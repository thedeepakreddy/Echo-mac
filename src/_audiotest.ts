/**
 * Echo hearing the turn, not just reading it.
 *
 *   npm run audiotest
 *
 * Offline: no API key, no network, no Electron. What is checked is the part
 * that decides whether a recording is sent at all, the shape it is sent in, and
 * — most importantly — that it comes back OUT of the conversation afterwards.
 * A leak there is invisible in testing and expensive in production: one spoken
 * command can drive a hundred iterations, each re-uploading the same audio.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWav } from "./voice/wav.js";
import {
  MAX_AUDIO_BYTES,
  audioTurnFor,
  describeAudio,
  describeTurn,
  stripAudioParts,
  toInlineDataPart,
  wavDurationMs,
} from "./voice/audio-turn.js";
import {
  HEARING_PROMPT,
  parseHeard,
  useHearingBridge,
  withTone,
} from "./voice/hearing.js";
import { AUDIO_TURN_GUIDANCE, Brain, type AudioTurn } from "./brain/types.js";
import { RecordingBrain } from "./agent-replay/runtime.js";
import type { JarvisConfig } from "./config.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const dir = mkdtempSync(join(tmpdir(), "echo-audiotest-"));
const wavPath = join(dir, "utterance.wav");
// Two seconds of 16kHz mono, written by the same helper the listener uses.
const frames = [new Int16Array(16000), new Int16Array(16000)];
await writeWav(frames, wavPath, 16000);

const cfgWith = (over: any = {}): JarvisConfig =>
  ({
    brain: "claude",
    gemini: { model: "gemini-2.0-flash", apiKeyEnv: "GEMINI_API_KEY" },
    voice: { sendAudioToBrain: true, ...over.voice },
    ...over,
  } as any);

console.log("\nHearing a turn\n");

console.log("  a captured WAV describes itself");
{
  ok(wavDurationMs(Buffer.alloc(10)) === undefined, "a truncated header is not a duration");
  ok(wavDurationMs(Buffer.alloc(64)) === undefined, "and neither are 64 bytes of zeroes");

  const turn = describeAudio(wavPath);
  ok(!!turn, "a real capture is readable");
  ok(turn?.mimeType === "audio/wav", "and is labelled as WAV");
  ok(turn?.durationMs === 2000, `two seconds of frames measure 2000ms (got ${turn?.durationMs})`);
  ok((turn?.bytes ?? 0) === 44 + 32000 * 2, "the size is the header plus the samples");
  ok(describeAudio(join(dir, "gone.wav")) === null, "a capture that isn't there is absent, not an error");
  ok(/^2\.0s/.test(describeTurn(turn!)), `it describes itself for the log (${describeTurn(turn!)})`);
}

console.log("  both switches have to be on before anything is sent");
{
  ok(!!audioTurnFor(wavPath, { enabled: true, hearsAudio: true }), "asked for, and the brain can hear");
  ok(audioTurnFor(wavPath, { enabled: false, hearsAudio: true }) === null, "not asked for — nothing is sent");
  ok(audioTurnFor(wavPath, { enabled: true, hearsAudio: false }) === null,
     "a brain that cannot listen is never handed bytes it would drop");
  ok(audioTurnFor("", { enabled: true, hearsAudio: true }) === null, "no path, no audio");
  ok(audioTurnFor(join(dir, "gone.wav"), { enabled: true, hearsAudio: true }) === null,
     "a missing capture is skipped rather than thrown over");
  ok(audioTurnFor(wavPath, { enabled: true, hearsAudio: true, maxBytes: 100 }) === null,
     "a capture over the size limit is skipped");
  ok(MAX_AUDIO_BYTES > 1024 * 1024, "and the limit leaves room for a long utterance");
}

console.log("  the recording goes in the shape the model reads");
{
  const turn = describeAudio(wavPath)!;
  const part = toInlineDataPart(turn);
  ok(!!part?.inlineData, "it becomes an inline data part");
  ok(part?.inlineData.mimeType === "audio/wav", "carrying its media type");
  ok(Buffer.from(part!.inlineData.data, "base64").length === turn.bytes,
     "and every byte of the file survives the encoding");
  ok(toInlineDataPart({ path: join(dir, "gone.wav"), mimeType: "audio/wav" }) === null,
     "a file that vanished between capture and send loses the audio, not the turn");
}

console.log("  and it comes back out once it has been heard");
{
  const contents: any[] = [
    { role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: "AAAA" } }, { text: "open mail" }] },
    { role: "model", parts: [{ text: "Opening Mail." }] },
    { role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: "BBBB" } }] },
    { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "CCCC" } }, { text: "what is this" }] },
  ];
  const dropped = stripAudioParts(contents);
  ok(dropped === 2, `both recordings are dropped (got ${dropped})`);
  ok(contents[0].parts.length === 1 && contents[0].parts[0].text === "open mail",
     "the transcript beside it stays — that is what the turn was");
  ok(contents[2].parts.length === 1 && contents[2].parts[0].text === "(spoken)",
     "a turn that was ONLY audio keeps a placeholder, because an empty content block is rejected outright");
  ok(contents[3].parts.some((p: any) => p.inlineData?.mimeType === "image/png"),
     "a screenshot in the history is left alone — this is about audio");
  ok(stripAudioParts(contents) === 0, "running it again drops nothing");
  ok(stripAudioParts([]) === 0 && stripAudioParts(undefined as any) === 0, "and it survives an empty history");
}

console.log("  brains declare whether they can listen");
{
  class DeafBrain extends Brain {
    sent: Array<{ text: string; audio?: AudioTurn }> = [];
    send(text: string, audio?: AudioTurn) { this.sent.push({ text, audio }); }
    interrupt() {}
    async stop() {}
  }
  class HearingBrain extends DeafBrain {
    get hearsAudio() { return true; }
  }
  ok(new DeafBrain().hearsAudio === false, "the default is that a brain reads, not hears");
  ok(new HearingBrain().hearsAudio === true, "one that can listen says so");

  // Every brain reaches the app through the recording wrapper, so a capability
  // that stops at the wrapper is one the app can never use.
  const previous = process.env.ECHO_LOG;
  process.env.ECHO_LOG = "0"; // don't write a run log from a test
  const inner = new HearingBrain();
  const wrapped = new RecordingBrain(inner, "test");
  ok(wrapped.hearsAudio === true, "the recording wrapper reports the inner brain's ears");
  const turn = describeAudio(wavPath)!;
  wrapped.send("open mail", turn);
  ok(inner.sent[0]?.audio?.path === wavPath, "and forwards the recording through to it");
  ok(new RecordingBrain(new DeafBrain(), "test").hearsAudio === false, "a deaf inner brain stays deaf");
  if (previous === undefined) delete process.env.ECHO_LOG; else process.env.ECHO_LOG = previous;
}

console.log("  the brain is told what the recording means");
{
  ok(/RECORDING is\s+what was said/i.test(AUDIO_TURN_GUIDANCE),
     "the audio is named as the truth, not an extra");
  ok(/transcript is a machine's guess/i.test(AUDIO_TURN_GUIDANCE),
     "and the transcript as a guess at it");
  ok(/Telugu|Hindi/.test(AUDIO_TURN_GUIDANCE), "with the languages the transcriber is worst at named");
  ok(/urgency|hesitation|irritation/i.test(AUDIO_TURN_GUIDANCE), "how it was said is part of the brief");
  ok(/Do not narrate/i.test(AUDIO_TURN_GUIDANCE),
     "and it is told not to read the user's mood back to them");
}

console.log("  the hearing pass, for a brain with no ears of its own");
{
  const savedKey = process.env.GEMINI_API_KEY;

  process.env.GEMINI_API_KEY = "test-key";
  ok(useHearingBridge(cfgWith(), false) === true, "a deaf brain plus a key means the pass runs");
  ok(useHearingBridge(cfgWith(), true) === false,
     "a brain that hears for itself never goes through it — that path is strictly better");
  ok(useHearingBridge(cfgWith({ voice: { sendAudioToBrain: false } }), false) === false,
     "and it is off unless asked for");

  delete process.env.GEMINI_API_KEY;
  ok(useHearingBridge(cfgWith(), false) === false, "no key, no pass — it just behaves as it always did");
  if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;

  ok(/ONLY a JSON object/i.test(HEARING_PROMPT), "the ear is asked for JSON");
  ok(/never translate/i.test(HEARING_PROMPT), "told never to translate what it heard");
  ok(/Do not add, tidy, complete or answer/i.test(HEARING_PROMPT), "and not to answer the question it hears");
}

console.log("  what comes back is read defensively");
{
  const plain = parseHeard('{"transcript":"open my mail","tone":"rushed"}');
  ok(plain?.transcript === "open my mail" && plain?.tone === "rushed", "plain JSON parses");

  const fenced = parseHeard('```json\n{"transcript":"చెప్పు","tone":""}\n```');
  ok(fenced?.transcript === "చెప్పు", "a fenced reply is unwrapped rather than thrown away");
  ok(fenced?.tone === undefined, "an empty tone is no tone, not an empty string");

  const chatty = parseHeard('Sure! Here you go:\n{"transcript":"stop","tone":"sharp"}\nHope that helps');
  ok(chatty?.transcript === "stop", "and so is one buried in chatter");

  // Asked for "" when a sentence is unremarkable, models answer with the word
  // instead about half the time — real behaviour from the first live run.
  ok(parseHeard('{"transcript":"open mail","tone":"ordinary"}')?.tone === undefined,
     "\"ordinary\" is not a tone worth telling the brain about");
  ok(parseHeard('{"transcript":"open mail","tone":"Neutral."}')?.tone === undefined,
     "nor is \"Neutral.\", however it is punctuated");
  ok(parseHeard('{"transcript":"open mail","tone":"calm but hesitant"}')?.tone === "calm but hesitant",
     "a real observation survives, even one that starts with a no-signal word");

  ok(parseHeard("") === null, "nothing back is nothing heard");
  ok(parseHeard("I could not hear that") === null, "prose with no JSON is not a transcript");
  ok(parseHeard('{"transcript":"   ","tone":"calm"}') === null, "a blank transcript is not a turn");
  ok(parseHeard('{"transcript":') === null, "and broken JSON does not throw");
}

console.log("  a text-only brain is told how it sounded");
{
  ok(withTone("open the door", "sounds urgent") === "open the door\n\n(heard: sounds urgent)",
     "the note rides along with the words");
  ok(withTone("open the door") === "open the door", "and nothing is added when there is nothing to add");
  ok(withTone("open the door", "") === "open the door", "an empty note is no note");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} hearing checks passed\n`);
process.exit(fail ? 1 : 0);
