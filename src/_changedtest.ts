/**
 * "What changed while I was gone" — the diff, and the noise it has to survive.
 *
 *   npm run changedtest
 *
 * Most of these are about what must NOT be reported. A change detector that
 * cries wolf about the clock is worse than none at all.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { append } from "./frontier/history.js";
import {
  compare, describe, phrasesFrom, whileAway,
  noteLeft, noteReturned, lastAwayWindow, resetAway,
} from "./frontier/changed.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const roots: string[] = [];
const newRoot = () => {
  const r = mkdtempSync(join(tmpdir(), "jarvis-changed-"));
  roots.push(r);
  return r;
};

const NOW = new Date(2026, 6, 21, 15, 0, 0).getTime();
const MIN = 60_000;

/** Write n captures of the same screen, ending at `end`. */
const screen = (root: string, text: string, end: number, n = 6, stepMs = 30_000) => {
  for (let i = n - 1; i >= 0; i--) append(root, { timestamp: end - i * stepMs, text });
};

const DESK = "inbox 3 unread messages project notes open terminal window build succeeded in 4 seconds welcome back to the workspace";

console.log("\nWhat changed while I was gone\n");

console.log("  it finds what actually appeared");
{
  const root = newRoot();
  screen(root, DESK, NOW - 40 * MIN);
  screen(root, DESK + " the deployment pipeline has finished running all tests", NOW);

  const r = compare(root, NOW - 30 * MIN, NOW);
  const found = r.appeared.join(" | ");
  ok(r.appeared.length > 0, `something new was reported (${r.appeared.length})`);
  ok(/deployment pipeline/.test(found), `and it is the new thing: "${found.slice(0, 60)}"`);
  ok(!/inbox 3 unread/.test(found), "the unchanged part is not reported as new");
}

console.log("  and what disappeared");
{
  const root = newRoot();
  screen(root, DESK + " a modal dialog is asking you to confirm the risky operation", NOW - 40 * MIN);
  screen(root, DESK, NOW);

  const r = compare(root, NOW - 30 * MIN, NOW);
  ok(r.vanished.some((p) => /modal dialog/.test(p)), `the dialog is reported gone (${r.vanished[0] ?? "none"})`);
  ok(!r.appeared.some((p) => /modal dialog/.test(p)), "and not also reported as new");
}

console.log("  the clock is not news");
{
  // The single most common false positive: everything identical except the
  // menu bar time and the battery. This must report nothing at all.
  const root = newRoot();
  screen(root, DESK + " 14:32 87% battery", NOW - 40 * MIN);
  screen(root, DESK + " 15:07 61% battery", NOW);

  const r = compare(root, NOW - 30 * MIN, NOW);
  ok(r.appeared.length === 0, `a changed clock reports nothing new (got ${r.appeared.length}: ${r.appeared.join("|")})`);
  ok(r.vanished.length === 0, "and nothing vanished");
  ok(/nothing meaningful changed/i.test(describe(r)), "and it says so plainly");
}
{
  const root = newRoot();
  screen(root, DESK + " downloading 41% 1.2gb 03:14 remaining", NOW - 40 * MIN);
  screen(root, DESK + " downloading 88% 4.7gb 00:42 remaining", NOW);
  const r = compare(root, NOW - 30 * MIN, NOW);
  ok(r.appeared.length === 0, "a progress bar ticking is not a change either");
}

console.log("  a single OCR misreading is not a change");
{
  const root = newRoot();
  screen(root, DESK, NOW - 40 * MIN);
  // Five clean captures and one garbled one, as accurate OCR actually behaves.
  for (let i = 5; i >= 1; i--) append(root, { timestamp: NOW - i * 30_000, text: DESK });
  append(root, { timestamp: NOW, text: DESK + " rnodal warkspace bulld succeded xyzzy" });

  const r = compare(root, NOW - 30 * MIN, NOW);
  ok(r.appeared.length === 0, `one bad frame does not become a finding (${r.appeared.join("|")})`);
}
{
  // But something present across most frames IS real, even if it arrived late.
  const root = newRoot();
  screen(root, DESK, NOW - 40 * MIN);
  for (let i = 5; i >= 0; i--) {
    append(root, {
      timestamp: NOW - i * 30_000,
      text: i > 3 ? DESK : DESK + " your build failed with a compiler error on line ninety",
    });
  }
  const r = compare(root, NOW - 30 * MIN, NOW);
  ok(r.appeared.some((p) => /build failed/.test(p)), "something durably present is reported");
}

