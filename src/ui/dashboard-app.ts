import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import "@openai/mcp-extensions/app/styles.css";
import {
  hydrationRecord,
  localRfc3339,
  nutritionRecord,
  sleepRecord,
  weightRecord,
} from "./record-payloads.js";
import {
  DashboardSubmissionGate,
  LatestRequest,
  latestRangeForRefresh,
  type DateRange,
} from "./dashboard-state.js";

type HealthData = Record<string, unknown>;
const app = new App({ name: "Google Health", version: "1.0.0" });
const root = document.querySelector<HTMLElement>("#view")!;
const status = document.querySelector<HTMLElement>("#status")!;
const rangeLabel = document.querySelector<HTMLElement>("#range-label")!;
const tabs = ["Overview", "Sleep", "Activity", "Log", "Goals"] as const;
type Tab = (typeof tabs)[number];
let activeTab: Tab = "Overview";
let summary: HealthData | null = null;
let preferences: HealthData | null = null;
let freshness: HealthData[] = [];
let freshnessUnavailable = false;
let selectedRange: DateRange | null = null;
const submissions = new DashboardSubmissionGate();
const requests = new LatestRequest();

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const object = (value: unknown): HealthData =>
  value !== null && typeof value === "object" ? (value as HealthData) : {};
const metric = (name: string) => {
  const rows = Array.isArray(summary?.["daily"])
    ? (summary["daily"] as HealthData[])
    : [];
  return object(object(rows.at(-1)?.["metrics"]))[name];
};
const valueOf = (value: unknown) =>
  typeof value === "number" ? value : object(value)["value"];
const unitOf = (value: unknown) => object(value)["unit"] ?? "";
const format = (value: unknown, digits = 0) =>
  typeof value === "number"
    ? new Intl.NumberFormat(undefined, {
        maximumFractionDigits: digits,
      }).format(value)
    : "—";
const unwrap = (result: HealthData) => {
  const structured = object(result["structuredContent"]);
  return object(structured["data"] ?? structured["settings"] ?? structured);
};

function effectiveTimeZone(): string {
  const accountTimeZone = object(summary?.["dateRange"])["timeZone"];
  if (typeof accountTimeZone === "string" && accountTimeZone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: accountTimeZone });
      return accountTimeZone;
    } catch {
      // Fall through to the browser's actual zone instead of silently using UTC.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function rangeDates(): DateRange {
  return latestRangeForRefresh(selectedRange, new Date(), effectiveTimeZone());
}

function setStatus(message: string, isError = false): void {
  status.textContent = message;
  status.setAttribute("aria-live", isError ? "assertive" : "polite");
}

function renderTabs(): void {
  const nav = document.querySelector<HTMLElement>("#tabs")!;
  nav.innerHTML = tabs
    .map(
      (tab) =>
        `<button type="button" data-tab="${tab}" aria-pressed="${tab === activeTab}">${tab}</button>`,
    )
    .join("");
  nav.querySelectorAll<HTMLButtonElement>("button").forEach((button) =>
    button.addEventListener("click", () => {
      activeTab = button.dataset["tab"] as Tab;
      render();
    }),
  );
}

function cards(names: string[]): string {
  return `<div class="grid">${names
    .map((name) => {
      const item = metric(name);
      return `<article class="card"><div class="muted">${escapeHtml(name.replaceAll(/([A-Z])/g, " $1"))}</div><div class="value">${format(valueOf(item), 1)} <small>${escapeHtml(unitOf(item))}</small></div></article>`;
    })
    .join("")}</div>`;
}

function dailyChart(): string {
  const rows = Array.isArray(summary?.["daily"])
    ? (summary["daily"] as HealthData[])
    : [];
  const samples = rows.map((row) => ({
    date: String(row["date"] ?? ""),
    value: valueOf(object(row["metrics"])["steps"]) as number | null,
  }));
  const max = Math.max(
    1,
    ...samples.map((row) => (typeof row.value === "number" ? row.value : 0)),
  );
  return `<article class="card"><h2>Steps by day</h2>${samples.map((row) => `<div class="row"><span style="width:82px">${escapeHtml(row.date.slice(5))}</span><div class="bar" role="img" aria-label="${escapeHtml(row.value ?? "No data")} steps" style="width:${row.value === null ? 2 : Math.max(2, (row.value / max) * 70)}%"></div><span>${format(row.value)}</span></div>`).join("")}</article>`;
}

