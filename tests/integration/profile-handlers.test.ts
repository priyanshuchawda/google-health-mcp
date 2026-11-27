import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { HealthApi } from "../../src/google-health/client.js";
import { registerProfileTools } from "../../src/tools/profile.js";

describe("account and paired-device MCP handlers", () => {
  it("verifies Google-returned paired-device names before reading them", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/identity"))
        return Response.json({ healthUserId: "1234567890" });
      return Response.json({ name: "users/1234567890/pairedDevices/device-1" });
    });
    const api = new HealthApi({
      tokenProvider: { getAccessToken: async () => "synthetic-token" },
      fetchImpl,
    });
    const handlers = new Map<string, (input: never) => Promise<unknown>>();
    const server = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (input: never) => Promise<unknown>,
      ) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerProfileTools(server, api);

    await handlers.get("get_health_account_data")!({
      resource: "device",
      deviceName: "users/1234567890/pairedDevices/device-1",
    } as never);
    expect(urls).toEqual([
      "https://health.googleapis.com/v4/users/me/identity",
      "https://health.googleapis.com/v4/users/me/pairedDevices/device-1",
    ]);
  });
});
