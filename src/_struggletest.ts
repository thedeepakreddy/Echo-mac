/**
 * Noticing when someone is stuck — and, mostly, keeping quiet about it.
 *
 *   npm run struggletest
 *
 * Nearly every test here asserts that Jarvis stays SILENT. That ratio is the
 * point: an assistant that reads your mood and then says so constantly is
 * worse than one that never noticed.
 */
import {
  signatureOf, noteActivity, observeText, repeatCount, isLate, assess,
  mayOfferHelp, noteOffered, noteDeclined, noteAccepted, offerText,
  styleFor, describe, reset,
} from "./frontier/struggle.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const MIN = 60_000;
// A fixed weekday afternoon, so "is it late?" is not decided by when CI runs.
const NOON = new Date(2026, 6, 21, 14, 0, 0).getTime();
const NIGHT = new Date(2026, 6, 21, 2, 30, 0).getTime();

const ERR = (line: number) =>
  `src/main.ts(${line},12): error TS2345: Argument of type 'string' is not assignable`;

console.log("\nStruggle detection\n");

console.log("  the same error is recognised as the same");
{
  ok(signatureOf(ERR(41)) === signatureOf(ERR(97)),
     "the same error on a different LINE is the same problem");
  ok(signatureOf("failed after 1.2s") === signatureOf("failed after 8.9s"),
     "changing durations do not make it a new problem");
  ok(signatureOf("cannot find module '/a/b/c'") === signatureOf("cannot find module '/x/y/z'"),
     "differing paths do not either");
  ok(signatureOf("error TS2345: bad argument") !== signatureOf("error TS1005: expected ;"),
     "but a genuinely different error is different");
}

console.log("  one failure is not a pattern");
{
  reset();
  noteActivity(NOON);
  observeText(ERR(41), NOON);
  const s = assess(NOON);
  ok(s.mood !== "stuck", `one failure is not being stuck (${s.mood})`);
  ok(!mayOfferHelp(s, NOON), "and nothing is said");
}
{
  reset();
  noteActivity(NOON);
  observeText(ERR(41), NOON);
  observeText(ERR(52), NOON + MIN);
  ok(!mayOfferHelp(assess(NOON + MIN), NOON + MIN), "two is still not enough");
}
{
  reset();
  noteActivity(NOON);
  for (let i = 0; i < 3; i++) observeText(ERR(40 + i), NOON + i * MIN);
  const s = assess(NOON + 3 * MIN);
  ok(s.mood === "stuck", `three of the same problem is being stuck (${s.mood}, ${s.repeats} repeats)`);
  ok(mayOfferHelp(s, NOON + 3 * MIN), "and now it may offer");
  ok(/want me to look/i.test(offerText(s, NOON + 3 * MIN)), `with one short sentence: "${offerText(s, NOON + 3 * MIN)}"`);
}
{
  // Three DIFFERENT problems is a busy afternoon, not a person stuck.
  reset();
  noteActivity(NOON);
  observeText("error TS2345: bad argument", NOON);
  observeText("cannot find module 'left-pad'", NOON + MIN);
  observeText("permission denied", NOON + 2 * MIN);
  const s = assess(NOON + 2 * MIN);
  ok(s.mood !== "stuck", `three different problems is not being stuck (${s.mood})`);
}
{
  // Old failures stop counting.
  reset();
  noteActivity(NOON);
  for (let i = 0; i < 3; i++) observeText(ERR(40 + i), NOON + i * MIN);
  ok(repeatCount(NOON + 90 * MIN).count === 0, "failures from an hour ago no longer count");
  ok(!mayOfferHelp(assess(NOON + 90 * MIN), NOON + 90 * MIN), "so it goes quiet again");
}

