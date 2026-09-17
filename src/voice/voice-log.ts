import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

/**
 * The voice pipeline's own event log.
 *
 * The agent run log (agent-replay/loop-log.ts) starts when a brain turn starts,
 * which is far too late for the questions this answers: was the wake word
 * heard, how long did endpointing take, when did the first audio actually
 * leave the speaker. Every stage stamps an event here with the turn it belongs
 * to, and the per-turn summary turns the stamps into the numbers that matter —
 * above all `first_audio_ms`, the gap between the user going quiet and Echo
 * starting to talk, which is what "fast" means to a person.
 *
 * One JSONL file per app launch under runs/voice/, plus a compact console line
 * per event so a live `npm start` shows the pipeline breathing.
 */

export type VoiceEventType =
  | "session.start"
  | "state"
  | "wake.detected"
  | "wake.ack"
  | "vad.speech_start"
  | "vad.speech_end"
  | "capture.start"
  | "capture.end"
  | "capture.discarded"
  | "stt.partial"
  | "stt.final"
  | "brain.send"
  | "llm.first_text"
  | "llm.text"
  | "llm.done"
  | "tts.first_audio"
  | "audio.start"
  | "audio.end"
  | "audio.stopped"
  | "barge_in"
  | "cancel"
  | "window.open"
  | "window.extend"
  | "window.close"
  | "turn.summary"
  | "note";

export interface VoiceEvent {
  seq: number;
  ts: number;
  iso: string;
  /** performance.now() — monotonic, what the latencies are computed from. */
  mono: number;
  type: VoiceEventType;
  turnId?: string;
  [key: string]: unknown;
}

/** The derived timings for one turn, all relative to the end of user speech. */
export interface TurnSummary {
  turnId: string;
  /** Detection → acknowledgement shown/heard. */
  wake_ack_ms: number | null;
  /** End of speech → capture closed (how long endpointing took). */
  endpoint_ms: number | null;
  /** End of speech → final transcript in hand. */
  stt_final_ms: number | null;
  /** End of speech → first text from the model. */
  first_token_ms: number | null;
  /** End of speech → first audible audio. THE number. */
  first_audio_ms: number | null;
  /** Barge-in → audio actually stopped. */
  cancel_ms: number | null;
  /** How the turn started. */
  wake?: string;
  transcript?: string;
}

const STAMP_EVENTS: VoiceEventType[] = [
  "wake.detected", "wake.ack", "vad.speech_start", "vad.speech_end", "capture.start", "capture.end",
  "stt.final", "brain.send", "llm.first_text", "llm.done", "tts.first_audio", "audio.start",
  "audio.end", "audio.stopped", "barge_in", "cancel",
];

/** Payload keys worth showing on the console line; the rest stays in the file. */
const SHOWN = ["state", "prev", "engine", "reason", "why", "ms", "score", "level", "bar", "text", "chars", "provider", "wake", "sentence"];

class VoiceLog {
  private file: string | null = null;
  private seq = 0;
  private marks = new Map<string, Map<string, number>>();
  private meta = new Map<string, { wake?: string; transcript?: string }>();
  private quiet = false;

  /** Choose the file for this launch. Safe to call more than once. */
  init(appRoot: string, options: { quiet?: boolean } = {}): string | null {
    this.quiet = options.quiet ?? false;
    if (this.file) return this.file;
    try {
      const dir = join(appRoot, "runs", "voice");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.file = join(dir, `${stamp}.jsonl`);
      this.event("session.start", { pid: process.pid });
      return this.file;
    } catch (err) {
      console.error("[voice] log unavailable:", (err as any)?.message ?? err);
      this.file = null;
      return null;
    }
  }

  get path(): string | null {
    return this.file;
  }

