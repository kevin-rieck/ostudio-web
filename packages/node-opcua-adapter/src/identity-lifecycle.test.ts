import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createApplication } from "@ostudio/application";
import {
  BinaryStream,
  DataType,
  DataValue,
  EndpointDescription,
  MessageSecurityMode,
  SecurityPolicy,
  Variant,
} from "node-opcua";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createNodeOpcuaAdapter } from "./index";
import { createOpcUaTestServer, disposeOpcUaTestServer } from "./test-fixture";

const endpointUrl = "opc.tcp://requested.example:4840/UA/Studio";

describe("server identity lifecycle", () => {
  let fixture: Awaited<ReturnType<typeof createOpcUaTestServer>>;
  let certificate: Buffer;
  let replacement: Buffer;
  let privateKey: ReturnType<typeof createPrivateKey>;
  beforeAll(async () => {
    fixture = await createOpcUaTestServer();
    certificate = fixture.server.getCertificate();
    privateKey = createPrivateKey(await readFile(fixture.serverCertificateManager.privateKey));
    const outputFile = path.join(fixture.temporaryDirectory, "renewal-replacement.pem");
    await fixture.serverCertificateManager.createSelfSignedCertificate({
      applicationUri: "urn:test:replacement",
      subject: "/CN=replacement",
      dns: ["localhost"],
      outputFile,
      startDate: new Date(),
      validity: 365,
    });
    replacement = new X509Certificate(await readFile(outputFile)).raw;
    expect(replacement.equals(certificate)).toBe(false);
    expect(new X509Certificate(replacement).publicKey.export({ type: "spki", format: "der" })).toEqual(
      new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" }),
    );
  }, 120_000);
  afterAll(async () => {
    if (fixture) await disposeOpcUaTestServer(fixture);
  });

  function seam() {
    const endpoints = [
      new EndpointDescription({
        endpointUrl,
        securityMode: MessageSecurityMode.SignAndEncrypt,
        securityPolicyUri: SecurityPolicy.Basic256Sha256,
        serverCertificate: certificate,
      }),
    ];
    const adapter = createNodeOpcuaAdapter({
      applicationName: "test",
      applicationUri: "urn:test",
      resolveClientIdentity: async () => ({ certificate, privateKey }),
    });
    const channel = new EventEmitter();
    const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const emitCertificate = (actual: Buffer) => {
      const stream = new BinaryStream(Buffer.alloc(actual.length + 100));
      stream.buffer.write("OPN", 0, "ascii");
      stream.length = 12;
      stream.writeString(SecurityPolicy.Basic256Sha256);
      stream.writeByteStream(actual);
      channel.emit("receive_chunk", stream.buffer);
    };
    const session = {
      close: vi.fn(async () => undefined),
      read: vi.fn(async (items: unknown[]) =>
        items.map(() => new DataValue({ value: new Variant({ dataType: DataType.Double, value: 12 }) })),
      ),
    };
    const disconnect = vi.fn(async () => {
      client.emit("connection_lost");
      client.emit("close");
    });
    const createSession = vi.fn(async () => session);
    client.connect = async () => {
      client.emit("secure_channel_created", channel);
      emitCertificate(certificate);
    };
    client.getEndpoints = async () => endpoints;
    client.createSession = createSession;
    client.disconnect = disconnect;
    Object.defineProperty(adapter, "discoverRaw", { value: async () => ({ servers: [], endpoints }) });
    Object.defineProperty(adapter, "createRawClient", { configurable: true, value: async () => client });
    const request = {
      endpointUrl,
      securityMode: "SignAndEncrypt" as const,
      securityPolicyUri: SecurityPolicy.Basic256Sha256,
      serverCertificateFingerprint: `sha256:${createHash("sha256").update(certificate).digest("hex")}`,
      clientCertificateReference: "cert",
      clientKeyReference: "key",
    };
    return { adapter, client, endpoints, emitCertificate, request, createSession, disconnect, session };
  }

  it("aborts a mismatch during endpoint retrieval before any session, even if a later OPN matches", async () => {
    const s = seam();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (started = resolve));
    s.client.getEndpoints = async () => {
      started();
      await gate;
      return s.endpoints;
    };
    const pending = s.adapter.connect(s.request);
    await entered;
    s.emitCertificate(replacement);
    s.emitCertificate(certificate);
    await expect(pending).rejects.toMatchObject({ code: "connection_failed" });
    expect(s.createSession).not.toHaveBeenCalled();
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    release();
  });

  it("rejects a mismatch during pending session creation and closes the late session", async () => {
    const s = seam();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (started = resolve));
    s.createSession.mockImplementation(async () => {
      started();
      await gate;
      return s.session;
    });
    const pending = s.adapter.connect(s.request);
    await entered;
    s.emitCertificate(replacement);
    s.emitCertificate(certificate);
    await expect(pending).rejects.toMatchObject({ code: "connection_failed" });
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(s.session.close).toHaveBeenCalledTimes(1));
    await s.adapter.disconnect();
    expect(s.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(["mismatch first", "loss first"])(
    "notifies application loss once and stales Live Values with %s",
    async (order) => {
      const s = seam();
      const losses = vi.fn();
      s.adapter.onConnectionLost(losses);
      const application = createApplication({
        clientFactory: () => s.adapter,
        savedConnections: { list: async () => [], save: async () => undefined, remove: async () => undefined },
        clock: { now: () => new Date() },
        events: { publish: () => undefined },
      });
      await application.connect(s.request);
      await application.setReadOnly(false, true);
      await application.inspectVariable("ns=2;s=level", { nodeId: "ns=2;s=level" });
      expect(application.snapshot()).toMatchObject({
        connection: { state: "connected", identityStatus: "verified" },
        safety: { readOnly: false },
        inspections: { "ns=2;s=level": { stale: false } },
      });
      if (order === "loss first") s.client.emit("connection_lost");
      s.emitCertificate(replacement);
      s.emitCertificate(certificate);
      s.client.emit("connection_lost");
      s.client.emit("close");
      expect(application.snapshot()).toMatchObject({
        connection: { state: "connection-lost" },
        safety: { readOnly: true },
        inspections: { "ns=2;s=level": { stale: true } },
      });
      expect(losses).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(s.disconnect).toHaveBeenCalledTimes(1));
      expect(s.session.close).toHaveBeenCalledTimes(1);
      await s.adapter.disconnect();
      expect(s.disconnect).toHaveBeenCalledTimes(1);
    },
  );

  it("aborts the transport without waiting for session cleanup after a mismatch", async () => {
    const s = seam();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    s.session.close.mockImplementation(async () => {
      await gate;
    });
    await s.adapter.connect(s.request);
    s.emitCertificate(replacement);
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(s.session.close).toHaveBeenCalledTimes(1));
    release();
    await vi.waitFor(() => expect(s.disconnect).toHaveBeenCalledTimes(1));
  });

  it("ignores an old channel mismatch after a new session takes ownership", async () => {
    const first = seam();
    const second = seam();
    const losses = vi.fn();
    first.adapter.onConnectionLost(losses);
    let calls = 0;
    Object.defineProperty(first.adapter, "createRawClient", {
      value: async () => (calls++ === 0 ? first.client : second.client),
    });
    const oldSession = await first.adapter.connect(first.request);
    await first.adapter.disconnect();
    await first.adapter.connect(first.request);
    first.emitCertificate(replacement);
    await oldSession.close();
    expect(losses).not.toHaveBeenCalled();
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(second.disconnect).not.toHaveBeenCalled();
    await first.adapter.disconnect();
    expect(second.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not report connection loss for deliberate disconnect", async () => {
    const s = seam();
    const losses = vi.fn();
    s.adapter.onConnectionLost(losses);
    await s.adapter.connect(s.request);
    await s.adapter.disconnect();
    expect(losses).not.toHaveBeenCalled();
    expect(s.disconnect).toHaveBeenCalledTimes(1);
  });
});
