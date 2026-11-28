# Privacy

This project is self-hosted software. The repository maintainers do not operate a hosted service and do not receive your Google Health data merely because you use the source code.

## Data and purpose

When configured, the server requests the Google Health permissions selected during Google OAuth. It processes requested health records in memory to respond to MCP tool calls, including on-demand reads, summaries, and explicitly requested supported writes. It does not run background polling or maintain a health-record database.

The application stores OAuth credentials needed for continued access. In local mode, the Google refresh token is written to a user-private configuration file outside the repository. In remote mode, the Google refresh token and account identity are placed in encrypted properties of the Cloudflare OAuth grant, with OAuth state and MCP tokens managed by Cloudflare Workers OAuth Provider and stored using the configured KV namespace. If the optional ChatGPT dashboard is enabled, its user-defined step, sleep, hydration, and exercise targets are stored in the same KV namespace as separate preference keys under a prefix derived from the authorized Google account subject. These settings are not health records and no raw health responses are persisted. Do not share access to the local account or Cloudflare project with people you do not trust.

## Sharing with MCP clients

When a user invokes a tool, the specific returned data is sent to the MCP client. A client such as ChatGPT may process that data under its own product terms and privacy settings. The user must choose whether to connect the MCP server and invoke health tools. The server does not send health records to analytics, advertising, data-broker, or general-purpose model-training services.

The remote consent page discloses this data flow before the user proceeds to Google's OAuth consent. Local setup displays the same data flow in the terminal and requires the user to type `AUTHORIZE` before opening Google sign-in. The account owner should preserve that disclosure and make deployment-specific privacy information available to authorized users.

The supplied Cloudflare Worker configuration disables observability and invocation logging. Cloudflare documents invocation logs as including request URLs, and OAuth callback URLs carry short-lived authorization codes. A deployment owner who overrides this setting must review what their logging configuration captures and retains before enabling it.

## Retention and deletion

The application does not retain health response bodies after a request completes or store health records in browser storage. OAuth grant metadata, encrypted credential properties, and any dashboard preferences remain until authorization is revoked or the configured OAuth store is deleted. To remove preferences without revoking access, delete all KV keys beginning with `health-preferences:<encoded Google subject>` in the Cloudflare dashboard. To stop Google access, revoke the Google Health grant in the Google Account's third-party connections. To invalidate all remote MCP client grants and preferences, disable the Worker and delete its OAuth KV namespace. Local users can delete the configured credentials file and revoke Google access.

The server's health data delete tool affects only exact Google Health record names supplied with explicit confirmation; it does not delete OAuth state or records stored by other services.

## Security

Credentials are excluded from Git by default. Remote transport uses HTTPS, Google identity is verified from an ID token, and the email must match `HEALTH_ALLOWED_EMAIL`. The OAuth Provider encrypts grant properties at rest. The server does not log request bodies, health results, OAuth codes, tokens, or authorization headers. No local credential, Google refresh token, sample real record, or personal account value should be committed.

Cloud hosting moves request processing off the user's device. Deployment owners are responsible for reviewing their Google Cloud and Cloudflare account security, access, terms, and any security assessment that Google requires for their use case.

## Google Health Limited Use statement

The project is intended for personal wellness and fitness access requested by the account owner. The use of information received from Google Health API and/or Developer Tools will adhere to the [Google Health API Developer and User Data Policy](https://developers.google.com/health/policies/health-api-developer-user-data-policy), including the [Limited Use requirements](https://developers.google.com/health/policies/health-api-developer-user-data-policy#limited_uses_of_user_data).

Users must review all applicable Google Health API terms and the terms of their MCP client before use. This statement describes the project's intended use; it is not a certification or legal determination of compliance.
