# Architecture

The local and remote servers share the same Google Health client and MCP tool registrations. Transport and authentication are adapters around that shared capability layer.

```text
MCP client
  ├─ local stdio ── local Google OAuth token file ──────────┐
  └─ HTTPS Worker ─ MCP OAuth grant ─ Google OAuth grant ──┤
                                                           ▼
                                                  MCP tool registry
                                                           │
                                                  typed HealthApi
                                                           │
                                            health.googleapis.com/v4
```

## Local stdio

The `auth` command uses Google's maintained `google-auth-library` OAuth client with authorization code flow, PKCE and a loopback-only callback. It stores the OAuth client ID and secret, refresh credential, and granted scopes in a private per-user configuration file outside the repository. The server refreshes short-lived access tokens when needed and checks every requested scope against the stored grant.

## Remote Worker

Cloudflare's maintained Workers OAuth Provider issues MCP access tokens and stores OAuth state and grants in the bound KV namespace. A consent page discloses that requested data will be returned to the MCP client. After consent, the user completes a separate Google OAuth flow. The callback verifies Google's signed identity token, nonce, verified email and configured account allowlist before issuing the MCP authorization grant.

The Google refresh token is stored in the provider's encrypted grant properties. Each authenticated `/mcp` request receives the verified grant properties and MCP scopes. `mcp:write` is required in addition to a Google write scope for mutation tools. MCP bearer tokens are never forwarded to Google. The Worker checks the account allowlist on each request, so changing it disables existing grants for the old account.

Remote project webhook administration is intentionally not exposed: it requires a broad Google Cloud project permission and is not part of the personal health-data path.

## Google Health client

The typed client derives exact REST paths and accepted query parameters from the checked-in official discovery snapshot. It rejects undeclared methods and parameters, validates write bodies against Google discovery schemas, sends OAuth bearer credentials only to Google's Health API origin, bounds response sizes and timeouts, paginates with explicit limits, and never automatically retries mutations. Error objects omit upstream response bodies.

The capability registry combines the discovery schema with the reviewed data-type matrix. This makes write availability specific to each type. The data type table is documented in [data-types.md](data-types.md).

## Summaries and data correctness

Daily metrics use Google's daily rollup endpoint when available. Sleep data uses Google's reconciliation endpoint, because overlapping watch and phone sources should not be summed as if they were independent sessions. The summary includes the requested local date and IANA timezone, uses account settings by default, preserves API units, and reports absent or incomplete values without substituting zero.

## Storage and retention

The server is on-demand and does not poll. It holds API responses only while building a response, then returns them to the MCP client. It does not create a health-data database, cache, or synchronization sheet. OAuth state and refresh credentials are retained only as required for authorization and ongoing access. See [PRIVACY.md](../PRIVACY.md).

## Official runtime references

- [Google Health API](https://developers.google.com/health/)
- [Google Health REST discovery](https://health.googleapis.com/$discovery/rest?version=v4)
- [MCP TypeScript SDK v2 web-standard serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard)
- [Cloudflare Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)
