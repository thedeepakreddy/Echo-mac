/**
 * Forces every exit reason and checks the log names it correctly.
 *
 * The silent-stop bug was not that the loop stopped — loops stop — it was that
 * five different stops all wrote `completed` to the log. So the thing worth
 * testing is not that the loop ends, but that the recorded REASON matches the
 * cause. Each case here stubs the provider into one specific failure and then
 * reads back `loop.exit` from the JSONL.
 *
 * `unknown_fallthrough` failing a case is the important signal: it means a path
 * out of the loop exists that does not name itself.
 */
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "echo-exittest-"));
process.env.ECHO_LOG_DIR = root;
process.env.ECHO_LOG_QUIET = "1";
process.env.ECHO_MAX_ITERATIONS = "2";
process.env.ECHO_AUTO_CONTINUE_LIMIT = "1";
// Keep episodic writes out of the real store while testing.
process.env.JARVIS_EPISODIC_DIR = join(root, "episodic");

const { GeminiBrain } = await import("./brain/gemini.js");
const { RecordingBrain } = await import("./agent-replay/runtime.js");
const { LOOP_CAPS } = await import("./brain/types.js");

let pass = 0;
let fail = 0;

const cfg: any = {
  brain: "gemini",
  gemini: { model: "test-model", apiKeyEnv: "GEMINI_API_KEY" },
  claude: { model: "test", systemPromptPreset: "none" },
  ollama: { model: "test", host: "http://localhost:11434" },
  control: { workingDir: process.cwd(), cliclickBin: "/usr/bin/true" },
};

