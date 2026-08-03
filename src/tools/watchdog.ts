import { watch } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";
import { sendToOverlay } from "../overlay.js";

let watchdog: import("node:fs").FSWatcher | null = null;
let eventCount = 0;
let resetTimer: NodeJS.Timeout | null = null;

export function startWatchdog() {
  if (watchdog) return;
  const home = process.env.HOME;
  if (!home) return;
  const docsDir = join(home, "Documents");
  
  function attachWatcher() {
    try {
      watchdog = watch(docsDir, (eventType) => {
        if (eventType === "rename") { // rename happens on delete/move
          eventCount++;
          
          if (!resetTimer) {
            resetTimer = setTimeout(() => {
              eventCount = 0;
              resetTimer = null;
            }, 5000); // 5 second window
          }
          
          if (eventCount >= 10) {
            console.warn("[jarvis] Ransomware Bodyguard triggered!");
            
            // FRIDAY PROTOCOL VISUAL OVERRIDE
            sendToOverlay("show-friday-protocol");
            
            // Trigger AppleScript alert
            const script = `display alert "⚠️ SECURITY ALERT" message "Jarvis detected unauthorized mass-file deletion in your Documents folder." as critical`;
            exec(`osascript -e '${script}'`);
            // Play sound
            exec(`say -v "Daniel" "Sir, unauthorized mass-deletion detected in the Documents folder. I have halted the system."`);
            eventCount = 0; // reset
          }
        }
      });
      
      watchdog.on("error", (err: any) => {
        if (err.code === "EINTR") {
          console.warn("[jarvis] Watchdog interrupted (EINTR), rebooting...");
          if (watchdog) watchdog.close();
          watchdog = null;
          setTimeout(attachWatcher, 1000); // Auto-restart after 1s
        } else {
          console.error("[jarvis] Watchdog error:", err);
        }
      });
      
    } catch (e: any) {
      if (e.code === "EINTR") {
        setTimeout(attachWatcher, 1000);
      } else {
        console.error("[jarvis] Watchdog failed to start:", e);
      }
    }
  }
  
  attachWatcher();
}

export function stopWatchdog() {
  if (watchdog) {
    watchdog.close();
    watchdog = null;
  }
}
