/**
 * Read the latest voice log and print one line per turn: how long the user
 * waited at each stage, with end-of-speech → first audio as the headline.
 *
 *   npm run voicelog            # latest launch
 *   npm run voicelog -- <file>  # a specific runs/voice/*.jsonl
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeSummary, type TurnSummary } from "./voice/voice-log.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dir = join(ROOT, "runs", "voice");

function latest(): string | null {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] ?? null;
  } catch {
    return null;
  }
}

const file = process.argv[2] ?? latest();
if (!file) {
  console.log("No voice logs yet. Start Echo and say something.");
  process.exit(1);
}

const events = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const summaries = events.filter((e) => e.type === "turn.summary") as (TurnSummary & { iso: string })[];
const wakes = events.filter((e) => e.type === "wake.detected").length;
const barges = events.filter((e) => e.type === "barge_in").length;
const discarded = events.filter((e) => e.type === "capture.discarded").length;
const states = events.filter((e) => e.type === "state");

console.log(`\nvoice log: ${file}`);
console.log(`  events ${events.length} · turns ${summaries.length} · wakes ${wakes} · barge-ins ${barges} · discarded captures ${discarded}\n`);

if (!summaries.length) {
  console.log("  no completed turns.");
} else {
  for (const s of summaries) console.log("  " + describeSummary(s) + (s.transcript ? `  "${String(s.transcript).slice(0, 50)}"` : ""));
  const fa = summaries.map((s) => s.first_audio_ms).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
  if (fa.length) {
    const med = fa[Math.floor(fa.length / 2)];
    console.log(`\n  first audio after you stop talking: median ${med} ms · best ${fa[0]} ms · worst ${fa[fa.length - 1]} ms`);
  }
}

// The last few transitions, for a stuck state.
const tail = states.slice(-8);
if (tail.length) {
  console.log("\n  last states:");
  for (const s of tail) console.log(`    ${String(s.iso).slice(11, 23)}  ${s.prev} → ${s.state}${s.why ? `  (${s.why})` : ""}`);
}
console.log();
