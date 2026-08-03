import { z } from "zod";
import { Brain, JARVIS_PERSONA } from "./types.js";
import { TOOLS, TOOL_MAP } from "../tools/registry.js";
import { recallForPrompt } from "../memory/recall.js";
import { classify, bareToolName } from "../safety/risk.js";
import { runGated } from "../safety/gate.js";
import { parseCallsFromText, resolveToolName, toolsForLocalModel } from "./localtools.js";
import { capture } from "../safety/snapshot.js";
import { confirmations } from "../safety/confirm.js";
import type { JarvisConfig } from "../config.js";

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
    private host = "http://localhost:11434"
  ) {
    super();
    let system = JARVIS_PERSONA + "\n\nCRITICAL: You are an autonomous agent. When asked to perform an action or look at the screen, you MUST invoke the provided tool natively. DO NOT output conversational text telling the user which tool to use. You must actually call the tool!";
    try {
      const mem = recallForPrompt();
      if (mem) system += `\n\n${mem}`;
    } catch {
      /* memory is best-effort */
    }
    this.messages.push({ role: "system", content: system });
  }

  send(userText: string) {
    this.messages.push({ role: "user", content: userText });
    if (!this.busy) void this.run();
  }

  interrupt() {
    this.aborted = true;
    this.emitEvent("status", "idle");
  }

  async stop() {
    this.aborted = true;
  }

  private async chat(): Promise<any> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.ollama?.model ?? "llama3.2:3b",
        messages: this.messages,
        tools: this.tools,
        stream: false,
        options: { temperature: 0.4 },
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private async run() {
    this.busy = true;
    this.aborted = false;
    this.emitEvent("status", "thinking");
    let hadError = false;
    try {
      for (let turn = 0; turn < 12 && !this.aborted; turn++) {
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

        // Only speak the content when it is prose, not a tool call it mislaid.
        if (msg.content?.trim() && !calls.length) this.emitEvent("text", msg.content.trim());

        if (!calls.length) break;

        this.emitEvent("status", "acting");
        for (const call of calls) {
          if (this.aborted) break;
          const called = call.function?.name;
          // "update_hand_gesture_params" is not a tool; "toggle_hand_gestures"
          // is. Small models guess names, and refusing outright would make the
          // local brain unusable when the intent was perfectly clear.
          const name = resolveToolName(called) ?? called;
          if (name !== called) console.log(`[ollama] "${called}" -> "${name}"`);
          const args = typeof call.function?.arguments === "string"
            ? safeParse(call.function.arguments)
            : (call.function?.arguments ?? {});
          const result = await this.invokeTool(name, args);
          this.messages.push({ role: "tool", content: result });
        }
      }
    } catch (err: any) {
      this.emitEvent("error", friendly(err));
      hadError = true;
    } finally {
      this.busy = false;
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
    return out.text ?? (out.image ? "[screenshot captured]" : "done");
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
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
