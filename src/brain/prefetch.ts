import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Anticipating the next command — safely.
 *
 * The old version spawned a global keylogger and read EVERY keystroke on the
 * machine to guess what you were about to type. That is the single biggest
 * liability in the app: it captures passwords, and it makes the app un-shippable
 * (notarization and antivirus both balk at a system-wide key tap). It is gone.
 *
 * This does the same job from a safe signal: the commands you have actually
 * given ECHO. From your own history it learns which commands you repeat, and
 * which command tends to follow which — so it can complete a half-typed command
 * or pre-warm for the likely next one. Nothing outside Echo is ever observed,
 * and no keystrokes are captured.
 */

export interface PrefetchModel {
  /** How often each full command has been used. */
  counts: Record<string, number>;
  /** For a given command, how often each command followed it. */
  next: Record<string, Record<string, number>>;
  /** The most recent command, to attribute the next transition. */
  last: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function emptyModel(): PrefetchModel {
  return { counts: {}, next: {}, last: null };
}

/**
 * Fold one command the user gave into the model. Order matters: a command is
 * counted, then linked as the successor of whatever came before it.
 */
export function observeCommand(model: PrefetchModel, raw: string): void {
  const cmd = norm(raw);
  if (!cmd) return;
  model.counts[cmd] = (model.counts[cmd] ?? 0) + 1;
  if (model.last && model.last !== cmd) {
    (model.next[model.last] ??= {})[cmd] = (model.next[model.last]?.[cmd] ?? 0) + 1;
  }
  model.last = cmd;
}

/**
 * Complete a half-typed command from history — the "you started typing X" case.
 * Ranked by how often each candidate has been used. An empty prefix returns
 * nothing (we don't guess from a blank).
 */
export function complete(model: PrefetchModel, prefix: string, limit = 3): string[] {
  const p = norm(prefix);
  if (!p) return [];
  return Object.entries(model.counts)
    .filter(([cmd]) => cmd.startsWith(p) && cmd !== p)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cmd]) => cmd);
}

/**
 * Predict the likely NEXT command after a given one, from what has historically
 * followed it. Used to pre-warm (e.g. take a screenshot ahead of "what's on my
 * screen"). A prediction is only a hint — acting still requires the user to
 * actually ask; nothing here runs a command on its own.
 */
export function predictNext(model: PrefetchModel, afterCmd: string, limit = 3): string[] {
  const after = norm(afterCmd);
  const followers = model.next[after];
  if (!followers) return [];
  return Object.entries(followers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cmd]) => cmd);
}

// ---- persistence ----------------------------------------------------------

function modelPath(base?: string): string {
  return join(base ?? join(homedir(), ".jarvis"), "prefetch.json");
}

export function loadModel(base?: string): PrefetchModel {
  const path = modelPath(base);
  if (!existsSync(path)) return emptyModel();
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    return { counts: m.counts ?? {}, next: m.next ?? {}, last: m.last ?? null };
  } catch {
    return emptyModel();
  }
}

export function saveModel(model: PrefetchModel, base?: string): void {
  const path = modelPath(base);
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(model), { mode: 0o600 });
}

/**
 * The live engine: learns from each command the user gives Echo, and answers
 * predictions. A thin, safe replacement for the old keylogger daemon — it never
 * spawns a native process and never reads anything outside Echo.
 */
export class PreFetchEngine {
  private model: PrefetchModel = emptyModel();
  private base?: string;

  start(base?: string): void {
    this.base = base;
    this.model = loadModel(base);
  }

  /** Record a command the user actually gave Echo (typed or spoken). */
  learn(command: string): void {
    observeCommand(this.model, command);
    try {
      saveModel(this.model, this.base);
    } catch {
      /* a prediction model is disposable; never let saving it break a turn */
    }
  }

  complete(prefix: string): string[] {
    return complete(this.model, prefix);
  }
  predictNext(afterCmd: string): string[] {
    return predictNext(this.model, afterCmd);
  }
}

export const prefetch = new PreFetchEngine();