  /** Stamp one event. Returns the monotonic time it was stamped at. */
  event(type: VoiceEventType, payload: Record<string, unknown> = {}): number {
    const mono = performance.now();
    const ev: VoiceEvent = {
      seq: this.seq++,
      ts: Date.now(),
      iso: new Date().toISOString(),
      mono,
      type,
      ...payload,
    } as VoiceEvent;
    const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
    if (turnId && STAMP_EVENTS.includes(type)) {
      if (!this.marks.has(turnId)) this.marks.set(turnId, new Map());
      const m = this.marks.get(turnId)!;
      // First occurrence wins: "first text" is the first text.
      if (!m.has(type)) m.set(type, mono);
    }
    if (turnId && (payload.wake || payload.transcript)) {
      const cur = this.meta.get(turnId) ?? {};
      if (typeof payload.wake === "string") cur.wake = payload.wake;
      if (typeof payload.transcript === "string") cur.transcript = payload.transcript;
      this.meta.set(turnId, cur);
    }
    if (this.file) {
      try {
        appendFileSync(this.file, JSON.stringify(ev) + "\n");
      } catch {
        /* a full disk must not take the voice down */
      }
    }
    if (!this.quiet && type !== "stt.partial") {
      const shown = SHOWN.filter((k) => payload[k] !== undefined)
        .map((k) => `${k}=${typeof payload[k] === "string" ? JSON.stringify(payload[k]) : payload[k]}`)
        .join(" ");
      console.log(`[voice] ${type}${turnId ? ` ${turnId}` : ""}${shown ? " " + shown : ""}`);
    }
    return mono;
  }

  /** Just the stamp, for stages that report their own time (e.g. the player). */
  stampAt(type: VoiceEventType, turnId: string, mono: number): void {
    if (!this.marks.has(turnId)) this.marks.set(turnId, new Map());
    const m = this.marks.get(turnId)!;
    if (!m.has(type)) m.set(type, mono);
  }

  /** Compute the timings for a turn from what has been stamped so far. */
  summarize(turnId: string): TurnSummary {
    const m = this.marks.get(turnId) ?? new Map<string, number>();
    const at = (t: VoiceEventType) => m.get(t);
    // The end of user speech is the anchor. Prefer the VAD's word for it; a
    // capture that ended on a silence timer knows when the silence began.
    const speechEnd = at("vad.speech_end");
    const diff = (a?: number, b?: number) => (a !== undefined && b !== undefined ? Math.round(a - b) : null);
    const meta = this.meta.get(turnId) ?? {};
    return {
      turnId,
      wake_ack_ms: diff(at("wake.ack"), at("wake.detected")),
      endpoint_ms: diff(at("capture.end"), speechEnd),
      stt_final_ms: diff(at("stt.final"), speechEnd),
      first_token_ms: diff(at("llm.first_text"), speechEnd),
      first_audio_ms: diff(at("audio.start") ?? at("tts.first_audio"), speechEnd),
      cancel_ms: diff(at("audio.stopped"), at("barge_in")),
      wake: meta.wake,
      transcript: meta.transcript,
    };
  }

  /** Write the summary line for a finished turn and forget its stamps. */
  finishTurn(turnId: string): TurnSummary {
    const s = this.summarize(turnId);
    this.event("turn.summary", { ...s });
    this.marks.delete(turnId);
    this.meta.delete(turnId);
    return s;
  }
}

export const voiceLog = new VoiceLog();

/** Human line for a summary, shared by the console and `npm run voicelog`. */
export function describeSummary(s: TurnSummary): string {
  const f = (n: number | null) => (n === null ? "  —  " : `${String(n).padStart(5)}ms`);
  return `${s.turnId.padEnd(5)} first_audio ${f(s.first_audio_ms)} · stt ${f(s.stt_final_ms)} · first_token ${f(s.first_token_ms)} · endpoint ${f(s.endpoint_ms)}${s.cancel_ms !== null ? ` · cancel ${f(s.cancel_ms)}` : ""}${s.wake ? ` · ${s.wake}` : ""}`;
}
