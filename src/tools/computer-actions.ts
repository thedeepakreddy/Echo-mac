import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { run, osascript } from "./shell.js";

let CLICLICK = "/opt/homebrew/bin/cliclick";
export function setCliclickBin(path: string) {
  CLICLICK = path;
}

export interface ScreenInfo {
  width: number;
  height: number;
}

import { createRequire } from "node:module";
const nodeRequire = typeof (globalThis as any).__non_webpack_require__ === "function" 
  ? (globalThis as any).__non_webpack_require__ 
  : createRequire(import.meta.url);

let cachedScreen: ScreenInfo | null = null;

/** Logical (point) size of the main display — the coordinate space cliclick uses. */
export async function getScreenInfo(force = false): Promise<ScreenInfo> {
  if (cachedScreen && !force) return cachedScreen;
  try {
    const screen = nodeRequire("electron")?.screen;
    if (screen) {
      const bounds = screen.getPrimaryDisplay().bounds;
      cachedScreen = { width: bounds.width, height: bounds.height };
      return cachedScreen;
    }
  } catch {}

  try {
    const out = await osascript(
      'tell application "Finder" to get bounds of window of desktop'
    );
    // AppleScript returns {left, top, right, bottom}
    const parts = out.split(",").map((n) => parseInt(n.trim(), 10));
    if (parts.length === 4 && parts[2] > parts[0] && parts[3] > parts[1]) {
      cachedScreen = { width: parts[2] - parts[0], height: parts[3] - parts[1] };
      return cachedScreen;
    }
  } catch {
    /* fall through */
  }
  cachedScreen = { width: 1440, height: 900 };
  return cachedScreen;
}

export interface Screenshot {
  data: string; // raw base64, no data: prefix
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Capture the screen and downscale to the display's *logical* resolution so
 * that 1 image pixel == 1 point == 1 cliclick coordinate. This is what makes
 * the model's pixel guesses land in the right place on a Retina display.
 */
export async function captureScreen(display?: {
  index: number;
  width: number;
  height: number;
}): Promise<Screenshot> {
  const { width, height } = display ?? (await getScreenInfo());
  const path = join(tmpdir(), `jarvis-shot-${Date.now()}.png`);
  // -D names the display explicitly, 1-indexed. Without it, screencapture's
  // behaviour with more than one monitor attached is not defined by anything
  // Jarvis controls — it may capture a different screen than the one whose
  // dimensions are then used to resize the image, which silently corrupts the
  // pixel-to-coordinate mapping the model relies on.
  const args = ["-x", "-t", "png"];
  if (display) args.push("-D", String(display.index + 1));
  args.push(path);
  const cap = await run("/usr/sbin/screencapture", args);
  if (cap.code !== 0) {
    throw new Error(
      `screencapture failed (${cap.code}). Grant Screen Recording permission in System Settings > Privacy & Security. ${cap.stderr}`
    );
  }
  // Resize in place to logical width; sips preserves aspect ratio.
  await run("/usr/bin/sips", ["--resampleWidth", String(width), path]);

  // Hand the model JPEG, not PNG. Every screenshot is carried in the
  // conversation and re-sent on each step of a long task, so the saving
  // compounds — this is what stopped the machine swapping itself to a standstill.
  //
  // Quality 90 rather than 82, decided by measurement, not taste: OCR'ing a
  // ground-truth UI-text image (11 runs, 11-16pt text) gave 100.00% identical
  // text at q90 and 99.89% at q82 — q82 dropped an apostrophe inside a file
  // path, which is exactly the kind of character that matters here. q90 is still
  // 2.4x smaller than PNG (678 KB -> 280 KB), so the accuracy is free.
  const jpg = path.replace(/\.png$/, ".jpg");
  const conv = await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", path, "--out", jpg]);
  const usable = conv.code === 0 && existsSync(jpg) ? jpg : path;

  const buf = await readFile(usable);
  unlink(path).catch(() => {});
  if (usable !== path) unlink(jpg).catch(() => {});
  return {
    data: buf.toString("base64"),
    mimeType: usable === jpg ? "image/jpeg" : "image/png",
    width,
    height,
  };
}

function clampCoords(x: number, y: number): [string, string] {
  return [String(Math.round(x)), String(Math.round(y))];
}

export async function moveMouse(x: number, y: number): Promise<string> {
  const [cx, cy] = clampCoords(x, y);
  const result = await run(CLICLICK, [`m:${cx},${cy}`]);
  if (result.code !== 0) throw new Error(`cliclick move failed: ${result.stderr || result.stdout}`);
  return `moved cursor to ${cx},${cy}`;
}

export async function click(
  x: number,
  y: number,
  button: "left" | "right" | "double" = "left"
): Promise<string> {
  const [cx, cy] = clampCoords(x, y);
  const cmd = button === "right" ? "rc" : button === "double" ? "dc" : "c";
  const result = await run(CLICLICK, [`${cmd}:${cx},${cy}`]);
  if (result.code !== 0) throw new Error(`cliclick click failed: ${result.stderr || result.stdout}`);
  return `${button} click at ${cx},${cy}`;
}

export async function dragTo(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): Promise<string> {
  const [fx, fy] = clampCoords(fromX, fromY);
  const [tx, ty] = clampCoords(toX, toY);
  await run(CLICLICK, ["-w", "10", `dd:${fx},${fy}`, `du:${tx},${ty}`]);
  return `dragged ${fx},${fy} -> ${tx},${ty}`;
}

export async function typeText(text: string): Promise<string> {
  // Interleave literal segments with return key-presses so newlines work.
  const args: string[] = ["-w", "15"];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.length) args.push(`t:${line}`);
    if (i < lines.length - 1) args.push("kp:return");
  });
  if (args.length === 2) return "nothing to type";
  await run(CLICLICK, args, 60000);
  return `typed ${text.length} characters`;
}

