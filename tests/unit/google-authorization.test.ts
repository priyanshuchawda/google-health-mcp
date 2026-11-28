import { describe, expect, it } from "vitest";
import { googleAuthorizationOptions } from "../../src/auth/google-authorization.js";

describe("Google Health OAuth authorization options", () => {
  it("requests only current Google Health scopes instead of prior Google Fit grants", () => {
    const options = googleAuthorizationOptions({
      googleScopes: [
        "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
      ],
      state: "synthetic-state",
      nonce: "synthetic-nonce",
      codeChallenge: "synthetic-challenge",
    });

    expect(options.include_granted_scopes).toBe(false);
    expect(options.scope).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
    ]);
    expect(options.scope.some((scope) => scope.includes("/fitness."))).toBe(
      false,
    );
  });
});