function overview(): string {
  const q = object(summary?.["dateRange"]);
  return `<form id="range-form" class="card"><label>From<input name="startDate" type="date" value="${escapeHtml(q["startDate"])}" required /></label><label>Through<input name="endDate" type="date" value="${escapeHtml(q["endDate"])}" required /></label><button type="submit">Load range</button></form><p class="muted">${escapeHtml(q["startDate"])} – ${escapeHtml(q["endDate"])} · ${escapeHtml(q["timeZone"] ?? "source civil dates")}</p>${cards(["steps", "sleepMinutesAsleep", "restingHeartRate", "exerciseMinutes"])}<div style="height:12px"></div>${dailyChart()}<p class="muted">Missing measurements are shown as — and are not treated as zero.</p>`;
}

function goalProgressView(): string {
  const daily = Array.isArray(summary?.["daily"])
    ? (summary["daily"] as HealthData[])
    : [];
  const latest = daily.at(-1);
  const metrics = object(latest?.["metrics"]);
  const targets = object(preferences);
  const days = Number(object(summary?.["dateRange"])["days"] ?? daily.length);
  const exerciseTarget =
    Number(targets["weeklyExerciseMinutesGoal"] ?? 150) * (days / 7);
  const values = [
    {
      title: "Steps",
      value: valueOf(metrics["steps"]),
      target: Number(targets["dailyStepsGoal"] ?? 8_000),
      unit: "steps today",
    },
    {
      title: "Sleep",
      value:
        typeof valueOf(metrics["sleepMinutesAsleep"]) === "number"
          ? Number(valueOf(metrics["sleepMinutesAsleep"])) / 60
          : null,
      target: Number(targets["sleepHoursGoal"] ?? 8),
      unit: "hours last source day",
    },
    {
      title: "Hydration",
      value: valueOf(metrics["hydration"]),
      target: Number(targets["hydrationMlGoal"] ?? 2_500),
      unit: "ml last source day",
    },
    {
      title: "Exercise",
      value: valueOf(object(summary?.["totals"])["exerciseMinutes"]),
      target: exerciseTarget,
      unit: `minutes in ${days} days`,
    },
  ];
  return `<article class="card"><h2>Personal target progress</h2><div class="grid">${values
    .map(({ title, value, target, unit }) => {
      const observedValue =
        typeof value === "number" && Number.isFinite(value) ? value : null;
      const targetAvailable = target > 0 && Number.isFinite(target);
      const progress =
        observedValue !== null && targetAvailable
          ? Math.min(100, (observedValue / target) * 100)
          : 0;
      return `<div><div class="muted">${escapeHtml(title)} · ${escapeHtml(unit)}</div><div>${observedValue !== null ? format(observedValue, 1) : "No data"}${targetAvailable ? ` / ${format(target, 1)}` : ""}</div>${targetAvailable ? `<progress max="100" value="${progress}" aria-label="${escapeHtml(title)} target progress"></progress>` : '<div class="muted">Set a target above zero to track progress.</div>'}</div>`;
    })
    .join(
      "",
    )}</div><p class="muted">These are personal targets, not Google Health goals. Missing measurements stay missing.</p></article>`;
}

