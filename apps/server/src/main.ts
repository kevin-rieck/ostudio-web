import { pathToFileURL } from "node:url";
import { createApplication, type ApplicationFacade, type ApplicationSnapshot } from "@ostudio/application";
import { createNodeOpcuaAdapter } from "@ostudio/node-opcua-adapter";
import type {
  AddressSpaceNode,
  BrowseResult,
  EndpointDiscoveryResult,
  SearchResult,
  Snapshot,
} from "@ostudio/contracts";
import { createServer, type WebServer } from "./server.js";

function snapshotForTransport(source: ApplicationSnapshot): Snapshot {
  const nodeMap = new Map<string, AddressSpaceNode>();
  for (const result of source.search.results) {
    nodeMap.set(result.nodeId, {
      nodeId: result.nodeId,
      nodeClass: (result.nodeClass === "Unspecified" ? "Object" : result.nodeClass) as AddressSpaceNode["nodeClass"],
      browseName: result.browseName ?? result.nodeId,
      displayName: result.displayName ?? result.browseName ?? result.nodeId,
    });
  }
  for (const reference of source.browsed?.references ?? []) {
    nodeMap.set(reference.nodeId, {
      nodeId: reference.nodeId,
      nodeClass: (reference.nodeClass === "Unspecified" ? "Object" : reference.nodeClass) as AddressSpaceNode["nodeClass"],
      browseName: reference.browseName.name ?? reference.nodeId,
      displayName: reference.displayName.text ?? reference.browseName.name ?? reference.nodeId,
    });
  }
  return {
    sequence: 0,
    buildVersion: process.env.OSTUDIO_BUILD_VERSION ?? "0.0.0",
    generatedAt: new Date().toISOString(),
    controller: { role: "controller", controllerGeneration: 0 },
    safety: source.safety,
    connection: {
      state: source.connection.state === "connection-lost" ? "lost" : source.connection.state,
      ...(source.connection.endpointUrl ? { endpoint: source.connection.endpointUrl } : {}),
      ...(source.connection.securityPolicy ? { securityPolicy: source.connection.securityPolicy } : {}),
      ...(source.connection.securityMode ? { securityMode: source.connection.securityMode } : {}),
      ...(source.connection.identityStatus ? { identityStatus: source.connection.identityStatus } : {}),
    },
    nodes: [...nodeMap.values()].slice(0, 10_000),
    ...(source.browsed ? { browsed: source.browsed } : {}),
    search: { ...source.search, results: source.search.results.slice(0, 10_000) },
  };
}

export async function start(): Promise<void> {
  const serverRef: { current?: WebServer } = {};
  const application: ApplicationFacade = createApplication({
    clock: { now: () => new Date() },
    events: { publish: (event) => {
      if (event.type === "diagnostic-changed") {
        const record = event.snapshot.diagnostics.at(-1);
        if (record) serverRef.current?.recordConnectionDiagnostic(record);
      }
      serverRef.current?.publishEvent("snapshot-required", { reason: "reconnect" });
    } },
    clientFactory: (options) => createNodeOpcuaAdapter(options),
    savedConnections: { list: async () => [], save: async () => undefined },
  });
  const runtime = {
    snapshot: (): Snapshot => snapshotForTransport(application.snapshot()),
    discover: (request: { endpointUrl: string }): Promise<EndpointDiscoveryResult> => application.discover(request),
    connect: (request: { endpointUrl: string }): Promise<void> =>
      application.connect({
        endpointUrl: request.endpointUrl,
        securityMode: "None",
        userIdentity: { type: "anonymous" },
      }),
    browse: (request: { nodeId: string }): Promise<BrowseResult> => application.browse(request),
    search: (request: { query: string }): Promise<SearchResult> => application.search(request.query),
    setReadOnly: (readOnly: true): Promise<void> => application.setReadOnly(readOnly),
    disconnect: (): Promise<void> => application.disconnect(),
    close: (): Promise<void> => application.close(),
  };
  const server = await createServer({ runtime });
  serverRef.current = server;
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  await server.listen({ host: "0.0.0.0", port });
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 15_000);
    try {
      await server.shutdown();
    } finally {
      clearTimeout(timeout);
    }
  };
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown();
  });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await start();
}
