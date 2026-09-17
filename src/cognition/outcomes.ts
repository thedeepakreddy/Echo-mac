import { record, consolidate, type EpisodeKind } from "./episodic.js";

/**
 * The bridge between a finished run and what Echo remembers about it.
 *
 * episodic.ts has been complete and unreachable: nothing imported it, so
 * `record` was never called, `consolidate` never ran, and `factsForPrompt`
 * always returned "". The scoring, the decay curve, the across-days
 * consolidation rule — all of it was dead code.
 *
 * This connects it to the one event worth remembering above all others: how a
 * run ended. An outcome carries the exit reason, so "you keep stopping halfway
 * through long refactors" is a thing Echo can eventually notice about itself
 * rather than a thing only the user notices.
 */

/** Exit reasons that mean the task did not finish. Mirrors INCOMPLETE_EXITS. */
const INCOMPLETE = new Set([
  "max_iterations", "abort_signal", "tool_error", "provider_error",
  "rate_limit_429", "context_overflow", "stream_closed", "unknown_fallthrough",
  "model_stop_no_tool_call", "error", "aborted", "unknown",
]);

/** Consolidation walks every episode, so it runs at most this often. */
const CONSOLIDATE_EVERY_MS = 60 * 60 * 1000;
let lastConsolidatedAt = 0;

/** What the user asked for. Recorded when the turn starts, not when it ends. */
export function rememberRequest(text: string, project?: string): void {
  try {
    record({ kind: "request", text, project });
  } catch (err) {
    console.error("[episodic] could not record the request:", (err as any)?.message ?? err);
  }
}

/**
 * What became of it.
 *
 * An incomplete run is deliberately scored well above a successful one. A run
 * that worked teaches nothing the next successful run will not also teach; the
 * ones worth being able to find months later are the ones that came apart.
 */
export function rememberOutcome(
  reason: string,
  payload: Record<string, unknown>,
  request: string,
  project?: string
): void {
  const incomplete = INCOMPLETE.has(reason);
  const kind: EpisodeKind = "outcome";
  const where = payload.lastTool ? ` while running ${payload.lastTool}` : "";
  const iteration = typeof payload.iteration === "number" ? payload.iteration : null;
  const text = incomplete
    ? `Stopped before finishing (${reason})${where}` +
      (iteration !== null ? ` at step ${iteration}` : "") +
      (request ? `. Task was: ${request.slice(0, 200)}` : "")
    : `Finished the task${iteration !== null ? ` in ${iteration} step(s)` : ""}` +
      (request ? `: ${request.slice(0, 200)}` : "");

  try {
    record({
      kind,
      text,
      project,
      // 0.8 keeps an unfinished run findable for months; a clean success sinks
      // at roughly the ordinary rate.
      importance: incomplete ? 0.8 : 0.35,
    });
  } catch (err) {
    console.error("[episodic] could not record the outcome:", (err as any)?.message ?? err);
  }

  maybeConsolidate();
}

/**
 * Promote what keeps recurring into standing facts.
 *
 * Throttled because it reads every episode. Run after a turn rather than on a
 * timer, so it never competes with the loop for the main thread mid-task.
 */
function maybeConsolidate(now = Date.now()): void {
  if (now - lastConsolidatedAt < CONSOLIDATE_EVERY_MS) return;
  lastConsolidatedAt = now;
  try {
    const { promoted } = consolidate();
    if (promoted.length) {
      console.log(`[episodic] promoted ${promoted.length} recurring pattern(s) to standing facts`);
    }
  } catch (err) {
    console.error("[episodic] consolidation failed:", (err as any)?.message ?? err);
  }
}
