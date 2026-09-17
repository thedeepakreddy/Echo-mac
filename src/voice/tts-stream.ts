import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { JarvisConfig } from "../config.js";
import { withProsody } from "./prosody.js";

/**
 * Streaming text-to-speech: sentences in, PCM out, as soon as each is ready.
 *
 * The file path (tts.ts) asked for the whole reply, waited for the whole audio
 * body (Sarvam: 1.5 s to the first byte, 1.9 s to the last), wrote a file and
 * spawned a player. These adapters keep one connection open per turn, send
 * each sentence the moment the chunker releases it, and hand back audio in
 * pieces to the persistent player — so the first sentence is playing while
 * the second is still being written by the model.
 *
 * Every adapter emits raw 16-bit PCM at `sampleRate`; the player does the rest.
 */

export interface TtsAudio {
  pcm: Buffer;
  sampleRate: number;
  /** Index of the sentence this audio belongs to, in the order spoken. */
  sentence: number;
}

export interface TtsStream extends EventEmitter {
  readonly name: string;
  readonly sampleRate: number;
  open(): Promise<void>;
  /** Speak one sentence; audio arrives via 'audio' events tagged with its index. */
  speak(text: string, sentence: number): void;
  /** No more sentences this turn; resolves once all audio has been emitted. */
  close(): Promise<void>;
  abort(): void;
}

/** Which Sarvam/ElevenLabs language the text is in, from its script. */
export function languageOf(text: string): "te-IN" | "hi-IN" | "en-IN" {
  if (/[ఀ-౿]/.test(text)) return "te-IN";
  if (/[ऀ-ॿ]/.test(text)) return "hi-IN";
  return "en-IN";
}

/** Raw linear16 may or may not come wrapped in a WAV header; take the samples either way. */
function stripWav(buf: Buffer): Buffer {
  if (buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF") {
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === "data") return buf.subarray(off + 8, off + 8 + size);
      off += 8 + size + (size % 2);
    }
  }
  return buf;
}

// ---- Sarvam bulbul:v3 over WebSocket --------------------------------------------

export class SarvamTtsStream extends EventEmitter implements TtsStream {
  readonly name = "sarvam-ws";
  readonly sampleRate = 24000;
  private ws: any = null;
  private open_ = false;
  private lang: string;
  private queue: Array<{ text: string; sentence: number }> = [];
  private current: number | null = null;
  private inflight = 0;
  private closing: (() => void) | null = null;
  private aborted = false;
  private openedAt = 0;

  constructor(private readonly cfg: JarvisConfig, private readonly apiKey: string, firstText = "") {
    super();
    this.lang = languageOf(firstText);
  }

