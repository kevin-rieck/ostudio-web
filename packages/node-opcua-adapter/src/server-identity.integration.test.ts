import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BinaryStream, MessageSecurityMode, OPCUAServer, SecurityPolicy } from "node-opcua";
import type { ClientSession, OPCUAClient, OPCUAClientOptions } from "node-opcua";
import { describe, expect, it, vi } from "vitest";
import { createNodeOpcuaAdapter } from "./index";
import { createOpcUaTestServer, disposeOpcUaTestServer } from "./test-fixture";

describe("secure server identity", () => {
  it.each([false, true])(
    "aborts the real guarded transport before held session cleanup (reentrant disconnect: %s)",
    async (reentrant) => {
      const fixture = await createOpcUaTestServer({
        securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
        securityModes: [MessageSecurityMode.None, MessageSecurityMode.SignAndEncrypt],
      });
      let releaseClose!: () => void;
      const gate = new Promise<void>((resolve) => (releaseClose = resolve));
      let heldCloses = 0;
      let channel: { isValid(): boolean; emit(event: string, chunk: Buffer): boolean } | undefined;
      let rawDisconnect: Promise<void> | undefined;
      let adapter: ReturnType<typeof createNodeOpcuaAdapter> | undefined;
      try {
        await fixture.server.start();
        const certificate = fixture.server.getCertificate();
        const privateKey = createPrivateKey(await readFile(fixture.serverCertificateManager.privateKey));
        const replacementFile = path.join(fixture.temporaryDirectory, "renewal-replacement.pem");
        await fixture.serverCertificateManager.createSelfSignedCertificate({
          applicationUri: "urn:identity:renewal-replacement",
          subject: "/CN=renewal-replacement",
          dns: ["localhost"],
          outputFile: replacementFile,
          startDate: new Date(),
          validity: 365,
        });
        const replacement = new X509Certificate(await readFile(replacementFile)).raw;
        expect(replacement.equals(certificate)).toBe(false);
        expect(new X509Certificate(replacement).publicKey.export({ type: "spki", format: "der" })).toEqual(
          new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" }),
        );
        adapter = createNodeOpcuaAdapter({
          applicationName: "identity abort test",
          applicationUri: "urn:identity:abort-test",
          outboundPolicy: { hosts: ["127.0.0.1"], addresses: ["127.0.0.1/32"] },
          resolveClientIdentity: async () => ({ certificate, privateKey }),
        });
        const seam = adapter as unknown as {
          createRawClient(options: Partial<OPCUAClientOptions>): Promise<OPCUAClient>;
        };
        const originalFactory = seam.createRawClient.bind(adapter);
        Object.defineProperty(adapter, "createRawClient", {
          value: async (options: Partial<OPCUAClientOptions>) => {
            const client = await originalFactory(options);
            if (options.securityMode !== MessageSecurityMode.None) {
              client.on("secure_channel_created", (created) => {
                channel = created;
              });
              const createSession = client.createSession.bind(client);
              Object.defineProperty(client, "createSession", {
                value: (...args: unknown[]) => {
                  const result = Reflect.apply(createSession, client, args) as Promise<ClientSession> | undefined;
                  if (!result) return result;
                  return result.then((session) => {
                    const close = session.close.bind(session);
                    Object.defineProperty(session, "close", {
                      value: (...closeArgs: unknown[]) => {
                        heldCloses += 1;
                        const callback = closeArgs.at(-1);
                        if (typeof callback === "function") {
                          void gate.then(() => Reflect.apply(close, session, closeArgs));
                          return;
                        }
                        return gate.then(() => Reflect.apply(close, session, closeArgs) as Promise<void>);
                      },
                    });
                    return session;
                  });
                },
              });
              const disconnect = client.disconnect.bind(client);
              Object.defineProperty(client, "disconnect", {
                value: (...args: unknown[]) => {
                  const result = Reflect.apply(disconnect, client, args) as Promise<void> | undefined;
                  if (result) rawDisconnect = result;
                  return result;
                },
              });
            }
            return client;
          },
        });
        const losses = vi.fn(() => {
          if (reentrant) void adapter?.disconnect();
        });
        adapter.onConnectionLost(losses);
        const discovery = await adapter.discover({ endpointUrl: fixture.endpointUrl });
        const selected = discovery.endpoints.find(
          (endpoint) =>
            endpoint.securityMode === "SignAndEncrypt" && endpoint.securityPolicyUri === SecurityPolicy.Basic256Sha256,
        )!;
        await adapter.connect({
          endpointUrl: fixture.endpointUrl,
          securityMode: "SignAndEncrypt",
          securityPolicyUri: selected.securityPolicyUri,
          serverCertificateFingerprint: selected.serverCertificateFingerprint,
          clientCertificateReference: "cert-test",
          clientKeyReference: "key-test",
        });
        expect(channel?.isValid()).toBe(true);
        const stream = new BinaryStream(Buffer.alloc(replacement.length + 100));
        stream.buffer.write("OPN", 0, "ascii");
        stream.length = 12;
        stream.writeString(SecurityPolicy.Basic256Sha256);
        stream.writeByteStream(replacement);
        channel!.emit("receive_chunk", stream.buffer);
        await vi.waitFor(() => expect(heldCloses).toBeGreaterThan(0), { timeout: 5_000, interval: 20 });
        await vi.waitFor(() => expect(channel?.isValid()).toBe(false), { timeout: 5_000, interval: 20 });
        expect(losses).toHaveBeenCalledTimes(1);
      } finally {
        releaseClose();
        await adapter?.disconnect().catch(() => undefined);
        if (rawDisconnect)
          await Promise.race([
            rawDisconnect.catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 3_000)),
          ]);
        await disposeOpcUaTestServer(fixture);
      }
    },
    120_000,
  );

  it("aborts the real guarded transport during initialization before a session starts", async () => {
    const fixture = await createOpcUaTestServer({
      securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
      securityModes: [MessageSecurityMode.None, MessageSecurityMode.SignAndEncrypt],
    });
    let releaseLookup!: () => void;
    let lookupStarted!: () => void;
    const gate = new Promise<void>((resolve) => (releaseLookup = resolve));
    const entered = new Promise<void>((resolve) => (lookupStarted = resolve));
    let channel: { isValid(): boolean; emit(event: string, chunk: Buffer): boolean } | undefined;
    let createSessionCalls = 0;
    let adapter: ReturnType<typeof createNodeOpcuaAdapter> | undefined;
    try {
      await fixture.server.start();
      const certificate = fixture.server.getCertificate();
      const privateKey = createPrivateKey(await readFile(fixture.serverCertificateManager.privateKey));
      const replacementFile = path.join(fixture.temporaryDirectory, "initialization-replacement.pem");
      await fixture.serverCertificateManager.createSelfSignedCertificate({
        applicationUri: "urn:identity:initialization-replacement",
        subject: "/CN=initialization-replacement",
        dns: ["localhost"],
        outputFile: replacementFile,
        startDate: new Date(),
        validity: 365,
      });
      const replacement = new X509Certificate(await readFile(replacementFile)).raw;
      adapter = createNodeOpcuaAdapter({
        applicationName: "initialization abort test",
        applicationUri: "urn:identity:initialization-test",
        outboundPolicy: { hosts: ["127.0.0.1"], addresses: ["127.0.0.1/32"] },
        resolveClientIdentity: async () => ({ certificate, privateKey }),
      });
      const seam = adapter as unknown as {
        createRawClient(options: Partial<OPCUAClientOptions>): Promise<OPCUAClient>;
      };
      const originalFactory = seam.createRawClient.bind(adapter);
      Object.defineProperty(adapter, "createRawClient", {
        value: async (options: Partial<OPCUAClientOptions>) => {
          const client = await originalFactory(options);
          if (options.securityMode !== MessageSecurityMode.None) {
            client.on("secure_channel_created", (created) => {
              channel = created;
            });
            const getEndpoints = client.getEndpoints.bind(client);
            Object.defineProperty(client, "getEndpoints", {
              value: (...args: unknown[]) => {
                if (args.length === 1 && typeof args[0] === "object" && args[0] !== null && "endpointUrl" in args[0]) {
                  lookupStarted();
                  return gate.then(() => Reflect.apply(getEndpoints, client, args));
                }
                return Reflect.apply(getEndpoints, client, args);
              },
            });
            const createSession = client.createSession.bind(client);
            Object.defineProperty(client, "createSession", {
              value: (...args: unknown[]) => {
                createSessionCalls += 1;
                return Reflect.apply(createSession, client, args);
              },
            });
          }
          return client;
        },
      });
      const discovery = await adapter.discover({ endpointUrl: fixture.endpointUrl });
      const selected = discovery.endpoints.find(
        (endpoint) =>
          endpoint.securityMode === "SignAndEncrypt" && endpoint.securityPolicyUri === SecurityPolicy.Basic256Sha256,
      )!;
      const pending = adapter.connect({
        endpointUrl: fixture.endpointUrl,
        securityMode: "SignAndEncrypt",
        securityPolicyUri: selected.securityPolicyUri,
        serverCertificateFingerprint: selected.serverCertificateFingerprint,
        clientCertificateReference: "cert-test",
        clientKeyReference: "key-test",
      });
      const rejected = expect(pending).rejects.toMatchObject({ code: "connection_failed" });
      await Promise.race([
        entered,
        pending.then(
          () => {
            throw new Error("Session unexpectedly connected.");
          },
          (error: unknown) => {
            throw error;
          },
        ),
      ]);
      expect(channel?.isValid()).toBe(true);
      const stream = new BinaryStream(Buffer.alloc(replacement.length + 100));
      stream.buffer.write("OPN", 0, "ascii");
      stream.length = 12;
      stream.writeString(SecurityPolicy.Basic256Sha256);
      stream.writeByteStream(replacement);
      channel!.emit("receive_chunk", stream.buffer);
      await rejected;
      expect(channel?.isValid()).toBe(false);
      expect(createSessionCalls).toBe(0);
    } finally {
      releaseLookup();
      await adapter?.disconnect().catch(() => undefined);
      await disposeOpcUaTestServer(fixture);
    }
  }, 120_000);

  it("rejects a replacement after discovery before any session is created", async () => {
    const fixture = await createOpcUaTestServer({
      securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
      securityModes: [MessageSecurityMode.None, MessageSecurityMode.SignAndEncrypt],
    });
    let replacement: OPCUAServer | undefined;
    let sessions = 0;
    let channels = 0;
    try {
      await fixture.server.start();
      const endpointUrl = fixture.endpointUrl;
      const port = Number(new URL(endpointUrl).port);
      const certificate = fixture.server.getCertificate();
      const privateKey = createPrivateKey(await readFile(fixture.serverCertificateManager.privateKey));
      const replacementFile = path.join(fixture.temporaryDirectory, "replacement.pem");
      await fixture.serverCertificateManager.createSelfSignedCertificate({
        applicationUri: "urn:localhost:replacement",
        subject: "/CN=replacement",
        dns: ["localhost"],
        outputFile: replacementFile,
        startDate: new Date(),
        validity: 365,
      });
      replacement = new OPCUAServer({
        port,
        host: "127.0.0.1",
        hostname: "127.0.0.1",
        securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
        securityModes: [MessageSecurityMode.None, MessageSecurityMode.SignAndEncrypt],
        certificateFile: replacementFile,
        privateKeyFile: fixture.serverCertificateManager.privateKey,
        serverCertificateManager: fixture.serverCertificateManager,
      });
      await replacement.initialize();
      expect(replacement.getCertificate().equals(certificate)).toBe(false);
      expect(
        new X509Certificate(replacement.getCertificate()).publicKey.export({ type: "spki", format: "der" }),
      ).toEqual(new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" }));
      replacement.on("create_session", () => sessions++);
      replacement.endpoints.forEach((endpoint) => endpoint.on("newChannel", () => channels++));
      const adapter = createNodeOpcuaAdapter({
        applicationName: "identity test",
        applicationUri: "urn:identity-test",
        resolveClientIdentity: async () => {
          await fixture.server.shutdown();
          await replacement!.start();
          return { certificate, privateKey };
        },
      });
      try {
        const discovery = await adapter.discover({ endpointUrl });
        const secure = discovery.endpoints.find(
          (item) => item.securityMode === "SignAndEncrypt" && item.securityPolicyUri === SecurityPolicy.Basic256Sha256,
        )!;
        expect(secure.serverCertificateFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
        await expect(
          adapter.connect({
            endpointUrl,
            securityMode: "SignAndEncrypt",
            securityPolicyUri: secure.securityPolicyUri,
            serverCertificateFingerprint: secure.serverCertificateFingerprint,
            clientCertificateReference: "cert-test",
            clientKeyReference: "key-test",
          }),
        ).rejects.toMatchObject({ code: "connection_failed" });
        expect(channels).toBeGreaterThan(0);
        expect(sessions).toBe(0);
      } finally {
        await adapter.disconnect();
      }
    } finally {
      await replacement?.shutdown().catch(() => undefined);
      await disposeOpcUaTestServer(fixture);
    }
  }, 120_000);
});
