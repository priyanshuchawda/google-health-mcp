import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { registerRangeSummaryTool } from "../../src/tools/range-summary.js";
import { HealthApiError } from "../../src/google-health/errors.js";

function captureRangeSummary(api: { request: ReturnType<typeof vi.fn> }) {
  let handler: ((input: never) => Promise<unknown>) | undefined;
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      callback: (input: never) => Promise<unknown>,
    ) {
      if (name === "get_health_summary") handler = callback;
    },
  } as unknown as McpServer;
  registerRangeSummaryTool(server, api as never);
  if (!handler) throw new Error("Range summary tool was not registered.");
  return handler;
}

function civilDate(value: unknown): string {
  const date = (value as { date: { year: number; month: number; day: number } })
    .date;
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

describe("date-range health summary MCP handler", () => {
  it("summarizes a month in bounded rollup requests and splits 14-day-only metrics", async () => {
    const requests: {
      methodId: string;
      pathParams?: Record<string, string>;
      body?: Record<string, unknown>;
    }[] = [];
    const request = vi.fn(async (input: (typeof requests)[number]) => {
      requests.push(input);
      if (input.methodId === "health.users.getSettings")
        return { timeZone: "Asia/Kolkata" };
      if (input.methodId.endsWith(".dailyRollUp")) {
        const range = input.body?.["range"] as { start: unknown; end: unknown };
        const first = civilDate(range.start);
        const end = civilDate(range.end);
        const points: Record<string, unknown>[] = [];
        for (let date = first; date < end;) {
          const [year, month, day] = date.split("-").map(Number);
          points.push({
            civilStartTime: { date: { year, month, day } },
            ...(input.pathParams?.parent === "users/me/dataTypes/steps"
              ? { steps: { countSum: "100" } }
              : {}),
          });
          const next = new Date(`${date}T00:00:00Z`);
          next.setUTCDate(next.getUTCDate() + 1);
          date = next.toISOString().slice(0, 10);
        }
        return { rollupDataPoints: points };
      }
      if (input.methodId.endsWith(".list")) return { dataPoints: [] };
      if (input.methodId.endsWith(".reconcile")) return { dataPoints: [] };
      throw new Error(`Unexpected method ${input.methodId}`);
    });
    const handler = captureRangeSummary({ request });

    const response = (await handler({
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    } as never)) as { structuredContent: { data: Record<string, unknown> } };
    const summary = response.structuredContent.data;
    const daily = summary.daily as Record<string, unknown>[];
    const totals = summary.totals as Record<
      string,
      { value: number | null; daysReported: number }
    >;

    expect(daily).toHaveLength(30);
    expect(totals.steps).toMatchObject({
      value: 3000,
      daysReported: 30,
      daysInRange: 30,
    });
    expect((summary.dateRange as Record<string, unknown>).timeZone).toBe(
      "Asia/Kolkata",
    );
    const heartRateWindows = requests
      .filter(
        (item) => item.pathParams?.parent === "users/me/dataTypes/heart-rate",
      )
      .map((item) => item.body?.["range"] as { start: unknown; end: unknown });
    expect(heartRateWindows).toHaveLength(3);
    expect(
      heartRateWindows.every((range) => {
        const difference =
          Date.parse(`${civilDate(range.end)}T00:00:00Z`) -
          Date.parse(`${civilDate(range.start)}T00:00:00Z`);
        return difference <= 14 * 86_400_000;
      }),
    ).toBe(true);
    // A 30-day report stays below the Workers Free per-invocation subrequest cap.
    expect(requests.length).toBeLessThan(50);
  });

  it("rejects invalid and overlong civil ranges without calling the API", async () => {
    const request = vi.fn();
    const handler = captureRangeSummary({ request });
    await expect(
      handler({ startDate: "2026-02-30", endDate: "2026-03-01" } as never),
    ).rejects.toThrow(/valid/);
    await expect(
      handler({ startDate: "2026-10-01", endDate: "2026-11-01" } as never),
    ).rejects.toThrow(/1 to 31/);
    expect(request).not.toHaveBeenCalled();
  });

  it("groups timestamp-only sleep and workouts by their recorded UTC offsets and accepts empty rollups", async () => {
    const requests: {
      methodId: string;
      pathParams?: Record<string, string>;
      query?: Record<string, unknown>;
    }[] = [];
    const request = vi.fn(async (input: (typeof requests)[number]) => {
      requests.push(input);
      if (input.methodId === "health.users.getSettings")
        return { timeZone: "Asia/Kolkata" };
      if (input.methodId.endsWith(".dailyRollUp")) {
        if (input.pathParams?.parent.endsWith("/hydration-log")) return {};
        return { rollupDataPoints: [] };
      }
      if (input.methodId.endsWith(".list")) return {};
      if (input.methodId.endsWith(".reconcile")) {
        if (input.pathParams?.parent.endsWith("/sleep"))
          return {
            dataPoints: [
              {
                sleep: {
                  interval: {
                    startTime: "2026-11-22T21:37:00Z",
                    startUtcOffset: "19800s",
                    endTime: "2026-11-23T04:00:00Z",
                    endUtcOffset: "19800s",
                  },
                  summary: { minutesAsleep: 383 },
                  metadata: { mainSleep: true },
                },
              },
            ],
          };
        if (input.pathParams?.parent.endsWith("/exercise"))
          return {
            dataPoints: [
              {
                exercise: {
                  interval: {
                    startTime: "2026-11-24T05:38:00Z",
                    startUtcOffset: "19800s",
                    endTime: "2026-11-24T06:08:00Z",
                    endUtcOffset: "19800s",
                  },
                  activeDuration: "1800s",
                },
              },
            ],
          };
      }
      throw new Error(`Unexpected method ${input.methodId}`);
    });
    const handler = captureRangeSummary({ request });
    const response = (await handler({
      startDate: "2026-11-23",
      endDate: "2026-11-24",
    } as never)) as { structuredContent: { data: Record<string, unknown> } };
    const summary = response.structuredContent.data;
    const daily = summary.daily as Record<string, unknown>[];
    const firstMetrics = daily[0]?.["metrics"] as Record<string, unknown>;
    const secondMetrics = daily[1]?.["metrics"] as Record<string, unknown>;
    expect(firstMetrics["sleepMinutesAsleep"]).toBe(383);
    expect(secondMetrics["exerciseCount"]).toBe(1);
    expect(secondMetrics["exerciseMinutes"]).toMatchObject({
      value: 30,
      unit: "min",
    });
    const exercises = daily[1]?.["exerciseSessions"] as Record<
      string,
      unknown
    >[];
    expect(exercises[0]?.["civilStartTime"]).toMatchObject({
      date: { year: 2026, month: 11, day: 24 },
      time: { hours: 11, minutes: 8, seconds: 0 },
    });
    expect(
      (summary.dataCompleteness as Record<string, { daysReported: number }>)[
        "hydration"
      ]?.daysReported,
    ).toBe(0);
    expect(
      requests.find((item) => item.pathParams?.parent?.endsWith("/exercise"))
        ?.query?.filter,
    ).toContain('"2026-11-23T00:00:00"');
  });

  it("reports a failed metric with a useful reason while preserving successful metrics", async () => {
    const request = vi.fn(
      async (input: {
        methodId: string;
        pathParams?: Record<string, string>;
      }) => {
        if (input.methodId === "health.users.getSettings")
          return { timeZone: "Asia/Kolkata" };
        if (input.methodId.endsWith(".dailyRollUp")) {
          if (input.pathParams?.parent === "users/me/dataTypes/steps")
            throw new HealthApiError({
              methodId: input.methodId,
              status: 403,
              outcome: "rejected",
              message: "permission denied",
            });
          return { rollupDataPoints: [] };
        }
        if (input.methodId.endsWith(".list")) return {};
        if (input.methodId.endsWith(".reconcile")) return {};
        throw new Error(`Unexpected method ${input.methodId}`);
      },
    );
    const handler = captureRangeSummary({ request });
    const response = (await handler({
      startDate: "2026-11-28",
      endDate: "2026-11-28",
    } as never)) as { structuredContent: { data: Record<string, unknown> } };
    const summary = response.structuredContent.data;
    const daily = summary.daily as Record<string, unknown>[];
    const quality = daily[0]?.["dataQuality"] as {
      rollupTypesReturned: string[];
      unavailableMetrics: {
        metric: string;
        reason: string;
        httpStatus?: number;
      }[];
    };
    expect(quality.rollupTypesReturned).toContain("distance");
    expect(quality.rollupTypesReturned).not.toContain("steps");
    expect(quality.unavailableMetrics).toContainEqual({
      metric: "steps",
      reason: "permission_denied",
      httpStatus: 403,
    });
  });
});
