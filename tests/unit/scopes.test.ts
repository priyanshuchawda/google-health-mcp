import { describe, expect, it } from "vitest";
import {
  allHealthScopes,
  DEFAULT_REMOTE_MCP_SCOPES,
} from "../../src/auth/scopes.js";

describe("Google OAuth scope selection", () => {
  it("requests read scopes for the enabled catalog and special account tools", () => {
    const scopes = allHealthScopes();
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/googlehealth.irn.readonly",
    );
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/googlehealth.location.readonly",
    );
    expect(scopes).not.toContain(
      "https://www.googleapis.com/auth/googlehealth.sleep.writeonly",
    );
    expect(scopes).not.toContain(
      "https://www.googleapis.com/auth/cloud-platform",
    );
  });

  it("adds only supported writes and project admin when explicitly requested", () => {
    const scopes = allHealthScopes(true, true);
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/googlehealth.sleep.writeonly",
    );
    expect(scopes).toContain("https://www.googleapis.com/auth/cloud-platform");
    expect(scopes).not.toContain(
      "https://www.googleapis.com/auth/googlehealth.ecg.writeonly",
    );
  });

  it("covers the complete documented set of 18 Google Health scopes without project IAM", () => {
    const scopes = allHealthScopes(true);
    expect(scopes).toHaveLength(18);
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/googlehealth.ecg.readonly",
    );
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/googlehealth.logged_symptoms.writeonly",
    );
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/googlehealth.mindfulness.writeonly",
    );
    expect(scopes).not.toContain(
      "https://www.googleapis.com/auth/cloud-platform",
    );
  });

  it("requests read and write MCP scopes by default on the private remote server", () => {
    expect(DEFAULT_REMOTE_MCP_SCOPES).toEqual(["mcp:read", "mcp:write"]);
  });
});
