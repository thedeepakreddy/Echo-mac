import type { Tts } from "./tts.js";

/**
 * One shared voice for the whole app.
 *
 * The main process owns the real Tts (the user's configured voice, the queue,
 * barge-in, the enabled/disabled flag). Background features — companion mode,
 * proactive watchers — run in the tool layer and have no handle on it, so they
 * used to shell out to `say` directly with a hardcoded voice. That bypassed
 * everything the real pipeline does and could talk over Echo mid-sentence.
 *
 * This is the single seam: main registers the real Tts here at startup, and
 * everyone else speaks through `speak()`. Before registration it is a no-op, so
 * nothing crashes if a background timer fires early.
 */
let active: Tts | null = null;

export function setActiveTts(tts: Tts): void {
  active = tts;
}

/** Speak through the app's real, configured voice. No-op until one is set. */
export function speak(text: string): void {
  if (active && text) active.say(text);
}

/** For tests: whether a voice is wired up. */
export function hasActiveTts(): boolean {
  return active !== null;
}
