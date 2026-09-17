import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { JarvisConfig } from "../../config.js";
import type { WakeDetector } from "./detector.js";
import { PorcupineWake } from "./porcupine.js";
import { OnnxWake } from "./onnx.js";
import { TemplateWake } from "./template.js";
import { transcribeFrames } from "../stt.js";
import { matchWakeWord } from "../wakeword.js";

export type { WakeDetector, WakeDetection } from "./detector.js";

/**
 * Build the wake-word detector the configuration asks for.
 *
 *   porcupine  models/wake/echo_mac.ppn + PICOVOICE_ACCESS_KEY  (best; needs a Console-trained keyword)
 *   onnx       models/wake/echo.onnx + the openWakeWord feature models (yours; trained in their notebook)
 *   template   models/wake/templates.json                         (built in; `npm run enroll`)
 *   whisper    none — the transcript matcher only, as it always was
 *
 * "auto" takes the keyword file by its extension, then the template store, and
 * returns null when nothing is available so the listener keeps the transcript
 * path. Every failure here is logged and degrades; none stops the voice.
 */
export async function createWakeDetector(cfg: JarvisConfig, appRoot: string): Promise<WakeDetector | null> {
  // "whisper" was the keyless default for a long time and sits in old
  // config.json files; it means the transcript path stays on (it does, via
  // wakeTranscriptFallback), not that the acoustic detector must stay off.
  const engine = cfg.voice.wakeEngine === "whisper" ? "auto" : cfg.voice.wakeEngine ?? "auto";
  if (cfg.voice.wakeWord === false || engine === "none") return null;

  const resolve = (p: string) => (isAbsolute(p) ? p : join(appRoot, p));
  const modelsDir = join(appRoot, "models", "wake");
  let keyword = cfg.voice.wakeKeywordPath ? resolve(cfg.voice.wakeKeywordPath) : "";
  if (!keyword && engine === "auto") {
    for (const candidate of ["echo_mac.ppn", "echo.ppn", "echo.onnx"]) {
      const p = join(modelsDir, candidate);
      if (existsSync(p)) {
        keyword = p;
        break;
      }
    }
  }
  const sensitivity = cfg.voice.sensitivity ?? 0.6;
  const accessKey = process.env[cfg.voice.picovoiceAccessKeyEnv || "PICOVOICE_ACCESS_KEY"] ?? "";

  const porcupine = () => PorcupineWake.load(keyword, accessKey, sensitivity);
  // openWakeWord recommends 0.5; sensitivity 0.6 lands there, higher is keener.
  const onnx = () => OnnxWake.load(keyword, modelsDir, Math.min(0.9, Math.max(0.2, 1.1 - sensitivity)));
  const template = () =>
    TemplateWake.load(join(modelsDir, "templates.json"), {
      verifier: makeVerifier(cfg),
    });

  switch (engine) {
    case "porcupine":
      return porcupine();
    case "onnx":
      return onnx();
    case "template":
      return template();
    default: {
      if (keyword.endsWith(".ppn")) {
        const d = await porcupine();
        if (d) return d;
      }
      if (keyword.endsWith(".onnx")) {
        const d = await onnx();
        if (d) return d;
      }
      return template();
    }
  }
}

/**
 * Second opinion for the template spotter: does whisper hear the name in the
 * last second? Bounded so a slow model cannot hold the chirp hostage.
 *
 * The hard part is that whisper does not decline to answer. Given audio it
 * cannot read it INVENTS text from its training data, and it invents the same
 * text every time — a real capture produced "Microsoft Word Document MSWordDoc
 * Word.D" on four consecutive candidates. Treating that as a transcript meant a
 * confident acoustic match was vetoed by a string the microphone never carried,
 * and Echo ignored someone who was calling it by name, repeatedly.
 *
 * So the veto is now conditional. Whisper can overrule the spotter only when it
 * returns something that plausibly came from THIS audio. When it returns
 * nothing, or returns the same text it just returned for different audio, it
 * has no opinion — and the acoustic detector's own confidence decides instead.
 */
const ACOUSTIC_TRUST = 0.45;

export function makeVerifier(cfg: JarvisConfig): (frames: Int16Array[], score?: number) => Promise<boolean> {
  let lastText = "";
  let repeats = 0;
  let warned = false;

  return async (frames, score = 0) => {
    // The word is at the end; a second is plenty and keeps whisper fast.
    const keep = Math.ceil(1.2 * 16000 / 512);
    const recent = frames.slice(-keep);

    const text = await Promise.race([
      transcribeFrames(recent, cfg).catch(() => ""),
      new Promise<string>((r) => setTimeout(() => r(""), 700)),
    ]);
    const trimmed = (text ?? "").trim();

    if (matchWakeWord(trimmed).matched) {
      lastText = trimmed;
      repeats = 0;
      return true;
    }

    // Identical output for two different candidates means whisper is reading
    // its own weights, not the microphone.
    if (trimmed && trimmed === lastText) repeats++;
    else { repeats = 0; lastText = trimmed; }
    const artefact = repeats >= 1;

    if (!trimmed || artefact) {
      if (artefact && !warned) {
        warned = true;
        console.warn(
          `[wake] whisper keeps returning the same text for different audio ` +
          `(${JSON.stringify(trimmed.slice(0, 48))}) — treating it as a hallucination ` +
          `and trusting the acoustic detector instead.`
        );
      }
      // No usable second opinion: let the spotter's own confidence decide.
      return score >= ACOUSTIC_TRUST;
    }

    console.log(`[wake] candidate rejected by whisper: ${JSON.stringify(trimmed.slice(0, 40))}`);
    return false;
  };
}
