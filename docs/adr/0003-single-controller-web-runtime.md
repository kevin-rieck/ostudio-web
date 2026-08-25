# Single-Controller Web Runtime

The browser delivery target runs one Node.js OPC UA Studio process per container. It owns one active OPC UA connection and Troubleshooting Session.

## Decision

The web runtime has one fixed administrator identity and permits one authenticated browser to hold the controller lease. Other authenticated browsers may observe application state, but every browser-initiated application state change requires the current lease. Internal fail-safe, timer, OPC UA event, and shutdown transitions do not require a browser lease.

A controller may explicitly take over immediately. Takeover revokes the old lease and restores Read-Only Mode. The controlling browser renews its lease with an authenticated, same-origin liveness request; one-way SSE heartbeats alone are not evidence that the browser remains attached. Missing renewals cause controller loss, restore Read-Only Mode, and start the bounded disconnect grace period. The same browser may recover its own brief interruption only when no takeover occurred, and recovery remains Read-Only Mode.

The application publishes authoritative snapshots and sequenced events; controller, authentication, and active Troubleshooting Session state are in memory only. Container restart invalidates that state. The web runtime does not automatically reconnect to an OPC UA Server.

## Consequences

The single-controller model keeps Variable Node Writes and Method Calls attributable to one Automation Engineer and gives controller loss a fail-safe state. It is intentionally a single-operator deployment, not an OPC UA gateway or shared service.

## Rejected alternatives

- Multiple independent controller roles or simultaneous writers: they complicate mutation ownership without a v1 operational need.
- Multiple replicas for one logical instance: they would require distributed controller, event, and active-session coordination.
- Automatic OPC UA reconnect: it could silently resume a changed industrial state after ownership or connectivity loss.
