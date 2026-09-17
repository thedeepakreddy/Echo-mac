import { contentHash, type ReplayEvent } from "./recorder.js";
import { loadEvents } from "./replay-source.js";

export interface Mismatch {
  seq: number;
  kind: "length" | "type" | "content";
  expected?: ReplayEvent;
  actual?: ReplayEvent;
}

export interface VerifyReport {
  ok: boolean;
  mismatches: Mismatch[];
  actionMatchRate: number;
}

function comparable(event: ReplayEvent): Record<string, unknown> {
  // Volatile by nature: wall-clock, monotonic offset, the run's own identity,
  // measured durations, and the OS process a replay happens to run in. None of
  // them say anything about whether the agent made the same decisions.
  const {
    ts: _ts, iso: _iso, mono: _mono, runId: _runId, durationMs: _durationMs,
    elapsedMs: _elapsedMs, elapsedInStateMs: _elapsedInStateMs, latencyMs: _latencyMs,
    pid: _pid, callId: _callId, reqId: _reqId, taskId: _taskId, ...rest
  } = event;
  if (rest.config && typeof rest.config === "object") {
    const { taskId: _configTaskId, ...config } = rest.config as Record<string, unknown>;
    rest.config = config;
  }
  return rest;
}

/** Compare two recorder streams and return the first informative divergence. */
export function compareEventStreams(original: ReplayEvent[], replayed: ReplayEvent[]): VerifyReport {
  const count = Math.max(original.length, replayed.length);
  let matchedActions = 0;
  let actionCount = 0;
  for (let i = 0; i < count; i++) {
    const expected = original[i];
    const actual = replayed[i];
    const action = expected?.type === "tool.call" || expected?.type === "llm.request";
    if (action) actionCount++;
    if (!expected || !actual) {
      return { ok: false, mismatches: [{ seq: i, kind: "length", expected, actual }], actionMatchRate: actionCount ? matchedActions / actionCount : 1 };
    }
    if (expected.type !== actual.type) {
      return { ok: false, mismatches: [{ seq: i, kind: "type", expected, actual }], actionMatchRate: actionCount ? matchedActions / actionCount : 1 };
    }
    if (contentHash(comparable(expected)) !== contentHash(comparable(actual))) {
      return { ok: false, mismatches: [{ seq: i, kind: "content", expected, actual }], actionMatchRate: actionCount ? matchedActions / actionCount : 1 };
    }
    if (action) matchedActions++;
  }
  return { ok: true, mismatches: [], actionMatchRate: 1 };
}

export function verifyRunDirectories(originalDir: string, replayDir: string): VerifyReport {
  return compareEventStreams(loadEvents(originalDir), loadEvents(replayDir));
}
