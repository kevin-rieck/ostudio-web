import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFileSavedConnectionStore, createMemorySavedConnectionStore } from "./saved-connections.js";

const connection = {
  id: "plc",
  name: "PLC",
  endpoint: "opc.tcp://plc:4840",
  securityPolicy: "None",
  securityMode: "None" as const,
  username: "admin",
  serverCertificatePin: "sha256:abc",
};

describe("saved connection storage", () => {
  it("keeps memory storage explicitly ephemeral and supports CRUD", async () => {
    const store = createMemorySavedConnectionStore();
    expect(store.mode).toBe("ephemeral");
    await store.save(connection);
    const listed = await store.list();
    listed[0]!.name = "mutated";
    expect((await store.list())[0]!.name).toBe("PLC");
    await store.remove("plc");
    await expect(store.list()).resolves.toEqual([]);
  });

  it("persists only an allowlisted connection envelope with restrictive modes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ostudio-saved-"));
    const store = await createFileSavedConnectionStore(directory);
    expect(store.mode).toBe("durable");
    await store.save({ ...connection, password: "must-not-persist", privateKeyPath: "C:\\private.key" } as never);
    const file = path.join(directory, "saved-connections.json");
    const raw = await readFile(file, "utf8");
    expect(raw).toContain('"version":1');
    expect(raw).not.toContain("must-not-persist");
    expect(raw).not.toContain("private.key");
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    const reopened = await createFileSavedConnectionStore(directory);
    await expect(reopened.list()).resolves.toEqual([connection]);
  });

  it("backs up and migrates the legacy desktop array before serving it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ostudio-legacy-"));
    const file = path.join(directory, "saved-connections.json");
    const legacy = [
      {
        id: "legacy",
        name: "Legacy PLC",
        endpointUrl: "opc.tcp://legacy:secret@legacy:4840",
        authType: "username",
        username: "engineer",
        password: "secret",
        securityPolicy: "Basic256Sha256",
        securityMode: "MessageSecurityModeSignAndEncrypt",
        privateKeyPath: "C:\\private.key",
        serverCertificateThumbprint: "sha256:legacy",
      },
    ];
    const original = JSON.stringify(legacy);
    await (await import("node:fs/promises")).writeFile(file, original, { mode: 0o600 });
    const store = await createFileSavedConnectionStore(directory);
    await expect(store.list()).resolves.toMatchObject([
      {
        id: "legacy",
        endpoint: "opc.tcp://legacy:4840",
        securityMode: "SignAndEncrypt",
        username: "engineer",
        serverCertificatePin: "sha256:legacy",
        certificateReviewRequired: true,
      },
    ]);
    const backup = await readFile(`${file}.bak`, "utf8");
    const migrated = await readFile(file, "utf8");
    expect(backup).toBe(migrated);
    expect(JSON.parse(backup)).toMatchObject({ version: 1 });
    for (const contents of [backup, migrated]) {
      expect(contents).not.toContain("secret");
      expect(contents).not.toContain("private.key");
    }
    await expect(createFileSavedConnectionStore(directory)).resolves.toBeDefined();
  });

  it("rejects a 101st record without rendering durable storage unreadable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ostudio-limit-"));
    const store = await createFileSavedConnectionStore(directory);
    for (let index = 0; index < 100; index++) await store.save({ ...connection, id: String(index) });
    await expect(store.save({ ...connection, id: "overflow" })).rejects.toThrow(/limit/i);
    await expect(createFileSavedConnectionStore(directory)).resolves.toBeDefined();
  });

  it("rejects non-OPC endpoints from versioned storage before serving", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ostudio-protocol-"));
    const file = path.join(directory, "saved-connections.json");
    const source = JSON.stringify({
      version: 1,
      savedConnections: [{ ...connection, endpoint: "https://example.com" }],
    });
    await (await import("node:fs/promises")).writeFile(file, source);
    await expect(createFileSavedConnectionStore(directory)).rejects.toThrow(/endpoint/i);
    expect(await readFile(file, "utf8")).toBe(source);
  });

  it("fails safely for corrupt and unknown documents without replacing them", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ostudio-invalid-"));
    const file = path.join(directory, "saved-connections.json");
    const invalid = "{not-json";
    await (await import("node:fs/promises")).writeFile(file, invalid, { mode: 0o600 });
    await expect(createFileSavedConnectionStore(directory)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(invalid);
    await (await import("node:fs/promises")).writeFile(file, JSON.stringify({ version: 99, savedConnections: [] }));
    await expect(createFileSavedConnectionStore(directory)).rejects.toThrow(/version/i);
  });
});
