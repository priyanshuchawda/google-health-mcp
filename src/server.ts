import { McpServer } from "@modelcontextprotocol/server";
import { HealthApi, type HealthApiOptions } from "./google-health/client.js";
import { registerHealthTools } from "./tools/registry.js";
import type { HealthToolOptions } from "./tools/registry.js";

export function createHealthMcpServer(
  apiOptions: HealthApiOptions,
  toolOptions: HealthToolOptions = {},
): McpServer {
  const server = new McpServer(
    { name: "google-health-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerHealthTools(server, new HealthApi(apiOptions), toolOptions);
  return server;
}
