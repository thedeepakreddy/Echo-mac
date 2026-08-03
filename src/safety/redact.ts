/**
 * Scrub secrets out of any text before Echo stores it.
 *
 * Echo keeps three records that outlive the moment: the screen-history log, the
 * DeepakLLM training set, and the long-term-memory embeddings. None of them may
 * ever contain a password, an API key, a card number or a token. This is the
 * single function they all pass text through, so "never record a password" is
 * enforced in one place rather than hoped for in several.
 *
 * It errs toward OVER-redaction on purpose. Losing a token from your own screen
 * history is a shrug; keeping a credential on disk forever — or worse, training
 * a model that can be coaxed into repeating it — is not. A [redacted] marker is
 * left behind so it is clear a secret was removed, not that text went missing.
 *
 * What it cannot catch: a bare password with no nearby label, sitting in a
 * field as an ordinary-looking word ("hunter2"). Nothing pattern-based can. The
 * trajectory recorder covers that case separately, by the CONTEXT of the turn
 * (anything typed during a sign-in is redded regardless of how it looks).
 */

export const REDACTED = "[redacted]";

/**
 * A value that follows a secret label with an explicit `:` or `=` — the
 * config/form case (`password: hunter2`, `pwd=x`, `secret="topsecret"`,
 * `PASSWORD=sk-...` in a .env). Always redacted; a separator makes it
 * unambiguous that a value follows.
 */
const LABELLED_SEP =
  /\b(pass(?:word|code|phrase)?|pwd|passwd|pin|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|cvv|ssn|otp|auth(?:orization)?|bearer)\b\s*[:=]\s*(["']?)([^\s"'<>,;]{2,})\2/gi;

/**
 * The same but with only whitespace between label and value (`password hunter2`
 * off a "show password" screen). Restricted to the strongest labels, and the
 * following word is redacted UNLESS it is obviously prose ("password field"),
 * so normal sentences survive while a revealed value does not.
 */
const LABELLED_SPACE = /\b(password|passcode|passphrase|pwd|passwd|otp)\s+(["']?)([^\s"'<>,;]{2,})\2/gi;
const PROSE_AFTER_LABEL =
  /^(is|was|are|the|a|an|for|to|and|or|of|on|in|field|fields|box|entry|form|forms|manager|managers|protected|required|reset|resets|screen|page|pages|prompt|input|inputs|here|below|above|please|enter|incorrect|wrong|correct|change|changed|update|updated|expired|strength|hint|hints|recovery|section|settings?)$/i;

/** Known credential shapes, redacted wherever they appear. */
const SHAPES: RegExp[] = [
  /\bsk-[a-z]*-?[A-Za-z0-9_-]{16,}\b/gi, // OpenAI / Anthropic keys
  /\bAIza[0-9A-Za-z_\-]{20,}\b/g, // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access-key id
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, // JWT
  /\b(?:\d[ -]?){13,19}\b/g, // card numbers (13-19 digits, spaced or dashed)
];

/**
 * Return `text` with every credential-looking span replaced by [redacted].
 * Safe on any string; returns non-strings untouched-as-empty.
 */
export function scrubSecrets(text: unknown): string {
  if (typeof text !== "string" || !text) return typeof text === "string" ? text : "";
  let out = text;
  // Separator-labelled values first ("password: x", secret="x").
  out = out.replace(LABELLED_SEP, (_m, label) => `${label}: ${REDACTED}`);
  // Space-labelled values, unless the following word is clearly prose.
  out = out.replace(LABELLED_SPACE, (m, label, _q, val) =>
    PROSE_AFTER_LABEL.test(val) ? m : `${label} ${REDACTED}`
  );
  for (const re of SHAPES) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Does this text still appear to carry a secret AFTER scrubbing? Used by the
 * capture paths to drop a row entirely rather than store a half-scrubbed one,
 * and by tests to assert nothing slipped through.
 */
export function looksSecret(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const scrubbed = scrubSecrets(text);
  return scrubbed !== text; // something was redacted -> it held a secret
}
