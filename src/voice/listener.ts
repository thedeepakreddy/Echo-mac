import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { writeWav } from "./wav.js";
import type { JarvisConfig } from "../config.js";
import type { WakeDetector, WakeDetection } from "./wake/detector.js";
import { WAKE_REFRACTORY_MS } from "./wake/detector.js";
import { type Vad, VAD_START, VAD_CONTINUE, VAD_START_FRAMES, VAD_BARGE } from "./vad.js";
import type { WakeKind } from "./session.js";

export const FRAME_LENGTH = 512; // Porcupine's and Silero's frame @ 16kHz
export const SAMPLE_RATE = 16000;

/**
 * Telling a quiet room from a dead microphone.
 *
 * A live input always carries a noise floor — preamp hiss, the room, the fans.
 * Frames of EXACT zero mean the device is not quiet, it is gone: unplugged,
 * back in its case, or handed to another app. macOS does not report that as an
 * error, it simply keeps returning silence, so the capture loop spins happily
 * and Echo looks like it is listening while hearing nothing at all.
 */
const DEAD_RMS = 1;
const DEAD_AFTER_MS = 4_000;
const RECOVERY_COOLDOWN_MS = 15_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const FRAME_MS = (FRAME_LENGTH / SAMPLE_RATE) * 1000;
const MS_PER_FRAME = (FRAME_LENGTH / SAMPLE_RATE) * 1000; // ~32ms
/**
 * Speech detection adapts to the microphone instead of using a fixed level.
 * Measured on a MacBook with AirPods as the default input, ordinary speech sat
 * around RMS 200 with a noise floor near 65 — a hardcoded threshold of 550
 * classified almost every spoken frame as silence, so captures never started
 * (or ended mid-sentence). We track the quiet baseline and treat anything a
 * few times above it as speech, which works across headsets and built-in mics.
 *
 * This is the FALLBACK speech detector. When the Silero VAD model is loaded
 * (see vad.ts) it decides speech/not-speech per frame instead, and the level
 * maths below only drives the reactor's glow.
 */
const SPEECH_FACTOR = 2.5; // speech = this many times the rolling noise floor
const MIN_SPEECH_RMS = 110; // absolute floor, so a silent room can't self-trigger
const INITIAL_NOISE_FLOOR = 60;

/**
 * Barge-in: hearing the user start talking while Echo is still speaking.
 *
 * The obstacle is self-hearing — the microphone picks up Echo's own voice
 * through the speakers, so listening naively during playback makes it interrupt
 * itself on its own words.
 *
 * We track the loudest level Echo's playback reaches at the mic and require a
 * genuine interruption to clear a multiple of it. A running PEAK rather than an
 * average is the point: Echo can never exceed its own peak, so its own voice
 * structurally cannot trigger, while your voice adds on top of it and does.
 *
 * With echo-cancelled capture (the voiceio helper, `aec` on the frame source)
 * none of that is needed: what reaches us is already the room minus Echo, so a
 * stretch of speech is the user by construction and the VAD alone decides.
 */
const BARGE_FACTOR = 1.6; // how far above Echo's own peak the user has to be
const BARGE_FRAMES = 6; // ~192ms sustained, so a cough or click doesn't cut in
const BARGE_FRAMES_AEC = 8; // ~256ms of VAD-confirmed speech on a cancelled stream
/**
 * Barge-in stays off for this long after Echo is asked to speak, while the
 * peak learns what its playback sounds like. Measured: `say` synthesises before
 * it plays, and first audible sound arrived 719–1322 ms after spawn. Not needed
 * on an echo-cancelled stream, where playback never reaches us at all.
 */
const BARGE_BLOCK_MS = 1500;
/**
 * Audio kept from before a capture starts. Long enough to hold the whole wake
 * word: an acoustic detector fires as the word ENDS, and the ~500 ms of "Echo"
 * before that has to be in the recording for the transcript to make sense.
 */
const PREROLL_FRAMES = 24; // ~768ms
/** In an always-on capture, this much confirmed speech lights the reactor. */
const SPEECH_CONFIRM_MS = 300;
/** A wake with nothing after it: how long to wait for the command before asking. */
export const DEFAULT_NO_SPEECH_MS = 1500;

