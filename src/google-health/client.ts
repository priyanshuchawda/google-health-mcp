import {
  getApiMethod,
  requiredScopesFor,
  type ApiMethod,
  type HealthOperation,
} from "./capabilities.js";
import { validateGoogleRequestBody } from "./body-validation.js";
import { HealthApiError, PaginationLimitError } from "./errors.js";
import { API_ORIGIN, buildHealthUrl, isWriteMethod } from "./request.js";

export interface HealthTokenProvider {
  getAccessToken(scopes: readonly string[]): Promise<string>;
}

export interface HealthRequest {
  methodId: string;
  apiVersion?: "v4" | "v4beta";
  pathParams?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | number | boolean>>;
  body?: unknown;
  responseType?: "json" | "text";
}

export interface HealthApiOptions {
  tokenProvider: HealthTokenProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ListAllOptions extends HealthRequest {
  collectionKey?: string;
  maxPages?: number;
}

const SPECIAL_METHOD_SCOPES: Readonly<Record<string, readonly string[]>> = {
  "health.users.getIdentity": [
    "https://www.googleapis.com/auth/googlehealth.profile.readonly",
  ],
  "health.users.getIrnProfile": [
    "https://www.googleapis.com/auth/googlehealth.irn.readonly",
  ],
  "health.users.getProfile": [
    "https://www.googleapis.com/auth/googlehealth.profile.readonly",
  ],
  "health.users.updateProfile": [
    "https://www.googleapis.com/auth/googlehealth.profile.writeonly",
  ],
  "health.users.getSettings": [
    "https://www.googleapis.com/auth/googlehealth.settings.readonly",
  ],
  "health.users.updateSettings": [
    "https://www.googleapis.com/auth/googlehealth.settings.writeonly",
  ],
  "health.users.pairedDevices.get": [
    "https://www.googleapis.com/auth/googlehealth.settings.readonly",
  ],
  "health.users.pairedDevices.list": [
    "https://www.googleapis.com/auth/googlehealth.settings.readonly",
  ],
  "health.shl.m.getShlManifest": [
    "https://www.googleapis.com/auth/googlehealth.profile.readonly",
  ],
  "health.shl.r.get": [
    "https://www.googleapis.com/auth/googlehealth.profile.readonly",
  ],
};
const PROJECT_IAM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function operationFor(methodId: string): HealthOperation | undefined {
  const operation = methodId.split(".").at(-1);
  if (
    operation === "list" ||
    operation === "get" ||
    operation === "reconcile" ||
    operation === "rollUp" ||
    operation === "dailyRollUp"
  )
    return operation;
  if (
    operation === "create" ||
    operation === "patch" ||
    operation === "batchDelete"
  )
    return operation;
  if (operation === "exportExerciseTcx") return "get";
  return undefined;
}

function scopesForMethod(
  methodId: string,
  pathParams: Readonly<Record<string, string>>,
): readonly string[] {
  if (methodId.startsWith("health.projects.subscribers."))
    return [PROJECT_IAM_SCOPE];
  const special = SPECIAL_METHOD_SCOPES[methodId];
  if (special) return special;
  if (methodId.endsWith(".exportExerciseTcx")) {
    return [
      "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
      "https://www.googleapis.com/auth/googlehealth.location.readonly",
    ];
  }

  const resourceName = pathParams["parent"] ?? pathParams["name"];
  const dataType = resourceName?.match(/(?:^|\/)dataTypes\/([^/]+)/)?.[1];
  const operation = operationFor(methodId);
  if (dataType && operation) return requiredScopesFor(dataType, operation);
  throw new TypeError(
    `No Google Health scope mapping is configured for ${methodId}.`,
  );
}

function methodIsWrite(method: ApiMethod): boolean {
  return isWriteMethod(method);
}

function fetchFailureKind(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("illegal invocation")) return "illegal_invocation";
  if (message.includes("invalid url")) return "invalid_url";
  if (message.includes("redirect")) return "redirect_rejected";
  if (
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("network")
  )
    return "network_fetch_failure";
  return "unclassified_fetch_failure";
}

