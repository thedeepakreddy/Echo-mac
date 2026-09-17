import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeWav } from "./wav.js";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { run } from "../tools/shell.js";
import type { JarvisConfig } from "../config.js";
import { buildVocabulary } from "./vocabulary.js";
import { getAppPath } from "../utils/appPath.js";

/**
 * Speech-to-text, either locally via whisper.cpp or through Sarvam's cloud API.
 *
 * whisper.cpp is the default and handles the wake-word pass in every mode, so
 * room audio that was never addressed to Echo stays on the machine. Sarvam is
 * opt-in (voice.sttProvider) because it is the only thing here that transcribes
 * Telugu and the other Indian languages usefully — local whisper is poor at them
 * even on a multilingual model, and hopeless on a `.en` one.
 *
 * Two paths. The CLI reloads the ~141MB model on every invocation, which
 * measured at ~600ms for a short clip — almost all of it load, not inference.
 * `whisper-server` keeps the model resident, so repeat transcriptions cost only
 * the inference. We prefer the server and fall back to the CLI if it can't be
 * started, so speech never breaks just because the server is unavailable.
 */

let server: ChildProcess | null = null;
let serverPort = 0;
let serverReady: Promise<boolean> | null = null;

function serverBinFor(cliPath: string): string {
  return join(dirname(cliPath), "whisper-server");
}

/** The `-l` value for whisper. Defaults to English, as it always used to be. */
function whisperLang(cfg: JarvisConfig): string {
  // On the Sarvam route local whisper only ever runs the wake-word pass, and
  // the name is an English word however the rest of the sentence is spoken. Keep
  // that pass in English so the bundled `.en` model stays usable there.
  if (cfg.voice.sttProvider === "sarvam") return "en";
  return cfg.voice.sttLanguage || "en";
}

/**
 * Is the local model English-only? `.en` builds have no multilingual decoder at
 * all, so asking one for Telugu yields confident, fluent, invented English
 * rather than an error — worth saying out loud instead of letting it through.
 */
function isEnglishOnlyModel(cfg: JarvisConfig): boolean {
  return /\.en\.bin$/.test(cfg.voice.sttModel);
}

async function waitForServer(port: number, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: "GET" });
      if (res.ok || res.status === 404) return true; // listening either way
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Boot the persistent server once; resolves false if unavailable. */
function ensureServer(cfg: JarvisConfig): Promise<boolean> {
  if (serverReady) return serverReady;

  serverReady = (async () => {
    const bin = serverBinFor(cfg.voice.whisperBin);
    if (!existsSync(bin)) return false;

    // Reap whisper servers orphaned by a previous run. A hard exit (or a crash)
    // leaves them parented to launchd, still holding the model in memory, and
    // they accumulate across restarts.
    await run("/usr/bin/pkill", ["-f", "whisper-server"]).catch(() => null);

    serverPort = 8178 + Math.floor(Math.random() * 400);
    try {
      server = spawn(
        bin,
        [
          "-m", cfg.voice.sttModel,
          "--port", String(serverPort),
          "-l", whisperLang(cfg),
          "-nt",
          // Bias decoding toward the words this user actually says. Measured on
          // real command audio this cut word error from 6.5% to 4.8% and fixed
          // tense errors ("increased" -> "increase") that a bigger model did not.
          "--prompt", buildVocabulary(getAppPath()),
          "--carry-initial-prompt",
          // Stop whisper emitting "(laughing)" and similar for room noise.
          "-sns",
          // NOTE: beam search (-bs 5) is deliberately NOT enabled. On the
          // persistent server it consistently swallowed the leading wake word —
          // "Jarvis, what is on my screen?" decoded as "What is on my screen?",
          // which stops Jarvis answering to its own name. The same flag is
          // harmless via the one-shot CLI, so this only shows up in the path we
          // actually use. Greedy decoding keeps the first word.
        ],
        { stdio: "ignore" }
      );
      server.on("exit", () => {
        server = null;
        serverReady = null; // allow a later retry
      });
    } catch {
      return false;
    }

    const up = await waitForServer(serverPort);
    if (!up) {
      try {
        server?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      server = null;
      return false;
    }
    console.log(`[jarvis] whisper server ready on :${serverPort} (model stays loaded)`);
    return true;
  })();

  return serverReady;
}

export function stopSttServer() {
  try {
    server?.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  server = null;
  serverReady = null;
}

function clean(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\[.*?\]/g, "") // strip [BLANK_AUDIO] style markers
    .trim();
}

async function viaServer(wavPath: string): Promise<string | null> {
  try {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(wavPath)]), "audio.wav");
    form.append("response_format", "text");
    form.append("temperature", "0");
    const res = await fetch(`http://127.0.0.1:${serverPort}/inference`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) return null;
    return clean(await res.text());
  } catch {
    return null; // fall back to the CLI
  }
}

