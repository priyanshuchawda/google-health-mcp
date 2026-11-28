import type { McpServer } from "@modelcontextprotocol/server";
import type { HealthApi } from "../google-health/client.js";
import { registerProfileTools } from "./profile.js";
import { registerRecordTools } from "./records.js";
import { registerSharedLinkTools } from "./shared-links.js";
import { registerDataFreshnessTool } from "./freshness.js";
import { registerRangeSummaryTool } from "./range-summary.js";
import { registerSummaryTool } from "./summaries.js";
import { registerWorkoutTool } from "./workouts.js";
import { registerWebhookTools } from "./webhooks.js";
import { registerDiscoveryTools } from "./discovery.js";
import { registerConnectionPermissionsTool } from "./permissions.js";
import { secureRemoteToolServer } from "./security.js";

export interface RemoteAuthorizationState {
  mcpScopes: readonly string[];
  googleHealthScopes: readonly string[];
  requestedGoogleScopes?: readonly string[];
  resourceMetadataUrl: string;
}

export interface HealthToolOptions {
  projectAdminToolsEnabled?: boolean;
  googleCloudProjectNumber?: string;
  remoteAuthorization?: RemoteAuthorizationState;
}

/** Registers the shared, transport-independent health tool set. */
export function registerHealthTools(
  server: McpServer,
  api: HealthApi,
  options: HealthToolOptions = {},
): void {
  if (options.remoteAuthorization) {
    secureRemoteToolServer(
      server,
      options.remoteAuthorization.resourceMetadataUrl,
    );
    registerConnectionPermissionsTool(server, options.remoteAuthorization);
  }
  registerDiscoveryTools(server);
  registerRecordTools(server, api);
  registerWorkoutTool(server, api);
  registerSummaryTool(server, api);
  registerRangeSummaryTool(server, api);
  registerDataFreshnessTool(server, api);
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
