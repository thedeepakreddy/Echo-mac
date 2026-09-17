/**
 * Streaming TTS against the live provider: one short sentence, measure the
 * time to the first audio bytes and to the last.
 *
 *   npm run ttsstreamtest            # the configured engine
 *   npm run ttsstreamtest -- sarvam  # a specific one
 */
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { loadConfig } from "./config.js";
import { loadEnv } from "./env.js";
import { createTtsStream } from "./voice/tts-stream.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
loadEnv(ROOT);
const cfg = loadConfig(ROOT);
const engine = (process.argv[2] as any) ?? cfg.voice.ttsEngine;
const text = process.argv[3] ?? "Sure. Your screen shows the Echo project open in the editor.";

const stream = createTtsStream({ ...cfg, voice: { ...cfg.voice, ttsEngine: engine, ttsStreaming: true, ttsEnabled: true } }, text);
if (!stream) {
  console.log(`no stream for engine ${engine}`);
  process.exit(1);
}
console.log(`\nStreaming TTS — ${stream.name} — "${text}"\n`);
const t0 = performance.now();
let first = -1, bytes = 0, chunks = 0;
stream.on("audio", (a: { pcm: Buffer; sentence: number }) => {
  if (first < 0) {
    first = performance.now() - t0;
    console.log(`  first audio +${Math.round(first)}ms (${a.pcm.length} bytes, sentence ${a.sentence})`);
  }
  bytes += a.pcm.length;
  chunks++;
});
stream.on("error", (e: string) => console.log(`  error: ${e}`));
await stream.open();
console.log(`  connected +${Math.round(performance.now() - t0)}ms`);
const sentences = text.split(/(?<=[.!?])\s+/);
sentences.forEach((s, i) => stream.speak(s, i));
await stream.close();
const total = performance.now() - t0;
console.log(`  done +${Math.round(total)}ms — ${chunks} chunk(s), ${bytes} bytes = ${(bytes / 2 / stream.sampleRate).toFixed(2)}s of audio at ${stream.sampleRate} Hz\n`);
process.exit(bytes > 1000 ? 0 : 1);