type ListenerState = "idle" | "capturing";

/** Where the frames come from. PvRecorder by default; the voiceio helper when it runs. */
export interface FrameSource {
  read(): Promise<Int16Array>;
  stop(): void;
  release(): void;
  describe(): string;
  /** True when the frames are echo-cancelled (Echo's own playback removed). */
  readonly aec: boolean;
}

export interface CaptureOptions {
  needsWakeWord: boolean;
  wake: WakeKind;
  turnId?: string;
  /** Give up (discard with "no speech") if nothing is said within this long. */
  noSpeechMs?: number;
}

/** What the listener knows about a capture, handed on with the utterance. */
export interface CaptureMeta {
  turnId?: string;
  wake: WakeKind;
  needsWakeWord: boolean;
  captureStartAt: number;
  speechStartAt?: number;
  /** performance.now() of the last frame that counted as speech. */
  speechEndAt?: number;
  durationMs: number;
  /** Which detector decided speech: the VAD model or the RMS fallback. */
  speechBy: "vad" | "rms";
}

export type EndpointHint = "punctuated" | "midclause" | null;

/**
 * Owns the single microphone pipeline. Continuously reads audio frames and runs
 * three things over them: the wake-word detector (if one is loaded), the
 * speech detector (Silero VAD, or the RMS fallback), and — while Echo is
 * talking — the barge-in watch. A wake, a manual trigger, or speech inside an
 * open conversation window starts capturing an utterance, which is endpointed
 * on silence and emitted as a WAV path for transcription.
 *
 * Emits:
 *   'ready'(wakeEnabled, engine) · 'device'(name) · 'unavailable'(reason) · 'error'(msg) · 'stopped'
 *   'wakeCandidate'(det) — an engine that verifies heard something; capture has already started
 *   'wake'(det) — the name was said (verified where the engine verifies)
 *   'listening'(meta) — an explicit or wake-started capture began
 *   'speech'(meta) — ~300 ms of confirmed speech inside an always-on capture
 *   'level'(0..1) · 'utterance'(wavPath, needsWakeWord, meta) · 'discarded'(reason, meta)
 *   'deaf'(wasDevice, nowDevice | null) — the input went silent and was rebound
 *   'bargein'(level, bar)
 */
export class VoiceListener extends EventEmitter {
  private source: FrameSource | null = null;
  private state: ListenerState = "idle";
  private running = false;
  private preroll: Int16Array[] = [];
  private captured: Int16Array[] = [];
  private silenceMs = 0;
  /** Consecutive frames of digital silence — see DEAD_RMS. */
  private deadFrames = 0;
  private recovering = false;
  private lastRecoveryAt = 0;
  private recoveryAttempts = 0;
  private captureMs = 0;
  private sawSpeech = false;
  private speechMs = 0;
  private speechAnnounced = false;
  private capture: CaptureOptions = { needsWakeWord: true, wake: "transcript" };
  private captureStartAt = 0;
  private speechStartAt: number | undefined;
  private speechEndAt: number | undefined;
  private speechBy: "vad" | "rms" = "rms";
  private paused = false; // Echo is speaking: capture suspended, barge-in watched
  /** Capture every spoken utterance and let the transcript decide (keyless wake). */
  private alwaysOn = false;
  /** Conversation window open: speech alone starts a turn, no wake word owed. */
  private sessionOpen = false;
  /** Until when new captures are suppressed (the chirp is playing). */
  private holdOffUntil = 0;
  private noiseFloor = INITIAL_NOISE_FLOOR;
  private peakRms = 0;
  private echoPeak = 0;
  private speakingSince = 0;
  private bargeFrames = 0;
  private vadStartFrames = 0;
  private endpointHint: EndpointHint = null;

  private wake: WakeDetector | null = null;
  private vad: Vad | null = null;
  private lastWakeAt = -Infinity;
  private verifying = false;
  private frameTap: ((frame: Int16Array, at: number, capture: CaptureMeta | null) => void) | null = null;

  /** Current level above which a frame counts as speech (RMS path). */
  private get speechThreshold(): number {
    return Math.max(MIN_SPEECH_RMS, this.noiseFloor * SPEECH_FACTOR);
  }

