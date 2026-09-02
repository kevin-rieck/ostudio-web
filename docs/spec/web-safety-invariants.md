# OPC UA Studio Web safety invariants

**Contract version:** `1.0.0`

This document is the language-neutral behavioral contract for OPC UA Studio's
web target. It describes observations available to an Automation Engineer; it
does not prescribe TypeScript classes, HTTP framework APIs, or `node-opcua`
implementation details. The version applies to the fixtures in
`testdata/conformance/` and to `api/openapi.yaml`.

## Applicability and vocabulary

Each conformance fixture declares `applicableTargets` as `web` or
`desktop-and-web`. A fixture marked `desktop-and-web` is a compatibility
fixture, and must also declare the source behavior version that produced it.
Fixtures marked only `web` describe browser transport or deployment behavior
that has no desktop equivalent. Web validation loads every fixture that lists
`web`; it does not check out or import desktop source code.

The terms **Read-Only Mode**, **Saved Connection**, **Troubleshooting Session**,
**Address Space**, **Variable Node**, **Method Node**, **Watchlist**, and
**Session Trend** have the meanings in `CONTEXT.md`.

## Safety state

1. A new process starts in Read-Only Mode.
2. A successful connection, deliberate Troubleshooting Session Recovery,
   controller takeover, controller loss, authentication expiry, logout,
   connection loss, and shutdown all result in Read-Only Mode being enabled.
3. Only an authenticated current controller may request a transition out of
   Read-Only Mode. The transition requires an explicit confirmation; opening a
   form, focusing a control, pressing Enter, or receiving a retried HTTP
   request is not confirmation.
4. An observer, an unauthenticated browser, and a browser with an expired or
   stale controller generation cannot change application state.
5. A safety transition and a mutation are serialized. A mutation never starts
   after a safety generation has changed, and no safety transition waits for a
   mutation that can no longer be proven safe.
6. A controller lease is renewed by an authenticated same-origin request. SSE
   heartbeats do not renew or prove the lease. Missing renewals for the
   configured lease-loss interval revoke control and restore Read-Only Mode.
7. Takeover revokes the previous controller immediately. The previous browser
   cannot use an already-issued lease or challenge after takeover.
8. A same-browser recovery is explicit and never restores write capability. It
   is allowed only when no other browser has taken over.
9. The runtime never reconnects to an OPC UA Server automatically. A timeout
   or transport loss during a mutation is `unknown` when completion cannot be
   proven. The server restores Read-Only Mode and the Automation Engineer must
   inspect server state before another mutation.

## Mutation and idempotency state

- Variable Node Writes and Method Calls use prepare then confirm. Preparation
  rechecks the current target metadata and binds a short-lived, one-time
  challenge to the normalized target and inputs, authenticated browser
  session, connection identity, controller generation, safety generation, and
  operation ID.
- Confirmation consumes the challenge before attempting the operation. A
  browser or HTTP retry therefore cannot execute a challenge twice.
- An operation ID is unique within an authenticated browser session and
  connection generation. A repeated ID returns its retained outcome and does
  not execute the operation again. If a prior outcome cannot be represented,
  the server returns `operation_result_unavailable` and does not execute it.
- Each authenticated browser session retains at most 1,000 mutation IDs. At
  the limit, new preparation is rejected; a used ID is never evicted while the
  session remains valid. Records end with the authentication session or process.
- Challenge expiry, target mismatch, connection change, controller change,
  safety change, and logout reject confirmation without execution.
- A conclusive server rejection is `rejected`. A successful server result is
  `succeeded`. An unprovable result is `unknown`; it is never converted to
  `rejected` merely because a client-side deadline elapsed.

## Private transport and redaction

The versioned transport is private, same-origin JSON HTTP plus Server-Sent
Events. The OpenAPI file is the source contract for the wire envelope. JSON
properties use lower camel case. The generated/browser-facing models contain
only bounded, transport-safe data:

- snapshots contain controller role/generation, safety state, connection
  summaries, Address Space metadata, and bounded Live Values;
- events contain a monotonically increasing `sequence`, `buildVersion`, an
  event type, and a bounded payload;
