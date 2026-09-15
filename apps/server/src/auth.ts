import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

const INACTIVITY_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_MS = 24 * 60 * 60 * 1000;
const HASH_OPTIONS = { parallelism: 1, memory: 19_456, passes: 2, tagLength: 32 } as const;
const GENERIC_FAILURE = "Invalid username or password.";

type PasswordVerifier = { salt: Buffer; digest: Buffer };
type FailureBucket = { failures: number; blockedUntil: number; lastFailureAt?: number };
const FAILURE_QUIET_PERIOD_MS = 15 * 60 * 1000;

export interface AuthenticatorOptions {
  password: string;
  now?: () => number;
}

export interface AuthSession {
  readonly id: string;
  readonly createdAt: number;
  lastActivityAt: number;
  readonly expiresAt: number;
}

export type LoginResult =
  | { ok: true; token: string; session: AuthSession }
  | { ok: false; retryAfterMs?: number };

export interface Authenticator {
  login(username: string, password: string, source: string): Promise<LoginResult>;
  session(token: string | undefined): AuthSession | undefined;
  logout(token: string | undefined): void;
  cookie(token: string): string;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { ...HASH_OPTIONS, message: password, nonce: salt }, (error, digest) => {
      if (error) reject(error);
      else resolve(Buffer.from(digest));
    });
  });
}

async function verifier(password: string): Promise<PasswordVerifier> {
  const salt = randomBytes(16);
  return { salt, digest: await derive(password, salt) };
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createAuthenticator(options: AuthenticatorOptions): Promise<Authenticator> {
  if (options.password.length < 12) throw new Error("The admin password must contain at least 12 characters.");
  const now = options.now ?? Date.now;
  const admin = await verifier(options.password);
  // Always verify against a real verifier for unknown usernames too.
  const dummy = await verifier(randomBytes(32).toString("base64url"));
  const sessions = new Map<string, AuthSession>();
  const sourceFailures = new Map<string, FailureBucket>();
  const globalFailures: FailureBucket = { failures: 0, blockedUntil: 0 };

  const blocked = (bucket: FailureBucket, timestamp: number): number => Math.max(0, bucket.blockedUntil - timestamp);
  const resetQuietBucket = (bucket: FailureBucket, timestamp: number): void => {
    if (bucket.lastFailureAt !== undefined && timestamp - bucket.lastFailureAt >= FAILURE_QUIET_PERIOD_MS) {
      bucket.failures = 0;
      bucket.blockedUntil = 0;
    }
  };
  const resetBucket = (bucket: FailureBucket): void => {
    bucket.failures = 0;
    bucket.blockedUntil = 0;
    bucket.lastFailureAt = undefined;
  };
  const registerFailure = (bucket: FailureBucket, timestamp: number): void => {
    resetQuietBucket(bucket, timestamp);
    bucket.failures += 1;
    bucket.lastFailureAt = timestamp;
    if (bucket.failures >= 5) {
      const delay = Math.min(15 * 60 * 1000, 250 * 2 ** Math.min(bucket.failures - 5, 11));
      bucket.blockedUntil = timestamp + delay;
    }
  };

  return {
    async login(username, password, source): Promise<LoginResult> {
      const timestamp = now();
      const sourceBucket = sourceFailures.get(source) ?? { failures: 0, blockedUntil: 0 };
      sourceFailures.set(source, sourceBucket);
      resetQuietBucket(sourceBucket, timestamp);
      resetQuietBucket(globalFailures, timestamp);
      const sourceRetry = blocked(sourceBucket, timestamp);
      const globalRetry = blocked(globalFailures, timestamp);
      if (sourceRetry || globalRetry) return { ok: false, retryAfterMs: Math.max(sourceRetry, globalRetry) };

      const candidate = await derive(password, username === "admin" ? admin.salt : dummy.salt);
      const valid = username === "admin" && sameDigest(candidate, admin.digest);
      if (!valid) {
        registerFailure(sourceBucket, timestamp);
        registerFailure(globalFailures, timestamp);
        return { ok: false, retryAfterMs: Math.max(blocked(sourceBucket, timestamp), blocked(globalFailures, timestamp)) };
      }

      sourceFailures.delete(source);
      resetBucket(globalFailures);
      const token = randomBytes(32).toString("base64url");
      const session: AuthSession = { id: token, createdAt: timestamp, lastActivityAt: timestamp, expiresAt: timestamp + ABSOLUTE_MS };
      sessions.set(token, session);
      return { ok: true, token, session };
    },
    session(token) {
      if (!token) return undefined;
      const current = sessions.get(token);
      if (!current) return undefined;
      const timestamp = now();
      if (timestamp >= current.expiresAt || timestamp - current.lastActivityAt >= INACTIVITY_MS) {
        sessions.delete(token);
        return undefined;
      }
      current.lastActivityAt = timestamp;
      return current;
    },
    logout(token) {
      if (token) sessions.delete(token);
    },
    cookie(token) {
      return `ostudio_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ABSOLUTE_MS / 1000}`;
    },
  };
}

export const authConstants = { inactivityMs: INACTIVITY_MS, absoluteMs: ABSOLUTE_MS, failureQuietPeriodMs: FAILURE_QUIET_PERIOD_MS, genericFailure: GENERIC_FAILURE } as const;