console.log("  it does not badger");
{
  reset();
  noteActivity(NOON);
  for (let i = 0; i < 4; i++) observeText(ERR(40 + i), NOON + i * MIN);
  const t = NOON + 4 * MIN;
  ok(mayOfferHelp(assess(t), t), "it may offer once");
  noteOffered(t);
  ok(!mayOfferHelp(assess(t + MIN), t + MIN), "and then not again a minute later");
  ok(!mayOfferHelp(assess(t + 10 * MIN), t + 10 * MIN), "nor ten minutes later");
  ok(mayOfferHelp(assess(t + 25 * MIN), t + 25 * MIN), "but may again after the cooldown");
}
{
  // Being told no is the case that matters most.
  reset();
  noteActivity(NOON);
  for (let i = 0; i < 4; i++) observeText(ERR(40 + i), NOON + i * MIN);
  const t = NOON + 4 * MIN;
  noteOffered(t);
  noteDeclined(t);
  ok(!mayOfferHelp(assess(t + 30 * MIN), t + 30 * MIN), "after a refusal it stays quiet well past the normal cooldown");
  ok(!mayOfferHelp(assess(t + 80 * MIN), t + 80 * MIN), "and longer still");

  // Someone still stuck an hour and a half later is still hitting the error;
  // without fresh evidence the old failures have rightly expired.
  for (let i = 0; i < 3; i++) observeText(ERR(60 + i), t + (95 + i) * MIN);
  ok(mayOfferHelp(assess(t + 100 * MIN), t + 100 * MIN),
     "before eventually being willing again, if the problem is still live");
}
{
  reset();
  noteActivity(NOON);
  for (let i = 0; i < 6; i++) observeText(ERR(40 + i), NOON + i * MIN);
  let t = NOON + 6 * MIN;
  for (let i = 0; i < 3; i++) {
    noteOffered(t);
    noteDeclined(t);
    t += 500 * MIN; // long enough that only the refusal count can stop it
  }
  ok(!mayOfferHelp(assess(t), t), "told no three times, it stops asking altogether");
}
{
  reset();
  noteActivity(NOON);
  for (let i = 0; i < 4; i++) observeText(ERR(40 + i), NOON + i * MIN);
  const t = NOON + 4 * MIN;
  noteOffered(t);
  noteDeclined(t);
  noteAccepted();
  ok(mayOfferHelp(assess(t + 25 * MIN), t + 25 * MIN),
     "but accepting an offer clears the grudge");
}

console.log("  tiredness is noticed and never announced");
{
  reset();
  noteActivity(NIGHT);
  const s = assess(NIGHT);
  ok(isLate(NIGHT), "2:30am counts as late");
  ok(!isLate(NOON), "2pm does not");
  ok(s.mood === "tired", `and the state reflects it (${s.mood})`);
  ok(!mayOfferHelp(s, NIGHT), "but being tired is never something to speak up about");
  ok(/short/i.test(styleFor(s)), "it only changes how replies are written");
}
{
  reset();
  noteActivity(NOON);
  const s = assess(NOON + 200 * MIN);
  ok(s.mood === "tired", `a long sitting is tiring even at midday (${s.mood})`);
  ok(/hours/.test(s.reasons.join(" ")), "and it can say why");
}
{
  // Being stuck outranks being tired: it is the more useful of the two.
  reset();
  noteActivity(NIGHT);
  for (let i = 0; i < 3; i++) observeText(ERR(40 + i), NIGHT + i * MIN);
  ok(assess(NIGHT + 3 * MIN).mood === "stuck", "stuck outranks tired when both are true");
}

console.log("  sessions");
{
  reset();
  noteActivity(NOON);
  noteActivity(NOON + 5 * MIN);
  ok(assess(NOON + 5 * MIN).sessionMinutes === 5, "continuous work accumulates");

  // Going away and coming back is a NEW session, not one with a hole in it.
  noteActivity(NOON + 300 * MIN);
  ok(assess(NOON + 300 * MIN).sessionMinutes === 0,
     "a long gap starts a fresh session rather than a five-hour one");
}

console.log("  how it describes itself");
{
  reset();
  noteActivity(NOON);
  ok(/calm/i.test(describe(assess(NOON))), "a quiet moment reads as calm");
  for (let i = 0; i < 3; i++) observeText(ERR(40 + i), NOON + i * MIN);
  const s = assess(NOON + 3 * MIN);
  ok(/fighting something/i.test(describe(s)), "being stuck is described plainly");
  ok(/3 times/.test(describe(s)), "with the evidence");
}
{
  // A fresh state must add nothing to the prompt. Left over from the previous
  // block, this asserted "calm" while three failures were still on record.
  reset();
  noteActivity(NOON);
  ok(styleFor(assess(NOON)) === "", "a calm state adds no instruction at all");
}

reset();
console.log(`\n${pass}/${pass + fail} struggle checks passed\n`);
process.exit(fail ? 1 : 0);
