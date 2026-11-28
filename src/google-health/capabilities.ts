import dataTypesDocument from "../../spec/data-types.json" with { type: "json" };
import apiMethodsDocument from "../../spec/api-methods.json" with { type: "json" };
import { z } from "zod";

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

const dataTypeSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  kind: z.enum(["Interval", "Sample", "Daily", "Session", "Food"]),
  filterParameter: z.string().regex(/^[a-z0-9_]+$/),
  scopes: z.array(z.string().url()).min(1),
  operations: z.array(operationSchema).default([]),
  beta: z.boolean().optional(),
});

const apiParameterSchema = z.object({
  name: z.string().min(1),
  location: z.enum(["path", "query"]),
  type: z.string().min(1),
  required: z.boolean().optional(),
  format: z.string().optional(),
  enum: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const apiMethodSchema = z.object({
  id: z.string().min(1),
  httpMethod: z.enum(["GET", "POST", "PATCH", "DELETE", "PUT"]),
  path: z.string().startsWith("v4"),
  description: z.string(),
  parameters: z.array(apiParameterSchema),
  requestSchema: z.string().optional(),
  responseSchema: z.string().optional(),
});

const dataTypesFileSchema = z.object({
  source: z.string().url(),
  verifiedOn: z.string().date(),
  dataTypes: z.array(dataTypeSchema).min(1),
});

const apiMethodsFileSchema = z.object({
  source: z.string().url(),
  discoveryDocuments: z.record(z.string(), z.string().url()),
  verifiedOn: z.string().date(),
  versions: z.record(z.string(), z.array(apiMethodSchema)),
  schemas: z.record(z.string(), z.record(z.string(), z.unknown())),
});

const parsedDataTypes = dataTypesFileSchema.parse(dataTypesDocument).dataTypes;
const parsedApiMethods = apiMethodsFileSchema.parse(apiMethodsDocument);

export type HealthDataType = z.infer<typeof dataTypeSchema>;
export type HealthOperation = z.infer<typeof operationSchema>;
export type ApiParameter = z.infer<typeof apiParameterSchema>;
export type ApiMethod = z.infer<typeof apiMethodSchema> & {
  apiVersion: "v4" | "v4beta";
};

export const dataTypes: readonly HealthDataType[] =
  Object.freeze(parsedDataTypes);

export const apiMethods: readonly ApiMethod[] = Object.freeze(
  Object.entries(parsedApiMethods.versions).flatMap(([apiVersion, methods]) =>
    methods.map((method) => ({
      ...method,
      apiVersion: apiVersion as "v4" | "v4beta",
    })),
  ),
);
export const apiSchemas = Object.freeze(parsedApiMethods.schemas);

const dataTypeIndex = new Map(
  dataTypes.map((dataType) => [dataType.slug, dataType]),
);
const apiMethodIndex = new Map(
  apiMethods.map((method) => [`${method.apiVersion}:${method.id}`, method]),
);

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

export function getCapability(slug: string): HealthDataType | undefined {
  return dataTypeIndex.get(slug);
}

/** Selects beta only for catalog entries that Google explicitly marks beta-only. */
export function defaultApiVersionForDataType(slug: string): "v4" | "v4beta" {
  return getCapability(slug)?.beta === true ? "v4beta" : "v4";
}

export function assertOperationAllowed(
  slug: string,
  operation: HealthOperation,
): HealthDataType {
  const capability = getCapability(slug);
  if (!capability)
    throw new CapabilityError(`Unknown data type for Google Health: ${slug}`);
  if (!capability.operations.includes(operation)) {
    throw new CapabilityError(
      `Google Health data type ${slug} does not support ${operation}.`,
    );
  }
  return capability;
}

export function requiredScopesFor(
  slug: string,
  operation: HealthOperation,
): readonly string[] {
  const capability = assertOperationAllowed(slug, operation);
  const suffix = ["create", "patch", "batchDelete"].includes(operation)
    ? ".writeonly"
    : ".readonly";
  return capability.scopes.filter((scope) => scope.endsWith(suffix));
}

export function getApiMethod(
  methodId: string,
  apiVersion: "v4" | "v4beta" = "v4",
): ApiMethod {
  const method = apiMethodIndex.get(`${apiVersion}:${methodId}`);
  if (!method)
    throw new CapabilityError(
      `Unsupported Google Health API method: ${apiVersion}.${methodId}`,
    );
  return method;
}
