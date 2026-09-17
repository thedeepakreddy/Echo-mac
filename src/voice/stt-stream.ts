import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { JarvisConfig } from "../config.js";

/**
 * Streaming speech-to-text: the transcript is produced WHILE the user speaks.
 *
 * The file-based path (stt.ts) cannot start until the utterance has ended and
 * been written to disk, then pays a full round trip — measured at 1.04 s for
 * Sarvam's REST endpoint on a two-second clip. Streamed, the same audio goes up
 * in 100 ms pieces as it is captured, partial transcripts come back as the
 * words land, and the final one arrives within a few hundred milliseconds of
 * the last word. That round trip stops being on the critical path at all.
 *
 * Only captures already addressed to Echo are streamed — a wake, a click, the
 * conversation window. The always-on transcript check stays local, so room
 * noise never leaves the machine, exactly as before.
 */

export interface SttStream extends EventEmitter {
  readonly name: string;
  /** Open the connection and send any audio already captured. */
  start(initialFrames: Int16Array[]): Promise<void>;
  push(frame: Int16Array): void;
  /** No more audio: resolve the final transcript, or null if the stream cannot provide one. */
  end(): Promise<string | null>;
  abort(): void;
  readonly partial: string;
}

export interface SttStreamEvents {
  partial: [text: string];
  final: [text: string];
  error: [message: string];
}

/** Sarvam's realtime STT accepts BCP-47 or "auto"; the config carries a bare code. */
function sarvamStreamLang(cfg: JarvisConfig): string {
  const lang = (cfg.voice.sttLanguage || "en").toLowerCase();
  if (lang === "auto" || lang === "unknown") return "auto";
  return lang.includes("-") ? lang : `${lang}-IN`;
}

const CHUNK_BYTES = 3200; // 100 ms of 16 kHz int16, Sarvam's recommended chunk
const FINAL_TIMEOUT_MS = 1500;
const CONNECT_TIMEOUT_MS = 2500;

/**
 * Sarvam realtime STT over WebSocket (saaras:v4 by default; v3-realtime also works).
 *
 * Endpointing is left to Echo's own VAD (`endpointing=manual`): we tell the
 * service when speech starts and ends, which keeps one authority on turn
 * taking instead of two VADs disagreeing. `stream_type=fast` asks for the
 * quickest partials.
 */
export class SarvamRealtimeStt extends EventEmitter implements SttStream {
  readonly name = "sarvam-realtime";
  private ws: any = null;
  private open = false;
  private buffer: Buffer[] = [];
  private buffered = 0;
  private finalResolve: ((t: string | null) => void) | null = null;
  private finalText: string | null = null;
  private lastPartial = "";
  private startedAt = 0;
  private aborted = false;

  constructor(private readonly cfg: JarvisConfig, private readonly apiKey: string, private readonly turnId?: string) {
    super();
  }

  get partial(): string {
    return this.lastPartial;
  }

