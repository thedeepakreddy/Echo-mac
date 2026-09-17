import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

export interface JarvisConfig {
  brain: "claude" | "gemini" | "ollama";
  claude: { model: string; systemPromptPreset: "claude_code" | "none" };
  gemini: { model: string; apiKeyEnv: string };
  ollama: { model: string; host: string };
  voice: {
    wakeWord: boolean;
    /**
     * "whisper" — keyless: every utterance is transcribed and checked for
     * "Jarvis" (no signup, fully on-device). "porcupine" — dedicated keyword
     * model, needs a Picovoice access key. "none" — push-to-talk only.
     */
    /**
     * "auto" — a Porcupine/openWakeWord model at wakeKeywordPath if there is
     * one, else the built-in template spotter (models/wake/templates.json),
     * else the transcript matcher. "whisper" is the old keyless value and is
     * treated as "auto"; "none" is push-to-talk only.
     */
    wakeEngine: "auto" | "porcupine" | "onnx" | "template" | "whisper" | "none";
    /**
     * Wake-word model for the acoustic detector: a Porcupine `.ppn` trained on
     * the Picovoice Console (engine "porcupine") or an openWakeWord-format
     * `.onnx` (engine "onnx"). Relative paths resolve against the app root.
     * "auto" picks by extension, falls back to the built-in template spotter
     * (models/wake/templates.json, see `npm run enroll`), then to the
     * transcript matcher.
     */
    wakeKeywordPath?: string;
    /**
     * Keep the always-on transcript check running alongside an acoustic
     * detector. Costs a local whisper pass per room noise; buys recall when the
     * detector misses. Default true.
     */
    wakeTranscriptFallback?: boolean;
    /** Silero VAD model; empty disables the model and uses the RMS level. */
    vadModel?: string;
    /** Stream audio to the STT while the user speaks (Sarvam realtime), so the transcript is ready at end of speech. */
    sttStreaming?: boolean;
    /** Sarvam realtime model: "saaras:v4" (default) or "saaras:v3-realtime". */
    sttStreamModel?: string;
    /** Speak the reply sentence by sentence as the model writes it, through the persistent player. */
    ttsStreaming?: boolean;
    /** Microphone/speaker path: the echo-cancelling voiceio helper when it runs, else PvRecorder + afplay. */
    captureEngine?: "auto" | "voiceio" | "pvrecorder";
    /** Spoken replies longer than this many sentences are cut with "the rest is on screen". 0 = never. */
    maxSpokenSentences?: number;
    /**
     * Voice barge-in: interrupt Jarvis by speaking over it. OFF by default.
     * It relies on telling your voice apart from Jarvis's own playback leaking
     * into the mic, which is unreliable on shared speaker/mic devices like
     * AirPods (Jarvis plays into the same earbud that is listening) and makes it
     * cut its own speech. To interrupt without this, right-click the reactor or
     * press Cmd+Shift+dot — both stop Jarvis instantly and always work.
     */
    bargeIn: boolean;
    /**
     * Microphone to listen on. -1 uses the system default; a number picks that
     * index from `npm run miccheck`; a string matches a device by name, which
     * survives indices shifting as devices connect and disconnect.
     */
    inputDevice: number | string;
    picovoiceAccessKeyEnv: string;
    sensitivity: number;
    /** Sound played when the wake word is recognised ('' disables). */
    wakeSound: string;
    /**
     * Seconds of that sound to play; 0 plays the whole file. Prefer trimming
     * the asset itself — afplay's -t is unreliable on compressed audio.
     */
    wakeSoundSeconds: number;
    /**
     * Which TTS engine to use:
     * - `mac`: macOS built-in `say` command (fast, free, offline)
     * - `fakeyou`: FakeYou inference (slower, relies on community models)
     * - `elevenlabs`: High quality (requires ELEVENLABS_API_KEY)
     * - `local-clone`: Local python inference
     * - `sarvam`: Indian languages TTS (requires SARVAM_API_KEY)
     */
    ttsEngine?: "mac" | "fakeyou" | "elevenlabs" | "local-clone" | "sarvam";
    elevenLabsVoiceId?: string;
    ttsVoice: string;
    ttsEnabled: boolean;
    sttModel: string;
    whisperBin: string;
    /**
     * Which engine transcribes a spoken command.
     * - `whisper`: local whisper.cpp. Offline, free, nothing leaves the machine.
     *   Weak on Indian languages, and a `.en` model cannot decode them at all.
     * - `sarvam`: Sarvam's cloud STT (requires SARVAM_API_KEY). Built for Indian
     *   languages and far more accurate on them than any local whisper model.
     *
     * Even on `sarvam`, the wake-word pass stays local: audio that turns out not
     * to be addressed to Echo never leaves the machine, and only real commands
     * cost a network round-trip.
     */
    /**
     * Which Sarvam voice speaks. Speakers are tied to the model generation —
     * `bulbul:v3` offers aditya, ritu, ashutosh, priya, neha, rahul, pooja,
     * rohan, simran, kavya, amit, dev, ishita, shreya, ratan, varun, manan,
     * sumit, roopa, kabir, aayan, shubh, advait, anand, tanya, tarun, sunny,
     * mani, gokul, vijay, shruti, suhani, mohit, kavitha, rehan, soham, rupali.
     * A speaker from an older generation is rejected outright, not ignored.
     */
    sarvamSpeaker?: string;
    /** Speaking rate. 1 is the voice's natural pace; below 1 is slower. */
    sarvamPace?: number;
    sttProvider?: "whisper" | "sarvam" | "apple";
    /**
     * Send the recording of a spoken turn to the brain, alongside its
     * transcript, so the model hears the turn instead of only reading it —
     * tone, emphasis, hesitation, and the words the transcriber got wrong.
     *
     * OFF by default, because it changes where audio goes. On the local-whisper
     * route nothing spoken currently leaves the machine at all; turning this on
     * sends every utterance addressed to Echo to the cloud brain. The wake-word
     * pass stays local either way, so audio that was never meant for Echo is
     * still never sent.
     *
     * Only the Gemini brain can listen today (see Brain.hearsAudio); with any
     * other brain this does nothing.
     */
    sendAudioToBrain?: boolean;
    /**
     * Spoken language, as an ISO code — `en`, `te` (Telugu), `hi`. Passed to
     * whisper's `-l` and mapped to Sarvam's language code. `auto` lets the
     * engine detect it, which costs some accuracy on short commands.
     *
     * NOTE: whisper only honours this on a multilingual model. The bundled
     * `ggml-base.en.bin` is English-only and will ignore it.
     */
    sttLanguage?: string;
    silenceMs: number;
    maxUtteranceMs: number;
    /**
     * Conversation mode. After you wake Echo once ("Echo …"), it keeps the
     * conversation open: it re-opens the mic after each reply so you can keep
     * talking without repeating the wake word. It is NOT always-listening — the
     * mic only opens briefly after each reply, and the moment you go quiet the
     * conversation ends and Echo waits for "Echo" again.
     */
    conversationMode: boolean;
    /** How long the follow-up mic stays armed before the conversation ends (ms). */
    conversationWindowMs: number;
  };
  control: { cliclickBin: string; workingDir: string };
  hud: {
    startListeningOnLaunch: boolean;
    /**
     * Which reactor the HUD draws. "classic" is the circular coil reactor drawn
     * in CSS; "mark50" and "jarvis" composite a rendered reactor from assets/
     * through the same three-layer path. Switchable by voice, and remembered
     * here so it survives a restart.
     */
    skin: "classic" | "mark50" | "jarvis";
  };
  /**
   * Background helpers that watch the screen on a timer.
   *
   * All default OFF, because each one costs a full-screen OCR on every tick and
   * they run whether or not you are asking for anything. Measured on this
   * machine with shadow on: visionhelper sat near 90% CPU permanently and the
   * load average passed 14 — the machine became unusable while Echo appeared
   * idle. Anything that polls the screen forever has to be something you turn
   * on deliberately, not something that starts because a port happened to
   * answer.
   */
  helpers: {
    /** Watches your IDE and offers to finish code. OCR + a local LLM call. */
    shadow: boolean;
    /** Looks for repeated patterns worth automating. */
    ghost: boolean;
    /** Watches a terminal log and offers to explain errors. */
    autoDebug: boolean;
    /** Seconds between shadow's screen reads. Lower is far more expensive. */
    shadowIntervalSeconds: number;
  };
  /**
   * Rehearse UI paths while you are away. Off by default: it spends tokens and
   * moves the mouse on its own, which should always be an explicit choice.
   */
  dreaming: { enabled: boolean };
  /**
   * Which part of the camera's view maps to the screen, in Vision's space
   * (origin bottom-left). Narrow the band if you cannot reach the screen edges;
   * widen it if the cursor feels twitchy.
   */
  gestureRegion: { xMin: number; xMax: number; yMin: number; yMax: number };
  /**
   * Record what the teacher brains do, as training data for a local model.
   *
   * Unlike `memory`, which deliberately never stores screen contents, this
   * stores screenshots and on-screen text — that is the whole point, and it is
   * why it is opt-in. Everything stays on this machine, in
   * ~/.jarvis/trajectories, and can be deleted by hand at any time.
   */
  learning: {
    enabled: boolean;
    /** Off keeps text observations only, which is far smaller on disk. */
    captureScreens: boolean;
    /** Zero is unlimited. Positive values reject incomplete capped turns. */
    maxStepsPerTurn: number;
  };
  /**
   * Keep the phone remote open all the time, so the saved link always works.
   *
   * When on, the remote starts automatically at launch (if a password is set)
   * and never auto-closes — a standing, password-guarded door reachable only
   * over the private tailnet. Off by default because opening full control of
   * the machine should normally be a deliberate act.
   */
  remote: { alwaysOn: boolean };
  /**
   * The Memory OS: layered memory with scope, provenance and deletion.
   *
   * `importLegacy` folds the old memories.jsonl and episodic files into the
   * memory service once, preserving their original IDs, dates and projects and
   * marking their provenance unknown. It is a copy, not a move: the legacy
   * files stay where they are, so turning this off returns Echo to the old
   * readers with nothing lost.
   *
   * `cloudRecall` decides whether remembered content may be sent to a cloud
   * brain at all. Echo has always put saved memories in the prompt, and the
   * default keeps that. Turned off, a cloud brain still receives the CURRENT
   * task's state — it cannot do the task otherwise — but no recalled memory,
   * and the local Ollama brain is unaffected either way. Content Echo derived
   * from the screen, a scan or a web page is never shared with a cloud model
   * regardless of this setting, and neither is anything marked sensitive.
   *
   * `retentionDays` expires consolidated episodes. It applies only to records
   * created after it was switched on, so enabling it never deletes an existing
   * archive behind your back. Zero keeps episodes until they are forgotten.
   */
  memory: {
    enabled: boolean;
    importLegacy: boolean;
    cloudRecall: boolean;
    retentionDays: number;
  };
  /**
   * An optional private Telegram command channel. The bot token stays in an
   * environment variable and only the explicitly listed chat IDs may control
   * Echo — never leave allowedChatIds empty on a live bot.
   */
  telegram: { enabled: boolean; botTokenEnv: string; allowedChatIds: string[] };
  /**
   * The Osiris grid — the open-source OSINT globe Echo can put on screen and
   * read out loud.
   *
   * `baseUrl` pins one instance. Empty means decide at open time: a checkout
   * running on this machine when `preferLocal` is on, otherwise the project's
   * hosted deployment. The OSIRIS_URL environment variable overrides both, so a
   * branch can be pointed at for a single run without editing this.
   *
   * `defaultLayers` is the view the grid opens with when the command didn't name
   * any layers; empty means Echo's standard view (see STANDARD_VIEW in
   * tools/osiris-intel.ts).
   */
  osiris: { baseUrl: string; preferLocal: boolean; defaultLayers: string[] };
}

