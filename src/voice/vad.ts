import { existsSync } from "node:fs";

/**
 * Voice activity detection on the listener's frames.
 *
 * The listener used to decide "speech or not" from a single RMS level against
 * a rolling noise floor. That is a loudness detector, not a speech detector:
 * a soft first syllable sits under the bar, a door or a keyboard sits over it,
 * and the end of a sentence is whatever length of quiet the timer was set to.
 * Silero VAD is a small neural model that answers the actual question — is
 * this speech — per 32 ms frame, and its native chunk size at 16 kHz is 512
 * samples, exactly the frame the microphone already delivers.
 *
 * The RMS path stays as the fallback (see listener.ts) for when the model or
 * onnxruntime is unavailable.
 */

export interface Vad {
  readonly name: string;
  /** Probability that this frame is speech, 0..1. */
  process(frame: Int16Array): number;
  reset(): void;
  release(): void;
}

/** Speech starts when the probability clears this... */
export const VAD_START = 0.5;
/** ...and continues while it stays above this (hysteresis for quiet syllables). */
export const VAD_CONTINUE = 0.35;
/** Frames in a row above VAD_START before a capture begins (2 × 32 ms). */
export const VAD_START_FRAMES = 2;
/** A barge-in wants to be sure: this probability, for BARGE_VAD_FRAMES frames. */
export const VAD_BARGE = 0.6;

const SAMPLE_RATE = 16000;
const FRAME = 512;

/**
 * Silero VAD v5 through onnxruntime-node.
 *
 * Inputs: `input` [1, 64 + 512] float32 — the chunk with the LAST 64 SAMPLES
 * OF THE PREVIOUS CHUNK in front of it, which is how the v5 graph expects to
 * be fed (its Python wrapper does the same; feeding a bare 512 scores clear
 * speech at 0.0) — `state` [2, 1, 128] float32, `sr` int64. Outputs: `output`
 * [1, 1] probability and `stateN` the carried state. The state and the
 * context are what make it a stream: both must be carried across chunks and
 * cleared when the audio is no longer continuous.
 */
const CONTEXT = 64;
export class SileroVad implements Vad {
  readonly name = "silero";
  private session: any;
  private state: Float32Array = new Float32Array(2 * 1 * 128);
  private ort: any;
  private srTensor: any;
  private failures = 0;

  private constructor(ort: any, session: any) {
    this.ort = ort;
    this.session = session;
    this.srTensor = new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  }

  /** Load the model; null when onnxruntime or the file is missing. */
  static async load(modelPath: string): Promise<SileroVad | null> {
    if (!existsSync(modelPath)) return null;
    let ort: any;
    try {
      ort = await import("onnxruntime-node");
    } catch {
      return null;
    }
    try {
      const session = await ort.InferenceSession.create(modelPath, {
        // One thread: it is a ~1 ms model and the audio loop is single-threaded.
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        graphOptimizationLevel: "all",
        logSeverityLevel: 3,
      });
      return new SileroVad(ort, session);
    } catch (err) {
      console.error("[vad] could not load silero model:", (err as any)?.message ?? err);
      return null;
    }
  }

  /**
   * Synchronous in signature, asynchronous underneath: onnxruntime-node only
   * runs asynchronously, so the probability returned is the latest one
   * computed — normally for the previous frame — while this frame is queued.
   * Frames are fed to the model strictly in order (the state must be
   * continuous), and one frame (32 ms) of lag is well inside every threshold
   * that uses it. The microphone loop never waits on the model.
   */
  private last = 0;
  private pending: Float32Array[] = [];
  private running = false;

  private context = new Float32Array(CONTEXT);

  private released = false;

  process(frame: Int16Array): number {
    if (this.released) return -1;
    const input = new Float32Array(CONTEXT + FRAME);
    input.set(this.context, 0);
    for (let i = 0; i < FRAME; i++) input[CONTEXT + i] = (frame[i] ?? 0) / 32768;
    this.context = input.slice(FRAME); // the tail of this chunk leads the next
    // Never let a stall pile up unbounded; dropping old frames beats lagging.
    if (this.pending.length > 8) this.pending.splice(0, this.pending.length - 8);
    this.pending.push(input);
    if (!this.running) void this.pump();
    return this.last;
  }

  private async pump(): Promise<void> {
    this.running = true;
    try {
      while (this.pending.length) {
        const input = this.pending.shift()!;
        try {
          const out = await this.session.run({
            input: new this.ort.Tensor("float32", input, [1, CONTEXT + FRAME]),
            state: new this.ort.Tensor("float32", this.state.slice(), [2, 1, 128]),
            sr: this.srTensor,
          });
          this.last = Number(out.output?.data?.[0] ?? 0);
          const st = out.stateN?.data;
          if (st && st.length === this.state.length) this.state.set(st);
          this.failures = 0;
        } catch (err: any) {
          if (this.released) return; // torn down mid-inference at shutdown: not an error
          if (this.failures++ === 0) console.error("[vad] inference failed:", err?.message ?? err);
          this.last = -1; // tells the listener to fall back to RMS
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** The latest probability without feeding audio (tests, diagnostics). */
  peek(): number {
    return this.last;
  }

  /** Wait for everything queued to be scored (tests). */
  async settle(): Promise<void> {
    while (this.running || this.pending.length) await new Promise((r) => setTimeout(r, 1));
  }

  reset(): void {
    this.state.fill(0);
    this.context.fill(0);
    this.last = 0;
    this.pending = [];
  }

  release(): void {
    this.released = true;
    this.pending = [];
    try {
      this.session?.release?.();
    } catch {
      /* ignore */
    }
  }
}
