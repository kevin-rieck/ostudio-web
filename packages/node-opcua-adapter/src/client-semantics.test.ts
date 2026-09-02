import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  AttributeIds,
  ClientSecureChannelLayer,
  DataType,
  Int64ToBigInt,
  MessageSecurityMode,
  OPCUAClient,
  OPCUACertificateManager,
  OPCUAServer,
  SecurityPolicy,
  StatusCodes,
  TimestampsToReturn,
  UInt64ToBigInt,
  Variant,
} from "node-opcua";
import type { ClientMonitoredItem } from "node-opcua-client";
import type { ClientSession } from "node-opcua-client";
import type { ClientSubscription } from "node-opcua-client";
import type { DataValue } from "node-opcua-data-value";
import type { EndpointDescription } from "node-opcua-service-endpoints";
import type { UAObject } from "node-opcua-address-space";
import type { UAMethod } from "node-opcua-address-space";
import type { UAVariable } from "node-opcua-address-space";

const applicationUri = "urn:ostudio:node-opcua-semantics-spike:client";
const delayedMethodDelay = 250;

type TestServer = {
  server: OPCUAServer;
  serverCertificateManager: OPCUACertificateManager;
  clientCertificateManager: OPCUACertificateManager;
  temporaryDirectory: string;
  endpointUrl: string;
  folder: UAObject;
  writableVariable: UAVariable;
  signedVariable: UAVariable;
  unsignedVariable: UAVariable;
  method: UAMethod;
  delayedMethod: UAMethod;
  delayedInvocations: number;
  delayedCompletions: number;
};

let fixture: TestServer;
let cleanup: (() => Promise<void>) | undefined;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(condition: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the in-process OPC UA server");
    }
    await delay(5);
  }
}

function waitForChanged(
  monitoredItem: ClientMonitoredItem,
  predicate: (value: number) => boolean,
): Promise<DataValue> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      monitoredItem.removeListener("changed", onChanged);
      reject(new Error("Timed out waiting for a subscription notification"));
    }, 2_000);

    const onChanged = (dataValue: DataValue) => {
      if (typeof dataValue.value.value === "number" && predicate(dataValue.value.value)) {
        clearTimeout(timer);
        monitoredItem.removeListener("changed", onChanged);
        resolve(dataValue);
      }
    };

    monitoredItem.on("changed", onChanged);
  });
}

function clientOptions(): {
  applicationName: string;
  applicationUri: string;
  certificateFile: string;
  privateKeyFile: string;
  clientCertificateManager: OPCUACertificateManager;
  connectionStrategy: { maxRetry: 0 };
  endpointMustExist: true;
} {
  return {
    applicationName: "OPC UA Studio semantics spike",
    applicationUri,
    certificateFile: path.join(fixture.clientCertificateManager.ownCertFolder, "client_certificate.pem"),
    privateKeyFile: fixture.clientCertificateManager.privateKey,
    clientCertificateManager: fixture.clientCertificateManager,
    connectionStrategy: { maxRetry: 0 },
    endpointMustExist: true,
  };
}

function secureClientOptions(overrides: { defaultTransactionTimeout?: number } = {}) {
  return {
    ...clientOptions(),
    ...overrides,
    securityMode: MessageSecurityMode.SignAndEncrypt,
    securityPolicy: SecurityPolicy.Basic256Sha256,
    serverCertificate: configuredSecureEndpoint().serverCertificate,
  };
}

function findExactEndpoint(
  endpoints: EndpointDescription[],
  endpointUrl: string,
  securityMode: MessageSecurityMode,
  securityPolicyUri: SecurityPolicy,
): EndpointDescription {
  const endpoint = endpoints.find(
    (candidate) =>
      candidate.endpointUrl === endpointUrl &&
      candidate.securityMode === securityMode &&
      candidate.securityPolicyUri === securityPolicyUri,
  );
  if (!endpoint) {
    throw new Error(`No exact endpoint found for ${endpointUrl} (${securityMode}, ${securityPolicyUri})`);
  }
  return endpoint;
}

function configuredSecureEndpoint(): EndpointDescription {
  const endpoint = fixture.server.endpoints[0]?.endpointDescriptions().find(
    (candidate) =>
      candidate.securityMode === MessageSecurityMode.SignAndEncrypt &&
      candidate.securityPolicyUri === SecurityPolicy.Basic256Sha256,
  );
  if (!endpoint) {
    throw new Error("The in-process server did not expose its secure endpoint");
  }
  return endpoint;
}