  async open(): Promise<void> {
    const { default: WebSocket } = await import("ws");
    const url = "wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true";
    this.openedAt = performance.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sarvam tts: connect timed out")), 3000);
      this.ws = new WebSocket(url, { headers: { "Api-Subscription-Key": this.apiKey } });
      this.ws.on("open", () => {
        clearTimeout(timer);
        this.open_ = true;
        this.send({
          type: "config",
          data: {
            target_language_code: this.lang,
            speaker: this.cfg.voice.sarvamSpeaker || "aditya",
            pace: this.cfg.voice.sarvamPace ?? 1,
            output_audio_codec: "linear16",
            speech_sample_rate: String(this.sampleRate),
            model: "bulbul:v3",
          },
        });
        resolve();
        this.pump();
      });
      this.ws.on("message", (d: Buffer) => this.onMessage(d));
      this.ws.on("error", (err: any) => {
        clearTimeout(timer);
        this.emit("error", String(err?.message ?? err));
        if (!this.open_) reject(err);
        this.finish();
      });
      this.ws.on("close", () => {
        this.open_ = false;
        this.finish();
      });
    });
  }

  private send(obj: unknown): void {
    if (!this.open_ || !this.ws) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err: any) {
      this.emit("error", String(err?.message ?? err));
    }
  }

  speak(text: string, sentence: number): void {
    if (this.aborted) return;
    this.queue.push({ text, sentence });
    this.pump();
  }

  /** One sentence at a time, so each audio message maps to a known sentence. */
  private pump(): void {
    if (!this.open_ || this.current !== null || !this.queue.length) return;
    const next = this.queue.shift()!;
    this.current = next.sentence;
    this.inflight++;
    this.send({ type: "text", data: { text: next.text } });
    this.send({ type: "flush" });
  }

  private onMessage(data: Buffer): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    const type = String(msg.type ?? "");
    if (type === "audio") {
      const b64 = msg.data?.audio ?? msg.audio;
      if (typeof b64 === "string" && b64.length) {
        this.emit("audio", { pcm: stripWav(Buffer.from(b64, "base64")), sampleRate: this.sampleRate, sentence: this.current ?? 0 } satisfies TtsAudio);
      }
    } else if (type === "event") {
      const ev = String(msg.data?.event_type ?? msg.event_type ?? "");
      if (ev === "final") {
        this.inflight = Math.max(0, this.inflight - 1);
        this.emit("sentenceDone", this.current);
        this.current = null;
        if (this.queue.length) this.pump();
        else if (this.closing) this.finish();
      }
    } else if (type === "error") {
      this.emit("error", String(msg.data?.message ?? msg.message ?? "tts error"));
      this.inflight = Math.max(0, this.inflight - 1);
      this.current = null;
      if (this.queue.length) this.pump();
      else if (this.closing) this.finish();
    }
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.open_ || (this.current === null && !this.queue.length)) {
        this.finish();
        resolve();
        return;
      }
      this.closing = resolve;
      // A stream that never sends its final must not hold the turn open.
      setTimeout(() => this.finish(), 15000);
    });
  }

  private finish(): void {
    const c = this.closing;
    this.closing = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.open_ = false;
    if (c) c();
    this.emit("closed");
  }

  abort(): void {
    this.aborted = true;
    this.queue = [];
    this.finish();
  }

  get elapsed(): number {
    return Math.round(performance.now() - this.openedAt);
  }
}

// ---- ElevenLabs stream-input over WebSocket -------------------------------------

export class ElevenLabsTtsStream extends EventEmitter implements TtsStream {
  readonly name = "elevenlabs-ws";
  readonly sampleRate = 24000;
  private ws: any = null;
  private open_ = false;
  private sentence = 0;
  private closing: (() => void) | null = null;
  private aborted = false;

  constructor(private readonly voiceId: string, private readonly apiKey: string, private readonly model = "eleven_flash_v2_5") {
    super();
  }

