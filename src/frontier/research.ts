import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Looking things up while you sleep.
 *
 * This reuses the discipline the idle rehearsal already worked out — only when
 * genuinely away, a hard ceiling on how long, and a teardown that actually
 * stops the agent when you come back — but points it somewhere far safer.
 * Rehearsal drives the mouse around your machine; this reads the web and
 * writes a file. Nothing it does touches your applications.
 *
 * Two rules keep it from being a way to quietly spend money:
 *
 *   - Nothing is researched unless you asked for it by name. There is no
 *     "it noticed you seemed interested in X". An empty queue means an idle
 *     night, which is the correct default.
 *   - There is a nightly budget, and it is small. A runaway loop overnight is
 *     the one failure here that you would only discover afterwards.
 */

export interface Question {
  id: string;
  text: string;
  askedAt: number;
  /** Set once a brief has been written. */
  doneAt?: number;
  briefFile?: string;
  /** Consecutive failures, so a question that cannot be answered is dropped. */
  attempts: number;
}

/** Questions researched in one night. */
export const MAX_PER_NIGHT = 3;
/** A single question may not run longer than this. */
export const MAX_QUESTION_MS = 8 * 60_000;
/** Give up on a question after this many failed attempts. */
export const MAX_ATTEMPTS = 3;
/** Questions waiting at once. */
export const MAX_QUEUE = 12;

export function researchDir(root: string = join(homedir(), ".jarvis")): string {
  return join(root, "research");
}

function queueFile(root?: string): string {
  return join(researchDir(root), "queue.json");
}

function briefsDir(root?: string): string {
  return join(researchDir(root), "briefs");
}

// ---- the queue ------------------------------------------------------------

export function loadQueue(root?: string): Question[] {
  const path = queueFile(root);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveQueue(items: Question[], root?: string): void {
  const dir = researchDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(queueFile(root), JSON.stringify(items, null, 1), { mode: 0o600 });
}

/** Loose comparison, so the same question asked twice is not queued twice. */
export function sameQuestion(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

export interface AddResult {
  added: boolean;
  reason: string;
  queued: number;
}

export function addQuestion(text: string, root?: string, now = Date.now()): AddResult {
  const clean = (text ?? "").trim();
  const items = loadQueue(root);
  const pending = items.filter((q) => !q.doneAt);

  if (clean.length < 5) {
    return { added: false, reason: "That's a bit short to research — what would you like me to find out?", queued: pending.length };
  }
  if (pending.some((q) => sameQuestion(q.text, clean))) {
    return { added: false, reason: "That's already on my list for tonight.", queued: pending.length };
  }
  if (pending.length >= MAX_QUEUE) {
    return { added: false, reason: `I already have ${pending.length} things queued — let me get through those first.`, queued: pending.length };
  }

  items.push({
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    text: clean,
    askedAt: now,
    attempts: 0,
  });
  saveQueue(items, root);
  return { added: true, reason: `I'll look into that while you're away.`, queued: pending.length + 1 };
}

/** The next question worth attempting, or null. */
export function nextQuestion(root?: string): Question | null {
  const items = loadQueue(root);
  return items.find((q) => !q.doneAt && q.attempts < MAX_ATTEMPTS) ?? null;
}

export function pendingCount(root?: string): number {
  return loadQueue(root).filter((q) => !q.doneAt && q.attempts < MAX_ATTEMPTS).length;
}

export function markAttempted(id: string, root?: string): void {
  const items = loadQueue(root);
  const q = items.find((x) => x.id === id);
  if (!q) return;
  q.attempts++;
  saveQueue(items, root);
}

export function markDone(id: string, briefFile: string, root?: string, now = Date.now()): void {
  const items = loadQueue(root);
  const q = items.find((x) => x.id === id);
  if (!q) return;
  q.doneAt = now;
  q.briefFile = briefFile;
  saveQueue(items, root);
}

export function removeQuestion(idOrText: string, root?: string): boolean {
  const items = loadQueue(root);
  const before = items.length;
  const kept = items.filter(
    (q) => q.id !== idOrText && !sameQuestion(q.text, idOrText)
  );
  if (kept.length === before) return false;
  saveQueue(kept, root);
  return true;
}

// ---- deciding whether to run ---------------------------------------------

export interface RunConditions {
  enabled: boolean;
  /** Presence says nobody is at the desk. */
  away: boolean;
  /** How many have already been done tonight. */
  doneTonight: number;
  pending: number;
}

/**
 * May a research run start right now?
 *
 * Deliberately conservative, and for the same reason the rehearsal is: idle is
 * not the same as absent. Someone reading a long document is idle, and an
 * agent quietly spending their tokens is not something they can see happening.
 */
export function mayRun(c: RunConditions): { ok: boolean; why: string } {
  if (!c.enabled) return { ok: false, why: "overnight research is off" };
  if (!c.pending) return { ok: false, why: "nothing queued" };
  if (!c.away) return { ok: false, why: "you're still at the desk" };
  if (c.doneTonight >= MAX_PER_NIGHT) {
    return { ok: false, why: `already researched ${c.doneTonight} things tonight` };
  }
  return { ok: true, why: "away, with questions waiting" };
}

// ---- briefs ---------------------------------------------------------------

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "question"
  );
}

