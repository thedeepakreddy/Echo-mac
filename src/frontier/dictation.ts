/**
 * Turns spoken addresses into typed ones.
 *
 * Nobody dictates an email address cleanly. People spell it letter by letter,
 * say "at" and "dot", and whisper renders that as anything from "j o h n at
 * gmail dot com" to "Jay. Oh. En. at gmail.com". Typing the transcript verbatim
 * puts garbage in the To field, so it is normalised first.
 */

/** Spoken names for characters that appear in addresses. */
const SYMBOLS: Array<[RegExp, string]> = [
  [/\b(?:at sign|at the rate|at)\b/gi, "@"],
  [/\b(?:dot|period|point|full stop)\b/gi, "."],
  [/\b(?:underscore|under score)\b/gi, "_"],
  [/\b(?:dash|hyphen|minus)\b/gi, "-"],
  [/\bplus\b/gi, "+"],
];

/** Letters people say aloud, which whisper writes as words. */
const SPOKEN_LETTERS: Record<string, string> = {
  ay: "a", bee: "b", see: "c", cee: "c", dee: "d", ee: "e", ef: "f", eff: "f",
  gee: "g", aitch: "h", haitch: "h", jay: "j", kay: "k", el: "l", ell: "l",
  em: "m", en: "n", oh: "o", pee: "p", cue: "q", queue: "q", ar: "r", are: "r",
  ess: "s", tee: "t", yoo: "u", you: "u", vee: "v", "double you": "w",
  ex: "x", why: "y", wye: "y", zed: "z", zee: "z",
};

/** Common providers, so "gmail" alone can be completed. */
const DOMAINS: Record<string, string> = {
  gmail: "gmail.com",
  googlemail: "gmail.com",
  outlook: "outlook.com",
  hotmail: "hotmail.com",
  yahoo: "yahoo.com",
  icloud: "icloud.com",
  proton: "proton.me",
  protonmail: "proton.me",
};

/**
 * Convert dictated speech into an email address.
 * Returns null when the text does not look like one, so callers can ask again
 * rather than typing something wrong into a To field.
 */
export function parseEmail(spoken: string): string | null {
  if (!spoken?.trim()) return null;

  // Already a valid address? Take it as-is — whisper often gets these right.
  const direct = spoken.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/);
  if (direct) return direct[0].toLowerCase();

  let t = ` ${spoken.toLowerCase().trim()} `;

  // "double you" before single-letter joining, since it contains a space.
  t = t.replace(/\bdouble\s+(?:you|u)\b/g, " w ");

  for (const [re, ch] of SYMBOLS) t = t.replace(re, ` ${ch} `);

  // Spoken letter names -> letters.
  t = t
    .split(/\s+/)
    .map((w) => SPOKEN_LETTERS[w.replace(/[.,]/g, "")] ?? w)
    .join(" ");

  // Whisper renders spelling as "J. O. H. N." — strip the dots between single
  // letters, but only where a letter sits on BOTH sides, so a real dot in
  // "john.smith" survives.
  t = t.replace(/\b([a-z])\s*\.\s*(?=[a-z]\b)/g, "$1 ");

  // Join runs of single letters into words: "j o h n" -> "john".
  t = t.replace(/\b(?:[a-z0-9]\s+){1,}[a-z0-9]\b/g, (run) =>
    run.split(/\s+/).every((p) => p.length === 1) ? run.replace(/\s+/g, "") : run
  );

  // Close up the spaces introduced around EVERY spoken symbol, not just @ and
  // the dot: "deepak underscore r" becomes "deepak _ r", and leaving those
  // spaces made the address fail validation and get thrown away.
  t = t.replace(/\s*([@._+-])\s*/g, "$1").replace(/\s+/g, " ").trim();

  // Complete a bare provider: "john@gmail" -> "john@gmail.com".
  const bare = t.match(/^([\w.+-]+)@([a-z]+)$/);
  if (bare && DOMAINS[bare[2]]) t = `${bare[1]}@${DOMAINS[bare[2]]}`;

  // "john at gmail" with no dot at all.
  if (!t.includes("@")) {
    const provider = Object.keys(DOMAINS).find((d) => t.endsWith(` ${d}`) || t.endsWith(d));
    if (provider) {
      const user = t.slice(0, t.lastIndexOf(provider)).trim().replace(/\s+/g, "");
      if (user) t = `${user}@${DOMAINS[provider]}`;
    }
  }

  const valid = t.match(/^[\w.+-]+@[\w-]+\.[\w.]{2,}$/);
  return valid ? t : null;
}

/** Same idea for a dictated phone number. */
export function parsePhone(spoken: string): string | null {
  if (!spoken?.trim()) return null;
  const WORDS: Record<string, string> = {
    zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9", double: "",
  };
  const digits = spoken
    .toLowerCase()
    .split(/[\s-]+/)
    .map((w) => WORDS[w.replace(/[.,]/g, "")] ?? w)
    .join("")
    .replace(/[^\d+]/g, "");
  return digits.length >= 7 ? digits : null;
}

/**
 * Write a subject line from the body of a message.
 *
 * A fallback only — the model writes a better one when it has the context. This
 * exists so a subject is never left empty, which is what makes a message look
 * automated.
 */
export function suggestSubject(body: string): string {
  const clean = body.replace(/\s+/g, " ").trim();
  if (!clean) return "(no subject)";

  const first = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  // A short opening sentence usually IS the subject.
  if (first.length <= 60) return capitalise(first.replace(/[.!?]+$/, ""));

  // Otherwise take the opening clause, cut at a word boundary.
  const cut = first.slice(0, 57);
  return capitalise(cut.slice(0, cut.lastIndexOf(" ")) || cut) + "…";
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