function sleepView(): string {
  const rows = Array.isArray(summary?.["daily"])
    ? (summary["daily"] as HealthData[])
    : [];
  const samples = rows.map((row) => ({
    date: String(row["date"] ?? ""),
    minutes: valueOf(object(row["metrics"])["sleepMinutesAsleep"]),
  }));
  const maxMinutes = Math.max(
    1,
    ...samples.map((sample) =>
      typeof sample.minutes === "number" ? sample.minutes : 0,
    ),
  );
  const consistency = object(summary?.["sleepTimingConsistency"]);
  const bedtime = object(consistency["bedtime"]);
  const wakeTime = object(consistency["wakeTime"]);
  return `${cards(["sleepMinutesAsleep"])}<article class="card"><h2>Sleep duration by source date</h2>${samples
    .map(
      (sample) =>
        `<div class="row"><span style="width:82px">${escapeHtml(sample.date.slice(5))}</span><div class="bar" role="img" aria-label="${escapeHtml(sample.minutes ?? "No data")} sleep minutes" style="width:${typeof sample.minutes === "number" ? Math.max(2, (sample.minutes / maxMinutes) * 70) : 2}%"></div><span>${format(sample.minutes)}</span></div>`,
    )
    .join(
      "",
    )}</article><div style="height:12px"></div><article class="card"><h2>Sleep timing consistency</h2><p>Usual bedtime ${escapeHtml(bedtime["averageLocalTime"] ?? "—")} · variability ${format(bedtime["circularStdDevMinutes"])} min</p><p>Usual wake time ${escapeHtml(wakeTime["averageLocalTime"] ?? "—")} · variability ${format(wakeTime["circularStdDevMinutes"])} min</p><p class="muted">Calculated from source-local clock times on nights with primary-sleep timing.</p></article><div style="height:12px"></div><div class="sessions">${rows
    .map((row) => {
      const m = object(row["metrics"]);
      const stages = object(m["sleepStagesMinutes"]);
      const times = object(m["primarySleepLocalTimes"]);
      return `<article class="card"><h2>${escapeHtml(row["date"])}</h2><div>${escapeHtml(times["bedtime"] ?? "—")} → ${escapeHtml(times["wakeTime"] ?? "—")} <span class="muted">local source time</span></div><div class="muted">Deep ${format(stages["deep"])} min · Light ${format(stages["light"])} min · REM ${format(stages["rem"])} min</div></article>`;
    })
    .join("")}</div>`;
}

function activityView(): string {
  const daily = Array.isArray(summary?.["daily"])
    ? (summary["daily"] as HealthData[])
    : [];
  const workouts = daily.flatMap((row) => {
    const sessions = Array.isArray(row["exerciseSessions"])
      ? (row["exerciseSessions"] as HealthData[])
      : [];
    return sessions.map((session) => ({ date: row["date"], session }));
  });
  const recent = workouts.slice(-20).reverse();
  const history = recent.length
    ? `<article class="card"><h2>Workout history (${workouts.length} returned)</h2><div class="sessions">${recent
        .map(({ date, session }) => {
          const title =
            session["displayName"] ?? session["exerciseType"] ?? "Workout";
          const start = civilDateTimeLabel(session["civilStartTime"]);
          const duration = session["activeMinutes"];
          return `<div class="row"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(start ?? date ?? "")}</span><span>${typeof duration === "number" ? `${format(duration)} min` : "Duration unavailable"}</span></div>`;
        })
        .join(
          "",
        )}</div>${workouts.length > recent.length ? `<p class="muted">Showing the latest ${recent.length} sessions in this range.</p>` : ""}</article>`
    : `<article class="card"><h2>Workout history</h2><p class="muted">${daily.some((row) => row["exerciseSessions"] === null) ? "Workout history could not be loaded for part of this range." : "No workouts were returned for this range."}</p></article>`;
  return `${cards(["steps", "distance", "activeEnergy", "activeMinutes", "exerciseCount", "exerciseMinutes"])}<div style="height:12px"></div>${dailyChart()}<div style="height:12px"></div>${history}`;
}

