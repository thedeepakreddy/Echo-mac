import { detectFailure, type Failure } from "./watchers.js";

/**
 * Noticing when the person using this is having a bad time, and behaving
 * differently about it.
 *
 * The detection here is not the hard part — repeated failures, long sessions
 * and late hours are all plainly visible. The hard part is restraint. An
 * assistant that pipes up with "you seem frustrated!" the moment a build fails
 * is not perceptive, it is irritating, and irritating is worse than silent.
 *
 * So the rules are deliberately grudging:
 *
 *   - The SAME problem has to recur. A single failure is just a failure; you
 *     already know about it and were probably about to fix it.
 *   - There is a floor on how often help can be offered, regardless of how bad
 *     things look.
 *   - Declining an offer suppresses the next few. Being told "no" and asking
 *     again shortly after is the specific behaviour people hate most.
 *   - Nothing is ever said while the user is mid-sentence or mid-command; the
 *     existing attention system already owns that, and this defers to it.
 *
 * Most of what this produces is not an interruption at all — it is a change in
 * how Jarvis answers when spoken to. Shorter, less chatty, more direct. That
 * costs nothing and is right far more often than speaking up would be.
 */

export type Mood = "fresh" | "working" | "stuck" | "tired";

export interface UserState {
  mood: Mood;
  /** Why, in words, for explaining itself when asked. */
  reasons: string[];
  /** How long the current session has run, in minutes. */
  sessionMinutes: number;
  /** Distinct repeats of the most-repeated recent problem. */
  repeats: number;
}

interface Seen {
  at: number;
  signature: string;
  kind: Failure["kind"];
}

/**
 * Failures older than this stop counting toward "stuck".
 *
 * Comfortably longer than the offer cooldown below. When the two were close,
 * the evidence expired at almost the same moment Jarvis became willing to
 * speak again, so a genuinely long fight with one problem could fall into the
 * gap and never be noticed.
 */
const FAILURE_WINDOW_MS = 45 * 60_000;
/** The same problem this many times before it counts as being stuck. */
const REPEATS_FOR_STUCK = 3;
/** A gap this long means a new session, not a continuing one. */
const SESSION_GAP_MS = 20 * 60_000;
/** Continuous work beyond this is tiring regardless of the clock. */
const LONG_SESSION_MIN = 180;
/** Never offer help more often than this. */
const OFFER_COOLDOWN_MS = 20 * 60_000;
/** After a refusal, stay quiet for this long. */
const REFUSAL_BACKOFF_MS = 90 * 60_000;

let failures: Seen[] = [];
let sessionStart = 0;
let lastActivity = 0;
let lastOffer = 0;
let refusedAt = 0;
let offersDeclined = 0;

/**
 * Reduce a failure to what makes it "the same problem".
 *
 * Error text is never byte-identical between runs — line numbers move,
 * timestamps and paths differ, durations change. Comparing raw strings would
 * mean the same error never looks repeated, and the feature would never fire.
 */
