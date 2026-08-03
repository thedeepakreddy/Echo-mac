import { spawn } from "node:child_process";
import { join } from "node:path";
import { getAppPath } from "../utils/appPath.js";

/**
 * Pillar 4: Deep System Hooking Wrapper
 * Executes the compiled Swift binary to perform an AXPress directly on the UI element
 * at the given coordinates within the specified PID, avoiding the need for `cliclick` and physical mouse movement.
 */
export async function deepHookClick(pid: number, x: number, y: number): Promise<{ ok: boolean, message: string }> {
  return new Promise((resolve) => {
    const binPath = join(getAppPath(), "native", "hooking"); // Assuming we compile hooking.swift to 'hooking'
    
    const proc = spawn(binPath, [String(pid), String(x), String(y)]);
    
    let stdout = "";
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    
    proc.on("close", (code) => {
      try {
        const result = JSON.parse(stdout);
        resolve({ ok: result.status === "success", message: result.message });
      } catch (e) {
        resolve({ ok: false, message: `Failed to parse hooking output. Code: ${code}, output: ${stdout}` });
      }
    });
    
    proc.on("error", (err) => {
      resolve({ ok: false, message: `Failed to spawn deep hooking binary: ${err.message}` });
    });
  });
}
