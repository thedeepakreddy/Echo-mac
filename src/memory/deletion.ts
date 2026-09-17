import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { memoryService } from "./service.js";
import type { MemoryScope } from "./types.js";
import { taskCoordinator } from "./task-state.js";
import { atomicWrite, dataRoot, memoryRoot } from "./paths.js";
import { invalidateCaptures } from "./capture-policy.js";
import { getAppPath } from "../utils/appPath.js";

export interface ForgetRequest { ids?: string[]; query?: string; scope?: MemoryScope; taskId?: string; appRoot?: string }
export interface DeletionReceipt {
  id: string; count: number; deletedIds: string[]; stores: Record<string, number>;
  failures: string[]; limitations: string[]; completedAt: string;
}

/** Delete only owned captures/derivatives. Never follow a sourcePath to an original document. */
export function forgetEverywhere(request: ForgetRequest): DeletionReceipt {
  invalidateCaptures();
  const removed = memoryService.forget(request);
  const receipt: DeletionReceipt = {
    id: randomUUID(), count: removed.count, deletedIds: removed.deletedIds,
    stores: {}, failures: [], limitations: [], completedAt: new Date().toISOString(),
  };
  const objects = removed.deletedObjects;
  const ids = new Set(removed.deletedIds);
  const taskIds = new Set<string>(request.taskId ? [request.taskId] : []);
  const text = new Set(objects.map((o) => o.summary).filter((s) => s.length >= 12));
  for (const object of objects) {
    for (const ref of object.source.evidenceRefs) {
      const anchor = ref.lastIndexOf("#");
      if (anchor >= 0) ids.add(ref.slice(anchor + 1));
    }
  }
  const match = (value: unknown): boolean => {
    if (typeof value === "string") return ids.has(value) || taskIds.has(value) || [...text].some((s) => value.includes(s));
    if (Array.isArray(value)) return value.some(match);
    return Boolean(value && typeof value === "object" && Object.values(value).some(match));
  };
  const note = (file: string, count = 1) => { receipt.stores[file] = (receipt.stores[file] ?? 0) + count; };
  const safeRemove = (file: string) => {
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return;
    rmSync(file, { recursive: true, force: true }); note(file);
  };
  const roots = [...new Set([dataRoot(), resolve(request.appRoot ?? getAppPath())])];
  // This can remove rollback evidence, but never the user-owned original file.
  const attached = (row: any, root: string) => {
    if (row.shot) safeRemove(join(root, "scans", "shots", basename(String(row.shot))));
    if (row.image?.path && String(row.image.path).startsWith(join(root, "trajectories", "screens") + "/")) safeRemove(row.image.path);
    if (row.undo?.backup && String(row.undo.backup).startsWith(join(root, "journal", "files") + "/")) {
      safeRemove(row.undo.backup);
      receipt.limitations.push("Affected undo backups were removed; those actions can no longer be rolled back from Echo's journal.");
    }
  };
  const filterJsonl = (file: string, root: string) => {
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return;
    const kept: string[] = []; let count = 0;
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line); // corrupt data stays untouched and is reported
      if (match(row)) { attached(row, root); count++; } else kept.push(line);
    }
    if (count) { atomicWrite(file, kept.join("\n") + (kept.length ? "\n" : "")); note(file, count); }
  };
  const visitFiles = (dir: string, apply: (file: string) => void) => {
    if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) visitFiles(p, apply); else if (entry.isFile()) apply(p);
    }
  };
  const attempt = (file: string, action: () => void) => {
    try { action(); } catch { receipt.failures.push(file); }
  };
  for (const taskId of taskIds) attempt(`task:${taskId}`, () => taskCoordinator.forget(taskId));
  taskCoordinator.invalidateMemories(removed.deletedIds);
  if (objects.length || taskIds.size) for (const root of roots) {
    for (const rel of ["memory/memories.jsonl", "episodic/episodes.jsonl", "episodic/facts.jsonl", "episodic/access.jsonl", "scans/scans.jsonl", "journal/actions.jsonl"])
      attempt(join(root, rel), () => filterJsonl(join(root, rel), root));
    for (const dir of ["rewind", "trajectories"])
      attempt(join(root, dir), () => visitFiles(join(root, dir), (p) => { if (p.endsWith(".jsonl")) filterJsonl(p, root); }));
    const embeddings = join(root, "long_term_memory.json");
    attempt(embeddings, () => {
      if (!existsSync(embeddings)) return;
      const db = JSON.parse(readFileSync(embeddings, "utf8"));
      const entries = Array.isArray(db) ? db : db.entries;
      if (!Array.isArray(entries)) throw new Error("invalid embedding file");
      const kept = entries.filter((row) => !match(row));
      if (kept.length !== entries.length) {
        atomicWrite(embeddings, JSON.stringify(Array.isArray(db) ? kept : { ...db, entries: kept }));
        note(embeddings, entries.length - kept.length);
      }
    });
    for (const rel of ["skills/skills.json", "reflex/cache.json", "prefetch.json"]) attempt(join(root, rel), () => {
      const p = join(root, rel); if (!existsSync(p)) return;
      const value = JSON.parse(readFileSync(p, "utf8"));
      if (!match(value)) return;
      const clean = (v: any): any => {
        if (Array.isArray(v)) return v.filter((r) => !match(r));
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !match(k)).map(([k, x]) => [k, typeof x === "object" ? clean(x) : match(x) ? null : x]));
        return v;
      };
      atomicWrite(p, JSON.stringify(clean(value))); note(p);
    });
    attempt(join(root, "workflows"), () => visitFiles(join(root, "workflows"), (p) => {
      if (p.endsWith(".json") && match(JSON.parse(readFileSync(p, "utf8")))) safeRemove(p);
    }));
    // A replay's content-addressed blobs cannot be rewritten without invalidating
    // every reference/hash. Remove the affected owned recording as one unit.
    attempt(join(root, "runs"), () => {
      const dir = join(root, "runs"); if (!existsSync(dir)) return;
      for (const run of readdirSync(dir, { withFileTypes: true })) {
        if (!run.isDirectory() || run.isSymbolicLink()) continue;
        const p = join(dir, run.name); let hit = false;
        visitFiles(p, (file) => {
          if (hit || !/\.(json|jsonl)$/.test(file)) return;
          const raw = readFileSync(file, "utf8");
          if (file.endsWith(".jsonl")) hit = raw.split("\n").filter(Boolean).some((line) => match(JSON.parse(line)));
          else hit = match(JSON.parse(raw));
        });
        if (hit && run.name !== "voice") safeRemove(p);
        else if (run.name === "voice") visitFiles(p, (file) => { if (file.endsWith(".jsonl")) filterJsonl(file, root); });
      }
    });
    // Remove matched chunks and their aligned vectors together. This deletes an
    // index entry only; the original document is never followed/deleted.
    attempt(join(root, "diskindex"), () => {
      const dir = join(root, "diskindex"), chunks = join(dir, "chunks.jsonl"), vectors = join(dir, "vectors.bin");
      if (!existsSync(chunks)) return;
      const rows = readFileSync(chunks, "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s));
      const kept = rows.map((row, i) => ({ row, i })).filter(({ row }) => !match(row));
      if (kept.length === rows.length) return;
      // Invalidate the whole disposable index rather than risk a mismatched
      // vector/chunk generation or an automatic resurrection from files.json.
      for (const name of [chunks, vectors, join(dir, "files.json")]) safeRemove(name);
      note(chunks, rows.length - kept.length);
      receipt.limitations.push("The affected document search index was invalidated. Original documents were preserved; explicitly indexing them again can reintroduce their contents.");
    });
  }
  if (taskIds.size) receipt.limitations.push("Legacy captures without task/source identifiers cannot always be attributed to a task. Matching linked and exact-content copies were removed.");
  receipt.limitations.push("External exports, model weights and operating-system backups are outside local deletion. Original user documents and deliverables were preserved.");
  receipt.limitations = [...new Set(receipt.limitations)];
  // Receipt deliberately contains no deleted text or query.
  atomicWrite(join(memoryRoot(), "deletion-receipts", `${receipt.id}.json`), JSON.stringify(receipt, null, 2));
  memoryService.reload();
  return receipt;
}

/** Idempotent retention applies only to records created after activation. */
export function enforceRetention(options: { enabled: boolean; activatedAt: string; episodeDays: number; now?: number }): number {
  if (!options.enabled) return 0;
  const now = options.now ?? Date.now(), start = Date.parse(options.activatedAt);
  if (!Number.isFinite(start)) return 0;
  const targets = memoryService.list(undefined, { includeInactive: true }).filter((m) => {
    const at = Date.parse(m.createdAt);
    return at >= start && ((m.expiresAt && Date.parse(m.expiresAt) < now) ||
      (m.layer === "episodic" && at < now - options.episodeDays * 86_400_000));
  });
  if (!targets.length) return 0;
  return forgetEverywhere({ ids: targets.map((m) => m.id) }).count;
}
