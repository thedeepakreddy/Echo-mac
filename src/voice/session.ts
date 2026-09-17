import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { voiceLog, type TurnSummary } from "./voice-log.js";

/**
 * The voice session: one state machine for everything between the microphone
 * and the speaker.
 *
 * Before this, the same facts lived in a dozen flags spread across main.ts and
 * the listener — `paused`, `expectAnswer`, `conversationActive`, the TTS
 * generation counter — and they disagreed with each other in exactly the
 * moments that mattered (the user talking while the chirp played, a reply
 * arriving after a stop). Here every turn has an id and a generation, every
 * transition is logged, and "is this output still wanted?" has one answer.
 *
 *   sleeping ──wake──► waking ──► listening ──► endpointing ──► thinking ──► speaking
 *      ▲                                                          │            │
 *      └────────── window closes ◄──── active_idle ◄──────────────┴────────────┘
 *
 * `active_idle` is the conversation window: after a turn, speech alone starts
 * the next one — no wake word — until the window times out. `confirming` is a
 * pending yes/no question; `interrupted` is the brief moment after a cancel.
 */

export type VoiceState =
  | "sleeping"
  | "waking"
  | "listening"
  | "endpointing"
  | "thinking"
  | "speaking"
  | "active_idle"
  | "confirming"
  | "interrupted";

/** How a turn came to exist. Logged, and used to decide whether a wake word is owed. */
export type WakeKind = "acoustic" | "transcript" | "manual" | "window" | "bargein" | "confirm" | "answer" | "typed";

export interface Turn {
  id: string;
  /** The session generation this turn belongs to; a cancel moves the session past it. */
  generation: number;
  wake: WakeKind;
  /** Aborts network work that belongs only to this turn (STT/TTS streams, an LLM request on a hard stop). */
  abort: AbortController;
  startedAt: number;
  cancelled: boolean;
  brainDone: boolean;
  speechDone: boolean;
  settled: boolean;
}

export type CancelKind = "bargein" | "stop";

export interface SessionOptions {
  /** Length of the conversation window after a turn, in ms. Read at open time. */
  windowMs: () => number;
}

export class VoiceSession extends EventEmitter {
  state: VoiceState = "sleeping";
  /** Bumped by every cancel. Anything produced under an older generation is stale. */
  generation = 0;
  private seq = 0;
  private turn: Turn | null = null;
  /** Generation in force when the brain was last given work. */
  private brainGeneration = -1;
  private brainTurn: Turn | null = null;
  private windowTimer: NodeJS.Timeout | null = null;
  windowOpen = false;
  private queue: Array<{ label: string; fn: () => Promise<void> }> = [];
  private draining = false;

  constructor(private readonly opts: SessionOptions) {
    super();
  }

  get current(): Turn | null {
    return this.turn;
  }

  /** The turn whose output the brain is currently producing, if any. */
  get brainTurnId(): string | null {
    return this.brainTurn?.id ?? null;
  }

