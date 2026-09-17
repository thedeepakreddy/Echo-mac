/**
 * Silero VAD on real audio: speech must read as speech, silence as silence,
 * and a frame must cost about a millisecond.
 *
 *   npm run vadtest
 */
import { execFile } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { SileroVad, VAD_START, VAD_CONTINUE } from "./voice/vad.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

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

console.log("\nSilero VAD\n");
const loaded = await SileroVad.load(join(ROOT, "models", "silero_vad.onnx"));
if (!loaded) {
  console.log("  ✗ models/silero_vad.onnx did not load");
  process.exit(1);
}
const vad: SileroVad = loaded;

const aiff = join(tmpdir(), `vad-${Date.now()}.aiff`);
const wav = aiff.replace(/\.aiff$/, ".wav");
await run("/usr/bin/say", ["-v", "Samantha", "-o", aiff, "Echo, open Safari and check my mail."]);
await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
const speech = readWav16k(wav);
try { unlinkSync(aiff); unlinkSync(wav); } catch { /* ignore */ }

// One second of silence, the sentence, one second of silence.
const pad = new Int16Array(16000);
const clip = new Int16Array(pad.length * 2 + speech.length);
clip.set(pad, 0);
clip.set(speech, pad.length);
// Quiet room noise instead of digital zero for the trailing pad.
for (let i = 0; i < pad.length; i++) clip[pad.length + speech.length + i] = Math.round((Math.random() - 0.5) * 60);

/** Run the stream frame by frame, letting the async model keep up. */
async function probs(samples: Int16Array): Promise<number[]> {
  vad.reset();
  const out: number[] = [];
  for (let off = 0; off + 512 <= samples.length; off += 512) {
    vad.process(samples.subarray(off, off + 512));
    await vad.settle();
    out.push(vad.peek());
  }
  return out;
}

const t0 = performance.now();
const p = await probs(clip);
const perFrame = (performance.now() - t0) / p.length;
const nLead = Math.floor(16000 / 512);
const lead = p.slice(2, nLead - 1);
const mid = p.slice(nLead + 2, nLead + Math.floor(speech.length / 512) - 2);
const tail = p.slice(p.length - nLead + 3);
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const frac = (a: number[], f: (x: number) => boolean) => a.filter(f).length / Math.max(1, a.length);

ok(mean(lead) < 0.1, `leading silence: mean prob ${mean(lead).toFixed(3)}`);
ok(frac(mid, (x) => x >= VAD_CONTINUE) > 0.7, `speech: ${(frac(mid, (x) => x >= VAD_CONTINUE) * 100).toFixed(0)}% of frames ≥ ${VAD_CONTINUE}`);
ok(mid.some((x) => x >= VAD_START), `speech clears the start threshold ${VAD_START} (peak ${Math.max(...mid).toFixed(2)})`);
ok(mean(tail) < 0.15, `trailing room noise: mean prob ${mean(tail).toFixed(3)}`);
ok(perFrame < 6, `cost per 32 ms frame: ${perFrame.toFixed(2)} ms (with test overhead)`);
const firstSpeech = p.findIndex((x) => x >= VAD_START);
ok(firstSpeech >= nLead - 2 && firstSpeech <= nLead + 8, `speech onset detected at frame ${firstSpeech} (audio starts at ${nLead})`);

vad.release();
console.log(`\n${pass}/${pass + fail} VAD cases passed\n`);
process.exit(fail ? 1 : 0);
