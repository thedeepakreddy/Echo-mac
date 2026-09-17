import OpenAI from "openai";
import { z } from "zod";
import {
  AUDIO_TURN_GUIDANCE,
  Brain,
  JARVIS_PERSONA,
  LOOP_CAPS,
  buildSystemPrompt,
  VOICE_TURN_CONTRACT,
} from "./types.js";
import type { AudioTurn, BrainExecutionLimits, SendOptions } from "./types.js";
import { stripAudioParts } from "../voice/audio-turn.js";
import { TOOLS, ToolDef } from "../tools/registry.js";
import { runGated } from "../safety/gate.js";
import { recordLLM, approxTokens } from "../agent-replay/runtime.js";
import { resolveToolName } from "./localtools.js";
import { currentLoop, classifyProviderError } from "../agent-replay/loop-log.js";
import type { ExitReason } from "../agent-replay/recorder.js";
import type { JarvisConfig } from "../config.js";
import { connectMcpServers, loadMcpConfig, type McpConnection, type McpToolHandle } from "./mcp.js";
import { ProviderMemoryContext } from "../memory/provider-context.js";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const JSON_TYPE_TO_OPENAI: Record<string, any> = {
  string: "string",
  number: "number",
  integer: "integer",
  boolean: "boolean",
  array: "array",
  object: "object",
};

function jsonSchemaToOpenAI(node: any): any {
  if (!node || typeof node !== "object") return { type: "string" };

  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants) && variants.length) {
    const pick = variants.find((v: any) => v?.type !== "null") ?? variants[0];
    return jsonSchemaToOpenAI(pick);
  }

  const out: any = {};
  if (node.description) out.description = node.description;

  const jsonType = Array.isArray(node.type)
    ? node.type.find((t: any) => t !== "null")
    : node.type;
  out.type = JSON_TYPE_TO_OPENAI[jsonType] ?? "string";

  if (Array.isArray(node.enum)) {
    out.type = "string";
    out.enum = node.enum.map(String);
  }
  if (jsonType === "array") {
    out.items = jsonSchemaToOpenAI(node.items ?? {});
  }
  if (jsonType === "object") {
    out.properties = Object.fromEntries(
      Object.entries(node.properties ?? {}).map(([k, v]) => [k, jsonSchemaToOpenAI(v)])
    );
    if (node.required?.length) out.required = node.required;
  }
  return out;
}

function toFunctionDeclaration(t: ToolDef) {
  const json: any = (z as any).toJSONSchema(z.object(t.schema), { io: "input" });
  const converted = jsonSchemaToOpenAI(json);
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: converted.properties ?? {},
        required: converted.required ?? [],
      }
    }
  };
}

export function openAIFallbackReason(
  error: unknown
): "quota" | "not found" | "temporarily overloaded" | null {
  const text = String((error as any)?.message ?? error ?? "");
  if (text.includes("429") || text.includes("insufficient_quota")) return "quota";
  if (text.includes("404") || text.includes("model_not_found")) return "not found";
  if (text.includes("503") || text.includes("server_error")) return "temporarily overloaded";
  return null;
}

const TOOL_RESULT_BUDGET = 12_000;

function withinBudget(text: string): string {
  if (typeof text !== "string" || text.length <= TOOL_RESULT_BUDGET) return text;
  const head = text.slice(0, Math.floor(TOOL_RESULT_BUDGET * 0.7));
  const tail = text.slice(-Math.floor(TOOL_RESULT_BUDGET * 0.25));
  const dropped = text.length - head.length - tail.length;
  return `${head}\n\n[... ${dropped.toLocaleString()} characters withheld to protect the context window. Narrow the request ...]\n\n${tail}`;
}

function unknownToolAdvice(called: string, known: string[]): string {
  const want = String(called).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const scored = known
    .map((name) => {
      const have = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const shared = want.filter((w) => have.some((h) => h.startsWith(w) || w.startsWith(h))).length;
      return { name, shared };
    })
    .filter((c) => c.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 5)
    .map((c) => c.name);
  return scored.length
    ? `There is no tool called "${called}". The closest tools that do exist are: ${scored.join(", ")}. Call one of those, or a different tool entirely — do not call "${called}" again.`
    : `There is no tool called "${called}", and nothing close to it exists. Choose a different tool from the ones you were given, or answer without one.`;
}