  transition(next: VoiceState, why?: string): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    voiceLog.event("state", { state: next, prev, why, turnId: this.turn?.id });
    this.emit("state", next, prev, this.turn);
  }

  /**
   * Start a turn. Called the moment something decides the user is talking to
   * Echo — an acoustic wake, a click, speech inside the window — so that every
   * later stage can stamp its time against the same id.
   */
  beginTurn(wake: WakeKind, at = performance.now()): Turn {
    const turn: Turn = {
      id: `t${++this.seq}`,
      generation: this.generation,
      wake,
      abort: new AbortController(),
      startedAt: at,
      cancelled: false,
      brainDone: false,
      speechDone: false,
      settled: false,
    };
    this.turn = turn;
    voiceLog.event("capture.start", { turnId: turn.id, wake });
    if (wake === "bargein") this.transition("listening", "barge-in");
    else if (wake === "typed") this.transition("thinking", "typed command");
    else this.transition("listening", wake);
    return turn;
  }

  isCurrent(turnId: string | undefined): boolean {
    return !!turnId && this.turn?.id === turnId;
  }

  /** Is output produced under this generation still wanted? */
  isLive(generation: number): boolean {
    return generation === this.generation;
  }

  /** The brain has been given this turn's command (or a typed one). */
  noteBrainSend(turn: Turn | null, text: string, provider?: string): void {
    this.brainGeneration = this.generation;
    this.brainTurn = turn;
    if (turn) turn.brainDone = false;
    voiceLog.event("brain.send", { turnId: turn?.id, chars: text.length, provider });
    this.transition("thinking", "sent to brain");
  }

  /** Should what the brain is saying right now be spoken? False after a cancel. */
  brainOutputIsLive(): boolean {
    return this.brainGeneration === this.generation;
  }

  /** Text arrived from the brain — stamps first-token latency on its turn. */
  noteBrainText(text: string): void {
    const turnId = this.brainTurn?.id;
    voiceLog.event("llm.first_text", { turnId, chars: text.length });
    voiceLog.event("llm.text", { turnId, chars: text.length });
  }

  noteBrainDone(): void {
    const t = this.brainTurn;
    voiceLog.event("llm.done", { turnId: t?.id });
    if (t) {
      t.brainDone = true;
      this.settleIfDone(t);
    }
    if (this.state === "thinking") this.transition("active_idle", "brain finished without speech");
  }

  /** Speech for the brain's turn started/stopped playing (from the TTS layer). */
  noteSpeaking(speaking: boolean): void {
    const t = this.brainTurn ?? this.turn;
    if (speaking) {
      // audio.start itself is stamped by the player when sound actually begins.
      voiceLog.event("note", { turnId: t?.id, speaking: true });
      if (t) t.speechDone = false;
      this.transition("speaking", "audio playing");
    } else {
      voiceLog.event("audio.end", { turnId: t?.id });
      if (t) {
        t.speechDone = true;
        this.settleIfDone(t);
      }
      if (this.state === "speaking") this.transition(this.windowOpen ? "active_idle" : "sleeping", "audio finished");
    }
  }

  /** Once the brain is done AND the last audio has played, the turn's numbers are final. */
  private settleIfDone(t: Turn): void {
    if (t.settled || !t.brainDone || !t.speechDone) return;
    t.settled = true;
    const summary = voiceLog.finishTurn(t.id);
    this.emit("turnSummary", summary);
  }

  /**
   * Cancel whatever is in flight.
   *
   * A barge-in only cancels the *speech*: the brain may be mid-task and the
   * user talking over it is usually a new instruction, not "stop everything".
   * A stop cancels the brain as well. Either way the generation moves on, so
   * output that was already on its way is dropped at the boundary instead of
   * being spoken a moment later.
   */
  cancel(kind: CancelKind, reason: string): Turn | null {
    const t = this.turn;
    this.generation++;
    if (t) {
      t.cancelled = true;
      try {
        t.abort.abort(new Error(`cancelled: ${reason}`));
      } catch {
        /* nothing listening */
      }
    }
    voiceLog.event(kind === "bargein" ? "barge_in" : "cancel", { turnId: t?.id, reason, kind });
    this.transition("interrupted", reason);
    this.emit("cancel", kind, reason, t);
    return t;
  }

  // ---- conversation window -------------------------------------------------

  openWindow(why = "turn completed"): void {
    const ms = this.opts.windowMs();
    if (ms <= 0) return;
    const wasOpen = this.windowOpen;
    this.windowOpen = true;
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = setTimeout(() => this.closeWindow("timed out"), ms);
    voiceLog.event(wasOpen ? "window.extend" : "window.open", { turnId: this.turn?.id, ms, why });
    if (!wasOpen) this.emit("window", true);
  }

  /** A user turn inside the window keeps it open. */
  extendWindow(): void {
    if (this.windowOpen) this.openWindow("user spoke");
  }

  closeWindow(why: string): void {
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    if (!this.windowOpen) return;
    this.windowOpen = false;
    voiceLog.event("window.close", { turnId: this.turn?.id, why });
    if (this.state === "active_idle" || this.state === "interrupted") this.transition("sleeping", `window closed: ${why}`);
    this.emit("window", false);
  }

  // ---- serialization --------------------------------------------------------

  /**
   * Run utterance handlers one at a time, in order. Two captures landing close
   * together used to transcribe and reach the brain concurrently, which is how
   * one spoken sentence became two overlapping commands.
   */
  enqueue(label: string, fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({
        label,
        fn: async () => {
          try {
            await fn();
          } catch (err) {
            console.error(`[voice] ${label} failed:`, (err as any)?.message ?? err);
          } finally {
            resolve();
          }
        },
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        await item.fn();
      }
    } finally {
      this.draining = false;
    }
  }

  get pending(): number {
    return this.queue.length + (this.draining ? 1 : 0);
  }
}

export type { TurnSummary };
