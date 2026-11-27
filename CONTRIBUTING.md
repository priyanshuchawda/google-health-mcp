# Contributing

Contributions are welcome. Keep the project focused on a safe personal Google Health MCP server.

## Before changing API behavior

- Verify endpoints, fields, scopes, filters, and operation support in current official Google Health documentation and discovery documents.
- Refresh metadata with `npm run spec:update`, inspect the diff, and update capability tests when support changes.
- Do not infer write support from a permission name. The per-type capability registry is authoritative for tool gating.
- Do not add real health data, credentials, or account identifiers to tests, issues, logs, or documentation.

## Development checks

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run worker:dry-run
```

Add focused tests for behavior changes. Tests must use synthetic data or mocked API responses. Never deploy or perform real health writes as part of CI.

## Pull requests

Describe the user need, API sources checked, security implications, and verification performed. Note any unverified live API assumptions. Keep changes small, and update README/privacy/security documentation when permissions or data handling changes.
