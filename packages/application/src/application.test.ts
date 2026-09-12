import { describe, expect, it } from "vitest";
import searchFixture from "../../../testdata/conformance/search-ordering.json";
import savedConnectionFixture from "../../../testdata/conformance/saved-connection-secret-stripping.json";
import { createApplication, type ApplicationEvent, type OpcUaClient, type OpcUaDataValue, type OpcUaReadRequest, type OpcUaSession, type SavedConnectionStore } from "./index.js";

const store: SavedConnectionStore = {
  list: async () => [],
  save: async () => undefined,
};

function client(): OpcUaClient {
  return {
    discover: async () => ({ servers: [], endpoints: [] }),
    connect: async () => ({
      browse: async () => ({ nodeId: "i=84", references: [], status: { name: "Good", value: 0 }, requests: 1, truncated: false }),
      read: async (request) => Array.isArray(request)
        ? request.map((item) => ({ ...item, attributeId: item.attributeId ?? 13, dataValue: { status: { name: "Good", value: 0 } } }))
        : { ...request, attributeId: request.attributeId ?? 13, dataValue: { status: { name: "Good", value: 0 } } },
      subscribe: async () => ({ unsubscribe: async () => undefined }),
      write: async () => ({ outcome: "succeeded" }),
      inspectMethod: async () => ({ inputArguments: [], outputArguments: [] }),
      call: async () => ({ outcome: "succeeded" }),
      close: async () => undefined,
    } as OpcUaSession),
    onConnectionLost: () => () => undefined,
    disconnect: async () => undefined,
  };
}

