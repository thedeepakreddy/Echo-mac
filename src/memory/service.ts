import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { memoryRoot } from "./paths.js";
import { contentHash, matchesQuery, normalizedScope, sameScope, scopeMatches, suppressionMatches, writePolicy } from "./policy.js";
import type { ForgetReceipt, ForgetRequest, MemoryChange, MemoryFilters, MemoryInput, MemoryObject, MemoryScope, SuppressionRule } from "./types.js";
export * from "./types.js";
export { memoryRoot } from "./paths.js";

interface Barrier { id: string; hash: string; scope: MemoryScope; taskId?: string; revision: number }
interface State {
  schemaVersion: 1; revision: number; deletionRevision: number;
  objects: Record<string, MemoryObject>; barriers: Barrier[];
  suppressions: SuppressionRule[]; imports: string[];
}
interface Event {
  schemaVersion: 1; revision: number; type: MemoryChange["type"];
  upserts?: MemoryObject[]; deletes?: string[]; barriers?: Barrier[];
  suppressions?: SuppressionRule[]; imports?: string[];
}
const empty = (): State => ({ schemaVersion: 1, revision: 0, deletionRevision: 0, objects: {}, barriers: [], suppressions: [], imports: [] });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Temp file + fsync + rename. Caller owns the single synchronous writer. */
export function atomicMemoryFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  // Some filesystems do not support directory fsync. The data fd was synced.
  try { const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); } } catch { /* platform limitation */ }
}
function apply(state: State, event: Event): void {
  if (event.schemaVersion !== 1 || !Number.isInteger(event.revision)) throw new Error("Unsupported memory journal schema");
  if (event.revision <= state.revision) return;
  if (event.revision !== state.revision + 1) throw new Error("Memory journal revision gap; repair required");
  for (const item of event.upserts ?? []) {
    if (!item?.id || item.schemaVersion !== 1 || typeof item.summary !== "string" || !item.source || !item.scope) throw new Error("Invalid memory object in journal");
    state.objects[item.id] = item;
  }
  for (const id of event.deletes ?? []) delete state.objects[id];
  if (event.barriers?.length) { state.barriers.push(...event.barriers); state.deletionRevision = event.revision; }
  if (event.suppressions) state.suppressions = event.suppressions;
  if (event.imports) state.imports = event.imports;
  state.revision = event.revision;
}
function parseJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const out: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { out.push(JSON.parse(lines[i])); }
    catch { if (i === lines.length - 1) break; throw new Error(`Corrupt memory record in ${path} at line ${i + 1}`); }
  }
  return out;
}