async function stopClient(client: OPCUAClient): Promise<void> {
  try {
    await client.disconnect();
  } catch {
    // A transport-loss test intentionally leaves the client without a channel.
  }
}

beforeAll(async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ostudio-node-opcua-spike-"));
  const serverCertificateManager = new OPCUACertificateManager({
    rootFolder: path.join(temporaryDirectory, "server-pki"),
    automaticallyAcceptUnknownCertificate: true,
    disableFileWatchers: true,
  });
  const clientCertificateManager = new OPCUACertificateManager({
    rootFolder: path.join(temporaryDirectory, "client-pki"),
    automaticallyAcceptUnknownCertificate: true,
    disableFileWatchers: true,
  });
  const resources: {
    server?: OPCUAServer;
    serverCertificateManager: OPCUACertificateManager;
    clientCertificateManager: OPCUACertificateManager;
    temporaryDirectory: string;
  } = { serverCertificateManager, clientCertificateManager, temporaryDirectory };
  cleanup = async () => {
    await resources.server?.shutdown().catch(() => undefined);
    await resources.serverCertificateManager.dispose().catch(() => undefined);
    await resources.clientCertificateManager.dispose().catch(() => undefined);
    await rm(resources.temporaryDirectory, { recursive: true, force: true });
  };
  await clientCertificateManager.initialize();
  await clientCertificateManager.createSelfSignedCertificate({
    applicationUri,
    subject: "CN=OPC UA Studio Semantics Spike Client",
    dns: ["localhost", "127.0.0.1"],
    startDate: new Date(Date.now() - 60_000),
    validity: 365,
    outputFile: path.join(clientCertificateManager.ownCertFolder, "client_certificate.pem"),
  });

  const server = new OPCUAServer({
    port: 0,
    host: "127.0.0.1",
    hostname: "127.0.0.1",
    securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
    securityModes: [MessageSecurityMode.None, MessageSecurityMode.SignAndEncrypt],
    serverCertificateManager,
  });
  resources.server = server;
  await server.initialize();

  const addressSpace = server.engine.addressSpace;
  if (!addressSpace) {
    throw new Error("The in-process server did not initialize an address space");
  }
  const namespace = addressSpace.getOwnNamespace();
  const folder = namespace.addObject({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: "SemanticsSpike",
    nodeId: "ns=1;s=SemanticsSpike",
  });
  let writableValue = 1;
  const writableVariable = namespace.addVariable({
    componentOf: folder,
    browseName: "WritableValue",
    nodeId: "ns=1;s=SemanticsSpike.WritableValue",
    dataType: DataType.Int32,
    value: {
      get: () => new Variant({ dataType: DataType.Int32, value: writableValue }),
      set: (value: Variant) => {
        writableValue = value.value as number;
        return StatusCodes.Good;
      },
    },
    minimumSamplingInterval: 10,
  });
  namespace.addVariable({
    propertyOf: writableVariable,
    browseName: "EngineeringUnit",
    nodeId: "ns=1;s=SemanticsSpike.WritableValue.EngineeringUnit",
    dataType: DataType.String,
    value: new Variant({ dataType: DataType.String, value: "count" }),
  });
  namespace.addVariable({
    componentOf: folder,
    browseName: "ExtraValue",
    nodeId: "ns=1;s=SemanticsSpike.ExtraValue",
    dataType: DataType.Int32,
    value: new Variant({ dataType: DataType.Int32, value: 0 }),
  });
  const signedVariable = namespace.addVariable({
    componentOf: folder,
    browseName: "SignedLimit",
    nodeId: "ns=1;s=SemanticsSpike.SignedLimit",
    dataType: DataType.Int64,
    value: new Variant({ dataType: DataType.Int64, value: "-9223372036854775808" }),
  });
  const unsignedVariable = namespace.addVariable({
    componentOf: folder,
    browseName: "UnsignedLimit",
    nodeId: "ns=1;s=SemanticsSpike.UnsignedLimit",
    dataType: DataType.UInt64,
    value: new Variant({ dataType: DataType.UInt64, value: "18446744073709551615" }),
  });
  const methodObject = namespace.addObject({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: "SemanticsMethods",
    nodeId: "ns=1;s=SemanticsMethods",
  });
  const method = namespace.addMethod(methodObject, {
    browseName: "Add",
    nodeId: "ns=1;s=SemanticsMethods.Add",
    inputArguments: [
      { name: "left", description: "Left operand", dataType: DataType.Int32, valueRank: -1 },
      { name: "right", description: "Right operand", dataType: DataType.Int32, valueRank: -1 },
    ],
    outputArguments: [{ name: "sum", description: "Sum", dataType: DataType.Int32, valueRank: -1 }],
  });
  method.bindMethod((inputArguments, _context, callback) => {
    callback(null, {
      statusCode: StatusCodes.Good,
      outputArguments: [
        new Variant({
          dataType: DataType.Int32,
          value: (inputArguments[0]?.value as number) + (inputArguments[1]?.value as number),
        }),
      ],
    });
  });

  let delayedInvocations = 0;
  let delayedCompletions = 0;
  const delayedMethod = namespace.addMethod(methodObject, {
    browseName: "Delayed",
    nodeId: "ns=1;s=SemanticsMethods.Delayed",
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
    }, delayedMethodDelay);
  });

  await server.start();
  fixture = {
    server,
    serverCertificateManager,
    clientCertificateManager,
    temporaryDirectory,
    endpointUrl: server.getEndpointUrl(),
    folder,
    writableVariable,
    signedVariable,
    unsignedVariable,
    method,
    delayedMethod,
    get delayedInvocations() {
      return delayedInvocations;
    },
    get delayedCompletions() {
      return delayedCompletions;
    },
  };
});

