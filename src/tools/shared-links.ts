import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { HealthApi } from "../google-health/client.js";
import { toolCatalog } from "./catalog.js";
import { toolOutputSchema, toolResult } from "./results.js";

const safeExternalId = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !/[/?#]/.test(value) &&
      !Array.from(value).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
    "Must be a single external shared-link ID.",
  );

/** Reads only the SMART Health Link explicitly supplied by the caller. */
export function registerSharedLinkTools(
  server: McpServer,
  api: HealthApi,
): void {
  const definition = toolCatalog.find(
    (tool) => tool.name === "get_shared_health_link",
  )!;
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      annotations: definition.annotations,
      inputSchema: z.object({
        externalShlId: safeExternalId,
        resourceToken: z.string().min(1).max(8192).optional(),
        manifestParams: z
          .object({
            recipient: z.string().min(1).max(500),
            passcode: z.string().max(256).optional(),
            embeddedLengthMax: z
              .number()
              .int()
              .min(1)
              .max(1_000_000)
              .optional(),
          })
          .optional(),
      }),
      outputSchema: toolOutputSchema,
    },
    async ({ externalShlId, resourceToken, manifestParams }) => {
      if (resourceToken && manifestParams)
        throw new TypeError(
          "Choose either a shared-link manifest or a specific resource token.",
        );
      if (resourceToken) {
        return toolResult(
          await api.request({
            methodId: "health.shl.r.get",
            pathParams: { externalShlId, resourceToken },
          }),
        );
      }
      if (!manifestParams)
        throw new TypeError(
          "manifestParams with a recipient is required when reading a shared-link manifest.",
        );
      return toolResult(
        await api.request({
          methodId: "health.shl.m.getShlManifest",
          pathParams: { externalShlId },
          body: manifestParams,
        }),
      );
    },
  );
}
