import { sendToOverlay } from "../overlay.js";

/**
 * The clone swarm: background sub-agents working in parallel.
 *
 * This used to be a scaffold that faked workers with timers, while the real
 * spawning lived inline in the `spawn_subagent` tool. Now this is the single
 * home for it — a sub-agent is an in-process brain (via createBrain), not an OS
 * worker thread, because that is what actually works and is what the tool was
 * already doing.
 *
 * Two honest limits are enforced here:
 *   - A concurrency CAP. Each clone can drive the mouse and keyboard, and there
 *     is only one of each, so an unbounded swarm would trample the user. Beyond
 *     the cap, spawning is refused rather than queued.
 *   - Clones are tracked and cleaned up on completion, so the overlay shows a
 *     true picture and finished brains do not leak.
 *
 * The manager takes its dependencies (how to make a brain, how to broadcast)
 * as arguments, so the whole thing tests without Electron or a real model.
 */

export type CloneStatus = "working" | "done" | "failed";

export interface SwarmClone {
  id: string;
  name: string;
  goal: string;
  status: CloneStatus;
  startedAt: number;
}

/** The slice of a brain a clone needs. Structural, so a fake satisfies it in tests. */
export interface CloneBrain {
  on(event: "text" | "turnEnd" | "error", cb: (arg?: any) => void): unknown;
  send(text: string): void;
}

export interface SwarmDeps {
  /** Make a fresh background brain for one clone. */
  makeBrain: () => CloneBrain;
  /** Push the current roster to the UI. Defaults to the overlay. */
  broadcast?: (clones: Array<{ name: string; progress: string }>) => void;
  now?: () => number;
}

/** At most this many clones at once — they share one mouse and keyboard. */
export const MAX_CONCURRENT_CLONES = 4;

const systemPrompt = (goal: string) =>
  `[SYSTEM: You are an Echo-Clone working quietly in the background.] Your goal: ${goal}. ` +
  `Work autonomously. When you finish, you MUST use the 'remember' tool to save a short summary ` +
  `of what you found or did, so the main Echo can read it later.`;

export class SwarmManager {
  private clones = new Map<string, SwarmClone>();
  private counter = 0;

  count(): number {
    return this.clones.size;
  }
  list(): SwarmClone[] {
    return [...this.clones.values()];
  }

  /**
   * Spawn one clone toward a goal. Refuses (rather than queues) past the cap,
   * and refuses an empty goal.
   */
  spawn(goal: string, deps: SwarmDeps): { ok: boolean; name?: string; reason?: string } {
    const g = (goal ?? "").trim();
    if (!g) return { ok: false, reason: "empty goal" };
    if (this.clones.size >= MAX_CONCURRENT_CLONES) {
      return { ok: false, reason: `already running ${this.clones.size} clones (max ${MAX_CONCURRENT_CLONES})` };
    }

    const now = deps.now ?? Date.now;
    const id = `clone_${now()}_${Math.random().toString(36).slice(2, 7)}`;
    const name = `Echo-clone ${++this.counter}`;
    const clone: SwarmClone = { id, name, goal: g, status: "working", startedAt: now() };
    this.clones.set(id, clone);

    const brain = deps.makeBrain();
    brain.on("text", (t) => console.log(`[${name}] ${t ?? ""}`));
    brain.on("error", () => this.finish(id, "failed", deps));
    brain.on("turnEnd", () => this.finish(id, "done", deps));
    brain.send(systemPrompt(g));

    this.broadcast(deps);
    return { ok: true, name };
  }

  private finish(id: string, status: CloneStatus, deps: SwarmDeps): void {
    const c = this.clones.get(id);
    if (!c) return;
    c.status = status;
    // Drop it from the roster; the summary it saved via `remember` is its
    // lasting output, so the brain object itself is no longer needed.
    this.clones.delete(id);
    this.broadcast(deps);
  }

  private broadcast(deps: SwarmDeps): void {
    const state = this.list().map((c) => ({ name: c.name, progress: c.status }));
    (deps.broadcast ?? ((s) => sendToOverlay("clones", s)))(state);
  }
}

export const swarm = new SwarmManager();
