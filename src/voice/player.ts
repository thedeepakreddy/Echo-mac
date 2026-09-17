import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { JarvisConfig } from "../config.js";
import type { FrameSource } from "./listener.js";

/**
 * The speaker side of the voice: one persistent player instead of a process
 * per sentence.
 *
 * `afplay` measured 0.82–1.29 s from spawn to sound for a 50 ms file, paid on
 * every sentence and on the wake chirp. The voiceio helper (native/voiceio.swift)
 * keeps an AVAudioEngine running for the life of the app, so a sentence starts
 * within milliseconds of its first PCM bytes and "stop" silences it at once.
 * When the helper is missing or fails to start, AfplayPlayer keeps the old
 * behaviour so speech never breaks because of it.
 *
 * Events: 'started' · 'drained' · 'stopped' · 'progress'(playedMs) · 'error'(msg) · 'exit'
 */
export interface AudioPlayer extends EventEmitter {
  readonly name: string;
  /** Frames from `frameSource` are echo-cancelled (Echo's own voice removed). */
  readonly aec: boolean;
  start(): Promise<void>;
  /** Queue PCM (int16 mono at `sampleRate`, tagged with its sentence) — plays immediately. */
  play(pcm: Buffer, sampleRate: number, sentence: number): void;
  /** All audio for this sentence has been handed over (file players need to know). */
  endSentence(sentence: number): void;
  /** Drop everything queued and fall silent now. */
  stop(): void;
  readonly playing: boolean;
  /** Milliseconds actually played since playback last started. */
  readonly playedMs: number;
  /** Microphone frames from the same helper, when it was started with capture. */
  readonly frameSource: FrameSource | null;
  dispose(): void;
}

// ---- voiceio -------------------------------------------------------------------

const T_PCM_IN = 0x01;
const T_CTRL = 0x02;
const T_PCM_OUT = 0x10;
const T_EVENT = 0x20;

export class VoiceIoPlayer extends EventEmitter implements AudioPlayer {
  readonly name = "voiceio";
  private proc: ChildProcess | null = null;
  private inbuf: Buffer = Buffer.alloc(0);
  private rate = 0;
  playing = false;
  playedMs = 0;
  aec = false;
  frameSource: FrameSource | null = null;
  /**
   * True when this helper was asked for the microphone and could not use it.
   *
   * It matters because asking is not free: --capture opens Apple's
   * voice-processing I/O unit, which TAKES the input device. Finding the unit
   * dead and simply not reading from it leaves the microphone held anyway, and
   * the plain recorder that follows opens the same device and gets a mangled
   * stream — measured here as a flat 14000-RMS signal with no dynamic range,
   * which whisper duly transcribed as "Thanks for watching."
   */
  captureDead = false;
  private frames: Int16Array[] = [];
  private frameWaiters: Array<(f: Int16Array) => void> = [];
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private firstFrameAt = 0;
  private stopped = false;
  private disposed = false;

  constructor(private readonly bin: string, private readonly capture: boolean) {
    super();
  }

  /** Capture was asked for. Says nothing about whether it produced sound — see `aec`. */
  get capturing(): boolean {
    return this.capture;
  }

