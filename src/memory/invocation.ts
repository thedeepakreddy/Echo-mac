import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { taskCoordinator, type TaskInvocation } from "./task-state.js";
export type InvocationContext = TaskInvocation;
const storage = new AsyncLocalStorage<InvocationContext>();
export const currentInvocation = (): InvocationContext | null => storage.getStore() ?? null;
export const runInInvocation = <T>(context: InvocationContext, action: () => T): T => storage.run(context, action);
export function createInvocation(taskId: string, actorId: string, tool: string, args: Record<string, unknown> = {}, workingDir = process.cwd(), callId = randomUUID()): InvocationContext {
  const task = taskCoordinator.get(taskId); if (!task) throw new Error("Tool invocation requires a task");
  const resources: string[] = [];
  // A resource is something this call needs EXCLUSIVELY. Driving the pointer or
  // the keyboard is exclusive: two of those at once interleave into nonsense.
  // Looking at the screen is not — and lumping the two together meant Echo could
  // never observe two things at once, so a batch of independent reads had to be
  // taken one after another even though none of them touched anything.
  if (/^(click.*|type_text|press_keys|scroll|drag|move_mouse|open_app|open_url|run_shortcut|move_window_to_display|show_translation)$/.test(tool)) {
    resources.push("desktop:input");
  }
  if (tool === "write_local_file" && typeof args.path === "string") resources.push(`file:${resolve(workingDir, args.path)}`);
  if (tool === "run_terminal_command") resources.push(`workspace:${resolve(String(args.cwd ?? workingDir))}`);
  return Object.freeze({ taskId, actorId, callId, stepId: `tool:${tool}`, generation: task.generation, baseRevision: task.revision, resources: Object.freeze(resources) });
}
