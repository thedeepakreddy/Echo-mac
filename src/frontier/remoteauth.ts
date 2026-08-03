import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The password that guards remote control of the machine.
 *
 * This is the one credential standing between a phone and full control of the
 * Mac, so it is treated accordingly:
 *
 *   - The password itself is NEVER stored. Only a scrypt hash of it, with a
 *     random per-install salt, so the stored file cannot be turned back into
 *     the password if someone reads it.
 *   - Verification is timing-safe. A plain `===` on a hash leaks, through how
 *     long it takes, how much of the guess was right — a real attack against
 *     something reachable over a network.
 *   - A correct password does not travel on every request. It is exchanged once
 *     for a session token with a limited life; the token is what the phone then
 *     carries, so the password is exposed as little as possible.
 *
 * scrypt is deliberately slow, which is the point: it makes guessing the
 * password by brute force expensive even for someone holding the hash.
 */

// Overridable so tests can set a password in a throwaway directory rather than
// writing a real credential into the user's ~/.jarvis.
const DIR = process.env.JARVIS_REMOTE_DIR || join(homedir(), ".jarvis");
const FILE = join(DIR, "remote.json");

export const remoteAuthPath = FILE;

interface StoredAuth {
  salt: string; // hex
  hash: string; // hex
  /** scrypt cost, recorded so it can be raised later without locking anyone out. */
  N: number;
}

const SCRYPT_N = 16384;
const KEYLEN = 32;

/** The credential file inside a given directory. */
const fileIn = (dir: string) => join(dir, "remote.json");

/** Derive the hash for a password against a given salt. */
function derive(password: string, saltHex: string, N = SCRYPT_N): string {
  return scryptSync(password, Buffer.from(saltHex, "hex"), KEYLEN, { N, r: 8, p: 1 }).toString("hex");
}

/**
 * Store a new password. Refuses trivially weak ones, because the whole security
 * model rests on this single secret.
 */
export function setPassword(password: string, dir = DIR): { ok: boolean; message: string } {
  if (typeof password !== "string" || password.length < 6) {
    return { ok: false, message: "Choose a password of at least 6 characters." };
  }
  const salt = randomBytes(16).toString("hex");
  const stored: StoredAuth = { salt, hash: derive(password, salt), N: SCRYPT_N };
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(fileIn(dir), JSON.stringify(stored), { mode: 0o600 });
  try {
    chmodSync(fileIn(dir), 0o600);
  } catch {
    /* best effort on filesystems without chmod */
  }
  return { ok: true, message: "Remote password set." };
}

export function hasPassword(dir = DIR): boolean {
  return existsSync(fileIn(dir));
}

function load(dir = DIR): StoredAuth | null {
  const path = fileIn(dir);
  if (!existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    if (s?.salt && s?.hash) return { salt: s.salt, hash: s.hash, N: s.N ?? SCRYPT_N };
  } catch {
    /* a corrupt file is treated as no password, which fails closed */
  }
  return null;
}

/**
 * Is this the right password? Timing-safe, and false when none is set — a
 * machine with no password must not be controllable, rather than accept any.
 */
export function verifyPassword(password: string, dir = DIR): boolean {
  const stored = load(dir);
  if (!stored || typeof password !== "string") return false;
  const attempt = Buffer.from(derive(password, stored.salt, stored.N), "hex");
  const expected = Buffer.from(stored.hash, "hex");
  if (attempt.length !== expected.length) return false;
  return timingSafeEqual(attempt, expected);
}

// ---- sessions -------------------------------------------------------------

interface Session {
  token: string;
  createdAt: number;
  expiresAt: number;
  /** The address the session was minted for, so a stolen token is less portable. */
  ip: string;
}

/** How long a login lasts before the password is needed again. */
export const SESSION_TTL_MS = 12 * 3600_000;

/**
 * Live sessions. In memory only: they should not survive a restart, because a
 * restart is exactly when you want everyone re-authenticated.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private ttlMs = SESSION_TTL_MS, private now = () => Date.now()) {}

  /** Mint a session after a correct password. */
  issue(ip = "?"): string {
    const token = randomBytes(24).toString("hex");
    const at = this.now();
    this.sessions.set(token, { token, createdAt: at, expiresAt: at + this.ttlMs, ip });
    return token;
  }

  /** Is this session token valid right now? */
  valid(token: string | undefined, ip?: string): boolean {
    if (!token) return false;
    const s = this.sessions.get(token);
    if (!s) return false;
    if (this.now() >= s.expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    // A session is bound to the address it was minted for; a token replayed from
    // elsewhere on the tailnet does not carry.
    if (ip && s.ip !== "?" && s.ip !== ip) return false;
    return true;
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  /** Drop everyone — used when the remote closes or the password changes. */
  revokeAll(): void {
    this.sessions.clear();
  }

  count(): number {
    // Purge expired as a side effect, so the count is honest.
    const now = this.now();
    for (const [t, s] of this.sessions) if (now >= s.expiresAt) this.sessions.delete(t);
    return this.sessions.size;
  }
}

/** Read a session token from a Cookie header or a query string. */
export function sessionFrom(cookieHeader: string | undefined, url: string | undefined): string | undefined {
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const [k, v] = part.trim().split("=");
      if (k === "js" && v) return v;
    }
  }
  if (url) {
    const q = url.indexOf("?");
    if (q >= 0) {
      const s = new URLSearchParams(url.slice(q + 1)).get("s");
      if (s) return s;
    }
  }
  return undefined;
}

/** A short fingerprint of the password, so the phone page can tell if it changed. */
export function passwordFingerprint(dir = DIR): string {
  const stored = load(dir);
  if (!stored) return "none";
  return createHash("sha256").update(stored.hash).digest("hex").slice(0, 8);
}

// ---- the stable link token ------------------------------------------------

const tokenFile = (dir: string) => join(dir, "remote-token");

/**
 * The link token, kept the SAME across restarts so the URL can be saved once
 * and reused forever.
 *
 * This changes the old behaviour, where every restart minted a new token and
 * killed old links. That made sense when the link was the only guard; now the
 * PASSWORD is the guard, and the link merely needs to be unguessable and stable.
 * Reachable only over the private tailnet and useless without the password, a
 * fixed token is the right trade for a link you bookmark on your phone.
 *
 * Rotate it deliberately (rotateToken) if a saved link should ever be revoked.
 */
export function getStableToken(dir = DIR): string {
  const path = tokenFile(dir);
  try {
    if (existsSync(path)) {
      const t = readFileSync(path, "utf8").trim();
      if (/^[0-9a-f]{32}$/.test(t)) return t;
    }
  } catch {
    /* fall through and mint a fresh one */
  }
  const t = randomBytes(16).toString("hex");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, t, { mode: 0o600 });
  } catch {
    /* if it cannot be persisted the link still works this session */
  }
  return t;
}

/** Throw away the saved link and mint a new one — invalidates every saved link. */
export function rotateToken(dir = DIR): string {
  try {
    const path = tokenFile(dir);
    if (existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  } catch {
    /* the write below still produces a new token */
  }
  return getStableToken(dir);
}