  static available(appRoot: string): string | null {
    const bin = join(appRoot, "native", "voiceio");
    return existsSync(bin) ? bin : null;
  }

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const args = this.capture ? ["--capture"] : [];
    this.proc = spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.on("data", (d: Buffer) => this.onData(d));
    this.proc.stderr!.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[voiceio] ${line}`);
    });
    this.proc.on("exit", (code) => {
      if (!this.disposed) this.emit("exit", code);
      this.readyReject?.(new Error(`voiceio exited (${code})`));
      this.proc = null;
    });
    this.proc.on("error", (err) => {
      this.emit("error", err.message);
      this.readyReject?.(err);
    });
    const timeout = setTimeout(() => this.readyReject?.(new Error("voiceio did not report ready")), 4000);
    try {
      await this.ready;
    } finally {
      clearTimeout(timeout);
    }
    if (this.capture) {
      // Voice processing that could not open the mic still reports ready, and
      // frames arriving is not proof either: measured on this machine, the unit
      // delivered a perfect stream of DIGITAL SILENCE — 118 frames, every
      // sample exactly zero — while the plain microphone heard the room fine.
      // Echo sat there for 37 minutes hearing nothing, because the old check
      // counted frames rather than listening to them.
      //
      // A real microphone is never exactly zero; even a quiet room dithers. So
      // "not one non-zero sample in the first second and a half" means the
      // capture unit is dead, and the listener falls back to PvRecorder.
      const audible = await this.probeCapture(1500);
      if (audible === "audio") {
        this.aec = true;
        this.frameSource = {
          read: () => this.readFrame(),
          stop: () => {},
          release: () => {},
          describe: () => "voiceio (voice-processing, echo-cancelled)",
          aec: true,
        };
      } else if (audible === "silent") {
        this.captureDead = true;
        console.warn(
          "[voiceio] the echo-cancelled microphone delivered nothing but digital silence — " +
          "falling back to the plain microphone. Echo can hear, but it can no longer tell its own " +
          'voice from yours, so barge-in over speakers may be unreliable. Set voice.captureEngine to ' +
          '"pvrecorder" to choose this deliberately and skip the probe.'
        );
      } else {
        this.captureDead = true;
        console.warn("[voiceio] no microphone frames arrived — capture disabled, playback only");
      }
    }
  }

  /**
   * Wait for capture frames and decide whether they carry any sound at all.
   *
   * Returns "audio" on the first non-zero sample, "silent" if frames kept
   * arriving but every sample was zero, and "none" if no frame ever came.
   * Consumed frames are put back: the probe must not eat the start of a turn.
   */
  private async probeCapture(budgetMs: number): Promise<"audio" | "silent" | "none"> {
    const deadline = Date.now() + budgetMs;
    const seen: Int16Array[] = [];
    let sawFrame = false;
    while (Date.now() < deadline) {
      if (!this.frames.length) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      const frame = this.frames.shift()!;
      seen.push(frame);
      sawFrame = true;
      for (const sample of frame) {
        if (sample !== 0) {
          this.restore(seen);
          return "audio";
        }
      }
    }
    this.restore(seen);
    return sawFrame ? "silent" : "none";
  }

  /** Put probed frames back, newest first, honouring the queue's half-second cap. */
  private restore(seen: Int16Array[]): void {
    this.frames.unshift(...seen);
    while (this.frames.length > 16) this.frames.shift();
  }

  private send(type: number, payload: Buffer): void {
    if (!this.proc?.stdin?.writable) return;
    const head = Buffer.alloc(5);
    head.writeUInt32LE(payload.length + 1, 0);
    head[4] = type;
    this.proc.stdin.write(Buffer.concat([head, payload]));
  }

  private control(obj: Record<string, unknown>): void {
    this.send(T_CTRL, Buffer.from(JSON.stringify(obj)));
  }

  play(pcm: Buffer, sampleRate: number, _sentence: number): void {
    if (!this.proc) return;
    if (sampleRate !== this.rate) {
      this.rate = sampleRate;
      this.control({ cmd: "config", rate: sampleRate });
    }
    this.stopped = false;
    // Keep messages modest so a stop is not queued behind a huge write.
    for (let off = 0; off < pcm.length; off += 32768) this.send(T_PCM_IN, pcm.subarray(off, Math.min(pcm.length, off + 32768)));
  }

  endSentence(): void {
    /* the engine plays whatever it has; nothing to flush */
  }

  stop(): void {
    this.stopped = true;
    this.control({ cmd: "stop" });
    this.playing = false;
  }

  private onData(d: Buffer): void {
    this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, d]) : d;
    for (;;) {
      if (this.inbuf.length < 5) return;
      const len = this.inbuf.readUInt32LE(0);
      if (this.inbuf.length < 4 + len) return;
      const type = this.inbuf[4];
      const payload = this.inbuf.subarray(5, 4 + len);
      this.inbuf = this.inbuf.subarray(4 + len);
      if (type === T_PCM_OUT) {
        const frame = new Int16Array(payload.length / 2);
        for (let i = 0; i < frame.length; i++) frame[i] = payload.readInt16LE(i * 2);
        if (!this.firstFrameAt) this.firstFrameAt = performance.now();
        const w = this.frameWaiters.shift();
        if (w) w(frame);
        else {
          this.frames.push(frame);
          if (this.frames.length > 16) this.frames.shift(); // nobody reading: keep half a second, not a backlog
        }
      } else if (type === T_EVENT) {
        let ev: any;
        try {
          ev = JSON.parse(payload.toString("utf8"));
        } catch {
          continue;
        }
        switch (ev.ev) {
          case "ready":
            this.readyResolve?.();
            break;
          case "started":
            this.playing = true;
            this.playedMs = 0;
            this.emit("started");
            break;
          case "progress":
            this.playedMs = Number(ev.played_ms ?? this.playedMs);
            this.emit("progress", this.playedMs);
            break;
          case "drained":
            this.playing = false;
            this.emit("drained");
            break;
          case "stopped":
            this.playing = false;
            this.emit("stopped");
            break;
          case "error":
            this.emit("error", String(ev.message ?? "voiceio error"));
            break;
        }
      }
    }
  }

  private readFrame(): Promise<Int16Array> {
    const f = this.frames.shift();
    if (f) return Promise.resolve(f);
    return new Promise<Int16Array>((resolve, reject) => {
      if (!this.proc) return reject(new Error("voiceio is not running"));
      this.frameWaiters.push(resolve);
    });
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.control({ cmd: "quit" });
      this.proc?.stdin?.end();
      this.proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

// ---- afplay fallback -----------------------------------------------------------

/** The old way, one process per sentence. Kept so speech works without the helper. */
export class AfplayPlayer extends EventEmitter implements AudioPlayer {
  readonly name = "afplay";
  readonly aec = false;
  readonly frameSource = null;
  playing = false;
  playedMs = 0;
  private pending = new Map<number, { chunks: Buffer[]; rate: number }>();
  private queue: string[] = [];
  private current: ChildProcess | null = null;
  private running = false;
  private startedAt = 0;

  async start(): Promise<void> {
    /* nothing persistent */
  }

  play(pcm: Buffer, sampleRate: number, sentence: number): void {
    const p = this.pending.get(sentence) ?? { chunks: [], rate: sampleRate };
    p.chunks.push(pcm);
    this.pending.set(sentence, p);
  }

  endSentence(sentence: number): void {
    const p = this.pending.get(sentence);
    if (!p) return;
    this.pending.delete(sentence);
    const pcm = Buffer.concat(p.chunks);
    if (!pcm.length) return;
    const path = join(tmpdir(), `echo-play-${process.pid}-${Date.now()}-${sentence}.wav`);
    writeFileSync(path, wavOf(pcm, p.rate));
    this.queue.push(path);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const path = this.queue.shift()!;
        this.playing = true;
        this.startedAt = performance.now();
        this.emit("started");
        await new Promise<void>((resolve) => {
          this.current = spawn("/usr/bin/afplay", [path]);
          this.current.on("exit", () => resolve());
          this.current.on("error", () => resolve());
        });
        this.current = null;
        this.playedMs = Math.round(performance.now() - this.startedAt);
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
    } finally {
      this.running = false;
      this.playing = false;
      this.emit("drained");
    }
  }

  stop(): void {
    this.queue = [];
    this.pending.clear();
    try {
      this.current?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.current = null;
    this.playing = false;
    this.emit("stopped");
  }

  dispose(): void {
    this.stop();
  }
}

function wavOf(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * The best player this machine can offer: voiceio (with echo-cancelled capture
 * unless the config says otherwise), else afplay.
 */
export async function createPlayer(cfg: JarvisConfig, appRoot: string): Promise<AudioPlayer> {
  const bin = VoiceIoPlayer.available(appRoot);
  const engine = cfg.voice.captureEngine ?? "auto";
  if (bin) {
    const wantCapture = engine !== "pvrecorder";
    const p = new VoiceIoPlayer(bin, wantCapture);
    try {
      await p.start();
      if (p.captureDead) {
        // Give the device back. The helper only takes the microphone when it is
        // launched with --capture, and there is no way to release it while it
        // runs, so the unit has to be restarted without the flag. Playback is
        // unaffected; barge-in over speakers loses its echo cancellation, which
        // the listener already warned about.
        console.warn("[voiceio] releasing the microphone so the plain recorder can open it cleanly");
        p.dispose();
        const playbackOnly = new VoiceIoPlayer(bin, false);
        try {
          await playbackOnly.start();
          return playbackOnly;
        } catch {
          playbackOnly.dispose();
          return new AfplayPlayer();
        }
      }
      return p;
    } catch (err: any) {
      console.warn(`[voiceio] unavailable (${err?.message ?? err}) — falling back to afplay`);
      p.dispose();
    }
  }
  return new AfplayPlayer();
}
