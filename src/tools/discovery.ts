import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  apiSchemas,
  dataTypes,
  defaultApiVersionForDataType,
  getApiMethod,
  getCapability,
} from "../google-health/capabilities.js";
import type {
  ApiMethod,
  HealthDataType,
} from "../google-health/capabilities.js";
import { toolCatalog } from "./catalog.js";
import { toolOutputSchema, toolResult } from "./results.js";

const methodPrefix = "health.users.dataTypes.dataPoints.";
const operationSchema = z.enum([
  "list",
  "get",
  "create",
  "patch",
  "batchDelete",
  "reconcile",
  "rollUp",
  "dailyRollUp",
]);

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function schemasFor(version: "v4" | "v4beta"): Record<string, unknown> {
  return apiSchemas[version] as Record<string, unknown>;
}

function includeReferencedSchemas(
  root: unknown,
  schemas: Record<string, unknown>,
): { schema: unknown; definitions: Record<string, unknown> } {
  const definitions: Record<string, unknown> = {};
  const visited = new Set<string>();

  function visit(value: unknown, depth: number): void {
    if (depth > 24) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const object = objectValue(value);
    if (!object) return;
    const reference = object["$ref"];
    if (typeof reference === "string" && schemas[reference] !== undefined) {
      if (!visited.has(reference)) {
        visited.add(reference);
        definitions[reference] = schemas[reference];
        visit(schemas[reference], depth + 1);
      }
    }
    for (const child of Object.values(object)) visit(child, depth + 1);
  }

  visit(root, 0);
  return { schema: root, definitions };
}

/** Rewrites Google's named discovery references as valid JSON Schema `$defs` refs. */
function normalizeSchemaReferences(
  value: unknown,
  definitions: Record<string, unknown>,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => normalizeSchemaReferences(item, definitions));
  const object = objectValue(value);
  if (!object) return value;

  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => {
      if (key === "$ref" && typeof child === "string" && child in definitions)
        return [
          key,
          `#/$defs/${child.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        ];
      return [key, normalizeSchemaReferences(child, definitions)];
    }),
  );
}

function dataPointPayloadSchema(
  type: HealthDataType,
  schemas: Record<string, unknown>,
): JsonObject | undefined {
  const dataPoint = objectValue(schemas["DataPoint"]);
  const properties = objectValue(dataPoint?.["properties"]);
  if (!properties) return undefined;

  const match = Object.entries(properties).find(([, value]) => {
    const description = objectValue(value)?.["description"];
    return (
      typeof description === "string" &&
      description.includes(`\`${type.slug}\``)
    );
  });
  if (!match) return undefined;

  // Google models all record types as a DataPoint union. Keep the caller's
  // payload example focused on the selected type and carry its referenced
  // schemas so clients can inspect its exact fields without guessing.
  const [field, fieldSchema] = match;
  const selectedProperties: JsonObject = { [field]: fieldSchema };
  for (const optionalField of ["name", "dataSource"]) {
    if (properties[optionalField] !== undefined)
      selectedProperties[optionalField] = properties[optionalField];
  }
  const rootSchema: JsonObject = {
    type: "object",
    description: `Google Health DataPoint payload for ${type.slug}.`,
    properties: selectedProperties,
  };
  const required = dataPoint?.["required"];
  if (Array.isArray(required)) {
    const selectedRequired = required.filter(
      (item): item is string =>
        typeof item === "string" && item in selectedProperties,
    );
    if (selectedRequired.length) rootSchema["required"] = selectedRequired;
  }
  const refs = includeReferencedSchemas(rootSchema, schemas);
  const definitions = Object.fromEntries(
    Object.entries(refs.definitions).map(([name, schema]) => [
      name,
      normalizeSchemaReferences(schema, refs.definitions),
    ]),
  );
  const normalized = normalizeSchemaReferences(rootSchema, refs.definitions);
  if (Object.keys(definitions).length)
    (normalized as JsonObject)["$defs"] = definitions;
  return normalized as JsonObject;
}

function describeMethod(
  method: ApiMethod,
  operation: string,
  type: HealthDataType,
  schemas: Record<string, unknown>,
): JsonObject {
  const description: JsonObject = {
    operation,
    id: method.id,
    httpMethod: method.httpMethod,
    path: method.path,
    description: method.description,
    parameters: method.parameters,
    ...(method.requestSchema ? { requestSchema: method.requestSchema } : {}),
    ...(method.responseSchema ? { responseSchema: method.responseSchema } : {}),
  };
  if (
    (operation === "create" || operation === "patch") &&
    method.requestSchema === "DataPoint"
  ) {
    const payloadSchema = dataPointPayloadSchema(type, schemas);
    if (payloadSchema) {
      description["payloadSchema"] = payloadSchema;
      const payloadProperties = objectValue(payloadSchema["properties"]);
      const field = Object.keys(payloadProperties ?? {}).find(
        (key) => key !== "name" && key !== "dataSource",
      );
      if (field) description["dataPointField"] = field;
    }
  }
  return description;
}

export function registerDiscoveryTools(server: McpServer): void {
  // These tools describe the reviewed public API catalog; neither accesses a
  // Google account or personal health data.
  const listTool = toolCatalog.find((tool) => tool.name === "list_data_types")!;
  server.registerTool(
    listTool.name,
    {
      title: listTool.title,
      description: listTool.description,
      annotations: listTool.annotations,
      inputSchema: z.object({}),
      outputSchema: toolOutputSchema,
    },
    async () =>
      toolResult({
        source: "https://developers.google.com/health/data-types",
        dataTypes: dataTypes.map((type) => ({ ...type })),
      }),
  );

  const describeTool = toolCatalog.find(
    (tool) => tool.name === "describe_schema",
  )!;
  server.registerTool(
    describeTool.name,
    {
      title: describeTool.title,
      description: describeTool.description,
      annotations: describeTool.annotations,
      inputSchema: z.object({
        dataType: z.string().min(1).max(80),
        operation: operationSchema.optional(),
        apiVersion: z.enum(["v4", "v4beta"]).optional(),
      }),
      outputSchema: toolOutputSchema,
    },
    async ({ dataType, operation, apiVersion }) => {
      const capability = getCapability(dataType);
      if (!capability)
        throw new TypeError(
          `Unsupported Google Health data type: ${dataType}. Call list_data_types to see supported data types.`,
        );
      const version = apiVersion ?? defaultApiVersionForDataType(dataType);
      if (capability.beta === true && version !== "v4beta")
        throw new TypeError(`${dataType} is documented only in v4beta.`);
      const operations = operation ? [operation] : capability.operations;
      const methods = operations.map((requestedOperation) => {
        if (!capability.operations.includes(requestedOperation))
          throw new TypeError(
            `Google Health data type ${dataType} does not support ${requestedOperation}. Supported operations: ${capability.operations.join(", ")}.`,
          );
        const method = getApiMethod(
          `${methodPrefix}${requestedOperation}`,
          version,
        );
        return describeMethod(
          method,
          requestedOperation,
          capability,
          schemasFor(version),
        );
      });

      return toolResult({
        source: "https://developers.google.com/health/reference/rest",
        apiVersion: version,
        dataType: capability,
        methods,
      });
    },
  );
}
