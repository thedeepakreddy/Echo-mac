/**
 * The ten frontier features, exercised against real data.
 *
 *   npm run frontiertest
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "jarvis-frontier-"));
process.env.HOME = sandbox;

const tt = await import("./frontier/timetravel.js");
const { Attention, urgencyOf } = await import("./frontier/attention.js");
const journal = await import("./frontier/journal.js");
const demo = await import("./frontier/demonstrate.js");
const { detectFailure, extractCommitments, minePatterns } = await import("./frontier/watchers.js");
const extract = await import("./frontier/extract.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nFrontier features\n");

// ---- 3. ask your own past -------------------------------------------------
console.log("  search your past");
const NOW = Date.now();
ok(tt.describeAge(90 * 60_000).includes("hour"), "elapsed time reads naturally");
ok(tt.parseWindow("an hour ago", NOW)! > NOW - 3 * 3600_000, '"an hour ago" bounds the search');
ok(tt.parseWindow("yesterday", NOW)! < NOW - 24 * 3600_000, '"yesterday" reaches back far enough');
ok(tt.parseWindow("what is this", NOW) === null, "a query with no time reference has no window");
ok(tt.parseWindow("a few minutes ago", NOW)! > NOW - 60 * 60_000, '"a few minutes ago" is understood');
ok(tt.parseWindow("half an hour ago", NOW)! > NOW - 2 * 3600_000, '"half an hour" is understood');
ok(tt.parseWindow("2 hours ago", NOW)! > NOW - 5 * 3600_000, "digits still work");
ok(tt.excerpt("aaa the invoice schema changed bbb", "invoice").includes("invoice"), "excerpt centres on the match");
ok(tt.search("", 3).length === 0, "an empty query returns nothing");

// ---- 6. knows when not to speak -------------------------------------------
console.log("  attention");
const att = new Attention();
ok(urgencyOf("Your build failed") === "now", "failures are urgent");
ok(urgencyOf("Should I continue?") === "now", "questions are urgent");
ok(urgencyOf("I noticed a new file") === "whenever", "observations can wait");
att.noteTyping(NOW);
ok(att.isBusy(NOW) === true, "typing means busy");
ok(att.offer("just so you know", "whenever", NOW) === null, "chatter is held while busy");
ok(att.offer("your build failed", "now", NOW) === "your build failed", "urgent output is never held");
ok(att.release(NOW).length === 0, "held messages stay held while still busy");
ok(att.release(NOW + 6 * 60_000).length === 1, "but are released once overdue");
att.noteTyping(NOW);
att.offer("later", "whenever", NOW);
ok(att.release(NOW + 5000).length === 1, "and released as soon as you stop typing");

// ---- 7. undo the last ten minutes -----------------------------------------
console.log("  session undo");
const target = join(sandbox, "note.txt");
writeFileSync(target, "original");
journal.recordFileChange(target, "edited note.txt");
writeFileSync(target, "changed by jarvis");
ok(journal.since(10).length === 1, "the change was journalled");
const undoMsg = await journal.undoWindow(10);
ok(/undid/i.test(undoMsg), "undo reports what it reversed");
const restored = existsSync(target) ? (await import("node:fs")).readFileSync(target, "utf8") : "";
ok(restored === "original", "the file really was restored");

journal.record({ kind: "external", what: "sent a text", undo: { type: "none", why: "cannot unsend" } });
ok(/couldn't be reversed/i.test(await journal.undoWindow(10)), "irreversible actions are admitted, not hidden");

// ---- 1 + 2. learn and repair a workflow -----------------------------------
console.log("  learn by demonstration");
demo.startRecording("export report");
demo.noteStep({ kind: "open", app: "Numbers" });
demo.noteStep({ kind: "click", target: "Export" });
demo.noteStep({ kind: "type", text: "jan" });
demo.noteStep({ kind: "type", text: "uary" });
const wf = demo.finishRecording()!;
ok(!!wf, "a workflow was learned");
ok(wf.steps.length === 3, "consecutive typing collapses into one step");
ok((wf.steps[2] as any).text === "january", "and keeps the full text");
ok(demo.load("export report") !== null, "it persists to disk");

const wfB = { ...wf, steps: [wf.steps[0], wf.steps[1], { kind: "type" as const, text: "february" }] };
const general = demo.generalise(wf, wfB as any);
ok(general.parameters.length === 1, "the value that changed became a parameter");
const bound = demo.bind(general.steps, { [general.parameters[0]]: "march" });
ok((bound[2] as any).text === "march", "and can be filled in on replay");

// ---- 5. spot failures -----------------------------------------------------
console.log("  failure detection");
ok(detectFailure("error TS2345: argument not assignable")?.kind === "build", "compiler errors");
ok(detectFailure("Traceback (most recent call last):")?.kind === "runtime", "stack traces");
ok(detectFailure("3 tests failed")?.kind === "test", "failing tests");
ok(detectFailure("Cannot find module 'zod'")?.kind === "dependency", "missing dependencies");
ok(detectFailure("0 tests failed") === null, "a passing run is not a failure");
ok(detectFailure("we added better error handling today") === null, "prose about errors is not a failure");
ok(detectFailure('p.on("error", cb)') === null, "source code about errors is not a failure");

// ---- 10. commitments ------------------------------------------------------
console.log("  commitments");
const commits = extractCommitments(
  "Sure, I'll send the schema to Sarah by Thursday. Let me also file the caching bug."
);
ok(commits.length >= 2, "several promises are found");
ok(commits.some((c) => /schema/i.test(c.text)), "the promise text is captured");
ok(commits.some((c) => c.when?.toLowerCase().includes("thursday")), "and the deadline");
ok(extractCommitments("The weather is nice today.").length === 0, "ordinary talk yields none");

// ---- 9. routines ----------------------------------------------------------
console.log("  routines");
const hist: Array<{ action: string; at: number }> = [];
for (let i = 0; i < 5; i++) {
  hist.push({ action: "commit", at: NOW + i * 60_000 });
  hist.push({ action: "push", at: NOW + i * 60_000 + 30_000 });
}
const pats = minePatterns(hist);
ok(pats.some((p) => p.trigger === "commit" && p.followUp === "push"), "a repeated pair is found");
ok(minePatterns(hist.slice(0, 2)).length === 0, "one occurrence is not a routine");

// ---- 4. table extraction --------------------------------------------------
console.log("  table extraction");
const csv = extract.toCsv([["a", "b"], ['has,comma', 'has"quote']]);
ok(csv.split("\n").length === 2, "CSV has a row per record");
ok(csv.includes('"has,comma"'), "commas are quoted");
ok(csv.includes('"has""quote"'), "quotes are escaped by doubling");

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} frontier checks passed\n`);
process.exit(fail ? 1 : 0);
