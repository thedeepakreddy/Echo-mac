import { EventEmitter } from "node:events";

/**
 * Bridges a paused agent turn to the voice loop.
 *
 * `canUseTool` runs deep inside the agent's own loop, but the microphone and
 * speech live in the main process. Rather than reaching across, the broker
 * emits an 'ask' and waits: whoever owns the voice pipeline answers by calling
 * resolve(). That keeps the safety layer testable without any audio at all.
 *
 * Emits: 'ask'({ id, question }), 'settled'({ id, approved, why })
 */
export class ConfirmationBroker extends EventEmitter {
  private pending: { id: string; resolve: (ok: boolean) => void; timer: NodeJS.Timeout } | null = null;

  /** Is a confirmation currently waiting on the user? */
  get isWaiting(): boolean {
    return this.pending !== null;
  }

  /**
   * Ask the user to approve an action. Resolves false on timeout — silence is
   * never taken as consent for something we already judged high risk.
   */
  request(question: string, timeoutMs = 30000): Promise<boolean> {
    // A second request while one is open denies the newcomer rather than
    // stacking prompts the user cannot tell apart.
    if (this.pending) return Promise.resolve(false);

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(id, false, "no answer"), timeoutMs);
      this.pending = { id, resolve, timer };
      this.emit("ask", { id, question });
    });
  }

  /** Answer the open confirmation. Returns false if there was nothing waiting. */
  settle(id: string | null, approved: boolean, why = ""): boolean {
    const p = this.pending;
    if (!p || (id !== null && p.id !== id)) return false;
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(approved);
    this.emit("settled", { id: p.id, approved, why });
    return true;
  }

  /** Interpret a spoken reply. Returns null when it is neither yes nor no. */
  static readAnswer(text: string): boolean | null {
    const t = text.toLowerCase().replace(/[^a-z\s]/g, " ").trim();
    if (!t) return null;
    if (/^(no|nope|nah|stop|cancel|don t|do not|abort|never mind|nevermind|negative)\b/.test(t)) return false;
    if (/^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|confirmed|affirmative|please do)\b/.test(t)) return true;
    // Also accept the words appearing alone anywhere in a short reply.
    if (/\b(cancel|abort|stop)\b/.test(t)) return false;
    if (/\b(go ahead|do it|confirmed)\b/.test(t)) return true;
    return null;
  }
}

export const confirmations = new ConfirmationBroker();
