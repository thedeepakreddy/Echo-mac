/**
 * Durable continuation: named logs, isolated concurrent clones, automatic
 * retry, and restart recovery from a checkpoint left in `running` state.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain } from "./brain/types.js";
import { currentLoop } from "./agent-replay/loop-log.js";
import { classifyProviderError } from "./agent-replay/loop-log.js";
import { Recorder } from "./agent-replay/recorder.js";
import {
  RecordingBrain,
  pendingRecoveries,
  recordLLM,
} from "./agent-replay/runtime.js";
import {
  createRecoveryCheckpoint,
  readRecoveryCheckpoint,
  writeRecoveryCheckpoint,
} from "./agent-replay/recovery.js";
import type { AgentIdentity } from "./agent-replay/context.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const events = (dir: string) => readFileSync(join(dir, "events.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((line) => JSON.parse(line));
const runDirs = (root: string) => readdirSync(root)
  .map((name) => join(root, name))
  .filter((dir) => {
    try { return events(dir).length > 0; } catch { return false; }
  });

let pass = 0;
function ok(value: unknown, message: string): void {
  if (!value) throw new Error(message);
  pass++;
  console.log(`  ✓ ${message}`);
}

class StopsOnceBrain extends Brain {
  sends: string[] = [];
  private calls = 0;

  send(text: string): void {
    this.sends.push(text);
    const call = this.calls++;
    queueMicrotask(() => {
      const log = currentLoop();
      log?.iterationStart(0, 1, 10);
      if (call === 0) {
        log?.toolStart("write_file", { path: "/tmp/example" });
        log?.exit("stream_closed", { detail: "simulated dead provider" });
      } else {
        this.emitEvent("text", "Recovered and finished.");
        log?.exit("completed", { detail: "finished after checkpoint" });
      }
      this.emitEvent("turnEnd");
    });
  }
  interrupt(): void {}
  async stop(): Promise<void> {}
}

class DelayedBrain extends Brain {
  constructor(private readonly label: string, private readonly delay: number) { super(); }
  send(text: string): void {
    void (async () => {
      await wait(this.delay);
      const log = currentLoop();
      log?.iterationStart(0, 1, 10);
      await recordLLM({ label: this.label, text }, async () => ({ label: this.label }));
      log?.exit("completed", { detail: this.label });
      this.emitEvent("turnEnd");
    })();
  }
  interrupt(): void {}
  async stop(): Promise<void> {}
}

class TimesOutOnceBrain extends Brain {
  private calls = 0;
  send(_text: string): void {
    const call = this.calls++;
    void (async () => {
      const log = currentLoop();
      log?.iterationStart(0, 1, 10);
      try {
        await recordLLM({ call }, async () => {
          if (call === 0) await wait(80);
          return { ok: true };
        });
        log?.exit("completed", { detail: "request returned" });
      } catch (error) {
        const reason = classifyProviderError(error);
        this.emitEvent("error", String((error as Error).message));
        log?.exit(reason, { error, detail: "deadline fired" });
      }
      this.emitEvent("turnEnd");
    })();
  }
  interrupt(): void {}
  async stop(): Promise<void> {}
}

/**
 * Re-entry point for the bare-process check below.
 *
 * Schedules a recovery and then returns, leaving the event loop with nothing
 * to do except that timer. If the timer does not hold the loop open, node
 * exits here and the recovery the user was promised never runs.
 */
if (process.argv.includes("--bare-recovery")) {
  const brain = new RecordingBrain(new StopsOnceBrain(), "test", {}, {
    identity: { id: "bare", name: "Echo Bare", kind: "clone" },
    maxRecoveryAttempts: 2,
    recoveryDelayMs: 150,
  });
  brain.on("text", () => {});
  brain.on("error", () => {});
  brain.on("turnEnd", () => console.log("BARE_RECOVERY_FIRED"));
  brain.send("a task nothing else is keeping alive");
  // No await, no interval, no open socket: the recovery timer is on its own.
}