const DEFAULTS: JarvisConfig = {
  brain: "claude",
  claude: { model: "claude-opus-4-8", systemPromptPreset: "claude_code" },
  // gemini-2.5-flash is retired for new keys; 2.0-flash still resolves.
  gemini: { model: "gemini-2.0-flash", apiKeyEnv: "GEMINI_API_KEY" },
  ollama: { model: "llama3.2:3b", host: "http://localhost:11434" },
  voice: {
    wakeWord: true,
    wakeEngine: "auto",
    wakeKeywordPath: "",
    wakeTranscriptFallback: true,
    vadModel: "models/silero_vad.onnx",
    sttStreaming: true,
    sttStreamModel: "saaras:v4",
    ttsStreaming: true,
    captureEngine: "auto",
    maxSpokenSentences: 6,
    bargeIn: true,
    inputDevice: -1,
    picovoiceAccessKeyEnv: "PICOVOICE_ACCESS_KEY",
    sensitivity: 0.6,
    wakeSound: "assets/wake-short.wav",
    wakeSoundSeconds: 0,
    ttsEngine: "mac",
    ttsVoice: "Daniel",
    ttsEnabled: true,
    sttModel: "models/ggml-base.en.bin",
    whisperBin: "/opt/homebrew/bin/whisper-cli",
    sarvamSpeaker: "aditya",
    sarvamPace: 1,
    sttProvider: "whisper",
    sttLanguage: "en",
    sendAudioToBrain: false,
    silenceMs: 900,
    maxUtteranceMs: 15000,
    conversationMode: true,
    conversationWindowMs: 12000,
  },
  control: { cliclickBin: "/opt/homebrew/bin/cliclick", workingDir: "~" },
  hud: { startListeningOnLaunch: true, skin: "classic" },
  helpers: { shadow: false, ghost: false, autoDebug: false, shadowIntervalSeconds: 60 },
  dreaming: { enabled: false },
  gestureRegion: { xMin: 0.2, xMax: 0.8, yMin: 0.35, yMax: 0.8 },
  learning: { enabled: false, captureScreens: true, maxStepsPerTurn: 0 },
  remote: { alwaysOn: false },
  memory: { enabled: true, importLegacy: true, cloudRecall: true, retentionDays: 0 },
  telegram: { enabled: false, botTokenEnv: "TELEGRAM_BOT_TOKEN", allowedChatIds: [] },
  osiris: { baseUrl: "", preferLocal: true, defaultLayers: [] },
};

