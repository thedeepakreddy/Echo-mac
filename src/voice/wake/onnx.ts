import { existsSync } from "node:fs";
import type { WakeDetector, WakeDetection } from "./detector.js";

/**
 * openWakeWord-format keyword models through onnxruntime-node.
 *
 * openWakeWord is a Python project, but its models are plain ONNX and the
 * pipeline is three small graphs run in sequence — so the runtime is portable
 * even though the library is not. A custom "Echo" model is trained in their
 * notebook from synthetic speech in about an hour, with no recordings needed.
 *
 *   melspectrogram.onnx   [1, samples] int16-scaled floats → [1, 1, T, 32]
 *   embedding_model.onnx  [1, 76, 32, 1]                    → [1, 1, 1, 96]
 *   <keyword>.onnx        [1, 16, 96]                        → [1, 1] probability
 *
 * Streaming: every 80 ms (1280 samples) the mel spectrogram of the last ~2 s
 * is refreshed, ONE new 76-frame embedding is computed for the window ending
 * now, and the newest 16 embeddings (≈1.3 s of context) go to the classifier.
 * That is the same 8-mel-frame stepping openWakeWord itself uses.
 */

const SAMPLE_RATE = 16000;
const CHUNK = 1280; // 80 ms
const MEL_WINDOW = 76;
const N_MEL = 32;
const EMB_DIM = 96;
const N_EMB = 16;
/** Audio kept for the mel spectrogram: enough for a 76-frame window plus slack. */
const AUDIO_KEEP = 16000 + 3200; // ~1.2 s (76 frames ≈ 0.76 s + context)

export class OnnxWake implements WakeDetector {
  readonly name: string;
  readonly frameLength = 512;
  private ort: any;
  private mel: any;
  private emb: any;
  private clf: any;
  private audio = new Float32Array(0);
  private pendingSamples = 0;
  private embeddings: Float32Array[] = [];
  private busy = false;
  private lastScore = 0;
  private fire: WakeDetection | null = null;
  private failures = 0;

  private constructor(ort: any, mel: any, emb: any, clf: any, name: string, private readonly threshold: number) {
    this.ort = ort;
    this.mel = mel;
    this.emb = emb;
    this.clf = clf;
    this.name = name;
  }

  static async load(keywordPath: string, modelsDir: string, threshold: number): Promise<OnnxWake | null> {
    const melPath = `${modelsDir}/melspectrogram.onnx`;
    const embPath = `${modelsDir}/embedding_model.onnx`;
    if (!keywordPath || !existsSync(keywordPath) || !existsSync(melPath) || !existsSync(embPath)) return null;
    let ort: any;
    try {
      ort = await import("onnxruntime-node");
    } catch {
      return null;
    }
    try {
      const opts = { intraOpNumThreads: 1, interOpNumThreads: 1, logSeverityLevel: 3 };
      const [mel, emb, clf] = await Promise.all([
        ort.InferenceSession.create(melPath, opts),
        ort.InferenceSession.create(embPath, opts),
        ort.InferenceSession.create(keywordPath, opts),
      ]);
      const name = `onnx:${keywordPath.split("/").pop()?.replace(/\.onnx$/, "")}`;
      return new OnnxWake(ort, mel, emb, clf, name, threshold);
    } catch (err) {
      console.error("[wake] onnx models failed to load:", (err as any)?.message ?? err);
      return null;
    }
  }

  process(frame: Int16Array, at: number): WakeDetection | null {
    // Append raw int16 values as floats — that is what the mel model was trained on.
    const joined = new Float32Array(Math.min(AUDIO_KEEP, this.audio.length + frame.length));
    const keep = joined.length - frame.length;
    if (keep > 0) joined.set(this.audio.subarray(this.audio.length - keep), 0);
    for (let i = 0; i < frame.length; i++) joined[keep + i] = frame[i];
    this.audio = joined;
    this.pendingSamples += frame.length;

    if (this.pendingSamples >= CHUNK && !this.busy && this.audio.length >= AUDIO_KEEP) {
      this.pendingSamples -= CHUNK;
      void this.step(at);
    }
    if (this.fire) {
      const d = { ...this.fire, frame };
      this.fire = null;
      return d;
    }
    return null;
  }

  /** One 80 ms step: refresh the mel, add one embedding, classify. */
  private async step(at: number): Promise<void> {
    this.busy = true;
    try {
      const melOut = await this.mel.run({ [this.mel.inputNames[0]]: new this.ort.Tensor("float32", this.audio.slice(), [1, this.audio.length]) });
      const melT = melOut[this.mel.outputNames[0]];
      const dims: number[] = melT.dims;
      const frames = dims[dims.length - 2];
      const data: Float32Array = melT.data;
      if (frames < MEL_WINDOW) return;
      // openWakeWord's fixed transform before the embedding model.
      const win = new Float32Array(MEL_WINDOW * N_MEL);
      const start = (frames - MEL_WINDOW) * N_MEL;
      for (let i = 0; i < win.length; i++) win[i] = data[start + i] / 10 + 2;
      const embOut = await this.emb.run({ [this.emb.inputNames[0]]: new this.ort.Tensor("float32", win, [1, MEL_WINDOW, N_MEL, 1]) });
      const e: Float32Array = embOut[this.emb.outputNames[0]].data;
      this.embeddings.push(Float32Array.from(e));
      if (this.embeddings.length > N_EMB) this.embeddings.shift();
      if (this.embeddings.length < N_EMB) return;
      const feat = new Float32Array(N_EMB * EMB_DIM);
      for (let i = 0; i < N_EMB; i++) feat.set(this.embeddings[i], i * EMB_DIM);
      const out = await this.clf.run({ [this.clf.inputNames[0]]: new this.ort.Tensor("float32", feat, [1, N_EMB, EMB_DIM]) });
      const score = Number(out[this.clf.outputNames[0]].data[0] ?? 0);
      // A confident step fires at once; a marginal one needs a second in a
      // row, so a single spike on a click does not.
      const fired = score >= Math.max(this.threshold, 0.85) || (score >= this.threshold && this.lastScore >= this.threshold);
      this.lastScore = score;
      if (fired) this.fire = { engine: this.name, score, at, keyword: "echo" };
      this.failures = 0;
    } catch (err: any) {
      if (this.failures++ === 0) console.error("[wake] onnx step failed:", err?.message ?? err);
    } finally {
      this.busy = false;
    }
  }

  /** For tests: the classifier's most recent score. */
  get score(): number {
    return this.lastScore;
  }

  reset(): void {
    this.embeddings = [];
    this.lastScore = 0;
    this.fire = null;
  }

  release(): void {
    for (const s of [this.mel, this.emb, this.clf]) {
      try {
        s?.release?.();
      } catch {
        /* ignore */
      }
    }
  }
}
