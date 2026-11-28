import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { registerSummaryTool } from "../../src/tools/summaries.js";

function captureSummary(api: { request: ReturnType<typeof vi.fn> }) {
  let handler: ((input: never) => Promise<unknown>) | undefined;
  const server = {
    registerTool(
      _name: string,
      _config: unknown,
      callback: (input: never) => Promise<unknown>,
    ) {
      handler = callback;
    },
  } as unknown as McpServer;
  registerSummaryTool(server, api as never);
  if (!handler) throw new Error("Daily summary tool was not registered.");
  return handler;
}

describe("daily summary MCP handler", () => {
  it("uses the direct settings response and returns partial metrics when an optional rollup fails", async () => {
    const request = vi.fn(
      async (input: {
        methodId: string;
        pathParams?: Record<string, string>;
      }) => {
        if (input.methodId === "health.users.getSettings")
          return { timeZone: "Asia/Kolkata" };
        if (input.methodId.endsWith(".reconcile")) return { dataPoints: [] };
        if (input.pathParams?.parent === "users/me/dataTypes/steps")
          throw new Error("synthetic unavailable rollup");
        return { rollupDataPoints: [] };
      },
    );
    const handler = captureSummary({ request });

    const response = (await handler({ date: "2026-11-26" } as never)) as {
      structuredContent: { data: Record<string, unknown> };
    };
    const summary = response.structuredContent.data;
    expect(summary.timeZone).toBe("Asia/Kolkata");
    expect((summary.metrics as Record<string, unknown>).steps).toBeNull();
    expect(summary.dataQuality).toMatchObject({
      unavailableMetrics: [{ metric: "steps", reason: "request_failed" }],
    });
    expect(summary.dataQuality.rollupTypesReturned).not.toContain("steps");
    expect(summary.dataQuality.rollupTypesReturned).toContain("distance");
  });

  it("does not invent UTC when Google Health settings omit the time zone", async () => {
    const request = vi.fn(async (input: { methodId: string }) =>
      input.methodId === "health.users.getSettings"
        ? {}
        : input.methodId.endsWith(".reconcile")
          ? { dataPoints: [] }
          : { rollupDataPoints: [] },
    );
    const handler = captureSummary({ request });
    const response = (await handler({ date: "2026-11-26" } as never)) as {
      structuredContent: { data: Record<string, unknown> };
    };
    expect(response.structuredContent.data.timeZone).toBeNull();
  });
});
