/**
 * Streaming STT against the live Sarvam realtime endpoint, with one
 * synthesised clip. Prints partials as they arrive and the time from "last
 * audio sent" to the final transcript — the number the file-based path cannot
 * beat.
 *
 *   npm run sttstreamtest
 */
import { execFile } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { loadConfig } from "./config.js";
import { loadEnv } from "./env.js";
import { createSttStream } from "./voice/stt-stream.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
loadEnv(ROOT);
const cfg = loadConfig(ROOT);

function readWav16k(path: string): Int16Array {
  const buf = readFileSync(path);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return new Int16Array(buf.buffer.slice(buf.byteOffset + off + 8, buf.byteOffset + off + 8 + size - (size % 2)));
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const text = process.argv[2] ?? "Echo, what's on my screen right now?";
const aiff = join(tmpdir(), `stts-${Date.now()}.aiff`);
const wav = aiff.replace(/\.aiff$/, ".wav");
await run("/usr/bin/say", ["-v", "Samantha", "-o", aiff, text]);
await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
const samples = readWav16k(wav);
try { unlinkSync(aiff); unlinkSync(wav); } catch { /* ignore */ }

const stream = createSttStream({ ...cfg, voice: { ...cfg.voice, sttProvider: "sarvam", sttStreaming: true } });
if (!stream) {
  console.log("no stream: set SARVAM_API_KEY and voice.sttProvider=sarvam");
  process.exit(1);
}
const t0 = performance.now();
stream.on("partial", (p: string) => console.log(`  partial +${Math.round(performance.now() - t0)}ms: ${JSON.stringify(p)}`));
stream.on("final", (f: string) => console.log(`  final   +${Math.round(performance.now() - t0)}ms: ${JSON.stringify(f)}`));
stream.on("error", (e: string) => console.log(`  error: ${e}`));

console.log(`\nSarvam realtime STT — "${text}" (${(samples.length / 16000).toFixed(2)}s of audio)\n`);
await stream.start([]);
console.log(`  connected +${Math.round(performance.now() - t0)}ms`);
// Real time: 512 samples every 32 ms, as the microphone would deliver them.
for (let off = 0; off + 512 <= samples.length; off += 512) {
  stream.push(samples.subarray(off, off + 512));
  await new Promise((r) => setTimeout(r, 32));
}
const tEnd = performance.now();
console.log(`  last audio sent +${Math.round(tEnd - t0)}ms — ending`);
const final = await stream.end();
const dt = Math.round(performance.now() - tEnd);
console.log(`\n  FINAL after end-of-audio: ${dt} ms -> ${JSON.stringify(final)}\n`);
process.exit(final && /screen/i.test(final) ? 0 : 1);
