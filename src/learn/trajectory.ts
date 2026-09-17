import { appendFile, mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrubSecrets } from "../safety/redact.js";
import { currentAgentRunContext } from "../agent-replay/context.js";
import { currentInvocation } from "../memory/invocation.js";
import { captureAllowed, deletionEpoch } from "../memory/capture-policy.js";

const run = promisify(execFile);

/**
 * Records what the teacher brains actually did, as training data.
 *
 * Every time Claude or Gemini drives the Mac correctly, that is a demonstration
 * nobody else can buy: this user's screen, this user's apps, this user's tools.
 * Discarding it is the only genuinely irreversible waste in the project, so this
 * captures it at the one place every tool call already passes through.
 *
 * Three rules shape the format, and all three exist to stop the dataset going
 * bad in ways that are invisible until training day:
 *
 *   1. Record the observation the model ACTUALLY saw, never a fresh capture.
 *      Re-screenshotting after the fact would pair a decision with a screen that
 *      postdates it — the model would be trained to predict clicks from their
 *      own consequences, which is unlearnable.
 *   2. Tag the source on every row. A student trained on its own output collapses
 *      within a few cycles, so the trainer must be able to exclude anything
 *      DeepakLLM itself produced.
 *   3. Only capture user-initiated turns. Background OCR, rewind sweeps and idle
 *      daemons are not demonstrations of anything, and they would swamp the real
 *      examples by volume.
 *
 * Append-only JSONL with separate label rows, matching the memory store: an
 * outcome is often only knowable a minute later (the user says "no, undo that"),
 * and rewriting history in place would make the file unsafe to read while it is
 * being written.
 */

// Overridable so the test suite can write to a throwaway directory instead of
// the real dataset. Without this the test could only run when no trajectories
// existed — which stopped being true the moment the recorder was switched on,
// leaving the one module that feeds DeepakLLM permanently untested.
const DIR = process.env.JARVIS_TRAJECTORY_DIR || join(homedir(), ".jarvis", "trajectories");
const SCREENS = join(DIR, "screens");

/** Which brain produced the action. Never train on "deepakllm". */
export type Source = "claude" | "gemini" | "ollama" | "deepakllm" | "reflex" | "shortcut" | "unknown";

export type Outcome = "success" | "failure" | "rejected";

export interface Observation {
  kind: "screenshot" | "ocr" | "ax";
  /** Filename under screens/, for the vision channel. */
  image?: string;
  /** OCR or accessibility-tree rendering, truncated. */
  text?: string;
  at: number;
}

/** One (observation, action, result) triple — the unit a VLM trains on. */
export interface StepRow {
  type: "step";
  turn: string;
  taskId?: string; actorId?: string; callId?: string;
  step: number;
  at: number;
  source: Source;
  model: string;
  /** What the user asked for, carried on every step so rows stand alone. */
  command: string;
  observation: Observation | null;
  tool: string;
  args: Record<string, unknown>;
  risk: { tier: string; reason: string };
  /** False when the user refused it — a gold negative for preference tuning. */
  allowed: boolean;
  result: string;
}

/** Written later, once the outcome of a whole turn is known. */
export interface LabelRow {
  type: "label";
  turn: string;
  taskId?: string; actorId?: string; callId?: string;
  at: number;
  outcome: Outcome;
  why: string;
}

export type Row = StepRow | LabelRow;

export interface LearningOptions {
  enabled: boolean;
  /** Store downscaled screenshots. Off = text observations only, far smaller. */
  captureScreens: boolean;
  /**
   * Maximum steps to keep from a single turn. Zero means unlimited, which is
   * the default: a successful task must be saved in full, not as a prefix.
   * A positive cap is still useful for debugging, but a capped turn is never
   * exported as a successful demonstration.
   */
  maxStepsPerTurn: number;
}

const DEFAULTS: LearningOptions = {
  enabled: false,
  captureScreens: true,
  maxStepsPerTurn: 0,
};

let opts: LearningOptions = { ...DEFAULTS };

export function configureLearning(patch: Partial<LearningOptions>): void {
  const max = patch.maxStepsPerTurn;
  opts = {
    ...opts,
    ...patch,
    // A malformed config must not silently turn into a zero-step recorder.
    maxStepsPerTurn:
      max === undefined ? opts.maxStepsPerTurn : Number.isFinite(max) && max >= 0 ? Math.floor(max) : 0,
  };
}

