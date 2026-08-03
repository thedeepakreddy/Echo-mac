import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { Brain, JARVIS_PERSONA } from "./types.js";
import { TOOLS, ToolDef } from "../tools/registry.js";
import { runGated } from "../safety/gate.js";
import type { JarvisConfig } from "../config.js";

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

export class GeminiBrain extends Brain {
  private ai: GoogleGenAI;
  private contents: any[] = [];
  private functionDeclarations = TOOLS.map(toFunctionDeclaration);
  private busy = false;
  private aborted = false;

  constructor(private cfg: JarvisConfig, apiKey: string) {
    super();
    this.ai = new GoogleGenAI({ apiKey });
  }

  send(userText: string) {
    this.contents.push({ role: "user", parts: [{ text: userText }] });
    if (!this.busy) void this.runLoop();
  }

  private async runLoop() {
    this.busy = true;
    this.aborted = false;
    this.emitEvent("status", "thinking");
    try {
      const FALLBACK_MODELS = [
        "gemini-3.5-flash",
        "gemini-3.1-flash-lite",
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-1.5-pro"
      ];

      for (let i = 0; i < 150 && !this.aborted; i++) {
        let res;
        let attempt = 0;
        let currentModel = this.cfg.gemini.model;
        
        // Auto-fallback logic for quota exhaustion
        while (attempt < FALLBACK_MODELS.length) {
          try {
            res = await this.ai.models.generateContent({
              model: currentModel,
              contents: this.contents,
              config: {
                systemInstruction: JARVIS_PERSONA,
                tools: [{ functionDeclarations: this.functionDeclarations }],
              },
            });
            // If it succeeded, persist the successful model for the next turn
            this.cfg.gemini.model = currentModel;
            break;
          } catch (err: any) {
            const errStr = String(err?.message ?? err);
            const isQuota = errStr.includes("429") || errStr.includes("Quota exceeded") || errStr.includes("RESOURCE_EXHAUSTED");
            const isNotFound = errStr.includes("404") || errStr.includes("NOT_FOUND") || errStr.includes("no longer available");
            
            if (isQuota || isNotFound) {
              console.warn(`[gemini] Model ${currentModel} failed (${isQuota ? 'quota' : 'not found'})! Switching models...`);
              const idx = FALLBACK_MODELS.indexOf(currentModel);
              currentModel = FALLBACK_MODELS[idx + 1];
              if (!currentModel) {
                currentModel = FALLBACK_MODELS[0];
              }
              attempt++;
              if (attempt >= FALLBACK_MODELS.length) {
                throw new Error(`All Gemini fallback models exhausted or unavailable. Last error: ${errStr}`);
              }
            } else {
              throw err; // Bubble up other errors immediately
            }
          }
        }

        if (!res) throw new Error("No response generated from any model.");
        const content = res.candidates?.[0]?.content;
        if (!content) break;
        this.contents.push({ role: content.role || "model", parts: content.parts || [] });

        const parts = content.parts ?? [];
        const calls = parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall);
        for (const p of parts) {
          if (p.text?.trim()) this.emitEvent("text", p.text.trim());
        }

        if (!calls.length) break;

        this.emitEvent("status", "acting");
        const responseParts: any[] = [];
        for (const call of calls) {
          const tool = TOOLS.find((t) => t.name === call.name);
          if (!tool) {
            this.emitEvent("tool", { name: call.name, summary: call.name });
            responseParts.push({
              functionResponse: { name: call.name, response: { error: "unknown tool" } },
            });
            continue;
          }
          try {
            // Through the shared gate, exactly as the other brains are.
            //
            // This brain previously called handlers directly with no risk check
            // of any kind: switching to Gemini silently turned off every
            // confirmation, so `rm -rf` was a plain tool call. Nothing about
            // which model is answering should change what Jarvis is willing
            // to do.
            const out = await runGated(tool, call.args ?? {}, {
              workingDir: this.cfg.control.workingDir,
              emit: (e, p) => this.emitEvent(e as any, p),
            });
            responseParts.push({
              functionResponse: { name: call.name, response: { result: out.text ?? "done" } },
            });
            if (out.image) {
              responseParts.push({
                inlineData: { mimeType: out.image.mimeType, data: out.image.data },
              });
            }
          } catch (err: any) {
            responseParts.push({
              functionResponse: { name: call.name, response: { error: String(err?.message ?? err) } },
            });
          }
        }
        this.contents.push({ role: "user", parts: responseParts });
      }
    } catch (err: any) {
      this.emitEvent("error", String(err?.message ?? err));
    } finally {
      this.busy = false;
      this.emitEvent("turnEnd");
      this.emitEvent("status", "idle");
    }
  }

  interrupt() {
    this.aborted = true;
    this.emitEvent("status", "idle");
  }

  async stop() {
    this.aborted = true;
  }
}
