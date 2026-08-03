import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAppPath } from "../utils/appPath.js";
import { loadRecent } from "../frontier/history.js";
import { scrubSecrets } from "../safety/redact.js";

interface MemoryEntry {
  /** Epoch milliseconds. Declared as a string here, which it never was. */
  timestamp: number;
  text: string;
  embedding: number[];
}

// Simple cosine similarity
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const res = await fetch("http://localhost:11434/api/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", prompt: text })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.embedding;
  } catch {
    return null; // Ollama not running or model missing
  }
}

export async function embedRecentMemory() {
  const dbPath = join(getAppPath(), "long_term_memory.json");

  let memoryDB: MemoryEntry[] = [];
  if (existsSync(dbPath)) {
    try {
      memoryDB = JSON.parse(readFileSync(dbPath, "utf8"));
    } catch { }
  }

  // We only want to embed new rows. Take the last 10 and skip any already
  // stored, matched by timestamp.
  const recent = loadRecent(getAppPath(), 10);
  if (!recent.length) return;

  for (const row of recent) {
    const exists = memoryDB.find(m => m.timestamp === row.timestamp);
    // Scrub before embedding: the source history is already scrubbed, but this
    // also covers any older rows written before scrubbing existed, so a secret
    // never makes it into the long-term embeddings.
    const text = scrubSecrets(row.text);
    if (!exists && text) {
      const embedding = await getEmbedding(text);
      if (embedding) {
        memoryDB.push({ timestamp: row.timestamp, text, embedding });
      }
    }
  }
  
  // Keep DB size manageable for a simple JSON file (e.g., 1000 entries)
  if (memoryDB.length > 1000) memoryDB = memoryDB.slice(-1000);
  
  writeFileSync(dbPath, JSON.stringify(memoryDB), "utf8");
}

export async function searchLongTermMemory(query: string): Promise<string> {
  const dbPath = join(getAppPath(), "long_term_memory.json");
  if (!existsSync(dbPath)) return "No long term memory database found.";
  
  const queryEmbedding = await getEmbedding(query);
  if (!queryEmbedding) return "Could not generate query embedding. Ensure Ollama is running with 'nomic-embed-text'.";
  
  let memoryDB: MemoryEntry[] = [];
  try {
    memoryDB = JSON.parse(readFileSync(dbPath, "utf8"));
  } catch {
    return "Long term memory database is corrupted or empty.";
  }
  
  if (memoryDB.length === 0) return "Long term memory is empty.";
  
  // Rank by similarity
  const results = memoryDB.map(entry => ({
    ...entry,
    score: cosineSimilarity(queryEmbedding, entry.embedding)
  })).sort((a, b) => b.score - a.score);
  
  // Return top 5 results
  const top = results.slice(0, 5);
  return top.map(r => `[Score: ${r.score.toFixed(2)}] [${r.timestamp}] ${r.text}`).join("\n---\n");
}
