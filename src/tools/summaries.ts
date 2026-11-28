import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  assertOperationAllowed,
  defaultApiVersionForDataType,
  getCapability,
} from "../google-health/capabilities.js";
import type { HealthApi } from "../google-health/client.js";
import { toolCatalog } from "./catalog.js";
import { toolOutputSchema, toolResult } from "./results.js";

export type JsonRecord = Record<string, unknown>;
type RollupMap = Readonly<Record<string, JsonRecord>>;

export interface DailySummaryInput {
  date: string;
  timeZone: string | null;
  rollups: RollupMap;
  sleep: JsonRecord;
  dailyMeasurements?: {
    restingHeartRate?: JsonRecord | undefined;
    heartRateVariability?: JsonRecord | undefined;
  };
  exerciseSessions?: JsonRecord[] | undefined;
  unavailableMetrics?: { metric: string; reason: string }[];
}

export const ROLLUP_TYPES = [
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

export function object(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function firstRollup(rollups: RollupMap, type: string): JsonRecord {
  const points = rollups[type]?.["rollupDataPoints"];
  return Array.isArray(points) && points.length > 0 ? object(points[0]) : {};
}

export function finiteNumber(value: unknown): number | null {
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

export function dateParts(date: string): {
  year: number;
  month: number;
  day: number;
} {
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

export function civilDateFromValue(value: unknown): string | null {
  const wrapped = object(value);
  const date = object(wrapped["date"] ?? value);
  const year = finiteNumber(date["year"]);
  const month = finiteNumber(date["month"]);
  const day = finiteNumber(date["day"]);
  if (year === null || month === null || day === null) return null;
  const candidate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  try {
    dateParts(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export function dateObject(date: string): JsonRecord {
  return dateParts(date);
}

function pointDate(point: JsonRecord, field: string): string | null {
  return civilDateFromValue(object(point[field])["date"]);
}

export function daysBetween(start: string, endExclusive: string): number {
  return (
    (Date.parse(`${endExclusive}T00:00:00Z`) -
      Date.parse(`${start}T00:00:00Z`)) /
    86_400_000
  );
}

export function datesInRange(start: string, endExclusive: string): string[] {
  const count = daysBetween(start, endExclusive);
  if (!Number.isInteger(count) || count < 1 || count > 31)
    throw new TypeError(
      "Date range must contain 1 to 31 valid consecutive civil dates.",
    );
  const dates: string[] = [];
  for (let date = start; date < endExclusive; date = nextCivilDate(date))
    dates.push(date);
  return dates;
}

function durationSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d+(?:\.\d+)?)s$/);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

function civilClock(value: unknown): string | null {
  const time = object(object(value)["time"]);
  const hours = finiteNumber(time["hours"]);
  const minutes = finiteNumber(time["minutes"]);
  if (
    hours === null ||
    minutes === null ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  )
    return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function sleepSessions(sleep: JsonRecord): JsonRecord[] {
  const points = sleep["dataPoints"];
  return Array.isArray(points) ? points.map(object) : [];
}

/** Stage entries are a timeline, so overlapping or invalid intervals are ambiguous. */
function hasValidNonOverlappingStages(stages: readonly JsonRecord[]): boolean {
  const intervals = stages.map((stage) => ({
    start: Date.parse(String(stage["startTime"] ?? "")),
    end: Date.parse(String(stage["endTime"] ?? "")),
  }));
  if (
    intervals.some(
      ({ start, end }) =>
        !Number.isFinite(start) || !Number.isFinite(end) || end <= start,
    )
  )
    return false;
  intervals.sort((a, b) => a.start - b.start);
  return intervals.every(
    (interval, index) =>
      index === 0 || interval.start >= intervals[index - 1]!.end,
  );
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
  const restingHeartRate = object(
    object(input.dailyMeasurements?.restingHeartRate)["dailyRestingHeartRate"],
  );
  const dailyHrv = object(
    object(input.dailyMeasurements?.heartRateVariability)[
      "dailyHeartRateVariability"
    ],
  );
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
        civilStartTime: interval["civilStartTime"] ?? null,
        civilEndTime: interval["civilEndTime"] ?? null,
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
    const start = Date.parse(session.startTime);
    const end = Date.parse(session.endTime);
    // Treat reversed and zero-length sessions as invalid, not as zero sleep.
    return !Number.isFinite(start) || !Number.isFinite(end) || end <= start;
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
      if (!hasValidNonOverlappingStages(session.stageIntervals)) return null;
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
      // Do not infer primary sleep from a nap or a session explicitly marked
      // mainSleep=false; use a fallback only when one candidate remains.
      const candidates = ordered.filter(
        (session) => session.nap !== true && session.mainSleep !== false,
      );
      return candidates.length === 1 ? candidates[0] : undefined;
    })();
  const publicSleepSessions = ordered.map((session) => {
    const output = { ...session };
    Reflect.deleteProperty(output, "stagesSummary");
    Reflect.deleteProperty(output, "stageIntervals");
    return output;
  });
  const exercises = (input.exerciseSessions ?? []).map((point) => {
    const exercise = object(point["exercise"]);
    const interval = object(exercise["interval"]);
    const metricsSummary = object(exercise["metricsSummary"]);
    const duration = durationSeconds(exercise["activeDuration"]);
    const millimeters = finiteNumber(metricsSummary["distanceMillimeters"]);
    return {
      name: typeof point["name"] === "string" ? point["name"] : null,
      exerciseType:
        typeof exercise["exerciseType"] === "string"
          ? exercise["exerciseType"]
          : null,
      displayName:
        typeof exercise["displayName"] === "string"
          ? exercise["displayName"]
          : null,
      startTime:
        typeof interval["startTime"] === "string"
          ? interval["startTime"]
          : null,
      endTime:
        typeof interval["endTime"] === "string" ? interval["endTime"] : null,
      activeMinutes: duration === null ? null : Math.round(duration / 60),
      caloriesKcal: finiteNumber(metricsSummary["caloriesKcal"]),
      distanceMeters: millimeters === null ? null : millimeters / 1000,
    };
  });
  const exerciseMinutes = exercises.some(
    (exercise) => exercise.activeMinutes === null,
  )
    ? null
    : exercises.reduce<number | null>((total, exercise) => {
        const minutes = finiteNumber(exercise.activeMinutes);
        return minutes === null ? total : (total ?? 0) + minutes;
      }, null);

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
      restingHeartRate: metric(
        finiteNumber(restingHeartRate["beatsPerMinute"]),
        "bpm",
      ),
      heartRateVariability: metric(
        finiteNumber(dailyHrv["averageHeartRateVariabilityMilliseconds"]),
        "ms",
      ),
      heartRateVariabilityDeepSleepRmssd: metric(
        finiteNumber(
          dailyHrv[
            "deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds"
          ],
        ),
        "ms",
      ),
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
      primarySleepLocalTimes: primarySleep
        ? {
            bedtime: civilClock(primarySleep.civilStartTime),
            wakeTime: civilClock(primarySleep.civilEndTime),
          }
        : null,
      exerciseCount:
        input.exerciseSessions === undefined ? null : exercises.length,
      exerciseMinutes: metric(
        exerciseMinutes === null && exercises.length > 0
          ? null
          : (exerciseMinutes ??
              (input.exerciseSessions === undefined ? null : 0)),
        "min",
      ),
    },
    sleepSessions: publicSleepSessions,
    exerciseSessions: input.exerciseSessions === undefined ? null : exercises,
    dataQuality: {
      // A successful empty rollup still carries rollupDataPoints: []. Failed
      // or unsupported requests are represented by {}, so omit those here.
      rollupTypesReturned: ROLLUP_TYPES.filter((type) =>
        Array.isArray(input.rollups[type]?.["rollupDataPoints"]),
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
      const [restingResult, hrvResult, exerciseResult] =
        await Promise.allSettled([
          fetchDailyRecords(
            api,
            "daily-resting-heart-rate",
            date,
            nextCivilDate(date),
          ),
          fetchDailyRecords(
            api,
            "daily-heart-rate-variability",
            date,
            nextCivilDate(date),
          ),
          fetchBoundedSessions(api, "exercise", date, nextCivilDate(date)),
        ]);
      const firstRecord = (
        result: PromiseSettledResult<Map<string, JsonRecord>>,
        type: string,
      ) => {
        if (result.status === "fulfilled") return result.value.get(date);
        unavailableMetrics.push({
          metric: type,
          reason: "request_failed_or_incomplete",
        });
        return undefined;
      };
      const exerciseSessions =
        exerciseResult.status === "fulfilled"
          ? exerciseResult.value
          : (unavailableMetrics.push({
              metric: "exercise",
              reason: "request_failed_or_incomplete",
            }),
            undefined);
      const sleep = { dataPoints: sleepPoints };
      return toolResult(
        buildDailySummary({
          date,
          timeZone,
          rollups,
          sleep,
          dailyMeasurements: {
            restingHeartRate: firstRecord(
              restingResult,
              "daily-resting-heart-rate",
            ),
            heartRateVariability: firstRecord(
              hrvResult,
              "daily-heart-rate-variability",
            ),
          },
          exerciseSessions,
          unavailableMetrics,
        }),
      );
    },
  );
}

function dateMapFromPoints(
  points: unknown,
  field: string,
): Map<string, JsonRecord> {
  const result = new Map<string, JsonRecord>();
  if (!Array.isArray(points)) return result;
  for (const value of points) {
    const point = object(value);
    const date = pointDate(point, field);
    if (date) result.set(date, point);
  }
  return result;
}

export async function fetchDailyRecords(
  api: HealthApi,
  dataType: "daily-resting-heart-rate" | "daily-heart-rate-variability",
  start: string,
  endExclusive: string,
): Promise<Map<string, JsonRecord>> {
  assertOperationAllowed(dataType, "list");
  const capability = getCapability(dataType)!;
  const result = await api.request<JsonRecord>({
    methodId: "health.users.dataTypes.dataPoints.list",
    apiVersion: defaultApiVersionForDataType(dataType),
    pathParams: { parent: `users/me/dataTypes/${dataType}` },
    query: {
      filter: `${capability.filterParameter}.date >= "${start}" AND ${capability.filterParameter}.date < "${endExclusive}"`,
      pageSize: 90,
    },
  });
  const field =
    dataType === "daily-resting-heart-rate"
      ? "dailyRestingHeartRate"
      : "dailyHeartRateVariability";
  return dateMapFromPoints(result["dataPoints"], field);
}

export async function fetchBoundedSessions(
  api: HealthApi,
  dataType: "sleep" | "exercise",
  start: string,
  endExclusive: string,
): Promise<JsonRecord[]> {
  assertOperationAllowed(dataType, "reconcile");
  const field = dataType === "sleep" ? "civil_end_time" : "civil_start_time";
  const filter = `${dataType}.interval.${field} >= "${start}" AND ${dataType}.interval.${field} < "${endExclusive}"`;
  const records: JsonRecord[] = [];
  let pageToken: string | undefined;
  // Session endpoints cap pages at 25; this keeps a summary bounded to 250 sessions.
  for (let page = 0; page < 10; page += 1) {
    const result = await api.request<JsonRecord>({
      methodId: "health.users.dataTypes.dataPoints.reconcile",
      pathParams: { parent: `users/me/dataTypes/${dataType}` },
      query: { filter, pageSize: 25, ...(pageToken ? { pageToken } : {}) },
    });
    const points = result["dataPoints"];
    if (!Array.isArray(points))
      throw new TypeError(`Missing ${dataType} records in API response.`);
    records.push(...points.map(object));
    const next = result["nextPageToken"];
    pageToken = typeof next === "string" && next ? next : undefined;
    if (!pageToken) return records;
  }
  throw new TypeError(`${dataType} session page limit reached.`);
}
