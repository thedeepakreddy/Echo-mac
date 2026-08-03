import * as ax from "../tools/ax.js";
import * as vision from "../tools/vision.js";
import * as act from "../tools/computer-actions.js";

/**
 * Clears the interruptions that get in the way mid-task.
 *
 * Storage warnings, update prompts, cookie banners and "try our new thing"
 * overlays all sit on top of the thing Jarvis was asked to do. Without a way to
 * clear them it clicks the banner instead of the button underneath.
 *
 * The hard part is restraint, not detection. A dialog's buttons are the most
 * dangerous things on screen — "OK" on "Delete these 400 files?" is a disaster,
 * and "Continue" can mean anything. So only unambiguously dismissive wording is
 * ever clicked, and anything else is described back to the user instead.
 */

/** Wording that can only mean "go away". Safe to click unseen. */
const DISMISSIVE = [
  "not now", "no thanks", "no thank you", "maybe later", "later", "skip",
  "dismiss", "close", "got it", "no, thanks", "remind me later", "ask me later",
  "not right now", "decline", "reject all", "only necessary", "continue without",
  "keep browsing", "stay on free", "no thanks, continue", "×", "✕", "✖",
];

/**
 * Words that LOOK dismissive but decide something. Never clicked automatically
 * — "OK" and "Allow" have destroyed more data than any error message.
 */
const AMBIGUOUS = [
  "ok", "okay", "yes", "allow", "continue", "accept", "agree", "confirm",
  "delete", "remove", "send", "buy", "upgrade", "subscribe", "pay", "sign out",
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export interface DismissResult {
  dismissed: string[];
  /** Things that looked like a dialog but were left alone, with why. */
  skipped: string[];
  note: string;
}

function isDismissive(label: string): boolean {
  const l = norm(label);
  if (!l || l.length > 34) return false;
  if (AMBIGUOUS.some((a) => l === a)) return false;
  return DISMISSIVE.some((d) => l === d || l.startsWith(d));
}

/** A lone × or close glyph, which carries no words at all. */
function isCloseGlyph(label: string): boolean {
  return /^[\s]*[×✕✖x✗]\s*$/i.test(label);
}

/**
 * Clear whatever is in the way.
 * @param rounds a dismissal can reveal another underneath it
 */
export async function dismissPopups(rounds = 3): Promise<DismissResult> {
  const dismissed: string[] = [];
  const skipped: string[] = [];

  for (let round = 0; round < rounds; round++) {
    const before = dismissed.length;

    // Accessibility first: real button labels, and pressing through the API
    // avoids moving the mouse over whatever is underneath.
    const dump = await ax.dump();
    if (dump.axAvailable) {
      for (const el of dump.elements) {
        if (!["AXButton", "AXLink", "AXStaticText"].includes(el.role)) continue;
        const label = el.label || el.value;
        if (!isDismissive(label) && !isCloseGlyph(label)) {
          if (el.role === "AXButton" && AMBIGUOUS.includes(norm(label))) {
            skipped.push(`"${label}" — too ambiguous to click for you`);
          }
          continue;
        }
        const pressed = el.press ? await ax.press(dump.pid, el.path) : { ok: false };
        if (pressed.ok) {
          dismissed.push(label);
        } else {
          await act.click(el.x + Math.round(el.w / 2), el.y + Math.round(el.h / 2), "left");
          dismissed.push(label);
        }
        await new Promise((r) => setTimeout(r, 400));
        break; // re-read the screen; the layout has changed
      }
    }

    // Browsers expose no tree, so fall back to reading the words on screen.
    if (dismissed.length === before) {
      const ocr = await vision.ocr("accurate");
      if (!ocr.error) {
        const hit = ocr.lines.find(
          (l) => l.confidence >= 0.6 && (isDismissive(l.text) || isCloseGlyph(l.text))
        );
        if (hit) {
          await act.click(hit.cx, hit.cy, "left");
          dismissed.push(hit.text.trim());
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
      }
    }

    if (dismissed.length === before) break; // nothing left to clear
  }

  const note = dismissed.length
    ? `Cleared ${dismissed.length}: ${dismissed.map((d) => `"${d}"`).join(", ")}.`
    : skipped.length
      ? "Nothing safe to dismiss automatically."
      : "Nothing in the way.";

  return { dismissed, skipped, note };
}
