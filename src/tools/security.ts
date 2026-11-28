import type { McpServer } from "@modelcontextprotocol/server";
import { InsufficientHealthPermissionError } from "../auth/permission-errors.js";

const MCP_READ = "mcp:read";
const MCP_WRITE = "mcp:write";

export function securitySchemesFor(readOnly: boolean) {
  return [
    {
      type: "oauth2" as const,
      scopes: readOnly ? [MCP_READ] : [MCP_READ, MCP_WRITE],
    },
  ];
}

function quoteHeader(value: string): string {
  return value.replace(/[\\"\r\n]/g, " ").slice(0, 300);
}

export function insufficientScopeResult(
  resourceMetadataUrl: string,
  scopes: readonly string[],
  description: string,
) {
  const challenge =
    `Bearer resource_metadata="${quoteHeader(resourceMetadataUrl)}", ` +
    `error="insufficient_scope", scope="${quoteHeader(scopes.join(" "))}", ` +
    `error_description="${quoteHeader(description)}"`;
  return {
    content: [{ type: "text" as const, text: description }],
    isError: true,
    _meta: { "mcp/www_authenticate": [challenge] },
  };
}

type GenericToolHandler = (...args: never[]) => unknown;

/** Adds ChatGPT OAuth hints and structured step-up errors to every remote tool. */
export function secureRemoteToolServer(
  server: McpServer,
  resourceMetadataUrl: string,
): McpServer {
  const originalRegister = server.registerTool.bind(server) as unknown as (
    name: string,
    config: Record<string, unknown>,
    handler: GenericToolHandler,
  ) => unknown;

  Object.defineProperty(server, "registerTool", {
    configurable: true,
    value: (
      name: string,
      config: Record<string, unknown>,
      handler: GenericToolHandler,
    ) => {
      const annotations = config["annotations"] as
        { readOnlyHint?: boolean } | undefined;
      const metadata = config["_meta"] as Record<string, unknown> | undefined;
      const securedConfig = {
        ...config,
        _meta: {
          ...metadata,
          securitySchemes: securitySchemesFor(
            annotations?.readOnlyHint === true,
          ),
        },
      };
      const securedHandler: GenericToolHandler = async (...args) => {
        try {
          return await handler(...args);
        } catch (error) {
          if (error instanceof InsufficientHealthPermissionError) {
            return insufficientScopeResult(
              resourceMetadataUrl,
              error.requiredMcpScopes,
              error.message,
            );
          }
          throw error;
        }
      };
      return originalRegister(name, securedConfig, securedHandler);
    },
  });
  return server;
}
