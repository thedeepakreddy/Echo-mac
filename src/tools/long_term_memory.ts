import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadRange } from "../frontier/history.js";
import { scrubSecrets } from "../safety/redact.js";
import { dataRoot, atomicWrite } from "../memory/paths.js";
import { captureAllowed, deletionEpoch } from "../memory/capture-policy.js";

export const EMBEDDING_MODEL = "nomic-embed-text";
export interface MemoryEntry {
  id: string; timestamp: number; text: string; contentHash: string;
  embedding?: number[]; model?: string; dimensions?: number; sourceVersion: number;
}
interface IndexFile { schemaVersion: 2; cursor: number; entries: MemoryEntry[] }
export interface MemoryIndexOptions {
  root?: string; batchSize?: number; embedding?: (text: string) => Promise<number[] | null>;
  model?: string; now?: number;
}
const flights = new Map<string, Promise<void>>();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const validVector = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every(n => typeof n === "number" && Number.isFinite(n));
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!validVector(a) || !validVector(b) || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const res = await fetch("http://localhost:11434/api/embeddings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }), signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return validVector(body.embedding) ? body.embedding : null;
  } catch { return null; }
}
function load(root: string): IndexFile {
  const file = join(root, "long_term_memory.json");
  if (!existsSync(file)) return { schemaVersion: 2, cursor: 0, entries: [] };
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
  const entries = rows.filter((r: any) => typeof r.timestamp === "number" && typeof r.text === "string").map((r: any) => {
    const text = scrubSecrets(r.text), contentHash = hash(text);
    return { ...r, text, id: r.id ?? hash(`${r.timestamp}:${contentHash}`), contentHash,
      sourceVersion: r.sourceVersion ?? 1,
      // Legacy vectors have unknown model provenance; lexical retrieval remains available.
      model: r.model, dimensions: r.dimensions ?? (validVector(r.embedding) ? r.embedding.length : undefined) } as MemoryEntry;
  });
  return { schemaVersion: 2, cursor: Number(raw?.cursor) || 0, entries };
}
/** One owner per index path. A durable cursor walks the oldest unprocessed rows, including outages. */
export function embedRecentMemory(options: MemoryIndexOptions = {}): Promise<void> {
  const root = options.root ?? dataRoot();
  const existing = flights.get(root); if (existing) return existing;
  const work = updateIndex(root, options).finally(() => { flights.delete(root); });
  flights.set(root, work); return work;
}
async function updateIndex(root: string, options: MemoryIndexOptions): Promise<void> {
  if (!captureAllowed()) return;
  const epoch = deletionEpoch(), index = load(root), model = options.model ?? EMBEDDING_MODEL;
  const batch = Math.max(1, Math.min(1000, options.batchSize ?? 100));
  const known = new Set(index.entries.map(r => r.id));
  const rows = loadRange(root, index.cursor).sort((a,b) => a.timestamp - b.timestamp);
  let accepted = 0;
  for (const row of rows) {
    const text = scrubSecrets(row.text), contentHash = hash(text), id = hash(`${row.timestamp}:${contentHash}`);
    if (known.has(id)) continue;
    if (accepted >= batch) break;
    index.cursor = Math.max(index.cursor, row.timestamp);
    if (!text.trim()) continue;
    index.entries.push({ id, timestamp: row.timestamp, text, contentHash, sourceVersion: 1 });
    known.add(id); accepted++;
  }
  // Embedding failure never loses the canonical lexical entry or blocks further ingestion.
  for (const entry of index.entries.filter(e => !e.embedding || e.model !== model).slice(0, Math.min(batch, 8))) {
    if (!captureAllowed() || deletionEpoch() !== epoch) return;
    const vector = await (options.embedding ?? getEmbedding)(entry.text);
    if (validVector(vector)) { entry.embedding = vector; entry.model = model; entry.dimensions = vector.length; }
  }
  if (!captureAllowed() || deletionEpoch() !== epoch) return;
  index.entries.sort((a,b) => a.timestamp - b.timestamp);
  index.entries = index.entries.slice(-1000);
  atomicWrite(join(root, "long_term_memory.json"), JSON.stringify(index));
}
const terms = (s: string) => [...new Set(s.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
export async function searchLongTermMemory(query: string, options: MemoryIndexOptions & { since?: number; until?: number; limit?: number } = {}): Promise<string> {
  let index: IndexFile;
  try { index = load(options.root ?? dataRoot()); } catch { return "The long-term memory index could not be read."; }
  if (!index.entries.length) return "Long-term memory is empty.";
  const q = terms(query); if (!q.length) return "Use a meaningful search phrase or an explicit time interval.";
  const vector = await (options.embedding ?? getEmbedding)(query), now = options.now ?? Date.now();
  const results = index.entries.filter(e => e.timestamp >= (options.since ?? 0) && e.timestamp <= (options.until ?? Infinity)).map(e => {
    const words = new Set(terms(e.text));
    const lexical = q.filter(t => words.has(t)).length / q.length;
    const semantic = vector && e.model === (options.model ?? EMBEDDING_MODEL) && e.dimensions === vector.length && e.embedding ? Math.max(0, cosineSimilarity(vector,e.embedding)) : 0;
    const relevant = lexical > 0 || semantic >= 0.55;
    const score = (semantic ? 0.65 * lexical + 0.35 * semantic : lexical) + 0.05 * Math.exp(-Math.max(0, now-e.timestamp)/(30*86400000));
    return { ...e, score, relevant, lexical, semantic };
  }).filter(e => e.relevant).sort((a,b) => b.score-a.score).slice(0, options.limit ?? 5);
  return results.length ? results.map(e => `[${e.id.slice(0,12)}] ${new Date(e.timestamp).toISOString()} · relevance ${e.score.toFixed(2)} · ${e.semantic ? "lexical + local vector" : "lexical"}\n${e.text}`).join("\n---\n") : "No relevant long-term memories matched that query and time range.";
}
