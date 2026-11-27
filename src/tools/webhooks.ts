import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { HealthApi } from "../google-health/client.js";
import { toolCatalog } from "./catalog.js";
import { toolOutputSchema, toolResult } from "./results.js";

const payload = z.record(z.string(), z.unknown());
const projectNumberSchema = z
  .string()
  .regex(/^\d{6,30}$/, "Use the numeric Google Cloud project number.");
const subscriberIdSchema = z.string().regex(/^[a-z]([a-z0-9-]{2,34}[a-z0-9])$/);
const subscriptionIdSchema = z
  .string()
  .regex(/^[a-z]([a-z0-9-]{2,34}[a-z0-9])$/);

function requireHttpsEndpoint(value: unknown): void {
  if (typeof value !== "string") return;
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname.endsWith(".localhost") ||
    endpoint.hostname.endsWith(".local") ||
    endpoint.hostname.endsWith(".internal") ||
    /^\d+(?:\.\d+){3}$/.test(endpoint.hostname) ||
    endpoint.hostname.startsWith("[")
  ) {
    throw new TypeError(
      "Webhook endpoint must be a public HTTPS URL without credentials or an IP-literal host.",
    );
  }
}

function requireConfiguredProject(path: string, projectNumber: string): void {
  if (!path.startsWith(`projects/${projectNumber}/`)) {
    throw new TypeError(
      "Webhook resource must belong to the configured Google Cloud project.",
    );
  }
}

