import { describe, expect, it, vi } from "vitest";
import {
  HealthApi,
  type HealthTokenProvider,
} from "../../src/google-health/client.js";
import type { HealthApiError } from "../../src/google-health/errors.js";
import { buildHealthUrl } from "../../src/google-health/request.js";

const tokenProvider: HealthTokenProvider = {
  getAccessToken: vi.fn(async () => "synthetic-access-token"),
};

describe("Google Health API request construction", () => {
  it("expands canonical resource paths and encodes query values", () => {
    const method = "health.users.dataTypes.dataPoints.list";
    const url = buildHealthUrl(method, {
      pathParams: { parent: "users/me/dataTypes/heart-rate" },
      query: { pageSize: 25, pageToken: "next page" },
    });
    expect(url.toString()).toBe(
      "https://health.googleapis.com/v4/users/me/dataTypes/heart-rate/dataPoints?pageSize=25&pageToken=next+page",
    );
  });

  it("rejects missing or extra path arguments and unknown query parameters", () => {
    expect(() =>
      buildHealthUrl("health.users.getProfile", { pathParams: {} }),
    ).toThrow(/missing required path parameter/i);
    expect(() =>
      buildHealthUrl("health.users.getProfile", {
        pathParams: { name: "users/me/profile", extra: "x" },
      }),
    ).toThrow(/unexpected path parameter/i);
    expect(() =>
      buildHealthUrl("health.users.getProfile", {
        pathParams: { name: "users/me/profile" },
        query: { arbitrary: "value" },
      }),
    ).toThrow(/unsupported query parameter/i);
  });

  it("rejects unsupported API methods and versions", () => {
    expect(() =>
      buildHealthUrl("users.rawRequest", { apiVersion: "v4" }),
    ).toThrow(/unsupported/i);
    expect(() =>
      buildHealthUrl("health.users.getProfile", { apiVersion: "v3" as "v4" }),
    ).toThrow(/unsupported/i);
  });

  it.each([
    "users/me/../profile",
    "users/me/%2e%2e/profile",
    "users/me\\profile",
  ])("rejects unsafe resource path segments in %s", (name) => {
    expect(() =>
      buildHealthUrl("health.users.getProfile", { pathParams: { name } }),
    ).toThrow(/path|resource|segment/i);
  });

  it("builds the documented TCX download request without allowing arbitrary queries", () => {
    const url = buildHealthUrl(
      "health.users.dataTypes.dataPoints.exportExerciseTcx",
      {
        pathParams: {
          name: "users/me/dataTypes/exercise/dataPoints/workout-1",
        },
        query: { alt: "media" },
      },
    );
    expect(url.toString()).toBe(
      "https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints/workout-1:exportExerciseTcx?alt=media",
    );
  });
});

