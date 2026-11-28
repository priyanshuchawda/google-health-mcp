# Google Health MCP

A personal, self-hosted MCP server for Google Health API v4. Use it from an MCP-compatible assistant to read your health data, calculate careful summaries, and create or edit only the record types Google documents as writable.

The project has two ways to run:

- **Local stdio**: runs on your computer and uses a Google OAuth Desktop client.
- **Remote Worker**: an optional Cloudflare Worker with its own MCP OAuth flow and a separate Google Health authorization. The deployed endpoint is intended for one allowed Google account.

The public source repository contains no credentials or user health records. A public repository does not make a deployment or account public.

## What it supports

The checked-in capability snapshot contains all **44 Google Health data type entries** in the official catalog and endpoint metadata generated from the official v4 and v4beta discovery documents. The generic data tool respects each type's allowed operations; a type is not writable just because another type is.

| Tool                           | Purpose                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `list_data_types`              | Discover documented data types, scopes, record kinds, filters, and allowed operations                  |
| `describe_schema`              | Inspect official request parameters and payload schemas before reading or writing                      |
| `get_daily_health_summary`     | Google's source-civil-date rollups and reconciled sleep; account time zone is context, not an override |
| `get_health_data`              | List, fetch, reconcile, or aggregate a documented health data type with pagination and date filters    |
| `get_health_account_data`      | Read identity, profile, settings, paired devices, and IRN profile                                      |
| `create_health_record`         | Create one supported record from user-supplied values                                                  |
| `update_health_record`         | Patch one supported, exact record                                                                      |
| `delete_health_records`        | Delete exact record names after explicit confirmation in the tool input                                |
| `update_health_account_data`   | Update supported profile or settings fields                                                            |
| `export_exercise_tcx`          | Export a supported exercise route                                                                      |
| `get_shared_health_link`       | Read a user-provided SMART Health Link                                                                 |
| `list_webhook_configuration`   | Optional project-level webhook reads (local opt-in only)                                               |
| `write_webhook_configuration`  | Optional project-level webhook writes (local opt-in only)                                              |
| `delete_webhook_configuration` | Optional project-level webhook deletion (local opt-in only)                                            |

Daily summaries use Google's own rollups where available; raw overlapping sources are not blindly added. Missing data stays missing rather than being represented as zero. Sleep summaries distinguish session time and stages and include completeness information. Results preserve API units and dates.

The Google data type catalog does not expose native step or sleep goals through this project's supported user API methods. This server does not invent or write those goals. Webhook administration requires the broad `cloud-platform` permission and is disabled by default.

See the complete [data type and supported operation list](docs/data-types.md).

The catalog contains **44 record data types**. Some similarly named values are not data point types: Google describes basal energy burned as unavailable as its own type, while personal-range HRV and resting-heart-rate values appear in daily rollup results. The discovery tools expose only types in the reviewed API catalog.

Read the [architecture notes](docs/architecture.md) for the local/remote authorization split and request lifecycle.

## Requirements

- Node.js 22.12 or newer
- npm
- A Google Cloud project with **Google Health API** enabled and an OAuth client
- For remote hosting only: a Cloudflare account, Wrangler login, and a free KV namespace for OAuth state/grants

## Local setup

1. In Google Cloud, configure the OAuth consent screen for your own use and create an **OAuth client ID → Desktop app**. Download the client JSON to a private location outside this repository.
2. Enable Google Health API for the project. No Google Cloud service account is used.
3. In Google Auth Platform → Data Access, add the Google Health API scopes requested by this build. Enabling the API and granting OAuth scopes are separate settings; a request with unapproved scopes is rejected by Google with `403 DISALLOWED_OAUTH_SCOPES`. The requested read scopes are listed in `allHealthScopes(false)` and supported write scopes in `allHealthScopes(true)` in [`src/auth/scopes.ts`](src/auth/scopes.ts). See Google's [OAuth setup instructions](https://developers.google.com/health/setup#add-scopes).
4. Install and build:

   ```powershell
   npm ci
   npm run build
   ```

5. Authorize read access. This opens Google's consent screen and stores an authorized-user refresh token under your user profile, outside the project:

   ```powershell
   npm run auth -- --client-secrets C:\path\to\client_secret.json
   ```

   Before opening Google sign-in, the terminal displays how data flows and asks you to type `AUTHORIZE`. The Google consent screen then shows the requested scopes.

   Add `--write` only if you want the local MCP server to write supported record types. Add `--project-admin` only if you intentionally want the opt-in project webhook tools. These two switches request additional Google permissions.

