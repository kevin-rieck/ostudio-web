import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { SavedConnection, SavedConnectionStore } from "@ostudio/application";

const VERSION = 1;
const FILE_NAME = "saved-connections.json";
const MAX_CONNECTIONS = 100;

type PersistedConnection = Omit<SavedConnection, "clientCertificateReference">;
type Envelope = { version: 1; savedConnections: PersistedConnection[] };

type StoredConnection = SavedConnection & { password?: string; privateKeyPath?: string };

export interface SavedConnectionStoreAdapter extends SavedConnectionStore {
  readonly mode: "durable" | "ephemeral";
}

function clone(connection: SavedConnection): SavedConnection {
  return structuredClone(connection);
}

function persisted(connection: StoredConnection): PersistedConnection {
  const result: PersistedConnection = {
    id: connection.id,
    name: connection.name,
    endpoint: connection.endpoint,
    securityPolicy: connection.securityPolicy,
    securityMode: connection.securityMode,
  };
  if (connection.username !== undefined) result.username = connection.username;
  if (connection.serverCertificatePin !== undefined) result.serverCertificatePin = connection.serverCertificatePin;
  if (connection.certificateReviewRequired === true) result.certificateReviewRequired = true;
  return result;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`Saved Connection ${name} is invalid.`);
  return value;
}

function safeEndpoint(value: unknown): string {
  const endpoint = boundedString(value, "endpoint", 2048);
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Saved Connection endpoint is invalid.");
  }
  if (parsed.protocol !== "opc.tcp:" || !parsed.hostname || parsed.username || parsed.password)
    throw new Error("Saved Connection endpoint is invalid.");
  return endpoint;
}

function parseConnection(value: unknown): PersistedConnection {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Saved Connection is invalid.");
  const record = value as Record<string, unknown>;
  const securityMode = record.securityMode;
  if (securityMode !== "None" && securityMode !== "Sign" && securityMode !== "SignAndEncrypt")
    throw new Error("Saved Connection security mode is invalid.");
  const connection: PersistedConnection = {
    id: boundedString(record.id, "id", 128),
    name: boundedString(record.name, "name", 256),
    endpoint: safeEndpoint(record.endpoint),
    securityPolicy: boundedString(record.securityPolicy, "security policy", 256),
    securityMode,
  };
  if (record.username !== undefined) connection.username = boundedString(record.username, "username", 256);
  if (record.serverCertificatePin !== undefined)
    connection.serverCertificatePin = boundedString(record.serverCertificatePin, "server certificate pin", 512);
  if (record.certificateReviewRequired !== undefined) {
    if (record.certificateReviewRequired !== true)
      throw new Error("Saved Connection certificate review flag is invalid.");
    connection.certificateReviewRequired = true;
  }
  return connection;
}

function parseEnvelope(value: unknown): Envelope {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Saved Connections are invalid.");
  const record = value as Record<string, unknown>;
  if (record.version !== VERSION) throw new Error("Unsupported Saved Connection storage version.");
  if (!Array.isArray(record.savedConnections) || record.savedConnections.length > MAX_CONNECTIONS)
    throw new Error("Saved Connections are invalid.");
  const savedConnections = record.savedConnections.map(parseConnection);
  const ids = new Set(savedConnections.map((connection) => connection.id));
  if (ids.size !== savedConnections.length) throw new Error("Saved Connection IDs must be unique.");
  return { version: VERSION, savedConnections };
}

function legacySecurityMode(value: unknown): SavedConnection["securityMode"] {
  if (value === undefined || value === "None" || value === "MessageSecurityModeNone") return "None";
  if (value === "Sign" || value === "MessageSecurityModeSign") return "Sign";
  if (value === "SignAndEncrypt" || value === "MessageSecurityModeSignAndEncrypt") return "SignAndEncrypt";
  throw new Error("Legacy Saved Connection security mode is unsupported.");
}