afterAll(async () => {
  await cleanup?.();
});

describe("node-opcua client semantics", () => {
  it("proves discovery, exact secure endpoint selection, and certificate loading", async () => {
    const expectedSecureEndpoint = configuredSecureEndpoint();

    const discoveryClient = OPCUAClient.create(clientOptions());
    try {
      await discoveryClient.connect(fixture.endpointUrl);
      const discoveredServers = await discoveryClient.findServers();
      expect(discoveredServers.length).toBeGreaterThan(0);
      const endpoints = await discoveryClient.getEndpoints({ endpointUrl: fixture.endpointUrl });
      const selectedEndpoint = findExactEndpoint(
        endpoints,
        expectedSecureEndpoint!.endpointUrl!,
        MessageSecurityMode.SignAndEncrypt,
        SecurityPolicy.Basic256Sha256,
      );
      expect(Buffer.compare(selectedEndpoint.serverCertificate, expectedSecureEndpoint!.serverCertificate)).toBe(0);
      expect(selectedEndpoint.serverCertificate.length).toBeGreaterThan(0);
    } finally {
      await stopClient(discoveryClient);
    }

    const secureClient = OPCUAClient.create(secureClientOptions());
    try {
      await secureClient.connect(expectedSecureEndpoint!.endpointUrl!);
      const secureSession = await secureClient.createSession();
      expect(secureClient.reconnectOnFailure).toBe(false);
      expect(secureSession.endpoint.endpointUrl).toBe(expectedSecureEndpoint!.endpointUrl!);
      expect(secureSession.endpoint.securityMode).toBe(MessageSecurityMode.SignAndEncrypt);
      expect(secureSession.endpoint.securityPolicyUri).toBe(SecurityPolicy.Basic256Sha256);
      expect(Buffer.compare(secureSession.serverCertificate, expectedSecureEndpoint!.serverCertificate)).toBe(0);
      await secureSession.close();
    } finally {
      await stopClient(secureClient);
    }
  });

  it("proves browse continuation, attributes, properties, reads, writes, subscriptions, and Method Calls", async () => {
    const client = OPCUAClient.create(secureClientOptions());
    let session: ClientSession | undefined;
    let subscription: ClientSubscription | undefined;
    try {
      await client.connect(fixture.endpointUrl);
      session = await client.createSession();
      session.requestedMaxReferencesPerNode = 1;
      const maxBrowseRequests = 2;
      let boundedBrowseResult = await session.browse({ nodeId: fixture.folder.nodeId });
      let browseRequests = 1;
      while (boundedBrowseResult.continuationPoint?.length && browseRequests < maxBrowseRequests) {
        boundedBrowseResult = await session.browseNext(boundedBrowseResult.continuationPoint, false);
        browseRequests += 1;
      }
      if (boundedBrowseResult.continuationPoint?.length) {
        await session.browseNext(boundedBrowseResult.continuationPoint, true);
      }
      expect(browseRequests).toBe(maxBrowseRequests);

      let browseResult = await session.browse({ nodeId: fixture.folder.nodeId });
      const references = [...(browseResult.references ?? [])];
      while (browseResult.continuationPoint?.length) {
        browseResult = await session.browseNext(browseResult.continuationPoint, false);
        references.push(...(browseResult.references ?? []));
      }
      expect(references.length).toBeGreaterThan(3);
      expect(references.map((reference) => reference.nodeId.toString())).toEqual(
        expect.arrayContaining([
          fixture.writableVariable.nodeId.toString(),
          fixture.signedVariable.nodeId.toString(),
          fixture.unsignedVariable.nodeId.toString(),
        ]),
      );

      const attributes = await session.read([
        { nodeId: fixture.writableVariable.nodeId, attributeId: AttributeIds.NodeClass },
        { nodeId: fixture.writableVariable.nodeId, attributeId: AttributeIds.BrowseName },
      ]);
      expect(attributes[0]?.statusCode.name).toBe("Good");
      expect(attributes[1]?.statusCode.name).toBe("Good");
      expect(attributes[0]?.value.value).toBe(2);
      expect(attributes[1]?.value.value.name).toBe("WritableValue");

      const property = await session.read({
        nodeId: "ns=1;s=SemanticsSpike.WritableValue.EngineeringUnit",
        attributeId: AttributeIds.Value,
      });
      expect(property.statusCode.name).toBe("Good");
      expect(property.value.value).toBe("count");

      const initialValue = await session.read({
        nodeId: fixture.writableVariable.nodeId,
        attributeId: AttributeIds.Value,
      });
      expect(initialValue.statusCode.name).toBe("Good");
      expect(initialValue.value.value).toBe(1);

      const writeStatus = await session.write({
        nodeId: fixture.writableVariable.nodeId,
        attributeId: AttributeIds.Value,
        value: { value: new Variant({ dataType: DataType.Int32, value: 7 }) },
      });
      expect(writeStatus.name).toBe("Good");
      expect(
        (
          await session.read({ nodeId: fixture.writableVariable.nodeId, attributeId: AttributeIds.Value })
        ).value.value,
      ).toBe(7);

      subscription = await session.createSubscription2({
        requestedPublishingInterval: 20,
        requestedLifetimeCount: 20,
        requestedMaxKeepAliveCount: 3,
        publishingEnabled: true,
      });
      const monitoredItem = await subscription.monitor(
        { nodeId: fixture.writableVariable.nodeId, attributeId: AttributeIds.Value },
        { samplingInterval: 0, discardOldest: true, queueSize: 10 },
        TimestampsToReturn.Both,
      );
      const changed = waitForChanged(monitoredItem, (value: number) => value === 8);
      const subscribedWriteStatus = await session.write({
        nodeId: fixture.writableVariable.nodeId,
        attributeId: AttributeIds.Value,
        value: { value: new Variant({ dataType: DataType.Int32, value: 8 }) },
      });
      expect(subscribedWriteStatus.name).toBe("Good");
      const notification = await changed;
      expect(notification.statusCode.name).toBe("Good");
      expect(notification.sourceTimestamp).toBeInstanceOf(Date);

      session.requestedMaxReferencesPerNode = 0;
      const argumentDefinition = await session.getArgumentDefinition(fixture.method.nodeId);
      expect(argumentDefinition.inputArguments.map((argument) => argument.name)).toEqual(["left", "right"]);
      expect(argumentDefinition.outputArguments.map((argument) => argument.name)).toEqual(["sum"]);
      const callResult = await session.call({
        objectId: "ns=1;s=SemanticsMethods",
        methodId: fixture.method.nodeId,
        inputArguments: [
          new Variant({ dataType: DataType.Int32, value: 2 }),
          new Variant({ dataType: DataType.Int32, value: 3 }),
        ],
      });
      expect(callResult.statusCode.name).toBe("Good");
      expect(callResult.outputArguments?.[0]?.value).toBe(5);
    } finally {
      await subscription?.terminate().catch(() => undefined);
      await session?.close().catch(() => undefined);
      await stopClient(client);
    }
  });

  it("proves exact Int64/UInt64 values remain two-word values, not JavaScript numbers", async () => {
    const client = OPCUAClient.create(secureClientOptions());
    let session: ClientSession | undefined;
    try {
      await client.connect(fixture.endpointUrl);
      session = await client.createSession();
      const signed = await session.read({ nodeId: fixture.signedVariable.nodeId, attributeId: AttributeIds.Value });
      const unsigned = await session.read({ nodeId: fixture.unsignedVariable.nodeId, attributeId: AttributeIds.Value });
      expect(typeof signed.value.value).not.toBe("number");
      expect(typeof unsigned.value.value).not.toBe("number");
      expect(Array.isArray(signed.value.value)).toBe(true);
      expect(Array.isArray(unsigned.value.value)).toBe(true);
      expect(Int64ToBigInt(signed.value.value)).toBe(-9223372036854775808n);
      expect(UInt64ToBigInt(unsigned.value.value)).toBe(18446744073709551615n);
    } finally {
      await session?.close().catch(() => undefined);
      await stopClient(client);
    }
  });

  it("proves client timeout is not completion evidence and late Method completion is possible", async () => {
    const client = OPCUAClient.create(secureClientOptions({ defaultTransactionTimeout: 50 }));
    let session: ClientSession | undefined;
    const invocationBefore = fixture.delayedInvocations;
    const completionBefore = fixture.delayedCompletions;
    const originalMinimumTransactionTimeout = ClientSecureChannelLayer.minTransactionTimeout;
    expect(originalMinimumTransactionTimeout).toBe(5_000);
    ClientSecureChannelLayer.minTransactionTimeout = 20;
    try {
      await client.connect(fixture.endpointUrl);
      session = await client.createSession();
      const pendingCall = session.call({
        objectId: "ns=1;s=SemanticsMethods",
        methodId: fixture.delayedMethod.nodeId,
        inputArguments: [],
      });
      await waitFor(() => fixture.delayedInvocations === invocationBefore + 1);
      await expect(pendingCall).rejects.toThrow();
      expect(fixture.delayedCompletions).toBe(completionBefore);
      await waitFor(() => fixture.delayedCompletions === completionBefore + 1);
      expect(client.reconnectOnFailure).toBe(false);
    } finally {
      await session?.close().catch(() => undefined);
      await stopClient(client);
      ClientSecureChannelLayer.minTransactionTimeout = originalMinimumTransactionTimeout;
    }
  });

  it("proves transport cancellation, no automatic reconnect, and disposable shutdown", async () => {
    const client = OPCUAClient.create(secureClientOptions());
    const invocationBefore = fixture.delayedInvocations;
    let session: ClientSession | undefined;
    try {
      await client.connect(fixture.endpointUrl);
      session = await client.createSession();
      const lost = new Promise<void>((resolve) => client.once("connection_lost", resolve));
      let reestablished = false;
      client.on("connection_reestablished", () => {
        reestablished = true;
      });
      const pendingCall = session.call({
        objectId: "ns=1;s=SemanticsMethods",
        methodId: fixture.delayedMethod.nodeId,
        inputArguments: [],
      });
      await waitFor(() => fixture.delayedInvocations === invocationBefore + 1);
      const endpoint = fixture.server.endpoints[0];
      const channels = endpoint as unknown as { _channels: Record<string, { close(): void }> };
      const channel = channels._channels[Object.keys(channels._channels)[0] ?? ""];
      if (!channel) {
        throw new Error("The in-process server did not expose a connected channel for the spike");
      }
      channel.close();

      await lost;
      await expect(pendingCall).rejects.toThrow();
      await delay(delayedMethodDelay + 50);
      expect(client.reconnectOnFailure).toBe(false);
      expect(client.isReconnecting).toBe(false);
      expect(reestablished).toBe(false);
      expect(fixture.delayedCompletions).toBeGreaterThanOrEqual(fixture.delayedInvocations);
      await stopClient(client);
      await fixture.server.shutdown();
      expect(fixture.server.currentChannelCount).toBe(0);
    } finally {
      await session?.close().catch(() => undefined);
      await stopClient(client);
    }
  });
});
