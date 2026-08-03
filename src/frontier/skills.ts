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
  name: string;
  description: string;
  steps: SkillStep[];
  createdAt: number;
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
      name,
      description: typeof raw.description === "string" ? raw.description : "",
      steps,
      createdAt: Date.now(),
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
    return Array.isArray(arr) ? arr.filter((s) => s?.name && Array.isArray(s.steps)) : [];
  } catch {
    return [];
  }
}

/** Save a skill, replacing any existing one with the same name. */
export function saveSkill(skill: Skill, base?: string): void {
  const path = skillsFile(base);
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const all = loadSkills(base).filter((s) => s.name.toLowerCase() !== skill.name.toLowerCase());
  all.push(skill);
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