function migrateLegacy(value: unknown): Envelope {
  if (!Array.isArray(value) || value.length > MAX_CONNECTIONS) throw new Error("Legacy Saved Connections are invalid.");
  const savedConnections = value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new Error("Legacy Saved Connection is invalid.");
    const record = item as Record<string, unknown>;
    const rawEndpoint = record.endpoint ?? record.endpointUrl;
    const legacyUrl = typeof rawEndpoint === "string" ? new URL(rawEndpoint) : undefined;
    if (legacyUrl) {
      legacyUrl.username = "";
      legacyUrl.password = "";
    }
    const endpoint = legacyUrl?.href ?? rawEndpoint;
    const securityMode = legacySecurityMode(record.securityMode);
    const certificateReviewRequired = [
      record.certificateFile,
      record.privateKeyFile,
      record.certificatePath,
      record.privateKeyPath,
      record.clientCertificatePath,
    ].some((candidate) => typeof candidate === "string" && candidate.length > 0);
    return parseConnection({
      id: record.id,
      name: record.name,
      endpoint,
      securityPolicy: record.securityPolicy ?? "None",
      securityMode,
      ...(record.username === undefined ? {} : { username: record.username }),
      ...(record.serverCertificateThumbprint === undefined
        ? {}
        : { serverCertificatePin: record.serverCertificateThumbprint }),
      ...(certificateReviewRequired ? { certificateReviewRequired: true } : {}),
    });
  });
  const ids = new Set(savedConnections.map((connection) => connection.id));
  if (ids.size !== savedConnections.length) throw new Error("Legacy Saved Connection IDs must be unique.");
  return { version: VERSION, savedConnections };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    try {
      await handle.sync();
    } catch (error) {
      // Windows does not expose directory fsync; file fsync and atomic rename still apply there.
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  } finally {
    await handle.close();
  }
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function readDocument(filePath: string): Promise<{ envelope: Envelope; legacy: boolean }> {
  const source = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error("Saved Connection storage is corrupt.", { cause: error });
  }
  if (Array.isArray(parsed)) return { envelope: migrateLegacy(parsed), legacy: true };
  return { envelope: parseEnvelope(parsed), legacy: false };
}

export function createMemorySavedConnectionStore(): SavedConnectionStoreAdapter {
  const records = new Map<string, SavedConnection>();
  return {
    mode: "ephemeral",
    list: async () => [...records.values()].map(clone),
    save: async (connection) => {
      const safe = persisted(connection as StoredConnection);
      records.set(safe.id, clone(safe));
    },
    remove: async (id) => {
      records.delete(id);
    },
  };
}

export async function createFileSavedConnectionStore(directory: string): Promise<SavedConnectionStoreAdapter> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const filePath = path.join(directory, FILE_NAME);
  let envelope: Envelope;
  try {
    const document = await readDocument(filePath);
    envelope = document.envelope;
    if (document.legacy) {
      // Back up only the sanitized projection; legacy source may contain OPC UA passwords.
      const sanitized = JSON.stringify(envelope);
      await atomicWrite(`${filePath}.bak`, sanitized);
      await atomicWrite(filePath, sanitized);
    }
    await chmod(filePath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    envelope = { version: VERSION, savedConnections: [] };
    await atomicWrite(filePath, JSON.stringify(envelope));
  }
  const records = new Map(envelope.savedConnections.map((connection) => [connection.id, connection]));
  return {
    mode: "durable",
    list: async () => [...records.values()].map(clone),
    save: async (connection) => {
      const safe = persisted(connection as StoredConnection);
      parseConnection(safe);
      const next = new Map(records);
      if (!next.has(safe.id) && next.size >= MAX_CONNECTIONS) throw new Error("Saved Connection limit reached.");
      next.set(safe.id, clone(safe));
      await atomicWrite(filePath, JSON.stringify({ version: VERSION, savedConnections: [...next.values()] }));
      records.clear();
      for (const [id, value] of next) records.set(id, value);
    },
    remove: async (id) => {
      const next = new Map(records);
      next.delete(id);
      await atomicWrite(filePath, JSON.stringify({ version: VERSION, savedConnections: [...next.values()] }));
      records.clear();
      for (const [recordId, value] of next) records.set(recordId, value);
    },
  };
}
