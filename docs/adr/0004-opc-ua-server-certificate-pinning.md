# OPC UA Server Certificate Pinning

OPC UA Studio verifies the identity of secure OPC UA Servers through explicit first-use trust and persisted certificate pins.

## Decision

When an Automation Engineer first connects to a secure endpoint, OPC UA Studio presents the discovered OPC UA Server certificate fingerprint for deliberate trust. New pins use an algorithm-qualified SHA-256 fingerprint. Later connections enforce the pin before creating a session.

A changed certificate is not silently accepted. OPC UA Studio presents the replacement for explicit review and acceptance. Existing legacy SHA-1 display thumbprints require review rather than being treated as SHA-256 pins. SecurityPolicy `None` connections have no certificate identity and visibly state that identity is unverified.

A Saved Connection and verified pin identify the same OPC UA Server for Troubleshooting Session Recovery. Unsaved secure connections require matching normalized endpoint, security policy/mode, and pin.

## Consequences

Trust decisions are local, deliberate, and survive normal Saved Connection persistence. Certificate replacement remains an observable safety decision rather than a background reconnect detail.

## Rejected alternatives

- Trust every discovered certificate: this permits an endpoint impersonator to become a trusted OPC UA Server.
- Log or display a thumbprint without enforcing it: this gives an Automation Engineer no effective server-identity protection.
- Silent replacement when the endpoint is unchanged: endpoint equality does not prove that the OPC UA Server identity is unchanged.