export function learningEnabled(): boolean {
  return opts.enabled;
}

// ---- the current turn ------------------------------------------------------

interface ActiveTurn {
  id: string;
  command: string;
  source: Source;
  model: string;
  step: number;
  /** The most recent thing the model looked at, attached to the next action. */
  observation: Observation | null;
  labelled: boolean;
  /** A handler failed, so this cannot become a teacher demonstration. */
  failed: boolean;
  /** Recording stopped before the task ended due to a configured step cap. */
  truncated: boolean;
}

const turns = new Map<string, ActiveTurn>();
const previousTurns = new Map<string, ActiveTurn>();
function owner(): string { return currentInvocation()?.taskId ?? currentAgentRunContext()?.taskId ?? "main"; }
function activeTurn(): ActiveTurn | null {
  const key = owner();
  // Main's voice dispatch opens a training turn immediately before the run context exists.
  if (!turns.has(key) && key !== "main" && currentAgentRunContext()?.identity.kind === "main" && turns.has("main")) {
    turns.set(key, turns.get("main")!); turns.delete("main");
  }
  return turns.get(key) ?? null;
}

/**
 * Tools whose output IS an observation. Their results become the context the
 * next action is trained against, which is why looking is recorded rather than
 * treated as overhead.
 */
const SEEING: Record<string, Observation["kind"]> = {
  screenshot: "screenshot",
  analyze_screen_visually: "screenshot",
  read_screen_text: "ocr",
  list_ui_elements: "ax",
};

/** Undoing is the clearest failure signal the user ever gives. */
const UNDO_TOOLS = new Set(["undo_last", "undo_recent"]);