const MODIFIERS = new Set(["cmd", "alt", "ctrl", "shift", "fn"]);

/**
 * Press a key chord, optionally repeated. modifiers ["cmd"], key "c" => Cmd+C.
 * repeat is useful for stepping a control: arrow-up x20 nudges a slider 20 steps.
 * Single-character keys are sent as text under the held modifiers; named keys
 * (return, tab, esc, arrow-left, space, delete, f1…) go through cliclick's kp:.
 */
export async function hotkey(modifiers: string[], key: string, repeat = 1): Promise<string> {
  const mods = modifiers.map((m) => m.toLowerCase()).filter((m) => MODIFIERS.has(m));
  const reps = Math.max(1, Math.min(200, Math.round(repeat)));
  const token = key.length === 1 ? `t:${key}` : `kp:${key}`;
  const args: string[] = ["-w", "12"];
  for (const m of mods) args.push(`kd:${m}`);
  for (let i = 0; i < reps; i++) args.push(token);
  for (const m of [...mods].reverse()) args.push(`ku:${m}`);
  await run(CLICLICK, args, 60000);
  return `pressed ${[...mods, key].join("+")}${reps > 1 ? ` x${reps}` : ""}`;
}

/**
 * Scroll the frontmost window (or the control under x,y if given — hovering
 * first is how you scrub a slider/knob that reacts to the scroll wheel).
 */
export async function scroll(
  direction: "up" | "down",
  amount = 5,
  x?: number,
  y?: number
): Promise<string> {
  if (x != null && y != null) {
    const [cx, cy] = clampCoords(x, y);
    await run(CLICLICK, [`m:${cx},${cy}`]);
  }
  await osascript(
    `tell application "System Events" to scroll ${direction === "up" ? "up" : "down"}`
  ).catch(() => {});
  const key = direction === "up" ? "page-up" : "page-down";
  for (let i = 0; i < Math.max(1, Math.round(amount / 3)); i++) {
    await run(CLICLICK, [`kp:${key}`]);
  }
  return `scrolled ${direction}${x != null ? ` at ${Math.round(x)},${Math.round(y!)}` : ""}`;
}

/**
 * Set an editable field to an exact value: double-click the field to focus it,
 * select everything already there, type the new value, and commit with Return.
 * This is the reliable way to set a numeric control (e.g. a Lightroom slider's
 * value box) to a precise number instead of nudging it.
 */
export async function setValueAt(x: number, y: number, value: string): Promise<string> {
  const [cx, cy] = clampCoords(x, y);
  await run(CLICLICK, ["-w", "15", `dc:${cx},${cy}`]);
  await run(CLICLICK, ["-w", "15", "kd:cmd", "t:a", "ku:cmd"]);
  await typeText(value);
  await run(CLICLICK, ["kp:return"]);
  return `set field at ${cx},${cy} to "${value}"`;
}