describe("application facade", () => {
  it("starts fail-safe and publishes an immutable connected snapshot", async () => {
    const events: ApplicationEvent[] = [];
    const application = createApplication({
      clientFactory: client,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: (event) => events.push(event) },
    });

    expect(application.snapshot()).toMatchObject({
      connection: { state: "disconnected" },
      safety: { readOnly: true, safetyGeneration: 1 },
    });
    expect(Object.isFrozen(application.snapshot())).toBe(true);

    await application.connect({ endpointUrl: "opc.tcp://plc:4840" });

    expect(application.snapshot()).toMatchObject({
      connection: { state: "connected", endpointUrl: "opc.tcp://plc:4840" },
      safety: { readOnly: true, safetyGeneration: 2 },
    });
    expect(events.map((event) => event.type)).toEqual(["connection-changed", "search-changed", "connection-changed", "safety-changed"]);
  });

  it("ranks explicit Address Space results before shallow results stably", async () => {
    const application = createApplication({
      clientFactory: client,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: () => undefined },
    });
    const result = await application.search(searchFixture.query, [
      { nodeId: "ns=2;s=unbrowsed-exact", aliasNames: ["pressure"], explicitBrowse: false, distance: 1 },
      { nodeId: "ns=2;s=browsed-substring", displayName: "pressure sensor", explicitBrowse: true, distance: 4 },
      { nodeId: "ns=2;s=browsed-browse", browseName: "pressure", explicitBrowse: true, distance: 3 },
      { nodeId: "ns=2;s=browsed-alias", aliasNames: ["pressure"], explicitBrowse: true, distance: 2 },
      { nodeId: "ns=2;s=unbrowsed-prefix", browseName: "pressure value", explicitBrowse: false, distance: 1 },
    ]);
    expect(result.results.map((candidate) => candidate.nodeId)).toEqual(searchFixture.orderedNodeIds);
  });

  it("orders display exact matches separately and uses safe connection references", async () => {
    const saved: unknown[] = [];
    const application = createApplication({
      clientFactory: client,
      savedConnections: { list: async () => [], save: async (value) => { saved.push(value); } },
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: () => undefined },
    });
    const result = await application.search("pressure", [
      { nodeId: "z", displayName: "pressure", explicitBrowse: true, distance: 1 },
      { nodeId: "😀", displayName: "pressure sensor", explicitBrowse: true, distance: 1 },
      { nodeId: "a", browseName: "pressure", explicitBrowse: true, distance: 1 },
    ]);
    expect(result.results.map((candidate) => [candidate.nodeId, candidate.match])).toEqual([
      ["a", "browse-exact"],
      ["z", "display-exact"],
      ["😀", "prefix"],
    ]);
    await application.saveSavedConnection({
      id: "1",
      name: savedConnectionFixture.input.name,
      endpoint: savedConnectionFixture.input.endpoint,
      securityPolicy: savedConnectionFixture.input.securityPolicy,
      securityMode: savedConnectionFixture.input.securityMode as "SignAndEncrypt",
      username: savedConnectionFixture.input.username,
      clientCertificateReference: "D:\\\\private.key",
      serverCertificatePin: savedConnectionFixture.input.serverCertificatePin,
    });
    expect(saved[0]).not.toHaveProperty("clientCertificateReference");
  });

  it("exposes no direct mutation facade and counts shallow browsing one request at a time", async () => {
    let browseCalls = 0;
    let browseMaxRequests: number | undefined;
    const opcua = client();
    opcua.connect = async () => ({ ...await client().connect({ endpointUrl: "opc.tcp://plc:4840" }), browse: async (request) => {
      browseCalls += 1;
      browseMaxRequests = request.maxRequests;
      return { nodeId: request.nodeId, references: [], status: { name: "Good", value: 0 }, requests: 1, truncated: false };
    } });
    let now = 0;
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date(now) },
      timers: { setTimeout: (callback) => { callback(); return 1; }, clearTimeout: () => undefined },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://plc:4840" });
    expect("write" in application).toBe(false);
    await application.search("missing");
    expect(browseCalls).toBe(1);
    expect(browseMaxRequests).toBe(1);
    now = 1_000;
    await application.search("missing-again");
    expect(browseCalls).toBe(2);
  });

  it("bounds concurrent safe reads", async () => {
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const opcua = client();
    const connect = opcua.connect;
    opcua.connect = async (request) => {
      const session = await connect(request);
      const read: OpcUaSession["read"] = (async (request: OpcUaReadRequest | OpcUaReadRequest[]) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate;
        active -= 1;
        if (Array.isArray(request)) return request.map((item) => ({ ...item, attributeId: item.attributeId ?? 13, dataValue: { status: { name: "Good", value: 0 } } }));
        return { ...request, attributeId: request.attributeId ?? 13, dataValue: { status: { name: "Good", value: 0 } } };
      }) as OpcUaSession["read"];
      return { ...session, read };
    };
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      config: { maxSafeReadConcurrency: 2 },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://plc:4840" });
    const pending = Promise.all(Array.from({ length: 5 }, (_, index) => application.inspectVariable(`ns=2;s=level-${index}`)));
    for (let attempt = 0; attempt < 10 && maximum < 2; attempt += 1) await Promise.resolve();
    expect(maximum).toBe(2);
    release();
    await pending;
  });

  it("enforces the Watchlist bound without evicting existing nodes", async () => {
    const application = createApplication({
      clientFactory: client,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      config: { watchlistLimit: 2 },
      events: { publish: () => undefined },
    });
    await application.addToWatchlist("ns=2;s=one");
    await application.addToWatchlist("ns=2;s=two");
    await expect(application.addToWatchlist("ns=2;s=three")).rejects.toMatchObject({ code: "watchlist_limit_reached" });
    expect(application.snapshot().watchlist).toEqual(["ns=2;s=one", "ns=2;s=two"]);
  });

  it("marks an inspected value stale after loss and reports range violations", async () => {
    let lost = (): void => undefined;
    const opcua = client();
    opcua.onConnectionLost = (listener) => { lost = () => listener({ code: "connection_lost", message: "lost" }); return () => undefined; };
    const connect = opcua.connect;
    opcua.connect = async (request) => {
      const session = await connect(request);
      const value: OpcUaDataValue = { status: { name: "Good", value: 0 }, value: { dataType: "Double", arrayType: "Scalar", value: 12 } };
      return { ...session, read: (async (request: OpcUaReadRequest | OpcUaReadRequest[]) => Array.isArray(request)
        ? request.map((item) => ({ ...item, attributeId: item.attributeId ?? 13, dataValue: value }))
        : { ...request, attributeId: request.attributeId ?? 13, dataValue: value }) as OpcUaSession["read"] };
    };
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://plc:4840" });
    const inspection = await application.inspectVariable("ns=2;s=level", { nodeId: "ns=2;s=level", range: { high: 10 } });
    expect(inspection.outOfRange).toBe(true);
    lost();
    await Promise.resolve();
    await Promise.resolve();
    expect(application.snapshot().inspections["ns=2;s=level"]?.stale).toBe(true);
  });

  it("recomputes range state from subscription updates and clears session state on reconnect", async () => {
    let handler: ((value: OpcUaDataValue) => void) | undefined;
    const opcua = client();
    opcua.connect = async () => ({ ...await client().connect({ endpointUrl: "opc.tcp://plc:4840" }), subscribe: async (_request, next) => { handler = next; return { unsubscribe: async () => undefined }; } });
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://first:4840" });
    await application.addToWatchlist("ns=2;s=old");
    const inspection = await application.inspectVariable("ns=2;s=level", { nodeId: "ns=2;s=level", range: { high: 10 } });
    expect(inspection.outOfRange).toBe(false);
    await application.subscribe("ns=2;s=level");
    handler?.({ status: { name: "Good", value: 0 }, value: { dataType: "Double", arrayType: "Scalar", value: 20 }, sourceTimestamp: "2026-01-01T00:00:01.000Z" });
    expect(application.snapshot().inspections["ns=2;s=level"]?.outOfRange).toBe(true);
    await application.disconnect();
    await application.connect({ endpointUrl: "opc.tcp://second:4840" });
    expect(application.snapshot().watchlist).toEqual([]);
    expect(application.snapshot().inspections).toEqual({});
    expect(application.snapshot().search.requests).toBe(0);
    expect(application.snapshot().connection.connectionGeneration).toBe(2);
  });
});
