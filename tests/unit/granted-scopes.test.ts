import { describe, expect, it } from "vitest";
import { compareGrantedScopes } from "../../src/auth/granted-scopes.js";

describe("Google OAuth granted-scope validation", () => {
  it("reports unrelated grants instead of silently filtering them", () => {
    expect(
      compareGrantedScopes(
        [
          "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
          "https://www.googleapis.com/auth/fitness.activity.read",
        ],
        ["https://www.googleapis.com/auth/googlehealth.sleep.readonly"],
      ),
    ).toEqual({
      missing: [],
      unexpected: ["https://www.googleapis.com/auth/fitness.activity.read"],
    });
  });

  it("allows only explicitly configured identity scopes in the remote flow", () => {
    expect(
      compareGrantedScopes(
        [
          "openid",
          "email",
          "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
        ],
        ["https://www.googleapis.com/auth/googlehealth.sleep.readonly"],
        ["openid", "email"],
      ),
    ).toEqual({ missing: [], unexpected: [] });
  });
});
