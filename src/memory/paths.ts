import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Mutable data belongs to the user, never the installed application bundle. */
export const dataRoot = () => resolve(process.env.ECHO_DATA_ROOT?.trim() || join(homedir(), ".jarvis"));
export const memoryRoot = () => resolve(process.env.ECHO_MEMORY_ROOT?.trim() || join(dataRoot(), "memory", "os"));

export function atomicWrite(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, value, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  // Some filesystems cannot fsync directories. The file itself is durable.
  try { const dir = openSync(dirname(file), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* unsupported */ }
}

export interface MigrationReceipt { version: 1; source: string; destination: string; copied: string[]; conflicts: string[]; completedAt: string }

/** Copy-only, resumable migration. Existing destination data always wins. */
export function migrateAppData(appRoot: string): MigrationReceipt {
  const source = resolve(appRoot), destination = dataRoot();
  const receipt: MigrationReceipt = { version: 1, source, destination, copied: [], conflicts: [], completedAt: new Date().toISOString() };
  if (source === destination) return receipt;
  const manifest = join(destination, "memory", "migrations", `${createHash("sha256").update(source).digest("hex").slice(0, 16)}.json`);
  if (existsSync(manifest)) {
    const old = JSON.parse(readFileSync(manifest, "utf8")) as MigrationReceipt;
    if (old.version === 1 && old.conflicts.length === 0) return old;
  }
  const copy = (relative: string) => {
    const from = join(source, relative), to = join(destination, relative);
    if (!existsSync(from)) return;
    const info = statSync(from);
    if (info.isDirectory()) {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) copy(join(relative, entry.name));
      }
    } else if (info.isFile()) {
      if (existsSync(to)) {
        const a = createHash("sha256").update(readFileSync(from)).digest("hex");
        const b = createHash("sha256").update(readFileSync(to)).digest("hex");
        if (a !== b) receipt.conflicts.push(relative);
      } else {
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        const tmp = `${to}.${randomUUID()}.tmp`;
        copyFileSync(from, tmp);
        renameSync(tmp, to);
        receipt.copied.push(relative);
      }
    }
  };
  for (const entry of ["rewind", "long_term_memory.json", "skills", "prefetch.json"]) copy(entry);
  atomicWrite(manifest, JSON.stringify(receipt, null, 2));
  return receipt;
}
