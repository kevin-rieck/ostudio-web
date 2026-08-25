# React and node-opcua web version implementation plan

## Outcome and scope

This repository delivers OPC UA Studio's browser target as a public OCI image. It is an independent TypeScript project: a React/Vite browser application communicates with a Node.js server that owns `node-opcua`.

The separately maintained desktop and web projects do not share runtime implementation code or release lifecycles. They share product language and may exchange versioned, language-neutral conformance fixtures for behavior that intentionally remains compatible.

The first container release provides parity with current desktop troubleshooting capabilities:

- Saved Connections;
- endpoint discovery and connection;
- Address Space browsing and search;
- Variable Node Inspection;
- Watchlist and Session Trend;
- Read-Only Mode;
- Variable Node Write;
- Method inspection and Method Call; and
- Diagnostic Report.

The web target is distributed as `ghcr.io/kevin-rieck/ostudio-web`. It is not a multi-user service, OPC UA gateway, historian, phone UI, PWA, horizontally scalable deployment, or automatically reconnecting control system.

This plan records the design and divides implementation into reviewable slices. Desktop implementation and packaging are outside this repository.

## Product and deployment contract

### Runtime model

- One container owns one active OPC UA connection and Troubleshooting Session.
- One authenticated browser holds the controller lease. Other authenticated browsers may observe state and explicitly take over.
- Read-Only Mode is enabled on process startup and after every successful OPC UA connection or deliberate Troubleshooting Session Recovery.
- Takeover is immediate, revokes the previous lease, and restores Read-Only Mode.
- The controlling browser sends an authenticated, same-origin lease renewal every five seconds. One-way SSE heartbeats do not prove browser liveness.
- Missing renewals for approximately 15 seconds restores Read-Only Mode and starts a configurable five-minute OPC UA disconnect grace period.
- The same browser may recover control after a brief interruption if no takeover occurred, but Read-Only Mode remains enabled.
- Explicit logout restores Read-Only Mode and disconnects OPC UA immediately. Authentication expiry revokes control, restores Read-Only Mode, and starts the same grace period.
- Authentication, controller, OPC UA, Watchlist, inspection, and Session Trend state is in memory and does not survive a container restart.
- The runtime never reconnects automatically to an OPC UA Server.
- One logical instance has exactly one replica. Separate containers require separate data and credentials.

### Authentication and browser security

- The fixed username is `admin`; v1 has no registration, password reset, roles, SSO, OIDC, LDAP, or reverse-proxy identity.
- Production startup requires `OPCUA_STUDIO_ADMIN_PASSWORD_FILE`. Direct environment input is allowed only in explicit insecure development mode and emits a warning.
- Passwords contain at least 12 characters. Startup derives an Argon2id verifier with a per-start salt and drops the plaintext secret.
- Authentication uses opaque server-side sessions and production cookies marked `Secure`, `HttpOnly`, and `SameSite=Strict`.
- Login has a sliding 12-hour inactivity limit and a 24-hour absolute limit. Healthy controller renewals count as activity.
- Failed login responses are generic and subject to increasing source and global temporary rate limits without permanent lockout.
- The UI and `/api/v1` are same-origin. CORS is disabled. State-changing requests, controller renewal, and SSE attachment validate the configured public origin.
- Forwarded headers are ignored unless the direct peer belongs to an explicitly trusted proxy CIDR.
- Localhost-only insecure development may use non-`Secure` cookies and must display a warning. Production configuration cannot be weakened by that mode.
- The server emits a restrictive Content Security Policy and frame, MIME-sniffing, referrer, and permissions protections. The TLS proxy owns HSTS.
- The UI is self-contained and telemetry-free. It loads no public assets and installs no service worker.

### Data, certificates, and trust

- Saved Connections are stored under `/data`; OPC UA passwords are never persisted.
- Explicit ephemeral operation is supported and visibly warns that Saved Connections will be lost.
- Existing desktop `saved-connections.json` files remain readable. Unavailable desktop certificate paths are flagged and never silently rewritten.
- Client Certificates and private keys are mounted read-only under `/certs`. Browser responses contain only safe inventory metadata and opaque relative references.
- Secure OPC UA endpoints require explicit first-use trust of an algorithm-qualified SHA-256 OPC UA Server certificate fingerprint.
- The persisted pin is enforced before session creation. Certificate replacement requires explicit review and acceptance.
- A Saved Connection and pin define server identity for Troubleshooting Session Recovery. Unsaved secure connections additionally match normalized endpoint and security policy/mode.
- SecurityPolicy `None` displays an unverified-identity warning.
- An optional hostname/IP/CIDR policy restricts discovery and the actual dial target. It is unrestricted by default for compatibility.

