import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run a binary with argv (no shell — arguments are passed verbatim, so there is
 * no shell-injection surface even when values come from the model).
 */
export function run(bin: string, args: string[], timeoutMs = 20000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        code: err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0,
      });
    });
  });
}

/** Run an AppleScript snippet via osascript and return stdout (trimmed). */
export async function osascript(script: string): Promise<string> {
  const { stdout } = await run("/usr/bin/osascript", ["-e", script]);
  return stdout.trim();
}
