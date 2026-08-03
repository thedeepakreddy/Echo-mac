import { execFile } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, extname, basename, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node:path";

/**
 * Answering from your own files.
 *
 * Jarvis could read what was on screen and nothing else — ask it about the
 * pricing you agreed in March and it had no way to look. This indexes the
 * documents you actually own so that question is answerable.
 *
 * It is deliberately a SMALL index rather than the whole disk. Embedding
 * measured at ~12 chunks a second on this machine, so a hundred documents is
 * about three minutes of background work and a hundred thousand would be a
 * day. Pointing it at the directories where documents actually live gets
 * essentially all of the value for a tiny fraction of the cost.
 *
 * Everything stays on this machine: the model is local, the vectors are local,
 * and nothing is uploaded. That matters more than usual here — a personal
 * document index contains exactly the things you would least like to leak.
 */

const EMBED_MODEL = "nomic-embed-text";
const EMBED_DIMS = 768;
const OLLAMA = process.env.OLLAMA_HOST || "http://localhost:11434";

/**
 * nomic-embed is trained with task prefixes, and they are not decoration:
 * embedding a question and a document the same way measurably degrades
 * retrieval, because a question and its answer are not phrased alike.
 */
const DOC_PREFIX = "search_document: ";
const QUERY_PREFIX = "search_query: ";

/** Files worth reading. Anything else is skipped without opening it. */
const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".rst", ".org",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".csv", ".tsv",
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h",
  ".cpp", ".hpp", ".cs", ".swift", ".kt", ".sh", ".sql", ".html", ".css",
]);
const DOC_EXT = new Set([".pdf", ".rtf", ".rtfd", ".doc", ".docx", ".odt", ".htm"]);

/**
 * Bulk data is not a document, and treating it as one is ruinous.
 *
 * Measured on this machine: a 97 MB CSV of public health statistics sitting in
 * Documents would have produced roughly eighty thousand passages and taken
 * about ninety minutes to embed — for a file no one will ever ask a question
 * about. Log files are the same story. These types therefore get a much
 * tighter size limit than prose does.
 */
const DATA_EXT = new Set([".csv", ".tsv", ".json", ".yaml", ".yml", ".sql", ".ini", ".toml"]);
const MAX_DATA_BYTES = 2 * 1024 * 1024;

/**
 * Names that are machine output rather than anything written for a reader.
 *
 * The date-and-TIME pattern is the useful general rule: `tabprotosrv_2025_05_07_04_12_02.txt`
 * is a process dump, while `Meeting notes 2025-05-07.md` is a document. A date
 * alone is something people write; a date with a timestamp attached is
 * something a program wrote.
 */
const NOISE =
  /(^|[^a-z])log([^a-z]|$)|\.min\.|-lock$|package-lock|yarn\.lock|crash|protosrv|\bdump\b|_bk$|\d{4}[-_]\d{2}[-_]\d{2}[-_]\d{2}/i;

/**
 * Directories never worth indexing.
 *
 * node_modules is the important one: a single project can hold more files than
 * every document you have ever written, none of which you will ever ask about.
 */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "target",
  "vendor", "__pycache__", ".venv", "venv", "env", ".next", ".nuxt", ".cache",
  "Library", "Applications", ".Trash", "DerivedData", ".gradle", ".m2",
  "Pods", ".terraform", "coverage", ".pytest_cache", ".mypy_cache",
]);

/** Files above this are almost never documents you would ask about. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** A ceiling so a runaway directory cannot consume the machine. */
export const MAX_CHUNKS = 60_000;

/**
 * Passages taken from any one file.
 *
 * 200 chunks is roughly 240,000 characters — far more than any document you
 * would ask a question about. The cap exists so one pathological file cannot
 * monopolise an entire indexing run; the beginning of a document is also where
 * its subject is stated, so a truncated long file is still findable.
 */
export const MAX_CHUNKS_PER_FILE = 200;

/** Save progress every this many files. */
const CHECKPOINT_EVERY = 20;

export interface Chunk {
  path: string;
  /** File modification time when this chunk was made, for incremental updates. */
  mtime: number;
  /** Position within the file, so several hits in one document can be ordered. */
  ord: number;
  text: string;
}

