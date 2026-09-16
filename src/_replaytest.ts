import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain } from "./brain/types.js";
import { RecordingBrain } from "./agent-replay/runtime.js";
import { currentLoop } from "./agent-replay/loop-log.js";
import { recordLLM } from "./agent-replay/runtime.js";
import { BlobStore, CounterfactualDivergence, ReplaySource, loadEvents } from "./agent-replay/replay-source.js";
import { inspectRun } from "./agent-replay/inspector.js";
import { compareEventStreams } from "./agent-replay/verify.js";
import { runGated } from "./safety/gate.js";
import type { ToolDef } from "./tools/registry.js";

class FakeBrain extends Brain {
  send(_text: string): void {
    // A real brain opens an iteration before it calls the model; without this
    // the recording has no iteration at all and the inspector has nothing to
    // count.
    currentLoop()?.iterationStart(0, 1, 10);
    this.emitEvent("status", "thinking");
  }
  interrupt(): void {}
  async stop(): Promise<void> {}
  finish(): void {
    // Real brains name their exit from inside the loop; a stand-in that only
    // emits `turnEnd` would be testing the exact inference that caused every
    // silent stop to be recorded as a success.
    currentLoop()?.exit("completed", { iteration: 1, detail: "fake brain finished" });
    this.emitEvent("turnEnd");
  }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "echo-replay-test-"));
  process.env.ECHO_REPLAY_DIR = root;
  const inner = new FakeBrain();
  const brain = new RecordingBrain(inner, "test");
  brain.send("inspect replay recording");
  const request = { model: "test", messages: ["inspect replay recording"] };
  // Ollama's shape: counts at the top level of the response.
  const recordedResponse = { message: { content: "recorded response" }, prompt_eval_count: 41, eval_count: 7 };
  const firstResponse = await recordLLM(request, async () => recordedResponse);
  if (firstResponse !== recordedResponse) throw new Error("live response did not pass through");

  // A retryable provider failure and the retry that followed it, recorded as a
  // pair. `willRetry` used to be the literal `false` on every recorded error
  // while the replay path believed the field, so the tape asserted a retry
  // decision that was never true — and recovery, the likeliest home for a
  // silent stop, was the one path replay could not reproduce.
  const failingRequest = { model: "test", messages: ["inspect replay recording"], attempt: 0 };
  const retriedRequest = { model: "test-fallback", messages: ["inspect replay recording"], attempt: 1 };
  // Gemini's shape: counts nested under usageMetadata.
  const retryResponse = {
    message: { content: "recovered after a retry" },
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 18, totalTokenCount: 138 },
  };
  let failureSurfaced = false;
  try {
    await recordLLM(failingRequest, async () => { throw new Error("503 high demand"); }, 0, {
      willRetry: () => true,
    });
  } catch {
    failureSurfaced = true;
  }
  if (!failureSurfaced) throw new Error("the retryable failure did not reach its caller");
  const afterRetry = await recordLLM(retriedRequest, async () => retryResponse, 1);
  if (afterRetry !== retryResponse) throw new Error("the retry did not pass through");
  const replayableTool: ToolDef = {
    name: "screenshot",
    description: "test only",
    schema: {},
    readOnly: true,
    handler: async () => ({ text: "recorded output" }),
  };
  const toolArgs = { apiKey: "never-on-disk" };
  const firstTool = await runGated(replayableTool, toolArgs, {
    workingDir: root,
    emit: (event, payload) => inner.emitEvent(event as any, payload),
  });
  if (firstTool.text !== "recorded output") throw new Error("live tool did not pass through");
  const continuationRequest = { model: "test", messages: ["tool result: ok"] };
  await recordLLM(continuationRequest, async () => ({ message: { content: "completed" } }));
  inner.finish();

  const runs = readdirSync(root);
  if (runs.length !== 1) throw new Error(`expected one recording, got ${runs.length}`);
  const runDir = join(root, runs[0]);
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const types = events.map((event) => event.type);
  for (const expected of ["run.start", "agent.input", "llm.request", "llm.response", "tool.call", "tool.result", "loop.exit", "run.end"]) {
    if (!types.includes(expected)) throw new Error(`missing ${expected}`);
  }
  if (JSON.stringify(events).includes("never-on-disk")) throw new Error("secret was not redacted");
  if (events.at(-2)?.reason !== "completed") throw new Error("turn did not record its exit reason");
  const recordedError = events.find((event) => event.type === "llm.error");
  if (!recordedError) throw new Error("the retryable failure was not recorded");
  if (recordedError.willRetry !== true) {
    throw new Error("the tape says the run would not retry, and then it retried");
  }
  const afterFailure = events
    .slice(events.indexOf(recordedError))
    .find((event) => event.type === "llm.request");
  if (afterFailure?.attempt !== 1) throw new Error("the retry attempt was not recorded after the failure");

  // A clean run must contain no unlabelled unpaired llm.request. That shape is
  // the signature of an abandoned call, so as long as it also appears in runs
  // that went fine, the tape has a permanent false positive for the exact
  // pattern the sink exists to find.
  const unpaired = events
    .filter((event) => event.type === "llm.request" && !event.speculative)
    .filter((event) => !events.some((other) =>
      (other.type === "llm.response" || other.type === "llm.error") && other.reqId === event.reqId));
  if (unpaired.length) {
    throw new Error(`a clean run left ${unpaired.length} unlabelled llm.request(s) with no terminal event`);
  }
  if (events.find((event) => event.type === "loop.exit")?.abandoned !== 0) {
    throw new Error("a clean run reported abandoned work");
  }

  // Every tape in ~/.echo/replays carried codeVersion "unknown" and usage {},
  // so none of them could be tied to a build or to a cost, and the one number
  // that shows a run heading for a context overflow was never written down.
  const started = events.find((event) => event.type === "run.start");
  if (!started?.gitSha || started.gitSha === "unknown") {
    throw new Error("the run does not say which build produced it");
  }
  const responses = events.filter((event) => event.type === "llm.response");
  if (responses.length !== 3) throw new Error(`expected three recorded responses, got ${responses.length}`);
  const [ollamaShaped, geminiShaped, silent] = responses.map((event) => event.usage as Record<string, number>);
  // A provider that reports nothing must still record nothing, not a guess.
  if (Object.keys(silent ?? {}).length !== 0) throw new Error("token counts were invented for a response that had none");
  if (ollamaShaped?.inputTokens !== 41 || ollamaShaped?.outputTokens !== 7 || ollamaShaped?.totalTokens !== 48) {
    throw new Error(`top-level provider token counts were not recorded: ${JSON.stringify(ollamaShaped)}`);
  }
  if (geminiShaped?.inputTokens !== 120 || geminiShaped?.outputTokens !== 18 || geminiShaped?.totalTokens !== 138) {
    throw new Error(`nested provider token counts were not recorded: ${JSON.stringify(geminiShaped)}`);
  }
  // Tool execution is the largest surface in Echo and had zero replay coverage.
  const toolCalls = events.filter((event) => event.type === "tool.call");
  const toolResults = events.filter((event) => event.type === "tool.result");
  if (toolCalls.length !== 1 || toolResults.length !== 1) {
    throw new Error(`a run that called one tool recorded ${toolCalls.length} calls and ${toolResults.length} results`);
  }
  if (toolResults[0].callId !== toolCalls[0].callId) throw new Error("the tool result does not name the call it answers");
  const source = new ReplaySource(loadEvents(runDir), new BlobStore(runDir));
  const replayedResponse = source.nextLLMExchange(request).response;
  if ((replayedResponse as any).message?.content !== "recorded response") throw new Error("replay did not serve the recorded model response");
  const replayedFailure = source.nextLLMExchange(failingRequest);
  if (replayedFailure.errorEvent?.willRetry !== true) throw new Error("replay lost the recorded retry decision");
  const replayedRetry = source.nextLLMExchange(retriedRequest);
  if ((replayedRetry.response as any)?.message?.content !== "recovered after a retry") {
    throw new Error("replay did not serve the recorded retry response");
  }
  const replayed = source.nextTool("screenshot", { apiKey: "a-different-secret" });
  if ((replayed as any).text !== "recorded output") throw new Error("replay did not serve the recorded tool result");
  source.nextLLMExchange(continuationRequest);
  const summary = inspectRun(events);
  if (summary.exitReason !== "completed" || summary.iterations !== 1) throw new Error("inspector summary is wrong");
  const timeShifted = events.map((event) => ({ ...event, ts: 0, mono: 0, runId: "another-run" }));
  if (!compareEventStreams(events, timeShifted).ok) throw new Error("verification included volatile timing fields");
  const replayRoot = mkdtempSync(join(tmpdir(), "echo-faithful-replay-"));
  process.env.ECHO_REPLAY_RUN = runDir;
  process.env.ECHO_REPLAY_OUTPUT_DIR = replayRoot;
  let liveModelCalled = false;
  const replayInner = new FakeBrain();
  const replayBrain = new RecordingBrain(replayInner, "test");
  replayBrain.send("inspect replay recording");
  const replayedModel = await recordLLM(request, async () => {
    liveModelCalled = true;
    return { message: { content: "live response" } };
  });
  if (liveModelCalled || (replayedModel as any).message?.content !== "recorded response") {
    throw new Error("faithful replay reached the live model");
  }
  // Replaying the tape has to reproduce the retry, not just the requests around it.
  let replayedFailureSurfaced = false;
  try {
    await recordLLM(failingRequest, async () => { liveModelCalled = true; return { message: { content: "live failure" } }; }, 0, {
      willRetry: () => true,
    });
  } catch {
    replayedFailureSurfaced = true;
  }
  if (!replayedFailureSurfaced || liveModelCalled) throw new Error("faithful replay did not reproduce the recorded failure");
  const replayedAfterRetry = await recordLLM(retriedRequest, async () => {
    liveModelCalled = true;
    return { message: { content: "live retry" } };
  }, 1);
  if (liveModelCalled || (replayedAfterRetry as any).message?.content !== "recovered after a retry") {
    throw new Error("faithful replay did not reproduce the retry");
  }
  let liveToolCalled = false;
  const replayToolDef: ToolDef = {
    ...replayableTool,
    handler: async () => {
      liveToolCalled = true;
      return { text: "live output" };
    },
  };
  const replayedTool = await runGated(replayToolDef, { apiKey: "another-secret" }, {
    workingDir: root,
    emit: (event, payload) => replayInner.emitEvent(event as any, payload),
  });
  if (liveToolCalled || replayedTool.text !== "recorded output") throw new Error("faithful replay reached the live tool");
  await recordLLM(continuationRequest, async () => {
    liveModelCalled = true;
    return { message: { content: "live continuation" } };
  });
  if (liveModelCalled) throw new Error("faithful replay reached a later live model call");
  replayInner.finish();
  const replayRun = join(replayRoot, readdirSync(replayRoot)[0]);
  const faithful = compareEventStreams(loadEvents(runDir), loadEvents(replayRun));
  if (!faithful.ok) throw new Error(`faithful replay diverged: ${JSON.stringify(faithful.mismatches[0])}`);
  delete process.env.ECHO_REPLAY_RUN;
  delete process.env.ECHO_REPLAY_OUTPUT_DIR;
  const call = events.find((event) => event.type === "tool.call");
  if (!call?.callId) throw new Error("counterfactual target is missing");
  const counterfactual = new ReplaySource(loadEvents(runDir), new BlobStore(runDir), {
    target: { type: "tool", callId: String(call.callId) },
    replaceWith: { text: "forced timeout" },
  });
  counterfactual.nextLLMExchange(request);
  counterfactual.nextLLMExchange(failingRequest);
  counterfactual.nextLLMExchange(retriedRequest);
  if ((counterfactual.nextTool("screenshot", { apiKey: "different" }) as any).text !== "forced timeout") {
    throw new Error("counterfactual tool result was not applied");
  }
  let stoppedAtDivergence = false;
  try {
    counterfactual.nextLLMExchange(continuationRequest);
  } catch (error) {
    stoppedAtDivergence = error instanceof CounterfactualDivergence;
  }
  if (!stoppedAtDivergence) throw new Error("counterfactual replay served a stale later response");

  // A run that ends with a request still in flight has to say so. `exit()`
  // closes the recorder, so the terminal event for that request is dropped by
  // the try/catch that keeps recording from ever changing a result — and the
  // gap it leaves reads exactly like a recorder that stopped writing.
  delete process.env.ECHO_REPLAY_DIR;
  const abandonedRoot = mkdtempSync(join(tmpdir(), "echo-abandoned-"));
  process.env.ECHO_LOG_DIR = abandonedRoot;
  // So the speculative call below settles inside the test rather than holding
  // the process open for the full default deadline.
  process.env.ECHO_LLM_TIMEOUT_MS = "50";
  const abandonedInner = new FakeBrain();
  const abandonedBrain = new RecordingBrain(abandonedInner, "test", {}, { autoResume: false });
  abandonedBrain.on("error", () => {});
  abandonedBrain.on("text", () => {});
  abandonedBrain.on("turnEnd", () => {});
  abandonedBrain.send("start a call the run never waits for");
  let neverAnswered: (value: unknown) => void = () => {};
  const inFlight = recordLLM({ model: "test", messages: ["never answered"] }, () =>
    new Promise((resolve) => { neverAnswered = resolve; }));
  // Labelled work is allowed to be abandoned and must not be reported.
  const speculative = recordLLM({ model: "test", messages: ["a guess"] }, () => new Promise(() => {}), 0, {
    speculative: true,
  }).catch(() => { /* a guess nobody waits for is allowed to fail */ });
  await new Promise((resolve) => setTimeout(resolve, 10));
  currentLoop()?.exit("stream_closed", { iteration: 1, detail: "ended with a request in flight" });
  neverAnswered({ message: { content: "too late" } });
  await inFlight;
  await speculative;

  const abandonedRun = join(abandonedRoot, readdirSync(abandonedRoot)[0]);
  const abandonedEvents = loadEvents(abandonedRun);
  const reported = abandonedEvents.filter((event) => event.type === "work.abandoned");
  if (reported.length !== 1) {
    throw new Error(`expected exactly one abandoned call to be named, got ${reported.length}`);
  }
  if (reported[0].kind !== "llm.request") throw new Error("the abandoned call was not named as an llm.request");
  const abandonedRequest = abandonedEvents.find((event) => event.type === "llm.request" && !event.speculative);
  if (reported[0].id !== abandonedRequest?.reqId) throw new Error("the abandoned call does not name the request it left open");
  const abandonedExit = abandonedEvents.find((event) => event.type === "loop.exit");
  if (abandonedExit?.abandoned !== 1) throw new Error("the exit event did not count the abandoned call");
  if (abandonedEvents.findIndex((event) => event.type === "work.abandoned") > abandonedEvents.indexOf(abandonedExit!)) {
    throw new Error("the abandoned call was recorded after the exit it explains");
  }
  delete process.env.ECHO_LOG_DIR;
  delete process.env.ECHO_LLM_TIMEOUT_MS;

  // Full journaling is now the default so interrupted tasks can reconstruct
  // their checkpoint. Privacy-sensitive installations can explicitly keep a
  // metadata-only trace with ECHO_FULL_LOG=0.
  delete process.env.ECHO_REPLAY_DIR;
  process.env.ECHO_FULL_LOG = "0";
  const metadataRoot = mkdtempSync(join(tmpdir(), "echo-loop-log-test-"));
  process.env.ECHO_LOG_DIR = metadataRoot;
  const metadataInner = new FakeBrain();
  const metadataBrain = new RecordingBrain(metadataInner, "test");
  metadataBrain.send("this prompt must not be recorded");
  await recordLLM(request, async () => ({ message: { content: "live only" } }));
  await runGated(replayableTool, toolArgs, {
    workingDir: metadataRoot,
    emit: (event, payload) => metadataInner.emitEvent(event as any, payload),
  });
  metadataInner.finish();
  const metadataRun = join(metadataRoot, readdirSync(metadataRoot)[0]);
  const metadataText = readFileSync(join(metadataRun, "events.jsonl"), "utf8");
  for (const forbidden of ["agent.input", "llm.request", "llm.response", "tool.call", "tool.result", "this prompt must not be recorded"]) {
    if (metadataText.includes(forbidden)) throw new Error(`metadata log leaked ${forbidden}`);
  }
  const metadataCheckpoint = readFileSync(join(metadataRun, "checkpoint.json"), "utf8");
  if (metadataCheckpoint.includes("this prompt must not be recorded")) throw new Error("metadata checkpoint leaked the prompt");
  if (!metadataText.includes("loop.exit")) throw new Error("metadata log lost its diagnostic exit event");
  delete process.env.ECHO_LOG_DIR;
  delete process.env.ECHO_FULL_LOG;
  console.log(`✓ replay recorder wrote ${events.length} redacted events, blocked live calls, and stops safely after counterfactual divergence`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