  constructor(private cfg: JarvisConfig, private readonly externalSource?: FrameSource) {
    super();
  }

  // ---- wiring ----------------------------------------------------------------

  setWakeDetector(detector: WakeDetector | null): void {
    this.wake = detector;
  }

  setVad(vad: Vad | null): void {
    this.vad = vad;
  }

  /**
   * Receive every frame (for streaming STT), with the capture it belongs to
   * or null when idle. Must not throw or block.
   */
  setFrameTap(tap: ((frame: Int16Array, at: number, capture: CaptureMeta | null) => void) | null): void {
    this.frameTap = tap;
  }

  /** Everything recorded so far in the capture in progress (pre-roll included). */
  capturedFrames(): Int16Array[] {
    return this.state === "capturing" ? [...this.captured] : [];
  }

  /** Open/close the conversation window: speech starts a turn without the name. */
  setSessionOpen(open: boolean): void {
    this.sessionOpen = open;
  }

  /** From streaming STT partials: does the sentence sound finished? Shortens/extends the endpoint. */
  setEndpointHint(hint: EndpointHint): void {
    this.endpointHint = hint;
  }

  /** Suppress NEW captures briefly (the wake chirp) without touching one in progress. */
  holdOff(ms: number): void {
    this.holdOffUntil = Math.max(this.holdOffUntil, Date.now() + ms);
  }

  /** Tag the capture in progress with the turn the session just opened for it. */
  setCaptureTurn(turnId: string): void {
    if (this.state === "capturing") this.capture.turnId = turnId;
  }

  get isCapturing(): boolean {
    return this.state === "capturing";
  }

  get hasAcousticWake(): boolean {
    return this.wake !== null;
  }

  get isEchoCancelled(): boolean {
    return this.source?.aec === true;
  }

