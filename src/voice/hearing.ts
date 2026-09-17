import { readFileSync } from "node:fs";
import type { JarvisConfig } from "../config.js";
import { GEMINI_MODEL_FALLBACKS, type AudioTurn } from "../brain/types.js";

/**
 * The hearing pass: ears for a brain that has none.
 *
 * Only one of Echo's brains can listen to a recording (Gemini). Claude's Agent
 * SDK loop and the local Ollama models take text, and they are what Echo
 * actually runs most days — so "let Echo hear" would have been a feature that
 * only works after switching brains, which is not a feature.
 *
 * This closes that gap: one short call hands the same recording to Gemini and
 * asks two things of it — what was really said, and how it was said. The answer
 * goes to whichever brain is running as its transcript plus a one-line note.
 * Second-hand hearing rather than the real thing, but it is the difference
 * between a model that reads "no don't" and one that knows it was shouted.
 *
 * It REPLACES the cloud transcription rather than adding to it: the local
 * whisper pass still gates the wake word, and this produces the transcript the
 * brain works from. So the round trip is the one Echo was already paying for.
 */

export interface Heard {
  /** What was actually said, verbatim, in the language it was said in. */
  transcript: string;
  /** A short phrase on HOW it was said, when that would change the reply. */
  tone?: string;
}

/**
 * What the ear is asked for.
 *
 * Strict about two things, both learned from what transcribers get wrong here:
 * no translation (a Telugu sentence must come back Telugu), and no commentary
 * dressed up as speech. The tone field is deliberately allowed to be empty —
 * an assistant that announces a mood on every ordinary sentence is worse than
 * one that never mentions it.
 */
export const HEARING_PROMPT = `You are the ear of a voice assistant. You are given one short recording of a person speaking to it.

Reply with ONLY a JSON object, no code fence, no commentary:
{"transcript": "...", "tone": "..."}

transcript — exactly what the speaker said, word for word, in the language(s) they actually used. Keep English/Telugu/Hindi code-switching exactly as spoken; never translate. Do not add, tidy, complete or answer anything. Use "" if nothing intelligible was said.

tone — at most six words on HOW it was said: pace, mood, certainty, or if it sounds like someone other than the user speaking. Only when it would change how an assistant should respond. When it is an ordinary, level sentence use "" — the empty string itself, never the word "ordinary" or "neutral".

A machine transcript of the same audio follows as a hint. It is frequently wrong on names, numbers and on Indian-language words. Correct it from what you hear.`;

/** Is there a key to do this with? Without one the bridge simply never runs. */
export function hearingAvailable(cfg: JarvisConfig): boolean {
  return !!process.env[cfg.gemini?.apiKeyEnv ?? "GEMINI_API_KEY"]?.trim();
}

/**
 * Whether this turn goes through the bridge.
 *
 * Not when the brain can hear for itself — that path is strictly better, since
 * the model reasons about the audio directly instead of reading someone else's
 * summary of it.
 */
export function useHearingBridge(cfg: JarvisConfig, brainHearsAudio: boolean): boolean {
  return cfg.voice?.sendAudioToBrain === true && !brainHearsAudio && hearingAvailable(cfg);
}

/**
 * Pull the answer out of whatever the model wrapped it in.
 *
 * Models fence JSON about half the time however plainly you ask them not to,
 * and a fenced reply is a correct answer badly packaged — worth unwrapping
 * rather than discarding, because the alternative is dropping the turn.
 */
/**
 * Tone words that say nothing.
 *
 * Asked for "" when a sentence is unremarkable, models answer "ordinary" or
 * "neutral" instead about half the time — measured on the first real recording
 * this was run against. Passing that through would staple "(heard: ordinary)"
 * onto almost every turn: noise in the prompt, and a note that trains the brain
 * to ignore the notes that do matter.
 */
const NO_SIGNAL = /^(ordinary|normal|neutral|none|nothing|n\/?a|unremarkable|plain|standard|calm|flat|regular|usual|clear)[.,!]?$/i;

export function parseHeard(raw: string): Heard | null {
  if (!raw) return null;
  const body = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    const transcript = typeof parsed?.transcript === "string" ? parsed.transcript.trim() : "";
    const tone = typeof parsed?.tone === "string" ? parsed.tone.trim() : "";
    if (!transcript) return null;
    return { transcript, tone: tone && !NO_SIGNAL.test(tone) ? tone : undefined };
  } catch {
    return null;
  }
}

/**
 * Models to try, in order, for one utterance.
 *
 * The configured brain model first, then smaller ones. This is a per-turn call
 * on a free-tier key where a single model gets twenty requests a day — measured
 * the hard way, with a 429 on the first real test — so exhausting one model must
 * not mean Echo stops hearing. Anything that fails twice falls back to ordinary
 * transcription, which is where the caller goes when this returns null.
 */
export function hearingModels(cfg: JarvisConfig): string[] {
  const configured = cfg.gemini?.model?.trim();
  return [...new Set([configured, ...GEMINI_MODEL_FALLBACKS].filter(Boolean) as string[])];
}

/** A failure worth trying another model for, rather than giving up on. */
function isExhausted(message: string): boolean {
  return /429|RESOURCE_EXHAUSTED|quota|404|NOT_FOUND|no longer available|503|UNAVAILABLE/i.test(message);
}

/** Attach what was heard to what was said, for a brain that can only read. */
export function withTone(text: string, tone?: string): string {
  return tone ? `${text}\n\n(heard: ${tone})` : text;
}

/**
 * Listen to one utterance. Returns null on any failure, because the caller
 * always has the ordinary transcription to fall back on and a spoken command
 * must never be lost to this.
 */
export async function listen(
  turn: AudioTurn,
  cfg: JarvisConfig,
  hint?: string
): Promise<Heard | null> {
  const key = process.env[cfg.gemini?.apiKeyEnv ?? "GEMINI_API_KEY"]?.trim();
  if (!key) return null;

  let audio: string;
  let ai: any;
  try {
    const { GoogleGenAI } = await import("@google/genai");
    ai = new GoogleGenAI({ apiKey: key });
    audio = readFileSync(turn.path).toString("base64");
  } catch (err: any) {
    console.error(`[jarvis] hearing pass could not read the capture: ${err?.message ?? err}`);
    return null;
  }

  const contents = [
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: turn.mimeType || "audio/wav", data: audio } },
        { text: `${HEARING_PROMPT}\n\nMachine transcript hint: ${JSON.stringify(hint ?? "")}` },
      ],
    },
  ];

  for (const model of hearingModels(cfg)) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents,
        // No tools and no temperature: this is a transcription, not a turn of
        // the agent loop, and it sits in front of every spoken command.
        config: { temperature: 0 },
      });
      const text = (res as any)?.candidates?.[0]?.content?.parts
        ?.map((p: any) => p?.text ?? "")
        .join("")
        .trim();
      const heard = parseHeard(text ?? "");
      if (heard) return heard;
      // A reply that parsed to nothing is the model's answer, not the model's
      // absence — another model would most likely say the same of the same
      // audio, so stop rather than spending a second request on it.
      return null;
    } catch (err: any) {
      const message = String(err?.message ?? err);
      if (!isExhausted(message)) {
        console.error(`[jarvis] hearing pass failed: ${message.slice(0, 200)}`);
        return null;
      }
      console.warn(`[jarvis] hearing pass: ${model} unavailable, trying the next model`);
    }
  }
  return null;
}
