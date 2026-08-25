# Agent guidance

Read `CONTEXT.md` before changing product behavior. Durable architecture decisions live in `docs/adr/`, and the implementation sequence lives in `docs/plans/`. Issues are tracked in `kevin-rieck/ostudio-web`; see `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

## Product language

Use the canonical terms from `CONTEXT.md`. In particular, use OPC UA Studio, Saved Connection, Read-Only Mode, Troubleshooting Session, Address Space, Variable Node, Method Node, Watchlist, and Session Trend.

## Architecture

- React runs only in `apps/client`.
- Node.js composition and HTTP/SSE delivery live in `apps/server`.
- Platform-neutral behavior lives in `packages/application`.
- Only `packages/node-opcua-adapter` may import `node-opcua`.
- The browser must never receive private keys, certificate contents, host paths, or raw `node-opcua` values.
- Do not add a dependency on the desktop repository's runtime code.

## Validation

Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` before completing implementation changes.
