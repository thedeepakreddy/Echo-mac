import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { scrubSecrets } from "../safety/redact.js";
import type { ToolResultMetadata, ToolStatus } from "./tool-result.js";
import { memoryRoot } from "./paths.js";

export interface TaskInvocation {
  readonly taskId: string; readonly actorId: string; readonly stepId: string; readonly callId: string;
  readonly generation: number; readonly baseRevision: number; readonly resources: readonly string[];
}
export interface TaskObservation {
  id: string; sourceCallId?: string; observedAt: string; resourceId?: string;
  resourceVersion?: string; expiresAt?: string; value: unknown;
}
export interface TaskCall {
  callId: string; tool: string; stepId: string; actorId: string; generation: number;
  status: "running" | ToolStatus; startedAt: string; endedAt?: string; resources: string[];
  result?: ToolResultMetadata & { text?: string }; late?: boolean;
}
export type TaskResultStatus = "completed" | "partial" | "blocked" | "failed" | "cancelled";
export interface TaskArtifact {
  kind: "text" | "file" | "url" | "data";
  label: string;
  value: string;
}
export interface TaskResult {
  status: TaskResultStatus;
  summary: string;
  artifacts: TaskArtifact[];
  verificationRefs: string[];
  blockers: string[];
  completedAt: string;
}
export interface TaskState {
  schemaVersion: 1; taskId: string; parentTaskId?: string; ownerActorId: string;
  revision: number; generation: number; goal: string; scope: Record<string, any>; privateMode: boolean;
  status: "running" | "waiting" | "verifying" | "completed" | "failed" | "cancelled" | "partial" | "blocked";
  steps: Record<string, { ownerActorId: string; status: string; dependsOn?: string[]; verificationRefs?: string[] }>;
  observations: Record<string, TaskObservation>; calls: Record<string, TaskCall>;
  bindings: Record<string, unknown>; decisions: unknown[]; artifacts: unknown[]; blockers: unknown[];
  childTaskIds: string[]; approvalRefs: string[]; verificationRefs: string[]; attemptIds: string[];
  createdAt: string; updatedAt: string; summary?: string; result?: TaskResult;
}
export interface TaskPatch {
  expectedRevision: number; generation: number; actorId: string; callId?: string;
  changes: { bindings?: Record<string, unknown>; observations?: TaskObservation[]; artifacts?: unknown[]; decisions?: unknown[]; blockers?: unknown[] };
}
export type PatchResult = { ok: true; state: TaskState } | { ok: false; reason: "not_found" | "conflict" | "cancelled" | "ownership" | "duplicate"; revision?: number };
type Lease = { taskId: string; callId: string; generation: number; quarantined: boolean };
const copy = <T>(value: T): T => structuredClone(value);
const safeId = (value: string) => { if (!/^[a-zA-Z0-9_.-]+$/.test(value) || value === "." || value === "..") throw new Error(`Invalid task identifier: ${JSON.stringify(value)}`); return value; };
const STABLE_ID_FIELDS = new Set([
  "id", "taskId", "parentTaskId", "ownerActorId", "actorId", "callId", "sourceCallId", "stepId",
  "childTaskIds", "attemptIds",
]);
const clean = (value: unknown, field = ""): any =>
  typeof value === "string"
    ? (STABLE_ID_FIELDS.has(field) ? value : scrubSecrets(value))
    : Array.isArray(value)
      ? value.map((item) => clean(item, field))
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            /password|secret|credential|authorization|api.?key/i.test(key) ? "[redacted]" : clean(item, key),
          ]))
        : value;

