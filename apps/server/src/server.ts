import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  loginRequestSchema,
  type BrowseRequest,
  type BrowseResult,
  type ConnectionDiagnostic,
  type EndpointDiscoveryRequest,
  type EndpointDiscoveryResult,
  type EventEnvelope,
  type SearchResult,
  type Snapshot,
  type SavedConnectionConnectRequest,
  type SavedConnectionList,
  type SavedConnectionRequest,
} from "@ostudio/contracts";
import { createAuthenticator, authConstants, type AuthSession } from "./auth.js";

const SESSION_COOKIE = "ostudio_session";
const DEFAULT_CONTROLLER_LEASE_MS = 15_000;
const DEFAULT_CONTROLLER_DISCONNECT_GRACE_MS = 5 * 60_000;
const SSE_QUEUE_LIMIT = 100;
const SSE_HEARTBEAT_MS = 15_000;
const SHA256_PIN = /^sha256:[0-9a-f]{64}$/;
type EventType = EventEnvelope["type"];
type Environment = NodeJS.ProcessEnv;
export interface TimerScheduler {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval?(callback: () => void, milliseconds: number): unknown;
  clearInterval?(handle: unknown): void;
}

export type SavedConnectionConnectResult = { outcome: "not_found" };

export interface RuntimeShutdownHooks {
  snapshot?(): Snapshot;
  discover?(request: EndpointDiscoveryRequest): Promise<EndpointDiscoveryResult>;
  connect?(request: EndpointDiscoveryRequest): Promise<void>;
  browse?(request: BrowseRequest): Promise<BrowseResult>;
  search?(request: { query: string }): Promise<SearchResult>;
  listSavedConnections?(): Promise<SavedConnectionList>;
  saveSavedConnection?(id: string, request: SavedConnectionRequest): Promise<void>;
  deleteSavedConnection?(id: string): Promise<void>;
  connectSavedConnection?(
    id: string,
    request: SavedConnectionConnectRequest,
  ): Promise<void | SavedConnectionConnectResult>;
  setReadOnly?(readOnly: true): Promise<void> | void;
  disconnect?(): Promise<void>;
  close?(): Promise<void>;
  flushLogs?(): Promise<void> | void;
}

export interface ServerOptions {
  env?: Environment;
  assetsDirectory?: string;
  now?: () => number;
  timers?: TimerScheduler;
  runtime?: RuntimeShutdownHooks;
  controllerLeaseMilliseconds?: number;
  controllerDisconnectGraceMilliseconds?: number;
}

export interface WebServer extends FastifyInstance {
  eventSequence(): number;
  publishEvent(type: EventType, payload: EventEnvelope["payload"]): EventEnvelope;
  recordConnectionDiagnostic(record: Pick<ConnectionDiagnostic, "code" | "outcome"> & { endpoint?: string }): void;
  shutdown(): Promise<void>;
}

type RequestWithSession = FastifyRequest & { authSession?: AuthSession };

type RuntimeConfig = {
  publicOrigin: string;
  secureCookies: boolean;
  insecureDevelopment: boolean;
  trustedProxyCidrs: string[];
  password: string;
  controllerLeaseMilliseconds: number;
  controllerDisconnectGraceMilliseconds: number;
};

function positiveMilliseconds(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0)
    throw new Error(`${name} must be a positive number of milliseconds.`);
  return milliseconds;
}

function errorBody(code: string, message: string, operationId?: string): Record<string, unknown> {
  return {
    code,
    message,
    correlationId: `cor-${randomBytes(16).toString("base64url")}`,
    ...(operationId ? { operationId } : {}),
  };
}

function parseOrigin(value: string | undefined, fallback: string): string {
  const candidate = value ?? fallback;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("OSTUDIO_PUBLIC_ORIGIN must be a valid HTTP(S) public origin.");
  }
  if (
    !(parsed.protocol === "http:" || parsed.protocol === "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("OSTUDIO_PUBLIC_ORIGIN must be a valid HTTP(S) public origin.");
  }
  return parsed.origin;
}

