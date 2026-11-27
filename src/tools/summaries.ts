import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  assertOperationAllowed,
  getCapability,
} from "../google-health/capabilities.js";
import type { HealthApi } from "../google-health/client.js";
import { toolCatalog } from "./catalog.js";
import { toolOutputSchema, toolResult } from "./results.js";

type JsonRecord = Record<string, unknown>;
type RollupMap = Readonly<Record<string, JsonRecord>>;

export interface DailySummaryInput {
  date: string;
  timeZone: string;
  rollups: RollupMap;
  sleep: JsonRecord;
}

const ROLLUP_TYPES = [
  "steps",
  "distance",
  "active-energy-burned",
  "total-calories",
  "active-minutes",
  "heart-rate",
  "weight",
  "hydration-log",
  "nutrition-log",
] as const;

function object(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function firstRollup(rollups: RollupMap, type: string): JsonRecord {
  const points = rollups[type]?.["rollupDataPoints"];
  return Array.isArray(points) && points.length > 0 ? object(points[0]) : {};
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function metric(
  value: number | null,
  unit: string,
): { value: number; unit: string } | null {
  return value === null ? null : { value, unit };
}

function readMetric(
  point: JsonRecord,
  family: string,
  field: string,
): number | null {
  return finiteNumber(object(point[family])[field]);
}

function dateParts(date: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new TypeError("date must be a valid YYYY-MM-DD civil date.");
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new TypeError("date must be a valid YYYY-MM-DD civil date.");
  }
  return { year: year!, month: month!, day: day! };
}

export function nextCivilDate(date: string): string {
  const { year, month, day } = dateParts(date);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear().toString().padStart(4, "0")}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function sleepSessions(sleep: JsonRecord): JsonRecord[] {
  const points = sleep["dataPoints"];
  return Array.isArray(points) ? points.map(object) : [];
}

export function buildDailySummary(input: DailySummaryInput): JsonRecord {
  dateParts(input.date);
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
  } catch {
    throw new TypeError("timeZone must be a valid IANA time zone.");
  }

  const steps = readMetric(
    firstRollup(input.rollups, "steps"),
    "steps",
    "countSum",
  );
  const distance = readMetric(
    firstRollup(input.rollups, "distance"),
    "distance",
    "millimetersSum",
  );
  const activeEnergy = readMetric(
    firstRollup(input.rollups, "active-energy-burned"),
    "activeEnergyBurned",
    "kcalSum",
  );
  const totalCalories = readMetric(
    firstRollup(input.rollups, "total-calories"),
    "totalCalories",
    "kcalSum",
  );
  const heartRate = readMetric(
    firstRollup(input.rollups, "heart-rate"),
    "heartRate",
    "beatsPerMinuteAvg",
  );
  const weight = readMetric(
    firstRollup(input.rollups, "weight"),
    "weight",
    "weightGramsAvg",
  );
  const hydrationPoint = firstRollup(input.rollups, "hydration-log");
  const hydration = finiteNumber(
    object(object(hydrationPoint["hydrationLog"])["amountConsumed"])[
      "millilitersSum"
    ],
  );
  const activeMinutesPoint = firstRollup(input.rollups, "active-minutes");
  const activityLevels =
    activeMinutesPoint["activeMinutesRollupByActivityLevel"];
  const activeMinutes = Array.isArray(activityLevels)
    ? activityLevels.reduce<number | null>((sum, item) => {
        const current = finiteNumber(object(item)["activeMinutesSum"]);
        return current === null ? sum : (sum ?? 0) + current;
      }, null)
    : null;
  const nutritionPoint = firstRollup(input.rollups, "nutrition-log");
  const nutrition = object(nutritionPoint["nutrition"]);
  const sleepPoints = sleepSessions(input.sleep);
  const ordered = sleepPoints
    .map((point) => {
      const sleep = object(point["sleep"]);
      const interval = object(sleep["interval"]);
      const summary = object(sleep["summary"]);
      const metadata = object(sleep["metadata"]);
      return {
        name:
          typeof point["dataPointName"] === "string"
            ? point["dataPointName"]
            : typeof point["name"] === "string"
              ? point["name"]
              : null,
        startTime:
          typeof interval["startTime"] === "string"
            ? interval["startTime"]
            : null,
        endTime:
          typeof interval["endTime"] === "string" ? interval["endTime"] : null,
        minutesAsleep: finiteNumber(summary["minutesAsleep"]),
        minutesInSleepPeriod: finiteNumber(summary["minutesInSleepPeriod"]),
        mainSleep: metadata["mainSleep"] === true,
      };
    })
    .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  const hasOverlap = ordered.some((session, index) => {
    if (index === 0 || !session.startTime) return false;
    const previous = ordered[index - 1];
    return Boolean(
      previous?.endTime &&
      Date.parse(session.startTime) < Date.parse(previous.endTime),
    );
  });
  const hasMissingSleepDuration = ordered.some(
    (session) => session.minutesAsleep === null,
  );
  const hasUnknownSleepInterval = ordered.some((session) => {
    if (!session.startTime || !session.endTime) return true;
    return (
      !Number.isFinite(Date.parse(session.startTime)) ||
      !Number.isFinite(Date.parse(session.endTime))
    );
  });
  const sleepMinutesAsleep =
    ordered.length === 0 ||
    hasOverlap ||
    hasMissingSleepDuration ||
    hasUnknownSleepInterval
      ? null
      : ordered.reduce((sum, session) => sum + (session.minutesAsleep ?? 0), 0);
  const sleepMinutesInBed =
    ordered.length === 0 ||
    hasOverlap ||
    hasUnknownSleepInterval ||
    ordered.some((s) => s.minutesInSleepPeriod === null)
      ? null
      : ordered.reduce(
          (sum, session) => sum + (session.minutesInSleepPeriod ?? 0),
          0,
        );

  return {
    date: input.date,
    timeZone: input.timeZone,
    aggregation:
      "Google Health daily rollups; sleep sessions reconciled by the API",
    metrics: {
      steps: metric(steps, "steps"),
      distance: metric(distance === null ? null : distance / 1000, "m"),
      activeEnergy: metric(activeEnergy, "kcal"),
      totalCalories: metric(totalCalories, "kcal"),
      activeMinutes: metric(activeMinutes, "min"),
      averageHeartRate: metric(heartRate, "bpm"),
      weight: metric(weight === null ? null : weight / 1000, "kg"),
      hydration: metric(hydration, "ml"),
      nutrition,
      sleepMinutesAsleep,
      sleepMinutesInBed,
    },
    sleepSessions: ordered,
    dataQuality: {
      rollupTypesReturned: ROLLUP_TYPES.filter(
        (type) => input.rollups[type] !== undefined,
      ),
      sleepSessionCount: ordered.length,
      sleepDurationUnavailableReason: hasOverlap
        ? "Sleep sessions overlap, so adding their durations would double-count."
        : hasMissingSleepDuration
          ? "At least one reconciled sleep session has no actual sleep duration."
          : hasUnknownSleepInterval
            ? "At least one reconciled sleep session has missing or invalid interval timestamps."
            : ordered.length === 0
              ? "No sleep sessions were returned for this date."
              : null,
    },
  };
}

