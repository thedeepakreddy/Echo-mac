import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { getAppPath } from "../utils/appPath.js";
import { createInterface } from "node:readline";
import { Tts } from "../voice/tts.js";

let sonarProc: ChildProcessWithoutNullStreams | null = null;
let lastAlert = 0;

export function toggleSonar(enable: boolean, tts: Tts) {
  if (enable && !sonarProc) {
    const bin = join(getAppPath(), "native", "sonar");
    sonarProc = spawn(bin);

    // A missing or unrunnable helper must not kill the app. Without this,

    // spawn raises an uncaught ENOENT and Jarvis dies mid-sentence.

    sonarProc.on("error", (err: any) => {

      console.error("[jarvis] presence sensing unavailable:", err?.message ?? err);

      sonarProc = null;

    });
    
    const rl = createInterface({ input: sonarProc.stdout });
    
    rl.on("line", (line) => {
      try {
        const data = JSON.parse(line);
        if (data.alert === "acoustic_anomaly") {
          const now = Date.now();
          // debounce alerts by 10 seconds
          if (now - lastAlert > 10000) {
            lastAlert = now;
            tts.say("Warning! I detected a sudden acoustic anomaly. There was a loud noise in the room.");
          }
        }
      } catch (e) {
        // ignore parse errors
      }
    });
    
    sonarProc.on("exit", () => { sonarProc = null; });
  } else if (!enable && sonarProc) {
    sonarProc.kill();
    sonarProc = null;
  }
}
