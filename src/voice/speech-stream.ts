import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { JarvisConfig } from "../config.js";
import { SentenceChunker, splitSentences } from "./chunker.js";
import { createTtsStream, languageOf, type TtsStream, type TtsAudio } from "./tts-stream.js";
import type { AudioPlayer } from "./player.js";

/**
 * Speaks a reply while it is still being written.
 *
 * Model text arrives here as fragments; the chunker releases each sentence as
 * soon as it is complete; the sentence goes straight to the streaming TTS; its
 * audio goes straight to the persistent player. Sentence two is being
 * synthesised while sentence one plays, so there are no gaps — and because
 * everything carries the generation it was started under, a cancel from the
 * session stops the audio at once and drops whatever was still on its way.
 *
 * Events: 'speaking'(bool) · 'firstAudio'(sentence text) · 'sentence'(text, index) · 'capped'
 */
export class SpeechStream extends EventEmitter {
  private generation = 0;
  private chunker = new SentenceChunker();
  private tts: TtsStream | null = null;
  private ttsLang = "";
  private ttsOpening: Promise<void> | null = null;
  private sentences: string[] = [];
  private nextIndex = 0;
  /** Sentences sent to TTS whose audio has not finished arriving. */
  private awaitingAudio = new Set<number>();
  private audioPending = false;
  private speaking = false;
  private blockTookDeltas = false;
  private firstAudioReported = false;
  private spokenThisTurn = 0;
  private capped = false;
  private idleClose: NodeJS.Timeout | null = null;
  private audioMsEnd: number[] = [];
  private sampleRate = 24000;

