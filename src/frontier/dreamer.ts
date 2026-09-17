import { loadConfig } from "../config.js";
import { createBrain, Brain } from "../brain/index.js";
import { presenceMonitor } from "./presence.js";

/**
 * Practises quietly while you are away, so common paths are already learned.
 *
 * The idea is sound — rehearse navigation when nobody is waiting — but an agent
 * that drives the mouse unattended needs tight limits, and the first version had
 * none. Three rules now hold:
 *
 *   1. Look, never act. The original task list included "add a book to the cart"
 *      on Amazon, which would have put real items in a real basket while its
 *      owner was away. Nothing here may buy, send, submit, or sign in.
 *   2. Only when genuinely away. Idle is not absent — you might be reading.
 *      Watching it fight you for the cursor is worse than no rehearsal at all.
 *   3. Always clean up. Each dream previously left its brain session running, so
 *      every idle period leaked another agent.
 *
 * Off by default: it costs tokens and moves the mouse, which should be a choice.
 */

let idleTimer: NodeJS.Timeout | null = null;
let dreaming = false;
let enabled = false;
/**
 * The rehearsal currently in flight.
 *
 * Held at module scope so returning to your desk can actually stop it. Keeping
 * the handle inside startDreaming() meant "standing down" only flipped a flag
 * while the agent carried on driving the mouse.
 */
let activeBrain: Brain | null = null;
let activeDeadline: NodeJS.Timeout | null = null;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** A dream that has not finished by now is stuck; stop it. */
const MAX_DREAM_MS = 3 * 60 * 1000;

/**
 * Read-only rehearsals on pages with nothing to buy or send.
 * Anything transactional is deliberately absent.
 */
const DREAM_TASKS = [
  "Open Wikipedia's main page and read the featured article heading. Click nothing else.",
  "Open System Settings and note which panes exist. Change nothing.",
  "Open Finder and note the folders in the sidebar. Open nothing.",
  "Open github.com/trending and read the top three repository names. Do not sign in.",
];

export function setDreamingEnabled(on: boolean) {
  enabled = on;
  if (!on && idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

export function isDreaming(): boolean {
  return dreaming;
}

export function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!enabled) return;
  idleTimer = setTimeout(startDreaming, IDLE_TIMEOUT_MS);
}

async function startDreaming() {
  if (dreaming || !enabled) return;

  // Idle is not absent. Only rehearse when presence says nobody is there; if it
  // cannot tell, err toward doing nothing.
  if (!presenceMonitor.isAway?.()) {
    resetIdleTimer();
    return;
  }

  dreaming = true;
  const task = DREAM_TASKS[Math.floor(Math.random() * DREAM_TASKS.length)];
  console.log(`[dreamer] you seem away — rehearsing: ${task.slice(0, 58)}…`);

  // A hard ceiling, so a stuck rehearsal cannot hold the mouse indefinitely.
  activeDeadline = setTimeout(() => {
    console.log("[dreamer] taking too long — stopping");
    void endDream();
  }, MAX_DREAM_MS);

  try {
    const cfg = loadConfig(process.cwd());
    activeBrain = createBrain(cfg, {
      identity: { id: "echo-rehearsal", name: "Echo Rehearsal", kind: "rehearsal" },
      autoResume: false,
    }).brain;
    activeBrain.on("text", (t: string) => console.log(`[dreamer] ${t.slice(0, 100)}`));
    activeBrain.on("turnEnd", () => void endDream());
    activeBrain.on("error", () => void endDream());

    activeBrain.send(
      `You are rehearsing while the user is away from their desk, to learn where things are.\n\n` +
        `Task: ${task}\n\n` +
        `Strict limits: LOOK ONLY. Do not buy, add anything to a cart, send, post, submit, ` +
        `sign in, delete, or change any setting, and do not type into any field. If the task ` +
        `appears to need any of that, stop and say so instead. Keep it under ten steps.`
    );
  } catch (err) {
    console.error("[dreamer] could not start:", (err as any)?.message ?? err);
    void endDream();
  }
}

/** Tear the rehearsal down and go back to waiting. Safe to call repeatedly. */
async function endDream() {
  if (activeDeadline) {
    clearTimeout(activeDeadline);
    activeDeadline = null;
  }
  const brain = activeBrain;
  activeBrain = null;
  dreaming = false;
  if (brain) {
    try {
      // Interrupt first: stop() alone lets an in-flight turn keep acting.
      brain.interrupt();
      await brain.stop();
    } catch {
      /* nothing useful to do if teardown fails */
    }
  }
  resetIdleTimer();
}

/** Called when the user returns, so a rehearsal never fights them for the cursor. */
export function stopDreamingNow() {
  if (!dreaming) return;
  console.log("[dreamer] you're back — standing down");
  // Actually tear the agent down. Flipping the flag alone left it driving the
  // mouse while the user was trying to use their machine.
  void endDream();
}
