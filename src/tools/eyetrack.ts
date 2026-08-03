import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { exec } from "node:child_process";
import { createRequire } from "node:module";
import { getAppPath } from "../utils/appPath.js";
import { desktopBounds } from "./displays.js";

const nodeRequire = createRequire(import.meta.url);

let trackerProc: ChildProcessWithoutNullStreams | null = null;
let lastBlink = false;

// We use an exponential moving average to smooth the jittery face landmarks.
let smoothX = 0;
let smoothY = 0;
const ALPHA = 0.3; // Smoothing factor (lower is smoother but slower)

export function toggleEyeTracking(enable: boolean) {
  if (enable && !trackerProc) {
    let electron;
    try { electron = nodeRequire("electron"); } catch {}
    if (!electron) return;
    const { screen } = electron;

    const bin = join(getAppPath(), "native", "facetracker");
    trackerProc = spawn(bin);

    // A missing or unrunnable helper must not kill the app. Without this,

    // spawn raises an uncaught ENOENT and Jarvis dies mid-sentence.

    trackerProc.on("error", (err: any) => {

      console.error("[jarvis] eye tracking unavailable:", err?.message ?? err);

      trackerProc = null;

    });
    
    const rl = createInterface({ input: trackerProc.stdout });
    const cliclick = "/opt/homebrew/bin/cliclick";
    // Span every display, so gaze can reach a second monitor rather than
    // stopping at the primary display's edge.
    const all = screen.getAllDisplays?.() ?? [screen.getPrimaryDisplay()];
    const { x: originX, y: originY, width, height } = desktopBounds(
      all.map((d: any, i: number) => ({
        index: i, id: d.id, x: d.bounds.x, y: d.bounds.y,
        width: d.bounds.width, height: d.bounds.height, primary: false,
      }))
    );
    
    // We want the user's nose in the middle of the camera to be the middle of the screen.
    // Normalized coordinates from vision are 0-1.
    // Let's assume standard face movement range is roughly 0.3 to 0.7.
    const RANGE = 0.4;
    
    rl.on("line", (line) => {
      try {
        const data = JSON.parse(line);
        // data.x and data.y are 0-1. Origin is bottom-left.
        // We mirror X because front camera is mirrored.
        let rawX = 1.0 - data.x;
        let rawY = 1.0 - data.y;
        
        // Map 0.3-0.7 to 0-1
        rawX = Math.max(0, Math.min(1, (rawX - 0.3) / RANGE));
        rawY = Math.max(0, Math.min(1, (rawY - 0.3) / RANGE));
        
        smoothX = smoothX === 0 ? rawX : (ALPHA * rawX) + ((1 - ALPHA) * smoothX);
        smoothY = smoothY === 0 ? rawY : (ALPHA * rawY) + ((1 - ALPHA) * smoothY);
        
        // The origin matters once a monitor sits left of or above the primary:
        // those displays occupy negative coordinates.
        const x = Math.round(originX + smoothX * width);
        const y = Math.round(originY + smoothY * height);
        
        let cmd = `${cliclick} m:${x},${y}`;
        
        // Blink to click
        if (data.blink && !lastBlink) {
          cmd = `${cliclick} c:${x},${y}`;
        }
        lastBlink = data.blink;
        
        exec(cmd);
      } catch (e) {
        // ignore
      }
    });
    
    trackerProc.on("exit", () => { trackerProc = null; });
  } else if (!enable && trackerProc) {
    trackerProc.kill();
    trackerProc = null;
  }
}
