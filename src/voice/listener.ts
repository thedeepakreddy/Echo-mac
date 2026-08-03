import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWav } from "./wav.js";
import type { JarvisConfig } from "../config.js";

const FRAME_LENGTH = 512; // Porcupine's required frame length @ 16kHz
const SAMPLE_RATE = 16000;
const MS_PER_FRAME = (FRAME_LENGTH / SAMPLE_RATE) * 1000; // ~32ms
/**
 * Speech detection adapts to the microphone instead of using a fixed level.
 * Measured on a MacBook with AirPods as the default input, ordinary speech sat
 * around RMS 200 with a noise floor near 65 — a hardcoded threshold of 550
 * classified almost every spoken frame as silence, so captures never started
 * (or ended mid-sentence). We track the quiet baseline and treat anything a
 * few times above it as speech, which works across headsets and built-in mics.
 */
const SPEECH_FACTOR = 2.5; // speech = this many times the rolling noise floor
const MIN_SPEECH_RMS = 110; // absolute floor, so a silent room can't self-trigger
const INITIAL_NOISE_FLOOR = 60;

/**
 * Barge-in: hearing the user start talking while Jarvis is still speaking.
 *
 * The obstacle is self-hearing — the microphone picks up Jarvis's own voice
 * through the speakers, so listening naively during playback makes it interrupt
 * itself on its own words.
 *
 * We track the loudest level Jarvis's playback reaches at the mic and require a
 * genuine interruption to clear a multiple of it. A running PEAK rather than an
 * average is the point: Jarvis can never exceed its own peak, so its own voice
 * structurally cannot trigger, while your voice adds on top of it and does.
 * An earlier averaging version failed both ways — first chasing the user's
 * voice so nothing ever fired, then learning silence during playback startup so
 * Jarvis cut itself off every sentence.
 *
 * On headphones the peak stays near room level and barge-in is easy; on open
 * speakers it rises and demands a louder voice. It calibrates either way.
 */
const BARGE_FACTOR = 1.6; // how far above Jarvis's own peak the user has to be
const BARGE_FRAMES = 6; // ~192ms sustained, so a cough or click doesn't cut in
/**
 * Barge-in stays off for this long after Jarvis is asked to speak, while the
 * peak learns what its playback sounds like.
 *
 * Measured rather than guessed: `say` synthesises before it plays, and first
 * audible sound arrived 719, 900, 901 and 1322 ms after spawn on this machine.
 * Anything shorter and the window closes before playback even starts, leaving
 * the peak at room level — which is exactly the bug where Jarvis cut itself off
 * on its own first word. The cost is that interrupting inside this window does
 * not register; click the reactor or press the hotkey for that.
 */
const BARGE_BLOCK_MS = 1500;
const PREROLL_FRAMES = 8; // ~256ms kept before capture starts, so we don't clip

type ListenerState = "idle" | "capturing";

/**
 * Owns the single microphone pipeline. Continuously reads audio frames; if the
 * Porcupine wake word is available it listens for "Jarvis", and either the wake
 * word or a manual trigger (button / hotkey) starts capturing an utterance,
 * which is endpointed on silence and emitted as a WAV path for transcription.
 *
 * Emits: 'ready'(bool wakeWordEnabled), 'wake', 'listening', 'utterance'(wavPath),
 *        'level'(0..1), 'stopped', 'error'(msg), 'unavailable'(reason)
 */
export class VoiceListener extends EventEmitter {
  private recorder: any = null;
  private state: ListenerState = "idle";
  private running = false;
  private preroll: Int16Array[] = [];
  private captured: Int16Array[] = [];
  private silenceMs = 0;
  private captureMs = 0;
  private sawSpeech = false;
  private paused = false; // suspended while Jarvis is speaking, to avoid self-hearing
  /** True when this capture began on its own and must prove it said "Jarvis". */
  private needsWakeWord = false;
  /** Capture every spoken utterance (keyless wake word verified in the transcript). */
  private alwaysOn = false;
  /** Rolling estimate of room noise, used to derive the speech threshold. */
  private noiseFloor = INITIAL_NOISE_FLOOR;
  /** Loudest frame in the current capture — reported when audio is discarded. */
  private peakRms = 0;
  /** While Jarvis speaks: loudest level its own voice reaches at the mic. */
  private echoPeak = 0;
  private speakingSince = 0;
  private bargeFrames = 0;

