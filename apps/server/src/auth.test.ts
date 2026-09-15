import { describe, expect, it } from "vitest";
import { authConstants, createAuthenticator } from "./auth.js";

describe("fixed admin authentication", () => {
  it("expires idle sessions while sliding active sessions up to the absolute deadline", async () => {
    let timestamp = 0;
    const auth = await createAuthenticator({ password: "correct horse battery staple", now: () => timestamp });
    const result = await auth.login("admin", "correct horse battery staple", "127.0.0.1");
    if (!result.ok) throw new Error("expected login to succeed");
    timestamp = 11 * 60 * 60 * 1000;
    expect(auth.session(result.token)).toBeDefined();
    timestamp = 22 * 60 * 60 * 1000;
    expect(auth.session(result.token)).toBeDefined();
    timestamp = 24 * 60 * 60 * 1000;
    expect(auth.session(result.token)).toBeUndefined();
  });

  it("temporarily rate-limits repeated failures without locking out permanently", async () => {
    let timestamp = 0;
    const auth = await createAuthenticator({ password: "correct horse battery staple", now: () => timestamp });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await auth.login("admin", "wrong password", "192.0.2.1");
      expect(result.ok).toBe(false);
    }
    const limited = await auth.login("admin", "correct horse battery staple", "192.0.2.1");
    expect(limited).toMatchObject({ ok: false });
    timestamp += 2_000;
    expect((await auth.login("admin", "correct horse battery staple", "192.0.2.1")).ok).toBe(true);
  });

  it("recovers both distributed failure buckets after a quiet period", async () => {
    let timestamp = 0;
    const auth = await createAuthenticator({ password: "correct horse battery staple", now: () => timestamp });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth.login("admin", "wrong password", `192.0.2.${attempt + 1}`);
    }
    timestamp += authConstants.failureQuietPeriodMs;
    const result = await auth.login("admin", "correct horse battery staple", "192.0.2.99");
    expect(result.ok).toBe(true);
    expect((await auth.login("admin", "correct horse battery staple", "192.0.2.1")).ok).toBe(true);
  });
});