  async start(initialFrames: Int16Array[]): Promise<void> {
    const { default: WebSocket } = await import("ws");
    const params = new URLSearchParams({
      language_code: sarvamStreamLang(this.cfg),
      model: this.cfg.voice.sttStreamModel || "saaras:v4",
      encoding: "linear16",
      sample_rate: "16000",
      endpointing: "manual",
      stream_type: "fast",
    });
    const url = `wss://api.sarvam.ai/speech-to-text-realtime/ws?${params.toString()}`;
    this.startedAt = performance.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sarvam realtime: connect timed out")), CONNECT_TIMEOUT_MS);
      try {
        this.ws = new WebSocket(url, { headers: { "api-subscription-key": this.apiKey } });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      this.ws.on("open", () => {
        clearTimeout(timer);
        this.open = true;
        this.send({ event: "speech_start" });
        for (const f of initialFrames) this.push(f);
        resolve();
      });
      this.ws.on("message", (data: Buffer) => this.onMessage(data));
      this.ws.on("error", (err: any) => {
        clearTimeout(timer);
        const msg = String(err?.message ?? err);
        this.emit("error", msg);
        if (!this.open) reject(new Error(msg));
        this.settle(null);
      });
      this.ws.on("close", () => {
        this.open = false;
        this.settle(this.finalText ?? (this.lastPartial || null));
      });
    });
  }

  private send(obj: unknown): void {
    if (!this.open || !this.ws) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err: any) {
      this.emit("error", String(err?.message ?? err));
    }
  }

  push(frame: Int16Array): void {
    if (this.aborted) return;
    this.buffer.push(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    this.buffered += frame.byteLength;
    if (this.buffered >= CHUNK_BYTES) this.flushAudio();
  }

  private flushAudio(): void {
    if (!this.buffered || !this.open) return;
    const chunk = Buffer.concat(this.buffer);
    this.buffer = [];
    this.buffered = 0;
    this.send({ event: "audio_input", audio: chunk.toString("base64") });
  }

  private onMessage(data: Buffer): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    const type = String(msg.type ?? msg.event ?? "");
    const text = String(msg.transcript ?? msg.data?.transcript ?? msg.text ?? msg.data?.text ?? "").trim();
    if (type === "transcript.partial" || type === "partial") {
      if (text) {
        this.lastPartial = text;
        this.emit("partial", text);
      }
    } else if (type === "transcript.final" || type === "final" || type === "transcript") {
      if (text) {
        // Several finals can arrive for one utterance (one per detected
        // segment); they are joined in order.
        this.finalText = this.finalText ? `${this.finalText} ${text}` : text;
        this.lastPartial = "";
        this.emit("final", text);
      }
      // end() has been called: give a second segment a moment, then settle —
      // measured, the final lands ~350 ms after the last audio, and waiting
      // the full grace period after it would throw that head start away.
      if (this.finalResolve) {
        if (this.graceTimer) clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => this.settle(this.finalText), 150);
      }
    } else if (type === "error") {
      const detail = String(msg.message ?? msg.data?.message ?? "unknown error");
      this.emit("error", detail);
      if (msg.is_fatal ?? msg.data?.is_fatal) this.settle(this.finalText);
    }
  }

  private graceTimer: NodeJS.Timeout | null = null;

  end(): Promise<string | null> {
    this.flushAudio();
    this.send({ event: "speech_end" });
    this.send({ event: "flush" });
    return new Promise<string | null>((resolve) => {
      if (this.finalText && !this.open) return resolve(this.finalText);
      this.finalResolve = resolve;
      // A final may already be in hand from an earlier segment; still wait a
      // beat for the tail segment, then settle with the best we have.
      this.graceTimer = setTimeout(
        () => this.settle(this.finalText ?? (this.lastPartial || null)),
        this.finalText ? 350 : FINAL_TIMEOUT_MS
      );
    });
  }

  private settle(text: string | null): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    const r = this.finalResolve;
    this.finalResolve = null;
    if (r) r(text);
    this.close();
  }

  private close(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.open = false;
  }

  abort(): void {
    this.aborted = true;
    this.settle(null);
  }

  /** Milliseconds since the stream was started, for the log. */
  get elapsed(): number {
    return Math.round(performance.now() - this.startedAt);
  }
}


// ---- Apple Speech (on-device) through native/speechhelper --------------------------

/** Apple's on-device locales we can use; Telugu is not among them (checked on this Mac). */
function appleLocale(cfg: JarvisConfig): string | null {
  const lang = (cfg.voice.sttLanguage || "en").toLowerCase();
  if (lang === "auto" || lang.startsWith("en")) return "en-IN";
  if (lang.startsWith("hi")) return "hi-IN";
  return null;
}

let appleHelper: { proc: ChildProcess } | null = null;
/**
 * Set when the helper dies at launch. macOS attributes Speech Recognition to
 * the RESPONSIBLE process — the app that spawned the helper — and kills the
 * helper with SIGABRT unless that app's Info.plist carries
 * NSSpeechRecognitionUsageDescription. Electron's does not, so until a
 * packaged build adds it (electron-builder `extendInfo`), "apple" degrades to
 * the file path after one clear log line rather than failing every turn.
 */
