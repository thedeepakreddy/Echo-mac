import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Brain, JARVIS_PERSONA } from "./types.js";
import { Pushable } from "./pushable.js";
import { recallForPrompt } from "../memory/recall.js";
import { TOOLS } from "../tools/registry.js";
import { classify, bareToolName } from "../safety/risk.js";
import { capture } from "../safety/snapshot.js";
import { confirmations } from "../safety/confirm.js";
import { observeAction } from "../frontier/observe.js";
import { runGated, decide, DENIAL_MESSAGE } from "../safety/gate.js";
import { assess, styleFor, noteActivity } from "../frontier/struggle.js";
import type { JarvisConfig } from "../config.js";

type SDKUserMessage = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
};

/** Turn raw SDK/CLI failures into something a spoken assistant can usefully say. */
function friendlyError(err: any): string {
  const msg = String(err?.message ?? err ?? "");
  if (/invalid api key|please run \/login|not logged in|unauthorized|401/i.test(msg)) {
    return "I'm not logged in yet. Run `npm run login` in the Jarvis folder, sign in, then restart me.";
  }
  if (/exited with code 1/i.test(msg)) {
    return "My brain failed to start — usually login. Run `npm run login`, then restart me.";
  }
  if (/rate limit|429/i.test(msg)) return "I've hit a rate limit. Give me a moment.";
  if (/ENOENT|not found/i.test(msg)) return `A required program is missing: ${msg}`;
  return msg || "Something went wrong.";
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
  } catch {
    /* ignore */
  }
  return short;
}

export class ClaudeBrain extends Brain {
  private input = new Pushable<SDKUserMessage>();
  private q: any = null;
  private started = false;
  /** Project whose memories are loaded when the session starts. */
  projectHint: string | undefined;

  constructor(private cfg: JarvisConfig) {
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
          const content: any[] = [];
          if (out.text) content.push({ type: "text", text: out.text });
          if (out.image)
            content.push({ type: "image", data: out.image.data, mimeType: out.image.mimeType });
          if (!content.length) content.push({ type: "text", text: "done" });
          return { content };
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

    // Load what Jarvis remembers about this project. Read synchronously: the
    // file is small and local, and the first turn must not start without it.
    let persona = JARVIS_PERSONA;
    try {
      const memories = recallForPrompt(this.projectHint);
      if (memories) persona = `${persona}\n\n${memories}`;
    } catch (err) {
      console.error("[jarvis] memory recall failed:", err);
    }

    const systemPrompt =
      this.cfg.claude.systemPromptPreset === "claude_code"
        ? { type: "preset" as const, preset: "claude_code" as const, append: persona }
        : persona;

    this.q = query({
      prompt: this.input,
      options: {
        model: this.cfg.claude.model,
        systemPrompt,
        mcpServers: { jarvis: mcpServer },
        // allowedTools is deliberately NOT set. A bare tool name there is an
        // unconditional pre-approval that short-circuits canUseTool entirely —
        // the SDK warns CAN_USE_TOOL_SHADOWED and the risk gate silently never
        // runs. Leaving it unset makes every call fall through to the gate.
        permissionMode: "default",
        canUseTool: this.gate.bind(this),
        cwd: this.cfg.control.workingDir,
        maxSteps: 150,
      } as any,
    });

    this.consume().catch((err) => this.emitEvent("error", friendlyError(err)));
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

  private async consume() {
    try {
      for await (const msg of this.q as AsyncIterable<any>) {
        if (msg.type === "assistant") {
          const blocks = msg.message?.content ?? [];
          let sawTool = false;
          for (const b of blocks) {
            if (b.type === "text" && b.text?.trim()) {
              this.emitEvent("text", b.text.trim());
            } else if (b.type === "tool_use") {
              sawTool = true;
              this.emitEvent("tool", { name: b.name, summary: summarize(b.name, b.input) });
            }
          }
          this.emitEvent("status", sawTool ? "acting" : "thinking");
        } else if (msg.type === "result") {
          if (msg.is_error) {
            this.emitEvent("error", friendlyError(msg.result ?? `turn ended: ${msg.subtype}`));
          }
          this.emitEvent("turnEnd");
          this.emitEvent("status", "idle");
        }
      }
    } finally {
      // The underlying CLI process has exited (crash, auth failure, or a clean
      // end of stream). Reset so the NEXT message starts a fresh session —
      // otherwise every later send would queue into a stream nobody reads and
      // Jarvis would look permanently deaf until the app was restarted.
      this.started = false;
      this.q = null;
      this.input = new Pushable<SDKUserMessage>();
      this.emitEvent("status", "idle");
    }
  }

  send(userText: string) {
    if (!this.started) this.start();
    this.emitEvent("status", "thinking");

    // How the user is doing changes how a reply should read, and it changes
    // between turns — so it rides along with each message rather than being
    // baked into the system prompt at startup, which would freeze whatever was
    // true when Jarvis launched. It is silent in the ordinary case: a fresh
    // state contributes nothing at all.
    noteActivity();
    const style = styleFor(assess());
    const content = style ? `${userText}\n\n[context: ${style}]` : userText;

    this.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    });
  }

  interrupt() {
    try {
      this.q?.interrupt?.();
    } catch {
      /* ignore */
    }
    this.emitEvent("status", "idle");
  }

  async stop() {
    try {
      this.q?.interrupt?.();
    } catch {
      /* ignore */
    }
    this.input.end();
  }
}
