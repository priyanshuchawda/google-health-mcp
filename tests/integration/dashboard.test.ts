import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { registerHealthDashboardTool } from "../../src/tools/dashboard.js";

function captureDashboard(api: { request: ReturnType<typeof vi.fn> }) {
  let handler: (() => Promise<unknown>) | undefined;
  const server = {
    registerResource() {},
    registerTool(
      name: string,
      _config: unknown,
      callback: () => Promise<unknown>,
    ) {
      if (name === "open_health_dashboard") handler = callback;
    },
  } as unknown as McpServer;
  registerHealthDashboardTool(server, api as never);
  if (!handler) throw new Error("Dashboard tool was not registered.");
  return handler;
}

describe("dashboard account timezone handling", () => {
  it("refuses to choose a dashboard date range when the account timezone is unavailable", async () => {
    const request = vi.fn(async () => ({}));
    const handler = captureDashboard({ request });
    await expect(handler()).rejects.toThrow(/account time zone/i);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      methodId: "health.users.getSettings",
    });
  });

  it("reuses the loaded timezone when building the initial summary", async () => {
    const request = vi.fn(async (input: { methodId: string }) => {
      if (input.methodId === "health.users.getSettings")
        return { timeZone: "Asia/Kolkata" };
      if (input.methodId.endsWith(".dailyRollUp")) return {};
      return {};
    });
    const handler = captureDashboard({ request });
    await handler();
    expect(
      request.mock.calls.filter(
        ([input]) => input.methodId === "health.users.getSettings",
      ),
    ).toHaveLength(1);
  });
});
