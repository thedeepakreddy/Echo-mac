/**
 * Every tool is reachable, gated, and named honestly.   npm run wiringtest
 *
 * A tool can be broken in four ways that all LOOK like the model being stupid:
 *
 *   1. It is in the registry but the provider rejects its schema, so the whole
 *      request 400s and the turn dies with no explanation.
 *   2. It is named in a prompt but does not exist, so the model calls a tool
 *      that errors — or worse, gives up and says nothing.
 *   3. It exists but no brain offers it, so it is dead weight nobody can call.
 *   4. It returns nothing at all, which reads to the model as "that did not
 *      work" and is the shape of every silent stop this project has had.
 *
 * None of these are caught by typechecking, and none of them raise an error
 * anywhere near the thing that is actually wrong.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { TOOLS, TOOL_MAP } from "./tools/registry.js";
import { JARVIS_PERSONA } from "./brain/types.js";
import { LOCAL_TOOL_NAMES, resolveToolName } from "./brain/localtools.js";
import { READ_ONLY, UI_ACTIONS, classify } from "./safety/risk.js";

let pass = 0;
const failures: string[] = [];
function ok(value: unknown, message: string): void {
  if (value) {
    pass++;
    console.log(`  ✓ ${message}`);
    return;
  }
  failures.push(message);
  console.log(`  ✗ ${message}`);
}

const names = new Set(TOOLS.map((t) => t.name));
console.log(`\nTool wiring — ${TOOLS.length} tools\n`);

console.log("  the registry itself");
{
  const dupes = TOOLS.map((t) => t.name).filter((n, i, all) => all.indexOf(n) !== i);
  ok(dupes.length === 0, `no duplicate tool names${dupes.length ? `: ${[...new Set(dupes)].join(", ")}` : ""}`);

  // Both providers accept [a-zA-Z0-9_-]{1,64}; Gemini additionally rejects a
  // leading digit. Staying inside the stricter set keeps one registry valid
  // for every brain.
  const badName = TOOLS.filter((t) => !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(t.name));
  ok(badName.length === 0, `every name is portable across providers${badName.length ? `: ${badName.map((t) => t.name).join(", ")}` : ""}`);

  const noDesc = TOOLS.filter((t) => !t.description?.trim() || t.description.trim().length < 20);
  ok(noDesc.length === 0, `every tool describes itself${noDesc.length ? `: ${noDesc.map((t) => t.name).join(", ")}` : ""}`);

  const noHandler = TOOLS.filter((t) => typeof t.handler !== "function");
  ok(noHandler.length === 0, `every tool has a handler${noHandler.length ? `: ${noHandler.map((t) => t.name).join(", ")}` : ""}`);

  // TOOL_MAP is how the Ollama loop dispatches. It was built halfway up the
  // file, above ten TOOLS.push() calls, so those ten were offered to the model
  // and then answered "No such tool" when called.
  const unmapped = TOOLS.filter((t) => !TOOL_MAP.has(t.name));
  ok(unmapped.length === 0,
    `every tool is dispatchable by name${unmapped.length ? `: ${unmapped.map((t) => t.name).join(", ")}` : ""}`);
  ok(TOOL_MAP.size === TOOLS.length, `the dispatch map covers the registry (${TOOL_MAP.size}/${TOOLS.length})`);
}

console.log("  provider schema conversion");
{
  const broken: string[] = [];
  const freeform: string[] = [];
  for (const tool of TOOLS) {
    try {
      const json: any = z.toJSONSchema(z.object(tool.schema), { io: "input" });
      for (const [field, node] of Object.entries<any>(json.properties ?? {})) {
        // An array with no item type is invalid for both providers.
        if (node?.type === "array" && !node.items) {
          broken.push(`${tool.name}.${field} (array with no item type)`);
        }
        // A z.record() becomes an OBJECT with no properties. Gemini's docs used
        // to require properties to be non-empty for OBJECT, and this is the
        // shape that 400s the WHOLE request — every tool with it, not just the
        // one. Checked against the run tapes rather than assumed: requests
        // carrying these declarations came back with responses and no errors,
        // so it is accepted today. Listed, not failed, so a future tightening
        // is visible here rather than as an unexplained dead turn.
        if (node?.type === "object" && !Object.keys(node.properties ?? {}).length) {
          freeform.push(`${tool.name}.${field}`);
        }
      }
    } catch (err: any) {
      broken.push(`${tool.name} (${err?.message ?? err})`);
    }
  }
  ok(broken.length === 0, `every schema converts to JSON Schema${broken.length ? `:\n      ${broken.join("\n      ")}` : ""}`);
  if (freeform.length) console.log(`      (free-form object params, accepted by Gemini today: ${freeform.join(", ")})`);
}

console.log("  prompts name tools that exist");
{
  // Anything in the persona shaped like a tool name. A prompt that promises a
  // tool the registry does not have is worse than not mentioning it: the model
  // calls it, gets an error it cannot act on, and often just stops.
  // Filenames and JSON keys are snake_case too; only tool-shaped words that are
  // not something else count.
  const NOT_TOOLS = new Set([
    "tool_calls", "long_term_memory", "e_c_h_o", "claude_code", "working_dir",
    "system_prompt", "api_key", "config_json", "shortcuts_json", "health_record",
    // The XML tag the memory packet arrives in, not a tool.
    "echo_context",
  ]);
  const mentioned = [...new Set(JARVIS_PERSONA.match(/\b[a-z][a-z0-9]*(?:_+[a-z0-9]+)+\b/g) ?? [])]
    .filter((word) => !NOT_TOOLS.has(word));
  // An mcp__ name comes from a server in mcp.json, not the registry, so it
  // cannot be resolved here — but it MUST carry the prefix, because that is the
  // name the brain registers it under. The persona used to promise Telugu
  // speech through `sarvam_tools_tts_speak`; the real tool is
  // `mcp__sarvam__sarvam_tools_tts_speak`, and the bare name answers
  // "unknown tool".
  const ghosts = mentioned.filter((word) => !names.has(word) && !word.startsWith("mcp__"));
  ok(ghosts.length === 0, `the persona names only real tools${ghosts.length ? `: ${ghosts.join(", ")}` : ""}`);
  const external = mentioned.filter((word) => word.startsWith("mcp__"));
  console.log(`      (${mentioned.length - ghosts.length - external.length} registry tools + ${external.length} MCP tools named in the persona)`);
}

console.log("  every way in answers a pending permission question");
{
  // main.ts is not otherwise testable, and this is a wiring fault that looks
  // exactly like the model being stupid: Echo asks "shall I send this?", the
  // answer arrives by a path that does not know a question is open, the answer
  // becomes a new command, the question times out as a refusal, and the model
  // asks again. Measured in a real session: three permission questions, every
  // typed answer lost. Pin all four entry points to the shared check.
  // The bundle runs from dist/, so reach back to the source tree.
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const entryPoints: Array<[string, RegExp]> = [
    ["the voice path", /confirmations\.isWaiting/],
    ["typing in the HUD", /ipcMain\.on\("send-text"[\s\S]{0,600}?maybeAnswerConfirmation/],
    ["the phone remote", /setCommandHandler\([\s\S]{0,400}?maybeAnswerConfirmation/],
    ["Telegram", /handleTelegramCommand[\s\S]{0,400}?maybeAnswerConfirmation/],
  ];
  for (const [what, pattern] of entryPoints) {
    ok(pattern.test(main), `${what} routes an answer to the waiting question`);
  }
  ok(/function maybeAnswerConfirmation[\s\S]{0,900}?ConfirmationBroker\.readAnswer/.test(main),
    "and they all share one reader, so yes means the same thing everywhere");
}

console.log("  the local model's short list");
{
  const missing = LOCAL_TOOL_NAMES.filter((name) => !names.has(name));
  // Drift here is silent by design: toolsForLocalModel falls back to ALL tools,
  // which is the exact condition that makes a 3B model invent names.
  ok(missing.length === 0, `every shortlisted tool exists${missing.length ? `: ${missing.join(", ")}` : ""}`);

  const offered = TOOLS.filter((t) => LOCAL_TOOL_NAMES.includes(t.name));
  ok(offered.length >= 10, `the shortlist survives the fallback threshold (${offered.length} offered)`);
}

console.log("  the risk gate knows these tools");
{
  // The SDK's own built-ins (Read, Bash, Write…) are named here too and are not
  // in Echo's registry, so only Echo-shaped names are checked for drift.
  const gateNames = [...READ_ONLY, ...UI_ACTIONS].filter((name) => /^[a-z][a-z0-9_]*$/.test(name));
  const stale = gateNames.filter((name) => !names.has(name));
  ok(stale.length === 0, `no risk rule names a tool that no longer exists${stale.length ? `: ${stale.join(", ")}` : ""}`);

  // Every tool that can change something must classify as more than low, or it
  // reaches the handler without anyone being asked.
  const unclassified = TOOLS.filter((t) =>
    t.readOnly === false && classify(t.name, {}, { workingDir: "/tmp" }).tier === "low"
  );
  console.log(`      (${unclassified.length} mutating tools classify as low risk${unclassified.length ? `: ${unclassified.map((t) => t.name).join(", ")}` : ""})`);
}

console.log("  name resolution for small models");
{
  ok(resolveToolName("screenshot") === "screenshot", "an exact name resolves to itself");
  ok(resolveToolName("update_hand_gesture_params") === "toggle_hand_gestures",
    "the observed invented name still maps to the real tool");
  ok(resolveToolName("") === null, "an empty name resolves to nothing");
}

console.log(`\n${pass}/${pass + failures.length} wiring checks passed\n`);
if (failures.length) {
  console.error(`${failures.length} problem(s):\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
