import type { McpServer } from "@modelcontextprotocol/server";
import type { HealthApi } from "../google-health/client.js";
import { registerProfileTools } from "./profile.js";
import { registerRecordTools } from "./records.js";
import { registerSharedLinkTools } from "./shared-links.js";
import { registerSummaryTool } from "./summaries.js";
import { registerWebhookTools } from "./webhooks.js";
import { registerDiscoveryTools } from "./discovery.js";

export interface HealthToolOptions {
  projectAdminToolsEnabled?: boolean;
  googleCloudProjectNumber?: string;
}

/** Registers the shared, transport-independent health tool set. */
export function registerHealthTools(
  server: McpServer,
  api: HealthApi,
  options: HealthToolOptions = {},
): void {
  registerDiscoveryTools(server);
  registerRecordTools(server, api);
  registerSummaryTool(server, api);
  registerProfileTools(server, api);
  registerSharedLinkTools(server, api);
  if (options.projectAdminToolsEnabled) {
    if (!options.googleCloudProjectNumber) {
      throw new TypeError(
        "Google Cloud project number is required to enable webhook administration tools.",
      );
    }
    registerWebhookTools(server, api, options.googleCloudProjectNumber);
  }
}
