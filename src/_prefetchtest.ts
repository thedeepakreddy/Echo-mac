/**
 * Pre-fetch prediction — learned only from the user's own Echo commands.
 *
 *   npm run prefetchtest
 *
 * The point of the rewrite: no keylogger, no OS-wide capture. The model is a
 * plain frequency/transition table over commands the user actually gave Echo.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyModel, observeCommand, complete, predictNext, saveModel, loadModel,
} from "./brain/prefetch.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const roots: string[] = [];
const newRoot = () => { const r = mkdtempSync(join(tmpdir(), "jarvis-prefetch-")); roots.push(r); return r; };

console.log("\nPre-fetch prediction\n");

console.log("  it learns which commands you repeat");
{
  const m = emptyModel();
  observeCommand(m, "open my email");
  observeCommand(m, "open my email");
  observeCommand(m, "what's on my screen");
  ok(m.counts["open my email"] === 2, "counts repeats");
  ok(m.counts["what's on my screen"] === 1, "and one-offs");
  observeCommand(m, "  Open   My   Email  ");
  ok(m.counts["open my email"] === 3, "normalises case and whitespace");
}

console.log("  completing a half-typed command");
{
  const m = emptyModel();
  observeCommand(m, "open mail"); observeCommand(m, "open mail");
  observeCommand(m, "open messages");
  observeCommand(m, "open maps");
  const c = complete(m, "open m");
  ok(c[0] === "open mail", "the most-used match ranks first");
  ok(c.includes("open messages") && c.includes("open maps"), "other matches are offered");
  ok(!complete(m, "open mail").includes("open mail"), "an exact match isn't suggested back");
  ok(complete(m, "").length === 0, "an empty prefix suggests nothing");
  ok(complete(m, "zzz").length === 0, "no match -> nothing");
}

console.log("  predicting the next command");
{
  const m = emptyModel();
  // A repeated habit: screenshot -> describe it.
  observeCommand(m, "take a screenshot");
  observeCommand(m, "what is on my screen");
  observeCommand(m, "take a screenshot");
  observeCommand(m, "what is on my screen");
  observeCommand(m, "take a screenshot");
  observeCommand(m, "open mail");
  const nxt = predictNext(m, "take a screenshot");
  ok(nxt[0] === "what is on my screen", "predicts the usual follow-up");
  ok(predictNext(m, "never seen this").length === 0, "unknown command -> no prediction");
}

console.log("  it persists");
{
  const root = newRoot();
  const m = emptyModel();
  observeCommand(m, "lock the screen");
  observeCommand(m, "lock the screen");
  saveModel(m, root);
  const back = loadModel(root);
  ok(back.counts["lock the screen"] === 2, "the model round-trips to disk");
  ok(loadModel(newRoot()).counts && Object.keys(loadModel(newRoot()).counts).length === 0, "a fresh machine loads an empty model");
}

console.log(`\n${pass}/${pass + fail} prefetch checks passed\n`);
process.exit(fail ? 1 : 0);
