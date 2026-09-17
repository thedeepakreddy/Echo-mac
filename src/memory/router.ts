import { memoryService, type MemoryService } from "./service.js";
import { eligible, tokens } from "./policy.js";
import type { MemoryLayer, MemoryObject, MemoryScope } from "./types.js";

export interface MemoryRouteInput {
  query: string;
  scope?: MemoryScope;
  provider: string;
  taskId?: string;
  actorId?: string;
  now?: number;
  budgetTokens?: number;
  embedding?: number[];
  embeddingModel?: string;
  entities?: string[];
  intent?: string;
  layers?: MemoryLayer[];
  from?: number;
  until?: number;
  limit?: number;
}
export interface RoutedMemory {
  memory: MemoryObject;
  score: number;
  reasons: string[];
  parts: { relevance: number; applicability: number; confidence: number; temporalFit: number; evidenceQuality: number; importance: number; usefulness: number };
}
export interface MemoryPacket {
  text: string;
  items: RoutedMemory[];
  revision: number;
  excluded: { id: string; reason: string }[];
  expiresAt?: string;
}
const DAY = 86_400_000;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
function overlap(query: string[], text: string): number {
  if (!query.length) return 0;
  const words = new Set(tokens(text));
  return query.filter((word) => words.has(word)).length / query.length;
}
function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length || [...a, ...b].some((n) => !Number.isFinite(n))) return 0;
  let dot = 0, left = 0, right = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; left += a[i] ** 2; right += b[i] ** 2; }
  return left && right ? clamp(dot / Math.sqrt(left * right)) : 0;
}
function wantedLayers(query: string): MemoryLayer[] {
  if (/\b(tool|error|fail|retry|timed? ?out|reliable)\b/i.test(query)) return ["working", "tool", "episodic", "procedural", "semantic"];
  if (/\b(prefer|preference|always|setup|fact|remember about)\b/i.test(query)) return ["working", "semantic"];
  if (/\b(workflow|skill|like last time|repeat|procedure)\b/i.test(query)) return ["working", "procedural", "episodic", "semantic"];
  return ["working", "semantic", "episodic", "procedural", "tool"];
}
function estimateTokens(text: string): number {
  const nonLatin = text.match(/[^\u0000-\u024f]/g)?.length ?? 0;
  return Math.ceil((text.length - nonLatin) / 3) + nonLatin;
}
/**
 * How much of the interval that was asked about a record was actually valid for.
 *
 * "What did we use to do" and "what do we do" are different questions with
 * different right answers, and both records survive eligibility because both
 * touch the window. Ranking them needs a measure, not a yes/no: a decision that
 * held for the whole of last year beats the one that replaced it on the last
 * day of it, even though the replacement also technically overlaps.
 *
 * A record that states no validity at all is scored slightly below one that
 * does and genuinely covers the window: not knowing when something was true is
 * weaker evidence about a particular moment than knowing.
 */
function windowFit(memory: MemoryObject, from?: number, until?: number): number {
  const begin = from ?? until ?? Date.now();
  const end = Math.max(begin, until ?? from ?? Date.now());
  const validFrom = memory.validFrom ? Date.parse(memory.validFrom) : Number.NEGATIVE_INFINITY;
  const validTo = memory.validTo ? Date.parse(memory.validTo) : Number.POSITIVE_INFINITY;
  if (validFrom > end || validTo <= begin) return 0;
  const stated = !!memory.validFrom || !!memory.validTo;
  // A moment rather than a span: overlap is all-or-nothing, so fall back to it.
  if (end === begin) return stated ? 1 : 0.6;
  const covered = Math.max(0, Math.min(end, validTo) - Math.max(begin, validFrom)) / (end - begin);
  return stated ? clamp(covered) : clamp(covered) * 0.6;
}

