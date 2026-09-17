/**
 * Teach the built-in wake-word spotter what "Echo" sounds like.
 *
 *   npm run enroll -- --seed       synthesise "Echo" in every English voice on
 *                                  this Mac and calibrate the threshold against
 *                                  words that are NOT the name
 *   npm run enroll                 record YOU saying "Echo" five times
 *   npm run enroll -- --name Mom   ...for someone else who talks to Echo
 *
 * Writes models/wake/templates.json. Seed first; then enroll each person who
 * uses the machine — the spotter is only as speaker-independent as its
 * examples, and thirty seconds per person buys most of the accuracy.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mfccFrames, FRAME_DIMS, cmn, dtwEndAligned, HOP, WINDOW } from "./voice/wake/mfcc.js";
import type { TemplateStore } from "./voice/wake/template.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STORE = join(ROOT, "models", "wake", "templates.json");
const args = process.argv.slice(2);
const seed = args.includes("--seed");
const who = args[args.indexOf("--name") + 1] && args.includes("--name") ? args[args.indexOf("--name") + 1] : process.env.USER ?? "user";

/** Words to say for positives, and words that must NOT match, for calibration. */
const POSITIVES = ["Echo", "Echo.", "Hey Echo", "Echo,"];
const NEGATIVES = ["Hello", "Okay", "Open Safari", "What time is it", "Taco", "Elbow", "Ever", "Let go", "Tempo", "Metro", "Alexa", "Hey Siri"];

function loadStore(): TemplateStore {
  if (existsSync(STORE)) {
    try {
      const s = JSON.parse(readFileSync(STORE, "utf8")) as TemplateStore;
      if (s.version === 1 && s.dims === FRAME_DIMS) return s;
    } catch {
      /* rebuild */
    }
  }
  return { version: 1, dims: FRAME_DIMS, threshold: 0, templates: [] };
}

