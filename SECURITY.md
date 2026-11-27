# Security policy

## Reporting a vulnerability

Please do not open a public issue containing credentials, health information, or an exploitable vulnerability. Use GitHub's private vulnerability reporting for this repository if available. Otherwise contact the repository owner privately through GitHub. Include affected version, impact, and reproducible steps with synthetic data. Do not send OAuth secrets or personal health records.

## Security boundaries

- Google OAuth credentials and refresh tokens must never be committed, placed in spreadsheet cells, or included in logs.
- Local credentials are stored outside the repository; remote Google credentials are kept in encrypted OAuth grant properties.
- Google authorization is separate from MCP-client authorization. MCP bearer tokens are never sent to Google.
- The remote Worker allows only the configured, ID-token-verified Google email.
- Health writes require both an MCP `mcp:write` grant and the corresponding Google write scope. The local flow requests read scopes by default.
- Destructive MCP tools require an explicit confirmation argument and exact record resource names.
- Arbitrary HTTP methods/URLs, generic proxy tools, and automatic retries for writes are not exposed.
- Test fixtures and examples must be synthetic.

## Deployment owner checklist

1. Keep the GitHub source public if desired, but keep Cloudflare, Google Cloud and OAuth credentials private.
2. Restrict Google OAuth to the intended account and use HTTPS redirect URIs.
3. Keep `HEALTH_ALLOWED_EMAIL` set to the exact authorized account.
4. Request write scopes only when using write features; grant broad project IAM only for optional webhook administration.
5. Review the Google Health API policies and ChatGPT/MCP-client data terms before transferring health data.
6. Revoke Google access and remove OAuth grant storage when retiring a deployment.
