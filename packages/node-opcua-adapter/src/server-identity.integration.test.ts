import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MessageSecurityMode, OPCUAServer, SecurityPolicy } from "node-opcua";
import { describe, expect, it } from "vitest";
import { createNodeOpcuaAdapter } from "./index";
import { createOpcUaTestServer, disposeOpcUaTestServer } from "./test-fixture";

describe("secure server identity", () => {
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
