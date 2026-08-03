/**
 * Shell-escaping, verified by actually running the escaped commands.
 *
 * Voice shortcuts interpolate spoken text into a shell string, so a bad escape
 * turns speech into code execution. Asserting on the escaped *string* would only
 * test my idea of correctness — these cases execute it and then check that the
 * payload did not fire and the value survived intact.
 *
 *   npm run shelltest
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { shellQuote } from "./safety/shellquote.js";

const CANARY = "/tmp/JARVIS_INJECTION_CANARY";

let pass = 0;
let fail = 0;
const ok = (c: boolean, msg: string) => (c ? (pass++, console.log(`  ✓ ${msg}`)) : (fail++, console.log(`  ✗ ${msg}`)));

console.log("\nShell escaping (executed, not just compared)\n");

/** Payloads that would break out of the quoting if the escape were wrong. */
const attacks = [
  `x'; touch ${CANARY}; echo '`,
  `x"; touch ${CANARY}; echo "`,
  `x$(touch ${CANARY})`,
  "x`touch " + CANARY + "`",
  `x; touch ${CANARY}`,
  `x && touch ${CANARY}`,
  `x | touch ${CANARY}`,
  `x\n touch ${CANARY}`,
];

for (const payload of attacks) {
  rmSync(CANARY, { force: true });
  let output = "";
  try {
    output = execSync(`echo ${shellQuote(payload)}`, { encoding: "utf8" });
  } catch {
    output = "<command failed>";
  }
  const fired = existsSync(CANARY);
  const label = JSON.stringify(payload.slice(0, 34));
  ok(!fired, `payload did not execute: ${label}`);
}
rmSync(CANARY, { force: true });

// The escape must also preserve the value — a mangled parameter is a silent bug.
const values = [
  "hello world",
  "it's a test",
  "quote\" and 'quote'",
  "spaces   and\ttabs",
  "unicode — em dash, café",
  "$HOME ${PATH} `pwd`",
  "100% & more",
];
for (const v of values) {
  const out = execSync(`printf %s ${shellQuote(v)}`, { encoding: "utf8" });
  ok(out === v, `value preserved exactly: ${JSON.stringify(v.slice(0, 30))}`);
}

console.log(`\n${pass}/${pass + fail} shell-escaping checks passed\n`);
process.exit(fail ? 1 : 0);
