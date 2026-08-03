import { classify } from "../safety/risk.js";
import { confirmations } from "../safety/confirm.js";
import { capture } from "../safety/snapshot.js";
import { observeAction } from "./observe.js";
import { replay } from "./replay.js";
import type { Step, Workflow } from "./demonstrate.js";

/**
 * Replays a saved workflow through the same safety checks a live command gets.
 *
 * The reflex cache replays steps directly, without the model in the loop — which
 * is the point, it is what makes a repeated command instant. But it also meant
 * those steps skipped the risk gate entirely: a cached workflow containing
 * "click Send" or "click Delete" fired with no confirmation at all, because the
 * gate lives in the brain and the brain was never consulted.
 *
 * Speed is not a reason to lower the bar. Every step is classified here first,
 * exactly as if the model had asked for it.
 */

/** Turn a step into the tool call it is equivalent to, for classification. */
function asToolCall(step: Step): { tool: string; input: Record<string, unknown> } {
  switch (step.kind) {
    case "click":
      return { tool: "click_ui_element", input: { description: step.target } };
    case "type":
      return { tool: "type_text", input: { text: step.text } };
    case "keys":
      return { tool: "press_keys", input: { modifiers: step.modifiers, key: step.key } };
    case "open":
      return { tool: "open_app", input: { name: step.app } };
    case "wait":
      return { tool: "wait", input: { seconds: step.seconds } };
  }
}

export interface GatedReplayResult {
  ok: boolean;
  summary: string;
}

/**
 * Check every step, then replay. A refusal stops the whole run rather than
 * skipping one step — a half-executed workflow is worse than none, because the
 * user cannot tell how far it got.
 */
export async function replayWithGate(
  wf: Workflow,
  steps: Step[],
  workingDir: string
): Promise<GatedReplayResult> {
  for (const step of steps) {
    const { tool, input } = asToolCall(step);
    const assessment = classify(`mcp__jarvis__${tool}`, input, { workingDir });

    // Show it in the feed and journal it, same as a live action.
    observeAction(tool, input, assessment.reason, assessment.tier);

    if (assessment.tier !== "high") continue;

    if (assessment.snapshot) {
      await capture(assessment.snapshot, assessment.reason).catch(() => null);
    }
    const approved = await confirmations.request(
      `That saved shortcut will ${assessment.reason}. Should I go ahead?`
    );
    if (!approved) {
      return {
        ok: false,
        summary: `Stopped — you didn't approve "${assessment.reason}". Nothing was run.`,
      };
    }
  }

  const report = await replay(wf, steps);
  return { ok: report.ok, summary: report.summary };
}
