#!/usr/bin/env node
/**
 * Permission doctor for J.A.R.V.I.S.
 *
 * macOS attaches Screen Recording / Accessibility / Microphone to the app that
 * *launches* Jarvis, not to Jarvis itself. This script reports what is actually
 * granted right now and opens the right System Settings pane.
 *
 *   node scripts/permissions.mjs         # check and report
 *   node scripts/permissions.mjs --fix   # also open the panes that need action
 */
import { execFileSync, execFile, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIX = process.argv.includes("--fix");
const ROOT = resolve(import.meta.dirname, "..");
const ELECTRON_APP = join(ROOT, "node_modules/electron/dist/Electron.app");

const PANES = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  mic: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
};

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

/** Run a tiny Swift program and return trimmed stdout, or null if it won't run. */
function swift(code) {
  try {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-perm-"));
    const file = join(dir, "check.swift");
    writeFileSync(file, code);
    return execFileSync("swift", [file], {
      encoding: "utf8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Accessibility: cliclick warns when it lacks the privilege — on STDERR, so both
 * streams have to be inspected or this silently reports a false pass.
 */
function checkAccessibility(bin) {
  if (!existsSync(bin)) return { ok: false, note: `cliclick not found at ${bin}` };
  const res = spawnSync(bin, ["-m", "test", "p"], { encoding: "utf8" });
  const blob = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.error) return { ok: false, note: res.error.message };
  return { ok: !/accessibility privileges not enabled/i.test(blob) };
}

function checkScreenRecording() {
  const out = swift("import CoreGraphics\nprint(CGPreflightScreenCaptureAccess())");
  if (out === null) return { ok: null, note: "could not run the Swift probe" };
  return { ok: out === "true" };
}

function checkCamera() {
  const out = swift(
    "import AVFoundation\nprint(AVCaptureDevice.authorizationStatus(for: .video).rawValue)"
  );
  if (out === null) return { ok: null, note: "could not run the Swift probe" };
  if (out === "3") return { ok: true };
  if (out === "0") return { ok: null, note: "not yet requested — grant on first use" };
  return { ok: false };
}

function checkMicrophone() {
  const out = swift(
    "import AVFoundation\nprint(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)"
  );
  if (out === null) return { ok: null, note: "could not run the Swift probe" };
  // 0 notDetermined, 1 restricted, 2 denied, 3 authorized
  if (out === "3") return { ok: true };
  if (out === "0") return { ok: null, note: "not yet requested — granted on first launch" };
  return { ok: false };
}

function line(label, res) {
  const mark = res.ok === true ? g("GRANTED ") : res.ok === null ? y("UNKNOWN ") : r("MISSING ");
  console.log(`  ${mark} ${label}${res.note ? dim(`  (${res.note})`) : ""}`);
}

const cliclickBin = (() => {
  for (const f of ["config.json", "config.example.json"]) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, "utf8"))?.control?.cliclickBin;
    } catch {
      /* fall through to the default */
    }
  }
  return "/opt/homebrew/bin/cliclick";
})() ?? "/opt/homebrew/bin/cliclick";

console.log(bold("\nJ.A.R.V.I.S — macOS permission check\n"));

const acc = checkAccessibility(cliclickBin);
const scr = checkScreenRecording();
const mic = checkMicrophone();
const cam = checkCamera();

line("Accessibility    — lets Jarvis move the mouse and type", acc);
line("Screen Recording — lets Jarvis see your screen", scr);
line("Microphone       — lets Jarvis hear you", mic);
line("Camera           — lets Jarvis tell if you're at your desk (optional)", cam);

console.log(bold("\nWhich app do I grant?\n"));
console.log(`  macOS grants these to the app that ${bold("launches")} Jarvis, not to Jarvis itself.`);
console.log(`  Running it with ${bold("npm start")} from a terminal means you grant the ${bold("terminal app")}`);
console.log(`  (Terminal, iTerm, Ghostty, Warp…) and/or ${bold("Electron")}:\n`);
console.log(dim(`    ${ELECTRON_APP}`));
console.log(
  `\n  ${y("Tip:")} in the Settings pane click ${bold("+")}, press ${bold(
    "Cmd+Shift+G"
  )}, paste that path, and add it.`
);
console.log(
  `  ${y("Tip:")} the surest way is to just run ${bold("npm start")} — macOS will prompt you and`
);
console.log(`  name the exact app. Grant it, then ${bold("quit and relaunch")} (permissions only`);
console.log(`  take effect on a fresh launch).\n`);

const failing = [
  acc.ok === false && ["Accessibility", PANES.accessibility],
  scr.ok !== true && ["Screen Recording", PANES.screen],
  mic.ok === false && ["Microphone", PANES.mic],
  // Camera is optional (presence detection only), so only flag an explicit deny,
  // not the not-yet-requested state.
  cam.ok === false && ["Camera", PANES.camera],
].filter(Boolean);

if (!failing.length) {
  console.log(g("All set — Jarvis can see, click, type, and listen.\n"));
  process.exit(0);
}

console.log(bold("Panes you still need:\n"));
for (const [name, url] of failing) console.log(`  ${name}\n    ${dim(url)}`);

if (FIX) {
  console.log(y("\nOpening System Settings…\n"));
  for (const [, url] of failing) execFile("open", [url]);
} else {
  console.log(dim("\n  Re-run with --fix to open these panes automatically.\n"));
}
