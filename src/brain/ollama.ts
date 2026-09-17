import { z } from "zod";
import { Brain, LOOP_CAPS, buildSystemPrompt, VOICE_TURN_CONTRACT, type AudioTurn, type BrainExecutionLimits, type SendOptions } from "./types.js";
import { TOOLS, TOOL_MAP } from "../tools/registry.js";
import { classify, bareToolName } from "../safety/risk.js";
import { runGated } from "../safety/gate.js";
import { parseCallsFromText, resolveToolName, toolsForLocalModel } from "./localtools.js";
import { capture } from "../safety/snapshot.js";
import { confirmations } from "../safety/confirm.js";
import { recordLLM, approxTokens } from "../agent-replay/runtime.js";
import { currentLoop, normalizeOllamaFinish, classifyProviderError } from "../agent-replay/loop-log.js";
import type { ExitReason } from "../agent-replay/recorder.js";
import type { JarvisConfig } from "../config.js";
import { ProviderMemoryContext } from "../memory/provider-context.js";

/**
 * Fully-offline brain backed by a local Ollama model.
 *
 * No network, no API limits, nothing leaves the machine. A small local model is
 * far weaker than Claude at driving a GUI, so this is best for private Q&A and
 * simple actions, or as the cheap workhorse for constant background jobs. It
 * runs every tool call through the SAME risk gate as the cloud brains — the
 * safety layer must not depend on which model is thinking.
 *
 * Ollama exposes an OpenAI-style tool-calling chat API, so the zod tool schemas
 * convert to JSON Schema and the loop is a plain call/observe cycle.
 */
