import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getCapability } from "../google-health/capabilities.js";
import type { HealthApi } from "../google-health/client.js";
import { toolCatalog } from "./catalog.js";
import { toolOutputSchema, toolResult } from "./results.js";
import {
  civilDateFromValue,
  daysBetween,
  nextCivilDate,
  object,
} from "./summaries.js";
import type { JsonRecord } from "./summaries.js";

const FRESHNESS_DEFAULT_TYPES = [
  "steps",
  "heart-rate",
  "sleep",
  "exercise",
  "weight",
  "hydration-log",
] as const;

function slugField(slug: string): string {
  return slug.replace(/-([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

function recordTimestamp(point: JsonRecord, dataType: string): string | null {
  const record = object(point[slugField(dataType)]);
  const interval = object(record["interval"]);
  const sampleTime = object(record["sampleTime"]);
  const timestamp =
    interval["endTime"] ??
    interval["startTime"] ??
    sampleTime["physicalTime"] ??
    record["date"];
  if (typeof timestamp === "string") return timestamp;
  const date = civilDateFromValue(timestamp);
  return date;
}

export function registerDataFreshnessTool(
  server: McpServer,
  api: HealthApi,
): void {
  const definition = toolCatalog.find(
    (tool) => tool.name === "get_data_freshness",
  )!;
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      annotations: definition.annotations,
      inputSchema: z.object({
        dataTypes: z
          .array(z.string().min(1).max(80))
          .max(8)
          .optional()
          .describe(
            "Up to eight types from list_data_types. Defaults to steps, heart rate, sleep, exercise, weight, and hydration.",
          ),
        lookbackDays: z.number().int().min(1).max(30).default(7),
      }),
      outputSchema: toolOutputSchema,
    },
    async ({ dataTypes, lookbackDays }) => {
      const selected = dataTypes ?? [...FRESHNESS_DEFAULT_TYPES];
      const end = new Date();
      const start = new Date(end.getTime() - lookbackDays * 86_400_000);
      const asDate = (date: Date) => date.toISOString().slice(0, 10);
      const today = asDate(end);
      const dailyStart = new Date(
        Date.UTC(
          end.getUTCFullYear(),
          end.getUTCMonth(),
          end.getUTCDate() - lookbackDays + 1,
        ),
      );
      const rows = await Promise.all(
        selected.map(async (dataType) => {
          const capability = getCapability(dataType);
          if (!capability || !capability.operations.includes("list"))
            return {
              dataType,
              status: "unsupported_for_listing",
              newestReturnedRecord: null,
            };
          if (capability.kind === "Food")
            return {
              dataType,
              status: "not_time_series_data",
              newestReturnedRecord: null,
            };
          try {
            const startBound =
              capability.kind === "Daily"
                ? asDate(dailyStart)
                : `${start.toISOString().slice(0, 19)}Z`;
            const endBound =
              capability.kind === "Daily"
                ? nextCivilDate(today)
                : `${end.toISOString().slice(0, 19)}Z`;
            const points: JsonRecord[] = [];
            let pageToken: string | undefined;
            let paginationTruncated = false;
            for (let page = 0; page < 3; page += 1) {
              const result = await api.request<JsonRecord>({
                methodId: "health.users.dataTypes.dataPoints.list",
                pathParams: { parent: `users/me/dataTypes/${dataType}` },
                query: {
                  filter: buildFreshnessFilter(
                    capability,
                    startBound,
                    endBound,
                  ),
                  pageSize: ["sleep", "exercise"].includes(dataType) ? 25 : 100,
                  ...(pageToken ? { pageToken } : {}),
                },
              });
              if (!Array.isArray(result["dataPoints"]))
                throw new TypeError("The API page did not contain dataPoints.");
              points.push(...result["dataPoints"].map(object));
              const next = result["nextPageToken"];
              pageToken = typeof next === "string" && next ? next : undefined;
              if (!pageToken) break;
              if (page === 2) paginationTruncated = true;
            }
            const newest = points
              .map((point) => ({
                point,
                timestamp: recordTimestamp(point, dataType),
              }))
              .filter(
                (item): item is { point: JsonRecord; timestamp: string } =>
                  item.timestamp !== null,
              )
              .sort(
                (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
              )[0];
            if (!newest)
              return {
                dataType,
                status: "no_record_in_lookback",
                lookbackDays,
                paginationTruncated,
                newestReturnedRecord: null,
              };
            const record = object(newest.point[slugField(dataType)]);
            const parsedTime = Date.parse(newest.timestamp);
            const isCivilDate = /^\d{4}-\d{2}-\d{2}$/.test(newest.timestamp);
            const todayDate = asDate(new Date());
            const ageDays = isCivilDate
              ? daysBetween(newest.timestamp, nextCivilDate(todayDate)) - 1
              : null;
            return {
              dataType,
              status: "record_found",
              lookbackDays,
              paginationTruncated,
              ...(isCivilDate
                ? { measurementCivilDate: newest.timestamp, ageDays }
                : {
                    measurementTime: newest.timestamp,
                    ageHours: Number.isFinite(parsedTime)
                      ? Math.round(
                          ((Date.now() - parsedTime) / 3_600_000) * 10,
                        ) / 10
                      : null,
                  }),
              updatedAt:
                typeof record["updateTime"] === "string"
                  ? record["updateTime"]
                  : null,
              dataSource: newest.point["dataSource"] ?? null,
            };
          } catch {
            return {
              dataType,
              status: "request_failed",
              lookbackDays,
              newestReturnedRecord: null,
            };
          }
        }),
      );
      return toolResult({
        measurementTimeNote:
          "This reports the newest timestamp found in a bounded API listing window. It is not a guaranteed upload/sync time; some data types have no update timestamp.",
        lookbackDays,
        dataTypes: rows,
      });
    },
  );
}

function buildFreshnessFilter(
  capability: ReturnType<typeof getCapability> & {},
  start: string,
  end: string,
): string {
  if (capability.kind === "Daily")
    return `${capability.filterParameter}.date >= "${start}" AND ${capability.filterParameter}.date < "${end}"`;
  if (capability.kind === "Interval")
    return `${capability.filterParameter}.interval.start_time >= "${start}" AND ${capability.filterParameter}.interval.start_time < "${end}"`;
  if (capability.kind === "Sample")
    return `${capability.filterParameter}.sample_time.physical_time >= "${start}" AND ${capability.filterParameter}.sample_time.physical_time < "${end}"`;
  if (capability.slug === "sleep")
    return `sleep.interval.end_time >= "${start}" AND sleep.interval.end_time < "${end}"`;
  if (capability.slug === "electrocardiogram")
    return `electrocardiogram.interval.start_time >= "${start}"`;
  if (capability.kind === "Session")
    return `${capability.filterParameter}.interval.civil_start_time >= "${start.slice(0, 10)}" AND ${capability.filterParameter}.interval.civil_start_time < "${end.slice(0, 10)}"`;
  throw new TypeError(
    `${capability.slug} does not support a bounded freshness query.`,
  );
}
