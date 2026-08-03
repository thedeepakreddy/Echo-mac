/**
 * The trajectory recorder that feeds DeepakLLM.
 *   npm run learntest
 *
 * The rules under test are the ones whose failure is invisible until training
 * day: pairing an action with the screen that came BEFORE it, never labelling
 * the student's own output as teacher data, and keeping secrets out of a file
 * that is meant to live forever.
 */
import { rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  configureLearning,
  startTurn,
  recordStep,
  finishTurn,
  labelPrevious,
  recording,
  datasetStats,
  describeStats,
  trajectoryDir,
  loadAll,
  buildTrainingSet,
  toChatFormat,
  type StepRow,
  type Row,
} from "./learn/trajectory.js";

let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`));

// Never touch the real dataset. The recorder honours JARVIS_TRAJECTORY_DIR, and
// the npm script points it at a throwaway path; this asserts that actually
// happened before a single write or delete. If the override is missing,
// trajectoryDir would still be ~/.jarvis/trajectories and this refuses to run
// rather than write and delete in there.
const REAL = join(homedir(), ".jarvis", "trajectories");
if (trajectoryDir === REAL || !/learntest/.test(trajectoryDir)) {
  console.error(`\nrefusing to run: trajectory dir is ${trajectoryDir}.`);
  console.error("This test writes and deletes; it must be pointed at a throwaway");
  console.error("directory via JARVIS_TRAJECTORY_DIR (the npm script does this).\n");
  process.exit(1);
}
// Start from a clean slate in case a previous run was interrupted mid-test.
rmSync(trajectoryDir, { recursive: true, force: true });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rows(): Row[] {
  if (!existsSync(trajectoryDir)) return [];
  const out: Row[] = [];
  for (const f of readdirSync(trajectoryDir).filter((n) => n.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(trajectoryDir, f), "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

const steps = (): StepRow[] => rows().filter((r): r is StepRow => r.type === "step");

const look = (text: string) => ({
  tool: "read_screen_text",
  args: {},
  tier: "low",
  reason: "reads only",
  allowed: true,
  resultText: text,
});

const act = (tool: string, args: Record<string, unknown>, allowed = true) => ({
  tool,
  args,
  tier: "medium",
  reason: `${tool} on screen`,
  allowed,
  resultText: "done",
});

console.log("\nTrajectory recording\n");

// Screens are off throughout: sips would be real work, and the image path is
// exercised separately by the app itself.
configureLearning({ enabled: true, captureScreens: false, maxStepsPerTurn: 5 });

console.log("  nothing is recorded outside a user turn");
recordStep(act("click", { x: 1, y: 2 }));
await wait(30);
ok(steps().length === 0, "a background tool call writes nothing");
ok(!recording(), "and no turn is open");

console.log("  a turn captures what the teacher did");
startTurn("open my mail", "claude", "claude-sonnet-5");
ok(recording(), "the turn is open");
recordStep(look("Inbox — 3 unread"));
recordStep(act("click_ui_element", { description: "Compose" }));
await wait(40);

let s = steps();
ok(s.length === 2, `two steps recorded (got ${s.length})`);
ok(s[0].command === "open my mail", "the user's words ride on every row");
ok(s[0].source === "claude", "the teacher is named");
ok(s[0].model === "claude-sonnet-5", "so is the exact model");
ok(s[0].step === 1 && s[1].step === 2, "steps are numbered in order");

console.log("  an action is paired with the screen that preceded it");
// This is the one that matters. The click must carry the observation from
// BEFORE it; pairing it with a later screen would train the model to predict a
// click from the state that click produced.
ok(s[0].observation === null, "the first look had nothing to see yet");
ok(s[1].observation?.kind === "ocr", "the click carries an observation");
ok(
  s[1].observation?.text?.includes("Inbox") === true,
  "and it is the text that was on screen before the click"
);

console.log("  outcomes are recorded separately, not rewritten in place");
finishTurn("success", "turn completed");
await wait(30);
const labels = rows().filter((r) => r.type === "label");
ok(labels.length === 1, "one label row was appended");
ok((labels[0] as any).outcome === "success", "with the outcome");
ok(steps().length === 2, "and the step rows were left untouched");

console.log("  a refused action is kept as a negative example");
startTurn("delete everything", "claude");
recordStep(act("run_terminal_command", { command: "rm -rf ~/Documents" }, false));
finishTurn("rejected", "user said no");
await wait(30);
const refused = steps().find((r) => r.tool === "run_terminal_command");
ok(!!refused, "the refused call is still written");
ok(refused?.allowed === false, "marked as not allowed");

console.log("  an undo retroactively marks the previous turn as failed");
startTurn("rename the file", "claude");
recordStep(act("write_local_file", { path: "/tmp/x", content: "hi" }));
finishTurn("success", "turn completed");
startTurn("no, undo that", "claude");
recordStep({ ...act("undo_last", {}), tool: "undo_last" });
await wait(40);
const failures = rows().filter((r) => r.type === "label" && (r as any).outcome === "failure");
ok(failures.length >= 1, "a failure label was written for the earlier turn");
finishTurn("success", "turn completed");

console.log("  the student's own output is tagged so it can be excluded");
startTurn("open safari", "deepakllm", "deepakllm:7b");
recordStep(act("open_app", { name: "Safari" }));
finishTurn("success", "turn completed");
await wait(30);
const own = steps().filter((r) => r.source === "deepakllm");
ok(own.length === 1, "student rows are recorded");
ok(
  steps().filter((r) => r.source === "claude").length > 0 && own[0].source === "deepakllm",
  "and are distinguishable from teacher rows"
);

console.log("  secrets never reach the dataset");
// "hunter2" is an ordinary word — no pattern can identify it as a password.
// The turn's own wording is what gives it away, so the context rule has to be
// the thing that catches it.
startTurn("log me in to the bank", "claude");
recordStep(act("type_text", { text: "hunter2", password: "hunter2" }));
finishTurn("success", "turn completed");
startTurn("write a note", "claude");
recordStep(act("type_text", { text: "my api_key is sk-ant-abc123" }));
recordStep(act("type_text", { text: "remember to buy milk" }));
finishTurn("success", "turn completed");
await wait(30);
const typed = steps().filter((r) => r.tool === "type_text");
ok(typed.some((r) => r.args.password === "[redacted]"), "a secret-named field is redacted");
ok(
  typed.every((r) => !JSON.stringify(r.args).includes("sk-ant-abc123")),
  "a secret-looking value is redacted"
);
ok(
  typed.every((r) => !JSON.stringify(r.args).includes("hunter2")),
  "and anything typed during a sign-in turn is redacted on context alone"
);
ok(
  typed.some((r) => r.args.text === "remember to buy milk"),
  "while ordinary typing is kept intact"
);

console.log("  a runaway turn is capped rather than filling the disk");
startTurn("loop forever", "claude");
for (let i = 0; i < 20; i++) recordStep(act("click", { x: i, y: i }));
await wait(40);
const capped = steps().filter((r) => r.command === "loop forever");
ok(capped.length === 5, `capped at maxStepsPerTurn (got ${capped.length})`);
finishTurn("failure", "runaway");

console.log("  disabling it stops recording entirely");
configureLearning({ enabled: false });
const before = steps().length;
startTurn("should not appear", "claude");
recordStep(act("click", { x: 9, y: 9 }));
await wait(30);
ok(steps().length === before, "nothing more is written when off");
ok(!recording(), "and no turn is considered open");

console.log("  the dataset can be summarised");
configureLearning({ enabled: true });
const stat = await datasetStats();
ok(stat.steps > 0 && stat.turns > 0, `${stat.steps} steps across ${stat.turns} turns`);
ok(stat.rejected >= 1, "refused actions are counted");
ok((stat.bySource.claude ?? 0) > 0, "sources are counted");
ok(describeStats(stat).includes("Stored in"), "and described in one line");

console.log("  the exporter drops everything unsafe to train on");
const set = buildTrainingSet(await loadAll());
ok(
  set.examples.every((e) => e.source !== "deepakllm"),
  "no example came from the student itself"
);
ok(set.dropped.student >= 1, "and those rows are counted as dropped");
ok(set.dropped.refused >= 1, "refused actions are excluded from the imitation set");
ok(set.dropped.failed >= 1, "so are turns that failed or were undone");
ok(
  set.examples.every((e) => e.command && e.action.tool),
  "every kept example has a task and an action"
);
ok(
  !JSON.stringify(set.examples).includes("hunter2"),
  "redaction survives into the exported set"
);

const chat = toChatFormat(set.examples[0]) as any;
ok(chat.messages?.length === 3, "chat format has system, user and assistant turns");
ok(
  typeof chat.messages[2].content === "string" && chat.messages[2].content.includes("\"tool\""),
  "the assistant turn is the tool call the teacher made"
);

rmSync(trajectoryDir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} trajectory checks passed\n`);
process.exit(fail ? 1 : 0);
