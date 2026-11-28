import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { InsufficientHealthPermissionError } from "../../src/auth/permission-errors.js";
import { createHealthMcpServer } from "../../src/server.js";

describe("remote OAuth metadata over MCP", () => {
  it("lists per-tool scopes and returns step-up auth metadata for a denied write", async () => {
    const server = createHealthMcpServer(
      {
        tokenProvider: {
          getAccessToken: vi.fn(async () => {
            throw new InsufficientHealthPermissionError(
              "Google Health settings.writeonly was not granted.",
              ["mcp:read", "mcp:write"],
            );
          }),
        },
        fetchImpl: vi.fn(),
      },
      {
        remoteAuthorization: {
          mcpScopes: ["mcp:read"],
          googleHealthScopes: [
            "https://www.googleapis.com/auth/googlehealth.settings.readonly",
          ],
          resourceMetadataUrl:
            "https://health.example/.well-known/oauth-protected-resource/mcp",
        },
      },
    );
    const client = new Client({ name: "remote-auth-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const readTool = tools.find((tool) => tool.name === "get_health_data");
      const writeTool = tools.find(
        (tool) => tool.name === "update_health_account_data",
      );
      expect(readTool?._meta).toMatchObject({
        securitySchemes: [{ type: "oauth2", scopes: ["mcp:read"] }],
      });
      expect(writeTool?._meta).toMatchObject({
        securitySchemes: [
          { type: "oauth2", scopes: ["mcp:read", "mcp:write"] },
        ],
      });
      expect(tools.map((tool) => tool.name)).toContain(
        "get_connection_permissions",
      );

      const result = await client.callTool({
        name: "update_health_account_data",
        arguments: {
          resource: "settings",
          fields: { timeZone: "Asia/Kolkata" },
        },
      });
      expect(result.isError).toBe(true);
      expect(result._meta?.["mcp/www_authenticate"]).toEqual(
        expect.arrayContaining([
          expect.stringContaining('error="insufficient_scope"'),
        ]),
      );
      expect(JSON.stringify(result)).toContain("settings.writeonly");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
