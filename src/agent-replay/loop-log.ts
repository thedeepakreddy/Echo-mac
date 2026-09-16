import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Recorder, contentHash, type ExitReason, type ReplayEvent, INCOMPLETE_EXITS } from "./recorder.js";
import { currentAgentRunContext } from "./context.js";

/**
 * The loop's own black box.
 *
 * Echo could stop mid-task with nothing in the console and nothing in the log,
 * and the reason was never that the cause was subtle — it was that every way the
 * loop could end reported the same thing. A `break` on an empty model response,
 * a 150-iteration cap, and a genuine "I'm finished" all emitted `turnEnd`, which
 * the recorder wrote down as `completed`. The evidence said the run succeeded.
 *
 * So this module's contract is narrow and absolute: EVERY path out of the loop
 * names why, from a closed union, before the loop unwinds. `unknown_fallthrough`
 * is the default. Seeing it means a path was missed — it is a bug report about
 * this file, not a description of the run.
 *
 * The second thing it does is tell a hang from a stop. Those are identical from
 * outside and have completely different causes, so the loop reports what it is
 * waiting on every 15 seconds. A log that ends with heartbeats still ticking is
 * a hang; a log that ends with neither heartbeat nor exit is a dead process.
 *
 * Standalone by design: node builtins and the recorder, nothing from Echo. It is
 * meant to survive being lifted out into its own package.
 */

export type LoopState = "awaiting_llm" | "awaiting_tool" | "reflecting" | "idle";

/** One vocabulary for three providers that each spell this differently. */
export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "error"
  | "unknown";

export interface ExitPayload {
  iteration: number;
  lastTool?: string | null;
  lastToolArgsHash?: string | null;
  finishReason?: FinishReason | null;
  rawFinishReason?: unknown;
  provider?: string;
  model?: string;
  messageCount?: number;
  approxTokensInContext?: number;
  error?: unknown;
  /** Free-text for a human; never parsed. */
  detail?: string;
  [key: string]: unknown;
}

export interface TurnPayload {
  iteration: number;
  provider: string;
  model: string;
  finishReason: FinishReason;
  rawFinishReason?: unknown;
  toolCallCount: number;
  toolNames: string[];
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalContextTokens?: number | null;
  latencyMs: number;
  cacheHit?: boolean | null;
}

/** How often the loop says what it is waiting on. */
export const HEARTBEAT_MS = 15_000;

/** The request deadline `recordLLM` applies when nothing overrides it. */
export const DEFAULT_REQUEST_DEADLINE_MS = 120_000;

/**
 * How far behind the slowest guarded operation the watchdog sits.
 *
 * A watchdog that becomes eligible at the same instant as the deadline it backs
 * up is not a backstop, it is a second racer. Both used to be 120000: when a
 * provider hung, `withDeadline` was rejecting the request while the watchdog
 * was calling `exit("stream_closed")` and `inner.interrupt()`, and which of the
 * two terminal paths described the run was a scheduling accident.
 */
export const STALL_HEADROOM_MS = 60_000;

/** How long one state may last before the log calls it a suspected stall. */
export const STALL_AFTER_MS = DEFAULT_REQUEST_DEADLINE_MS + STALL_HEADROOM_MS;

/** A deadline in milliseconds, where 0 means the operation is never cut off. */
function deadlineFromEnv(raw: string | undefined, fallback: number): number {
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : fallback;
}

/**
 * The stall threshold for the current configuration, clamped so it can never be
 * set at or below the deadlines it is supposed to outlive.
 *
 * It tracks `ECHO_LLM_TIMEOUT_MS` and `ECHO_TOOL_TIMEOUT_MS` because those are
 * the two waits the watchdog observes (`awaiting_llm`, `awaiting_tool`). A
 * deadline of 0 disables the cut-off entirely, which leaves the watchdog as the
 * only thing that can end that wait — so it constrains nothing.
 */
