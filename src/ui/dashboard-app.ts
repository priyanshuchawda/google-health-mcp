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

function rangeDates(): { startDate: string; endDate: string } {
  const existing = object(summary?.["dateRange"]);
  const existingStart = String(existing["startDate"] ?? "");
  const existingEnd = String(existing["endDate"] ?? "");
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(existingStart) &&
    /^\d{4}-\d{2}-\d{2}$/.test(existingEnd) &&
    existingStart <= existingEnd
  )
    return { startDate: existingStart, endDate: existingEnd };
  const timeZone = String(existing["timeZone"] ?? "UTC");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (name: string) =>
    parts.find((item) => item.type === name)?.value ?? "";
  const endDate = `${part("year")}-${part("month")}-${part("day")}`;
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 6);
  return { startDate: start.toISOString().slice(0, 10), endDate };
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

function sleepView(): string {
  const rows = Array.isArray(summary?.["daily"])
    ? (summary["daily"] as HealthData[])
    : [];
  return `${cards(["sleepMinutesAsleep"])}<div class="sessions">${rows
    .map((row) => {
      const m = object(row["metrics"]);
      const stages = object(m["sleepStagesMinutes"]);
      const times = object(m["primarySleepLocalTimes"]);
      return `<article class="card"><h2>${escapeHtml(row["date"])}</h2><div>${escapeHtml(times["bedtime"] ?? "—")} → ${escapeHtml(times["wakeTime"] ?? "—")} <span class="muted">local source time</span></div><div class="muted">Deep ${format(stages["deep"])} min · Light ${format(stages["light"])} min · REM ${format(stages["rem"])} min</div></article>`;
    })
    .join("")}</div>`;
}

function activityView(): string {
  return `${cards(["steps", "distance", "activeEnergy", "activeMinutes", "exerciseCount", "exerciseMinutes"])}<div style="height:12px"></div>${dailyChart()}`;
}

function freshnessView(): string {
  return freshness.length
    ? `<article class="card"><h2>Latest records returned</h2><p class="muted">Measurement times are not guaranteed upload times.</p>${freshness.map((row) => `<div class="row"><strong>${escapeHtml(row["dataType"])}</strong><span>${escapeHtml(row["measurementTime"] ?? row["measurementCivilDate"] ?? "—")}</span><span class="muted">${escapeHtml(row["status"])}</span></div>`).join("")}</article>`
    : `<article class="card"><h2>Data freshness</h2><p class="muted">No freshness report is available yet.</p></article>`;
}

