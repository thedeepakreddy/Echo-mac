/**
 * End-to-end check of the real brain + real tools, without the GUI.
 *
 * Sends one READ-ONLY request through the actual ClaudeBrain: it must call the
 * screenshot tool, look at the screen, and describe it. This exercises auth,
 * MCP tool registration, image return, and the reply path — the whole spine.
 *
 *   npm run e2e
 */
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.js";
import { loadConfig } from "./config.js";
import { createBrain } from "./brain/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TIMEOUT_MS = 120000;

loadEnv(ROOT);
const cfg = loadConfig(ROOT);
console.log(`\nJ.A.R.V.I.S — end-to-end check  (brain=${cfg.brain})\n`);

const { brain, provider } = createBrain(cfg);
console.log(`  provider: ${provider}`);

const toolsUsed: string[] = [];
const errors: string[] = [];
let reply = "";

/** An API/runtime failure can arrive as assistant *text*, so treat it as an error. */
const looksLikeError = (s: string) =>
  /^API Error:|invalid_request_error|"type"\s*:\s*"error"/i.test(s.trim());

const gated: string[] = [];
brain.on("risk", (r: { tool: string; tier: string }) => {
  gated.push(`${r.tool}:${r.tier}`);
  console.log(`  · gate: ${r.tool} → ${r.tier}`);
});

brain.on("tool", (t: { name: string; summary: string }) => {
  toolsUsed.push(t.name);
  console.log(`  → tool: ${t.summary}`);
});
brain.on("text", (t: string) => {
  if (looksLikeError(t)) {
    errors.push(t);
    console.log(`  ✗ error (as text): ${t.slice(0, 160)}`);
    return;
  }
  reply += `${t}\n`;
  console.log(`  → says: ${t}`);
});
brain.on("error", (e: string) => {
  errors.push(e);
  console.log(`  ✗ error: ${String(e).slice(0, 160)}`);
});

const done = new Promise<void>((resolve) => {
  brain.on("turnEnd", () => resolve());
  setTimeout(() => resolve(), TIMEOUT_MS);
});

brain.send(
  "Take a screenshot and tell me in ONE short sentence which application is " +
    "currently in the foreground. Only look — do not click, type, or change anything."
);

await done;
await brain.stop();

const sawScreenshot = toolsUsed.some((t) => t.includes("screenshot"));
console.log("\n  ---");
console.log(`  tools called : ${toolsUsed.length ? toolsUsed.join(", ") : "(none)"}`);
console.log(`  screenshot   : ${sawScreenshot ? "yes" : "NO"}`);
console.log(`  replied      : ${reply.trim() ? "yes" : "NO"}`);
console.log(`  errors       : ${errors.length}`);
console.log(`  risk gate    : ${gated.length ? gated.join(", ") : "NEVER RAN"}`);

// The gate silently not running is the dangerous failure: the SDK pre-approves
// any tool named in allowedTools before canUseTool is consulted, so a safety
// layer can look fine while gating nothing at all.
if (gated.length === 0) {
  console.log("\n  FAIL — tools ran without passing through the risk gate.\n");
  process.exit(1);
}

if (sawScreenshot && reply.trim() && errors.length === 0) {
  console.log("\n  PASS — brain sees the screen, and every tool went through the gate.\n");
  process.exit(0);
}
console.log("\n  FAIL — see the output above.\n");
process.exit(1);
