/**
 * Skills — the safe replacement for self-writing code.
 *
 *   npm run skillstest
 *
 * The safety property under test: a skill can ONLY reference tools that already
 * exist. Anything else is rejected, so a skill can never be a backdoor to new
 * capability.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSkill, screenPlan, saveSkill, loadSkills, getSkill, deleteSkill, describeSkills,
  type Skill,
} from "./frontier/skills.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const roots: string[] = [];
const newRoot = () => { const r = mkdtempSync(join(tmpdir(), "jarvis-skills-")); roots.push(r); return r; };
const KNOWN = new Set(["screenshot", "open_app", "read_screen_text", "type_text", "run_terminal_command"]);

console.log("\nSkills\n");

console.log("  a skill can only use tools that already exist");
{
  const bad = validateSkill({ name: "sneaky", steps: [{ tool: "delete_everything" }] }, KNOWN);
  ok(!bad.ok, "a step naming a non-existent tool is rejected");
  if (!bad.ok) ok(/not a real tool/.test(bad.errors.join(" ")), "with a clear reason");

  const good = validateSkill(
    { name: "morning setup", description: "open things", steps: [{ tool: "open_app", args: { name: "Mail" } }, { tool: "screenshot" }] },
    KNOWN
  );
  ok(good.ok, "a skill of real tools is accepted");
  if (good.ok) ok(good.skill.steps.length === 2, "with its steps preserved");
}

console.log("  bad input is refused");
{
  ok(!validateSkill({ name: "", steps: [{ tool: "screenshot" }] }, KNOWN).ok, "no name -> rejected");
  ok(!validateSkill({ name: "x", steps: [{ tool: "screenshot" }] }, KNOWN).ok, "one-char name -> rejected");
  ok(!validateSkill({ name: "ok name", steps: [] }, KNOWN).ok, "no steps -> rejected");
  ok(!validateSkill({ name: "ok", steps: [{ notatool: 1 } as any] }, KNOWN).ok, "step with no tool -> rejected");
  const evil = validateSkill({ name: "bad;rm", steps: [{ tool: "screenshot" }] }, KNOWN);
  ok(!evil.ok, "a name with odd characters is rejected");
}

console.log("  a risky step makes the skill confirm, not auto-run");
{
  const skill: Skill = {
    name: "cleanup", description: "", createdAt: 0,
    steps: [{ tool: "screenshot" }, { tool: "run_terminal_command", args: { command: "rm -rf ~/tmp" } }],
  };
  const tierOf = (tool: string) => (tool === "run_terminal_command" ? "high" : "low");
  const screen = screenPlan(skill, tierOf);
  ok(!screen.autoRunnable, "a skill containing a high-risk step is not auto-runnable");
  ok(screen.highSteps.includes(2), "and it points at the risky step (2)");

  const safe: Skill = { name: "look", description: "", createdAt: 0, steps: [{ tool: "screenshot" }, { tool: "read_screen_text" }] };
  ok(screenPlan(safe, () => "low").autoRunnable, "an all-safe skill is auto-runnable");
}

console.log("  saving, loading, replacing, deleting");
{
  const root = newRoot();
  const mk = (name: string): Skill => ({ name, description: "d", createdAt: Date.now(), steps: [{ tool: "screenshot" }] });
  saveSkill(mk("alpha"), root);
  saveSkill(mk("beta"), root);
  ok(loadSkills(root).length === 2, "two skills saved");
  ok(getSkill("ALPHA", root)?.name === "alpha", "lookup is case-insensitive");

  saveSkill({ ...mk("alpha"), description: "updated" }, root);
  ok(loadSkills(root).length === 2, "re-saving a name replaces, not duplicates");
  ok(getSkill("alpha", root)?.description === "updated", "with the new content");

  ok(deleteSkill("beta", root) === true, "delete reports success");
  ok(loadSkills(root).length === 1 && !getSkill("beta", root), "and it's gone");
  ok(deleteSkill("nope", root) === false, "deleting an unknown skill reports failure");
}
{
  ok(loadSkills(newRoot()).length === 0, "a fresh machine has no skills, no throw");
  ok(/haven't taught/.test(describeSkills([])), "and describes that plainly");
}

for (const r of roots) rmSync(r, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} skill checks passed\n`);
process.exit(fail ? 1 : 0);
