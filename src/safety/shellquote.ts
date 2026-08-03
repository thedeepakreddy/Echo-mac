/**
 * Shell-argument escaping.
 *
 * Voice shortcuts interpolate a spoken parameter into a shell string that is
 * handed to `exec`. Without escaping, saying something containing a quote and a
 * semicolon runs whatever follows — speech becomes arbitrary code execution.
 *
 * Single quotes suppress every metacharacter a shell knows. The one character
 * that cannot appear inside them is a single quote itself, so each one is
 * closed, escaped outside the quotes, and reopened: ' -> '\''
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
