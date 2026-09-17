/**
 * Conversation-history trimming — the fix for the memory blow-up.
 *
 *   npm run historytrimtest
 *
 * A long task used to accumulate every screenshot in the conversation as base64
 * and re-send the lot on each step. On an 8 GB machine that ended in swap
 * thrashing. These assert the bytes are actually released while the narrative
 * of what happened stays readable.
 */
import {
  trimGeminiHistory, trimOllamaHistory, imageBytes, KEEP_IMAGES, DROPPED_NOTE,
} from "./brain/history.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

/** A Gemini-style history with `n` screenshots of ~1 MB each. */
const bigImage = () => "A".repeat(1_000_000);
function history(n: number) {
  const contents: any[] = [{ role: "user", parts: [{ text: "open my email" }] }];
  for (let i = 0; i < n; i++) {
    contents.push({ role: "model", parts: [{ functionCall: { name: "screenshot" } }] });
    contents.push({
      role: "user",
      parts: [
        { functionResponse: { name: "screenshot", response: { result: `step ${i}` } } },
        { inlineData: { mimeType: "image/png", data: bigImage() } },
      ],
    });
  }
  return contents;
}

console.log("\nConversation history trimming\n");

console.log("  old screenshots are released");
{
  const c = history(10);
  const before = imageBytes(c);
  ok(before > 9_000_000, `10 screenshots ≈ ${(before / 1_048_576).toFixed(0)} MB held`);

  const freed = trimGeminiHistory(c);
  const after = imageBytes(c);
  // Derived from KEEP_IMAGES, not a magic number, so tuning the constant does
  // not silently break this assertion.
  const expectFreed = (10 - KEEP_IMAGES) * 1_000_000;
  ok(freed >= expectFreed, `freed ${(freed / 1_048_576).toFixed(0)} MB (expected ≥ ${(expectFreed / 1_048_576).toFixed(0)} MB)`);
  ok(after <= KEEP_IMAGES * 1_000_000, `only the ${KEEP_IMAGES} newest remain (${(after / 1_048_576).toFixed(0)} MB)`);
}

console.log("  the most RECENT screenshots are the ones kept");
{
  const c: any[] = [];
  for (const tag of ["oldest", "middle", "newest"]) {
    c.push({ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: tag } }] });
  }
  trimGeminiHistory(c, 2);
  const kept = JSON.stringify(c);
  ok(kept.includes("newest") && kept.includes("middle"), "newest two survive");
  ok(!kept.includes('"oldest"'), "the oldest is dropped");
}

console.log("  the story still reads correctly");
{
  const c = history(5);
  trimGeminiHistory(c);
  const s = JSON.stringify(c);
  ok(s.includes(DROPPED_NOTE), "a note marks where an image was removed");
  ok(s.includes("open my email"), "the original command is untouched");
  ok(s.includes("step 0"), "tool results are untouched");
  ok(c.length === history(5).length, "no messages were deleted, only image bytes");
}

console.log("  it is safe to call repeatedly and on odd input");
{
  const c = history(6);
  trimGeminiHistory(c);
  const afterFirst = imageBytes(c);
  const freedAgain = trimGeminiHistory(c);
  ok(freedAgain === 0, "a second pass frees nothing more");
  ok(imageBytes(c) === afterFirst, "and changes nothing");

  ok(trimGeminiHistory([]) === 0, "an empty history is fine");
  ok(trimGeminiHistory([{ role: "user" }, null, { parts: null }] as any) === 0, "malformed entries do not throw");
  ok(imageBytes([]) === 0, "imageBytes of nothing is zero");
}

console.log("  a short conversation is left completely alone");
{
  const c = history(KEEP_IMAGES);
  const before = imageBytes(c);
  ok(trimGeminiHistory(c) === 0, "nothing is trimmed below the keep threshold");
  ok(imageBytes(c) === before, "every image survives");
}

console.log("  the ollama-shaped variant works too");
{
  const msgs: any[] = [
    { role: "user", content: "look", images: ["old1"] },
    { role: "user", content: "look", images: ["old2"] },
    { role: "user", content: "look", images: ["new1"] },
    { role: "user", content: "look", images: ["new2"] },
  ];
  const freed = trimOllamaHistory(msgs, 2);
  ok(freed > 0, "bytes were freed");
  ok(!msgs[0].images && !msgs[1].images, "old images removed");
  ok(!!msgs[2].images && !!msgs[3].images, "recent images kept");
  ok(msgs[0].content.includes(DROPPED_NOTE), "and a note is left behind");
}

console.log(`\n${pass}/${pass + fail} history-trim checks passed\n`);
process.exit(fail ? 1 : 0);
