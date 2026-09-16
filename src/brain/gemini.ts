import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import {
  AUDIO_TURN_GUIDANCE,
  Brain,
  GEMINI_MODEL_FALLBACKS,
  JARVIS_PERSONA,
  LOOP_CAPS,
  buildSystemPrompt,
  VOICE_TURN_CONTRACT,
} from "./types.js";
import type { AudioTurn, SendOptions } from "./types.js";
import { stripAudioParts, toInlineDataPart } from "../voice/audio-turn.js";
import { TOOLS, ToolDef } from "../tools/registry.js";
import { runGated } from "../safety/gate.js";
import { trimGeminiHistory } from "./history.js";
import { recordLLM, approxTokens } from "../agent-replay/runtime.js";
import { currentLoop, normalizeGeminiFinish, classifyProviderError } from "../agent-replay/loop-log.js";
import type { ExitReason } from "../agent-replay/recorder.js";
import type { JarvisConfig } from "../config.js";
import { connectMcpServers, loadMcpConfig, type McpConnection, type McpToolHandle } from "./mcp.js";
import { ProviderMemoryContext } from "../memory/provider-context.js";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const JSON_TYPE_TO_GOOGLE: Record<string, any> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

/**
 * Translate a JSON Schema node into Google's function-declaration schema.
 *
 * We go through JSON Schema rather than reading Zod's internals: those are
 * private and did change shape between Zod 3 and 4, which silently broke this
 * conversion. `z.toJSONSchema()` is the supported route.
 */
function jsonSchemaToGoogle(node: any): any {
  if (!node || typeof node !== "object") return { type: Type.STRING };

  // Optional/nullable fields arrive as a union — take the first real branch.
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants) && variants.length) {
    const pick = variants.find((v: any) => v?.type !== "null") ?? variants[0];
    return jsonSchemaToGoogle(pick);
  }

  const out: any = {};
  if (node.description) out.description = node.description;

  const jsonType = Array.isArray(node.type)
    ? node.type.find((t: any) => t !== "null")
    : node.type;
  out.type = JSON_TYPE_TO_GOOGLE[jsonType] ?? Type.STRING;

  if (Array.isArray(node.enum)) {
    out.type = Type.STRING;
    out.enum = node.enum.map(String);
  }
  if (jsonType === "array") {
    out.items = jsonSchemaToGoogle(node.items ?? {});
  }
  if (jsonType === "object") {
    out.properties = Object.fromEntries(
      Object.entries(node.properties ?? {}).map(([k, v]) => [k, jsonSchemaToGoogle(v)])
    );
    if (node.required?.length) out.required = node.required;
  }
  return out;
}

function toFunctionDeclaration(t: ToolDef) {
  // io: "input" — a field with a default is optional for the *caller*.
  const json: any = z.toJSONSchema(z.object(t.schema), { io: "input" });
  const converted = jsonSchemaToGoogle(json);
  return {
    name: t.name,
    description: t.description,
    parameters: {
      type: Type.OBJECT,
      properties: converted.properties ?? {},
      required: converted.required ?? [],
    },
  };
}

/**
 * Why a Gemini failure is worth another model from the fallback ladder, or
 * `null` when it is not.
 *
 * Exported and used twice on purpose: by the catch that actually performs the
 * fallback, and by the `willRetry` predicate handed to `recordLLM`. Two copies
 * of this expression would drift, and the whole point of recording the decision
 * is that the tape agrees with what the loop did.
 */
export function geminiFallbackReason(
  error: unknown
): "quota" | "not found" | "temporarily overloaded" | null {
  const text = String((error as any)?.message ?? error ?? "");
  if (text.includes("429") || text.includes("Quota exceeded") || text.includes("RESOURCE_EXHAUSTED")) return "quota";
  if (text.includes("404") || text.includes("NOT_FOUND") || text.includes("no longer available")) return "not found";
  // A 503/UNAVAILABLE is normally a short-lived capacity spike. Move to the next
  // fast model so a spoken command remains responsive.
  if (text.includes("503") || text.includes("UNAVAILABLE") || text.includes("high demand")) return "temporarily overloaded";
  return null;
}

