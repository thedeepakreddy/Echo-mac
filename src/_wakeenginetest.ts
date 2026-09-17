/**
 * The acoustic wake-word engines, fed real synthesised audio.
 *
 *   npm run wakeenginetest
 *
 * Part 1 validates the openWakeWord ONNX runtime against its own pre-trained
 * "hey jarvis" model (the only openWakeWord keyword we have until "Echo" is
 * trained): "hey jarvis" must score high, other phrases low. Part 2 scores the
 * built-in template spotter on "Echo" in voices it was NOT seeded from versus
 * other words, and reports where the threshold sits.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { OnnxWake } from "./voice/wake/onnx.js";
import { TemplateWake, type TemplateStore } from "./voice/wake/template.js";
import { makeVerifier } from "./voice/wake/index.js";
import { loadConfig } from "./config.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODELS = join(ROOT, "models", "wake");
const cfg = loadConfig(ROOT);
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

/** Speak to 16 kHz mono, padded with a second of silence either side so the stream has context. */
async function synth(text: string, voice: string, rate = 190): Promise<Int16Array> {
  const aiff = join(tmpdir(), `wet-${Date.now()}-${Math.random().toString(36).slice(2)}.aiff`);
  const wav = aiff.replace(/\.aiff$/, ".wav");
  await run("/usr/bin/say", ["-v", voice, "-r", String(rate), "-o", aiff, text]);
  await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const s = readWav16k(wav);
  try { unlinkSync(aiff); unlinkSync(wav); } catch { /* ignore */ }
  const pad = 16000;
  const out = new Int16Array(s.length + pad * 2);
  out.set(s, pad);
  return out;
}

function feed(det: { process(f: Int16Array, at: number): any; reset(): void }, samples: Int16Array): { fired: boolean; at: number } {
  det.reset();
  let at = 0;
  for (let off = 0; off + 512 <= samples.length; off += 512) {
    const d = det.process(samples.subarray(off, off + 512), at);
    if (d) return { fired: true, at };
    at += 32;
  }
  return { fired: false, at };
}

// ---- Part 1: openWakeWord runtime --------------------------------------------
console.log("\nWake engines — real audio\n\n  openWakeWord ONNX runtime (hey_jarvis_v0.1)");
const hj = join(MODELS, "hey_jarvis_v0.1.onnx");
const onnx = existsSync(hj) ? await OnnxWake.load(hj, MODELS, 0.5) : null;
if (!onnx) {
  console.log("  (skipped: models/wake/hey_jarvis_v0.1.onnx or the feature models are missing)");
} else {
  // The engine steps asynchronously; give each clip's inferences time to land.
  const scoreClip = async (samples: Int16Array): Promise<{ max: number; fired: boolean }> => {
    onnx.reset();
    let max = 0, fired = false;
    for (let off = 0; off + 512 <= samples.length; off += 512) {
      const d = onnx.process(samples.subarray(off, off + 512), off / 16);
      if (d) fired = true;
      // let the 80 ms step run: onnx is async
      await new Promise((r) => setImmediate(r));
      if (onnx.score > max) max = onnx.score;
    }
    await new Promise((r) => setTimeout(r, 50));
    if (onnx.score > max) max = onnx.score;
    return { max, fired };
  };
  for (const voice of ["Samantha", "Daniel", "Rishi"]) {
    const pos = await scoreClip(await synth("Hey Jarvis", voice));
    ok(pos.max >= 0.5, `"Hey Jarvis" (${voice}) scores ${pos.max.toFixed(2)} — fires: ${pos.fired}`);
  }
  for (const [text, voice] of [["Open Safari", "Samantha"], ["What time is it", "Daniel"], ["Hey Siri", "Rishi"]] as const) {
    const neg = await scoreClip(await synth(text, voice));
    ok(neg.max < 0.5, `"${text}" (${voice}) scores ${neg.max.toFixed(2)} — stays quiet`);
  }
  onnx.release();
}

// ---- Part 2: built-in template spotter ---------------------------------------
console.log("\n  template spotter (models/wake/templates.json)");
const storePath = join(MODELS, "templates.json");
if (!existsSync(storePath)) {
  console.log("  (skipped: run `npm run enroll -- --seed` first)");
} else {
  const store = JSON.parse(readFileSync(storePath, "utf8")) as TemplateStore;
  // Hold out two voices entirely: the spotter must generalise to voices it never saw.
  const holdout = ["Samantha", "Rishi"];
  const reduced: TemplateStore = { ...store, templates: store.templates.filter((t) => !holdout.some((v) => t.name.startsWith(v + ":"))) };
  const det = new TemplateWake(reduced, store.threshold);
  console.log(`  ${det.templateCount} templates in play, threshold ${store.threshold}`);
  const posCosts: number[] = [];
  for (const voice of holdout) {
    for (const text of ["Echo", "Hey Echo", "Echo, what's on my screen?"]) {
      const c = TemplateWake.scoreClip(det, await synth(text, voice));
      posCosts.push(c);
      ok(c <= store.threshold, `"${text}" (${voice}, unseen) cost ${c.toFixed(2)} — detected`);
    }
  }
  // Stage two: a DTW candidate is only a candidate. The verifier (whisper on
  // the last second) makes the decision, so precision is measured after it.
  const verify = makeVerifier(cfg);
  const negCosts: number[] = [];
  let candidates = 0;
  for (const [text, voice] of [["Hello there", "Samantha"], ["Open Safari", "Rishi"], ["Taco", "Daniel"], ["What time is it", "Karen"], ["Let's go", "Moira"]] as const) {
    const clip = await synth(text, voice);
    const c = TemplateWake.scoreClip(det, clip);
    negCosts.push(c);
    if (c > store.threshold) {
      ok(true, `"${text}" (${voice}) cost ${c.toFixed(2)} — ignored by the spotter`);
      continue;
    }
    candidates++;
    const frames: Int16Array[] = [];
    for (let off = 0; off + 512 <= clip.length; off += 512) frames.push(clip.subarray(off, off + 512));
    const accepted = await verify(frames);
    ok(!accepted, `"${text}" (${voice}) cost ${c.toFixed(2)} — candidate, ${accepted ? "WRONGLY accepted" : "rejected"} by whisper`);
  }
  // And the verifier must not reject the real thing. It sees what the listener
  // holds at detection time: the pre-roll ending at the frame the word ended in.
  {
    const clip = await synth("Echo, open Safari", "Samantha");
    const hit = feed(det, clip);
    const endFrame = Math.floor(hit.at / 32) + 1;
    const frames: Int16Array[] = [];
    for (let i = Math.max(0, endFrame - 24); i < endFrame; i++) frames.push(clip.subarray(i * 512, i * 512 + 512));
    ok(hit.fired && (await verify(frames)), `verifier accepts a real "Echo" (window ending at ${hit.at} ms)`);
  }
  const live = feed(det, await synth("Echo, open Safari", "Samantha"));
  ok(live.fired, `streaming: "Echo, open Safari" fires${live.fired ? ` at ${live.at} ms into the clip` : ""}`);
  console.log(`  positives ${posCosts.map((c) => c.toFixed(1)).join(" ")} | negatives ${negCosts.map((c) => c.toFixed(1)).join(" ")} | ${candidates} negative(s) needed the verifier`);
}

console.log(`\n${pass}/${pass + fail} wake-engine cases passed\n`);
process.exit(fail ? 1 : 0);