async function viaCli(wavPath: string, cfg: JarvisConfig): Promise<string> {
  const { stdout, stderr, code } = await run(
    cfg.voice.whisperBin,
    ["-m", cfg.voice.sttModel, "-f", wavPath, "-l", whisperLang(cfg), "-nt", "-np"],
    60000
  );
  if (code !== 0 && !stdout.trim()) {
    throw new Error(`whisper-cli failed (${code}): ${stderr.slice(0, 200)}`);
  }
  return clean(stdout);
}

/**
 * Sarvam wants a region-qualified code; the config carries a bare one. Anything
 * already qualified ("te-IN") passes through untouched.
 */
function sarvamLang(cfg: JarvisConfig): string {
  const lang = (cfg.voice.sttLanguage || "en").toLowerCase();
  if (lang === "auto") return "unknown"; // Sarvam's spelling for detect-it-yourself
  return lang.includes("-") ? lang : `${lang}-IN`;
}

async function viaSarvam(wavPath: string, cfg: JarvisConfig): Promise<string> {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error("voice.sttProvider is 'sarvam' but SARVAM_API_KEY is not set.");

  const form = new FormData();
  form.append("file", new Blob([readFileSync(wavPath)]), "audio.wav");
  form.append("model", "saarika:v2.5");
  form.append("language_code", sarvamLang(cfg));

  const res = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": key },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`sarvam stt failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data: any = await res.json();
  return clean(String(data?.transcript ?? ""));
}

/** Transcribe a WAV file with the local whisper.cpp model, ignoring sttProvider. */
export async function transcribeLocal(wavPath: string, cfg: JarvisConfig): Promise<string> {
  if (!existsSync(cfg.voice.sttModel)) {
    throw new Error(
      `Whisper model not found at ${cfg.voice.sttModel}. Download it (see README) or fix voice.sttModel in config.json.`
    );
  }
  if (whisperLang(cfg) !== "en" && isEnglishOnlyModel(cfg)) {
    throw new Error(
      `voice.sttLanguage is "${whisperLang(cfg)}" but ${cfg.voice.sttModel} is an English-only model. ` +
        `Point voice.sttModel at a multilingual build (one without ".en"), or set voice.sttProvider to "sarvam".`
    );
  }

  if (await ensureServer(cfg)) {
    const text = await viaServer(wavPath);
    if (text !== null) return text;
  }
  return viaCli(wavPath, cfg);
}

/**
 * Transcribe raw 16 kHz frames with the local model — for the wake-word
 * verifier, which holds the last second of audio in memory rather than on disk.
 */
export async function transcribeFrames(frames: Int16Array[], cfg: JarvisConfig): Promise<string> {
  const path = join(tmpdir(), `echo-verify-${process.pid}-${Date.now()}.wav`);
  await writeWav(frames, path, 16000);
  try {
    return await transcribeLocal(path, cfg);
  } finally {
    unlink(path).catch(() => {});
  }
}

/** Transcribe a WAV file using whichever engine voice.sttProvider selects. */
export async function transcribe(wavPath: string, cfg: JarvisConfig): Promise<string> {
  if (cfg.voice.sttProvider === "sarvam") return viaSarvam(wavPath, cfg);
  // "apple" streams while the user speaks (stt-stream.ts); for a file there is
  // nothing on-device to call, so whisper reads it.
  return transcribeLocal(wavPath, cfg);
}

/** Start the model loading now so the first command isn't slowed by it. */
export function warmUpStt(cfg: JarvisConfig) {
  void ensureServer(cfg);
}
