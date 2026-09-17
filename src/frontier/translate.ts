import { createHash } from "node:crypto";
import { putHandoff, readHandoff, clearHandoff } from "./task-handoff.js";
import type { OcrLine } from "../tools/vision.js";

/**
 * Reading a screen that is not in your language.
 *
 * Everything needed already existed: OCR that returns text WITH coordinates,
 * and a click-through overlay that can draw anywhere. Putting them together
 * gives a translation layer for content that has no translate button — a
 * scanned PDF, a screenshot someone sent you, a native app, a video frame.
 *
 * The interesting problem is not translating; it is deciding what to translate.
 * OCR returns dozens of disconnected runs, and translating each in isolation
 * produces nonsense: word order differs between languages, so a fragment
 * translated alone is often wrong even when every word is right. Runs are
 * therefore grouped into lines and paragraphs FIRST, translated as passages,
 * and only then placed back over their source.
 */

export interface TextBlock {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The OCR runs this block was assembled from. */
  parts: number;
}

export interface TranslatedBlock extends TextBlock {
  translated: string;
}

/** Ignore text the recogniser was unsure of; a mistranslated misreading is worse than a gap. */
const MIN_CONFIDENCE = 0.5;

/**
 * Two runs belong to the same visual line when their vertical centres are
 * within this fraction of their height. Comparing centres rather than tops
 * survives the different cap heights that mixed font sizes produce.
 */
const LINE_TOLERANCE = 0.6;

/** Lines closer than this many line-heights apart are one paragraph. */
const PARAGRAPH_GAP = 1.8;

/** Group OCR runs into visual lines, left to right. */
export function groupIntoLines(lines: OcrLine[]): TextBlock[] {
  const usable = lines.filter((l) => (l.confidence ?? 1) >= MIN_CONFIDENCE && l.text.trim());
  if (!usable.length) return [];

  const sorted = [...usable].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: OcrLine[][] = [];

  for (const l of sorted) {
    const centre = l.y + l.h / 2;
    const row = rows.find((r) => {
      const first = r[0];
      const rc = first.y + first.h / 2;
      return Math.abs(rc - centre) <= Math.max(first.h, l.h) * LINE_TOLERANCE;
    });
    if (row) row.push(l);
    else rows.push([l]);
  }

  return rows.map((r) => {
    const ordered = [...r].sort((a, b) => a.x - b.x);
    const x = Math.min(...ordered.map((l) => l.x));
    const y = Math.min(...ordered.map((l) => l.y));
    const right = Math.max(...ordered.map((l) => l.x + l.w));
    const bottom = Math.max(...ordered.map((l) => l.y + l.h));
    return {
      text: ordered.map((l) => l.text.trim()).join(" ").replace(/\s+/g, " ").trim(),
      x, y, w: right - x, h: bottom - y,
      parts: ordered.length,
    };
  });
}

/**
 * Merge adjacent lines into paragraphs.
 *
 * A sentence split across three lines has to reach the translator whole, or
 * each third is translated as though it were a complete thought.
 */
export function groupIntoParagraphs(lines: TextBlock[]): TextBlock[] {
  if (!lines.length) return [];
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: TextBlock[] = [];
  let cur: TextBlock[] = [sorted[0]];

  const flush = () => {
    const x = Math.min(...cur.map((l) => l.x));
    const y = Math.min(...cur.map((l) => l.y));
    const right = Math.max(...cur.map((l) => l.x + l.w));
    const bottom = Math.max(...cur.map((l) => l.y + l.h));
    out.push({
      text: cur.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim(),
      x, y, w: right - x, h: bottom - y,
      parts: cur.reduce((n, l) => n + l.parts, 0),
    });
    cur = [];
  };

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const l = sorted[i];
    const gap = l.y - (prev.y + prev.h);
    const lineHeight = Math.max(prev.h, 1);

    // A new paragraph when the vertical gap is large, or when the block starts
    // in a clearly different column — side-by-side panes are not one passage.
    const farBelow = gap > lineHeight * PARAGRAPH_GAP;
    const differentColumn = Math.abs(l.x - prev.x) > Math.max(prev.w, l.w) * 0.6;
    if (farBelow || differentColumn) {
      flush();
    }
    cur.push(l);
  }
  if (cur.length) flush();
  return out;
}

