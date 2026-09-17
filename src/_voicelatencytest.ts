/**
 * The whole spoken turn, offline, with stubbed providers — and the numbers
 * the session must produce for it.
 *
 * No microphone, no network, no model: a fake brain that streams a reply, a
 * fake TTS that returns audio after a fixed delay, a fake player that reports
 * playback. What is being checked is the plumbing the real providers plug
 * into: that streamed sentences are spoken as they complete and not again when
 * the whole text arrives, that a barge-in cancels audio at once and later
 * fragments of the cancelled reply are never voiced, and that the voice log's
 * per-turn summary comes out with sane, ordered timings.
 *
 *   npm run voicelatencytest
 */
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { VoiceSession } from "./voice/session.js";
import { voiceLog } from "./voice/voice-log.js";
import { SpeechStream } from "./voice/speech-stream.js";
import { Tts } from "./voice/tts.js";
import type { AudioPlayer } from "./voice/player.js";
import type { JarvisConfig } from "./config.js";
import { DEFAULTS_FOR_TESTS } from "./config.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

voiceLog.init(process.cwd(), { quiet: true });

// ---- fakes ----------------------------------------------------------------------
class FakePlayer extends EventEmitter implements AudioPlayer {
  readonly name = "fake";
  readonly aec = false;
  readonly frameSource = null;
  playing = false;
  playedMs = 0;
  played: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private queuedMs = 0;
  async start() {}
  play(pcm: Buffer, rate: number, sentence: number) {
    this.played.push(sentence);
    this.queuedMs += (pcm.length / 2 / rate) * 1000;
    if (!this.playing) {
      this.playing = true;
      this.playedMs = 0;
      this.emit("started");
      const tick = () => {
        this.playedMs += 20;
        this.emit("progress", this.playedMs);
        if (this.playedMs >= this.queuedMs) {
          this.playing = false;
          this.timer = null;
          this.queuedMs = 0;
          this.emit("drained");
        } else this.timer = setTimeout(tick, 20);
      };
      this.timer = setTimeout(tick, 20);
    }
  }
  endSentence() {}
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.playing = false;
    this.queuedMs = 0;
    this.emit("stopped");
  }
  dispose() {}
}

/** A TTS that answers each sentence with `ms` of silence after `delay`. */
const fakeTts = { delay: 120, spoken: [] as string[] };
const cfg: JarvisConfig = { ...DEFAULTS_FOR_TESTS, voice: { ...DEFAULTS_FOR_TESTS.voice, ttsEngine: "mac", ttsStreaming: true, ttsEnabled: true, maxSpokenSentences: 6 } };

// The say adapter would shell out; the SpeechStream takes a factory instead.
class FakeTtsStream extends EventEmitter {
  readonly name = "fake-tts";
  readonly sampleRate = 16000;
  async open() {}
  speak(text: string, sentence: number) {
    fakeTts.spoken.push(text);
    setTimeout(() => {
      const ms = 300;
      this.emit("audio", { pcm: Buffer.alloc((ms / 1000) * this.sampleRate * 2), sampleRate: this.sampleRate, sentence });
      this.emit("sentenceDone", sentence);
    }, fakeTts.delay);
  }
  async close() {}
  abort() {}
}
console.log("\nVoice pipeline — stubbed end to end\n");

const player = new FakePlayer();
const speech = new SpeechStream(cfg, player, { maxSentences: () => 6, createTts: () => new FakeTtsStream() as any });
const session = new VoiceSession({ windowMs: () => 5000 });
const states: string[] = [];
session.on("state", (s: string) => states.push(s));
const speakingLog: boolean[] = [];
const tts = new Tts("Evan", true, "mac", undefined, (on) => {
  speakingLog.push(on);
  session.noteSpeaking(on);
});
tts.attachStream(speech);
player.on("started", () => voiceLog.event("audio.start", { turnId: session.brainTurnId ?? undefined }));

