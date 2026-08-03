/**
 * Keyless wake-word detection over a transcript.
 *
 * Instead of a dedicated always-on keyword model (Porcupine needs an API key,
 * Vosk's Node bindings are stuck on the unmaintained ffi-napi, openWakeWord is
 * Python-first), we let whisper.cpp — already installed and used for commands —
 * transcribe each spoken utterance once and look for "Jarvis" at the front.
 * Whisper's cost is dominated by loading the model, so checking the transcript
 * we were producing anyway is effectively free, and nothing leaves the machine.
 *
 * Matching is deliberately forgiving. Whisper has no context to anchor on when
 * a name is the first thing said, so it produces things like "Javis", "Jervis",
 * or — observed in testing — "Hijavis" for "Hey Jarvis", with the greeting and
 * the name run together into a single token.
 */

const TARGET = "echo";

/** Spellings whisper actually emits for the name. */
const VARIANTS = new Set([
  "echo",
  "ecco",
  "ekko",
  "eko",
  "ecko",
  "eccho",
  "eco",
]);

const PREFIXES = ["hey", "okay", "ok", "hello", "yo", "hi"];

const strip = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** Levenshtein distance, capped work for the short strings we compare. */
function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 99; // far too different to be the name
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** Is this token the name, allowing for whisper's mishearings? */
function isName(token: string): boolean {
  const t = strip(token);
  if (!t) return false;
  if (VARIANTS.has(t)) return true;
  // Catch spellings not enumerated above without matching unrelated words.
  // Echo is short, so we only allow 1 typo.
  return t.length >= 3 && t.length <= 6 && distance(t, TARGET) <= 1;
}

/** Handles "hijavis" / "heyjarvis" — greeting and name fused into one token. */
function isMergedGreetingAndName(token: string): boolean {
  const t = strip(token);
  return PREFIXES.some((p) => t.startsWith(p) && t.length > p.length && isName(t.slice(p.length)));
}

const isPrefix = (token: string) => PREFIXES.includes(strip(token));

export interface WakeMatch {
  /** Did the utterance start with the wake word? */
  matched: boolean;
  /** The command with the wake word stripped ("" if they only said the name). */
  command: string;
}

/**
 * Test a transcript for the wake word and return whatever followed it.
 *
 * Scans the whole utterance rather than only its first word. Silence-based
 * endpointing does not segment on sentence boundaries, so in practice the name
 * frequently lands mid-transcript — an observed capture read
 * "Good job is how are you doing? Jarvis what is on", where an opening-token
 * check threw away a perfectly good command.
 *
 * Everything after the FIRST occurrence becomes the command, so
 * "Jarvis, tell me about Jarvis" keeps its full instruction. The cost is that
 * mentioning the name to another person can trigger a command; recall matters
 * more here, since a missed command reads as Jarvis being broken.
 */
export function matchWakeWord(transcript: string): WakeMatch {
  // Whisper annotates non-speech as [BLANK_AUDIO], (wind blowing), *sighs*.
  let text = (transcript ?? "").replace(/\[.*?\]|\(.*?\)|\*.*?\*/g, " ").trim();
  
  // Normalize Whisper mishearings that span multiple tokens
  text = text.replace(/\bi go\b/gi, "echo");
  
  if (!text) return { matched: false, command: "" };

  const tokens = text.split(/\s+/);

  /**
   * Does this token contain the name once inner punctuation is split off?
   *
   * Whisper hyphenates mishearings — an observed capture rendered "Hey Jarvis"
   * as "Hage-arvis", a single 9-character token that no whole-word check could
   * match, even though its second half is one edit from "jarvis".
   */
  const containsName = (token: string): boolean => {
    if (isName(token) || isMergedGreetingAndName(token)) return true;
    const parts = token.split(/[^A-Za-z]+/).filter((p) => p.length > 2);
    if (parts.length < 2) return false;
    return parts.some((p) => isName(p) || isMergedGreetingAndName(p));
  };

  for (let i = 0; i < tokens.length; i++) {
    let consumed = 0;
    if (containsName(tokens[i])) {
      consumed = 1;
    } else if (isPrefix(tokens[i]) && tokens[i + 1] && containsName(tokens[i + 1])) {
      consumed = 2;
    }
    if (!consumed) continue;

    // Drop punctuation that trailed the name ("Jarvis, open…" -> "open…").
    const command = tokens
      .slice(i + consumed)
      .join(" ")
      .replace(/^[\s\p{P}]+/u, "")
      .trim();
    return { matched: true, command };
  }

  return { matched: false, command: "" };
}

/** True when they said the name and nothing else. */
export function isNameOnly(command: string): boolean {
  return command.replace(/[\s\p{P}]/gu, "").length === 0;
}