export interface Hit {
  path: string;
  text: string;
  score: number;
  ord: number;
}

// ---- pure logic -----------------------------------------------------------

/** Should this path be opened at all? */
export function shouldIndex(path: string, size: number): boolean {
  if (size <= 0 || size > MAX_FILE_BYTES) return false;
  const name = basename(path);
  // Dotfiles are configuration, not documents.
  if (name.startsWith(".")) return false;
  if (NOISE.test(name)) return false;

  const ext = extname(path).toLowerCase();
  if (DATA_EXT.has(ext)) return size <= MAX_DATA_BYTES;
  return TEXT_EXT.has(ext) || DOC_EXT.has(ext);
}

/** Should this directory be descended into? */
export function shouldDescend(name: string): boolean {
  if (SKIP_DIRS.has(name)) return false;
  // Hidden directories, but not the root "." itself.
  if (name.startsWith(".") && name !== "." && name !== "..") return false;
  // A .app is a directory on macOS; descending into one yields thousands of
  // resource files and no documents.
  if (name.endsWith(".app") || name.endsWith(".framework") || name.endsWith(".bundle")) return false;
  return true;
}

export const CHUNK_CHARS = 1200;
export const CHUNK_OVERLAP = 200;
/** Shorter than this and there is not enough context to embed meaningfully. */
export const MIN_CHUNK_CHARS = 20;

/**
 * Split a document into passages to embed.
 *
 * Paragraph boundaries are preferred over a fixed character count: an
 * embedding of half a sentence joined to half of the next one represents
 * neither, and that is what a naive fixed-size split produces. Overlap exists
 * so an answer that straddles a boundary is still wholly inside some chunk.
 */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!clean) return [];
  // The short-document path has to honour the same minimum as the splitting
  // path below, or a one-line file becomes a chunk that can never usefully
  // match anything while still costing an embedding.
  if (clean.length <= size) return clean.length > MIN_CHUNK_CHARS ? [clean] : [];

  const paras = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";

  const push = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = "";
  };

  for (const p of paras) {
    // A single paragraph longer than a chunk has to be cut regardless; do it on
    // sentence boundaries so the pieces still read as language.
    if (p.length > size) {
      push();
      const sentences = p.split(/(?<=[.!?])\s+/);
      let buf = "";
      for (const s of sentences) {
        if (buf.length + s.length + 1 > size && buf) {
          out.push(buf.trim());
          buf = overlap > 0 ? buf.slice(-overlap) + " " : "";
        }
        // A "sentence" longer than the whole chunk (minified data, a long URL
        // run) still has to be broken, or it would grow without limit.
        if (s.length > size) {
          if (buf.trim()) out.push(buf.trim());
          buf = "";
          for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
          continue;
        }
        buf += s + " ";
      }
      if (buf.trim()) out.push(buf.trim());
      continue;
    }
    if (cur.length + p.length + 2 > size && cur) {
      push();
    }
    cur += (cur ? "\n\n" : "") + p;
  }
  push();
  return out.filter((c) => c.length > MIN_CHUNK_CHARS);
}

/** Cosine similarity of two equal-length vectors. */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Collapse hits so one long document cannot fill the whole answer.
 *
 * Without this, asking about a subject discussed at length in one file returns
 * five passages from that file and nothing else — technically the best matches,
 * and useless if what you needed was the other document that also mentions it.
 */
