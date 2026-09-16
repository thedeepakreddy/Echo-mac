import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { Brain, type AudioTurn , type SendOptions } from "../brain/types.js";
import { Recorder, contentHash, INCOMPLETE_EXITS, type ExitReason, type ReplayEvent } from "./recorder.js";
import { DEFAULT_REQUEST_DEADLINE_MS, LoopLog, clearCurrentLoop, consoleMirror, currentLoop, setCurrentLoop, serializeError } from "./loop-log.js";
import { getAppPath } from "../utils/appPath.js";
import { rememberRequest, rememberOutcome } from "../cognition/outcomes.js";
import { BlobStore, type Override, ReplaySource, ReplayedError, loadEvents } from "./replay-source.js";
import { agentNow, liveDeps, replayDeps, resetAgentDeps, setAgentDeps } from "./deps.js";
import {
  currentAgentRunContext,
  runInAgentContext,
  type AgentIdentity,
  type AgentRunContext,
} from "./context.js";
import {
  createRecoveryCheckpoint,
  pendingRecoveryCheckpoints,
  recoveryPrompt,
  writeRecoveryCheckpoint,
  type RecoveryCheckpoint,
} from "./recovery.js";

import { taskCoordinator, type TaskState } from "../memory/task-state.js";
import { currentInvocation } from "../memory/invocation.js";
import { consolidateTask } from "../memory/consolidate.js";
import { setPrivateTask } from "../memory/capture-policy.js";
import { dataRoot } from "../memory/paths.js";

/** Diagnostics can be off while the authoritative task coordinator remains active. */
function ephemeralRecorder(runId: string): Recorder {
  let seq = 0;
  const rec: any = { runId, dir: "", mirror: null, blob: contentHash, close() {}, finish() {},
    emit(event: any) { const full = { ...event, seq: seq++, ts: Date.now(), mono: 0, runId }; rec.mirror?.(full); return full; } };
  return rec as Recorder;
}

const activeRecorders = new Set<Recorder>();
let fallbackActive: Recorder | null = null;
let processHandlersInstalled = false;
let replaySession: { source: ReplaySource; runDir: string } | null = null;

function replayRoot(): string | null {
  // An explicit replay root still overrides the ordinary named run directory.
  const configured = process.env.ECHO_REPLAY_DIR?.trim();
  return configured ? configured : null;
}

/** Full journaling is on by default because recovery needs the original task. */
function payloadRecordingEnabled(): boolean {
  if (replayRoot() || configuredReplayRun()) return true;
  return process.env.ECHO_FULL_LOG?.trim() !== "0";
}

/**
 * Where the diagnostic loop log goes, and whether it runs at all.
 *
 * ON by default. `ECHO_LOG=0` disables both the journal and automatic restart
 * recovery; `ECHO_FULL_LOG=0` retains only diagnostic metadata.
 */
export function loopLogRoot(): string | null {
  if (process.env.ECHO_LOG?.trim() === "0") return null;
  const configured = process.env.ECHO_LOG_DIR?.trim();
  if (configured) return configured;
  const replay = replayRoot();
  if (replay) return replay;
  try {
    return join(dataRoot(), "runs");
  } catch {
    return null;
  }
}

/** Rough token count. Cheap and provider-agnostic: ~4 characters per token. */
export function approxTokens(value: unknown): number {
  try {
    return Math.round(JSON.stringify(value ?? "").length / 4);
  } catch {
    return 0;
  }
}

function configuredReplayRun(): string | null {
  return process.env.ECHO_REPLAY_RUN?.trim() || null;
}

function configuredOverride(): Override | undefined {
  const raw = process.env.ECHO_REPLAY_OVERRIDE_JSON?.trim();
  if (!raw) return undefined;
  try {
    const candidate = JSON.parse(raw) as Override;
    if ((candidate.target?.type === "tool" && typeof candidate.target.callId === "string") ||
      (candidate.target?.type === "llm" && typeof candidate.target.reqId === "string")) return candidate;
  } catch {
    /* reported as an unavailable replay below rather than crashing Echo */
  }
  return undefined;
}

function getReplaySession(): { source: ReplaySource; runDir: string } | null {
  if (replaySession) return replaySession;
  const runDir = configuredReplayRun();
  if (!runDir) return null;
  try {
    replaySession = {
      runDir,
      source: new ReplaySource(loadEvents(runDir), new BlobStore(runDir), configuredOverride()),
    };
    return replaySession;
  } catch (error) {
    console.error("[replay] could not load recording:", error);
    return null;
  }
}

export function isReplaying(): boolean {
  return Boolean(getReplaySession());
}

/** The provider named by a configured recording, without consuming its tape. */
export function configuredReplayProvider(): string | null {
  const runDir = configuredReplayRun();
  if (!runDir) return null;
  try {
    const start = loadEvents(runDir).find((event) => event.type === "run.start");
    const provider = start?.provider ?? (start?.config as any)?.provider;
    return typeof provider === "string" ? provider : null;
  } catch {
    return null;
  }
}

export function configuredReplayDirectory(): string | null {
  return configuredReplayRun();
}

