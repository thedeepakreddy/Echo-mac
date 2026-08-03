import { TOOLS } from "../tools/registry.js";

/**
 * Helps a small local model actually call tools.
 *
 * A 3B model behaves quite differently from a hosted one, in two ways that both
 * break tool use outright:
 *
 *   1. It writes the call as ordinary text — `{"name":"do_thing",...}` in the
 *      message body — instead of filling the structured tool_calls field. The
 *      caller sees no tool call at all and the request silently does nothing.
 *   2. Given 73 tool definitions (~22KB every turn) it cannot find the right
 *      name and invents a plausible one. Observed: asked to turn on hand
 *      gestures, it produced "update_hand_gesture_params", which exists
 *      nowhere.
 *
 * Both are recoverable without changing the model: read the call out of the
 * text, and map the invented name onto the real one.
 */

export interface ParsedCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Pull tool calls out of a plain-text reply.
 *
 * Small models emit several shapes — a bare object, one wrapped in a fenced
 * code block, sometimes several in a row — so this scans for JSON objects and
 * keeps the ones that look like a call.
 */
export function parseCallsFromText(text: string): ParsedCall[] {
  if (!text?.trim()) return [];
  const found: ParsedCall[] = [];

  // Scan for balanced {...} runs; a regex cannot match nested braces reliably.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") {
        depth--;
        if (depth === 0) {
          const slice = text.slice(i, j + 1);
          try {
            const obj = JSON.parse(slice);
            const call = asCall(obj);
            if (call) found.push(call);
          } catch {
            /* not JSON; keep scanning */
          }
          i = j; // continue after this object
          break;
        }
      }
    }
  }
  return found;
}

/** Recognise the several shapes a model might use for "call this tool". */
function asCall(obj: any): ParsedCall | null {
  if (!obj || typeof obj !== "object") return null;

  // {"name": "...", "parameters"|"arguments": {...}}
  const name =
    obj.name ??
    obj.tool ??
    obj.tool_name ??
    obj.function?.name ??
    (typeof obj.function === "string" ? obj.function : undefined);
  if (typeof name !== "string" || !name) return null;

  const args =
    obj.parameters ?? obj.arguments ?? obj.args ?? obj.input ?? obj.function?.arguments ?? {};

  return {
    name,
    args: typeof args === "string" ? safeJson(args) : (args ?? {}),
  };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// ---- resolving an invented name to a real one ----------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();

/**
 * Reduce a word to its stem so singular and plural match.
 *
 * This is what made the real failure miss: the model said "gesture", the tool
 * is called "gestures", the words did not compare equal, and the score fell
 * below the threshold — so the one case this exists to handle was rejected.
 */
const stem = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);

const wordsOf = (s: string) =>
  new Set(norm(s).split(" ").filter(Boolean).map(stem));

/**
 * Map whatever the model called it onto a tool that exists.
 *
 * Matching on shared words rather than string distance: "update hand gesture
 * params" and "toggle hand gestures" share "hand" and "gesture", which is the
 * real signal, while their spellings are far apart.
 */
export function resolveToolName(called: string): string | null {
  if (!called) return null;

  const exact = TOOLS.find((t) => t.name === called);
  if (exact) return exact.name;

  const ci = TOOLS.find((t) => t.name.toLowerCase() === called.toLowerCase());
  if (ci) return ci.name;

  const want = wordsOf(called);
  if (!want.size) return null;

  // Words that appear in half the tool names carry no signal.
  const NOISE = new Set(["get", "set", "the", "a", "to", "on", "off", "param", "value", "update", "my", "enable", "disable"]);
  const meaningful = new Set([...want].filter((w) => !NOISE.has(w) && !NOISE.has(stem(w))));
  if (!meaningful.size) return null;

  let best: { name: string; score: number } | null = null;
  for (const t of TOOLS) {
    const have = wordsOf(t.name);
    let shared = 0;
    for (const w of meaningful) if (have.has(w)) shared++;
    if (!shared) continue;
    // Favour a tool whose own name is mostly covered, so "toggle_hand_gestures"
    // beats a longer tool that happens to share one word.
    const score = shared / Math.max(meaningful.size, have.size);
    if (!best || score > best.score) best = { name: t.name, score };
  }

  // Require real overlap; a single incidental word is not a match.
  return best && best.score >= 0.4 ? best.name : null;
}

/**
 * The tools worth offering a small local model.
 *
 * Sending all 73 is what makes it invent names — the list alone is ~22KB and
 * crowds out the conversation. These are the ones that matter for spoken
 * commands, and they leave the model a short enough list to choose from.
 */
const LOCAL_TOOL_NAMES = [
  // seeing
  "screenshot", "read_screen_text", "list_ui_elements", "frontmost_app",
  // pointing and typing
  "click", "click_ui_element", "click_text", "type_text", "press_keys", "scroll",
  // apps
  "open_app", "open_url", "run_shortcut", "list_shortcuts", "show_creator_page",
  // the switches people ask for by voice
  "toggle_hand_gestures", "toggle_eye_tracking", "away_mode", "presence_status",
  "pause_media", "lock_screen", "switch_brain",
  // controlling the Mac from a phone
  "set_remote_password", "open_phone_remote", "close_phone_remote", "phone_remote_status",
  // memory
  "remember", "recall", "search_my_past",
  // scan a page and recall it later
  "scan_page", "save_last_scan", "recall_scan",
  // essentials
  "wait", "check_calendar", "undo_last",
];

export function toolsForLocalModel(all: any[]): any[] {
  const wanted = new Set(LOCAL_TOOL_NAMES);
  const picked = all.filter((t) => wanted.has(t.function?.name ?? t.name));
  // If the names ever drift, fall back to everything rather than no tools.
  return picked.length >= 10 ? picked : all;
}