/** A Gemini response with the given parts and finish reason. */
const reply = (parts: any[] | null, finishReason = "STOP", extra: any = {}) => ({
  candidates: [{ content: parts ? { role: "model", parts } : undefined, finishReason }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  ...extra,
});

/** Run one turn against a stubbed provider and return its loop.exit event. */
async function runCase(
  name: string,
  generate: (callCount: number) => Promise<any>,
  opts: { interruptAfterMs?: number; maxIterations?: number } = {}
): Promise<any> {
  process.env.ECHO_MAX_ITERATIONS = String(opts.maxIterations ?? 2);
  const before = new Set(existsSync(root) ? readdirSync(root) : []);
  const inner = new GeminiBrain(cfg, "test-key");
  // Stub the transport, not the loop: everything under test still runs.
  let calls = 0;
  (inner as any).ai = { models: { generateContent: async () => generate(calls++) } };
  (inner as any).mcpInitialized = true;

  const brain = new RecordingBrain(
    inner,
    "gemini",
    { ...LOOP_CAPS.gemini, model: "test-model" },
    { autoResume: false }
  );
  const done = new Promise<void>((resolve) => {
    brain.on("turnEnd", () => resolve());
    setTimeout(resolve, 15000);
  });
  brain.on("error", () => {});
  brain.on("text", () => {});

  brain.send(`test case: ${name}`);
  if (opts.interruptAfterMs !== undefined) {
    setTimeout(() => brain.interrupt(), opts.interruptAfterMs);
  }
  await done;

  // The episodic test store is also created under `root`. It is not a run
  // directory, so select by the recorder's contract rather than whichever
  // directory the filesystem happens to return first.
  const runDir = () => readdirSync(root).find((d) =>
    !before.has(d) && existsSync(join(root, d, "events.jsonl"))
  );

  // Poll rather than sleeping a fixed amount. `turnEnd` and the exit are
  // written from the same `finally`, but the turnEnd listener can be scheduled
  // ahead of the append on a loaded machine, and a fixed 60ms made this test
  // fail roughly one run in three for timing reasons that say nothing about
  // the code under test.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const dir = runDir();
    if (dir) {
      const file = join(root, dir, "events.jsonl");
      if (existsSync(file)) {
        const events = readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        const exit = events.reverse().find((e) => e.type === "loop.exit");
        if (exit) return exit;
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  // Report what DID land, so a genuine missing-exit failure is diagnosable
  // rather than just absent.
  const dir = runDir();
  if (dir) {
    const file = join(root, dir, "events.jsonl");
    const types = existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).type)
      : [];
    console.log(`      (run dir ${dir} held: ${types.join(", ") || "nothing"})`);
  } else {
    console.log("      (no run directory was created at all)");
  }
  return null;
}

async function expect(
  name: string,
  expected: string,
  generate: (n: number) => Promise<any>,
  opts: { interruptAfterMs?: number; maxIterations?: number } = {}
) {
  let exit: any = null;
  try {
    exit = await runCase(name, generate, opts);
  } catch (err: any) {
    console.log(`  ✗ ${name}: threw ${err?.message ?? err}`);
    fail++;
    return;
  }
  if (!exit) {
    console.log(`  ✗ ${name}: no loop.exit event was written at all`);
    fail++;
    return;
  }
  if (exit.reason === expected) {
    console.log(`  ✓ ${name} -> ${exit.reason}${exit.detail ? ` (${String(exit.detail).slice(0, 60)})` : ""}`);
    pass++;
  } else {
    console.log(`  ✗ ${name}: expected "${expected}", logged "${exit.reason}" (${exit.detail ?? "no detail"})`);
    fail++;
  }
}

console.log(`Forcing each exit reason (logs in ${root})\n`);

// A plain text answer is an ordinary completion.
await expect("model answers and finishes", "completed", async () =>
  reply([{ text: "All done." }], "STOP")
);

// Output truncated at the token limit, leaving no usable content.
await expect("output truncated (MAX_TOKENS)", "context_overflow", async () =>
  reply(null, "MAX_TOKENS")
);

// Blocked by a safety filter — the candidate comes back with no content.
await expect("blocked by safety filter", "provider_error", async () =>
  reply(null, "SAFETY")
);

// Empty content with no reason given at all.
await expect("empty response, no reason", "model_stop_no_tool_call", async () =>
  reply(null, undefined)
);

// Always calls a tool, so the iteration cap (forced to 2) is what stops it.
await expect("iteration cap reached", "max_iterations", async () =>
  reply([{ functionCall: { name: "get_screen_info", args: {} } }], "STOP")
);

// A tool call, then prose that sounds mid-task; the auto-continue budget is 1.
// Needs headroom above the auto-continue budget, or the iteration cap fires
// first and the case proves nothing about the budget.
await expect(
  "auto-continue budget spent",
  "model_stop_no_tool_call",
  async (n) =>
    n === 0
      ? reply([{ functionCall: { name: "get_screen_info", args: {} } }], "STOP")
      : reply([{ text: "Next I will open the file and keep going." }], "STOP"),
  { maxIterations: 20 }
);

// Rate limited on every fallback model in the ladder.
await expect("rate limited (429)", "rate_limit_429", async () => {
  throw new Error("429 RESOURCE_EXHAUSTED: Quota exceeded for this model");
});

// A transport failure mid-request.
await expect("connection dropped", "stream_closed", async () => {
  throw new Error("socket hang up ECONNRESET");
});

// Anything else from the provider.
await expect("provider rejected the request", "provider_error", async () => {
  throw new Error("400 INVALID_ARGUMENT: malformed request");
});

// Interrupted while a slow request is in flight.
await expect(
  "user interrupted mid-run",
  "abort_signal",
  async () => {
    await new Promise((r) => setTimeout(r, 400));
    return reply([{ functionCall: { name: "get_screen_info", args: {} } }], "STOP");
  },
  { interruptAfterMs: 80 }
);

// ---- a second turn in the same session ----------------------------------
//
// ClaudeBrain.consume() is started on the first message and then runs for the
// life of the session, while a logger is created per TURN. Capturing the logger
// once meant every turn after the first wrote nothing: a real session recorded
// 83 turns for the first message and zero for the next five, each closing as
// `unknown_fallthrough`. This drives the real consume() across two turns with
// two different loggers and checks that both are recorded.
console.log("\nsecond turn in a long-lived session");
{
  const { ClaudeBrain } = await import("./brain/claude.js");
  const { Recorder } = await import("./agent-replay/recorder.js");
  const { LoopLog, setCurrentLoop } = await import("./agent-replay/loop-log.js");

  const assistant = (text: string) => ({
    type: "assistant",
    message: { content: [{ type: "text", text }], stop_reason: "end_turn", usage: {} },
  });
  const result = () => ({
    type: "result", subtype: "success", is_error: false,
    terminal_reason: "completed", num_turns: 1, usage: {}, permission_denials: [],
  });

  // A stream the test can feed one turn at a time, exactly as the SDK does.
  // Held in an object so TypeScript does not narrow it to `never`: the only
  // assignment happens inside a callback it cannot see running first.
  const gate_ = { release: null as null | (() => void) };
  const gate = () =>
    new Promise<void>((r) => {
      gate_.release = r;
    });
  async function* stream() {
    yield assistant("turn one"); yield result();
    await gate();
    yield assistant("turn two"); yield result();
  }

  const brain = new ClaudeBrain(cfg);
  (brain as any).started = true;
  (brain as any).q = stream();

  const mkLog = (label: string) => {
    const rec = new Recorder(root, `session-${label}`);
    const log = new LoopLog(rec, "claude", "claude-sonnet-5");
    log.runStart({ maxTurns: 150 });
    setCurrentLoop(log);
    return rec;
  };

  const recA = mkLog("turn-a");
  const consumed = (brain as any).consume();
  await new Promise((r) => setTimeout(r, 50));

  // Turn one is over; a new turn means a new logger, as RecordingBrain does.
  const recB = mkLog("turn-b");
  gate_.release?.();
  await consumed;

  const read = (rec: any) =>
    readFileSync(join(rec.dir, "events.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const [label, rec] of [["first turn", recA], ["second turn", recB]] as const) {
    const ev = read(rec);
    const turns = ev.filter((e) => e.type === "turn.end").length;
    const exit = ev.find((e) => e.type === "loop.exit");
    const ok = turns > 0 && exit && exit.reason !== "unknown_fallthrough";
    console.log(
      `  ${ok ? "✓" : "✗"} ${label}: ${turns} turn.end, exit=${exit?.reason ?? "NONE"}`
    );
    ok ? pass++ : fail++;
  }
}

/** A plain assertion for the blocks below, which drive the loop directly. */
function check(label: string, condition: unknown): void {
  if (condition) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
}

// ---- the watchdog must outlive the deadlines it backs up -------------------
//
// `STALL_AFTER_MS` and the `ECHO_LLM_TIMEOUT_MS` deadline were both 120000, so
// a hung provider made the two terminal paths eligible in the same tick and
// which one described the run was a scheduling accident. The watchdog is a
// backstop; a backstop that fires at the same moment is a second racer.
console.log("\nthe stall watchdog sits behind the request deadline");
{
  const { stallAfterMs, STALL_HEADROOM_MS, DEFAULT_REQUEST_DEADLINE_MS } =
    await import("./agent-replay/loop-log.js");

  const configs: { label: string; env: NodeJS.ProcessEnv; deadline: number }[] = [
    { label: "default configuration", env: {}, deadline: DEFAULT_REQUEST_DEADLINE_MS },
    { label: "a shortened request deadline", env: { ECHO_LLM_TIMEOUT_MS: "5000" }, deadline: 5_000 },
    { label: "a lengthened request deadline", env: { ECHO_LLM_TIMEOUT_MS: "300000" }, deadline: 300_000 },
    { label: "a slow tool deadline", env: { ECHO_TOOL_TIMEOUT_MS: "600000" }, deadline: 600_000 },
    // The clamp exists for this one: an operator who sets the watchdog below the
    // deadline is asking for the race back.
    { label: "an operator undercutting the watchdog", env: { ECHO_LLM_TIMEOUT_MS: "300000", ECHO_STALL_AFTER_MS: "1000" }, deadline: 300_000 },
  ];
  for (const { label, env, deadline } of configs) {
    const stall = stallAfterMs(env);
    check(`${label}: watchdog ${stall}ms > deadline ${deadline}ms`, stall > deadline);
    check(`${label}: with at least ${STALL_HEADROOM_MS}ms of headroom`, stall - deadline >= STALL_HEADROOM_MS);
  }
  // A deadline of 0 disables the cut-off, leaving the watchdog as the only
  // thing that can end the wait. It must still fire.
  check("a disabled deadline still leaves a finite watchdog",
    stallAfterMs({ ECHO_LLM_TIMEOUT_MS: "0", ECHO_TOOL_TIMEOUT_MS: "0" }) > 0);
}

// ---- one hung request produces exactly one terminal path -------------------
console.log("\na provider that never answers ends the run once");
{
  const { Brain } = await import("./brain/types.js");
  const { currentLoop, classifyProviderError } = await import("./agent-replay/loop-log.js");
  const { recordLLM } = await import("./agent-replay/runtime.js");

  const hungRoot = mkdtempSync(join(tmpdir(), "echo-exittest-hung-"));
  const previousLogDir = process.env.ECHO_LOG_DIR;
  const previousTimeout = process.env.ECHO_LLM_TIMEOUT_MS;
  process.env.ECHO_LOG_DIR = hungRoot;
  process.env.ECHO_LLM_TIMEOUT_MS = "40";

  class HangsForeverBrain extends Brain {
    send(_text: string): void {
      void (async () => {
        const log = currentLoop();
        log?.iterationStart(0, 1, 10);
        log?.enterState("awaiting_llm", "test:never-answers");
        try {
          await recordLLM({ hung: true }, () => new Promise<never>(() => {}));
          log?.exit("completed", { detail: "a hung request cannot complete" });
        } catch (error) {
          log?.exit(classifyProviderError(error), { error, detail: "request deadline fired" });
        }
        this.emitEvent("turnEnd");
      })();
    }
    interrupt(): void {}
    async stop(): Promise<void> {}
  }

  const brain = new RecordingBrain(new HangsForeverBrain(), "test", { model: "fake" }, {
    identity: { id: "hung", name: "Echo Hung", kind: "clone" },
    autoResume: false,
  });
  brain.on("error", () => {});
  brain.on("text", () => {});
  const ended = new Promise<void>((resolve) => { brain.on("turnEnd", () => resolve()); setTimeout(resolve, 5000); });
  brain.send("ask a provider that never answers");
  await ended;
  await new Promise((r) => setTimeout(r, 100));

  const runDir = join(hungRoot, readdirSync(hungRoot)[0] ?? "");
  const tape = existsSync(join(runDir, "events.jsonl"))
    ? readFileSync(join(runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const exits = tape.filter((e) => e.type === "loop.exit");
  const ends = tape.filter((e) => e.type === "run.end");
  check("the hung request is recorded as a failed llm call",
    tape.some((e) => e.type === "llm.error" && /timed out/.test(String(e.message))));
  check(`exactly one loop.exit was written (got ${exits.length})`, exits.length === 1);
  check(`exactly one run.end followed it (got ${ends.length})`, ends.length === 1);
  check("the deadline ended the run, not the watchdog",
    !tape.some((e) => e.type === "loop.stall_suspected") &&
    !/watchdog/.test(String(exits[0]?.detail ?? "")));

  if (previousLogDir === undefined) delete process.env.ECHO_LOG_DIR; else process.env.ECHO_LOG_DIR = previousLogDir;
  if (previousTimeout === undefined) delete process.env.ECHO_LLM_TIMEOUT_MS; else process.env.ECHO_LLM_TIMEOUT_MS = previousTimeout;
}

// ---- two failures in one run are both reported ----------------------------
//
// `pendingError` was one slot written under two opposite rules: forward()
// overwrote it with the newest error, the exhausted-recovery path kept the
// first. Which one the user saw depended on execution order.
console.log("\ntwo errors in one run both reach the user");
{
  const { Brain } = await import("./brain/types.js");
  const { currentLoop } = await import("./agent-replay/loop-log.js");

  class TwoFailuresBrain extends Brain {
    send(_text: string): void {
      queueMicrotask(() => {
        const log = currentLoop();
        log?.iterationStart(0, 1, 10);
        this.emitEvent("error", "first failure: the screenshot tool timed out");
        this.emitEvent("error", "second failure: the provider refused the request");
        // The same failure reported twice is one fact, not a third error.
        this.emitEvent("error", "second failure: the provider refused the request");
        log?.exit("provider_error", { detail: "two distinct failures in one run" });
        this.emitEvent("turnEnd");
      });
    }
    interrupt(): void {}
    async stop(): Promise<void> {}
  }

  const errorRoot = mkdtempSync(join(tmpdir(), "echo-exittest-errors-"));
  const previousLogDir = process.env.ECHO_LOG_DIR;
  process.env.ECHO_LOG_DIR = errorRoot;

  const brain = new RecordingBrain(new TwoFailuresBrain(), "test", { model: "fake" }, {
    identity: { id: "two-errors", name: "Echo Two Errors", kind: "clone" },
    autoResume: false,
  });
  const surfaced: string[] = [];
  brain.on("error", (message: unknown) => surfaced.push(String(message)));
  brain.on("text", () => {});
  const ended = new Promise<void>((resolve) => { brain.on("turnEnd", () => resolve()); setTimeout(resolve, 5000); });
  brain.send("fail in two different ways");
  await ended;

  const reported = surfaced.join("\n");
  check("the first failure survives to the terminal output", reported.includes("first failure"));
  check("the most recent failure survives too", reported.includes("second failure"));
  check("the terminal output says how many there were", /\b2 errors\b/.test(reported));

  // The tape kept them separately all along; it was only the user-facing
  // terminal that collapsed to one.
  const tape = readFileSync(join(errorRoot, readdirSync(errorRoot)[0] ?? "", "events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check("both failures are in the tape as separate events",
    tape.filter((e) => e.type === "agent.error").length >= 2);

  if (previousLogDir === undefined) delete process.env.ECHO_LOG_DIR; else process.env.ECHO_LOG_DIR = previousLogDir;
}

console.log(`\n${pass}/${pass + fail} exit reasons recorded correctly`);
if (fail) console.log("A failure here means a path out of the loop does not name itself.");
process.exit(fail ? 1 : 0);