export function rankHits(hits: Hit[], limit: number, perFile = 2): Hit[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const seen = new Map<string, number>();
  const out: Hit[] = [];
  for (const h of sorted) {
    const n = seen.get(h.path) ?? 0;
    if (n >= perFile) continue;
    seen.set(h.path, n + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

/** Has this file changed since it was indexed? */
export function needsReindex(
  known: { mtime: number } | undefined,
  current: { mtime: number }
): boolean {
  if (!known) return true;
  // Whole milliseconds: filesystem timestamps and JSON round-tripping do not
  // agree on sub-millisecond precision, and a false "changed" re-embeds the
  // entire disk on every sweep.
  return Math.floor(known.mtime) !== Math.floor(current.mtime);
}

// ---- storage --------------------------------------------------------------

export function indexDir(root: string = join(homedir(), ".jarvis")): string {
  return join(root, "diskindex");
}

interface FileRecord {
  mtime: number;
  size: number;
  chunks: number;
}

export interface IndexState {
  chunks: Chunk[];
  vectors: Float32Array;
  files: Record<string, FileRecord>;
}

export function emptyIndex(): IndexState {
  return { chunks: [], vectors: new Float32Array(0), files: {} };
}

export function loadIndex(dir: string): IndexState {
  const chunksPath = join(dir, "chunks.jsonl");
  const vecPath = join(dir, "vectors.bin");
  const filesPath = join(dir, "files.json");
  if (!existsSync(chunksPath) || !existsSync(vecPath)) return emptyIndex();

  try {
    const chunks: Chunk[] = [];
    for (const line of readFileSync(chunksPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        chunks.push(JSON.parse(t));
      } catch {
        /* skip a corrupt row rather than lose the index */
      }
    }
    const buf = readFileSync(vecPath);
    // Copy rather than view: a Buffer's byteOffset is not guaranteed to be
    // 4-byte aligned, and Float32Array over an unaligned offset throws.
    const vectors = new Float32Array(new Uint8Array(buf).buffer.slice(0));

    // A vector file that does not match the chunk list is unusable; rebuilding
    // is cheap and silently mismatched results would be worse.
    if (vectors.length !== chunks.length * EMBED_DIMS) return emptyIndex();

    const files = existsSync(filesPath)
      ? JSON.parse(readFileSync(filesPath, "utf8"))
      : {};
    return { chunks, vectors, files };
  } catch {
    return emptyIndex();
  }
}

export function saveIndex(dir: string, state: IndexState): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Write beside then rename: a crash mid-write leaves the previous index
  // intact rather than a truncated one that loads as empty.
  const tmp = (n: string) => join(dir, n + ".tmp");
  writeFileSync(tmp("chunks.jsonl"), state.chunks.map((c) => JSON.stringify(c)).join("\n") + "\n", { mode: 0o600 });
  writeFileSync(tmp("vectors.bin"), Buffer.from(state.vectors.buffer, state.vectors.byteOffset, state.vectors.byteLength), { mode: 0o600 });
  writeFileSync(tmp("files.json"), JSON.stringify(state.files), { mode: 0o600 });
  renameSync(tmp("chunks.jsonl"), join(dir, "chunks.jsonl"));
  renameSync(tmp("vectors.bin"), join(dir, "vectors.bin"));
  renameSync(tmp("files.json"), join(dir, "files.json"));
}

// ---- extraction -----------------------------------------------------------

function locateHelper(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, "native", "textextract");
    if (existsSync(candidate)) return candidate;
    if (dir === root) return candidate;
    dir = dirname(dir);
  }
}
const EXTRACTOR = locateHelper();

/** Pull readable text out of a file, whatever kind it is. */
export async function extractText(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();

  // Plain text needs no helper.
  if (TEXT_EXT.has(ext)) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  }
  if (!existsSync(EXTRACTOR)) return "";

  return new Promise((resolve) => {
    execFile(EXTRACTOR, [path], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout) => {
      if (!stdout?.trim()) return resolve("");
      try {
        const parsed = JSON.parse(stdout);
        resolve(typeof parsed.text === "string" ? parsed.text : "");
      } catch {
        resolve("");
      }
    });
  });
}

// ---- embedding ------------------------------------------------------------

