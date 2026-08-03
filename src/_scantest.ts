/**
 * "Scan this page" — capture, permanent storage, and recall.
 *
 *   npm run scantest
 *
 * The impure edges (OCR, the camera, the embedding model) are exercised by the
 * app; here the focus is on what must be RIGHT for a scan to still be findable
 * and saveable in two months: correct type detection, a permanent archive that
 * survives corruption, recall ranking, and never clobbering a Desktop file.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectKind, looksLikeCode, suggestFilename, saveStrategy,
  saveScan, loadScans, updateScan, rankByVector, rankByText,
  ageOf, describeMatches, uniqueDestination, offerFor,
  scanRoot, type Scan,
} from "./frontier/scan.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const roots: string[] = [];
const newRoot = () => {
  const r = mkdtempSync(join(tmpdir(), "jarvis-scan-"));
  roots.push(r);
  return r;
};

const NOW = new Date(2026, 6, 22, 12, 0, 0).getTime();
const DAY = 86_400_000;

const scan = (p: Partial<Scan>): Scan => ({
  id: p.id ?? Math.random().toString(36).slice(2),
  at: p.at ?? NOW,
  app: p.app ?? "Preview",
  title: p.title ?? "",
  kind: p.kind ?? "text",
  text: p.text ?? "",
  ...p,
});

console.log("\nScan this page\n");

console.log("  it knows what it is looking at");
{
  ok(detectKind("anything", "Preview", "lecture3.pdf") === "pdf", "a .pdf title is a PDF");
  ok(detectKind("some text", "Google Chrome", "Syllabus.pdf") === "pdf", "a PDF in a browser is still a PDF");
  ok(detectKind("From: alice\nTo: bob\nSubject: hi\nReply", "Mail", "Inbox") === "email", "mail headers are email");
  ok(detectKind("From: a\nTo: b\nHello there", "Google Chrome", "Gmail - Inbox") === "email", "webmail is email");
  ok(detectKind("hey\nsee you at 5\nok", "Messages", "Alice") === "message", "the Messages app is a message");
  ok(detectKind("just some words here about things", "Notes", "Meeting") === "notes", "the Notes app is notes");
  ok(detectKind("a paragraph of ordinary prose about the weather today and tomorrow", "Google Chrome", "News") === "web",
     "ordinary text in a browser is a web page");
  ok(detectKind("", "Preview", "photo.heic") === "image", "an image viewer with no text is an image");
  ok(detectKind("plain words with nothing special about them at all", "TextEdit", "notes") === "text", "the fallback is plain text");
}
{
  const code = `function add(a, b) {\n  const sum = a + b;\n  return sum;\n}\nexport default add;`;
  ok(detectKind(code, "Visual Studio Code", "add.ts") === "code", "code in an editor is code");
  ok(detectKind(code, "Google Chrome", "gist") === "code", "code in a browser is still code by its shape");
  ok(looksLikeCode(code), "the code detector fires on real code");
  ok(!looksLikeCode("The function returns a list of the results we discussed in the meeting yesterday afternoon."),
     "but not on prose that merely talks about code");
  ok(!looksLikeCode("one line only"), "and not on a single line");
}

console.log("  naming a copy someone will recognise");
{
  ok(suggestFilename(scan({ sourcePath: "/Users/x/Documents/Lecture 3.pdf" })) === "Lecture 3.pdf",
     "a real file keeps its own name");
  const f = suggestFilename(scan({ kind: "notes", title: "Neural Nets — Chapter 4", at: NOW }));
  ok(f === "2026-07-22-neural-nets-chapter-4.md", `a captured page gets a dated, slugged name (${f})`);
  ok(suggestFilename(scan({ kind: "image", title: "", app: "Preview", at: NOW })).endsWith(".png"),
     "an image is named .png");
  ok(suggestFilename(scan({ kind: "code", title: "", app: "", at: NOW })).endsWith(".txt"), "code is named .txt");
}
{
  ok(saveStrategy(scan({ sourcePath: "/x/a.pdf" })) === "file", "a real file is saved as the file");
  ok(saveStrategy(scan({ kind: "image", shot: "x.jpg" })) === "image", "an image with no source saves the screenshot");
  ok(saveStrategy(scan({ kind: "email" })) === "text", "everything else saves the captured text");
}

console.log("  the archive is permanent and survives damage");
{
  const root = newRoot();
  saveScan(scan({ id: "a", text: "first", at: NOW - 60 * DAY }), root);
  saveScan(scan({ id: "b", text: "second", at: NOW }), root);
  // A scan store must not live under a prunable path.
  ok(!/rewind|history/.test(scanRoot(root)), "scans are stored apart from the pruned history");

  const back = loadScans(root);
  ok(back.length === 2, "scans reload");
  ok(back[0].id === "a" && back[1].id === "b", "in the order written");

  // Corrupt a line in the middle.
  const path = join(scanRoot(root), "scans.jsonl");
  writeFileSync(path, readFileSync(path, "utf8") + "{ broken json\n" + JSON.stringify(scan({ id: "c", text: "third" })) + "\n");
  const after = loadScans(root);
  ok(after.length === 3 && after.some((s) => s.id === "c"), "a corrupt line loses only itself");
}
{
  ok(loadScans(newRoot()).length === 0, "a fresh machine has no scans, and does not throw");
}

console.log("  a scan can be updated in place (marking it saved)");
{
  const root = newRoot();
  saveScan(scan({ id: "x", text: "hello" }), root);
  saveScan(scan({ id: "y", text: "world" }), root);
  ok(updateScan("x", { saved: "/Users/x/Desktop/hello.md" }, root), "the update reports success");
  const back = loadScans(root);
  ok(back.find((s) => s.id === "x")?.saved === "/Users/x/Desktop/hello.md", "the mark persists");
  ok(back.find((s) => s.id === "y")?.text === "world", "and the other scan is untouched");
  ok(back.length === 2, "with no rows lost or duplicated");
  ok(!updateScan("missing", { saved: "z" }, root), "updating an unknown scan reports failure");
}

console.log("  recall finds it months later");
{
  const v = (a: number, b: number, c: number) => [a, b, c];
  const scans = [
    scan({ id: "pricing", text: "the quarterly pricing agreement", vector: v(1, 0, 0), at: NOW - 60 * DAY }),
    scan({ id: "cat", text: "my cat on the windowsill", vector: v(0, 1, 0), at: NOW - 1 * DAY }),
    scan({ id: "old-price", text: "older pricing note", vector: v(0.9, 0.1, 0), at: NOW - 120 * DAY }),
  ];
  const hits = rankByVector(v(1, 0, 0), scans, 5, 0.4);
  ok(hits[0].id === "pricing", "the closest match wins, though it is two months old");
  ok(!hits.some((h) => h.id === "cat"), "an unrelated scan is excluded by the threshold");
  ok((hits as any[]).every((h) => h.vector === undefined), "the heavy vector is stripped from what recall returns");
}
{
  // Two near-equal matches: recency is the tiebreak, but only the tiebreak.
  const scans = [
    scan({ id: "recent", text: "budget", vector: [1, 0, 0], at: NOW }),
    scan({ id: "older", text: "budget", vector: [1, 0, 0], at: NOW - 90 * DAY }),
  ];
  ok(rankByVector([1, 0, 0], scans, 5)[0].id === "recent", "of two equal matches, the newer is first");
}
{
  // The offline fallback: no vectors at all, pure text.
  const scans = [
    scan({ id: "auth", text: "the login authentication flow with tokens" }),
    scan({ id: "weather", text: "tomorrow will be sunny" }),
  ];
  const hits = rankByText("authentication login", scans, 5);
  ok(hits[0]?.id === "auth", "text recall still works when the model is off");
  ok(!hits.some((h) => h.id === "weather"), "and does not return the unrelated one");
  ok(rankByText("", scans).length === 0, "an empty query matches nothing rather than everything");
}

console.log("  it speaks about time like a person");
{
  ok(ageOf(NOW, NOW) === "today", "today");
  ok(ageOf(NOW - DAY, NOW) === "yesterday", "yesterday");
  ok(ageOf(NOW - 10 * DAY, NOW) === "10 days ago", "days");
  ok(/2 months/.test(ageOf(NOW - 60 * DAY, NOW)), "months");
  ok(/year/.test(ageOf(NOW - 400 * DAY, NOW)), "years");
}
{
  const desc = describeMatches(
    [{ id: "p", at: NOW - 60 * DAY, app: "Preview", title: "Q2 Pricing", kind: "pdf", text: "ninety dollars per seat" } as any],
    "pricing", NOW
  );
  ok(/PDF/.test(desc) && /2 months ago/.test(desc), "a match reads back its kind and age");
  ok(/no scan|don't have/i.test(describeMatches([], "anything")), "no match says so plainly");
}

console.log("  saving never clobbers an existing Desktop file");
{
  const root = newRoot();
  const desk = join(root, "Desktop");
  mkdirSync(desk, { recursive: true });
  const target = join(desk, "notes.md");
  ok(uniqueDestination(target) === target, "a free name is used as-is");
  writeFileSync(target, "existing");
  ok(uniqueDestination(target) === join(desk, "notes (2).md"), "an occupied name gets (2)");
  writeFileSync(join(desk, "notes (2).md"), "also existing");
  ok(uniqueDestination(target) === join(desk, "notes (3).md"), "and keeps counting");
}

console.log("  the offer explains what was captured");
{
  const pdf = offerFor(scan({ kind: "pdf", sourcePath: "/x/Report.pdf" }));
  ok(/PDF/.test(pdf) && /Report\.pdf/.test(pdf) && /Desktop/.test(pdf), "a resolved PDF is offered by name");
  ok(/months/.test(pdf), "and promises long-term recall");
  const web = offerFor(scan({ kind: "web", title: "An Article", app: "Chrome" }));
  ok(/save this to your Desktop as a file/i.test(web), "a web page offers to save the captured text");
}

for (const r of roots) rmSync(r, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} scan checks passed\n`);
process.exit(fail ? 1 : 0);
