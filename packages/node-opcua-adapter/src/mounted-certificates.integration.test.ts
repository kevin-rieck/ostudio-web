import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMountedCertificateStore } from "../../../apps/server/src/mounted-certificates";
import { createOpcUaTestServer, disposeOpcUaTestServer } from "./test-fixture";

describe("mounted Client Certificate inventory", () => {
  it("returns only opaque choices and revalidates matching PEM credentials", async () => {
    const fixture = await createOpcUaTestServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "ostudio-mounted-"));
    try {
      const certificate = new X509Certificate(fixture.server.getCertificate());
      const key = await readFile(fixture.serverCertificateManager.privateKey);
      await writeFile(path.join(directory, "secret-cert.pem"), certificate.toString());
      await writeFile(path.join(directory, "secret-key.pem"), key);
      await writeFile(path.join(directory, "unsupported.txt"), key);
      await writeFile(path.join(directory, "invalid.key"), "not a PEM key");
      const store = createMountedCertificateStore(directory);
      const inventory = await store.inventory();
      expect(inventory.certificates).toHaveLength(1);
      expect(inventory.keys).toHaveLength(1);
      expect(JSON.stringify(inventory)).not.toMatch(/secret|BEGIN|private\.key|unsupported/i);
      const cert = inventory.certificates[0]!.reference;
      const privateKey = inventory.keys[0]!.reference;
      expect(cert).toMatch(/^cert-[0-9a-f]{64}$/);
      expect(privateKey).toMatch(/^key-[0-9a-f]{64}$/);
      await expect(store.resolve(cert, privateKey)).resolves.toMatchObject({ certificate: certificate.raw });
      for (const bad of ["../secret-key.pem", "C:\\secret.key", "/secret.key", "key-bad"]) {
        await expect(store.resolve(cert, bad)).rejects.toThrow();
      }
      if (process.platform !== "win32") {
        await chmod(path.join(directory, "secret-key.pem"), 0);
        await expect(store.resolve(cert, privateKey)).rejects.toThrow();
        await chmod(path.join(directory, "secret-key.pem"), 0o600);
      }
      const wrong = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      });
      await writeFile(path.join(directory, "secret-key.pem"), wrong);
      await expect(store.resolve(cert, privateKey)).rejects.toThrow();
      key.fill(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await disposeOpcUaTestServer(fixture);
    }
  }, 120_000);

  it("never inventories or follows a symlink outside the mounted directory", async ({ skip }) => {
    const fixture = await createOpcUaTestServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "ostudio-symlink-"));
    try {
      const link = path.join(directory, "escaped.pem");
      try {
        await symlink(fixture.serverCertificateManager.privateKey, link, "file");
      } catch (error) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") skip();
        throw error;
      }
      const store = createMountedCertificateStore(directory);
      expect((await store.inventory()).keys).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await disposeOpcUaTestServer(fixture);
    }
  }, 120_000);
});