console.log("  a notification that flashed past is not reported");
{
  const root = newRoot();
  screen(root, DESK, NOW - 40 * MIN);
  for (let i = 5; i >= 0; i--) {
    append(root, {
      timestamp: NOW - i * 30_000,
      text: i === 3 ? DESK + " reminder your meeting starts in five minutes" : DESK,
    });
  }
  const r = compare(root, NOW - 30 * MIN, NOW);
  ok(!r.appeared.some((p) => /meeting starts/.test(p)),
     `a one-frame notification is not a change (${r.appeared.join("|")})`);
}

console.log("  phrases read like sentences, not fragments");
{
  const interesting = new Set(["the deployment pipeline", "deployment pipeline has", "pipeline has finished"]);
  const out = phrasesFrom("idle text the deployment pipeline has finished more idle text", interesting);
  ok(out.length === 1, `consecutive matches merge into one phrase (${out.length})`);
  ok(out[0] === "the deployment pipeline has finished", `reads as written: "${out[0]}"`);
}
{
  ok(phrasesFrom("one two three", new Set(["one two three"])).length === 0,
     "a phrase too short to be meaningful is dropped");
}

console.log("  it refuses to guess without evidence");
{
  const root = newRoot();
  screen(root, DESK, NOW); // only "after", nothing before
  const r = compare(root, NOW - 30 * MIN, NOW);
  ok(r.samples.before === 0, "no baseline is detected");
  ok(/enough screen history/i.test(describe(r)), "and it says so rather than inventing a diff");
}
{
  const root = newRoot();
  const r = compare(root, NOW - 30 * MIN, NOW);
  ok(r.appeared.length === 0 && r.vanished.length === 0, "an empty history compares to nothing, without throwing");
}

console.log("  knowing when you left");
{
  resetAway();
  ok(lastAwayWindow() === null, "no absence on record means no window");

  noteLeft(NOW - 60 * MIN);
  noteReturned(NOW);
  const w = lastAwayWindow();
  ok(w?.from === NOW - 60 * MIN && w?.to === NOW, "a recorded absence gives its window");

  resetAway();
  noteLeft(NOW - 60_000);
  noteReturned(NOW);
  ok(lastAwayWindow() === null, "a one-minute absence is not worth briefing about");

  resetAway();
  noteLeft(NOW - 60 * MIN);
  ok(lastAwayWindow() !== null, "still being away counts as a window");
  ok(lastAwayWindow()!.to >= NOW, "which runs up to now");
}

console.log("  answering the question");
{
  const root = newRoot();
  screen(root, DESK, NOW - 90 * MIN);
  screen(root, DESK + " the deployment pipeline has finished running all tests", NOW);

  resetAway();
  noteLeft(NOW - 80 * MIN);
  noteReturned(NOW);
  const answer = whileAway(root, 30 * MIN, NOW);
  ok(/deployment pipeline/.test(answer), "it answers from the actual absence");
  ok(!/didn't see you leave/.test(answer), "and does not claim otherwise");
}
{
  const root = newRoot();
  screen(root, DESK, NOW - 90 * MIN);
  screen(root, DESK + " the deployment pipeline has finished running all tests", NOW);
  resetAway();
  const answer = whileAway(root, 30 * MIN, NOW);
  ok(/didn't see you leave/.test(answer),
     "with no absence recorded it says which window it used instead");
  ok(/deployment pipeline/.test(answer), "and still answers usefully");
}
{
  // A fallback window wide enough to swallow its own baseline has nothing to
  // compare against. Saying so beats inventing a diff from one side.
  const root = newRoot();
  screen(root, DESK, NOW - 90 * MIN);
  screen(root, DESK + " the deployment pipeline has finished running all tests", NOW);
  resetAway();
  ok(/enough screen history/i.test(whileAway(root, 120 * MIN, NOW)),
     "a window with no history before it admits it cannot compare");
}
{
  resetAway();
  ok(/haven't recorded any screen history/.test(whileAway(newRoot(), 30 * MIN, NOW)),
     "with no history at all it says that, rather than 'nothing changed'");
}

for (const r of roots) rmSync(r, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} change checks passed\n`);
process.exit(fail ? 1 : 0);
