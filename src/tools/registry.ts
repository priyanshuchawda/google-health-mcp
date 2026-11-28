import type { McpServer } from "@modelcontextprotocol/server";
import { OpenAIExtensions } from "@openai/mcp-extensions/server";
import { z } from "zod";
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
import { registerHealthDashboardTool } from "./dashboard.js";

export interface HealthPreferences {
  dailyStepsGoal: number;
  sleepHoursGoal: number;
  hydrationMlGoal: number;
  weeklyExerciseMinutesGoal: number;
}

export interface HealthPreferencesStore {
  read(): Promise<HealthPreferences>;
  update(set: Partial<HealthPreferences>): Promise<HealthPreferences>;
}

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
  preferences?: HealthPreferencesStore;
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
  registerHealthDashboardTool(server, api);
  if (options.preferences) {
    const extensions = new OpenAIExtensions(server);
    const store = options.preferences;
    extensions.settings.register({
      fields: {
        dailyStepsGoal: {
          schema: z.number().int().min(0).max(200_000),
          title: "Daily steps target",
          description:
            "Optional personal target; not a Google Health native goal.",
        },
        sleepHoursGoal: {
          schema: z.number().min(0).max(24),
          title: "Sleep target (hours)",
        },
        hydrationMlGoal: {
          schema: z.number().int().min(0).max(100_000),
          title: "Hydration target (ml/day)",
        },
        weeklyExerciseMinutesGoal: {
          schema: z.number().int().min(0).max(10_080),
          title: "Exercise target (minutes/week)",
        },
      },
      layout: [
        {
          kind: "group",
          title: "Personal wellness targets",
          items: [
            { kind: "property", property: "dailyStepsGoal" },
            { kind: "property", property: "sleepHoursGoal" },
            { kind: "property", property: "hydrationMlGoal" },
            { kind: "property", property: "weeklyExerciseMinutesGoal" },
          ],
        },
      ],
      read: () => store.read(),
      update: (set) => store.update(set),
    });
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
