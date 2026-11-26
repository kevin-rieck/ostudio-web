import { execFileSync } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { MessageSecurityMode, OPCUACertificateManager, OPCUAClient, SecurityPolicy } from "node-opcua";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOutboundTransportFactory } from "./outbound-transport";
import { createOpcUaTestServer, disposeOpcUaTestServer } from "./test-fixture";

type Address = { address: string; family: number };

async function listen(
  host: string,
): Promise<{ server: Server; port: number; connections: () => number; data: () => Buffer }> {
  let count = 0;
  const chunks: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    count++;
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, host, resolve));
  server.on("close", () => sockets.forEach((socket) => socket.destroy()));
  return {
    server,
    port: (server.address() as { port: number }).port,
    connections: () => count,
    data: () => Buffer.concat(chunks),
  };
}

function dial(factory: ReturnType<typeof createOutboundTransportFactory>, url: string, timeout = 100): Promise<void> {
  const transport = factory.create();
  transport.timeout = timeout;
  return new Promise<void>((resolve, reject) => {
    transport.connect(url, (error) => {
      transport.dispose();
      if (error) reject(error);
      else resolve();
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("outbound transport policy", () => {
  it("rejects node-opcua forced discovery, which does not forward the transport factory", () => {
    const code = `import { createOutboundTransportFactory } from './packages/node-opcua-adapter/src/outbound-transport.ts'; try { createOutboundTransportFactory({}); process.exit(1); } catch { process.exit(0); }`;
    expect(() =>
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        env: { ...process.env, NODEOPCUA_CLIENT_FORCE_ENDPOINT_DISCOVERY: "1" },
      }),
    ).not.toThrow();
  }, 30_000);

  it("rejects invalid configuration before dialing", () => {
    for (const rule of ["example.com/24", "127.0.0.1/33", "::1/129", "127.0.0.1/-1", "127.0.0.1/08"]) {
      expect(() => createOutboundTransportFactory({ addresses: [rule] })).toThrow();
    }
    for (const host of ["*.example.com", "example.com/path", "-bad.example", ""]) {
      expect(() => createOutboundTransportFactory({ hosts: [host] })).toThrow();
    }
  });

  it("denies hostname, literal IPv4 and CIDR mismatches before any TCP connection", async () => {
    const listener = await listen("127.0.0.1");
    try {
      const url = `opc.tcp://127.0.0.1:${listener.port}`;
      await expect(dial(createOutboundTransportFactory({ addresses: ["127.0.0.2/32"] }), url)).rejects.toThrow();
      await expect(dial(createOutboundTransportFactory({ hosts: ["other.example"] }), url)).rejects.toThrow();
      expect(listener.connections()).toBe(0);
    } finally {
      await close(listener.server);
    }
  });

  it("filters multiple DNS answers at dial time and rejects a changed answer without connecting", async () => {
    const listener = await listen("127.0.0.1");
    let answers: Address[] = [
      { address: "127.0.0.2", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    const factory = createOutboundTransportFactory(
      { hosts: ["plc.example"], addresses: ["127.0.0.1/32"] },
      (_host, callback) => callback(null, answers),
    );
    try {
      const url = `opc.tcp://plc.example:${listener.port}/UA/Test`;
      await expect(dial(factory, url)).rejects.toThrow(); // listener deliberately never sends ACK
      expect(listener.connections()).toBe(1);
      expect(listener.data().includes(Buffer.from(url))).toBe(true);
      answers = [{ address: "127.0.0.2", family: 4 }];
      await expect(dial(factory, url)).rejects.toThrow();
      expect(listener.connections()).toBe(1);
    } finally {
      await close(listener.server);
    }
  });

  it("enforces IPv6 CIDRs before dialing", async () => {
    const listener = await listen("::1");
    try {
      const url = `opc.tcp://[::1]:${listener.port}`;
      await expect(dial(createOutboundTransportFactory({ addresses: ["::2/128"] }), url)).rejects.toThrow();
      expect(listener.connections()).toBe(0);
      await expect(dial(createOutboundTransportFactory({ addresses: ["::1/128"] }), url)).rejects.toThrow();
      expect(listener.connections()).toBe(1);
    } finally {
      await close(listener.server);
    }
  });

  it("allows a hostname-only policy to trust its current address resolution", async () => {
    const listener = await listen("127.0.0.1");
    try {
      const factory = createOutboundTransportFactory({ hosts: ["plc.example"] }, (_host, callback) => {
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      });
      await expect(dial(factory, `opc.tcp://plc.example:${listener.port}`)).rejects.toThrow();
      expect(listener.connections()).toBe(1);
    } finally {
      await close(listener.server);
    }
  });

  it("times out pending DNS and does not dial after its late answer", async () => {
    const listener = await listen("127.0.0.1");
    try {
      const factory = createOutboundTransportFactory({}, (_host, callback) => {
        setTimeout(() => callback(null, [{ address: "127.0.0.1", family: 4 }]), 150);
      });
      await expect(dial(factory, `opc.tcp://slow.example:${listener.port}`, 30)).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(listener.connections()).toBe(0);
    } finally {
      await close(listener.server);
    }
  });
});

describe("factory integration", () => {
  let fixture: Awaited<ReturnType<typeof createOpcUaTestServer>>;
  let manager: OPCUACertificateManager;
  let certificateFile: string;
  beforeAll(async () => {
    fixture = await createOpcUaTestServer({
      securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
      securityModes: [MessageSecurityMode.None, MessageSecurityMode.SignAndEncrypt],
    });
    manager = new OPCUACertificateManager({
      rootFolder: path.join(fixture.temporaryDirectory, "client-pki"),
      automaticallyAcceptUnknownCertificate: true,
      disableFileWatchers: true,
    });
    await manager.initialize();
    certificateFile = path.join(manager.ownCertFolder, "client_certificate.pem");
    await manager.createSelfSignedCertificate({
      applicationUri: "urn:localhost:outbound-proof",
      subject: "/CN=outbound-proof",
      dns: ["localhost"],
      outputFile: certificateFile,
      startDate: new Date(),
      validity: 365,
    });
    await fixture.server.start();
  }, 120_000);
  afterAll(async () => {
    await manager?.dispose();
    if (fixture) await disposeOpcUaTestServer(fixture);
  });

  it("uses the factory for discovery and a secure channel without changing the endpoint URL", async () => {
    const url = fixture.endpointUrl.replace("127.0.0.1", "plc.example");
    let resolves = 0;
    const transportFactory = createOutboundTransportFactory(
      { hosts: ["plc.example"], addresses: ["127.0.0.0/8"] },
      (_host, callback) => {
        resolves++;
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      },
    );
    const options = {
      transportFactory,
      connectionStrategy: { maxRetry: 0 },
      endpointMustExist: false,
      clientCertificateManager: manager,
      certificateFile,
      privateKeyFile: manager.privateKey,
    };
    const discovery = OPCUAClient.create({
      ...options,
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
    });
    let secure: OPCUAClient | undefined;
    try {
      await discovery.connect(url);
      const endpoint = (await discovery.getEndpoints({ endpointUrl: url })).find(
        (item) =>
          item.securityMode === MessageSecurityMode.SignAndEncrypt &&
          item.securityPolicyUri === SecurityPolicy.Basic256Sha256,
      );
      expect(endpoint?.serverCertificate?.length).toBeGreaterThan(0);
      await discovery.disconnect();
      secure = OPCUAClient.create({
        ...options,
        securityMode: MessageSecurityMode.SignAndEncrypt,
        securityPolicy: SecurityPolicy.Basic256Sha256,
        serverCertificate: endpoint!.serverCertificate,
      });
      await secure.connect(url);
      const session = await secure.createSession();
      expect(session.serverCertificate.equals(endpoint!.serverCertificate!)).toBe(true);
      await session.close();
      expect(resolves).toBeGreaterThanOrEqual(2);
    } finally {
      await discovery.disconnect().catch(() => undefined);
      await secure?.disconnect().catch(() => undefined);
    }
  }, 120_000);

  it("rechecks DNS between discovery and secure connect", async () => {
    const url = fixture.endpointUrl.replace("127.0.0.1", "plc.example");
    let address = "127.0.0.1";
    let resolutions = 0;
    const transportFactory = createOutboundTransportFactory({ addresses: ["127.0.0.1"] }, (_host, callback) => {
      resolutions++;
      callback(null, [{ address, family: 4 }]);
    });
    const options = {
      transportFactory,
      connectionStrategy: { maxRetry: 0 },
      endpointMustExist: false,
      clientCertificateManager: manager,
      certificateFile,
      privateKeyFile: manager.privateKey,
    };
    const discovery = OPCUAClient.create({
      ...options,
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
    });
    let secure: OPCUAClient | undefined;
    try {
      await discovery.connect(url);
      const endpoint = (await discovery.getEndpoints({ endpointUrl: url })).find(
        (item) =>
          item.securityMode === MessageSecurityMode.SignAndEncrypt &&
          item.securityPolicyUri === SecurityPolicy.Basic256Sha256,
      );
      expect(endpoint?.serverCertificate?.length).toBeGreaterThan(0);
      await discovery.disconnect();
      address = "127.0.0.2";
      secure = OPCUAClient.create({
        ...options,
        securityMode: MessageSecurityMode.SignAndEncrypt,
        securityPolicy: SecurityPolicy.Basic256Sha256,
        serverCertificate: endpoint!.serverCertificate,
      });
      await expect(secure.connect(url)).rejects.toThrow();
      expect(resolutions).toBe(2);
    } finally {
      await discovery.disconnect().catch(() => undefined);
      await secure?.disconnect().catch(() => undefined);
    }
  }, 120_000);
});
