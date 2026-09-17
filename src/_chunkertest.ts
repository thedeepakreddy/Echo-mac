/**
 * The sentence chunker: streamed fragments come out as speakable sentences,
 * early, and nothing is lost or duplicated.
 *
 *   npm run chunkertest
 */
import { SentenceChunker, splitSentences } from "./voice/chunker.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
console.log("\nSentence chunker\n");

// Token-sized deltas, the way a model streams.
const text = "Sure. Your screen shows the Echo project open in the editor, with main.ts selected. Want me to summarise it?";
const c = new SentenceChunker();
const out: string[] = [];
let firstAt = -1;
const tokens = text.match(/\S+\s*|\s+/g) ?? [];
tokens.forEach((t, i) => {
  const got = c.feed(t);
  if (got.length && firstAt < 0) firstAt = i;
  out.push(...got);
});
out.push(...c.flush());
ok(out.length === 3, `three sentences from ${tokens.length} tokens (got ${out.length}: ${JSON.stringify(out)})`);
ok(out[0] === "Sure.", `first sentence is "Sure." (got ${JSON.stringify(out[0])})`);
ok(firstAt === 0, `the first sentence was released on token ${firstAt} — before the rest arrived`);
ok(out.join(" ").replace(/\s+/g, " ") === text, "nothing lost, nothing duplicated");

// Markdown is stripped per chunk; lists and code do not get read aloud.
const md = splitSentences("**Done.** I opened `main.ts` and saw https://example.com/x. Next step?");
ok(md[0] === "Done." && !md.join(" ").includes("**") && !md.join(" ").includes("`"), `markdown stripped: ${JSON.stringify(md)}`);
ok(md.join(" ").includes("the link"), "URLs are read as 'the link'");

// Decimals and abbreviations are not sentence ends.
const dec = splitSentences("Version 3.5 is out, e.g. the new build. Install it?");
ok(dec.length === 2 && dec[0].startsWith("Version 3.5"), `no cut inside "3.5" or "e.g." (got ${JSON.stringify(dec)})`);

// Long clauses are released at a comma once they are worth saying.
const long = splitSentences("I checked the calendar and the meeting with the design team about the onboarding flow is at three, then you have a dentist appointment at five.");
ok(long.length >= 2, `a long sentence is split at a clause break (${long.length} chunks)`);

// Telugu danda ends a sentence too.
const te = splitSentences("శుభోదయం। ఈ రోజు మీ షెడ్యూల్ ఖాళీగా ఉంది।");
ok(te.length === 2, `Indic danda splits sentences (${te.length})`);

console.log(`\n${pass}/${pass + fail} chunker cases passed\n`);
process.exit(fail ? 1 : 0);