function civilDateTimeLabel(value: unknown): string | null {
  const civil = object(value);
  const date = object(civil["date"]);
  const time = object(civil["time"]);
  const year = date["year"];
  const month = date["month"];
  const day = date["day"];
  const hours = time["hours"];
  const minutes = time["minutes"];
  if (
    ![year, month, day, hours, minutes].every(
      (part) => typeof part === "number" && Number.isInteger(part),
    )
  )
    return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function freshnessView(): string {
  return freshness.length
    ? `<article class="card"><h2>Latest records returned</h2><p class="muted">Measurement times are not guaranteed upload times.</p>${freshness.map((row) => `<div class="row"><strong>${escapeHtml(row["dataType"])}</strong><span>${escapeHtml(row["measurementTime"] ?? row["measurementCivilDate"] ?? "—")}</span><span class="muted">${escapeHtml(row["status"])}</span></div>`).join("")}</article>`
    : `<article class="card"><h2>Data freshness</h2><p class="muted">${freshnessUnavailable ? "Freshness could not be checked. Refresh to try again." : "No recent records were returned."}</p></article>`;
}

function availabilityView(): string {
  const rows = Array.isArray(summary?.["daily"])
    ? (summary["daily"] as HealthData[])
    : [];
  const unavailable = new Map<string, string>();
  for (const row of rows) {
    const quality = object(row["dataQuality"]);
    const items = Array.isArray(quality["unavailableMetrics"])
      ? (quality["unavailableMetrics"] as HealthData[])
      : [];
    for (const item of items) {
      const metricName = String(item["metric"] ?? "Health data");
      const reason = String(item["reason"] ?? "unavailable");
      const statusCode = Number(item["httpStatus"]);
      const explanation: Record<string, string> = {
        permission_denied:
          "permission was not granted; reconnect with the required access",
        quota_exceeded: "Google Health rate limit was reached; try later",
        temporary_upstream_error: "Google Health is temporarily unavailable",
        upstream_rejected_request: "Google Health rejected this request",
        pagination_limit_reached:
          "the result was incomplete because the page limit was reached",
        invalid_or_incomplete_response:
          "Google returned an incomplete or invalid response",
        request_failed: "the request failed",
        request_failed_or_incomplete:
          "the request failed or returned incomplete data",
        invalid_settings_value: "the account time zone setting is invalid",
        missing_settings_value:
          "Google Health did not provide an account time zone",
      };
      const detail = explanation[reason] ?? reason.replaceAll("_", " ");
      const message = `${metricName}: ${detail}${Number.isInteger(statusCode) && statusCode > 0 ? ` (HTTP ${statusCode})` : ""}`;
      unavailable.set(`${metricName}:${reason}`, message);
    }
  }
  if (!unavailable.size) return "";
  return `<article class="card" role="status"><h2>Some metrics could not be loaded</h2><ul>${[...unavailable.values()].map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul></article><div style="height:12px"></div>`;
}

function logView(): string {
  const browserTimeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "unknown device timezone";
  const accountTimeZone = object(summary?.["dateRange"])["timeZone"];
  const timeZoneNotice =
    typeof accountTimeZone === "string" && accountTimeZone !== browserTimeZone
      ? `Entries use device time (${browserTimeZone}); summary dates use account time (${accountTimeZone}).`
      : `Entry times use this device's local time (${browserTimeZone}).`;
  return `<p class="muted">${escapeHtml(timeZoneNotice)}</p><article class="card"><h2>Hydration</h2><form id="hydration-form"><label>Water (ml)<input name="milliliters" type="number" min="1" max="100000" step="1" value="250" required /></label><button type="submit">Log water</button></form></article><div style="height:12px"></div><article class="card"><h2>Workout</h2><form id="workout-form"><label>Workout type<select name="exerciseType"><option value="WALKING">Walking</option><option value="RUNNING">Running</option><option value="CIRCUIT_TRAINING">Circuit training</option><option value="STRENGTH_TRAINING">Strength training</option></select></label><label>Start<input name="startTime" type="datetime-local" required /></label><label>End<input name="endTime" type="datetime-local" required /></label><label>Active minutes<input name="activeMinutes" type="number" min="1" step="1" /></label><button type="submit">Log workout</button></form></article><div style="height:12px"></div><article class="card"><h2>Weight</h2><form id="weight-form"><label>Weight (kg)<input name="kilograms" type="number" min="0.1" max="1000" step="0.1" required /></label><button type="submit">Log weight</button></form></article><div style="height:12px"></div><article class="card"><h2>Sleep session</h2><p class="muted">This stores the sleep interval only. No sleep stages or actual minutes asleep are invented.</p><form id="sleep-form"><label>Start<input name="startTime" type="datetime-local" required /></label><label>End<input name="endTime" type="datetime-local" required /></label><button type="submit">Log sleep interval</button></form></article><div style="height:12px"></div><article class="card"><h2>Nutrition</h2><p class="muted">Anonymous food entries cannot be edited later in Google Health.</p><form id="nutrition-form"><label>Food<input name="foodDisplayName" type="text" maxlength="200" required /></label><label>Meal<select name="mealType"><option value="ANYTIME">Anytime</option><option value="BREAKFAST">Breakfast</option><option value="LUNCH">Lunch</option><option value="DINNER">Dinner</option><option value="SNACK">Snack</option></select></label><label>Calories (optional)<input name="caloriesKcal" type="number" min="0" max="100000" step="1" /></label><button type="submit">Log food</button></form></article><p class="muted">Each form asks for confirmation before writing to Google Health.</p>`;
}

function goalsView(): string {
  const values = object(preferences);
  return `<article class="card"><h2>Your private dashboard preferences</h2><p class="muted">These optional targets are stored in your server's existing account-isolated KV. They are not Google Health's native goals.</p><form id="goals-form"><label>Daily steps<input name="dailyStepsGoal" type="number" min="0" max="200000" value="${escapeHtml(values["dailyStepsGoal"] ?? 8000)}" /></label><label>Sleep target (hours)<input name="sleepHoursGoal" type="number" min="0" max="24" step="0.25" value="${escapeHtml(values["sleepHoursGoal"] ?? 8)}" /></label><label>Water (ml/day)<input name="hydrationMlGoal" type="number" min="0" max="100000" value="${escapeHtml(values["hydrationMlGoal"] ?? 2500)}" /></label><label>Exercise (minutes/week)<input name="weeklyExerciseMinutesGoal" type="number" min="0" max="10080" value="${escapeHtml(values["weeklyExerciseMinutesGoal"] ?? 150)}" /></label><button type="submit">Save preferences</button></form></article>`;
}

function render(): void {
  renderTabs();
  if (!summary) return;
  const range = object(summary["dateRange"]);
  rangeLabel.textContent = `${String(range["startDate"] ?? "")} to ${String(range["endDate"] ?? "")} · refreshed on request`;
  root.innerHTML =
    activeTab === "Overview"
      ? `${availabilityView()}${overview()}<div style="height:12px"></div>${goalProgressView()}<div style="height:12px"></div>${freshnessView()}`
      : activeTab === "Sleep"
        ? sleepView()
        : activeTab === "Activity"
          ? activityView()
          : activeTab === "Log"
            ? logView()
            : `${goalProgressView()}<div style="height:12px"></div>${goalsView()}`;
  document.querySelector<HTMLButtonElement>("#refresh")!.onclick = () =>
    void refresh();
  bindForms();
}

async function callTool(
  name: string,
  args: HealthData = {},
): Promise<HealthData> {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError)
    throw new Error(
      result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join(" ") || "The MCP tool failed.",
    );
  return unwrap(result as unknown as HealthData);
}

