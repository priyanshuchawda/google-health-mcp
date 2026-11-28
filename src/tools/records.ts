import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  assertOperationAllowed,
  defaultApiVersionForDataType,
  getCapability,
} from "../google-health/capabilities.js";
import type { HealthApi } from "../google-health/client.js";
import { buildDateFilter } from "../google-health/filters.js";
import { normalizeOwnedDataPointName } from "../google-health/resources.js";
import { toolCatalog } from "./catalog.js";
import { toolOutputSchema, toolResult } from "./results.js";

const dataTypeNames = z.string().min(1).max(80);
const dateRangeSchema = {
  start: z.string().min(10).max(40).optional(),
  end: z.string().min(10).max(40).optional(),
};
const API_VERSION = z.enum(["v4", "v4beta"]);
const operationRead = z.enum([
  "list",
  "get",
  "reconcile",
  "rollUp",
  "dailyRollUp",
]);
const dataSourceFamily = z.enum([
  "all-sources",
  "google-wearables",
  "google-sources",
  "self-sources",
]);
const recordSchema = z.record(z.string(), z.unknown());

function buildSourceFamily(value: z.infer<typeof dataSourceFamily>): string {
  return `users/me/dataSourceFamilies/${value}`;
}

function ensureApiRange(
  dataType: string,
  operation: "rollUp" | "dailyRollUp",
  requestBody: Record<string, unknown>,
): void {
  const range = requestBody["range"];
  if (!range || typeof range !== "object" || Array.isArray(range)) return;
  const data = range as Record<string, unknown>;
  let start: string | undefined;
  let end: string | undefined;
  if (operation === "rollUp") {
    start =
      typeof data["startTime"] === "string" ? data["startTime"] : undefined;
    end = typeof data["endTime"] === "string" ? data["endTime"] : undefined;
  } else {
    const civilDate = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
      const date = (value as Record<string, unknown>)["date"];
      if (!date || typeof date !== "object" || Array.isArray(date))
        return undefined;
      const parts = date as Record<string, unknown>;
      if (
        !["year", "month", "day"].every((key) => typeof parts[key] === "number")
      )
        return undefined;
      const year = String(parts["year"]).padStart(4, "0");
      const month = String(parts["month"]).padStart(2, "0");
      const day = String(parts["day"]).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };
    start = civilDate(data["start"]);
    end = civilDate(data["end"]);
  }
  if (!start || !end)
    throw new TypeError(
      "Rollup requests must include both range start and end.",
    );
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    startTime >= endTime
  ) {
    throw new TypeError(
      "Rollup range must contain valid ordered start and end dates.",
    );
  }
  const restricted14Days = [
    "calories-in-heart-rate-zone",
    "heart-rate",
    "active-minutes",
    "total-calories",
  ].includes(dataType);
  const maximumDays = restricted14Days ? 14 : 90;
  if ((endTime - startTime) / 86_400_000 > maximumDays) {
    throw new TypeError(
      `${dataType} ${operation} range cannot exceed ${maximumDays} days.`,
    );
  }
}

