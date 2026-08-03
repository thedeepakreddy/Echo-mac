import { getAppPath } from "../utils/appPath.js";
import { loadRange } from "./history.js";

/**
 * Searchable memory of your own screen.
 *
 * Rewind already writes what was on screen every 30 seconds. This turns that
 * log into something you can ask questions of — "what was that error an hour
 * ago?" — by combining three signals rather than one:
 *
 *   - word overlap, which is exact but brittle
 *   - character trigrams, which survive the OCR errors that remain
 *   - recency, because "an hour ago" is usually nearer than last week
 *
 * A vector search alone was tempting, but embedding every row on each query is
 * slow and the local model returns 0.00 similarity on short OCR fragments. This
 * is lexical, instant, and works offline.
 */

export interface Moment {
  timestamp: number;
  text: string;
  score: number;
  /** How long before now, phrased for speech: "about 2 hours ago". */
  when: string;
}

interface Row {
  timestamp: number;
  text: string;
}

const STOP = new Set([
  "the", "a", "an", "is", "was", "were", "are", "and", "or", "but", "of", "to",
  "in", "on", "at", "for", "with", "that", "this", "it", "i", "my", "me", "you",
  "what", "when", "where", "did", "do", "does", "about", "from", "any", "there",
  "show", "find", "see", "saw", "look", "looking", "tell", "again", "back",
]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

function words(s: string): string[] {
  return norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
}

/** Character trigrams — these still match when OCR drops or mangles a letter. */
function trigrams(s: string): Set<string> {
  const t = norm(s).replace(/\s+/g, " ");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

function load(since = 0): Row[] {
  return loadRange(getAppPath(), since);
}

/** Speech-friendly elapsed time. */
export function describeAge(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `about ${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `about ${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? "yesterday" : `about ${days} days ago`;
}

/**
 * Parse a spoken time window: "an hour ago", "this morning", "yesterday".
 * Returns the oldest timestamp worth considering, or null for no limit.
 */
export function parseWindow(query: string, now = Date.now()): number | null {
  const q = query.toLowerCase();
  const HOUR = 3600_000;

  // People speak quantities as words far more often than digits — "an hour
  // ago", not "1 hour ago". Matching only digits missed the most common phrasing
  // there is, so the search silently ignored the time window entirely.
  const WORD_NUMBERS: Record<string, number> = {
    a: 1, an: 1, one: 1, couple: 2, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10, few: 3, several: 4,
  };

  if (/\bhalf an hour\b|\bhalf hour\b/.test(q)) return now - HOUR;

  const num = /(\d+|[a-z]+)\s*(minutes?|mins?|hours?|hrs?|days?)\b/.exec(q);
  if (num) {
    const raw = num[1];
    const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : WORD_NUMBERS[raw];
    if (n) {
      const unit = num[2];
      const span = unit.startsWith("min") ? n * 60_000 : unit.startsWith("h") ? n * HOUR : n * 24 * HOUR;
      // Look back twice as far as stated — people round these generously.
      return now - span * 2;
    }
  }
  if (/\byesterday\b/.test(q)) return now - 48 * HOUR;
  if (/\bthis morning\b/.test(q)) return now - 12 * HOUR;
  if (/\btoday\b/.test(q)) return now - 24 * HOUR;
  if (/\bjust now\b|\bmoment ago\b/.test(q)) return now - 15 * 60_000;
  if (/\blast week\b/.test(q)) return now - 14 * 24 * HOUR;
  return null;
}

export function search(query: string, limit = 5, now = Date.now()): Moment[] {
  if (!query?.trim()) return [];
  // Work out the time window BEFORE reading anything. History is stored one
  // file per day, so a bounded question ("an hour ago") opens a single file
  // instead of every day being retained — which is the difference between an
  // instant answer and parsing hundreds of megabytes.
  const since = parseWindow(query, now);
  const pool = load(since ?? 0);
  if (!pool.length) return [];

  const qWords = words(query);
  const qTri = trigrams(query);
  if (!qWords.length && qTri.size === 0) return [];

  const newest = Math.max(...pool.map((r) => r.timestamp));
  const oldest = Math.min(...pool.map((r) => r.timestamp));
  const span = Math.max(1, newest - oldest);

  const scored = pool.map((r) => {
    const hay = norm(r.text);
    let lexical = 0;
    for (const w of qWords) if (hay.includes(w)) lexical += 1;
    lexical = qWords.length ? lexical / qWords.length : 0;

    // Trigram overlap catches "invoce" matching "invoice".
    const rowTri = trigrams(r.text);
    let shared = 0;
    for (const g of qTri) if (rowTri.has(g)) shared++;
    const fuzzy = qTri.size ? shared / qTri.size : 0;

    // Recency only breaks ties; it must never outrank a real content match.
    const recency = (r.timestamp - oldest) / span;

    const score = lexical * 0.6 + fuzzy * 0.3 + recency * 0.1;
    return { ...r, score, when: describeAge(now - r.timestamp) };
  });

  return scored
    .filter((m) => m.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Pull the sentence around the match, so the answer is readable aloud. */
export function excerpt(text: string, query: string, width = 200): string {
  const qWords = words(query);
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of qWords) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, width).trim();
  const start = Math.max(0, at - Math.floor(width / 3));
  return (start > 0 ? "…" : "") + text.slice(start, start + width).trim() + (start + width < text.length ? "…" : "");
}

/** Formatted answer for the tool. */
export function answer(query: string, limit = 3): string {
  const hits = search(query, limit);
  if (!hits.length) {
    return `I couldn't find anything about "${query}" in what I've seen on your screen.`;
  }
  return hits
    .map((m, i) => `${i + 1}. ${m.when} — ${excerpt(m.text, query)}`)
    .join("\n");
}
