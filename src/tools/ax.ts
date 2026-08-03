import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, parse } from "node:path";

/**
 * Accessibility-based targeting.
 *
 * Reads the macOS Accessibility tree via the compiled `native/axhelper` so the
 * model can act on "the Send button" instead of a screenshot guess. Works on
 * native apps and Safari; Chromium and some Electron apps expose nothing, in
 * which case callers fall back to the screenshot + coordinate path.
 */
export interface AxElement {
  i: number;
  role: string;
  label: string;
  value: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled: boolean;
  press: boolean; // supports AXPress (activate without moving the mouse)
}

export interface AxDump {
  app: string;
  pid: number;
  axAvailable: boolean;
  elements: AxElement[];
  error?: string;
}

/**
 * Find native/axhelper by walking up from this module until a directory
 * containing it appears. esbuild bundles ax.ts into files at different depths
 * (dist/main.js, dist/_axtest.js), so a fixed "../.." is wrong depending on the
 * entry point — walking up is robust to all of them.
 */
function locateHelper(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, "native", "axhelper");
    if (existsSync(candidate)) return candidate;
    if (dir === root) return candidate; // last tried; helperAvailable() reports false
    dir = dirname(dir);
  }
}

const HELPER = locateHelper();

export function helperAvailable(): boolean {
  return existsSync(HELPER);
}

function runHelper(args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(HELPER, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stdout?.trim()) return resolve(stdout);
      reject(new Error(stderr?.trim() || err?.message || "axhelper produced no output"));
    });
  });
}

export async function dump(all = false): Promise<AxDump> {
  if (!helperAvailable()) {
    return { app: "?", pid: 0, axAvailable: false, elements: [], error: "helper-not-built" };
  }
  try {
    const raw = await runHelper(all ? ["dump", "--all"] : ["dump"]);
    const parsed = JSON.parse(raw) as AxDump;
    parsed.elements ??= [];
    return parsed;
  } catch (err: any) {
    return { app: "?", pid: 0, axAvailable: false, elements: [], error: String(err?.message ?? err) };
  }
}

/** Activate an element directly through the API (no mouse). Returns its label. */
export async function press(pid: number, path: string): Promise<{ ok: boolean; label?: string; error?: string }> {
  try {
    const raw = await runHelper(["press", "--pid", String(pid), "--path", path]);
    return JSON.parse(raw);
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ---- matching ------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Rank elements against a spoken description ("the send button", "search
 * field"). Scores exact and substring label hits, with a nudge from any role
 * word in the query, so "submit button" prefers an actual AXButton.
 */
export function rank(elements: AxElement[], query: string): AxElement[] {
  const q = norm(query);
  const qWords = q.split(" ").filter((w) => w.length > 1 && !STOP.has(w));

  const roleHint = ROLE_WORDS.find((r) => q.includes(r.word));

  return elements
    .map((e) => {
      const label = norm(e.label);
      const value = norm(e.value);

      // A textual match is REQUIRED to qualify. Structural signals (role, press)
      // only break ties among things that already matched by words — otherwise
      // every pressable control scores above zero and an unrelated request like
      // "launch the rockets" matches the whole window.
      let textScore = 0;
      if (label && label === q) textScore += 100;
      if (label && (q.includes(label) || label.includes(q))) textScore += 40;
      for (const w of qWords) {
        if (label.split(" ").includes(w)) textScore += 12;
        else if (label.includes(w)) textScore += 6;
        if (value.includes(w)) textScore += 3;
      }
      if (textScore === 0) return { e, score: 0 };

      let score = textScore;
      if (roleHint && e.role === roleHint.role) score += 8;
      if (!e.enabled) score -= 5;
      if (e.press) score += 2; // prefer things we can activate cleanly

      return { e, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.e);
}

const STOP = new Set(["the", "a", "an", "on", "in", "click", "press", "button", "field", "my", "please", "that", "this"]);

const ROLE_WORDS = [
  { word: "button", role: "AXButton" },
  { word: "checkbox", role: "AXCheckBox" },
  { word: "link", role: "AXLink" },
  { word: "tab", role: "AXTab" },
  { word: "field", role: "AXTextField" },
  { word: "search", role: "AXSearchField" },
  { word: "menu", role: "AXMenuItem" },
  { word: "dropdown", role: "AXPopUpButton" },
  { word: "slider", role: "AXSlider" },
];

/** Compact, model-friendly rendering of a dump. */
export function summarize(dump: AxDump, limit = 60): string {
  if (!dump.axAvailable || !dump.elements.length) {
    return `No accessibility data for ${dump.app}. Use a screenshot and click by coordinates instead.`;
  }
  const rows = dump.elements
    .slice(0, limit)
    .map((e) => {
      const role = e.role.replace(/^AX/, "");
      const val = e.value && e.value !== e.label ? ` = "${e.value.slice(0, 24)}"` : "";
      const off = e.enabled ? "" : " (disabled)";
      return `#${e.i} ${role} "${e.label.slice(0, 40)}"${val}${off} @${e.x + Math.round(e.w / 2)},${e.y + Math.round(e.h / 2)}`;
    })
    .join("\n");
  const more = dump.elements.length > limit ? `\n… and ${dump.elements.length - limit} more` : "";
  return `${dump.app} — ${dump.elements.length} elements:\n${rows}${more}`;
}