  /** Current level above which a frame counts as speech. */
  private get speechThreshold(): number {
    return Math.max(MIN_SPEECH_RMS, this.noiseFloor * SPEECH_FACTOR);
  }

  constructor(private cfg: JarvisConfig) {
    super();
  }

  async start(): Promise<void> {
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

    // Wake word defaults to the keyless path, where every utterance is captured
    // and the wake word is checked in the transcript we already produce.
    this.alwaysOn = true;

    try {
      // Worth surfacing which input this resolves to: if it lands on a headset
      // sitting in its case, Jarvis hears almost nothing and looks broken
      // rather than simply deaf.
      const deviceIndex = this.resolveDevice(PvRecorder);
      this.recorder = new PvRecorder(FRAME_LENGTH, deviceIndex);
      this.recorder.start();
      this.emit("device", this.recorder.getSelectedDevice?.() ?? `index ${deviceIndex}`);
    } catch (err: any) {
      this.emit(
        "unavailable",
        `Could not open the microphone (${String(err?.message ?? err)}). Grant Microphone permission in System Settings, or type commands in the HUD.`
      );
      return;
    }

    this.running = true;
    this.emit("ready", this.alwaysOn, "whisper");
    void this.loop();
  }

  /** Manually begin capturing an utterance (push-to-talk / HUD mic button). */
  triggerListen() {
    if (!this.running || this.paused) return;
    // Explicit trigger — the user already asked for attention, so no wake word.
    this.beginCapture(false);
  }

  /**
   * Called when Jarvis starts and stops speaking.
   *
   * This used to hard-mute the microphone, which is why you had to wait for
   * Jarvis to finish before saying anything. Now the mic keeps running and
   * listens for you cutting in; only capture is suspended, not hearing.
   */
  setPaused(paused: boolean) {
    if (paused && !this.paused) {
      // Seed from the room's own noise level, NOT zero. Zero meant that on
      // headphones — where Jarvis barely reaches the mic at all — the first
      // thing loud enough to train the estimate was the user, who then became
      // the baseline instead of an interruption. Room level degrades correctly:
      // an inaudible echo leaves the peak there and any real speech clears it.
      this.echoPeak = this.noiseFloor;
      this.speakingSince = Date.now();
      this.bargeFrames = 0;
    }
    this.paused = paused;
    if (paused && this.state === "capturing") this.resetCapture();
  }

  /** Turn the configured inputDevice (index, name fragment, or -1) into an index. */
  private resolveDevice(PvRecorder: any): number {
    const want = this.cfg.voice.inputDevice ?? -1;
    if (typeof want === "number") return want;

    try {
      const devices: string[] = PvRecorder.getAvailableDevices() ?? [];
      const i = devices.findIndex((d) =>
        d.toLowerCase().includes(String(want).toLowerCase())
      );
      if (i >= 0) return i;
      this.emit("error", `No microphone matching "${want}" — using the system default.`);
    } catch {
      /* fall back to the default below */
    }
    return -1;
  }

  private beginCapture(needsWakeWord: boolean) {
    this.state = "capturing";
    this.needsWakeWord = needsWakeWord;
    this.captured = [...this.preroll];
    this.silenceMs = 0;
    this.captureMs = 0;
    this.sawSpeech = false;
    this.peakRms = 0;
    // Only announce an explicit capture. In always-on mode every stray noise
    // would otherwise light the reactor up as though it were taking an order.
    if (!needsWakeWord) this.emit("listening");
  }

  private resetCapture() {
    this.state = "idle";
    this.captured = [];
    this.sawSpeech = false;
  }

