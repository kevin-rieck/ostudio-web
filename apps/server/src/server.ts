import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { loginRequestSchema, type EventEnvelope, type Snapshot } from "@ostudio/contracts";
import { createAuthenticator, authConstants, type AuthSession } from "./auth.js";

const SESSION_COOKIE = "ostudio_session";
const DEFAULT_CONTROLLER_LEASE_MS = 15_000;
const DEFAULT_CONTROLLER_DISCONNECT_GRACE_MS = 5 * 60_000;
const SSE_QUEUE_LIMIT = 100;
const SSE_HEARTBEAT_MS = 15_000;
type EventType = EventEnvelope["type"];
type Environment = NodeJS.ProcessEnv;
export interface TimerScheduler {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RuntimeShutdownHooks {
  snapshot?(): Snapshot;
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
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new Error(`${name} must be a positive number of milliseconds.`);
  return milliseconds;
}

function errorBody(code: string, message: string, operationId?: string): Record<string, unknown> {
  return { code, message, correlationId: `cor-${randomBytes(16).toString("base64url")}`, ...(operationId ? { operationId } : {}) };
}

function parseOrigin(value: string | undefined, fallback: string): string {
  const candidate = value ?? fallback;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("OSTUDIO_PUBLIC_ORIGIN must be a valid HTTP(S) public origin.");
  }
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("OSTUDIO_PUBLIC_ORIGIN must be a valid HTTP(S) public origin.");
  }
  return parsed.origin;
}

async function runtimeConfig(environment: Environment): Promise<RuntimeConfig> {
  const production = environment.NODE_ENV === "production";
  const insecureDevelopment = environment.OSTUDIO_INSECURE_DEV === "true" || environment.OPCUA_STUDIO_INSECURE_DEV === "true";
  const publicOrigin = parseOrigin(environment.OSTUDIO_PUBLIC_ORIGIN ?? environment.OPCUA_STUDIO_PUBLIC_ORIGIN, production ? "" : `http://localhost:${environment.PORT ?? "8080"}`);
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
  if (directPassword && !insecureDevelopment) throw new Error("Direct admin passwords require explicit insecure development mode.");
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
    trustedProxyCidrs: (environment.OSTUDIO_TRUSTED_PROXY_CIDRS ?? environment.OPCUA_STUDIO_TRUSTED_PROXY_CIDRS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    password,
    controllerLeaseMilliseconds: positiveMilliseconds(environment.OSTUDIO_CONTROLLER_LEASE_MS ?? environment.OPCUA_STUDIO_CONTROLLER_LEASE_MS, "OSTUDIO_CONTROLLER_LEASE_MS", DEFAULT_CONTROLLER_LEASE_MS),
    controllerDisconnectGraceMilliseconds: positiveMilliseconds(environment.OSTUDIO_CONTROLLER_DISCONNECT_GRACE_MS ?? environment.OPCUA_STUDIO_CONTROLLER_DISCONNECT_GRACE_MS, "OSTUDIO_CONTROLLER_DISCONNECT_GRACE_MS", DEFAULT_CONTROLLER_DISCONNECT_GRACE_MS),
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
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return undefined; }
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
  reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
}

function unauthorized(reply: FastifyReply): void {
  void reply.code(401).send(errorBody("authentication_required", "Authentication is required."));
}

