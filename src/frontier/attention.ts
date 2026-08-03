/**
 * Decides *when* Jarvis is allowed to speak.
 *
 * An assistant that interrupts you mid-thought gets muted on day two, so
 * non-urgent output waits for a moment when you are actually available. Three
 * signals feed the decision, cheapest first:
 *
 *   - typing: mid-keystroke is the worst possible moment
 *   - presence: nobody there means nobody to talk to
 *   - gaze: looking at your editor means you are in it
 *
 * Nothing waits forever. Anything held past its deadline is spoken anyway —
 * silently dropping information would be a worse failure than interrupting.
 */

export type Urgency = "now" | "soon" | "whenever";

export interface HeldMessage {
  text: string;
  urgency: Urgency;
  queuedAt: number;
  /** Speak by this time regardless of what the user is doing. */
  deadline: number;
}

/** How long each urgency may be held before it is spoken regardless. */
const MAX_HOLD: Record<Urgency, number> = {
  now: 0, // errors, direct answers, confirmations — never held
  soon: 45_000,
  whenever: 5 * 60_000,
};

/** Typing within this window counts as "actively working". */
const TYPING_WINDOW_MS = 2500;

export interface AttentionState {
  /** Last time a keystroke was observed. */
  lastTypedAt: number;
  /** Someone is in front of the camera. */
  present: boolean;
  /** Eyes are on the screen. */
  lookingAtScreen: boolean;
  /** Sensors unavailable — fall back to interrupting rather than going mute. */
  sensorsActive: boolean;
}

export class Attention {
  private held: HeldMessage[] = [];
  private state: AttentionState = {
    lastTypedAt: 0,
    present: true,
    lookingAtScreen: false,
    sensorsActive: false,
  };

  /** Feed in whatever the sensors currently report. */
  update(patch: Partial<AttentionState>) {
    this.state = { ...this.state, ...patch };
  }

  noteTyping(now = Date.now()) {
    this.state.lastTypedAt = now;
  }

  /** Is the user deep in something right now? */
  isBusy(now = Date.now()): boolean {
    if (now - this.state.lastTypedAt < TYPING_WINDOW_MS) return true;
    // Only trust gaze when the sensors are actually running; otherwise a
    // default of "not looking" would hold every message forever.
    if (this.state.sensorsActive && this.state.lookingAtScreen) return true;
    return false;
  }

  /**
   * Decide what to do with a message.
   * Returns the text to speak now, or null if it should wait.
   */
  offer(text: string, urgency: Urgency = "soon", now = Date.now()): string | null {
    if (urgency === "now" || !this.isBusy(now)) return text;
    this.held.push({ text, urgency, queuedAt: now, deadline: now + MAX_HOLD[urgency] });
    return null;
  }

  /**
   * Anything ready to say. Call on a timer and whenever the user goes idle.
   * Messages past their deadline come out even if the user is still busy.
   */
  release(now = Date.now()): string[] {
    if (!this.held.length) return [];
    const overdue = this.held.filter((m) => now >= m.deadline);
    const free = !this.isBusy(now);

    const out = free ? this.held : overdue;
    if (!out.length) return [];
    this.held = free ? [] : this.held.filter((m) => now < m.deadline);
    return out.map((m) => m.text);
  }

  /** Nothing queued is worth saying once it is this stale. */
  pending(): number {
    return this.held.length;
  }

  clear() {
    this.held = [];
  }

  describe(now = Date.now()): string {
    const s = this.state;
    const bits = [
      this.isBusy(now) ? "you look busy" : "you seem free",
      s.sensorsActive ? (s.present ? "present" : "away") : "sensors off",
      s.sensorsActive && s.lookingAtScreen ? "looking at the screen" : "",
      this.held.length ? `${this.held.length} message(s) waiting` : "nothing waiting",
    ].filter(Boolean);
    return bits.join(", ");
  }
}

export const attention = new Attention();

/**
 * Classify a message so callers do not have to. Errors and questions must never
 * be held; observations can wait.
 */
export function urgencyOf(text: string): Urgency {
  const t = text.toLowerCase();
  if (/\?\s*$/.test(text.trim())) return "now"; // a question awaiting an answer
  if (/\b(error|failed|failing|broke|broken|crash|denied|cannot|couldn't)\b/.test(t)) return "now";
  if (/\b(done|finished|complete|ready|saved|found)\b/.test(t)) return "soon";
  return "whenever";
}
