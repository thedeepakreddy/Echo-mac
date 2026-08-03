import * as ax from "../tools/ax.js";
import * as vision from "../tools/vision.js";
import * as act from "../tools/computer-actions.js";
import type { Step, Workflow } from "./demonstrate.js";
import { save } from "./demonstrate.js";

/**
 * Replays a learned workflow, re-finding each control instead of trusting
 * coordinates.
 *
 * Every macro tool eventually breaks the same way: the app moves a button and
 * the recorded position points at nothing. Here each click is resolved fresh
 * through three escalating strategies, and a step only fails after all of them
 * miss:
 *
 *   1. the accessibility tree, matched on the control's label
 *   2. on-screen text via OCR, for apps that expose no tree (Chrome, Brave)
 *   3. give up and say which step broke, rather than clicking something wrong
 *
 * Clicking the wrong thing is far worse than stopping, so a low-confidence
 * match is treated as a miss.
 */

export interface StepResult {
  step: Step;
  ok: boolean;
  how: "accessibility" | "screen-text" | "direct" | "failed" | "skipped" | "unverified";
  note: string;
  /** Where it resolved to, so a dry run can draw the target without clicking it. */
  at?: { x: number; y: number };
}

/**
 * Resolve a click target by meaning. Returns coordinates, or null.
 *
 * `activate` exists for dry runs. Resolution through the accessibility tree
 * normally PRESSES the control as the way of finding it, which is exactly what
 * a preview must not do — so when previewing, the same search runs but stops
 * short of pressing and reports the control's position instead.
 */
async function locate(
  target: string,
  activate = true
): Promise<{ x: number; y: number; how: StepResult["how"]; label: string } | null> {
  // 1. accessibility tree — exact labels, works even when covered
  const dump = await ax.dump();
  if (dump.axAvailable && dump.elements.length) {
    const ranked = ax.rank(dump.elements, target);
    if (ranked.length) {
      const el = ranked[0];
      // Activate through the API when possible; no mouse movement at all.
      if (el.press && activate) {
        const pressed = await ax.press(dump.pid, el.path);
        if (pressed.ok) {
          return { x: -1, y: -1, how: "accessibility", label: el.label || target };
        }
      }
      return {
        x: el.x + Math.round(el.w / 2),
        y: el.y + Math.round(el.h / 2),
        how: "accessibility",
        label: el.label || target,
      };
    }
  }

  // 2. on-screen text — the fallback for apps with no tree
  const ocr = await vision.ocr("accurate");
  if (!ocr.error) {
    const hit = vision.findText(ocr, target);
    if (hit) return { x: hit.cx, y: hit.cy, how: "screen-text", label: hit.text };
  }

  return null;
}

async function runStep(step: Step, dry = false, afterSkip = false): Promise<StepResult> {
  switch (step.kind) {
    case "open":
      // Opening an app is allowed even in a preview. It changes nothing you
      // would want to undo, and without it every later step would be resolved
      // against the wrong frontmost application — turning the whole preview
      // into a list of things it could not find.
      await act.openApp(step.app);
      return { step, ok: true, how: "direct", note: `opened ${step.app}` };

    case "wait":
      if (dry) return { step, ok: true, how: "skipped", note: `would wait ${step.seconds}s` };
      await new Promise((r) => setTimeout(r, step.seconds * 1000));
      return { step, ok: true, how: "direct", note: `waited ${step.seconds}s` };

    case "type":
      if (dry) {
        const preview = step.text.length > 40 ? step.text.slice(0, 40) + "…" : step.text;
        return { step, ok: true, how: "skipped", note: `would type "${preview}"` };
      }
      await act.typeText(step.text);
      return { step, ok: true, how: "direct", note: `typed ${step.text.length} chars` };

    case "keys": {
      const combo = [...step.modifiers, step.key].join("+");
      if (dry) return { step, ok: true, how: "skipped", note: `would press ${combo}` };
      await act.hotkey(step.modifiers, step.key);
      return { step, ok: true, how: "direct", note: `pressed ${combo}` };
    }

    case "click": {
      const found = await locate(step.target, !dry);
      if (!found) {
        // In a preview, earlier steps were deliberately not performed, so the
        // screen is not in the state this step expects. Calling that a failure
        // would be untrue — the step may be perfectly fine. Say what is
        // actually known instead.
        if (dry && afterSkip) {
          return {
            step,
            ok: true,
            how: "unverified",
            note: `couldn't check "${step.target}" — it appears after a step I didn't perform`,
          };
        }
        return {
          step,
          ok: false,
          how: "failed",
          note: `could not find "${step.target}" on screen`,
        };
      }
      const repaired = found.label.toLowerCase() !== step.target.toLowerCase();
      const named = repaired
        ? `"${found.label}" (recorded as "${step.target}")`
        : `"${found.label}"`;

      if (dry) {
        return {
          step,
          ok: true,
          how: found.how,
          note: `would click ${named}`,
          at: found.x >= 0 ? { x: found.x, y: found.y } : undefined,
        };
      }
      // x < 0 means it was activated through the accessibility API already.
      if (found.x >= 0) await act.click(found.x, found.y, "left");
      return { step, ok: true, how: found.how, note: `clicked ${named}` };
    }
  }
}

