import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { HealthApi } from "../google-health/client.js";
import { HEALTH_DASHBOARD_HTML } from "../ui/dashboard-resource.js";
import { getHealthSummaryForRange } from "./range-summary.js";
import { nextCivilDate } from "./summaries.js";
import { toolResult } from "./results.js";

const RESOURCE_URI = "ui://ghealth/health-dashboard-v1";

function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function subtractDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year!, month! - 1, day! - days));
  return `${result.getUTCFullYear().toString().padStart(4, "0")}-${String(result.getUTCMonth() + 1).padStart(2, "0")}-${String(result.getUTCDate()).padStart(2, "0")}`;
}

export function registerHealthDashboardTool(
  server: McpServer,
  api: HealthApi,
): void {
  server.registerResource(
    "Google Health dashboard",
    RESOURCE_URI,
    {
      title: "Google Health dashboard",
      description:
        "Interactive view of the user's authorized Google Health summary.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          preferredDisplayMode: "fullscreen",
          availableDisplayModes: ["inline", "fullscreen"],
        },
      },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: RESOURCE_MIME_TYPE,
          text: HEALTH_DASHBOARD_HTML,
          _meta: {
            ui: {
              preferredDisplayMode: "fullscreen",
              availableDisplayModes: ["inline", "fullscreen"],
            },
          },
        },
      ],
    }),
  );

  server.registerTool(
    "open_health_dashboard",
    {
      title: "Open Google Health dashboard",
      description:
        "Open an interactive private dashboard for the latest seven source-civil days. The same authorized text tools remain available in clients that do not support MCP Apps.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: RESOURCE_URI, visibility: ["model", "app"] },
        "openai/ui": {
          entrypoints: [
            {
              type: "global",
              quickAction: {
                title: "Google Health",
                target: {
                  type: "tool",
                  name: "open_health_dashboard",
                  arguments: {},
                },
              },
            },
          ],
        },
      },
      outputSchema: z.object({ data: z.unknown() }),
    },
    async () => {
      let timeZone: string | null = null;
      try {
        const settings = await api.request<Record<string, unknown>>({
          methodId: "health.users.getSettings",
          pathParams: { name: "users/me/settings" },
        });
        if (typeof settings["timeZone"] === "string") {
          new Intl.DateTimeFormat("en", { timeZone: settings["timeZone"] });
          timeZone = settings["timeZone"];
        }
      } catch {
        // Summary still works with source-civil dates if settings are unavailable.
      }
      const today = dateInTimeZone(new Date(), timeZone ?? "UTC");
      const endDate = subtractDays(nextCivilDate(today), 1);
      const startDate = subtractDays(endDate, 6);
      return toolResult(
        await getHealthSummaryForRange(api, startDate, endDate),
      );
    },
  );
}