  constructor(
    private readonly cfg: JarvisConfig,
    private readonly player: AudioPlayer,
    private readonly opts: {
      maxSentences: () => number;
      /** Test seam: build the TTS stream (defaults to the configured engine). */
      createTts?: (cfg: JarvisConfig, firstText: string) => TtsStream | null;
    }
  ) {
    super();
    player.on("drained", () => this.onDrained());
    player.on("started", () => this.emit("playerStarted"));
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** A new brain turn: reset the per-turn sentence budget. */
  newTurn(): void {
    this.spokenThisTurn = 0;
    this.capped = false;
  }

  /**
   * Open the TTS connection now so the first sentence does not pay for it.
   * Measured: Sarvam's socket takes ~1 s to connect and ~0.45 s to first audio
   * after that; the model takes at least that long to write a sentence, so the
   * connect is free when it overlaps.
   */
  warm(hint = ""): void {
    if (this.tts || this.ttsOpening) return;
    void this.ensureTts(hint).catch(() => {});
  }

  private async ensureTts(text: string): Promise<TtsStream | null> {
    const lang = languageOf(text);
    if (this.tts && this.ttsLang && this.ttsLang !== lang && this.tts.name === "sarvam-ws") {
      // Sarvam fixes the language per connection; a reply that switches script
      // gets a fresh one for the new language.
      const old = this.tts;
      this.tts = null;
      void old.close();
    }
    if (this.tts) return this.tts;
    if (this.ttsOpening) {
      await this.ttsOpening;
      return this.tts;
    }
    const gen = this.generation;
    const stream = (this.opts.createTts ?? createTtsStream)(this.cfg, text);
    if (!stream) return null;
    this.ttsLang = lang;
    this.sampleRate = stream.sampleRate;
    stream.on("audio", (a: TtsAudio) => {
      if (gen !== this.generation) return;
      this.onAudio(a);
    });
    stream.on("sentenceDone", (idx: number) => {
      if (gen !== this.generation) return;
      this.awaitingAudio.delete(idx);
      this.player.endSentence(idx);
      this.checkIdle();
    });
    stream.on("error", (m: string) => console.log(`[voice] tts stream: ${m}`));
    stream.on("closed", () => {
      if (this.tts === stream) this.tts = null;
    });
    this.ttsOpening = stream.open().then(
      () => {
        if (gen === this.generation) this.tts = stream;
        else stream.abort();
      },
      (err: any) => {
        console.log(`[voice] tts stream failed to open: ${err?.message ?? err}`);
      }
    );
    await this.ttsOpening;
    this.ttsOpening = null;
    return this.tts;
  }

  /** Streamed model text. */
  feed(delta: string): void {
    this.blockTookDeltas = true;
    for (const s of this.chunker.feed(delta)) void this.speakSentence(s);
  }

  /** The model finished the block the deltas belonged to. */
  endBlock(): void {
    for (const s of this.chunker.flush()) void this.speakSentence(s);
  }

  /** Did the current block arrive as deltas (so its `text` must not be spoken again)? */
  tookDeltas(): boolean {
    return this.blockTookDeltas;
  }

  /** The `text` event for a streamed block has been seen; the next block starts clean. */
  ackBlock(): void {
    this.blockTookDeltas = false;
  }

  /** A whole text at once — the `Tts.say()` path for non-streaming callers. */
  speakText(text: string): void {
    for (const s of splitSentences(text)) void this.speakSentence(s);
  }

  private async speakSentence(text: string): Promise<void> {
    const gen = this.generation;
    const cap = this.opts.maxSentences();
    if (cap > 0 && this.spokenThisTurn >= cap) {
      if (!this.capped) {
        this.capped = true;
        this.emit("capped");
        text = "The rest is on screen.";
      } else return;
    }
    this.spokenThisTurn++;
    const idx = this.nextIndex++;
    this.sentences[idx] = text;
    this.awaitingAudio.add(idx);
    this.setSpeaking(true);
    const tts = await this.ensureTts(text);
    if (gen !== this.generation) return;
    if (!tts) {
      this.awaitingAudio.delete(idx);
      this.checkIdle();
      return;
    }
    this.emit("sentence", text, idx);
    tts.speak(text, idx);
    this.armIdleClose();
  }

  private onAudio(a: TtsAudio): void {
    this.audioPending = true;
    this.player.play(a.pcm, a.sampleRate, a.sentence);
    const ms = (a.pcm.length / 2 / a.sampleRate) * 1000;
    const prev = this.audioMsEnd.length ? this.audioMsEnd[this.audioMsEnd.length - 1] : 0;
    this.audioMsEnd[a.sentence] = Math.max(this.audioMsEnd[a.sentence] ?? 0, prev) + ms;
    if (!this.firstAudioReported) {
      this.firstAudioReported = true;
      this.emit("firstAudio", this.sentences[a.sentence] ?? "", performance.now());
    }
  }

  private onDrained(): void {
    this.audioPending = false;
    this.checkIdle();
  }

  /** Nothing left to say and nothing left to play: speech is over. */
  private checkIdle(): void {
    if (this.awaitingAudio.size === 0 && !this.audioPending && !this.player.playing && !this.chunker.pending.trim()) {
      this.setSpeaking(false);
    }
  }

  private setSpeaking(on: boolean): void {
    if (this.speaking === on) return;
    this.speaking = on;
    if (!on) {
      // A run is over: the next sentence starts a fresh, zero-based run so
      // "what was heard" lines up with the player's clock.
      this.firstAudioReported = false;
      this.audioMsEnd = [];
      this.sentences = [];
      this.nextIndex = 0;
    }
    this.emit("speaking", on);
  }

  /** Close an idle TTS connection before the server does. */
  private armIdleClose(): void {
    if (this.idleClose) clearTimeout(this.idleClose);
    this.idleClose = setTimeout(() => {
      if (this.awaitingAudio.size === 0 && this.tts) {
        const t = this.tts;
        this.tts = null;
        void t.close();
      }
    }, 20000);
  }

  /** What has actually been heard so far, for patching the model's history after an interruption. */
  spokenSoFar(): string {
    const played = this.player.playedMs;
    const out: string[] = [];
    for (let i = 0; i < this.sentences.length; i++) {
      const end = this.audioMsEnd[i];
      if (end !== undefined && end <= played) out.push(this.sentences[i]);
      else if (end !== undefined && played > 0) {
        // Part of this sentence was heard.
        const frac = Math.max(0, Math.min(1, (played - (this.audioMsEnd[i - 1] ?? 0)) / (end - (this.audioMsEnd[i - 1] ?? 0))));
        const words = this.sentences[i].split(/\s+/);
        out.push(words.slice(0, Math.max(1, Math.round(words.length * frac))).join(" ") + "…");
        break;
      } else break;
    }
    return out.join(" ");
  }

  /** Drop everything: queued text, in-flight synthesis, queued and playing audio. */
  cancel(): void {
    this.generation++;
    this.chunker.reset();
    this.awaitingAudio.clear();
    this.audioPending = false;
    const t = this.tts;
    this.tts = null;
    this.ttsOpening = null;
    t?.abort();
    this.player.stop();
    this.blockTookDeltas = false;
    this.speaking = true; // force the reset below even if nothing was playing yet
    this.setSpeaking(false);
  }
}