/** One main-process authority. Methods are synchronous: no await can interleave commits. */
export class MemoryService {
  private rootProvider: () => string;
  private state: State | null = null;
  private loadedRoot = "";
  private listeners = new Set<(event: MemoryChange) => void>();
  constructor(root: string | (() => string) = memoryRoot) { this.rootProvider = typeof root === "string" ? () => root : root; }
  root(): string { return this.rootProvider(); }
  private load(): State {
    const root = this.root();
    if (this.state && this.loadedRoot === root) return this.state;
    let state = empty();
    const snapshot = join(root, "state.json");
    if (existsSync(snapshot)) {
      state = JSON.parse(readFileSync(snapshot, "utf8"));
      if (state.schemaVersion !== 1 || !Number.isInteger(state.revision) || !state.objects || !Array.isArray(state.barriers) || !Array.isArray(state.suppressions)) throw new Error("Invalid memory snapshot; refusing to overwrite it");
    }
    for (const event of parseJsonl(join(root, "events.jsonl"))) apply(state, event);
    this.loadedRoot = root;
    this.state = state;
    return state;
  }
  /** Tests/restart only: discard an in-process projection and replay durable data. */
  reload(): void { this.state = null; this.load(); }
  private commit(event: Omit<Event, "schemaVersion" | "revision">): number {
    const current = this.load();
    const full: Event = { ...event, schemaVersion: 1, revision: current.revision + 1 };
    const next = copy(current);
    apply(next, full);
    const root = this.root();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const fd = openSync(join(root, "events.jsonl"), "a", 0o600);
    try { writeSync(fd, JSON.stringify(full) + "\n", undefined, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    // The journal is authoritative even if writing the projection fails.
    this.state = next;
    try { atomicMemoryFile(join(root, "state.json"), JSON.stringify(next)); }
    catch (error) { console.error("[memory] snapshot deferred; journal is durable:", (error as Error).message); }
    const change: MemoryChange = { type: event.type, revision: full.revision, ids: [...(event.upserts ?? []).map((m) => m.id), ...(event.deletes ?? [])] };
    for (const listener of this.listeners) { try { listener(copy(change)); } catch { /* observer cannot undo committed memory */ } }
    return full.revision;
  }
  revision(): number { return this.load().revision; }
  subscribe(listener: (event: MemoryChange) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get(id: string): MemoryObject | undefined { const item = this.load().objects[id]; return item ? copy(item) : undefined; }
  list(scope?: MemoryScope, filters: MemoryFilters = {}): MemoryObject[] {
    return Object.values(this.load().objects).filter((item) => {
      if (scope && !scopeMatches(item.scope, scope)) return false;
      if (!scope && normalizedScope(item.scope).principalId !== "local-user") return false;
      if (!filters.includeInactive && item.status !== "active" && item.status !== "disputed") return false;
      if (filters.layer && item.layer !== filters.layer) return false;
      if (filters.kind && item.kind !== filters.kind) return false;
      if (filters.status && item.status !== filters.status) return false;
      if (filters.taskId && item.scope.taskId !== filters.taskId && item.source.taskId !== filters.taskId) return false;
      return !filters.query || matchesQuery(filters.query, `${item.summary} ${item.key ?? ""}`);
    }).map(copy).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  isSuppressed(scope: MemoryScope = {}, taskId?: string): boolean {
    return this.load().suppressions.some((rule) => suppressionMatches(rule, normalizedScope(scope), taskId));
  }
  suppressions(): SuppressionRule[] { return copy(this.load().suppressions); }
  setSuppression(input: { id?: string; scope?: MemoryScope; taskId?: string; enabled: boolean; reason?: string }): SuppressionRule {
    const state = this.load();
    const rule: SuppressionRule = { id: input.id ?? randomUUID(), scope: normalizedScope(input.scope), taskId: input.taskId, enabled: input.enabled, reason: input.reason ? String(input.reason).slice(0, 200) : undefined, createdAt: new Date().toISOString() };
    this.commit({ type: "suppression", suppressions: [...state.suppressions.filter((r) => r.id !== rule.id), rule] });
    return copy(rule);
  }
  propose(input: MemoryInput): MemoryObject | null {
    const state = this.load();
    const policy = writePolicy(input);
    if (!policy.allowed) return null;
    const clean = policy.input;
    const scope = normalizedScope(clean.scope);
    if (this.isSuppressed(scope, clean.source?.taskId)) return null;
    if (input.baseRevision != null && input.baseRevision < state.deletionRevision) return null;
    const derived = clean.source?.derivedFromIds ?? [];
    if (derived.some((id) => state.barriers.some((barrier) => barrier.id === id))) return null;
    if (clean.id && state.barriers.some((barrier) => barrier.id === clean.id)) return null;
    const hash = contentHash(clean.summary);
    const explicitNewStatement = clean.source?.kind === "user" && clean.source.trust === "user_asserted" && input.baseRevision == null;
    if (!explicitNewStatement && state.barriers.some((barrier) => barrier.hash === hash && sameScope(barrier.scope, scope))) return null;
    const now = new Date().toISOString();
    const prior = clean.id ? state.objects[clean.id] : undefined;
    if (prior && !sameScope(prior.scope, scope)) throw new Error("A memory ID cannot change scope");
    if (input.expectedRevision != null && prior?.revision !== input.expectedRevision) throw new Error("Memory revision conflict");
    const trust = clean.source?.trust ?? (clean.source?.kind === "user" ? "user_asserted" : clean.source?.kind === "tool" ? "observed" : "inferred");
    const memory: MemoryObject = {
      schemaVersion: 1, id: clean.id ?? randomUUID(), revision: (prior?.revision ?? 0) + 1,
      layer: clean.layer, kind: clean.kind, key: clean.key, summary: clean.summary.trim().slice(0, 12_000),
      payload: clean.payload, payloadRef: clean.payloadRef,
      confidence: clean.confidence == null ? null : Math.max(0, Math.min(1, clean.confidence)),
      confidenceBasis: clean.confidenceBasis ?? "Evidence confidence has not been established",
      importance: Math.max(0, Math.min(1, clean.importance ?? 0.5)), status: clean.status ?? "active", scope,
      source: { kind: clean.source?.kind ?? "inference", origin: "real", evidenceRefs: [], derivedFromIds: [], ...clean.source, trust },
      createdAt: prior?.createdAt ?? clean.createdAt ?? now, observedAt: clean.observedAt ?? null,
      validFrom: clean.validFrom, validTo: clean.validTo, lastVerifiedAt: clean.lastVerifiedAt,
      expiresAt: clean.expiresAt, timezone: clean.timezone,
      supersedesIds: clean.supersedesIds ?? [], contradictsIds: clean.contradictsIds ?? [],
      privacy: { sensitivity: "personal", modelAccess: "local_only", retentionPolicy: "explicit", trainingAllowed: false, ...clean.privacy },
      embedding: clean.embedding,
    };
    const sources = derived.map((id) => state.objects[id]).filter(Boolean);
    if (sources.some((source) => source.privacy.modelAccess === "local_only")) memory.privacy.modelAccess = "local_only";
    if (sources.some((source) => !source.privacy.trainingAllowed)) memory.privacy.trainingAllowed = false;
    if (sources.some((source) => source.privacy.sensitivity === "sensitive")) memory.privacy.sensitivity = "sensitive";
    for (const date of [memory.createdAt, memory.observedAt, memory.validFrom, memory.validTo, memory.lastVerifiedAt, memory.expiresAt]) {
      if (date != null && !Number.isFinite(Date.parse(date))) throw new Error("Invalid memory timestamp");
    }
    const peers = Object.values(state.objects).filter((m) => m.id !== memory.id && memory.key && m.key === memory.key && m.layer === memory.layer && sameScope(m.scope, scope) && m.status === "active");
    const changed: MemoryObject[] = [];
    for (const peer of peers) {
      if (peer.summary === memory.summary) { memory.source.derivedFromIds = [...new Set([...memory.source.derivedFromIds, ...peer.source.derivedFromIds])]; continue; }
      const overlaps = !(peer.validTo && memory.validFrom && Date.parse(peer.validTo) <= Date.parse(memory.validFrom)) && !(memory.validTo && peer.validFrom && Date.parse(memory.validTo) <= Date.parse(peer.validFrom));
      if (!overlaps) continue;
      if (memory.source.kind === "user" && memory.source.trust === "user_asserted") {
        // Stamp both ends of the handover. Without a validFrom on the new
        // record, "what did we use to do" cannot tell the two apart: the
        // replacement looks like it was always true, and a question about last
        // year answers with today's decision.
        memory.validFrom = memory.validFrom ?? now;
        changed.push({ ...peer, revision: peer.revision + 1, status: "superseded", validTo: memory.validFrom });
        memory.supersedesIds = [...new Set([...memory.supersedesIds, peer.id])];
      } else {
        memory.status = "disputed";
        memory.contradictsIds.push(peer.id);
        changed.push({ ...peer, revision: peer.revision + 1, status: "disputed", contradictsIds: [...new Set([...peer.contradictsIds, memory.id])] });
      }
    }
    for (const id of memory.supersedesIds) {
      const peer = state.objects[id];
      if (!peer || !sameScope(peer.scope, scope) || changed.some((m) => m.id === id)) continue;
      memory.validFrom = memory.validFrom ?? now;
      changed.push({ ...peer, revision: peer.revision + 1, status: "superseded", validTo: memory.validFrom });
    }
    if (prior && JSON.stringify({ ...memory, revision: prior.revision }) === JSON.stringify(prior) && !changed.length) return copy(prior);
    this.commit({ type: "write", upserts: [...changed, memory] });
    return copy(memory);
  }
  forget(request: ForgetRequest): ForgetReceipt {
    const state = this.load();
    const wanted = new Set(request.ids ?? []);
    const selected = Object.values(state.objects).filter((item) => {
      if (request.scope && !scopeMatches(item.scope, request.scope)) return false;
      const matchId = wanted.has(item.id);
      const matchTask = !!request.taskId && (item.source.taskId === request.taskId || item.scope.taskId === request.taskId);
      return matchId || matchTask || (!!request.query && matchesQuery(request.query, `${item.summary} ${item.key ?? ""}`));
    });
    const ids = new Set(selected.map((m) => m.id));
    let added = true;
    while (added) {
      added = false;
      for (const item of Object.values(state.objects)) {
        if (!ids.has(item.id) && item.source.derivedFromIds.some((id) => ids.has(id))) { ids.add(item.id); added = true; }
      }
    }
    const deletedObjects = [...ids].map((id) => copy(state.objects[id]));
    if (!ids.size) return { deletedIds: [], deletedObjects: [], count: 0, revision: state.revision };
    const revision = this.commit({ type: "delete", deletes: [...ids], barriers: deletedObjects.map((item) => ({ id: item.id, hash: contentHash(item.summary), scope: item.scope, taskId: item.source.taskId, revision: state.revision + 1 })) });
    // Remove historical payload copies only after the durable deletion barrier exists.
    this.compact();
    return { deletedIds: [...ids], deletedObjects, count: ids.size, revision };
  }
  compact(): void {
    const state = this.load();
    atomicMemoryFile(join(this.root(), "state.json"), JSON.stringify(state));
    atomicMemoryFile(join(this.root(), "events.jsonl"), "");
  }
  /** Explicit, idempotent import. Deleted legacy IDs stay barred after future imports. */
  importLegacy(paths: { memoryFile?: string; episodicDir?: string; skillsFile?: string } = {}): { imported: number; skipped: number } {
    const memoryFile = paths.memoryFile ?? join(homedir(), ".jarvis", "memory", "memories.jsonl");
    const episodicDirectory = paths.episodicDir ?? process.env.JARVIS_EPISODIC_DIR ?? join(homedir(), ".jarvis", "episodic");
    const result = { imported: 0, skipped: 0 };
    const importSource = (path: string, records: MemoryInput[]) => {
      if (!existsSync(path) || this.load().imports.includes(path)) return;
      for (const item of records) {
        if (item.id && this.get(item.id)) { result.skipped++; continue; }
        const saved = this.propose(item); saved ? result.imported++ : result.skipped++;
      }
      this.commit({ type: "import", imports: [...this.load().imports, path] });
    };
    if (!this.load().imports.includes(memoryFile) && existsSync(memoryFile)) {
      const rows = parseJsonl(memoryFile);
      const forgotten = new Set(rows.filter((r) => typeof r.forget === "string").map((r) => r.forget));
      importSource(memoryFile, rows.filter((r) => typeof r.id === "string" && typeof r.text === "string" && !r.forget && !forgotten.has(r.id)).map((r) => ({
        id: r.id, layer: r.type === "episode" ? "episodic" : "semantic", kind: r.type ?? "legacy", summary: r.text,
        scope: { projectId: r.project }, createdAt: r.at, observedAt: null, confidence: null, status: "active",
        confidenceBasis: "Imported legacy memory; original source/verification unavailable",
        payload: { legacyType: r.type, legacyPath: memoryFile }, source: { kind: "import", trust: "legacy_unknown", evidenceRefs: [`${memoryFile}#${r.id}`] },
      })));
    }
    for (const [name, layer] of [["episodes", "episodic"], ["facts", "semantic"]] as const) {
      const path = join(episodicDirectory, `${name}.jsonl`);
      if (this.load().imports.includes(path) || !existsSync(path)) continue;
      importSource(path, parseJsonl(path).filter((r) => typeof r.id === "string" && typeof r.text === "string").map((r) => ({
        id: r.id, layer, kind: r.kind ?? "legacy", summary: r.text, scope: { projectId: r.project },
        createdAt: new Date(r.at ?? r.firstSeen ?? 0).toISOString(), observedAt: r.at != null ? new Date(r.at).toISOString() : null,
        confidence: null, confidenceBasis: "Legacy heuristic support is not independently verified", importance: r.importance,
        status: layer === "semantic" ? "candidate" : "active", payload: { legacyPath: path, legacySupport: r.support },
        source: { kind: "import", trust: "legacy_unknown", turnId: r.turn, evidenceRefs: [`${path}#${r.id}`], derivedFromIds: r.sourceEpisodeIds ?? [] },
      })));
    }
    if (paths.skillsFile && existsSync(paths.skillsFile) && !this.load().imports.includes(paths.skillsFile)) {
      const path = paths.skillsFile;
      const rows = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(rows)) throw new Error("Invalid legacy skills file");
      importSource(path, rows.filter((r) => r?.name && Array.isArray(r.steps)).map((r) => ({
        id: `legacy-skill-${contentHash(`${path}:${r.name}`).slice(0, 24)}`, layer: "procedural", kind: "skill", key: `skill:${String(r.name).toLowerCase()}`, summary: String(r.description || r.name),
        status: "candidate", payload: { ...r, legacyPath: path }, createdAt: new Date(r.createdAt ?? 0).toISOString(), observedAt: null,
        source: { kind: "import", trust: "legacy_unknown", evidenceRefs: [`${path}#${r.name}`] },
      })));
    }
    return result;
  }
}
export const memoryService = new MemoryService();