/** The built-in defaults, for tests that need a config without a config.json. */
export const DEFAULTS_FOR_TESTS: JarvisConfig = DEFAULTS;

function deepMerge<T>(base: T, override: any): T {
  if (override == null || typeof override !== "object") return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const k of Object.keys(override)) {
    const b = (base as any)?.[k];
    const o = override[k];
    out[k] =
      b && typeof b === "object" && !Array.isArray(b) ? deepMerge(b, o) : o;
  }
  return out;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Load config.json (falling back to config.example.json, then built-in defaults). */
export function loadConfig(appRoot: string): JarvisConfig {
  const candidates = [join(appRoot, "config.json"), join(appRoot, "config.example.json")];
  let merged: JarvisConfig = DEFAULTS;
  for (const file of candidates) {
    if (existsSync(file)) {
      try {
        merged = deepMerge(DEFAULTS, JSON.parse(readFileSync(file, "utf8")));
      } catch (err) {
        console.error(`[config] failed to parse ${file}:`, err);
      }
      break;
    }
  }
  // Resolve model + working paths to absolute where sensible.
  merged.control.workingDir = expandHome(merged.control.workingDir);
  if (!isAbsolute(merged.voice.sttModel)) {
    merged.voice.sttModel = join(appRoot, merged.voice.sttModel);
  }
  if (merged.voice.wakeSound && !isAbsolute(merged.voice.wakeSound)) {
    merged.voice.wakeSound = join(appRoot, merged.voice.wakeSound);
  }
  return merged;
}