  async open(): Promise<void> {
    const { default: WebSocket } = await import("ws");
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input?model_id=${this.model}&output_format=pcm_24000`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("elevenlabs tts: connect timed out")), 3000);
      this.ws = new WebSocket(url, { headers: { "xi-api-key": this.apiKey } });
      this.ws.on("open", () => {
        clearTimeout(timer);
        this.open_ = true;
        // Shorter chunk schedule: latency over perfect prosody, this is a conversation.
        this.send({ text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.8 }, generation_config: { chunk_length_schedule: [50, 90, 120, 150] } });
        resolve();
      });
      this.ws.on("message", (d: Buffer) => this.onMessage(d));
      this.ws.on("error", (err: any) => {
        clearTimeout(timer);
        this.emit("error", String(err?.message ?? err));
        if (!this.open_) reject(err);
        this.finish();
      });
      this.ws.on("close", () => {
        this.open_ = false;
        this.finish();
      });
    });
  }

  private send(obj: unknown): void {
    if (!this.open_ || !this.ws) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err: any) {
      this.emit("error", String(err?.message ?? err));
    }
  }

  speak(text: string, sentence: number): void {
    if (this.aborted) return;
    this.sentence = sentence;
    this.send({ text: text.endsWith(" ") ? text : text + " ", flush: true });
  }

  private onMessage(data: Buffer): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (typeof msg.audio === "string" && msg.audio.length) {
      this.emit("audio", { pcm: Buffer.from(msg.audio, "base64"), sampleRate: this.sampleRate, sentence: this.sentence } satisfies TtsAudio);
    }
    if (msg.isFinal) this.finish();
    if (msg.error) this.emit("error", String(msg.message ?? msg.error));
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.open_) return resolve();
      this.closing = resolve;
      this.send({ text: "" }); // end of input → the server sends isFinal
      setTimeout(() => this.finish(), 15000);
    });
  }

  private finish(): void {
    const c = this.closing;
    this.closing = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.open_ = false;
    if (c) c();
    this.emit("closed");
  }

  abort(): void {
    this.aborted = true;
    this.finish();
  }
}

// ---- macOS `say`, rendered to PCM ---------------------------------------------

/**
 * The offline fallback. `say` renders a sentence to a PCM file in roughly real
 * time, so the first sentence of a reply is playing about a second after the
 * model finishes it — no better than spawning `say` directly, but every
 * sentence then flows through the same player, with the same instant stop.
 */
export class SayTtsStream extends EventEmitter implements TtsStream {
  readonly name = "say";
  readonly sampleRate = 24000;
  private queue: Array<{ text: string; sentence: number }> = [];
  private running = false;
  private aborted = false;
  private closing: (() => void) | null = null;
  private child: ReturnType<typeof spawn> | null = null;

  constructor(private readonly voice: string) {
    super();
  }

  async open(): Promise<void> {
    /* nothing to open */
  }

  speak(text: string, sentence: number): void {
    if (this.aborted) return;
    this.queue.push({ text, sentence });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.aborted) {
        const { text, sentence } = this.queue.shift()!;
        const out = join(tmpdir(), `echo-say-${process.pid}-${Date.now()}.wav`);
        await new Promise<void>((resolve) => {
          this.child = spawn("/usr/bin/say", ["-v", this.voice, "-o", out, `--data-format=LEI16@${this.sampleRate}`, withProsody(text)]);
          this.child.on("exit", () => resolve());
          this.child.on("error", () => resolve());
        });
        this.child = null;
        if (this.aborted) break;
        try {
          const pcm = stripWav(readFileSync(out));
          this.emit("audio", { pcm, sampleRate: this.sampleRate, sentence } satisfies TtsAudio);
          this.emit("sentenceDone", sentence);
        } catch {
          /* say failed; skip the sentence */
        } finally {
          try {
            unlinkSync(out);
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      this.running = false;
      if (this.closing && !this.queue.length) {
        const c = this.closing;
        this.closing = null;
        c();
      }
    }
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.running && !this.queue.length) return resolve();
      this.closing = resolve;
    });
  }

  abort(): void {
    this.aborted = true;
    this.queue = [];
    try {
      this.child?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    const c = this.closing;
    this.closing = null;
    if (c) c();
  }
}

/** The stream for the configured engine, or null when that engine cannot stream. */
export function createTtsStream(cfg: JarvisConfig, firstText: string): TtsStream | null {
  if (cfg.voice.ttsStreaming === false || !cfg.voice.ttsEnabled) return null;
  switch (cfg.voice.ttsEngine) {
    case "sarvam": {
      const key = process.env.SARVAM_API_KEY;
      return key ? new SarvamTtsStream(cfg, key, firstText) : new SayTtsStream(cfg.voice.ttsVoice);
    }
    case "elevenlabs": {
      const key = process.env.ELEVENLABS_API_KEY;
      return key && cfg.voice.elevenLabsVoiceId ? new ElevenLabsTtsStream(cfg.voice.elevenLabsVoiceId, key) : new SayTtsStream(cfg.voice.ttsVoice);
    }
    case "mac":
      return new SayTtsStream(cfg.voice.ttsVoice);
    default:
      return null; // fakeyou / local-clone keep the file path
  }
}