export class GeminiBrain extends Brain {
  private ai: GoogleGenAI;
  private contents: any[] = [];
  private functionDeclarations = TOOLS.map(toFunctionDeclaration);
  private busy = false;
  private aborted = false;
  private mcpInitialized = false;
  private mcpTools: Map<string, McpToolHandle> = new Map();
  /** A recording is sitting in the history, waiting to be heard exactly once. */
  private audioPending = false;
  /** How the current turn arrived; shapes the reply for the ear when spoken. */
  private lastSend: SendOptions = {};
  /** MCP servers, connected during startup rather than on the first turn. */
  private mcpReady: Promise<McpConnection> | null = null;
  private mcpConnection: McpConnection | null = null;
  private memory = new ProviderMemoryContext("gemini");

  /**
   * Built once per session, not per request: it is re-sent on every one of up to
   * 150 iterations, and re-reading the memory files that often would be pure
   * disk churn for a value that does not change mid-task.
   */
  private systemPrompt = JARVIS_PERSONA;

  constructor(private cfg: JarvisConfig, apiKey: string) {
    super();
    this.ai = new GoogleGenAI({ apiKey });
    // The listening instructions are only true when audio is actually attached,
    // so they are only in the prompt when it is.
    this.systemPrompt = buildSystemPrompt(
      undefined,
      cfg.voice?.sendAudioToBrain ? AUDIO_TURN_GUIDANCE : undefined,
      false
    );

    // Start the MCP servers NOW rather than on the first turn. Measured: uvx
    // takes ~16s to bring the Sarvam server up because it re-resolves the
    // package against pypi every time. Paid here it overlaps with the app
    // finishing its own startup and with the user deciding what to say; paid on
    // the first turn it is sixteen seconds of an assistant appearing to ignore
    // someone. Nothing awaits this until initMcp does.
    if (Object.keys(loadMcpConfig()).length) {
      this.mcpReady = connectMcpServers().catch((err) => {
        console.error("[gemini] MCP startup failed:", (err as any)?.message ?? err);
        return { tools: [], servers: [], close: async () => {} };
      });
    }
  }