  // ---- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    if (this.externalSource) {
      this.source = this.externalSource;
    } else {
      let PvRecorder: any;
      try {
        ({ PvRecorder } = await import("@picovoice/pvrecorder-node"));
      } catch {
        this.emit(
          "unavailable",
          "Microphone capture needs @picovoice/pvrecorder-node. Run `npm install` (it is an optional dependency). You can still type commands in the HUD."
        );
        return;
      }
      try {
        // Worth surfacing which input this resolves to: if it lands on a headset
        // sitting in its case, Echo hears almost nothing and looks broken
        // rather than simply deaf.
        this.source = this.openRecorder(PvRecorder);
      } catch (err: any) {
        this.emit(
          "unavailable",
          `Could not open the microphone (${String(err?.message ?? err)}). Grant Microphone permission in System Settings, or type commands in the HUD.`
        );
        return;
      }
    }
    this.emit("device", this.source.describe());

    // Keyless always-on capture is the fallback wake path. With an acoustic
    // detector loaded it stays on only if asked, because every room noise it
    // captures costs a transcription.
    this.alwaysOn = this.wake ? this.cfg.voice.wakeTranscriptFallback !== false : true;

    this.running = true;
    this.emit("ready", this.alwaysOn || this.wake !== null, this.wake?.name ?? "whisper");
    void this.loop();
  }

  /** Manually begin capturing an utterance (push-to-talk / HUD / after a wake). */
  triggerListen(opts: Partial<CaptureOptions> = {}) {
    if (!this.running || this.paused) return;
    // Explicit trigger — the user already asked for attention, so no wake word.
    this.beginCapture({
      needsWakeWord: false,
      wake: opts.wake ?? "manual",
      turnId: opts.turnId,
      noSpeechMs: opts.noSpeechMs,
    });
  }

  /**
   * Called when Echo starts and stops speaking. The mic keeps running and
   * listens for you cutting in; only capture is suspended, not hearing. A
   * capture that already holds speech is finished, not thrown away — the user
   * saying "…and also" as Echo starts replying used to be lost here.
   */
  setPaused(paused: boolean) {
    if (paused && !this.paused) {
      // Seed from the room's own noise level, NOT zero: on headphones Echo
      // barely reaches the mic, and a zero seed let the user become the
      // baseline instead of the interruption.
      this.echoPeak = this.noiseFloor;
      this.speakingSince = Date.now();
      this.bargeFrames = 0;
    }
    this.paused = paused;
    if (paused && this.state === "capturing") {
      if (this.sawSpeech) void this.finishCapture();
      else this.resetCapture();
    }
  }

  /**
   * Open the microphone. Separate from start() because it has to be possible to
   * do again: an inputDevice of -1 means "the system default", and PvRecorder
   * resolves that ONCE, when the recorder is created. Whatever was default at
   * launch is what Echo holds for the life of the process — so unplugging it
   * later leaves Echo bound to a device that no longer produces anything.
   */
  private openRecorder(PvRecorder: any): FrameSource {
    const deviceIndex = this.resolveDevice(PvRecorder);
    const recorder = new PvRecorder(FRAME_LENGTH, deviceIndex);
    recorder.start();
    return {
      read: () => recorder.read(),
      stop: () => recorder.stop(),
      release: () => recorder.release(),
      describe: () => recorder.getSelectedDevice?.() ?? `index ${deviceIndex}`,
      aec: false,
    };
  }

  /**
   * Rebind to whatever is the system default NOW.
   *
   * Announced rather than done quietly: a microphone that has gone deaf is the
   * one failure the user cannot see, and silently swapping devices under them
   * is its own surprise. Capped and rate-limited, because if every input on the
   * machine is silent then reopening in a loop just burns the CPU and says the
   * same thing forever.
   */
  private async recoverMicrophone(): Promise<void> {
    if (this.recovering) return;
    const now = Date.now();
    if (now - this.lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;
    this.lastRecoveryAt = now;
    this.deadFrames = 0;

    if (this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      this.emit("deaf", this.source?.describe() ?? "the microphone", null);
      return;
    }
    this.recoveryAttempts++;
    this.recovering = true;
    const was = this.source?.describe() ?? "the microphone";
    // An injected source that goes silent is replaced the same way the startup
    // probe replaces it — with the plain recorder. It is never released: the
    // player still owns it, and closing it would take playback down too.
    const injected = this.source === this.externalSource;
    try {
      const { PvRecorder } = await import("@picovoice/pvrecorder-node");
      if (!injected) {
        try { this.source?.stop(); this.source?.release(); }
        catch { /* the device is already gone; that is the situation */ }
      }
      this.source = this.openRecorder(PvRecorder);
      const now2 = this.source.describe();
      this.emit("deaf", was, now2);
      this.emit("device", now2);
    } catch (err: any) {
      this.emit("error", `the microphone went silent and could not be reopened: ${String(err?.message ?? err)}`);
    } finally {
      this.recovering = false;
    }
  }

  /** Turn the configured inputDevice (index, name fragment, or -1) into an index. */
  private resolveDevice(PvRecorder: any): number {
    const want = this.cfg.voice.inputDevice ?? -1;
    if (typeof want === "number") return want;
    try {
      const devices: string[] = PvRecorder.getAvailableDevices() ?? [];
      const i = devices.findIndex((d) => d.toLowerCase().includes(String(want).toLowerCase()));
      if (i >= 0) return i;
      this.emit("error", `No microphone matching "${want}" — using the system default.`);
    } catch {
      /* fall back to the default below */
    }
    return -1;
  }

  // ---- capture ---------------------------------------------------------------

  private beginCapture(opts: CaptureOptions) {
    this.state = "capturing";
    this.capture = { ...opts };
    this.captured = [...this.preroll];
    this.silenceMs = 0;
    this.captureMs = 0;
    this.sawSpeech = false;
    this.speechMs = 0;
    this.speechAnnounced = false;
    this.peakRms = 0;
    this.captureStartAt = performance.now();
    this.speechStartAt = undefined;
    this.speechEndAt = undefined;
    this.endpointHint = null;
    this.vadStartFrames = 0;
    // Only announce a capture the user asked for. In always-on mode every stray
    // noise would otherwise light the reactor up as though it were taking an order.
    if (!opts.needsWakeWord) this.emit("listening", this.meta());
  }

  private meta(): CaptureMeta {
    return {
      turnId: this.capture.turnId,
      wake: this.capture.wake,
      needsWakeWord: this.capture.needsWakeWord,
      captureStartAt: this.captureStartAt,
      speechStartAt: this.speechStartAt,
      speechEndAt: this.speechEndAt,
      durationMs: this.captureMs,
      speechBy: this.speechBy,
    };
  }

  private resetCapture() {
    this.state = "idle";
    this.captured = [];
    this.sawSpeech = false;
    this.speechMs = 0;
    this.vadStartFrames = 0;
  }

  /** The silence that ends an utterance, shaped by what the transcript so far sounds like. */
  private endpointMs(): number {
    const base = this.cfg.voice.silenceMs;
    if (this.endpointHint === "punctuated") return Math.max(350, Math.round(base * 0.65));
    if (this.endpointHint === "midclause") return Math.min(1500, Math.round(base * 1.4));
    return base;
  }

  private async loop() {
    while (this.running) {
      // Never read across a reopen: releasing the recorder under an in-flight
      // read throws, and the catch below would end the loop for good.
      if (this.recovering) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      let frame: Int16Array;
      try {
        frame = await this.source!.read();
      } catch (err: any) {
        if (this.running) this.emit("error", `mic read failed: ${String(err?.message ?? err)}`);
        break;
      }
      const at = performance.now();
      const rms = frameRms(frame);
      const threshold = this.speechThreshold;

      // Exact silence is a dead device, not a quiet room.
      if (rms <= DEAD_RMS) {
        this.deadFrames++;
        if (this.deadFrames * FRAME_MS >= DEAD_AFTER_MS) void this.recoverMicrophone();
      } else {
        this.deadFrames = 0;
        this.recoveryAttempts = 0;
      }

      // The VAD returns -1 when it cannot answer (not loaded, or a failed
      // inference); the RMS path then decides for this frame.
      let prob = -1;
      if (this.vad) {
        try {
          prob = this.vad.process(frame);
        } catch {
          prob = -1;
        }
      }
      const useVad = prob >= 0;
      this.speechBy = useVad ? "vad" : "rms";

      if (this.frameTap) {
        try {
          this.frameTap(frame, at, this.state === "capturing" ? this.meta() : null);
        } catch {
          /* a tap must never take the mic down */
        }
      }

      // Only report level while actually capturing. Reporting it all the time
      // makes the reactor pulse to your voice even when nothing is being
      // recorded, which reads as "Echo heard me" when it did not.
      this.emit("level", this.state === "capturing" ? Math.min(1, rms / (threshold * 3)) : 0);

      if (this.paused) {
        this.watchForBargeIn(rms, threshold, prob);
        // On an echo-cancelled stream the name can be heard over Echo's own
        // voice; a wake while speaking is a barge-in that already says who it
        // is addressed to.
        if (this.source?.aec && this.wake) {
          const det = this.runWake(frame, at);
          if (det) this.emit("bargein", Math.round(rms), 0, det);
        }
        continue;
      }

      // The wake detector hears every frame Echo is not speaking over: idle
      // frames, and frames of an always-on capture that still owes the name.
      if (this.wake && (this.state === "idle" || this.capture.needsWakeWord)) {
        const det = this.runWake(frame, at);
        if (det) {
          this.onWakeDetected(det);
          continue;
        }
      }

      if (this.state === "idle") {
        // Track the quiet baseline on frames that are not speech: fall towards
        // quiet frames quickly, rise slowly, so a passing noise doesn't
        // desensitise the microphone.
        const quiet = useVad ? prob < 0.2 : rms < this.noiseFloor;
        this.noiseFloor = quiet
          ? this.noiseFloor * 0.9 + rms * 0.1
          : this.noiseFloor * 0.995 + rms * 0.005;

        this.preroll.push(frame);
        if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();

        if (Date.now() < this.holdOffUntil) continue;

        const wantCapture = this.alwaysOn || this.sessionOpen;
        if (!wantCapture) continue;

        let starts = false;
        if (useVad) {
          this.vadStartFrames = prob >= VAD_START ? this.vadStartFrames + 1 : 0;
          starts = this.vadStartFrames >= VAD_START_FRAMES;
        } else {
          starts = rms >= threshold;
        }
        if (starts) {
          // Inside the window the speech IS the turn; otherwise the transcript
          // decides whether it was addressed to Echo.
          this.beginCapture(
            this.sessionOpen
              ? { needsWakeWord: false, wake: "window", noSpeechMs: 0 }
              : { needsWakeWord: true, wake: "transcript" }
          );
          // The frames that tripped the start are speech too.
          this.noteSpeechFrame(at);
        }
      } else {
        // Capturing an utterance.
        this.captured.push(frame);
        this.captureMs += MS_PER_FRAME;
        if (rms > this.peakRms) this.peakRms = rms;
        // Hysteresis: once speaking, a lower level still counts as speech, so
        // quiet syllables between words don't look like the end of a sentence.
        const speech = useVad
          ? prob >= (this.sawSpeech ? VAD_CONTINUE : VAD_START)
          : rms >= (this.sawSpeech ? threshold * 0.6 : threshold);
        if (speech) {
          this.noteSpeechFrame(at);
        } else {
          this.silenceMs += MS_PER_FRAME;
        }

        const noSpeechMs = this.capture.noSpeechMs ?? 0;
        const gaveUp = noSpeechMs > 0 && !this.sawSpeech && this.captureMs >= noSpeechMs;
        const enoughSilence = this.sawSpeech && this.silenceMs >= this.endpointMs();
        const tooLong = this.captureMs >= this.cfg.voice.maxUtteranceMs;
        if (gaveUp) {
          const meta = this.meta();
          this.resetCapture();
          this.emit("discarded", `no speech within ${noSpeechMs}ms`, meta);
        } else if (enoughSilence || tooLong) {
          await this.finishCapture();
        }
      }
    }
  }

  private noteSpeechFrame(at: number) {
    if (!this.sawSpeech) this.speechStartAt = at;
    this.sawSpeech = true;
    this.speechEndAt = at;
    this.silenceMs = 0;
    this.speechMs += MS_PER_FRAME;
    if (!this.speechAnnounced && this.capture.needsWakeWord && this.speechMs >= SPEECH_CONFIRM_MS) {
      this.speechAnnounced = true;
      this.emit("speech", this.meta());
    }
  }

  // ---- wake word -------------------------------------------------------------

  private runWake(frame: Int16Array, at: number): WakeDetection | null {
    if (!this.wake || this.verifying) return null;
    if (at - this.lastWakeAt < WAKE_REFRACTORY_MS) {
      // Still feed the engine so its internal state stays continuous.
      try {
        this.wake.process(frame, at);
      } catch {
        /* ignore */
      }
      return null;
    }
    try {
      const det = this.wake.process(frame, at);
      if (det) this.lastWakeAt = at;
      return det;
    } catch (err: any) {
      this.emit("error", `wake detector failed: ${String(err?.message ?? err)} — falling back to transcript matching`);
      this.wake = null;
      this.alwaysOn = true;
      return null;
    }
  }

  /**
   * The detector heard the name. Start (or keep) capturing right away so the
   * command that follows is not lost, then either confirm immediately or ask
   * the engine's verifier and confirm once it agrees.
   */
  private onWakeDetected(det: WakeDetection) {
    if (this.state === "idle") {
      this.beginCapture({ needsWakeWord: true, wake: "acoustic", noSpeechMs: DEFAULT_NO_SPEECH_MS });
      // The frame the word ended in belongs to the capture too.
      this.captured.push(det.frame ?? new Int16Array(0));
      if (!det.frame) this.captured.pop();
    }
    if (!this.wake?.verify) {
      this.confirmWake(det);
      return;
    }
    this.emit("wakeCandidate", det);
    this.verifying = true;
    const recent = [...this.captured];
    this.wake
      .verify(det, recent)
      .then((ok) => {
        if (ok) this.confirmWake(det);
        else if (this.state === "capturing" && this.capture.wake === "acoustic" && !this.alwaysOn) {
          // Not the name, and nothing else wants this capture.
          this.resetCapture();
        }
      })
      .catch(() => {
        // A verifier that fails is no reason to drop the turn: trust the detector.
        this.confirmWake(det);
      })
      .finally(() => {
        this.verifying = false;
      });
  }

  private confirmWake(det: WakeDetection) {
    this.wake?.reset();
    if (this.state === "idle") {
      this.beginCapture({ needsWakeWord: false, wake: "acoustic", noSpeechMs: DEFAULT_NO_SPEECH_MS });
    } else {
      this.capture.needsWakeWord = false;
      this.capture.wake = "acoustic";
      if (this.capture.noSpeechMs === undefined) this.capture.noSpeechMs = DEFAULT_NO_SPEECH_MS;
    }
    // Handlers run synchronously here and may tag the capture with a turn id.
    this.emit("wake", det);
    this.emit("listening", this.meta());
  }

  // ---- barge-in --------------------------------------------------------------

  /**
   * Runs on every frame while Echo is speaking. Distinguishes the user talking
   * over it from its own voice echoing back into the microphone.
   */
  private watchForBargeIn(rms: number, speechThreshold: number, prob: number) {
    if (!this.cfg.voice.bargeIn) return;

    if (this.source?.aec) {
      // Echo's own voice is not in these frames. Speech here is the user.
      const speech = prob >= 0 ? prob >= VAD_BARGE : rms >= speechThreshold;
      if (speech) {
        this.bargeFrames++;
        if (this.bargeFrames >= BARGE_FRAMES_AEC) {
          this.bargeFrames = 0;
          this.emit("bargein", Math.round(rms), Math.round(speechThreshold));
        }
      } else if (this.bargeFrames > 0) {
        this.bargeFrames--;
      }
      return;
    }

    const settling = Date.now() - this.speakingSince < BARGE_BLOCK_MS;
    const bar = Math.max(this.echoPeak * BARGE_FACTOR, speechThreshold);

    // A running peak rather than an average: Echo can never exceed its own
    // peak, so its own voice structurally cannot trigger an interruption, while
    // your voice adds on top of it and does. Frames already over the bar are
    // candidate interruptions and must not raise the peak, or it would chase
    // your voice upward and the bar would outrun you.
    if (settling || rms < bar) {
      this.echoPeak = Math.max(rms, this.echoPeak * 0.995); // decay ~4s half-life
    }
    if (settling) return;

    // Clear both bars: louder than the echo, and loud enough to be speech at
    // all — and, when the VAD can say, actually speech rather than a bang.
    const loud = rms >= bar;
    const speechy = prob < 0 || prob >= VAD_BARGE;
    if (loud && speechy) {
      this.bargeFrames++;
      if (this.bargeFrames >= BARGE_FRAMES) {
        this.bargeFrames = 0;
        this.emit("bargein", Math.round(rms), Math.round(bar));
      }
    } else if (this.bargeFrames > 0) {
      this.bargeFrames--; // decay rather than reset, so a dip mid-word is tolerated
    }
  }

  // ---- end of utterance ------------------------------------------------------

  private async finishCapture() {
    const frames = this.captured;
    const peak = Math.round(this.peakRms);
    const threshold = Math.round(this.speechThreshold);
    const sawSpeech = this.sawSpeech;
    const meta = this.meta();
    this.resetCapture();

    if (!sawSpeech || frames.length < 6) {
      // Report why the audio was dropped. Discarding silently is what made this
      // look like Echo was ignoring the user when it simply never heard them.
      this.emit(
        "discarded",
        !sawSpeech
          ? `nothing loud enough to be speech — peak level ${peak}, needed ${threshold}`
          : `too short (${frames.length} frames)`,
        meta
      );
      return;
    }
    const path = join(tmpdir(), `echo-utter-${Date.now()}.wav`);
    try {
      await writeWav(frames, path, SAMPLE_RATE);
      this.emit("utterance", path, meta.needsWakeWord, meta);
    } catch (err: any) {
      this.emit("error", `failed to save audio: ${String(err?.message ?? err)}`);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      this.source?.stop();
      this.source?.release();
    } catch {
      /* ignore */
    }
    try {
      this.wake?.release();
      this.vad?.release();
    } catch {
      /* ignore */
    }
    this.emit("stopped");
  }
}

export function frameRms(frame: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}
