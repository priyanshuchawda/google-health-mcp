import { describe, expect, it } from "vitest";
import { advertiseSupportedMcpScopes } from "../../src/auth/resource-metadata.js";

describe("protected resource scope metadata", () => {
  it("advertises both read and step-up write scopes", async () => {
    const response = await advertiseSupportedMcpScopes(
      Response.json({
        resource: "https://health.example/mcp",
        authorization_servers: ["https://health.example"],
        scopes_supported: ["mcp:read"],
      }),
    );
    expect(await response.json()).toMatchObject({
      resource: "https://health.example/mcp",
      scopes_supported: ["mcp:read", "mcp:write"],
    });
  });

  it("leaves provider error responses untouched", async () => {
    const original = new Response("unavailable", { status: 503 });
    const response = await advertiseSupportedMcpScopes(original);
    expect(response).toBe(original);
  });
});
