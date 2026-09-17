/**
 * Keyless wake-word check, end to end.
 *
 * Synthesises speech with macOS `say`, runs it through the SAME whisper.cpp
 * pipeline Jarvis uses, and asserts the wake word is detected and stripped.
 * This exercises real audio -> real STT -> the matcher, not just the regex.
 *
 *   npm run waketest
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { transcribeLocal } from "./voice/stt.js";
import { matchWakeWord, isNameOnly } from "./voice/wakeword.js";

const run = promisify(execFile);
// fileURLToPath decodes %20 etc; `.pathname` does not, which broke once the
// folder was renamed to "Echo Mac" (a path with a space).
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const cfg = loadConfig(ROOT);

interface Case {
  spoken: string;
  expectWake: boolean;
  expectCommand?: string; // substring the extracted command must contain
  nameOnly?: boolean;
}

// The wake word is "Echo" (renamed from Jarvis).
const CASES: Case[] = [
  { spoken: "Echo, what is on my screen?", expectWake: true, expectCommand: "screen" },
  { spoken: "Hey Echo, open Safari.", expectWake: true, expectCommand: "safari" },
  { spoken: "Echo", expectWake: true, nameOnly: true },
  { spoken: "What time is the meeting tomorrow?", expectWake: false },
  { spoken: "I was telling Sarah about the report.", expectWake: false },
  // Observed for real: silence-based endpointing runs preceding chatter into
  // the command, leaving the wake word mid-transcript.
  {
    spoken: "Good job, how are you doing? Echo, what is on my screen?",
    expectWake: true,
    expectCommand: "screen",
  },
];

/**
 * Mishearings this machine actually produced, checked against the matcher.
 *
 * These are TRANSCRIPTS, not things to say. Speaking them aloud and hoping
 * whisper mishears them back into the same shape compounds the distortion
 * instead of reproducing it — synthesising "Hage-arvis" came back as
 * "Figavus", which is nothing like the name and which nothing should match.
 * Feeding the observed text straight to the matcher tests the thing that
 * actually has to cope with it.
 */
const HEARD: Case[] = [
  { spoken: "Eco, open Safari.", expectWake: true, expectCommand: "safari" },
  { spoken: "Ecko, what is on my screen?", expectWake: true, expectCommand: "screen" },
  { spoken: "Echo. Open Safari.", expectWake: true, expectCommand: "safari" },
  { spoken: "Hey echo, open mail.", expectWake: true, expectCommand: "mail" },
  // And things that must still be ignored, so the fuzziness above has a limit.
  // (Note: "Echo" is a common English word, so a sentence that literally
  // contains it will wake — a known tradeoff of the name. These avoid it.)
  { spoken: "Just service the car tomorrow.", expectWake: false },
  { spoken: "The harvest is in.", expectWake: false },
];

/** Speak text to a 16kHz mono WAV, the format whisper.cpp expects. */
async function synth(text: string): Promise<string> {
  const aiff = join(tmpdir(), `wake-${Date.now()}.aiff`);
  const wav = join(tmpdir(), `wake-${Date.now()}.wav`);
  await run("/usr/bin/say", ["-v", cfg.voice.ttsVoice, "-o", aiff, text]);
  await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  unlink(aiff).catch(() => {});
  return wav;
}

let pass = 0;
let fail = 0;

console.log("\nKeyless wake word — say() -> whisper.cpp -> matcher\n");

for (const c of CASES) {
  let wav = "";
  try {
    wav = await synth(c.spoken);
    const transcript = await transcribeLocal(wav, cfg); // the wake pass is always local, whatever sttProvider says
    const { matched, command } = matchWakeWord(transcript);

    const problems: string[] = [];
    if (matched !== c.expectWake) {
      problems.push(`expected wake=${c.expectWake}, got ${matched}`);
    }
    if (c.expectCommand && !command.toLowerCase().includes(c.expectCommand)) {
      problems.push(`command should contain "${c.expectCommand}"`);
    }
    if (c.nameOnly && !isNameOnly(command)) {
      problems.push(`expected name-only, got "${command}"`);
    }

    if (problems.length) {
      fail++;
      console.log(`  ✗ "${c.spoken}"`);
      console.log(`      heard: ${JSON.stringify(transcript.trim())}`);
      console.log(`      ${problems.join("; ")}`);
    } else {
      pass++;
      const shown = matched ? (isNameOnly(command) ? "(name only)" : command) : "ignored";
      console.log(`  ✓ "${c.spoken}"  ->  ${shown}`);
    }
  } catch (err: any) {
    fail++;
    console.log(`  ✗ "${c.spoken}" — ${err?.message ?? err}`);
  } finally {
    if (wav) unlink(wav).catch(() => {});
  }
}

console.log("\n  observed transcripts, straight to the matcher\n");

for (const c of HEARD) {
  const { matched, command } = matchWakeWord(c.spoken);
  const problems: string[] = [];
  if (matched !== c.expectWake) problems.push(`expected wake=${c.expectWake}, got ${matched}`);
  if (c.expectCommand && !command.toLowerCase().includes(c.expectCommand)) {
    problems.push(`command should contain "${c.expectCommand}"`);
  }
  if (problems.length) {
    fail++;
    console.log(`  ✗ ${JSON.stringify(c.spoken)} — ${problems.join("; ")}`);
  } else {
    pass++;
    console.log(`  ✓ ${JSON.stringify(c.spoken)}  ->  ${matched ? command || "(name only)" : "ignored"}`);
  }
}

console.log(`\n${pass}/${pass + fail} wake-word cases passed\n`);
process.exit(fail ? 1 : 0);
