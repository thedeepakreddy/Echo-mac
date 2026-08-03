import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Learn a task by watching it done once, then repeat it.
 *
 * Steps are stored by MEANING, never by coordinate: "clicked the button labelled
 * Export", not "clicked 840,312". That single decision is what lets a recorded
 * workflow survive the app moving its own buttons — the replayer re-finds each
 * control through the accessibility tree, and falls back to on-screen text.
 *
 * The generaliser looks across repetitions for the values that changed and turns
 * them into parameters, so one demonstration becomes "now do it for the other
 * forty".
 */
export type Step =
  | { kind: "click"; target: string; role?: string }
  | { kind: "type"; text: string }
  | { kind: "keys"; modifiers: string[]; key: string }
  | { kind: "open"; app: string }
  | { kind: "wait"; seconds: number };

export interface Workflow {
  name: string;
  createdAt: number;
  steps: Step[];
  /** Placeholders discovered by generalisation, e.g. ["filename"]. */
  parameters: string[];
  /** How often it has been replayed, and how often that worked. */
  runs: number;
  repairs: number;
}

const DIR = join(homedir(), ".jarvis", "workflows");
const file = (name: string) => join(DIR, `${slug(name)}.json`);

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workflow";
}

function ensure() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

// ---- recording ------------------------------------------------------------

let recording: { name: string; steps: Step[] } | null = null;

export function startRecording(name: string) {
  recording = { name, steps: [] };
}

export function isRecording(): boolean {
  return recording !== null;
}

/** Called by the tool layer each time an action is performed while recording. */
export function noteStep(step: Step) {
  if (!recording) return;
  // Collapse consecutive typing into one step — replaying keystroke-by-keystroke
  // is slower and more fragile than typing the finished string.
  const last = recording.steps[recording.steps.length - 1];
  if (step.kind === "type" && last?.kind === "type") {
    last.text += step.text;
    return;
  }
  recording.steps.push(step);
}

export function cancelRecording() {
  recording = null;
}

export function finishRecording(): Workflow | null {
  if (!recording || !recording.steps.length) {
    recording = null;
    return null;
  }
  ensure();
  const wf: Workflow = {
    name: recording.name,
    createdAt: Date.now(),
    steps: recording.steps,
    parameters: [],
    runs: 0,
    repairs: 0,
  };
  recording = null;
  writeFileSync(file(wf.name), JSON.stringify(wf, null, 2));
  return wf;
}

// ---- storage --------------------------------------------------------------

export function load(name: string): Workflow | null {
  const p = file(name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function save(wf: Workflow) {
  ensure();
  writeFileSync(file(wf.name), JSON.stringify(wf, null, 2));
}

export function list(): string[] {
  ensure();
  try {
    // Lazily required so this module stays usable in plain Node tests.
    const { readdirSync } = require("node:fs");
    return readdirSync(DIR)
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

// ---- generalisation -------------------------------------------------------

/**
 * Turn the values that differ between two runs of the same task into
 * parameters. Given "open report-jan.pdf" and "open report-feb.pdf", the
 * filename becomes a slot rather than a constant.
 */
export function generalise(a: Workflow, b: Workflow): Workflow {
  if (a.steps.length !== b.steps.length) return a;
  const steps: Step[] = [];
  const params: string[] = [];

  a.steps.forEach((sa, i) => {
    const sb = b.steps[i];
    if (sa.kind !== sb.kind) {
      steps.push(sa);
      return;
    }
    if (sa.kind === "type" && sb.kind === "type" && sa.text !== sb.text) {
      const name = `value${params.length + 1}`;
      params.push(name);
      steps.push({ kind: "type", text: `{${name}}` });
      return;
    }
    if (sa.kind === "click" && sb.kind === "click" && sa.target !== sb.target) {
      const name = `target${params.length + 1}`;
      params.push(name);
      steps.push({ kind: "click", target: `{${name}}`, role: sa.role });
      return;
    }
    steps.push(sa);
  });

  return { ...a, steps, parameters: params };
}

/** Fill placeholders before replay. */
export function bind(steps: Step[], values: Record<string, string>): Step[] {
  const sub = (s: string) => s.replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m);
  return steps.map((s) => {
    if (s.kind === "type") return { ...s, text: sub(s.text) };
    if (s.kind === "click") return { ...s, target: sub(s.target) };
    return s;
  });
}

export function describe(wf: Workflow): string {
  const lines = wf.steps.map((s, i) => {
    switch (s.kind) {
      case "click": return `${i + 1}. click "${s.target}"`;
      case "type": return `${i + 1}. type "${s.text.slice(0, 40)}"`;
      case "keys": return `${i + 1}. press ${[...s.modifiers, s.key].join("+")}`;
      case "open": return `${i + 1}. open ${s.app}`;
      case "wait": return `${i + 1}. wait ${s.seconds}s`;
    }
  });
  const params = wf.parameters.length ? `\nParameters: ${wf.parameters.join(", ")}` : "";
  const health = wf.runs ? `\nRun ${wf.runs} time(s), self-repaired ${wf.repairs}.` : "";
  return `"${wf.name}" — ${wf.steps.length} steps:\n${lines.join("\n")}${params}${health}`;
}