### HTTP and live events

- One Node.js process serves the built React application and versioned `/api/v1` JSON endpoints from the same origin.
- Commands and queries use JSON HTTP. Live state uses Server-Sent Events.
- Events contain a monotonically increasing sequence and build version. Initial attachment, reconnect, gaps, and version mismatch trigger authoritative snapshot resynchronization.
- Snapshot attachment is atomic with a sequence watermark, or a bounded replay retains events after that watermark.
- Event queues are bounded. Replaceable inspection, Watchlist, and Live Value updates may be coalesced. Ownership and safety events are preserved. Slow clients are disconnected and resynchronize.
- Every browser-initiated application state change requires a valid controller generation and lease. Login, initial controller attachment, takeover, logout, and same-browser recovery are bootstrap exceptions with authentication and origin checks. Internal fail-safe, timer, OPC UA event, and shutdown transitions never require a browser lease.
- Request bodies are capped at 1 MiB with tighter field limits. Safe structured errors include codes and correlation/operation IDs without stack traces, secrets, container paths, or unnecessary network details.
- `api/openapi.yaml` is the committed private transport contract. Generated TypeScript models use lower-camel JSON fields and are not a supported third-party integration interface.

### Mutation safety

- Connection lifecycle changes, Read-Only transitions, Variable Node Writes, and Method Calls are serialized by one application coordinator.
- Safe reads and browse operations have bounded concurrency.
- Disabling Read-Only Mode requires deliberate confirmation.
- Variable Node Writes and Method Calls use server-authoritative prepare and confirm steps.
- Preparation binds normalized target and inputs to a short-lived, one-time challenge, controller generation, connection identity, safety generation, and operation ID.
- Confirmation consumes the challenge before execution. Operation IDs are scoped to the authenticated browser session and connection generation. Used IDs and retained outcomes remain in memory until that authentication session ends or the process restarts.
- Retention is bounded to 1,000 mutation IDs per authentication session. The server rejects new mutation preparation when the bound is reached; it never evicts a used ID while that session remains valid. A duplicate returns the retained outcome, or an explicit non-executing `operation_result_unavailable` error if the outcome cannot be represented.
- Browser and HTTP retries never automatically execute a mutation again.
- A timeout or transport loss that cannot prove completion returns `unknown`. Read-Only Mode is restored and the Automation Engineer must inspect server state before proceeding.
- Default deadlines are 15 seconds for discovery, connect, read, browse, and write, and 30 seconds for Method Calls.
- Diagnostics include actor, endpoint, controller generation, node identifiers, operation/correlation ID, and outcome. They omit passwords, cookies, keys, Variable values, and Method inputs/outputs.

### Browser and image support

- The supported viewport is approximately 1024×768 or larger. Narrow layouts display an unsupported-layout message.
- Current and previous desktop Chrome, Edge, and Firefox releases are supported. Chromium and Firefox run in automated tests; Safari is best effort.
- The server listens on `0.0.0.0:8080`, supports root-path hosting only, and relies on a configured TLS-terminating reverse proxy in production.
- The reference deployment uses Caddy and Docker Compose; plain `docker run` is documented.
- The image runs as a fixed non-root UID/GID with a read-only root filesystem, writes only to `/data`, and treats `/certs` as read-only.
- Official platforms are `linux/amd64` and `linux/arm64`. The web image has an independent release lifecycle from the desktop application.
- Minimal unauthenticated `/health/live` and `/health/ready` endpoints reveal no session details. Readiness means startup, configuration, and storage migration succeeded.
- `SIGTERM` rejects new work, restores Read-Only Mode, closes SSE, performs bounded OPC UA disconnect, flushes logs, and exits within 15 seconds.

## Architecture and seams

### Desktop target

