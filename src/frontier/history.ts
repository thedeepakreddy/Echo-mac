import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Where the record of your screen lives, and how long it stays.
 *
 * This was one growing file. At the measured rate — about 4.8 MB a day — a
 * three month history is roughly 430 MB, and the search path read and parsed
 * the WHOLE file on every question. That is fine at 4 MB and unusable at 430:
 * every "what was I looking at earlier?" would stall for seconds.
 *
 * So the log is split into one file per day. Three things follow from that:
 *
 *   - Deleting old history is unlinking files, not rewriting a huge one. There
 *     is no window where a crash could truncate the log.
 *   - A search for "an hour ago" opens one file instead of ninety.
 *   - A corrupt file costs you that day, not the entire history.
 *
 * Days are LOCAL days. You think of "yesterday" in the timezone you were
 * sitting in, not in UTC, and a UTC boundary would cut the evening off the day
 * it belonged to.
 */

/** How much history to keep. Three months, as whole days. */
export const RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

export interface HistoryRow {
  timestamp: number;
  text: string;
}

/** Directory holding the per-day files. */
export function historyDir(root: string): string {
  return join(root, "rewind");
}

/** The local calendar day a timestamp falls in, as YYYY-MM-DD. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local midnight that starts the given day. */
export function dayStart(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  // Constructing from parts (not Date.parse) keeps this in local time —
  // `new Date("2026-07-21")` would be parsed as UTC and land on the wrong day
  // for anyone west of Greenwich.
  return new Date(y, m - 1, d).getTime();
}

/** Last millisecond of the given day. */
export function dayEnd(key: string): number {
  return dayStart(key) + DAY_MS - 1;
}

const SHARD = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Digit-shaped is not the same as real.
 *
 * `2026-13-99` matches the pattern, and JavaScript will happily roll it over
 * into April 2027 rather than reject it — so a junk file would claim a time
 * range in the future and never fall outside the retention window. Requiring
 * the date to round-trip back to its own name rejects anything that rolled.
 */
function isRealDay(key: string): boolean {
  return dayKey(dayStart(key)) === key;
}

/** Every day we hold history for, oldest first. */
export function listDays(root: string): string[] {
  const dir = historyDir(root);
  if (!existsSync(dir)) return [];
  const days: string[] = [];
  for (const name of readdirSync(dir)) {
    const m = SHARD.exec(name);
    if (m && isRealDay(m[1])) days.push(m[1]);
  }
  // YYYY-MM-DD sorts correctly as text, which is the reason for that format.
  return days.sort();
}

function shardPath(root: string, key: string): string {
  return join(historyDir(root), `${key}.jsonl`);
}

/** Record one observation. */
export function append(root: string, row: HistoryRow): void {
  const dir = historyDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(shardPath(root, dayKey(row.timestamp)), JSON.stringify(row) + "\n", "utf8");
}

function parseFile(path: string): HistoryRow[] {
  if (!existsSync(path)) return [];
  const rows: HistoryRow[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return rows; // an unreadable day must not fail the whole search
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (typeof r?.text === "string" && typeof r?.timestamp === "number") {
        rows.push({ timestamp: r.timestamp, text: r.text });
      }
    } catch {
      /* one bad line should not lose the rest of the day */
    }
  }
  return rows;
}

/**
 * Load the rows overlapping a time window.
 *
 * The point of the whole layout: a day whose range cannot intersect the window
 * is skipped by its FILENAME, without opening it. Asking about the last hour
 * touches one file however much history has accumulated.
 */
export function loadRange(root: string, since = 0, until = Infinity): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const key of listDays(root)) {
    if (dayEnd(key) < since || dayStart(key) > until) continue;
    for (const r of parseFile(shardPath(root, key))) {
      if (r.timestamp >= since && r.timestamp <= until) rows.push(r);
    }
  }
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

/** Everything still retained. Prefer loadRange when a window is known. */
export function loadAll(root: string): HistoryRow[] {
  return loadRange(root);
}

