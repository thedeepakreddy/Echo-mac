import { loadRange, loadRecent, type HistoryRow } from "./history.js";
import { describeAge } from "./timetravel.js";

/**
 * What changed on your screen while you were not looking.
 *
 * The naive version of this — diff the text then and the text now — produces
 * nothing but noise. Three things defeat it, and each is handled here:
 *
 *   - The clock in the menu bar changes every minute, as do battery levels,
 *     unread counts and progress percentages. A plain diff reports those
 *     forever and nothing else is ever visible underneath them.
 *   - OCR is not deterministic. The same unchanged screen read twice differs in
 *     a few characters, so single-sample differences are mostly misreadings.
 *   - Things flash past. A notification that appeared and left is not something
 *     you need to be told about when you sit back down.
 *
 * The fix for all three is the same: never trust a single frame. A difference
 * counts only if it is absent from EVERY sample before you left and present in
 * SEVERAL samples since. That turns a noisy character diff into a claim about
 * what is durably on screen now that was not before.
 */

export interface ChangeReport {
  /** When the comparison window starts and ends. */
  from: number;
  to: number;
  /** How long that was, phrased for speech. */
  span: string;
  /** Durably present now, absent before. */
  appeared: string[];
  /** Durably present before, gone now. */
  vanished: string[];
  /** How many captures each side was judged from. */
  samples: { before: number; after: number };
}

/** Shingle length. Three words is long enough to be meaningful, short enough to survive an OCR slip. */
const N = 3;

/** Phrases shorter than this are not worth reporting. */
const MIN_PHRASE_WORDS = 4;

/** Captures to use on each side of the window. */
const MAX_SAMPLES = 12;

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9:%.\s-]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Tokens whose value changes on its own, without anything happening.
 *
 * Without this the answer to "what changed?" is permanently "the clock says
 * 14:33 now" — technically true, never what was asked.
 */
function isVolatile(word: string): boolean {
  return (
    /^\d{1,2}:\d{2}(:\d{2})?$/.test(word) || // clock
    /^\d+%$/.test(word) || // battery, progress, zoom
    /^[\d.,]+$/.test(word) || // bare numbers and counts
    /^\d+(kb|mb|gb|ms|s|m|h)$/.test(word) || // sizes and durations
    /^(am|pm)$/.test(word)
  );
}

function tokens(text: string): string[] {
  return norm(text).split(" ").filter(Boolean);
}

/** Word n-grams, skipping any that contain a value that changes by itself. */
function shingles(text: string): Set<string> {
  const w = tokens(text);
  const out = new Set<string>();
  for (let i = 0; i + N <= w.length; i++) {
    const gram = w.slice(i, i + N);
    if (gram.some(isVolatile)) continue;
    out.add(gram.join(" "));
  }
  return out;
}

/** Every shingle seen anywhere in a set of captures. */
function union(rows: HistoryRow[]): Set<string> {
  const all = new Set<string>();
  for (const r of rows) for (const g of shingles(r.text)) all.add(g);
  return all;
}

/** How many captures each shingle appears in. */
function support(rows: HistoryRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const g of shingles(r.text)) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

/**
 * How many captures a thing must appear in to count as really there.
 *
 * One sample is allowed to speak for itself — with a single capture there is
 * nothing to corroborate against, and refusing to answer would be worse than
 * answering carefully. Beyond that, require at least two so a single OCR
 * misreading or a notification that flashed past cannot become a finding.
 */
function minSupport(sampleCount: number): number {
  if (sampleCount <= 1) return 1;
  return Math.max(2, Math.floor(sampleCount * 0.4));
}

/**
 * Turn a set of interesting shingles back into readable phrases.
 *
 * Reporting raw three-word fragments reads like a ransom note, so this marks
 * every word covered by an interesting shingle and then reads off the runs of
 * consecutive marked words — recovering the original sentence rather than the
 * pieces it was chopped into.
 */
export function phrasesFrom(text: string, interesting: Set<string>): string[] {
  const w = tokens(text);
  const marked = new Array(w.length).fill(false);
  for (let i = 0; i + N <= w.length; i++) {
    if (interesting.has(w.slice(i, i + N).join(" "))) {
      for (let j = i; j < i + N; j++) marked[j] = true;
    }
  }

  const phrases: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= MIN_PHRASE_WORDS) phrases.push(run.join(" "));
    run = [];
  };
  for (let i = 0; i < w.length; i++) {
    if (marked[i]) run.push(w[i]);
    else flush();
  }
  flush();
  return phrases;
}

/** Prefer longer, more distinctive phrases and drop near-duplicates. */
function rank(phrases: string[], limit: number): string[] {
  const sorted = [...new Set(phrases)].sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const p of sorted) {
    // Skip anything already covered by a longer phrase we kept.
    if (kept.some((k) => k.includes(p))) continue;
    kept.push(p);
    if (kept.length >= limit) break;
  }
  return kept;
}

