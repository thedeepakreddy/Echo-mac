import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Step } from "./demonstrate.js";

const REFLEX_DIR = join(homedir(), ".jarvis", "reflex");
const REFLEX_FILE = join(REFLEX_DIR, "cache.json");

export interface ReflexEntry {
  query: string;
  steps: Step[];
  createdAt: number;
  successes: number;
}

function ensure() {
  if (!existsSync(REFLEX_DIR)) mkdirSync(REFLEX_DIR, { recursive: true });
}

export function loadCache(): Record<string, ReflexEntry> {
  if (!existsSync(REFLEX_FILE)) return {};
  try {
    return JSON.parse(readFileSync(REFLEX_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveCache(cache: Record<string, ReflexEntry>) {
  ensure();
  writeFileSync(REFLEX_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Normalise a query so that "open youtube" and "open  youtube!" match.
 */
function norm(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Searches the reflex cache for an exact (normalized) semantic match.
 */
export function matchReflex(query: string): ReflexEntry | null {
  const cache = loadCache();
  const nq = norm(query);
  
  for (const key in cache) {
    if (norm(key) === nq) {
      return cache[key];
    }
  }
  return null;
}

/**
 * Saves a successful autonomous workflow into the Reflex cache so it can be executed instantly next time.
 */
export function saveReflex(query: string, steps: Step[]) {
  const cache = loadCache();
  const nq = norm(query);
  
  // Find if it already exists to increment success count
  let existingKey = Object.keys(cache).find(k => norm(k) === nq);
  
  if (existingKey) {
    cache[existingKey].steps = steps; // overwrite with newest optimal path
    cache[existingKey].successes += 1;
    cache[existingKey].createdAt = Date.now();
  } else {
    cache[query] = {
      query,
      steps,
      createdAt: Date.now(),
      successes: 1
    };
  }
  saveCache(cache);
}
