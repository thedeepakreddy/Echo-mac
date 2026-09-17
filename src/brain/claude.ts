import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Brain, LOOP_CAPS, buildSystemPrompt, VOICE_TURN_CONTRACT, type AudioTurn, type BrainExecutionLimits, type SendOptions } from "./types.js";
import {
  currentLoop, normalizeClaudeFinish, claudeTerminalToExit, classifyProviderError,
} from "../agent-replay/loop-log.js";
import type { ExitReason } from "../agent-replay/recorder.js";
import { Pushable } from "./pushable.js";
import { TOOLS } from "../tools/registry.js";
import { classify, bareToolName } from "../safety/risk.js";
import { capture } from "../safety/snapshot.js";
import { confirmations } from "../safety/confirm.js";
import { observeAction } from "../frontier/observe.js";
import { runGated, decide, DENIAL_MESSAGE } from "../safety/gate.js";
import { assess, styleFor, noteActivity } from "../frontier/struggle.js";
import type { JarvisConfig } from "../config.js";
import { loadMcpConfig } from "./mcp.js";
import { ProviderMemoryContext } from "../memory/provider-context.js";

type SDKUserMessage = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
};

/** Turn raw SDK/CLI failures into something a spoken assistant can usefully say. */
function friendlyError(err: any): string {
  const msg = String(err?.message ?? err ?? "");
  // "OAuth session expired and could not be refreshed" is what an expired
  // subscription login actually says, and it matched none of the patterns
  // below — so the one error with a precise, actionable fix was the one Echo
  // read out verbatim instead of explaining.
  if (/invalid api key|please run \/login|not logged in|unauthorized|401|oauth session expired|failed to authenticate|could not be refreshed|refresh token/i.test(msg)) {
    return "My login has expired. Run `npm run login` in the Echo folder, sign in, then restart me.";
  }
  if (/exited with code 1/i.test(msg)) {
    return "My brain failed to start — usually login. Run `npm run login`, then restart me.";
  }
  if (/rate limit|429/i.test(msg)) return "I've hit a rate limit. Give me a moment.";
  if (/ENOENT|not found/i.test(msg)) return `A required program is missing: ${msg}`;
  return msg || "Something went wrong.";
}

/**
 * What to say when the SDK stopped for a structural reason.
 *
 * These all used to be silence: `is_error` is false for a turn cap and for a
 * blocking rate limit, so the result looked like an ordinary success.
 */
function explainTerminal(terminal: string, maxTurns = LOOP_CAPS.claude.maxTurns): string {
  switch (terminal) {
    case "max_turns":
    case "error_max_turns":
      return `I hit my ${maxTurns}-step limit before finishing. I'm continuing from my durable checkpoint.`;
    case "prompt_too_long":
      return "That conversation got too long. I'm starting a fresh recovery attempt with the saved checkpoint.";
    case "blocking_limit":
    case "rapid_refill_breaker":
      return "I've hit a rate limit mid-task. I'll wait briefly, then continue from the checkpoint.";
    case "budget_exhausted":
    case "error_max_budget_usd":
      return "I ran out of my spending budget for this task before finishing it.";
    case "aborted_streaming":
    case "aborted_tools":
      return "That got cut off partway through.";
    case "hook_stopped":
    case "stop_hook_prevented":
      return "Something stopped me mid-task before I could finish.";
    case "malformed_tool_use_exhausted":
      return "I kept getting a tool call wrong and gave up on that step rather than looping.";
    default:
      return `I stopped before finishing that (${terminal}).`;
  }
}

function summarize(name: string, input: any): string {
  const short = name.replace(/^mcp__jarvis__/, "");
  try {
    if (short === "click" || short === "move_mouse") return `${short} ${input.x},${input.y}`;
    if (short === "type_text") return `type "${String(input.text).slice(0, 40)}"`;
    if (short === "press_keys")
      return `press ${[...(input.modifiers ?? []), input.key].join("+")}`;
    if (short === "open_app") return `open ${input.name}`;
    if (short === "open_url") return `open ${input.url}`;
    if (short === "scroll") return `scroll ${input.direction}`;
    if (short === "screenshot") return "look at the screen";
    if (name === "Bash") return `run: ${String(input.command).slice(0, 60)}`;
    if (name === "Read" || name === "Write" || name === "Edit") return `${name} ${input.file_path ?? ""}`;
    if (name === "WebSearch") return `search: ${input.query ?? ""}`;
    if (name === "WebFetch") return `fetch: ${input.url ?? ""}`;
  } catch (err) {
    console.error(`[jarvis] could not summarise ${name}:`, (err as any)?.message ?? err);
  }
  return short;
}