const id = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function dayFile(): string {
  return join(DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
}

async function ensure(): Promise<void> {
  if (!existsSync(SCREENS)) await mkdir(SCREENS, { recursive: true });
}

/**
 * A single ordered chain that every disk operation runs on.
 *
 * recordStep is called synchronously and back-to-back — two tool calls with no
 * await between them is normal. Firing each appendFile off independently let
 * them finish out of order, so rows landed shuffled: step 2 before step 1, and
 * with them the observation that pairs with each action. Serialising through one
 * promise chain guarantees rows hit the file in the order they were recorded,
 * while recordStep still returns immediately — it only enqueues.
 */
let writeChain: Promise<void> = Promise.resolve();

/** Append a row in order. Never throws — losing a row must not disturb the assistant. */
function enqueueWrite(row: Row): void {
  if (!captureAllowed()) return;
  const epoch = deletionEpoch();
  writeChain = writeChain.then(async () => {
    try {
      if (epoch !== deletionEpoch() || !captureAllowed()) return;
      await ensure();
      await appendFile(dayFile(), JSON.stringify(row) + "\n", "utf8");
    } catch (err) {
      console.error("[learn] could not write trajectory:", (err as any)?.message ?? err);
    }
  });
}

/** Run arbitrary work on the same ordered chain, so it interleaves correctly with writes. */
function enqueue(work: () => Promise<void>): void {
  if (!captureAllowed()) return;
  const epoch = deletionEpoch();
  writeChain = writeChain.then(() => epoch === deletionEpoch() && captureAllowed() ? work() : undefined).catch((err) => {
    console.error("[learn] trajectory task failed:", (err as any)?.message ?? err);
  });
}

/** Wait for every queued write to reach disk. For tests and shutdown. */
export function flushTrajectory(): Promise<void> {
  return writeChain;
}

/**
 * Begin recording a user-initiated turn.
 *
 * Anything not inside a turn is deliberately dropped: a background rewind sweep
 * is not a demonstration, and at one capture every 30 seconds it would outnumber
 * the real examples many times over.
 */
export function startTurn(command: string, source: Source, model = ""): void {
  if (!opts.enabled || !captureAllowed()) return;
  const turn = activeTurn();
  // A new request means the old one did not finish. Calling it a success here
  // used to leak partial trajectories into the training set.
  if (turn && !turn.labelled) finishTurn("rejected", "superseded by a new command");
  turns.set(owner(), {
    id: id(),
    command: command.trim(),
    source,
    model,
    step: 0,
    observation: null,
    labelled: false,
    failed: false,
    truncated: false,
  });
}

/** True while a user turn is being recorded. */
export function recording(): boolean {
  return opts.enabled && captureAllowed() && activeTurn() !== null;
}

/**
 * Record one gated tool call. Called from the safety gate, which is the single
 * path to every handler — a brain cannot route around it, so it cannot forget.
 *
 * Returns immediately; the write and any image conversion happen in the
 * background. Nothing here may add latency to an action the user is watching.
 */
export function recordStep(input: {
  tool: string;
  args: Record<string, unknown>;
  tier: string;
  reason: string;
  allowed: boolean;
  resultText?: string;
  /** Raw base64 image the tool returned, if any. */
  image?: { data: string; mimeType: string } | null;
  /** False only when the tool handler threw. Denials use allowed: false. */
  succeeded?: boolean;
}): void {
  const turn = activeTurn();
  if (!opts.enabled || !captureAllowed() || !turn) return;

  // An undo is the user telling us the previous turn was wrong. Label it before
  // recording anything else, so the signal is not lost if this turn is short.
  if (UNDO_TOOLS.has(input.tool)) {
    labelPrevious("failure", `user called ${input.tool}`);
  }

  if (opts.maxStepsPerTurn > 0 && turn.step >= opts.maxStepsPerTurn) {
    turn.truncated = true;
    return;
  }
  if (input.succeeded === false) turn.failed = true;
  turn.step += 1;

  const row: StepRow = {
    type: "step",
    taskId: currentInvocation()?.taskId ?? currentAgentRunContext()?.taskId,
    actorId: currentInvocation()?.actorId ?? currentAgentRunContext()?.identity.id,
    callId: currentInvocation()?.callId,
    turn: turn.id,
    step: turn.step,
    at: Date.now(),
    source: turn.source,
    model: turn.model,
    command: turn.command,
    // The state BEFORE this action — including for a seeing tool, whose own
    // output only becomes context for whatever comes next.
    observation: turn.observation,
    tool: input.tool,
    args: redact(input.args, input.tool, turn.command),
    risk: { tier: input.tier, reason: input.reason },
    allowed: input.allowed,
    // Scrub the result too: a tool that read the screen may have returned a
    // visible password or key, and this row lives in the training set forever.
    result: scrubSecrets(input.resultText ?? "").slice(0, 2000),
  };

  enqueueWrite(row);

  // Now let this tool's output become the observation for the NEXT step.
  const kind = SEEING[input.tool];
  if (kind && input.allowed) {
    // Set the text observation SYNCHRONOUSLY. The previous version did this in a
    // background microtask, so an action recorded immediately after a look — no
    // await between them — read turn.observation before it was set and paired
    // with null. The screen text is already in hand here, so there is no reason
    // to defer it: the pairing that the whole dataset depends on is now
    // deterministic regardless of timing.
    const obs: Observation = { kind, at: Date.now() };
    // Scrub before storing: this observation is the screen the model saw, and a
    // visible credential on it must not be baked into the training data.
    if (input.resultText) obs.text = scrubSecrets(input.resultText).slice(0, 6000);
    turn.observation = obs;

    // Only the image is heavy (a sips subprocess). Convert it on the same
    // ordered chain, so the filename is attached before the next step's row is
    // serialised, without blocking the action the user is watching.
    const image = input.image;
    if (image && opts.captureScreens) {
      enqueue(async () => {
        const file = await saveScreen(image.data).catch(() => undefined);
        if (file) obs.image = file;
      });
    }
  }
}

/**
 * Store a screenshot small enough to keep thousands of.
 *
 * Full-resolution PNG runs about 1MB each, so ten thousand steps would be ten
 * gigabytes. Downscaling to 896px on the long edge as JPEG lands near 150KB and
 * is still above what the vision encoders actually consume.
 */
async function saveScreen(b64: string): Promise<string | undefined> {
  await ensure();
  const name = `${id()}.jpg`;
  const tmp = join(tmpdir(), `traj-${name}.png`);
  try {
    await writeFile(tmp, Buffer.from(b64, "base64"));
    await run("/usr/bin/sips", [
      "-Z", "896",
      "-s", "format", "jpeg",
      "-s", "formatOptions", "70",
      tmp,
      "--out", join(SCREENS, name),
    ]);
    return name;
  } catch {
    return undefined;
  } finally {
    unlink(tmp).catch(() => {});
  }
}

/**
 * Capture the live screen straight to a training-sized JPEG.
 *
 * Distinct from saveScreen, which reuses an image a tool already returned. This
 * grabs the framebuffer itself, for the common case where the model drove by
 * OCR or the accessibility tree and never asked for a screenshot — so there is
 * no image to reuse, yet a click still needs a picture to be a grounding
 * example. screencapture straight to a temp PNG, then one sips pass to 896px,
 * skips the full-resolution base64 round-trip the tool path pays.
 */
async function captureScreenFrame(): Promise<string | undefined> {
  await ensure();
  const name = `${id()}.jpg`;
  const tmp = join(tmpdir(), `traj-cap-${name}.png`);
  try {
    await run("/usr/sbin/screencapture", ["-x", "-t", "png", tmp], { timeout: 4000 });
    await run(
      "/usr/bin/sips",
      ["-Z", "896", "-s", "format", "jpeg", "-s", "formatOptions", "70", tmp, "--out", join(SCREENS, name)],
      { timeout: 4000 }
    );
    return name;
  } catch {
    return undefined;
  } finally {
    unlink(tmp).catch(() => {});
  }
}

/**
 * Actions that place the cursor somewhere specific. The screen at the instant
 * one of these fires, paired with where it landed, is the grounding signal a
 * vision model needs — "this is what a Send button looks like, click here".
 * Nothing else on the list; typing or waiting teaches nothing about pixels.
 */
const GROUNDING_TOOLS = new Set([
  "click",
  "drag",
  "move_mouse",
  "set_value",
  "click_ui_element",
  "click_text",
  "scroll",
]);

/**
 * How recent a pixel frame must be to stand in for this action's.
 *
 * Jarvis's own actions are model round-trips apart — seconds each — so a frame
 * this fresh is still the screen the model was looking at when it decided. It
 * does two jobs: reuse the image the screenshot tool just returned instead of
 * grabbing another, and skip a second capture inside a rare rapid burst.
 */
const FRESH_FRAME_MS = 1500;

/**
 * Grab the pre-action screen for a grounding tool, if one is due.
 *
 * Called by the gate BEFORE the handler runs, so the pixels are the ones the
 * click was aimed at, not the destination it navigated to — pairing an action
 * with the screen it produced would be unlearnable. Awaited, which adds one
 * capture (~300ms) before a click while collecting; that is the price of the
 * data, it only applies in learning mode, and it is best-effort so a slow or
 * failed capture never blocks the action itself.
 *
 * Enriches a recent OCR/accessibility observation with pixels rather than
 * discarding its text — the model saw both, so the example should carry both.
 */
export async function captureGroundingFrame(tool: string): Promise<void> {
  const turn = activeTurn();
  if (!opts.enabled || !captureAllowed() || !opts.captureScreens || !turn) return;
  if (!GROUNDING_TOOLS.has(tool)) return;

  const cur = turn.observation;
  // A fresh pixel frame already exists (the model just took a screenshot). Reuse it.
  if (cur?.image && Date.now() - cur.at < FRESH_FRAME_MS) return;

  const file = await captureScreenFrame().catch(() => undefined);
  if (!file || !turn) return;

  if (turn.observation && !turn.observation.image && Date.now() - turn.observation.at < FRESH_FRAME_MS) {
    // Keep the text the model just read; add the pixels it was reading it from.
    turn.observation.image = file;
  } else {
    turn.observation = { kind: "screenshot", image: file, at: Date.now() };
  }
}

/**
 * Strip anything that should not sit in a training file forever.
 *
 * Typed text is the risk: a turn that types a password or a card number would
 * otherwise preserve it in plain text on disk for the life of the dataset, and
 * a model trained on it can be made to repeat it.
 *
 * Content alone is not enough to spot a secret — "hunter2" is an ordinary word,
 * and no pattern will catch it. So the CONTEXT is used as well: if the user's
 * own command was about signing in, everything typed during that turn is
 * redacted regardless of how innocent it looks. This over-redacts, which is the
 * correct direction to be wrong in; a login demonstration is worth very little
 * as training data anyway, since Jarvis is forbidden from typing credentials.
 */
const SECRET_HINT = /pass(word|code)|secret|api[_-]?key|token|card number|cvv|ssn|otp|pin\b/i;
const AUTH_CONTEXT =
  /\b(log ?in|logged ?in|log me in|sign ?in|sign me in|password|passcode|credential|authenticat|2fa|one.?time code|card number|billing|checkout)\b/i;
/** Tools whose arguments are literally keystrokes. */
const TYPING_TOOLS = new Set(["type_text", "set_value"]);
const TYPED_FIELDS = new Set(["text", "value"]);

function redact(
  args: Record<string, unknown>,
  tool: string,
  command: string
): Record<string, unknown> {
  const authTurn = AUTH_CONTEXT.test(command);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === "string") {
      if (SECRET_HINT.test(k) || SECRET_HINT.test(v)) {
        out[k] = "[redacted]";
        continue;
      }
      if (authTurn && TYPING_TOOLS.has(tool) && TYPED_FIELDS.has(k)) {
        out[k] = "[redacted]";
        continue;
      }
      // Defence in depth: even a "safe" arg may contain a pasted API key or
      // card number — run it through the shared secret scrubber too.
      const scrubbed = scrubSecrets(v);
      out[k] = scrubbed.length > 2000 ? scrubbed.slice(0, 2000) + "…" : scrubbed;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** Record how a turn ended, then close it. */
export function finishTurn(outcome: Outcome, why = ""): void {
  const turn = activeTurn();
  if (!opts.enabled || !captureAllowed() || !turn || turn.labelled) return;
  // The model's normal turn-end event only means it stopped talking; it does
  // not erase a tool exception or an incomplete recording.
  if (outcome === "success" && turn.failed) {
    outcome = "failure";
    why = why ? `${why}; a tool handler failed` : "a tool handler failed";
  }
  if (outcome === "success" && turn.truncated) {
    outcome = "failure";
    why = why ? `${why}; recording hit maxStepsPerTurn` : "recording hit maxStepsPerTurn";
  }
  turn.labelled = true;
  // Only a turn that actually did something is worth a label; a turn where the
  // model just talked has no actions to learn from.
  if (turn.step > 0) {
    enqueueWrite({ type: "label", turn: turn.id, at: Date.now(), outcome, why });
  }
  previousTurns.set(currentAgentRunContext()?.identity.id ?? "main", turn);
  turns.delete(owner());
}

/** Relabel the turn before this one — for an undo that arrives late. */
export function labelPrevious(outcome: Outcome, why: string): void {
  if (!opts.enabled) return;
  const target = previousTurns.get(currentAgentRunContext()?.identity.id ?? "main") ?? activeTurn();
  if (!target || target.step === 0) return;
  enqueueWrite({ type: "label", turn: target.id, at: Date.now(), outcome, why });
}

// ---- reading the dataset back ---------------------------------------------

export interface DatasetStats {
  steps: number;
  turns: number;
  labelled: Record<Outcome, number>;
  bySource: Record<string, number>;
  withImages: number;
  rejected: number;
  days: number;
  dir: string;
}

/**
 * Summarise what has been collected.
 *
 * The number that matters is labelled successes by teacher source, since that is
 * what actually reaches a training run — total rows flatter the dataset.
 */
export async function datasetStats(): Promise<DatasetStats> {
  const empty: DatasetStats = {
    steps: 0,
    turns: 0,
    labelled: { success: 0, failure: 0, rejected: 0 },
    bySource: {},
    withImages: 0,
    rejected: 0,
    days: 0,
    dir: DIR,
  };
  if (!existsSync(DIR)) return empty;

  let files: string[] = [];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return empty;
  }
  empty.days = files.length;

  const turns = new Set<string>();
  // A later label supersedes an earlier one, so keep only the last per turn.
  const labels = new Map<string, Outcome>();

  for (const f of files) {
    let text = "";
    try {
      text = await readFile(join(DIR, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let row: Row;
      try {
        row = JSON.parse(t);
      } catch {
        continue;
      }
      if (row.type === "label") {
        labels.set(row.turn, row.outcome);
        continue;
      }
      empty.steps += 1;
      turns.add(row.turn);
      empty.bySource[row.source] = (empty.bySource[row.source] ?? 0) + 1;
      if (row.observation?.image) empty.withImages += 1;
      if (!row.allowed) empty.rejected += 1;
    }
  }

  empty.turns = turns.size;
  for (const outcome of labels.values()) empty.labelled[outcome] += 1;
  return empty;
}

/** Every row on disk, oldest first. */
export async function loadAll(): Promise<Row[]> {
  if (!existsSync(DIR)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const out: Row[] = [];
  for (const f of files) {
    let text = "";
    try {
      text = await readFile(join(DIR, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as Row);
      } catch {
        /* a torn final line is expected while the app is running */
      }
    }
  }
  return out;
}

export interface TrainingExample {
  /** Absolute path to the screenshot, or undefined for a text-only example. */
  image?: string;
  command: string;
  observation: string;
  /** The action the teacher took, as the model should emit it. */
  action: { tool: string; arguments: Record<string, unknown> };
  source: Source;
}

export interface ExportResult {
  examples: TrainingExample[];
  kept: number;
  dropped: { unlabelled: number; failed: number; student: number; refused: number };
}

/**
 * Turn the log into examples fit to train on.
 *
 * The filtering is the whole value of this function, and every rule removes a
 * specific way the resulting model would be made worse:
 *
 *   - student rows, because training a model on its own output compounds its
 *     mistakes until it collapses
 *   - unlabelled and failed turns, because a demonstration is only a
 *     demonstration if it worked
 *   - refused actions, because the user said no — they belong in a preference
 *     set as negatives, never in the imitation set as targets
 */
export function buildTrainingSet(rows: Row[]): ExportResult {
  const outcome = new Map<string, Outcome>();
  for (const r of rows) if (r.type === "label") outcome.set(r.turn, r.outcome);

  const res: ExportResult = {
    examples: [],
    kept: 0,
    dropped: { unlabelled: 0, failed: 0, student: 0, refused: 0 },
  };

  for (const r of rows) {
    if (r.type !== "step") continue;

    if (r.source === "deepakllm") {
      res.dropped.student += 1;
      continue;
    }
    // Checked before the turn's outcome so a refusal is reported as one. A
    // refused action usually sits in a turn labelled "rejected", and counting it
    // as a generic failure hid how often the user was actually saying no.
    if (!r.allowed) {
      res.dropped.refused += 1;
      continue;
    }
    const label = outcome.get(r.turn);
    if (!label) {
      res.dropped.unlabelled += 1;
      continue;
    }
    if (label !== "success") {
      res.dropped.failed += 1;
      continue;
    }

    res.examples.push({
      image: r.observation?.image ? join(SCREENS, r.observation.image) : undefined,
      command: r.command,
      observation: r.observation?.text ?? "",
      action: { tool: r.tool, arguments: r.args },
      source: r.source,
    });
    res.kept += 1;
  }
  return res;
}

/**
 * Render an example as a chat turn, the shape VLM fine-tuners expect.
 * Kept separate from the filtering so the target format can change without
 * touching the rules about what is safe to train on.
 */
export function toChatFormat(ex: TrainingExample): unknown {
  const content: unknown[] = [];
  if (ex.image) content.push({ type: "image", image: ex.image });
  content.push({
    type: "text",
    text: `Task: ${ex.command}\n\nScreen:\n${ex.observation || "(no text observation)"}\n\nRespond with the single next tool call as JSON.`,
  });
  return {
    messages: [
      {
        role: "system",
        content:
          "You are DeepakLLM, controlling a macOS desktop. Given the task and what is on screen, emit exactly one tool call as JSON.",
      },
      { role: "user", content },
      { role: "assistant", content: JSON.stringify(ex.action) },
    ],
  };
}

/** One-line summary, for the console and for "how much have you learned?". */
export function describeStats(s: DatasetStats): string {
  if (!s.steps) return `No trajectories recorded yet. They will appear in ${s.dir}.`;
  const sources = Object.entries(s.bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    `${s.steps} steps across ${s.turns} turns over ${s.days} day(s).`,
    `Labelled: ${s.labelled.success} success, ${s.labelled.failure} failure, ${s.labelled.rejected} rejected.`,
    `Sources: ${sources}.`,
    `${s.withImages} steps carry a screenshot; ${s.rejected} refused actions kept as negatives.`,
    `Stored in ${s.dir}.`,
  ].join(" ");
}

export const trajectoryDir = DIR;
