/**
 * Disk index: chunking, similarity, incremental updates and storage.
 *
 *   npm run indextest
 *
 * The embedding model is exercised only if Ollama is running; everything else
 * runs offline so the suite is not hostage to a background service.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chunkText, cosine, shouldIndex, shouldDescend, rankHits, needsReindex,
  loadIndex, saveIndex, emptyIndex, walk, indexDir, describeHits, indexStatus,
  embed, embeddingAvailable, extractText, CHUNK_CHARS, type Hit, type Chunk,
} from "./frontier/diskindex.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const roots: string[] = [];
const newRoot = () => {
  const r = mkdtempSync(join(tmpdir(), "jarvis-index-"));
  roots.push(r);
  return r;
};

console.log("\nDisk index\n");

console.log("  splitting documents into passages");
{
  ok(chunkText("").length === 0, "empty text yields no chunks");
  ok(chunkText("too short").length === 0, "a trivial fragment is not worth a chunk");
  ok(chunkText("a".repeat(500)).length === 1, "a short document is one chunk");

  const paras = Array.from({ length: 20 }, (_, i) =>
    `Paragraph ${i} about the quarterly pricing agreement and the terms we settled on.`
  ).join("\n\n");
  const chunks = chunkText(paras);
  ok(chunks.length > 1, `a long document splits (${chunks.length} chunks)`);
  ok(chunks.every((c) => c.length <= CHUNK_CHARS + 50), "no chunk greatly exceeds the target size");
  ok(chunks.every((c) => c.trim().length > 20), "no chunk is a scrap");
}
{
  // A paragraph longer than a whole chunk has to be cut on sentence bounds.
  const long = Array.from({ length: 60 }, (_, i) => `This is sentence number ${i} in one enormous paragraph.`).join(" ");
  const chunks = chunkText(long);
  ok(chunks.length > 1, `an oversized paragraph is still split (${chunks.length})`);
  ok(chunks.every((c) => c.length <= CHUNK_CHARS + 50), "and each piece respects the size limit");
}
{
  // The pathological case: no sentence breaks at all. Minified JSON, a base64
  // blob, a single enormous line. This must terminate and stay bounded.
  const blob = "x".repeat(50_000);
  const chunks = chunkText(blob);
  ok(chunks.length > 1, `an unbroken 50k blob is split (${chunks.length})`);
  ok(chunks.every((c) => c.length <= CHUNK_CHARS), "and never exceeds the chunk size");
  ok(chunks.join("").length >= 49_000, "without losing the content");
}

console.log("  deciding what to open");
{
  ok(shouldIndex("/a/notes.md", 1000), "markdown is indexed");
  ok(shouldIndex("/a/report.pdf", 1000), "pdf is indexed");
  ok(shouldIndex("/a/main.ts", 1000), "source is indexed");
  ok(!shouldIndex("/a/photo.jpg", 1000), "an image is not");
  ok(!shouldIndex("/a/movie.mov", 1000), "nor a video");
  ok(!shouldIndex("/a/.zshrc", 1000), "a dotfile is configuration, not a document");
  ok(!shouldIndex("/a/huge.pdf", 500 * 1024 * 1024), "an enormous file is skipped");
  ok(!shouldIndex("/a/empty.md", 0), "an empty file is skipped");
}
{
  // Found by actually running this: a 97 MB statistics CSV in Documents would
  // have produced ~80,000 passages and taken about ninety minutes to embed.
  ok(!shouldIndex("/a/stats.csv", 97 * 1024 * 1024), "a huge data file is not treated as a document");
  ok(shouldIndex("/a/contacts.csv", 50 * 1024), "but a small one still is");
  ok(shouldIndex("/a/thesis.pdf", 20 * 1024 * 1024), "prose keeps the generous limit");
  ok(!shouldIndex("/a/log_2025_04_22.txt", 1000), "log files are machine output, not documents");
  ok(!shouldIndex("/a/app.log", 1000), "and so is anything named .log");
  ok(!shouldIndex("/a/package-lock.json", 1000), "as is a lockfile");
  ok(shouldIndex("/a/dialog.md", 1000), "but a word merely containing 'log' is fine");
  ok(shouldIndex("/a/blog-post.md", 1000), "including one with a hyphen");
  // Also found by running it: crash dumps and process traces sitting in Documents.
  ok(!shouldIndex("/a/tabcrashreporter_bk.txt", 1000), "a crash report is not a document");
  ok(!shouldIndex("/a/tabprotosrv_2025_05_07_04_12_02.txt", 1000), "nor a timestamped process dump");
  ok(shouldIndex("/a/Meeting notes 2025-05-07.md", 1000),
     "but a document with a DATE in its name is kept — only date-plus-time means machine output");
}
{
  ok(!shouldDescend("node_modules"), "node_modules is never descended");
  ok(!shouldDescend(".git"), "nor .git");
  ok(!shouldDescend("Library"), "nor Library");
  ok(!shouldDescend("Xcode.app"), "an .app bundle is not a folder of documents");
  ok(!shouldDescend(".hidden"), "hidden directories are skipped");
  ok(shouldDescend("Documents"), "but real directories are descended");
  ok(shouldDescend("my-project"), "including ordinary project folders");
}

console.log("  similarity");
{
  const a = Float32Array.from([1, 0, 0]);
  const b = Float32Array.from([1, 0, 0]);
  const c = Float32Array.from([0, 1, 0]);
  const d = Float32Array.from([-1, 0, 0]);
  ok(Math.abs(cosine(a, b) - 1) < 1e-6, "identical vectors score 1");
  ok(Math.abs(cosine(a, c)) < 1e-6, "orthogonal vectors score 0");
  ok(Math.abs(cosine(a, d) + 1) < 1e-6, "opposite vectors score -1");
  ok(cosine(a, Float32Array.from([0, 0, 0])) === 0, "a zero vector scores 0 rather than NaN");
  ok(cosine(Float32Array.from([]), a) === 0, "an empty vector does not throw");
}

console.log("  one document cannot crowd out the rest");
{
  const hits: Hit[] = [
    { path: "/a.md", text: "one", score: 0.99, ord: 0 },
    { path: "/a.md", text: "two", score: 0.98, ord: 1 },
    { path: "/a.md", text: "three", score: 0.97, ord: 2 },
    { path: "/a.md", text: "four", score: 0.96, ord: 3 },
    { path: "/b.md", text: "other", score: 0.80, ord: 0 },
  ];
  const ranked = rankHits(hits, 5);
  ok(ranked.filter((h) => h.path === "/a.md").length === 2, "at most two passages come from one file");
  ok(ranked.some((h) => h.path === "/b.md"), "so a weaker match in another file is still seen");
  ok(ranked[0].score === 0.99, "the best match is still first");
  ok(rankHits([], 5).length === 0, "no hits ranks to nothing");
}

console.log("  only re-reading what changed");
{
  ok(needsReindex(undefined, { mtime: 100 }), "an unknown file needs indexing");
  ok(!needsReindex({ mtime: 100 }, { mtime: 100 }), "an unchanged file does not");
  ok(needsReindex({ mtime: 100 }, { mtime: 200 }), "a modified file does");
  ok(!needsReindex({ mtime: 100.4 }, { mtime: 100.9 }),
     "sub-millisecond jitter is not a change (this re-embedded the whole disk every sweep)");
}

console.log("  walking a directory");
{
  const root = newRoot();
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "docs", "notes.md"), "a".repeat(100));
  writeFileSync(join(root, "readme.txt"), "b".repeat(100));
  writeFileSync(join(root, "photo.jpg"), "c".repeat(100));
  writeFileSync(join(root, "node_modules", "dep.js"), "d".repeat(100));
  writeFileSync(join(root, ".git", "config"), "e".repeat(100));

  const found = walk([root]);
  const names = found.map((f) => f.path.replace(root, "")).sort();
  ok(found.length === 2, `two indexable files found (${found.length}: ${names.join(", ")})`);
  ok(names.some((n) => n.endsWith("notes.md")), "including one in a subdirectory");
  ok(!names.some((n) => n.includes("node_modules")), "and nothing from node_modules");
  ok(walk(["/definitely/not/a/real/path"]).length === 0, "a missing root yields nothing, without throwing");
}

console.log("  storing and reloading");
{
  const root = newRoot();
  const dir = indexDir(root);
  const chunks: Chunk[] = [
    { path: "/a.md", mtime: 1, ord: 0, text: "first passage" },
    { path: "/b.md", mtime: 2, ord: 0, text: "second passage" },
  ];
  const vectors = new Float32Array(2 * 768);
  vectors[0] = 0.5;
  vectors[768] = 0.25;

  saveIndex(dir, { chunks, vectors, files: { "/a.md": { mtime: 1, size: 10, chunks: 1 } } });
  const back = loadIndex(dir);
  ok(back.chunks.length === 2, "chunks survive the round trip");
  ok(back.vectors.length === 2 * 768, "so do the vectors");
  ok(Math.abs(back.vectors[0] - 0.5) < 1e-6 && Math.abs(back.vectors[768] - 0.25) < 1e-6,
     "with their values intact and correctly offset");
  ok(back.files["/a.md"]?.mtime === 1, "and the file records");
}
{
  ok(loadIndex(indexDir(newRoot())).chunks.length === 0, "a missing index loads as empty, not an error");
}
{
  // A vector file that disagrees with the chunk list would silently return the
  // wrong document for every query. Rebuilding is the only safe response.
  const root = newRoot();
  const dir = indexDir(root);
  saveIndex(dir, {
    chunks: [{ path: "/a.md", mtime: 1, ord: 0, text: "x" }, { path: "/b.md", mtime: 1, ord: 0, text: "y" }],
    vectors: new Float32Array(768), // one vector, two chunks
    files: {},
  });
  ok(loadIndex(dir).chunks.length === 0, "a mismatched index is discarded rather than half-trusted");
}

console.log("  reporting");
{
  ok(/couldn't find anything/.test(describeHits([], "pricing")), "no hits says so");
  const shown = describeHits([{ path: "/tmp/a.md", text: "the price is ninety", score: 0.82, ord: 0 }], "price");
  ok(/82% match/.test(shown), "a hit shows how good the match is");
  ok(/a\.md/.test(shown), "and which file it came from");
  ok(/haven't indexed/.test(indexStatus(newRoot())), "an empty index says it is empty");
}

console.log("  extracting text");
{
  const root = newRoot();
  const p = join(root, "note.md");
  writeFileSync(p, "# Heading\n\nSome content about pricing.");
  const text = await extractText(p);
  ok(/pricing/.test(text), "plain text is read directly");
  ok((await extractText(join(root, "missing.md"))) === "", "a missing file yields empty text, not a throw");
}

// ---- the parts that need the model ---------------------------------------

const haveModel = await embeddingAvailable();
if (!haveModel) {
  console.log("\n  ⚠ Ollama/nomic-embed-text not available — skipping live embedding checks");
} else {
  console.log("\n  embeddings actually distinguish meaning");
  const price = await embed("the quarterly pricing agreement was ninety dollars per seat");
  const priceQ = await embed("what did we agree the pricing was?", true);
  const cat = await embed("my cat likes to sleep in the sunshine on the windowsill");

  ok(price !== null && priceQ !== null && cat !== null, "the model returns vectors");
  if (price && priceQ && cat) {
    const relevant = cosine(priceQ, price);
    const irrelevant = cosine(priceQ, cat);
    ok(relevant > irrelevant,
       `a question is closer to its answer than to noise (${relevant.toFixed(3)} vs ${irrelevant.toFixed(3)})`);
    ok(relevant > 0.5, `and the relevant match clears the threshold (${relevant.toFixed(3)})`);
    ok(price.length === 768, "vectors are the expected width");
  }
}

for (const r of roots) rmSync(r, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} index checks passed\n`);
process.exit(fail ? 1 : 0);
