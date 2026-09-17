import { randomUUID } from "node:crypto";
import { currentAgentRunContext } from "../agent-replay/context.js";
import { currentInvocation } from "../memory/invocation.js";
import { taskCoordinator } from "../memory/task-state.js";

export interface TaskHandoff<T> {
  id: string;
  taskId: string;
  createdAt: number;
  expiresAt: number;
  resourceVersion?: string;
  value: T;
}
export function owningTaskId(): string | undefined {
  return currentInvocation()?.taskId ?? currentAgentRunContext()?.taskId;
}
export function putHandoff<T>(kind: string, value: T, options: { taskId?: string; ttlMs?: number; resourceVersion?: string; now?: number } = {}): TaskHandoff<T> {
  const taskId = options.taskId ?? owningTaskId();
  if (!taskId) throw new Error("This operation requires an active task.");
  const now = options.now ?? Date.now();
  const item: TaskHandoff<T> = { id: `${kind}_${randomUUID()}`, taskId, createdAt: now,
    expiresAt: now + (options.ttlMs ?? 120_000), resourceVersion: options.resourceVersion, value: structuredClone(value) };
  taskCoordinator.bind(taskId, `handoff:${kind}`, item, currentInvocation() ?? undefined);
  return item;
}
export function readHandoff<T>(kind: string, options: { taskId?: string; id?: string; resourceVersion?: string; now?: number } = {}): TaskHandoff<T> | null {
  const taskId = options.taskId ?? owningTaskId();
  if (!taskId) return null;
  const item = taskCoordinator.lookup(taskId, `handoff:${kind}`) as TaskHandoff<T> | undefined;
  if (!item || item.taskId !== taskId || item.expiresAt <= (options.now ?? Date.now())) return null;
  if (options.id && item.id !== options.id) return null;
  if (options.resourceVersion && item.resourceVersion !== options.resourceVersion) return null;
  return structuredClone(item);
}
export function clearHandoff(kind: string, taskId = owningTaskId()): void {
  if (taskId) taskCoordinator.bind(taskId, `handoff:${kind}`, null, currentInvocation() ?? undefined);
}
