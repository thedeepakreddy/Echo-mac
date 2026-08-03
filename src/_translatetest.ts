/**
 * Screen translation: grouping OCR runs into passages, and matching a model's
 * reply back to the coordinates it came from.
 *
 *   npm run translatetest
 *
 * The parsing tests matter most. A reply that loses one line must leave one
 * block untranslated — not shift every later translation onto the wrong text,
 * which would be wrong in a way nobody could see.
 */
import {
  groupIntoLines, groupIntoParagraphs, translatableBlocks,
  buildPrompt, parseTranslations, drawable, describe,
  type TextBlock, type TranslatedBlock,
} from "./frontier/translate.js";
import type { OcrLine } from "./tools/vision.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const run = (text: string, x: number, y: number, w = 60, h = 16, confidence = 0.9): OcrLine =>
  ({ text, x, y, w, h, cx: x + w / 2, cy: y + h / 2, confidence });

const block = (text: string, x = 0, y = 0, w = 100, h = 16): TextBlock =>
  ({ text, x, y, w, h, parts: 1 });

console.log("\nScreen translation\n");

console.log("  runs on the same visual line are joined");
{
  const lines = groupIntoLines([
    run("Bonjour", 10, 100),
    run("tout", 80, 101),      // 1px off — the same line
    run("le monde", 130, 99),  // 1px the other way
    run("Deuxième ligne", 10, 140),
  ]);
  ok(lines.length === 2, `two visual lines found (${lines.length})`);
  ok(lines[0].text === "Bonjour tout le monde", `and joined left to right: "${lines[0].text}"`);
  ok(lines[0].x === 10 && lines[0].w === 180, "with a box covering the whole line");
}
{
  // Out-of-order input must still assemble correctly — OCR does not promise
  // reading order.
  const lines = groupIntoLines([run("monde", 130, 100), run("Bonjour", 10, 100)]);
  ok(lines[0].text === "Bonjour monde", "runs arriving out of order are ordered by position");
}
{
  const lines = groupIntoLines([
    run("clear", 10, 100, 60, 16, 0.9),
    run("gArBlEd", 80, 100, 60, 16, 0.2),
  ]);
  ok(lines[0].text === "clear", "text the recogniser doubted is dropped");
}
{
  ok(groupIntoLines([]).length === 0, "no input yields no lines");
  ok(groupIntoLines([run("   ", 0, 0)]).length === 0, "whitespace is not a line");
}
{
  // Different font sizes on one line: a heading next to small print.
  const lines = groupIntoLines([
    run("Titre", 10, 100, 80, 30),
    run("sous-titre", 100, 108, 60, 14), // centres align, tops do not
  ]);
  ok(lines.length === 1, "mixed type sizes still group as one line (centres, not tops)");
}

console.log("  lines become paragraphs");
{
  const paras = groupIntoParagraphs([
    block("First line of the paragraph", 10, 100, 200, 16),
    block("continues on the next line", 10, 120, 200, 16),
    block("A separate paragraph далеко below", 10, 300, 200, 16),
  ]);
  ok(paras.length === 2, `two paragraphs (${paras.length})`);
  ok(/First line.*continues/.test(paras[0].text), "adjacent lines merge into one passage");
  ok(!/separate/.test(paras[0].text), "and a distant one stays apart");
}
{
  // Side-by-side columns are not one passage, however close vertically.
  const paras = groupIntoParagraphs([
    block("Left column text", 10, 100, 200, 16),
    block("Right column text", 600, 102, 200, 16),
  ]);
  ok(paras.length === 2, "columns side by side stay separate passages");
}
{
  ok(groupIntoParagraphs([]).length === 0, "no lines yields no paragraphs");
}

