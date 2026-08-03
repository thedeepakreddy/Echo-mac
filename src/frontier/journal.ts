import { appendFileSync, existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../tools/shell.js";

/**
 * A reversible log of everything Jarvis did.
 *
 * File snapshots already made single edits recoverable. This widens that to the
 * session: every action records how to undo itself, so "undo the last ten
 * minutes" can walk backwards through all of them.
 *
 * The honesty rule matters more than the coverage. Actions with no true inverse
 * — a sent message, a launched app — are recorded as irreversible and reported
 * as such, because a rollback that silently skips things is worse than one that
 * admits its limits.
 */
export type ActionKind = "file" | "git" | "app" | "ui" | "external";

export interface JournalEntry {
  id: string;
  at: number;
  kind: ActionKind;
  /** Spoken description: "edited listener.ts". */
  what: string;
  /** How to reverse it, if it can be. */
  undo:
    | { type: "restore-file"; target: string; backup: string }
    | { type: "delete-file"; target: string }
    | { type: "git-checkout"; repo: string; object: string }
    | { type: "quit-app"; app: string }
    | { type: "none"; why: string };
}

const DIR = join(homedir(), ".jarvis", "journal");
const FILE = join(DIR, "actions.jsonl");
const BACKUPS = join(DIR, "files");

function ensure() {
  if (!existsSync(BACKUPS)) mkdirSync(BACKUPS, { recursive: true });
}

export function record(entry: Omit<JournalEntry, "id" | "at">): JournalEntry {
  ensure();
  const full: JournalEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    ...entry,
  };
  appendFileSync(FILE, JSON.stringify(full) + "\n");
  return full;
}

/** Copy a file aside before it is changed, and journal how to put it back. */
export function recordFileChange(target: string, what: string): JournalEntry {
  ensure();
  if (!existsSync(target)) {
    // Creating a file: the inverse is deleting it.
    return record({ kind: "file", what, undo: { type: "delete-file", target } });
  }
  const backup = join(BACKUPS, `${Date.now()}-${target.split("/").pop()}`);
  try {
    copyFileSync(target, backup);
    return record({ kind: "file", what, undo: { type: "restore-file", target, backup } });
  } catch (err: any) {
    return record({ kind: "file", what, undo: { type: "none", why: `could not back up: ${err?.message}` } });
  }
}

export function all(): JournalEntry[] {
  if (!existsSync(FILE)) return [];
  const out: JournalEntry[] = [];
  for (const line of readFileSync(FILE, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip a corrupt row */
    }
  }
  return out;
}

/** Entries from the last N minutes, newest first. */
export function since(minutes: number, now = Date.now()): JournalEntry[] {
  const cutoff = now - minutes * 60_000;
  return all()
    .filter((e) => e.at >= cutoff)
    .sort((a, b) => b.at - a.at);
}

async function reverse(e: JournalEntry): Promise<{ ok: boolean; note: string }> {
  const u = e.undo;
  switch (u.type) {
    case "restore-file":
      if (!existsSync(u.backup)) return { ok: false, note: `${e.what} — backup is gone` };
      try {
        copyFileSync(u.backup, u.target);
        return { ok: true, note: e.what };
      } catch (err: any) {
        return { ok: false, note: `${e.what} — ${err?.message}` };
      }
    case "delete-file":
      try {
        if (existsSync(u.target)) await run("/bin/rm", ["-f", u.target]);
        return { ok: true, note: e.what };
      } catch {
        return { ok: false, note: `${e.what} — could not remove` };
      }
    case "git-checkout": {
      const r = await run("/usr/bin/git", ["-C", u.repo, "checkout", u.object, "--", "."]);
      return r.code === 0
        ? { ok: true, note: e.what }
        : { ok: false, note: `${e.what} — git refused` };
    }
    case "quit-app": {
      await run("/usr/bin/osascript", ["-e", `tell application "${u.app}" to quit`]);
      return { ok: true, note: `closed ${u.app}` };
    }
    case "none":
      return { ok: false, note: `${e.what} — ${u.why}` };
  }
}

/**
 * Walk backwards through recent actions, undoing what can be undone.
 * Returns a sentence written to be read aloud.
 */
export async function undoWindow(minutes: number, now = Date.now()): Promise<string> {
  const entries = since(minutes, now);
  if (!entries.length) return `I haven't done anything in the last ${minutes} minutes.`;

  const undone: string[] = [];
  const failed: string[] = [];
  // Newest first: later changes must be reversed before earlier ones.
  for (const e of entries) {
    const r = await reverse(e);
    (r.ok ? undone : failed).push(r.note);
  }

  const parts: string[] = [];
  if (undone.length) {
    parts.push(`Undid ${undone.length} change${undone.length === 1 ? "" : "s"}: ${undone.slice(0, 4).join(", ")}${undone.length > 4 ? ", and more" : ""}.`);
  }
  if (failed.length) {
    parts.push(`${failed.length} couldn't be reversed: ${failed.slice(0, 3).join("; ")}.`);
  }
  return parts.join(" ") || "Nothing to undo.";
}

export function describeWindow(minutes: number, now = Date.now()): string {
  const entries = since(minutes, now);
  if (!entries.length) return `Nothing recorded in the last ${minutes} minutes.`;
  const reversible = entries.filter((e) => e.undo.type !== "none").length;
  const lines = entries
    .slice(0, 10)
    .map((e) => `- ${e.what}${e.undo.type === "none" ? " (cannot be undone)" : ""}`)
    .join("\n");
  return `${entries.length} action(s), ${reversible} reversible:\n${lines}`;
}