export function registerSummaryTool(server: McpServer, api: HealthApi): void {
  const definition = toolCatalog.find(
    (tool) => tool.name === "get_daily_health_summary",
  )!;
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      annotations: definition.annotations,
      inputSchema: z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe(
            "Local calendar date in the Google Health account time zone.",
          ),
        timeZone: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Optional IANA time zone override; otherwise use Google Health account settings.",
          ),
      }),
      outputSchema: toolOutputSchema,
    },
    async ({ date, timeZone: requestedTimeZone }) => {
      const settings = await api.request<JsonRecord>({
        methodId: "health.users.getSettings",
        pathParams: { name: "users/me/settings" },
      });
      const configuredTimeZone = object(settings["settings"])["timeZone"];
      const timeZone =
        requestedTimeZone ??
        (typeof configuredTimeZone === "string" ? configuredTimeZone : "UTC");
      try {
        new Intl.DateTimeFormat("en", { timeZone });
      } catch {
        throw new TypeError(
          "Google Health settings did not provide a valid IANA time zone; supply timeZone explicitly.",
        );
      }

      const { year, month, day } = dateParts(date);
      const next = nextCivilDate(date).split("-").map(Number);
      const range = {
        start: { date: { year, month, day } },
        end: { date: { year: next[0], month: next[1], day: next[2] } },
      };
      const rollups = Object.fromEntries(
        await Promise.all(
          ROLLUP_TYPES.map(async (dataType) => {
            const capability = getCapability(dataType);
            if (!capability || !capability.operations.includes("dailyRollUp"))
              return [dataType, {}];
            assertOperationAllowed(dataType, "dailyRollUp");
            const result = await api.request<JsonRecord>({
              methodId: "health.users.dataTypes.dataPoints.dailyRollUp",
              pathParams: { parent: `users/me/dataTypes/${dataType}` },
              body: { range, windowSizeDays: 1 },
            });
            return [dataType, result];
          }),
        ),
      );
      const sleepCapability = getCapability("sleep");
      if (!sleepCapability?.operations.includes("reconcile"))
        throw new TypeError(
          "Google Health sleep reconciliation is unavailable.",
        );
      assertOperationAllowed("sleep", "reconcile");
      const sleepFilter = `sleep.interval.civil_end_time >= "${date}" AND sleep.interval.civil_end_time < "${nextCivilDate(date)}"`;
      const sleepPoints: JsonRecord[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = await api.request<JsonRecord>({
          methodId: "health.users.dataTypes.dataPoints.reconcile",
          pathParams: { parent: "users/me/dataTypes/sleep" },
          query: {
            filter: sleepFilter,
            pageSize: 25,
            ...(pageToken ? { pageToken } : {}),
          },
        });
        const pagePoints = result["dataPoints"];
        if (!Array.isArray(pagePoints))
          throw new TypeError(
            "Google Health sleep reconciliation response is missing dataPoints.",
          );
        sleepPoints.push(...pagePoints.map(object));
        const nextPageToken = result["nextPageToken"];
        pageToken =
          typeof nextPageToken === "string" && nextPageToken
            ? nextPageToken
            : undefined;
        if (!pageToken) break;
        if (page === 9)
          throw new TypeError(
            "Sleep summary exceeded the 250-session pagination limit; use the sleep data tool for a bounded query.",
          );
      }
      const sleep = { dataPoints: sleepPoints };
      return toolResult(buildDailySummary({ date, timeZone, rollups, sleep }));
    },
  );
}
