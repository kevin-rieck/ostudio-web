import {
  DataType,
  StatusCodes,
  Variant,
  VariantArrayType,
} from "node-opcua";
import type { UAMethod, UAVariable } from "node-opcua-address-space";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpcUaClient, OpcUaSubscription } from "@ostudio/application";
import { createNodeOpcuaAdapter } from "./index";
import { createOpcUaTestServer, disposeOpcUaTestServer } from "./test-fixture";

let server: Awaited<ReturnType<typeof createOpcUaTestServer>>["server"];
let endpointUrl: string;
let writableVariable: UAVariable;
let scalarVariables: Array<{ variable: UAVariable; dataType: DataType; initial: unknown; updated: unknown }>;
let method: UAMethod;
let delayedMethod: UAMethod;
let delayedInvocations = 0;
let delayedCompletions = 0;
let adapter: OpcUaClient;

let fixture: Awaited<ReturnType<typeof createOpcUaTestServer>>;

beforeAll(async () => {
  fixture = await createOpcUaTestServer();
  server = fixture.server;
  const addressSpace = server.engine.addressSpace!;
  const namespace = addressSpace.getOwnNamespace();
  const folder = namespace.addObject({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: "AdapterFixture",
    nodeId: "ns=1;s=AdapterFixture",
  });
  let value = 1;
  writableVariable = namespace.addVariable({
    componentOf: folder,
    browseName: "Value",
    nodeId: "ns=1;s=AdapterFixture.Value",
    dataType: DataType.Int32,
    value: {
      get: () => new Variant({ dataType: DataType.Int32, value }),
      set: (next: Variant) => {
        value = next.value as number;
        return StatusCodes.Good;
      },
    },
  });
  namespace.addVariable({
    componentOf: folder,
    browseName: "Other",
    nodeId: "ns=1;s=AdapterFixture.Other",
    dataType: DataType.Int32,
    value: new Variant({ dataType: DataType.Int32, value: 2 }),
  });
  const scalarFolder = namespace.addObject({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: "AdapterScalars",
    nodeId: "ns=1;s=AdapterScalars",
  });
  const scalarCases = [
    ["Boolean", DataType.Boolean, false, true],
    ["SByte", DataType.SByte, -128, 127],
    ["Byte", DataType.Byte, 0, 255],
    ["Int16", DataType.Int16, -32_768, 32_767],
    ["UInt16", DataType.UInt16, 0, 65_535],
    ["Int32", DataType.Int32, -2_147_483_648, 2_147_483_647],
    ["UInt32", DataType.UInt32, 0, 4_294_967_295],
    ["Int64", DataType.Int64, "-9223372036854775808", "9223372036854775807"],
    ["UInt64", DataType.UInt64, "0", "18446744073709551615"],
    ["Float", DataType.Float, -1.25, 1.25],
    ["Double", DataType.Double, -9.5, 9.5],
    ["String", DataType.String, "before", "after"],
    ["DateTime", DataType.DateTime, new Date("2026-01-02T03:04:05.000Z"), new Date("2027-02-03T04:05:06.000Z")],
    ["Guid", DataType.Guid, "01234567-89AB-CDEF-0123-456789ABCDEF", "FEDCBA98-7654-3210-FEDC-BA9876543210"],
    ["ByteString", DataType.ByteString, Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])],
    ["XmlElement", DataType.XmlElement, "<before />", "<after />"],
  ] as const;
  scalarVariables = scalarCases.map(([name, dataType, initial, updated]) => {
    let value: unknown = initial;
    const variable = namespace.addVariable({
      componentOf: scalarFolder,
      browseName: name,
      nodeId: `ns=1;s=AdapterScalars.${name}`,
      dataType,
      value: {
        get: () => new Variant({ dataType, arrayType: VariantArrayType.Scalar, value } as never),
        set: (next: Variant) => {
          value = next.value;
          return StatusCodes.Good;
        },
      },
    });
    return { variable, dataType, initial, updated };
  });
  method = namespace.addMethod(folder, {
    browseName: "Add",
    nodeId: "ns=1;s=AdapterFixture.Add",
    inputArguments: [
      { name: "left", dataType: DataType.Int32, valueRank: -1 },
      { name: "right", dataType: DataType.Int32, valueRank: -1 },
    ],
    outputArguments: [{ name: "sum", dataType: DataType.Int32, valueRank: -1 }],
  });
  method.bindMethod((inputArguments, _context, callback) => {
    callback(null, {
      statusCode: StatusCodes.Good,
      outputArguments: [new Variant({ dataType: DataType.Int32, value: Number(inputArguments[0]?.value) + Number(inputArguments[1]?.value) })],
    });
  });
  delayedMethod = namespace.addMethod(folder, {
    browseName: "Delayed",
    nodeId: "ns=1;s=AdapterFixture.Delayed",
    inputArguments: [],
    outputArguments: [{ name: "result", dataType: DataType.Int32, valueRank: -1 }],
  });
  delayedMethod.bindMethod((_inputArguments, _context, callback) => {
    delayedInvocations += 1;
    setTimeout(() => {
      delayedCompletions += 1;
      callback(null, {
        statusCode: StatusCodes.Good,
        outputArguments: [new Variant({ dataType: DataType.Int32, value: 99 })],
      });
    }, 250);
  });
  await server.start();
  endpointUrl = fixture.endpointUrl;
  adapter = createNodeOpcuaAdapter({
    applicationName: "OPC UA Studio adapter test",
    applicationUri: "urn:ostudio:adapter-test",
    maxReferencesPerNode: 1,
    maxBrowseRequests: 2,
    methodCallTimeout: 50,
  });
});

