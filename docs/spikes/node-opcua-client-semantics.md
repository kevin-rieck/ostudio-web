# `node-opcua` client semantics spike

**Status:** executable evidence recorded
**Date:** 2026-09-02
**Test:** `packages/node-opcua-adapter/src/client-semantics.test.ts`

## Versions and command

- Node.js: `v24.15.0` (the repository requires `>=24`)
- `node-opcua`: `2.178.0` (resolved by `package-lock.json`)
- Server and client run in one Node.js process.

Run the spike with:

```sh
npx vitest run packages/node-opcua-adapter/src/client-semantics.test.ts
```

The test passed with five tests on Node.js `v24.15.0` and
`node-opcua` `2.178.0`.

## Evidence

### Discovery and endpoint selection

The disposable `OPCUAServer` binds to `127.0.0.1` on an ephemeral port and
publishes both `SecurityPolicy#None`/`None` and
`Basic256Sha256`/`SignAndEncrypt` endpoints. The client connects to the
server's endpoint URL, calls `findServers()` and `getEndpoints()`, and selects
an endpoint only when all of these match:

1. `endpointUrl`;
2. `securityMode`; and
3. `securityPolicyUri`.

The selected endpoint's `serverCertificate` is non-empty and byte-for-byte
equal to the certificate configured by the in-process server. A secure client
connects with that exact endpoint and the active session reports the same
endpoint and certificate.

### Client certificate and key

The test creates a temporary client PKI using
`OPCUACertificateManager.createSelfSignedCertificate()`. It passes the
resulting PEM paths explicitly as `certificateFile` and `privateKeyFile` to
`OPCUAClient.create()`, with the temporary certificate manager supplied as
`clientCertificateManager`. The secure `Basic256Sha256` /
`SignAndEncrypt` session succeeds.

The temporary test manager uses `automaticallyAcceptUnknownCertificate`; this
only makes the disposable fixture usable and is **not** the product trust
policy. Production connection code must apply explicit server-certificate
pinning before session creation.

### Browse, reads, attributes, properties, subscriptions, writes, and calls

- `requestedMaxReferencesPerNode = 1` produces continuation points. The test
  first enforces a two-request browse bound and releases the remaining point
  with `browseNext(..., true)`, then repeatedly calls `browseNext(..., false)`
  on a fresh browse and receives all fixture children.
- `read()` returns good values for `NodeClass`, `BrowseName`, a Variable Node's
  Value, and its `EngineeringUnit` property.
- `write()` returns `StatusCodes.Good`, updates the value, and the read-back is
  the written value.
- `createSubscription2()` must set `publishingEnabled: true` explicitly in
  this version. A monitored Value notification arrives after a write with a
  good status and source timestamp. The subscription is terminated before the
  session is closed.
- `getArgumentDefinition()` returns the two declared input arguments and one
  output argument for the Method Node. `call()` returns `StatusCodes.Good` and
  the expected sum.

The test resets `requestedMaxReferencesPerNode` before calling
`getArgumentDefinition()`: the helper performs its own property browse and
must not be used with a bound of one unless the caller also drains its
continuation point.

### Int64 and UInt64

The server exposes the signed minimum
`-9223372036854775808` and unsigned maximum
`18446744073709551615`. The client receives each Variant value as the
library's two-word array, never a JavaScript `number`. `Int64ToBigInt()` and
`UInt64ToBigInt()` recover the exact values. The adapter must retain these as
validated decimal strings at its application seam and must not pass through
`number`.

### Timeout, late completion, and cancellation

`node-opcua` enforces a minimum transaction timeout of five seconds. The test
temporarily lowers that public static minimum to 20 ms so the spike remains
fast, then restores it. A Method Node increments its server-side invocation
counter immediately but waits 250 ms before sending its successful response.
With a 50 ms client transaction timeout:

- the client Promise rejects;
- the server-side invocation has started;
- no completion has been observed at rejection time; and
- the delayed server completion still occurs.

The late response is logged by `node-opcua` as an unknown/timeout request and
is not delivered as a second client result. Therefore a Variable Node Write or
Method Call that times out before completion evidence is available must be
classified as **unknown**, restore Read-Only Mode, and never be retried merely
because the client Promise rejected.

The cancellation case starts the same delayed Method, closes the server's
connected secure channel, and observes the client's pending call reject along
with `connection_lost`. `connection_reestablished` is not emitted,
`isReconnecting` remains false, and `connectionStrategy.maxRetry = 0` makes
automatic reconnect explicitly disabled. The server then shuts down and all
certificate managers and temporary files are disposed.

The server-channel close uses the in-process server's test-only connected
channel handle to create an abrupt transport loss. It is not production code.

## Resolved and unresolved constraints

Resolved for the tested version:

- endpoint discovery and exact security selection;
- explicit client certificate/key PEM loading;
- extraction and comparison of the selected server certificate;
- browse continuation points and explicit `browseNext` handling;
- reads, attributes, properties, subscriptions, writes, Method Node metadata, and Method Calls;
- transport cancellation and teardown;
- no automatic reconnect with `maxRetry: 0`; and
- exact 64-bit values without JavaScript `number` conversion.

**Unresolved: actual dial-address policy.** `node-opcua` accepts an endpoint URL
and owns the TCP connection. Validating a hostname with `dns.lookup()` before
calling `connect()` would not prove that the library dials the same address if
DNS changes between validation and connection. The spike does not claim a
hostname/IP/CIDR allowlist is enforced for the actual dial. Until a supported
transport/address injection seam is proven, production policy must either use
an endpoint URL whose resolved address is already trusted or keep this product
constraint explicit; do not advertise DNS/IP policy enforcement based only on a
separate lookup.

No production adapter behavior was promoted by this spike. The executable
coverage is retained as the reusable capability test, and it uses only
throwaway temporary certificates and an in-process disposable server.
