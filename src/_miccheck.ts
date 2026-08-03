/**
 * Microphone diagnostic.
 *
 * Opens the same capture pipeline Jarvis uses and reports the actual signal
 * levels, so the speech threshold can be set from measurement rather than
 * guesswork. Silent frames mean a permissions problem; quiet-but-nonzero frames
 * mean the threshold is simply too high for this microphone.
 *
 *   npm run miccheck
 */
export {}; // make this a module so top-level await is allowed

const SECONDS = Number(process.argv[2] ?? 8);
const FRAME_LENGTH = 512;
const CURRENT_THRESHOLD = 550;

const { PvRecorder } = await import("@picovoice/pvrecorder-node");

console.log("\nMicrophone check\n");
try {
  console.log("  devices:");
  for (const [i, d] of (PvRecorder.getAvailableDevices() ?? []).entries()) {
    console.log(`    [${i}] ${d}`);
  }
} catch {
  console.log("    (could not enumerate devices)");
}

const rec = new PvRecorder(FRAME_LENGTH, -1);
rec.start();
console.log(`\n  Recording ${SECONDS}s — SPEAK NORMALLY NOW…\n`);

const rms: number[] = [];
const deadline = Date.now() + SECONDS * 1000;
while (Date.now() < deadline) {
  const frame = await rec.read();
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  rms.push(Math.sqrt(sum / frame.length));
}
rec.stop();
rec.release();

const sorted = [...rms].sort((a, b) => a - b);
const pct = (p: number) => Math.round(sorted[Math.floor((sorted.length - 1) * p)]);
const max = Math.round(Math.max(...rms));
const mean = Math.round(rms.reduce((a, b) => a + b, 0) / rms.length);
const over = rms.filter((r) => r >= CURRENT_THRESHOLD).length;

console.log(`  frames captured : ${rms.length}`);
console.log(`  all-silent      : ${max === 0 ? "YES — microphone is delivering nothing" : "no"}`);
console.log(`  RMS  min/mean/max : ${pct(0)} / ${mean} / ${max}`);
console.log(`  RMS  p50 p75 p90 p95 p99 : ${pct(0.5)} ${pct(0.75)} ${pct(0.9)} ${pct(0.95)} ${pct(0.99)}`);
console.log(`\n  frames over current threshold (${CURRENT_THRESHOLD}): ${over} / ${rms.length} (${Math.round((over / rms.length) * 100)}%)`);

if (max === 0) {
  console.log("\n  DIAGNOSIS: no audio at all. Grant Microphone permission and relaunch.\n");
} else if (over === 0) {
  console.log(
    `\n  DIAGNOSIS: audio is arriving but never crosses ${CURRENT_THRESHOLD}, so speech is` +
      `\n  never detected. A threshold near ${Math.max(40, Math.round(pct(0.5) * 2.5))} would suit this microphone.\n`
  );
} else {
  console.log(`\n  DIAGNOSIS: speech is being detected on ${Math.round((over / rms.length) * 100)}% of frames — threshold looks usable.\n`);
}
process.exit(0);
