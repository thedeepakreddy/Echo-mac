import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "../memory/paths.js";
import { captureAllowed } from "../memory/capture-policy.js";

/**
 * Episodic memory: what happened, when, and how much it mattered.
 *
 * The existing stores each answer a narrower question — memory/store.ts holds
 * facts someone chose to save, journal.ts holds actions and how to undo them,
 * trajectories hold training data. None of them rank. Ask any of them "what is
 * relevant right now" and you get everything, newest first, which is not the
 * same thing.
 *
 * What this adds is a SCORE. An episode competes on four axes — how recently it
 * happened, how well it matches the question, how important it was, and how
 * often it has proved worth retrieving — so the prompt can carry the ten things
 * that matter instead of the ten that are newest.
 *
 * Three design decisions worth knowing:
 *
 *   1. Append-only, with retrieval counted in a SEPARATE file. Scoring state
 *      changes every time a memory is read, and rewriting a growing log on
 *      every read would be both slow and unsafe while the app is running. The
 *      counts are folded back in at load, the same shape as store.ts's
 *      tombstones.
 *   2. Nothing is ever deleted. Old and unimportant memories sink; they do not
 *      disappear. A memory that stops being retrieved for a year is still there
 *      when the one question that needs it finally gets asked.
 *   3. Embeddings are optional. Semantic similarity improves ranking but
 *      requires Ollama, which is a standing 2.4GB. Without it this degrades to
 *      lexical overlap rather than failing.
 */

/**
 * Where the store lives. Resolved on every access, not once at module load.
 *
 * `JARVIS_EPISODIC_DIR` overrides it so a test never writes into the real
 * memory. Reading it lazily is the whole point: static imports are hoisted and
 * evaluated before any statement in the importing module, so a constant here
 * would be fixed to the real path before a test could ever set the variable —
 * which is exactly how a live test quietly filled the real store with its own
 * runs.
 */
function dir(): string {
  // Keep the narrow test override, but otherwise share Echo's user-data root.
  // This lets a portable/profiled installation move all mutable captures with
  // ECHO_DATA_ROOT instead of leaving a second, invisible store in $HOME.
  return process.env.JARVIS_EPISODIC_DIR?.trim() || join(dataRoot(), "episodic");
}
const EPISODES = () => join(dir(), "episodes.jsonl");
const ACCESS = () => join(dir(), "access.jsonl");
const FACTS = () => join(dir(), "facts.jsonl");

export type EpisodeKind =
  | "request"
  | "action"
  | "outcome"
  | "correction"
  | "observation";

export interface Episode {
  id: string;
  at: number;
  kind: EpisodeKind;
  text: string;
  project?: string;
  /** Links back to the trajectory turn, so an episode can be traced to its steps. */
  turn?: string;
  tool?: string;
  /** 0..1. Set by heuristic unless a caller knows better. */
  importance: number;
  /** How often this has been retrieved — rehearsal, which slows decay. */
  accessCount: number;
  lastAccessedAt: number;
  embedding?: number[];
}

export interface SemanticFact {
  id: string;
  text: string;
  kind: "preference" | "rule" | "entity" | "routine";
  /** How many distinct episodes support it. */
  support: number;
  confidence: number;
  firstSeen: number;
  lastSeen: number;
  sourceEpisodeIds: string[];
  project?: string;
}

// ---- tuning ---------------------------------------------------------------

/**
 * How long a memory of average importance takes to lose half its recency
 * weight. Two weeks: long enough that last week's work still surfaces, short
 * enough that a month-old one-off stops crowding the prompt.
 */
export const HALF_LIFE_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * How much importance stretches the half-life, and why it is squared.
 *
 * A linear multiplier could not satisfy both ends at once: raising it enough to
 * keep a correction findable after months also kept ambient noise alive for
 * weeks. Squaring separates them — at importance 0.15 the stretch is 1.2× (near
 * the base rate, so noise still sinks in a month), while at 0.9 it is 7.5×.
 * Only things that genuinely mattered get to persist.
 */
export const IMPORTANCE_STRETCH = 8;

/** What each axis contributes. They sum to 1 so a score is readable as 0..1. */
export const WEIGHTS = { recency: 0.3, relevance: 0.3, importance: 0.25, usage: 0.15 };

/** Consolidation needs repetition ACROSS days, not just within one session. */
export const CONSOLIDATE_MIN_SUPPORT = 3;
export const CONSOLIDATE_MIN_DAYS = 2;
/** Support at which a fact is fully trusted. */
export const CONFIDENCE_SATURATION = 8;

