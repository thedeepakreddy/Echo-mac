import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Skills: named recipes Echo can teach itself, safely.
 *
 * The old "meta-agent" wrote fresh TypeScript, compiled it, and hot-loaded it
 * into the running process. That is unsafe (arbitrary code execution) and does
 * not even work in a signed, packaged app (no compiler, read-only bundle). This
 * replaces it with something that gives the same "Echo can gain new abilities"
 * feeling without any of that danger:
 *
 *   A skill is a NAMED SEQUENCE OF TOOLS ECHO ALREADY HAS.
 *
 * That one rule is the whole safety model. A skill cannot do anything Echo
 * could not already do — it can only compose existing tools, each of which
 * still passes through the risk gate when it runs. Creating a skill is data,
 * not code: it is a small JSON file, portable and inert until run.
 */

export interface SkillStep {
  tool: string;
  args?: Record<string, unknown>;
}

export interface Skill {
  /**
   * Stable identity for this workflow, independent of its display name.
   *
   * Procedural memory tracks a skill across renames and edits, and a deletion
   * has to be able to reach every record derived from it. A name cannot do
   * either: renaming "deploy" to "ship it" would silently orphan its history,
   * and two people's "deploy" are not the same procedure. Older files have no
   * ID, so readers derive one from the name rather than rewriting the file.
   */
  procedureId: string;
  /** Bumped whenever the steps change, so a verified run is tied to what ran. */
  version: number;
  name: string;
  description: string;
  steps: SkillStep[];
  createdAt: number;
  updatedAt?: number;
  /** Whether the user taught this directly, or Echo proposed it from a run. */
  taughtByUser?: boolean;
}

/** Fold a name into the ID shape used for legacy rows and for new skills alike. */
export function procedureIdFor(name: string): string {
  return (name ?? "").trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "skill";
}

/** Fill in identity/version for a skill loaded from an older file, without rewriting it. */
function withIdentity(raw: any): Skill {
  return {
    ...raw,
    procedureId: typeof raw.procedureId === "string" && raw.procedureId ? raw.procedureId : procedureIdFor(raw.name),
    version: Number.isInteger(raw.version) && raw.version > 0 ? raw.version : 1,
  };
}

/**
 * Validate a proposed skill against the tools that actually exist.
 *
 * The critical check is that every step names a REAL registered tool. A step
 * referencing something that does not exist is rejected — that is what stops a
 * skill from being a backdoor to invent new capability. Everything a skill can
 * do, Echo could already do a step at a time.
 */
export function validateSkill(
  raw: { name?: unknown; description?: unknown; steps?: unknown },
  knownTools: Set<string>
): { ok: true; skill: Skill } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) errors.push("a skill needs a name");
  else if (!/^[a-z0-9][a-z0-9 _-]{1,39}$/i.test(name)) {
    errors.push("the name must be 2-40 characters: letters, numbers, spaces, _ or -");
  }

  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!rawSteps.length) errors.push("a skill needs at least one step");

  const steps: SkillStep[] = [];
  rawSteps.forEach((s: any, i: number) => {
    if (!s || typeof s.tool !== "string") {
      errors.push(`step ${i + 1}: each step needs a "tool"`);
      return;
    }
    if (!knownTools.has(s.tool)) {
      errors.push(`step ${i + 1}: "${s.tool}" is not a real tool — a skill can only use tools Echo already has`);
      return;
    }
    steps.push({ tool: s.tool, args: s.args && typeof s.args === "object" ? s.args : {} });
  });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    skill: {
      procedureId: procedureIdFor(name),
      version: 1,
      name,
      description: typeof raw.description === "string" ? raw.description : "",
      steps,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      taughtByUser: true,
    },
  };
}

/**
 * Decide whether a skill is safe to run unattended.
 *
 * A skill runs its steps automatically, which must never quietly do something
 * irreversible. So any step the risk classifier rates HIGH makes the skill
 * "needs confirmation" — the caller stops and asks before those steps, exactly
 * as a person driving the tools one by one would be asked.
 */
export function screenPlan(
  skill: Skill,
  tierOf: (tool: string, args: Record<string, unknown>) => string
): { autoRunnable: boolean; highSteps: number[] } {
  const highSteps: number[] = [];
  skill.steps.forEach((s, i) => {
    if (tierOf(s.tool, s.args ?? {}) === "high") highSteps.push(i + 1);
  });
  return { autoRunnable: highSteps.length === 0, highSteps };
}

// ---- storage --------------------------------------------------------------

function skillsFile(base?: string): string {
  return join(base ?? join(homedir(), ".jarvis"), "skills", "skills.json");
}

export function loadSkills(base?: string): Skill[] {
  const path = skillsFile(base);
  if (!existsSync(path)) return [];
  try {
    const arr = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(arr) ? arr.filter((s) => s?.name && Array.isArray(s.steps)).map(withIdentity) : [];
  } catch {
    return [];
  }
}

/**
 * Save a skill, replacing any existing one with the same name.
 *
 * Replacing keeps the previous row's identity and creation date and bumps the
 * version when the steps actually changed. Procedural memory scores a workflow
 * on verified runs of a *specific* version; letting an edit inherit the old
 * version's record would credit new steps with an old workflow's successes.
 */
export function saveSkill(skill: Skill, base?: string): void {
  const path = skillsFile(base);
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = loadSkills(base);
  const prior = existing.find((s) => s.name.toLowerCase() === skill.name.toLowerCase());
  const changed = !prior || JSON.stringify(prior.steps) !== JSON.stringify(skill.steps);
  const row: Skill = {
    ...skill,
    procedureId: prior?.procedureId ?? skill.procedureId ?? procedureIdFor(skill.name),
    version: prior ? prior.version + (changed ? 1 : 0) : skill.version || 1,
    createdAt: prior?.createdAt ?? skill.createdAt,
    updatedAt: Date.now(),
  };
  const all = existing.filter((s) => s.name.toLowerCase() !== skill.name.toLowerCase());
  all.push(row);
  writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function getSkill(name: string, base?: string): Skill | undefined {
  const want = (name ?? "").trim().toLowerCase();
  return loadSkills(base).find((s) => s.name.toLowerCase() === want);
}

export function deleteSkill(name: string, base?: string): boolean {
  const before = loadSkills(base);
  const after = before.filter((s) => s.name.toLowerCase() !== (name ?? "").trim().toLowerCase());
  if (after.length === before.length) return false;
  writeFileSync(skillsFile(base), JSON.stringify(after, null, 2), { mode: 0o600 });
  return true;
}

export function describeSkills(skills: Skill[]): string {
  if (!skills.length) return "You haven't taught me any skills yet. Ask me to 'create a skill' that chains tools I already have.";
  return skills
    .map((s) => `• ${s.name}${s.description ? ` — ${s.description}` : ""} (${s.steps.length} step${s.steps.length === 1 ? "" : "s"})`)
    .join("\n");
}
