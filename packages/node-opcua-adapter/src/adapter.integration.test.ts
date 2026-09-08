import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DataType,
  OPCUACertificateManager,
  OPCUAServer,
  StatusCodes,
  Variant,
} from "node-opcua";
import type { UAMethod, UAVariable } from "node-opcua-address-space";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpcUaClient, OpcUaSubscription } from "@ostudio/application";
import { createNodeOpcuaAdapter } from "./index";

let server: OPCUAServer;
let certificateManager: OPCUACertificateManager;
let temporaryDirectory: string;
let endpointUrl: string;
let writableVariable: UAVariable;
let method: UAMethod;
let delayedMethod: UAMethod;
let delayedInvocations = 0;
let delayedCompletions = 0;
let adapter: OpcUaClient;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ostudio-adapter-"));
  certificateManager = new OPCUACertificateManager({
    rootFolder: path.join(temporaryDirectory, "pki"),
    automaticallyAcceptUnknownCertificate: true,
    disableFileWatchers: true,
  });
  await certificateManager.initialize();
  server = new OPCUAServer({
    port: 0,
    host: "127.0.0.1",
    hostname: "127.0.0.1",
    serverCertificateManager: certificateManager,
  });
  await server.initialize();
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
  endpointUrl = server.getEndpointUrl();
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
  await server?.shutdown().catch(() => undefined);
  await certificateManager?.dispose().catch(() => undefined);
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("production node-opcua adapter", () => {
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
