/**
 * Episodic memory: decay, scoring, and consolidation.
 *   npm run episodictest
 *
 * The properties tested here are the ones whose failure is silent. A wrong
 * decay curve does not throw — it just quietly stops surfacing the thing you
 * needed, and you would never know it had been considered and ranked last.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  record,
  retrieve,
  allEpisodes,
  allFacts,
  consolidate,
  factsForPrompt,
  defaultImportance,
  recencyScore,
  usageScore,
  lexicalScore,
  cosine,
  signature,
  noteAccessed,
  compact,
  stats,
  episodicDir,
  _resetForTests,
  HALF_LIFE_MS,
  type Episode,
} from "./cognition/episodic.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`));

// Refuse to run against real data.
//
// JARVIS_EPISODIC_DIR is the supported way to point the store somewhere else,
// and setting it is an explicit statement that this is not the real store — so
// it satisfies the check rather than tripping it. Without an override the
// original rule stands: the path must be the real one AND it must be empty.
const REAL = join(process.env.HOME ?? "", ".jarvis", "episodic");
const overridden = Boolean(process.env.JARVIS_EPISODIC_DIR?.trim());
if (!overridden && episodicDir() !== REAL) {
  console.error("refusing to run: episodic dir is not where it was expected");
  process.exit(1);
}
const epFile = join(episodicDir(), "episodes.jsonl");
if (existsSync(epFile) && readFileSync(epFile, "utf8").trim()) {
  console.error(`\nrefusing to run: ${episodicDir()} already holds data.`);
  console.error("Move it aside first — this test writes and clears there.\n");
  process.exit(1);
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

console.log("\nEpisodic memory\n");
_resetForTests();

// ---- importance -----------------------------------------------------------
console.log("  importance is assigned from the shape of the event");
ok(defaultImportance("observation", "the screen shows a file list") < 0.25,
   "ambient observation scores low");
ok(defaultImportance("action", "clicked Compose") < 0.4, "a routine action scores low");
ok(defaultImportance("correction", "no, use Brave not Chrome") >= 0.85,
   "a correction scores high");
ok(defaultImportance("request", "always use pnpm from now on") >= 0.9,
   "an explicit standing instruction scores highest");
ok(defaultImportance("outcome", "the build failed with an error") >= 0.7,
   "a failure scores high — divergence is what is worth keeping");

// ---- decay ----------------------------------------------------------------
console.log("  decay: old and unimportant sinks, important and rehearsed persists");
const mk = (over: Partial<Episode>): Episode => ({
  id: "x", at: T0, kind: "action", text: "t",
  importance: 0.3, accessCount: 0, lastAccessedAt: T0, ...over,
} as Episode);

const fresh = mk({ at: T0 });
const old = mk({ at: T0 - 60 * DAY });
ok(recencyScore(fresh, T0) > recencyScore(old, T0), "a newer memory outranks an older one");

const trivialOld = mk({ at: T0 - 60 * DAY, importance: 0.15 });
const importantOld = mk({ at: T0 - 60 * DAY, importance: 0.95 });
ok(recencyScore(importantOld, T0) > recencyScore(trivialOld, T0) * 3,
   "at the same age, an important memory decays far slower");

const unrehearsed = mk({ at: T0 - 30 * DAY, importance: 0.5 });
const rehearsed = mk({ at: T0 - 30 * DAY, importance: 0.5, accessCount: 8 });
ok(recencyScore(rehearsed, T0) > recencyScore(unrehearsed, T0),
   "being retrieved before slows decay (rehearsal)");

// The stated design target: a correction is still findable months later.
const correction = mk({ at: T0 - 120 * DAY, importance: 0.9, accessCount: 3 });
ok(recencyScore(correction, T0) > 0.5,
   `a rehearsed correction is still strong after 4 months (${recencyScore(correction, T0).toFixed(2)})`);
const noise = mk({ at: T0 - 30 * DAY, importance: 0.15 });
ok(recencyScore(noise, T0) < 0.2,
   `unimportant noise has sunk within a month (${recencyScore(noise, T0).toFixed(2)})`);

// Half-life sanity: an average memory loses about half its weight in one period.
const avg = mk({ at: T0 - HALF_LIFE_MS, importance: 0 });
ok(Math.abs(recencyScore(avg, T0) - 0.5) < 0.02,
   "an importance-0 memory halves in exactly one half-life");

ok(recencyScore(mk({ at: T0 - 3650 * DAY, importance: 0.1 }), T0) >= 0,
   "nothing ever goes negative — memories sink, they are never removed");

// ---- usage + relevance ----------------------------------------------------
console.log("  relevance and usage");
ok(usageScore(mk({ accessCount: 0 })) === 0, "never retrieved scores zero usage");
ok(usageScore(mk({ accessCount: 10 })) > usageScore(mk({ accessCount: 2 })),
   "more retrievals scores higher");
ok(usageScore(mk({ accessCount: 100 })) <= 1, "usage saturates rather than running away");

ok(lexicalScore("brave browser", "opened the brave browser") === 1, "full term overlap scores 1");
ok(lexicalScore("brave browser", "opened chrome") === 0, "no overlap scores 0");
ok(lexicalScore("the a of", "anything") === 0, "stop words alone yield nothing");
ok(cosine([1, 0], [1, 0]) === 1 && cosine([1, 0], [0, 1]) === 0, "cosine behaves");
ok(cosine([1, 0], []) === 0, "a missing embedding is not an error");

// ---- retrieval ranking ----------------------------------------------------
console.log("  retrieval ranks on all four axes together");
_resetForTests();
record({ kind: "observation", text: "window shows a list of files" }, T0 - 40 * DAY);
record({ kind: "correction", text: "use Brave instead of Chrome for links" }, T0 - 40 * DAY);
record({ kind: "action", text: "opened Chrome and searched" }, T0 - 1 * DAY);

let hits = retrieve("which browser should I use", { now: T0, markAccessed: false });
ok(hits.length === 3, "everything is considered, not just recent");
ok(/brave/i.test(hits[0].episode.text),
   `the old but important+relevant correction wins (top: "${hits[0].episode.text.slice(0, 30)}")`);
ok(hits[hits.length - 1].episode.kind === "observation",
   "the ambient observation ranks last");
ok(hits[0].score > 0 && hits[0].score <= 1, "scores are readable as 0..1");

console.log("  retrieval is rehearsal — it feeds back into decay");
const before = allEpisodes().reduce((n, e) => n + e.accessCount, 0);
retrieve("browser", { now: T0, limit: 2 });
const after = allEpisodes().reduce((n, e) => n + e.accessCount, 0);
ok(after === before + 2, `retrieving 2 recorded 2 accesses (${before} -> ${after})`);
retrieve("browser", { now: T0, markAccessed: false });
ok(allEpisodes().reduce((n, e) => n + e.accessCount, 0) === after,
   "read-only inspection does not inflate the counts");

// ---- consolidation --------------------------------------------------------
console.log("  consolidation promotes only what repeats ACROSS days");
_resetForTests();
// Three times, but all in one session — a person retrying, not a preference.
for (let i = 0; i < 4; i++) {
  record({ kind: "action", text: "deploy the staging server now" }, T0 + i * 60_000);
}
let res = consolidate(allEpisodes(), T0);
ok(res.promoted.length === 0, "four occurrences in ONE day promote nothing");

// Same count, spread over days — that is a pattern.
_resetForTests();
for (let i = 0; i < 3; i++) {
  record({ kind: "request", text: "open Brave and check the dashboard" }, T0 + i * DAY);
}
res = consolidate(allEpisodes(), T0 + 3 * DAY);
ok(res.promoted.length === 1, "three occurrences across three days promote one fact");
ok(res.promoted[0].support === 3, "support is recorded");
ok(res.promoted[0].confidence > 0 && res.promoted[0].confidence < 1,
   `confidence is partial at low support (${res.promoted[0].confidence.toFixed(2)})`);
ok(res.promoted[0].sourceEpisodeIds.length === 3, "it can be traced back to its episodes");

console.log("  consolidation does not double-promote");
const again = consolidate(allEpisodes(), T0 + 3 * DAY);
ok(again.promoted.length === 0, "running it twice promotes nothing new");
ok(allFacts().length === 1, "the fact store still holds one");

console.log("  confidence grows with support and fades with staleness");
_resetForTests();
for (let i = 0; i < 8; i++) record({ kind: "request", text: "run the nightly backup script" }, T0 + i * DAY);
const strong = consolidate(allEpisodes(), T0 + 8 * DAY).promoted[0];
ok(strong.confidence > 0.9, `heavy support is near-certain (${strong.confidence.toFixed(2)})`);
_resetForTests();
for (let i = 0; i < 8; i++) record({ kind: "request", text: "run the nightly backup script" }, T0 + i * DAY);
const stale = consolidate(allEpisodes(), T0 + 400 * DAY).promoted[0];
ok(stale.confidence < strong.confidence,
   `the same pattern unseen for a year is trusted less (${stale.confidence.toFixed(2)} < ${strong.confidence.toFixed(2)})`);

console.log("  ambient noise is never promoted");
_resetForTests();
for (let i = 0; i < 6; i++) {
  record({ kind: "observation", text: "the editor window is showing some code" }, T0 + i * DAY);
}
ok(consolidate(allEpisodes(), T0 + 6 * DAY).promoted.length === 0,
   "observations repeated for days still promote nothing");

console.log("  signatures collapse the parts that vary");
ok(signature('open "report-jan.pdf" from /Users/x/docs') ===
   signature('open "report-feb.pdf" from /Users/y/files'),
   "filenames and paths do not make two runs look different");
ok(signature("scroll down 40 lines") === signature("scroll down 900 lines"),
   "numbers are collapsed");
ok(signature("open brave") !== signature("open finder"), "genuinely different intents stay different");

// ---- prompt bridge --------------------------------------------------------
console.log("  the prompt bridge only surfaces confident facts");
_resetForTests();
for (let i = 0; i < 8; i++) record({ kind: "request", text: "always open links in Brave" }, T0 + i * DAY);
consolidate(allEpisodes(), T0 + 8 * DAY);
const block = factsForPrompt(0.35);
ok(block.includes("Brave"), "a confident fact reaches the prompt");
ok(/likely rather than certain/i.test(block),
   "it is framed as inferred, so a stated preference still outranks it");
ok(factsForPrompt(0.99) === "", "raising the bar past the evidence yields nothing");
ok(factsForPrompt(0.35, 40).split("\n").filter((l) => l.startsWith("- ")).length <= 1,
   "the budget is respected");

// ---- housekeeping ---------------------------------------------------------
console.log("  compaction folds access counts in without losing them");
_resetForTests();
const e = record({ kind: "request", text: "check the calendar" }, T0)!;
noteAccessed([e.id, e.id, e.id], T0);
ok(allEpisodes()[0].accessCount === 3, "counts are folded in from the access log");
compact();
ok(allEpisodes()[0].accessCount === 3, "and survive compaction");
ok(stats().accessRecords === 0, "while the access log is emptied");

ok(record({ kind: "request", text: "   " }) === null, "an empty episode is refused");

_resetForTests();
console.log(`\n${pass}/${pass + fail} episodic checks passed\n`);
process.exit(fail ? 1 : 0);