export class ClaudeBrain extends Brain {
  private input = new Pushable<SDKUserMessage>();
  private q: any = null;
  private started = false;
  /** Project whose memories are loaded when the session starts. */
  projectHint: string | undefined;
  private memory = new ProviderMemoryContext("claude");
  private sessionGeneration = 0;

  constructor(private cfg: JarvisConfig, private readonly limits: BrainExecutionLimits = {}) {
    super();
  }

  private buildMcpServer() {
    const sdkTools = TOOLS.map((t) =>
      tool(
        t.name,
        t.description,
        t.schema,
        async (args: any) => {
          // Gate INSIDE the handler, not only through canUseTool.
          //
          // canUseTool is not invoked for in-process MCP tools, so these — every
          // tool Jarvis defines, including run_terminal_command — reached their
          // handlers unclassified. A live test asked Jarvis to `rm` a real file
          // and it did, with no confirmation ever requested. Here there is no
          // path to the handler that goes around the check.
          const out = await runGated(t, args ?? {}, {
            workingDir: this.cfg.control.workingDir,
            emit: (e, p) => this.emitEvent(e as any, p),
          });
          if (this.memory.takeInvalidation()) {
            // The SDK owns its history. Recreate it rather than sending deleted
            // evidence again on its next model request.
            const opts = this.lastSend;
            this.resetSession();
            setTimeout(() => this.send("Continue from sanitized task state; forgotten evidence must be re-observed.", undefined, opts), 0);
          }
          const content: any[] = [];
          if (out.text) content.push({ type: "text", text: out.text });
          if (out.image)
            content.push({ type: "image", data: out.image.data, mimeType: out.image.mimeType });
          if (!content.length) content.push({ type: "text", text: "done" });
          content.push({ type: "text", text: JSON.stringify({ status: out.status, data: out.data, error: out.error, verification: out.verification, callId: out.callId }) });
          content.push({ type: "text", text: this.memory.packet() });
          return { content, isError: out.status === "failed" || out.status === "timeout" || out.status === "uncertain" };
        }
      )
    );
    return createSdkMcpServer({
      name: "jarvis",
      version: "1.0.0",
      tools: sdkTools,
      // Keep the computer-control tools in the prompt permanently. Without
      // this the SDK defers them behind a ToolSearch call, costing a whole
      // extra model round trip before Jarvis can even take a screenshot —
      // very noticeable when every command is spoken.
      alwaysLoad: true,
    });
  }

  start() {
    if (this.started) return;
    this.started = true;

    const mcpServer = this.buildMcpServer();

    // Shared loader: it looks in the app path before the working directory, so
    // a packaged build finds mcp.json instead of silently running without it,
    // and it drops a malformed entry rather than throwing startup away. The SDK
    // owns the connection for these — Echo only hands over the specs.
    const externalMcpServers = loadMcpConfig();
    const external = Object.keys(externalMcpServers);
    if (external.length) console.log(`[claude] MCP servers configured: ${external.join(", ")}`);

    // Load what Jarvis remembers about this project. Read synchronously: the
    // file is small and local, and the first turn must not start without it.
    // Now also carries the episodic facts block, which no brain was loading.
    const persona = buildSystemPrompt(this.projectHint, undefined, false);

    const systemPrompt =
      this.cfg.claude.systemPromptPreset === "claude_code"
        ? { type: "preset" as const, preset: "claude_code" as const, append: persona }
        : persona;

    this.q = query({
      prompt: this.input,
      options: {
        model: this.cfg.claude.model,
        systemPrompt,
        mcpServers: { jarvis: mcpServer, ...externalMcpServers },
        // allowedTools is deliberately NOT set. A bare tool name there is an
        // unconditional pre-approval that short-circuits canUseTool entirely —
        // the SDK warns CAN_USE_TOOL_SHADOWED and the risk gate silently never
        // runs. Leaving it unset makes every call fall through to the gate.
        permissionMode: "default",
        canUseTool: this.gate.bind(this),
        cwd: this.cfg.control.workingDir,
        // `maxSteps` is not an option this SDK has ever had — the field name is
        // `maxTurns`. The `as any` below meant TypeScript never said so, and the
        // cap silently did nothing for as long as it has been here.
        maxTurns: this.limits.maxIterations ?? LOOP_CAPS.claude.maxTurns,
        // Text fragments as the model writes them, so the voice can start on
        // the first sentence. The complete assistant message still follows.
        includePartialMessages: true,
      } as any,
    });

    const generation = ++this.sessionGeneration;
    this.consume(generation).catch((err) => {
      if (generation === this.sessionGeneration) this.emitEvent("error", friendlyError(err));
    });
  }