export class HealthApi {
  private readonly tokenProvider: HealthTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: HealthApiOptions) {
    this.tokenProvider = options.tokenProvider;
    // Native Worker fetch may depend on its global receiver. Invoking a bare
    // fetch function as `this.fetchImpl(...)` binds `this` to this client.
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  }

  async request<T = unknown>(request: HealthRequest): Promise<T> {
    const apiVersion = request.apiVersion ?? "v4";
    const method = getApiMethod(request.methodId, apiVersion);
    const pathParams = request.pathParams ?? {};
    const url = buildHealthUrl(request.methodId, {
      apiVersion,
      pathParams,
      ...(request.query ? { query: request.query } : {}),
    });
    const hasBody = request.body !== undefined;
    if (hasBody && !method.requestSchema)
      throw new TypeError(
        `${request.methodId} does not accept a request body.`,
      );
    if (method.httpMethod === "GET" && hasBody)
      throw new TypeError(`${request.methodId} cannot use a request body.`);
    if (hasBody)
      validateGoogleRequestBody(
        request.methodId,
        apiVersion,
        pathParams,
        request.body,
      );

    const scopes = scopesForMethod(request.methodId, pathParams);
    const accessToken = await this.tokenProvider.getAccessToken(scopes);
    const headers = new Headers({
      accept:
        request.responseType === "text"
          ? "application/xml, text/xml, */*"
          : "application/json",
      authorization: `Bearer ${accessToken}`,
    });
    if (hasBody) headers.set("content-type", "application/json");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let responseReceived = false;
    try {
      let requestUrl = url;
      let redirectCount = 0;
      let response: Response;
      while (true) {
        response = await this.fetchImpl(requestUrl, {
          method: method.httpMethod,
          headers,
          ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
          signal: controller.signal,
          redirect: "manual",
        });
        responseReceived = true;
        const location = response.headers.get("location");
        if (response.status < 300 || response.status >= 400 || !location) break;

        // Do not forward write payloads or bearer tokens to a redirect target.
        if (methodIsWrite(method))
          throw new HealthApiError({
            methodId: request.methodId,
            status: response.status,
            outcome: "uncertain",
            message:
              "Google Health redirected a write request; verify the record before retrying.",
          });

        const target = new URL(location, requestUrl);
        if (
          target.origin !== API_ORIGIN ||
          target.protocol !== "https:" ||
          target.username !== "" ||
          target.password !== ""
        )
          throw new HealthApiError({
            methodId: request.methodId,
            status: response.status,
            outcome: "rejected",
            message:
              "Google Health redirected outside its trusted API origin; request stopped.",
          });
        if (redirectCount >= 2)
          throw new HealthApiError({
            methodId: request.methodId,
            status: response.status,
            outcome: "rejected",
            message: "Google Health exceeded the safe redirect limit.",
          });
        requestUrl = target;
        redirectCount += 1;
      }

      if (!response.ok) {
        const uncertain = methodIsWrite(method) && response.status >= 500;
        const upstreamStatus = await safeGoogleErrorStatus(
          response,
          this.maxResponseBytes,
        );
        throw new HealthApiError({
          methodId: request.methodId,
          status: response.status,
          outcome: uncertain ? "uncertain" : "rejected",
          message: uncertain
            ? `Google Health returned HTTP ${response.status} after a write request; verify the record before retrying.`
            : `Google Health rejected ${request.methodId} with HTTP ${response.status}` +
              (upstreamStatus ? ` (${upstreamStatus})` : "") +
              ".",
        });
      }

      if (response.status === 204) return undefined as T;
      const responseText = await readResponseText(
        response,
        this.maxResponseBytes,
      );
      if (request.responseType === "text") return responseText as T;
      return JSON.parse(responseText) as T;
    } catch (error) {
      if (error instanceof HealthApiError) throw error;
      const timedOut = controller.signal.aborted;
      const outcome = methodIsWrite(method) ? "uncertain" : "rejected";
      if (!responseReceived && !timedOut) {
        // Keep diagnostics useful without logging URLs, credentials, or data.
        console.warn("Google Health upstream fetch failed", {
          methodId: request.methodId,
          errorName: error instanceof Error ? error.name : typeof error,
          failureKind: fetchFailureKind(error),
        });
      }
      throw new HealthApiError({
        methodId: request.methodId,
        outcome,
        message: timedOut
          ? methodIsWrite(method)
            ? "Google Health write outcome is uncertain because the request timed out; verify the record before retrying."
            : "Google Health request timed out before the response was fully read."
          : !responseReceived
            ? methodIsWrite(method)
              ? "Google Health write outcome is uncertain because the network request failed; inspect the record before retrying."
              : "Google Health request failed before a response was received."
            : methodIsWrite(method)
              ? "Google Health accepted the write but returned an unreadable response; verify the record before retrying."
              : "Google Health returned an unreadable response.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async listAll<T = unknown>(options: ListAllOptions): Promise<T[]> {
    const method = getApiMethod(options.methodId, options.apiVersion ?? "v4");
    if (method.httpMethod !== "GET" || !options.methodId.endsWith(".list")) {
      throw new TypeError(
        "Pagination requires an official Google Health list method.",
      );
    }
    const maxPages = options.maxPages ?? 20;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
      throw new TypeError("maxPages must be an integer from 1 through 100.");
    }
    const collectionKey = options.collectionKey ?? "dataPoints";
    const items: T[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    do {
      const result = await this.request<Record<string, unknown>>({
        methodId: options.methodId,
        ...(options.apiVersion ? { apiVersion: options.apiVersion } : {}),
        ...(options.pathParams ? { pathParams: options.pathParams } : {}),
        query: { ...options.query, ...(pageToken ? { pageToken } : {}) },
      });
      const pageItems = result[collectionKey];
      if (!Array.isArray(pageItems))
        throw new TypeError(
          `Google Health list response is missing the ${collectionKey} array.`,
        );
      items.push(...(pageItems as T[]));
      const nextPageToken = result["nextPageToken"];
      pageToken =
        typeof nextPageToken === "string" && nextPageToken
          ? nextPageToken
          : undefined;
      pages += 1;
      if (pageToken && pages >= maxPages)
        throw new PaginationLimitError(pageToken);
    } while (pageToken);

    return items;
  }
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new TypeError(
      `Google Health response exceeded the ${maxBytes}-byte safety limit.`,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new TypeError(
        `Google Health response exceeded the ${maxBytes}-byte safety limit.`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function safeGoogleErrorStatus(
  response: Response,
  maxResponseBytes: number,
): Promise<string | undefined> {
  if (!response.headers.get("content-type")?.includes("json")) return undefined;
  try {
    const text = await readResponseText(
      response.clone(),
      Math.min(maxResponseBytes, 64 * 1024),
    );
    const payload: unknown = JSON.parse(text);
    if (!payload || typeof payload !== "object") return undefined;
    const error = (payload as Record<string, unknown>)["error"];
    if (!error || typeof error !== "object") return undefined;
    const errorRecord = error as Record<string, unknown>;
    const status = errorRecord["status"];
    const safeStatus =
      typeof status === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(status)
        ? status
        : undefined;
    const details = errorRecord["details"];
    const reason = Array.isArray(details)
      ? details
          .map((detail) =>
            detail && typeof detail === "object"
              ? (detail as Record<string, unknown>)["reason"]
              : undefined,
          )
          .find(
            (value): value is string =>
              typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value),
          )
      : undefined;
    return [safeStatus, reason].filter(Boolean).join("/") || undefined;
  } catch {
    // Error bodies are untrusted and intentionally never returned or logged.
    return undefined;
  }
}
