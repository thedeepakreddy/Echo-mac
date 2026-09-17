/**
 * Gemini Live feasibility spike — NOT part of the voice pipeline.
 *
 * Opens one Live session with this key, streams a synthesised sentence as
 * 16 kHz PCM, and reports whether audio comes back, how fast, and whether the
 * server sends input/output transcripts. The point is a measured answer to
 * "could Echo run full duplex on the model itself?" without wiring anything.
 *
 *   npm run livetest
 */
import { execFile } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { loadConfig } from "./config.js";
import { loadEnv } from "./env.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
loadEnv(ROOT);
const cfg = loadConfig(ROOT);
const key = process.env[cfg.gemini?.apiKeyEnv ?? "GEMINI_API_KEY"];
if (!key) {
  console.log("no GEMINI_API_KEY");
  process.exit(1);
}

function readWav16k(path: string): Buffer {
  const buf = readFileSync(path);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const aiff = join(tmpdir(), `live-${Date.now()}.aiff`);
const wav = aiff.replace(/\.aiff$/, ".wav");
await run("/usr/bin/say", ["-v", "Samantha", "-o", aiff, "Hello. In one short sentence, what can you help me with?"]);
await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
const pcm = readWav16k(wav);
try { unlinkSync(aiff); unlinkSync(wav); } catch { /* ignore */ }

const { GoogleGenAI, Modality } = await import("@google/genai");
const ai = new GoogleGenAI({ apiKey: key });
const models = [process.env.ECHO_LIVE_MODEL, "gemini-2.5-flash-native-audio-preview-12-2025"].filter(Boolean) as string[];

for (const model of models) {
  console.log(`\nGemini Live — ${model}`);
  const t0 = performance.now();
  let audioBytes = 0, firstAudio = -1, inputTx = "", outputTx = "", done = false, failed = "";
  try {
    const session: any = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: "You are Echo, a concise voice assistant. Reply in one short sentence.",
      },
      callbacks: {
        onopen: () => console.log(`  open +${Math.round(performance.now() - t0)}ms`),
        onmessage: (m: any) => {
          const sc = m.serverContent;
          if (sc?.inputTranscription?.text) inputTx += sc.inputTranscription.text;
          if (sc?.outputTranscription?.text) outputTx += sc.outputTranscription.text;
          for (const p of sc?.modelTurn?.parts ?? []) {
            if (p.inlineData?.data) {
              const n = Buffer.from(p.inlineData.data, "base64").length;
              if (firstAudio < 0) firstAudio = performance.now() - t0;
              audioBytes += n;
            }
          }
          if (sc?.interrupted) console.log("  server: interrupted (barge-in signal)");
          if (sc?.turnComplete) done = true;
        },
        onerror: (e: any) => { failed = String(e?.message ?? e); },
        onclose: (e: any) => { if (!done && !failed) failed = `closed: ${e?.reason ?? ""}`; },
      },
    });
    // Stream the clip in 100 ms chunks, real time.
    const tSend = performance.now();
    for (let off = 0; off < pcm.length; off += 3200) {
      session.sendRealtimeInput({ audio: { data: pcm.subarray(off, off + 3200).toString("base64"), mimeType: "audio/pcm;rate=16000" } });
      await new Promise((r) => setTimeout(r, 100));
    }
    // Tell the server the speech is over, then also nudge with text if no
    // audio comes back — to separate "no reply" from "waiting for turn end".
    session.sendRealtimeInput({ audioStreamEnd: true });
    const tEnd = performance.now();
    setTimeout(() => {
      if (audioBytes === 0 && !done) {
        console.log("  (no audio after 5 s — sending a text turn to check the reply path)");
        session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "Say hello in five words." }] }], turnComplete: true });
      }
    }, 5000);
    const deadline = Date.now() + 12000;
    while (!done && !failed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    session.close();
    console.log(`  audio sent in ${Math.round(tEnd - tSend)}ms · first audio back ${firstAudio < 0 ? "never" : `+${Math.round(firstAudio - tEnd)}ms after end of speech`} · ${audioBytes} bytes (${(audioBytes / 2 / 24000).toFixed(2)}s @24k)`);
    if (inputTx) console.log(`  heard:  ${JSON.stringify(inputTx.trim())}`);
    if (outputTx) console.log(`  said:   ${JSON.stringify(outputTx.trim())}`);
    if (failed) console.log(`  failed: ${failed.slice(0, 200)}`);
    if (audioBytes > 0) break;
  } catch (err: any) {
    console.log(`  failed: ${String(err?.message ?? err).slice(0, 220)}`);
  }
}
console.log();
