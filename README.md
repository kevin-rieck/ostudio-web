# OPC UA Studio Web

Browser-based OPC UA troubleshooting built with React, Node.js, TypeScript, and [`node-opcua`](https://github.com/node-opcua/node-opcua).

> The project is in its foundation stage and is not ready for production use.

## Architecture

```text
React browser
    │ JSON HTTP + SSE
    ▼
Node.js server ──► TypeScript application module ──► node-opcua adapter ──► OPC UA Server
```

- `apps/client` — React/Vite browser application
- `apps/server` — same-origin Node.js HTTP/SSE server and composition root
- `packages/application` — platform-neutral application behavior
- `packages/contracts` — private transport models and generated client
- `packages/node-opcua-adapter` — the only package allowed to import `node-opcua`
- `packages/test-support` — deterministic fakes and clocks

The Wails/Svelte/Go desktop application is maintained separately in [`kevin-rieck/project-cobalt`](https://github.com/kevin-rieck/project-cobalt). This repository does not import or package desktop runtime code.

## Requirements

- Node.js 24.15.0 (pinned in `.node-version`)
- npm 11.13.0

Select the pinned Node.js version with your version manager, then install the pinned npm if needed:

```sh
npm install --global npm@11.13.0 --ignore-scripts
```

`package.json` and `.npmrc` enforce these exact versions during installation. CI uses the same pins; update them together with `.node-version` and the lockfile metadata.

### Dependency release cooldown

`.npmrc` sets [`min-release-age=7`](https://github.com/npm/cli/blob/v11.13.0/workspaces/config/lib/definitions/definitions.js): npm resolution excludes releases newer than seven days. Dependabot also has a [seven-day cooldown](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference#cooldown) for npm version updates; its security updates bypass that cooldown.

This delays new dependency selection, not execution of already locked dependencies: `npm ci` consumes the reviewed lockfile without rechecking every publication date. Continue reviewing lockfile changes. A cooldown is not a malware scan and can delay security fixes. For an urgent fix, a maintainer must approve a one-off `npm install --min-release-age=0` with the specific package/version, review the resulting lockfile diff, and run validation; do not disable the committed policy.

## Development

```sh
npm ci
npm run dev
```

The Vite development server proxies `/api` and `/health` to the Node.js server on port 8080. Start the server separately with:

```sh
npm run dev --workspace @ostudio/server
```

## Validation

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

## Product and architecture documentation

- Product language: [`CONTEXT.md`](CONTEXT.md)
- Architecture decisions: [`docs/adr/`](docs/adr/)
- Implementation plan: [`docs/plans/0001-standalone-web-version.md`](docs/plans/0001-standalone-web-version.md)

## Saved Connection storage

Durable Saved Connections are owned by the web process under `/data/saved-connections.json` (with restrictive permissions). Legacy desktop JSON is imported with a sanitized, versioned `.bak` backup before replacement; the backup is not a byte-for-byte copy because legacy records may contain passwords. Securely remove any pre-existing raw legacy copies or backups separately; corrupt or unsupported data prevents startup. Stop the desktop application before importing and do not run desktop and web processes as concurrent writers of the same file. Set `OSTUDIO_EPHEMERAL=true` only when loss on restart is acceptable.

## Client Certificates and outbound policy

Mount PEM Client Certificates and unencrypted PEM private keys read-only in `/certs`, as separate files with `.pem`, `.crt`, or `.key` extensions. Select both in the Saved Connection; the selected certificate and key must match. The browser sees opaque references and generic labels, not filenames or contents. Files are revalidated when connecting, and keys are not copied into `/data`. Secure endpoints require deliberate review and acceptance of the discovered SHA-256 server fingerprint; changed certificates require a new review. `SecurityPolicy None` does not verify server identity.

Outbound discovery and connection are unrestricted by default. Set `OSTUDIO_OPCUA_ALLOWED_HOSTS` to a comma-separated list of exact hostnames and/or `OSTUDIO_OPCUA_ALLOWED_ADDRESSES` to comma-separated IP addresses or CIDRs. When both are set, both restrictions apply; invalid or empty rules prevent startup. Hostname-only restrictions trust the name's current DNS results, so also configure address restrictions when destination addresses must be constrained. Every DNS candidate is filtered before the socket dials. `NODEOPCUA_CLIENT_FORCE_ENDPOINT_DISCOVERY` must remain disabled because that library mode bypasses the guarded transport.

## Security posture

`node-opcua`, Client Certificates, private keys, and OPC UA sockets remain server-side. Browser contracts must not expose private material, host paths, or raw library values. Read [`AGENTS.md`](AGENTS.md) before changing module placement or safety behavior.
