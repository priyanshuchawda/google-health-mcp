import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Google Health MCP stdio protocol", () => {
  it("initializes, lists tools, invokes discovery, and closes cleanly", async () => {
    const cli = resolve("src/cli.ts");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", cli],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({
      name: "stdio-integration-test",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("list_data_types");
      expect(tools.map((tool) => tool.name)).toContain("describe_schema");
      expect(tools.map((tool) => tool.name)).toContain("get_health_summary");
      expect(tools.map((tool) => tool.name)).toContain("get_data_freshness");
      expect(tools.map((tool) => tool.name)).toContain("log_workout");
      const dashboard = tools.find(
        (tool) => tool.name === "open_health_dashboard",
      );
      expect(dashboard?._meta?.["ui"]).toMatchObject({
        resourceUri: "ui://ghealth/health-dashboard-v1",
      });
      expect(dashboard?._meta?.["openai/ui"]).toBeDefined();
      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain(
        "ui://ghealth/health-dashboard-v1",
      );
      const dashboardResource = await client.readResource({
        uri: "ui://ghealth/health-dashboard-v1",
      });
      expect(dashboardResource.contents[0]?.mimeType).toBe(
        "text/html;profile=mcp-app",
      );
      expect(dashboardResource.contents[0]?.text).toContain("Google Health");
      expect(dashboardResource.contents[0]?.text).toContain("hydration-form");

      const result = await client.callTool({
        name: "list_data_types",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("active-energy-burned");

      const schema = await client.callTool({
        name: "describe_schema",
        arguments: { dataType: "sleep", operation: "create" },
      });
      expect(schema.isError).not.toBe(true);
      expect(JSON.stringify(schema)).toContain('"dataPointField":"sleep"');
    } finally {
      await client.close();
    }
  }, 20_000);
});
