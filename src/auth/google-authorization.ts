import { CodeChallengeMethod } from "google-auth-library";

const OIDC_SCOPES = ["openid", "email"] as const;

export function googleAuthorizationOptions(input: {
  googleScopes: readonly string[];
  state: string;
  nonce: string;
  codeChallenge: string;
}) {
  return {
    access_type: "offline" as const,
    // Do not merge this app's legacy Google Fit grants into Google Health
    // access tokens. Google Health rejects unrelated OAuth scopes.
    include_granted_scopes: false,
    prompt: "consent" as const,
    scope: [...OIDC_SCOPES, ...input.googleScopes],
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  };
}