export function stallAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const request = deadlineFromEnv(env.ECHO_LLM_TIMEOUT_MS, DEFAULT_REQUEST_DEADLINE_MS);
  const tool = deadlineFromEnv(env.ECHO_TOOL_TIMEOUT_MS, DEFAULT_REQUEST_DEADLINE_MS);
  const slowestGuarded = Math.max(request, tool);
  const floor = slowestGuarded > 0 ? slowestGuarded + STALL_HEADROOM_MS : STALL_AFTER_MS;
  const configured = Number(env.ECHO_STALL_AFTER_MS);
  if (Number.isFinite(configured) && configured > 0) return Math.max(Math.floor(configured), floor);
  return floor;
}

let cachedSha: string | null = null;

/**
 * Which build produced this run.
 *
 * Read once per process from git, because a log that cannot be tied back to a
 * commit is hard to act on weeks later. `GIT_SHA` wins when set, for a packaged
 * build with no repository around it.
 */
export function gitSha(cwd?: string): string {
  if (cachedSha !== null) return cachedSha;
  const fromEnv = process.env.GIT_SHA?.trim();
  if (fromEnv) return (cachedSha = fromEnv);
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return (cachedSha = out.trim() + (dirty ? "-dirty" : ""));
  } catch {
    // Not a repository, or git is unavailable in a packaged build.
    return (cachedSha = "unknown");
  }
}

/**
 * Identify a call by its arguments, so repeat calls are visible in a log.
 *
 * Uses the recorder's own hash, which redacts before hashing and sorts keys.
 * Hashing the raw object instead made two calls that differed only in a
 * credential hash differently — which broke replay verification and quietly
 * held a fingerprint of the secret, against the redact-before-disk rule the
 * rest of this sink follows.
 */
export function argsHash(args: unknown): string {
  try {
    return contentHash(args ?? {}).slice(0, 16);
  } catch {
    return "unhashable";
  }
}

/** Flatten an error to something JSON can hold, including its cause chain. */
export function serializeError(error: unknown, depth = 0): unknown {
  if (error == null) return null;
  if (!(error instanceof Error)) {
    return typeof error === "object" ? { value: String(error) } : { value: error };
  }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    // A wrapped provider failure usually carries the real status underneath.
    cause: depth < 3 && (error as any).cause ? serializeError((error as any).cause, depth + 1) : undefined,
    status: (error as any).status ?? (error as any).code ?? undefined,
  };
}

/**
 * Classify a provider failure into an exit reason.
 *
 * String matching, because none of the three providers throws a typed error:
 * Gemini returns prose inside a generic Error, Ollama surfaces an HTTP body, and
 * the Claude SDK wraps its CLI's stderr. The order matters — a 429 body often
 * also mentions a model name, so rate limiting is tested before anything else.
 */
export function classifyProviderError(error: unknown): ExitReason {
  const text = String((error as any)?.message ?? error ?? "").toLowerCase();
  if (/429|rate.?limit|resource_exhausted|quota exceeded|too many requests/.test(text)) {
    return "rate_limit_429";
  }
  if (/context length|context window|too many tokens|prompt is too long|prompt_too_long|maximum context/.test(text)) {
    return "context_overflow";
  }
  if (/stream|socket hang up|econnreset|epipe|aborted|premature close|timed? out|timeout/.test(text)) {
    return "stream_closed";
  }
  return "provider_error";
}

/** Gemini's finishReason -> the shared vocabulary. */
export function normalizeGeminiFinish(raw: unknown): FinishReason {
  switch (String(raw ?? "").toUpperCase()) {
    case "STOP": return "stop";
    case "MAX_TOKENS": return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY": return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL": return "error";
    case "": return "unknown";
    default: return "unknown";
  }
}

/** The Claude Agent SDK's terminal_reason / subtype -> the shared vocabulary. */
export function normalizeClaudeFinish(raw: unknown): FinishReason {
  switch (String(raw ?? "")) {
    case "completed":
    case "end_turn":
    case "success": return "stop";
    case "tool_use":
    case "tool_deferred": return "tool_calls";
    case "max_turns":
    case "error_max_turns":
    case "budget_exhausted":
    case "error_max_budget_usd":
    case "prompt_too_long": return "length";
    case "refusal": return "content_filter";
    case "model_error":
    case "api_error":
    case "turn_setup_failed":
    case "malformed_tool_use_exhausted":
    case "error_during_execution": return "error";
    case "": return "unknown";
    default: return "unknown";
  }
}

