import { osascript } from "../tools/shell.js";
import { GLOBAL } from "./store.js";

/**
 * Works out what you are currently working on, so Jarvis loads the memories for
 * that project instead of starting cold.
 *
 * The signal is the frontmost app plus its window title. Editors and terminals
 * put the folder in the title ("index.ts — my-app", "my-app — -zsh"), which is
 * the most reliable cheap indicator of a project without indexing your disk.
 */
export interface WorkContext {
  app: string;
  title: string;
  project: string;
}

/** Titles that name a tool or state rather than a project. */
const NOISE = new Set([
  "zsh", "bash", "sh", "fish", "node", "npm", "vim", "nvim", "top", "htop",
  "edited", "untitled", "new tab", "new window", "home", "inbox", "login",
  "terminal", "finder", "safari", "chrome", "google chrome", "brave browser",
  "code", "visual studio code", "textedit", "mail", "messages", "system settings",
]);

/**
 * Does this segment look like a file rather than a project?
 *
 * Naively "ends in a dot-extension" is wrong: it throws away dotted project
 * names like "J.A.R.V.I.S". A filename has a stem and one trailing extension,
 * so require exactly one dot and a stem of more than a single character.
 */
const isFileName = (s: string) => {
  const parts = s.split(".");
  if (parts.length !== 2) return false; // "J.A.R.V.I.S" has many; "README" none
  const [stem, ext] = parts;
  return stem.length > 1 && /^[a-z0-9]{1,5}$/i.test(ext);
};

/**
 * Pick the project name out of a window title.
 *
 * Editors put the folder LAST ("file.ts — project"), terminals put it FIRST
 * ("project — -zsh"), so neither position alone works. Instead we drop the
 * segments that are clearly not projects — filenames, shell names, app names —
 * and take what survives, preferring the last since that is the editor case.
 */
export function deriveProject(app: string, title: string): string {
  if (!title?.trim()) return app || GLOBAL;

  const segments = title
    .split(/\s+[—–|:·]\s+|\s+[-]\s+/) // em/en dash, pipe, colon, spaced hyphen
    .map((s) => s.trim())
    .filter(Boolean)
    // Strip editor "modified" markers and leading bullets.
    .map((s) => s.replace(/^[●•*]\s*/, "").trim())
    .filter((s) => s.length > 1)
    .filter((s) => !isFileName(s))
    .filter((s) => !NOISE.has(s.toLowerCase()))
    // A bare shell invocation like "-zsh".
    .filter((s) => !/^-?(zsh|bash|fish|sh)$/i.test(s));

  if (!segments.length) return app || GLOBAL;

  // Prefer the last surviving segment (the editor convention); if it looks like
  // a path, use its final component.
  const pick = segments[segments.length - 1];
  const leaf = pick.split("/").filter(Boolean).pop() ?? pick;
  return leaf.replace(/^~\s*/, "").trim() || app || GLOBAL;
}

export async function currentContext(): Promise<WorkContext> {
  let app = "";
  let title = "";
  try {
    const out = await osascript(
      'tell application "System Events" to tell (first process whose frontmost is true) to return name & "|||" & (value of attribute "AXTitle" of front window)'
    );
    [app = "", title = ""] = out.split("|||").map((s) => s.trim());
  } catch {
    // Some apps have no window or refuse the query; the app name alone still
    // scopes memory usefully.
    try {
      app = await osascript(
        'tell application "System Events" to get name of first process whose frontmost is true'
      );
    } catch {
      /* fall through to global */
    }
  }
  return { app, title, project: deriveProject(app, title) };
}