export async function getMousePosition(): Promise<string> {
  const result = await run(CLICLICK, ["p"]);
  if (result.code !== 0) throw new Error(`cliclick position failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** Every app installed on this machine, for resolving what the user said. */
async function installedApps(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const out: string[] = [];
  // Utilities matters: Terminal and Activity Monitor live there, not in
  // /Applications, so omitting it made "open Terminal" report "not installed".
  const dirs = [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    // Finder and a few other core apps live here and nowhere else.
    "/System/Library/CoreServices",
    `${homedir()}/Applications`,
  ];
  for (const dir of dirs) {
    try {
      for (const entry of await readdir(dir)) {
        if (entry.endsWith(".app")) out.push(entry.replace(/\.app$/, ""));
      }
    } catch {
      /* directory may not exist */
    }
  }
  return [...new Set(out)];
}

/** Shorthand people actually say for apps whose real names are longer. */
const ALIASES: Record<string, string> = {
  "vs code": "Visual Studio Code",
  vscode: "Visual Studio Code",
  code: "Visual Studio Code",
  antigravity: "Antigravity IDE",
  chrome: "Google Chrome",
  "system settings": "System Settings",
  "system preferences": "System Settings",
  preferences: "System Settings",
  browser: "Google Chrome",
  email: "Mail",
  photoshop: "Adobe Photoshop",
  lightroom: "Adobe Lightroom",
};

/**
 * Turn what the user said into an app that actually exists.
 *
 * People say "Chrome", but the bundle is called "Google Chrome" and `open -a
 * Chrome` simply fails. Matching against what is installed means the spoken
 * name works without the user knowing the official one.
 */
export async function resolveAppName(spoken: string): Promise<string | null> {
  const want = spoken.trim().toLowerCase().replace(/\.app$/, "");
  if (!want) return null;
  const apps = await installedApps();
  const byLower = new Map(apps.map((a) => [a.toLowerCase(), a]));

  const exact = byLower.get(want);
  if (exact) return exact;

  // Known shorthand, but only when that app is really installed.
  const alias = ALIASES[want];
  if (alias && byLower.has(alias.toLowerCase())) return byLower.get(alias.toLowerCase())!;

  const contains = apps
    .filter((a) => a.toLowerCase().includes(want) || want.includes(a.toLowerCase()))
    .sort((a, b) => a.length - b.length);
  if (contains.length) return contains[0];

  // Every spoken word begins a word in the app's name: "visual code" and
  // "activity mon" both find their app without an exact substring.
  const words = want.split(/\s+/).filter(Boolean);
  const tokenMatch = apps
    .filter((a) => {
      const appWords = a.toLowerCase().split(/[\s-]+/);
      return words.every((w) => appWords.some((aw) => aw.startsWith(w)));
    })
    .sort((a, b) => a.length - b.length);
  if (tokenMatch.length) return tokenMatch[0];

  // Initials, for the way people abbreviate: "vs code" -> Visual Studio Code.
  const initials = apps
    .filter((a) => {
      const init = a.split(/[\s-]+/).map((w) => w[0]?.toLowerCase() ?? "").join("");
      return init.length > 1 && init.startsWith(want.replace(/\s+/g, ""));
    })
    .sort((a, b) => a.length - b.length);
  return initials[0] ?? null;
}

/** Is the app running and frontmost? Used to verify a launch actually worked. */
async function appIsRunning(name: string): Promise<boolean> {
  const out = await osascript(
    `tell application "System Events" to (name of processes) contains ${JSON.stringify(name)}`
  ).catch(() => "false");
  return /true/i.test(out);
}

/**
 * Open (or focus) an application, and confirm it really opened.
 *
 * This used to report `opened ${name}` whatever happened — including when both
 * the launch and the fallback failed — so Jarvis would cheerfully announce it
 * had opened Chrome while nothing appeared. Reporting failure honestly lets the
 * model try something else instead of carrying on against a window that is not
 * there.
 */
export async function openApp(name: string): Promise<string> {
  const resolved = (await resolveAppName(name)) ?? name;

  const res = await run("/usr/bin/open", ["-a", resolved]);
  if (res.code !== 0) {
    await osascript(`tell application ${JSON.stringify(resolved)} to activate`).catch(() => {});
  }

  // Launching is asynchronous; give it a moment before deciding it failed.
  for (let i = 0; i < 10; i++) {
    if (await appIsRunning(resolved)) {
      const note = resolved.toLowerCase() !== name.trim().toLowerCase() ? ` (matched "${name}")` : "";
      return `opened ${resolved}${note}`;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const available = (await installedApps()).slice(0, 40).join(", ");
  return `FAILED to open "${name}" — it does not appear to be installed or would not launch. Installed apps include: ${available}`;
}

export async function frontmostApp(): Promise<string> {
  try {
    return await osascript(
      'tell application "System Events" to get name of first process whose frontmost is true'
    );
  } catch {
    return "unknown";
  }
}

/**
 * Normalise whatever the model passed into something `open` will actually
 * accept. Without this, a bare domain ("youtube.com") or a search phrase gets
 * handed straight to `open`, which treats it as a bad path and Safari reports
 * "the address is invalid".
 */
export function normaliseUrl(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  // Already a real scheme (http, https, mailto, file, tel, custom://) — leave it.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  // A domain-ish token with no spaces (example.com, sub.site.co/uk/path) — assume https.
  if (!/\s/.test(s) && /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(s)) return `https://${s}`;
  // Anything else (a phrase, spaces) — treat as a web search.
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

export async function openUrl(url: string): Promise<string> {
  const target = normaliseUrl(url);
  if (!target) return "No URL was given to open.";
  const res = await run("/usr/bin/open", [target]);
  if (res.code !== 0) {
    return `I couldn't open ${target}${res.stderr ? ` (${res.stderr.trim()})` : ""}.`;
  }
  return `Opened ${target}`;
}