export async function embed(text: string, isQuery = false): Promise<Float32Array | null> {
  try {
    const res = await fetch(`${OLLAMA}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: EMBED_MODEL,
        prompt: (isQuery ? QUERY_PREFIX : DOC_PREFIX) + text,
      }),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    if (!Array.isArray(json.embedding) || json.embedding.length !== EMBED_DIMS) return null;
    return Float32Array.from(json.embedding);
  } catch {
    return null; // ollama not running, or the model is missing
  }
}

export async function embeddingAvailable(): Promise<boolean> {
  return (await embed("probe")) !== null;
}

// ---- walking --------------------------------------------------------------

export interface Candidate {
  path: string;
  mtime: number;
  size: number;
}

/** Every indexable file under a set of roots. */
export function walk(roots: string[], maxFiles = 20_000): Candidate[] {
  const out: Candidate[] = [];
  const queue = [...roots];
  const visited = new Set<string>();

  while (queue.length && out.length < maxFiles) {
    const dir = queue.shift()!;
    if (visited.has(dir)) continue; // a symlink loop would otherwise never end
    visited.add(dir);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable directory (permissions); skip quietly
    }

    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue; // a broken symlink
      }
      if (st.isDirectory()) {
        if (shouldDescend(name)) queue.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (shouldIndex(full, st.size)) {
        out.push({ path: full, mtime: st.mtimeMs, size: st.size });
      }
    }
  }
  return out;
}

/** Where documents actually live, by default. */
export function defaultRoots(): string[] {
  return ["Documents", "Desktop", "Downloads"]
    .map((d) => join(homedir(), d))
    .filter((d) => existsSync(d));
}

// ---- building -------------------------------------------------------------

export interface BuildProgress {
  filesTotal: number;
  filesDone: number;
  chunksAdded: number;
  currentFile: string;
}

export interface BuildResult {
  filesIndexed: number;
  filesSkipped: number;
  chunksAdded: number;
  chunksRemoved: number;
  totalChunks: number;
  stopped: boolean;
  error?: string;
}

let building = false;
let cancelRequested = false;

export function isIndexing(): boolean {
  return building;
}

/** Ask a running index to stop at the next file boundary. */
export function cancelIndexing() {
  cancelRequested = true;
}

/**
 * Bring the index up to date.
 *
 * Only files whose modification time changed are re-read, so the common case —
 * a sweep where nothing was edited — costs a directory walk and no embedding at
 * all. Progress is reported per file because a first run takes minutes and
 * silence for minutes reads as a hang.
 */
export async function buildIndex(opts: {
  root?: string;
  roots?: string[];
  onProgress?: (p: BuildProgress) => void;
  /** Pause between files, so indexing does not compete with what you are doing. */
  throttleMs?: number;
} = {}): Promise<BuildResult> {
  if (building) {
    return { filesIndexed: 0, filesSkipped: 0, chunksAdded: 0, chunksRemoved: 0, totalChunks: 0, stopped: false, error: "already-indexing" };
  }
  building = true;
  cancelRequested = false;

  const dir = indexDir(opts.root);
  const roots = opts.roots?.length ? opts.roots : defaultRoots();

  try {
    if (!(await embeddingAvailable())) {
      return {
        filesIndexed: 0, filesSkipped: 0, chunksAdded: 0, chunksRemoved: 0, totalChunks: 0, stopped: false,
        error: `the local embedding model isn't available — start Ollama and run: ollama pull ${EMBED_MODEL}`,
      };
    }

    const state = loadIndex(dir);
    const found = walk(roots);
    const foundPaths = new Set(found.map((f) => f.path));

    const changed = found.filter((f) => needsReindex(state.files[f.path], f));
    // Files that vanished, plus files being replaced, lose their old chunks.
    const stale = new Set<string>(changed.map((f) => f.path));
    for (const known of Object.keys(state.files)) {
      if (!foundPaths.has(known)) stale.add(known);
    }

    const keptChunks: Chunk[] = [];
    const keptVectors: Float32Array[] = [];
    for (let i = 0; i < state.chunks.length; i++) {
      if (stale.has(state.chunks[i].path)) continue;
      keptChunks.push(state.chunks[i]);
      keptVectors.push(state.vectors.subarray(i * EMBED_DIMS, (i + 1) * EMBED_DIMS));
    }
    const chunksRemoved = state.chunks.length - keptChunks.length;

    const files: Record<string, FileRecord> = {};
    for (const [p, rec] of Object.entries(state.files)) {
      if (!stale.has(p)) files[p] = rec;
    }

    let chunksAdded = 0;
    let filesIndexed = 0;
    let filesSkipped = 0;

    /**
     * Write what we have so far.
     *
     * A first index measured at roughly twenty minutes on this machine, and
     * saving only at the end meant an interrupted run — a quit, a crash, a
     * laptop lid — threw all of it away and started from nothing next time.
     * Checkpointing makes progress cumulative.
     */
    const checkpoint = () => {
      const flat = new Float32Array(keptVectors.length * EMBED_DIMS);
      for (let i = 0; i < keptVectors.length; i++) flat.set(keptVectors[i], i * EMBED_DIMS);
      saveIndex(dir, { chunks: keptChunks, vectors: flat, files });
    };

    for (let i = 0; i < changed.length; i++) {
      if (cancelRequested) break;
      const f = changed[i];
      opts.onProgress?.({
        filesTotal: changed.length,
        filesDone: i,
        chunksAdded,
        currentFile: f.path,
      });

      const text = await extractText(f.path);
      const pieces = text ? chunkText(text) : [];
      if (!pieces.length) {
        // Recorded anyway, so an unreadable file is not retried every sweep.
        files[f.path] = { mtime: f.mtime, size: f.size, chunks: 0 };
        filesSkipped++;
        continue;
      }

      let added = 0;
      const take = Math.min(pieces.length, MAX_CHUNKS_PER_FILE);
      for (let k = 0; k < take; k++) {
        if (cancelRequested) break;
        if (keptChunks.length >= MAX_CHUNKS) break;
        const vec = await embed(pieces[k], false);
        if (!vec) continue;
        keptChunks.push({ path: f.path, mtime: f.mtime, ord: k, text: pieces[k] });
        keptVectors.push(vec);
        added++;
        chunksAdded++;
      }
      files[f.path] = { mtime: f.mtime, size: f.size, chunks: added };
      filesIndexed++;

      if (filesIndexed % CHECKPOINT_EVERY === 0) checkpoint();
      if (opts.throttleMs) await new Promise((r) => setTimeout(r, opts.throttleMs));
    }

    checkpoint();

    return {
      filesIndexed,
      filesSkipped,
      chunksAdded,
      chunksRemoved,
      totalChunks: keptChunks.length,
      stopped: cancelRequested,
    };
  } finally {
    building = false;
    cancelRequested = false;
  }
}

