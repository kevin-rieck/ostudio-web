# OPC UA Studio Web

A browser-based OPC UA client for automation engineers who need to inspect and interact with existing OPC UA Servers.

This repository implements the web product independently with React, Node.js, TypeScript, and `node-opcua`. The desktop OPC UA Studio application is maintained separately.

## Language

**OPC UA Studio**: A client that connects to existing OPC UA Servers so automation engineers can inspect and interact with them.

**Saved Connection**: A locally stored set of non-secret details used to reconnect to an OPC UA Server. Avoid: profile, bookmark, credential, workspace.

**Read-Only Mode**: A state where OPC UA Studio does not perform writes or mutating Method Calls. Avoid: safe mode, view-only mode.

**Client Certificate**: A certificate presented by OPC UA Studio to an OPC UA Server for signed or encrypted communication.

**Automation Engineer**: A practitioner who configures, commissions, troubleshoots, or maintains industrial automation systems. Avoid: developer, operator, user.

**OPC UA Server**: An industrial automation endpoint exposing data, metadata, events, and operations.

**Address Space**: The browsable structure of an OPC UA Server containing nodes and references. Avoid: tag tree, menu, file tree.

**Address Space Search**: Search across Alias Names and Address Space metadata without requiring tree navigation first.

**Rate-Limited Browsing**: Browsing or indexing at a bounded request rate to reduce load on an OPC UA Server.

**Object Node**: A node representing an entity, grouping, or component.

**Variable Node**: A node representing a readable and sometimes writable process value or state. Avoid: tag, point.

**Method Node**: A node representing an operation exposed by an OPC UA Server.

**Method Call**: A deliberate request to execute a Method Node for its owning Object Node.

**Live Value**: The current value of a Variable Node together with health and timestamp information.

**Stale Value**: A previously observed Live Value that may no longer represent current server state.

**Troubleshooting Session**: A focused investigation of a live OPC UA Server.

**Variable Node Inspection**: The focused view of one Variable Node combining Live Value, metadata, health, stale state, and out-of-range state.

**Variable Node Write**: A deliberate change to one writable Variable Node.

**Watchlist**: A selected set of Variable Nodes whose Live Values remain readily available.

**Session Trend**: A temporary view of Live Value updates observed during the current Troubleshooting Session.

**Troubleshooting Session Recovery**: Deliberate continuation after connectivity interruption without silently resuming mutating operations.

**Diagnostic Report**: A sanitized exportable record of operations and failures that excludes secrets.