/** The prompt an overnight run is given. */
export function buildPrompt(question: string): string {
  return (
    `Research this question while the user is away, then write them a short brief.\n\n` +
    `Question: ${question}\n\n` +
    `How to work:\n` +
    `- Use web search. Read enough sources to be confident, not exhaustive.\n` +
    `- Do NOT open, click, or type in any application. Do not change anything on this machine.\n` +
    `- If sources disagree, say so rather than picking one silently.\n\n` +
    `Write the brief as markdown, in this shape:\n` +
    `## Short answer\n(two or three sentences)\n\n` +
    `## What I found\n(the substance, in a few short paragraphs or bullets)\n\n` +
    `## Worth trying\n(concrete next steps, if there are any)\n\n` +
    `## Sources\n(bulleted list of URLs you actually used)\n\n` +
    `If you could not find a real answer, say that plainly instead of padding it out.`
  );
}

export function briefPath(question: string, root?: string, now = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return join(briefsDir(root), `${stamp}-${slugify(question)}.md`);
}

export function saveBrief(question: string, body: string, root?: string, now = Date.now()): string {
  const dir = briefsDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = briefPath(question, root, now);
  // The machine-readable stamp is written into the file itself rather than
  // relying on the filesystem's mtime. A brief that gets copied, restored from
  // a backup, or touched by a sync client keeps its real age this way —
  // otherwise last week's research reappears in this morning's summary.
  const header =
    `# ${question}\n\n` +
    `<!-- researched: ${new Date(now).toISOString()} -->\n` +
    `*Researched ${new Date(now).toLocaleString()} while you were away.*\n\n`;
  writeFileSync(path, header + body.trim() + "\n", { mode: 0o600 });
  return path;
}

export interface BriefSummary {
  file: string;
  question: string;
  at: number;
}

/** Briefs written since a given time, newest first. */
export function briefsSince(since: number, root?: string): BriefSummary[] {
  const dir = briefsDir(root);
  if (!existsSync(dir)) return [];
  const out: BriefSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      const raw = readFileSync(path, "utf8");
      const title = /^#\s+(.+)$/m.exec(raw)?.[1] ?? name.replace(/\.md$/, "");
      const at = writtenAt(raw, path);
      if (at >= since) out.push({ file: path, question: title, at });
    } catch {
      /* skip an unreadable brief */
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** When a brief was actually written, from its own header where possible. */
export function writtenAt(raw: string, path: string): number {
  const stamped = /<!--\s*researched:\s*(\S+?)\s*-->/.exec(raw)?.[1];
  if (stamped) {
    const t = Date.parse(stamped);
    if (Number.isFinite(t)) return t;
  }
  // Older briefs, written before the stamp existed, fall back to the file.
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** The morning summary: what was looked into, and the headline of each. */
export function morningBrief(root?: string, now = Date.now()): string {
  const since = now - 18 * 3600_000;
  const briefs = briefsSince(since, root);
  if (!briefs.length) {
    const waiting = pendingCount(root);
    return waiting
      ? `I haven't researched anything yet — ${waiting} question${waiting === 1 ? "" : "s"} still queued for the next time you're away.`
      : "Nothing to report — there was nothing queued to look into.";
  }

  const parts = briefs.map((b) => {
    let answer = "";
    try {
      const raw = readFileSync(b.file, "utf8");
      const m = /##\s*Short answer\s*\n+([\s\S]*?)(\n##|$)/i.exec(raw);
      answer = (m?.[1] ?? "").trim().replace(/\s+/g, " ");
      if (answer.length > 300) answer = answer.slice(0, 300).trimEnd() + "…";
    } catch {
      /* the headline is optional */
    }
    return `• ${b.question}\n  ${answer || "(brief saved)"}`;
  });

  return `While you were away I looked into ${briefs.length} thing${briefs.length === 1 ? "" : "s"}:\n\n${parts.join("\n\n")}\n\nAsk me about any of them for the full brief.`;
}

/** Read one brief in full. */
export function readBrief(match: string, root?: string): string | null {
  const briefs = briefsSince(0, root);
  const hit =
    briefs.find((b) => sameQuestion(b.question, match)) ??
    briefs.find((b) => b.question.toLowerCase().includes(match.toLowerCase()));
  if (!hit) return null;
  try {
    return readFileSync(hit.file, "utf8");
  } catch {
    return null;
  }
}

export function describeQueue(root?: string): string {
  const items = loadQueue(root).filter((q) => !q.doneAt && q.attempts < MAX_ATTEMPTS);
  if (!items.length) return "Nothing queued for overnight research.";
  return `${items.length} question${items.length === 1 ? "" : "s"} queued:\n${items
    .map((q, i) => `  ${i + 1}. ${q.text}`)
    .join("\n")}`;
}