async function refresh(options: { quiet?: boolean } = {}): Promise<void> {
  const request = requests.begin();
  if (!options.quiet) setStatus("Refreshing the authorized summary…");
  try {
    const range = rangeDates();
    const [summaryResult, freshnessResult] = await Promise.allSettled([
      callTool("get_health_summary", { ...range }),
      callTool("get_data_freshness", {
        dataTypes: ["steps", "sleep", "heart-rate", "exercise"],
        lookbackDays: 7,
      }),
    ]);
    if (!requests.isCurrent(request)) return;
    if (summaryResult.status === "rejected") throw summaryResult.reason;
    summary = summaryResult.value;
    freshnessUnavailable = freshnessResult.status === "rejected";
    if (freshnessResult.status === "fulfilled") {
      const report = freshnessResult.value;
      freshness = Array.isArray(report["dataTypes"])
        ? (report["dataTypes"] as HealthData[])
        : [];
    } else {
      freshness = [];
    }
    render();
    if (!options.quiet) setStatus("Updated from Google Health.");
  } catch (error) {
    if (!requests.isCurrent(request)) return;
    if (!options.quiet)
      setStatus(
        error instanceof Error
          ? error.message
          : "Could not refresh health data.",
        true,
      );
  }
}

function dateFromInput(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Enter a valid date and time.");
  return date;
}

