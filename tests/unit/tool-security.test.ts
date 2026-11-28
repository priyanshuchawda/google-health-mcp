import { describe, expect, it } from "vitest";
import {
  insufficientScopeResult,
  securitySchemesFor,
} from "../../src/tools/security.js";

describe("remote MCP tool authorization metadata", () => {
  it("requires read scope for read-only tools", () => {
    expect(securitySchemesFor(true)).toEqual([
      { type: "oauth2", scopes: ["mcp:read"] },
    ]);
  });

  it("requires both read and write scopes for mutations", () => {
    expect(securitySchemesFor(false)).toEqual([
      { type: "oauth2", scopes: ["mcp:read", "mcp:write"] },
    ]);
  });

  it("returns an MCP authentication challenge without exposing credentials", () => {
    const result = insufficientScopeResult(
      "https://health.example/.well-known/oauth-protected-resource/mcp",
      ["mcp:read", "mcp:write"],
      "Google Health sleep.writeonly permission is missing; reconnect and grant it.",
    );
    expect(result).toMatchObject({ isError: true });
    expect(result._meta["mcp/www_authenticate"][0]).toContain(
      'error="insufficient_scope"',
    );
    expect(result._meta["mcp/www_authenticate"][0]).toContain(
      'scope="mcp:read mcp:write"',
    );
    expect(JSON.stringify(result)).not.toMatch(
      /refresh_token|access_token|client_secret/i,
    );
  });
});