6. Check the saved authorization by running:

   ```powershell
   npm run doctor
   ```

7. Start the local server:

   ```powershell
   npm run serve
   ```

### npm distribution

The repository is prepared for the `ghealth-mcp` npm package. The package is not published yet; after its first release, users can install it globally or run it with `npx`:

```powershell
npm install --global ghealth-mcp
ghealth-mcp auth --client-secrets C:\path\to\client_secret.json
ghealth-mcp doctor
```

Add `--write` to `auth` only when you want supported write scopes. The command opens Google sign-in, displays the data-flow disclosure in the terminal, and requires typing `AUTHORIZE`. Each user supplies their own OAuth Desktop client JSON; it remains outside the project. No maintainer credentials are included in the package.

For Codex or another local MCP client, the post-release `npx` configuration is:

```json
{
  "mcpServers": {
    "ghealth": {
      "command": "npx",
      "args": ["--yes", "ghealth-mcp"]
    }
  }
}
```

The executable starts stdio when invoked without arguments. Before the first npm release, clone the repository and use the source setup commands above.

The project does not require paid infrastructure or an AI API. GitHub Actions for this public repository and the optional Cloudflare Worker target their free offerings; platform eligibility, quotas, and Google OAuth requirements still apply. Do not enable billing for this project unless you intentionally choose a paid service.

For local project webhook tools, set `GOOGLE_HEALTH_ENABLE_PROJECT_ADMIN=true` and `GOOGLE_HEALTH_PROJECT_NUMBER` in the MCP process environment. The OAuth credentials must also have been granted project-admin scope using `--project-admin`.

## Remote Cloudflare Worker

The Worker is optional. It uses Cloudflare's maintained OAuth Provider for MCP authorization and Google OAuth for upstream access. The two grants are separate: the MCP client receives only an MCP token, while the Worker keeps the Google refresh token in encrypted OAuth grant properties. A verified Google email is checked against `HEALTH_ALLOWED_EMAIL` before issuing the authorization.

### Configure

1. Set the Worker name and deploy account in Wrangler if needed:

   ```powershell
   npx wrangler login
   npx wrangler whoami
   ```

   Before the first deploy, register a `workers.dev` account subdomain in **Cloudflare Dashboard → Workers & Pages → Your subdomain** if the account does not already have one. Wrangler may not be able to claim `google-health-mcp` automatically if that account-level name is unavailable. Pick an available account subdomain; the final Worker URL will be `https://google-health-mcp.<account-subdomain>.workers.dev`.

2. Create the OAuth KV namespace and copy its ID into `wrangler.jsonc` under `kv_namespaces`:

   ```powershell
   npx wrangler kv namespace create OAUTH_KV
   ```

3. Create a Google OAuth **Web application** client. Once you know the Worker URL, add this exact authorized redirect URI:

   ```text
   https://<worker-name>.<your-subdomain>.workers.dev/google/callback
   ```

   Enable Google Health API. The Worker requests OpenID email identity plus Google Health read permissions; MCP write permission is separately requested by the MCP client. Project-wide IAM scopes remain unavailable through the remote Worker.

4. Store the deployment URL and allowed Google account as Worker secrets. `MCP_RESOURCE` must be the full HTTPS Worker URL ending in `/mcp`; `HEALTH_ALLOWED_EMAIL` must be the exact account allowed to authorize this personal deployment:

   ```powershell
   npx wrangler secret put MCP_RESOURCE
   npx wrangler secret put HEALTH_ALLOWED_EMAIL
   ```

5. Add the Google client values as Worker secrets (never as `vars`):

   ```powershell
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   Keep all four values in Cloudflare's secret store. The repository has no account-specific Worker variables.

6. Verify the package, run locally if desired, then deploy only when you intend to publish the endpoint:

   ```powershell
   npm run typecheck
   npm test
   npm run worker:dry-run
   npx wrangler deploy
   ```

Cloudflare KV is required for OAuth authorization state and token/grant records. Worker observability is disabled in `wrangler.jsonc` because Cloudflare invocation logs include request URLs, which can carry OAuth callback codes. Ordinary personal use targets Workers Free and KV Free limits, but actual free-tier eligibility, account quotas, Worker CPU use and Google OAuth eligibility depend on the account and must be checked in Cloudflare/Google dashboards. This repository does not deploy automatically. The present verification is a local dry run, not a live deployment or measured production CPU result.

For local Worker development, copy `.dev.vars.example` to `.dev.vars`; edit only the synthetic loopback resource and test email unless you are intentionally testing the complete OAuth callback. `.dev.vars` is ignored by Git.

After deployment, configure the MCP client with the Worker endpoint `https://<worker-name>.<your-subdomain>.workers.dev/mcp` and complete both consent steps. If the account uses Google OAuth Testing mode, refresh tokens can expire under Google's testing rules; configure the OAuth audience appropriately for personal use and verify the current Google policy.

