import { execFile } from "node:child_process";
import {
  existsSync, mkdirSync, appendFileSync, readFileSync, copyFileSync, writeFileSync, statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { embed, cosine } from "./diskindex.js";

/**
 * "Scan this page."
 *
 * The 30-second rewind sweep is a rough, sampled record that ages out after
 * three months. This is the opposite: a deliberate, full-fidelity capture of
 * exactly what is on screen right now — a PDF, a screen of code, an email, a
 * message thread, lecture notes — kept FOREVER and recallable by meaning months
 * later. "What was that pricing PDF I scanned in the spring?" has to still
 * answer in the autumn, so nothing here is ever pruned.
 *
 * Each scan holds three things: the text (searchable and readable back), a
 * downscaled screenshot (so you can be shown it, not just told about it), and an
 * embedding (so recall is by meaning, not exact words). When the thing on screen
 * is a real file — a PDF open in Preview, a source file in an editor — its path
 * is resolved so the actual document can be saved, not just a picture of it.
 */

// ---- content types --------------------------------------------------------

export type ScanKind = "pdf" | "code" | "email" | "message" | "notes" | "image" | "web" | "text";

export interface Scan {
  id: string;
  at: number;
  app: string;
  title: string;
  kind: ScanKind;
  text: string;
  /** Resolved source file, when the thing on screen is a real document. */
  sourcePath?: string;
  /** Screenshot filename under shots/. */
  shot?: string;
  /** Where a copy was saved, once the user accepts the offer. */
  saved?: string;
  /** Inline embedding for recall. Absent when the model was unavailable. */
  vector?: number[];
}

/** A scan without the heavy vector — what recall hands back. */
export type ScanSummary = Omit<Scan, "vector">;

// ---- detecting what is on screen ------------------------------------------

const CODE_APPS = /visual studio code|vscode|code|xcode|intellij|pycharm|webstorm|sublime|terminal|iterm|nova|zed|android studio|antigravity/i;
const MAIL_APPS = /\bmail\b|outlook|spark|airmail|thunderbird/i;
const CHAT_APPS = /messages|whatsapp|telegram|signal|slack|discord|imessage/i;
const NOTE_APPS = /notes|notion|obsidian|bear|craft|onenote|evernote|logseq/i;
const PDF_APPS = /preview|acrobat|adobe|skim|pdf expert/i;
const BROWSERS = /chrome|safari|brave|arc|firefox|edge|opera|vivaldi/i;
const IMAGE_APPS = /photos|preview|pixelmator|photoshop|affinity|gimp|figma/i;

/**
 * Guess the kind of content from the text, the app and the window title.
 *
 * The app is a strong signal but not decisive: a PDF open in Chrome is still a
 * PDF, and code pasted into an email is still an email. So the title and the
 * shape of the text get a say, and the checks are ordered most-specific first.
 */
const IMAGE_EXT = /\.(png|jpe?g|heic|gif|webp|tiff?|bmp|svg)(\b|$)/;

export function detectKind(text: string, app: string, title = ""): ScanKind {
  const a = app.toLowerCase();
  const t = title.toLowerCase();
  const body = text.slice(0, 4000);
  const textDensity = body.replace(/\s/g, "").length;

  // An image extension in the title is decisive — Preview shows images and PDFs
  // alike, so the app alone cannot tell them apart.
  if (IMAGE_EXT.test(t)) return "image";

  // A .pdf title is unambiguous. A PDF viewer is a PDF only when there is real
  // text on screen; Preview showing a photo has almost none, and that is an
  // image, not a PDF.
  if (/\.pdf(\b|$)/.test(t)) return "pdf";
  if (PDF_APPS.test(a)) return textDensity >= 40 ? "pdf" : "image";

  // Email has an unmistakable header shape; the app alone would miss webmail.
  const emailish =
    MAIL_APPS.test(a) ||
    (/\bfrom:\s/i.test(body) && /\bto:\s/i.test(body)) ||
    (/\bsubject:\s/i.test(body) && /\b(reply|forward|inbox|unread)\b/i.test(body)) ||
    /\bgmail\b/.test(t);
  if (emailish) return "email";

  if (CHAT_APPS.test(a)) return "message";

  if (CODE_APPS.test(a) || looksLikeCode(body)) return "code";

  if (NOTE_APPS.test(a)) return "notes";

  // An image viewer showing almost no text is an image, not a document.
  if (IMAGE_APPS.test(a) && body.replace(/\s/g, "").length < 40) return "image";

  if (BROWSERS.test(a)) return "web";

  return "text";
}

/**
 * Does this text read like source code?
 *
 * Judged by density of code-only tokens across lines rather than any single
 * keyword, because prose about code ("the function returns a list") should not
 * be mistaken for code itself.
 */
export function looksLikeCode(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return false;

  const CODE = /[{};]|=>|\b(function|const|let|var|def|class|import|export|return|public|private|void|int|for|while|if|else)\b|<\/?[a-z]|::|->|\)\s*{|\w+\(.*\)/;
  let hits = 0;
  for (const l of lines) if (CODE.test(l)) hits++;
  // A third of lines carrying code tokens is well above what prose produces.
  return hits / lines.length >= 0.34;
}

// ---- naming a saved copy --------------------------------------------------

const EXT_FOR: Record<ScanKind, string> = {
  pdf: ".pdf",
  code: ".txt",
  email: ".md",
  message: ".md",
  notes: ".md",
  image: ".png",
  web: ".md",
  text: ".md",
};

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "scan";

/**
 * A filename for a saved copy that a person would recognise later.
 *
 * The window title is the best label there is — "Lecture 3 - Neural Nets" beats
 * "scan-1721659200". A date prefix keeps saved scans sorted and unique so two
 * saves never collide.
 */
export function suggestFilename(scan: Pick<Scan, "kind" | "title" | "app" | "at" | "sourcePath">): string {
  // A resolved real file keeps its own name and extension — that is the file
  // the user recognises.
  if (scan.sourcePath) return basename(scan.sourcePath);

  const date = new Date(scan.at).toISOString().slice(0, 10);
  const label = slug(scan.title || scan.app || String(scan.kind));
  return `${date}-${label}${EXT_FOR[scan.kind]}`;
}

/** What a scan is worth saving AS: the real file, or the captured text/image. */
export function saveStrategy(scan: Pick<Scan, "kind" | "sourcePath" | "shot">): "file" | "image" | "text" {
  if (scan.sourcePath) return "file";
  if (scan.kind === "image") return "image";
  return "text";
}

// ---- storage --------------------------------------------------------------

export function scanRoot(base: string = join(homedir(), ".jarvis")): string {
  return join(base, "scans");
}
function recordPath(base?: string): string {
  return join(scanRoot(base), "scans.jsonl");
}
export function shotsDir(base?: string): string {
  return join(scanRoot(base), "shots");
}

function ensureDirs(base?: string): void {
  const dir = scanRoot(base);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const shots = shotsDir(base);
  if (!existsSync(shots)) mkdirSync(shots, { recursive: true, mode: 0o700 });
}

/** Append a scan. Permanent — nothing ever prunes this file. */
export function saveScan(scan: Scan, base?: string): void {
  ensureDirs(base);
  appendFileSync(recordPath(base), JSON.stringify(scan) + "\n", { mode: 0o600 });
}

export function loadScans(base?: string): Scan[] {
  const path = recordPath(base);
  if (!existsSync(path)) return [];
  const out: Scan[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const s = JSON.parse(t);
      if (s?.id && typeof s.text === "string") out.push(s);
    } catch {
      /* a corrupt line must not lose the rest of the archive */
    }
  }
  return out;
}

