/**
 * Persistent memory: store, recall, project scoping, and forgetting.
 *
 * Runs against a temporary HOME so it never touches your real ~/.jarvis —
 * a memory test that pollutes the thing it is testing is worse than no test.
 *
 *   npm run memtest
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect HOME before importing the store, which resolves its path on load.
const sandbox = mkdtempSync(join(tmpdir(), "jarvis-mem-"));
process.env.HOME = sandbox;

const store = await import("./memory/store.js");
const { recallForPrompt, recallQuery } = await import("./memory/recall.js");
const { deriveProject } = await import("./memory/context.js");

let pass = 0;
let fail = 0;
const ok = (c: boolean, msg: string) => (c ? (pass++, console.log(`  ✓ ${msg}`)) : (fail++, console.log(`  ✗ ${msg}`)));

console.log("\nPersistent memory\n");

try {
  // ---- storing and reloading -------------------------------------------
  ok(store.all().length === 0, "starts empty");

  store.remember("The user prefers short spoken answers", "preference", store.GLOBAL);
  store.remember("Building the voice assistant HUD", "project", "jarvis");
  store.remember("Chose whisper over Picovoice to avoid an API key", "decision", "jarvis");
  store.remember("Fixed the mic threshold bug", "episode", "jarvis");
  store.remember("Refactored the invoice parser", "episode", "billing-app");

  ok(store.all().length === 5, "records persist to disk and read back");
  ok(existsSync(store.memoryFile), "written to ~/.jarvis/memory as plain JSONL");

  // ---- search ------------------------------------------------------------
  const whisper = store.search("whisper picovoice");
  ok(whisper.length > 0 && /whisper/i.test(whisper[0].text), "search finds a decision by its words");
  ok(store.search("quantum tunnelling").length === 0, "unrelated search returns nothing");

  // ---- project scoping ---------------------------------------------------
  const jarvisPrompt = recallForPrompt("jarvis");
  ok(jarvisPrompt.includes("voice assistant HUD"), "recall includes the current project's work");
  ok(jarvisPrompt.includes("short spoken answers"), "recall always includes global preferences");
  ok(!jarvisPrompt.includes("invoice parser"), "recall excludes another project's history");

  const billingPrompt = recallForPrompt("billing-app");
  ok(billingPrompt.includes("invoice parser"), "switching project switches the history shown");
  ok(!billingPrompt.includes("voice assistant HUD"), "and hides the previous project's work");

  // ---- budget ------------------------------------------------------------
  for (let i = 0; i < 200; i++) store.remember(`Filler episode number ${i} with some text`, "episode", "jarvis");
  const big = recallForPrompt("jarvis");
  ok(big.length < 2600, `recall stays within its prompt budget (${big.length} chars for 205 records)`);
  ok(big.includes("short spoken answers"), "preferences survive the budget squeeze");

  // ---- forgetting --------------------------------------------------------
  const before = store.all().length;
  const removed = store.forget({ query: "invoice parser" });
  ok(removed === 1, "forget removes the matching memory");
  ok(store.all().length === before - 1, "and it is gone from the live set");
  ok(!recallForPrompt("billing-app").includes("invoice parser"), "forgotten memories stop being recalled");

  store.compact();
  ok(store.all().length === before - 1, "compaction preserves the live set");

  // ---- recall tool output ------------------------------------------------
  ok(recallQuery("whisper").includes("whisper"), "recall tool answers a direct question");
  ok(recallQuery("nothing like this exists").startsWith("Nothing"), "recall tool says so when it knows nothing");

  // ---- project detection from real window titles --------------------------
  const cases: Array<[string, string, string]> = [
    ["Code", "listener.ts — J.A.R.V.I.S", "J.A.R.V.I.S"],
    ["Code", "● index.tsx — my-web-app", "my-web-app"],
    ["Terminal", "jarvis — -zsh", "jarvis"],
    ["Finder", "Downloads", "Downloads"],
    ["Safari", "", "Safari"],
    ["Terminal", "-zsh", "Terminal"],
  ];
  for (const [app, title, want] of cases) {
    const got = deriveProject(app, title);
    ok(got === want, `project from "${title || "(no title)"}" in ${app} -> ${got}`);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} memory checks passed\n`);
process.exit(fail ? 1 : 0);
