import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DataType,
  MessageSecurityMode,
  OPCUACertificateManager,
  OPCUAServer,
  SecurityPolicy,
  Variant,
  VariantArrayType,
} from "node-opcua";

export type OpcUaTestServer = {
  server: OPCUAServer;
  serverCertificateManager: OPCUACertificateManager;
  temporaryDirectory: string;
  endpointUrl: string;
};

export async function createOpcUaTestServer(
  options: {
    securityPolicies?: SecurityPolicy[];
    securityModes?: MessageSecurityMode[];
  } = {},
): Promise<OpcUaTestServer> {
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

export function addOpcUaTestVariable(
  fixture: OpcUaTestServer,
  options: {
    browseName: string;
    nodeId: string;
    initialValue: number | number[];
    valueRank?: number;
    arrayDimensions?: number[];
    engineeringRange?: { low: number; high: number };
    engineeringUnit?: string;
  },
): { setValue(value: number | number[]): void } {
  const addressSpace = fixture.server.engine.addressSpace!;
  const namespace = addressSpace.getOwnNamespace();
  let value = options.initialValue;
  const variableOptions = {
    organizedBy: addressSpace.rootFolder.objects,
    browseName: options.browseName,
    nodeId: options.nodeId,
    dataType: DataType.Double,
    ...(options.valueRank === undefined ? {} : { valueRank: options.valueRank }),
    ...(options.arrayDimensions === undefined ? {} : { arrayDimensions: options.arrayDimensions }),
    value: {
      get: () =>
        new Variant({
          dataType: DataType.Double,
          arrayType: Array.isArray(value) ? VariantArrayType.Array : VariantArrayType.Scalar,
          value,
        }),
    },
  };
  if (options.engineeringRange) {
    namespace.addAnalogDataItem({
      ...variableOptions,
      engineeringUnitsRange: options.engineeringRange,
      ...(options.engineeringUnit ? { engineeringUnits: { displayName: options.engineeringUnit } } : {}),
    });
  } else {
    namespace.addVariable(variableOptions);
  }
  return {
    setValue: (next) => {
      value = next;
    },
  };
}

export async function disposeOpcUaTestServer(fixture: OpcUaTestServer): Promise<void> {
  await fixture.server.shutdown().catch(() => undefined);
  await fixture.serverCertificateManager.dispose().catch(() => undefined);
  await rm(fixture.temporaryDirectory, { recursive: true, force: true });
}
