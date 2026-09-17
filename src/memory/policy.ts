import { createHash } from "node:crypto";
import { looksSecret, scrubSecrets } from "../safety/redact.js";
import type { MemoryInput, MemoryObject, MemoryScope, SuppressionRule } from "./types.js";

const STOP = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "do", "did", "for", "from", "i", "in", "is", "it", "me", "my", "of", "on", "or", "the", "to", "was", "what", "with", "you", "your", "remember", "forget"]);
export function tokens(text: string): string[] {
  return [...new Set((text ?? "").normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])]
    .filter((word) => word.length > 1 && !STOP.has(word));
}
export function contentHash(text: string): string {
  return createHash("sha256").update(text.normalize("NFKC").trim().toLowerCase()).digest("hex");
}
export function normalizedScope(scope: MemoryScope = {}): MemoryScope {
  return {
    ...scope,
    principalId: scope.principalId || "local-user",
    projectId: scope.projectId && scope.projectId !== "global" ? scope.projectId : undefined,
    resourceIds: scope.resourceIds ? [...new Set(scope.resourceIds)].sort() : undefined,
    allowedActors: scope.allowedActors ? [...new Set(scope.allowedActors)].sort() : undefined,
  };
}
/** Missing scope never authorizes a project/task-specific record. */
export function scopeMatches(record: MemoryScope, requested: MemoryScope = {}, actorId?: string): boolean {
  const a = normalizedScope(record), b = normalizedScope(requested);
  if (a.principalId !== b.principalId) return false;
  if (a.workspaceId && a.workspaceId !== b.workspaceId) return false;
  if (a.projectId && a.projectId !== b.projectId) return false;
  if (a.taskId && a.taskId !== b.taskId) return false;
  if (a.allowedActors?.length && (!actorId || !a.allowedActors.includes(actorId))) return false;
  if (a.resourceIds?.length && !a.resourceIds.some((id) => b.resourceIds?.includes(id))) return false;
  return true;
}
export function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  return JSON.stringify(normalizedScope(a)) === JSON.stringify(normalizedScope(b));
}
/** Deletion matching is deliberately all-content-terms, with no recency fallback. */
export function matchesQuery(query: string, text: string): boolean {
  const needle = tokens(query);
  const hay = new Set(tokens(text));
  return needle.length > 0 && needle.every((word) => hay.has(word));
}
/** Apply scrubbing recursively, including provenance, nested tool args and arrays. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[omitted: nesting limit]";
  if (typeof value === "string") return scrubSecrets(value).slice(0, 50_000);
  if (Array.isArray(value)) return value.slice(0, 2000).map((item) => scrubValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 2000)) {
      if (/password|passcode|api.?key|access.?token|refresh.?token|authorization|credential|private.?key|secret|cvv/i.test(key)) out[key] = "[redacted]";
      else out[scrubSecrets(key)] = scrubValue(item, depth + 1);
    }
    return out;
  }
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}
export function suppressionMatches(rule: SuppressionRule, scope: MemoryScope, taskId?: string): boolean {
  if (!rule.enabled || (rule.taskId && rule.taskId !== taskId && rule.taskId !== scope.taskId)) return false;
  return scopeMatches({ ...rule.scope, allowedActors: undefined }, { ...scope, taskId: taskId ?? scope.taskId });
}
export function writePolicy(input: MemoryInput): { allowed: boolean; reason?: string; input: MemoryInput } {
  if (!input.summary?.trim()) return { allowed: false, reason: "empty memory", input };
  if (input.source?.origin && input.source.origin !== "real") return { allowed: false, reason: "simulated evidence is not durable user memory", input };
  const clean = scrubValue(input) as MemoryInput;
  // Identifiers are inert references: preserve exactly for deterministic lineage/deletion.
  clean.id = input.id;
  clean.scope = normalizedScope(input.scope);
  clean.source = { ...clean.source, derivedFromIds: input.source?.derivedFromIds ?? [], evidenceRefs: (input.source?.evidenceRefs ?? []).map(scrubSecrets) };
  const userAsserted = input.source?.kind === "user" && input.source.trust === "user_asserted";
  const observed = input.source?.kind === "tool" && input.source.trust === "observed" && !!input.lastVerifiedAt && !!input.source.evidenceRefs?.length;
  if ((input.layer === "semantic" || input.layer === "procedural") && !userAsserted && !observed && input.source?.kind !== "import") {
    if (!input.status || input.status === "active") clean.status = "candidate";
  }
  if (input.source?.kind === "document") {
    clean.source.trust = "external";
    if (input.layer === "semantic" || input.layer === "procedural") clean.status = "candidate";
  }
  // Where a memory may GO, decided from where it came from rather than left to
  // the caller. Echo has always put what the user told it into the prompt, and
  // a brain that cannot see its own memory is not remembering anything — so
  // what the user said, and what Echo observed doing their task, is shareable
  // with whichever brain is answering. What Echo merely READ — a page, a scan,
  // OCR of the screen — is not: the user never chose to send that anywhere, and
  // §10 of the design is explicit that a document is evidence, not a preference.
  const external = input.source?.kind === "document" || input.source?.trust === "external";
  clean.privacy = {
    sensitivity: "personal",
    modelAccess: external ? "local_only" : "configured_providers",
    retentionPolicy: input.layer === "working" ? "task" : "explicit",
    trainingAllowed: false,
    ...clean.privacy,
  };
  if (external) clean.privacy.modelAccess = "local_only";
  if (clean.privacy.sensitivity === "sensitive") { clean.privacy.modelAccess = "local_only"; clean.privacy.trainingAllowed = false; }
  // A memory that CONTAINED a credential stays sensitive even though the value
  // itself has been masked. Checked against the original text, not the scrubbed
  // copy: scrubbing the scrubbed version changes nothing, so asking it there
  // would always answer no and the flag could never fire.
  if (looksSecret(input.summary)) { clean.privacy.sensitivity = "sensitive"; clean.privacy.modelAccess = "local_only"; clean.privacy.trainingAllowed = false; }
  return { allowed: true, input: clean };
}
export function eligible(memory: MemoryObject, options: { scope?: MemoryScope; actorId?: string; provider?: string; now?: number; from?: number; until?: number }): boolean {
  if (!scopeMatches(memory.scope, options.scope, options.actorId)) return false;
  if (memory.source.origin !== "real" || memory.status === "deleted" || memory.status === "candidate") return false;
  const historical = options.from != null || options.until != null;
  if (!historical && (memory.status === "expired" || memory.status === "superseded")) return false;
  if (memory.privacy.modelAccess === "local_only" && !["local", "ollama", "deepakllm"].includes(options.provider ?? "cloud")) return false;
  const now = options.now ?? Date.now();
  if (memory.expiresAt && Date.parse(memory.expiresAt) <= now) return false;
  const begin = options.from ?? now, end = options.until ?? now;
  if (memory.validFrom && Date.parse(memory.validFrom) > end) return false;
  if (memory.validTo && Date.parse(memory.validTo) <= begin) return false;
  return true;
}