function controllerState(session: AuthSession, owner: string | undefined, generation: number, expiresAt: number | undefined): Snapshot["controller"] {
  return {
    role: owner === session.id ? "controller" : "observer",
    controllerGeneration: generation,
    ...(owner === session.id && expiresAt ? { leaseExpiresAt: new Date(expiresAt).toISOString() } : {}),
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
  if (config.insecureDevelopment) server.log.warn("Insecure development mode is enabled; do not expose this server publicly.");
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const assetsDirectory = options.assetsDirectory ?? environment.OSTUDIO_WEB_ASSETS_DIR ?? path.resolve(moduleDirectory, "../../client/dist");
  const hasClientAssets = await fileExists(path.join(assetsDirectory, "index.html"));
  if (environment.NODE_ENV === "production" && !hasClientAssets) {
    throw new Error("Production assets are missing index.html.");
  }
  const buildVersion = environment.OSTUDIO_BUILD_VERSION ?? "0.0.0";
  const controllerLeaseMilliseconds = options.controllerLeaseMilliseconds ?? config.controllerLeaseMilliseconds;
  const controllerDisconnectGraceMilliseconds = options.controllerDisconnectGraceMilliseconds ?? config.controllerDisconnectGraceMilliseconds;
  if (!Number.isSafeInteger(controllerLeaseMilliseconds) || controllerLeaseMilliseconds <= 0) throw new Error("controllerLeaseMilliseconds must be a positive integer.");
  if (!Number.isSafeInteger(controllerDisconnectGraceMilliseconds) || controllerDisconnectGraceMilliseconds <= 0) throw new Error("controllerDisconnectGraceMilliseconds must be a positive integer.");
  let controllerOwner: string | undefined;
  let previousController: string | undefined;
  let controllerGeneration = 0;
  let controllerLeaseExpiresAt: number | undefined;
  let controllerExpiryTimer: unknown;
  let disconnectGraceTimer: unknown;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let controlQueue = Promise.resolve();
  const serializeControl = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const result = controlQueue.then(operation, operation);
    controlQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  type EventClient = {
    response: import("node:http").ServerResponse;
    queue: EventEnvelope[];
    paused: boolean;
    closed: boolean;
    heartbeat: NodeJS.Timeout;
  };
  const eventClients = new Set<EventClient>();
  const eventHistory: EventEnvelope[] = [];
  let sequence = 0;
  const eventData = (event: EventEnvelope): string => `data: ${JSON.stringify(event)}\n\n`;
  const closeEventClient = (client: EventClient): void => {
    if (client.closed) return;
    client.closed = true;
    eventClients.delete(client);
    clearInterval(client.heartbeat);
    client.response.end();
  };
  const flushEventClient = (client: EventClient): void => {
    if (client.closed) return;
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
    if (client.paused) {
      if (event.type === "live-value-changed") {
        const nodeId = "nodeId" in event.payload ? event.payload.nodeId : undefined;
        const index = nodeId === undefined ? -1 : client.queue.findIndex((queued) => queued.type === event.type && "nodeId" in queued.payload && queued.payload.nodeId === nodeId);
        if (index >= 0) {
          client.queue[index] = event;
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
  const restoreReadOnly = (): Promise<void> => Promise.resolve(options.runtime?.setReadOnly?.(true));
  const disconnectAfterGrace = (): void => {
    disconnectGraceTimer = undefined;
    void serializeControl(async () => {
      if (shuttingDown || controllerOwner !== undefined || previousController === undefined) return;
      const disconnect = options.runtime?.disconnect ?? options.runtime?.close;
      if (!disconnect) return;
      try {
        await disconnect();
      } catch {
        server.log.error("Unable to disconnect the runtime after controller loss.");
      }
    });
  };
  const scheduleDisconnectGrace = (): void => {
    clearDisconnectGrace();
    disconnectGraceTimer = timers.setTimeout(disconnectAfterGrace, controllerDisconnectGraceMilliseconds);
  };
  const revokeControllerState = async (): Promise<void> => {
    if (controllerOwner === undefined) return;
    await restoreReadOnly();
    previousController = controllerOwner;
    controllerOwner = undefined;
    controllerLeaseExpiresAt = undefined;
    controllerExpiryTimer = undefined;
    controllerGeneration += 1;
    scheduleDisconnectGrace();
    publishEvent("ownership-changed", { role: "observer", controllerGeneration });
  };
  const revokeController = (): Promise<void> => serializeControl(revokeControllerState);
  const expireController = (): Promise<void> => serializeControl(async () => {
    if (controllerLeaseExpiresAt === undefined || now() < controllerLeaseExpiresAt) {
      scheduleControllerExpiry();
      return;
    }
    await revokeControllerState();
  });
  const onControllerExpired = (): void => { void expireController().catch(() => server.log.error("Unable to restore Read-Only Mode after controller expiry.")); };
  const scheduleControllerExpiry = (): void => {
    if (controllerExpiryTimer !== undefined) timers.clearTimeout(controllerExpiryTimer);
    controllerExpiryTimer = undefined;
    if (controllerLeaseExpiresAt === undefined) return;
    controllerExpiryTimer = timers.setTimeout(onControllerExpired, Math.max(0, controllerLeaseExpiresAt - now()));
  };

  server.decorate("eventSequence", eventSequence);
  server.decorate("publishEvent", publishEvent);
  server.decorate("shutdown", async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      if (controllerExpiryTimer !== undefined) timers.clearTimeout(controllerExpiryTimer);
      controllerExpiryTimer = undefined;
      clearDisconnectGrace();
      controllerOwner = undefined;
      previousController = undefined;
      controllerLeaseExpiresAt = undefined;
      controllerGeneration += 1;
      await serializeControl(restoreReadOnly);
      for (const client of [...eventClients]) closeEventClient(client);
      const disconnect = options.runtime?.disconnect ?? options.runtime?.close;
      if (disconnect) {
        await Promise.race([
          disconnect().catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
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
    const protectedApi = pathname === "/api/v1/auth/logout" || ["/api/v1/build", "/api/v1/snapshot", "/api/v1/events", "/api/v1/diagnostics"].includes(pathname) || pathname.startsWith("/api/v1/controller/");
    if (isLogin && !sameOrigin(request, config)) {
      void reply.code(403).send(errorBody("origin_rejected", "The request origin is not allowed."));
      return;
    }
    if (!protectedApi) {
      if (isAuthSession) {
        const token = cookieValue(request.headers.cookie);
        current.authSession = authenticator.session(token);
        if (!current.authSession && token === controllerOwner) void revokeController().catch(() => server.log.error("Unable to restore Read-Only Mode after authentication expiry."));
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
      if (token === controllerOwner) void revokeController().catch(() => server.log.error("Unable to restore Read-Only Mode after authentication expiry."));
      unauthorized(reply);
      return;
    }
    current.authSession = session;
  });

  server.setErrorHandler((error, request, reply) => {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode === 413) return void reply.code(413).send(errorBody("request_too_large", "The request is too large."));
    if (statusCode === 400) return void reply.code(400).send(errorBody("bad_request", "The request is invalid."));
    request.log.error("request failed");
    return void reply.code(500).send(errorBody("internal_error", "The request could not be completed."));
  });

  server.get("/health/live", async () => ({ status: "ok" }));
  server.get("/health/ready", async () => ({ status: "ready" }));
  server.post("/api/v1/auth/login", {
    schema: {
      body: loginRequestSchema,
    },
  }, async (request, reply) => {
    const body = request.body as { username: string; password: string };
    const result = await authenticator.login(body.username, body.password, request.ip);
    if (!result.ok) {
      if (result.retryAfterMs !== undefined) reply.header("Retry-After", Math.ceil(result.retryAfterMs / 1000));
      return reply.code(401).send(errorBody("authentication_required", authConstants.genericFailure));
    }
    reply.header("Set-Cookie", `${authenticator.cookie(result.token)}${config.secureCookies ? "; Secure" : ""}`);
    return reply.code(204).send();
  });
  server.post("/api/v1/auth/logout", async (request, reply) => {
    const sessionId = (request as RequestWithSession).authSession?.id;
    await serializeControl(async () => {
      if (sessionId !== controllerOwner) return;
      await revokeControllerState();
      clearDisconnectGrace();
      previousController = undefined;
      const disconnect = options.runtime?.disconnect ?? options.runtime?.close;
      if (disconnect) {
        try {
          await disconnect();
        } catch {
          server.log.error("Unable to disconnect the runtime after logout.");
        }
      }
    });
    authenticator.logout(cookieValue(request.headers.cookie));
    reply.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${config.secureCookies ? "; Secure" : ""}; Max-Age=0`);
    return reply.code(204).send();
  });
  server.get("/api/v1/auth/session", async (request) => {
    const session = (request as RequestWithSession).authSession;
    return { authenticated: Boolean(session), insecureDevelopment: config.insecureDevelopment };
  });
  server.get("/api/v1/build", async () => ({ buildVersion }));
  server.get("/api/v1/snapshot", async (request) => {
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
      controller: controllerState(session, controllerOwner, controllerGeneration, controllerLeaseExpiresAt),
    } satisfies Snapshot;
  });
  server.post("/api/v1/controller/attach", async (request, reply) => {
    const session = (request as RequestWithSession).authSession!;
    await serializeControl(async () => {
      if (controllerOwner !== undefined) {
        if (controllerOwner === session.id) {
          controllerLeaseExpiresAt = now() + controllerLeaseMilliseconds;
          scheduleControllerExpiry();
        }
        return;
      }
      if (previousController !== undefined && previousController !== session.id) return;
      const recovering = previousController === session.id;
      if (recovering) await restoreReadOnly();
      previousController = undefined;
      clearDisconnectGrace();
      controllerOwner = session.id;
      controllerGeneration += 1;
      controllerLeaseExpiresAt = now() + controllerLeaseMilliseconds;
      scheduleControllerExpiry();
      publishEvent("ownership-changed", { role: "controller", controllerGeneration });
    });
    return reply.send(controllerState(session, controllerOwner, controllerGeneration, controllerLeaseExpiresAt));
  });
  server.post("/api/v1/controller/takeover", async (request, reply) => {
    const session = (request as RequestWithSession).authSession!;
    await serializeControl(async () => {
      await restoreReadOnly();
      clearDisconnectGrace();
      previousController = undefined;
      controllerOwner = session.id;
      controllerGeneration += 1;
      controllerLeaseExpiresAt = now() + controllerLeaseMilliseconds;
      scheduleControllerExpiry();
      publishEvent("ownership-changed", { role: "controller", controllerGeneration });
    });
    return reply.send(controllerState(session, controllerOwner, controllerGeneration, controllerLeaseExpiresAt));
  });
  server.post("/api/v1/controller/renew", async (request, reply) => {
    const session = (request as RequestWithSession).authSession!;
    const generation = Number(new URL(request.url, config.publicOrigin).searchParams.get("controllerGeneration"));
    return serializeControl(async () => {
      if (!Number.isSafeInteger(generation) || generation !== controllerGeneration || controllerOwner !== session.id || controllerLeaseExpiresAt === undefined || now() >= controllerLeaseExpiresAt) {
        if (controllerOwner === session.id && controllerLeaseExpiresAt !== undefined && now() >= controllerLeaseExpiresAt) await revokeControllerState();
        return reply.code(409).send(errorBody("controller_generation_mismatch", "The controller lease is no longer current."));
      }
      controllerLeaseExpiresAt = now() + controllerLeaseMilliseconds;
      scheduleControllerExpiry();
      return reply.code(204).send();
    });
  });
  server.get("/api/v1/diagnostics", async () => []);
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
    const client: EventClient = {
      response: reply.raw,
      queue: [],
      paused: false,
      closed: false,
      heartbeat: setInterval(() => {
        if (client.closed || client.paused) return;
        try {
          client.paused = !client.response.write(": heartbeat\n\n");
        } catch {
          closeEventClient(client);
        }
      }, SSE_HEARTBEAT_MS),
    };
    client.heartbeat.unref();
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
    const reservedPath = ["/api/", "/health/", "/assets/"].some((prefix) => requestPath(request, config.publicOrigin).startsWith(prefix));
    const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
    if (hasClientAssets && !reservedPath && acceptsHtml) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "not_found" });
  });
  return server;
}
