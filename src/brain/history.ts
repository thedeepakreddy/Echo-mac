/**
 * Keeping the conversation from eating all the RAM.
 *
 * Every screenshot a brain takes is pushed into the conversation as base64 and,
 * until now, stayed there for the life of the turn. A full-resolution PNG is
 * roughly 1-3 MB, base64 inflates it by a third, and the whole array is
 * re-serialised and re-sent on EVERY step of the loop. On a long task — exactly
 * the long tasks the "finish the whole task" rule now encourages — that grows
 * into hundreds of megabytes of live objects plus transient copies.
 *
 * On an 8 GB machine that ends in swap thrashing: the cursor stops moving, fans
 * spin up, and helper processes start crash-looping. That is a memory bug, not
 * "the model is busy".
 *
 * The fix rests on one observation: OLD SCREENSHOTS ARE NEARLY USELESS. The
 * screen has changed since; what matters is the latest view plus the text of
 * what happened. So old images are dropped and replaced by a short note, which
 * keeps the narrative intact while freeing the bytes.
 */

/**
 * How many of the most recent screenshots to keep in the conversation.
 *
 * Three, not two: screenshots are now JPEG (~375 KB of base64 each), so three
 * costs about 1.1 MB — trivial next to the unbounded growth this replaced —
 * and the extra frame gives the model room to reason about what a step changed
 * ("it looked like this, now it looks like that") instead of only ever seeing
 * the latest view.
 */
export const KEEP_IMAGES = 3;

/** Left behind where an image was dropped, so the model knows one existed. */
export const DROPPED_NOTE = "[earlier screenshot omitted to save memory]";

/** Rough byte cost of a base64 payload. */
const bytesOf = (data: unknown) => (typeof data === "string" ? data.length : 0);

/**
 * Drop all but the most recent `keep` images from a Gemini-style history.
 *
 * Mutates in place (the array is the live conversation) and returns how many
 * bytes were freed, so the caller can log it. Walks backwards so "most recent"
 * is counted from the end.
 */
export function trimGeminiHistory(contents: any[], keep = KEEP_IMAGES): number {
  let seen = 0;
  let freed = 0;
  for (let i = contents.length - 1; i >= 0; i--) {
    const parts = contents[i]?.parts;
    if (!Array.isArray(parts)) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (!p?.inlineData?.data) continue;
      seen++;
      if (seen <= keep) continue;
      freed += bytesOf(p.inlineData.data);
      // Replace the image with a text note rather than deleting the part, so
      // the sequence of events still reads correctly to the model.
      parts[j] = { text: DROPPED_NOTE };
    }
  }
  return freed;
}

/**
 * Drop all but the most recent `keep` images from an Ollama/OpenAI-style
 * history, where images live on `message.images` as an array of base64 strings.
 */
export function trimOllamaHistory(messages: any[], keep = KEEP_IMAGES): number {
  let seen = 0;
  let freed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m?.images) || m.images.length === 0) continue;
    seen++;
    if (seen <= keep) continue;
    for (const img of m.images) freed += bytesOf(img);
    delete m.images;
    if (typeof m.content === "string" && !m.content.includes(DROPPED_NOTE)) {
      m.content = `${m.content} ${DROPPED_NOTE}`.trim();
    }
  }
  return freed;
}

/** Total base64 image bytes currently held in a Gemini-style history. */
export function imageBytes(contents: any[]): number {
  let total = 0;
  for (const c of contents ?? []) {
    for (const p of c?.parts ?? []) total += bytesOf(p?.inlineData?.data);
  }
  return total;
}
