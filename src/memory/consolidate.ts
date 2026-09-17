import { memoryService } from "./service.js";
import { sameScope } from "./policy.js";
import { taskCoordinator } from "./task-state.js";
import type { ToolStatus } from "./tool-result.js";
import type { ExecutionOrigin, MemoryObject, MemoryScope } from "./types.js";

type TaskOutcome = "verified_success" | "failed" | "cancelled" | "partial";

export interface TaskConsolidationInput {
  taskId: string;
  scope?: MemoryScope;
  goal: string;
  outcome: TaskOutcome;
  executionStatus: "completed" | "failed" | "cancelled";
  verificationRefs: string[];
  attemptIds: string[];
  actorId: string;
  origin: ExecutionOrigin;
}

export interface ToolOutcomeInput {
  tool: string;
  taskId: string;
  callId: string;
  scope?: MemoryScope;
  status: ToolStatus;
  verified: boolean;
  durationMs?: number;
  errorCategory?: string;
  origin: ExecutionOrigin;
}

export interface ProcedureInput {
  procedureId?: string;
  name: string;
  description: string;
  steps?: unknown[];
  /** The exact version of the workflow these steps are; runs are credited per version. */
  version?: number;
  scope?: MemoryScope;
  taskId?: string;
  actorId?: string;
  taughtByUser?: boolean;
  verificationRefs?: string[];
}
export interface ProcedureRunInput {
  procedureId: string;
  version?: number;
  scope?: MemoryScope;
  taskId?: string;
  verified: boolean;
  verificationRefs?: string[];
  origin: ExecutionOrigin;
}
/** Independent verified runs before an inferred workflow is trusted without asking. */
const RUNS_TO_ACTIVATE = 3;

const withoutTask = (scope: MemoryScope = {}): MemoryScope => {
  const { taskId: _taskId, resourceIds: _resourceIds, ...shared } = scope;
  return shared;
};

function findByKey(key: string, layer: MemoryObject["layer"], scope: MemoryScope): MemoryObject | undefined {
  return memoryService.list(undefined, { layer, includeInactive: true })
    .find((item) => item.key === key && sameScope(item.scope, scope));
}

/** Store the active task as scoped working memory. This is intentionally short-lived. */
export function recordTaskStarted(input: { taskId: string; scope?: MemoryScope; goal: string; actorId: string; origin?: ExecutionOrigin; privateMode?: boolean }): void {
  if (input.privateMode || input.origin === "rehearsal" || input.origin === "replay" || input.origin === "test") return;
  memoryService.propose({
    id: `task-${input.taskId}`, layer: "working", kind: "task", key: `task:${input.taskId}`,
    summary: input.goal, scope: { ...input.scope, taskId: input.taskId }, status: "active",
    confidence: 1, confidenceBasis: "The user supplied this current task", importance: 1,
    source: { kind: "user", trust: "user_asserted", origin: "real", taskId: input.taskId, actorId: input.actorId, evidenceRefs: [`task:${input.taskId}`] },
    privacy: { sensitivity: "personal", modelAccess: "configured_providers", retentionPolicy: "task", trainingAllowed: false },
  });
}

/**
 * Convert completed task state into a compact episode. It deliberately never
 * promotes arbitrary model prose to a stable fact or procedure.
 */
