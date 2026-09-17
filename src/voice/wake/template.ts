import { existsSync, readFileSync } from "node:fs";
import type { WakeDetector, WakeDetection } from "./detector.js";
import { MfccStream, cmn, dtwEndAligned, FRAME_DIMS } from "./mfcc.js";

/**
 * The built-in wake-word spotter: nothing to download, train or sign up for.
 *
 * It keeps a few dozen examples of the word "Echo" as MFCC sequences —
 * synthesised from the Mac's own voices by `npm run enroll -- --seed`, plus
 * the real people who use this machine via `npm run enroll` — and every ~130 ms
 * asks, with dynamic time warping, whether the last second of audio ends in
 * something shaped like one of them. Template matching is the oldest trick in
 * keyword spotting; on a single short word with examples in several voices it
 * is good enough to fire early and on soft speech, which is what the transcript
 * match could never do.
 *
 * Its weakness is false accepts on similar-sounding words, so it does not act
 * alone: a candidate is handed to `verify`, which runs the resident whisper
 * model over the last second and confirms the name is actually there (~120 ms).
 * The listener starts capturing the moment the candidate fires, so the
 * verification costs no words — only the chirp waits for it.
 */

export interface TemplateStore {
  version: 1;
  dims: number;
  /** DTW cost per frame at or under which a window counts as the name. */
  threshold: number;
  templates: Array<{ name: string; source: "seed" | "enroll"; frames: number[][] }>;
}

/** How much recent audio the word is looked for in (MFCC frames of 10 ms). */
const RING_FRAMES = 130;
/** Check every N microphone frames (4 × 32 ms ≈ 128 ms). */
const CHECK_EVERY = 4;
/** Frames the word may be: shorter is a click, longer is a sentence. */
const MIN_TEMPLATE = 20;
const MAX_TEMPLATE = 110;
/** Speech-ish energy in the last ~300 ms before DTW is even attempted. */
const ENERGY_HISTORY = 10;

export class TemplateWake implements WakeDetector {
  readonly name = "template";
  readonly frameLength = 512;
  private mfcc = new MfccStream();
  private ring: Float32Array[] = [];
  private templates: Float32Array[][];
  private sinceCheck = 0;
  private recentRms: number[] = [];
  private floor = 60;
  /** The latest best DTW cost, for tests and tuning. */
  lastCost = Infinity;

  constructor(
    store: TemplateStore,
    private readonly threshold: number,
    private readonly verifier?: (frames: Int16Array[], score?: number) => Promise<boolean>
  ) {
    this.templates = store.templates
      .filter((t) => t.frames.length >= MIN_TEMPLATE && t.frames.length <= MAX_TEMPLATE)
      .map((t) => cmn(t.frames.map((f) => Float32Array.from(f))));
    if (!this.templates.length) throw new Error("template store has no usable templates");
  }

  static load(
    storePath: string,
    opts: { threshold?: number; verifier?: (frames: Int16Array[], score?: number) => Promise<boolean> } = {}
  ): TemplateWake | null {
    if (!existsSync(storePath)) return null;
    try {
      const store = JSON.parse(readFileSync(storePath, "utf8")) as TemplateStore;
      if (store.version !== 1 || store.dims !== FRAME_DIMS || !store.templates?.length) return null;
      return new TemplateWake(store, opts.threshold ?? store.threshold, opts.verifier);
    } catch (err) {
      console.error("[wake] template store unreadable:", (err as any)?.message ?? err);
      return null;
    }
  }

  get templateCount(): number {
    return this.templates.length;
  }

  process(frame: Int16Array, at: number): WakeDetection | null {
    for (const f of this.mfcc.push(frame)) this.ring.push(f);
    if (this.ring.length > RING_FRAMES) this.ring.splice(0, this.ring.length - RING_FRAMES);

    // Energy gate: DTW on silence is wasted work and the source of phantom
    // matches against very quiet templates.
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.995 + rms * 0.005;
    this.recentRms.push(rms);
    if (this.recentRms.length > ENERGY_HISTORY) this.recentRms.shift();

    if (++this.sinceCheck < CHECK_EVERY) return null;
    this.sinceCheck = 0;
    if (this.ring.length < MIN_TEMPLATE + 10) return null;
    if (Math.max(...this.recentRms) < Math.max(90, this.floor * 1.5)) return null;

    const cost = this.bestCost();
    this.lastCost = cost;
    if (cost > this.threshold) return null;
    // Fresh start for the next word: the same frames must not fire twice.
    this.ring = [];
    return { engine: this.name, score: Math.max(0, Math.min(1, 1 - cost / (this.threshold * 1.5))), at, keyword: "echo", frame };
  }

  /** Lowest per-frame DTW cost of any template against the end of the ring. */
  bestCost(): number {
    const tail = cmn(this.ring.slice(-Math.min(this.ring.length, RING_FRAMES)));
    let best = Infinity;
    for (const t of this.templates) {
      const c = dtwEndAligned(t, tail);
      if (c < best) best = c;
    }
    return best;
  }

  /** Offline scoring for the test harness: the best cost over a whole clip, checked as a stream would. */
  static scoreClip(detector: TemplateWake, samples: Int16Array): number {
    detector.reset();
    let best = Infinity;
    for (let off = 0; off + 512 <= samples.length; off += 512) {
      const frame = samples.subarray(off, off + 512);
      for (const f of detector.mfcc.push(frame)) detector.ring.push(f);
      if (detector.ring.length > RING_FRAMES) detector.ring.splice(0, detector.ring.length - RING_FRAMES);
      if (++detector.sinceCheck < CHECK_EVERY) continue;
      detector.sinceCheck = 0;
      if (detector.ring.length < MIN_TEMPLATE + 10) continue;
      const c = detector.bestCost();
      if (c < best) best = c;
    }
    return best;
  }

  async verify(det: WakeDetection, recent: Int16Array[]): Promise<boolean> {
    if (!this.verifier) return true;
    // The score matters to the verifier: when whisper cannot give a usable
    // opinion, how sure THIS detector was is the only evidence left.
    return this.verifier(recent, det.score);
  }

  reset(): void {
    this.ring = [];
    this.mfcc.reset();
    this.sinceCheck = 0;
    this.recentRms = [];
  }

  release(): void {
    /* nothing held */
  }
}
