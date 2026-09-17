import { forgetEverywhere } from "./deletion.js";
import { scopeMatches } from "./policy.js";
import { routeMemory } from "./router.js";
import { memoryService } from "./service.js";
import type { MemoryObject, MemoryScope } from "./types.js";

/**
 * Explicit local commands that never need to be sent through a model.  The
 * narrow slash grammar matters for deletion: a conversational use of the word
 * "forget" must not become a destructive request by accident.
 */
export const isMemoryCommand = (text: string): boolean => /^\/(?:memory|task)\b/i.test(text.trim());

export interface MemoryCommandContext {
  scope: MemoryScope;
  appRoot?: string;
}

const when = (value?: string | null) => value ? new Date(value).toLocaleString() : "not recorded";
const confidence = (value: number | null) => value == null ? "unscored" : `${Math.round(value * 100)}%`;
const withoutTask = (scope: MemoryScope): MemoryScope => {
  const { taskId: _taskId, ...base } = scope;
  return base;
};

function describe(memory: MemoryObject): string {
  return `${memory.id} · ${memory.layer}/${memory.kind} · ${memory.status} · ${confidence(memory.confidence)} · ${memory.source.kind}/${memory.source.trust} · ${when(memory.observedAt ?? memory.createdAt)}\n${memory.summary}`;
}

function status(scope: MemoryScope): string {
  const memories = memoryService.list(scope, { includeInactive: true });
  const byLayer = new Map<string, number>();
  for (const memory of memories) byLayer.set(memory.layer, (byLayer.get(memory.layer) ?? 0) + 1);
  const layers = [...byLayer.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([layer, count]) => `${layer}: ${count}`).join(", ");
  return `Memory OS has ${memories.length} record${memories.length === 1 ? "" : "s"} in this scope${layers ? ` (${layers})` : ""}. Revision ${memoryService.revision()}.\n\nCommands: /memory inspect [query], /memory why <id>, /memory forget id <id>, /memory forget <all terms>, /memory forget task <task-id>.`;
}

/**
 * A local `/task status` command is an inspection view over the current
 * project/workspace, so it may enumerate task-scoped working records. Normal
 * memory retrieval keeps its stricter exact-task matching in `scopeMatches`.
 */
function taskRecords(scope: MemoryScope): MemoryObject[] {
  const requestedTaskId = scope.taskId;
  const baseScope = withoutTask(scope);
  return memoryService.list(undefined, { layer: "working", includeInactive: true }).filter((memory) => {
    if (requestedTaskId) return scopeMatches(memory.scope, scope);
    return scopeMatches(withoutTask(memory.scope), baseScope);
  });
}

/**
 * Execute an explicit inspection/deletion command locally.  Returned text is
 * safe to display to the local user; it deliberately omits payloads and any
 * deleted content from deletion receipts.
 */
export function executeMemoryCommand(raw: string, context: MemoryCommandContext): string | null {
  const text = raw.trim();
  const match = /^\/(memory|task)\b\s*(.*)$/i.exec(text);
  if (!match) return null;
  const namespace = match[1].toLowerCase();
  const rest = match[2].trim();

  if (namespace === "task") {
    if (!rest || /^status$/i.test(rest)) {
      const tasks = taskRecords(context.scope);
      if (!tasks.length) return "There is no saved task state in this scope.";
      return `Saved task records:\n\n${tasks.slice(-12).map(describe).join("\n\n")}`;
    }
    return "Task commands currently support /task status. Use /memory forget task <task-id> to remove a task and its linked local memory.";
  }

  if (!rest || /^status$/i.test(rest) || /^help$/i.test(rest)) return status(context.scope);

  const why = /^why\s+([^\s]+)$/i.exec(rest);
  if (why) {
    const memory = memoryService.list(context.scope, { includeInactive: true }).find((item) => item.id === why[1]);
    if (!memory) return "That memory is not available in the current scope.";
    const source = `${memory.source.kind}/${memory.source.trust}, origin=${memory.source.origin}`;
    const links = [
      memory.supersedesIds.length ? `supersedes ${memory.supersedesIds.join(", ")}` : "",
      memory.contradictsIds.length ? `contradicts ${memory.contradictsIds.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    return `${describe(memory)}\n\nProvenance: ${source}. Created ${when(memory.createdAt)}. ${memory.lastVerifiedAt ? `Last verified ${when(memory.lastVerifiedAt)}.` : "It has not been independently verified."}${links ? ` ${links}.` : ""} Privacy: ${memory.privacy.modelAccess}, ${memory.privacy.retentionPolicy}.`;
  }

  const forgetTask = /^forget\s+task\s+([^\s]+)$/i.exec(rest);
  if (forgetTask) {
    const receipt = forgetEverywhere({ taskId: forgetTask[1], scope: context.scope, appRoot: context.appRoot });
    return receipt.count
      ? `Forgot ${receipt.count} linked memory record${receipt.count === 1 ? "" : "s"} and removed the local task state. Receipt ${receipt.id}.`
      : "No matching memory record was found. Any matching local task state was removed if it existed.";
  }

  const forgetId = /^forget\s+id\s+([^\s]+)$/i.exec(rest);
  if (forgetId) {
    const receipt = forgetEverywhere({ ids: [forgetId[1]], scope: context.scope, appRoot: context.appRoot });
    return receipt.count
      ? `Forgot ${receipt.count} memory record${receipt.count === 1 ? "" : "s"}. Receipt ${receipt.id}.`
      : "That memory is not available in the current scope.";
  }

  const forgetQuery = /^forget\s+(.+)$/i.exec(rest);
  if (forgetQuery) {
    const query = forgetQuery[1].trim();
    if (!query) return "Specify an ID, task ID, or all of the words that identify the memory to forget.";
    const receipt = forgetEverywhere({ query, scope: context.scope, appRoot: context.appRoot });
    return receipt.count
      ? `Forgot ${receipt.count} matching memory record${receipt.count === 1 ? "" : "s"}. Receipt ${receipt.id}.`
      : "No matching memory was found in the current scope. Forgetting requires every query term to match.";
  }

  const inspect = /^(?:inspect\s*)?(.*)$/i.exec(rest)?.[1]?.trim() ?? "";
  if (!inspect || /^all$/i.test(inspect)) {
    const memories = memoryService.list(context.scope, { includeInactive: true });
    if (!memories.length) return "There are no saved memories in the current scope.";
    return `Saved memories (newest first):\n\n${memories.slice(-12).reverse().map(describe).join("\n\n")}`;
  }
  const routed = routeMemory({ query: inspect, scope: context.scope, provider: "local", budgetTokens: 1_800, limit: 12 });
  if (!routed.items.length) return "No eligible memory matched that query in the current scope.";
  return `Relevant memories:\n\n${routed.items.map(({ memory, score, reasons }) => `${describe(memory)}\nRelevance ${Math.round(score * 100)}%: ${reasons.join(", ")}`).join("\n\n")}`;
}