afterAll(async () => {
  await adapter?.disconnect().catch(() => undefined);
  if (fixture) await disposeOpcUaTestServer(fixture);
});

describe("production node-opcua adapter", () => {
  it("rejects an unbounded per-response browse reference override", () => {
    expect(() => createNodeOpcuaAdapter({
      applicationName: "OPC UA Studio adapter test",
      applicationUri: "urn:ostudio:adapter-test",
      maxReferencesPerNode: 0,
    })).toThrow();
  });

  it("discovers, connects, browses with a bound, reads, writes, inspects, calls, and disconnects", async () => {
    const discovery = await adapter.discover({ endpointUrl });
    expect(discovery.endpoints.some((endpoint) => endpoint.endpointUrl === endpointUrl && endpoint.securityMode === "None")).toBe(true);

    const session = await adapter.connect({ endpointUrl, securityMode: "None" });
    try {
      const browse = await session.browse({ nodeId: "ns=1;s=AdapterFixture", maxRequests: 2, maxReferencesPerNode: 1 });
      expect(browse.references.map((reference) => reference.nodeId)).toEqual(
        expect.arrayContaining([writableVariable.nodeId.toString()]),
      );
      expect(browse.requests).toBe(2);
      expect(browse.truncated).toBe(true);
      const completeBrowse = await session.browse({ nodeId: "ns=1;s=AdapterFixture", maxRequests: 10, maxReferencesPerNode: 1 });
      expect(completeBrowse.references.map((reference) => reference.nodeId)).toContain(method.nodeId.toString());

      const initial = await session.read({ nodeId: writableVariable.nodeId.toString() });
      expect(initial.dataValue.value?.value).toBe(1);

      let resolveSubscriptionValue!: (value: number) => void;
      const subscriptionValue = new Promise<number>((resolve) => {
        resolveSubscriptionValue = resolve;
      });
      const subscription: OpcUaSubscription = await session.subscribe(
        { nodeId: writableVariable.nodeId.toString() },
        (dataValue) => {
          if (dataValue.value?.value === 7) resolveSubscriptionValue(7);
        },
      );
      const write = await session.write({
      nodeId: writableVariable.nodeId.toString(),
      value: { dataType: "Int32", arrayType: "Scalar", value: 7 },
    });
      expect(write.outcome).toBe("succeeded");
      await expect(subscriptionValue).resolves.toBe(7);
      await subscription!.unsubscribe();

      const definition = await session.inspectMethod(method.nodeId.toString());
    expect(definition.inputArguments.map((argument) => argument.name)).toEqual(["left", "right"]);
    const call = await session.call({
      objectId: "ns=1;s=AdapterFixture",
      methodId: method.nodeId.toString(),
      inputArguments: [
        { dataType: "Int32", arrayType: "Scalar", value: 2 },
        { dataType: "Int32", arrayType: "Scalar", value: 3 },
      ],
      expectedDefinition: definition,
    });
      expect(call.outcome).toBe("succeeded");
      expect(call.outputArguments?.[0]?.value).toBe(5);
    } finally {
      await session.close();
      await adapter.disconnect();
    }
  });

  it("reads and writes supported scalar values, including exact 64-bit boundaries", async () => {
    const session = await adapter.connect({ endpointUrl, securityMode: "None" });
    try {
      for (const { variable, dataType, initial, updated } of scalarVariables) {
        const nodeId = variable.nodeId.toString();
        const transport = (value: unknown) => dataType === DataType.DateTime && value instanceof Date
          ? value.toISOString()
          : dataType === DataType.ByteString && Buffer.isBuffer(value)
            ? value.toString("base64")
            : value;
        await expect(session.read({ nodeId })).resolves.toMatchObject({ dataValue: { value: { value: transport(initial) } } });
        await expect(session.write({
          nodeId,
          value: { dataType: DataType[dataType] as never, arrayType: "Scalar", value: transport(updated) as never },
        })).resolves.toMatchObject({ outcome: "succeeded" });
        await expect(session.read({ nodeId })).resolves.toMatchObject({ dataValue: { value: { value: transport(updated) } } });
      }
    } finally {
      await session.close();
      await adapter.disconnect();
    }
  });

  it("serializes Method inspection with bounded browse continuation", async () => {
    const session = await adapter.connect({ endpointUrl, securityMode: "None" });
    try {
      const browsing = session.browse({
        nodeId: "ns=1;s=AdapterFixture",
        maxRequests: 10,
        maxReferencesPerNode: 1,
      });
      await Promise.resolve();
      const inspecting = session.inspectMethod(method.nodeId.toString());
      const [, definition] = await Promise.all([browsing, inspecting]);

      expect(definition.inputArguments.map((argument) => argument.name)).toEqual(["left", "right"]);
      expect(definition.outputArguments.map((argument) => argument.name)).toEqual(["sum"]);
    } finally {
      await session.close();
      await adapter.disconnect();
    }
  });

  it("selects a secure endpoint only with its exact pinned certificate fingerprint", async () => {
    const discovery = await adapter.discover({ endpointUrl });
    const secureEndpoint = discovery.endpoints.find(
      (candidate) => candidate.securityMode === "SignAndEncrypt" && candidate.securityPolicyUri.endsWith("Basic256Sha256"),
    );
    expect(secureEndpoint?.serverCertificateFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const session = await adapter.connect({
      endpointUrl,
      securityMode: "SignAndEncrypt",
      securityPolicyUri: secureEndpoint!.securityPolicyUri,
      serverCertificateFingerprint: secureEndpoint!.serverCertificateFingerprint,
    });
    await session.close();
    await adapter.disconnect();
  });

  it("classifies a method deadline as unknown when the server may complete later", async () => {
    const session = await adapter.connect({ endpointUrl, securityMode: "None" });
    try {
      const beforeInvocations = delayedInvocations;
      const beforeCompletions = delayedCompletions;
      const result = await session.call({
        objectId: "ns=1;s=AdapterFixture",
        methodId: delayedMethod.nodeId.toString(),
        inputArguments: [],
      });
      expect(result.outcome).toBe("unknown");
      expect(result.error?.code).toBe("timeout");
      expect(delayedInvocations).toBe(beforeInvocations + 1);
      expect(delayedCompletions).toBe(beforeCompletions);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(delayedCompletions).toBe(beforeCompletions + 1);
    } finally {
      await session.close();
      await adapter.disconnect();
    }
  });

  it("reports connection loss without reconnecting", async () => {
    const lost = new Promise<{ code: string }>((resolve) => {
      adapter.onConnectionLost(resolve);
    });
    await adapter.connect({ endpointUrl, securityMode: "None" });
    await server.shutdown();
    await expect(lost).resolves.toEqual({ code: "connection_lost", message: "The OPC UA connection was lost." });
    await adapter.disconnect();
  });
});
