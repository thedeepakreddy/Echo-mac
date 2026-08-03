/**
 * Companion mode's restraint — the part that keeps it from being annoying.
 *
 *   npm run companiontest
 *
 * The decision logic is tested with an injected clock and coin-flip, so no real
 * mouse, timer, or voice is involved.
 */
import { decideCheckIn, newCompanionState, COMPANION_PHRASES } from "./tools/companion.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const COOLDOWN = 2 * 60 * 60 * 1000;
const at = (x: number, y: number) => ({ x, y });

console.log("\nCompanion mode\n");

console.log("  it never speaks on the first tick (just learns where you are)");
{
  const s = newCompanionState();
  ok(decideCheckIn(s, at(10, 10), 1000, 0.1, COOLDOWN) === null, "first tick is silent");
  ok(s.lastPos?.x === 10, "but it records position");
}

console.log("  it only speaks when you're actually active");
{
  const s = newCompanionState();
  decideCheckIn(s, at(10, 10), 1000, 0.1, COOLDOWN); // baseline
  ok(decideCheckIn(s, at(10, 10), 2000, 0.1, COOLDOWN) === null, "no movement -> silent");
  const said = decideCheckIn(s, at(50, 60), 3000, 0.1, COOLDOWN);
  ok(typeof said === "string", "movement + good roll -> speaks");
  ok(COMPANION_PHRASES.includes(said as string), "and it's one of the real phrases");
}

console.log("  the coin flip keeps it a surprise");
{
  const s = newCompanionState();
  decideCheckIn(s, at(0, 0), 1000, 0.5, COOLDOWN);
  ok(decideCheckIn(s, at(1, 1), 2000, 0.9, COOLDOWN) === null, "a high roll stays quiet even when moving");
  ok(decideCheckIn(s, at(2, 2), 3000, 0.24, COOLDOWN) !== null, "a low roll speaks");
}

console.log("  the long cooldown prevents chatter");
{
  const s = newCompanionState();
  decideCheckIn(s, at(0, 0), 1000, 0.1, COOLDOWN); // baseline
  const first = decideCheckIn(s, at(5, 5), 2000, 0.1, COOLDOWN);
  ok(first !== null, "it speaks once");
  ok(decideCheckIn(s, at(9, 9), 2000 + 60 * 60 * 1000, 0.1, COOLDOWN) === null,
     "and stays silent an hour later — still inside the 2h cooldown");
  ok(decideCheckIn(s, at(12, 12), 2000 + COOLDOWN + 1, 0.1, COOLDOWN) !== null,
     "but speaks again once the cooldown has fully elapsed");
}

console.log(`\n${pass}/${pass + fail} companion checks passed\n`);
process.exit(fail ? 1 : 0);