The desktop application is maintained in the separate `kevin-rieck/project-cobalt` repository. This repository does not import, build, package, or release desktop runtime code. Compatibility is behavioral and documented, not a source dependency.

### Web workspace

Create an isolated npm workspace at the repository root:

```text
apps/
    client/                 React/Vite browser application
    server/                 Node.js composition root and HTTP/SSE adapter
packages/
    application/            Platform-neutral TypeScript application module
    contracts/              Generated transport types and client
    node-opcua-adapter/      Sole node-opcua integration
    test-support/           Fakes, clocks, and probes
```

The external seam of `packages/application` is the primary web behavioral test surface. It accepts an OPC UA client factory, Saved Connection store, clock/timers, logger, and event sink. It does not import React, the HTTP framework, filesystem primitives, or `node-opcua`.

`packages/node-opcua-adapter` satisfies the application OPC UA interface and is the only package allowed to import `node-opcua`. Raw Variants, ExtensionObjects, StatusCodes, and certificate-manager objects never cross that seam.

`apps/server` owns configuration, authentication, controller leases and renewal, origin checks, persistence and certificate adapters, snapshot/SSE delivery, static assets, health, and process lifecycle.

`apps/client` owns presentation and browser state. It uses only the generated HTTP/SSE contract and never imports `node-opcua`, Node.js built-ins, filesystem paths, or certificate contents.

### Cross-stack conformance

Add `docs/spec/web-safety-invariants.md` and language-neutral fixtures under `testdata/conformance/`. Each fixture declares `applicableTargets` (`web` or `desktop-and-web`). Web tests consume every applicable fixture. Compatibility fixtures imported from or exported to the desktop project are versioned explicitly rather than coupled through a source checkout.

The fixtures describe externally observable behavior, not TypeScript implementation details. A web release fails if it violates an applicable invariant.

## Buildable implementation slices

### Slice 1 — Record the standalone web architecture

- Add the standalone TypeScript architecture decision.
- Record the Node.js runtime and acknowledged controller renewal.
- Keep desktop implementation details outside this repository.

**Acceptance:** no active document claims this project imports the desktop application, runs a Go HTTP server, builds Svelte, or shares frontend views.

### Slice 2 — Define safety and transport contracts

Add:

- `docs/spec/web-safety-invariants.md`;
- `testdata/conformance/*.json`; and
- `api/openapi.yaml`.

Derive stable fixtures from documented product behavior and, where useful, versioned desktop fixtures. Define snapshot/event envelopes, operation IDs, mutation challenges, and safe error codes before implementing routes.

**Acceptance:** fixtures are language-neutral, secret fields are absent from schemas, web tests consume applicable fixtures, and contract drift can be checked deterministically.

### Slice 3 — Scaffold the isolated web workspace

Create workspace manifests, strict TypeScript configuration, lint, Vitest, React/Vite, server, Playwright, and build scripts at the repository root. Add root npm Dependabot coverage.

**Acceptance:** install, lint, typecheck, unit test, and placeholder production build pass under the selected Node LTS.

### Slice 4 — Prove node-opcua behavior

Use an in-process disposable OPC UA Server and document executable evidence for:

- discovery and exact endpoint selection;
- endpoint certificate extraction and Client Certificate/key loading;
- disabled automatic reconnect;
- browse continuation points and bounded browsing;
- attributes, properties, reads, subscriptions, and teardown;
- Method argument metadata and calls;
- scalar writes and StatusCode projection;
- operation timeout, late completion, connection loss, and shutdown;
- exact Int64/UInt64 representation without JavaScript `number`; and
- control of the actual resolved dial address.

Record results in `docs/spikes/node-opcua-client-semantics.md`. Promote only proven code and delete throwaway spike entry points.

**Acceptance:** supported Node and `node-opcua` versions are recorded. Pinning, DNS policy, no-reconnect, unknown outcomes, and 64-bit parity are not claimed until executable tests prove them.

### Slice 5 — Port the application state machine

Implement the TypeScript application module with explicit serialized transitions, injected clocks/deadlines, immutable snapshots, bounded read concurrency, typed events, and redacted diagnostics. Port behavior rather than translating Go synchronization primitives line by line.

**Acceptance:** tests use fakes and conformance fixtures; no React, HTTP framework, filesystem, or `node-opcua` imports enter the package.

