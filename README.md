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

- Node.js 24 or newer
- npm 11 or newer

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

## Security posture

`node-opcua`, Client Certificates, private keys, and OPC UA sockets remain server-side. Browser contracts must not expose private material, host paths, or raw library values. Read [`AGENTS.md`](AGENTS.md) before changing module placement or safety behavior.
