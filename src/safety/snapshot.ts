import { mkdir, copyFile, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { run } from "../tools/shell.js";
import type { Snapshot } from "./risk.js";

const ROOT = join(homedir(), ".jarvis", "snapshots");

export interface SnapshotRecord {
  id: string;
  at: string;
  kind: "file" | "git";
  target: string;
  /** Copy of the original file, or the git object id holding the old state. */
  restoreFrom: string;
  /** What the snapshot was taken before, for reading back to the user. */
  action: string;
}

const indexPath = () => join(ROOT, "index.jsonl");

/**
 * Capture enough state to undo an action.
 *
 * Files are copied verbatim. For shell commands we lean on git — `stash create`
 * builds a commit object holding the current working tree WITHOUT touching the
 * tree itself, so taking the snapshot can't disturb the command about to run.
 * A command in a non-git directory returns null: worth being explicit that we
 * cannot undo it rather than implying we can.
 */
export async function capture(snap: Snapshot, action: string): Promise<SnapshotRecord | null> {
  await mkdir(ROOT, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  let record: SnapshotRecord | null = null;

  if (snap.kind === "file") {
    // Nothing to restore if the file doesn't exist yet — creating it is undone
    // by deleting it, which we record as an empty restoreFrom.
    const dir = join(ROOT, id);
    await mkdir(dir, { recursive: true });
    const copy = join(dir, basename(snap.target));
    if (existsSync(snap.target)) {
      await copyFile(snap.target, copy);
      record = { id, at: new Date().toISOString(), kind: "file", target: snap.target, restoreFrom: copy, action };
    } else {
      record = { id, at: new Date().toISOString(), kind: "file", target: snap.target, restoreFrom: "", action };
    }
  }

  if (snap.kind === "git") {
    const isRepo = await run("/usr/bin/git", ["-C", snap.target, "rev-parse", "--is-inside-work-tree"]);
    if (isRepo.code !== 0 || !/true/.test(isRepo.stdout)) return null;

    const stash = await run("/usr/bin/git", ["-C", snap.target, "stash", "create"]);
    const head = await run("/usr/bin/git", ["-C", snap.target, "rev-parse", "HEAD"]);
    const objectId = stash.stdout.trim() || head.stdout.trim();
    if (!objectId) return null;

    record = { id, at: new Date().toISOString(), kind: "git", target: snap.target, restoreFrom: objectId, action };
  }

  if (record) await writeFile(indexPath(), JSON.stringify(record) + "\n", { flag: "a" });
  return record;
}

export async function list(limit = 10): Promise<SnapshotRecord[]> {
  if (!existsSync(indexPath())) return [];
  const lines = (await readFile(indexPath(), "utf8")).trim().split("\n").filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l) as SnapshotRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is SnapshotRecord => r !== null)
    .reverse();
}

/** Restore a snapshot. Returns a sentence describing what happened, for speech. */
export async function restore(id?: string): Promise<string> {
  const all = await list(50);
  const rec = id ? all.find((r) => r.id === id) : all[0];
  if (!rec) return "I don't have a snapshot to restore.";

  if (rec.kind === "file") {
    if (!rec.restoreFrom) {
      return `The file ${basename(rec.target)} didn't exist before that change — delete it yourself if you want it gone.`;
    }
    await copyFile(rec.restoreFrom, rec.target);
    return `Restored ${basename(rec.target)} to how it was before I ${rec.action}.`;
  }

  // git: check the recorded tree back out over the working directory.
  const res = await run("/usr/bin/git", ["-C", rec.target, "checkout", rec.restoreFrom, "--", "."]);
  if (res.code !== 0) {
    return `I couldn't restore that automatically. The snapshot is git object ${rec.restoreFrom.slice(0, 8)} in ${rec.target}.`;
  }
  return `Rolled the working tree back to before I ${rec.action}.`;
}

/** Human-readable list for "what can you undo?" */
export async function describeRecent(limit = 5): Promise<string> {
  const recs = await list(limit);
  if (!recs.length) return "I haven't taken any snapshots yet.";
  return recs
    .map((r, i) => `${i + 1}. ${r.action} (${new Date(r.at).toLocaleTimeString()})`)
    .join("; ");
}
