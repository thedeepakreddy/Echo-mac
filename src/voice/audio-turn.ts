import { statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import type { AudioTurn } from "../brain/types.js";

/**
 * The recording of a spoken turn, on its way to a brain that can listen to it.
 *
 * Echo's ear has always been a transcriber: audio in, string out, and the model
 * only ever saw the string. Everything that is not a word — the tone, the
 * emphasis, the hesitation, whether it was an order or a joke, whether the
 * Telugu word was the one whisper guessed — was thrown away before the brain
 * saw anything. This is the path that keeps it: the same WAV the transcriber
 * read is attached to the turn, and the transcript rides along as a fallible
 * second opinion rather than the only evidence.
 *
 * Three deliberate limits:
 *
 *   - the wake-word pass stays local. Only an utterance that was actually
 *     addressed to Echo ever gets here, exactly as before.
 *   - it is off unless asked for. On the local-whisper route audio currently
 *     never leaves the machine, and turning that around should be a choice
 *     somebody made, not a default they inherited.
 *   - it is sent once. The agent loop can run a hundred iterations off one
 *     spoken command; re-uploading the recording on every one of them would be
 *     absurd, so the brain strips it from its history after the first reply.
 */

/**
 * Biggest recording worth sending. The listener caps an utterance at 15s, which
 * is about 480KB of 16kHz mono PCM — this is roomy enough for a raised cap and
 * small enough that a runaway capture is never uploaded.
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** Canonical WAV header the listener writes: 44 bytes, PCM, mono. */
const HEADER_BYTES = 44;

/**
 * How much of the front of a file to read when measuring it.
 *
 * Not 44: a canonical header is that long, but plenty of WAVs put LIST/fact
 * chunks before the samples — macOS `say` does — and assuming the data chunk
 * starts at byte 36 measured those as "unknown length".
 */
const HEADER_SCAN_BYTES = 4096;

/**
 * How long a WAV runs, read from its header alone.
 *
 * The bytes matter more than the seconds here: audio is billed by duration, and
 * a log line saying "3.2s of audio" is the one number that makes the cost of
 * this feature legible while it is running.
 */
export function wavDurationMs(header: Buffer): number | undefined {
  if (header.length < HEADER_BYTES) return undefined;
  if (header.toString("ascii", 0, 4) !== "RIFF") return undefined;
  if (header.toString("ascii", 8, 12) !== "WAVE") return undefined;

  // Walk the chunk list rather than trusting fixed offsets. Chunks are
  // word-aligned, so an odd size is followed by a pad byte.
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= header.length) {
    const id = header.toString("ascii", offset, offset + 4);
    const size = header.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 24 <= header.length) {
      byteRate = header.readUInt32LE(offset + 16);
    } else if (id === "data") {
      return byteRate && size ? Math.round((size / byteRate) * 1000) : undefined;
    }
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

/** Read just the header of a WAV, without pulling the samples into memory. */
function readHeader(path: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(HEADER_SCAN_BYTES);
    const read = readSync(fd, buf, 0, HEADER_SCAN_BYTES, 0);
    return read >= HEADER_BYTES ? buf.subarray(0, read) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Describe a captured WAV, or nothing if it isn't a readable one. */
export function describeAudio(path: string): AudioTurn | null {
  try {
    const bytes = statSync(path).size;
    if (!bytes) return null;
    const header = readHeader(path);
    return {
      path,
      mimeType: "audio/wav",
      bytes,
      durationMs: header ? wavDurationMs(header) : undefined,
    };
  } catch {
    return null; // the capture was cleaned up, or never landed
  }
}

/**
 * Decide whether this turn's recording goes to the brain.
 *
 * Both switches have to be on: the user has to have asked for it, and the brain
 * has to be able to hear. A brain that cannot would otherwise be handed bytes it
 * silently drops, which reads as a working feature and is not one.
 */
export function audioTurnFor(
  path: string,
  opts: { enabled: boolean; hearsAudio: boolean; maxBytes?: number }
): AudioTurn | null {
  if (!opts.enabled || !opts.hearsAudio || !path) return null;
  const turn = describeAudio(path);
  if (!turn) return null;
  if ((turn.bytes ?? 0) > (opts.maxBytes ?? MAX_AUDIO_BYTES)) return null;
  return turn;
}

/** "3.2s" — for the one log line that makes this feature's cost visible. */
export function describeTurn(turn: AudioTurn): string {
  const secs = turn.durationMs ? (turn.durationMs / 1000).toFixed(1) : "?";
  return `${secs}s (${Math.round((turn.bytes ?? 0) / 1024)}KB)`;
}

/**
 * The recording as a Gemini content part.
 *
 * Gemini's shape lives here rather than in the brain because it is the only
 * wire format that takes audio today, and keeping it beside the reader means
 * one file to change when a second one appears. Returns null rather than
 * throwing: a turn that loses its audio should still be a turn.
 */
export function toInlineDataPart(turn: AudioTurn): { inlineData: { mimeType: string; data: string } } | null {
  try {
    return {
      inlineData: {
        mimeType: turn.mimeType || "audio/wav",
        data: readFileSync(turn.path).toString("base64"),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Drop recordings out of a conversation history, in place.
 *
 * Called once the model has answered the turn it was listening to. After that
 * the audio is dead weight — re-sent on every iteration of the agent loop,
 * counted by every token estimate, and trimmed against by the history limiter —
 * while the transcript beside it already says what was asked. Returns how many
 * were dropped, which is what the test asserts on.
 */
export function stripAudioParts(contents: any[]): number {
  let dropped = 0;
  for (const entry of contents ?? []) {
    if (!Array.isArray(entry?.parts)) continue;
    const kept = entry.parts.filter((p: any) => !p?.inlineData?.mimeType?.startsWith?.("audio/"));
    if (kept.length !== entry.parts.length) {
      dropped += entry.parts.length - kept.length;
      // Never leave an entry with no parts at all — an empty content block is
      // rejected by the API, which would break the whole conversation rather
      // than just this turn.
      entry.parts = kept.length ? kept : [{ text: "(spoken)" }];
    }
  }
  return dropped;
}