async function runtimeConfig(environment: Environment): Promise<RuntimeConfig> {
  const production = environment.NODE_ENV === "production";
  const insecureDevelopment =
    environment.OSTUDIO_INSECURE_DEV === "true" || environment.OPCUA_STUDIO_INSECURE_DEV === "true";
  const publicOrigin = parseOrigin(
    environment.OSTUDIO_PUBLIC_ORIGIN ?? environment.OPCUA_STUDIO_PUBLIC_ORIGIN,
    production ? "" : `http://localhost:${environment.PORT ?? "8080"}`,
  );
  const publicUrl = new URL(publicOrigin);
  const localhost = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(publicUrl.hostname);
  if (!publicOrigin.startsWith("https://") && (production || !localhost)) {
    throw new Error("An HTTPS public origin is required outside localhost development.");
  }
  if (!production && publicUrl.protocol === "http:" && !insecureDevelopment) {
    throw new Error("HTTP requires explicit localhost insecure development mode.");
  }
  const passwordFile = environment.OPCUA_STUDIO_ADMIN_PASSWORD_FILE ?? environment.OSTUDIO_ADMIN_PASSWORD_FILE;
  const directPassword = environment.OPCUA_STUDIO_ADMIN_PASSWORD ?? environment.OSTUDIO_ADMIN_PASSWORD;
  if (production && !passwordFile) throw new Error("Production requires an admin password file.");
  if (insecureDevelopment && !localhost) throw new Error("Insecure development mode is localhost-only.");
  if (directPassword && !insecureDevelopment)
    throw new Error("Direct admin passwords require explicit insecure development mode.");
  if (production && insecureDevelopment) throw new Error("Insecure development mode is not available in production.");
  let password = randomBytes(32).toString("base64url");
  if (passwordFile) {
    let contents: Buffer;
    try {
      contents = await readFile(passwordFile);
    } catch (error) {
      throw new Error("Unable to read the admin password file.", { cause: error });
    }
    password = contents.toString("utf8").trim();
    contents.fill(0);
  } else if (directPassword) {
    password = directPassword;
  }
  if (password.length < 12) throw new Error("The admin password must contain at least 12 characters.");
  return {
    publicOrigin,
    secureCookies: publicUrl.protocol === "https:",
    insecureDevelopment: !production && (insecureDevelopment || publicUrl.protocol !== "https:"),
    trustedProxyCidrs: (environment.OSTUDIO_TRUSTED_PROXY_CIDRS ?? environment.OPCUA_STUDIO_TRUSTED_PROXY_CIDRS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    password,
    controllerLeaseMilliseconds: positiveMilliseconds(
      environment.OSTUDIO_CONTROLLER_LEASE_MS ?? environment.OPCUA_STUDIO_CONTROLLER_LEASE_MS,
      "OSTUDIO_CONTROLLER_LEASE_MS",
      DEFAULT_CONTROLLER_LEASE_MS,
    ),
    controllerDisconnectGraceMilliseconds: positiveMilliseconds(
      environment.OSTUDIO_CONTROLLER_DISCONNECT_GRACE_MS ?? environment.OPCUA_STUDIO_CONTROLLER_DISCONNECT_GRACE_MS,
      "OSTUDIO_CONTROLLER_DISCONNECT_GRACE_MS",
      DEFAULT_CONTROLLER_DISCONNECT_GRACE_MS,
    ),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function cookieValue(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function requestPath(request: FastifyRequest, origin: string): string {
  return new URL(request.url, origin).pathname;
}
function sameOrigin(request: FastifyRequest, config: RuntimeConfig): boolean {
  return request.headers.origin === config.publicOrigin;
}

function securityHeaders(reply: FastifyReply): void {
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
}

function unauthorized(reply: FastifyReply): void {
  void reply.code(401).send(errorBody("authentication_required", "Authentication is required."));
}

function controllerState(
  session: AuthSession,
  owner: string | undefined,
  generation: number,
  expiresAt: number | undefined,
  recoverableSessionId?: string,
): Snapshot["controller"] {
  return {
    role: owner === session.id ? "controller" : "observer",
    controllerGeneration: generation,
    ...(owner === session.id && expiresAt ? { leaseExpiresAt: new Date(expiresAt).toISOString() } : {}),
    ...(recoverableSessionId === session.id ? { recoverable: true } : {}),
  };
}

export async function createServer(options: ServerOptions = {}): Promise<WebServer> {
  const environment = options.env ?? process.env;
  const config = await runtimeConfig(environment);
  const authenticator = await createAuthenticator({ password: config.password, now: options.now });
  config.password = "";
  const now = options.now ?? Date.now;
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
    clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  };
  const server = Fastify({
    logger: true,
    bodyLimit: 1024 * 1024,
    trustProxy: config.trustedProxyCidrs.length > 0 ? config.trustedProxyCidrs : false,
  }) as unknown as WebServer;
  if (config.insecureDevelopment)
    server.log.warn("Insecure development mode is enabled; do not expose this server publicly.");
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const assetsDirectory =
    options.assetsDirectory ?? environment.OSTUDIO_WEB_ASSETS_DIR ?? path.resolve(moduleDirectory, "../../client/dist");
  const hasClientAssets = await fileExists(path.join(assetsDirectory, "index.html"));
  if (environment.NODE_ENV === "production" && !hasClientAssets) {
    throw new Error("Production assets are missing index.html.");
  }
  const buildVersion = environment.OSTUDIO_BUILD_VERSION ?? "0.0.0";
  const controllerLeaseMilliseconds = options.controllerLeaseMilliseconds ?? config.controllerLeaseMilliseconds;
  const controllerDisconnectGraceMilliseconds =
    options.controllerDisconnectGraceMilliseconds ?? config.controllerDisconnectGraceMilliseconds;
  if (!Number.isSafeInteger(controllerLeaseMilliseconds) || controllerLeaseMilliseconds <= 0)
    throw new Error("controllerLeaseMilliseconds must be a positive integer.");
  if (!Number.isSafeInteger(controllerDisconnectGraceMilliseconds) || controllerDisconnectGraceMilliseconds <= 0)
    throw new Error("controllerDisconnectGraceMilliseconds must be a positive integer.");
  let controllerOwner: string | undefined;
  let controllerSession: AuthSession | undefined;
  let recoverableControllerSessionId: string | undefined;
  let controllerGeneration = 0;
  const diagnostics: ConnectionDiagnostic[] = [];
  const recordConnectionDiagnostic = (
    record: Pick<ConnectionDiagnostic, "code" | "outcome"> & { endpoint?: string },
  ): void => {
    let endpoint = "OPC UA Server";
    try {
      if (record.endpoint) {
        const url = new URL(record.endpoint);
        if (url.protocol === "opc.tcp:") endpoint = `${url.protocol}//${url.host}`.slice(0, 256);
      }
    } catch {
      /* No untrusted endpoint text reaches diagnostics. */
    }
    diagnostics.push({
      code: record.code,
      actor: "admin",
      endpoint,
      controllerGeneration,
      operationId: `op-${randomBytes(16).toString("hex")}`,
      correlationId: `cor-${randomBytes(16).toString("hex")}`,
      outcome: record.outcome,
    });
    if (diagnostics.length > 100) diagnostics.shift();
  };
  let controllerLeaseExpiresAt: number | undefined;
  let controllerExpiryTimer: unknown;
  let disconnectGraceTimer: unknown;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let controlQueue = Promise.resolve();
  const serializeControl = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const result = controlQueue.then(operation, operation);
    controlQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  type EventClient = {
    sessionId: string;
    response: import("node:http").ServerResponse;
    queue: EventEnvelope[];
    paused: boolean;
    closed: boolean;
    heartbeat: unknown;
  };
  const eventClients = new Set<EventClient>();
  const eventHistory: EventEnvelope[] = [];
  let sequence = 0;
  const eventData = (event: EventEnvelope): string => `data: ${JSON.stringify(event)}\n\n`;
  const closeEventClient = (client: EventClient): void => {
    if (client.closed) return;
    client.closed = true;
    eventClients.delete(client);
    if (timers.clearInterval) timers.clearInterval(client.heartbeat);
    else clearInterval(client.heartbeat as NodeJS.Timeout);
    client.response.end();
  };
  const expireEventClient = (client: EventClient): boolean => {
    if (authenticator.valid(client.sessionId)) return false;
    if (client.sessionId === controllerOwner) void revokeExpiredController();
    closeEventClient(client);
    return true;
  };
  const flushEventClient = (client: EventClient): void => {
    if (client.closed) return;
    if (expireEventClient(client)) return;
    client.paused = false;
    while (client.queue.length > 0 && !client.paused && !client.closed) {
      const event = client.queue.shift()!;
      try {
        client.paused = !client.response.write(eventData(event));
      } catch {
        closeEventClient(client);
      }
    }
  };
  const sendEvent = (client: EventClient, event: EventEnvelope): void => {
    if (client.closed) return;
    if (expireEventClient(client)) return;
    if (client.paused) {
      if (event.type === "live-value-changed") {
        const nodeId = "nodeId" in event.payload ? event.payload.nodeId : undefined;
        const index =
          nodeId === undefined
            ? -1
            : client.queue.findIndex(
                (queued) =>
                  queued.type === event.type && "nodeId" in queued.payload && queued.payload.nodeId === nodeId,
              );
        if (index >= 0) {
          client.queue.splice(index, 1);
          client.queue.push(event);
          return;
        }
      }
      if (client.queue.length >= SSE_QUEUE_LIMIT) {
        closeEventClient(client);
        return;
      }
      client.queue.push(event);
      return;
    }
    try {
      client.paused = !client.response.write(eventData(event));
    } catch {
      closeEventClient(client);
    }
  };
  const publishEvent = (type: EventType, payload: EventEnvelope["payload"]): EventEnvelope => {
    const event = { sequence: ++sequence, buildVersion, type, payload } as EventEnvelope;
    eventHistory.push(event);
    if (eventHistory.length > SSE_QUEUE_LIMIT) eventHistory.shift();
    for (const client of eventClients) sendEvent(client, event);
    return event;
  };
  const eventSequence = (): number => sequence;
  const clearDisconnectGrace = (): void => {
    if (disconnectGraceTimer !== undefined) timers.clearTimeout(disconnectGraceTimer);
    disconnectGraceTimer = undefined;
  };
  const revalidateControllerSession = (session: AuthSession, reply: FastifyReply): boolean => {
    if (authenticator.valid(session.id)) return true;
    unauthorized(reply);
    return false;
  };
  const restoreReadOnly = (): Promise<void> => Promise.resolve(options.runtime?.setReadOnly?.(true));
  const disconnectRuntime = async (message: string, bounded = false): Promise<void> => {
    const disconnect = options.runtime?.disconnect ?? options.runtime?.close;
    if (!disconnect) return;
    try {
      const operation = disconnect();
      if (bounded) await Promise.race([operation, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
      else await operation;
    } catch {
      server.log.error(message);
    }
  };
  const disconnectAfterGrace = (): void => {
    disconnectGraceTimer = undefined;
    void serializeControl(async () => {
      if (shuttingDown || controllerOwner !== undefined || recoverableControllerSessionId === undefined) return;
      recoverableControllerSessionId = undefined;
      await disconnectRuntime("Unable to disconnect the runtime after controller loss.");
    });
  };
  const scheduleDisconnectGrace = (): void => {
    clearDisconnectGrace();
    disconnectGraceTimer = timers.setTimeout(disconnectAfterGrace, controllerDisconnectGraceMilliseconds);
  };
  const revokeControllerState = async (): Promise<void> => {
    if (controllerOwner === undefined) return;
    recoverableControllerSessionId = controllerOwner;
    controllerOwner = undefined;
    controllerSession = undefined;
    controllerLeaseExpiresAt = undefined;
    if (controllerExpiryTimer !== undefined) timers.clearTimeout(controllerExpiryTimer);
    controllerExpiryTimer = undefined;
    controllerGeneration += 1;
    scheduleDisconnectGrace();
    publishEvent("ownership-changed", { role: "observer", controllerGeneration });
    try {
      await restoreReadOnly();
    } catch (error) {
      clearDisconnectGrace();
      recoverableControllerSessionId = undefined;
      await disconnectRuntime("Unable to disconnect the runtime after Read-Only Mode restoration failed.");
      throw error;
    }
  };
  const grantController = (session: AuthSession, generationAlreadyChanged = false): void => {
    recoverableControllerSessionId = undefined;
    clearDisconnectGrace();
    controllerOwner = session.id;
    controllerSession = session;
    if (!generationAlreadyChanged) controllerGeneration += 1;
    controllerLeaseExpiresAt = now() + controllerLeaseMilliseconds;
    scheduleControllerExpiry();
    publishEvent("ownership-changed", { role: "controller", controllerGeneration });
  };
  const revokeController = (): Promise<void> =>
    commandInFlight && controllerOwner !== undefined
      ? revokeControllerState()
      : serializeControl(revokeControllerState);
  async function revokeExpiredController(): Promise<void> {
    try {
      await revokeController();
    } catch {
      server.log.error("Unable to restore Read-Only Mode after authentication expiry.");
    }
  }
  const expireController = async (): Promise<void> => {
    const authenticationExpired = controllerOwner !== undefined && !authenticator.valid(controllerOwner);
    if (
      commandInFlight &&
      (authenticationExpired || (controllerLeaseExpiresAt !== undefined && now() >= controllerLeaseExpiresAt))
    )
      await revokeControllerState();
    return serializeControl(async () => {
      if (controllerOwner === undefined) return;
      if (!authenticator.valid(controllerOwner)) {
        await revokeControllerState();
        return;
      }
      if (controllerLeaseExpiresAt === undefined || now() < controllerLeaseExpiresAt) {
        scheduleControllerExpiry();
        return;
      }
      await revokeControllerState();
    });
  };
  const onControllerExpired = (): void => {
    void expireController().catch(() => server.log.error("Unable to restore Read-Only Mode after controller expiry."));
  };
  const scheduleControllerExpiry = (): void => {
    if (controllerExpiryTimer !== undefined) timers.clearTimeout(controllerExpiryTimer);
    controllerExpiryTimer = undefined;
    if (controllerLeaseExpiresAt === undefined) return;
    const authenticationExpiresAt = controllerSession
      ? Math.min(controllerSession.expiresAt, controllerSession.lastActivityAt + authConstants.inactivityMs)
      : Number.POSITIVE_INFINITY;
    const expiresAt = Math.min(controllerLeaseExpiresAt, authenticationExpiresAt);
    controllerExpiryTimer = timers.setTimeout(onControllerExpired, Math.max(0, expiresAt - now()));
  };

  server.decorate("eventSequence", eventSequence);
  server.decorate("publishEvent", publishEvent);
  server.decorate("recordConnectionDiagnostic", recordConnectionDiagnostic);
  server.decorate("shutdown", async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      if (controllerExpiryTimer !== undefined) timers.clearTimeout(controllerExpiryTimer);
      controllerExpiryTimer = undefined;
      clearDisconnectGrace();
      controllerOwner = undefined;
      controllerSession = undefined;
      recoverableControllerSessionId = undefined;
      controllerLeaseExpiresAt = undefined;
      controllerGeneration += 1;
      await serializeControl(restoreReadOnly);
      for (const client of [...eventClients]) closeEventClient(client);
      await disconnectRuntime("Unable to disconnect the runtime during shutdown.", true);
      try {
        await server.close();
      } finally {
        await Promise.resolve(options.runtime?.flushLogs?.()).catch(() => undefined);
      }
    })();
    return shutdownPromise;
  });
  server.addHook("onClose", async () => {
    if (controllerExpiryTimer !== undefined) timers.clearTimeout(controllerExpiryTimer);
    controllerExpiryTimer = undefined;
    clearDisconnectGrace();
    for (const client of [...eventClients]) closeEventClient(client);
  });

  server.addHook("onRequest", async (request, reply) => {
    securityHeaders(reply);
    if (shuttingDown) {
      void reply.code(503).send(errorBody("internal_error", "The server is shutting down."));
      return;
    }
    const current = request as RequestWithSession;
    const pathname = requestPath(request, config.publicOrigin);
    const isLogin = pathname === "/api/v1/auth/login";
    const isAuthSession = pathname === "/api/v1/auth/session";
    const protectedApi =
      pathname === "/api/v1/auth/logout" ||
      ["/api/v1/build", "/api/v1/snapshot", "/api/v1/events", "/api/v1/diagnostics"].includes(pathname) ||
      pathname.startsWith("/api/v1/controller/") ||
      pathname.startsWith("/api/v1/opcua/") ||
      pathname.startsWith("/api/v1/address-space/") ||
      pathname.startsWith("/api/v1/saved-connections");
    if (isLogin && !sameOrigin(request, config)) {
      void reply.code(403).send(errorBody("origin_rejected", "The request origin is not allowed."));
      return;
    }
    if (!protectedApi) {
      if (isAuthSession) {
        const token = cookieValue(request.headers.cookie);
        current.authSession = authenticator.session(token);
        if (current.authSession?.id === controllerOwner) scheduleControllerExpiry();
        if (!current.authSession && token === controllerOwner) await revokeExpiredController();
      }
      return;
    }
    if ((request.method !== "GET" || pathname === "/api/v1/events") && !sameOrigin(request, config)) {
      void reply.code(403).send(errorBody("origin_rejected", "The request origin is not allowed."));
      return;
    }
    const token = cookieValue(request.headers.cookie);
    const session = authenticator.session(token);
    if (!session) {
      if (token === controllerOwner) await revokeExpiredController();
      unauthorized(reply);
      return;
    }
    current.authSession = session;
    if (session.id === controllerOwner) scheduleControllerExpiry();
  });

  server.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (statusCode === 413)
      return void reply.code(413).send(errorBody("request_too_large", "The request is too large."));
    if (statusCode === 400) return void reply.code(400).send(errorBody("bad_request", "The request is invalid."));
    request.log.error("request failed");
    return void reply.code(500).send(errorBody("internal_error", "The request could not be completed."));
  });

  server.get("/health/live", async () => ({ status: "ok" }));
  server.get("/health/ready", async () => ({ status: "ready" }));
  server.post(
    "/api/v1/auth/login",
    {
      schema: {
        body: loginRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as { username: string; password: string };
      const result = await authenticator.login(body.username, body.password, request.ip);
      if (!result.ok) {
        if (result.retryAfterMs !== undefined) reply.header("Retry-After", Math.ceil(result.retryAfterMs / 1000));
        return reply.code(401).send(errorBody("authentication_required", authConstants.genericFailure));
      }
      reply.header("Set-Cookie", `${authenticator.cookie(result.token)}${config.secureCookies ? "; Secure" : ""}`);
      return reply.code(204).send();
    },
  );
  server.post("/api/v1/auth/logout", async (request, reply) => {
    const session = (request as RequestWithSession).authSession!;
    authenticator.logout(cookieValue(request.headers.cookie));
    for (const client of [...eventClients]) if (client.sessionId === session.id) closeEventClient(client);
    const revokedDuringCommand = controllerOwner === session.id && commandInFlight;
    if (revokedDuringCommand) {
      logoutRevokedSession = session.id;
      await revokeControllerState();
    }
    await serializeControl(async () => {
      if (controllerOwner !== session.id && recoverableControllerSessionId !== session.id) {
        if (logoutRevokedSession === session.id) logoutRevokedSession = undefined;
        return;
      }
      if (controllerOwner === session.id) await revokeControllerState();
      clearDisconnectGrace();
      recoverableControllerSessionId = undefined;
      await disconnectRuntime("Unable to disconnect the runtime after logout.");
      if (logoutRevokedSession === session.id) logoutRevokedSession = undefined;
    });
    reply.header(
      "Set-Cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${config.secureCookies ? "; Secure" : ""}; Max-Age=0`,
    );
    return reply.code(204).send();
  });
  server.get("/api/v1/auth/session", async (request) => {
    const session = (request as RequestWithSession).authSession;
    return { authenticated: Boolean(session), insecureDevelopment: config.insecureDevelopment };
  });
  server.get("/api/v1/build", async () => ({ buildVersion }));
  const currentSnapshot = (request: FastifyRequest): Snapshot => {
    const session = (request as RequestWithSession).authSession!;
    const snapshotSequence = sequence;
    const runtimeSnapshot = options.runtime?.snapshot?.();
    return {
      ...(runtimeSnapshot ?? {
        safety: { readOnly: true, safetyGeneration: 1 },
        connection: { state: "disconnected" as const },
        nodes: [],
      }),
      sequence: snapshotSequence,
      buildVersion,
      generatedAt: new Date(now()).toISOString(),
      controller: controllerState(
        session,
        controllerOwner,
        controllerGeneration,
        controllerLeaseExpiresAt,
        recoverableControllerSessionId,
      ),
    } satisfies Snapshot;
  };
  server.get("/api/v1/snapshot", async (request) => currentSnapshot(request));
  server.post("/api/v1/controller/attach", async (request, reply) => {
    const session = (request as RequestWithSession).authSession!;
    let authorized = true;
    await serializeControl(async () => {
      if (!(authorized = revalidateControllerSession(session, reply))) return;
      if (controllerOwner !== undefined) {
        if (controllerOwner === session.id) {
          controllerLeaseExpiresAt = now() + controllerLeaseMilliseconds;
          scheduleControllerExpiry();
        }
        return;
      }
      if (recoverableControllerSessionId !== undefined) return;
      grantController(session);
    });
    if (!authorized) return;
    return reply.send(
      controllerState(
        session,
        controllerOwner,
        controllerGeneration,
        controllerLeaseExpiresAt,
        recoverableControllerSessionId,
      ),
    );
  });
  server.post("/api/v1/controller/recover", async (request, reply) => {
    const session = (request as RequestWithSession).authSession!;
    let authorized = true;
    let recovered = false;
    await serializeControl(async () => {
      if (!(authorized = revalidateControllerSession(session, reply))) return;
      if (controllerOwner !== undefined || recoverableControllerSessionId !== session.id) return;
      await restoreReadOnly();
      grantController(session);
      recovered = true;
    });
    if (!authorized) return;
    if (!recovered)
      return reply
        .code(409)
        .send(errorBody("controller_generation_mismatch", "The controller recovery is no longer current."));
    return reply.send(
      controllerState(
        session,
        controllerOwner,
        controllerGeneration,
        controllerLeaseExpiresAt,
        recoverableControllerSessionId,
      ),
    );
  });
  server.post("/api/v1/controller/takeover", async (request, reply) => {
    const session = (request as RequestWithSession).authSession!;
    if (!revalidateControllerSession(session, reply)) return;
    // Revoke immediately even when an old controller's OPC UA request is still in flight.
    if (commandInFlight && controllerOwner !== undefined) await revokeControllerState();
    let authorized = true;
    await serializeControl(async () => {
      if (!(authorized = revalidateControllerSession(session, reply))) return;
      const hadController = controllerOwner !== undefined;
      if (hadController) await revokeControllerState();
      else await restoreReadOnly();
      grantController(session, hadController);
    });
    if (!authorized) return;
    return reply.send(
      controllerState(
        session,
        controllerOwner,
        controllerGeneration,
        controllerLeaseExpiresAt,
        recoverableControllerSessionId,
      ),
    );
  });
  server.post("/api/v1/controller/renew", async (request, reply) => {
    const session = (request as RequestWithSession).authSession!;
    const generation = Number(new URL(request.url, config.publicOrigin).searchParams.get("controllerGeneration"));
    return serializeControl(async () => {
      if (!revalidateControllerSession(session, reply)) return;
      if (
        !Number.isSafeInteger(generation) ||
        generation !== controllerGeneration ||
        controllerOwner !== session.id ||
        controllerLeaseExpiresAt === undefined ||
        now() >= controllerLeaseExpiresAt
      ) {
        if (
          controllerOwner === session.id &&
          controllerLeaseExpiresAt !== undefined &&
          now() >= controllerLeaseExpiresAt
        )
          await revokeControllerState();
        return reply
          .code(409)
          .send(errorBody("controller_generation_mismatch", "The controller lease is no longer current."));
      }
      controllerLeaseExpiresAt = now() + controllerLeaseMilliseconds;
      scheduleControllerExpiry();
      return reply.code(204).send();
    });
  });
  let commandInFlight = false;
  let logoutRevokedSession: string | undefined;
  const controllerCommand = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: () => Promise<T>,
    connectionChange = false,
  ): Promise<T | undefined> =>
    serializeControl(async () => {
      const session = (request as RequestWithSession).authSession!;
      if (!revalidateControllerSession(session, reply)) return;
      const generation = Number(new URL(request.url, config.publicOrigin).searchParams.get("controllerGeneration"));
      if (controllerOwner === session.id && controllerLeaseExpiresAt !== undefined && now() >= controllerLeaseExpiresAt)
        await revokeControllerState();
      if (controllerOwner !== session.id || !Number.isSafeInteger(generation) || generation !== controllerGeneration) {
        void reply
          .code(409)
          .send(errorBody("controller_generation_mismatch", "The controller lease is no longer current."));
        return;
      }
      commandInFlight = true;
      try {
        const result = await operation();
        if (
          !authenticator.valid(session.id) ||
          controllerOwner !== session.id ||
          generation !== controllerGeneration ||
          controllerLeaseExpiresAt === undefined ||
          now() >= controllerLeaseExpiresAt
        ) {
          if (controllerOwner === session.id) await revokeControllerState();
          if (connectionChange && logoutRevokedSession !== session.id)
            await disconnectRuntime("Unable to disconnect the runtime after controller loss.");
          void reply
            .code(409)
            .send(errorBody("controller_generation_mismatch", "The controller lease is no longer current."));
          return;
        }
        return result;
      } finally {
        commandInFlight = false;
      }
    });
  const requestBody = <T>(request: FastifyRequest): T | undefined => {
    const body = request.body;
    return body && typeof body === "object" ? (body as T) : undefined;
  };
  const sanitizeEndpoint = (value: unknown): string | undefined => {
    if (typeof value !== "string" || value.length === 0 || value.length > 2048) return undefined;
    try {
      const endpoint = new URL(value);
      if (endpoint.protocol !== "opc.tcp:" || !endpoint.hostname) return undefined;
      endpoint.username = "";
      endpoint.password = "";
      return `${endpoint.protocol}//${endpoint.host}${endpoint.pathname === "/" ? "" : endpoint.pathname}${endpoint.search}${endpoint.hash}`;
    } catch {
      return undefined;
    }
  };
  const endpointRequest = (request: FastifyRequest): EndpointDiscoveryRequest | undefined => {
    const body = requestBody<EndpointDiscoveryRequest>(request);
    const endpointUrl = sanitizeEndpoint(body?.endpointUrl);
    return endpointUrl === undefined ? undefined : { endpointUrl };
  };
  const savedConnectionId = (request: FastifyRequest): string | undefined => {
    const id = (request.params as { id?: unknown } | undefined)?.id;
    return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? id : undefined;
  };
  const savedConnectionRequest = (request: FastifyRequest): SavedConnectionRequest | undefined => {
    const body = requestBody<Partial<SavedConnectionRequest>>(request);
    if (
      !body ||
      typeof body.name !== "string" ||
      body.name.length < 1 ||
      body.name.length > 256 ||
      typeof body.endpoint !== "string" ||
      body.endpoint.length < 1 ||
      body.endpoint.length > 2048 ||
      typeof body.securityPolicy !== "string" ||
      body.securityPolicy.length < 1 ||
      body.securityPolicy.length > 256 ||
      !["None", "Sign", "SignAndEncrypt"].includes(body.securityMode ?? "")
    )
      return undefined;
    const endpoint = sanitizeEndpoint(body.endpoint);
    if (endpoint === undefined) return undefined;
    if (body.username !== undefined && (typeof body.username !== "string" || body.username.length > 256))
      return undefined;
    const hasValidPin = typeof body.serverCertificatePin === "string" && SHA256_PIN.test(body.serverCertificatePin);
    if (body.serverCertificatePin !== undefined && !hasValidPin) return undefined;
    if (body.certificateReviewRequired !== undefined && body.certificateReviewRequired !== true) return undefined;
    if (body.securityMode !== "None" && !hasValidPin && body.certificateReviewRequired !== true) return undefined;
    return { ...body, endpoint } as SavedConnectionRequest;
  };
  const savedConnectionConnectRequest = (request: FastifyRequest): SavedConnectionConnectRequest => {
    const body = requestBody<{ userSecret?: unknown; password?: unknown }>(request);
    const secret = body?.userSecret ?? body?.password;
    return secret === undefined
      ? {}
      : typeof secret === "string" && secret.length <= 1024
        ? { userSecret: secret }
        : (() => {
            throw new Error("invalid user secret");
          })();
  };
  const runtimeError = (
    reply: FastifyReply,
    code: "discovery_failed" | "connection_failed" | "operation_failed",
  ): void => {
    void reply.code(502).send(errorBody(code, "The OPC UA operation could not be completed."));
  };
  server.get(
    "/api/v1/saved-connections",
    async () => (await options.runtime?.listSavedConnections?.()) ?? { mode: "ephemeral", savedConnections: [] },
  );
  server.put("/api/v1/saved-connections/:id", async (request, reply) =>
    controllerCommand(request, reply, async () => {
      const id = savedConnectionId(request);
      const body = savedConnectionRequest(request);
      if (!id || !body) return void reply.code(400).send(errorBody("bad_request", "The Saved Connection is invalid."));
      if (!options.runtime?.saveSavedConnection) return runtimeError(reply, "operation_failed");
      try {
        await options.runtime.saveSavedConnection(id, body);
        return reply.code(204).send();
      } catch {
        return runtimeError(reply, "operation_failed");
      }
    }),
  );
  server.delete("/api/v1/saved-connections/:id/delete", async (request, reply) =>
    controllerCommand(request, reply, async () => {
      const id = savedConnectionId(request);
      if (!id) return void reply.code(400).send(errorBody("bad_request", "The Saved Connection ID is invalid."));
      if (!options.runtime?.deleteSavedConnection) return runtimeError(reply, "operation_failed");
      try {
        await options.runtime.deleteSavedConnection(id);
        return reply.code(204).send();
      } catch {
        return runtimeError(reply, "operation_failed");
      }
    }),
  );
  server.post("/api/v1/saved-connections/:id/connect", async (request, reply) =>
    controllerCommand(
      request,
      reply,
      async () => {
        const id = savedConnectionId(request);
        if (!id) return void reply.code(400).send(errorBody("bad_request", "The Saved Connection ID is invalid."));
        if (!options.runtime?.connectSavedConnection) return runtimeError(reply, "connection_failed");
        let body: SavedConnectionConnectRequest;
        try {
          body = savedConnectionConnectRequest(request);
          const result = await options.runtime.connectSavedConnection(id, body);
          if (result?.outcome === "not_found")
            return void reply
              .code(404)
              .send(errorBody("saved_connection_not_found", "The Saved Connection was not found."));
          return currentSnapshot(request);
        } catch {
          return runtimeError(reply, "connection_failed");
        }
      },
      true,
    ),
  );
  server.post("/api/v1/opcua/discover", async (request, reply) =>
    controllerCommand(request, reply, async () => {
      const body = endpointRequest(request);
      if (!body) return void reply.code(400).send(errorBody("bad_request", "The endpoint URL is invalid."));
      if (!options.runtime?.discover) return runtimeError(reply, "discovery_failed");
      try {
        return await options.runtime.discover(body);
      } catch {
        return runtimeError(reply, "discovery_failed");
      }
    }),
  );
  server.post("/api/v1/opcua/connect", async (request, reply) =>
    controllerCommand(
      request,
      reply,
      async () => {
        const body = endpointRequest(request);
        if (!body) return void reply.code(400).send(errorBody("bad_request", "The endpoint URL is invalid."));
        if (!options.runtime?.connect) return runtimeError(reply, "connection_failed");
        try {
          await options.runtime.connect(body);
          return currentSnapshot(request);
        } catch {
          return runtimeError(reply, "connection_failed");
        }
      },
      true,
    ),
  );
  server.post("/api/v1/opcua/disconnect", async (request, reply) =>
    controllerCommand(request, reply, async () => {
      if (!options.runtime?.disconnect) return runtimeError(reply, "operation_failed");
      try {
        await restoreReadOnly();
        await options.runtime.disconnect();
        publishEvent("connection-changed", { state: "disconnected" });
        return currentSnapshot(request);
      } catch {
        return runtimeError(reply, "operation_failed");
      }
    }),
  );
  server.post("/api/v1/address-space/browse", async (request, reply) =>
    controllerCommand(request, reply, async () => {
      const body = requestBody<BrowseRequest>(request);
      if (!body || typeof body.nodeId !== "string" || body.nodeId.length === 0 || body.nodeId.length > 512)
        return void reply.code(400).send(errorBody("bad_request", "The Address Space node identifier is invalid."));
      if (!options.runtime?.browse) return runtimeError(reply, "operation_failed");
      try {
        const result = await options.runtime.browse({ nodeId: body.nodeId });
        publishEvent("snapshot-required", { reason: "reconnect" });
        return result;
      } catch {
        return runtimeError(reply, "operation_failed");
      }
    }),
  );
  server.post("/api/v1/address-space/search", async (request, reply) =>
    controllerCommand(request, reply, async () => {
      const body = requestBody<{ query: string }>(request);
      if (!body || typeof body.query !== "string" || body.query.length > 256)
        return void reply.code(400).send(errorBody("bad_request", "The Address Space Search query is invalid."));
      if (!options.runtime?.search) return runtimeError(reply, "operation_failed");
      try {
        const result = await options.runtime.search({ query: body.query });
        publishEvent("snapshot-required", { reason: "reconnect" });
        return result;
      } catch {
        return runtimeError(reply, "operation_failed");
      }
    }),
  );
  server.get("/api/v1/diagnostics", async () => diagnostics);
  server.get("/api/v1/events", async (request, reply) => {
    const rawAfter = new URL(request.url, config.publicOrigin).searchParams.get("afterSequence");
    const after = rawAfter === null ? 0 : Number(rawAfter);
    if (!Number.isSafeInteger(after) || after < 0 || (rawAfter !== null && !/^\d+$/.test(rawAfter))) {
      return reply.code(400).send(errorBody("bad_request", "The event sequence is invalid."));
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    });
    const heartbeat = (): void => {
      if (client.closed) return;
      if (expireEventClient(client)) return;
      if (client.paused) return;
      try {
        client.paused = !client.response.write(": heartbeat\n\n");
      } catch {
        closeEventClient(client);
      }
    };
    const heartbeatHandle = timers.setInterval
      ? timers.setInterval(heartbeat, SSE_HEARTBEAT_MS)
      : setInterval(heartbeat, SSE_HEARTBEAT_MS);
    const client: EventClient = {
      sessionId: (request as RequestWithSession).authSession!.id,
      response: reply.raw,
      queue: [],
      paused: false,
      closed: false,
      heartbeat: heartbeatHandle,
    };
    if (typeof client.heartbeat === "object" && client.heartbeat !== null && "unref" in client.heartbeat)
      (client.heartbeat as NodeJS.Timeout).unref();
    eventClients.add(client);
    reply.raw.on("drain", () => flushEventClient(client));
    const oldest = eventHistory[0]?.sequence;
    if (after === 0) {
      publishEvent("snapshot-required", { reason: "initial" });
    } else if (after > sequence || (after < sequence && (oldest === undefined || after < oldest - 1))) {
      publishEvent("snapshot-required", { reason: "gap" });
    } else {
      for (const event of eventHistory) {
        if (event.sequence > after) sendEvent(client, event);
      }
    }
    const close = (): void => closeEventClient(client);
    request.raw.on("close", close);
    reply.raw.on("close", close);
  });

  if (hasClientAssets) {
    await server.register(fastifyStatic, { root: assetsDirectory, wildcard: false });
  }
  server.setNotFoundHandler(async (request, reply) => {
    const reservedPath = ["/api/", "/health/", "/assets/"].some((prefix) =>
      requestPath(request, config.publicOrigin).startsWith(prefix),
    );
    const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
    if (hasClientAssets && !reservedPath && acceptsHtml) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "not_found" });
  });
  return server;
}
