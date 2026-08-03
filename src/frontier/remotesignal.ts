/**
 * The plumbing between the phone and the Mac, minus the network.
 *
 * Three separate flows run over the one connection, and keeping them apart is
 * what makes the whole thing testable without a browser or a socket:
 *
 *   1. WebRTC signalling — the phone and the Mac have to swap a description of
 *      how to reach each other (an SDP offer and answer) and a trickle of
 *      network candidates. Neither is on the wire yet when this runs; this is
 *      just the mailbox they leave those messages in for each other.
 *
 *   2. Commands — what the phone tells Jarvis to do. Queued rather than executed
 *      here, so the risky business of actually running them stays in one place
 *      that goes through the safety gate.
 *
 *   3. Confirmations — when Jarvis hits something irreversible, the question has
 *      to travel OUT to the phone and the answer back IN. This holds the pending
 *      question and matches the answer to it by id, so a stale "yes" cannot
 *      approve a different action than the one that was shown.
 *
 * All of it is a plain in-memory relay: nothing here persists, because a phone
 * session is exactly the sort of thing that should evaporate on restart.
 */

// ---- WebRTC signalling ----------------------------------------------------

export interface Sdp {
  type: "offer" | "answer";
  sdp: string;
}

export interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/**
 * One negotiation between the phone (the offerer) and the Mac (the answerer).
 *
 * ICE candidates arrive in a trickle and out of order relative to whoever is
 * polling, so each side's candidates are queued and handed over once, never
 * replayed — a candidate applied twice is at best wasted work.
 */
export class Signalling {
  private offer: Sdp | null = null;
  private answer: Sdp | null = null;
  private toMac: IceCandidate[] = [];
  private toPhone: IceCandidate[] = [];
  /** Bumped whenever the phone starts a new negotiation, so the Mac can tell. */
  private generation = 0;

  /** The phone posts its offer. Starts a fresh negotiation, discarding any old one. */
  setOffer(offer: Sdp): number {
    this.offer = offer;
    this.answer = null;
    this.toMac = [];
    this.toPhone = [];
    this.generation += 1;
    return this.generation;
  }

  /** The Mac reads the offer it must answer. */
  takeOffer(): { offer: Sdp; generation: number } | null {
    return this.offer ? { offer: this.offer, generation: this.generation } : null;
  }

  /** The Mac posts its answer. */
  setAnswer(answer: Sdp): void {
    this.answer = answer;
  }

  /** The phone polls for the answer to its offer. */
  getAnswer(): Sdp | null {
    return this.answer;
  }

  addCandidate(from: "phone" | "mac", c: IceCandidate): void {
    (from === "phone" ? this.toMac : this.toPhone).push(c);
  }

  /** Drain the candidates destined for one side. Returned once, then cleared. */
  drainCandidates(forSide: "mac" | "phone"): IceCandidate[] {
    const q = forSide === "mac" ? this.toMac : this.toPhone;
    const out = q.splice(0, q.length);
    return out;
  }

  reset(): void {
    this.offer = null;
    this.answer = null;
    this.toMac = [];
    this.toPhone = [];
  }

  get gen(): number {
    return this.generation;
  }
}

// ---- commands from the phone ----------------------------------------------

export interface Command {
  id: string;
  at: number;
  text: string;
  /** "typed" or "voice", only for how it is shown back. */
  via: "typed" | "voice";
}

/** How long a single command may be, to keep a stray paste from flooding the brain. */
export const MAX_COMMAND_LEN = 2000;

/**
 * Validate and normalise a command from the phone.
 *
 * Rejects the empty and the enormous. Everything else is passed through — the
 * phone has full control by the user's choice, so this does not try to be a
 * second opinion on WHAT is asked, only that it is a sane string. The safety
 * gate downstream is where risky actions are still caught and confirmed.
 */
export function normaliseCommand(raw: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "not text" };
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > MAX_COMMAND_LEN) return { ok: false, reason: "too long" };
  return { ok: true, text };
}

// ---- confirmations relayed to the phone -----------------------------------

export interface PendingConfirm {
  id: string;
  at: number;
  /** The human sentence describing what is about to happen. */
  prompt: string;
  /** The risk tier, so the phone can colour it. */
  tier: string;
}

/**
 * A question awaiting an answer from the phone, matched by id.
 *
 * The id match is the safety-critical part. A confirmation shown on the phone
 * ("send this email to Bob?") must be answered as itself — if the answer were
 * matched only by "the latest pending question", a delayed tap could approve a
 * DIFFERENT action that had since taken its place. So an answer names the id it
 * is answering, and an answer to anything else is discarded.
 */
export class ConfirmRelay {
  private pending: PendingConfirm | null = null;
  private resolver: ((approved: boolean) => void) | null = null;

  /**
   * Ask the phone. Returns a promise that resolves when the phone answers, or
   * when `timeoutMs` passes with no answer — in which case the answer is NO,
   * because silence must never approve something irreversible.
   */
  ask(prompt: string, tier: string, timeoutMs: number, id = uid()): { id: string; answered: Promise<boolean> } {
    // A new question supersedes any unanswered one, which is denied so its
    // caller is not left hanging forever.
    if (this.resolver) {
      this.resolver(false);
      this.resolver = null;
    }
    this.pending = { id, at: Date.now(), prompt, tier };

    const answered = new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.pending?.id === id) this.pending = null;
        if (this.resolver === wrapped) this.resolver = null;
        resolve(v);
      };
      const wrapped = (v: boolean) => finish(v);
      this.resolver = wrapped;
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
    return { id, answered };
  }

  /** What the phone should currently be showing, if anything. */
  current(): PendingConfirm | null {
    return this.pending;
  }

  /**
   * The phone answers. Ignored unless it names the question actually pending,
   * so a stale answer cannot approve the wrong action.
   */
  answer(id: string, approved: boolean): boolean {
    if (!this.pending || this.pending.id !== id || !this.resolver) return false;
    this.resolver(approved);
    return true;
  }

  /** Deny and clear anything outstanding — used when the phone disconnects. */
  cancel(): void {
    if (this.resolver) {
      this.resolver(false);
      this.resolver = null;
    }
    this.pending = null;
  }

  /**
   * Clear a specific question because it was already answered elsewhere.
   *
   * When the confirmation is approved out loud at the Mac, the phone must stop
   * showing it — but WITHOUT re-resolving anything, since the real answer has
   * already been acted on. This just removes it from view.
   */
  dismiss(id: string): void {
    if (this.pending?.id === id) {
      this.pending = null;
      this.resolver = null;
    }
  }

  get isPending(): boolean {
    return this.pending !== null;
  }
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
