import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Why a run stopped.
 *
 * A closed union on purpose: every `break`, `return` and `throw` that can end
 * the loop has to name one of these, so "the run just ended" stops being a
 * possible outcome. `unknown_fallthrough` is the default, and seeing it in a log
 * means a path was missed rather than that the cause is mysterious.
 *
 * The first four names are kept for recordings written before this widened, so
 * an old trace still loads in the inspector.
 */
export type ExitReason =
  | "completed"
  | "max_iterations"
  | "model_stop_no_tool_call"
  | "abort_signal"
  | "tool_error"
  | "provider_error"
  | "rate_limit_429"
  | "context_overflow"
  | "stream_closed"
  | "unknown_fallthrough"
  // Pre-existing names, still read by the inspector for older runs.
  | "error"
  | "aborted"
  | "unknown";

/** Exit reasons that mean the task did NOT finish, whatever the model said. */
export const INCOMPLETE_EXITS: ReadonlySet<string> = new Set([
  "max_iterations",
  "model_stop_no_tool_call",
  "abort_signal",
  "tool_error",
  "provider_error",
  "rate_limit_429",
  "context_overflow",
  "stream_closed",
  "unknown_fallthrough",
  "error",
  "aborted",
  "unknown",
]);

/** Payloads at or above this many bytes are spilled to blobs/ and referenced. */
export const BLOB_THRESHOLD_BYTES = 32 * 1024;

export type ReplayEvent = {
  seq: number;
  ts: number;
  mono: number;
  runId: string;
  type: string;
  [key: string]: unknown;
};

export type Redactor = (path: string, value: unknown) => unknown;

/**
 * Redact before bytes touch the replay directory, never while rendering them.
 *
 * A bare `token` here also matched `totalContextTokens` and `promptTokens`, so
 * the telemetry that diagnoses a context overflow was being redacted as if it
 * were a credential. "token" only implies a secret when it is the whole field
 * name or is qualified by one (access, refresh, bearer, session…) — a count is
 * never sensitive.
 */
export const defaultRedactor: Redactor = (path, value) =>
  /api[-_]?key|authorization|password|secret|cookie|credential|(^|[^A-Za-z])(access|refresh|bearer|auth|session|id|api)[-_]?token|\.tokens?$/i.test(path)
    ? "[REDACTED]"
    : value;

export function stableJson(value: unknown, redact: Redactor = defaultRedactor, path = "$"): string {
  const visit = (current: unknown, currentPath: string): unknown => {
    const redacted = redact(currentPath, current);
    if (redacted !== current) return redacted;
    if (Array.isArray(current)) return current.map((item, i) => visit(item, `${currentPath}[${i}]`));
    if (current && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, visit(item, `${currentPath}.${key}`)])
      );
    }
    return current;
  };
  return JSON.stringify(visit(value, path));
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/**
 * An append-only per-turn recorder. Critical terminal events are synchronously
 * appended and fsynced, so a hard crash still leaves the explanation behind.
 */
export class Recorder {
  readonly runId: string;
  readonly dir: string;
  private seq = 0;
  private readonly started = performance.now();
  private closed = false;

  // `runId: string`, not the UUID template type randomUUID() infers: a caller
  // may supply a readable id, and a run's identity is not required to be a UUID.
  constructor(rootDir: string, runId: string = randomUUID(), private readonly redact: Redactor = defaultRedactor) {
    this.runId = runId;
    this.dir = join(rootDir, runId);
    mkdirSync(join(this.dir, "blobs"), { recursive: true });
  }

  /**
   * Spill any oversized field to blobs/ and leave a reference behind.
   *
   * The messages array is re-sent whole on every iteration, so writing it inline
   * would make the file grow quadratically with the run and the interesting last
   * lines would be buried under megabytes of repeated context.
   */
  private spill(event: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      if (value === undefined) continue;
      if (value === null || typeof value !== "object") {
        out[key] = value;
        continue;
      }
      let json: string;
      try {
        json = stableJson(value, this.redact);
      } catch {
        out[key] = "[unserializable]";
        continue;
      }
      if (Buffer.byteLength(json, "utf8") < BLOB_THRESHOLD_BYTES) {
        out[key] = value;
        continue;
      }
      try {
        out[`${key}Ref`] = this.blob(value);
        out[`${key}Bytes`] = Buffer.byteLength(json, "utf8");
      } catch {
        // A full disk must cost the payload, never the event that explains the run.
        out[`${key}Ref`] = "[blob-write-failed]";
      }
    }
    return out;
  }

  blob(value: unknown): string {
    const json = stableJson(value, this.redact);
    const hash = createHash("sha256").update(json).digest("hex");
    const file = join(this.dir, "blobs", hash);
    if (!existsSync(file)) writeFileSync(file, json, { mode: 0o600 });
    return hash;
  }

  emit(event: Record<string, unknown> & { type: string }, critical = false): ReplayEvent {
    if (this.closed) throw new Error("cannot write to a closed replay recorder");
    const full: ReplayEvent = {
      seq: this.seq++,
      ts: Date.now(),
      iso: new Date().toISOString(),
      mono: performance.now() - this.started,
      runId: this.runId,
      ...this.spill(event),
      type: event.type,
    };
    const file = join(this.dir, "events.jsonl");
    const fd = openSync(file, "a", 0o600);
    try {
      appendFileSync(fd, `${stableJson(full, this.redact)}\n`);
      // The runs worth reading are the ones that died, so every line is on disk
      // before the next one is built. `critical` additionally forces the
      // platform to flush its own cache, for a hard kill rather than a crash.
      if (critical) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.mirror?.(full);
    return full;
  }

  /** Watch a live run. Set by the loop logger; never used for replay fidelity. */
  mirror: ((event: ReplayEvent) => void) | null = null;

  finish(ok: boolean, reason: ExitReason, iteration: number, detail?: string): void {
    if (this.closed) return;
    this.emit({ type: "loop.exit", reason, iteration, detail }, true);
    this.emit({ type: "run.end", ok, durationMs: performance.now() - this.started }, true);
    this.closed = true;
  }

  /** Close after LoopLog has written its one run.end event. */
  close(): void {
    this.closed = true;
  }
}