  /**
   * Attach whatever MCP servers are configured, once per session.
   *
   * The connecting, deadlining and naming all live in brain/mcp.ts now, so a
   * server that is missing or hung costs its own tools and nothing else. This
   * is only responsible for turning what came back into Gemini declarations.
   *
   * Note it is awaited at the top of the agent loop: before the deadline
   * existed, a server that spawned but never answered held the FIRST request of
   * every turn open indefinitely, which looked exactly like the brain ignoring
   * the user.
   */
  private async initMcp() {
    if (this.mcpInitialized) return;
    this.mcpInitialized = true;
    // Await the connection started in the constructor. Connecting again here
    // would close those servers and spawn a second set.
    this.mcpConnection = await (this.mcpReady ?? connectMcpServers());
    const { tools, servers } = this.mcpConnection;
    for (const tool of tools) {
      const schema = jsonSchemaToGoogle(tool.inputSchema);
      this.functionDeclarations.push({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: Type.OBJECT,
          properties: schema.properties ?? {},
          required: schema.required ?? [],
        },
      });
      this.mcpTools.set(tool.name, tool);
    }
    const failed = servers.filter((s) => !s.ok);
    if (failed.length) {
      // Said once, out loud in the log, rather than buried: a tool the user
      // asked for by name that simply is not there is worth knowing about.
      console.error(`[gemini] MCP servers unavailable: ${failed.map((s) => s.name).join(", ")}`);
    }
  }

  /**
   * Whether Echo is configured to let this brain hear the turn.
   *
   * Every Gemini model in the fallback list accepts audio, so the only question
   * is whether the user asked for it — sending the recording of everything
   * spoken in the room to a cloud model is a decision, not a detail.
   */
  get hearsAudio(): boolean {
    return this.cfg.voice?.sendAudioToBrain === true;
  }

  send(userText: string, audio?: AudioTurn, opts?: SendOptions) {
    this.lastSend = opts ?? {};
    if (this.memory.begin(userText, opts)) this.contents = [];
    // A spoken turn gets the per-turn reminder that it will be read aloud.
    if (opts?.modality === "voice") userText = `${userText}\n\n${VOICE_TURN_CONTRACT}`;
    // Audio first, transcript second: the model reads the parts in order, and
    // this is the order that says "here is what was said, and here is a guess
    // at it" rather than the reverse.
    const parts: any[] = [];
    if (audio && this.hearsAudio) {
      const part = toInlineDataPart(audio);
      if (part) {
        parts.push(part);
        this.audioPending = true;
      }
    }
    parts.push({ text: userText });
    this.contents.push({ role: "user", parts });
    if (!this.busy) void this.runLoop();
  }

  /**
   * Forget the recording once it has been heard.
   *
   * One spoken command can drive a hundred iterations of the agent loop, every
   * one of which re-sends the whole history. The audio is only evidence for the
   * first reply; after that it is a quarter-megabyte re-uploaded per step, and
   * a token estimate that makes the history limiter trim real conversation to
   * make room for bytes nobody is listening to any more.
   */
  private forgetAudio() {
    if (!this.audioPending) return;
    this.audioPending = false;
    const dropped = stripAudioParts(this.contents);
    if (dropped) console.log(`[gemini] heard the turn; dropped ${dropped} recording(s) from history`);
  }

  /** Aborts the request in flight on a hard stop (never on a barge-in). */
  private turnAbort: AbortController | null = null;

  /**
   * One model call, streamed. Text fragments go out as `textDelta` the moment
   * they arrive — that is what lets the voice start on the first sentence
   * while the model writes the second — and the whole response is assembled
   * into the same shape `generateContent` returns, so the loop below, the
   * replay recorder and the history are none the wiser.
   */
  private async generateStreaming(request: any): Promise<any> {
    const signal = this.turnAbort?.signal;
    const turnId = this.lastSend.turnId;
    const stream = await this.ai.models.generateContentStream({
      ...request,
      config: { ...request.config, abortSignal: signal },
    });
    let text = "";
    const otherParts: any[] = [];
    let last: any = null;
    let streamedText = false;
    for await (const chunk of stream as AsyncIterable<any>) {
      last = chunk;
      const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p.text === "string" && p.text) {
          if (p.thought) continue; // the model thinking aloud is not the reply
          text += p.text;
          streamedText = true;
          this.emitEvent("textDelta", { text: p.text, turnId });
        } else if (p.functionCall || p.inlineData || p.executableCode || p.codeExecutionResult) {
          otherParts.push(p);
        }
      }
      if (signal?.aborted) break;
    }
    if (streamedText) this.emitEvent("textDone", { text, turnId });
    const cand = last?.candidates?.[0] ?? {};
    const merged = [...(text ? [{ text }] : []), ...otherParts];
    return {
      ...last,
      candidates: [{ ...cand, content: { role: cand?.content?.role ?? "model", parts: merged } }],
    };
  }

  /**
   * The user cut the reply off. The model must not believe it said the whole
   * thing: its last message becomes what was actually heard.
   */
  noteInterrupted(spoken: string): void {
    for (let i = this.contents.length - 1; i >= 0; i--) {
      const c = this.contents[i];
      if (c.role !== "model") continue;
      const textPart = (c.parts ?? []).find((p: any) => typeof p.text === "string");
      if (!textPart) return;
      textPart.text = `${spoken ? spoken + " " : ""}[interrupted by the user before finishing]`;
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

    /**
     * End the loop, on the record, and say so out loud.
     *
     * The silent-stop bug was never one bug: it was five different exits that
     * all looked like "finished" because none of them said anything. Anything
     * that is not an ordinary completion now gets a spoken sentence, so the
     * failure mode is at worst a wrong explanation rather than no explanation.
     */
    const stop = (reason: ExitReason, detail: string, spoken?: string) => {
      if (exitReason) return;
      exitReason = reason;
      exitDetail = detail;
      if (spoken) this.emitEvent("text", spoken);
    };

    try {
      // Shared with the hearing pass — see GEMINI_MODEL_FALLBACKS.
      const FALLBACK_MODELS = GEMINI_MODEL_FALLBACKS;

      // Gemini flash likes to stop mid-task with a text-only "next I will…"
      // rather than continuing to call tools. These bound an automatic nudge so
      // the user doesn't have to keep saying "finish it".
      let autoContinues = 0;
      let didAnyToolCall = false;
      const MAX_ITERATIONS = LOOP_CAPS.gemini.maxIterations;
      const AUTO_CONTINUE_LIMIT = LOOP_CAPS.gemini.autoContinueLimit;

      // The cap and the abort flag used to share one `for` condition, so the two
      // were indistinguishable afterwards — and both were silent. Split so each
      // can name itself.
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
        let currentModel = this.cfg.gemini.model;
        
        // Auto-fallback logic for quota exhaustion
        while (attempt < FALLBACK_MODELS.length) {
          try {
            if (this.memory.takeInvalidation()) {
              this.contents = [{ role: "user", parts: [{ text: "Continue from the saved task state. Forgotten evidence is unavailable; re-observe if needed." }] }];
            }
            const request = {
              model: currentModel,
              contents: this.contents,
              config: {
                systemInstruction: `${this.systemPrompt}\n\n${this.memory.packet()}`,
                tools: [{ functionDeclarations: this.functionDeclarations }],
              },
            };
            log?.enterState("awaiting_llm", `gemini:${currentModel}`);
            log?.setModel(currentModel);
            turnStartedAt = Date.now();
            res = await recordLLM(
              request,
              () => this.generateStreaming(request),
              attempt,
              // Asked the moment the failure surfaces, before the catch below
              // runs, so `attempt` still holds the value that catch is about to
              // increment and test against the ladder's length.
              {
                willRetry: (error) =>
                  geminiFallbackReason(error) !== null && attempt + 1 < FALLBACK_MODELS.length,
              }
            );
            // If it succeeded, persist the successful model for the next turn
            this.cfg.gemini.model = currentModel;
            break;
          } catch (err: any) {
            const errStr = String(err?.message ?? err);
            // The same expression the willRetry predicate above uses, so the
            // tape's retry decision cannot drift from the retry itself.
            const reason = geminiFallbackReason(err);

            if (reason) {
              console.warn(`[gemini] Model ${currentModel} failed (${reason}); switching models...`);
              const idx = FALLBACK_MODELS.indexOf(currentModel);
              currentModel = FALLBACK_MODELS[idx + 1];
              if (!currentModel) {
                currentModel = FALLBACK_MODELS[0];
              }
              attempt++;
              log?.note("llm.model_fallback", { from: currentModel, reason, attempt });
              if (attempt >= FALLBACK_MODELS.length) {
                throw new Error(`All Gemini fallback models exhausted or unavailable. Last error: ${errStr}`);
              }
            } else {
              throw err; // Bubble up other errors immediately
            }
          }
        }

        if (!res) throw new Error("No response generated from any model.");

        // The model has now heard the recording. Everything after this point in
        // the task is conditioned on its own first reply, so the audio comes out
        // of the history rather than riding along for another 149 iterations.
        this.forgetAudio();

        const candidate = (res as any).candidates?.[0];
        const rawFinish = candidate?.finishReason;
        const blockReason = (res as any).promptFeedback?.blockReason;
        lastFinish = rawFinish ?? blockReason ?? null;
        const usage = (res as any).usageMetadata ?? {};
        const content = candidate?.content;

        const parts = content?.parts ?? [];
        const calls = parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall);

        log?.turnEnd({
          iteration: i,
          provider: "gemini",
          model: currentModel,
          finishReason: normalizeGeminiFinish(rawFinish ?? blockReason),
          rawFinishReason: rawFinish ?? blockReason ?? null,
          toolCallCount: calls.length,
          toolNames: calls.map((c: any) => String(c?.name ?? "?")),
          promptTokens: usage.promptTokenCount ?? null,
          completionTokens: usage.candidatesTokenCount ?? null,
          totalContextTokens: usage.totalTokenCount ?? null,
          latencyMs: Date.now() - turnStartedAt,
          cacheHit: usage.cachedContentTokenCount ? true : null,
        });

        // THE silent stop. A candidate with no content means the model produced
        // nothing usable — blocked by a safety filter, cut off at the token
        // limit, or a recitation halt. The reason was sitting on the response
        // the whole time and was never read, so the loop simply broke and the
        // turn reported success. Now it is named, and said out loud.
        if (!content) {
          const why = String(rawFinish ?? blockReason ?? "no reason given");
          const finish = normalizeGeminiFinish(rawFinish ?? blockReason);
          const reason: ExitReason =
            finish === "length" ? "context_overflow"
              : finish === "content_filter" ? "provider_error"
                : "model_stop_no_tool_call";
          const spoken =
            finish === "length"
              ? "I ran out of context before finishing. I'm restarting from my checkpoint and continuing."
              : finish === "content_filter"
                ? `The model blocked that step (${why}), so I've stopped partway through.`
                : `The model returned nothing for that step (${why}). I've stopped rather than pretend I finished.`;
          stop(reason, `empty candidate content, finishReason=${why}`, spoken);
          break;
        }

        this.contents.push({ role: content.role || "model", parts: content.parts || [] });

        for (const p of parts) {
          if (p.text?.trim()) this.emitEvent("text", p.text.trim());
        }

        if (!calls.length) {
          // A text-only reply normally ends the turn. But if Gemini has been
          // acting and this reply clearly means to keep going ("next I'll…",
          // "shall I continue?") rather than reporting completion, nudge it on
          // automatically instead of dumping the job back on the user.
          const said = parts.map((p: any) => p.text || "").join(" ").trim();
          const meansToContinue =
            /\b(next|then|now i|after that|let me|i'?ll|i will|continu|proceed|moving on|going to|start(ing)? (with|by))\b/i.test(said) &&
            !/\b(done|finished|complete|all set|here'?s the|the result|in summary|to summari[sz]e|anything else)\b/i.test(said);
          const asksToContinue = /\b(shall i|should i|do you want me to|would you like me to)\b/i.test(said);
          if (didAnyToolCall && (meansToContinue || asksToContinue) && autoContinues < AUTO_CONTINUE_LIMIT) {
            autoContinues++;
            log?.note("loop.auto_continue", { n: autoContinues, limit: AUTO_CONTINUE_LIMIT });
            this.contents.push({
              role: "user",
              parts: [{ text: "Continue and finish the task completely now. Do not stop, summarise, or ask — take the next step and keep going until it is fully done." }],
            });
            continue;
          }

          // The nudge budget is spent but the model still sounds mid-task. It
          // used to fall through this same `break` as a finished turn.
          if (didAnyToolCall && (meansToContinue || asksToContinue)) {
            stop(
              "model_stop_no_tool_call",
              `auto-continue limit ${AUTO_CONTINUE_LIMIT} reached while still mid-task`,
              `I've used ${AUTO_CONTINUE_LIMIT} in-context continuations without finishing. I'm restarting from my durable checkpoint and continuing.`
            );
            break;
          }

          // A genuine end of turn: the model answered and wanted nothing more.
          stop("completed", "text-only reply with no tool calls");
          break;
        }

        this.emitEvent("status", "acting");
        didAnyToolCall = true;
        const responseParts: any[] = [];
        for (const call of calls) {
          const tool = TOOLS.find((t) => t.name === call.name);
          const mcpInfo = this.mcpTools.get(call.name);

          if (!tool && !mcpInfo) {
            this.emitEvent("tool", { name: call.name, summary: call.name });
            responseParts.push({
              functionResponse: { name: call.name, response: { error: "unknown tool" } },
            });
            continue;
          }

          try {
            if (mcpInfo) {
              // No "tool" event here: runGated emits one for every tool it runs,
              // so announcing it first reported each MCP call TWICE in the HUD
              // and the phone feed — and with the raw mcp__server__name at that,
              // where the gate's version reads "sarvam_tools_translate".
              // Wrap the MCP tool in a ToolDef so it goes through the same safety gate
              const mcpToolDef: ToolDef = {
                name: call.name,
                description: "MCP tool",
                schema: {},
                // MCP tools come from outside, so assume they can change something
                // and make the safety gate judge them like any other write tool.
                readOnly: false,
                handler: async (args: any) => {
                  // Deadlined inside the handle: a server that accepts the call
                  // and never answers would otherwise hold the turn open.
                  const result = await mcpInfo.call(args ?? {});
                  const resultText = result.text ?? "";

                  // Auto-play generated audio files from Sarvam/MCP tools
                  const wavMatch = resultText.match(/(\/[^\s"']+\.wav)/i);
                  if (wavMatch && existsSync(wavMatch[1])) {
                    try {
                      spawn("/usr/bin/afplay", [wavMatch[1]]);
                    } catch (err) {
                      console.error("[gemini] could not play generated audio:", (err as any)?.message ?? err);
                    }
                  }

                  return { ...result, text: resultText || "done" };
                }
              };
              const out = await runGated(mcpToolDef, call.args ?? {}, {
                workingDir: this.cfg.control.workingDir,
                emit: (e, p) => this.emitEvent(e as any, p),
              });
              responseParts.push({
                functionResponse: { name: call.name, response: { result: out.text ?? "done", status: out.status, data: out.data, error: out.error, verification: out.verification, callId: out.callId } },
              });
            } else if (tool) {
              // Through the shared gate, exactly as the other brains are.
              const out = await runGated(tool, call.args ?? {}, {
                workingDir: this.cfg.control.workingDir,
                emit: (e, p) => this.emitEvent(e as any, p),
              });
              responseParts.push({
                functionResponse: { name: call.name, response: { result: out.text ?? "done", status: out.status, data: out.data, error: out.error, verification: out.verification, callId: out.callId } },
              });
              if (out.image) {
                responseParts.push({
                  inlineData: { mimeType: out.image.mimeType, data: out.image.data },
                });
              }
            }
          } catch (err: any) {
            // tool.start / tool.end come from runGated, the one path every brain
            // shares; this only records what the model is told.
            responseParts.push({
              functionResponse: { name: call.name, response: { error: String(err?.message ?? err) } },
            });
          }
        }
        log?.enterState("reflecting", "trimming history");
        this.contents.push({ role: "user", parts: responseParts });

        // Free the bytes of older screenshots before the next request. Without
        // this the conversation grows by 1-3 MB per screenshot and is re-sent
        // whole on every step — which is what drove this machine into swap.
        const freed = trimGeminiHistory(this.contents);
        if (freed > 1_000_000) {
          console.log(`[gemini] released ${(freed / 1_048_576).toFixed(1)} MB of old screenshots from context`);
        }
      }

      // Ran the cap out. Previously this fell straight into `finally`, which
      // emitted turnEnd — a long task that hit 150 steps was indistinguishable
      // from one that finished in three.
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
      // Also on the way out of a turn that never got a reply — an interrupted or
      // failed request must not leave a recording in the history to be uploaded
      // again with the next thing the user says.
      this.forgetAudio();
      // `unknown_fallthrough` is deliberately the default. If it ever shows up
      // in a log, a path out of this loop was added without naming itself.
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
      /* nothing in flight */
    }
    this.emitEvent("status", "idle");
  }

  invalidateMemory(): void {
    this.memory.invalidate();
  }

  async stop() {
    this.aborted = true;
    // Every MCP server is a child process this brain spawned. Without this, a
    // brain switch left the old set running and started a second one.
    this.memory.close();
    const connection = this.mcpConnection ?? await this.mcpReady;
    await connection?.close().catch((err) =>
      console.error("[gemini] MCP shutdown failed:", (err as any)?.message ?? err)
    );
  }
}
