import { classify, bareToolName, type RiskAssessment } from "./risk.js";
import { capture } from "./snapshot.js";
import { confirmations } from "./confirm.js";
import { observeAction } from "../frontier/observe.js";
import { recordStep, captureGroundingFrame } from "../learn/trajectory.js";
import type { ToolDef, ToolOutput } from "../tools/registry.js";

/**
 * The one gate every tool call goes through.
 *
 * This exists because relying on each brain to remember was not good enough,
 * and a live test proved it. Three brains had three different answers:
 *
 *   - Ollama classified and confirmed correctly.
 *   - Claude delegated to the SDK's `canUseTool`, which is NOT invoked for
 *     in-process MCP tools — so Jarvis's OWN `run_terminal_command` reached the
 *     shell without ever being classified. `rm` on a real file went through
 *     with no confirmation asked.
 *   - Gemini had no risk check of any kind.
 *
 * The classification was right the whole time; it simply was not being called.
 * That is the failure mode a shared choke point prevents: putting the check
 * inside the tool handler means a brain cannot forget it, because there is no
 * path to the handler that goes around it.
 *
 * `canUseTool` is still wired up in the Claude brain — it is the only thing
 * that sees the SDK's own built-in tools (Bash, Write, Edit) — so the two
 * layers overlap deliberately. The dedupe below stops that overlap becoming
 * two confirmation prompts for one action.
 */

export interface GateContext {
  workingDir: string;
  /** Lets a brain surface risk and tool events in its own shape. */
  emit?: (event: string, payload: any) => void;
}

export interface GateDecision {
  allowed: boolean;
  assessment: RiskAssessment;
  /** What to tell the model when refused. */
  message?: string;
}

/** How long an identical decision is reused, so two layers do not both ask. */
const DEDUPE_MS = 15_000;

const recent = new Map<string, { at: number; allowed: boolean }>();

function keyOf(tool: string, input: unknown): string {
  let shape = "";
  try {
    shape = JSON.stringify(input ?? {});
  } catch {
    shape = String(input);
  }
  return `${bareToolName(tool)}:${shape}`;
}

function rememberedDecision(key: string, now: number): boolean | null {
  const hit = recent.get(key);
  if (!hit) return null;
  if (now - hit.at > DEDUPE_MS) {
    recent.delete(key);
    return null;
  }
  return hit.allowed;
}

/** Forget cached decisions. Used by tests, and whenever a turn ends. */
export function resetGateMemory(): void {
  recent.clear();
}

export const DENIAL_MESSAGE =
  "The user did not approve this action. Do not retry it. Explain what you were going to do and ask how they would like to proceed instead.";

/**
 * Classify an action, take a snapshot, and ask if it is dangerous.
 *
 * Does not execute anything — callers that already have a handler should use
 * runGated below. This is separated so the Claude brain's `canUseTool` can
 * share exactly the same decision.
 */
export async function decide(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GateContext,
  now = Date.now()
): Promise<GateDecision> {
  const assessment = classify(toolName, input, { workingDir: ctx.workingDir });
  const bare = bareToolName(toolName);
  const key = keyOf(toolName, input);

  // If this exact call was just decided, reuse it rather than asking twice.
  const already = rememberedDecision(key, now);
  if (already !== null) {
    return {
      allowed: already,
      assessment,
      message: already ? undefined : DENIAL_MESSAGE,
    };
  }

  ctx.emit?.("risk", { tool: bare, ...assessment });

  // Every tool call funnels through here, which makes this the one place that
  // can see the whole session. Two features hang off that: the reversible
  // journal behind "undo the last ten minutes", and the step recorder behind
  // learning a workflow by demonstration.
  try {
    observeAction(bare, input, assessment.reason, assessment.tier);
  } catch {
    /* observation must never block the action or the refusal */
  }

  if (assessment.tier !== "high") {
    // Snapshot ordinary edits too — cheap, and it makes "undo that" work for
    // the routine changes people actually want to take back.
    if (assessment.snapshot) {
      await capture(assessment.snapshot, assessment.reason).catch(() => null);
    }
    recent.set(key, { at: now, allowed: true });
    return { allowed: true, assessment };
  }

  // High risk: capture state first, so approving is recoverable.
  const snap = assessment.snapshot
    ? await capture(assessment.snapshot, assessment.reason).catch(() => null)
    : null;

  const undoable = snap ? " I've taken a snapshot first." : "";
  const approved = await confirmations.request(
    `I'm about to ${assessment.reason}.${undoable} Should I go ahead?`
  );

  recent.set(key, { at: now, allowed: approved });
  return {
    allowed: approved,
    assessment,
    message: approved ? undefined : DENIAL_MESSAGE,
  };
}

/**
 * Gate a tool and then run it.
 *
 * The refusal is returned as ordinary tool output rather than thrown: the model
 * needs to read what happened and respond to the user, and an exception would
 * end the turn with nothing said.
 */
export async function runGated(
  def: ToolDef,
  args: Record<string, unknown>,
  ctx: GateContext
): Promise<ToolOutput> {
  ctx.emit?.("tool", { name: def.name, summary: bareToolName(def.name) });

  const decision = await decide(def.name, args ?? {}, ctx);
  const bare = bareToolName(def.name);

  // Capture the call as training data. This is the same argument as the gate
  // itself: put it on the one path to the handler and no brain can omit it.
  // Every call is wrapped so a logging fault can never break a real action.
  const learn = (resultText: string, image: ToolOutput["image"] | null) => {
    try {
      recordStep({
        tool: bare,
        args: args ?? {},
        tier: decision.assessment.tier,
        reason: decision.assessment.reason,
        allowed: decision.allowed,
        resultText,
        image: image ? { data: image.data, mimeType: image.mimeType } : null,
      });
    } catch {
      /* never let the recorder disturb the action it is watching */
    }
  };

  if (!decision.allowed) {
    const refused = decision.message ?? DENIAL_MESSAGE;
    // A refusal is worth keeping: it is a labelled example of what NOT to do.
    learn(refused, null);
    return { text: refused };
  }
  try {
    // For a pointer action, grab the screen it is aimed at BEFORE it fires —
    // this is what turns a click into a grounding example. No-op unless learning
    // is on, and best-effort, so it can never delay or break the action.
    await captureGroundingFrame(bare);
    const out = await def.handler(args ?? {});
    learn(out.text ?? "", out.image ?? null);
    return out;
  } catch (err: any) {
    const failed = { text: `${def.name} failed: ${err?.message ?? err}` };
    learn(failed.text, null);
    return failed;
  }
}
