import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { HealthApi } from "../../src/google-health/client.js";
import { registerWorkoutTool } from "../../src/tools/workouts.js";

function workoutHandler(api: HealthApi) {
  let handler: ((input: never) => Promise<unknown>) | undefined;
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      callback: (input: never) => Promise<unknown>,
    ) {
      if (name === "log_workout") handler = callback;
    },
  } as unknown as McpServer;
  registerWorkoutTool(server, api);
  if (!handler) throw new Error("Workout tool was not registered.");
  return handler;
}

describe("log_workout MCP handler", () => {
  it("creates a schema-valid exercise and derives correct UTC offsets", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        Response.json({ done: true, response: JSON.parse(String(init?.body)) }),
    );
    const api = new HealthApi({
      tokenProvider: { getAccessToken: async () => "synthetic-token" },
      fetchImpl,
    });
    const handler = workoutHandler(api);

    const result = (await handler({
      exerciseType: "CIRCUIT_TRAINING",
      startTime: "2026-11-28T11:08:00+05:30",
      endTime: "2026-11-28T11:38:00+05:30",
      activeMinutes: 30,
      notes: "Synthetic test; no live health account used.",
      steps: 100,
    } as never)) as { structuredContent: { data: Record<string, unknown> } };

    expect(result.structuredContent.data.status).toBe("completed");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints",
    );
    const payload = JSON.parse(String(init?.body)) as {
      dataSource: { recordingMethod: string };
      exercise: {
        interval: { startUtcOffset: string; endUtcOffset: string };
        activeDuration: string;
        metricsSummary: Record<string, unknown>;
      };
    };
    expect(payload.dataSource).toEqual({ recordingMethod: "MANUAL" });
    expect(payload.exercise.displayName).toBe("circuit training");
    expect(payload.exercise.interval).toMatchObject({
      startUtcOffset: "19800s",
      endUtcOffset: "19800s",
    });
    expect(payload.exercise.activeDuration).toBe("1800s");
    expect(payload.exercise.metricsSummary).toEqual({ steps: "100" });
  });

  it("rejects reversed times, invalid offsets and unnamed OTHER workouts before calling Google", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ done: true }));
    const api = new HealthApi({
      tokenProvider: { getAccessToken: async () => "synthetic-token" },
      fetchImpl,
    });
    const handler = workoutHandler(api);
    const base = {
      exerciseType: "RUNNING",
      startTime: "2026-11-28T11:38:00+05:30",
      endTime: "2026-11-28T11:08:00+05:30",
    };

    await expect(handler(base as never)).rejects.toThrow(
      /later than startTime/,
    );
    await expect(
      handler({
        ...base,
        exerciseType: "OTHER",
        startTime: "2026-11-28T11:08:00+05:30",
        endTime: "2026-11-28T11:38:00+05:30",
      } as never),
    ).rejects.toThrow(/displayName is required/);
    await expect(
      handler({
        exerciseType: "RUNNING",
        startTime: "2026-11-28T11:08:00+15:00",
        endTime: "2026-11-28T11:38:00+15:00",
      } as never),
    ).rejects.toThrow(/invalid UTC offset/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