  private async loop() {
    while (this.running) {
      let frame: Int16Array;
      try {
        frame = await this.recorder.read();
      } catch (err: any) {
        if (this.running) this.emit("error", `mic read failed: ${String(err?.message ?? err)}`);
        break;
      }

      const rms = frameRms(frame);
      const threshold = this.speechThreshold;
      // Only report level while actually capturing. Reporting it all the time
      // makes the reactor pulse to your voice even when nothing is being
      // recorded, which reads as "Jarvis heard me" when it did not. Scaled off
      // the threshold so the reactor responds on a quiet mic too.
      this.emit(
        "level",
        this.state === "capturing" ? Math.min(1, rms / (threshold * 3)) : 0
      );

      if (this.paused) {
        this.watchForBargeIn(rms, threshold);
        continue;
      }

      if (this.state === "idle") {
        // Track the quiet baseline: fall towards quiet frames quickly, rise
        // slowly, so a passing noise doesn't desensitise the microphone.
        this.noiseFloor =
          rms < this.noiseFloor
            ? this.noiseFloor * 0.9 + rms * 0.1
            : this.noiseFloor * 0.995 + rms * 0.005;

        // Maintain a short pre-roll ring buffer.
        this.preroll.push(frame);
        if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();

        if (this.alwaysOn && rms >= threshold) {
          // Someone started speaking. Capture it and let the transcript decide
          // whether it was actually addressed to Jarvis.
          this.beginCapture(true);
        }
      } else {
        // Capturing an utterance.
        this.captured.push(frame);
        this.captureMs += MS_PER_FRAME;
        if (rms > this.peakRms) this.peakRms = rms;
        // Hysteresis: once speaking, a lower level still counts as speech, so
        // quiet syllables between words don't look like the end of a sentence.
        if (rms >= (this.sawSpeech ? threshold * 0.6 : threshold)) {
          this.sawSpeech = true;
          this.silenceMs = 0;
        } else {
          this.silenceMs += MS_PER_FRAME;
        }

        const enoughSilence = this.sawSpeech && this.silenceMs >= this.cfg.voice.silenceMs;
        const tooLong = this.captureMs >= this.cfg.voice.maxUtteranceMs;
        if (enoughSilence || tooLong) {
          await this.finishCapture();
        }
      }
    }
  }

  /**
   * Runs on every frame while Jarvis is speaking. Distinguishes the user
   * talking over it from its own voice echoing back into the microphone.
   */
  private watchForBargeIn(rms: number, speechThreshold: number) {
    if (!this.cfg.voice.bargeIn) return;

    const settling = Date.now() - this.speakingSince < BARGE_BLOCK_MS;
    const bar = Math.max(this.echoPeak * BARGE_FACTOR, speechThreshold);

    // A running peak rather than an average: Jarvis can never exceed its own
    // peak, so its own voice structurally cannot trigger an interruption, while
    // your voice adds on top of it and does. Frames already over the bar are
    // candidate interruptions and must not raise the peak, or it would chase
    // your voice upward and the bar would outrun you.
    if (settling || rms < bar) {
      this.echoPeak = Math.max(rms, this.echoPeak * 0.995); // decay ~4s half-life
    }

    if (settling) return;

    // Clear both bars: louder than the echo, and loud enough to be speech at all.
    if (rms >= bar) {
      this.bargeFrames++;
      if (this.bargeFrames >= BARGE_FRAMES) {
        this.bargeFrames = 0;
        this.emit("bargein", Math.round(rms), Math.round(bar));
      }
    } else if (this.bargeFrames > 0) {
      this.bargeFrames--; // decay rather than reset, so a dip mid-word is tolerated
    }
  }

  private async finishCapture() {
    const frames = this.captured;
    const peak = Math.round(this.peakRms);
    const threshold = Math.round(this.speechThreshold);
    const sawSpeech = this.sawSpeech;
    this.resetCapture();

    if (!sawSpeech || frames.length < 6) {
      // Report why the audio was dropped. Discarding silently is what made this
      // look like Jarvis was ignoring the user when it simply never heard them.
      this.emit(
        "discarded",
        !sawSpeech
          ? `nothing loud enough to be speech — peak level ${peak}, needed ${threshold}`
          : `too short (${frames.length} frames)`
      );
      return;
    }
    const path = join(tmpdir(), `jarvis-utter-${Date.now()}.wav`);
    const needsWakeWord = this.needsWakeWord;
    try {
      await writeWav(frames, path, SAMPLE_RATE);
      this.emit("utterance", path, needsWakeWord);
    } catch (err: any) {
      this.emit("error", `failed to save audio: ${String(err?.message ?? err)}`);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      this.recorder?.stop();
      this.recorder?.release();
    } catch {
      /* ignore */
    }
    this.emit("stopped");
  }
}

function frameRms(frame: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}