export function signatureOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "#")
    // Not `\b\d+\b`: there is no word boundary between the digit and the unit
    // in "1.2s", so that pattern left the "2" in place and "failed after 1.2s"
    // and "failed after 8.9s" read as different problems — which is exactly
    // the repetition this is supposed to notice.
    .replace(/\d[\d.,]*/g, "#")
    .replace(/["'`][^"'`]*["'`]/g, "@")
    .replace(/\/[^\s:]+/g, "/p")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Note that the user did something. Keeps the session clock honest. */
export function noteActivity(now = Date.now()) {
  if (!sessionStart || now - lastActivity > SESSION_GAP_MS) {
    // A long gap means they went away and came back; that is a fresh session,
    // not a nine-hour one with a hole in the middle.
    sessionStart = now;
  }
  lastActivity = now;
}

/** Feed screen text in. Returns the failure if this looked like one. */
export function observeText(text: string, now = Date.now()): Failure | null {
  const f = detectFailure(text);
  if (!f) return null;
  failures.push({ at: now, signature: signatureOf(f.evidence), kind: f.kind });
  // Bound the list; only a recent window ever matters.
  failures = failures.filter((s) => now - s.at <= FAILURE_WINDOW_MS);
  return f;
}

/** How many times the most-repeated recent problem has appeared. */
export function repeatCount(now = Date.now()): { count: number; signature: string } {
  const recent = failures.filter((s) => now - s.at <= FAILURE_WINDOW_MS);
  const tally = new Map<string, number>();
  for (const s of recent) tally.set(s.signature, (tally.get(s.signature) ?? 0) + 1);

  let best = "";
  let count = 0;
  for (const [sig, n] of tally) {
    if (n > count) {
      count = n;
      best = sig;
    }
  }
  return { count, signature: best };
}

/** Is it the small hours? */
export function isLate(now = Date.now()): boolean {
  const h = new Date(now).getHours();
  return h >= 23 || h < 5;
}

export function assess(now = Date.now()): UserState {
  const { count } = repeatCount(now);
  const sessionMinutes = sessionStart ? Math.round((now - sessionStart) / 60_000) : 0;
  const reasons: string[] = [];

  let mood: Mood = "fresh";

  if (sessionMinutes > 20) mood = "working";

  // Tiredness is about the clock and the length of the sitting, and it is
  // judged BEFORE being stuck so that a long night of the same error reads as
  // stuck rather than merely late — that is the more actionable of the two.
  const late = isLate(now);
  if (late) reasons.push("it's the middle of the night");
  if (sessionMinutes >= LONG_SESSION_MIN) reasons.push(`you've been at this ${Math.floor(sessionMinutes / 60)} hours`);
  if (late || sessionMinutes >= LONG_SESSION_MIN) mood = "tired";

  if (count >= REPEATS_FOR_STUCK) {
    reasons.push(`the same problem has come up ${count} times`);
    mood = "stuck";
  }

  return { mood, reasons, sessionMinutes, repeats: count };
}

/**
 * May Jarvis say something unprompted right now?
 *
 * Deliberately hard to satisfy. Every condition here exists because the
 * alternative is an assistant that talks when it should not.
 */
export function mayOfferHelp(state: UserState, now = Date.now()): boolean {
  // Only ever for being stuck. Being tired is not something to be told about.
  if (state.mood !== "stuck") return false;
  // One failure is not a pattern.
  if (state.repeats < REPEATS_FOR_STUCK) return false;
  if (now - lastOffer < OFFER_COOLDOWN_MS) return false;
  // Told no recently: stay out of the way. Each refusal costs more.
  if (refusedAt && now - refusedAt < REFUSAL_BACKOFF_MS * Math.max(1, offersDeclined)) return false;
  // Three refusals means this person does not want it. Stop asking.
  if (offersDeclined >= 3) return false;
  return true;
}

export function noteOffered(now = Date.now()) {
  lastOffer = now;
}

export function noteDeclined(now = Date.now()) {
  refusedAt = now;
  offersDeclined++;
}

export function noteAccepted() {
  // Taking the offer is evidence it was welcome; forgive the earlier refusals.
  offersDeclined = 0;
  refusedAt = 0;
}

/**
 * What to say when offering. Never more than one sentence.
 *
 * `now` is injectable so the wording — which shifts late at night — can be
 * tested deterministically. Reading the wall clock directly is what made the
 * "same error" line untestable, since a fixed-time test still hit the real hour.
 */
export function offerText(state: UserState, now = Date.now()): string {
  if (state.mood !== "stuck") return "";
  return state.sessionMinutes >= LONG_SESSION_MIN || isLate(now)
    ? "That's the same error a few times now — want me to take a look?"
    : "That's come up a few times — want me to look at it properly?";
}

/**
 * Guidance folded into the brain's context, so answers match the moment.
 *
 * This is the part that does most of the work, because it never interrupts:
 * it only changes how a reply reads once the user has asked for one.
 */
export function styleFor(state: UserState): string {
  switch (state.mood) {
    case "stuck":
      return (
        "The user has hit the same problem several times. Be direct and concrete: " +
        "lead with the most likely cause, skip preamble and encouragement, and do not " +
        "restate what they already know."
      );
    case "tired":
      return (
        "It is late or this has been a long session. Keep answers short, do not start " +
        "new tangents, and don't suggest ambitious work. If something can wait until " +
        "tomorrow, say so."
      );
    case "working":
      return "The user is mid-task. Answer briefly and don't interrupt their flow.";
    default:
      return "";
  }
}

export function describe(state: UserState): string {
  const base =
    state.mood === "stuck" ? "You seem to be fighting something" :
    state.mood === "tired" ? "It's been a long stretch" :
    state.mood === "working" ? "You're in the middle of something" :
    "Everything looks calm";
  const why = state.reasons.length ? ` — ${state.reasons.join(", ")}` : "";
  return `${base}${why}.`;
}

/** Wipe all accumulated signals. Used by tests and on quit. */
export function reset() {
  failures = [];
  sessionStart = 0;
  lastActivity = 0;
  lastOffer = 0;
  refusedAt = 0;
  offersDeclined = 0;
}