  /**
   * Every tool call passes through here before it runs. Low and medium risk
   * proceed; high risk is snapshotted and then put to the user out loud, and
   * only runs on an explicit yes.
   */
  /**
   * The SDK's permission hook.
   *
   * Still wired up, but it is no longer the only defence: it covers the SDK's
   * OWN built-in tools (Bash, Read, Write, Edit, WebFetch), which never pass
   * through Jarvis's MCP handlers. Jarvis's own tools are gated in the handler
   * instead, because this hook is not called for them. The shared decision
   * function dedupes, so an action seen by both layers is only asked about
   * once.
   */
  private async gate(
    toolName: string,
    input: Record<string, unknown>,
    _options: { signal: AbortSignal }
  ): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
    const decision = await decide(toolName, input, {
      workingDir: this.cfg.control.workingDir,
      emit: (e, p) => this.emitEvent(e as any, p),
    });
    if (!decision.allowed) {
      return { behavior: "deny", message: decision.message ?? DENIAL_MESSAGE };
    }
    return { behavior: "allow", updatedInput: input };
  }

  /**
   * The logger for the turn happening RIGHT NOW.
   *
   * Not captured once, because `consume()` is started on the first message and
   * then runs for the whole session, while a logger is created per turn. Holding
   * the first one meant every turn after the first wrote nothing at all — the
   * run log showed 83 turns for the first message and zero for the next five,
   * and each of those closed as `unknown_fallthrough`. The iteration counter
   * resets with the logger, since it counts within a turn.
   */
  /** How the current turn arrived; shapes the reply for the ear when spoken. */
  private lastSend: SendOptions = {};
  /** Text of the block currently streaming in, for `textDone`. */
  private deltaText = "";
  private loggerRunId: string | null = null;
  private iteration = 0;

  private log() {
    const current = currentLoop();
    if (current && current.runId !== this.loggerRunId) {
      this.loggerRunId = current.runId;
      this.iteration = 0;
    }
    return current;
  }

  private async consume(generation: number) {
    let sawResult = false;
    try {
      this.log()?.enterState("awaiting_llm", `claude:${this.cfg.claude.model}`);
      for await (const msg of this.q as AsyncIterable<any>) {
        if (generation !== this.sessionGeneration) return;
        if (msg.type === "stream_event") {
          // Only the top-level reply is spoken; a subagent's stream is not.
          if (msg.parent_tool_use_id) continue;
          const ev = msg.event ?? {};
          if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
            this.deltaText = "";
          } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            this.deltaText += ev.delta.text;
            this.emitEvent("textDelta", { text: ev.delta.text, turnId: this.lastSend.turnId });
          } else if (ev.type === "content_block_stop" && this.deltaText) {
            this.emitEvent("textDone", { text: this.deltaText, turnId: this.lastSend.turnId });
            this.deltaText = "";
          }
          continue;
        }
        if (msg.type === "assistant") {
          const blocks = msg.message?.content ?? [];
          let sawTool = false;
          const toolNames: string[] = [];
          for (const b of blocks) {
            if (b.type === "text" && b.text?.trim()) {
              this.emitEvent("text", b.text.trim());
            } else if (b.type === "tool_use") {
              sawTool = true;
              toolNames.push(String(b.name));
              this.emitEvent("tool", { name: b.name, summary: summarize(b.name, b.input) });
            }
          }
          const log = this.log();
          log?.iterationStart(this.iteration, blocks.length, 0);
          this.iteration++;
          // The loop itself lives inside the SDK, so everything here is derived
          // from the message stream rather than measured. Marked approximate so
          // a reader does not mistake it for the fidelity the other two give.
          log?.turnEnd({
            iteration: this.iteration,
            provider: "claude",
            model: this.cfg.claude.model,
            finishReason: sawTool ? "tool_calls" : "stop",
            rawFinishReason: msg.message?.stop_reason ?? null,
            toolCallCount: toolNames.length,
            toolNames,
            promptTokens: msg.message?.usage?.input_tokens ?? null,
            completionTokens: msg.message?.usage?.output_tokens ?? null,
            totalContextTokens: null,
            latencyMs: 0,
            cacheHit: msg.message?.usage?.cache_read_input_tokens ? true : null,
            approximate: true,
          } as any);
          log?.enterState(sawTool ? "awaiting_tool" : "awaiting_llm", toolNames[0] ?? `claude:${this.cfg.claude.model}`);
          this.emitEvent("status", sawTool ? "acting" : "thinking");
        } else if (msg.type === "result") {
          sawResult = true;
          // Every one of these was being thrown away. `terminal_reason` is the
          // SDK telling us, in its own words, that it stopped for a structural
          // reason — a turn cap, a context overflow, a blocking rate limit —
          // and `is_error` is false for several of them, so the turn read as a
          // clean success and Echo said nothing at all.
          const terminal = msg.terminal_reason ?? msg.subtype;
          const mapped = claudeTerminalToExit(terminal);
          const reason: ExitReason = mapped ?? (msg.is_error ? "provider_error" : "completed");

          if (msg.is_error) {
            this.emitEvent("error", friendlyError(msg.result ?? (msg.errors ?? []).join("; ") ?? `turn ended: ${msg.subtype}`));
          } else if (reason !== "completed") {
            this.emitEvent("text", explainTerminal(String(terminal), this.limits.maxIterations ?? LOOP_CAPS.claude.maxTurns));
          }

          this.log()?.exit(reason, {
            iteration: Number(msg.num_turns ?? this.iteration),
            finishReason: normalizeClaudeFinish(terminal),
            rawFinishReason: terminal,
            promptTokens: msg.usage?.input_tokens ?? null,
            completionTokens: msg.usage?.output_tokens ?? null,
            detail: `subtype=${msg.subtype} terminal_reason=${terminal ?? "none"} is_error=${msg.is_error}`,
            permissionDenials: (msg.permission_denials ?? []).length,
          });

          this.emitEvent("turnEnd");
          this.emitEvent("status", "idle");
        }
      }
      // The stream ended without a result message: the CLI subprocess died, the
      // pipe closed, or auth dropped. This is the path that used to end a run
      // with nothing said, nothing logged, and the HUD quietly back to idle.
      if (!sawResult) {
        this.emitEvent(
          "text",
          "My connection to the model closed before that finished. I'm restarting the session from the checkpoint."
        );
        this.log()?.exit("stream_closed", { iteration: this.iteration, detail: "SDK stream ended without a result message" });
      }
    } catch (err: any) {
      const reason = classifyProviderError(err);
      this.log()?.exit(reason, { iteration: this.iteration, error: err });
      throw err;
    } finally {
      if (generation !== this.sessionGeneration) return;
      // The underlying CLI process has exited (crash, auth failure, or a clean
      // end of stream). Reset so the NEXT message starts a fresh session —
      // otherwise every later send would queue into a stream nobody reads and
      // Jarvis would look permanently deaf until the app was restarted.
      this.started = false;
      this.q = null;
      this.input = new Pushable<SDKUserMessage>();
      this.log()?.exit("unknown_fallthrough", {
        iteration: this.iteration,
        detail: "consume() unwound without naming an exit",
      });
      this.log()?.enterState("idle");
      this.emitEvent("status", "idle");
    }
  }

  send(userText: string, _audio?: AudioTurn, opts?: SendOptions) {
    this.lastSend = opts ?? {};
    if (this.memory.begin(userText, opts)) this.resetSession();
    if (!this.started) this.start();
    this.emitEvent("status", "thinking");

    // How the user is doing changes how a reply should read, and it changes
    // between turns — so it rides along with each message rather than being
    // baked into the system prompt at startup, which would freeze whatever was
    // true when Jarvis launched. It is silent in the ordinary case: a fresh
    // state contributes nothing at all.
    noteActivity();
    const style = styleFor(assess());
    const spoken = opts?.modality === "voice" ? `${userText}\n\n${VOICE_TURN_CONTRACT}` : userText;
    const content = `${style ? `${spoken}\n\n[context: ${style}]` : spoken}\n\n${this.memory.packet()}`;

    this.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    });
  }

  private resetSession(): void {
    this.sessionGeneration++;
    try { this.q?.interrupt?.(); } catch { /* already closed */ }
    this.input.end();
    this.input = new Pushable<SDKUserMessage>();
    this.q = null;
    this.started = false;
  }

  invalidateMemory(): void {
    this.memory.invalidate();
    this.resetSession();
  }

  interrupt() {
    try {
      this.q?.interrupt?.();
    } catch (err) {
      console.error("[jarvis] interrupt failed:", (err as any)?.message ?? err);
    }
    currentLoop()?.exit("abort_signal", { detail: "user interrupted" });
    this.emitEvent("status", "idle");
  }

  async stop() {
    this.memory.close();
    try {
      this.q?.interrupt?.();
    } catch (err) {
      console.error("[jarvis] stop failed:", (err as any)?.message ?? err);
    }
    currentLoop()?.exit("abort_signal", { detail: "brain stopped" });
    this.input.end();
  }
}