/** Update the most recent matching scan in place (rewrites the file). */
export function updateScan(id: string, patch: Partial<Scan>, base?: string): boolean {
  const scans = loadScans(base);
  const i = scans.findIndex((s) => s.id === id);
  if (i < 0) return false;
  scans[i] = { ...scans[i], ...patch };
  ensureDirs(base);
  writeFileSync(recordPath(base), scans.map((s) => JSON.stringify(s)).join("\n") + "\n", { mode: 0o600 });
  return true;
}

export const strip = (s: Scan): ScanSummary => {
  const { vector, ...rest } = s;
  return rest;
};

// ---- recall ---------------------------------------------------------------

/**
 * Rank scans against a query embedding, newest breaking ties.
 *
 * Recency is a whisper, not a shout: it only separates matches of almost equal
 * meaning, so a strongly relevant scan from months ago still beats a barely
 * relevant one from yesterday — which is the whole point of keeping them.
 */
export function rankByVector(query: number[], scans: Scan[], limit = 5, minScore = 0.4): ScanSummary[] {
  const scored = scans
    .filter((s) => s.vector?.length)
    .map((s) => ({ s, score: cosine(query, s.vector!) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || b.s.at - a.s.at);
  return scored.slice(0, limit).map((x) => strip(x.s));
}

/**
 * The offline fallback when the embedding model is not running.
 *
 * Word and substring overlap — crude next to embeddings, but it means recall
 * never simply stops working because Ollama is down.
 */
export function rankByText(query: string, scans: Scan[], limit = 5): ScanSummary[] {
  const q = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!q.length) return [];
  const scored = scans
    .map((s) => {
      const hay = (s.text + " " + s.title + " " + s.app).toLowerCase();
      let hits = 0;
      for (const w of q) if (hay.includes(w)) hits++;
      return { s, score: hits / q.length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.s.at - a.s.at);
  return scored.slice(0, limit).map((x) => strip(x.s));
}

/** Speech-friendly age. */
export function ageOf(ms: number, now = Date.now()): string {
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `about ${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(months / 12);
  return `about ${years} year${years === 1 ? "" : "s"} ago`;
}

const KIND_WORD: Record<ScanKind, string> = {
  pdf: "PDF", code: "code", email: "email", message: "message",
  notes: "notes", image: "image", web: "web page", text: "page",
};

/** Readable recall answer. */
export function describeMatches(matches: ScanSummary[], query: string, now = Date.now()): string {
  if (!matches.length) {
    return `I don't have a scan matching "${query}". I only recall pages you asked me to scan.`;
  }
  return matches
    .map((m, i) => {
      const excerpt = m.text.replace(/\s+/g, " ").slice(0, 260).trim();
      const where = m.saved ? ` — saved at ${m.saved}` : "";
      return `${i + 1}. ${KIND_WORD[m.kind]} from ${m.app || "an app"}, ${ageOf(m.at, now)}${where}\n   ${m.title ? `"${m.title}" — ` : ""}${excerpt}${m.text.length > 260 ? "…" : ""}`;
    })
    .join("\n\n");
}

// ---- capture (impure) -----------------------------------------------------

function locateHelper(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(dir, "native", name);
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) return candidate;
    dir = up;
  }
}