export function consolidateTask(input: TaskConsolidationInput): MemoryObject | null {
  if (input.origin !== "real") return null;
  const state = taskCoordinator.get(input.taskId);
  const scope = withoutTask(input.scope ?? state?.scope ?? {});
  const verified = input.outcome === "verified_success" && input.verificationRefs.length > 0;
  const result = verified ? "completed with verification" : input.outcome.replace(/_/g, " ");
  const summary = state?.summary?.trim()
    ? `Task ${result}: ${input.goal}. Outcome: ${state.summary.trim()}`
    : `Task ${result}: ${input.goal}.`;
  const existing = findByKey(`episode:${input.taskId}`, "episodic", scope);
  const episode = memoryService.propose({
    id: existing?.id, layer: "episodic", kind: "task_outcome", key: `episode:${input.taskId}`,
    summary, scope, status: "active", importance: verified ? 0.7 : 0.4,
    confidence: verified ? 0.95 : input.outcome === "failed" ? 0.8 : 0.5,
    confidenceBasis: verified ? "Verified task postcondition evidence is attached" : "Task completion state was not fully verified",
    observedAt: new Date().toISOString(), lastVerifiedAt: verified ? new Date().toISOString() : undefined,
    expiresAt: input.outcome === "cancelled" ? new Date(Date.now() + 30 * 86_400_000).toISOString() : undefined,
    payload: { taskId: input.taskId, outcome: input.outcome, executionStatus: input.executionStatus, verificationRefs: [...new Set(input.verificationRefs)], attemptIds: [...new Set(input.attemptIds)] },
    source: { kind: "tool", trust: "observed", origin: "real", actorId: input.actorId, taskId: input.taskId, evidenceRefs: [...new Set(input.verificationRefs)], derivedFromIds: existing ? [existing.id] : [] },
    privacy: { sensitivity: "personal", modelAccess: "configured_providers", retentionPolicy: "episode", trainingAllowed: false },
  });
  const working = memoryService.get(`task-${input.taskId}`);
  if (working && working.status === "active") {
    memoryService.propose({ ...working, status: "superseded", validTo: new Date().toISOString(), source: { ...working.source, origin: "real" } });
  }
  return episode;
}

/** Aggregate tool reliability only from observable outcomes; unverified calls do not inflate reliability. */
export function noteToolOutcome(input: ToolOutcomeInput): MemoryObject | null {
  if (input.origin !== "real") return null;
  const scope = withoutTask(input.scope);
  const key = `tool:${input.tool}`;
  const prior = findByKey(key, "tool", scope);
  const previous = (prior?.payload ?? {}) as Record<string, unknown>;
  const count = (name: string) => Number(previous[name] ?? 0) || 0;
  const attempts = count("attempts") + 1;
  const verifiedSuccesses = count("verifiedSuccesses") + Number(input.verified && input.status === "success");
  const verifiedFailures = count("verifiedFailures") + Number(input.verified && input.status !== "success");
  const unverified = count("unverified") + Number(!input.verified);
  const verifiedAttempts = verifiedSuccesses + verifiedFailures;
  const failed = count("failed") + Number(input.status === "failed");
  const denied = count("denied") + Number(input.status === "denied");
  const uncertain = count("uncertain") + Number(input.status === "uncertain" || input.status === "timeout" || input.status === "partial");
  const durationTotal = count("durationTotalMs") + Math.max(0, Number(input.durationMs ?? 0));
  const reliability = verifiedAttempts ? verifiedSuccesses / verifiedAttempts : null;
  return memoryService.propose({
    id: prior?.id, layer: "tool", kind: "tool_health", key,
    summary: `${input.tool}: ${attempts} observed call${attempts === 1 ? "" : "s"}; ${verifiedAttempts ? `${Math.round((reliability ?? 0) * 100)}% verified success` : "no verified reliability sample"}.`,
    scope, status: "active", confidence: verifiedAttempts ? Math.min(0.95, 0.25 + verifiedAttempts / 20) : 0.2,
    confidenceBasis: verifiedAttempts ? `${verifiedAttempts} verified outcomes` : "Calls are unverified transport outcomes",
    observedAt: new Date().toISOString(), lastVerifiedAt: input.verified ? new Date().toISOString() : prior?.lastVerifiedAt,
    payload: { attempts, verifiedSuccesses, verifiedFailures, verifiedAttempts, unverified, failed, denied, uncertain, durationTotalMs: durationTotal, averageDurationMs: Math.round(durationTotal / attempts), reliability, lastStatus: input.status, lastErrorCategory: input.errorCategory ?? null, lastTaskId: input.taskId },
    source: { kind: "tool", trust: "observed", origin: "real", taskId: input.taskId, callId: input.callId, evidenceRefs: [`task:${input.taskId}:call:${input.callId}`], derivedFromIds: prior ? [prior.id] : [] },
    privacy: { sensitivity: "ordinary", modelAccess: "configured_providers", retentionPolicy: "tool_health", trainingAllowed: false },
  });
}

