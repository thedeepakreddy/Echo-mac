import { createRequire } from "node:module";
import { speak } from "../voice/speaker.js";

const nodeRequire = createRequire(import.meta.url);

/**
 * Companion mode: an occasional, warm check-in while you work.
 *
 * The whole risk here is being annoying, so the restraint is the feature. It
 * speaks only when ALL of these hold: mode is on, you've actually moved (you're
 * at the desk), a long cooldown has elapsed, and a coin-flip passes. That makes
 * it a rare, pleasant surprise rather than a chatterbox.
 *
 * The decision logic is separated from the timer and the OS so it can be tested
 * without a real clock, mouse, or voice.
 */

const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours between check-ins
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // look every 5 minutes

export const COMPANION_PHRASES = [
  "Hey, Echo here. Just checking in — how's your day going so far?",
  "Echo here. You've been at it a while; everything going okay?",
  "Echo here. How's the work treating you?",
  "Taking a quick breath — how has your day been?",
  "Echo here. Just wanted to see how you're doing today.",
];

export interface CompanionState {
  lastPos: { x: number; y: number } | null;
  lastSpokenAt: number;
}

export const newCompanionState = (): CompanionState => ({ lastPos: null, lastSpokenAt: 0 });

/**
 * Decide whether to speak on this tick, and update state.
 *
 * @param roll a 0..1 value (Math.random in production) — the coin flip.
 * Returns the phrase to say, or null to stay quiet.
 */
export function decideCheckIn(
  state: CompanionState,
  pos: { x: number; y: number },
  now: number,
  roll: number,
  cooldownMs = COOLDOWN_MS
): string | null {
  const moved = state.lastPos !== null && (pos.x !== state.lastPos.x || pos.y !== state.lastPos.y);
  const first = state.lastPos === null;
  state.lastPos = pos;

  // The very first tick only establishes a baseline — never speaks.
  if (first || !moved) return null;
  // Never having spoken (lastSpokenAt 0) counts as "cooldown satisfied", so the
  // first check-in can happen without assuming epoch-0 was two hours ago.
  const cooldownOk = state.lastSpokenAt === 0 || now - state.lastSpokenAt >= cooldownMs;
  if (!cooldownOk) return null;
  if (roll >= 0.25) return null; // a 1-in-4 chance, so it stays a surprise

  state.lastSpokenAt = now;
  const idx = Math.min(COMPANION_PHRASES.length - 1, Math.floor((roll / 0.25) * COMPANION_PHRASES.length));
  return COMPANION_PHRASES[idx];
}

// ---- the live wiring ------------------------------------------------------

let companionInterval: NodeJS.Timeout | null = null;
let enabled = false;
const state = newCompanionState();

export function isCompanionActive(): boolean {
  return enabled;
}

/**
 * Turn companion mode on or off. Speaks through the app's real voice (the
 * shared speaker), so it honours the user's chosen voice and mute setting.
 */
export function toggleCompanion(enable: boolean): void {
  enabled = enable;

  if (!enable) {
    if (companionInterval) clearInterval(companionInterval);
    companionInterval = null;
    return;
  }
  if (companionInterval) return;

  let screen: any;
  try {
    screen = nodeRequire("electron")?.screen;
  } catch {
    /* not in the main process */
  }
  if (!screen?.getCursorScreenPoint) {
    console.error("[jarvis] companion mode needs the Electron main process; not starting.");
    enabled = false;
    return;
  }

  state.lastPos = screen.getCursorScreenPoint();
  state.lastSpokenAt = 0;

  companionInterval = setInterval(() => {
    const phrase = decideCheckIn(state, screen.getCursorScreenPoint(), Date.now(), Math.random());
    if (phrase) speak(phrase);
  }, CHECK_INTERVAL_MS);
}
