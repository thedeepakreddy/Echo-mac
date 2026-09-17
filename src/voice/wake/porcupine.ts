import { existsSync } from "node:fs";
import type { WakeDetector, WakeDetection } from "./detector.js";

/**
 * Porcupine: Picovoice's keyword spotter, listening for a custom "Echo" model.
 *
 * The library was installed and documented from the start but never wired up —
 * the listener's "Porcupine wake word" comment sat above a transcript matcher.
 * This is the wiring. It needs two things the repo cannot ship: an access key
 * (free for personal use at console.picovoice.ai, put it in .env as
 * PICOVOICE_ACCESS_KEY) and a keyword file for the word "Echo" trained on that
 * same console for macOS. Porcupine's built-in keywords do not include it.
 *
 * Runs on the listener's own 512-sample frames (that IS Porcupine's frame) and
 * answers within a frame or two of the word ending.
 */
export class PorcupineWake implements WakeDetector {
  readonly name: string;
  readonly frameLength = 512;
  private handle: any;

  private constructor(handle: any, keyword: string) {
    this.handle = handle;
    this.name = `porcupine:${keyword}`;
  }

  static async load(keywordPath: string, accessKey: string, sensitivity: number): Promise<PorcupineWake | null> {
    if (!keywordPath || !existsSync(keywordPath)) return null;
    if (!accessKey) {
      console.warn("[wake] porcupine keyword present but PICOVOICE_ACCESS_KEY is empty — engine skipped");
      return null;
    }
    let Porcupine: any;
    try {
      ({ Porcupine } = await import("@picovoice/porcupine-node"));
    } catch {
      return null;
    }
    try {
      const s = Math.min(1, Math.max(0, sensitivity));
      const handle = new Porcupine(accessKey, [keywordPath], [s]);
      if (handle.frameLength !== 512 || handle.sampleRate !== 16000) {
        console.warn(`[wake] porcupine wants ${handle.frameLength} @ ${handle.sampleRate}; the listener delivers 512 @ 16000`);
      }
      const keyword = keywordPath.split("/").pop()?.replace(/_mac\.ppn$|\.ppn$/, "") ?? "keyword";
      return new PorcupineWake(handle, keyword);
    } catch (err) {
      console.error("[wake] porcupine failed to load:", (err as any)?.message ?? err);
      return null;
    }
  }

  process(frame: Int16Array, at: number): WakeDetection | null {
    const idx = this.handle.process(frame);
    if (idx < 0) return null;
    return { engine: this.name, score: 1, at, keyword: "echo", frame };
  }

  reset(): void {
    /* Porcupine keeps no state worth clearing between detections */
  }

  release(): void {
    try {
      this.handle.release();
    } catch {
      /* ignore */
    }
  }
}
