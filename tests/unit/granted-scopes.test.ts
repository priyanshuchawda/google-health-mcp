import { describe, expect, it } from "vitest";
import {
  acceptedHealthScopes,
  compareGrantedScopes,
} from "../../src/auth/granted-scopes.js";

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

  it("accepts a partial Health grant and reports the missing categories", () => {
    expect(
      acceptedHealthScopes(
        [
          "openid",
          "email",
          "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
        ],
        [
          "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
          "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
        ],
        ["openid", "email"],
      ),
    ).toEqual({
      healthScopes: [
        "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
      ],
      missing: [
        "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
      ],
      unexpected: [],
    });
  });

  it("rejects a grant containing no Google Health scope", () => {
    expect(() =>
      acceptedHealthScopes(
        ["openid", "email"],
        ["https://www.googleapis.com/auth/googlehealth.sleep.readonly"],
        ["openid", "email"],
      ),
    ).toThrow(/at least one scope/i);
  });

  it("rejects unrelated Google Fit scopes even when Health consent is partial", () => {
    expect(() =>
      acceptedHealthScopes(
        [
          "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
          "https://www.googleapis.com/auth/fitness.activity.read",
        ],
        ["https://www.googleapis.com/auth/googlehealth.sleep.readonly"],
      ),
    ).toThrow(/unexpected oauth permission/i);
  });
});