/**
 * The most recent rows, oldest-first within the result.
 *
 * Walks days backwards and stops as soon as it has enough, so "what was I just
 * doing?" reads one file rather than three months of them. Several callers
 * wanted exactly this and each had reimplemented it by loading everything and
 * slicing the tail.
 */
export function loadRecent(root: string, count: number): HistoryRow[] {
  if (count <= 0) return [];
  const days = listDays(root);
  const out: HistoryRow[] = [];
  for (let i = days.length - 1; i >= 0 && out.length < count; i--) {
    const rows = parseFile(shardPath(root, days[i]));
    rows.sort((a, b) => a.timestamp - b.timestamp);
    // Prepend: we are walking backwards but the result reads forwards.
    out.unshift(...rows.slice(Math.max(0, rows.length - (count - out.length))));
  }
  return out;
}

export interface PruneResult {
  removedDays: string[];
  freedBytes: number;
}

/**
 * Drop history older than the retention window.
 *
 * A day is only removed once ALL of it has fallen outside the window — the
 * check is against the day's last millisecond, so nothing still inside the
 * three months is ever deleted to make a filename comparison simpler. The cost
 * is that you keep up to one extra day, which is the right way to be wrong.
 */
export function prune(root: string, retentionDays = RETENTION_DAYS, now = Date.now()): PruneResult {
  const cutoff = now - retentionDays * DAY_MS;
  const removedDays: string[] = [];
  let freedBytes = 0;

  for (const key of listDays(root)) {
    if (dayEnd(key) >= cutoff) continue;
    const path = shardPath(root, key);
    try {
      freedBytes += statSync(path).size;
      rmSync(path);
      removedDays.push(key);
    } catch {
      /* a file we cannot remove is retried on the next sweep */
    }
  }
  return { removedDays, freedBytes };
}

/** Bytes currently held, and the span they cover. */
export function usage(root: string): { bytes: number; days: number; oldest: string | null } {
  const days = listDays(root);
  let bytes = 0;
  for (const key of days) {
    try {
      bytes += statSync(shardPath(root, key)).size;
    } catch {
      /* counted as zero */
    }
  }
  return { bytes, days: days.length, oldest: days[0] ?? null };
}

/**
 * Move a pre-existing single-file history into per-day files.
 *
 * Ordering matters for crash safety. The legacy file is RENAMED first, which is
 * atomic: after that instant the old path is gone and the work in progress is
 * parked under a name that says what it is. An interrupted run therefore leaves
 * the data safe under `.migrating` and resumes from it, rather than leaving a
 * half-split file that a later run would read as complete.
 *
 * Rows are deduplicated against whatever the target day already holds, so
 * resuming an interrupted migration cannot double up entries.
 */
export function migrateLegacy(root: string): { migrated: number; days: string[] } {
  const legacy = join(root, "rewind.jsonl");
  const parked = join(root, "rewind.jsonl.migrating");

  if (existsSync(legacy)) {
    try {
      renameSync(legacy, parked);
    } catch {
      return { migrated: 0, days: [] };
    }
  }
  if (!existsSync(parked)) return { migrated: 0, days: [] };

  const rows = parseFile(parked);
  if (!rows.length) {
    try {
      rmSync(parked);
    } catch {
      /* leaving an empty file behind is harmless */
    }
    return { migrated: 0, days: [] };
  }

  const byDay = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    const key = dayKey(r.timestamp);
    const list = byDay.get(key);
    if (list) list.push(r);
    else byDay.set(key, [r]);
  }

  const dir = historyDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let migrated = 0;
  for (const [key, dayRows] of byDay) {
    const path = shardPath(root, key);
    const seen = new Set(parseFile(path).map((r) => `${r.timestamp} ${r.text}`));
    let chunk = "";
    for (const r of dayRows) {
      const id = `${r.timestamp} ${r.text}`;
      if (seen.has(id)) continue;
      seen.add(id);
      chunk += JSON.stringify(r) + "\n";
      migrated++;
    }
    if (chunk) appendFileSync(path, chunk, "utf8");
  }

  try {
    rmSync(parked);
  } catch {
    /* the next run dedupes, so a surviving file costs nothing */
  }
  return { migrated, days: [...byDay.keys()].sort() };
}
