import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  assertOperationAllowed,
  getCapability,
} from "../google-health/capabilities.js";
import type { HealthApi } from "../google-health/client.js";
import { toolCatalog } from "./catalog.js";
import { toolOutputSchema, toolResult } from "./results.js";
import {
  buildDailySummary,
  civilDateFromValue,
  dateObject,
  dateParts,
  daysBetween,
  datesInRange,
  fetchBoundedSessions,
  fetchDailyRecords,
  finiteNumber,
  intervalCivilDateTime,
  nextCivilDate,
  object,
  ROLLUP_TYPES,
  type JsonRecord,
} from "./summaries.js";

interface LoadedRange {
  timeZone: string | null;
  dailyRollups: Map<string, Map<string, JsonRecord[]>>;
  restingByDate: Map<string, JsonRecord>;
  hrvByDate: Map<string, JsonRecord>;
  sleepByDate: Map<string, JsonRecord[]>;
  exerciseByDate: Map<string, JsonRecord[]>;
  unavailableMetrics: { metric: string; reason: string }[];
}

function addToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

async function loadSummaryRange(
  api: HealthApi,
  start: string,
  endExclusive: string,
): Promise<LoadedRange> {
  datesInRange(start, endExclusive);
  const unavailableMetrics: { metric: string; reason: string }[] = [];
  let timeZone: string | null = null;
  try {
    const settings = await api.request<JsonRecord>({
      methodId: "health.users.getSettings",
      pathParams: { name: "users/me/settings" },
    });
    const candidate = settings["timeZone"];
    if (typeof candidate === "string") {
      try {
        new Intl.DateTimeFormat("en", { timeZone: candidate });
        timeZone = candidate;
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

  // API discovery caps four daily rollups at 14 days; split those requests while
  // keeping one request per wider-range metric whenever the 90-day cap permits.
  const dailyRollups = new Map<string, Map<string, JsonRecord[]>>();
  await Promise.all(
    ROLLUP_TYPES.map(async (dataType) => {
      const capability = getCapability(dataType);
      if (!capability?.operations.includes("dailyRollUp")) return;
      assertOperationAllowed(dataType, "dailyRollUp");
      const maximumWindow = [
        "calories-in-heart-rate-zone",
        "heart-rate",
        "active-minutes",
        "total-calories",
      ].includes(dataType)
        ? 14
        : 90;
      const byDate = new Map<string, JsonRecord[]>();
      try {
        let windowStart = start;
        while (windowStart < endExclusive) {
          let windowEnd = windowStart;
          for (
            let index = 0;
            index < maximumWindow && windowEnd < endExclusive;
            index += 1
          )
            windowEnd = nextCivilDate(windowEnd);
          const windowDays = daysBetween(windowStart, windowEnd);
          let pageToken: string | undefined;
          for (let page = 0; page < 3; page += 1) {
            const result = await api.request<JsonRecord>({
              methodId: "health.users.dataTypes.dataPoints.dailyRollUp",
              pathParams: { parent: `users/me/dataTypes/${dataType}` },
              body: {
                range: {
                  start: { date: dateObject(windowStart) },
                  end: { date: dateObject(windowEnd) },
                },
                windowSizeDays: 1,
                pageSize: windowDays,
                ...(pageToken ? { pageToken } : {}),
              },
            });
            const points = result["rollupDataPoints"];
            if (points !== undefined && !Array.isArray(points))
              throw new TypeError("Missing daily rollup points.");
            for (const value of Array.isArray(points) ? points : []) {
              const point = object(value);
              const date = civilDateFromValue(
                object(point["civilStartTime"])["date"],
              );
              if (date && date >= start && date < endExclusive)
                addToMap(byDate, date, point);
            }
            const token = result["nextPageToken"];
            pageToken = typeof token === "string" && token ? token : undefined;
            if (!pageToken) break;
            if (page === 2)
              throw new TypeError("Daily rollup page limit reached.");
          }
          windowStart = windowEnd;
        }
        dailyRollups.set(dataType, byDate);
      } catch {
        unavailableMetrics.push({
          metric: dataType,
          reason: "request_failed_or_incomplete",
        });
        dailyRollups.delete(dataType);
      }
    }),
  );

  const [restingResult, hrvResult, sleepResult, exerciseResult] =
    await Promise.allSettled([
      fetchDailyRecords(api, "daily-resting-heart-rate", start, endExclusive),
      fetchDailyRecords(
        api,
        "daily-heart-rate-variability",
        start,
        endExclusive,
      ),
      fetchBoundedSessions(api, "sleep", start, endExclusive),
      fetchBoundedSessions(api, "exercise", start, endExclusive),
    ]);
  const capture = <T>(
    result: PromiseSettledResult<T>,
    metricName: string,
    fallback: T,
  ): T => {
    if (result.status === "fulfilled") return result.value;
    unavailableMetrics.push({
      metric: metricName,
      reason: "request_failed_or_incomplete",
    });
    return fallback;
  };
  const emptyDateMap = new Map<string, JsonRecord>();
  const restingByDate = capture(
    restingResult,
    "daily-resting-heart-rate",
    emptyDateMap,
  );
  const hrvByDate = capture(
    hrvResult,
    "daily-heart-rate-variability",
    emptyDateMap,
  );
  const sleepRecords = capture<JsonRecord[]>(sleepResult, "sleep", []);
  const exerciseRecords = capture<JsonRecord[]>(exerciseResult, "exercise", []);
  const sleepByDate = new Map<string, JsonRecord[]>();
  for (const point of sleepRecords) {
    const interval = object(object(point["sleep"])["interval"]);
    const date = civilDateFromValue(intervalCivilDateTime(interval, "end"));
    if (date && date >= start && date < endExclusive)
      addToMap(sleepByDate, date, point);
  }
  const exerciseByDate = new Map<string, JsonRecord[]>();
  for (const point of exerciseRecords) {
    const interval = object(object(point["exercise"])["interval"]);
    const date = civilDateFromValue(intervalCivilDateTime(interval, "start"));
    if (date && date >= start && date < endExclusive)
      addToMap(exerciseByDate, date, point);
  }

  return {
    timeZone,
    dailyRollups,
    restingByDate,
    hrvByDate,
    sleepByDate,
    exerciseByDate,
    unavailableMetrics,
  };
}

function summaryRows(
  dates: readonly string[],
  loaded: LoadedRange,
): JsonRecord[] {
  return dates.map((date) => {
    const rollups: Record<string, JsonRecord> = {};
    for (const dataType of ROLLUP_TYPES) {
      const successfullyLoaded = loaded.dailyRollups.get(dataType);
      if (successfullyLoaded) {
        rollups[dataType] = {
          rollupDataPoints: successfullyLoaded.get(date) ?? [],
        };
      }
    }
    const summary = buildDailySummary({
      date,
      timeZone: loaded.timeZone,
      rollups,
      sleep: { dataPoints: loaded.sleepByDate.get(date) ?? [] },
      exerciseSessions: loaded.unavailableMetrics.some(
        (item) => item.metric === "exercise",
      )
        ? undefined
        : (loaded.exerciseByDate.get(date) ?? []),
      dailyMeasurements: {
        restingHeartRate: loaded.restingByDate.get(date),
        heartRateVariability: loaded.hrvByDate.get(date),
      },
      unavailableMetrics: loaded.unavailableMetrics,
    });
    return {
      date,
      metrics: summary["metrics"],
      dataQuality: summary["dataQuality"],
    };
  });
}

function metricNumber(row: JsonRecord, name: string): number | null {
  const metrics = object(row["metrics"]);
  const value = metrics[name];
  if (typeof value === "number") return value;
  return finiteNumber(object(value)["value"]);
}

function rangeAggregate(
  rows: readonly JsonRecord[],
  name: string,
  unit: string,
  mode: "sum" | "average" | "latest",
): JsonRecord {
  const observed = rows
    .map((row) => ({
      date: String(row["date"]),
      value: metricNumber(row, name),
    }))
    .filter(
      (item): item is { date: string; value: number } => item.value !== null,
    );
  const values = observed.map((item) => item.value);
  const value =
    values.length === 0
      ? null
      : mode === "sum"
        ? values.reduce((sum, current) => sum + current, 0)
        : mode === "average"
          ? values.reduce((sum, current) => sum + current, 0) / values.length
          : observed.at(-1)!.value;
  return {
    value,
    unit,
    daysReported: observed.length,
    daysInRange: rows.length,
  };
}

function circularClockSummary(
  rows: readonly JsonRecord[],
  key: "bedtime" | "wakeTime",
): JsonRecord {
  const minutes = rows
    .map((row) => {
      const localTimes = object(
        object(row["metrics"])["primarySleepLocalTimes"],
      );
      const value = localTimes[key];
      if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value))
        return null;
      const [hour, minute] = value.split(":").map(Number);
      return hour! <= 23 && minute! <= 59 ? hour! * 60 + minute! : null;
    })
    .filter((value): value is number => value !== null);
  if (minutes.length === 0)
    return {
      averageLocalTime: null,
      circularStdDevMinutes: null,
      daysReported: 0,
    };
  const angles = minutes.map((value) => (value / 1440) * Math.PI * 2);
  const sin =
    angles.reduce((sum, angle) => sum + Math.sin(angle), 0) / angles.length;
  const cos =
    angles.reduce((sum, angle) => sum + Math.cos(angle), 0) / angles.length;
  const resultantLength = Math.min(1, Math.hypot(sin, cos));
  const meanAngle = (Math.atan2(sin, cos) + Math.PI * 2) % (Math.PI * 2);
  const meanMinutes = Math.round((meanAngle / (Math.PI * 2)) * 1440) % 1440;
  const standardDeviation =
    resultantLength <= 0
      ? null
      : Math.round(
          (Math.sqrt(-2 * Math.log(resultantLength)) * 1440) / (Math.PI * 2),
        );
  return {
    averageLocalTime: `${String(Math.floor(meanMinutes / 60)).padStart(2, "0")}:${String(meanMinutes % 60).padStart(2, "0")}`,
    circularStdDevMinutes: standardDeviation,
    daysReported: minutes.length,
  };
}

export function buildRangeSummary(
  startDate: string,
  endDate: string,
  rows: readonly JsonRecord[],
): JsonRecord {
  // Input endDate is inclusive; API requests use a closed-open end boundary.
  const dates = datesInRange(startDate, nextCivilDate(endDate));
  if (rows.length !== dates.length)
    throw new TypeError("Summary rows must cover every requested date.");
  const sums = {
    steps: rangeAggregate(rows, "steps", "steps", "sum"),
    distance: rangeAggregate(rows, "distance", "m", "sum"),
    activeEnergy: rangeAggregate(rows, "activeEnergy", "kcal", "sum"),
    totalCalories: rangeAggregate(rows, "totalCalories", "kcal", "sum"),
    activeMinutes: rangeAggregate(rows, "activeMinutes", "min", "sum"),
    hydration: rangeAggregate(rows, "hydration", "ml", "sum"),
    exerciseMinutes: rangeAggregate(rows, "exerciseMinutes", "min", "sum"),
  };
  const averages = {
    sleepMinutesAsleep: rangeAggregate(
      rows,
      "sleepMinutesAsleep",
      "min",
      "average",
    ),
    averageHeartRate: rangeAggregate(
      rows,
      "averageHeartRate",
      "bpm",
      "average",
    ),
    restingHeartRate: rangeAggregate(
      rows,
      "restingHeartRate",
      "bpm",
      "average",
    ),
    heartRateVariability: rangeAggregate(
      rows,
      "heartRateVariability",
      "ms",
      "average",
    ),
  };
  const latestWeight = rangeAggregate(rows, "averageWeight", "kg", "latest");
  const midpoint = Math.ceil(rows.length / 2);
  const compare = (name: string): JsonRecord => {
    const first = rangeAggregate(rows.slice(0, midpoint), name, "", "average");
    const second = rangeAggregate(rows.slice(midpoint), name, "", "average");
    const firstValue = finiteNumber(first["value"]);
    const secondValue = finiteNumber(second["value"]);
    return {
      firstHalfAverage: firstValue,
      secondHalfAverage: secondValue,
      percentChange:
        firstValue === null || secondValue === null || firstValue === 0
          ? null
          : ((secondValue - firstValue) / Math.abs(firstValue)) * 100,
    };
  };
  return {
    dateRange: { startDate, endDate, days: rows.length, timeZone: null },
    totals: sums,
    averages,
    latestWeight,
    sleepTimingConsistency: {
      method:
        "Circular statistics over Google's source civil clock times for sessions marked as primary sleep. No timezone conversion is applied.",
      bedtime: circularClockSummary(rows, "bedtime"),
      wakeTime: circularClockSummary(rows, "wakeTime"),
    },
    comparisons: {
      steps: compare("steps"),
      sleepMinutesAsleep: compare("sleepMinutesAsleep"),
      restingHeartRate: compare("restingHeartRate"),
    },
    daily: rows,
    dataCompleteness: Object.fromEntries(
      [
        "steps",
        "distance",
        "activeEnergy",
        "activeMinutes",
        "sleepMinutesAsleep",
        "averageHeartRate",
        "restingHeartRate",
        "heartRateVariability",
        "hydration",
        "exerciseMinutes",
        "averageWeight",
      ].map((name) => [
        name,
        {
          daysReported: rows.filter((row) => metricNumber(row, name) !== null)
            .length,
          daysInRange: rows.length,
        },
      ]),
    ),
  };
}

export async function getHealthSummaryForRange(
  api: HealthApi,
  startDate: string,
  endDate: string,
): Promise<JsonRecord> {
  dateParts(startDate);
  dateParts(endDate);
  const endExclusive = nextCivilDate(endDate);
  const dates = datesInRange(startDate, endExclusive);
  const loaded = await loadSummaryRange(api, startDate, endExclusive);
  const summary = buildRangeSummary(
    startDate,
    endDate,
    summaryRows(dates, loaded),
  );
  object(summary["dateRange"])["timeZone"] = loaded.timeZone;
  return summary;
}

export function registerRangeSummaryTool(
  server: McpServer,
  api: HealthApi,
): void {
  const definition = toolCatalog.find(
    (tool) => tool.name === "get_health_summary",
  )!;
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      annotations: definition.annotations,
      inputSchema: z.object({
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Inclusive first source-civil calendar date."),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe(
            "Inclusive last source-civil calendar date; the range may contain at most 31 days.",
          ),
      }),
      outputSchema: toolOutputSchema,
    },
    async ({ startDate, endDate }) => {
      return toolResult(
        await getHealthSummaryForRange(api, startDate, endDate),
      );
    },
  );
}
