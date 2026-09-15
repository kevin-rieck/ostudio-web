import { describe, expect, it } from "vitest";
import diagnosticFixture from "../../../testdata/conformance/diagnostic-redaction.json";
import searchFixture from "../../../testdata/conformance/search-ordering.json";
import reversedSearchFixture from "../../../testdata/conformance/search-reversed-discovery.json";
import savedConnectionFixture from "../../../testdata/conformance/saved-connection-secret-stripping.json";
import {
  createApplication,
  type ApplicationEvent,
  type OpcUaClient,
  type OpcUaDataValue,
  type OpcUaReadRequest,
  type OpcUaSession,
  type SavedConnectionStore,
} from "./index.js";

const store: SavedConnectionStore = {
  list: async () => [],
  save: async () => undefined,
};

function client(): OpcUaClient {
  return {
    discover: async () => ({ servers: [], endpoints: [] }),
    connect: async () =>
      ({
        browse: async () => ({
          nodeId: "i=84",
          references: [],
          status: { name: "Good", value: 0 },
          requests: 1,
          truncated: false,
        }),
        read: async (request) =>
          Array.isArray(request)
            ? request.map((item) => ({
                ...item,
                attributeId: item.attributeId ?? 13,
                dataValue: { status: { name: "Good", value: 0 } },
              }))
            : { ...request, attributeId: request.attributeId ?? 13, dataValue: { status: { name: "Good", value: 0 } } },
        subscribe: async () => ({ unsubscribe: async () => undefined }),
        write: async () => ({ outcome: "succeeded" }),
        inspectMethod: async () => ({ inputArguments: [], outputArguments: [] }),
        call: async () => ({ outcome: "succeeded" }),
        close: async () => undefined,
      }) as OpcUaSession,
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
    expect(events.map((event) => event.type)).toEqual([
      "connection-changed",
      "search-changed",
      "connection-changed",
      "safety-changed",
    ]);
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

  it("merges reversed Address Space discovery without losing explicit membership or shortest distance", async () => {
    const run = async (arrivals: typeof reversedSearchFixture.arrivals) => {
      const application = createApplication({
        clientFactory: client,
        savedConnections: store,
        clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
        events: { publish: () => undefined },
      });
      for (const arrival of arrivals) await application.search(reversedSearchFixture.query, [arrival]);
      return application.search(reversedSearchFixture.query);
    };

    for (const result of [
      await run(reversedSearchFixture.arrivals),
      await run(reversedSearchFixture.reversedArrivals),
    ]) {
      expect(result.results).toMatchObject([
        {
          nodeId: "ns=2;s=shared",
          displayName: "pressure sensor",
          browseName: "pressure",
          explicitBrowse: true,
          distance: 2,
        },
      ]);
    }
  });

  it("assigns a relative distance to explicitly browsed Address Space results", async () => {
    let browseCalls = 0;
    const opcua = client();
    opcua.connect = async () => ({
      ...(await client().connect({ endpointUrl: "opc.tcp://plc:4840" })),
      browse: async (request) => {
        browseCalls += 1;
        return {
          nodeId: request.nodeId,
          references:
            browseCalls === 2
              ? [
                  {
                    nodeId: "ns=2;s=explicit",
                    browseName: { namespaceIndex: 2, name: "pressure" },
                    displayName: { text: "pressure" },
                    nodeClass: "Variable",
                    isForward: true,
                  },
                ]
              : [],
          status: { name: "Good", value: 0 },
          requests: 1,
          truncated: false,
        };
      },
    });
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:01.000Z") },
      config: { shallowBrowseRequestBudget: 1 },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://plc:4840" });
    await application.search("missing");
    await application.browse({ nodeId: "i=85" });
    const result = await application.search("pressure");
    expect(result.results).toMatchObject([{ nodeId: "ns=2;s=explicit", explicitBrowse: true, distance: 1 }]);
  });

  it("orders display exact matches separately and uses safe connection references", async () => {
    const saved: unknown[] = [];
    const application = createApplication({
      clientFactory: client,
      savedConnections: {
        list: async () => [],
        save: async (value) => {
          saved.push(value);
        },
      },
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

  it("redacts endpoint userinfo from connection state and Saved Connections", async () => {
    const events: ApplicationEvent[] = [];
    const saved: unknown[] = [];
    let adapterRequest: string | undefined;
    const opcua = client();
    opcua.connect = async (request) => {
      adapterRequest = request.endpointUrl;
      return client().connect(request);
    };
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: {
        list: async () => [
          {
            id: "stored",
            name: "Stored",
            endpoint: "opc.tcp://stored:stored-secret@plc.example:4840/path",
            securityPolicy: "None",
            securityMode: "None",
          },
        ],
        save: async (connection) => {
          saved.push(connection);
        },
      },
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: (event) => events.push(event) },
    });

    const originalEndpoint = "opc.tcp://adapter:connect-secret@plc.example:4840/path";
    await application.connect({ endpointUrl: originalEndpoint });
    await application.saveSavedConnection({
      id: "saved",
      name: "Saved",
      endpoint: "opc.tcp://persist:save-secret@plc.example:4840/path",
      securityPolicy: "None",
      securityMode: "None",
    });
    const listed = await application.listSavedConnections();

    expect(adapterRequest).toBe(originalEndpoint);
    expect(application.snapshot().connection.endpointUrl).toBe("opc.tcp://plc.example:4840/path");
    expect(listed[0]?.endpoint).toBe("opc.tcp://plc.example:4840/path");
    expect(saved[0]).toMatchObject({ endpoint: "opc.tcp://plc.example:4840/path" });
    expect(JSON.stringify({ snapshot: application.snapshot(), events, listed, saved })).not.toMatch(
      /connect-secret|stored-secret|save-secret/,
    );
  });

  it("drops shallow-browse results from an old connection and resets its queue", async () => {
    let releaseOldBrowse!: () => void;
    const oldBrowse = new Promise<void>((resolve) => {
      releaseOldBrowse = resolve;
    });
    let connections = 0;
    const browsed: string[] = [];
    const opcua = client();
    opcua.connect = async (request) => {
      const session = await client().connect(request);
      connections += 1;
      return {
        ...session,
        browse: async (browseRequest) => {
          browsed.push(browseRequest.nodeId);
          if (connections === 1) await oldBrowse;
          return {
            nodeId: browseRequest.nodeId,
            references: [],
            status: { name: "Good", value: 0 },
            requests: 1,
            truncated: false,
          };
        },
      };
    };
    let now = 0;
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date(now) },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://old:4840" });
    const pendingSearch = application.search("missing");
    await Promise.resolve();
    await application.disconnect();
    await application.connect({ endpointUrl: "opc.tcp://new:4840" });
    releaseOldBrowse();
    await pendingSearch;
    expect(application.snapshot().search.requests).toBe(0);
    now = 1_000;
    await application.search("missing-again");
    expect(browsed).toEqual(["i=85", "i=85"]);
  });

  it("continues rate-limited shallow browsing when a matching result already exists", async () => {
    let now = 0;
    const browsed: string[] = [];
    const opcua = client();
    opcua.connect = async () => ({
      ...(await client().connect({ endpointUrl: "opc.tcp://plc:4840" })),
      browse: async (request) => {
        browsed.push(request.nodeId);
        return {
          nodeId: request.nodeId,
          references:
            request.nodeId === "i=85"
              ? [
                  {
                    nodeId: "ns=2;s=child",
                    browseName: { namespaceIndex: 2, name: "pressure" },
                    displayName: { text: "pressure" },
                    nodeClass: "Object",
                    isForward: true,
                  },
                ]
              : [],
          status: { name: "Good", value: 0 },
          requests: 1,
          truncated: false,
        };
      },
    });
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date(now) },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://plc:4840" });
    const first = await application.search("pressure");
    expect(first.results.map((result) => result.nodeId)).toEqual(["ns=2;s=child"]);
    expect(first.coverage).toBe("incomplete");
    now = 1_000;
    const second = await application.search("pressure");
    expect(second.coverage).toBe("incomplete");
    expect(browsed).toEqual(["i=85", "ns=2;s=child"]);
  });

  it("preserves shallow-browse traversal distance in deterministic search ordering", async () => {
    let now = 0;
    const opcua = client();
    opcua.connect = async () => ({
      ...(await client().connect({ endpointUrl: "opc.tcp://plc:4840" })),
      browse: async (request) => ({
        nodeId: request.nodeId,
        references:
          request.nodeId === "i=85"
            ? [
                {
                  nodeId: "ns=2;s=near",
                  browseName: { namespaceIndex: 2, name: "pressure" },
                  displayName: { text: "near" },
                  nodeClass: "Object",
                  isForward: true,
                },
              ]
            : request.nodeId === "ns=2;s=near"
              ? [
                  {
                    nodeId: "ns=2;s=far",
                    browseName: { namespaceIndex: 2, name: "pressure" },
                    displayName: { text: "far" },
                    nodeClass: "Object",
                    isForward: true,
                  },
                ]
              : [],
        status: { name: "Good", value: 0 },
        requests: 1,
        truncated: false,
      }),
    });
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date(now) },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://plc:4840" });
    await application.search("pressure");
    now = 1_000;
    await application.search("pressure");
    now = 2_000;
    const result = await application.search("pressure");
    expect(result.results.map(({ nodeId, distance }) => [nodeId, distance])).toEqual([
      ["ns=2;s=near", 1],
      ["ns=2;s=far", 2],
    ]);
  });

  it("exposes no direct mutation facade and counts shallow browsing one request at a time", async () => {
    let browseCalls = 0;
    let browseMaxRequests: number | undefined;
    const opcua = client();
    const browseNodeIds: string[] = [];
    opcua.connect = async () => ({
      ...(await client().connect({ endpointUrl: "opc.tcp://plc:4840" })),
      browse: async (request) => {
        browseCalls += 1;
        browseNodeIds.push(request.nodeId);
        browseMaxRequests = request.maxRequests;
        return {
          nodeId: request.nodeId,
          references:
            request.nodeId === "i=85"
              ? [
                  {
                    nodeId: "ns=2;s=child",
                    browseName: { namespaceIndex: 2, name: "child" },
                    displayName: { text: "child" },
                    nodeClass: "Object",
                    isForward: true,
                  },
                ]
              : [],
          status: { name: "Good", value: 0 },
          requests: 1,
          truncated: false,
        };
      },
    });
    let now = 0;
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date(now) },
      timers: {
        setTimeout: (callback) => {
          callback();
          return 1;
        },
        clearTimeout: () => undefined,
      },
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
    expect(browseNodeIds).toEqual(["i=85", "ns=2;s=child"]);
  });

  it("records only bounded, redacted diagnostics for connection failures", async () => {
    const messages: Array<{ message: string; details?: Record<string, unknown> }> = [];
    const application = createApplication({
      clientFactory: () => ({
        ...client(),
        connect: async () => {
          throw new Error("password=must-not-survive C:\\certs\\client.key");
        },
      }),
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      logger: {
        info: (message, details) => messages.push({ message, details }),
        error: (message, details) => messages.push({ message, details }),
      },
      events: { publish: () => undefined },
    });
    await expect(application.connect({ endpointUrl: "opc.tcp://admin:secret@plc.example:4840" })).rejects.toThrow();
    const diagnostic = application.snapshot().diagnostics[0];
    expect(diagnostic).toMatchObject({
      endpoint: diagnosticFixture.safeRecord.endpoint,
      outcome: diagnosticFixture.safeRecord.outcome,
    });
    for (const field of diagnosticFixture.removedFields) expect(diagnostic).not.toHaveProperty(field);
    expect(JSON.stringify(application.snapshot().diagnostics)).not.toMatch(/must-not-survive|client\\.key|secret/);
    expect(JSON.stringify(messages)).not.toMatch(/must-not-survive|client\\.key|secret/);
  });

  it("bounds concurrent safe reads", async () => {
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opcua = client();
    const connect = opcua.connect;
    opcua.connect = async (request) => {
      const session = await connect(request);
      const read: OpcUaSession["read"] = (async (request: OpcUaReadRequest | OpcUaReadRequest[]) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate;
        active -= 1;
        if (Array.isArray(request))
          return request.map((item) => ({
            ...item,
            attributeId: item.attributeId ?? 13,
            dataValue: { status: { name: "Good", value: 0 } },
          }));
        return {
          ...request,
          attributeId: request.attributeId ?? 13,
          dataValue: { status: { name: "Good", value: 0 } },
        };
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
    const pending = Promise.all(
      Array.from({ length: 5 }, (_, index) => application.inspectVariable(`ns=2;s=level-${index}`)),
    );
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
    opcua.onConnectionLost = (listener) => {
      lost = () => listener({ code: "connection_lost", message: "lost" });
      return () => undefined;
    };
    const connect = opcua.connect;
    opcua.connect = async (request) => {
      const session = await connect(request);
      const value: OpcUaDataValue = {
        status: { name: "Good", value: 0 },
        value: { dataType: "Double", arrayType: "Scalar", value: 12 },
      };
      return {
        ...session,
        read: (async (request: OpcUaReadRequest | OpcUaReadRequest[]) =>
          Array.isArray(request)
            ? request.map((item) => ({ ...item, attributeId: item.attributeId ?? 13, dataValue: value }))
            : { ...request, attributeId: request.attributeId ?? 13, dataValue: value }) as OpcUaSession["read"],
      };
    };
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://plc:4840" });
    const inspection = await application.inspectVariable("ns=2;s=level", {
      nodeId: "ns=2;s=level",
      range: { high: 10 },
    });
    expect(inspection.outOfRange).toBe(true);
    lost();
    for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
    expect(application.snapshot().inspections["ns=2;s=level"]?.stale).toBe(true);
  });

  it("invalidates immediately when connection loss interrupts a hanging browse", async () => {
    let lost = (): void => undefined;
    let releaseBrowse!: () => void;
    let browseStarted!: () => void;
    const browseEntered = new Promise<void>((resolve) => {
      browseStarted = resolve;
    });
    const hangingBrowse = new Promise<void>((resolve) => {
      releaseBrowse = resolve;
    });
    const opcua = client();
    opcua.onConnectionLost = (listener) => {
      lost = () => listener({ code: "connection_lost", message: "lost" });
      return () => undefined;
    };
    opcua.connect = async () => ({
      ...(await client().connect({ endpointUrl: "opc.tcp://plc:4840" })),
      browse: async (request) => {
        browseStarted();
        await hangingBrowse;
        return {
          nodeId: request.nodeId,
          references: [],
          status: { name: "Good", value: 0 },
          requests: 1,
          truncated: false,
        };
      },
    });
    const events: ApplicationEvent[] = [];
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: (event) => events.push(event) },
    });
    await application.connect({ endpointUrl: "opc.tcp://plc:4840" });
    await application.setReadOnly(false, true);
    await application.inspectVariable("ns=2;s=level");
    const pendingBrowse = application.browse({ nodeId: "i=85" });
    await browseEntered;

    const lossEventStart = events.length;
    lost();

    const lossEvents = events.slice(lossEventStart);
    expect(lossEvents[0]).toMatchObject({
      type: "connection-changed",
      snapshot: {
        connection: { state: "connection-lost" },
        safety: { readOnly: true, safetyGeneration: 4 },
        inspections: { "ns=2;s=level": { stale: true } },
      },
    });
    expect(lossEvents.map((event) => event.type)).toEqual([
      "connection-changed",
      "safety-changed",
      "diagnostic-changed",
    ]);
    expect(application.snapshot()).toMatchObject({
      connection: { state: "connection-lost" },
      safety: { readOnly: true },
    });
    releaseBrowse();
    await pendingBrowse;
  });

  it("restores Read-Only Mode before connection-loss cleanup finishes", async () => {
    let lost = (): void => undefined;
    let releaseCleanup!: () => void;
    let cleanupStarted = false;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const opcua = client();
    opcua.onConnectionLost = (listener) => {
      lost = () => listener({ code: "connection_lost", message: "lost" });
      return () => undefined;
    };
    opcua.connect = async () => ({
      ...(await client().connect({ endpointUrl: "opc.tcp://plc:4840" })),
      subscribe: async () => ({
        unsubscribe: async () => {
          cleanupStarted = true;
          await cleanup;
        },
      }),
    });
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://plc:4840" });
    await application.subscribe("ns=2;s=level");
    await application.setReadOnly(false, true);
    lost();
    for (let attempt = 0; attempt < 10 && !cleanupStarted; attempt += 1) await Promise.resolve();
    expect(cleanupStarted).toBe(true);
    expect(application.snapshot()).toMatchObject({
      connection: { state: "connection-lost" },
      safety: { readOnly: true },
    });
    await expect(application.read({ nodeId: "ns=2;s=level" })).rejects.toMatchObject({ code: "connection_required" });
    releaseCleanup();
  });

  it("restores Read-Only Mode when disconnect cleanup rejects", async () => {
    const opcua = client();
    opcua.disconnect = async () => {
      throw new Error("disconnect failed");
    };
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://plc:4840" });
    await application.setReadOnly(false, true);

    await expect(application.disconnect()).rejects.toThrow("disconnect failed");
    expect(application.snapshot()).toMatchObject({
      connection: { state: "disconnected" },
      safety: { readOnly: true },
    });
  });

  it("restores Read-Only Mode when close cleanup rejects", async () => {
    const opcua = client();
    opcua.disconnect = async () => {
      throw new Error("close failed");
    };
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://plc:4840" });
    await application.setReadOnly(false, true);

    await expect(application.close()).rejects.toThrow("close failed");
    expect(application.snapshot()).toMatchObject({
      connection: { state: "disconnected" },
      safety: { readOnly: true },
    });
  });

  it("does not run a queued Safe Read against a reconnected session", async () => {
    let releaseOldRead!: () => void;
    const oldRead = new Promise<void>((resolve) => {
      releaseOldRead = resolve;
    });
    let connections = 0;
    let newReadCalls = 0;
    const opcua = client();
    opcua.connect = async (request) => {
      const session = await client().connect(request);
      connections += 1;
      if (connections === 1) {
        return {
          ...session,
          read: (async (readRequest: OpcUaReadRequest | OpcUaReadRequest[]) => {
            await oldRead;
            const result = { status: { name: "Good", value: 0 } };
            return Array.isArray(readRequest)
              ? readRequest.map((item) => ({ ...item, attributeId: item.attributeId ?? 13, dataValue: result }))
              : { ...readRequest, attributeId: readRequest.attributeId ?? 13, dataValue: result };
          }) as OpcUaSession["read"],
        };
      }
      return {
        ...session,
        read: (async (readRequest: OpcUaReadRequest | OpcUaReadRequest[]) => {
          newReadCalls += 1;
          const result = { status: { name: "Good", value: 0 } };
          return Array.isArray(readRequest)
            ? readRequest.map((item) => ({ ...item, attributeId: item.attributeId ?? 13, dataValue: result }))
            : { ...readRequest, attributeId: readRequest.attributeId ?? 13, dataValue: result };
        }) as OpcUaSession["read"],
      };
    };
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      config: { maxSafeReadConcurrency: 1 },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://old:4840" });
    const pendingInspection = application.inspectVariable("ns=2;s=old");
    await Promise.resolve();
    const pendingRead = application.read({ nodeId: "ns=2;s=queued" });
    const pendingReadAfterReconnect = application.read({ nodeId: "ns=2;s=queued-again" });
    await application.disconnect();
    await application.connect({ endpointUrl: "opc.tcp://new:4840" });
    releaseOldRead();
    await pendingInspection;
    await expect(pendingRead).rejects.toMatchObject({ code: "connection_required" });
    let bothSettled = false;
    void Promise.allSettled([pendingReadAfterReconnect]).then(() => {
      bothSettled = true;
    });
    for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
    expect(bothSettled).toBe(true);
    expect(newReadCalls).toBe(0);
  });

  it("discards a Variable Node Inspection that completes after reconnect", async () => {
    let releaseOldRead!: () => void;
    const oldRead = new Promise<void>((resolve) => {
      releaseOldRead = resolve;
    });
    let connections = 0;
    const opcua = client();
    opcua.connect = async (request) => {
      const session = await client().connect(request);
      connections += 1;
      if (connections !== 1) return session;
      return {
        ...session,
        read: (async (readRequest: OpcUaReadRequest | OpcUaReadRequest[]) => {
          await oldRead;
          const value = {
            status: { name: "Good", value: 0 },
            value: { dataType: "Double" as const, arrayType: "Scalar" as const, value: 12 },
          };
          return Array.isArray(readRequest)
            ? readRequest.map((item) => ({ ...item, attributeId: item.attributeId ?? 13, dataValue: value }))
            : { ...readRequest, attributeId: readRequest.attributeId ?? 13, dataValue: value };
        }) as OpcUaSession["read"],
      };
    };
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://old:4840" });
    const pendingInspection = application.inspectVariable("ns=2;s=old");
    await Promise.resolve();
    await application.disconnect();
    await application.connect({ endpointUrl: "opc.tcp://new:4840" });
    releaseOldRead();
    await pendingInspection;
    expect(application.snapshot().inspections).toEqual({});
  });

  it("tears down a subscription that finishes establishing after reconnect", async () => {
    let releaseSubscribe!: () => void;
    const pendingSubscribe = new Promise<void>((resolve) => {
      releaseSubscribe = resolve;
    });
    let oldHandler: ((value: OpcUaDataValue) => void) | undefined;
    let unsubscribeCalls = 0;
    let connections = 0;
    const opcua = client();
    opcua.connect = async (request) => {
      const session = await client().connect(request);
      connections += 1;
      if (connections !== 1) return session;
      return {
        ...session,
        subscribe: async (_request, handler) => {
          oldHandler = handler;
          await pendingSubscribe;
          return {
            unsubscribe: async () => {
              unsubscribeCalls += 1;
            },
          };
        },
      };
    };
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://old:4840" });
    const pending = application.subscribe("ns=2;s=old");
    await Promise.resolve();
    await application.disconnect();
    await application.connect({ endpointUrl: "opc.tcp://new:4840" });
    releaseSubscribe();
    await pending;
    oldHandler?.({ status: { name: "Good", value: 0 }, value: { dataType: "Double", arrayType: "Scalar", value: 10 } });
    expect(unsubscribeCalls).toBe(1);
    expect(application.getTrend("ns=2;s=old")).toEqual([]);
  });

  it("recomputes range state from subscription updates and clears session state on reconnect", async () => {
    let handler: ((value: OpcUaDataValue) => void) | undefined;
    const opcua = client();
    opcua.connect = async () => ({
      ...(await client().connect({ endpointUrl: "opc.tcp://plc:4840" })),
      subscribe: async (_request, next) => {
        handler = next;
        return { unsubscribe: async () => undefined };
      },
    });
    const application = createApplication({
      clientFactory: () => opcua,
      savedConnections: store,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      events: { publish: () => undefined },
    });
    await application.connect({ endpointUrl: "opc.tcp://first:4840" });
    await application.addToWatchlist("ns=2;s=old");
    const inspection = await application.inspectVariable("ns=2;s=level", {
      nodeId: "ns=2;s=level",
      range: { high: 10 },
    });
    expect(inspection.outOfRange).toBe(false);
    await application.subscribe("ns=2;s=level");
    handler?.({
      status: { name: "Good", value: 0 },
      value: { dataType: "Double", arrayType: "Scalar", value: 20 },
      sourceTimestamp: "2026-01-01T00:00:01.000Z",
    });
    expect(application.snapshot().inspections["ns=2;s=level"]?.outOfRange).toBe(true);
    await application.disconnect();
    await application.connect({ endpointUrl: "opc.tcp://second:4840" });
    expect(application.snapshot().watchlist).toEqual([]);
    expect(application.snapshot().inspections).toEqual({});
    expect(application.snapshot().search.requests).toBe(0);
    expect(application.snapshot().connection.connectionGeneration).toBe(2);
  });
});
