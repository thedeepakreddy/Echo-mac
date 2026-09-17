import { Tts } from "../voice/tts.js";
import { frontmostApp } from "./computer-actions.js";
import { ocr } from "./vision.js";

let shadowInterval: NodeJS.Timeout | null = null;
export let shadowPendingCode = "";
export let isShadowModeActive = false;

const SUPPORTED_IDES = ["Code", "Cursor", "Xcode", "Terminal", "iTerm2", "WebStorm"];

/**
 * @param intervalSeconds how often to read the screen. The original 15s was far
 * too hot: each tick is a full-screen OCR, and with this running permanently the
 * vision helper sat near 90% CPU and the machine's load average passed 14. A
 * pause worth interrupting lasts longer than a minute anyway, so the slower poll
 * costs nothing real.
 */
export function startShadowMode(tts: Tts, intervalSeconds = 60) {
  if (shadowInterval) return;
  isShadowModeActive = true;
  const period = Math.max(20, intervalSeconds) * 1000;

  shadowInterval = setInterval(async () => {
    if (!isShadowModeActive) return;

    try {
      // Check the cheap thing FIRST. Reading the whole screen and then finding
      // out the user is not even in an editor was the bulk of the wasted work.
      const appName = await frontmostApp();
      if (!SUPPORTED_IDES.includes(appName)) return;

      const r = await ocr("fast");
      if (r.error || !r.lines.length) return;

      const screenText = r.lines.map(l => l.text).join("\n");
      
      const prompt = `You are a Shadow Pair Programmer watching the user code. The user has paused for 15 seconds. Look at the text on their screen:
      
${screenText.substring(0, 3000)}

Are they in the middle of writing a function and stuck? 
If NO, output exactly the word "NONE".
If YES, output a 1-sentence plan of how to finish the code, followed by the exact delimiter "|||", followed by ONLY the exact raw code required to finish the function (no markdown, no backticks, just the code to type).`;

      const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "llama3.2:3b",
          prompt: prompt,
          stream: false
        })
      });
      
      if (res.ok) {
        const json = await res.json();
        const reply = json.response.trim();
        if (reply && reply.toUpperCase() !== "NONE" && reply.includes("|||")) {
          const parts = reply.split("|||");
          const plan = parts[0].trim();
          const code = parts[1].trim();
          
          if (plan && code) {
            shadowPendingCode = code;
            tts.say(`Sir, I notice you paused. ${plan} Shall I take control and type it out?`);
            // Pause the interval for 60 seconds so it doesn't spam while waiting for answer
            isShadowModeActive = false;
            setTimeout(() => { isShadowModeActive = true; }, 60000);
          }
        }
      }
    } catch (e) {
      // Silently fail if offline or OCR fails
    }
  }, period);
}

export function stopShadowMode() {
  if (shadowInterval) clearInterval(shadowInterval);
  shadowInterval = null;
  isShadowModeActive = false;
  shadowPendingCode = "";
}
