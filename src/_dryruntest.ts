/**
 * Workflow previews.
 *
 *   npm run dryruntest
 *
 * The claim a preview makes is "nothing was changed". These tests check the
 * reporting logic that surrounds that claim — in particular that a step which
 * COULD NOT be checked is never reported as one that passed.
 */
import { describeDryRun, type StepResult } from "./frontier/replay.js";
import type { Step } from "./frontier/demonstrate.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const step = (target = "Send"): Step => ({ kind: "click", target } as Step);
const res = (how: StepResult["how"], note: string, okFlag = true): StepResult =>
  ({ step: step(), ok: okFlag, how, note });

console.log("\nWorkflow previews\n");

console.log("  it always says nothing happened");
{
  const out = describeDryRun([res("accessibility", 'would click "Send"')], 0);
  ok(/nothing was changed/i.test(out), "the report opens by saying nothing was changed");
  ok(/would click/.test(out), "and describes the action in the conditional");
  ok(!/\bclicked\b/.test(out), "never in the past tense, which would imply it acted");
}

console.log("  unresolvable steps are not passed off as fine");
{
  const out = describeDryRun([
    res("accessibility", 'would click "Compose"'),
    res("skipped", 'would type "hello"'),
    res("unverified", `couldn't check "Send" — it appears after a step I didn't perform`),
  ], 0);
  ok(/could not be checked/i.test(out), "it states that something could not be checked");
  ok(/1 could not be checked/.test(out), "and how many");
  ok(!/Every step resolved/.test(out), "and does NOT claim every step resolved");
}
{
  const out = describeDryRun([
    res("accessibility", 'would click "Compose"'),
    res("screen-text", 'would click "Send"'),
  ], 0);
  ok(/Every step resolved/.test(out), "when everything really did resolve, it says so");
  ok(!/could not be checked/i.test(out), "without a caveat it has not earned");
}

console.log("  a step that would genuinely break is reported as such");
{
  const out = describeDryRun([
    res("accessibility", 'would click "Compose"'),
    res("failed", `could not find "Send Anyway" on screen`, false),
  ], 0);
  ok(/would stop at step 2/i.test(out), "it names the step that would stop the run");
  ok(/Send Anyway/.test(out), "and what it could not find");
}

console.log("  drift is surfaced before it matters");
{
  const out = describeDryRun([res("accessibility", 'would click "Send" (recorded as "Submit")')], 2);
  ok(/2 control\(s\) have moved/.test(out), "controls that have moved since recording are reported");
  ok(/I'd re-find them/.test(out), "along with what would happen about it");
}
{
  ok(!/have moved/.test(describeDryRun([res("direct", "opened Mail")], 0)),
     "and nothing is said about drift when there is none");
}

console.log("  every step is listed, in order");
{
  const out = describeDryRun([
    res("direct", "opened Mail"),
    res("skipped", 'would type "hello"'),
    res("accessibility", 'would click "Send"'),
  ], 0);
  ok(/1\. opened Mail/.test(out), "steps are numbered from one");
  ok(/2\. would type/.test(out) && /3\. would click/.test(out), "and appear in order");
}
{
  ok(typeof describeDryRun([], 0) === "string", "an empty preview still produces a report");
}

console.log(`\n${pass}/${pass + fail} dry-run checks passed\n`);
process.exit(fail ? 1 : 0);
