import { loadConfig } from "../config.js";
import { createBrain, Brain } from "../brain/index.js";
import { presenceMonitor } from "./presence.js";
import {
  nextQuestion, pendingCount, markAttempted, markDone, saveBrief,
  buildPrompt, mayRun, MAX_QUESTION_MS,
} from "./research.js";

/**
 * Running the overnight queue.
 *
 * The lifecycle mistakes here were already made once by the idle rehearsal, so
 * this copies its fixes rather than rediscovering them:
 *
 *   - The brain is held at MODULE scope, so returning to your desk can actually
 *     stop it. Keeping the handle inside the start function meant "stand down"
 *     flipped a flag while the agent carried on working.
 *   - Teardown interrupts before stopping. stop() alone lets an in-flight turn
 *     finish, which is exactly the turn you wanted to end.
 *   - There is a hard deadline. A run that has not finished by then is stuck,
 *     not thorough.
 *
 * One question at a time, and never more than the nightly budget: an agent that
 * works all night on your account is a thing you should have chosen.
 */

let enabled = false;
let running = false;
let activeBrain: Brain | null = null;
let activeDeadline: NodeJS.Timeout | null = null;
let activeId: string | null = null;
let collected = "";
let doneTonight = 0;
let nightStamp = "";
let pollTimer: NodeJS.Timeout | null = null;

/** How often to check whether conditions allow a run. */
const POLL_MS = 2 * 60_000;

function tonight(now = Date.now()): string {
  // "Tonight" rolls over at midday, not midnight — otherwise a session that
  // runs past 00:00 would silently reset the nightly budget and start again.
  const d = new Date(now - 12 * 3600_000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function setResearchEnabled(on: boolean) {
  enabled = on;
  if (!on) {
    stopResearchNow();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    return;
  }
  if (!pollTimer) pollTimer = setInterval(() => void tick(), POLL_MS);
}

export function isResearching(): boolean {
  return running;
}

export function researchStatus(): string {
  const waiting = pendingCount();
  if (!enabled) return `Overnight research is off. ${waiting} question(s) queued for when you turn it on.`;
  if (running) return "I'm researching something right now.";
  const c = { enabled, away: presenceMonitor.isAway?.() === true, doneTonight: budgetUsed(), pending: waiting };
  const { ok, why } = mayRun(c);
  return ok ? "Ready to start on the next question." : `Waiting — ${why}.`;
}

function budgetUsed(now = Date.now()): number {
  if (nightStamp !== tonight(now)) {
    nightStamp = tonight(now);
    doneTonight = 0;
  }
  return doneTonight;
}

async function tick() {
  if (running || !enabled) return;
  const c = {
    enabled,
    away: presenceMonitor.isAway?.() === true,
    doneTonight: budgetUsed(),
    pending: pendingCount(),
  };
  if (!mayRun(c).ok) return;
  await startOne();
}

async function startOne() {
  const q = nextQuestion();
  if (!q) return;

  running = true;
  activeId = q.id;
  collected = "";
  markAttempted(q.id);
  console.log(`[research] you're away — looking into: ${q.text.slice(0, 60)}…`);

  activeDeadline = setTimeout(() => {
    console.log("[research] taking too long — stopping");
    void finish(q.text, false);
  }, MAX_QUESTION_MS);

  try {
    const cfg = loadConfig(process.cwd());
    activeBrain = createBrain(cfg, {
      identity: { id: "echo-research", name: "Echo Research", kind: "research" },
      autoResume: false,
    }).brain;
    // Collect the prose rather than speaking it: nobody is there to hear it,
    // and the point is the file waiting in the morning.
    activeBrain.on("text", (t: string) => {
      collected += t;
    });
    activeBrain.on("turnEnd", () => void finish(q.text, true));
    activeBrain.on("error", () => void finish(q.text, false));
    activeBrain.send(buildPrompt(q.text));
  } catch (err) {
    console.error("[research] could not start:", (err as any)?.message ?? err);
    void finish(q.text, false);
  }
}

/** Tear down and record the outcome. Safe to call repeatedly. */
async function finish(question: string, ok: boolean) {
  if (activeDeadline) {
    clearTimeout(activeDeadline);
    activeDeadline = null;
  }
  const brain = activeBrain;
  const id = activeId;
  const body = collected;
  activeBrain = null;
  activeId = null;
  collected = "";
  running = false;

  if (brain) {
    try {
      // Interrupt first: stop() alone lets an in-flight turn keep working.
      brain.interrupt();
      await brain.stop();
    } catch {
      /* nothing useful to do if teardown fails */
    }
  }

  // A few words is a failure that happened to exit cleanly, not a brief.
  if (ok && id && body.trim().length > 120) {
    try {
      const file = saveBrief(question, body);
      markDone(id, file);
      doneTonight = budgetUsed() + 1;
      console.log(`[research] wrote ${file}`);
    } catch (err) {
      console.error("[research] could not save the brief:", (err as any)?.message ?? err);
    }
  }
}

/** Called when the user returns, so research never competes with them. */
export function stopResearchNow() {
  if (!running) return;
  console.log("[research] you're back — standing down");
  void finish("", false);
}
