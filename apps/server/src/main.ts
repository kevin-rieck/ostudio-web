import { pathToFileURL } from "node:url";
import {
  createApplication,
  ApplicationError,
  type ApplicationFacade,
  type ApplicationSnapshot,
  type OpcUaDataType,
  type VariableNodeMetadata as ApplicationVariableNodeMetadata,
} from "@ostudio/application";
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

const standardDataTypes: Record<number, OpcUaDataType> = {
  1: "Boolean",
  2: "SByte",
  3: "Byte",
  4: "Int16",
  5: "UInt16",
  6: "Int32",
  7: "UInt32",
  8: "Int64",
  9: "UInt64",
  10: "Float",
  11: "Double",
  12: "String",
  13: "DateTime",
  14: "Guid",
  15: "ByteString",
  16: "XmlElement",
  17: "NodeId",
  18: "ExpandedNodeId",
  19: "StatusCode",
  20: "QualifiedName",
  21: "LocalizedText",
  22: "ExtensionObject",
  23: "DataValue",
  24: "Variant",
  25: "DiagnosticInfo",
};

function variableDataType(value: unknown): OpcUaDataType | undefined {
  const match = /^(?:ns=0;)?i=(\d+)$/.exec(String(value));
  return match ? standardDataTypes[Number(match[1])] : undefined;
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
  const inspectVariable = async (nodeId: string): Promise<void> => {
    const attributes = await application.read([
      { nodeId, attributeId: 2 },
      { nodeId, attributeId: 14 },
      { nodeId, attributeId: 15 },
      { nodeId, attributeId: 16 },
    ]);
    const readResults = Array.isArray(attributes) ? attributes : [attributes];
    const attributeValue = (attributeId: number): unknown => {
      const result = readResults.find((item) => item.attributeId === attributeId);
      return result?.dataValue.status.name === "Good" ? result.dataValue.value?.value : undefined;
    };
    if (attributeValue(2) !== 2) {
      throw new ApplicationError("invalid_request", "The selected node is not a readable Variable Node.");
    }
    const source = application.snapshot();
    const reference = source.browsed?.references.find((candidate) => candidate.nodeId === nodeId);
    const result = source.search.results.find((candidate) => candidate.nodeId === nodeId);
    let browseResult;
    try {
      browseResult = await application.browse({ nodeId });
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== "browse_budget_exhausted") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      browseResult = await application.browse({ nodeId });
    }
    const properties = browseResult.references.filter((candidate) =>
      ["EURange", "EngineeringUnits"].includes(candidate.browseName.name ?? ""),
    );
    const propertyValues = properties.length
      ? await application.read(properties.map((property) => ({ nodeId: property.nodeId })))
      : [];
    const readValues = Array.isArray(propertyValues) ? propertyValues : [propertyValues];
    const propertyValue = (name: string): unknown => {
      const index = properties.findIndex((property) => property.browseName.name === name);
      return index >= 0 ? readValues[index]?.dataValue.value?.value : undefined;
    };
    const rangeValue = propertyValue("EURange");
    const rangeObject =
      typeof rangeValue === "object" && rangeValue !== null ? (rangeValue as Record<string, unknown>) : undefined;
    const low = typeof rangeObject?.low === "number" && Number.isFinite(rangeObject.low) ? rangeObject.low : undefined;
    const high =
      typeof rangeObject?.high === "number" && Number.isFinite(rangeObject.high) ? rangeObject.high : undefined;
    const unitsValue = propertyValue("EngineeringUnits");
    const unitsObject =
      typeof unitsValue === "object" && unitsValue !== null ? (unitsValue as Record<string, unknown>) : undefined;
    const unitsDisplay =
      typeof unitsObject?.displayName === "object" && unitsObject.displayName !== null
        ? (unitsObject.displayName as Record<string, unknown>)
        : undefined;
    const valueRank = attributeValue(15);
    const arrayDimensions = attributeValue(16);
    const dataType = variableDataType(attributeValue(14));
    const metadata: ApplicationVariableNodeMetadata = {
      nodeId,
      ...(reference ? { browseName: reference.browseName, displayName: reference.displayName } : {}),
      ...(dataType ? { dataType } : {}),
      ...(typeof valueRank === "number" && Number.isInteger(valueRank) && valueRank >= -3 ? { valueRank } : {}),
      ...(Array.isArray(arrayDimensions) &&
      arrayDimensions.length > 0 &&
      arrayDimensions.length <= 16 &&
      arrayDimensions.every((dimension) => Number.isSafeInteger(dimension) && dimension >= 0)
        ? { arrayDimensions }
        : {}),
      ...(!reference && result?.browseName ? { browseName: { namespaceIndex: 0, name: result.browseName } } : {}),
      ...(!reference && result?.displayName ? { displayName: { text: result.displayName } } : {}),
      ...(low !== undefined || high !== undefined
        ? { range: { ...(low !== undefined ? { low } : {}), ...(high !== undefined ? { high } : {}) } }
        : {}),
      ...(typeof unitsDisplay?.text === "string" ? { engineeringUnit: unitsDisplay.text } : {}),
    };
    await application.inspectVariable(nodeId, metadata);
  };
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
    inspectVariable: ({ nodeId }: { nodeId: string }): Promise<void> => inspectVariable(nodeId),
    addToWatchlist: async ({ nodeId }: { nodeId: string }): Promise<void> => {
      const snapshot = application.snapshot();
      const alreadyListed = snapshot.watchlist.includes(nodeId);
      if (!alreadyListed && snapshot.inspections[nodeId]?.stale !== false) await inspectVariable(nodeId);
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
