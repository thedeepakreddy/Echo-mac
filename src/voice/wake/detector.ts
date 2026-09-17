/**
 * A wake-word detector that listens to the raw microphone frames.
 *
 * This is the piece Echo never had: the old "wake word" was a string match on
 * whisper's transcript, which only ran once an utterance had ended and been
 * transcribed — so "Echo" was decided a second after it was said, by a model
 * with no idea it was listening for a name. A detector here sees every 32 ms
 * frame as it arrives and answers the one question "was the name just said?"
 * within a frame or two of the word ending.
 *
 * Three engines implement it (see wake/index.ts): Porcupine with a custom
 * keyword file, an openWakeWord-format ONNX model, and a built-in template
 * spotter that needs nothing downloaded or trained. All of them take the same
 * 512-sample, 16 kHz frames the listener already reads.
 */

export interface WakeDetection {
  /** Which engine fired. */
  engine: string;
  /** Detector confidence in 0..1 where the engine has one; 1 for binary engines. */
  score: number;
  /** performance.now() at the frame the word ended in. */
  at: number;
  /** The keyword that matched, when the engine listens for more than one. */
  keyword?: string;
  /** The frame the detection fired on, so the capture can include it. */
  frame?: Int16Array;
}

export interface WakeDetector {
  readonly name: string;
  /** Frames per detection frame — every engine here wants 512 @ 16 kHz. */
  readonly frameLength: number;
  /**
   * Feed one frame. Returns a detection when the word has just been heard,
   * else null. Must be cheap: it runs on every frame, in the audio loop.
   */
  process(frame: Int16Array, at: number): WakeDetection | null;
  /**
   * Some engines want a second opinion before committing (the template spotter
   * asks whisper to confirm a candidate). Optional; when present the listener
   * awaits it before treating the detection as real, but starts capturing
   * immediately so nothing said meanwhile is lost.
   */
  verify?(detection: WakeDetection, recent: Int16Array[]): Promise<boolean>;
  /** Forget any state, e.g. after a detection or a long pause. */
  reset(): void;
  release(): void;
}

/** Shared refractory: no engine may fire twice within this many ms. */
export const WAKE_REFRACTORY_MS = 1500;