let appleBroken: string | null = null;

/**
 * One long-lived helper process; each utterance is a start/end pair on it.
 * Partials come back within a few hundred milliseconds of the words, the
 * final one shortly after `end`. Free, offline, English/Hindi only.
 */
export class AppleSttStream extends EventEmitter implements SttStream {
  readonly name = "apple-speech";
  private lastPartial = "";
  private finalText: string | null = null;
  private finalResolve: ((t: string | null) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private aborted = false;
  private static current: AppleSttStream | null = null;

  constructor(private readonly bin: string, private readonly locale: string) {
    super();
  }

  get partial(): string {
    return this.lastPartial;
  }

  private static ensure(bin: string): ChildProcess {
    if (appleHelper && appleHelper.proc.exitCode === null) return appleHelper.proc;
    const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) AppleSttStream.current?.onLine(line);
      }
    });
    proc.stderr!.on("data", (d: Buffer) => console.log(`[speechhelper] ${d.toString().trim()}`));
    const startedAt = Date.now();
    proc.on("exit", (code, signal) => {
      appleHelper = null;
      if (Date.now() - startedAt < 3000 && (signal === "SIGABRT" || code !== 0)) {
        appleBroken = `speechhelper died at launch (${signal ?? code}) — the host app needs NSSpeechRecognitionUsageDescription in its Info.plist; using the file path instead`;
        console.error(`[voice] ${appleBroken}`);
      }
    });
    appleHelper = { proc };
    return proc;
  }

  private send(type: number, payload: Buffer): void {
    const proc = appleHelper?.proc;
    if (!proc?.stdin?.writable) return;
    const head = Buffer.alloc(5);
    head.writeUInt32LE(payload.length + 1, 0);
    head[4] = type;
    proc.stdin.write(Buffer.concat([head, payload]));
  }

  async start(initialFrames: Int16Array[]): Promise<void> {
    AppleSttStream.ensure(this.bin);
    AppleSttStream.current = this;
    this.send(0x02, Buffer.from(JSON.stringify({ cmd: "start", locale: this.locale })));
    for (const f of initialFrames) this.push(f);
  }

  push(frame: Int16Array): void {
    if (this.aborted) return;
    this.send(0x01, Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "partial" && msg.text) {
      this.lastPartial = String(msg.text);
      this.emit("partial", this.lastPartial);
    } else if (msg.type === "final") {
      this.finalText = String(msg.text ?? this.lastPartial ?? "");
      if (this.finalText) this.emit("final", this.finalText);
      this.settle(this.finalText || null);
    } else if (msg.type === "error") {
      this.emit("error", String(msg.message ?? "speech error"));
    }
  }

  end(): Promise<string | null> {
    this.send(0x02, Buffer.from(JSON.stringify({ cmd: "end" })));
    return new Promise<string | null>((resolve) => {
      if (this.finalText) return resolve(this.finalText);
      this.finalResolve = resolve;
      this.timer = setTimeout(() => this.settle(this.lastPartial || null), 2000);
    });
  }

  private settle(text: string | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const r = this.finalResolve;
    this.finalResolve = null;
    if (r) r(text);
    if (AppleSttStream.current === this) AppleSttStream.current = null;
  }

  abort(): void {
    this.aborted = true;
    this.settle(null);
  }
}

/** Build the configured stream for a turn, or null when streaming is off/unavailable. */
export function createSttStream(cfg: JarvisConfig, turnId?: string, appRoot?: string): SttStream | null {
  if (cfg.voice.sttStreaming === false) return null;
  if (cfg.voice.sttProvider === "apple") {
    if (appleBroken) return null;
    const locale = appleLocale(cfg);
    const bin = join(appRoot ?? process.cwd(), "native", "speechhelper");
    if (locale && existsSync(bin)) return new AppleSttStream(bin, locale);
    return null;
  }
  if (cfg.voice.sttProvider === "sarvam") {
    const key = process.env.SARVAM_API_KEY;
    if (!key) return null;
    return new SarvamRealtimeStt(cfg, key, turnId);
  }
  return null;
}