function replayOutputRoot(runDir: string): string {
  return process.env.ECHO_REPLAY_OUTPUT_DIR?.trim() || join(dirname(runDir), `${basename(runDir)}.replay`);
}

function safeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Recorder controls alter where/how traces are written, never what the
    // agent decides. Keeping them out lets a faithful replay verify its own
    // event stream without treating its control plane as code drift.
    if (/^(NODE_ENV|JARVIS_|ECHO_(?!REPLAY_))/.test(key) && typeof value === "string") env[key] = value;
  }
  return env;
}

/**
 * Catch what escapes the loop entirely.
 *
 * Exported so the Electron entry can install these BEFORE anything else boots —
 * a rejection thrown during startup used to happen before any recorder existed
 * and left nothing behind at all. Neither handler swallows: `uncaughtException`
 * is observed through `uncaughtExceptionMonitor`, which runs alongside Node's
 * own handling rather than replacing it, so the process still dies exactly as
 * it did before. It just says why on the way out.
 */
export function installProcessHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  const report = (type: string, error: Error, extra: Record<string, unknown> = {}) => {
    const payload = { type, error: serializeError(error), ...extra };
    for (const recorder of activeRecorders) {
      try {
        recorder.emit(payload, true);
      } catch {
        /* the console line below is the fallback when the disk is gone */
      }
    }
    console.error(`[echo:${type}]`, error?.stack ?? error?.message ?? error);
  };
  process.on("unhandledRejection", (reason: unknown) => {
    report("process.unhandledRejection", reason instanceof Error ? reason : new Error(String(reason)));
  });
  process.on("uncaughtExceptionMonitor", (error) => {
    report("process.uncaughtException", error);
  });
}

/** Forwarded from a renderer window, so a UI-side failure lands in the same file. */
export function recordRendererError(payload: { kind: string; message: string; stack?: string; source?: string }): void {
  for (const recorder of activeRecorders) {
    try {
      recorder.emit(
        {
          type: "renderer.error",
          kind: payload.kind,
          message: String(payload.message ?? "").slice(0, 2000),
          stack: payload.stack ? String(payload.stack).slice(0, 8000) : undefined,
          source: payload.source,
        },
        true
      );
    } catch {
      /* never let a renderer fault take out the main process */
    }
  }
  console.error(`[echo:renderer.${payload.kind}]`, payload.message, payload.stack ?? "");
}

export function currentRecorder(): Recorder | null {
  return currentAgentRunContext()?.recorder ?? fallbackActive;
}

function emitReplayedTool<T>(name: string, args: unknown): T {
  const session = getReplaySession();
  if (!session) throw new Error("replay session is not active");
  const exchange = session.source.nextToolExchange(name, args);
  const rec = currentRecorder();
  if (rec) {
    const argsRef = rec.blob(args);
    rec.emit({ type: "tool.call", callId: exchange.call.callId, name, argsRef, argsHash: argsRef });
    if (exchange.terminal.type === "tool.error") {
      rec.emit({ type: "tool.error", callId: exchange.call.callId, durationMs: Number(exchange.terminal.durationMs ?? 0), message: String(exchange.terminal.message), stack: exchange.terminal.stack });
      throw new ReplayedError(String(exchange.terminal.message), typeof exchange.terminal.stack === "string" ? exchange.terminal.stack : undefined);
    }
    rec.emit({
      type: "tool.result",
      callId: exchange.call.callId,
      durationMs: Number(exchange.terminal.durationMs ?? 0),
      resultRef: rec.blob(exchange.value),
    });
  }
  return exchange.value as T;
}

/** Returns a recorded tool value before the gate, handler, or side effect can run. */
export async function takeReplayedTool<T>(
  name: string,
  args: unknown,
  clockAlreadyConsumed = false
): Promise<{ handled: boolean; value?: T }> {
  if (!isReplaying()) return { handled: false };
  // `decide()` captures the clock before emitting a live tool call. Consume the
  // same input here without invoking any of its snapshots or confirmations.
  if (!clockAlreadyConsumed) agentNow();
  return { handled: true, value: emitReplayedTool<T>(name, args) };
}

function timeoutFromEnv(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : fallback;
}

