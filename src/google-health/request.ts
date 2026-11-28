import { getApiMethod, type ApiMethod } from "./capabilities.js";

export const API_ORIGIN = "https://health.googleapis.com";

export interface BuildUrlOptions {
  apiVersion?: "v4" | "v4beta";
  pathParams?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | number | boolean>>;
}

function escapePathValue(value: string, reserved: boolean): string {
  if (
    !value ||
    /[?#%\\]/.test(value) ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new TypeError(
      "Path parameters must be non-empty resource names without query, fragment, escape, or backslash characters.",
    );
  }
  const segments = value.split("/");
  if (
    (!reserved && value.includes("/")) ||
    segments.some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError(
      "Path parameters cannot contain unexpected separators, empty segments, or dot segments.",
    );
  }
  return reserved
    ? segments.map((part) => encodeURIComponent(part)).join("/")
    : encodeURIComponent(value);
}

export function buildHealthUrl(
  methodId: string,
  options: BuildUrlOptions = {},
): URL {
  const apiVersion = options.apiVersion ?? "v4";
  if (apiVersion !== "v4" && apiVersion !== "v4beta") {
    throw new TypeError(
      `Unsupported Google Health API version: ${String(apiVersion)}`,
    );
  }

  const method = getApiMethod(methodId, apiVersion);
  const pathParams = options.pathParams ?? {};
  const query = options.query ?? {};
  const declaredPath = new Set(
    method.parameters
      .filter((parameter) => parameter.location === "path")
      .map((parameter) => parameter.name),
  );
  const declaredQuery = new Set(
    method.parameters
      .filter((parameter) => parameter.location === "query")
      .map((parameter) => parameter.name),
  );

  for (const name of declaredPath) {
    const parameter = method.parameters.find(
      (entry) => entry.name === name && entry.location === "path",
    );
    if (parameter?.required && !(name in pathParams)) {
      throw new TypeError(`Missing required path parameter: ${name}`);
    }
  }
  for (const name of Object.keys(pathParams)) {
    if (!declaredPath.has(name))
      throw new TypeError(`Unexpected path parameter: ${name}`);
  }
  for (const name of Object.keys(query)) {
    if (
      !declaredQuery.has(name) &&
      !(name === "alt" && methodId.endsWith(".exportExerciseTcx"))
    )
      throw new TypeError(`Unsupported query parameter: ${name}`);
  }

  const path = method.path.replace(
    /\{(\+?)([A-Za-z][A-Za-z0-9_]*)\}/g,
    (_match, reserved: string, name: string) => {
      const value = pathParams[name];
      if (value === undefined)
        throw new TypeError(`Missing path parameter: ${name}`);
      return escapePathValue(value, reserved === "+");
    },
  );
  if (/\{[^}]+\}/.test(path))
    throw new TypeError("Google Health path contains an unresolved parameter.");

  const url = new URL(`/${path}`, API_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    if (
      !["string", "number", "boolean"].includes(typeof value) ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw new TypeError(
        `Query parameter ${key} must be a finite string, number, or boolean.`,
      );
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

export function isWriteMethod(method: ApiMethod): boolean {
  return /(?:^|\.)(?:create|patch|delete|batchDelete|updateProfile|updateSettings)$/.test(
    method.id,
  );
}
