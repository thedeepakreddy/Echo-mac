/**
 * DeepakLLM client — standalone. No Jarvis imports, no build step, no deps.
 *
 *   import { DeepakLLM } from "./deepakllm.mjs";
 *   const llm = new DeepakLLM({ tools: myTools });
 *   const result = await llm.run("open safari", { execute });
 *
 * Everything here exists because a 7B model behaves differently from a hosted
 * one in ways that break tool use outright. Two of them are load-bearing:
 *
 *   1. It often writes the call as prose instead of filling tool_calls, so the
 *      caller sees no call at all and the request silently does nothing.
 *   2. It emits the tool NAMES it was trained on. If your project calls its
 *      tools something else, pass a `rename` map — otherwise every call misses.
 *
 * Both are recovered here rather than being the host project's problem.
 */

const DEFAULT_HOST = "http://localhost:11434";

export class DeepakLLM {
  /**
   * @param {object} opts
   * @param {string} [opts.model]   Ollama model name.
   * @param {string} [opts.host]    Ollama host.
   * @param {Array}  [opts.tools]   OpenAI-style tool definitions. Load from
   *                                tools.json for the vocabulary it was trained on.
   * @param {object} [opts.rename]  Map trained name -> your project's name.
   * @param {string} [opts.system]  Override the system prompt.
   * @param {number} [opts.maxTurns] Stop runaway loops.
   */
  constructor(opts = {}) {
    this.model = opts.model ?? "deepakllm";
    this.host = (opts.host ?? DEFAULT_HOST).replace(/\/$/, "");
    this.tools = opts.tools ?? [];
    this.rename = opts.rename ?? {};
    this.maxTurns = opts.maxTurns ?? 12;
    this.messages = [];
    if (opts.system) this.messages.push({ role: "system", content: opts.system });
  }

  /** Names the model may emit, for recovering a mistyped one. */
  get #knownNames() {
    return this.tools.map((t) => t.function?.name ?? t.name).filter(Boolean);
  }

  /**
   * Run one user request to completion, executing tools as they are called.
   *
   * @param {string} userText
   * @param {object} handlers
   * @param {(name: string, args: object) => Promise<string>} handlers.execute
   *        Runs one tool and returns what to tell the model. THIS is where the
   *        host applies its own safety checks — the model must never be trusted
   *        to have decided an action is safe.
   * @param {(step: object) => void} [handlers.onStep] Called before each call.
   */
  async run(userText, { execute, onStep } = {}) {
    if (typeof execute !== "function") {
      throw new Error("run() needs an execute(name, args) function");
    }
    this.messages.push({ role: "user", content: userText });

    const performed = [];
    let said = "";

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const reply = await this.#chat();
      this.messages.push(reply);

      let calls = reply.tool_calls ?? [];

      // The model wrote the call into the message body instead of the
      // structured field. Recover it rather than losing the request.
      if (!calls.length && reply.content?.trim()) {
        const found = parseCallsFromText(reply.content);
        if (found.length) {
          calls = found.map((c) => ({ function: { name: c.name, arguments: c.args } }));
        }
      }

      if (!calls.length) {
        said = reply.content?.trim() ?? "";
        break;
      }

      for (const call of calls) {
        const raw = call.function?.name;
        const resolved = resolveToolName(raw, this.#knownNames) ?? raw;
        const name = this.rename[resolved] ?? resolved;
        const args =
          typeof call.function?.arguments === "string"
            ? safeParse(call.function.arguments)
            : (call.function?.arguments ?? {});

        onStep?.({ tool: name, args, emittedAs: raw });

        let result;
        try {
          result = await execute(name, args);
        } catch (err) {
          result = `${name} failed: ${err?.message ?? err}`;
        }
        performed.push({ tool: name, args, result });
        this.messages.push({ role: "tool", content: String(result ?? "done") });
      }
    }

    return { text: said, steps: performed };
  }

  async #chat() {
    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: this.messages,
        tools: this.tools.length ? this.tools : undefined,
        stream: false,
        options: { temperature: 0.2 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(friendly(res.status, body));
    }
    const data = await res.json();
    return data.message ?? { role: "assistant", content: "" };
  }

  /** Drop the conversation but keep the configuration. */
  reset() {
    this.messages = this.messages.filter((m) => m.role === "system");
  }
}

// ---- recovering a call written as prose ------------------------------------

/** Pull tool calls out of a plain-text reply. */
export function parseCallsFromText(text) {
  if (!text?.trim()) return [];
  const found = [];
  // Balanced-brace scan; a regex cannot match nesting reliably.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") {
        depth--;
        if (depth === 0) {
          try {
            const call = asCall(JSON.parse(text.slice(i, j + 1)));
            if (call) found.push(call);
          } catch {
            /* not JSON; keep scanning */
          }
          i = j;
          break;
        }
      }
    }
  }
  return found;
}

function asCall(obj) {
  if (!obj || typeof obj !== "object") return null;
  const name =
    obj.name ?? obj.tool ?? obj.tool_name ?? obj.function?.name ??
    (typeof obj.function === "string" ? obj.function : undefined);
  if (typeof name !== "string" || !name) return null;
  const args =
    obj.parameters ?? obj.arguments ?? obj.args ?? obj.input ?? obj.function?.arguments ?? {};
  return { name, args: typeof args === "string" ? safeParse(args) : (args ?? {}) };
}

// ---- resolving an invented name onto a real one ----------------------------

const norm = (s) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();
/** Stem so singular and plural compare equal — "gesture" vs "gestures". */
const stem = (w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const wordsOf = (s) => new Set(norm(s).split(" ").filter(Boolean).map(stem));

const NOISE = new Set([
  "get", "set", "the", "a", "to", "on", "off", "param", "value", "update", "my", "enable", "disable",
]);

/**
 * Map whatever the model called it onto a name that exists.
 * Matches on shared words rather than string distance: "update hand gesture
 * params" and "toggle hand gestures" share the words that carry the meaning
 * while their spellings are far apart.
 */
export function resolveToolName(called, known) {
  if (!called || !known?.length) return null;
  const exact = known.find((n) => n === called);
  if (exact) return exact;
  const ci = known.find((n) => n.toLowerCase() === called.toLowerCase());
  if (ci) return ci;

  const want = wordsOf(called);
  const meaningful = new Set([...want].filter((w) => !NOISE.has(w) && !NOISE.has(stem(w))));
  if (!meaningful.size) return null;

  let best = null;
  for (const n of known) {
    const have = wordsOf(n);
    let shared = 0;
    for (const w of meaningful) if (have.has(w)) shared++;
    if (!shared) continue;
    const score = shared / Math.max(meaningful.size, have.size);
    if (!best || score > best.score) best = { name: n, score };
  }
  return best && best.score >= 0.4 ? best.name : null;
}

function safeParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function friendly(status, body) {
  if (status === 404) {
    return "That model is not installed. Run: ollama create deepakllm -f Modelfile";
  }
  return `ollama ${status}: ${String(body).slice(0, 200)}`;
}

/** Load the tool vocabulary the model was trained on, as Ollama expects it. */
export async function loadTools(specPath) {
  const { readFile } = await import("node:fs/promises");
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  return (spec.tools ?? []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
