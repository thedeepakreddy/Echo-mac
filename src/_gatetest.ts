/**
 * The shared risk gate.
 *
 *   npm run gatetest
 *
 * This exists because of a real escape. A live test asked Jarvis to `rm` a
 * file; the Claude brain relied on the SDK's canUseTool hook, which is not
 * invoked for in-process MCP tools, so run_terminal_command reached the shell
 * unclassified and the file was deleted with nothing asked. The Gemini brain
 * had no risk check at all. These tests hold the choke point in place.
 */
import { runGated, decide, resetGateMemory, DENIAL_MESSAGE } from "./safety/gate.js";
import { confirmations } from "./safety/confirm.js";
import { TOOLS } from "./tools/registry.js";
import type { ToolDef } from "./tools/registry.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const CTX = { workingDir: "/tmp/jarvis-gate-test" };

/** Answer every confirmation the same way, and count how many were asked. */
let asked: string[] = [];
let answer = false;
confirmations.on("ask", ({ id, question }: { id: string; question: string }) => {
  asked.push(question);
  setTimeout(() => confirmations.settle(id, answer, "test"), 5);
});
const fresh = (allow: boolean) => {
  asked = [];
  answer = allow;
  resetGateMemory();
};

let ran = 0;
const fakeTool = (name: string): ToolDef => ({
  name,
  description: "test",
  schema: {},
  readOnly: false,
  handler: async () => {
    ran++;
    return { text: "EXECUTED" };
  },
});

console.log("\nShared risk gate\n");

console.log("  a destructive command is stopped when refused");
{
  fresh(false);
  ran = 0;
  const out = await runGated(fakeTool("run_terminal_command"), { command: "rm -rf /tmp/x" }, CTX);
  ok(asked.length === 1, `a confirmation was requested (${asked.length})`);
  ok(/delete files/i.test(asked[0] ?? ""), `and it names the danger: "${(asked[0] ?? "").slice(0, 50)}"`);
  ok(ran === 0, "the handler NEVER RAN");
  ok(out.text === DENIAL_MESSAGE, "and the model is told it was refused");
}
{
  fresh(true);
  ran = 0;
  const out = await runGated(fakeTool("run_terminal_command"), { command: "rm -rf /tmp/x" }, CTX);
  ok(asked.length === 1, "approving still asks first");
  ok(ran === 1, "and then the handler runs");
  ok(out.text === "EXECUTED", "returning its real output");
}
{
  // The exact hole that was found: Jarvis's own shell tool, not the SDK's.
  fresh(false);
  ran = 0;
  await runGated(fakeTool("run_terminal_command"), { command: "sudo rm -rf /" }, CTX);
  ok(ran === 0, "run_terminal_command cannot reach the shell unclassified");
}

console.log("  ordinary work is not interrupted");
{
  fresh(false);
  ran = 0;
  const out = await runGated(fakeTool("screenshot"), {}, CTX);
  ok(asked.length === 0, "a read-only tool asks nothing");
  ok(ran === 1, "and just runs");
  ok(out.text === "EXECUTED", "returning its output");
}
{
  fresh(false);
  ran = 0;
  await runGated(fakeTool("click"), { x: 10, y: 10 }, CTX);
  ok(asked.length === 0 && ran === 1, "an ordinary UI action is not confirmed either");
}
{
  fresh(false);
  ran = 0;
  await runGated(fakeTool("run_terminal_command"), { command: "ls -la" }, CTX);
  ok(asked.length === 0 && ran === 1, "a harmless shell command is not confirmed");
}

console.log("  the user is not asked twice for one action");
{
  // Both canUseTool and the handler wrapper can see the same call. Without
  // dedupe that is two prompts for one `rm`, which trains people to say yes.
  fresh(false);
  const input = { command: "rm -rf /tmp/y" };
  const first = await decide("run_terminal_command", input, CTX);
  const second = await decide("run_terminal_command", input, CTX);
  ok(asked.length === 1, `asked once, not twice (${asked.length})`);
  ok(!first.allowed && !second.allowed, "and both layers get the same refusal");
}
{
  fresh(true);
  const a = await decide("run_terminal_command", { command: "rm /tmp/a" }, CTX);
  const b = await decide("run_terminal_command", { command: "rm /tmp/DIFFERENT" }, CTX);
  ok(asked.length === 2, "but a DIFFERENT command is asked about separately");
  ok(a.allowed && b.allowed, "and each gets its own answer");
}
{
  // The cache must not turn one "yes" into blanket approval later.
  fresh(true);
  await decide("run_terminal_command", { command: "rm /tmp/z" }, CTX);
  resetGateMemory();
  answer = false;
  const later = await decide("run_terminal_command", { command: "rm /tmp/z" }, CTX);
  ok(!later.allowed, "an earlier yes does not approve the same command forever");
}

console.log("  a failing tool does not look like a refusal");
{
  fresh(true);
  const boom: ToolDef = {
    name: "screenshot", description: "", schema: {}, readOnly: true,
    handler: async () => { throw new Error("camera on fire"); },
  };
  const out = await runGated(boom, {}, CTX);
  ok(/camera on fire/.test(out.text ?? ""), "the real error is reported");
  ok(out.text !== DENIAL_MESSAGE, "and is not confused with the user saying no");
}

console.log("  every registered tool is classifiable");
{
  // A tool the classifier has never heard of still has to get a tier — the
  // default must be a real decision, not an accident.
  let unclassified = 0;
  for (const t of TOOLS) {
    const d = await decide(t.name, {}, CTX).catch(() => null);
    resetGateMemory();
    if (!d || !["low", "medium", "high"].includes(d.assessment.tier)) unclassified++;
  }
  ok(unclassified === 0, `all ${TOOLS.length} registered tools receive a tier (${unclassified} did not)`);
}

console.log(`\n${pass}/${pass + fail} gate checks passed\n`);
process.exit(fail ? 1 : 0);