if (!process.argv.includes("--bare-recovery")) {

console.log("\nDurable recovery\n");
process.env.ECHO_LOG_QUIET = "1";
process.env.ECHO_RECOVERY_DELAY_MS = "0";

console.log("  an incomplete loop continues automatically");
{
  const root = mkdtempSync(join(tmpdir(), "echo-recovery-live-"));
  process.env.ECHO_LOG_DIR = root;
  const identity: AgentIdentity = { id: "clone-test-1", name: "Echo Clone 1", kind: "clone" };
  const inner = new StopsOnceBrain();
  const brain = new RecordingBrain(inner, "test", { model: "fake" }, {
    identity,
    maxRecoveryAttempts: 2,
    recoveryDelayMs: 0,
  });
  let outerEnds = 0;
  const done = new Promise<void>((resolve) => brain.on("turnEnd", () => { outerEnds++; resolve(); }));
  brain.send("finish the original task");
  await Promise.race([done, wait(3000).then(() => { throw new Error("automatic recovery timed out"); })]);

  const dirs = runDirs(root);
  ok(dirs.length === 2, "the original attempt and recovery have separate run directories");
  ok(dirs.every((dir) => dir.split("/").at(-1)?.startsWith("Echo Clone 1--")), "both logs carry the clone's readable name");
  const checkpoints = dirs.map(readRecoveryCheckpoint).filter(Boolean)!;
  const latest = checkpoints.sort((a, b) => (a!.updatedAt - b!.updatedAt)).at(-1)!;
  ok(latest?.status === "completed", "the logical task checkpoint ends completed");
  ok(latest?.recoveryAttempts === 1, "one recovery attempt is recorded durably");
  ok(inner.sends[1]?.includes("finish the original task"), "the recovery reads the original task from disk state");
  ok(inner.sends[1]?.includes("never repeat them blindly"), "uncertain side effects are verified before repetition");
  ok(outerEnds === 1, "the app sees one final turn end, not a false end before recovery");
}

console.log("  concurrent clones never cross-write their tapes");
{
  const root = mkdtempSync(join(tmpdir(), "echo-recovery-isolation-"));
  process.env.ECHO_LOG_DIR = root;
  const a = new RecordingBrain(new DelayedBrain("alpha", 40), "test", {}, {
    identity: { id: "a", name: "Echo Clone 7", kind: "clone" }, autoResume: false,
  });
  const b = new RecordingBrain(new DelayedBrain("beta", 5), "test", {}, {
    identity: { id: "b", name: "Echo Clone 8", kind: "clone" }, autoResume: false,
  });
  const doneA = new Promise<void>((resolve) => a.on("turnEnd", resolve));
  const doneB = new Promise<void>((resolve) => b.on("turnEnd", resolve));
  a.send("alpha prompt");
  b.send("beta prompt");
  await Promise.all([doneA, doneB]);

  const dirs = runDirs(root);
  ok(dirs.length === 2, "two simultaneous clones write two runs");
  for (const dir of dirs) {
    const tape = events(dir);
    const start = tape.find((event) => event.type === "run.start");
    const request = tape.find((event) => event.type === "llm.request");
    const name = String(start?.actor?.name);
    const expected = name === "Echo Clone 7" ? "alpha" : "beta";
    const requestBody = readFileSync(join(dir, "blobs", request.bodyRef), "utf8");
    ok(requestBody.includes(expected), `${name} contains only its own provider request`);
    ok(!requestBody.includes(expected === "alpha" ? "beta" : "alpha"), `${name} excludes the other clone's request`);
  }
}

console.log("  a hung model request reaches recovery instead of hanging forever");
{
  const root = mkdtempSync(join(tmpdir(), "echo-recovery-timeout-"));
  process.env.ECHO_LOG_DIR = root;
  process.env.ECHO_LLM_TIMEOUT_MS = "15";
  const brain = new RecordingBrain(new TimesOutOnceBrain(), "test", {}, {
    identity: { id: "timeout", name: "Echo Clone 9", kind: "clone" },
    maxRecoveryAttempts: 1,
    recoveryDelayMs: 0,
  });
  let surfacedErrors = 0;
  brain.on("error", () => surfacedErrors++);
  const done = new Promise<void>((resolve) => brain.on("turnEnd", resolve));
  brain.send("finish despite a stuck provider");
  await Promise.race([done, wait(3000).then(() => { throw new Error("deadline recovery timed out"); })]);
  const dirs = runDirs(root);
  ok(dirs.length === 2, "the request deadline starts a separate recovery run");
  ok(dirs.flatMap(events).some((event) => event.type === "llm.error" && /timed out/.test(event.message)), "the timed-out request is recorded explicitly");
  ok(surfacedErrors === 0, "a recovered transient timeout is not reported as final failure");
  delete process.env.ECHO_LLM_TIMEOUT_MS;
}

console.log("  a process-kill checkpoint is discovered and resumed on startup");
{
  const root = mkdtempSync(join(tmpdir(), "echo-recovery-restart-"));
  process.env.ECHO_LOG_DIR = root;
  const actor: AgentIdentity = { id: "echo", name: "Echo", kind: "main" };
  const deadRun = new Recorder(root, "Echo--dead-process");
  const checkpoint = createRecoveryCheckpoint(actor, "complete the interrupted build", 2);
  checkpoint.actions.push({ name: "run_terminal_command", status: "started", at: Date.now() });
  writeRecoveryCheckpoint(deadRun.dir, checkpoint);

  const found = pendingRecoveries();
  ok(found.length === 1 && found[0].taskId === checkpoint.taskId, "startup finds the newest running checkpoint");

  class CompletesBrain extends Brain {
    sent = "";
    send(text: string): void {
      this.sent = text;
      queueMicrotask(() => {
        currentLoop()?.exit("completed", { detail: "startup recovery complete" });
        this.emitEvent("turnEnd");
      });
    }
    interrupt(): void {}
    async stop(): Promise<void> {}
  }
  const inner = new CompletesBrain();
  const brain = new RecordingBrain(inner, "test", {}, { identity: actor, recoveryDelayMs: 0 });
  const done = new Promise<void>((resolve) => brain.on("turnEnd", resolve));
  ok(brain.recoverFromCheckpoint(found[0]), "a fresh brain accepts the persisted task");
  await Promise.race([done, wait(3000).then(() => { throw new Error("restart recovery timed out"); })]);
  ok(inner.sent.includes("complete the interrupted build"), "the fresh brain receives the original goal");
  ok(inner.sent.includes("run_terminal_command"), "the fresh brain receives the uncertain last action");
}

console.log("  stopping mid-backoff cancels the retry for good");
{
  // The gap between a failed attempt and its retry is the one moment when the
  // run context is already gone, so the abort_signal path marks nothing. A
  // checkpoint left `pending` here is resumed at the NEXT LAUNCH — the task you
  // stopped coming back hours later.
  const halts = [
    ["interrupt", (brain: RecordingBrain) => { brain.interrupt(); }],
    ["stop", async (brain: RecordingBrain) => { await brain.stop(); }],
  ] as const;

  for (const [label, halt] of halts) {
    const root = mkdtempSync(join(tmpdir(), `echo-recovery-cancel-${label}-`));
    process.env.ECHO_LOG_DIR = root;
    const brain = new RecordingBrain(new StopsOnceBrain(), "test", {}, {
      identity: { id: `cancel-${label}`, name: "Echo Clone 4", kind: "clone" },
      maxRecoveryAttempts: 2,
      // Long enough that the retry is still waiting when the user gives up.
      recoveryDelayMs: 5000,
    });
    // The failed attempt's turnEnd is suppressed so recovery can carry the task
    // on. Cancel that recovery and nothing is left to close the turn, so the
    // caller waits in "thinking" forever unless the cancel says so itself.
    let ends = 0;
    let spoken = 0;
    brain.on("turnEnd", () => ends++);
    brain.on("text", () => spoken++);
    brain.on("error", () => {});
    brain.send("a task the user gives up on");
    await wait(60); // let the first attempt fail into its backoff

    const waiting = runDirs(root).map(readRecoveryCheckpoint).filter(Boolean);
    ok(waiting.some((cp) => cp!.status === "pending"),
      `${label}: the retry is genuinely waiting before we stop it`);
    ok(ends === 0, `${label}: the turn is still open while the retry waits`);
    const runsBefore = runDirs(root).length;
    const spokenBefore = spoken;

    await halt(brain);
    await wait(120); // long enough for the cancelled retry to have fired

    ok(ends === 1, `${label}: the cancel ends the turn exactly once`);
    ok(spoken > spokenBefore, `${label}: the user is told the cancel took effect`);
    ok(runDirs(root).length === runsBefore, `${label}: no new run begins after the cancel`);

    const after = runDirs(root).map(readRecoveryCheckpoint).filter(Boolean);
    ok(after.length > 0 && after.every((cp) => cp!.status !== "pending"),
      `${label}: no checkpoint is left pending on disk`);
    ok(after.some((cp) => cp!.status === "cancelled"),
      `${label}: the stopped task is recorded as cancelled`);
    ok(pendingRecoveries().length === 0,
      `${label}: the next launch finds nothing to resume`);
  }
}

console.log("  a scheduled recovery keeps the process alive long enough to run");
{
  // `this.recoveryTimer.unref?.()` meant the retry did not hold the event loop
  // open. In the Electron main process something else usually does, which is
  // why this was invisible; anywhere else the process exits during the backoff
  // right after telling the user the task is being continued.
  const root = mkdtempSync(join(tmpdir(), "echo-recovery-handle-"));
  process.env.ECHO_LOG_DIR = root;
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const brain = new RecordingBrain(new StopsOnceBrain(), "test", {}, {
    identity: { id: "handle", name: "Echo Clone 5", kind: "clone" },
    maxRecoveryAttempts: 2,
    // Still waiting while we look at it.
    recoveryDelayMs: 5000,
  });
  brain.on("text", () => {});
  const before = timeouts();
  brain.send("a retry that must survive an idle event loop");
  await wait(60);
  ok(timeouts() > before, "the pending retry is a handle that holds the event loop open");
  await brain.stop();
  ok(timeouts() <= before, "stopping releases that handle again");

  // And the same thing end to end: a fresh process with nothing else running.
  const bareRoot = mkdtempSync(join(tmpdir(), "echo-recovery-bare-"));
  const output = execFileSync(process.execPath, [process.argv[1], "--bare-recovery"], {
    encoding: "utf8",
    env: { ...process.env, ECHO_LOG_DIR: bareRoot, ECHO_LOG_QUIET: "1" },
    timeout: 20_000,
  });
  ok(output.includes("BARE_RECOVERY_FIRED"),
    "a bare process stays alive through the backoff and runs the recovery");
  ok(runDirs(bareRoot).length === 2,
    "the bare process leaves both the failed attempt and its recovery on disk");
}

delete process.env.ECHO_LOG_DIR;
delete process.env.ECHO_LOG_QUIET;
delete process.env.ECHO_RECOVERY_DELAY_MS;
console.log(`\n${pass}/${pass} recovery checks passed\n`);

}
