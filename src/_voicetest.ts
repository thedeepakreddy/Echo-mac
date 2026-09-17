/**
 * Voice understanding: vocabulary biasing and noise rejection.
 *
 *   npm run voicetest
 */
import { buildVocabulary, isHallucination } from "./voice/vocabulary.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nVoice understanding\n");

// ---- vocabulary ----------------------------------------------------------
console.log("  vocabulary hint");
const vocab = buildVocabulary(process.cwd());
ok(vocab.includes("Echo") && vocab.startsWith("Echo "), "the wake word is always included, and leads");
ok(/screenshot|brightness|workflow/.test(vocab), "command verbs are included");
ok(vocab.length > 80, "the hint has real content");
ok(vocab.length < 1400, "but stays short enough not to crowd out the audio");
ok(vocab.trim().endsWith("."), "reads as a sentence, which biases better than a bare list");
// Built from this machine, so whatever is installed should show up.
ok(/Chrome|Safari|Terminal|Visual Studio Code/.test(vocab), "real applications are named");

// ---- noise rejection -----------------------------------------------------
console.log("  rejecting noise");
const noise = [
  "", "   ", ".", "...", "(laughing)", "[BLANK_AUDIO]", "[ Silence ]",
  "Thank you.", "thanks", "you", "You", "uh", "um", "Okay.", "♪♪",
  "Thanks for watching!", "bye",
];
for (const n of noise) {
  ok(isHallucination(n), `rejects ${JSON.stringify(n)}`);
}

console.log("  keeping real commands");
const real = [
  "Jarvis what is on my screen",
  "open Chrome",
  "undo that",
  "yes",
  "no",
  "stop",
  "run the tests",
  "what was that error an hour ago",
];
for (const r of real) {
  ok(!isHallucination(r), `keeps ${JSON.stringify(r)}`);
}

console.log(`\n${pass}/${pass + fail} voice checks passed\n`);
process.exit(fail ? 1 : 0);
