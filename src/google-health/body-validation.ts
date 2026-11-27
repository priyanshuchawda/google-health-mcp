import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { apiSchemas, getApiMethod } from "./capabilities.js";

type JsonObject = Record<string, unknown>;
type SchemaObject = Record<string, unknown>;
type Validator = (
  input: unknown,
) => { valid: true; data: unknown } | { valid: false; errorMessage: string };

const validator = new CfWorkerJsonSchemaValidator({ draft: "7" });
const compiled = new Map<string, Validator>();

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaFor(apiVersion: "v4" | "v4beta", name: string): SchemaObject {
  const schemas = apiSchemas[apiVersion];
  const schema = schemas?.[name];
  if (!isObject(schema))
    throw new TypeError(
      `Missing Google discovery schema: ${apiVersion}.${name}`,
    );
  return schema;
}

function schemasFor(
  apiVersion: "v4" | "v4beta",
): Readonly<Record<string, unknown>> {
  const schemas = apiSchemas[apiVersion];
  if (!schemas)
    throw new TypeError(`Missing Google discovery schemas for ${apiVersion}.`);
  return schemas;
}

function collectReferences(
  schema: unknown,
  schemas: Readonly<Record<string, unknown>>,
  found: Map<string, SchemaObject>,
): void {
  if (Array.isArray(schema)) {
    for (const entry of schema) collectReferences(entry, schemas, found);
    return;
  }
  if (!isObject(schema)) return;

  const reference = schema["$ref"];
  if (typeof reference === "string" && !found.has(reference)) {
    const target = schemas[reference];
    if (!isObject(target))
      throw new TypeError(
        `Google discovery schema has an unresolved reference: ${reference}`,
      );
    found.set(reference, target);
    collectReferences(target, schemas, found);
  }
  for (const [key, child] of Object.entries(schema)) {
    if (key !== "$ref") collectReferences(child, schemas, found);
  }
}

function rewriteReferences(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(rewriteReferences);
  if (!isObject(schema)) return schema;
  const isSchemaNode =
    "type" in schema ||
    "$ref" in schema ||
    "properties" in schema ||
    "items" in schema ||
    "enum" in schema ||
    "additionalProperties" in schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !(key === "id" && isSchemaNode))
      .map(([key, value]) => [
        key,
        key === "$ref" && typeof value === "string"
          ? `#/definitions/${value.replace(/~/g, "~0").replace(/\//g, "~1")}`
          : rewriteReferences(value),
      ]),
  );
}

function getValidator(apiVersion: "v4" | "v4beta", name: string): Validator {
  const cacheKey = `${apiVersion}:${name}`;
  const cached = compiled.get(cacheKey);
  if (cached) return cached;

  const schemas = schemasFor(apiVersion);
  const root = schemaFor(apiVersion, name);
  const definitions = new Map<string, SchemaObject>();
  collectReferences(root, schemas, definitions);
  const jsonSchema = {
    ...(rewriteReferences(root) as SchemaObject),
    $schema: "http://json-schema.org/draft-07/schema#",
    ...(definitions.size
      ? { definitions: rewriteReferences(Object.fromEntries(definitions)) }
      : {}),
  } as JsonSchemaType;
  const validate = validator.getValidator<unknown>(jsonSchema);
  compiled.set(cacheKey, validate);
  return validate;
}

