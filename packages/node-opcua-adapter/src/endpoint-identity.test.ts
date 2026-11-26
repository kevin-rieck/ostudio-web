import { createHash, createPrivateKey } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { BinaryStream, EndpointDescription, MessageSecurityMode, SecurityPolicy } from "node-opcua";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createNodeOpcuaAdapter } from "./index";
import { createOpcUaTestServer, disposeOpcUaTestServer } from "./test-fixture";

const endpointUrl = "opc.tcp://requested.example:4840/UA/Studio";
const aliasUrl = "opc.tcp://alias.example:4840/UA/Studio";
const pin = (certificate: Buffer) => `sha256:${createHash("sha256").update(certificate).digest("hex")}`;
const descriptor = (url: string, certificate: Buffer) =>
  new EndpointDescription({
    endpointUrl: url,
    securityMode: MessageSecurityMode.SignAndEncrypt,
    securityPolicyUri: SecurityPolicy.Basic256Sha256,
    serverCertificate: certificate,
  });

describe("selected endpoint identity", () => {
  let first: Awaited<ReturnType<typeof createOpcUaTestServer>>;
  let second: Awaited<ReturnType<typeof createOpcUaTestServer>>;
  let certificateA: Buffer;
  let certificateB: Buffer;
  beforeAll(async () => {
    first = await createOpcUaTestServer();
    second = await createOpcUaTestServer();
    certificateA = first.server.getCertificate();
    certificateB = second.server.getCertificate();
    expect(pin(certificateA)).not.toBe(pin(certificateB));
  }, 120_000);
  afterAll(async () => {
    if (first) await disposeOpcUaTestServer(first);
    if (second) await disposeOpcUaTestServer(second);
  });

  it("prefers the exact raw endpoint independently of order and rejects ambiguous candidates", async () => {
    const resolveClientIdentity = vi.fn(async () => {
      throw new Error("stop before dialing");
    });
    const adapter = createNodeOpcuaAdapter({
      applicationName: "test",
      applicationUri: "urn:test",
      resolveClientIdentity,
    });
    let endpoints: EndpointDescription[] = [];
    Object.defineProperty(adapter, "discoverRaw", { value: async () => ({ servers: [], endpoints }) });
    for (const order of [false, true]) {
      resolveClientIdentity.mockClear();
      endpoints = [descriptor(aliasUrl, certificateA), descriptor(endpointUrl, certificateB)];
      if (order) endpoints.reverse();
      const discovery = await adapter.discover({ endpointUrl });
      expect(discovery.endpoints).toHaveLength(1);
      expect(discovery.endpoints[0]?.serverCertificateFingerprint).toBe(pin(certificateB));
      const request = {
        endpointUrl,
        securityMode: "SignAndEncrypt" as const,
        securityPolicyUri: SecurityPolicy.Basic256Sha256,
        clientCertificateReference: "cert",
        clientKeyReference: "key",
      };
      await expect(
        adapter.connect({ ...request, serverCertificateFingerprint: pin(certificateA) }),
      ).rejects.toMatchObject({ code: "connection_failed" });
      expect(resolveClientIdentity).not.toHaveBeenCalled();
      await expect(
        adapter.connect({ ...request, serverCertificateFingerprint: pin(certificateB) }),
      ).rejects.toMatchObject({ code: "connection_failed" });
      expect(resolveClientIdentity).toHaveBeenCalledTimes(1);
    }
    for (const urls of [
      [endpointUrl, endpointUrl],
      [aliasUrl, "opc.tcp://other.example:4840/UA/Studio"],
    ]) {
      endpoints = [descriptor(urls[0]!, certificateA), descriptor(urls[1]!, certificateB)];
      await expect(adapter.discover({ endpointUrl })).rejects.toMatchObject({ code: "discovery_failed" });
      await expect(
        adapter.connect({
          endpointUrl,
          securityMode: "SignAndEncrypt",
          securityPolicyUri: SecurityPolicy.Basic256Sha256,
          serverCertificateFingerprint: pin(certificateA),
        }),
      ).rejects.toMatchObject({ code: "discovery_failed" });
    }
    endpoints = [
      descriptor(aliasUrl, certificateA),
      descriptor("opc.tcp://other.example:4840/UA/Studio", certificateA),
    ];
    expect((await adapter.discover({ endpointUrl })).endpoints[0]?.serverCertificateFingerprint).toBe(
      pin(certificateA),
    );
  });

  it("uses the leaf for discovery and actual-channel checks and rejects malformed bundles", async () => {
    const privateKey = createPrivateKey(await readFile(first.serverCertificateManager.privateKey));
    const adapter = createNodeOpcuaAdapter({
      applicationName: "test",
      applicationUri: "urn:test",
      resolveClientIdentity: async () => ({ certificate: certificateA, privateKey }),
    });
    let advertised: Buffer = Buffer.concat([certificateA, certificateB]);
    let actual: Buffer = certificateA;
    let channelEndpoints: EndpointDescription[] | undefined;
    const endpoints = () => [descriptor(endpointUrl, advertised)];
    Object.defineProperty(adapter, "discoverRaw", { value: async () => ({ servers: [], endpoints: endpoints() }) });
    const createSession = vi.fn(async () => ({ close: async () => undefined }));
    Object.defineProperty(adapter, "createRawClient", {
      value: async () => {
        const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
        client.connect = async () => {
          const channel = new EventEmitter();
          client.emit("secure_channel_created", channel);
          const stream = new BinaryStream(Buffer.alloc(actual.length + 100));
          stream.buffer.write("OPN", 0, "ascii");
          stream.length = 12;
          stream.writeString(SecurityPolicy.Basic256Sha256);
          stream.writeByteStream(actual);
          channel.emit("receive_chunk", stream.buffer);
        };
        client.getEndpoints = async () => channelEndpoints ?? endpoints();
        client.createSession = createSession;
        client.disconnect = async () => undefined;
        return client;
      },
    });
    const request = {
      endpointUrl,
      securityMode: "SignAndEncrypt" as const,
      securityPolicyUri: SecurityPolicy.Basic256Sha256,
      serverCertificateFingerprint: pin(certificateA),
      clientCertificateReference: "cert",
      clientKeyReference: "key",
    };
    for (const pair of [
      [Buffer.concat([certificateA, certificateB]), certificateA],
      [certificateA, Buffer.concat([certificateA, certificateB])],
      [Buffer.concat([certificateA, certificateA]), Buffer.concat([certificateA, certificateB])],
    ]) {
      [advertised, actual] = pair as [Buffer, Buffer];
      expect((await adapter.discover({ endpointUrl })).endpoints[0]?.serverCertificateFingerprint).toBe(
        pin(certificateA),
      );
      await adapter.connect(request);
      await adapter.disconnect();
    }
    expect(createSession).toHaveBeenCalledTimes(3);
    advertised = certificateA;
    actual = certificateA;
    channelEndpoints = [
      descriptor("opc.tcp://REQUESTED.example:4840/UA/Studio", certificateB),
      descriptor(endpointUrl, certificateA),
    ];
    await expect(adapter.connect(request)).rejects.toMatchObject({ code: "connection_failed" });
    expect(createSession).toHaveBeenCalledTimes(3);
    channelEndpoints = undefined;
    expect([certificateA[0], certificateA[1], certificateA[4], certificateA[5]]).toEqual([0x30, 0x82, 0x30, 0x82]);
    const nonCanonicalInner = Buffer.concat([
      certificateA.subarray(0, 4),
      Buffer.from([0x30, 0x83, 0]),
      certificateA.subarray(6),
    ]);
    nonCanonicalInner.writeUInt16BE(certificateA.readUInt16BE(2) + 1, 2);
    for (const bad of [
      nonCanonicalInner,
      Buffer.concat([certificateA, Buffer.from([0])]),
      certificateA.subarray(0, certificateA.length - 1),
      Buffer.from([0x30, 0x80, 0, 0]),
    ]) {
      advertised = bad;
      await expect(adapter.discover({ endpointUrl })).rejects.toThrow();
      advertised = certificateA;
      actual = bad;
      await expect(adapter.connect(request)).rejects.toMatchObject({ code: "connection_failed" });
    }
    expect(createSession).toHaveBeenCalledTimes(3);
  });
});
