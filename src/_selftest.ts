// Safe plumbing check: wiring only, no autonomous control, no API calls.
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { TOOLS } from "./tools/registry.js";
import { GeminiBrain } from "./brain/gemini.js";
import { getScreenInfo, captureScreen } from "./tools/computer-actions.js";
import { transcribe, stopSttServer } from "./voice/stt.js";
import { loadConfig } from "./config.js";
import { loadEnv } from "./env.js";
import { join } from "node:path";

async function main() {
  const root = process.cwd();
  let ok = 0;
  const fail = (m: string) => {
    console.log("  ✗", m);
  };
  const pass = (m: string) => {
    ok++;
    console.log("  ✓", m);
  };

  console.log("1) Claude in-process MCP server builds from the tool registry");
  try {
    const sdkTools = TOOLS.map((t) =>
      tool(t.name, t.description, t.schema, async () => ({ content: [{ type: "text", text: "ok" }] }))
    );
    const server = createSdkMcpServer({ name: "jarvis", version: "1.0.0", tools: sdkTools });
    if (server && sdkTools.length === TOOLS.length) pass(`${sdkTools.length} tools registered`);
    else fail("server did not build");
  } catch (e: any) {
    fail(e.message);
  }

  console.log("2) Gemini function declarations convert from Zod schemas");
  try {
    const g = new GeminiBrain(loadConfig(root), "fake-key-not-used");
    const decls = (g as any).functionDeclarations;
    const click = decls.find((d: any) => d.name === "click");
    const btnEnum = click?.parameters?.properties?.button?.enum;
    if (decls.length === TOOLS.length && Array.isArray(btnEnum) && btnEnum.includes("double"))
      pass(`${decls.length} declarations, enum + required inferred`);
    else fail("declaration conversion incomplete");
  } catch (e: any) {
    fail(e.message);
  }

  console.log("3) Screen geometry (AppleScript)");
  try {
    const s = await getScreenInfo(true);
    if (s.width > 0 && s.height > 0) pass(`logical screen ${s.width}x${s.height}`);
    else fail("no screen size");
  } catch (e: any) {
    fail(e.message);
  }

  console.log("4) Screen capture -> logical-resolution PNG (needs Screen Recording perm)");
  try {
    const shot = await captureScreen();
    if (shot.data.length > 1000 && shot.width > 0) pass(`captured ${shot.width}x${shot.height}, ${Math.round(shot.data.length / 1024)}KB base64`);
    else fail("empty capture");
  } catch (e: any) {
    fail(`capture failed (likely a permission prompt): ${e.message}`);
  }

  console.log("5) STT on the bundled sample (jfk.wav)");
  try {
    const cfg = loadConfig(root);
    // A cloud sttProvider needs its key, and the app itself only loads .env at
    // startup — without this the check fails on a missing key rather than on
    // anything about speech.
    loadEnv(root);
    const sample = "/opt/homebrew/share/whisper-cpp/jfk.wav";
    const text = await transcribe(sample, cfg);
    if (/country/i.test(text)) pass(`transcribed: "${text.slice(0, 60)}…"`);
    else fail(`unexpected transcript: "${text}"`);
  } catch (e: any) {
    fail(e.message);
  }

  console.log(`\n${ok}/5 checks passed`);

  // Transcribing starts a whisper server that keeps the model resident. Without
  // shutting it down the process never exits, so this test hangs forever after
  // reporting success — which silently blocks anything chained after it.
  stopSttServer();
  process.exit(ok === 5 ? 0 : 1);
}

main();
