import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { recordFileChange, record } from "./journal.js";
import { isRecording, noteStep } from "./demonstrate.js";
import { narrateAction } from "./narrate.js";

/**
 * The single place that watches what Jarvis does.
 *
 * Both the reversible session journal and learning-by-demonstration need to see
 * every action. Rather than sprinkling hooks through every tool handler — which
 * would rot the moment someone adds a tool and forgets — this listens at the one
 * gate all tool calls already pass through.
 */

function str(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input?.[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

export function observeAction(
  tool: string,
  input: Record<string, unknown>,
  reason: string,
  tier?: string
): void {
  try {
    // Show the work as it happens, before it happens.
    narrateAction(tool, input, tier);
    journalIt(tool, input, reason);
    if (isRecording()) recordStep(tool, input);
  } catch (err) {
    // Observation must never break the action it is watching.
    console.error("[jarvis] observe failed:", (err as any)?.message ?? err);
  }
}

function journalIt(tool: string, input: Record<string, unknown>, reason: string) {
  const home = homedir();

  if (tool === "Write" || tool === "Edit" || tool === "write_local_file") {
    const p = str(input, ["file_path", "path"]);
    if (p) recordFileChange(isAbsolute(p) ? p : resolve(home, p), reason);
    return;
  }

  if (tool === "open_app") {
    const app = str(input, ["name", "app"]);
    // Closing it again is a genuine inverse, so this one can be undone.
    if (app) record({ kind: "app", what: `opened ${app}`, undo: { type: "quit-app", app } });
    return;
  }

  // Things that change the world but cannot be reversed are still recorded, so
  // an undo can say what it could not take back instead of pretending.
  const IRREVERSIBLE: Record<string, string> = {
    send_sms_message: "a sent message cannot be unsent",
    handoff_to_ios: "already delivered to your phone",
    run_terminal_command: "shell commands have no general inverse",
    Bash: "shell commands have no general inverse",
    click: "a click cannot be un-clicked",
    click_ui_element: "a click cannot be un-clicked",
    click_text: "a click cannot be un-clicked",
    type_text: "typing cannot be un-typed",
    press_keys: "a keypress cannot be un-pressed",
  };
  if (tool in IRREVERSIBLE) {
    record({ kind: tool.startsWith("send") ? "external" : "ui", what: reason, undo: { type: "none", why: IRREVERSIBLE[tool] } });
  }
}

/** Translate a tool call into a replayable step, by meaning rather than position. */
function recordStep(tool: string, input: Record<string, unknown>) {
  switch (tool) {
    case "open_app": {
      const app = str(input, ["name", "app"]);
      if (app) noteStep({ kind: "open", app });
      return;
    }
    case "type_text": {
      const text = str(input, ["text"]);
      if (text) noteStep({ kind: "type", text });
      return;
    }
    case "press_keys": {
      const key = str(input, ["key"]);
      const mods = Array.isArray(input?.modifiers) ? (input.modifiers as string[]) : [];
      if (key) noteStep({ kind: "keys", modifiers: mods, key });
      return;
    }
    case "click_ui_element": {
      const target = str(input, ["description"]);
      if (target) noteStep({ kind: "click", target });
      return;
    }
    case "click_text": {
      const target = str(input, ["text"]);
      if (target) noteStep({ kind: "click", target });
      return;
    }
    case "wait": {
      const secs = typeof input?.seconds === "number" ? input.seconds : 1;
      noteStep({ kind: "wait", seconds: secs });
      return;
    }
    // A bare coordinate click is deliberately NOT recorded: replaying a raw
    // position is exactly the brittleness this design exists to avoid. The
    // click is journalled, it just cannot become a durable workflow step.
    default:
      return;
  }
}
