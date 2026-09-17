/**
 * The persistent player, for real: spawn voiceio, play PCM, measure the time
 * from the first bytes to sound, stop it mid-sentence and measure that too.
 * With --capture, also checks echo-cancelled microphone frames arrive at
 * 16 kHz / 512 samples. Audible: it plays a sentence through your speakers.
 *
 *   npm run playertest
 */
import { execFile } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { VoiceIoPlayer } from "./voice/player.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nvoiceio player\n");
const bin = VoiceIoPlayer.available(ROOT);
if (!bin) {
  console.log("  ✗ native/voiceio not built (npm run build compiles it)");
  process.exit(1);
}

// 24 kHz mono PCM from `say`.
const wav = join(tmpdir(), `pt-${Date.now()}.wav`);
await run("/usr/bin/say", ["-v", "Samantha", "-o", wav, "--data-format=LEI16@24000", "This is Echo's new voice path: one player, always running, no gaps between sentences."]);
const buf = readFileSync(wav);
let off = 12, pcm = Buffer.alloc(0);
while (off + 8 <= buf.length) {
  const id = buf.toString("ascii", off, off + 4);
  const size = buf.readUInt32LE(off + 4);
  if (id === "data") { pcm = buf.subarray(off + 8, off + 8 + size); break; }
  off += 8 + size + (size % 2);
}
try { unlinkSync(wav); } catch { /* ignore */ }
const audioMs = (pcm.length / 2 / 24000) * 1000;

const player = new VoiceIoPlayer(bin, process.argv.includes("--no-capture") ? false : true);
const t0 = performance.now();
await player.start();
ok(true, `helper ready in ${Math.round(performance.now() - t0)} ms (aec capture: ${player.aec})`);

// Time from first bytes to 'started'.
const started = new Promise<number>((r) => player.once("started", () => r(performance.now())));
const tPlay = performance.now();
player.play(pcm.subarray(0, pcm.length / 2), 24000, 0);
const tStarted = await Promise.race([started, new Promise<number>((r) => setTimeout(() => r(-1), 3000))]);
ok(tStarted > 0 && tStarted - tPlay < 150, `first bytes → playing in ${tStarted > 0 ? Math.round(tStarted - tPlay) : "∞"} ms`);

// Feed the second half a moment later: no gap expected, still one run.
await new Promise((r) => setTimeout(r, 300));
player.play(pcm.subarray(pcm.length / 2), 24000, 0);

// Stop mid-sentence and measure.
await new Promise((r) => setTimeout(r, 700));
const stopped = new Promise<number>((r) => player.once("stopped", () => r(performance.now())));
const tStop = performance.now();
player.stop();
const tStopped = await Promise.race([stopped, new Promise<number>((r) => setTimeout(() => r(-1), 1000))]);
ok(tStopped > 0 && tStopped - tStop < 60, `stop → silent in ${tStopped > 0 ? Math.round(tStopped - tStop) : "∞"} ms (had ${Math.round(audioMs)} ms queued)`);
ok(player.playedMs > 500 && player.playedMs < audioMs, `progress reported: ${player.playedMs} ms played before the stop`);

// Play again after a stop: the engine must still be alive.
const again = new Promise<boolean>((r) => player.once("started", () => r(true)));
player.play(pcm.subarray(0, 24000 * 2), 24000, 1); // one second
ok(await Promise.race([again, new Promise<boolean>((r) => setTimeout(() => r(false), 1000))]), "plays again after a stop");
const drained = new Promise<boolean>((r) => player.once("drained", () => r(true)));
ok(await Promise.race([drained, new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]), "reports drained when the queue empties");

if (player.frameSource) {
  const src = player.frameSource;
  // Frames queued while playback was being tested come out in a burst; count
  // only what arrives in real time from here.
  { const tDrain = performance.now(); while (performance.now() - tDrain < 120) await src.read(); }
  const tc = performance.now();
  let n = 0, rmsMax = 0;
  while (performance.now() - tc < 1000) {
    const f = await src.read();
    n++;
    let s = 0;
    for (let i = 0; i < f.length; i++) s += f[i] * f[i];
    rmsMax = Math.max(rmsMax, Math.sqrt(s / f.length));
    ok(f.length === 512, `capture frame is 512 samples (${f.length})`) ;
    break;
  }
  while (performance.now() - tc < 1000) { await src.read(); n++; }
  ok(n >= 24 && n <= 40, `captured ${n} frames in 1 s (~31 expected at 16 kHz/512)`);
} else if (player.capturing) {
  // The helper opened the microphone and is streaming, but every sample was
  // zero — a working ADC always dithers. Echo falls back to the plain mic, so
  // it can still hear; this says so out loud because a silent capture unit is
  // otherwise invisible, and was what left Echo deaf for a whole session.
  console.log("  ⚠ the echo-cancelled microphone delivered DIGITAL SILENCE on this machine.");
  console.log("    Echo falls back to the plain microphone and can hear; barge-in over speakers may suffer.");
  ok(true, "silent capture unit detected and refused rather than used");
} else {
  console.log("  (capture not active — playback-only)");
}

player.dispose();
console.log(`\n${pass}/${pass + fail} player cases passed\n`);
process.exit(fail ? 1 : 0);