export class OpenAIBrain extends Brain {
  private ai: OpenAI;
  private contents: any[] = [];
  private functionDeclarations = TOOLS.map(toFunctionDeclaration);
  private busy = false;
  private aborted = false;
  private mcpInitialized = false;
  private mcpTools: Map<string, McpToolHandle> = new Map();
  private audioPending = false;
  private lastSend: SendOptions = {};
  private mcpReady: Promise<McpConnection> | null = null;
  private mcpConnection: McpConnection | null = null;
  private memory = new ProviderMemoryContext("openai");

  private systemPrompt = JARVIS_PERSONA;

  constructor(private cfg: JarvisConfig, apiKey: string, private readonly limits: BrainExecutionLimits = {}) {
    super();
    this.ai = new OpenAI({ apiKey });
    this.systemPrompt = buildSystemPrompt(
      undefined,
      cfg.voice?.sendAudioToBrain ? AUDIO_TURN_GUIDANCE : undefined,
      false
    );

    if (Object.keys(loadMcpConfig()).length) {
      this.mcpReady = connectMcpServers().catch((err) => {
        console.error("[openai] MCP startup failed:", (err as any)?.message ?? err);
        return { tools: [], servers: [], close: async () => {} };
      });
    }
  }

  private async initMcp() {
    if (this.mcpInitialized) return;
    this.mcpInitialized = true;
    this.mcpConnection = await (this.mcpReady ?? connectMcpServers());
    const { tools, servers } = this.mcpConnection;
    for (const tool of tools) {
      const schema = jsonSchemaToOpenAI(tool.inputSchema);
      this.functionDeclarations.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: "object",
            properties: schema.properties ?? {},
            required: schema.required ?? [],
          }
        }
      });
      this.mcpTools.set(tool.name, tool);
    }
    const failed = servers.filter((s) => !s.ok);
    if (failed.length) {
      console.error(`[openai] MCP servers unavailable: ${failed.map((s) => s.name).join(", ")}`);
    }
  }

  get hearsAudio(): boolean {
    return this.cfg.voice?.sendAudioToBrain === true;
  }

  send(userText: string, audio?: AudioTurn, opts?: SendOptions) {
    this.lastSend = opts ?? {};
    if (this.memory.begin(userText, opts)) this.contents = [];
    if (opts?.modality === "voice") userText = `${userText}\n\n${VOICE_TURN_CONTRACT}`;
    
    const content: any[] = [];
    if (audio && this.hearsAudio) {
      const base64Audio = readFileSync(audio.path).toString("base64");
      content.push({
        type: "input_audio",
        input_audio: {
          data: base64Audio,
          format: "wav"
        }
      });
      this.audioPending = true;
    }
    content.push({ type: "text", text: userText });
    
    this.contents.push({ role: "user", content });
    if (!this.busy) void this.runLoop();
  }

  private forgetAudio() {
    if (!this.audioPending) return;
    this.audioPending = false;
    let dropped = 0;
    for (const msg of this.contents) {
      if (Array.isArray(msg.content)) {
        const len = msg.content.length;
        msg.content = msg.content.filter((c: any) => c.type !== "input_audio");
        dropped += len - msg.content.length;
      }
    }
    if (dropped) console.log(`[openai] heard the turn; dropped ${dropped} recording(s) from history`);
  }

  private turnAbort: AbortController | null = null;

  private async generateStreaming(request: any): Promise<any> {
    const signal = this.turnAbort?.signal;
    const turnId = this.lastSend.turnId;
    const stream = await this.ai.chat.completions.create({
      ...request,
      stream: true,
    }, { signal });
    
    let text = "";
    let toolCalls: any[] = [];
    let streamedText = false;
    let lastChunk: any = null;
    
    for await (const chunk of stream as any) {
      lastChunk = chunk;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      
      if (delta.content) {
        text += delta.content;
        streamedText = true;
        this.emitEvent("textDelta", { text: delta.content, turnId });
      }
      
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCalls[tc.index]) {
            toolCalls[tc.index] = {
              id: tc.id,
              type: tc.type,
              function: { name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" }
            };
          } else {
            if (tc.function?.arguments) {
              toolCalls[tc.index].function.arguments += tc.function.arguments;
            }
          }
        }
      }
      
      if (signal?.aborted) break;
    }
    
    if (streamedText) this.emitEvent("textDone", { text, turnId });
    
    const message: any = { role: "assistant", content: text };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }
    
    return {
      id: lastChunk?.id,
      model: lastChunk?.model,
      choices: [{ message, finish_reason: lastChunk?.choices[0]?.finish_reason }]
    };
  }

  noteInterrupted(spoken: string): void {
    for (let i = this.contents.length - 1; i >= 0; i--) {
      const c = this.contents[i];
      if (c.role !== "assistant") continue;
      if (typeof c.content === "string") {
         c.content = `${spoken ? spoken + " " : ""}[interrupted by the user before finishing]`;
      } else if (Array.isArray(c.content)) {
         const textPart = c.content.find((p: any) => p.type === "text");
         if (textPart) {
           textPart.text = `${spoken ? spoken + " " : ""}[interrupted by the user before finishing]`;
         }
      }
      return;
    }
  }

  private async runLoop() {
    await this.initMcp();
    this.busy = true;
    this.aborted = false;
    this.turnAbort = new AbortController();
    this.emitEvent("status", "thinking");

    const log = currentLoop();
    let exitReason: ExitReason | null = null;
    let exitDetail: string | undefined;
    let iteration = 0;
    let lastFinish: unknown = null;

    const stop = (reason: ExitReason, detail: string, spoken?: string) => {
      if (exitReason) return;
      exitReason = reason;
      exitDetail = detail;
      if (spoken) this.emitEvent("text", spoken);
    };

    try {
      const FALLBACK_MODELS = [this.cfg.openai.model]; 
      let autoContinues = 0;
      let didAnyToolCall = false;
      const MAX_ITERATIONS = this.limits.maxIterations ?? LOOP_CAPS.openai.maxIterations;
      const AUTO_CONTINUE_LIMIT = LOOP_CAPS.openai.autoContinueLimit;

      let i = 0;
      for (; i < MAX_ITERATIONS; i++) {
        if (this.aborted) {
          stop("abort_signal", `interrupted at iteration ${i}`);
          break;
        }
        iteration = i;
        log?.iterationStart(i, this.contents.length, approxTokens(this.contents));

        let res;
        let attempt = 0;
        let turnStartedAt = Date.now();
        let currentModel = this.cfg.openai.model;
        
        while (attempt < FALLBACK_MODELS.length) {
          try {
            if (this.memory.takeInvalidation()) {
              this.contents = [{ role: "user", content: "Continue from the saved task state. Forgotten evidence is unavailable; re-observe if needed." }];
            }
            
            const systemMessage = {
              role: "system",
              content: `${this.systemPrompt}\n\n${this.memory.packet()}`
            };
            
            const request = {
              model: currentModel,
              messages: [systemMessage, ...this.contents],
              tools: this.functionDeclarations.length > 0 ? (this.functionDeclarations as any) : undefined,
            };
            
            log?.enterState("awaiting_llm", `openai:${currentModel}`);
            log?.setModel(currentModel);
            turnStartedAt = Date.now();
            
            res = await recordLLM(
              request,
              () => this.generateStreaming(request),
              attempt,
              {
                willRetry: (error) =>
                  openAIFallbackReason(error) !== null && attempt + 1 < FALLBACK_MODELS.length,
              }
            );
            this.cfg.openai.model = currentModel;
            break;
          } catch (err: any) {
            const errStr = String(err?.message ?? err);
            const reason = openAIFallbackReason(err);

            if (reason) {
              console.warn(`[openai] Model ${currentModel} failed (${reason}); switching models...`);
              const idx = FALLBACK_MODELS.indexOf(currentModel);
              currentModel = FALLBACK_MODELS[idx + 1] || FALLBACK_MODELS[0];
              attempt++;
              log?.note("llm.model_fallback", { from: currentModel, reason, attempt });
              if (attempt >= FALLBACK_MODELS.length) {
                throw new Error(`All OpenAI fallback models exhausted or unavailable. Last error: ${errStr}`);
              }
            } else {
              throw err;
            }
          }
        }

        if (!res) throw new Error("No response generated from any model.");

        this.forgetAudio();

        const choice = (res as any).choices?.[0];
        const rawFinish = choice?.finish_reason;
        lastFinish = rawFinish ?? null;
        const message = choice?.message;

        const calls = message?.tool_calls ?? [];

        log?.turnEnd({
          iteration: i,
          provider: "openai",
          model: currentModel,
          finishReason: rawFinish,
          rawFinishReason: rawFinish ?? null,
          toolCallCount: calls.length,
          toolNames: calls.map((c: any) => String(c?.function?.name ?? "?")),
          promptTokens: null,
          completionTokens: null,
          totalContextTokens: null,
          latencyMs: Date.now() - turnStartedAt,
          cacheHit: null,
        });

        if (!message) {
          const why = String(rawFinish ?? "no reason given");
          stop("model_stop_no_tool_call", `empty message, finishReason=${why}`, `The model returned nothing for that step (${why}). I've stopped rather than pretend I finished.`);
          break;
        }

        this.contents.push(message);

        if (message.content?.trim()) {
          this.emitEvent("text", message.content.trim());
        }

        if (!calls.length) {
          const said = message.content || "";
          const meansToContinue =
            /\b(next|then|now i|after that|let me|i'?ll|i will|continu|proceed|moving on|going to|start(ing)? (with|by))\b/i.test(said) &&
            !/\b(done|finished|complete|all set|here'?s the|the result|in summary|to summari[sz]e|anything else)\b/i.test(said);
          const asksToContinue = /\b(shall i|should i|do you want me to|would you like me to)\b/i.test(said);
          if (didAnyToolCall && (meansToContinue || asksToContinue) && autoContinues < AUTO_CONTINUE_LIMIT) {
            autoContinues++;
            log?.note("loop.auto_continue", { n: autoContinues, limit: AUTO_CONTINUE_LIMIT });
            this.contents.push({
              role: "user",
              content: "Continue and finish the task completely now. Do not stop, summarise, or ask — take the next step and keep going until it is fully done.",
            });
            continue;
          }

          if (didAnyToolCall && (meansToContinue || asksToContinue)) {
            stop(
              "model_stop_no_tool_call",
              `auto-continue limit ${AUTO_CONTINUE_LIMIT} reached while still mid-task`,
              `I've used ${AUTO_CONTINUE_LIMIT} in-context continuations without finishing. I'm restarting from my durable checkpoint and continuing.`
            );
            break;
          }

          stop("completed", "text-only reply with no tool calls");
          break;
        }

        this.emitEvent("status", "acting");
        didAnyToolCall = true;
        
        const runOneCall = async (call: any): Promise<any> => {
          const fn = call.function;
          let argsObj: any = {};
          try {
            argsObj = JSON.parse(fn.arguments || "{}");
          } catch (e) {
            argsObj = {};
          }
          let tool = TOOLS.find((t) => t.name === fn.name);
          const mcpInfo = this.mcpTools.get(fn.name);

          if (!tool && !mcpInfo) {
            const resolved = resolveToolName(fn.name);
            if (resolved) {
              tool = TOOLS.find((t) => t.name === resolved);
              if (tool) log?.note("tool.name_resolved", { called: fn.name, ran: resolved });
            }
          }

          if (!tool && !mcpInfo) {
            const advice = unknownToolAdvice(fn.name, TOOLS.map((t) => t.name).concat([...this.mcpTools.keys()]));
            log?.note("tool.unknown", { called: fn.name });
            this.emitEvent("tool", { name: fn.name, summary: fn.name });
            return {
              role: "tool",
              tool_call_id: call.id,
              name: fn.name,
              content: JSON.stringify({ error: advice })
            };
          }

          try {
            if (mcpInfo) {
              const mcpToolDef: ToolDef = {
                name: fn.name,
                description: "MCP tool",
                schema: {},
                readOnly: false,
                handler: async (args: any) => {
                  const result = await mcpInfo.call(args ?? {});
                  const resultText = result.text ?? "";
                  const wavMatch = resultText.match(/(\/[^\s"']+\.wav)/i);
                  if (wavMatch && existsSync(wavMatch[1])) {
                    try { spawn("/usr/bin/afplay", [wavMatch[1]]); } catch (err) {}
                  }
                  return { ...result, text: resultText || "done" };
                }
              };
              const out = await runGated(mcpToolDef, argsObj, {
                workingDir: this.cfg.control.workingDir,
                emit: (e, p) => this.emitEvent(e as any, p),
              });
              return {
                role: "tool",
                tool_call_id: call.id,
                name: fn.name,
                content: JSON.stringify({ result: withinBudget(out.text ?? "done"), status: out.status, data: out.data, error: out.error, verification: out.verification, callId: out.callId })
              };
            } else if (tool) {
              const out = await runGated(tool, argsObj, {
                workingDir: this.cfg.control.workingDir,
                emit: (e, p) => this.emitEvent(e as any, p),
              });
              return {
                role: "tool",
                tool_call_id: call.id,
                name: fn.name,
                content: JSON.stringify({ result: withinBudget(out.text ?? "done"), status: out.status, data: out.data, error: out.error, verification: out.verification, callId: out.callId })
              };
            }
          } catch (err: any) {
            return {
              role: "tool",
              tool_call_id: call.id,
              name: fn.name,
              content: JSON.stringify({ error: String(err?.message ?? err) })
            };
          }
        };

        const isObservation = (call: any): boolean => {
          if (this.mcpTools.has(call.function.name)) return false;
          const named = TOOLS.find((t) => t.name === call.function.name)
            ?? TOOLS.find((t) => t.name === resolveToolName(call.function.name));
          return Boolean(named?.readOnly);
        };
        
        let batched = 0;
        while (batched < calls.length && isObservation(calls[batched])) batched++;

        const responseParts: any[] = [];
        if (batched > 1) {
          log?.note("tool.parallel_batch", { count: batched, names: calls.slice(0, batched).map((c: any) => String(c?.function?.name ?? "?")) });
          const settled = await Promise.all(calls.slice(0, batched).map((call: any) => runOneCall(call)));
          for (const msg of settled) responseParts.push(msg);
        } else {
          batched = 0;
        }
        for (const call of calls.slice(batched)) {
          responseParts.push(await runOneCall(call));
        }
        
        log?.enterState("reflecting", "trimming history");
        for (const part of responseParts) {
            this.contents.push(part);
        }

      }

      if (i >= MAX_ITERATIONS) {
        stop(
          "max_iterations",
          `hit the ${MAX_ITERATIONS}-iteration cap`,
          `I hit my ${MAX_ITERATIONS}-step limit before finishing. I'm opening a fresh recovery attempt from the checkpoint.`
        );
      }
    } catch (err: any) {
      const reason = classifyProviderError(err);
      stop(reason, String(err?.message ?? err));
      this.emitEvent("error", String(err?.message ?? err));
      log?.exit(reason, {
        iteration,
        error: err,
        messageCount: this.contents.length,
        approxTokensInContext: approxTokens(this.contents),
        rawFinishReason: lastFinish,
        detail: exitDetail,
      });
    } finally {
      this.busy = false;
      this.forgetAudio();
      log?.exit(exitReason ?? "unknown_fallthrough", {
        iteration,
        detail: exitDetail,
        messageCount: this.contents.length,
        approxTokensInContext: approxTokens(this.contents),
        rawFinishReason: lastFinish,
      });
      log?.enterState("idle");
      this.emitEvent("turnEnd");
      this.emitEvent("status", "idle");
    }
  }

  interrupt() {
    this.aborted = true;
    try {
      this.turnAbort?.abort();
    } catch {
    }
    this.emitEvent("status", "idle");
  }

  invalidateMemory(): void {
    this.memory.invalidate();
  }

  async stop() {
    this.aborted = true;
    this.memory.close();
    const connection = this.mcpConnection ?? await this.mcpReady;
    await connection?.close().catch((err) =>
      console.error("[openai] MCP shutdown failed:", (err as any)?.message ?? err)
    );
  }
}
