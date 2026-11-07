import { pathToFileURL } from "node:url";
import { createApplication, type ApplicationFacade, type ApplicationSnapshot } from "@ostudio/application";
import { createNodeOpcuaAdapter } from "@ostudio/node-opcua-adapter";
import type {
  AddressSpaceNode,
  BrowseResult,
  EndpointDiscoveryResult,
  SearchResult,
  SessionTrendPoint,
  Snapshot,
  VariableNodeInspection,
} from "@ostudio/contracts";
import { createServer, type WebServer } from "./server.js";

function displayValue(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 4_096);
  try {
    return JSON.stringify(value)!.slice(0, 4_096);
  } catch {
    return "Value unavailable";
  }
}

function snapshotForTransport(source: ApplicationSnapshot): Snapshot {
  const nodeMap = new Map<string, AddressSpaceNode>();
  const addNode = (
    nodeId: string,
    nodeClass: AddressSpaceNode["nodeClass"],
    browseName: string,
    displayName: string,
  ): void => {
    nodeMap.set(nodeId, {
      nodeId,
      nodeClass,
      browseName: browseName.slice(0, 512),
      displayName: displayName.slice(0, 512),
    });
  };
  for (const result of source.search.results) {
    addNode(
      result.nodeId,
      (result.nodeClass === "Unspecified" ? "Object" : result.nodeClass) as AddressSpaceNode["nodeClass"],
      result.browseName ?? result.nodeId,
      result.displayName ?? result.browseName ?? result.nodeId,
    );
  }
  for (const reference of source.browsed?.references ?? []) {
    addNode(
      reference.nodeId,
      (reference.nodeClass === "Unspecified" ? "Object" : reference.nodeClass) as AddressSpaceNode["nodeClass"],
      reference.browseName.name ?? reference.nodeId,
      reference.displayName.text ?? reference.browseName.name ?? reference.nodeId,
    );
  }
  const inspections: Record<string, VariableNodeInspection> = {};
  for (const [nodeId, inspection] of Object.entries(source.inspections)) {
    const liveValue = inspection.value
      ? {
          displayValue: displayValue(inspection.value.value?.value ?? null),
          status: inspection.value.status.name,
          ...(inspection.value.sourceTimestamp ? { sourceTimestamp: inspection.value.sourceTimestamp } : {}),
          ...(inspection.value.serverTimestamp ? { serverTimestamp: inspection.value.serverTimestamp } : {}),
          stale: inspection.stale,
          ...(inspection.metadata?.range ? { outOfRange: inspection.outOfRange } : {}),
        }
      : undefined;
    inspections[nodeId] = {
      nodeId,
      ...(inspection.metadata ? { metadata: inspection.metadata } : {}),
      ...(liveValue ? { liveValue } : {}),
      stale: inspection.stale,
      outOfRange: inspection.outOfRange,
      ...(inspection.updatedAt ? { updatedAt: inspection.updatedAt } : {}),
    };
    const nodeMetadata = inspection.metadata;
    addNode(
      nodeId,
      "Variable",
      nodeMetadata?.browseName?.name ?? nodeId,
      nodeMetadata?.displayName?.text ?? nodeMetadata?.browseName?.name ?? nodeId,
    );
    const node = nodeMap.get(nodeId)!;
    node.dataType = nodeMetadata?.dataType;
    node.liveValue = liveValue;
  }
  for (const nodeId of source.watchlist) {
    if (!nodeMap.has(nodeId)) addNode(nodeId, "Variable", nodeId, nodeId);
  }
  const trends: Record<string, SessionTrendPoint[]> = Object.fromEntries(
    Object.entries(source.trends).map(([nodeId, points]) => [
      nodeId,
      points.slice(-500).map((point) => ({
        timestamp: point.timestamp,
        displayValue: displayValue(point.value),
        status: point.status.name,
      })),
    ]),
  );
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
    watchlist: source.watchlist.slice(0, 100),
    inspections,
    trends,
    ...(source.browsed ? { browsed: source.browsed } : {}),
    search: { ...source.search, results: source.search.results.slice(0, 10_000) },
  };
}

export async function start(): Promise<void> {
  const serverRef: { current?: WebServer } = {};
  let snapshotEventTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSnapshotEvent = (): void => {
    if (snapshotEventTimer !== undefined) return;
    snapshotEventTimer = setTimeout(() => {
      snapshotEventTimer = undefined;
      serverRef.current?.publishEvent("snapshot-required", { reason: "reconnect" });
    }, 50);
  };
  const application: ApplicationFacade = createApplication({
    clock: { now: () => new Date() },
    events: {
      publish: (event) => {
        if (event.type === "diagnostic-changed") {
          const record = event.snapshot.diagnostics.at(-1);
          if (record) serverRef.current?.recordConnectionDiagnostic(record);
        }
        scheduleSnapshotEvent();
      },
    },
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
    inspectVariable: async ({ nodeId }: { nodeId: string }): Promise<void> => {
      await application.inspectVariable(nodeId);
    },
    addToWatchlist: async ({ nodeId }: { nodeId: string }): Promise<void> => {
      const snapshot = application.snapshot();
      const alreadyListed = snapshot.watchlist.includes(nodeId);
      if (!alreadyListed && snapshot.inspections[nodeId]?.stale !== false) await application.inspectVariable(nodeId);
      await application.addToWatchlist(nodeId);
      try {
        await application.subscribe(nodeId);
      } catch (error) {
        if (!alreadyListed) await application.removeFromWatchlist(nodeId);
        throw error;
      }
    },
    removeFromWatchlist: async ({ nodeId }: { nodeId: string }): Promise<void> => {
      await application.unsubscribe(nodeId);
      await application.removeFromWatchlist(nodeId);
    },
    setReadOnly: (readOnly: true): Promise<void> => application.setReadOnly(readOnly),
    disconnect: (): Promise<void> => application.disconnect(),
    close: async (): Promise<void> => {
      if (snapshotEventTimer !== undefined) clearTimeout(snapshotEventTimer);
      snapshotEventTimer = undefined;
      await application.close();
    },
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
