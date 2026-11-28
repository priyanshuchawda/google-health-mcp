import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { allHealthScopes } from "../auth/scopes.js";
import {
  dataTypes,
  requiredScopesFor,
  type HealthOperation,
} from "../google-health/capabilities.js";
import type { RemoteAuthorizationState } from "./registry.js";
import { toolCatalog } from "./catalog.js";
import { toolOutputSchema, toolResult } from "./results.js";

const MCP_READ = "mcp:read";
const MCP_WRITE = "mcp:write";
const GOOGLE_SCOPE_PREFIX = "https://www.googleapis.com/auth/googlehealth.";

export function buildConnectionPermissions(
  authorization: RemoteAuthorizationState,
) {
  const mcpReadGranted = authorization.mcpScopes.includes(MCP_READ);
  const mcpWriteGranted = authorization.mcpScopes.includes(MCP_WRITE);
  const googleScopes = new Set(authorization.googleHealthScopes);
  const requestedGoogleScopes = new Set(
    authorization.requestedGoogleScopes ?? [],
  );
  const availableOperations = (
    slug: string,
    operations: readonly HealthOperation[],
  ) =>
    operations.filter((operation) => {
      const isWrite = ["create", "patch", "batchDelete"].includes(operation);
      if (isWrite && !mcpWriteGranted) return false;
      return requiredScopesFor(slug, operation).every((scope) =>
        googleScopes.has(scope),
      );
    });

  return {
    mcp: {
      readGranted: mcpReadGranted,
      writeGranted: mcpWriteGranted,
      supportedScopes: [MCP_READ, MCP_WRITE],
    },
    googleHealthScopes: allHealthScopes(true).map((scope) => ({
      scope: scope.slice(GOOGLE_SCOPE_PREFIX.length),
      requested: requestedGoogleScopes.has(scope),
      granted: googleScopes.has(scope),
    })),
    dataTypes: dataTypes.map((type) => ({
      dataType: type.slug,
      supportedOperations: type.operations,
      enabledOperations: mcpReadGranted
        ? availableOperations(type.slug, type.operations)
        : [],
      readEnabled:
        mcpReadGranted &&
        type.operations.some(
          (operation) =>
            ["list", "get", "reconcile", "rollUp", "dailyRollUp"].includes(
              operation,
            ) &&
            requiredScopesFor(type.slug, operation).every((scope) =>
              googleScopes.has(scope),
            ),
        ),
    })),
    accountAccess: {
      profileRead: googleScopes.has(`${GOOGLE_SCOPE_PREFIX}profile.readonly`),
      profileWrite:
        mcpWriteGranted &&
        googleScopes.has(`${GOOGLE_SCOPE_PREFIX}profile.writeonly`),
      settingsRead: googleScopes.has(`${GOOGLE_SCOPE_PREFIX}settings.readonly`),
      settingsWrite:
        mcpWriteGranted &&
        googleScopes.has(`${GOOGLE_SCOPE_PREFIX}settings.writeonly`),
    },
  };
}

export function registerConnectionPermissionsTool(
  server: McpServer,
  authorization: RemoteAuthorizationState,
): void {
  const definition = toolCatalog.find(
    (tool) => tool.name === "get_connection_permissions",
  )!;
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      annotations: definition.annotations,
      inputSchema: z.object({}),
      outputSchema: toolOutputSchema,
    },
    async () => toolResult(buildConnectionPermissions(authorization)),
  );
}
