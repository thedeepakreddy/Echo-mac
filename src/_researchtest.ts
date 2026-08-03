/**
 * Overnight research: the queue, the budget, and the morning brief.
 *
 *   npm run researchtest
 *
 * The limits get the most attention. This is the one feature that runs while
 * nobody is watching and spends tokens doing it, so "when may it run" matters
 * more than "what does it find".
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addQuestion, loadQueue, nextQuestion, pendingCount, markAttempted, markDone,
  removeQuestion, sameQuestion, mayRun, slugify, buildPrompt, saveBrief,
  briefsSince, morningBrief, readBrief, describeQueue,
  MAX_ATTEMPTS, MAX_PER_NIGHT, MAX_QUEUE,
} from "./frontier/research.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const roots: string[] = [];
const newRoot = () => {
  const r = mkdtempSync(join(tmpdir(), "jarvis-research-"));
  roots.push(r);
  return r;
};

const NOW = new Date(2026, 6, 21, 23, 0, 0).getTime();

console.log("\nOvernight research\n");

console.log("  queueing");
{
  const root = newRoot();
  const r = addQuestion("how do other people handle offline sync conflicts", root, NOW);
  ok(r.added, "a real question is queued");
  ok(pendingCount(root) === 1, "and shows as pending");
  ok(/look into that/i.test(r.reason), `with a plain confirmation: "${r.reason}"`);
}
{
  const root = newRoot();
  addQuestion("how do people handle offline sync conflicts", root, NOW);
  const again = addQuestion("How do people handle offline sync conflicts?", root, NOW);
  ok(!again.added, "the same question asked again is not queued twice");
  ok(pendingCount(root) === 1, "so the queue stays at one");
}
{
  ok(sameQuestion("What is CRDT?", "what is crdt"), "punctuation and case do not make it a new question");
  ok(!sameQuestion("what is CRDT", "what is OT"), "but a different question is different");
}
{
  const root = newRoot();
  ok(!addQuestion("hm", root, NOW).added, "a fragment is refused");
  ok(!addQuestion("", root, NOW).added, "an empty question is refused");
  ok(pendingCount(root) === 0, "and neither is queued");
}
{
  const root = newRoot();
  for (let i = 0; i < MAX_QUEUE + 3; i++) addQuestion(`research question number ${i}`, root, NOW);
  ok(pendingCount(root) === MAX_QUEUE, `the queue is capped at ${MAX_QUEUE} (${pendingCount(root)})`);
}
{
  const root = newRoot();
  addQuestion("something to look into later on", root, NOW);
  ok(removeQuestion("something to look into later on", root), "a question can be removed by its text");
  ok(pendingCount(root) === 0, "and it goes away");
  ok(!removeQuestion("never asked this", root), "removing something absent reports that");
}

console.log("  when it is allowed to run");
{
  const base = { enabled: true, away: true, doneTonight: 0, pending: 2 };
  ok(mayRun(base).ok, "away, enabled, with questions waiting: yes");
  ok(!mayRun({ ...base, away: false }).ok, "at the desk: no");
  ok(/still at the desk/.test(mayRun({ ...base, away: false }).why), "and it says why");
  ok(!mayRun({ ...base, enabled: false }).ok, "turned off: no");
  ok(!mayRun({ ...base, pending: 0 }).ok, "nothing queued: no");
  ok(!mayRun({ ...base, doneTonight: MAX_PER_NIGHT }).ok,
     `already did ${MAX_PER_NIGHT} tonight: no`);
  ok(mayRun({ ...base, doneTonight: MAX_PER_NIGHT - 1 }).ok, "one under the budget: yes");
}

console.log("  a question that cannot be answered is dropped");
{
  const root = newRoot();
  addQuestion("a question that keeps failing to complete", root, NOW);
  const q = nextQuestion(root)!;
  ok(q !== null, "it is offered first");
  for (let i = 0; i < MAX_ATTEMPTS; i++) markAttempted(q.id, root);
  ok(nextQuestion(root) === null, `after ${MAX_ATTEMPTS} failed attempts it is no longer offered`);
  ok(pendingCount(root) === 0, "and no longer counted as pending");
}
{
  const root = newRoot();
  addQuestion("first question in the queue", root, NOW);
  addQuestion("second question in the queue", root, NOW + 1000);
  ok(nextQuestion(root)?.text === "first question in the queue", "questions are taken in order");
  markDone(nextQuestion(root)!.id, "/tmp/a.md", root, NOW);
  ok(nextQuestion(root)?.text === "second question in the queue", "and the next one follows");
  ok(pendingCount(root) === 1, "a finished question stops being pending");
}

console.log("  the prompt keeps it out of your applications");
{
  const p = buildPrompt("how do people handle sync conflicts");
  ok(/web search/i.test(p), "it is told to search the web");
  ok(/Do NOT open, click, or type/i.test(p), "and explicitly not to touch any application");
  ok(/Sources/.test(p), "and to cite what it used");
  ok(/sources disagree/i.test(p), "and to admit disagreement rather than pick one silently");
}

console.log("  briefs");
{
  ok(slugify("How do I handle CRDTs?!") === "how-do-i-handle-crdts", `filenames are safe: ${slugify("How do I handle CRDTs?!")}`);
  ok(slugify("???").length > 0, "an unslugifiable question still gets a name");
}
{
  const root = newRoot();
  const file = saveBrief(
    "how do people handle sync conflicts",
    "## Short answer\nMost use CRDTs or last-write-wins.\n\n## Sources\n- https://example.com",
    root, NOW
  );
  ok(file.endsWith(".md"), "a brief is written as markdown");
  ok(briefsSince(0, root).length === 1, "and can be found again");
  ok(briefsSince(0, root)[0].question === "how do people handle sync conflicts",
     "with its question as the title");

  const full = readBrief("sync conflicts", root);
  ok(full !== null && /CRDTs/.test(full), "and read back in full by a partial match");
  ok(readBrief("something else entirely", root) === null, "an unmatched request returns nothing");
}

console.log("  the morning brief");
{
  const root = newRoot();
  ok(/Nothing to report/.test(morningBrief(root, NOW)),
     "with nothing queued and nothing done, it says so");
}
{
  const root = newRoot();
  addQuestion("a question waiting to be researched", root, NOW);
  ok(/still queued/.test(morningBrief(root, NOW)),
     "with something queued but not done, it says that instead of 'nothing'");
}
{
  const root = newRoot();
  saveBrief("how do people handle sync conflicts",
    "## Short answer\nMost use CRDTs or last-write-wins, depending on the data.\n\n## Sources\n- https://example.com",
    root, NOW);
  saveBrief("what is the state of local first software",
    "## Short answer\nActive, with several mature libraries.\n\n## Sources\n- https://example.com",
    root, NOW);

  const brief = morningBrief(root, NOW);
  ok(/looked into 2 things/.test(brief), "it counts what it did");
  ok(/CRDTs or last-write-wins/.test(brief), "and leads with each short answer");
  ok(!/## Sources/.test(brief), "without dumping the whole document at you");
}
{
  // A brief from last week must not appear in this morning's summary.
  const root = newRoot();
  saveBrief("an old question", "## Short answer\nOld news.", root, NOW - 7 * 86400_000);
  ok(/Nothing to report/.test(morningBrief(root, NOW)),
     "an old brief is not reported as though it were from last night");
  ok(briefsSince(0, root).length === 1, "though it is still there when asked for everything");
}
{
  // A brief with no stamp — written before the stamp existed — must still load.
  const root = newRoot();
  mkdirSync(join(root, "research", "briefs"), { recursive: true });
  writeFileSync(join(root, "research", "briefs", "2026-07-21-old.md"),
    "# a brief from before stamps existed\n\n## Short answer\nStill readable.\n", "utf8");
  ok(briefsSince(0, root).length === 1, "an unstamped brief falls back to the file's own time");
  ok(readBrief("before stamps", root) !== null, "and can still be read");
}

console.log("  describing the queue");
{
  const root = newRoot();
  ok(/Nothing queued/.test(describeQueue(root)), "an empty queue says so");
  addQuestion("the first thing to look into", root, NOW);
  addQuestion("the second thing to look into", root, NOW + 1);
  const d = describeQueue(root);
  ok(/2 questions queued/.test(d), "and a full one counts them");
  ok(/1\. the first thing/.test(d), "and lists them in order");
}

console.log("  surviving a corrupt queue");
{
  const root = newRoot();
  mkdirSync(join(root, "research"), { recursive: true });
  writeFileSync(join(root, "research", "queue.json"), "{not json", "utf8");
  ok(loadQueue(root).length === 0, "a corrupt queue file loads as empty rather than throwing");
  ok(addQuestion("a question after the corruption", root, NOW).added,
     "and can be written over");
}

for (const r of roots) rmSync(r, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} research checks passed\n`);
process.exit(fail ? 1 : 0);