function validateRequiredAndReadOnly(
  schema: unknown,
  value: unknown,
  schemas: Readonly<Record<string, unknown>>,
  path = "payload",
  depth = 0,
): void {
  if (depth > 32)
    throw new TypeError(
      "Google Health request payload exceeds the supported nesting depth.",
    );
  if (Array.isArray(schema) || !isObject(schema)) return;

  const reference = schema["$ref"];
  if (typeof reference === "string") {
    const target = schemas[reference];
    if (!target)
      throw new TypeError(
        `Google discovery schema has an unresolved reference: ${reference}`,
      );
    validateRequiredAndReadOnly(target, value, schemas, path, depth + 1);
  }

  if (schema["type"] === "object" && isObject(value)) {
    const properties = isObject(schema["properties"])
      ? schema["properties"]
      : {};
    const required = new Set(
      Array.isArray(schema["required"])
        ? schema["required"].filter(
            (field): field is string => typeof field === "string",
          )
        : [],
    );
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (!isObject(propertySchema)) continue;
      if (
        typeof propertySchema["description"] === "string" &&
        /^Required\./i.test(propertySchema["description"])
      )
        required.add(name);
      if (propertySchema["readOnly"] === true && name in value) {
        throw new TypeError(
          `${path}.${name} is output-only and cannot be written.`,
        );
      }
    }
    for (const name of required) {
      if (!(name in value) || value[name] === null || value[name] === "") {
        throw new TypeError(`${path}.${name} is required by Google Health.`);
      }
    }
    for (const [name, entry] of Object.entries(value)) {
      const propertySchema = properties[name];
      if (propertySchema)
        validateRequiredAndReadOnly(
          propertySchema,
          entry,
          schemas,
          `${path}.${name}`,
          depth + 1,
        );
    }
  }

  if (schema["type"] === "array" && Array.isArray(value) && schema["items"]) {
    value.forEach((entry, index) =>
      validateRequiredAndReadOnly(
        schema["items"],
        entry,
        schemas,
        `${path}[${index}]`,
        depth + 1,
      ),
    );
  }

  if (schema["format"] === "google-datetime" && typeof value === "string") {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) ||
      Number.isNaN(Date.parse(value))
    ) {
      throw new TypeError(
        `${path} must be a valid RFC 3339 timestamp with a UTC offset.`,
      );
    }
  }
  if (
    schema["format"] === "google-duration" &&
    typeof value === "string" &&
    !/^-?\d+(?:\.\d+)?s$/.test(value)
  ) {
    throw new TypeError(
      `${path} must be a Google duration string such as "19800s".`,
    );
  }
}

function dataTypeField(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_match, character: string) =>
    character.toUpperCase(),
  );
}

function validateDataPointType(
  methodId: string,
  pathParams: Readonly<Record<string, string>>,
  body: unknown,
): void {
  if (
    !methodId.endsWith(".dataPoints.create") &&
    !methodId.endsWith(".dataPoints.patch")
  )
    return;
  const resource = methodId.endsWith(".dataPoints.create")
    ? pathParams["parent"]
    : pathParams["name"];
  const match = resource?.match(
    methodId.endsWith(".dataPoints.create")
      ? /^users\/(?:me|[A-Za-z0-9-]{1,63})\/dataTypes\/([a-z0-9]+(?:-[a-z0-9]+)*)$/
      : /^users\/(?:me|[A-Za-z0-9-]{1,63})\/dataTypes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/dataPoints\/[A-Za-z0-9-]{1,63}$/,
  );
  if (!match || !isObject(body))
    throw new TypeError(
      "Data point writes require a matching data type collection and object payload.",
    );
  const slug = match[1];
  if (!slug)
    throw new TypeError(
      "Data point writes require a valid data type collection.",
    );
  const expectedField = dataTypeField(slug);
  const allowedFields = new Set([expectedField, "name", "dataSource"]);
  const presentTypeFields = Object.keys(body).filter(
    (field) => field !== "name" && field !== "dataSource",
  );
  if (
    presentTypeFields.length !== 1 ||
    presentTypeFields[0] !== expectedField ||
    Object.keys(body).some((field) => !allowedFields.has(field))
  ) {
    throw new TypeError(
      `Data point payload must match the requested data type: ${slug}.`,
    );
  }
  const providedName = body["name"];
  if (providedName !== undefined) {
    if (
      typeof providedName !== "string" ||
      (methodId.endsWith(".dataPoints.create")
        ? !providedName.startsWith(`${pathParams["parent"]}/dataPoints/`)
        : providedName !== pathParams["name"])
    ) {
      throw new TypeError(
        "Data point name must match the requested user and data type collection.",
      );
    }
  }
}

export function validateGoogleRequestBody(
  methodId: string,
  apiVersion: "v4" | "v4beta",
  pathParams: Readonly<Record<string, string>>,
  body: unknown,
): void {
  const method = getApiMethod(methodId, apiVersion);
  if (!method.requestSchema)
    throw new TypeError(`${methodId} has no official request schema.`);
  if (!isObject(body))
    throw new TypeError(`${methodId} requires an object request payload.`);

  validateDataPointType(methodId, pathParams, body);
  const schemas = schemasFor(apiVersion);
  validateRequiredAndReadOnly(
    schemaFor(apiVersion, method.requestSchema),
    body,
    schemas,
  );
  const result = getValidator(apiVersion, method.requestSchema)(body);
  if (!result.valid) {
    throw new TypeError(
      `${methodId} payload does not match Google's ${method.requestSchema} schema: ${result.errorMessage}`,
    );
  }
}
