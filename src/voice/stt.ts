import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { run } from "../tools/shell.js";
import type { JarvisConfig } from "../config.js";
import { buildVocabulary } from "./vocabulary.js";
import { getAppPath } from "../utils/appPath.js";

/**
 * Speech-to-text via whisper.cpp.
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
          "-l", "en",
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
    ["-m", cfg.voice.sttModel, "-f", wavPath, "-l", "en", "-nt", "-np"],
    60000
  );
  if (code !== 0 && !stdout.trim()) {
    throw new Error(`whisper-cli failed (${code}): ${stderr.slice(0, 200)}`);
  }
  return clean(stdout);
}

/** Transcribe a WAV file to text using the local whisper.cpp model. */
export async function transcribe(wavPath: string, cfg: JarvisConfig): Promise<string> {
  if (!existsSync(cfg.voice.sttModel)) {
    throw new Error(
      `Whisper model not found at ${cfg.voice.sttModel}. Download it (see README) or fix voice.sttModel in config.json.`
    );
  }

  if (await ensureServer(cfg)) {
    const text = await viaServer(wavPath);
    if (text !== null) return text;
  }
  return viaCli(wavPath, cfg);
}

/** Start the model loading now so the first command isn't slowed by it. */
export function warmUpStt(cfg: JarvisConfig) {
  void ensureServer(cfg);
}