/** Blocks worth sending to a translator. */
export function translatableBlocks(lines: OcrLine[], maxBlocks = 40): TextBlock[] {
  const blocks = groupIntoParagraphs(groupIntoLines(lines));
  return blocks
    // A stray character or a lone digit is interface furniture, not language.
    .filter((b) => b.text.replace(/[^\p{L}]/gu, "").length >= 3)
    // Biggest first: if there is a cap, the substantial text matters most.
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, maxBlocks);
}

/**
 * The prompt used to translate a screen.
 *
 * Numbered lines in, numbered lines out. Free-form output cannot be matched
 * back to the coordinates it came from, and asking for JSON from a small local
 * model produces malformed JSON often enough to matter.
 */
export function buildPrompt(blocks: TextBlock[], targetLanguage: string): string {
  const numbered = blocks.map((b, i) => `${i + 1}. ${b.text}`).join("\n");
  return (
    `Translate each numbered line into ${targetLanguage}.\n\n` +
    `Rules:\n` +
    `- Reply with ONLY the numbered translations, one per line, same numbers.\n` +
    `- Keep the same number of lines. Never merge or split lines.\n` +
    `- If a line is already in ${targetLanguage}, repeat it unchanged.\n` +
    `- Do not explain, comment, or add anything else.\n\n` +
    numbered
  );
}

/**
 * Match a numbered reply back to the blocks it came from.
 *
 * Models drop a line, renumber, or wrap the answer in commentary. Parsing by
 * the NUMBER rather than by position means a dropped line leaves one block
 * untranslated instead of shifting every later translation onto the wrong
 * piece of text — which would be silently, confidently wrong.
 */
export function parseTranslations(reply: string, blocks: TextBlock[]): TranslatedBlock[] {
  const byIndex = new Map<number, string>();
  for (const raw of (reply ?? "").split("\n")) {
    const m = /^\s*(\d+)\s*[.)\]:-]\s*(.+)$/.exec(raw.trim());
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const text = m[2].trim();
    if (n >= 1 && n <= blocks.length && text && !byIndex.has(n)) {
      byIndex.set(n, text);
    }
  }
  return blocks.map((b, i) => ({ ...b, translated: byIndex.get(i + 1) ?? "" }));
}

/** Only blocks that actually came back changed are worth drawing. */
export function drawable(blocks: TranslatedBlock[]): TranslatedBlock[] {
  return blocks.filter(
    (b) =>
      b.translated &&
      // If the translation equals the source, the text was already in the
      // target language. Covering it with an identical copy is pure noise.
      b.translated.trim().toLowerCase() !== b.text.trim().toLowerCase()
  );
}

// ---- the two-step handoff -------------------------------------------------

/**
 * Blocks awaiting a translation.
 *
 * Jarvis does not need a translation service: the brain reading this IS a
 * language model, and a far better translator than anything that would fit
 * beside it. So the work is split across two tool calls — one that reads the
 * screen and hands back numbered passages, one that takes the translations and
 * draws them. The coordinates stay here in between, because sending pixel
 * boxes out to the model and trusting them to come back intact is a needless
 * way to lose them.
 */
export function translationVersion(blocks: TextBlock[], resource = ""): string {
  return createHash("sha256").update(JSON.stringify([resource, blocks])).digest("hex");
}
export function stashBlocks(blocks: TextBlock[], language: string, resourceVersion?: string) {
  return putHandoff("translation", { blocks, language }, { ttlMs: 120_000, resourceVersion });
}
export function pendingTranslation(id?: string, resourceVersion?: string) {
  return readHandoff<{ blocks: TextBlock[]; language: string }>("translation", { id, resourceVersion });
}
export function pendingBlocks(): TextBlock[] { return pendingTranslation()?.value.blocks ?? []; }
export function pendingTarget(): string { return pendingTranslation()?.value.language ?? "English"; }
export function clearPending() { clearHandoff("translation"); }

/** Speakable summary of what was put on screen. */
export function describe(shown: TranslatedBlock[], target: string, total: number): string {
  if (!total) return "I couldn't find any readable text on screen to translate.";
  if (!shown.length) return `That already looks like ${target} to me — nothing to translate.`;
  return `Translated ${shown.length} passage${shown.length === 1 ? "" : "s"} into ${target} and laid them over the screen. Say "clear translation" when you're done.`;
}