export interface ReplayReport {
  ok: boolean;
  results: StepResult[];
  repairs: number;
  summary: string;
}

export async function replay(
  wf: Workflow,
  steps: Step[],
  opts: { dryRun?: boolean; onStep?: (r: StepResult, i: number) => void } = {}
): Promise<ReplayReport> {
  const dry = opts.dryRun === true;
  const results: StepResult[] = [];
  let repairs = 0;
  // Once a preview has declined to perform something, the screen no longer
  // matches what later steps expect.
  let skippedSomething = false;

  for (const step of steps) {
    const r = await runStep(step, dry, skippedSomething);
    results.push(r);
    opts.onStep?.(r, results.length - 1);
    if (r.how === "skipped") skippedSomething = true;
    if (r.note.includes("recorded as")) repairs++;
    if (!r.ok) break; // stop at the first miss rather than compounding the error
    // Let the interface settle; replaying faster than the app redraws is the
    // most common cause of a step landing before its target exists.
    // A preview only needs long enough to be watched.
    await new Promise((res) => setTimeout(res, dry ? 500 : 350));
  }

  const failed = results.find((r) => !r.ok);

  // A preview is not a run: counting it would corrupt the workflow's success
  // record, which is what decides whether it is trusted.
  if (!dry) {
    wf.runs++;
    wf.repairs += repairs;
    try {
      save(wf);
    } catch {
      /* health stats are not worth failing a replay over */
    }
  }

  const summary = dry
    ? describeDryRun(results, repairs)
    : failed
      ? `Stopped at step ${results.length} — ${failed.note}. The first ${results.length - 1} step(s) completed.`
      : `Done — ${results.length} steps${repairs ? `, and I re-found ${repairs} control(s) that had moved` : ""}.`;

  return { ok: !failed, results, repairs, summary };
}

/** Report what a preview found, without pretending it proved more than it did. */
export function describeDryRun(results: StepResult[], repairs: number): string {
  const failed = results.find((r) => !r.ok);
  const unverified = results.filter((r) => r.how === "unverified").length;

  const lines = results.map((r, i) => `  ${i + 1}. ${r.note}`).join("\n");
  const parts = [`Dry run — nothing was changed.\n${lines}`];

  if (failed) {
    parts.push(`\nThis would stop at step ${results.length}: ${failed.note}`);
  } else if (unverified) {
    parts.push(
      `\nI resolved every step I could. ${unverified} could not be checked because they only appear after a step I deliberately didn't perform.`
    );
  } else {
    parts.push(`\nEvery step resolved to a real control.`);
  }
  if (repairs) {
    parts.push(`${repairs} control(s) have moved since this was recorded — I'd re-find them.`);
  }
  return parts.join("\n");
}