async function submitWrite(
  form: HTMLFormElement,
  pendingMessage: string,
  successMessage: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  // Acquire before awaiting the host so a second submit cannot enqueue a duplicate.
  const release = submissions.tryAcquire(form.id);
  if (!release) return;
  const buttons = [
    ...form.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
  ];
  buttons.forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  });
  form.setAttribute("aria-busy", "true");
  setStatus(pendingMessage);
  try {
    await operation();
    setStatus(successMessage);
    void refresh({ quiet: true });
  } catch (error) {
    const detail =
      error instanceof Error ? ` ${error.message}` : " The request failed.";
    setStatus(
      `The result could not be confirmed.${detail} Check Google Health before retrying to avoid a duplicate.`,
      true,
    );
  } finally {
    form.removeAttribute("aria-busy");
    buttons.forEach((button) => {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    });
    release();
  }
}

async function submitPreferences(
  form: HTMLFormElement,
  values: Record<string, number>,
): Promise<void> {
  const release = submissions.tryAcquire(form.id);
  if (!release) return;
  const buttons = [
    ...form.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
  ];
  buttons.forEach((button) => (button.disabled = true));
  setStatus("Saving private dashboard targets…");
  try {
    const result = await callTool("settings.update", { set: values });
    preferences = object(result["settings"] ?? result);
    setStatus("Preferences saved.");
    render();
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Could not save preferences.",
      true,
    );
  } finally {
    buttons.forEach((button) => (button.disabled = false));
    release();
  }
}

