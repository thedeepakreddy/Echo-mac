import { all, search, GLOBAL, type MemoryRecord } from "./store.js";

/**
 * Chooses which memories are worth putting in front of the model.
 *
 * Everything cannot go in — the record grows without bound while the prompt
 * budget does not. Preferences come first because they change how Jarvis should
 * behave in every reply; project history follows, newest first, because older
 * episodes are usually superseded by newer ones.
 */
const DEFAULT_BUDGET = 1800; // characters

function line(r: MemoryRecord): string {
  const when = r.at.slice(0, 10);
  const scope = r.project && r.project !== GLOBAL ? ` [${r.project}]` : "";
  return `- (${r.type}${scope}, ${when}) ${r.text}`;
}

/**
 * Build the memory block for the system prompt.
 * Returns "" when there is nothing worth saying, so the prompt stays clean on
 * a first run.
 */
export function recallForPrompt(project?: string, budget = DEFAULT_BUDGET): string {
  const live = all();
  if (!live.length) return "";

  const prefs = live.filter((r) => r.type === "preference");
  const scoped = live
    .filter((r) => r.type !== "preference")
    .filter((r) => !project || r.project === project || r.project === GLOBAL);

  // Preferences oldest-first (they read as standing rules); history newest-first.
  const chosen: MemoryRecord[] = [];
  let used = 0;
  const add = (r: MemoryRecord) => {
    const cost = line(r).length + 1;
    if (used + cost > budget) return false;
    chosen.push(r);
    used += cost;
    return true;
  };

  for (const r of prefs) if (!add(r)) break;
  for (const r of [...scoped].reverse()) if (!add(r)) break;

  if (!chosen.length) return "";

  const header = project && project !== GLOBAL ? `Working context: ${project}.` : "";
  return [
    "## What you remember",
    "",
    "From earlier sessions with this user. Treat preferences as standing instructions.",
    header,
    "",
    ...chosen.map(line),
    "",
    'If something here is now wrong, say so and use the forget tool rather than acting on it.',
  ]
    .filter((s) => s !== undefined)
    .join("\n");
}

/** Formatted answer for the recall tool. */
export function recallQuery(query: string, project?: string, limit = 8): string {
  const hits = query.trim() ? search(query, { project, limit }) : all().slice(-limit).reverse();
  if (!hits.length) return query.trim() ? `Nothing remembered about "${query}".` : "Nothing remembered yet.";
  return hits.map(line).join("\n");
}