- operation outcomes contain IDs, status, safe error codes, and timestamps;
- mutation challenges contain an opaque challenge token and binding
  generations, never the bound inputs;
- safe errors contain a stable code, human-safe message, correlation ID, and
  optional operation ID. They do not contain stack traces, secrets, cookies,
  private keys, host paths, or unnecessary network details.

The transport never returns passwords, session cookies, private-key material,
certificate contents, container or host paths, raw `node-opcua` values, or
unbounded values. Client Certificate inventory may expose a display label and
an opaque relative reference under the configured certificate mount only.
Diagnostic records exclude Variable mutation values and Method inputs/outputs.
Live Values are bounded display projections, not raw library objects.

Authentication cookies are an HTTP mechanism and are never represented in a
JSON model or event. State-changing requests and SSE attachment require a
valid configured public origin. Forwarded headers affect that decision only
when the direct peer is in the explicitly trusted proxy range.

## Scalar normalization

Wire representations are deterministic and preserve information:

- Boolean values are JSON booleans.
- SByte, Byte, Int16, UInt16, Int32, and UInt32 values are finite JSON
  integers within the OPC UA type range.
- Int64 and UInt64 values are canonical base-10 strings, including a leading
  minus only for Int64 negatives. Leading zeroes, plus signs, decimals, and
  exponential notation are rejected. JavaScript `number` is never used for
  these types.
- Float and Double values are finite JSON numbers. Non-finite OPC UA values
  use explicit display/status metadata rather than JSON `NaN` or `Infinity`.
- DateTime values use UTC RFC 3339 strings. Strings remain strings and
  ByteStrings use bounded base64 projections.

A rejected representation is reported as a safe validation error and is not
silently rounded or coerced.

## Address Space Search ordering

Search is deterministic and may be incomplete until more of the Address Space
has been browsed or indexed. The ordering key is, in order:

1. explicit-browse membership (`true` before `false`);
2. match rank: exact Alias Name, exact BrowseName, exact DisplayName, prefix
   match, then substring match;
3. shorter Address Space distance; and
4. Unicode code-point order of the stable Node identifier.

The same query and same known metadata produce the same order regardless of
response arrival order. Rate-Limited Browsing uses a one-second default
shallow-browse interval and no more than 250 browse requests in one
Troubleshooting Session. Budget exhaustion marks coverage incomplete instead
of turning a partial result into an operational failure.

## Bounded state

- A Watchlist contains at most 100 Variable Nodes. The 101st distinct node is
  rejected without evicting an existing node.
- A Session Trend contains at most the latest 500 points per Variable Node.
  Adding a point evicts only the oldest point for that node.
- Request bodies are at most 1 MiB, with tighter limits for individual fields.
  Oversized requests are rejected before application work.
- SSE clients have bounded queues. Replaceable Live Value, inspection, and
  Watchlist updates may be coalesced. Ownership and safety events are never
  silently coalesced; a slow client is disconnected and must resynchronize
  from an authoritative snapshot.

## Saved Connections

Saved Connections contain only non-secret reconnect details. OPC UA passwords,
private-key contents, cookies, live Variable Values, active subscriptions, and
Troubleshooting Session state are not persisted. A certificate entry is an
opaque mounted reference plus safe inventory metadata. A legacy unavailable
certificate path is flagged for review and is never silently copied or
rewritten.

When an input contains a secret or a host path, stripping it produces a safe
Saved Connection and records a non-secret warning where appropriate. The
operation does not mutate the caller's input. Corrupt storage fails safely;
partial writes never replace the last valid file.

## Diagnostics and health

Diagnostics retain actor, endpoint summary, controller generation, node
identifiers, operation/correlation ID, and outcome. They omit passwords,
cookies, keys, host paths, Variable values, Method inputs, and Method outputs.
Errors and diagnostics use stable codes and bounded messages.

Unauthenticated `/health/live` and `/health/ready` disclose only a minimal
health status. They disclose no authentication, controller, connection,
filesystem, certificate, or OPC UA details. Readiness is false until startup,
configuration, and storage migration have succeeded.