/** Ollama reports done_reason on a completed chat. */
export function normalizeOllamaFinish(raw: unknown, hadToolCalls = false): FinishReason {
  const value = String(raw ?? "").toLowerCase();
  if (hadToolCalls) return "tool_calls";
  if (value === "stop") return "stop";
  if (value === "length") return "length";
  if (!value) return "unknown";
  return "unknown";
}

/**
 * Map a Claude terminal_reason to why the LOOP ended, which is a different
 * question from how the model finished. `max_turns` finishes as "length" but
 * exits as `max_iterations`.
 */
export function claudeTerminalToExit(raw: unknown): ExitReason | null {
  switch (String(raw ?? "")) {
    case "max_turns": return "max_iterations";
    case "prompt_too_long": return "context_overflow";
    case "blocking_limit":
    case "rapid_refill_breaker": return "rate_limit_429";
    case "budget_exhausted": return "provider_error";
    case "aborted_streaming": return "stream_closed";
    case "aborted_tools": return "abort_signal";
    case "hook_stopped":
    case "stop_hook_prevented": return "abort_signal";
    case "model_error":
    case "api_error":
    case "turn_setup_failed": return "provider_error";
    case "malformed_tool_use_exhausted": return "tool_error";
    case "completed": return "completed";
    default: return null;
  }
}

export class LoopLog {
  readonly runId: string;
  private exited = false;
  private state: LoopState = "idle";
  private waitingOn: string | null = null;
  private stateSince = Date.now();
  private stalledReported = false;
  private timer: NodeJS.Timeout | null = null;
  private iteration = 0;
  private lastTool: string | null = null;
  private lastToolArgsHash: string | null = null;
  private lastFinish: FinishReason | null = null;
  private lastRawFinish: unknown = null;
  private readonly startedAt = Date.now();
  /**
   * Frozen per run: a threshold that moved mid-run would make two heartbeats in
   * the same tape disagree about what counts as stalled.
   */
  readonly stallAfterMs = stallAfterMs();
  private writeFailed = false;
  private endedBecause: ExitReason | null = null;
  private sealed = false;
  /**
   * Work the loop has started and not yet finished.
   *
   * An `llm.request` with no `llm.response` and no `llm.error` is exactly the
   * signature of a call that was walked away from — and it is produced by the
   * current code, because `exit()` closes the recorder and a request still in
   * flight then has its terminal event silently dropped by the try/catch that
   * keeps recording from ever changing a result. The gap that leaves in the
   * tape is indistinguishable from a recorder that simply stopped writing.
   *
   * So the loop keeps the ledger and names what it abandoned on the way out.
   */
  private readonly openWork = new Map<string, { kind: string; detail?: string; since: number }>();

  constructor(
    private readonly recorder: Recorder,
    readonly provider: string,
    private model: string
  ) {
    this.runId = recorder.runId;
  }

  /** Never let a logging fault change what the agent does. */
  private write(type: string, payload: Record<string, unknown>, critical = false): void {
    if (this.sealed) return;
    try {
      this.recorder.emit({ type, ...payload }, critical);
    } catch (err) {
      // Once, not per event: a broken sink would otherwise bury the console in
      // the same message thousands of times. Losing the trace is survivable;
      // losing it silently is the failure mode this whole module exists to end.
      if (!this.writeFailed) {
        this.writeFailed = true;
        console.error("[echo:loop] run log is no longer being written:", (err as any)?.message ?? err);
      }
    }
  }

  runStart(config: Record<string, unknown>): void {
    this.write(
      "run.start",
      {
        provider: this.provider,
        model: this.model,
        nodeVersion: process.version,
        electronVersion: (process.versions as any).electron ?? null,
        gitSha: config.gitSha ?? gitSha(),
        pid: process.pid,
        actor: config.actor ?? null,
        taskId: config.taskId ?? null,
        recoveryAttempt: config.recoveryAttempt ?? 0,
        resumedFrom: config.resumedFrom ?? null,
        config,
      },
      true
    );
    this.beat();
  }

