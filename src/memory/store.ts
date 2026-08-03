import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Persistent memory: what Jarvis knows across restarts.
 *
 * Plain JSONL in ~/.jarvis/memory so it stays outside your repos, survives a
 * reinstall, and can be read or deleted by hand — this is a long-lived record of
 * your work, so it must never be an opaque blob. It records what you SAID and
 * what Jarvis DID; screen contents are deliberately never stored.
 *
 * Append-only with tombstones. Reads are synchronous because the file is small
 * and local, and the brain needs recalled context before its first turn.
 */
export type MemoryType = "preference" | "project" | "decision" | "episode";

export interface MemoryRecord {
  id: string;
  at: string; // ISO timestamp
  type: MemoryType;
  /** Project key this belongs to; "global" for things true everywhere. */
  project: string;
  text: string;
}

/** Written when something is forgotten, so the log stays append-only. */
interface Tombstone {
  id: string;
  forget: string;
}

type Line = MemoryRecord | Tombstone;

const DIR = join(homedir(), ".jarvis", "memory");
const FILE = join(DIR, "memories.jsonl");

export const GLOBAL = "global";

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

function parseLines(): Line[] {
  if (!existsSync(FILE)) return [];
  const out: Line[] = [];
  for (const line of readFileSync(FILE, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip a corrupt line rather than losing the whole file */
    }
  }
  return out;
}

/** All live memories, newest last. Tombstoned records are removed. */
export function all(): MemoryRecord[] {
  const lines = parseLines();
  const forgotten = new Set(
    lines.filter((l): l is Tombstone => "forget" in l).map((l) => l.forget)
  );
  return lines
    .filter((l): l is MemoryRecord => !("forget" in l) && !forgotten.has(l.id))
    .filter((r) => r.text?.trim());
}

export function remember(
  text: string,
  type: MemoryType = "episode",
  project: string = GLOBAL
): MemoryRecord {
  ensureDir();
  const rec: MemoryRecord = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    type,
    project: project || GLOBAL,
    text: text.trim(),
  };
  appendFileSync(FILE, JSON.stringify(rec) + "\n");
  return rec;
}

/** Forget by id, or every memory whose text matches a query. Returns the count. */
export function forget(opts: { id?: string; query?: string }): number {
  const live = all();
  const targets = opts.id
    ? live.filter((r) => r.id === opts.id)
    : opts.query
      ? search(opts.query, { limit: 50 })
      : [];
  if (!targets.length) return 0;

  ensureDir();
  const stamp = new Date().toISOString();
  appendFileSync(
    FILE,
    targets.map((t) => JSON.stringify({ id: `t-${stamp}`, forget: t.id })).join("\n") + "\n"
  );
  return targets.length;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["the", "a", "an", "is", "are", "was", "my", "me", "i", "to", "of", "on", "in", "for", "and", "that", "what", "do", "did"]);

/** Word-overlap search — enough for a few thousand short records, no index needed. */
export function search(
  query: string,
  opts: { project?: string; limit?: number } = {}
): MemoryRecord[] {
  const words = norm(query).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
  const pool = opts.project ? all().filter((r) => r.project === opts.project || r.project === GLOBAL) : all();
  if (!words.length) return pool.slice(-(opts.limit ?? 10)).reverse();

  return pool
    .map((r) => {
      const hay = norm(`${r.text} ${r.project}`);
      let score = 0;
      for (const w of words) if (hay.includes(w)) score += hay.split(" ").includes(w) ? 3 : 1;
      // Preferences are usually the most useful thing to surface.
      if (score > 0 && r.type === "preference") score += 2;
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.r.at.localeCompare(a.r.at))
    .slice(0, opts.limit ?? 10)
    .map((x) => x.r);
}

/** Rewrite the file without tombstoned records. Safe to call at startup. */
export function compact(): void {
  if (!existsSync(FILE)) return;
  const live = all();
  ensureDir();
  writeFileSync(FILE, live.map((r) => JSON.stringify(r)).join("\n") + (live.length ? "\n" : ""));
}

export function stats(): { count: number; projects: string[]; file: string } {
  const live = all();
  return {
    count: live.length,
    projects: [...new Set(live.map((r) => r.project))],
    file: FILE,
  };
}

export const memoryFile = FILE;
