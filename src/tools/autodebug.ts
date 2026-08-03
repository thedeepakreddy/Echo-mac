import { watch, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Tts } from "../voice/tts.js";

let debugWatcher: import("node:fs").FSWatcher | null = null;
let lastSize = 0;

export function startAutoDebug(tts: Tts) {
  if (debugWatcher) return;
  const home = process.env.HOME;
  if (!home) return;
  const logPath = join(home, ".jarvis_terminal.log");
  
  function attachWatcher() {
    if (!existsSync(logPath)) {
      setTimeout(attachWatcher, 5000); // Poll every 5s until file exists
      return;
    }
    
    try {
      debugWatcher = watch(logPath, (eventType) => {
        if (eventType === "change") {
          try {
            const content = readFileSync(logPath, "utf8");
            if (content.length > lastSize) {
              const newText = content.substring(lastSize);
              lastSize = content.length;
              
              const lower = newText.toLowerCase();
              if (lower.includes("error:") || lower.includes("exception") || lower.includes("traceback (most recent call last)")) {
                 fetch("http://localhost:11434/api/generate", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      model: "llama3.2:3b",
                      prompt: `You are Jarvis, an auto-debugger. A terminal error just occurred:\n${newText.substring(0, 1000)}\n\nIn ONE short sentence, tell the user what the error is and ask if you should fix it.`,
                      stream: false
                    })
                 }).then(r => r.json()).then(d => {
                    tts.say(d.response);
                 }).catch(() => {
                    tts.say("Sir, I detected a terminal error. Shall I investigate the logs?");
                 });
              }
            } else {
              lastSize = content.length; // file truncated
            }
          } catch { }
        }
      });
      
      debugWatcher.on("error", () => {
        if (debugWatcher) debugWatcher.close();
        debugWatcher = null;
        setTimeout(attachWatcher, 2000);
      });
    } catch (e) {
      setTimeout(attachWatcher, 2000);
    }
  }
  
  attachWatcher();
}

export function stopAutoDebug() {
  if (debugWatcher) {
    debugWatcher.close();
    debugWatcher = null;
  }
}
