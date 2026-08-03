/**
 * The password and sessions guarding remote control of the machine.
 *
 *   npm run remoteauthtest
 *
 * This is the single credential between a phone and full control of the Mac, so
 * the checks are unforgiving: the password must never be stored in the clear,
 * a machine with no password must be uncontrollable, and sessions must expire
 * and stay bound to where they were issued.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setPassword, hasPassword, verifyPassword, passwordFingerprint,
  SessionStore, sessionFrom, getStableToken, rotateToken,
} from "./frontier/remoteauth.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const roots: string[] = [];
const newRoot = () => {
  const r = mkdtempSync(join(tmpdir(), "jarvis-remoteauth-"));
  roots.push(r);
  return r;
};

console.log("\nRemote auth\n");

console.log("  the password is never stored in the clear");
{
  const dir = newRoot();
  setPassword("correct horse battery", dir);
  const raw = readFileSync(join(dir, "remote.json"), "utf8");
  ok(!raw.includes("correct horse battery"), "the plaintext password is nowhere in the file");
  ok(/"salt"/.test(raw) && /"hash"/.test(raw), "only a salt and a hash are stored");
}
{
  // Two installs with the same password must not produce the same hash, or a
  // stolen file from one machine would reveal the other.
  const a = newRoot(), b = newRoot();
  setPassword("samepass123", a);
  setPassword("samepass123", b);
  const ha = JSON.parse(readFileSync(join(a, "remote.json"), "utf8"));
  const hb = JSON.parse(readFileSync(join(b, "remote.json"), "utf8"));
  ok(ha.salt !== hb.salt, "each install gets its own salt");
  ok(ha.hash !== hb.hash, "so the same password hashes differently on each");
}

console.log("  it lets the right password in and keeps the wrong one out");
{
  const dir = newRoot();
  setPassword("letmein42", dir);
  ok(verifyPassword("letmein42", dir), "the correct password verifies");
  ok(!verifyPassword("letmein43", dir), "a wrong password does not");
  ok(!verifyPassword("", dir), "an empty password does not");
  ok(!verifyPassword("letmein42 ", dir), "not even with trailing space");
}
{
  // The most important property: no password set means NOTHING gets in.
  const dir = newRoot();
  ok(!hasPassword(dir), "a fresh machine has no remote password");
  ok(!verifyPassword("anything", dir), "and cannot be controlled with any password");
  ok(!verifyPassword("", dir), "nor an empty one");
}

console.log("  weak passwords are refused");
{
  const dir = newRoot();
  ok(!setPassword("abc", dir).ok, "too short is rejected");
  ok(!setPassword("", dir).ok, "empty is rejected");
  ok(!hasPassword(dir), "and nothing is written when rejected");
  ok(setPassword("longenough", dir).ok, "a reasonable password is accepted");
}

console.log("  changing the password is detectable");
{
  const dir = newRoot();
  setPassword("firstpass", dir);
  const fp1 = passwordFingerprint(dir);
  setPassword("secondpass", dir);
  const fp2 = passwordFingerprint(dir);
  ok(fp1 !== fp2, "the fingerprint changes when the password does");
  ok(passwordFingerprint(newRoot()) === "none", "and reads 'none' when unset");
  ok(!verifyPassword("firstpass", dir), "the old password stops working");
  ok(verifyPassword("secondpass", dir), "the new one works");
}

console.log("  sessions expire and stay put");
{
  let clock = 1_000_000;
  const store = new SessionStore(1000, () => clock); // 1s TTL
  const tok = store.issue("100.64.0.5");
  ok(store.valid(tok, "100.64.0.5"), "a fresh session from its own address is valid");
  ok(!store.valid(tok, "100.64.0.9"), "the same token from another address is not");
  ok(!store.valid("madeuptoken", "100.64.0.5"), "an invented token is not valid");
  ok(!store.valid(undefined), "no token is not valid");

  clock += 1500; // past the TTL
  ok(!store.valid(tok, "100.64.0.5"), "an expired session is rejected");
}
{
  const store = new SessionStore();
  const t1 = store.issue("a"), t2 = store.issue("a");
  ok(t1 !== t2, "each session token is unique");
  ok(store.count() === 2, "the store counts live sessions");
  store.revoke(t1);
  ok(!store.valid(t1, "a") && store.valid(t2, "a"), "revoking one leaves the other");
  store.revokeAll();
  ok(store.count() === 0, "revokeAll clears everyone (used on close / password change)");
}

console.log("  the link token is stable, so the URL can be saved");
{
  const dir = newRoot();
  const t1 = getStableToken(dir);
  ok(/^[0-9a-f]{32}$/.test(t1), "a fresh install mints a 32-char token");
  const t2 = getStableToken(dir);
  ok(t1 === t2, "and every later read returns the SAME token (permanent link)");
  ok(existsSync(join(dir, "remote-token")), "it is persisted to disk");
}
{
  // Rotation exists for deliberately killing every saved link.
  const dir = newRoot();
  const before = getStableToken(dir);
  const after = rotateToken(dir);
  ok(before !== after, "rotating produces a new token");
  ok(getStableToken(dir) === after, "which then becomes the stable one");
}

console.log("  reading a session token from a request");
{
  ok(sessionFrom("js=abc123; other=x", undefined) === "abc123", "from a Cookie header");
  ok(sessionFrom(undefined, "/rtc/offer?s=def456") === "def456", "from a query string");
  ok(sessionFrom("nothing=here", "/page") === undefined, "absent means undefined");
  ok(sessionFrom(undefined, undefined) === undefined, "no inputs means undefined");
}

for (const r of roots) rmSync(r, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} remote-auth checks passed\n`);
process.exit(fail ? 1 : 0);