/** Project IAM webhooks are opt-in because they require the broad cloud-platform OAuth scope. */
export function registerWebhookTools(
  server: McpServer,
  api: HealthApi,
  projectNumber: string,
): void {
  const project = projectNumberSchema.parse(projectNumber);
  const projectPath = `projects/${project}`;

  const listDefinition = toolCatalog.find(
    (tool) => tool.name === "list_webhook_configuration",
  )!;
  server.registerTool(
    listDefinition.name,
    {
      title: listDefinition.title,
      description: listDefinition.description,
      annotations: listDefinition.annotations,
      inputSchema: z.object({
        resource: z.enum(["subscribers", "subscriptions"]),
        subscriberName: z.string().min(1).max(256).optional(),
        pageSize: z.number().int().min(1).max(1000).optional(),
        pageToken: z.string().min(1).max(4096).optional(),
        filter: z.string().max(2048).optional(),
      }),
      outputSchema: toolOutputSchema,
    },
    async ({ resource, subscriberName, pageSize, pageToken, filter }) => {
      if (resource === "subscribers") {
        if (subscriberName || filter)
          throw new TypeError(
            "Subscriber listing does not accept subscriberName or filter.",
          );
        return toolResult(
          await api.request({
            methodId: "health.projects.subscribers.list",
            pathParams: { parent: projectPath },
            query: {
              ...(pageSize ? { pageSize } : {}),
              ...(pageToken ? { pageToken } : {}),
            },
          }),
        );
      }
      if (
        !subscriberName ||
        !new RegExp(`^${projectPath}/subscribers/[^/]+$`).test(subscriberName)
      ) {
        throw new TypeError(
          "subscriberName must identify one subscriber in the configured project.",
        );
      }
      return toolResult(
        await api.request({
          methodId: "health.projects.subscribers.subscriptions.list",
          pathParams: { parent: subscriberName },
          query: {
            ...(pageSize ? { pageSize } : {}),
            ...(pageToken ? { pageToken } : {}),
            ...(filter ? { filter } : {}),
          },
        }),
      );
    },
  );

  const writeDefinition = toolCatalog.find(
    (tool) => tool.name === "write_webhook_configuration",
  )!;
  server.registerTool(
    writeDefinition.name,
    {
      title: writeDefinition.title,
      description: writeDefinition.description,
      annotations: writeDefinition.annotations,
      inputSchema: z.object({
        resource: z.enum(["subscriber", "subscription"]),
        action: z.enum(["create", "update"]),
        parent: z.string().min(1).max(512).optional(),
        resourceName: z.string().min(1).max(512).optional(),
        resourceId: z.string().min(4).max(36).optional(),
        updateMask: z
          .array(z.string().min(1).max(100))
          .min(1)
          .max(30)
          .optional(),
        body: payload,
      }),
      outputSchema: toolOutputSchema,
    },
    async ({
      resource,
      action,
      parent,
      resourceName,
      resourceId,
      updateMask,
      body,
    }) => {
      const isSubscriber = resource === "subscriber";
      if (action === "create") {
        if (resourceName)
          throw new TypeError("resourceName is valid only for update.");
        const expectedParent = isSubscriber ? projectPath : parent;
        if (!expectedParent)
          throw new TypeError("parent is required to create a subscription.");
        requireConfiguredProject(
          isSubscriber ? `${expectedParent}/` : expectedParent,
          project,
        );
        if (isSubscriber && expectedParent !== projectPath)
          throw new TypeError(
            "Subscriber creation parent must equal the configured project.",
          );
        if (
          !isSubscriber &&
          !new RegExp(`^${projectPath}/subscribers/[^/]+$`).test(expectedParent)
        ) {
          throw new TypeError(
            "Subscription parent must identify a subscriber in the configured project.",
          );
        }
        requireHttpsEndpoint(body["endpointUri"]);
        const methodId = isSubscriber
          ? "health.projects.subscribers.create"
          : "health.projects.subscribers.subscriptions.create";
        const pathParams = isSubscriber
          ? { parent: expectedParent }
          : { parent: expectedParent };
        const query = resourceId
          ? {
              [isSubscriber ? "subscriberId" : "subscriptionId"]: isSubscriber
                ? subscriberIdSchema.parse(resourceId)
                : subscriptionIdSchema.parse(resourceId),
            }
          : undefined;
        return toolResult(
          await api.request({
            methodId,
            pathParams,
            ...(query ? { query } : {}),
            body,
          }),
        );
      }

      if (parent || resourceId)
        throw new TypeError("parent and resourceId are valid only for create.");
      if (!resourceName)
        throw new TypeError("resourceName is required for update.");
      requireConfiguredProject(resourceName, project);
      requireHttpsEndpoint(body["endpointUri"]);
      const expectedPattern = isSubscriber
        ? new RegExp(`^${projectPath}/subscribers/[^/]+$`)
        : new RegExp(`^${projectPath}/subscribers/[^/]+/subscriptions/[^/]+$`);
      if (!expectedPattern.test(resourceName))
        throw new TypeError(
          "resourceName does not match the selected webhook resource type.",
        );
      const response = await api.request({
        methodId: isSubscriber
          ? "health.projects.subscribers.patch"
          : "health.projects.subscribers.subscriptions.patch",
        pathParams: { name: resourceName },
        ...(updateMask ? { query: { updateMask: updateMask.join(",") } } : {}),
        body: { ...body, name: resourceName },
      });
      return toolResult(response);
    },
  );

  const deleteDefinition = toolCatalog.find(
    (tool) => tool.name === "delete_webhook_configuration",
  )!;
  server.registerTool(
    deleteDefinition.name,
    {
      title: deleteDefinition.title,
      description: deleteDefinition.description,
      annotations: deleteDefinition.annotations,
      inputSchema: z.object({
        resource: z.enum(["subscriber", "subscription"]),
        resourceName: z.string().min(1).max(512),
        confirm: z
          .boolean()
          .describe(
            "Set true only after the user confirms deletion of this exact webhook resource.",
          ),
      }),
      outputSchema: toolOutputSchema,
    },
    async ({ resource, resourceName, confirm }) => {
      if (!confirm)
        throw new TypeError(
          "Webhook deletion requires confirm=true after user confirmation.",
        );
      requireConfiguredProject(resourceName, project);
      const expectedPattern =
        resource === "subscriber"
          ? new RegExp(`^${projectPath}/subscribers/[^/]+$`)
          : new RegExp(
              `^${projectPath}/subscribers/[^/]+/subscriptions/[^/]+$`,
            );
      if (!expectedPattern.test(resourceName))
        throw new TypeError(
          "resourceName does not match the selected webhook resource type.",
        );
      const response = await api.request({
        methodId:
          resource === "subscriber"
            ? "health.projects.subscribers.delete"
            : "health.projects.subscribers.subscriptions.delete",
        pathParams: { name: resourceName },
      });
      return toolResult(response);
    },
  );
}
