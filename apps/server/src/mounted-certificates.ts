import { createHash, createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_SIZE = 1024 * 1024;
const REFERENCE = /^(cert|key)-[0-9a-f]{64}$/;

type Kind = "cert" | "key";
type Entry = { reference: string; name: string; kind: Kind };
export type MountedCertificateInventory = {
  certificates: { reference: string; label: string }[];
  keys: { reference: string; label: string }[];
};

export function createMountedCertificateStore(directory: string) {
  async function read(name: string): Promise<Buffer> {
    if (path.basename(name) !== name || !/\.(pem|crt|key)$/i.test(name)) throw new Error("Invalid mounted credential.");
    const root = await realpath(directory);
    const file = path.join(root, name);
    const before = await lstat(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > MAX_FILE_SIZE ||
      before.size < 1 ||
      (before.mode & 0o444) === 0
    )
      throw new Error("Invalid mounted credential.");
    const resolved = await realpath(file);
    if (path.dirname(resolved) !== root) throw new Error("Invalid mounted credential.");
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > MAX_FILE_SIZE ||
        stat.size < 1 ||
        stat.ino !== before.ino ||
        stat.dev !== before.dev
      ) {
        throw new Error("Invalid mounted credential.");
      }
      const contents = Buffer.alloc(MAX_FILE_SIZE + 1);
      let offset = 0;
      while (offset < contents.length) {
        const { bytesRead } = await handle.read(contents, offset, contents.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset === contents.length) {
        contents.fill(0);
        throw new Error("Invalid mounted credential.");
      }
      return contents.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }

  async function entries(): Promise<Entry[]> {
    let files: string[];
    try {
      files = (await readdir(directory)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Mounted credential inventory is unavailable.", { cause: error });
    }
    if (files.length > 1024) throw new Error("Mounted credential inventory is too large.");
    const result: Entry[] = [];
    for (const name of files) {
      if (!/\.(pem|crt|key)$/i.test(name)) continue;
      let contents: Buffer | undefined;
      try {
        contents = await read(name);
        let kind: Kind;
        if (contents.includes("-----BEGIN CERTIFICATE-----")) {
          new X509Certificate(contents);
          kind = "cert";
        } else if (contents.includes("PRIVATE KEY-----")) {
          createPrivateKey(contents);
          kind = "key";
        } else continue;
        const hash = createHash("sha256").update(name).digest("hex");
        result.push({ reference: `${kind}-${hash}`, name, kind });
      } catch {
        // Unsupported, inaccessible, or unsafe files are never exposed as choices.
      } finally {
        contents?.fill(0);
      }
    }
    return result;
  }

  return {
    async inventory(): Promise<MountedCertificateInventory> {
      const found = await entries();
      const choices = (kind: Kind) =>
        found
          .filter((entry) => entry.kind === kind)
          .map((entry, index) => ({
            reference: entry.reference,
            label: kind === "cert" ? `Client Certificate ${index + 1}` : `Private key ${index + 1}`,
          }));
      return { certificates: choices("cert"), keys: choices("key") };
    },
    async resolve(
      certificateReference: string,
      keyReference: string,
    ): Promise<{ certificate: Buffer; privateKey: KeyObject }> {
      if (
        !REFERENCE.test(certificateReference) ||
        !certificateReference.startsWith("cert-") ||
        !REFERENCE.test(keyReference) ||
        !keyReference.startsWith("key-")
      )
        throw new Error("Mounted credential is invalid.");
      const found = await entries();
      const certificate = found.find((entry) => entry.reference === certificateReference && entry.kind === "cert");
      const key = found.find((entry) => entry.reference === keyReference && entry.kind === "key");
      if (!certificate || !key) throw new Error("Mounted credential is unavailable.");
      let certBytes: Buffer | undefined;
      let keyBytes: Buffer | undefined;
      try {
        certBytes = await read(certificate.name);
        keyBytes = await read(key.name);
        const cert = new X509Certificate(certBytes);
        const privateKey = createPrivateKey(keyBytes);
        const certPublic = cert.publicKey.export({ type: "spki", format: "der" });
        const keyPublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
        if (!certPublic.equals(keyPublic)) throw new Error("Mounted credential pair does not match.");
        return { certificate: cert.raw, privateKey };
      } catch {
        throw new Error("Mounted credential is invalid or unavailable.");
      } finally {
        certBytes?.fill(0);
        keyBytes?.fill(0);
      }
    },
  };
}
