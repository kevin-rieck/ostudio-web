import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MessageSecurityMode,
  OPCUACertificateManager,
  OPCUAServer,
  SecurityPolicy,
} from "node-opcua";

export type OpcUaTestServer = {
  server: OPCUAServer;
  serverCertificateManager: OPCUACertificateManager;
  temporaryDirectory: string;
  endpointUrl: string;
};

export async function createOpcUaTestServer(options: {
  securityPolicies?: SecurityPolicy[];
  securityModes?: MessageSecurityMode[];
} = {}): Promise<OpcUaTestServer> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ostudio-node-opcua-test-"));
  const serverCertificateManager = new OPCUACertificateManager({
    rootFolder: path.join(temporaryDirectory, "server-pki"),
    automaticallyAcceptUnknownCertificate: true,
    disableFileWatchers: true,
  });
  try {
    await serverCertificateManager.initialize();
    const server = new OPCUAServer({
      port: 0,
      host: "127.0.0.1",
      hostname: "127.0.0.1",
      ...(options.securityPolicies ? { securityPolicies: options.securityPolicies } : {}),
      ...(options.securityModes ? { securityModes: options.securityModes } : {}),
      serverCertificateManager,
    });
    await server.initialize();
    return {
      server,
      serverCertificateManager,
      temporaryDirectory,
      get endpointUrl() {
        return server.getEndpointUrl();
      },
    };
  } catch (error) {
    await serverCertificateManager.dispose().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function disposeOpcUaTestServer(fixture: OpcUaTestServer): Promise<void> {
  await fixture.server.shutdown().catch(() => undefined);
  await fixture.serverCertificateManager.dispose().catch(() => undefined);
  await rm(fixture.temporaryDirectory, { recursive: true, force: true });
}