### Self-hosting and public service scope

Each self-hosted Worker is configured with its own `HEALTH_ALLOWED_EMAIL` secret, so another developer can deploy this repository for their own account without editing source. The checked-in/personal deployment remains single-account restricted. Removing that restriction to host a service for arbitrary Google accounts is a separate product and compliance decision; Google Health restricted-scope verification and applicable security assessment requirements must be reviewed before offering it. Public source code does not mean public access to any deployed user's records.

The optional Worker uses the Cloudflare Free Worker and KV offerings. No paid database, domain, server, polling job, or external AI API is required by the design. Quotas and free-plan eligibility are controlled by Google and Cloudflare; this project does not enable billing.

### ChatGPT

From ChatGPT on the web, open **Plugins → Add custom MCP server**, enter the deployed `/mcp` URL, and complete the server OAuth flow followed by the Google Health consent flow. Review the discovered tools before enabling them. OpenAI's current plan availability differs: its Help Center says full read/write MCP access is available on Business, Enterprise, and Edu, while Pro is limited to read/fetch; Plus availability is not promised. Check the current [ChatGPT custom MCP requirements](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) for your account before relying on write tools. The local stdio mode can also be used with other MCP clients such as Codex.

## Supported permissions and data

Local authorization is read-only by default. `--write` requests the documented write scopes for available types, but Google may not permit create/update/delete for every type. Each call is capability checked against the checked-in Google documentation snapshot and request schemas from the API discovery documents. Remote authorization has `mcp:read` and optional `mcp:write` scopes; a write-only Google scope is rejected unless the MCP grant also has `mcp:write`.

`get_health_data` takes a type slug from `spec/data-types.json`. Use date bounds to keep result sizes manageable. Pagination returns page tokens and the server limits pages/response sizes. Aggregation date limits are validated before requests. The API's supported operations and filter fields can change; refresh the snapshot and review the diff before adopting an update:

```powershell
npm run spec:update
npm run docs:data-types
```

The tool will not expose arbitrary HTTP calls. Shared Health Links are bearer capabilities: only provide links you intend this assistant to access.

## Development and verification

```powershell
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run worker:dry-run
npm run smoke:package
```

GitHub Actions runs these checks for the public repository. The `release.yml` workflow is prepared to publish a public npm package with Trusted Publishing after a GitHub Release is published. npm requires an initial package to exist before its trusted publisher can be configured; that first publication is a maintainer bootstrap step and has not been performed. Configure npm's trusted publisher for this repository and `.github/workflows/release.yml` after the package exists. There is no npm token stored in GitHub or this repository.

Tests use synthetic or mocked data. They do not prove live account permissions or write support. Never run a create, update, or delete tool against real Google Health records unless you intentionally authorized that action.

## Privacy and safety

Read [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and the applicable [Google Health API developer and user data policy](https://developers.google.com/health/policies/health-api-developer-user-data-policy) before connecting a model. When you ask an MCP client to retrieve health data, that client receives the returned data for the requested analysis under its own data-handling terms. The server does not store health responses, use them for advertising, sell them, or use them to train a general-purpose AI model. Local credentials remain on the host; remote Google refresh credentials are retained only in the OAuth provider's encrypted grant storage to support ongoing use.

This is personal wellness software, not a medical device. It does not diagnose, treat, or replace a clinician.

## API metadata provenance

`spec/api-methods.json` is generated from the official Google Health v4 and v4beta discovery documents. `spec/data-types.json` is the reviewed capability snapshot derived from the official [data type catalog](https://developers.google.com/health/data-types). Refresh through the script above, check the source URLs/dates, and update tests and documentation when API behavior changes. The `THIRD_PARTY_NOTICES.md` file acknowledges an MIT-licensed reference project used for comparison; no implementation code was copied from it.

## License

MIT. See [LICENSE](LICENSE).
