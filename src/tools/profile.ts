import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { HealthApi } from "../google-health/client.js";
import { toolCatalog } from "./catalog.js";
import { toolOutputSchema, toolResult } from "./results.js";

const jsonObject = z.record(z.string(), z.unknown());
const accountResources = z.enum([
  "identity",
  "irn-profile",
  "profile",
  "settings",
  "devices",
  "device",
]);

const READ_METHODS: Record<string, string> = {
  identity: "health.users.getIdentity",
  "irn-profile": "health.users.getIrnProfile",
  profile: "health.users.getProfile",
  settings: "health.users.getSettings",
  devices: "health.users.pairedDevices.list",
  device: "health.users.pairedDevices.get",
};

function requireDeviceName(name: string): string {
  if (!/^users\/me\/devices\/[^/]+$/.test(name)) {
    throw new TypeError(
      "deviceName must identify one device belonging to users/me.",
    );
  }
  return name;
}

export function registerProfileTools(server: McpServer, api: HealthApi): void {
  const readTool = toolCatalog.find(
    (tool) => tool.name === "get_health_account_data",
  )!;
  server.registerTool(
    readTool.name,
    {
      title: readTool.title,
      description: readTool.description,
      annotations: readTool.annotations,
      inputSchema: z.object({
        resource: accountResources,
        deviceName: z.string().min(1).max(256).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
        pageToken: z.string().min(1).max(4096).optional(),
      }),
      outputSchema: toolOutputSchema,
    },
    async ({ resource, deviceName, pageSize, pageToken }) => {
      const methodId = READ_METHODS[resource]!;
      if (resource === "device") {
        if (!deviceName)
          throw new TypeError("deviceName is required for resource=device.");
        if (pageSize !== undefined || pageToken !== undefined)
          throw new TypeError("Device retrieval does not accept pagination.");
        return toolResult(
          await api.request({
            methodId,
            pathParams: { name: requireDeviceName(deviceName) },
          }),
        );
      }
      if (deviceName)
        throw new TypeError("deviceName is valid only for resource=device.");
      if (resource === "devices") {
        return toolResult(
          await api.request({
            methodId,
            pathParams: { parent: "users/me" },
            query: {
              ...(pageSize === undefined ? {} : { pageSize }),
              ...(pageToken ? { pageToken } : {}),
            },
          }),
        );
      }
      if (pageSize !== undefined || pageToken !== undefined)
        throw new TypeError(
          "This account resource does not accept pagination.",
        );
      return toolResult(
        await api.request({
          methodId,
          pathParams: {
            name: `users/me/${resource === "irn-profile" ? "irnProfile" : resource}`,
          },
        }),
      );
    },
  );

  const updateTool = toolCatalog.find(
    (tool) => tool.name === "update_health_account_data",
  )!;
  server.registerTool(
    updateTool.name,
    {
      title: updateTool.title,
      description: updateTool.description,
      annotations: updateTool.annotations,
      inputSchema: z.object({
        resource: z.enum(["profile", "settings"]),
        fields: jsonObject,
        updateMask: z
          .array(z.string().min(1).max(100))
          .min(1)
          .max(30)
          .optional(),
      }),
      outputSchema: toolOutputSchema,
    },
    async ({ resource, fields, updateMask }) => {
      if (Object.keys(fields).length === 0)
        throw new TypeError("At least one supported field is required.");
      const methodId =
        resource === "profile"
          ? "health.users.updateProfile"
          : "health.users.updateSettings";
      const response = await api.request({
        methodId,
        pathParams: { name: `users/me/${resource}` },
        ...(updateMask ? { query: { updateMask: updateMask.join(",") } } : {}),
        body: { ...fields, name: `users/me/${resource}` },
      });
      return toolResult(response);
    },
  );
}