  setModel(model: string): void {
    this.model = model;
  }

  /** Called at the top of each loop iteration. */
  iterationStart(n: number, messageCount: number, approxTokens: number): void {
    this.iteration = n;
    this.write("iteration.start", { iteration: n, messageCount, approxTokensInContext: approxTokens });
  }

  /**
   * What the loop is blocked on right now. The heartbeat reads this, so a state
   * left unset is the difference between "hung calling Gemini" and "hung
   * somewhere".
   */
  enterState(state: LoopState, waitingOn: string | null = null): void {
    this.state = state;
    this.waitingOn = waitingOn;
    this.stateSince = Date.now();
    this.stalledReported = false;
  }

  turnEnd(payload: TurnPayload): void {
    this.lastFinish = payload.finishReason;
    this.lastRawFinish = payload.rawFinishReason;
    this.write("turn.end", { ...payload });
  }

  toolStart(name: string, args: unknown, callId: string = randomUUID()): string {
    this.lastTool = name;
    this.lastToolArgsHash = argsHash(args);
    this.enterState("awaiting_tool", name);
    this.write("tool.start", { callId, name, argsHash: this.lastToolArgsHash, iteration: this.iteration });
    return callId;
  }

  toolEnd(callId: string, name: string, startedAt: number, isError: boolean, detail?: string): void {
    this.write("tool.end", {
      callId,
      name,
      durationMs: Date.now() - startedAt,
      isError,
      detail: detail ? String(detail).slice(0, 500) : undefined,
      iteration: this.iteration,
    });
  }

  /**
   * Register work whose completion the loop expects to record later.
   *
   * Callers that legitimately abandon what they start — a speculative or
   * warm-up request — must not register it, so that an unpaired event in the
   * tape always means something went wrong.
   */
  openedWork(id: string, kind: string, detail?: string): void {
    this.openWork.set(id, { kind, detail, since: Date.now() });
  }

  closedWork(id: string): void {
    this.openWork.delete(id);
  }

  /** A non-fatal note worth having in the same file as everything else. */
  note(type: string, payload: Record<string, unknown> = {}): void {
    this.write(type, { iteration: this.iteration, ...payload });
  }