### Slice 6 — Port search and Troubleshooting Session state

Port hybrid Address Space Search, explicit-browse prioritization, one-second default shallow browse interval, 250-request session budget, inspection lifecycle, stale/out-of-range state, 100-node Watchlist, and 500-point per-node Session Trends.

**Acceptance:** fake-clock and fixture tests prove ordering, budget exhaustion, queue cleanup, subscription cleanup, limits, and timestamp behavior.

### Slice 7 — Implement the node-opcua adapter

Project `node-opcua` endpoints, Variants, statuses, timestamps, Methods, and subscriptions into bounded application models. Handle continuation points to a configured bound, revalidate metadata before mutation, and distinguish conclusive rejection from unprovable completion.

**Acceptance:** unit and in-process integration tests cover all desktop-supported scalar types, exact 64-bit edges, browse/read/subscribe/write/call/disconnect, malformed metadata, late completion, and teardown. Vendor-server tests remain opt-in.

### Slice 8 — Add persistence, certificate, trust, and outbound-policy adapters

Read legacy desktop Saved Connection JSON, write a versioned schema atomically with restrictive permissions, and fail safely on corruption. Inventory `/certs` without exposing paths or contents. Reject traversal and symlink escape. Enforce the exact selected secure endpoint's SHA-256 pin before session creation. Apply optional host/IP/CIDR policy to discovery and actual dialing.

**Acceptance:** tests cover migration, interrupted writes, corrupt storage, secret omission, ephemeral mode, unavailable desktop paths, path attacks, pin replacement/mismatch, SecurityPolicy `None`, DNS changes, and IPv4/IPv6 policy.

### Slice 9 — Add mutation and recovery safety

Implement challenge preparation/confirmation, operation-result retention, safety/controller generation invalidation, unknown outcomes, deliberate same-server recovery, stale Live Values after loss, subscription cleanup, and no automatic reconnect.

**Acceptance:** deterministic race tests prove no mutation overlaps a safety transition, retries execute once, stale challenges fail, unknown results restore Read-Only Mode, recovery never starts automatically, and reaching the per-session operation-ID bound rejects new preparation without evicting deduplication records.

### Slice 10 — Build HTTP, authentication, controller, and SSE delivery

Implement the Node.js composition root, fixed-admin authentication, controller leases and renewals, takeover, grace periods, strict origin checks, security headers, request limits, safe errors, snapshots, sequenced bounded SSE, static serving, health, and bounded shutdown.

**Acceptance:** route and two-browser fake-clock tests cover observer/controller behavior, stale leases, takeover, approximately 15-second loss, five-minute grace, expiry, logout, snapshot races, gaps, slow clients, cookie flags, CSRF/origin, forwarded-header spoofing, brute force, and redaction.

### Slice 11 — Create the React shell and generated transport

Implement login, controller/observer/takeover state, resynchronization, version mismatch, insecure-development and ephemeral-storage warnings, and unsupported-layout behavior. Recreate visual tokens as needed without importing Svelte modules or desktop runtime code.

**Acceptance:** React tests cover bootstrap and ownership flows. Bundle inspection finds no `node-opcua`, Node.js built-ins, private material, external assets, telemetry, or service worker.

### Slice 12 — Port read-only workflows vertically

Port in order:

1. Saved Connections and discovery/connect;
2. Address Space browse/search;
3. Variable Node Inspection;
4. Watchlist and Session Trend;
5. Method metadata; and
6. Diagnostic Report.

Use focused React feature modules and one authoritative server-snapshot store rather than mechanically translating the desktop frontend.

**Acceptance:** each slice includes application tests, HTTP contract tests, React tests, and Chromium/Firefox Playwright coverage before the next begins. Layout and language match the current product at 1024×768.

### Slice 13 — Port mutating workflows and run conformance

Add deliberate Read-Only disable confirmation and prepare/confirm flows for Variable Node Write and Method Call. Never auto-retry confirmation. Display retained, rejected, mismatch, and unknown outcomes.

**Acceptance:** browser tests prove no Enter-key mutation, no mutation in Read-Only/observer/stale-controller states, duplicate confirmation executes once, unknown outcomes require inspection, and takeover immediately revokes the old browser. The web stack passes all web-applicable conformance fixtures; cross-project fixtures are versioned explicitly when shared with desktop.

