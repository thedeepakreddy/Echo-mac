/**
 * Apple on-device streaming recognition through native/speechhelper, fed a
 * synthesised clip in real time. Prompts for Speech Recognition permission
 * the first time.
 *
 *   npm run applestttest
 */
import { execFile } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { AppleSttStream } from "./voice/stt-stream.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
const aiff = join(tmpdir(), `apl-${Date.now()}.aiff`);
const wav = aiff.replace(/\.aiff$/, ".wav");
await run("/usr/bin/say", ["-v", "Samantha", "-o", aiff, text]);
await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
const samples = readWav16k(wav);
try { unlinkSync(aiff); unlinkSync(wav); } catch { /* ignore */ }

const stream = new AppleSttStream(join(ROOT, "native", "speechhelper"), "en-IN");
const t0 = performance.now();
stream.on("partial", (p: string) => console.log(`  partial +${Math.round(performance.now() - t0)}ms: ${JSON.stringify(p)}`));
stream.on("final", (f: string) => console.log(`  final   +${Math.round(performance.now() - t0)}ms: ${JSON.stringify(f)}`));
stream.on("error", (e: string) => console.log(`  error: ${e}`));
console.log(`\nApple on-device STT — "${text}"\n`);
await stream.start([]);
for (let off = 0; off + 512 <= samples.length; off += 512) {
  stream.push(samples.subarray(off, off + 512));
  await new Promise((r) => setTimeout(r, 32));
}
const tEnd = performance.now();
console.log(`  last audio +${Math.round(tEnd - t0)}ms — ending`);
const final = await stream.end();
console.log(`\n  FINAL after end-of-audio: ${Math.round(performance.now() - tEnd)} ms -> ${JSON.stringify(final)}\n`);
process.exit(final && /screen/i.test(final) ? 0 : 1);