function logView(): string {
  return `<article class="card"><h2>Hydration</h2><form id="hydration-form"><label>Water (ml)<input name="milliliters" type="number" min="1" max="100000" step="1" value="250" required /></label><button type="submit">Log water</button></form></article><div style="height:12px"></div><article class="card"><h2>Workout</h2><form id="workout-form"><label>Workout type<select name="exerciseType"><option value="WALKING">Walking</option><option value="RUNNING">Running</option><option value="CIRCUIT_TRAINING">Circuit training</option><option value="STRENGTH_TRAINING">Strength training</option></select></label><label>Start<input name="startTime" type="datetime-local" required /></label><label>End<input name="endTime" type="datetime-local" required /></label><label>Active minutes<input name="activeMinutes" type="number" min="1" step="1" /></label><button type="submit">Log workout</button></form></article><div style="height:12px"></div><article class="card"><h2>Weight</h2><form id="weight-form"><label>Weight (kg)<input name="kilograms" type="number" min="0.1" max="1000" step="0.1" required /></label><button type="submit">Log weight</button></form></article><div style="height:12px"></div><article class="card"><h2>Sleep session</h2><p class="muted">This stores the sleep interval only. No sleep stages or actual minutes asleep are invented.</p><form id="sleep-form"><label>Start<input name="startTime" type="datetime-local" required /></label><label>End<input name="endTime" type="datetime-local" required /></label><button type="submit">Log sleep interval</button></form></article><div style="height:12px"></div><article class="card"><h2>Nutrition</h2><p class="muted">Anonymous food entries cannot be edited later in Google Health.</p><form id="nutrition-form"><label>Food<input name="foodDisplayName" type="text" maxlength="200" required /></label><label>Meal<select name="mealType"><option value="ANYTIME">Anytime</option><option value="BREAKFAST">Breakfast</option><option value="LUNCH">Lunch</option><option value="DINNER">Dinner</option><option value="SNACK">Snack</option></select></label><label>Calories (optional)<input name="caloriesKcal" type="number" min="0" max="100000" step="1" /></label><button type="submit">Log food</button></form></article><p class="muted">Each form asks for confirmation before writing to Google Health.</p>`;
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
      ? `${overview()}<div style="height:12px"></div>${freshnessView()}`
      : activeTab === "Sleep"
        ? sleepView()
        : activeTab === "Activity"
          ? activityView()
          : activeTab === "Log"
            ? logView()
            : goalsView();
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

async function refresh(): Promise<void> {
  setStatus("Refreshing the authorized summary…");
  try {
    const range = rangeDates();
    summary = await callTool("get_health_summary", range);
    try {
      const report = await callTool("get_data_freshness", {
        dataTypes: ["steps", "sleep", "heart-rate", "exercise"],
        lookbackDays: 7,
      });
      freshness = Array.isArray(report["dataTypes"])
        ? (report["dataTypes"] as HealthData[])
        : [];
    } catch {
      freshness = [];
    }
    render();
    setStatus("Updated from Google Health.");
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Could not refresh health data.",
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
      setStatus("Loading the selected date range…");
      void callTool("get_health_summary", { startDate, endDate })
        .then((value) => {
          summary = value;
          render();
          setStatus("Updated from Google Health.");
        })
        .catch((error: unknown) =>
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
      void callTool("create_health_record", {
        dataType: "hydration-log",
        record: hydrationRecord(amount, now),
      })
        .then(() => {
          setStatus("Water entry saved.");
          void refresh();
        })
        .catch((error: unknown) =>
          setStatus(
            error instanceof Error ? error.message : "Water entry failed.",
            true,
          ),
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
        void callTool("log_workout", {
          exerciseType: values.get("exerciseType"),
          startTime: localRfc3339(start),
          endTime: localRfc3339(end),
          ...(minutes === undefined ? {} : { activeMinutes: minutes }),
        })
          .then(() => {
            setStatus("Workout saved.");
            void refresh();
          })
          .catch((error: unknown) =>
            setStatus(
              error instanceof Error ? error.message : "Workout entry failed.",
              true,
            ),
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
      void callTool("create_health_record", {
        dataType: "weight",
        record: weightRecord(kg, now),
      })
        .then(() => {
          setStatus("Weight saved.");
          void refresh();
        })
        .catch((error: unknown) =>
          setStatus(
            error instanceof Error ? error.message : "Weight entry failed.",
            true,
          ),
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
        void callTool("create_health_record", {
          dataType: "sleep",
          record: sleepRecord(start, end),
        })
          .then(() => {
            setStatus("Sleep interval saved.");
            void refresh();
          })
          .catch((error: unknown) =>
            setStatus(
              error instanceof Error ? error.message : "Sleep entry failed.",
              true,
            ),
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
      void callTool("create_health_record", {
        dataType: "nutrition-log",
        record: nutritionRecord(
          foodDisplayName,
          String(values.get("mealType")),
          calories,
          now,
        ),
      })
        .then(() => {
          setStatus("Food entry saved.");
          void refresh();
        })
        .catch((error: unknown) =>
          setStatus(
            error instanceof Error ? error.message : "Nutrition entry failed.",
            true,
          ),
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
      void callTool("settings.update", { set: parsed })
        .then((result) => {
          preferences = object(result["settings"] ?? result);
          setStatus("Preferences saved.");
          render();
        })
        .catch((error: unknown) =>
          setStatus(
            error instanceof Error
              ? error.message
              : "Could not save preferences.",
            true,
          ),
        );
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