export function registerRecordTools(server: McpServer, api: HealthApi): void {
  const getTool = toolCatalog.find((tool) => tool.name === "get_health_data")!;
  server.registerTool(
    getTool.name,
    {
      title: getTool.title,
      description: getTool.description,
      annotations: getTool.annotations,
      inputSchema: z.object({
        dataType: dataTypeNames,
        operation: operationRead,
        apiVersion: API_VERSION.optional(),
        ...dateRangeSchema,
        pageSize: z.number().int().min(1).max(100).optional(),
        pageToken: z.string().min(1).max(4096).optional(),
        dataSourceFamily: dataSourceFamily.optional(),
        recordName: z.string().min(1).max(512).optional(),
        requestBody: recordSchema.optional(),
      }),
      outputSchema: toolOutputSchema,
    },
    async (input) => {
      const capability = getCapability(input.dataType);
      if (!capability)
        throw new TypeError(
          `Unsupported Google Health data type: ${input.dataType}.`,
        );
      assertOperationAllowed(input.dataType, input.operation);
      const apiVersion =
        input.apiVersion ?? defaultApiVersionForDataType(input.dataType);
      if (capability.beta === true && apiVersion !== "v4beta") {
        throw new TypeError(
          `${input.dataType} is documented only in v4beta; omit apiVersion to select it automatically or set apiVersion to v4beta.`,
        );
      }
      if (apiVersion === "v4beta" && input.operation === "get") {
        throw new TypeError(
          "Individual record reads use the stable v4 endpoint only.",
        );
      }
      const parent = `users/me/dataTypes/${input.dataType}`;
      if (input.operation === "get") {
        if (!input.recordName)
          throw new TypeError("recordName is required when operation is get.");
        const recordName = await normalizeOwnedDataPointName(
          api,
          input.recordName,
          input.dataType,
        );
        if (
          input.requestBody ||
          input.start ||
          input.end ||
          input.pageToken ||
          input.pageSize ||
          input.dataSourceFamily
        ) {
          throw new TypeError(
            "get accepts only dataType, operation, apiVersion, and recordName.",
          );
        }
        return toolResult(
          await api.request({
            methodId: "health.users.dataTypes.dataPoints.get",
            apiVersion,
            pathParams: { name: recordName },
          }),
        );
      }

      if (input.recordName)
        throw new TypeError("recordName is only valid when operation is get.");
      if (input.operation === "rollUp" || input.operation === "dailyRollUp") {
        if (!input.requestBody)
          throw new TypeError(
            `requestBody is required for ${input.operation}.`,
          );
        if (
          input.start ||
          input.end ||
          input.pageSize ||
          input.pageToken ||
          input.dataSourceFamily
        ) {
          throw new TypeError(
            "Use the validated requestBody for rollup ranges, pagination, and data source selection.",
          );
        }
        ensureApiRange(input.dataType, input.operation, input.requestBody);
        return toolResult(
          await api.request({
            methodId: `health.users.dataTypes.dataPoints.${input.operation}`,
            apiVersion,
            pathParams: { parent },
            body: input.requestBody,
          }),
        );
      }

      if (input.requestBody)
        throw new TypeError(
          "requestBody is only valid for rollUp or dailyRollUp.",
        );
      const pageLimit = ["sleep", "exercise"].includes(input.dataType)
        ? 25
        : 100;
      if (input.pageSize && input.pageSize > pageLimit) {
        throw new TypeError(
          `${input.dataType} pageSize cannot exceed ${pageLimit}.`,
        );
      }
      if (
        input.dataSourceFamily &&
        ["sleep", "food", "food-measurement-unit"].includes(input.dataType)
      ) {
        throw new TypeError(
          `${input.dataType} does not support dataSourceFamily filtering.`,
        );
      }
      const filter = buildDateFilter(capability, input.start, input.end);
      const source = input.dataSourceFamily
        ? buildSourceFamily(input.dataSourceFamily)
        : undefined;
      const query = {
        ...(filter ? { filter } : {}),
        ...(input.pageSize ? { pageSize: input.pageSize } : {}),
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
        ...(source ? { dataSourceFamily: source } : {}),
      };
      return toolResult(
        await api.request({
          methodId: `health.users.dataTypes.dataPoints.${input.operation}`,
          apiVersion,
          pathParams: { parent },
          query,
        }),
      );
    },
  );

  const createTool = toolCatalog.find(
    (tool) => tool.name === "create_health_record",
  )!;
  server.registerTool(
    createTool.name,
    {
      title: createTool.title,
      description: createTool.description,
      annotations: createTool.annotations,
      inputSchema: z.object({ dataType: dataTypeNames, record: recordSchema }),
      outputSchema: toolOutputSchema,
    },
    async ({ dataType, record }) => {
      assertOperationAllowed(dataType, "create");
      const response = await api.request<Record<string, unknown>>({
        methodId: "health.users.dataTypes.dataPoints.create",
        pathParams: { parent: `users/me/dataTypes/${dataType}` },
        body: record,
      });
      return toolResult(writeOperationResult(response));
    },
  );

  const updateTool = toolCatalog.find(
    (tool) => tool.name === "update_health_record",
  )!;
  server.registerTool(
    updateTool.name,
    {
      title: updateTool.title,
      description: updateTool.description,
      annotations: updateTool.annotations,
      inputSchema: z.object({
        dataType: dataTypeNames,
        recordName: z.string().min(1).max(512),
        record: recordSchema,
      }),
      outputSchema: toolOutputSchema,
    },
    async ({ dataType, recordName, record }) => {
      assertOperationAllowed(dataType, "patch");
      const ownedRecordName = await normalizeOwnedDataPointName(
        api,
        recordName,
        dataType,
      );
      if (
        record["name"] !== undefined &&
        record["name"] !== recordName &&
        record["name"] !== ownedRecordName
      ) {
        throw new TypeError(
          "The record name in the payload must match recordName.",
        );
      }
      const response = await api.request<Record<string, unknown>>({
        methodId: "health.users.dataTypes.dataPoints.patch",
        pathParams: { name: ownedRecordName },
        body: { ...record, name: ownedRecordName },
      });
      return toolResult(writeOperationResult(response));
    },
  );

  const deleteTool = toolCatalog.find(
    (tool) => tool.name === "delete_health_records",
  )!;
  server.registerTool(
    deleteTool.name,
    {
      title: deleteTool.title,
      description: deleteTool.description,
      annotations: deleteTool.annotations,
      inputSchema: z.object({
        dataType: dataTypeNames,
        recordNames: z.array(z.string().min(1).max(512)).min(1).max(100),
        confirm: z
          .boolean()
          .describe(
            "Set true only after the user confirms deletion of these exact record names.",
          ),
      }),
      outputSchema: toolOutputSchema,
    },
    async ({ dataType, recordNames, confirm }) => {
      assertOperationAllowed(dataType, "batchDelete");
      if (!confirm)
        throw new TypeError(
          "Deletion requires confirm=true after user confirmation.",
        );
      const ownedRecordNames = await Promise.all(
        recordNames.map((name) =>
          normalizeOwnedDataPointName(api, name, dataType),
        ),
      );
      const parent = `users/me/dataTypes/${dataType}`;
      const response = await api.request<Record<string, unknown>>({
        methodId: "health.users.dataTypes.dataPoints.batchDelete",
        pathParams: { parent },
        body: { names: ownedRecordNames },
      });
      return toolResult(writeOperationResult(response));
    },
  );

  const exportTool = toolCatalog.find(
    (tool) => tool.name === "export_exercise_tcx",
  )!;
  server.registerTool(
    exportTool.name,
    {
      title: exportTool.title,
      description: exportTool.description,
      annotations: exportTool.annotations,
      inputSchema: z.object({ recordName: z.string().min(1).max(512) }),
      outputSchema: toolOutputSchema,
    },
    async ({ recordName }) => {
      const ownedRecordName = await normalizeOwnedDataPointName(
        api,
        recordName,
        "exercise",
      );
      const xml = await api.request<string>({
        methodId: "health.users.dataTypes.dataPoints.exportExerciseTcx",
        pathParams: { name: ownedRecordName },
        query: { alt: "media" },
        responseType: "text",
      });
      return toolResult({ format: "tcx", xml });
    },
  );
}

export function writeOperationResult(
  operation: Record<string, unknown>,
): Record<string, unknown> {
  if (operation["error"])
    throw new Error("Google Health reported a write operation error.");
  if (operation["done"] === true)
    return {
      status: "completed",
      operation: operation["response"] ?? operation,
    };
  if (operation["done"] === false) return { status: "pending", operation };
  return { status: "response_received_unconfirmed", operation };
}