export class OllamaBrain extends Brain {
  private messages: any[] = [];
  private busy = false;
  private aborted = false;
  /** How the current turn arrived; shapes the reply for the ear when spoken. */
  private lastSend: SendOptions = {};
  private memory = new ProviderMemoryContext("ollama", 650);
  // A 3B model given all 73 definitions (~22KB per turn) cannot pick the right
  // one and starts inventing names. A focused list is what makes tool use work
  // at all locally.
  private tools = toolsForLocalModel(
    TOOLS.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: z.toJSONSchema(z.object(t.schema), { io: "input" }),
      },
    }))
  );

  constructor(
    private cfg: JarvisConfig,
    private host = "http://localhost:11434",
    private readonly limits: BrainExecutionLimits = {}
  ) {
    super();
    const system = buildSystemPrompt(
      undefined,
      "CRITICAL: You are an autonomous agent. When asked to perform an action or look at the screen, you MUST invoke the provided tool natively. DO NOT output conversational text telling the user which tool to use. You must actually call the tool!",
      false
    );
    this.messages.push({ role: "system", content: system });
  }

  send(userText: string, _audio?: AudioTurn, opts?: SendOptions) {
    this.lastSend = opts ?? {};
    if (this.memory.begin(userText, opts)) this.messages = this.messages.filter((m) => m.role === "system");
    if (opts?.modality === "voice") userText = `${userText}\n\n${VOICE_TURN_CONTRACT}`;
    this.messages.push({ role: "user", content: userText });
    if (!this.busy) void this.run();
  }

  interrupt() {
    this.aborted = true;
    this.emitEvent("status", "idle");
  }

  /** The user cut the reply off: the history keeps what was heard, not what was written. */
  noteInterrupted(spoken: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "assistant" || typeof m.content !== "string") continue;
      m.content = `${spoken ? spoken + " " : ""}[interrupted by the user before finishing]`;
      return;
    }
  }

  async stop() {
    this.aborted = true;
    this.memory.close();
  }

  invalidateMemory(): void { this.memory.invalidate(); }

  private async chat(): Promise<any> {
    if (this.memory.takeInvalidation()) {
      this.messages = this.messages.filter((m) => m.role === "system");
      this.messages.push({ role: "user", content: "Continue from the current saved task state. Re-observe any evidence that was forgotten." });
    }
    const request = {
      model: this.cfg.ollama?.model ?? "llama3.2:3b",
      messages: this.messages.map((m) => m.role === "system" ? { ...m, content: `${m.content}\n\n${this.memory.packet()}` } : m),
      tools: this.tools,
      stream: true,
      options: { temperature: 0.4 },
    };
    return recordLLM(request, async () => {
      const res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!res.ok || !res.body) throw new Error(`ollama ${res.status}: ${await res.text()}`);
      // NDJSON: one object per line, the reply growing a few tokens at a time.
      // Fragments are spoken as they come; the whole is reassembled into the
      // single-message shape the loop expects.
      const decoder = new TextDecoder();
      let buffered = "";
      let content = "";
      let toolCalls: any[] = [];
      let last: any = {};
      let streamed = false;
      const turnId = this.lastSend.turnId;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          let obj: any;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          last = obj;
          const piece = obj.message?.content;
          if (typeof piece === "string" && piece) {
            content += piece;
            streamed = true;
            this.emitEvent("textDelta", { text: piece, turnId });
          }
          if (Array.isArray(obj.message?.tool_calls) && obj.message.tool_calls.length) toolCalls = toolCalls.concat(obj.message.tool_calls);
          if (this.aborted) break;
        }
      }
      if (streamed) this.emitEvent("textDone", { text: content, turnId });
      return { ...last, message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } };
    });
  }

  private async run() {
    this.busy = true;
    this.aborted = false;
    this.emitEvent("status", "thinking");
    let hadError = false;

    const log = currentLoop();
    const MAX_TURNS = this.limits.maxIterations ?? LOOP_CAPS.ollama.maxIterations;
    let exitReason: ExitReason | null = null;
    let exitDetail: string | undefined;
    let turn = 0;
    const stop = (reason: ExitReason, detail: string, spoken?: string) => {
      if (exitReason) return;
      exitReason = reason;
      exitDetail = detail;
      if (spoken) this.emitEvent("text", spoken);
    };

    try {
      for (; turn < MAX_TURNS; turn++) {
        if (this.aborted) {
          stop("abort_signal", `interrupted at turn ${turn}`);
          break;
        }
        log?.iterationStart(turn, this.messages.length, approxTokens(this.messages));
        log?.enterState("awaiting_llm", `ollama:${this.cfg.ollama?.model ?? "llama3.2:3b"}`);
        const startedAt = Date.now();
        const data = await this.chat();
        const msg = data.message ?? {};
        this.messages.push(msg);

        let calls = msg.tool_calls ?? [];

        // Small models often write the call into the message body instead of
        // the structured field. Recover it rather than losing the request —
        // this is the difference between "turn on gestures" working and
        // silently doing nothing.
        if (!calls.length && msg.content?.trim()) {
          const recovered = parseCallsFromText(msg.content);
          if (recovered.length) {
            calls = recovered.map((c) => ({ function: { name: c.name, arguments: c.args } }));
            console.log(`[ollama] recovered ${calls.length} tool call(s) written as text`);
          }
        }

        log?.turnEnd({
          iteration: turn,
          provider: "ollama",
          model: String(this.cfg.ollama?.model ?? "llama3.2:3b"),
          finishReason: normalizeOllamaFinish(data.done_reason, calls.length > 0),
          rawFinishReason: data.done_reason ?? null,
          toolCallCount: calls.length,
          toolNames: calls.map((c: any) => String(c?.function?.name ?? "?")),
          promptTokens: data.prompt_eval_count ?? null,
          completionTokens: data.eval_count ?? null,
          totalContextTokens: null,
          latencyMs: Date.now() - startedAt,
          cacheHit: null,
        });

        // Only speak the content when it is prose, not a tool call it mislaid.
        if (msg.content?.trim() && !calls.length) this.emitEvent("text", msg.content.trim());

        if (!calls.length) {
          stop(
            msg.content?.trim() ? "completed" : "model_stop_no_tool_call",
            msg.content?.trim() ? "text-only reply" : "empty reply with no tool calls",
            msg.content?.trim() ? undefined : "My local model returned nothing that time, so I've stopped rather than guess."
          );
          break;
        }

        this.emitEvent("status", "acting");
        for (const call of calls) {
          if (this.aborted) {
            stop("abort_signal", `interrupted during tool calls at turn ${turn}`);
            break;
          }
          const called = call.function?.name;
          // "update_hand_gesture_params" is not a tool; "toggle_hand_gestures"
          // is. Small models guess names, and refusing outright would make the
          // local brain unusable when the intent was perfectly clear.
          const name = resolveToolName(called) ?? called;
          if (name !== called) console.log(`[ollama] "${called}" -> "${name}"`);
          const args = typeof call.function?.arguments === "string"
            ? safeParse(call.function.arguments)
            : (call.function?.arguments ?? {});
          // tool.start / tool.end come from runGated, which every brain shares.
          let result: string;
          try {
            result = await this.invokeTool(name, args);
          } catch (err: any) {
            result = `${name} failed: ${err?.message ?? err}`;
          }
          this.messages.push({ role: "tool", content: result });
        }
      }

      if (turn >= MAX_TURNS) {
        stop(
          "max_iterations",
          `hit the ${MAX_TURNS}-turn cap`,
          `I hit my ${MAX_TURNS}-step limit before finishing. I'm continuing from a fresh recovery checkpoint.`
        );
      }
    } catch (err: any) {
      const reason = classifyProviderError(err);
      stop(reason, String(err?.message ?? err));
      this.emitEvent("error", friendly(err));
      hadError = true;
      log?.exit(reason, { iteration: turn, error: err, messageCount: this.messages.length });
    } finally {
      this.busy = false;
      log?.exit(exitReason ?? "unknown_fallthrough", {
        iteration: turn,
        detail: exitDetail,
        messageCount: this.messages.length,
        approxTokensInContext: approxTokens(this.messages),
      });
      log?.enterState("idle");
      this.emitEvent("turnEnd");
      this.emitEvent("status", "idle");
      
      // Prevent infinite loops: if we failed, drop the offending user message so we don't retry it infinitely.
      if (hadError && this.messages[this.messages.length - 1]?.role === "user") {
        this.messages.pop();
      } else if (!hadError && this.messages[this.messages.length - 1]?.role === "user" && !this.aborted) {
        void this.run();
      }
    }
  }

  /**
   * Same risk gate as the cloud brains — literally the same code now.
   *
   * This brain had its own correct copy of the classify-snapshot-confirm
   * sequence while Claude and Gemini had different, weaker ones. Three
   * implementations meant three chances to be wrong, and two of them were.
   */
  private async invokeTool(name: string, args: any): Promise<string> {
    const def = TOOL_MAP.get(name);
    if (!def) return `No such tool: ${name}`;

    const out = await runGated(def, args ?? {}, {
      workingDir: this.cfg.control.workingDir,
      emit: (e, p) => this.emitEvent(e as any, p),
    });
    // A local model can't see images; describe instead of returning pixels.
    return JSON.stringify({ status: out.status, text: out.text ?? (out.image ? "[screenshot captured]" : "done"), data: out.data, error: out.error, verification: out.verification, callId: out.callId });
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    // Small models emit half-formed JSON constantly; this is the expected case,
    // not a fault, and the recovered-call path above already logs what it found.
    console.warn(`[ollama] unparseable tool arguments, treating as empty: ${s.slice(0, 120)}`);
    return {};
  }
}

function friendly(err: any): string {
  const msg = String(err?.message ?? err);
  if (/ECONNREFUSED|fetch failed|11434/.test(msg)) {
    return "My offline brain isn't running. Start it with `brew services start ollama`.";
  }
  if (/not found|no such model/i.test(msg)) {
    return "That local model isn't installed. Pull it with `ollama pull`.";
  }
  return msg;
}
