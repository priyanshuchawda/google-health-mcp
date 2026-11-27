import { describe, expect, it } from "vitest";
import { apiMethods } from "../../src/google-health/capabilities.js";
import { toolCatalog } from "../../src/tools/catalog.js";

describe("MCP health tool catalog", () => {
  it("covers every stable Google Health v4 discovery method exactly once", () => {
    const coveredMethods = toolCatalog.flatMap((tool) => tool.methodIds);
    const stableMethods = apiMethods
      .filter((method) => method.apiVersion === "v4")
      .map((method) => method.id);
    expect(coveredMethods).toHaveLength(stableMethods.length);
    expect(new Set(coveredMethods).size).toBe(coveredMethods.length);
    expect([...coveredMethods].sort()).toEqual([...stableMethods].sort());
  });

  it("marks reads, writes, and irreversible deletion accurately", () => {
    expect(
      toolCatalog.find((tool) => tool.name === "get_health_data")?.annotations
        .readOnlyHint,
    ).toBe(true);
    expect(
      toolCatalog.find((tool) => tool.name === "create_health_record")
        ?.annotations.readOnlyHint,
    ).toBe(false);
    expect(
      toolCatalog.find((tool) => tool.name === "delete_health_records")
        ?.annotations.destructiveHint,
    ).toBe(true);
    expect(
      toolCatalog.find((tool) => tool.name === "delete_health_records")
        ?.annotations.readOnlyHint,
    ).toBe(false);
  });
});
