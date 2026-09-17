import { speakableText } from "./prosody.js";

/**
 * Turns a stream of text fragments into sentences to speak.
 *
 * Speech synthesis needs whole phrases — a voice cannot start a sentence it
 * does not have the end of without sounding like it is reading a telegram —
 * but waiting for the whole reply is what made Echo sound like a machine
 * reading text. The chunker sits between: it hands the first sentence to the
 * voice the moment its full stop arrives, while the model is still writing the
 * second.
 *
 * Cuts at sentence ends (. ! ? … and the Indic danda ।), at clause breaks
 * once a chunk is long enough to be worth saying on its own, and at a word
 * boundary if a sentence runs very long. Markdown is stripped per chunk.
 */

const SENTENCE_END = /[.!?…।]["')\]*_]*\s+$/;
const CLAUSE_END = /[,;:—-]\s+$/;
const CLAUSE_MIN = 60;
const HARD_MAX = 180;
/** Do not cut after an abbreviation or a number with a dot ("3.5", "e.g."). */
const NOT_AN_END = /(\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no)\.|\d\.\s*)$/i;

export class SentenceChunker {
  private buf = "";

  /** Feed a fragment; returns any chunks that are ready to speak. */
  feed(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    // Repeatedly peel off the first complete sentence/clause.
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const piece = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut);
      const clean = speakableText(piece);
      if (clean) out.push(clean);
    }
    return out;
  }

  private findCut(): number {
    // Scan for the earliest boundary position, checking the text up to it.
    for (let i = 1; i <= this.buf.length; i++) {
      const head = this.buf.slice(0, i);
      if (SENTENCE_END.test(head) && !NOT_AN_END.test(head.trimEnd().slice(0, -1) + head.trimEnd().slice(-1))) {
        // Guard: "3. " inside a list vs a real sentence — require some letters.
        if (/[A-Za-zऀ-෿]{2,}/.test(head)) return i;
      }
      if (head.length >= CLAUSE_MIN && CLAUSE_END.test(head)) return i;
      if (head.length >= HARD_MAX && /\s$/.test(head)) return i;
    }
    return -1;
  }

  /** The model is done: whatever is left is the last chunk. */
  flush(): string[] {
    const rest = speakableText(this.buf);
    this.buf = "";
    return rest ? [rest] : [];
  }

  get pending(): string {
    return this.buf;
  }

  reset(): void {
    this.buf = "";
  }
}

/** Sentences in a finished text, for the non-streaming path (`Tts.say`). */
export function splitSentences(text: string): string[] {
  const c = new SentenceChunker();
  return [...c.feed(text.endsWith(" ") ? text : text + " "), ...c.flush()];
}
