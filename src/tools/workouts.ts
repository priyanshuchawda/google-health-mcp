import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  apiSchemas,
  assertOperationAllowed,
} from "../google-health/capabilities.js";
import type { HealthApi } from "../google-health/client.js";
import { toolCatalog } from "./catalog.js";
import { toolOutputSchema, toolResult } from "./results.js";
import { writeOperationResult } from "./records.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

const exerciseSchema = object(apiSchemas["v4"]?.["Exercise"]);
const exerciseProperties = object(exerciseSchema["properties"]);
const exerciseTypeSchema = object(exerciseProperties["exerciseType"]);
const documentedExerciseTypes = Array.isArray(exerciseTypeSchema["enum"])
  ? exerciseTypeSchema["enum"].filter(
      (value): value is string =>
        typeof value === "string" && value !== "EXERCISE_TYPE_UNSPECIFIED",
    )
  : [];

if (documentedExerciseTypes.length === 0)
  throw new Error("Google's discovery schema contains no exercise type enum.");

const exerciseTypeInput = z.enum(
  documentedExerciseTypes as [string, ...string[]],
);

function timestampAndOffset(value: string): {
  timestamp: string;
  offset: string;
} {
  // Require a complete RFC 3339 timestamp so a local time is never guessed as UTC.
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match || !Number.isFinite(Date.parse(value)))
    throw new TypeError(
      "Workout timestamps must be valid RFC 3339 values with an explicit UTC offset.",
    );
  const [, local, zone, sign, hoursText, minutesText] = match;
  const [datePart, timePart] = local!.split("T");
  const [year, month, day] = datePart!.split("-").map(Number);
  const [hour, minute, second] = timePart!.split(":").map(Number);
  const calendarDate = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() + 1 !== month ||
    calendarDate.getUTCDate() !== day ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59
  )
    throw new TypeError(
      "Workout timestamp contains an invalid calendar date or clock time.",
    );
  if (zone === "Z") return { timestamp: `${local}Z`, offset: "0s" };
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0))
    throw new TypeError("Workout timestamp has an invalid UTC offset.");
  const seconds = (hours * 60 + minutes) * 60 * (sign === "-" ? -1 : 1);
  return { timestamp: `${local}${zone}`, offset: `${seconds}s` };
}

export function registerWorkoutTool(server: McpServer, api: HealthApi): void {
  const definition = toolCatalog.find((tool) => tool.name === "log_workout")!;
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      annotations: definition.annotations,
      inputSchema: z.object({
        exerciseType: exerciseTypeInput.describe(
          "Exercise type from Google's documented enum.",
        ),
        startTime: z
          .string()
          .min(20)
          .max(40)
          .describe(
            "RFC 3339 start timestamp with Z or an explicit numeric offset, for example 2026-11-28T18:00:00+05:30.",
          ),
        endTime: z
          .string()
          .min(20)
          .max(40)
          .describe(
            "RFC 3339 end timestamp with Z or an explicit numeric offset.",
          ),
        displayName: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Optional title; Google generates it for known exercise types. Required for OTHER.",
          ),
        notes: z.string().trim().max(1000).optional(),
        activeMinutes: z
          .number()
          .finite()
          .positive()
          .optional()
          .describe("Active duration excluding pauses, when known."),
        caloriesKcal: z.number().finite().nonnegative().optional(),
        distanceMeters: z.number().finite().nonnegative().optional(),
        steps: z.number().int().nonnegative().optional(),
        averageHeartRateBpm: z.number().finite().nonnegative().optional(),
      }),
      outputSchema: toolOutputSchema,
    },
    async (input) => {
      assertOperationAllowed("exercise", "create");
      const start = timestampAndOffset(input.startTime);
      const end = timestampAndOffset(input.endTime);
      const elapsedSeconds =
        (Date.parse(end.timestamp) - Date.parse(start.timestamp)) / 1000;
      if (elapsedSeconds <= 0)
        throw new TypeError("Workout endTime must be later than startTime.");
      const activeSeconds =
        input.activeMinutes === undefined
          ? undefined
          : input.activeMinutes * 60;
      if (activeSeconds !== undefined && activeSeconds > elapsedSeconds)
        throw new TypeError(
          "activeMinutes cannot exceed the elapsed workout duration.",
        );
      if (input.exerciseType === "OTHER" && !input.displayName)
        throw new TypeError(
          "displayName is required when exerciseType is OTHER.",
        );

      // Send only user-supplied metrics. The API must not receive fabricated sensor measurements.
      const metricsSummary: JsonObject = {};
      if (input.caloriesKcal !== undefined)
        metricsSummary["caloriesKcal"] = input.caloriesKcal;
      if (input.distanceMeters !== undefined)
        metricsSummary["distanceMillimeters"] = String(
          Math.round(input.distanceMeters * 1000),
        );
      if (input.steps !== undefined)
        metricsSummary["steps"] = String(input.steps);
      if (input.averageHeartRateBpm !== undefined)
        metricsSummary["averageHeartRateBeatsPerMinute"] = String(
          input.averageHeartRateBpm,
        );

      const exercise: JsonObject = {
        interval: {
          startTime: start.timestamp,
          startUtcOffset: start.offset,
          endTime: end.timestamp,
          endUtcOffset: end.offset,
        },
        exerciseType: input.exerciseType,
        metricsSummary,
        displayName:
          input.displayName ??
          input.exerciseType.toLowerCase().replaceAll("_", " "),
        ...(activeSeconds === undefined
          ? {}
          : { activeDuration: `${activeSeconds}s` }),
        ...(input.notes ? { notes: input.notes } : {}),
      };
      const result = await api.request<Record<string, unknown>>({
        methodId: "health.users.dataTypes.dataPoints.create",
        pathParams: { parent: "users/me/dataTypes/exercise" },
        body: { dataSource: { recordingMethod: "MANUAL" }, exercise },
      });
      return toolResult(writeOperationResult(result));
    },
  );
}