function withDeadline<T>(action: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const running = Promise.resolve().then(action);
  if (timeoutMs === 0) return running;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    running.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/** Record one tool boundary without allowing recorder faults to affect Echo. */
export function recordTool<T>(name: string, args: unknown, action: () => Promise<T>): Promise<T> {
  if (isReplaying()) return Promise.resolve().then(() => emitReplayedTool<T>(name, args));
  const run = () => withDeadline(action, timeoutFromEnv("ECHO_TOOL_TIMEOUT_MS", DEFAULT_REQUEST_DEADLINE_MS), `tool ${name}`);
  const rec = currentRecorder();
  if (!rec || !payloadRecordingEnabled()) return run();
  let callId: string;
  try {
    callId = currentInvocation()?.callId ?? randomUUID();
    const argsRef = rec.blob(args);
    rec.emit({ type: "tool.call", callId, name, argsRef, argsHash: argsRef });
  } catch {
    // A recorder must be observational. A full disk or an unwritable replay
    // directory can lose a trace, but must never keep Echo from acting.
    return run();
  }
  const started = performance.now();
  return run().then(
    (result) => {
      try {
        rec.emit({ type: "tool.result", callId, durationMs: performance.now() - started, resultRef: rec.blob(result) });
      } catch {
        /* recording must not alter a successful tool result */
      }
      return result;
    },
    (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      try {
        rec.emit({ type: "tool.error", callId, durationMs: performance.now() - started, message: err.message, stack: err.stack });
      } catch {
        /* preserve the original tool failure */
      }
      throw error;
    }
  );
}

/** Record a gate refusal as a tool result, even though no handler may run. */
export function recordToolDenied(name: string, args: unknown, message: string): void {
  const rec = currentRecorder();
  if (!rec || !payloadRecordingEnabled()) return;
  try {
    const callId = currentInvocation()?.callId ?? randomUUID();
    const argsRef = rec.blob(args);
    rec.emit({ type: "tool.call", callId, name, argsRef, argsHash: argsRef });
    rec.emit({ type: "tool.result", callId, durationMs: 0, resultRef: rec.blob({ text: message, denied: true }) });
  } catch (err) {
    console.error("[replay] could not record a denied tool:", (err as any)?.message ?? err);
  }
}

export interface RecordLLMOptions {
  /**
   * Whether this caller is about to try again, asked at the moment the failure
   * surfaces and before the caller's own catch runs.
   *
   * `willRetry` used to be the literal `false` on every recorded error, and the
   * replay path at the top of this function believes what the tape says. A tape
   * from 10 September holds `llm.error ... willRetry: false` immediately followed
   * by `llm.request attempt: 1` — the recorder said it would not retry, then
   * retried. Recovery is the most intricate path in the runtime and the likeliest
   * home for a silent stop, and it was the one path replay could not reproduce.
   *
   * A predicate rather than a value, because only the caller knows its policy,
   * and it has to be the same expression its catch block uses — see
   * `geminiFallbackReason`.
   */
  willRetry?: (error: unknown) => boolean;
}

/**
 * Capture a complete non-streaming provider exchange. Providers that stream
 * should emit llm.chunk separately; Gemini and Ollama currently return their
 * assembled response, which is still sufficient for inspection and retries.
 */
export function recordLLM<T>(
  request: unknown,
  action: () => Promise<T>,
  attempt = 0,
  opts: RecordLLMOptions = {}
): Promise<T> {
  const session = getReplaySession();
  if (session) {
    return Promise.resolve().then(() => {
      const exchange = session.source.nextLLMExchange(request);
      const rec = currentRecorder();
      if (rec) {
        const bodyRef = rec.blob(request);
        rec.emit({ type: "llm.request", reqId: String(exchange.request.reqId), attempt: Number(exchange.request.attempt ?? attempt), bodyRef, bodyHash: bodyRef });
        if (exchange.errorEvent) {
          rec.emit({
            type: "llm.error",
            reqId: String(exchange.request.reqId),
            status: exchange.errorEvent.status,
            message: String(exchange.errorEvent.message),
            stack: exchange.errorEvent.stack,
            willRetry: Boolean(exchange.errorEvent.willRetry),
          });
          throw new ReplayedError(String(exchange.errorEvent.message), typeof exchange.errorEvent.stack === "string" ? exchange.errorEvent.stack : undefined);
        }
        if (exchange.responseEvent) {
          rec.emit({
            type: "llm.response",
            reqId: String(exchange.request.reqId),
            stopReason: exchange.responseEvent.stopReason ?? "complete",
            usage: exchange.responseEvent.usage ?? {},
            bodyRef: rec.blob(exchange.response),
          });
        }
      }
      if (exchange.errorEvent) {
        throw new ReplayedError(String(exchange.errorEvent.message), typeof exchange.errorEvent.stack === "string" ? exchange.errorEvent.stack : undefined);
      }
      return exchange.response as T;
    });
  }
  const run = () => withDeadline(action, timeoutFromEnv("ECHO_LLM_TIMEOUT_MS", DEFAULT_REQUEST_DEADLINE_MS), "model request");
  const rec = currentRecorder();
  if (!rec || !payloadRecordingEnabled()) return run();
  let reqId: string;
  try {
    reqId = randomUUID();
    const bodyRef = rec.blob(request);
    rec.emit({ type: "llm.request", reqId, attempt, bodyRef, bodyHash: bodyRef });
  } catch {
    return run();
  }
  return run().then(
    (response) => {
      try {
        rec.emit({ type: "llm.response", reqId, stopReason: "complete", usage: {}, bodyRef: rec.blob(response) });
      } catch {
        /* never turn a complete model response into a failed turn */
      }
      return response;
    },
    (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      let willRetry = false;
      try {
        willRetry = opts.willRetry?.(error) === true;
      } catch {
        // A fault in a caller's retry policy must not change what is recorded
        // about the provider's failure, and must not become the failure.
      }
      try {
        rec.emit({ type: "llm.error", reqId, message: err.message, stack: err.stack, willRetry });
      } catch {
        /* preserve the provider's original failure */
      }
      throw error;
    }
  );
}

export interface RecordingBrainOptions {
  identity?: AgentIdentity;
  /** Disable only for diagnostics/tests. User-facing brains recover by default. */
  autoResume?: boolean;
  maxRecoveryAttempts?: number;
  recoveryDelayMs?: number;
}

export const MAIN_ECHO_IDENTITY: AgentIdentity = { id: "echo", name: "Echo", kind: "main" };

function runIdFor(identity: AgentIdentity): string {
  const readable = identity.name.replace(/[^a-zA-Z0-9 _.-]/g, "").trim().slice(0, 60) || "Echo";
  return `${readable}--${randomUUID()}`;
}

function configuredRecoveryDelay(reason: ExitReason): number {
  const configured = Number(process.env.ECHO_RECOVERY_DELAY_MS);
  if (Number.isFinite(configured) && configured >= 0) return Math.floor(configured);
  return reason === "rate_limit_429" ? 5_000 : 750;
}

/**
 * Decorates every provider with an isolated, named run journal and recovery.
 * AsyncLocalStorage keeps simultaneous clones from ever sharing a recorder.
 */
export class RecordingBrain extends Brain {
  readonly identity: AgentIdentity;
  private context: AgentRunContext | null = null;
  private lastContext: AgentRunContext | null = null;
  private checkpoint: RecoveryCheckpoint | null = null;
  private interrupted = false;
  private stopped = false;
  private recoveryTimer: NodeJS.Timeout | null = null;
  /**
   * Every failure this run surfaced, in order.
   *
   * This was one slot written under two opposite rules: `forward()` overwrote
   * it with the newest error, and the exhausted-recovery path kept whichever
   * was already there. With more than one failure in a run, which one the user
   * finally saw depended on the order the two paths happened to run — and a
   * task that failed three different ways reported exactly one of them, chosen
   * by accident.
   */
  private readonly pendingErrors: string[] = [];
  private finalFailureMessage: string | null = null;
  private readonly suppressedTurnEnds = new Set<string>();
  private readonly terminalRuns = new Set<string>();
  private readonly autoResume: boolean;
  private readonly maxRecoveryAttempts?: number;
  private readonly recoveryDelayMs?: number;

  constructor(
    private readonly inner: Brain,
    private readonly provider: string,
    private readonly loopConfig: Record<string, unknown> = {},
    options: RecordingBrainOptions = {}
  ) {
    super();
    this.identity = options.identity ?? MAIN_ECHO_IDENTITY;
    this.autoResume = options.autoResume !== false;
    this.maxRecoveryAttempts = options.maxRecoveryAttempts;
    this.recoveryDelayMs = options.recoveryDelayMs;
    for (const event of ["status", "text", "textDelta", "textDone", "tool", "risk", "error", "turnEnd"] as const) {
      inner.on(event, (...args: any[]) => this.forward(event, args));
    }
  }

  private contextForEvent(): AgentRunContext | null {
    return currentAgentRunContext() ?? this.context;
  }

  private updateCheckpoint(event: ReplayEvent, checkpoint: RecoveryCheckpoint, runDir: string): void {
    let changed = false;
    if (event.type === "tool.start") {
      checkpoint.actions.push({
        callId: typeof event.callId === "string" ? event.callId : undefined,
        name: String(event.name ?? "unknown tool"),
        argsHash: typeof event.argsHash === "string" ? event.argsHash : undefined,
        status: "started",
        at: Number(event.ts ?? Date.now()),
      });
      if (checkpoint.actions.length > 100) checkpoint.actions.splice(0, checkpoint.actions.length - 100);
      changed = true;
    } else if (event.type === "tool.end") {
      const pending = [...checkpoint.actions].reverse().find((action) =>
        action.status === "started" && (action.callId ? action.callId === event.callId : action.name === String(event.name ?? "unknown tool"))
      );
      // A timed-out handler may still finish in the background because not all
      // tools expose cancellation. Keep it uncertain so recovery observes the
      // real state before deciding whether the action needs repeating.
      const uncertainTimeout = event.isError && /timed? out|timeout/i.test(String(event.detail ?? ""));
      if (pending) {
        if (!uncertainTimeout) pending.status = event.isError ? "failed" : "completed";
      } else {
        checkpoint.actions.push({
          name: String(event.name ?? "unknown tool"),
          status: uncertainTimeout ? "started" : event.isError ? "failed" : "completed",
          at: Number(event.ts ?? Date.now()),
        });
      }
      changed = true;
    }
    if (changed) {
      try { writeRecoveryCheckpoint(runDir, checkpoint); }
      catch (error) { console.error("[echo:recovery] checkpoint write failed:", (error as any)?.message ?? error); }
    }
  }

  private persistCheckpoint(runDir: string, checkpoint: RecoveryCheckpoint): void {
    try { writeRecoveryCheckpoint(runDir, checkpoint); }
    catch (error) { console.error("[echo:recovery] checkpoint write failed:", (error as any)?.message ?? error); }
  }

  private forward(event: string, args: any[]): void {
    const context = this.contextForEvent();
    const rec = context?.recorder ?? null;
    try {
      if (rec && !context?.loop.hasExited && event === "text") {
        rec.emit({ type: "agent.text", textRef: rec.blob(args[0]) });
        if (this.checkpoint && context?.payloadRecording) {
          this.checkpoint.lastAssistantText = String(args[0] ?? "").slice(-4000);
          writeRecoveryCheckpoint(rec.dir, this.checkpoint);
        }
      }
      if (rec && !context?.loop.hasExited && event === "status") rec.emit({ type: "agent.status", status: args[0] });
      if (rec && !context?.loop.hasExited && event === "tool") {
        const info = args[0] ?? {};
        const name = String(info.name ?? "unknown tool");
        rec.emit({
          type: "agent.tool",
          name,
          summary: context?.payloadRecording ? String(info.summary ?? name).slice(0, 1000) : undefined,
        });
        if (this.checkpoint) {
          const duplicate = [...this.checkpoint.actions].reverse().find((action) =>
            action.status === "started" && action.name === name && Date.now() - action.at < 2_000
          );
          if (!duplicate) this.checkpoint.actions.push({ name, status: "started", at: Date.now() });
          writeRecoveryCheckpoint(rec.dir, this.checkpoint);
        }
      }
      if (rec && !context?.loop.hasExited && event === "risk") {
        const risk = args[0] ?? {};
        rec.emit({ type: "agent.risk", tool: risk.tool, tier: risk.tier, reason: risk.reason });
      }
      if (rec && !context?.loop.hasExited && event === "error") {
        rec.emit({ type: "agent.error", message: String(args[0] ?? "Unknown brain error").slice(0, 4000) }, true);
      }
    } catch (err) {
      console.error("[replay] recording disabled mid-run:", (err as any)?.message ?? err);
    }

    if (event === "error") {
      if (!context) {
        this.emit(event, ...args);
        return;
      }
      // A transient provider error is not the end of the user's task anymore.
      // Hold it until recovery is exhausted; a successful retry stays quiet.
      this.notePendingError(args[0]);
      return;
    }

    if (event === "turnEnd") {
      const runId = context?.recorder.runId;
      if (context && !context.loop.hasExited) {
        context.loop.exit(this.interrupted ? "abort_signal" : "unknown_fallthrough", {
          detail: "brain ended the turn without reporting an exit",
        });
      }
      if (runId && this.suppressedTurnEnds.has(runId)) return;
      if (runId) this.emitTerminal(runId);
      else this.emit(event, ...args);
      return;
    }

    this.emit(event, ...args);
  }

  private notePendingError(message: unknown): void {
    const text = String(message ?? "").trim() || "Unknown brain error";
    // A provider that reports the same failure twice is one fact, not two.
    if (this.pendingErrors.at(-1) === text) return;
    this.pendingErrors.push(text);
    if (this.pendingErrors.length > 20) this.pendingErrors.splice(0, this.pendingErrors.length - 20);
  }

  /**
   * What went wrong, as one message: the first failure, the most recent one,
   * and how many there were. The first is usually the cause and the last is
   * usually what the user saw, so reporting either alone loses the run.
   */
  private summarizePendingErrors(): string | null {
    const count = this.pendingErrors.length;
    if (count === 0) return null;
    if (count === 1) return this.pendingErrors[0];
    return `${this.pendingErrors[0]}\n\n(${count} errors in this run; most recent: ${this.pendingErrors[count - 1]})`;
  }

  private emitTerminal(runId: string): void {
    if (this.terminalRuns.has(runId)) return;
    this.terminalRuns.add(runId);
    const reason = this.checkpoint?.lastExitReason;
    if (this.finalFailureMessage) this.emit("text", this.finalFailureMessage);
    const failures = this.summarizePendingErrors();
    if (failures && reason !== "completed" && reason !== "abort_signal") {
      this.emit("error", failures);
    }
    this.finalFailureMessage = null;
    this.pendingErrors.length = 0;
    this.emit("turnEnd");
  }

  private cleanup(context: AgentRunContext): void {
    activeRecorders.delete(context.recorder);
    clearCurrentLoop(context.loop);
    if (fallbackActive === context.recorder) fallbackActive = null;
    if (this.context === context) this.context = null;
    if (configuredReplayRun()) replaySession = null;
  }

  private onRunExit(
    context: AgentRunContext,
    checkpoint: RecoveryCheckpoint,
    reason: ExitReason,
    payload: Record<string, unknown>
  ): void {
    checkpoint.lastExitReason = reason;
    checkpoint.lastExitDetail = typeof payload.detail === "string" ? payload.detail : undefined;

    if (reason === "completed") {
      checkpoint.status = "completed";
      this.finalizeTask(checkpoint, "completed");
      this.persistCheckpoint(context.recorder.dir, checkpoint);
      this.cleanup(context);
      return;
    }
    if (reason === "abort_signal" || this.interrupted || this.stopped) {
      checkpoint.status = "cancelled";
      this.finalizeTask(checkpoint, "cancelled");
      this.persistCheckpoint(context.recorder.dir, checkpoint);
      this.cleanup(context);
      return;
    }

    const recoverable = INCOMPLETE_EXITS.has(reason);
    const canRetry = recoverable && checkpoint.restartable !== false && this.autoResume &&
      checkpoint.recoveryAttempts < checkpoint.maxRecoveryAttempts;
    if (canRetry) {
      checkpoint.recoveryAttempts++;
      checkpoint.status = "pending";
      this.persistCheckpoint(context.recorder.dir, checkpoint);
      this.suppressedTurnEnds.add(context.recorder.runId);
      this.cleanup(context);

      const delay = this.recoveryDelayMs ?? configuredRecoveryDelay(reason);
      console.warn(
        `[echo:recovery] ${checkpoint.actor.name} stopped (${reason}); resuming task ${checkpoint.taskId} ` +
        `from checkpoint, attempt ${checkpoint.recoveryAttempts}/${checkpoint.maxRecoveryAttempts}`
      );
      this.emit("status", "thinking");
      if (checkpoint.recoveryAttempts === 1) {
        this.emit("text", `${checkpoint.actor.name} stopped before finishing, so I'm continuing from its checkpoint.`);
      }
      // Deliberately NOT unref'd. The line above has already told the user the
      // task is continuing from its checkpoint, so this timer is a promise
      // that has been made out loud. An unref'd timer does not hold the event
      // loop open, so whenever nothing else does — a headless run, a detached
      // worker, a rehearsal actor — the process exits during the backoff and
      // the promised recovery simply never happens. That is a silent stop
      // manufactured by the recovery mechanism itself.
      //
      // Nothing is left dangling at quit in exchange: both `interrupt()` and
      // `stop()` clear this timer through `cancelPendingRecovery`.
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = null;
        this.beginRun(recoveryPrompt(checkpoint), checkpoint);
      }, delay);
      return;
    }

    checkpoint.status = "exhausted";
    this.finalizeTask(checkpoint, "failed");
    this.persistCheckpoint(context.recorder.dir, checkpoint);
    this.cleanup(context);
    this.suppressedTurnEnds.add(context.recorder.runId);
    const message = recoverable
      ? `${checkpoint.actor.name} could not finish after ${checkpoint.recoveryAttempts} automatic recovery attempt(s). ` +
        `The checkpoint is preserved in ${context.recorder.dir}.`
      : `${checkpoint.actor.name} stopped for an unrecoverable reason (${reason}).`;
    // Only when the run said nothing else: this is the wrapper's own summary,
    // and `finalFailureMessage` already speaks it. It should not displace a
    // real provider failure, nor be appended beside it.
    if (this.pendingErrors.length === 0) this.notePendingError(message);
    this.finalFailureMessage = message;
    queueMicrotask(() => this.emitTerminal(context.recorder.runId));
  }

  private beginRun(userText: string, checkpoint?: RecoveryCheckpoint, audio?: AudioTurn): void {
    const replay = getReplaySession();
    const root = replay ? replayOutputRoot(replay.runDir) : loopLogRoot();
    try {
      installProcessHandlers();
      const privateMode = this.lastSendOpts?.privateMode === true || checkpoint?.privateMode === true;
      const fullPayload = !privateMode && !!root && payloadRecordingEnabled();
      // A metadata-only trace (ECHO_FULL_LOG=0) must not keep the prompt: the
      // checkpoint sits on disk next to the redacted journal, and storing the
      // goal there would put back exactly the text that mode exists to omit.
      // Restart follows from the same fact — there is no prompt to restart.
      const task = checkpoint ?? createRecoveryCheckpoint(
        this.identity,
        fullPayload ? userText : "",
        this.maxRecoveryAttempts,
        fullPayload
      );
      task.taskId = checkpoint?.taskId ?? this.lastSendOpts?.taskId ?? task.taskId;
      task.privateMode = privateMode;
      task.scope = this.lastSendOpts?.scope ?? checkpoint?.scope ?? {};
      task.restartable = !privateMode && fullPayload && !!task.originalPrompt;
      if (!replay) {
        const state = taskCoordinator.create({ taskId: task.taskId, parentTaskId: this.lastSendOpts?.parentTaskId ?? this.identity.parentTaskId, ownerActorId: this.identity.id, goal: userText, scope: task.scope, privateMode });
        task.taskRevision = state.revision;
        setPrivateTask(task.taskId, privateMode);
      }
      const recorder = root && !privateMode ? new Recorder(root, runIdFor(task.actor)) : ephemeralRecorder(runIdFor(task.actor));
      if (!replay) taskCoordinator.recordAttempt(task.taskId, recorder.runId);
      task.provider = this.provider;
      task.model = String(this.loopConfig.model ?? "unknown");
      const log = new LoopLog(recorder, this.provider, String(this.loopConfig.model ?? "unknown"));
      const context: AgentRunContext = {
        identity: task.actor,
        taskId: task.taskId,
        recorder,
        loop: log,
        payloadRecording: fullPayload,
        privateMode,
        scope: task.scope,
      };
      if (this.lastContext) this.lastContext.successor = context;
      this.lastContext = context;
      context.deps = replay ? replayDeps(replay.source, recorder) : liveDeps(recorder);

      this.context = context;
      this.checkpoint = task;
      this.interrupted = false;
      task.status = "running";
      task.lastRunId = recorder.runId;
      writeRecoveryCheckpoint(recorder.dir, task);

      activeRecorders.add(recorder);
      fallbackActive = recorder;
      setCurrentLoop(log);
      recorder.mirror = (event) => {
        if (recorder.dir && !privateMode && process.env.ECHO_LOG_QUIET?.trim() !== "1") consoleMirror(event);
        this.updateCheckpoint(event, task, recorder.dir);
      };

      log.onExit((reason, payload) => {
        if (!replay && !privateMode && task.actor.kind !== "rehearsal") rememberOutcome(reason, payload, task.originalPrompt);
        this.onRunExit(context, task, reason, payload);
      });
      log.onStall((payload) => {
        if (log.hasExited) return;
        const waitingOn = String(payload.waitingOn ?? payload.state ?? "unknown work");
        this.notePendingError(`${task.actor.name} stalled while waiting on ${waitingOn}.`);
        log.exit("stream_closed", {
          detail: `watchdog stopped a stalled run while waiting on ${waitingOn}`,
        });
        try { this.inner.interrupt(); }
        catch { /* the separate recovery attempt still starts from the checkpoint */ }
      });
      log.runStart({
        ...this.loopConfig,
        env: safeEnv(),
        actor: task.actor,
        taskId: task.taskId,
        recoveryAttempt: task.recoveryAttempts,
        resumedFrom: task.runDirs.length > 1 ? task.runDirs.at(-2) : null,
      });

      if (context.payloadRecording) {
        const promptRef = recorder.blob(userText);
        recorder.emit({ type: "agent.input", bodyRef: promptRef, recovery: task.recoveryAttempts > 0 });
      }
      if (!checkpoint && !replay && !privateMode && task.actor.kind !== "rehearsal") rememberRequest(userText);
      runInAgentContext(context, () => {
        setAgentDeps(context.deps as any);
        this.inner.send(userText, audio, this.lastSendOpts);
      });
    } catch (error) {
      console.error("[echo:log] could not start the run log:", (error as any)?.message ?? error);
      if (this.context) this.cleanup(this.context);
      replaySession = null;
      resetAgentDeps();
      this.emit("error", `Could not persist task state; action paused: ${(error as any)?.message ?? error}`);
      this.emit("turnEnd");
    }
  }

  get currentTaskId(): string | undefined { return this.context?.taskId ?? this.checkpoint?.taskId; }
  get currentTaskState(): TaskState | null { return this.currentTaskId ? taskCoordinator.get(this.currentTaskId) : null; }
  getTaskId(): string | undefined { return this.currentTaskId; }
  exportTaskState(): TaskState | null { return this.currentTaskState; }
  get projectHint(): string | undefined { return (this.inner as any).projectHint; }
  set projectHint(value: string | undefined) { (this.inner as any).projectHint = value; }
  invalidateMemory(): void { (this.inner as any).invalidateMemory?.(); }

  private finalizeTask(checkpoint: RecoveryCheckpoint, status: "completed" | "failed" | "cancelled"): void {
    if (isReplaying()) return;
    const existing = taskCoordinator.get(checkpoint.taskId); if (!existing) return;
    let state: TaskState;
    if (status === "cancelled") state = taskCoordinator.cancel(checkpoint.taskId);
    else {
      // Tool-free responses can complete communication; an action needs an explicit verified postcondition.
      const noActions = Object.keys(existing.calls).length === 0 && checkpoint.actions.length === 0;
      state = taskCoordinator.finish(checkpoint.taskId, { status: existing.status === "completed" ? "completed" : status,
        verificationRefs: existing.verificationRefs.length ? existing.verificationRefs : noActions && status === "completed" ? [`response:${checkpoint.lastRunId}`] : [], summary: checkpoint.lastAssistantText });
    }
    setPrivateTask(checkpoint.taskId, false);
    if (state.privateMode || checkpoint.actor.kind === "rehearsal") return;
    try { consolidateTask({ taskId: state.taskId, scope: state.scope as any, goal: state.goal,
      outcome: state.status === "completed" ? "verified_success" : state.status === "failed" ? "failed" : state.status === "cancelled" ? "cancelled" : "partial",
      executionStatus: status, verificationRefs: state.verificationRefs, attemptIds: state.attemptIds, actorId: state.ownerActorId, origin: "real" }); }
    catch (error) { console.error("[memory] consolidation failed", error); }
  }

  /** The wrapped brain's actual audio capability. */
  get hearsAudio(): boolean {
    return this.inner.hearsAudio;
  }

  /**
   * Cancel a retry that is still waiting out its backoff.
   *
   * The window between a failed attempt and its retry is the one moment when
   * stopping does not stop anything. `cleanup` has already run, so `this.context`
   * is null and the `context?.loop.exit("abort_signal")` in interrupt/stop is a
   * no-op — nothing marks the checkpoint, it stays `pending` on disk, and
   * pendingRecoveries() resumes `pending` at the next launch. The task you
   * killed comes back hours later, at a moment with no context for it.
   *
   * A new command has always cancelled the retry; interrupting and stopping
   * have to mean at least as much as talking over it.
   */
  private cancelPendingRecovery(cause: "superseded" | "halted"): void {
    if (!this.recoveryTimer || this.checkpoint?.status !== "pending") return;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    const checkpoint = this.checkpoint;
    checkpoint.status = "cancelled";
    // The user aborted. The provider failure that opened this backoff is no
    // longer the story, and must not be reported as the reason the turn ended.
    checkpoint.lastExitReason = "abort_signal";
    checkpoint.lastExitDetail =
      cause === "halted" ? "cancelled during the recovery backoff" : "superseded by a new command";
    this.finalizeTask(checkpoint, "cancelled");
    const lastDir = checkpoint.runDirs.at(-1);
    if (lastDir) this.persistCheckpoint(lastDir, checkpoint);

    // A new command is about to open its own run, which will end itself. Only a
    // halt leaves the turn with nothing left to close it.
    if (cause === "halted") {
      // Nothing else can end this turn. The failed attempt's `turnEnd` was
      // suppressed precisely so recovery could carry the task on, and the
      // recovery has just been cancelled — so without this the caller waits in
      // "thinking" forever and the cancel is the thing that silently does
      // nothing. For an agent with real machine access, a cancel that appears
      // not to land is worse than a stop that does.
      //
      // `this.checkpoint` is still set here on purpose: emitTerminal reads
      // `lastExitReason` from it, and abort_signal is what keeps the stale
      // provider error from surfacing as this turn's failure.
      this.emit("text", `Stopped. ${checkpoint.actor.name} will not resume that task.`);
      this.emitTerminal(checkpoint.lastRunId);
    }
    this.checkpoint = null;
  }

  private lastSendOpts?: SendOptions;

  noteInterrupted(spoken: string): void {
    this.inner.noteInterrupted?.(spoken);
  }

  send(userText: string, audio?: AudioTurn, opts?: SendOptions): void {
    this.lastSendOpts = opts;
    this.cancelPendingRecovery("superseded");
    if (this.context && !this.context.loop.hasExited) {
      // A follow-up can arrive while the provider is still draining the same
      // conversation. Keep it in the owning clone's async context and tape.
      const context = this.context;
      if (context.payloadRecording) {
        const bodyRef = context.recorder.blob(userText);
        context.recorder.emit({ type: "agent.input", bodyRef, queued: true });
        if (this.checkpoint) {
          (this.checkpoint.followUpPrompts ??= []).push(userText);
          if (this.checkpoint.followUpPrompts.length > 20) this.checkpoint.followUpPrompts.shift();
          writeRecoveryCheckpoint(context.recorder.dir, this.checkpoint);
        }
      }
      runInAgentContext(context, () => this.inner.send(userText, audio, this.lastSendOpts));
      return;
    }
    this.stopped = false;
    this.beginRun(userText, undefined, audio);
  }

  /** Resume a task left `running` by a dead process. Used once during startup. */
  recoverFromCheckpoint(checkpoint: RecoveryCheckpoint): boolean {
    if (this.context || this.stopped) return false;
    if (checkpoint.restartable === false || !checkpoint.originalPrompt) return false;
    if (checkpoint.recoveryAttempts >= checkpoint.maxRecoveryAttempts) {
      checkpoint.status = "exhausted";
      const lastDir = checkpoint.runDirs.at(-1);
      if (lastDir) this.persistCheckpoint(lastDir, checkpoint);
      return false;
    }
    checkpoint.recoveryAttempts++;
    checkpoint.status = "pending";
    this.checkpoint = checkpoint;
    this.emit("text", `${checkpoint.actor.name} was interrupted, so I'm resuming it from the last checkpoint.`);
    this.beginRun(recoveryPrompt(checkpoint), checkpoint);
    return true;
  }

  interrupt(): void {
    this.interrupted = true;
    // Before the unconditional clear below, which would otherwise drop the
    // timer and leave the checkpoint behind as pending.
    this.cancelPendingRecovery("halted");
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.inner.interrupt();
    const context = this.context;
    context?.loop.exit("abort_signal", { detail: "user interrupted" });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.interrupted = true;
    // Quitting mid-backoff is the likeliest way to hit this: the loop has just
    // gone quiet after a 429, and the app is closed before the retry fires.
    this.cancelPendingRecovery("halted");
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    const context = this.context;
    context?.loop.exit("abort_signal", { detail: "brain stopped" });
    await this.inner.stop();
  }
}

/** Unfinished checkpoints owned by processes that are no longer alive. */
export function pendingRecoveries(): RecoveryCheckpoint[] {
  // Exact replay is a side-effect-free lab mode. Never wake real unfinished
  // tasks beside it just because their checkpoints share the normal log root.
  if (configuredReplayRun()) return [];
  const root = loopLogRoot();
  return root ? pendingRecoveryCheckpoints(root) : [];
}
