/**
 * Working example + smoke test for the DeepakLLM client.
 *
 *   node example.mjs                    # uses whatever model is installed
 *   node example.mjs deepakllm          # once you have trained one
 *
 * This is what using DeepakLLM in ANOTHER project looks like end to end: load
 * the vocabulary, hand the client an execute() that does the real work, run.
 * Nothing here imports Jarvis.
 */
import { DeepakLLM, loadTools, resolveToolName, parseCallsFromText } from "./deepakllm.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const model = process.argv[2] ?? "llama3.1:8b";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nDeepakLLM client\n");

console.log("  recovering a call the model wrote as prose");
const prose = 'Sure, I will do that: {"name":"open_app","arguments":{"name":"Safari"}}';
const recovered = parseCallsFromText(prose);
ok(recovered.length === 1, "a call embedded in prose is recovered");
ok(recovered[0]?.args?.name === "Safari", "with its arguments intact");
ok(parseCallsFromText("I cannot help with that.").length === 0, "plain prose yields nothing");

console.log("  mapping an invented name onto a real one");
const known = ["toggle_hand_gestures", "open_app", "screenshot", "click_ui_element"];
ok(resolveToolName("update_hand_gesture_params", known) === "toggle_hand_gestures", "the observed real failure resolves");
ok(resolveToolName("take_screenshot", known) === "screenshot", "a near-miss resolves");
ok(resolveToolName("open_app", known) === "open_app", "an exact name is unchanged");
ok(resolveToolName("launch_the_rockets", known) === null, "an unrelated name resolves to nothing");

console.log(`  driving a real model (${model})`);

// A small, focused list. Handing a 7B model all 95 definitions is what makes it
// invent names — the reason the resolver above exists.
const all = await loadTools(join(here, "..", "tools.json"));
const wanted = new Set(["open_app", "screenshot", "type_text"]);
const tools = all.filter((t) => wanted.has(t.function.name));
ok(tools.length === 3, `loaded ${tools.length} tool definitions from tools.json`);

const llm = new DeepakLLM({
  model,
  tools,
  system: "You control a Mac. Use the provided tools. Call open_app to open an application.",
});

const executed = [];
let liveRan = false;
try {
  const result = await llm.run("Open the Safari application.", {
    // In a real project this is where YOUR safety checks go. The model deciding
    // an action is fine is not the same as it being fine.
    execute: async (name, args) => {
      executed.push({ name, args });
      return `${name} ok`;
    },
    onStep: (s) => console.log(`      -> ${s.tool}(${JSON.stringify(s.args)})`),
  });
  liveRan = true;
  ok(executed.length > 0, `the model called ${executed.length} tool(s)`);
  ok(executed.some((e) => e.name === "open_app"), "it chose open_app for an 'open' request");
  ok(typeof result.text === "string", "a final reply came back");
} catch (err) {
  // Reported as SKIPPED, never as passed. A suite that goes green because its
  // only real integration check quietly failed to run is worse than no suite:
  // it is a false all-clear on the one thing tests cannot verify offline.
  console.log(`  ~ skipped — no model reachable (${err.message})`);
  console.log(`    warm it first:  ollama run ${model} "hi"`);
}

const label = liveRan ? "" : "  (live model check SKIPPED — offline checks only)";
console.log(`\n${pass}/${pass + fail} client checks passed${label}\n`);
process.exit(fail ? 1 : 0);
