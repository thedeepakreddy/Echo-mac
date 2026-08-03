import { spawn, ChildProcess } from "node:child_process";
import { withProsody } from "./prosody.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Speaks text aloud via the macOS `say` command or API (FakeYou / ElevenLabs).
 * Emits nothing; callers can await speak() or fire-and-forget. stop() cuts the
 * current utterance and clears the queue (used when the user interrupts Jarvis).
 */
export class Tts {
  private queue: string[] = [];
  private current: ChildProcess | null = null;
  private speaking = false;
  /** Bumped by stop(), so an interrupted drain knows it has been superseded. */
  private generation = 0;

  constructor(
    private voice: string,
    private enabled: boolean,
    private engine: "mac" | "fakeyou" | "elevenlabs" | "local-clone" = "mac",
    private elevenLabsVoiceId?: string,
    private onStateChange?: (speaking: boolean) => void
  ) {}

  say(text: string) {
    const clean = text.replace(/```[\s\S]*?```/g, " code block ").replace(/\s+/g, " ").trim();
    if (!this.enabled || !clean) return;
    this.queue.push(clean);
    if (!this.speaking) void this.drain();
  }

  private async fetchElevenLabs(text: string): Promise<string | null> {
    if (!this.elevenLabsVoiceId || !process.env.ELEVENLABS_API_KEY) {
      console.error("[elevenlabs] missing voice ID or API key");
      return null;
    }
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2"
        })
      });
      if (!res.ok) {
        console.error("[elevenlabs] http error:", res.status, await res.text());
        return null;
      }
      const buffer = await res.arrayBuffer();
      const tmpPath = join(tmpdir(), `elevenlabs_${Date.now()}.mp3`);
      writeFileSync(tmpPath, Buffer.from(buffer));
      return tmpPath;
    } catch (err) {
      console.error("[elevenlabs] fetch error:", err);
      return null;
    }
  }

  private async fetchFakeYou(text: string): Promise<string | null> {
    const model = "weight_vadc6zst7jq26jdfhkckab8yh";
    const idempotency = Math.random().toString(36).substring(2) + Date.now().toString(36);
    
    try {
      const res = await fetch("https://api.fakeyou.com/tts/inference", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          tts_model_token: model,
          uuid_idempotency_token: idempotency,
          inference_text: text
        })
      });
      const data = await res.json();
      if (!data.success) return null;
      const jobToken = data.inference_job_token;

      while (true) {
        await new Promise(r => setTimeout(r, 2000));
        const checkRes = await fetch(`https://api.fakeyou.com/tts/job/${jobToken}`);
        const checkData = await checkRes.json();
        const state = checkData.state?.status;
        if (state === "complete_success") {
          const path = checkData.state.maybe_public_bucket_wav_audio_path;
          const audioRes = await fetch(`https://storage.fakeyou.com${path}`);
          const buffer = await audioRes.arrayBuffer();
          const tmpPath = join(tmpdir(), `fakeyou_${Date.now()}.wav`);
          writeFileSync(tmpPath, Buffer.from(buffer));
          return tmpPath;
        } else if (state === "dead" || state === "attempt_failed") {
          return null;
        }
      }
    } catch (err) {
      console.error("[fakeyou] fetch error:", err);
      return null;
    }
  }

  private async fetchLocalClone(text: string): Promise<string | null> {
    try {
      // Pick a random reference file from the extracted deepak_voice_source
      // Hardcoded to one of the files for scaffolding purposes
      const refAudio = join(process.cwd(), "deepak_voice_source", "TrainingData", "yXLHR_91.caf");
      const tmpPath = join(tmpdir(), `local_tts_${Date.now()}.wav`);
      const scriptPath = join(process.cwd(), "scripts", "local_tts.py");

      await new Promise<void>((resolve, reject) => {
        const p = spawn("python3", [scriptPath, "--text", text, "--ref", refAudio, "--out", tmpPath]);
        p.stdout.on("data", d => console.log(d.toString().trim()));
        p.stderr.on("data", d => console.error(d.toString().trim()));
        p.on("exit", code => code === 0 ? resolve() : reject(new Error(`Exit code ${code}`)));
        p.on("error", err => reject(err));
      });

      return tmpPath;
    } catch (err) {
      console.error("[local-clone] generation error:", err);
      return null;
    }
  }

  private async drain() {
    const generation = ++this.generation;
    this.speaking = true;
    this.onStateChange?.(true);

    while (this.queue.length && generation === this.generation) {
      const text = this.queue.shift()!;
      
      let audioPath: string | null = null;
      if (this.engine === "fakeyou") {
        console.log(`[jarvis] fetching fakeyou voice for: "${text.slice(0, 30)}..."`);
        audioPath = await this.fetchFakeYou(text);
      } else if (this.engine === "elevenlabs") {
        console.log(`[jarvis] fetching elevenlabs voice for: "${text.slice(0, 30)}..."`);
        audioPath = await this.fetchElevenLabs(text);
      } else if (this.engine === "local-clone") {
        console.log(`[jarvis] running local open-source clone for: "${text.slice(0, 30)}..."`);
        audioPath = await this.fetchLocalClone(text);
      }

      // If stop() was called while downloading audio, don't play it.
      if (generation !== this.generation) break;

      await new Promise<void>((resolve) => {
        // Never let two utterances overlap. Anything still playing is stale by
        // definition — one voice at a time is the whole contract of this class.
        if (this.current) {
          this.current.kill("SIGTERM");
          this.current = null;
        }
        if ((this.engine === "fakeyou" || this.engine === "elevenlabs" || this.engine === "local-clone") && audioPath) {
          this.current = spawn("/usr/bin/afplay", [audioPath]);
        } else {
          // Give the line a delivery rather than reading it flat: pitch,
          // expressiveness, pace and real pauses chosen from what it says.
          this.current = spawn("/usr/bin/say", ["-v", this.voice, withProsody(text)]);
        }
        this.current.on("exit", () => resolve());
        this.current.on("error", () => resolve());
      });
      this.current = null;
    }

    // If stop() ran, it already reported that speech ended and a newer drain may
    // be underway. Announcing it a second time here would look like a fresh end
    // of speech and re-open the microphone for an answer nobody was asked for.
    if (generation !== this.generation) return;
    this.speaking = false;
    this.onStateChange?.(false);
  }

  /** Cut speech off immediately — used when the user talks over Jarvis. */
  stop() {
    this.generation++;
    this.queue = [];
    if (this.current) {
      this.current.kill("SIGTERM");
      this.current = null;
    }
    if (!this.speaking) return;
    this.speaking = false;
    this.onStateChange?.(false);
  }

  isSpeaking() {
    return this.speaking;
  }
}