/** Record a user-taught workflow as a procedure; inferred workflows remain candidates. */
export function recordProcedure(input: ProcedureInput): MemoryObject | null {
  const scope = withoutTask(input.scope);
  const stable = input.procedureId ?? input.name.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  if (!stable) return null;
  const key = `procedure:${stable}`;
  const prior = findByKey(key, "procedural", scope);
  const userTaught = input.taughtByUser === true;
  return memoryService.propose({
    id: prior?.id, layer: "procedural", kind: "workflow", key, summary: input.description || input.name,
    scope, status: userTaught ? "active" : "candidate", confidence: userTaught ? 0.8 : 0.3,
    confidenceBasis: userTaught ? "User explicitly taught this workflow" : "Workflow requires independent verified runs before activation",
    payload: {
      procedureId: stable, name: input.name, version: input.version ?? Number(prior?.payload?.version ?? 1),
      steps: input.steps ?? (prior?.payload?.steps as unknown[] | undefined) ?? [],
      // A new version of the steps starts with no run history: crediting edited
      // steps with the old version's successes is how a broken workflow keeps
      // looking reliable.
      ...(input.version != null && prior && Number(prior.payload?.version ?? 1) !== input.version
        ? { demonstratedUsefulness: 0, verifiedRuns: 0, failedRuns: 0 }
        : { demonstratedUsefulness: prior?.payload?.demonstratedUsefulness ?? 0, verifiedRuns: prior?.payload?.verifiedRuns ?? 0, failedRuns: prior?.payload?.failedRuns ?? 0 }),
    },
    source: { kind: userTaught ? "user" : "inference", trust: userTaught ? "user_asserted" : "inferred", origin: "real", actorId: input.actorId, taskId: input.taskId, evidenceRefs: input.verificationRefs ?? [], derivedFromIds: prior ? [prior.id] : [] },
    privacy: { sensitivity: "personal", modelAccess: "configured_providers", retentionPolicy: "explicit", trainingAllowed: false },
  });
}

/**
 * Credit or debit one run of a stored workflow.
 *
 * Only a run whose outcome was actually verified counts towards trusting it,
 * and a run of a DIFFERENT version of the steps counts for nothing — those two
 * rules are what stop "it worked once" and "it used to work before I edited it"
 * from becoming "Echo can be relied on to do this".
 */
export function noteProcedureRun(input: ProcedureRunInput): MemoryObject | null {
  if (input.origin !== "real") return null;
  const scope = withoutTask(input.scope);
  const prior = findByKey(`procedure:${input.procedureId}`, "procedural", scope);
  if (!prior) return null;
  const payload = (prior.payload ?? {}) as Record<string, unknown>;
  const storedVersion = Number(payload.version ?? 1);
  if (input.version != null && input.version !== storedVersion) return null;
  const verifiedRuns = Number(payload.verifiedRuns ?? 0) + Number(input.verified);
  const failedRuns = Number(payload.failedRuns ?? 0) + Number(!input.verified);
  const taught = prior.source.trust === "user_asserted";
  // Usefulness is evidence that it finished the job, not that it was retrieved.
  const demonstratedUsefulness = verifiedRuns + failedRuns ? verifiedRuns / (verifiedRuns + failedRuns) : 0;
  const evidenceRefs = [...new Set([...prior.source.evidenceRefs, ...(input.verificationRefs ?? [])])];
  const lastVerifiedAt = input.verified ? new Date().toISOString() : prior.lastVerifiedAt;
  // Once runs carry it, the claim "this workflow works" rests on observed
  // verified outcomes rather than on Echo having inferred the workflow — so the
  // provenance changes to say that. Without evidence references it stays
  // inferred and stays a candidate, however many times it appeared to run: a
  // run nobody checked is not evidence that it worked.
  const supported = evidenceRefs.length > 0 && !!lastVerifiedAt;
  const active = taught || (verifiedRuns >= RUNS_TO_ACTIVATE && supported);
  return memoryService.propose({
    ...prior,
    status: active ? "active" : "candidate",
    confidence: taught ? 0.8 : Math.min(0.75, 0.2 + verifiedRuns * 0.15),
    confidenceBasis: taught
      ? "User explicitly taught this workflow"
      : supported
        ? `${verifiedRuns} verified run(s) of this exact version; ${RUNS_TO_ACTIVATE} are required before it is trusted unprompted`
        : `${verifiedRuns} run(s) recorded, none with verification evidence attached`,
    lastVerifiedAt,
    payload: { ...payload, verifiedRuns, failedRuns, demonstratedUsefulness },
    source: {
      ...prior.source, origin: "real", taskId: input.taskId ?? prior.source.taskId, evidenceRefs,
      ...(taught || !supported ? {} : { kind: "tool" as const, trust: "observed" as const }),
    },
  });
}