  /**
   * The one exit event. Idempotent: the first caller wins, so a `finally` that
   * also reports cannot overwrite the specific reason a `break` already gave.
   */
  exit(reason: ExitReason, payload: Partial<ExitPayload> = {}): void {
    if (this.exited) return;
    this.exited = true;
    this.endedBecause = reason;
    this.stopHeartbeat();

    // Whatever is still open was abandoned. Recorded before the exit event, and
    // counted on it, so a reader sees the abandoned call in the same place they
    // already look for the reason.
    const abandoned = [...this.openWork.entries()];
    for (const [id, work] of abandoned) {
      this.write(
        "work.abandoned",
        {
          id,
          kind: work.kind,
          detail: work.detail,
          openForMs: Date.now() - work.since,
          iteration: this.iteration,
          reason,
        },
        true
      );
    }
    this.openWork.clear();

    const error = payload.error === undefined ? undefined : serializeError(payload.error);
    this.write(
      "loop.exit",
      {
        reason,
        abandoned: abandoned.length,
        iteration: payload.iteration ?? this.iteration,
        lastTool: payload.lastTool ?? this.lastTool,
        lastToolArgsHash: payload.lastToolArgsHash ?? this.lastToolArgsHash,
        finishReason: payload.finishReason ?? this.lastFinish ?? null,
        rawFinishReason: payload.rawFinishReason ?? this.lastRawFinish ?? null,
        provider: payload.provider ?? this.provider,
        model: payload.model ?? this.model,
        messageCount: payload.messageCount ?? null,
        approxTokensInContext: payload.approxTokensInContext ?? null,
        elapsedMs: Date.now() - this.startedAt,
        incomplete: INCOMPLETE_EXITS.has(reason),
        detail: payload.detail,
        error,
      },
      true
    );
    this.write("run.end", { ok: !INCOMPLETE_EXITS.has(reason), reason, durationMs: Date.now() - this.startedAt }, true);

    for (const listener of this.exitListeners) {
      try {
        listener(reason, { ...payload, incomplete: INCOMPLETE_EXITS.has(reason), iteration: payload.iteration ?? this.iteration });
      } catch {
        /* a subscriber must never turn a recorded exit into a thrown one */
      }
    }
    this.sealed = true;
    this.recorder.close();
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get exitReason(): ExitReason | null {
    return this.endedBecause;
  }

  /**
   * Told when the loop ends, and why.
   *
   * A hook rather than a direct call so this module keeps importing nothing
   * from Echo. Echo subscribes; the sink stays liftable into its own package.
   */
  onExit(listener: (reason: ExitReason, payload: Record<string, unknown>) => void): void {
    this.exitListeners.push(listener);
  }

  private exitListeners: ((reason: ExitReason, payload: Record<string, unknown>) => void)[] = [];
  private stallListeners: ((payload: Record<string, unknown>) => void)[] = [];

  onStall(listener: (payload: Record<string, unknown>) => void): void {
    this.stallListeners.push(listener);
  }

  // ---- heartbeat ----------------------------------------------------------

  private beat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), HEARTBEAT_MS);
    // A heartbeat must never be the reason Electron stays alive at quit.
    this.timer.unref?.();
  }

  private tick(): void {
    if (this.exited) return;
    const elapsedInStateMs = Date.now() - this.stateSince;
    const payload = {
      iteration: this.iteration,
      state: this.state,
      waitingOn: this.waitingOn,
      elapsedInStateMs,
      stallAfterMs: this.stallAfterMs,
    };
    this.write("loop.heartbeat", payload);
    // First record the evidence, then notify the owning brain. Recovery keeps
    // the stall event in the tape and starts a separate named attempt, so the
    // cause remains visible rather than being hidden by the retry.
    if (elapsedInStateMs > this.stallAfterMs && !this.stalledReported && this.state !== "idle") {
      this.stalledReported = true;
      this.write("loop.stall_suspected", payload, true);
      console.warn(
        `[echo:loop] stall suspected — ${this.state}${this.waitingOn ? ` (${this.waitingOn})` : ""} for ${Math.round(elapsedInStateMs / 1000)}s`
      );
      for (const listener of this.stallListeners) {
        try { listener(payload); }
        catch { /* recovery observers must never break the heartbeat */ }
      }
    }
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ---- the one live run -----------------------------------------------------

let fallback: LoopLog | null = null;

export function currentLoop(): LoopLog | null {
  return currentAgentRunContext()?.loop ?? fallback;
}

export function setCurrentLoop(log: LoopLog | null): void {
  if (log === null) fallback?.stopHeartbeat?.();
  fallback = log;
}

/** Clear only the named fallback; never stop another clone's heartbeat. */
export function clearCurrentLoop(log: LoopLog): void {
  if (fallback !== log) return;
  fallback = null;
}

/** Compact single-line mirror so a run can be watched without tailing a file. */
export function consoleMirror(event: ReplayEvent): void {
  const type = String(event.type);
  if (type === "clock.now" || type === "random.value" || type === "uuid.value" || type === "env.value") return;
  const at = String(event.iso ?? "").slice(11, 19);
  const bits: string[] = [];
  for (const key of ["reason", "state", "waitingOn", "name", "finishReason", "iteration", "elapsedInStateMs", "durationMs", "isError", "toolCallCount"]) {
    if (event[key] !== undefined && event[key] !== null) bits.push(`${key}=${String(event[key]).slice(0, 60)}`);
  }
  const actor = String(event.runId ?? "Echo").split("--")[0] || "Echo";
  const line = `[echo:log:${actor} ${at}] ${type}${bits.length ? " " + bits.join(" ") : ""}`;
  if (type === "loop.exit" || type === "loop.stall_suspected" || type === "process.uncaughtException") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
