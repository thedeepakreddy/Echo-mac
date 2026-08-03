import { sendToOverlay, toOverlaySpace } from "../overlay.js";
import { record as recordRemote } from "./remote.js";

/**
 * Turns tool calls into something worth watching.
 *
 * Every action Jarvis takes passes through one gate, so this is where the work
 * becomes visible: a line in the feed, a marker where a click is about to land,
 * brackets around the element being used, a sweep while the screen is read.
 *
 * The wording is written for a bystander, not a developer — "clicking Send",
 * not "mcp__jarvis__click_ui_element". Anyone glancing at the screen should be
 * able to follow what is happening.
 */

export type FeedKind = "" | "go" | "warn" | "stop";

export interface FeedEvent {
  line?: string;
  kind?: FeedKind;
  state?: string;
  strike?: { x: number; y: number };
  target?: { x: number; y: number; w: number; h: number };
  sweep?: boolean;
  clear?: boolean;
}

export function feed(event: FeedEvent) {
  try {
    // Coordinates arrive in the GLOBAL screen space; the overlay window draws
    // in its own, which starts at the top-left of the whole desktop — negative
    // coordinates when a monitor sits left of or above the primary.
    const placed: FeedEvent = { ...event };
    if (event.strike) placed.strike = toOverlaySpace(event.strike);
    if (event.target) {
      const p = toOverlaySpace(event.target);
      placed.target = { ...event.target, x: p.x, y: p.y };
    }
    sendToOverlay("feed", placed);
    // The same line goes to the phone, if anyone is watching from one. It is a
    // no-op when the remote is off, which is the normal case.
    if (event.line) recordRemote(event.line, event.kind ?? "");
  } catch {
    // The overlay is decoration; never let it interfere with the work.
  }
}

const shorten = (s: unknown, n = 46) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Human sentence for a tool about to run. Returns null for noise. */
export function describeAction(tool: string, input: Record<string, unknown>): FeedEvent | null {
  const a = input ?? {};
  switch (tool) {
    // ---- looking ----
    case "screenshot":
      return { line: "Looking at the screen", sweep: true };
    case "read_screen_text":
      return { line: "Reading the screen", sweep: true };
    case "list_ui_elements":
      return { line: "Mapping the controls on screen" };
    case "check_for_failures":
      return { line: "Scanning for errors", sweep: true };
    case "extract_table":
      return { line: "Extracting the table", kind: "go", sweep: true };

    // ---- pointing ----
    case "click": {
      const x = Number(a.x), y = Number(a.y);
      return {
        line: `Clicking at ${Math.round(x)}, ${Math.round(y)}`,
        strike: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined,
      };
    }
    case "click_ui_element":
      return { line: `Clicking “${shorten(a.description)}”`, kind: "go" };
    case "click_text":
      return { line: `Clicking “${shorten(a.text)}”`, kind: "go" };
    case "move_mouse": {
      const x = Number(a.x), y = Number(a.y);
      return { line: `Moving to ${Math.round(x)}, ${Math.round(y)}`, strike: { x, y } };
    }
    case "drag":
      return { line: "Dragging" };
    case "scroll":
      return { line: `Scrolling ${a.direction ?? "down"}` };

    // ---- typing ----
    case "type_text":
      return { line: `Typing “${shorten(a.text, 38)}”` };
    case "set_value":
      return { line: `Setting field to “${shorten(a.value, 24)}”` };
    case "press_keys": {
      const mods = Array.isArray(a.modifiers) ? (a.modifiers as string[]) : [];
      return { line: `Pressing ${[...mods, a.key].filter(Boolean).join("+")}` };
    }

    // ---- apps and the wider machine ----
    case "open_app":
      return { line: `Opening ${shorten(a.name ?? a.app, 28)}`, kind: "go" };
    case "open_url":
      return { line: `Opening ${shorten(a.url, 40)}`, kind: "go" };
    case "dismiss_popups":
      return { line: "Clearing what's in the way", kind: "warn" };
    case "run_shortcut":
      return { line: `Running shortcut “${shorten(a.name, 28)}”`, kind: "go" };

    // ---- code ----
    case "Bash":
    case "run_terminal_command":
      return { line: `Running: ${shorten(a.command, 44)}`, kind: "warn" };
    case "Read":
      return { line: `Reading ${shorten(String(a.file_path ?? "").split("/").pop(), 30)}` };
    case "Write":
    case "write_local_file":
      return { line: `Writing ${shorten(String(a.file_path ?? a.path ?? "").split("/").pop(), 30)}`, kind: "warn" };
    case "Edit":
      return { line: `Editing ${shorten(String(a.file_path ?? "").split("/").pop(), 30)}`, kind: "warn" };
    case "Grep":
    case "Glob":
      return { line: `Searching for ${shorten(a.pattern ?? a.query, 30)}` };

    // ---- memory and time ----
    case "remember":
      return { line: `Remembering: ${shorten(a.text, 38)}` };
    case "recall":
    case "search_my_past":
      return { line: `Searching memory for “${shorten(a.query, 30)}”` };
    case "undo_recent":
    case "undo_last":
      return { line: "Undoing recent changes", kind: "warn" };

    // ---- outward facing ----
    case "send_sms_message":
      return { line: `Sending a message to ${shorten(a.recipient, 24)}`, kind: "stop" };
    case "run_workflow":
      return { line: `Running workflow “${shorten(a.name, 28)}”`, kind: "go" };
    case "lock_screen":
      return { line: "Locking the screen", kind: "stop" };

    default:
      // Anything unlisted still shows, so nothing happens invisibly.
      return { line: tool.replace(/_/g, " ") };
  }
}

/** Announce a tool that is about to run. */
export function narrateAction(tool: string, input: Record<string, unknown>, tier?: string) {
  const event = describeAction(tool, input);
  if (!event) return;
  // A high-risk action is about to ask for permission — colour it so the
  // pause has a visible cause rather than seeming like a hang.
  if (tier === "high") event.kind = "stop";
  feed(event);
}

export function narrateState(state: string) {
  feed({ state });
}

export function narrateSaid(text: string) {
  feed({ line: `“${shorten(text, 60)}”`, kind: "" });
}
