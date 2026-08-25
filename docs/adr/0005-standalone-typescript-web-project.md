# Standalone TypeScript Web Project

OPC UA Studio's browser product requires a browser UI and a server-side OPC UA client. The desktop product is maintained separately with Wails, Svelte, Go, and `gopcua`.

## Decision

This repository is the standalone web project and uses one npm workspace:

- `apps/client` is a React/Vite browser application;
- `apps/server` is the Node.js composition root and same-origin HTTP/SSE delivery adapter;
- `packages/application` owns platform-neutral Troubleshooting Session behavior;
- `packages/node-opcua-adapter` is the only module that imports `node-opcua`;
- `packages/contracts` contains generated types for the private versioned web transport contract; and
- `packages/test-support` supplies clocks, fakes, and probes for deterministic tests.

`node-opcua` runs only in the Node.js process. The browser never opens an OPC UA connection and never receives Client Certificate private keys. The Node.js process serves the built React assets and `/api/v1` from the same origin.

This project does not import, build, package, or release desktop runtime code. Product terminology and deliberately compatible behavior may be exchanged through versioned documentation and language-neutral fixtures, not source dependencies or synchronized release versions.

The TypeScript application module is the primary behavioral test seam. It accepts OPC UA client creation, Saved Connection persistence, time, logging, and event publication as dependencies. It does not import React, the HTTP framework, filesystem modules, or `node-opcua`.

Before the production adapter relies on `node-opcua`, an executable capability spike must establish endpoint selection, certificate handling, disabled automatic reconnect, continuation handling, subscriptions, Method metadata, timeout semantics, actual dial control, and exact Int64/UInt64 representation.

## Consequences

The web project can evolve, test, and release independently. A single Node.js process owns authentication, controller leases, browser liveness renewal, HTTP/SSE delivery, OPC UA sessions, persistence adapters, and shutdown.

Behavior that intentionally matches desktop can drift across repositories. Shared fixtures therefore carry explicit versions and applicability metadata; neither repository follows the other's unversioned main branch during a release.

## Rejected alternatives

- Keep desktop and web in one repository: the products share no runtime code and now have independent development and release lifecycles.
- Maintain this project as a GitHub fork of the desktop repository: there is no upstream/downstream source relationship to preserve.
- Share the Go application module through a Go HTTP server: this prevents use of `node-opcua` and couples web operation to desktop implementation choices.
- Run `node-opcua` in React: browsers cannot safely provide the networking, certificate, and private-key capabilities required by OPC UA.
- Add a Go-to-Node bridge: this creates two server runtimes and an additional internal transport without enough benefit.