### Slice 14 — Package and harden the container

Build React and Node artifacts in builder stages. Run the compiled Node server as a fixed non-root identity with read-only root, writable `/data`, read-only `/certs`, port 8080, OCI labels, and a shell-free healthcheck. Add Compose and Caddy examples.

**Acceptance:** image tests prove non-root/read-only-root operation, persistence, certificate mount restrictions, health privacy, absence of build tools and secrets, bounded shutdown, and amd64/arm64 builds.

### Slice 15 — Add CI, release, and operations documentation

Add web and container workflows. Include npm audit, typecheck, unit/integration tests, OpenAPI drift, Chromium/Firefox Playwright, image scanning, SBOM, provenance, signing, and independent web version tags. Document configuration, proxy trust, allowlists, volumes, backup/import, password rotation, certificate replacement, single-replica semantics, and deployment.

**Acceptance:** a release-candidate dry run creates one signed multi-platform image without depending on desktop packaging, and a clean-machine Compose walkthrough covers authentication, legacy import, connection, persistence, restart, secret rotation, and signature verification.

## Dependencies and sequencing

- Slice 1 precedes implementation.
- Slice 2 precedes application, server, and client behavior.
- Slice 3 precedes all TypeScript code.
- Slice 4 blocks production adapter claims and secure release behavior.
- Slices 5 and 6 precede real HTTP workflow routes.
- Slice 7 precedes real OPC UA vertical slices; fake-client UI work may proceed earlier.
- Slice 8 precedes secure connection and migration UI.
- Slice 9 precedes mutation and recovery routes.
- Slice 10 precedes complete browser transport tests.
- Slice 11 precedes workflow slices 12 and 13.
- Slices 12 and 13 precede release qualification.
- Slice 14 precedes release publication in slice 15.

## Primary implementation risks

### Independent safety implementations

The separate desktop and web projects can drift where behavior should remain compatible. Explicitly versioned shared invariants and fixtures mitigate this without creating a source or release dependency.

### node-opcua reconnect and timeout semantics

Library defaults may reconnect automatically, and Promise timeout does not prove an OPC UA mutation failed. The adapter must disable reconnect, test it, retain operation IDs, and classify unprovable completion as `unknown`.

### Exact 64-bit values

JavaScript `number` cannot represent the full Int64/UInt64 range. Keep externally supplied 64-bit values as validated decimal strings and prove the adapter representation before exposing those types.

### Certificate identity

Displaying a discovery thumbprint is not pin enforcement. Compare the exact selected endpoint certificate before session creation and ensure library certificate-manager defaults cannot silently accept replacement.

### DNS rebinding and actual dialing

Validating one DNS lookup while the OPC UA library resolves again is insufficient. Prove control over the actual dial address or narrow the product promise through a later ADR.

### Sensitive OPC UA values

Variants and ExtensionObjects may be large, non-JSON, or sensitive. Project them into bounded display models before snapshots, events, errors, or logs.

### Legacy persistence

The desktop format is an unversioned JSON array and currently uses direct overwrite. The Node adapter must migrate safely and must not concurrently write the same file as desktop.

### Frontend source shape

The desktop Svelte implementation is only a workflow and visual-language reference. Do not copy its Wails coupling or file structure.

### Native dependencies and image platforms

Argon2id and `node-opcua` dependencies must build reproducibly for amd64 and arm64. Pin supported Node/dependency versions and scan runtime layers.

## Release validation

At minimum:

```sh
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run contract:check
npm run test:integration
npm run test:e2e -- --project=chromium
npm run test:e2e -- --project=firefox
npm run build

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --output type=oci,dest=/tmp/opcua-studio.oci.tar .
```

Also run container non-root/read-only-root/persistence/health/shutdown tests, image scanning, SBOM/provenance/signature verification, browser-bundle inspection, image-layer secret inspection, and the opt-in real OPC UA Server suite before release.

## Architecture record outcome

ADR-0005 records this repository's standalone React/Node.js/`node-opcua` architecture. ADR-0001's hybrid Rate-Limited Browsing, ADR-0003's single-controller runtime, and ADR-0004's server-certificate pinning remain in force. The desktop project is maintained separately.