// ---- a streamed reply -------------------------------------------------------------
const turn = session.beginTurn("acoustic");
voiceLog.stampAt("vad.speech_end", turn.id, performance.now());
session.noteBrainSend(turn, "what's on my screen", "fake");
speech.newTurn();
let firstAudioAt = -1;
speech.once("firstAudio", () => (firstAudioAt = performance.now()));
const t0 = performance.now();
// The fake brain streams three sentences, token by token.
const reply = "Your screen shows the editor. The file main.ts is open. Want a summary?";
for (const tok of reply.match(/\S+\s*/g)!) {
  session.noteBrainText(tok);
  speech.feed(tok);
  await sleep(15);
}
speech.endBlock();
await sleep(30); // the flushed sentence reaches the TTS on the next tick
// ...then the whole text arrives, as the brains do after the deltas.
const spokenBefore = fakeTts.spoken.length;
if (speech.tookDeltas()) speech.ackBlock();
else tts.say(reply);
await sleep(50);
ok(fakeTts.spoken.length === spokenBefore, "the whole-text event does not speak a streamed block twice");
ok(fakeTts.spoken[0] === "Your screen shows the editor.", `first sentence went to TTS on its own: ${JSON.stringify(fakeTts.spoken[0])}`);
ok(firstAudioAt > 0 && firstAudioAt - t0 < 600, `first audio ${Math.round(firstAudioAt - t0)} ms after the reply started streaming (before the reply finished: ${Math.round(reply.length * 15 / 6)} ms)`);
const summaryEvent = new Promise<any>((r) => session.once("turnSummary", r));
session.noteBrainDone();
// Wait for playback to finish.
await sleep(1400);
ok(fakeTts.spoken.length === 3, `three sentences spoken (${fakeTts.spoken.length})`);
ok(!speech.isSpeaking && speakingLog[0] === true && speakingLog[speakingLog.length - 1] === false, "speaking went on, then off");
const summary = await Promise.race([summaryEvent, sleep(100).then(() => voiceLog.summarize(turn.id))]);
ok(typeof summary.first_audio_ms === "number" && summary.first_audio_ms > 0, `turn summary: first_audio_ms = ${summary.first_audio_ms}`);
ok(typeof summary.first_token_ms === "number" && summary.first_token_ms <= (summary.first_audio_ms ?? 0), `first_token (${summary.first_token_ms}) ≤ first_audio (${summary.first_audio_ms})`);

// ---- barge-in mid-reply --------------------------------------------------------------
fakeTts.spoken = [];
const t2 = session.beginTurn("window");
session.noteBrainSend(t2, "tell me more", "fake");
speech.newTurn();
const long = "First sentence here. Second sentence here. Third sentence here. Fourth sentence here.";
for (const tok of long.match(/\S+\s*/g)!.slice(0, 8)) {
  speech.feed(tok);
  await sleep(10);
}
await sleep(200); // first sentence's audio is playing
ok(player.playing, "audio is playing when the user interrupts");
const tStop = performance.now();
const stoppedAt = new Promise<number>((r) => player.once("stopped", () => r(performance.now())));
const spokenAtCancel = speech.spokenSoFar(); // read BEFORE the cancel clears it, as main.ts does
session.cancel("bargein", "user spoke");
tts.stop();
const dt = (await Promise.race([stoppedAt, sleep(200).then(() => -1)])) as number;
ok(dt > 0 && dt - tStop < 30, `player stopped ${dt > 0 ? Math.round(dt - tStop) : "∞"} ms after the barge-in`);
ok(!session.brainOutputIsLive(), "the interrupted brain output is no longer live");
// Late fragments of the cancelled reply keep arriving from the model…
const before = fakeTts.spoken.length;
for (const tok of long.match(/\S+\s*/g)!.slice(8)) {
  if (session.brainOutputIsLive()) speech.feed(tok);
}
speech.endBlock();
await sleep(300);
ok(fakeTts.spoken.length === before, "…and none of them are spoken");
ok(spokenAtCancel.length > 0 && spokenAtCancel.endsWith("…"), `what was heard is reported for the history: ${JSON.stringify(spokenAtCancel)}`);
ok(states.includes("interrupted"), "the session went through 'interrupted'");

// ---- the spoken-sentence cap ----------------------------------------------------------
fakeTts.spoken = [];
speech.cancel();
speech.newTurn();
tts.say("One. Two. Three. Four. Five. Six. Seven. Eight.");
await sleep(400);
ok(fakeTts.spoken.length === 7 && fakeTts.spoken[6] === "The rest is on screen.", `long replies are capped at 6 sentences + a pointer (${fakeTts.spoken.length} spoken)`);

console.log(`\n${pass}/${pass + fail} pipeline cases passed\n`);
process.exit(fail ? 1 : 0);