/**
 * Resolve the real file behind the front window, if there is one.
 *
 * AXDocument is the reliable path for document apps (Preview, editors, Word):
 * it returns a file URL for whatever is open. Browsers do not set it, so a
 * local file:// URL in the address bar is the fallback there. Anything else —
 * a web page, an Electron app — legitimately has no file, and that is fine:
 * the scan is saved as its captured text instead.
 */
export async function resolveSourcePath(): Promise<string | undefined> {
  const script = `
    tell application "System Events"
      set p to first process whose frontmost is true
      try
        set d to value of attribute "AXDocument" of window 1 of p
        if d is not missing value then return d
      end try
    end tell
    return ""`;
  try {
    const out = await runOsascript(script);
    const url = out.trim();
    if (!url) return undefined;
    // AXDocument gives a file URL; turn it into a plain path.
    if (url.startsWith("file://")) {
      const path = decodeURIComponent(url.replace(/^file:\/\//, "").replace(/\?.*$/, ""));
      return existsSync(path) ? path : undefined;
    }
    return existsSync(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The frontmost app and its window title, for labelling and type detection. */
export async function frontContext(): Promise<{ app: string; title: string }> {
  const script = `
    tell application "System Events"
      set p to first process whose frontmost is true
      set appName to name of p
      set winName to ""
      try
        set winName to name of window 1 of p
      end try
      return appName & "\n" & winName
    end tell`;
  try {
    const out = await runOsascript(script);
    const [app = "", title = ""] = out.split("\n");
    return { app: app.trim(), title: title.trim() };
  } catch {
    return { app: "", title: "" };
  }
}

function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 5000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

/** Downscale a base64 PNG to a small JPEG kept alongside the scan. */
export async function saveShot(id: string, pngBase64: string, base?: string): Promise<string | undefined> {
  ensureDirs(base);
  const name = `${id}.jpg`;
  const tmp = join(shotsDir(base), `${id}.png`);
  try {
    writeFileSync(tmp, Buffer.from(pngBase64, "base64"));
    await new Promise<void>((resolve, reject) => {
      execFile(
        "/usr/bin/sips",
        ["-Z", "1400", "-s", "format", "jpeg", "-s", "formatOptions", "80", tmp, "--out", join(shotsDir(base), name)],
        { timeout: 15000 },
        (err) => (err ? reject(err) : resolve())
      );
    });
    return name;
  } catch {
    return undefined;
  } finally {
    try { if (existsSync(tmp)) writeFileSync(tmp, ""); } catch { /* ignore */ }
  }
}

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Everything the capture layer feeds in; separated so the store stays testable. */
export interface CaptureInput {
  text: string;
  app: string;
  title: string;
  pngBase64?: string;
}

/**
 * Turn a capture into a stored, embedded, permanent scan.
 *
 * The embedding is best-effort: if the local model is down the scan is still
 * saved and still recallable by text, so a capture is never lost to a service
 * being off.
 */
export async function commitScan(input: CaptureInput, base?: string): Promise<Scan> {
  const id = uid();
  const kind = detectKind(input.text, input.app, input.title);
  const sourcePath = await resolveSourcePath().catch(() => undefined);

  let shot: string | undefined;
  if (input.pngBase64) shot = await saveShot(id, input.pngBase64, base);

  let vector: number[] | undefined;
  const toEmbed = `${input.title}\n${input.text}`.slice(0, 6000);
  const v = await embed(toEmbed, false).catch(() => null);
  if (v) vector = Array.from(v);

  const scan: Scan = {
    id,
    at: Date.now(),
    app: input.app,
    title: input.title,
    kind,
    text: input.text,
    sourcePath,
    shot,
    vector,
  };
  saveScan(scan, base);
  return scan;
}

/** Recall scans by meaning, falling back to text when the model is off. */
export async function recallScans(query: string, base?: string, limit = 5): Promise<ScanSummary[]> {
  const scans = loadScans(base);
  if (!scans.length) return [];
  const qv = await embed(query, true).catch(() => null);
  if (qv) {
    const byVec = rankByVector(Array.from(qv), scans, limit);
    if (byVec.length) return byVec;
  }
  return rankByText(query, scans, limit);
}

/** The most recent scan, for the "save it for me" follow-up. */
export function lastScan(base?: string): Scan | undefined {
  const scans = loadScans(base);
  return scans[scans.length - 1];
}

/**
 * Save a scan to the Desktop — the real file if there is one, otherwise the
 * captured text or screenshot.
 */
export async function saveScanToDesktop(scan: Scan, base?: string): Promise<string> {
  const desktop = join(homedir(), "Desktop");
  const strategy = saveStrategy(scan);
  let dest = uniqueDestination(join(desktop, suggestFilename(scan)));

  if (strategy === "file" && scan.sourcePath && existsSync(scan.sourcePath)) {
    copyFileSync(scan.sourcePath, dest);
  } else if (strategy === "image" && scan.shot) {
    const shotPath = join(shotsDir(base), scan.shot);
    dest = uniqueDestination(join(desktop, suggestFilename({ ...scan, kind: "image" })));
    if (existsSync(shotPath)) copyFileSync(shotPath, dest);
    else throw new Error("the screenshot for that scan is missing");
  } else {
    // Save the captured text as a readable markdown file, with a small header.
    const header = `# ${scan.title || KIND_WORD[scan.kind]}\n\nScanned from ${scan.app || "an app"} on ${new Date(scan.at).toLocaleString()}.\n\n---\n\n`;
    writeFileSync(dest, header + scan.text);
  }

  updateScan(scan.id, { saved: dest }, base);
  return dest;
}

/** Never overwrite something already on the Desktop. */
export function uniqueDestination(path: string): string {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** Offer text after a scan: what it is, and whether to save it. */
export function offerFor(scan: Scan): string {
  const what = KIND_WORD[scan.kind];
  const named = scan.sourcePath ? ` ("${basename(scan.sourcePath)}")` : scan.title ? ` ("${scan.title}")` : "";
  const canSaveReal = !!scan.sourcePath;
  const saveHint =
    canSaveReal
      ? `Want me to save this ${what}${named} to your Desktop?`
      : scan.kind === "image"
      ? "Want me to save the image to your Desktop?"
      : `Want me to save this to your Desktop as a file?`;
  return `Scanned and remembered this ${what}${named}. I'll be able to recall it for you any time, even months from now. ${saveHint}`;
}