export interface CompareOptions {
  /** Captures to judge from, per side. */
  maxSamples?: number;
  /** Phrases to report, per direction. */
  limit?: number;
}

/**
 * Compare the screen before `from` with the screen between `from` and `to`.
 *
 * The "before" side is the captures immediately preceding the window, not a
 * fixed lookback: what matters is the state you left behind, whether that was
 * ten minutes or a whole night ago.
 */
export function compare(
  root: string,
  from: number,
  to: number = Date.now(),
  opts: CompareOptions = {}
): ChangeReport {
  const maxSamples = opts.maxSamples ?? MAX_SAMPLES;
  const limit = opts.limit ?? 6;

  const beforeAll = loadRange(root, 0, from - 1);
  const before = beforeAll.slice(-maxSamples);
  const afterAll = loadRange(root, from, to);
  const after = afterAll.slice(-maxSamples);

  const report: ChangeReport = {
    from,
    to,
    span: describeAge(to - from),
    appeared: [],
    vanished: [],
    samples: { before: before.length, after: after.length },
  };
  if (!before.length || !after.length) return report;

  const beforeSeen = union(before);
  const afterSeen = union(after);
  const afterSupport = support(after);
  const beforeSupport = support(before);

  const needAfter = minSupport(after.length);
  const needBefore = minSupport(before.length);

  const appeared = new Set<string>();
  for (const [gram, n] of afterSupport) {
    if (n >= needAfter && !beforeSeen.has(gram)) appeared.add(gram);
  }
  const vanished = new Set<string>();
  for (const [gram, n] of beforeSupport) {
    if (n >= needBefore && !afterSeen.has(gram)) vanished.add(gram);
  }

  // Phrases are recovered from the most recent capture on the relevant side,
  // so the wording is the wording that is actually on screen.
  report.appeared = rank(phrasesFrom(after[after.length - 1].text, appeared), limit);
  report.vanished = rank(phrasesFrom(before[before.length - 1].text, vanished), limit);
  return report;
}

/** Speakable summary. */
export function describe(r: ChangeReport): string {
  if (!r.samples.before || !r.samples.after) {
    return "I don't have enough screen history from either side of that period to compare.";
  }
  if (!r.appeared.length && !r.vanished.length) {
    return `Nothing meaningful changed on screen over ${r.span.replace(/^about /, "")}.`;
  }
  const parts: string[] = [];
  if (r.appeared.length) {
    parts.push(`New since then:\n${r.appeared.map((p) => `  • ${p}`).join("\n")}`);
  }
  if (r.vanished.length) {
    parts.push(`No longer on screen:\n${r.vanished.map((p) => `  • ${p}`).join("\n")}`);
  }
  return `Over ${r.span.replace(/^about /, "")}:\n${parts.join("\n")}`;
}

// ---- knowing when you left -----------------------------------------------

let leftAt: number | null = null;
let returnedAt: number | null = null;

/** Record that the desk went empty. */
export function noteLeft(at = Date.now()) {
  leftAt = at;
  returnedAt = null;
}

/** Record that you came back. */
export function noteReturned(at = Date.now()) {
  if (leftAt !== null) returnedAt = at;
}

/** Forget the recorded absence — used by tests and on shutdown. */
export function resetAway() {
  leftAt = null;
  returnedAt = null;
}

/**
 * The window you were away for, if there was one.
 *
 * Very short absences are not worth reporting on: standing up to stretch is not
 * a period you need briefing about, and presence needs ~90 seconds of missed
 * readings to call you away in the first place.
 */
export function lastAwayWindow(minMs = 5 * 60_000): { from: number; to: number } | null {
  if (leftAt === null) return null;
  const to = returnedAt ?? Date.now();
  if (to - leftAt < minMs) return null;
  return { from: leftAt, to };
}

/**
 * Answer "what changed while I was away?".
 *
 * Falls back to a recent window when there is no recorded absence, because the
 * question gets asked after closing a laptop lid or finishing a call, neither
 * of which the camera ever saw as leaving.
 */
export function whileAway(root: string, fallbackMs = 30 * 60_000, now = Date.now()): string {
  const win = lastAwayWindow();
  if (win) {
    const r = compare(root, win.from, win.to);
    return describe(r);
  }
  // No absence on record. Compare against the recent past instead, and say so,
  // rather than silently answering a different question than the one asked.
  const rows = loadRecent(root, 1);
  if (!rows.length) return "I haven't recorded any screen history yet.";
  const r = compare(root, now - fallbackMs, now);
  const body = describe(r);
  return `I didn't see you leave, so I compared the last half hour.\n${body}`;
}
