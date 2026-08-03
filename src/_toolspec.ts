/**
 * Freeze the tool vocabulary DeepakLLM speaks.
 *   npm run toolspec
 *
 * A fine-tuned model does not learn tools in general — it learns THESE names,
 * with THESE argument shapes, and it will keep emitting them long after the
 * project that defined them is gone. Anything reusing the model therefore needs
 * the vocabulary as data, not as an import from Jarvis's source tree.
 *
 * Written into deepakllm/ so the folder can be carried away whole.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TOOLS } from "./tools/registry.js";

const OUT_DIR = join(process.cwd(), "deepakllm");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const tools = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  readOnly: t.readOnly,
  // JSON Schema rather than Zod: every runtime can read it, and it is the shape
  // Ollama, OpenAI-compatible servers and most trainers already expect.
  parameters: z.toJSONSchema(z.object(t.schema), { io: "input" }),
}));

const spec = {
  name: "deepakllm-tools",
  version: 1,
  generatedAt: new Date().toISOString(),
  note:
    "The tool vocabulary DeepakLLM was trained on. A project reusing the model must expose these exact names, or translate them — the model will emit these regardless of what the host calls its own tools.",
  count: tools.length,
  tools,
};

const out = join(OUT_DIR, "tools.json");
writeFileSync(out, JSON.stringify(spec, null, 2) + "\n", "utf8");

const readOnly = tools.filter((t) => t.readOnly).length;
console.log(`\nWrote ${tools.length} tool definitions to ${out}`);
console.log(`  ${readOnly} read-only, ${tools.length - readOnly} that can change something`);
console.log(`  ${(JSON.stringify(spec).length / 1024).toFixed(0)}KB\n`);