/** One synchronous writer in Electron main; acknowledgements follow durable appends. */
export class TaskCoordinator {
  private states = new Map<string, TaskState>();
  private leases = new Map<string, Lease>();
  private committed = new Set<string>();
  private deleted = new Set<string>();
  private loadedRoot = "";
  constructor(private readonly configuredRoot?: string) {}
  root(): string { return this.configuredRoot ?? memoryRoot(); }
  private load(): void {
    const root = this.root();
    if (this.loadedRoot === root) return;
    this.states.clear(); this.leases.clear(); this.committed.clear(); this.deleted.clear(); this.loadedRoot = root;
    const base = join(root, "tasks");
    if (!existsSync(base)) return;
    for (const taskId of readdirSync(base)) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(taskId)) continue;
      const dir = join(base, taskId);
      if (existsSync(join(dir, "deleted"))) { this.deleted.add(taskId); continue; }
      let state: TaskState | null = null;
      try { state = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8")); } catch {}
      try {
        for (const line of readFileSync(join(dir, "events.jsonl"), "utf8").split("\n")) {
          if (!line.trim()) continue;
          try { const event = JSON.parse(line); if (event.commitId) this.committed.add(event.commitId); if (event.state?.taskId === taskId && (!state || event.state.revision > state.revision)) state = event.state; } catch { /* tolerate an incomplete crash tail */ }
        }
      } catch {}
      if (!state || state.schemaVersion !== 1 || state.taskId !== taskId) continue;
      this.states.set(taskId, state);
      for (const call of Object.values(state.calls)) if (["running", "timeout", "uncertain"].includes(call.status)) {
        for (const resource of call.resources) this.leases.set(resource, { taskId, callId: call.callId, generation: call.generation, quarantined: true });
      }
    }
  }
  private persist(state: TaskState, type: string, commitId?: string): void {
    const next = clean(state) as TaskState;
    if (!state.privateMode) {
      const dir = join(this.root(), "tasks", safeId(state.taskId)); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = openSync(join(dir, "events.jsonl"), "a", 0o600);
      try { appendFileSync(fd, JSON.stringify({ type, taskId: state.taskId, revision: state.revision, commitId, state: next }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      const tmp = join(dir, ".snapshot.tmp"); writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      const snap = openSync(tmp, "r"); try { fsyncSync(snap); } finally { closeSync(snap); } renameSync(tmp, join(dir, "snapshot.json"));
      try { const d = openSync(dir, "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* directory fsync is platform-dependent */ }
    }
    // Do not retain an unsanitized alternate copy in memory after persisting it.
    this.states.set(state.taskId, copy(next));
    if (commitId) this.committed.add(commitId);
  }
  create(input: { taskId?: string; parentTaskId?: string; ownerActorId: string; goal: string; scope?: Record<string, any>; privateMode?: boolean }): TaskState {
    this.load(); const taskId = safeId(input.taskId ?? randomUUID());
    if (this.deleted.has(taskId)) throw new Error("Task was forgotten");
    const existing = this.states.get(taskId); if (existing) { if (existing.ownerActorId !== input.ownerActorId) throw new Error("Task belongs to another actor"); return copy(existing); }
    const now = new Date().toISOString();
    const state: TaskState = { schemaVersion: 1, taskId, parentTaskId: input.parentTaskId, ownerActorId: input.ownerActorId, revision: 0, generation: 0, goal: String(clean(input.goal)), scope: clean(input.scope ?? {}), privateMode: input.privateMode === true, status: "running", steps: {}, observations: {}, calls: {}, bindings: {}, decisions: [], artifacts: [], blockers: [], childTaskIds: [], approvalRefs: [], verificationRefs: [], attemptIds: [], createdAt: now, updatedAt: now };
    this.persist(state, "task.created");
    if (input.parentTaskId && this.states.has(input.parentTaskId)) this.update(input.parentTaskId, "task.child", parent => { if (!parent.childTaskIds.includes(taskId)) parent.childTaskIds.push(taskId); });
    return copy(state);
  }
  get(taskId: string): TaskState | null { this.load(); const state = this.states.get(taskId); return state ? copy(state) : null; }
  list(): TaskState[] { this.load(); return [...this.states.values()].map(copy); }
  private update(taskId: string, type: string, change: (state: TaskState) => void, commitId?: string): TaskState {
    this.load(); const current = this.states.get(taskId); if (!current || this.deleted.has(taskId)) throw new Error("Task not found");
    const next = copy(current); change(next); next.revision++; next.updatedAt = new Date().toISOString(); this.persist(next, type, commitId); return copy(next);
  }
  patch(taskId: string, patch: TaskPatch): PatchResult {
    const state = this.get(taskId); if (!state) return { ok: false, reason: "not_found" };
    if (patch.generation !== state.generation || state.status === "cancelled") return { ok: false, reason: "cancelled", revision: state.revision };
    if (patch.actorId !== state.ownerActorId) return { ok: false, reason: "ownership", revision: state.revision };
    const commitId = patch.callId ? `${taskId}:patch:${patch.callId}` : undefined;
    if (commitId && this.committed.has(commitId)) return { ok: false, reason: "duplicate", revision: state.revision };
    if (patch.expectedRevision !== state.revision) return { ok: false, reason: "conflict", revision: state.revision };
    return { ok: true, state: this.update(taskId, "task.patch", next => {
      if (patch.changes.bindings) Object.assign(next.bindings, clean(patch.changes.bindings));
      for (const observation of patch.changes.observations ?? []) { if (next.observations[observation.id]) throw new Error("Observation is immutable"); next.observations[observation.id] = clean(observation); }
      next.artifacts.push(...clean(patch.changes.artifacts ?? [])); next.decisions.push(...clean(patch.changes.decisions ?? [])); next.blockers.push(...clean(patch.changes.blockers ?? []));
    }, commitId) };
  }
  assertInvocation(invocation: TaskInvocation): TaskState {
    const task = this.get(invocation.taskId);
    if (!task || task.ownerActorId !== invocation.actorId || task.generation !== invocation.generation || task.status === "cancelled" || task.result) {
      throw new Error("Invocation is cancelled, complete, or no longer owns the task");
    }
    return task;
  }
  bind(taskId: string, key: string, value: unknown, invocation?: TaskInvocation): TaskState {
    if (invocation) { if (invocation.taskId !== taskId) throw new Error("Cross-task binding denied"); this.assertInvocation(invocation); }
    return this.update(taskId, "task.binding", state => { state.bindings[key] = clean(value); });
  }
  lookup<T = unknown>(taskId: string, key: string): T | undefined { return this.get(taskId)?.bindings[key] as T | undefined; }
  addObservation(taskId: string, input: Partial<TaskObservation> & { value: unknown }, invocation?: TaskInvocation): TaskObservation {
    if (invocation) { if (invocation.taskId !== taskId) throw new Error("Cross-task observation denied"); this.assertInvocation(invocation); }
    const observation: TaskObservation = { ...input, id: input.id ?? randomUUID(), observedAt: input.observedAt ?? new Date().toISOString(), sourceCallId: input.sourceCallId ?? invocation?.callId };
    this.update(taskId, "task.observation", state => { if (state.observations[observation.id]) throw new Error("Observation is immutable"); state.observations[observation.id] = clean(observation); }); return copy(observation);
  }
  getObservation(taskId: string, id: string): TaskObservation | undefined { const item = this.get(taskId)?.observations[id]; return item && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()) ? item : undefined; }
  startCall(invocation: TaskInvocation, tool: string): TaskState {
    const task = this.assertInvocation(invocation); if (task.calls[invocation.callId]) return task;
    return this.update(task.taskId, "call.started", next => { next.calls[invocation.callId] = { ...invocation, resources: [...invocation.resources], tool, status: "running", startedAt: new Date().toISOString() }; });
  }
  endCall(invocation: TaskInvocation, result: ToolResultMetadata & { text?: string }): TaskState | null {
    const task = this.get(invocation.taskId); if (!task) return null;
    const commitId = `${invocation.taskId}:result:${invocation.callId}`; if (this.committed.has(commitId)) return task;
    return this.update(task.taskId, "call.result", next => { const call = next.calls[invocation.callId]; if (!call) throw new Error("Unknown invocation"); call.result = copy(result); call.status = result.status ?? "uncertain"; call.endedAt = new Date().toISOString(); call.late = invocation.generation !== next.generation; }, commitId);
  }
  recordAttempt(taskId: string, runId: string): void { this.update(taskId, "task.attempt", state => { if (!state.attemptIds.includes(runId)) state.attemptIds.push(runId); }); }
  /**
   * Commit the terminal Result produced by an Agent Task.
   *
   * A model stream ending is not completion. This is the explicit, durable
   * handoff from an agent to its parent Mission. Completed work must carry
   * at least one artifact and verification evidence; retries may repeat the
   * exact same Result, but may not replace it with a different story.
   */
  submitResult(taskId: string, actorId: string, input: Omit<TaskResult, "completedAt">): TaskState {
    const current = this.get(taskId);
    if (!current) throw new Error("Task not found");
    if (current.ownerActorId !== actorId) throw new Error("Task belongs to another actor");
    if (current.status === "cancelled") throw new Error("Task is cancelled");
    const summary = String(input.summary ?? "").trim();
    if (!summary) throw new Error("A Result requires a summary");
    const artifacts = input.artifacts ?? [];
    const verificationRefs = [...new Set((input.verificationRefs ?? []).map(String).filter(Boolean))];
    if (input.status === "completed" && !artifacts.length) {
      throw new Error("A completed Result requires at least one artifact");
    }
    if (input.status === "completed" && !verificationRefs.length) {
      throw new Error("A completed Result requires verification evidence");
    }
    const result: TaskResult = clean({
      status: input.status,
      summary,
      artifacts,
      verificationRefs,
      blockers: (input.blockers ?? []).map(String).filter(Boolean),
      completedAt: new Date().toISOString(),
    });
    if (current.result) {
      const comparable = (value: TaskResult) => JSON.stringify({
        status: value.status,
        summary: value.summary,
        artifacts: value.artifacts,
        verificationRefs: value.verificationRefs,
        blockers: value.blockers,
      });
      if (comparable(current.result) === comparable(result)) return current;
      throw new Error("Task already has a different Result");
    }
    return this.update(taskId, "task.result", state => {
      state.result = result;
      state.status = result.status;
      state.summary = result.summary;
      state.artifacts.push(...result.artifacts);
      state.blockers.push(...result.blockers);
      state.verificationRefs = [...new Set([...state.verificationRefs, ...result.verificationRefs])];
    });
  }
  cancel(taskId: string): TaskState { return this.update(taskId, "task.cancelled", state => { state.generation++; state.status = "cancelled"; for (const lease of this.leases.values()) if (lease.taskId === taskId) lease.quarantined = true; }); }
  finish(taskId: string, input: { status: TaskState["status"]; verificationRefs?: string[]; summary?: string }): TaskState {
    return this.update(taskId, "task.finished", state => {
      const uncertain = Object.values(state.calls).some(call => ["running", "timeout", "uncertain", "partial"].includes(call.status));
      const evidence = input.verificationRefs ?? state.verificationRefs;
      state.status = input.status === "completed" && (uncertain || !evidence.length) ? "verifying" : input.status;
      state.verificationRefs = [...new Set(evidence)]; state.summary = input.summary;
    });
  }
  /** Verification is append-only evidence. It can complete a task only after uncertain calls are resolved. */
  recordVerification(taskId: string, verificationRefs: string[]): TaskState {
    const refs = [...new Set(verificationRefs.map(String).filter(Boolean))];
    if (!refs.length) throw new Error("Verification requires at least one evidence reference");
    return this.update(taskId, "task.verified", state => {
      state.verificationRefs = [...new Set([...state.verificationRefs, ...refs])];
      const uncertain = Object.values(state.calls).some(call => ["running", "timeout", "uncertain", "partial"].includes(call.status));
      if (state.status === "verifying" && !uncertain) state.status = "completed";
    });
  }
  acquireResources(invocation: TaskInvocation): { ok: boolean; resource?: string; quarantined?: boolean } {
    this.assertInvocation(invocation);
    for (const resource of invocation.resources) { const held = this.leases.get(resource); if (held && held.callId !== invocation.callId) return { ok: false, resource, quarantined: held.quarantined }; }
    for (const resource of invocation.resources) this.leases.set(resource, { taskId: invocation.taskId, callId: invocation.callId, generation: invocation.generation, quarantined: false }); return { ok: true };
  }
  releaseResources(invocation: TaskInvocation, uncertain = false): void { for (const resource of invocation.resources) { const held = this.leases.get(resource); if (held?.callId !== invocation.callId) continue; if (uncertain) held.quarantined = true; else this.leases.delete(resource); } }
  reconcileResource(resource: string, expectedCallId: string): boolean { const held = this.leases.get(resource); if (!held || held.callId !== expectedCallId) return false; this.leases.delete(resource); return true; }
  resourceState(): Record<string, Lease> { this.load(); return Object.fromEntries([...this.leases].map(([key,value]) => [key,copy(value)])); }
  contextPacket(taskId: string): string { const state = this.get(taskId); if (!state) return ""; return JSON.stringify({ taskId, revision: state.revision, goal: state.goal, scope: state.scope, status: state.status, steps: state.steps, bindings: state.bindings, calls: Object.values(state.calls).map(({callId, tool, status, result}) => ({callId,tool,status,result})), blockers: state.blockers, artifacts: state.artifacts }); }
  /** Remove local task references to deleted memory IDs so a stale binding cannot resurrect them. */
  invalidateMemories(memoryIds: readonly string[]): number {
    this.load();
    const ids = new Set(memoryIds);
    if (!ids.size) return 0;
    const references = (value: unknown): boolean => {
      if (typeof value === "string") return ids.has(value);
      if (Array.isArray(value)) return value.some(references);
      return Boolean(value && typeof value === "object" && Object.values(value).some(references));
    };
    let changed = 0;
    for (const task of [...this.states.values()]) {
      const bindings = Object.fromEntries(Object.entries(task.bindings).filter(([, value]) => !references(value)));
      const observations = Object.fromEntries(Object.entries(task.observations).filter(([, value]) => !references(value)));
      const decisions = task.decisions.filter((value) => !references(value));
      const artifacts = task.artifacts.filter((value) => !references(value));
      const blockers = task.blockers.filter((value) => !references(value));
      if (Object.keys(bindings).length === Object.keys(task.bindings).length && Object.keys(observations).length === Object.keys(task.observations).length && decisions.length === task.decisions.length && artifacts.length === task.artifacts.length && blockers.length === task.blockers.length) continue;
      this.update(task.taskId, "task.memory_invalidated", state => {
        state.bindings = bindings; state.observations = observations; state.decisions = decisions; state.artifacts = artifacts; state.blockers = blockers;
      });
      changed++;
    }
    return changed;
  }
  forget(taskId: string): boolean {
    this.load(); const state = this.states.get(taskId); if (!state) return false;
    // Preserve no content, but retain a durable barrier against stale in-flight writes.
    const dir = join(this.root(), "tasks", safeId(taskId));
    if (!state.privateMode) { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir,"deleted"), "forgotten\n", { mode: 0o600 }); for (const file of ["events.jsonl", "snapshot.json", ".snapshot.tmp"]) rmSync(join(dir,file), { force: true }); }
    this.deleted.add(taskId); this.states.delete(taskId); for (const lease of this.leases.values()) if (lease.taskId === taskId) lease.quarantined = true; return true;
  }
}
export const taskCoordinator = new TaskCoordinator();
