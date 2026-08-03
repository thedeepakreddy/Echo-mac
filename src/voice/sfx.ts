import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Short UI sounds via macOS `afplay`.
 *
 * Playback is deliberately capped: the wake sound is an acknowledgement, and a
 * long one would still be playing while Jarvis is trying to speak its reply.
 */
export function playSound(file: string, seconds = 0): Promise<void> {
  return new Promise((resolve) => {
    if (!file || !existsSync(file)) return resolve();
    const args = seconds > 0 ? ["-t", String(seconds), file] : [file];
    const child = execFile("/usr/bin/afplay", args, () => resolve());
    child.on("error", () => resolve());
  });
}
