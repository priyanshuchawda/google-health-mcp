/** Compares Google's token response with the scopes requested for this grant. */
export function compareGrantedScopes(
  grantedScopes: readonly string[],
  requestedScopes: readonly string[],
  allowedAdditionalScopes: readonly string[] = [],
): { missing: string[]; unexpected: string[] } {
  const requested = new Set(requestedScopes);
  const allowed = new Set([...requested, ...allowedAdditionalScopes]);
  const granted = new Set(grantedScopes);
  return {
    missing: [...requested].filter((scope) => !granted.has(scope)),
    unexpected: [...granted].filter((scope) => !allowed.has(scope)),
  };
}

const HEALTH_SCOPE_PREFIX = "https://www.googleapis.com/auth/googlehealth.";

/** Accept granular Google Health consent while rejecting every unrelated grant. */
export function acceptedHealthScopes(
  grantedScopes: readonly string[],
  requestedScopes: readonly string[],
  allowedAdditionalScopes: readonly string[] = [],
): { healthScopes: string[]; missing: string[]; unexpected: string[] } {
  const comparison = compareGrantedScopes(
    grantedScopes,
    requestedScopes,
    allowedAdditionalScopes,
  );
  if (comparison.unexpected.length) {
    throw new TypeError(
      `Google returned ${comparison.unexpected.length} unexpected OAuth permission(s).`,
    );
  }
  const healthScopes = [...new Set(grantedScopes)].filter((scope) =>
    scope.startsWith(HEALTH_SCOPE_PREFIX),
  );
  if (healthScopes.length === 0) {
    throw new TypeError(
      "Google Health consent must include at least one scope.",
    );
  }
  return { ...comparison, healthScopes };
}
