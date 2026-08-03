/**
 * Setup window logic: key storage, first-run detection, merge-on-save.
 *   npm run setuptest
 */
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "jarvis-setup-"));
process.env.HOME = sandbox;
// A packaged first run has none of these set.
for (const k of ["ANTHROPIC_API_KEY","GEMINI_API_KEY","ELEVENLABS_API_KEY","PICOVOICE_ACCESS_KEY"]) delete process.env[k];

const ks = await import("./keystore.js");
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nSetup / API keys\n");

console.log("  a fresh install");
ok(ks.needsSetup() === true, "with no keys, Setup is offered");
ok(Object.keys(ks.readKeys()).length === 0, "nothing stored yet");

console.log("  saving");
ks.writeKeys({ GEMINI_API_KEY: "AIza-test-123" });
ok(ks.readKeys().GEMINI_API_KEY === "AIza-test-123", "a key round-trips to disk");
ok(existsSync(ks.keysPath), "written to the user's own directory, not the app bundle");
ok(ks.keysPath.startsWith(sandbox), "under HOME, so it survives app updates");

// Credentials in a world-readable file are a real exposure on a shared Mac.
const mode = statSync(ks.keysPath).mode & 0o777;
ok(mode === 0o600, `readable only by the owner (mode ${mode.toString(8)})`);

console.log("  after saving");
ok(ks.needsSetup() === false, "Setup is no longer forced on next launch");
ks.applyKeys();
ok(process.env.GEMINI_API_KEY === "AIza-test-123", "the key reaches the environment");

console.log("  a real environment variable still wins");
process.env.GEMINI_API_KEY = "from-the-shell";
ks.applyKeys();
ok(process.env.GEMINI_API_KEY === "from-the-shell", "so a one-off override works");
delete process.env.GEMINI_API_KEY;

console.log("  adding a second key later");
const merged = { ...ks.readKeys(), ANTHROPIC_API_KEY: "sk-ant-test" };
ks.writeKeys(merged);
const after = ks.readKeys();
ok(after.ANTHROPIC_API_KEY === "sk-ant-test" && after.GEMINI_API_KEY === "AIza-test-123",
   "the earlier key is not lost");

console.log("  every field the window shows is real");
ok(ks.KEY_FIELDS.length >= 3, `${ks.KEY_FIELDS.length} keys offered`);
ok(ks.KEY_FIELDS.every((f) => f.url.startsWith("https://")), "each links somewhere to get one");
ok(ks.KEY_FIELDS.every((f) => f.help.length > 20), "each explains what it buys");
ok(ks.KEY_FIELDS.every((f) => f.optional), "none is mandatory — Jarvis runs without any");

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} setup checks passed\n`);
process.exit(fail ? 1 : 0);
