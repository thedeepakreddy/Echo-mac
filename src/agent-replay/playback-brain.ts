import { Brain } from "../brain/types.js";
import { contentHash } from "./recorder.js";
import { BlobStore, loadEvents } from "./replay-source.js";

/**
 * The Claude Agent SDK intentionally owns its network transport, so it cannot
 * accept a recorded provider response. This is a safe UI/session playback for
 * those recordings: it re-emits what happened and never starts an SDK query or
 * invokes a tool. Gemini and Ollama use the faithful runner instead.
 */
export class RecordedPlaybackBrain extends Brain {
  private stopped = false;

  constructor(private readonly runDir: string) {
    super();
  }

  send(userText: string): void {
    this.stopped = false;
    void this.play(userText);
  }

  private async play(userText: string): Promise<void> {
    try {
      const events = loadEvents(this.runDir);
      const blobs = new BlobStore(this.runDir);
      const input = events.find((event) => event.type === "agent.input");
      if (input?.bodyRef && contentHash(userText) !== input.bodyRef) {
        this.emitEvent("error", "This replay was recorded with a different request.");
        return;
      }
      this.emitEvent("status", "thinking");
      for (const event of events) {
        if (this.stopped) break;
        if (event.type === "agent.status" && typeof event.status === "string") {
          this.emitEvent("status", event.status as any);
        } else if (event.type === "agent.text" && typeof event.textRef === "string") {
          const text = blobs.get(event.textRef);
          if (typeof text === "string") this.emitEvent("text", text);
        } else if (event.type === "tool.call") {
          this.emitEvent("tool", { name: String(event.name), summary: String(event.name) });
        } else if (event.type === "process.unhandledRejection" || event.type === "process.uncaughtException") {
          this.emitEvent("error", String(event.message ?? "recorded process error"));
        }
        // Yield occasionally to keep the HUD responsive on a long trace.
        if (event.seq % 20 === 0) await Promise.resolve();
      }
      if (!this.stopped) this.emitEvent("turnEnd");
    } catch (error: any) {
      this.emitEvent("error", String(error?.message ?? error));
    } finally {
      this.emitEvent("status", "idle");
    }
  }

  interrupt(): void {
    this.stopped = true;
    this.emitEvent("status", "idle");
  }

  async stop(): Promise<void> {
    this.interrupt();
  }
}
