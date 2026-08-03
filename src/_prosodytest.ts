/**
 * Delivery: does Jarvis sound like it means what it says?
 *
 *   npm run prosodytest
 */
import { toneFor, withProsody, speakableText, describeDelivery } from "./voice/prosody.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nSpeech delivery\n");

console.log("  choosing a tone from the words");
const tones: Array<[string, string]> = [
  ["Your build failed with three errors", "concerned"],
  ["I couldn't open that file", "concerned"],
  ["Done — all tests passed", "pleased"],
  ["I've sent the message", "pleased"],
  ["This will permanently delete them. Are you sure?", "urgent"],
  ["Let me check that for you", "thinking"],
  ["Which account should I use?", "warm"],
  ["Good evening", "warm"],
  ["The file is in your downloads folder", "neutral"],
];
for (const [line, want] of tones) {
  const got = toneFor(line);
  ok(got === want, `${JSON.stringify(line.slice(0, 40))} -> ${got}`);
}

console.log("  never announce bad news brightly");
ok(toneFor("Failed to send — done") === "concerned", "trouble outranks a success word in the same line");

console.log("  text written for the eye is not read aloud");
ok(!speakableText("Run `npm test` now").includes("`"), "backticks are dropped");
ok(speakableText("See **this**").includes("this") && !speakableText("See **this**").includes("*"), "bold markers are dropped");
ok(speakableText("Go to https://example.com/x?y=1").includes("the link"), "a URL becomes 'the link'");
ok(speakableText("```\ncode\n```").includes("code block"), "a code fence is summarised");
ok(speakableText("[docs](https://x.com)") === "docs", "a link keeps only its words");

console.log("  the controls are well formed");
const out = withProsody("Done — everything passed.");
ok(out.startsWith("[[pbas "), "controls lead the line, before any spoken word");
ok(/\[\[pmod [\d.]+\]\]/.test(out), "expressiveness is set");
ok(/\[\[rate \d+\]\]/.test(out), "pace is set");
ok(out.includes("[[slnc"), "pauses are inserted where a person would breathe");
ok(withProsody("") === "", "an empty line produces nothing to say");

console.log("  expressiveness is what stops it sounding robotic");
const mods = ["Done!", "Your build failed", "Let me look", "Which one?"].map((t) => {
  const m = /\[\[pmod ([\d.]+)\]\]/.exec(withProsody(t));
  return m ? parseFloat(m[1]) : 0;
});
ok(mods.every((m) => m > 0.6), "no line is delivered monotone");
ok(new Set(mods).size > 1, "different lines are delivered differently");

console.log(`\n  examples: ${["Done — tests passed", "Your build failed"].map(describeDelivery).join(" | ")}`);
console.log(`\n${pass}/${pass + fail} delivery checks passed\n`);
process.exit(fail ? 1 : 0);
