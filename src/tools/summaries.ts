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
  timeZone: string | null;
  rollups: RollupMap;
  sleep: JsonRecord;
  unavailableMetrics?: { metric: string; reason: string }[];
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
  if (input.timeZone !== null) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
    } catch {
      throw new TypeError("timeZone must be a valid IANA time zone or null.");
    }
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
        mainSleep:
          typeof metadata["mainSleep"] === "boolean"
            ? metadata["mainSleep"]
            : null,
        nap: typeof metadata["nap"] === "boolean" ? metadata["nap"] : null,
        sleepType: typeof sleep["type"] === "string" ? sleep["type"] : null,
        stagesSummary: Array.isArray(summary["stagesSummary"])
          ? summary["stagesSummary"].map(object)
          : null,
        stageIntervals: Array.isArray(sleep["stages"])
          ? sleep["stages"].map(object)
          : null,
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

  const sleepStageMinutes = (stage: string): number | null => {
    if (ordered.length === 0 || hasOverlap) return null;
    let total = 0;
    for (const session of ordered) {
      // Google computes stage totals server-side; prefer them over local math.
      if (session.stagesSummary !== null) {
        const stageSummary = session.stagesSummary.find(
          (item) => item["type"] === stage,
        );
        if (!stageSummary) return null;
        const minutes = finiteNumber(stageSummary["minutes"]);
        if (minutes === null) return null;
        total += minutes;
        continue;
      }

      if (session.stageIntervals === null) return null;
      const matching = session.stageIntervals.filter(
        (segment) => segment["type"] === stage,
      );
      if (matching.length === 0) return null;
      for (const segment of matching) {
        const start = Date.parse(String(segment["startTime"] ?? ""));
        const end = Date.parse(String(segment["endTime"] ?? ""));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
          return null;
        total += (end - start) / 60_000;
      }
    }
    return Math.round(total);
  };
  const primarySleep =
    ordered.find((session) => session.mainSleep === true) ??
    (() => {
      const nonNaps = ordered.filter((session) => session.nap !== true);
      return nonNaps.length === 1 ? nonNaps[0] : undefined;
    })();
  const publicSleepSessions = ordered.map((session) => {
    const output = { ...session };
    Reflect.deleteProperty(output, "stagesSummary");
    Reflect.deleteProperty(output, "stageIntervals");
    return output;
  });

  return {
    date: input.date,
    timeZone: input.timeZone,
    aggregation:
      "Google Health source civil-date rollups; sleep sessions reconciled by the API. The account time zone is descriptive and does not override source civil times.",
    metrics: {
      steps: metric(steps, "steps"),
      distance: metric(distance === null ? null : distance / 1000, "m"),
      activeEnergy: metric(activeEnergy, "kcal"),
      totalCalories: metric(totalCalories, "kcal"),
      activeMinutes: metric(activeMinutes, "min"),
      averageHeartRate: metric(heartRate, "bpm"),
      averageWeight: metric(weight === null ? null : weight / 1000, "kg"),
      hydration: metric(hydration, "ml"),
      nutrition,
      sleepMinutesAsleep,
      sleepMinutesInBed,
      sleepStagesMinutes: {
        deep: sleepStageMinutes("DEEP"),
        light: sleepStageMinutes("LIGHT"),
        rem: sleepStageMinutes("REM"),
        awake: sleepStageMinutes("AWAKE"),
        asleep: sleepStageMinutes("ASLEEP"),
        restless: sleepStageMinutes("RESTLESS"),
      },
      primarySleep: primarySleep
        ? {
            startTime: primarySleep.startTime,
            endTime: primarySleep.endTime,
          }
        : null,
    },
    sleepSessions: publicSleepSessions,
    dataQuality: {
      rollupTypesReturned: ROLLUP_TYPES.filter(
        (type) => input.rollups[type] !== undefined,
      ),
      unavailableMetrics: input.unavailableMetrics ?? [],
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
            "Civil calendar date used by Google Health source-data rollups. The account time zone is reported as context and cannot override the civil date stored with measurements.",
          ),
      }),
      outputSchema: toolOutputSchema,
    },
    async ({ date }) => {
      dateParts(date);
      const unavailableMetrics: { metric: string; reason: string }[] = [];
      let timeZone: string | null = null;
      try {
        const settings = await api.request<JsonRecord>({
          methodId: "health.users.getSettings",
          pathParams: { name: "users/me/settings" },
        });
        const configuredTimeZone = settings["timeZone"];
        if (typeof configuredTimeZone === "string") {
          try {
            new Intl.DateTimeFormat("en", { timeZone: configuredTimeZone });
            timeZone = configuredTimeZone;
          } catch {
            unavailableMetrics.push({
              metric: "accountTimeZone",
              reason: "invalid_settings_value",
            });
          }
        }
      } catch {
        unavailableMetrics.push({
          metric: "accountTimeZone",
          reason: "request_failed",
        });
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
            try {
              const result = await api.request<JsonRecord>({
                methodId: "health.users.dataTypes.dataPoints.dailyRollUp",
                pathParams: { parent: `users/me/dataTypes/${dataType}` },
                body: { range, windowSizeDays: 1 },
              });
              return [dataType, result];
            } catch {
              unavailableMetrics.push({
                metric: dataType,
                reason: "request_failed",
              });
              return [dataType, {}];
            }
          }),
        ),
      );
      const sleepPoints: JsonRecord[] = [];
      const sleepCapability = getCapability("sleep");
      if (!sleepCapability?.operations.includes("reconcile")) {
        unavailableMetrics.push({
          metric: "sleep",
          reason: "unsupported_operation",
        });
      } else {
        assertOperationAllowed("sleep", "reconcile");
        const sleepFilter = `sleep.interval.civil_end_time >= "${date}" AND sleep.interval.civil_end_time < "${nextCivilDate(date)}"`;
        let pageToken: string | undefined;
        try {
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
              throw new TypeError("Missing sleep session records.");
            sleepPoints.push(...pagePoints.map(object));
            const nextPageToken = result["nextPageToken"];
            pageToken =
              typeof nextPageToken === "string" && nextPageToken
                ? nextPageToken
                : undefined;
            if (!pageToken) break;
            if (page === 9)
              throw new TypeError("Sleep session page limit reached.");
          }
        } catch {
          sleepPoints.length = 0;
          unavailableMetrics.push({
            metric: "sleep",
            reason: "request_failed_or_incomplete",
          });
        }
      }
      const sleep = { dataPoints: sleepPoints };
      return toolResult(
        buildDailySummary({
          date,
          timeZone,
          rollups,
          sleep,
          unavailableMetrics,
        }),
      );
    },
  );
}