function bindForms(): void {
  document
    .querySelector<HTMLFormElement>("#range-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget as HTMLFormElement);
      const startDate = String(values.get("startDate"));
      const endDate = String(values.get("endDate"));
      if (startDate > endDate) {
        setStatus("The first date must not follow the last date.", true);
        return;
      }
      selectedRange = { startDate, endDate };
      const request = requests.begin();
      setStatus("Loading the selected date range…");
      void callTool("get_health_summary", { startDate, endDate })
        .then((value) => {
          if (!requests.isCurrent(request)) return;
          summary = value;
          render();
          setStatus("Updated from Google Health.");
        })
        .catch(
          (error: unknown) =>
            requests.isCurrent(request) &&
            setStatus(
              error instanceof Error
                ? error.message
                : "Could not load this range.",
              true,
            ),
        );
    });
  document
    .querySelector<HTMLFormElement>("#hydration-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const amount = Number(new FormData(form).get("milliliters"));
      if (!Number.isFinite(amount) || amount <= 0) return;
      if (!window.confirm(`Add ${amount} ml of water to Google Health?`))
        return;
      const now = new Date();
      void submitWrite(form, "Saving water entry…", "Water entry saved.", () =>
        callTool("create_health_record", {
          dataType: "hydration-log",
          record: hydrationRecord(amount, now),
        }),
      );
    });
  document
    .querySelector<HTMLFormElement>("#workout-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const values = new FormData(form);
      try {
        const start = dateFromInput(String(values.get("startTime")));
        const end = dateFromInput(String(values.get("endTime")));
        const minutesValue = Number(values.get("activeMinutes"));
        const minutes =
          Number.isFinite(minutesValue) && minutesValue > 0
            ? minutesValue
            : undefined;
        if (end <= start)
          throw new Error("Workout end must be later than its start.");
        if (
          !window.confirm(
            `Log this ${String(values.get("exerciseType")).toLowerCase().replaceAll("_", " ")} workout?`,
          )
        )
          return;
        void submitWrite(form, "Saving workout…", "Workout saved.", () =>
          callTool("log_workout", {
            exerciseType: values.get("exerciseType"),
            startTime: localRfc3339(start),
            endTime: localRfc3339(end),
            ...(minutes === undefined ? {} : { activeMinutes: minutes }),
          }),
        );
      } catch (error) {
        setStatus(
          error instanceof Error ? error.message : "Check the workout fields.",
          true,
        );
      }
    });
  document
    .querySelector<HTMLFormElement>("#weight-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const kg = Number(
        new FormData(event.currentTarget as HTMLFormElement).get("kilograms"),
      );
      if (!Number.isFinite(kg) || kg <= 0 || kg > 1000) {
        setStatus("Enter a weight between 0.1 and 1000 kg.", true);
        return;
      }
      if (!window.confirm(`Log ${kg} kg as a manually entered weight?`)) return;
      const now = new Date();
      const form = event.currentTarget as HTMLFormElement;
      void submitWrite(form, "Saving weight…", "Weight saved.", () =>
        callTool("create_health_record", {
          dataType: "weight",
          record: weightRecord(kg, now),
        }),
      );
    });
  document
    .querySelector<HTMLFormElement>("#sleep-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget as HTMLFormElement);
      try {
        const start = dateFromInput(String(values.get("startTime")));
        const end = dateFromInput(String(values.get("endTime")));
        if (end <= start)
          throw new Error("Sleep end must be later than its start.");
        if (
          !window.confirm(
            "Log this sleep interval? No stages or sleep minutes will be fabricated.",
          )
        )
          return;
        const form = event.currentTarget as HTMLFormElement;
        void submitWrite(
          form,
          "Saving sleep interval…",
          "Sleep interval saved.",
          () =>
            callTool("create_health_record", {
              dataType: "sleep",
              record: sleepRecord(start, end),
            }),
        );
      } catch (error) {
        setStatus(
          error instanceof Error ? error.message : "Check the sleep interval.",
          true,
        );
      }
    });
  document
    .querySelector<HTMLFormElement>("#nutrition-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget as HTMLFormElement);
      const foodDisplayName = String(
        values.get("foodDisplayName") ?? "",
      ).trim();
      const calorieText = String(values.get("caloriesKcal") ?? "");
      const calories = calorieText === "" ? undefined : Number(calorieText);
      if (
        !foodDisplayName ||
        (calories !== undefined &&
          (!Number.isFinite(calories) || calories < 0 || calories > 100000))
      ) {
        setStatus(
          "Enter a food name and a valid optional calorie amount.",
          true,
        );
        return;
      }
      if (
        !window.confirm(
          `Log ${foodDisplayName} to Google Health? Anonymous food entries cannot be edited.`,
        )
      )
        return;
      const now = new Date();
      const form = event.currentTarget as HTMLFormElement;
      void submitWrite(form, "Saving food entry…", "Food entry saved.", () =>
        callTool("create_health_record", {
          dataType: "nutrition-log",
          record: nutritionRecord(
            foodDisplayName,
            String(values.get("mealType")),
            calories,
            now,
          ),
        }),
      );
    });
  document
    .querySelector<HTMLFormElement>("#goals-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget as HTMLFormElement);
      const parsed = Object.fromEntries(
        [
          "dailyStepsGoal",
          "sleepHoursGoal",
          "hydrationMlGoal",
          "weeklyExerciseMinutesGoal",
        ].map((key) => [key, Number(values.get(key))]),
      );
      const form = event.currentTarget as HTMLFormElement;
      void submitPreferences(form, parsed as Record<string, number>);
    });
}

app.ontoolresult = (result) => {
  summary = unwrap(result as unknown as HealthData);
  render();
};
app.addEventListener("hostcontextchanged", () => {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
});
void app.connect().then(async () => {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
  try {
    const result = await app.callServerTool({
      name: "settings.read",
      arguments: {},
    });
    if (!result.isError) preferences = unwrap(result as unknown as HealthData);
  } catch {
    /* The dashboard remains useful when host settings are unavailable. */
  }
  if (!summary) await refresh();
});