console.log("  choosing what is worth translating");
{
  const blocks = translatableBlocks([
    run("Une phrase complète à traduire ici", 10, 100, 300),
    run("×", 500, 100, 12),
    run("42", 520, 100, 20),
    run("OK", 540, 100, 24),
  ]);
  const texts = blocks.map((b) => b.text);
  ok(texts.some((t) => /phrase complète/.test(t)), "real language is kept");
  ok(!texts.includes("×"), "a lone symbol is not language");
  ok(!texts.includes("42"), "nor a bare number");
}
{
  const many = Array.from({ length: 100 }, (_, i) => run(`Ligne numéro ${i} de texte`, 10, i * 40, 200));
  ok(translatableBlocks(many, 40).length <= 40, "the number of passages is capped");
}

console.log("  the prompt");
{
  const p = buildPrompt([block("Bonjour"), block("Au revoir")], "English");
  ok(/1\. Bonjour/.test(p) && /2\. Au revoir/.test(p), "passages are numbered");
  ok(/English/.test(p), "the target language is named");
  ok(/ONLY/.test(p), "and the model is told to reply with nothing else");
}

console.log("  matching the reply back to the screen");
{
  const blocks = [block("Bonjour"), block("Au revoir"), block("Merci")];
  const out = parseTranslations("1. Hello\n2. Goodbye\n3. Thank you", blocks);
  ok(out.length === 3, "every block comes back");
  ok(out[0].translated === "Hello" && out[2].translated === "Thank you", "in the right order");
}
{
  // The failure that matters: the model drops a line. Position-based matching
  // would shift "Thank you" onto "Au revoir" and look perfectly fine.
  const blocks = [block("Bonjour"), block("Au revoir"), block("Merci")];
  const out = parseTranslations("1. Hello\n3. Thank you", blocks);
  ok(out[0].translated === "Hello", "the first is still right");
  ok(out[1].translated === "", "the DROPPED one is left empty");
  ok(out[2].translated === "Thank you", "and the third is not shifted onto the second");
}
{
  const blocks = [block("Bonjour"), block("Merci")];
  const out = parseTranslations(
    "Sure! Here are the translations:\n\n1) Hello\n2) Thank you\n\nLet me know if you need anything else.",
    blocks
  );
  ok(out[0].translated === "Hello" && out[1].translated === "Thank you",
     "commentary around the answer is ignored");
}
{
  const blocks = [block("Bonjour")];
  ok(parseTranslations("1. Hello\n5. Nonsense\n99. More", blocks)[0].translated === "Hello",
     "numbers outside the range are ignored");
  ok(parseTranslations("", blocks)[0].translated === "", "an empty reply leaves it untranslated");
  ok(parseTranslations("total gibberish with no numbers", blocks)[0].translated === "",
     "an unnumbered reply is not guessed at");
}
{
  const blocks = [block("Bonjour")];
  ok(parseTranslations("1. First\n1. Second", blocks)[0].translated === "First",
     "a repeated number keeps the first answer rather than the last");
}

console.log("  only drawing what changed");
{
  const blocks: TranslatedBlock[] = [
    { ...block("Bonjour"), translated: "Hello" },
    { ...block("Hello"), translated: "Hello" },
    { ...block("Merci"), translated: "" },
  ];
  const shown = drawable(blocks);
  ok(shown.length === 1, `only genuinely translated text is drawn (${shown.length})`);
  ok(shown[0].translated === "Hello" && shown[0].text === "Bonjour",
     "text already in the target language is not covered with a copy of itself");
}

console.log("  what it says afterwards");
{
  ok(/couldn't find any readable text/.test(describe([], "English", 0)), "an empty screen says so");
  ok(/already looks like English/.test(describe([], "English", 5)),
     "a screen already in the target language says that, not 'nothing found'");
  ok(/Translated 2 passages/.test(
    describe([{ ...block("a"), translated: "b" }, { ...block("c"), translated: "d" }], "English", 5)
  ), "and a successful run reports the count");
}

console.log(`\n${pass}/${pass + fail} translation checks passed\n`);
process.exit(fail ? 1 : 0);
