import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where API keys live once Jarvis is an installed app.
 *
 * They cannot sit beside the executable: an installed .app bundle is read-only,
 * and anything written there would be destroyed by the next update anyway. This
 * keeps them in the user's own directory, which survives updates and is theirs
 * to inspect or delete.
 *
 * The file is chmod 600 — readable only by its owner. Keys in a world-readable
 * file are a real exposure on a shared machine, and the default umask does not
 * guarantee otherwise.
 */

const DIR = join(homedir(), ".jarvis");
const FILE = join(DIR, "keys.env");

export const keysPath = FILE;

/** The keys Jarvis knows how to use, with what each unlocks. */
export interface KeyField {
  env: string;
  label: string;
  help: string;
  /** Where the user gets one. */
  url: string;
  /** Jarvis works without it. */
  optional: boolean;
  /** Rough shape check, to catch a mis-paste before it fails at runtime. */
  looksValid?: (v: string) => boolean;
}

export const KEY_FIELDS: KeyField[] = [
  {
    env: "ANTHROPIC_API_KEY",
    label: "Claude",
    help: "Powers the main brain. Leave blank if you signed in with a Claude subscription instead.",
    url: "https://console.anthropic.com/settings/keys",
    optional: true,
    looksValid: (v) => v.startsWith("sk-ant-"),
  },
  {
    env: "GEMINI_API_KEY",
    label: "Gemini",
    help: "An alternative brain you can switch to by voice.",
    url: "https://aistudio.google.com/apikey",
    optional: true,
  },
  {
    env: "ELEVENLABS_API_KEY",
    label: "ElevenLabs",
    help: "A more natural speaking voice. Without it Jarvis uses the built-in macOS voice.",
    url: "https://elevenlabs.io/app/settings/api-keys",
    optional: true,
  },
  {
    env: "PICOVOICE_ACCESS_KEY",
    label: "Picovoice",
    help: "A dedicated wake-word engine. Without it the name is detected from speech, which works fine.",
    url: "https://console.picovoice.ai",
    optional: true,
  },
];

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && /^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    if (v) out[k] = v;
  }
  return out;
}

export function readKeys(): Record<string, string> {
  if (!existsSync(FILE)) return {};
  try {
    return parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Save keys, replacing what was there. Blank values remove a key. */
export function writeKeys(keys: Record<string, string>): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

  const lines = [
    "# J.A.R.V.I.S API keys.",
    "# Written by the Setup window; safe to edit by hand.",
    "# Delete a line to remove that key.",
    "",
  ];
  for (const field of KEY_FIELDS) {
    const v = (keys[field.env] ?? "").trim();
    if (v) lines.push(`${field.env}=${v}`);
  }
  writeFileSync(FILE, lines.join("\n") + "\n");
  try {
    chmodSync(FILE, 0o600); // owner-only: these are credentials
  } catch {
    /* a filesystem without permissions is not worth failing over */
  }
}

/** Put saved keys into the environment. Real env vars still win. */
export function applyKeys(): string[] {
  const applied: string[] = [];
  for (const [k, v] of Object.entries(readKeys())) {
    if (process.env[k] !== undefined) continue;
    process.env[k] = v;
    applied.push(k);
  }
  return applied;
}

/** True when nothing is configured — used to show Setup on a first run. */
export function needsSetup(): boolean {
  const keys = readKeys();
  const anyKey = KEY_FIELDS.some((f) => (keys[f.env] ?? process.env[f.env] ?? "").trim());
  return !anyKey;
}
