import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { registerDiscoveryTools } from "../../src/tools/discovery.js";

function captureTools() {
  const registrations = new Map<
    string,
    { config: unknown; handler: (input: never) => Promise<unknown> }
  >();
  const server = {
    registerTool(
      name: string,
      config: unknown,
      handler: (input: never) => Promise<unknown>,
    ) {
      registrations.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerDiscoveryTools(server);
  return registrations;
}

describe("MCP schema discovery tools", () => {
  it("lists official supported data types and only their supported operations", async () => {
    const tools = captureTools();
    const result = (await tools
      .get("list_data_types")!
      .handler({} as never)) as {
      structuredContent: {
        data: { dataTypes: Array<Record<string, unknown>> };
      };
    };
    const types = result.structuredContent.data.dataTypes;
    expect(types.length).toBeGreaterThan(40);
    expect(types.find((item) => item["slug"] === "sleep")).toMatchObject({
      kind: "Session",
      operations: expect.arrayContaining(["list", "create", "patch"]),
    });
    for (const unsupported of [
      "basal-energy-burned",
      "heart-rate-variability-personal-range",
      "resting-heart-rate-personal-range",
    ]) {
      expect(types.some((item) => item["slug"] === unsupported)).toBe(false);
    }
    const entry = tools.get("list_data_types");
    expect(entry?.config).toMatchObject({
      annotations: { readOnlyHint: true },
    });
  });

  it("describes the supported sleep create payload from discovery schemas", async () => {
    const tools = captureTools();
    const result = (await tools.get("describe_schema")!.handler({
      dataType: "sleep",
      operation: "create",
      apiVersion: "v4",
    } as never)) as {
      structuredContent: {
        data: {
          methods: Array<{
            id: string;
            requestSchema: string;
            dataPointField: string;
            payloadSchema: {
              properties: Record<string, unknown>;
              $defs?: Record<string, unknown>;
            };
          }>;
        };
      };
    };
    const description = result.structuredContent.data;
    expect(description.methods).toHaveLength(1);
    expect(description.methods[0]).toMatchObject({
      id: "health.users.dataTypes.dataPoints.create",
      requestSchema: "DataPoint",
      dataPointField: "sleep",
    });
    expect(description.methods[0]?.payloadSchema.properties).toHaveProperty(
      "sleep",
    );
    const sleepSchema = description.methods[0]?.payloadSchema.properties[
      "sleep"
    ] as { $ref?: string };
    expect(sleepSchema.$ref).toBe("#/$defs/Sleep");
    expect(description.methods[0]?.payloadSchema.$defs).toHaveProperty("Sleep");
  });

  it("rejects a type that is not a documented Google Health data type", async () => {
    const tools = captureTools();
    await expect(
      tools
        .get("describe_schema")!
        .handler({ dataType: "basal-energy-burned" } as never),
    ).rejects.toThrow(/unsupported google health data type/i);
  });
});