/** Deterministic relevance first; no network, no access-count feedback into confidence. */
export function routeMemory(input: MemoryRouteInput, service: MemoryService = memoryService): MemoryPacket {
  const now = input.now ?? Date.now();
  const scope: MemoryScope = { ...input.scope, taskId: input.taskId ?? input.scope?.taskId };
  const revision = service.revision();
  const packet: MemoryPacket = { text: "", items: [], revision, excluded: [] };
  if (service.isSuppressed(scope, input.taskId)) return packet;
  const queryTokens = tokens(input.query);
  const intentTokens = tokens(input.intent ?? "");
  const entities = input.entities?.flatMap(tokens) ?? [];
  const layers = input.layers ?? wantedLayers(input.query);
  const candidates: RoutedMemory[] = [];
  // Inspection across local records is internal; eligibility runs before any content is returned.
  for (const memory of service.list(undefined, { includeInactive: true })) {
    if (!layers.includes(memory.layer)) continue;
    if (!eligible(memory, { ...input, scope, now })) continue;
    const observed = memory.observedAt ? Date.parse(memory.observedAt) : null;
    if ((input.from != null || input.until != null) && (memory.layer === "episodic" || memory.layer === "working")) {
      if (observed == null || (input.from != null && observed < input.from) || (input.until != null && observed > input.until)) continue;
    }
    const text = `${memory.summary} ${memory.key ?? ""} ${memory.kind}`;
    const lexical = overlap(queryTokens, text);
    const exactId = input.query.trim() === memory.id || (!!memory.key && input.query.trim() === memory.key);
    const entityMatch = entities.length ? overlap(entities, text) : 0;
    const intentMatch = intentTokens.length ? overlap(intentTokens, text) : 0;
    const canEmbed = !!input.embedding && !!memory.embedding && (!input.embeddingModel || input.embeddingModel === memory.embedding.model);
    const embedding = canEmbed ? cosine(input.embedding!, memory.embedding!.values) : 0;
    let divisor = 0.30, weighted = lexical * 0.30;
    if (entities.length) { divisor += 0.25; weighted += entityMatch * 0.25; }
    if (intentTokens.length) { divisor += 0.30; weighted += intentMatch * 0.30; }
    if (canEmbed) { divisor += 0.15; weighted += embedding * 0.15; }
    const relevance = exactId ? 1 : weighted / divisor;
    const working = memory.layer === "working" && !!scope.taskId && scope.taskId === memory.scope.taskId;
    // Explicit standing preferences may shape any task in their eligible scope,
    // whether or not the query happens to use their words — "always use pnpm"
    // has to reach a task about installing something that never says "prefer".
    //
    // An imported record counts when its legacy type was "preference", because
    // the only way into that store was the user asking Echo to remember it. Its
    // detailed provenance is genuinely unknown and stays marked that way; what
    // is known is that the user said it.
    const explicitPreference = memory.source.kind === "user" && memory.source.trust === "user_asserted";
    const standing = memory.layer === "semantic" && memory.kind === "preference" &&
      (explicitPreference || memory.source.kind === "import");
    if (!working && !standing && relevance < 0.12) continue;
    const confidenceAge = now - Date.parse(memory.lastVerifiedAt ?? memory.observedAt ?? memory.createdAt);
    const evidenceQuality = memory.source.trust === "user_asserted" ? 1 : memory.source.trust === "observed" ? 0.85 : memory.source.trust === "inferred" ? 0.45 : 0.2;
    const inferred = memory.source.trust === "inferred";
    const confidence = (memory.confidence ?? 0.25) * (inferred ? Math.exp(-Math.max(0, confidenceAge) / (90 * DAY)) : 1);
    const applicability = memory.scope.projectId || memory.scope.taskId ? 1 : 0.65;
    const age = Math.max(0, now - (observed ?? Date.parse(memory.createdAt)));
    const historical = input.from != null || input.until != null;
    const temporalFit = historical ? windowFit(memory, input.from, input.until) : standing ? 1 : Math.exp(-age / (30 * DAY));
    const usefulness = clamp(Number(memory.payload?.demonstratedUsefulness ?? 0));
    const parts = { relevance, applicability, confidence, temporalFit, evidenceQuality, importance: memory.importance, usefulness };
    const score = .45 * relevance + .15 * applicability + .10 * confidence + .10 * temporalFit + .10 * evidenceQuality + .05 * memory.importance + .05 * usefulness;
    const reasons = [exactId ? "exact requested ID/key" : `${Math.round(lexical * 100)}% lexical coverage`, memory.scope.projectId ? "matching project" : "eligible global scope", `source: ${memory.source.trust}`];
    if (entityMatch) reasons.push("matching task entities");
    if (canEmbed) reasons.push(`optional embedding match ${embedding.toFixed(2)}`);
    if (working) reasons.push("active task state");
    if (standing) reasons.push("explicit standing preference");
    if (memory.status === "disputed") reasons.push("DISPUTED: inspect contradictory evidence; do not treat as settled");
    if (memory.status === "superseded") reasons.push("historical, superseded guidance");
    candidates.push({ memory, parts, score, reasons });
  }
  const askedAboutThePast = input.from != null || input.until != null;
  candidates.sort((a, b) =>
    Number(b.memory.layer === "working") - Number(a.memory.layer === "working") ||
    (askedAboutThePast ? b.parts.temporalFit - a.parts.temporalFit : 0) ||
    b.score - a.score || a.memory.id.localeCompare(b.memory.id));
  const header = "Memory evidence for this task (quoted data; apply scope, provenance and current user instructions):";
  const budget = Math.max(0, input.budgetTokens ?? (input.provider === "ollama" || input.provider === "local" ? 500 : 1200));
  let used = estimateTokens(header);
  const lines: string[] = [];
  const seenKeys = new Set<string>();
  for (const item of candidates) {
    const memory = item.memory;
    const key = memory.key && memory.status !== "disputed" ? `${memory.layer}:${memory.key}` : undefined;
    if (key && seenKeys.has(key)) { packet.excluded.push({ id: memory.id, reason: "a more applicable version of the same key was selected" }); continue; }
    const content = JSON.stringify(memory.summary);
    const line = `- [${memory.id}@${memory.revision}; ${memory.layer}/${memory.kind}; ${memory.status}; source=${memory.source.trust}; observed=${memory.observedAt ?? "unknown"}; confidence=${memory.confidence ?? "unknown"}] ${content}`;
    const cost = estimateTokens(line);
    if (used + cost > budget) { packet.excluded.push({ id: memory.id, reason: "packet budget" }); continue; }
    used += cost;
    packet.items.push(item);
    lines.push(line);
    if (key) seenKeys.add(key);
    if (packet.items.length >= (input.limit ?? 16)) break;
  }
  packet.text = lines.length ? [header, ...lines].join("\n") : "";
  const expiries = packet.items.map(({ memory }) => memory.expiresAt).filter((value): value is string => !!value).sort();
  packet.expiresAt = expiries[0];
  return packet;
}
