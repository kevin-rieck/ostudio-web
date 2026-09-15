import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type TimerScheduler, type WebServer } from "./server.js";

let server: WebServer | undefined;
const developmentEnvironment = { OSTUDIO_INSECURE_DEV: "true", OSTUDIO_ADMIN_PASSWORD: "correct horse battery staple", OSTUDIO_PUBLIC_ORIGIN: "http://localhost:8080" };

afterEach(async () => {
  await server?.shutdown();
  server = undefined;
});

describe("server routes", () => {
  it("requires an origin and password file in production", async () => {
    await expect(createServer({ env: { NODE_ENV: "production" } })).rejects.toThrow(/public origin/i);
    await expect(createServer({ env: { NODE_ENV: "production", OSTUDIO_PUBLIC_ORIGIN: "https://studio.example" } })).rejects.toThrow(/password file/i);
  });

  it("rejects non-localhost insecure development origins", async () => {
    await expect(createServer({ env: { OSTUDIO_INSECURE_DEV: "true", OSTUDIO_ADMIN_PASSWORD: "correct horse battery staple", OSTUDIO_PUBLIC_ORIGIN: "https://studio.example" } })).rejects.toThrow(/localhost-only/i);
  });

  it("emits restrictive browser headers and caps oversized requests", async () => {
    server = await createServer({ env: developmentEnvironment });
    const live = await server.inject({ method: "GET", url: "/health/live" });
    expect(live.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(live.headers["x-frame-options"]).toBe("DENY");
    const oversized = await server.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: "http://localhost:8080", "content-type": "application/json" }, payload: "x".repeat(1024 * 1024 + 1) });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ code: "request_too_large" });
  });

  it("authenticates the fixed admin with a secure HttpOnly session cookie", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ostudio-auth-"));
    const passwordFile = path.join(directory, "admin-password");
    const assetsDirectory = await mkdtemp(path.join(os.tmpdir(), "ostudio-assets-"));
    await writeFile(passwordFile, "correct horse battery staple");
    await writeFile(path.join(assetsDirectory, "index.html"), "<!doctype html>");
    server = await createServer({
      assetsDirectory,
      env: { NODE_ENV: "production", OSTUDIO_PUBLIC_ORIGIN: "https://studio.example", OPCUA_STUDIO_ADMIN_PASSWORD_FILE: passwordFile },
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "https://studio.example", "content-type": "application/json" },
      payload: { username: "admin", password: "correct horse battery staple" },
    });

    expect(login.statusCode).toBe(204);
    const cookie = login.headers["set-cookie"];
    expect(cookie).toMatch(/ostudio_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect((await server.inject({ method: "GET", url: "/api/v1/build" })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/api/v1/build", headers: { cookie: String(cookie) } })).statusCode).toBe(200);
  });

  it("uses one generic failed-login response and rejects cross-origin state changes", async () => {
    server = await createServer({ env: { OSTUDIO_INSECURE_DEV: "true", OSTUDIO_ADMIN_PASSWORD: "correct horse battery staple", OSTUDIO_PUBLIC_ORIGIN: "http://localhost:8080" } });
    const wrong = await server.inject({
      method: "POST", url: "/api/v1/auth/login", headers: { origin: "http://localhost:8080", "content-type": "application/json" },
      payload: { username: "admin", password: "not-the-password" },
    });
    const unknown = await server.inject({
      method: "POST", url: "/api/v1/auth/login", headers: { origin: "http://localhost:8080", "content-type": "application/json" },
      payload: { username: "nobody", password: "not-the-password" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: "authentication_required", message: "Invalid username or password." });
    expect(unknown.json()).toMatchObject({ code: "authentication_required", message: "Invalid username or password." });

    const crossOrigin = await server.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: "https://evil.example" }, payload: {} });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toMatchObject({ code: "origin_rejected" });
  });

  it("reports liveness without exposing application state", async () => {
    server = await createServer({ env: developmentEnvironment });

    const response = await server.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it.each(["/api/v1/missing", "/health/missing", "/assets/missing.js"])(
    "does not hide a missing reserved route behind the React shell: %s",
    async (url) => {
      server = await createServer({ env: developmentEnvironment });

      const response = await server.inject({
        method: "GET",
        url,
        headers: { accept: "text/html" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
    },
  );

  it("bootstraps an authenticated session, enforces query-safe CSRF checks, and logs out", async () => {
    server = await createServer({ env: { OSTUDIO_INSECURE_DEV: "true", OSTUDIO_ADMIN_PASSWORD: "correct horse battery staple", OSTUDIO_PUBLIC_ORIGIN: "http://localhost:8080" } });
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login?attempt=1",
      headers: { origin: "http://localhost:8080", "content-type": "application/json" },
      payload: { username: "admin", password: "correct horse battery staple" },
    });
    const cookie = String(login.headers["set-cookie"]);
    expect(login.statusCode).toBe(204);
    expect((await server.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } })).json()).toMatchObject({ authenticated: true });
    const invalidBody = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:8080", "content-type": "application/json" },
      payload: { username: "", password: "correct horse battery staple", extra: true },
    });
    expect(invalidBody.statusCode).toBe(400);
    const crossOrigin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login?attempt=2",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      payload: { username: "admin", password: "correct horse battery staple" },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { origin: "http://localhost:8080", cookie } })).statusCode).toBe(204);
    expect((await server.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } })).json()).toMatchObject({ authenticated: false });
  });

  it("expires controller leases on the clock without another request", async () => {
    let timestamp = 0;
    const scheduled: Array<{ callback: () => void; milliseconds: number }> = [];
    const timers: TimerScheduler = {
      setTimeout: (callback, milliseconds) => {
        const entry = { callback, milliseconds };
        scheduled.push(entry);
        return entry;
      },
      clearTimeout: (handle) => {
        const index = scheduled.indexOf(handle as (typeof scheduled)[number]);
        if (index >= 0) scheduled.splice(index, 1);
      },
    };
    server = await createServer({
      now: () => timestamp,
      timers,
      env: { OSTUDIO_INSECURE_DEV: "true", OSTUDIO_ADMIN_PASSWORD: "correct horse battery staple", OSTUDIO_PUBLIC_ORIGIN: "http://localhost:8080" },
    });
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: "http://localhost:8080" }, payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = String(login.headers["set-cookie"]);
    expect((await server.inject({ method: "POST", url: "/api/v1/controller/attach", headers: { origin: "http://localhost:8080", cookie } })).json()).toMatchObject({ role: "controller" });
    expect(scheduled).toHaveLength(1);
    timestamp = 15_000;
    scheduled.shift()!.callback();
    expect((await server.inject({ method: "GET", url: "/api/v1/snapshot", headers: { cookie } })).json()).toMatchObject({ controller: { role: "observer", controllerGeneration: 2 } });
  });

  it("revokes the old browser on takeover", async () => {
    server = await createServer({ env: { OSTUDIO_INSECURE_DEV: "true", OSTUDIO_ADMIN_PASSWORD: "correct horse battery staple", OSTUDIO_PUBLIC_ORIGIN: "http://localhost:8080" } });
    const login = async (): Promise<string> => {
      const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: "http://localhost:8080" }, payload: { username: "admin", password: "correct horse battery staple" } });
      return String(response.headers["set-cookie"]);
    };
    const first = await login();
    const second = await login();
    await server.inject({ method: "POST", url: "/api/v1/controller/attach", headers: { origin: "http://localhost:8080", cookie: first } });
    expect((await server.inject({ method: "POST", url: "/api/v1/controller/takeover", headers: { origin: "http://localhost:8080", cookie: second } })).json()).toMatchObject({ role: "controller" });
    expect((await server.inject({ method: "POST", url: "/api/v1/controller/renew", headers: { origin: "http://localhost:8080", cookie: first } })).statusCode).toBe(409);
  });

  it("uses server-owned event sequences and emits a gap resynchronization", async () => {
    server = await createServer({ env: { OSTUDIO_INSECURE_DEV: "true", OSTUDIO_ADMIN_PASSWORD: "correct horse battery staple", OSTUDIO_PUBLIC_ORIGIN: "http://localhost:8080" } });
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: "http://localhost:8080" }, payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = String(login.headers["set-cookie"]);
    const initialRequest = server.inject({ method: "GET", url: "/api/v1/events?afterSequence=0", headers: { origin: "http://localhost:8080", cookie } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await server.shutdown();
    const initial = await initialRequest;
    const initialEvent = JSON.parse(initial.body.slice(initial.body.indexOf("data: ") + 6).trim()) as { sequence: number };
    expect(initialEvent.sequence).toBe(1);

    server = await createServer({ env: { OSTUDIO_INSECURE_DEV: "true", OSTUDIO_ADMIN_PASSWORD: "correct horse battery staple", OSTUDIO_PUBLIC_ORIGIN: "http://localhost:8080" } });
    const secondLogin = await server.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: "http://localhost:8080" }, payload: { username: "admin", password: "correct horse battery staple" } });
    const secondCookie = String(secondLogin.headers["set-cookie"]);
    for (let index = 0; index < 102; index += 1) server.publishEvent("snapshot-required", { reason: "reconnect" });
    const gapRequest = server.inject({ method: "GET", url: "/api/v1/events?afterSequence=1", headers: { origin: "http://localhost:8080", cookie: secondCookie } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await server.shutdown();
    const gap = await gapRequest;
    const gapEvent = JSON.parse(gap.body.slice(gap.body.indexOf("data: ") + 6).trim()) as { sequence: number; payload: { reason: string } };
    expect(gapEvent.sequence).toBeGreaterThan(initialEvent.sequence);
    expect(gapEvent.payload.reason).toBe("gap");
    expect(server.eventSequence()).toBe(gapEvent.sequence);
  });

  it("rejects remote HTTP password-file deployments and missing production assets", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ostudio-production-"));
    const passwordFile = path.join(directory, "admin-password");
    await writeFile(passwordFile, "correct horse battery staple");
    await expect(createServer({ env: { OSTUDIO_PUBLIC_ORIGIN: "http://localhost:8080", OPCUA_STUDIO_ADMIN_PASSWORD_FILE: passwordFile } })).rejects.toThrow(/explicit/i);
    await expect(createServer({ env: { NODE_ENV: "production", OSTUDIO_PUBLIC_ORIGIN: "http://studio.example", OPCUA_STUDIO_ADMIN_PASSWORD_FILE: passwordFile } })).rejects.toThrow(/https/i);
    await expect(createServer({ env: { NODE_ENV: "production", OSTUDIO_PUBLIC_ORIGIN: "https://studio.example", OPCUA_STUDIO_ADMIN_PASSWORD_FILE: passwordFile }, assetsDirectory: path.join(directory, "empty") })).rejects.toThrow(/assets/i);
  });

  it("ignores spoofed forwarded addresses unless a proxy is explicitly trusted", async () => {
    server = await createServer({ env: developmentEnvironment });
    const request = (password: string, remoteAddress: string, forwarded: string) => server!.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress,
      headers: { origin: "http://localhost:8080", "x-forwarded-for": forwarded },
      payload: { username: "admin", password },
    });
    for (let attempt = 0; attempt < 4; attempt += 1) await request("wrong password", "10.0.0.1", `192.0.2.${attempt + 1}`);
    await request("correct horse battery staple", "10.0.0.2", "198.51.100.1");
    const fifth = await request("wrong password", "10.0.0.1", "198.51.100.99");
    expect(fifth.headers["retry-after"]).toBeDefined();
  });

  it("redacts internal failures and emits the contract error code", async () => {
    server = await createServer({ env: developmentEnvironment });
    server.get("/test-internal-error", async () => { throw new Error("secret stack detail"); });
    const response = await server.inject({ method: "GET", url: "/test-internal-error" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "internal_error" });
    expect(response.body).not.toContain("operationId");
    expect(response.body).not.toContain("secret stack detail");
  });

  it("coordinates fail-safe shutdown and bounded runtime disconnect", async () => {
    const calls: string[] = [];
    server = await createServer({
      runtime: {
        setReadOnly: () => { calls.push("read-only"); },
        disconnect: async () => { calls.push("disconnect"); },
        flushLogs: () => { calls.push("flush-logs"); },
      },
      env: { OSTUDIO_INSECURE_DEV: "true", OSTUDIO_ADMIN_PASSWORD: "correct horse battery staple", OSTUDIO_PUBLIC_ORIGIN: "http://localhost:8080" },
    });
    await server.shutdown();
    expect(calls).toEqual(["read-only", "disconnect", "flush-logs"]);
  });
});
