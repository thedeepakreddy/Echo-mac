import type { Provider } from "./index.js";

/**
 * Recognising "switch to Gemini" — and, more to the point, plain "Gemini".
 *
 * Echo could already change brains, but only for the exact sentence "switch
 * your brain to X", and only by rewriting config.json and relaunching itself.
 * Saying a model's name is the natural way to ask, so this is the parser for it.
 *
 * The whole difficulty is that these are also ordinary words. "Ask Claude what
 * it thinks" must not swap the brain out from under a task, and neither must
 * "open Claude Code". So the rule is deliberately narrow: the command has to be
 * ONE provider name and nothing else but filler. Anything carrying real content
 * — a verb that isn't about switching, an object, a question word — is left
 * alone and goes to the brain as a normal command.
 */

export const PROVIDERS: Provider[] = ["claude", "gemini", "ollama", "openai"];

/** How each brain is named out loud. */
export const PROVIDER_LABELS: Record<Provider, string> = {
  claude: "Claude",
  gemini: "Gemini",
  ollama: "the local model",
  openai: "ChatGPT",
};

/**
 * What people actually call them. Model names count: asking for "Sonnet" or
 * "Flash" is asking for the brain that runs it, and nobody says "Ollama" when
 * they mean the llama running inside it.
 */
const ALIASES: Record<string, Provider> = {
  claude: "claude",
  anthropic: "claude",
  sonnet: "claude",
  opus: "claude",
  haiku: "claude",
  gemini: "gemini",
  google: "gemini",
  flash: "gemini",
  ollama: "ollama",
  llama: "ollama",
  local: "ollama",
  offline: "ollama",
  deepakllm: "ollama",
  openai: "openai",
  chatgpt: "openai",
  gpt: "openai",
  gpt4: "openai",
  gpt4o: "openai",
};

/**
 * Words that may surround the name without changing the request.
 *
 * Kept tight on purpose. Every word added here is a sentence that might be
 * swallowed instead of answered, and the cost of the two mistakes is not
 * symmetric: refusing to switch is a repeated command, switching by accident
 * throws away the conversation the user was in the middle of.
 */
const FILLER = new Set([
  "switch", "switching", "change", "changing", "swap", "use", "using",
  "go", "run", "running", "become", "set", "turn",
  "to", "into", "onto", "on", "over", "back", "again", "instead", "now", "please",
  "the", "your", "my", "brain", "brains", "model", "mode", "default",
  "can", "you", "hey", "echo", "jarvis", "be",
]);

/**
 * Which brain this command asks for, or null if it is not that kind of command.
 *
 * Returns null for anything ambiguous — two names ("claude or gemini?"), any
 * word with content in it, or a sentence long enough to be doing something else.
 */
export function parseBrainSwitch(command: string): Provider | null {
  const words = String(command ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // Eight is generous for "can you switch your brain over to gemini now" and
  // short enough that a real instruction never gets this far.
  if (!words.length || words.length > 8) return null;

  let found: Provider | null = null;
  for (const word of words) {
    // Version numbers ride along with the name: "claude 3.5", "llama3.2".
    if (/^[\d.]+$/.test(word)) continue;
    const alias = ALIASES[word] ?? ALIASES[word.replace(/[\d.]+$/, "")];
    if (alias) {
      // "claude or gemini" is a question, not an instruction.
      if (found && found !== alias) return null;
      found = alias;
      continue;
    }
    if (!FILLER.has(word)) return null;
  }
  return found;
}

/** Is this provider reachable right now, and if not, why not? */
export function unavailableReason(
  provider: Provider,
  env: NodeJS.ProcessEnv,
  geminiKeyEnv = "GEMINI_API_KEY",
  openaiKeyEnv = "OPENAI_API_KEY"
): string | null {
  if (provider === "gemini" && !env[geminiKeyEnv]?.trim()) {
    return `${geminiKeyEnv} isn't set`;
  }
  if (provider === "openai" && !env[openaiKeyEnv]?.trim()) {
    return `${openaiKeyEnv} isn't set`;
  }
  return null;
}