const id = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function ensure() {
  const d = dir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ---- importance -----------------------------------------------------------

/**
 * How much this is likely to matter later, from the shape of the event.
 *
 * Corrections and failures rank highest on purpose. The moments worth keeping
 * are the ones where what was expected and what happened came apart — a routine
 * success teaches nothing that the next routine success will not also teach.
 */
export function defaultImportance(kind: EpisodeKind, text: string): number {
  const t = (text ?? "").toLowerCase();

  if (/\b(remember|don'?t forget|from now on|always|never)\b/.test(t)) return 0.95;
  if (kind === "correction") return 0.9;
  if (/\b(no,|actually|that'?s wrong|undo|not what i|stop)\b/.test(t)) return 0.9;
  if (/\b(failed|error|refused|denied|couldn'?t|rejected)\b/.test(t)) return 0.75;

  switch (kind) {
    case "request": return 0.5;
    case "outcome": return 0.4;
    case "action": return 0.3;
    case "observation": return 0.15;
    default: return 0.3;
  }
}

// ---- reading and writing --------------------------------------------------

function parseJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      /* a torn final line is expected while the app is writing */
    }
  }
  return out;
}

/**
 * Every episode, with retrieval counts folded in.
 *
 * The counts live in their own file precisely so this is the only place that
 * has to know they are stored apart.
 */
export function allEpisodes(): Episode[] {
  const episodes = parseJsonl<Episode>(EPISODES());
  if (!episodes.length) return [];

  const hits = new Map<string, { n: number; last: number }>();
  for (const a of parseJsonl<{ id: string; at: number }>(ACCESS())) {
    const cur = hits.get(a.id);
    if (cur) {
      cur.n += 1;
      cur.last = Math.max(cur.last, a.at);
    } else {
      hits.set(a.id, { n: 1, last: a.at });
    }
  }

  for (const e of episodes) {
    const h = hits.get(e.id);
    // ADD to whatever the episode already carries rather than replacing it.
    // Compaction folds the access log into the episodes and then empties it, so
    // overwriting here reset every count to zero the moment it ran — a memory
    // that had proved useful fifty times would silently become unrehearsed.
    const base = typeof e.accessCount === "number" ? e.accessCount : 0;
    e.accessCount = base + (h?.n ?? 0);
    e.lastAccessedAt = Math.max(e.lastAccessedAt ?? e.at, h?.last ?? 0);
  }
  return episodes;
}

export interface RecordInput {
  kind: EpisodeKind;
  text: string;
  project?: string;
  turn?: string;
  tool?: string;
  /** Override the heuristic when the caller genuinely knows. */
  importance?: number;
  embedding?: number[];
}

/** Log an episode. Never throws — losing one must not disturb the assistant. */
export function record(input: RecordInput, now = Date.now()): Episode | null {
  // This module is retained only as a read/migration adapter while old data is
  // being brought into Memory OS. A private task must never revive its legacy
  // capture path through an overlooked caller.
  if (!captureAllowed()) return null;
  const text = (input.text ?? "").trim();
  if (!text) return null;

  const e: Episode = {
    id: id(),
    at: now,
    kind: input.kind,
    text: text.slice(0, 2000),
    project: input.project,
    turn: input.turn,
    tool: input.tool,
    importance:
      input.importance != null
        ? Math.max(0, Math.min(1, input.importance))
        : defaultImportance(input.kind, text),
    accessCount: 0,
    lastAccessedAt: now,
    embedding: input.embedding,
  };

  try {
    ensure();
    appendFileSync(EPISODES(), JSON.stringify(e) + "\n", "utf8");
  } catch (err) {
    console.error("[episodic] could not write:", (err as any)?.message ?? err);
    return null;
  }
  return e;
}

/** Note that these episodes were retrieved — rehearsal, which slows their decay. */
export function noteAccessed(ids: string[], now = Date.now()): void {
  if (!ids.length || !captureAllowed()) return;
  try {
    ensure();
    appendFileSync(
      ACCESS(),
      ids.map((i) => JSON.stringify({ id: i, at: now })).join("\n") + "\n",
      "utf8"
    );
  } catch {
    /* access counts are an optimisation, not a correctness requirement */
  }
}

// ---- scoring --------------------------------------------------------------

/**
 * How much of its recency weight an episode still has.
 *
 * Plain exponential decay would treat a passing observation and an explicit
 * correction identically, which is wrong: the correction should still be
 * findable months later. Two multipliers stretch the half-life —
 * importance, and rehearsal — so what mattered, and what keeps proving useful,
 * fades slowly while background noise sinks quickly.
 *
 * Simplification: ACT-R computes base-level activation as a power-law sum over
 * every individual rehearsal. This is exponential with a rehearsal multiplier —
 * the same monotonic shape, O(1) rather than O(rehearsals), and tunable by a
 * single number.
 */
export function recencyScore(e: Episode, now = Date.now()): number {
  const age = Math.max(0, now - e.at);
  const stretch =
    (1 + IMPORTANCE_STRETCH * e.importance * e.importance) *
    (1 + Math.log(1 + e.accessCount));
  // LN2 makes HALF_LIFE_MS mean what it says. Without it this is exp(-age/τ),
  // which loses 63% per period, not half — the constant would be a time
  // constant wearing a half-life's name, and every number tuned against it
  // would be off by a factor of ln2.
  return Math.exp((-Math.LN2 * age) / (HALF_LIFE_MS * stretch));
}

/** Diminishing credit for having been useful before. */
export function usageScore(e: Episode): number {
  return Math.min(1, Math.log(1 + e.accessCount) / Math.log(1 + 10));
}

const STOP = new Set([
  "the", "a", "an", "is", "are", "was", "were", "to", "of", "on", "in", "for",
  "and", "or", "that", "this", "it", "my", "me", "i", "you", "do", "did", "with",
]);

const words = (s: string) =>
  new Set(
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );

/** Lexical overlap, as a fraction of the query that the episode covers. */
export function lexicalScore(query: string, text: string): number {
  const q = words(query);
  if (!q.size) return 0;
  const t = words(text);
  let hit = 0;
  for (const w of q) if (t.has(w)) hit++;
  return hit / q.size;
}

export function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface Scored {
  episode: Episode;
  score: number;
  parts: { recency: number; relevance: number; importance: number; usage: number };
}

export interface RetrieveOptions {
  limit?: number;
  project?: string;
  /** Query embedding; when absent, relevance is lexical only. */
  embedding?: number[];
  /** Count these as retrieved, so they decay slower. Off for read-only inspection. */
  markAccessed?: boolean;
  now?: number;
}

/**
 * Rank episodes against a question.
 *
 * Relevance blends lexical overlap with cosine similarity when embeddings are
 * present on both sides. Blending rather than replacing matters: an exact word
 * match ("Brave") is a strong signal that a sentence embedding can wash out.
 */
export function retrieve(query: string, opts: RetrieveOptions = {}): Scored[] {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 8;

  let pool = allEpisodes();
  if (opts.project) pool = pool.filter((e) => !e.project || e.project === opts.project);
  if (!pool.length) return [];

  const scored: Scored[] = pool.map((e) => {
    const lex = lexicalScore(query, e.text);
    const sem =
      opts.embedding && e.embedding ? Math.max(0, cosine(opts.embedding, e.embedding)) : 0;
    const relevance = opts.embedding && e.embedding ? (lex + sem) / 2 : lex;

    const parts = {
      recency: recencyScore(e, now),
      relevance,
      importance: e.importance,
      usage: usageScore(e),
    };
    const score =
      WEIGHTS.recency * parts.recency +
      WEIGHTS.relevance * parts.relevance +
      WEIGHTS.importance * parts.importance +
      WEIGHTS.usage * parts.usage;
    return { episode: e, score, parts };
  });

  scored.sort((a, b) => b.score - a.score || b.episode.at - a.episode.at);
  const top = scored.slice(0, limit);

  if (opts.markAccessed !== false && top.length) {
    noteAccessed(top.map((s) => s.episode.id), now);
  }
  return top;
}

// ---- consolidation --------------------------------------------------------

/**
 * Reduce an episode to what makes it "the same thing happening again".
 *
 * Numbers, paths and quoted strings are the parts that vary between two runs of
 * the same intent, so they are dropped. What is left is the shape of the event.
 */
export function signature(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/["'`][^"'`]*["'`]/g, " ")
    .replace(/\/[^\s]+/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 8)
    .join(" ")
    .trim();
}

const dayOf = (t: number) => Math.floor(t / 86_400_000);

function factKind(text: string): SemanticFact["kind"] {
  const t = text.toLowerCase();
  if (/\b(prefer|always|never|instead of|rather than|don'?t)\b/.test(t)) return "preference";
  if (/\b(when|if|before|after)\b/.test(t)) return "rule";
  if (/\b(open|run|check|start|build|deploy)\b/.test(t)) return "routine";
  return "entity";
}

export interface ConsolidationResult {
  promoted: SemanticFact[];
  examined: number;
  groups: number;
}

/**
 * Find what keeps happening and promote it to a standing fact.
 *
 * The across-days rule is the important one. Three occurrences inside a single
 * session is usually one task being repeated — a person retrying something —
 * not a standing preference. Requiring two distinct days is what separates
 * "Deepak uses Brave" from "Deepak fought with Brave for an hour on Tuesday".
 *
 * Simplification: this is LEXICAL. It detects that something recurs, not that
 * two facts imply a third. Real consolidation would generalise across episodes
 * ("prefers Brave" + "prefers Firefox" -> "avoids Chrome"); this will not.
 */
export function consolidate(
  episodes: Episode[] = allEpisodes(),
  now = Date.now()
): ConsolidationResult {
  const groups = new Map<string, Episode[]>();
  for (const e of episodes) {
    // Observations are ambient noise; promoting them would fill the fact store
    // with whatever happened to be on screen.
    if (e.kind === "observation") continue;
    const sig = signature(e.text);
    if (!sig || sig.split(" ").length < 2) continue;
    const g = groups.get(sig);
    if (g) g.push(e);
    else groups.set(sig, [e]);
  }

  const existing = allFacts();
  const known = new Set(existing.map((f) => signature(f.text)));
  const promoted: SemanticFact[] = [];

  for (const [sig, members] of groups) {
    if (members.length < CONSOLIDATE_MIN_SUPPORT) continue;
    const days = new Set(members.map((m) => dayOf(m.at)));
    if (days.size < CONSOLIDATE_MIN_DAYS) continue;
    if (known.has(sig)) continue;

    const sorted = [...members].sort((a, b) => a.at - b.at);
    // The longest phrasing is usually the most explicit one the user gave.
    const best = [...members].sort((a, b) => b.text.length - a.text.length)[0];
    const lastSeen = sorted[sorted.length - 1].at;

    // Confidence grows with support, then fades if it stops recurring — a
    // preference that has not shown up in months may simply have changed.
    const base = Math.min(1, members.length / CONFIDENCE_SATURATION);
    const staleness = Math.exp(-(now - lastSeen) / (HALF_LIFE_MS * 4));
    promoted.push({
      id: id(),
      text: best.text.slice(0, 300),
      kind: factKind(best.text),
      support: members.length,
      confidence: Math.max(0, Math.min(1, base * staleness)),
      firstSeen: sorted[0].at,
      lastSeen,
      sourceEpisodeIds: members.slice(0, 20).map((m) => m.id),
      project: best.project,
    });
  }

  if (promoted.length) {
    try {
      ensure();
      appendFileSync(FACTS(), promoted.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");
    } catch (err) {
      console.error("[episodic] could not save facts:", (err as any)?.message ?? err);
    }
  }
  return { promoted, examined: episodes.length, groups: groups.size };
}

export function allFacts(): SemanticFact[] {
  return parseJsonl<SemanticFact>(FACTS());
}

// ---- bridge to the prompt -------------------------------------------------

/**
 * Consolidated facts, rendered for the system prompt.
 *
 * Deliberately a SEPARATE block from memory/store.ts's "What you remember".
 * Those are things someone chose to save; these were inferred from repetition,
 * and the model should be able to tell the difference — an inferred rule that
 * is wrong should be easier to override than one the user stated outright.
 * Only confident facts appear, so a coincidence seen three times does not get
 * presented as a standing rule.
 */
export function factsForPrompt(minConfidence = 0.35, budget = 900): string {
  const facts = allFacts()
    .filter((f) => f.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence);
  if (!facts.length) return "";

  const lines: string[] = [];
  let used = 0;
  for (const f of facts) {
    const l = `- (${f.kind}, seen ${f.support}×) ${f.text}`;
    if (used + l.length + 1 > budget) break;
    lines.push(l);
    used += l.length + 1;
  }
  if (!lines.length) return "";

  return [
    "## Patterns I have noticed",
    "",
    "Inferred from things that kept recurring, not stated outright — so treat",
    "them as likely rather than certain, and drop one if the user contradicts it.",
    "",
    ...lines,
  ].join("\n");
}

// ---- housekeeping ---------------------------------------------------------

export interface EpisodicStats {
  episodes: number;
  facts: number;
  accessRecords: number;
  oldest?: number;
  dir: string;
}

export function stats(): EpisodicStats {
  const eps = parseJsonl<Episode>(EPISODES());
  return {
    episodes: eps.length,
    facts: allFacts().length,
    accessRecords: parseJsonl<unknown>(ACCESS()).length,
    oldest: eps.length ? Math.min(...eps.map((e) => e.at)) : undefined,
    dir: dir(),
  };
}

/**
 * Fold access counts into the episode log and start the access file over.
 *
 * The access log grows one line per retrieval and is pure overhead once folded
 * in. Nothing is lost: the counts survive on the episodes themselves.
 */
export function compact(): void {
  const eps = allEpisodes();
  if (!eps.length) return;
  ensure();
  writeFileSync(EPISODES(), eps.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  writeFileSync(ACCESS(), "", "utf8");
}

/** Wipe everything. Tests only — there is no user-facing path to this. */
export function _resetForTests(): void {
  ensure();
  writeFileSync(EPISODES(), "", "utf8");
  writeFileSync(ACCESS(), "", "utf8");
  writeFileSync(FACTS(), "", "utf8");
}

/** The resolved store path. A function, because the override is read lazily. */
export const episodicDir = dir;
