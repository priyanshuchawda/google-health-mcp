import { describe, expect, it } from "vitest";
import { allHealthScopes } from "../../src/auth/scopes.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { InsufficientHealthPermissionError } from "../../src/auth/permission-errors.js";
import {
  buildConnectionPermissions,
  registerConnectionPermissionsTool,
} from "../../src/tools/permissions.js";
import { secureRemoteToolServer } from "../../src/tools/security.js";

const sleepRead = "https://www.googleapis.com/auth/googlehealth.sleep.readonly";
const sleepWrite =
  "https://www.googleapis.com/auth/googlehealth.sleep.writeonly";

describe("connection permissions", () => {
  it("shows granular supported Google permissions and enabled operations", () => {
    const permissions = buildConnectionPermissions({
      mcpScopes: ["mcp:read", "mcp:write"],
      googleHealthScopes: [sleepRead, sleepWrite],
      resourceMetadataUrl:
        "https://health.example/.well-known/oauth-protected-resource/mcp",
    });
    expect(permissions.mcp).toMatchObject({
      readGranted: true,
      writeGranted: true,
      supportedScopes: ["mcp:read", "mcp:write"],
    });
    expect(permissions.googleHealthScopes).toHaveLength(
      allHealthScopes(true).length,
    );
    expect(
      permissions.dataTypes.find((type) => type.dataType === "sleep"),
    ).toMatchObject({
      readEnabled: true,
      enabledOperations: expect.arrayContaining(["list", "create", "patch"]),
    });
    expect(
      permissions.dataTypes.find((type) => type.dataType === "weight"),
    ).toMatchObject({ readEnabled: false, enabledOperations: [] });
    expect(JSON.stringify(permissions)).not.toMatch(
      /token|secret|health record|refresh/i,
    );
  });

  it("does not report Google writes as enabled when MCP write scope is absent", () => {
    const permissions = buildConnectionPermissions({
      mcpScopes: ["mcp:read"],
      googleHealthScopes: [sleepRead, sleepWrite],
      resourceMetadataUrl:
        "https://health.example/.well-known/oauth-protected-resource/mcp",
    });
    expect(
      permissions.dataTypes.find((type) => type.dataType === "sleep"),
    ).toMatchObject({
      readEnabled: true,
      enabledOperations: expect.not.arrayContaining(["create", "patch"]),
    });
  });

  it("registers a read-only permissions tool without exposing credentials", async () => {
    const registrations = new Map<
      string,
      { config: unknown; handler: () => Promise<unknown> }
    >();
    const server = {
      registerTool(
        name: string,
        config: unknown,
        handler: () => Promise<unknown>,
      ) {
        registrations.set(name, { config, handler });
      },
    } as unknown as McpServer;
    registerConnectionPermissionsTool(server, {
      mcpScopes: ["mcp:read"],
      googleHealthScopes: [sleepRead],
      resourceMetadataUrl:
        "https://health.example/.well-known/oauth-protected-resource/mcp",
    });
    const tool = registrations.get("get_connection_permissions")!;
    expect(tool.config).toMatchObject({ annotations: { readOnlyHint: true } });
    const result = (await tool.handler()) as {
      structuredContent: { data: object };
    };
    expect(result.structuredContent.data).toMatchObject({
      mcp: { readGranted: true, writeGranted: false },
    });
  });

  it("publishes OAuth metadata and returns a structured challenge for withheld grants", async () => {
    const registered = new Map<
      string,
      {
        config: Record<string, unknown>;
        handler: (...args: never[]) => Promise<unknown>;
      }
    >();
    const server = {
      registerTool(
        name: string,
        config: Record<string, unknown>,
        handler: (...args: never[]) => Promise<unknown>,
      ) {
        registered.set(name, { config, handler });
      },
    } as unknown as McpServer;
    const securedServer = secureRemoteToolServer(
      server,
      "https://health.example/.well-known/oauth-protected-resource/mcp",
    );
    securedServer.registerTool(
      "write_test",
      { annotations: { readOnlyHint: false } },
      async () => {
        throw new InsufficientHealthPermissionError(
          "Google Health nutrition.writeonly was not granted.",
          ["mcp:read", "mcp:write"],
        );
      },
    );
    expect(registered.get("write_test")?.config).toMatchObject({
      _meta: {
        securitySchemes: [
          { type: "oauth2", scopes: ["mcp:read", "mcp:write"] },
        ],
      },
    });
    const result = (await registered.get("write_test")?.handler()) as {
      isError: boolean;
      _meta: Record<string, string[]>;
    };
    expect(result.isError).toBe(true);
    expect(result._meta["mcp/www_authenticate"]?.[0]).toContain(
      'error="insufficient_scope"',
    );
  });
});