// ---- searching ------------------------------------------------------------

/** Below this a match is coincidence rather than an answer. */
export const MIN_SCORE = 0.45;

export async function search(query: string, limit = 5, root?: string): Promise<Hit[]> {
  if (!query?.trim()) return [];
  const state = loadIndex(indexDir(root));
  if (!state.chunks.length) return [];

  const q = await embed(query, true);
  if (!q) return [];

  const hits: Hit[] = [];
  for (let i = 0; i < state.chunks.length; i++) {
    const score = cosine(q, state.vectors.subarray(i * EMBED_DIMS, (i + 1) * EMBED_DIMS));
    if (score >= MIN_SCORE) {
      hits.push({ path: state.chunks[i].path, text: state.chunks[i].text, score, ord: state.chunks[i].ord });
    }
  }
  return rankHits(hits, limit);
}

/** Readable answer, with the files it came from. */
export function describeHits(hits: Hit[], query: string): string {
  if (!hits.length) {
    return `I couldn't find anything about "${query}" in your indexed files. If you haven't indexed yet, ask me to index your documents.`;
  }
  const home = homedir();
  return hits
    .map((h, i) => {
      const where = h.path.startsWith(home) ? "~/" + relative(home, h.path) : h.path;
      const snippet = h.text.length > 500 ? h.text.slice(0, 500).trimEnd() + "…" : h.text;
      return `${i + 1}. ${where}  (${(h.score * 100).toFixed(0)}% match)\n${snippet}`;
    })
    .join("\n\n");
}

/** What the index currently holds. */
export function indexStatus(root?: string): string {
  const dir = indexDir(root);
  const state = loadIndex(dir);
  if (!state.chunks.length) {
    return "I haven't indexed your files yet. Ask me to index your documents and I'll read through Documents, Desktop and Downloads.";
  }
  const fileCount = Object.keys(state.files).length;
  const withText = Object.values(state.files).filter((f) => f.chunks > 0).length;
  const mb = (state.vectors.byteLength / 1_048_576).toFixed(1);
  return `I've indexed ${withText} documents (${state.chunks.length} passages, ${mb} MB of vectors) out of ${fileCount} files seen. Everything stays on this machine.`;
}
