import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, parse } from "node:path";
import type { Display } from "./displays.js";

/**
 * Local, on-device screen understanding via the compiled visionhelper.
 *
 * OCR reads the screen's text without an image ever reaching the model — fast
 * enough to poll, free of token cost, and it returns clickable coordinates for
 * text, which is how Jarvis can act inside apps that expose no accessibility
 * tree (Chrome, Brave). Presence reports whether someone is at the camera.
 */
export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number; // centre — click here
  cy: number;
  /** Which display this text was found on. */
  display?: number;
  confidence: number;
}
export interface OcrResult {
  width: number;
  height: number;
  lines: OcrLine[];
  /** Which display was read, and where it sits in the global coordinate space. */
  display?: number;
  originX?: number;
  originY?: number;
  primary?: boolean;
  error?: string;
}
export interface Presence {
  present: boolean;
  faces: number;
  prominence: number; // 0..1, how much of the frame the nearest face fills
  /** Mean luminance 0..1, so "nobody there" can be told from "too dark to see". */
  brightness?: number;
  dark?: boolean;
  framesExamined?: number;
  error?: string;
}

function locate(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, "native", "visionhelper");
    if (existsSync(candidate)) return candidate;
    if (dir === root) return candidate;
    dir = dirname(dir);
  }
}
const HELPER = locate();

export function visionAvailable(): boolean {
  return existsSync(HELPER);
}

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(HELPER, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stdout?.trim()) return resolve(stdout);
      reject(new Error(stderr?.trim() || err?.message || "visionhelper produced no output"));
    });
  });
}

/**
 * Every attached display, in the coordinate space the mouse uses.
 *
 * Electron's own `screen.getAllDisplays()` would do for the main process, but
 * the helper is the single source of truth here so tools, tests and the
 * capture path all agree about which display is index 1.
 */
export async function displays(): Promise<Display[]> {
  if (!visionAvailable()) return [];
  try {
    const parsed = JSON.parse(await run(["displays"], 8000)) as { displays?: Display[] };
    return parsed.displays ?? [];
  } catch {
    return [];
  }
}

/**
 * accurate mode reads more reliably; fast mode is for polling.
 *
 * `display` selects which screen to read. Coordinates come back GLOBAL — the
 * display's own offset is already applied — so a centre can be clicked
 * directly whichever monitor the text was on.
 */
export async function ocr(
  mode: "fast" | "accurate" = "accurate",
  display = 0
): Promise<OcrResult> {
  if (!visionAvailable()) return { width: 0, height: 0, lines: [], error: "helper-not-built" };
  try {
    const args = ["ocr"];
    if (mode === "fast") args.push("--fast");
    if (display) args.push("--display", String(display));
    const raw = await run(args, 15000);
    const parsed = JSON.parse(raw) as OcrResult;
    parsed.lines ??= [];
    return parsed;
  } catch (err: any) {
    return { width: 0, height: 0, lines: [], error: String(err?.message ?? err) };
  }
}

/**
 * Read every display and merge the results.
 *
 * Screens are read in sequence rather than in parallel: ScreenCaptureKit
 * contends with itself, and accurate OCR is already 1-3 seconds of CPU per
 * display. Because every coordinate is global, the merged list needs no
 * further translation — a line from the second monitor is clickable as-is.
 */
export async function ocrAll(mode: "fast" | "accurate" = "accurate"): Promise<OcrResult> {
  const list = await displays();
  if (list.length <= 1) return ocr(mode, 0);

  const merged: OcrResult = { width: 0, height: 0, lines: [] };
  for (const d of list) {
    const r = await ocr(mode, d.index);
    if (r.error) continue;
    merged.lines.push(...r.lines);
    merged.width = Math.max(merged.width, (r.originX ?? 0) + r.width);
    merged.height = Math.max(merged.height, (r.originY ?? 0) + r.height);
  }
  if (!merged.lines.length) merged.error = "no-text-found";
  return merged;
}

export async function presence(): Promise<Presence> {
  if (!visionAvailable()) return { present: false, faces: 0, prominence: 0, error: "helper-not-built" };
  try {
    return JSON.parse(await run(["presence", "--timeout", "6"], 15000));
  } catch (err: any) {
    return { present: false, faces: 0, prominence: 0, error: String(err?.message ?? err) };
  }
}

/** Compact, model-friendly rendering: text with the point to click each run. */
export function summarizeOcr(r: OcrResult, limit = 80): string {
  if (r.error) return `Could not read the screen (${r.error}).`;
  if (!r.lines.length) return "No text detected on screen.";
  const rows = r.lines
    .slice(0, limit)
    .map((l) => `"${l.text}" @${l.cx},${l.cy}`)
    .join("\n");
  const more = r.lines.length > limit ? `\n… ${r.lines.length - limit} more` : "";
  return `Screen text (${r.lines.length} runs, click coordinates given):\n${rows}${more}`;
}

/** Best clickable text match for a spoken target, for the Chromium fallback. */
export function findText(r: OcrResult, query: string): OcrLine | null {
  const q = query.toLowerCase().trim();
  const cands = r.lines.filter((l) => l.text.toLowerCase().includes(q));
  if (!cands.length) return null;
  // Shortest match containing the query is usually the actual label, not a
  // paragraph that happens to mention it.
  return cands.sort((a, b) => a.text.length - b.text.length)[0];
}
