import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../tools/shell.js";

/**
 * Try several approaches at once and keep the one that works.
 *
 * Fixing something usually means guess, run, fail, guess again — paying the
 * cost serially. Here each candidate gets its own git worktree, so the attempts
 * cannot see or corrupt each other or your working copy, and they run
 * concurrently. Only the winning diff comes back.
 *
 * Isolation is the whole point: without it this would be several agents editing
 * the same files at once, which is worse than doing nothing.
 */

export interface Attempt {
  name: string;
  /** Shell command that makes the change. */
  apply: string;
}

export interface AttemptResult {
  name: string;
  ok: boolean;
  durationMs: number;
  output: string;
  /** Diff produced in the isolated copy, if it passed. */
  diff?: string;
}

export interface RaceReport {
  winner: AttemptResult | null;
  all: AttemptResult[];
  summary: string;
}

async function isGitRepo(dir: string): Promise<boolean> {
  const r = await run("/usr/bin/git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && /true/.test(r.stdout);
}

/**
 * Run each attempt in its own worktree, then the verify command.
 * The first that passes verification wins; the rest are discarded.
 */
export async function race(
  repo: string,
  attempts: Attempt[],
  verify: string,
  timeoutMs = 180_000
): Promise<RaceReport> {
  if (!(await isGitRepo(repo))) {
    return {
      winner: null,
      all: [],
      summary: `${repo} is not a git repository, so I cannot isolate the attempts safely.`,
    };
  }

  const base = mkdtempSync(join(tmpdir(), "jarvis-race-"));
  const worktrees: string[] = [];

  const runOne = async (a: Attempt): Promise<AttemptResult> => {
    const started = Date.now();
    const dir = join(base, a.name.replace(/[^a-z0-9]+/gi, "-"));
    // A detached worktree keeps the user's checkout and branch untouched.
    const add = await run("/usr/bin/git", ["-C", repo, "worktree", "add", "--detach", dir], 60_000);
    if (add.code !== 0) {
      return { name: a.name, ok: false, durationMs: Date.now() - started, output: `worktree failed: ${add.stderr.slice(0, 200)}` };
    }
    worktrees.push(dir);

    const applied = await run("/bin/sh", ["-c", `cd ${JSON.stringify(dir)} && ${a.apply}`], timeoutMs);
    if (applied.code !== 0) {
      return { name: a.name, ok: false, durationMs: Date.now() - started, output: `change failed: ${(applied.stderr || applied.stdout).slice(0, 300)}` };
    }

    const checked = await run("/bin/sh", ["-c", `cd ${JSON.stringify(dir)} && ${verify}`], timeoutMs);
    const diff = await run("/usr/bin/git", ["-C", dir, "diff"], 30_000);

    return {
      name: a.name,
      ok: checked.code === 0,
      durationMs: Date.now() - started,
      output: (checked.stdout || checked.stderr).slice(-400),
      diff: checked.code === 0 ? diff.stdout : undefined,
    };
  };

  let results: AttemptResult[] = [];
  try {
    results = await Promise.all(attempts.map(runOne));
  } finally {
    // Always clean up, even if an attempt threw — stale worktrees accumulate
    // and later confuse git in the user's real repository.
    for (const dir of worktrees) {
      await run("/usr/bin/git", ["-C", repo, "worktree", "remove", "--force", dir], 30_000).catch(() => {});
    }
    if (existsSync(base)) rmSync(base, { recursive: true, force: true });
  }

  const winner = results.find((r) => r.ok) ?? null;
  const summary = winner
    ? `"${winner.name}" passed in ${(winner.durationMs / 1000).toFixed(1)}s. ${results.length - 1} other attempt(s) failed and were discarded.`
    : `None of the ${results.length} attempts passed. ${results.map((r) => `${r.name}: ${r.output.slice(0, 60)}`).join(" | ")}`;

  return { winner, all: results, summary };
}
