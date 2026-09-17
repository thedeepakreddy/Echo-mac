import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Vocabulary hint given to the speech recogniser before it listens.
 *
 * Whisper accepts an "initial prompt" that biases decoding toward words it
 * expects. Measured on real command audio, adding one cut the word error rate
 * from 6.5% to 4.8% and fixed tense errors outright ("increased" -> "increase")
 * — a larger model did not help nearly as much, and small.en was actually WORSE
 * without a prompt because it hallucinated more on short clips.
 *
 * The list is built from this machine rather than hardcoded: your installed
 * apps, your shortcut phrases, your learned workflow names. Recognition should
 * lean toward the words you actually say, not a generic list.
 */

/** Words Echo needs to hear correctly no matter what. */
const CORE = [
  "Echo", "Hey Echo", "Jarvis",
  "screenshot", "brightness", "volume", "workflow", "undo", "redo",
  "clipboard", "terminal", "browser", "tab", "window", "folder",
  "compile", "build", "deploy", "commit", "push", "pull request",
  "TypeScript", "JavaScript", "Python", "npm", "pnpm", "git", "GitHub",
  "extract", "table", "spreadsheet", "calendar", "reminder", "message",
  "hand gestures", "eye tracking", "presence", "meeting", "transcript",
];

/** Apps worth recognising even if they are not currently installed. */
const COMMON_APPS = [
  "Visual Studio Code", "Chrome", "Safari", "Brave", "Terminal", "Finder",
  "Mail", "Messages", "Calendar", "Notes", "Slack", "Spotify", "Figma",
  "Lightroom", "Photoshop", "Notion", "Xcode", "Antigravity",
];

const MAX_TERMS = 90; // an over-long prompt starts crowding out the audio itself

function installedApps(): string[] {
  const out: string[] = [];
  for (const dir of ["/Applications", join(homedir(), "Applications")]) {
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.endsWith(".app")) out.push(entry.replace(/\.app$/, ""));
      }
    } catch {
      /* directory may not exist */
    }
  }
  return out;
}

function shortcutPhrases(appRoot: string): string[] {
  const p = join(appRoot, "shortcuts.json");
  if (!existsSync(p)) return [];
  try {
    return Object.keys(JSON.parse(readFileSync(p, "utf8"))).map((k) => k.replace(/\*/g, "").trim());
  } catch {
    return [];
  }
}

function workflowNames(): string[] {
  const dir = join(homedir(), ".jarvis", "workflows");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, "").replace(/-/g, " "));
  } catch {
    return [];
  }
}

/**
 * Build the prompt. Ordered by importance because it is truncated: the wake
 * word and command verbs matter more than the twentieth installed app.
 */
export function buildVocabulary(appRoot: string): string {
  const seen = new Set<string>();
  const terms: string[] = [];

  const add = (term: string) => {
    const t = term.trim();
    const key = t.toLowerCase();
    if (!t || t.length > 30 || seen.has(key) || terms.length >= MAX_TERMS) return;
    seen.add(key);
    terms.push(t);
  };

  CORE.forEach(add);
  // What the user has actually taught Jarvis outranks generic app names.
  workflowNames().forEach(add);
  shortcutPhrases(appRoot).forEach(add);
  COMMON_APPS.forEach(add);
  installedApps().forEach(add);

  // Phrased as a sentence: whisper conditions on this as if it were preceding
  // speech, so a natural sentence biases better than a bare word list.
  // The name leads: it is the one word whisper must not rewrite, and the
  // prompt used to say "Jarvis" long after the assistant was renamed — which
  // steered decoding AWAY from the actual wake word on every utterance.
  return `Echo is a voice assistant for a Mac. Likely words: ${terms.join(", ")}.`;
}

/**
 * Whisper invents text when it hears near-silence — "(laughing)", "Thank you.",
 * "you", a lone period. These reliably appear in the log as phantom commands, so
 * they are discarded rather than sent to the brain.
 */
const HALLUCINATIONS = [
  /^\s*$/,
  /^[\s.,!?'"-]*$/,
  /^\s*(thank you|thanks|you|bye|okay|ok|uh|um|hmm|mm|ah|oh)[.!]?\s*$/i,
  /^\s*(thanks for watching|subscribe|the end|silence)[.!]?\s*$/i,
  /^\s*\[.*\]\s*$/,
  /^\s*\(.*\)\s*$/,
  /^\s*♪+\s*$/,
];

/** True when a transcript is almost certainly noise rather than speech. */
export function isHallucination(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  if (HALLUCINATIONS.some((re) => re.test(t))) return true;
  // A single short token with no vowel is not a real command.
  const letters = t.replace(/[^a-z]/gi, "");
  return letters.length < 2 || !/[aeiou]/i.test(letters);
}