function readWav16k(path: string): Int16Array {
  const buf = readFileSync(path);
  // Walk chunks to the data chunk; afconvert writes a canonical header but be safe.
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return new Int16Array(buf.buffer, buf.byteOffset + off + 8, Math.floor(size / 2));
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

/** Keep the spoken part: frames from the first to the last 10 ms slice above 8 % of the peak energy, with a little margin. */
function trimSilence(samples: Int16Array): Int16Array {
  const hop = HOP;
  const energies: number[] = [];
  for (let off = 0; off + WINDOW <= samples.length; off += hop) {
    let s = 0;
    for (let i = 0; i < WINDOW; i++) s += samples[off + i] * samples[off + i];
    energies.push(Math.sqrt(s / WINDOW));
  }
  const peak = Math.max(...energies);
  const gate = peak * 0.08;
  let first = energies.findIndex((e) => e > gate);
  let last = energies.length - 1 - [...energies].reverse().findIndex((e) => e > gate);
  if (first < 0) return samples;
  first = Math.max(0, first - 3);
  last = Math.min(energies.length - 1, last + 5);
  return samples.subarray(first * hop, Math.min(samples.length, last * hop + WINDOW));
}

function toFloat(s: Int16Array): Float32Array {
  const f = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
  return f;
}

async function synth(text: string, voice: string, rate: number): Promise<Int16Array> {
  const aiff = join(tmpdir(), `enroll-${process.pid}-${Date.now()}.aiff`);
  const wav = aiff.replace(/\.aiff$/, ".wav");
  await run("/usr/bin/say", ["-v", voice, "-r", String(rate), "-o", aiff, text]);
  await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const s = readWav16k(wav);
  try { unlinkSync(aiff); unlinkSync(wav); } catch { /* ignore */ }
  return s;
}

async function englishVoices(): Promise<string[]> {
  const { stdout } = await run("/usr/bin/say", ["-v", "?"]);
  const names = stdout
    .split("\n")
    .filter((l) => /\ben_(US|GB|AU|IN|IE|ZA|CA|SC)\b/.test(l))
    .map((l) => l.trim().split(/\s{2,}|\s(?=en_)/)[0].trim())
    .filter(Boolean);
  // Novelty voices make poor examples of anyone's speech.
  const skip = /^(Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Pipe Organ|Trinoids|Whisper|Zarvox|Albert|Fred|Junior|Kathy|Ralph|Jester|Organ|Superstar|Wobble|Grandma|Grandpa|Eddy|Flo|Reed|Rocko|Sandy|Shelley)\b/i;
  return [...new Set(names)].filter((n) => !skip.test(n));
}

function framesOf(samples: Int16Array): number[][] {
  return cmn(mfccFrames(toFloat(trimSilence(samples)))).map((f) => Array.from(f));
}

async function seedStore(): Promise<void> {
  const voices = await englishVoices();
  if (!voices.length) throw new Error("no English voices found via `say -v ?`");
  console.log(`\nSeeding "Echo" templates from ${voices.length} voices: ${voices.join(", ")}\n`);
  const store = loadStore();
  store.templates = store.templates.filter((t) => t.source !== "seed");
  const positives: Float32Array[][] = [];
  for (const voice of voices) {
    for (const text of POSITIVES) {
      for (const rate of [170, 215]) {
        try {
          const frames = framesOf(await synth(text, voice, rate));
          if (frames.length < 20 || frames.length > 110) continue;
          store.templates.push({ name: `${voice}:${text}@${rate}`, source: "seed", frames });
          positives.push(frames.map((f) => Float32Array.from(f)));
        } catch (err: any) {
          console.log(`  skip ${voice} "${text}": ${err?.message ?? err}`);
        }
      }
    }
    process.stdout.write(".");
  }
  console.log(`\n  ${positives.length} positive templates`);

  // Calibrate: each positive scored against all OTHER voices' templates
  // (leave-one-voice-out), each negative against everything.
  const byVoice = new Map<string, Float32Array[][]>();
  for (const t of store.templates) {
    const v = t.name.split(":")[0];
    if (!byVoice.has(v)) byVoice.set(v, []);
    byVoice.get(v)!.push(t.frames.map((f) => Float32Array.from(f)));
  }
  const posCosts: number[] = [];
  for (const [v, mine] of byVoice) {
    const others = [...byVoice.entries()].filter(([o]) => o !== v).flatMap(([, t]) => t);
    for (const p of mine) posCosts.push(Math.min(...others.map((t) => dtwEndAligned(t, p))));
  }
  const negCosts: number[] = [];
  const all = store.templates.map((t) => t.frames.map((f) => Float32Array.from(f)));
  for (const voice of voices.slice(0, 6)) {
    for (const text of NEGATIVES) {
      try {
        const frames = cmn(mfccFrames(toFloat(trimSilence(await synth(text, voice, 190)))));
        negCosts.push(Math.min(...all.map((t) => dtwEndAligned(t, frames))));
      } catch {
        /* skip */
      }
    }
  }
  posCosts.sort((a, b) => a - b);
  negCosts.sort((a, b) => a - b);
  const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  const pos90 = q(posCosts, 0.9); // 90 % of unseen-voice positives under this
  const neg05 = q(negCosts, 0.05); // 5 % of negatives under this
  // Sit between them; when they overlap, favour recall — whisper verifies anyway.
  const threshold = pos90 < neg05 ? (pos90 + neg05) / 2 : pos90;
  store.threshold = Number(threshold.toFixed(3));
  console.log(`  positives (unseen voice): median ${q(posCosts, 0.5).toFixed(2)} · p90 ${pos90.toFixed(2)}`);
  console.log(`  negatives:                 p5 ${neg05.toFixed(2)} · median ${q(negCosts, 0.5).toFixed(2)}`);
  console.log(`  threshold -> ${store.threshold}${pos90 >= neg05 ? "  (overlap: relying on whisper verification for precision)" : ""}`);
  save(store);
}

async function enrollPerson(): Promise<void> {
  const { PvRecorder } = await import("@picovoice/pvrecorder-node");
  const store = loadStore();
  const rec = new PvRecorder(512, -1);
  rec.start();
  console.log(`\nEnrolling ${who}. Say "Echo" when prompted — five times, normal voice, normal distance.\n`);
  for (let n = 1; n <= 5; n++) {
    await new Promise((r) => setTimeout(r, 600));
    process.stdout.write(`  ${n}/5  say "Echo" now... `);
    const frames: Int16Array[] = [];
    const start = Date.now();
    while (Date.now() - start < 1800) frames.push(await rec.read());
    const total = new Int16Array(frames.length * 512);
    frames.forEach((f, i) => total.set(f, i * 512));
    const trimmed = trimSilence(total);
    const f = framesOf(trimmed);
    if (f.length < 20 || f.length > 110) {
      console.log(`too ${f.length < 20 ? "short" : "long"} (${f.length} frames) — try again`);
      n--;
      continue;
    }
    store.templates.push({ name: `${who}:enroll:${Date.now()}`, source: "enroll", frames: f });
    console.log(`ok (${f.length} frames)`);
  }
  rec.stop();
  rec.release();
  if (!store.threshold) store.threshold = 20;
  save(store);
}

function save(store: TemplateStore): void {
  mkdirSync(join(ROOT, "models", "wake"), { recursive: true });
  writeFileSync(STORE, JSON.stringify(store));
  const seeds = store.templates.filter((t) => t.source === "seed").length;
  console.log(`\n  saved ${store.templates.length} templates (${seeds} seed, ${store.templates.length - seeds} enrolled), threshold ${store.threshold}`);
  console.log(`  -> ${STORE}\n`);
}

try {
  if (seed) await seedStore();
  else await enrollPerson();
} catch (err: any) {
  console.error(`enroll failed: ${err?.message ?? err}`);
  process.exit(1);
}
