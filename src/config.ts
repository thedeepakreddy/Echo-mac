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
    wakeEngine: "whisper" | "porcupine" | "none";
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
    ttsEngine?: "mac" | "fakeyou" | "elevenlabs" | "local-clone";
    elevenLabsVoiceId?: string;
    ttsVoice: string;
    ttsEnabled: boolean;
    sttModel: string;
    whisperBin: string;
    silenceMs: number;
    maxUtteranceMs: number;
  };
  control: { cliclickBin: string; workingDir: string };
  hud: { startListeningOnLaunch: boolean };
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
}

const DEFAULTS: JarvisConfig = {
  brain: "claude",
  claude: { model: "claude-opus-4-8", systemPromptPreset: "claude_code" },
  // gemini-2.5-flash is retired for new keys; 2.0-flash still resolves.
  gemini: { model: "gemini-2.0-flash", apiKeyEnv: "GEMINI_API_KEY" },
  ollama: { model: "llama3.2:3b", host: "http://localhost:11434" },
  voice: {
    wakeWord: true,
    wakeEngine: "whisper",
    bargeIn: false,
    inputDevice: -1,
    picovoiceAccessKeyEnv: "PICOVOICE_ACCESS_KEY",
    sensitivity: 0.6,
    wakeSound: "assets/wake.wav",
    wakeSoundSeconds: 0,
    ttsEngine: "mac",
    ttsVoice: "Daniel",
    ttsEnabled: true,
    sttModel: "models/ggml-base.en.bin",
    whisperBin: "/opt/homebrew/bin/whisper-cli",
    silenceMs: 900,
    maxUtteranceMs: 15000,
  },
  control: { cliclickBin: "/opt/homebrew/bin/cliclick", workingDir: "~" },
  hud: { startListeningOnLaunch: true },
  dreaming: { enabled: false },
  gestureRegion: { xMin: 0.2, xMax: 0.8, yMin: 0.35, yMax: 0.8 },
  learning: { enabled: false, captureScreens: true, maxStepsPerTurn: 60 },
  remote: { alwaysOn: false },
};

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