describe("Google Health API client", () => {
  it("calls the default native fetch in the global context", async () => {
    const nativeFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async function (this: typeof globalThis) {
        expect(this).toBe(globalThis);
        return Response.json({ name: "users/me/profile", height: 1.7 });
      });
    const api = new HealthApi({ tokenProvider });

    await expect(
      api.request({
        methodId: "health.users.getProfile",
        pathParams: { name: "users/me/profile" },
      }),
    ).resolves.toEqual({ name: "users/me/profile", height: 1.7 });
    expect(nativeFetch).toHaveBeenCalledOnce();
  });

  it("sends the Google token only to the Google API and returns parsed JSON", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer synthetic-access-token",
        );
        return Response.json({ name: "users/me/profile", height: 1.7 });
      },
    );
    const api = new HealthApi({ tokenProvider, fetchImpl });

    await expect(
      api.request({
        methodId: "health.users.getProfile",
        pathParams: { name: "users/me/profile" },
      }),
    ).resolves.toEqual({ name: "users/me/profile", height: 1.7 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(tokenProvider.getAccessToken).toHaveBeenCalledWith([
      "https://www.googleapis.com/auth/googlehealth.profile.readonly",
    ]);
  });

  it("follows a Google API redirect only when it stays on the trusted origin", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/v4/users/health-user-123/identity" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ name: "users/health-user-123/identity" }),
      );
    const api = new HealthApi({ tokenProvider, fetchImpl });

    await expect(
      api.request({
        methodId: "health.users.getIdentity",
        pathParams: { name: "users/me/identity" },
      }),
    ).resolves.toEqual({ name: "users/health-user-123/identity" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
      "https://health.googleapis.com/v4/users/health-user-123/identity",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("refuses a Google API redirect to another origin", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/collect" },
        }),
    );
    const api = new HealthApi({ tokenProvider, fetchImpl });

    await expect(
      api.request({
        methodId: "health.users.getIdentity",
        pathParams: { name: "users/me/identity" },
      }),
    ).rejects.toMatchObject({ name: "HealthApiError", status: 302 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("never resends a health-data write after a redirect", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: {
            location: "https://health.googleapis.com/v4/users/me/next",
          },
        }),
    );
    const api = new HealthApi({ tokenProvider, fetchImpl });

    await expect(
      api.request({
        methodId: "health.users.dataTypes.dataPoints.create",
        pathParams: { parent: "users/me/dataTypes/sleep" },
        body: {
          sleep: {
            interval: {
              startTime: "2026-11-26T22:00:00Z",
              endTime: "2026-11-26T23:00:00Z",
              startUtcOffset: "0s",
              endUtcOffset: "0s",
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "HealthApiError",
      status: 307,
      outcome: "uncertain",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not expose upstream error bodies that could contain sensitive data", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { message: "personal health payload leaked" } },
        { status: 403 },
      ),
    );
    const api = new HealthApi({ tokenProvider, fetchImpl });

    await expect(
      api.request({
        methodId: "health.users.getProfile",
        pathParams: { name: "users/me/profile" },
      }),
    ).rejects.toMatchObject({ name: "HealthApiError", status: 403 });
    try {
      await api.request({
        methodId: "health.users.getProfile",
        pathParams: { name: "users/me/profile" },
      });
    } catch (error) {
      expect(String(error)).not.toContain("personal health payload leaked");
    }
  });

  it("surfaces only Google's safe status code from an API error body", async () => {
    const api = new HealthApi({
      tokenProvider,
      fetchImpl: vi.fn(async () =>
        Response.json(
          {
            error: {
              status: "PERMISSION_DENIED",
              message: "Private response details must not be exposed.",
            },
          },
          { status: 403 },
        ),
      ),
    });

    await expect(
      api.request({
        methodId: "health.users.getIdentity",
        pathParams: { name: "users/me/identity" },
      }),
    ).rejects.toThrow(/HTTP 403 \(PERMISSION_DENIED\)/);
    await expect(
      api.request({
        methodId: "health.users.getIdentity",
        pathParams: { name: "users/me/identity" },
      }),
    ).rejects.not.toThrow(/Private response details/);
  });

  it("marks network failures on writes as uncertain and never retries them", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("connection reset");
    });
    const api = new HealthApi({ tokenProvider, fetchImpl });

    await expect(
      api.request({
        methodId: "health.users.dataTypes.dataPoints.create",
        pathParams: { parent: "users/me/dataTypes/sleep" },
        body: {
          sleep: {
            interval: {
              startTime: "2026-11-26T22:00:00Z",
              endTime: "2026-11-26T23:00:00Z",
              startUtcOffset: "0s",
              endUtcOffset: "0s",
            },
          },
        },
      }),
    ).rejects.toMatchObject<Partial<HealthApiError>>({ outcome: "uncertain" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a POST-based rollup as a read operation, not a health-data write", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("connection reset");
    });
    const api = new HealthApi({ tokenProvider, fetchImpl });

    await expect(
      api.request({
        methodId: "health.users.dataTypes.dataPoints.rollUp",
        pathParams: { parent: "users/me/dataTypes/steps" },
        body: {
          range: {
            startTime: "2026-11-26T00:00:00Z",
            endTime: "2026-11-27T00:00:00Z",
          },
          windowSize: "3600s",
        },
      }),
    ).rejects.toMatchObject({ outcome: "rejected" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("validates a write body against Google's discovery schema before sending it", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ name: "should-not-be-requested" }),
    );
    const api = new HealthApi({ tokenProvider, fetchImpl });

    await expect(
      api.request({
        methodId: "health.users.dataTypes.dataPoints.create",
        pathParams: { parent: "users/me/dataTypes/sleep" },
        body: { sleep: [] },
      }),
    ).rejects.toThrow(/schema|payload/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prevents a data point for one type from being written into another type's collection", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ name: "should-not-be-requested" }),
    );
    const api = new HealthApi({ tokenProvider, fetchImpl });

    await expect(
      api.request({
        methodId: "health.users.dataTypes.dataPoints.create",
        pathParams: { parent: "users/me/dataTypes/sleep" },
        body: { weight: { value: 70 } },
      }),
    ).rejects.toThrow(/match the requested data type/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("paginates list operations until Google omits nextPageToken", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          dataPoints: [{ name: "first" }],
          nextPageToken: "cursor",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ dataPoints: [{ name: "second" }] }),
      );
    const api = new HealthApi({ tokenProvider, fetchImpl });

    await expect(
      api.listAll({
        methodId: "health.users.dataTypes.dataPoints.list",
        pathParams: { parent: "users/me/dataTypes/steps" },
        collectionKey: "dataPoints",
        maxPages: 3,
      }),
    ).resolves.toEqual([{ name: "first" }, { name: "second" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects pagination for a non-list method", async () => {
    const api = new HealthApi({ tokenProvider, fetchImpl: vi.fn() });
    await expect(
      api.listAll({
        methodId: "health.users.getProfile",
        pathParams: { name: "users/me/profile" },
      }),
    ).rejects.toThrow(/list method/i);
  });

  it("requests the additional location scope required for TCX export", async () => {
    const getAccessToken = vi.fn(async () => "synthetic-access-token");
    const api = new HealthApi({
      tokenProvider: { getAccessToken },
      fetchImpl: vi.fn(async () => new Response("<TrainingCenterDatabase/>")),
    });
    await api.request({
      methodId: "health.users.dataTypes.dataPoints.exportExerciseTcx",
      pathParams: {
        name: "users/me/dataTypes/exercise/dataPoints/workout-1",
      },
      query: { alt: "media" },
      responseType: "text",
    });
    expect(getAccessToken).toHaveBeenCalledWith([
      "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
      "https://www.googleapis.com/auth/googlehealth.location.readonly",
    ]);
  });

  it("bounds upstream response bodies before parsing or returning them", async () => {
    const api = new HealthApi({
      tokenProvider,
      maxResponseBytes: 8,
      fetchImpl: vi.fn(async () => Response.json({ value: "too large" })),
    });
    await expect(
      api.request({
        methodId: "health.users.getProfile",
        pathParams: { name: "users/me/profile" },
      }),
    ).rejects.toMatchObject({ name: "HealthApiError" });
  });

  it("keeps the request timeout active while a response body is being read", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal as AbortSignal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () =>
              controller.error(new Error("aborted")),
            );
          },
        });
        return new Response(stream);
      },
    );
    const api = new HealthApi({ tokenProvider, fetchImpl, timeoutMs: 15 });

    await expect(
      api.request({
        methodId: "health.users.getProfile",
        pathParams: { name: "users/me/profile" },
      }),
    ).rejects.toMatchObject({ name: "HealthApiError" });
    expect(signal?.aborted).toBe(true);
  });
});
