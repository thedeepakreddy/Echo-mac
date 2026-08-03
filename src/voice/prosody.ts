/**
 * Makes Jarvis sound like it means what it says.
 *
 * The flat, even delivery is what gives a synthetic voice away — not the timbre
 * so much as the fact that every sentence is spoken identically. macOS `say`
 * accepts embedded controls for pitch, pitch *variation*, rate and volume, and
 * varying those to suit the sentence is most of what "sounding human" is:
 *
 *   [[pbas n]]  baseline pitch — lower reads as calmer, more authoritative
 *   [[pmod n]]  pitch modulation — the single biggest robot/human difference;
 *               near zero is monotone, higher is expressive
 *   [[rate n]]  words per minute
 *   [[volm n]]  0..1
 *
 * Delivery is chosen from what is being said, so bad news is not announced in
 * the same bright tone as a success.
 */

export type Tone = "neutral" | "warm" | "pleased" | "concerned" | "urgent" | "thinking" | "wry";

interface Voicing {
  /** Baseline pitch. Lower is deeper; a male voice sits comfortably near 40. */
  pitch: number;
  /** Expressiveness. Below ~0.6 sounds robotic; above ~2 sounds theatrical. */
  modulation: number;
  rate: number;
  volume: number;
}

/**
 * Deliberately narrow ranges. Big swings sound like an impression of emotion
 * rather than emotion — the aim is a person who is interested, not an actor.
 */
const TONES: Record<Tone, Voicing> = {
  neutral:   { pitch: 40, modulation: 1.15, rate: 178, volume: 1 },
  warm:      { pitch: 38, modulation: 1.45, rate: 172, volume: 1 },
  pleased:   { pitch: 42, modulation: 1.70, rate: 184, volume: 1 },
  concerned: { pitch: 36, modulation: 0.95, rate: 164, volume: 0.97 },
  urgent:    { pitch: 46, modulation: 1.60, rate: 205, volume: 1 },
  thinking:  { pitch: 38, modulation: 0.85, rate: 168, volume: 0.94 },
  wry:       { pitch: 39, modulation: 1.55, rate: 170, volume: 0.98 },
};

/** Work out how a line should be delivered from what it says. */
export function toneFor(text: string): Tone {
  const t = (text ?? "").toLowerCase();

  // Trouble first — never announce a failure brightly.
  if (/\b(error|failed|failing|broke|broken|crash|denied|couldn't|cannot|unable|sorry|wrong)\b/.test(t)) {
    return "concerned";
  }
  if (/\b(careful|warning|about to|are you sure|permanently|irreversible|delete|overwrite)\b/.test(t)) {
    return "urgent";
  }
  if (/\b(done|finished|complete|completed|success|passed|working|fixed|ready|saved|sent)\b/.test(t)) {
    return "pleased";
  }
  if (/\b(let me|i'll|i will|checking|looking|searching|one moment|working on)\b/.test(t)) {
    return "thinking";
  }
  if (/\?\s*$/.test(text.trim())) return "warm"; // questions rise, they don't flatten
  if (/\b(good morning|good evening|hello|hi there|welcome back|of course|happy to)\b/.test(t)) {
    return "warm";
  }
  return "neutral";
}

/**
 * Punctuation that buys a breath.
 *
 * Synthesised speech runs sentences together; a person pauses. `[[slnc ms]]`
 * inserts real silence, and a short beat after a full stop does more for
 * naturalness than any pitch setting.
 */
function addBreaths(text: string): string {
  return text
    // A beat between sentences.
    .replace(/([.!?])\s+(?=[A-Z"'])/g, "$1 [[slnc 260]] ")
    // A shorter one after a clause break, where a person would draw breath.
    .replace(/([,;:])\s+/g, "$1 [[slnc 110]] ")
    // A longer one before a correction or aside, which is where people pause most.
    .replace(/\s+(—|--)\s+/g, " [[slnc 200]] ");
}

/**
 * Strip anything that would be read aloud as punctuation soup.
 *
 * Markdown, code fences and URLs are written for the eye. Spoken verbatim they
 * are unbearable, and they are the main reason assistants sound like they are
 * reading a screen rather than talking to you.
 */
export function speakableText(text: string): string {
  return (text ?? "")
    .replace(/```[\s\S]*?```/g, " the code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // A bare URL read character by character is torture.
    .replace(/https?:\/\/\S+/g, " the link ")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Wrap text with the controls that give it a delivery.
 * @param tone override the automatic choice
 */
export function withProsody(text: string, tone?: Tone): string {
  const clean = speakableText(text);
  if (!clean) return "";
  const v = TONES[tone ?? toneFor(clean)];
  // Controls must lead, before any spoken word, or they apply mid-sentence.
  return `[[pbas ${v.pitch}]][[pmod ${v.modulation}]][[rate ${v.rate}]][[volm ${v.volume}]] ${addBreaths(clean)}`;
}

/** For logging and tests: what delivery would this line get? */
export function describeDelivery(text: string): string {
  const tone = toneFor(speakableText(text));
  const v = TONES[tone];
  return `${tone} (pitch ${v.pitch}, expression ${v.modulation}, ${v.rate} wpm)`;
}
