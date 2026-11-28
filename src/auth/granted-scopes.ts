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
