import { getAppPath } from "../utils/appPath.js";
import { loadRecent } from "../frontier/history.js";
import { speak } from "../voice/speaker.js";

/**
 * Ghost mode: notice a repetitive task and offer to automate it.
 *
 * Off unless the user asks for it. A background voice that interrupts on its own
 * schedule has to earn every word, and this one did not: it started at launch
 * whenever Ollama happened to be reachable, spoke on a fixed ten-minute timer,
 * and the only thing that ever stopped it was quitting the app.
 *
 * Three things keep it quiet now. It starts only when turned on. After a
 * suggestion it says nothing for an hour. And it never repeats a suggestion it
 * has already made, because the same observation twice is not new information.
 *
 * The decision is separated from the timer and the network, so it can be tested
 * without either.
 */

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
/**
 * Silence after speaking. A 3B model asked "do you see a pattern?" every ten
 * minutes will eventually say yes to almost anything; the cooldown is what
 * keeps an occasionally useful nudge from becoming a nag.
 */
const COOLDOWN_MS = 60 * 60 * 1000;

export interface GhostState {
  lastSpokenAt: number;
  lastSuggestion: string;
}

export const newGhostState = (): GhostState => ({ lastSpokenAt: 0, lastSuggestion: "" });

/**
 * Decide whether a model reply is worth saying out loud, and update state.
 *
 * @returns the sentence to speak, or null to stay quiet.
 */
export function decideSuggestion(
  state: GhostState,
  reply: string,
  now: number,
  cooldownMs = COOLDOWN_MS
): string | null {
  const clean = (reply ?? "").trim();
  if (!clean || clean.toUpperCase() === "NONE") return null;
  // lastSpokenAt 0 means it has never spoken, which must not be read as "spoke
  // at epoch zero" — the first suggestion of a session should not wait an hour.
  if (state.lastSpokenAt && now - state.lastSpokenAt < cooldownMs) return null;
  if (clean === state.lastSuggestion) return null;

  state.lastSpokenAt = now;
  state.lastSuggestion = clean;
  return clean;
}

// ---- the live wiring ------------------------------------------------------

let ghostInterval: NodeJS.Timeout | null = null;
let enabled = false;
const state = newGhostState();

export function isGhostActive(): boolean {
  return enabled;
}

/**
 * Turn ghost mode on or off.
 *
 * Speaks through the app's shared voice, so it honours the configured voice and
 * the mute setting rather than talking over Echo mid-sentence.
 */
export function toggleGhostMode(
  enable: boolean,
  opts: { host?: string; model?: string } = {}
): void {
  enabled = enable;

  if (!enable) {
    if (ghostInterval) clearInterval(ghostInterval);
    ghostInterval = null;
    return;
  }
  if (ghostInterval) return;

  const host = (opts.host || "http://localhost:11434").replace(/\/$/, "");
  const model = opts.model || "llama3.2:3b";
  // Turning it on is a fresh ask: do not make the user wait out a cooldown left
  // over from the last time it ran.
  state.lastSpokenAt = 0;

  ghostInterval = setInterval(async () => {
    try {
      // The last 50 entries, to avoid massive payloads.
      const rows = loadRecent(getAppPath(), 50);
      if (!rows.length) return;
      const recent = rows.map((r) => r.text).join("\n");

      const prompt = `You are a background pattern analyzer. Look at the following screen text history from the last 10 minutes. If you notice a highly repetitive task (like repeatedly copying emails, or constantly switching between the same two apps for data entry), reply with EXACTLY a short, 1-sentence suggestion asking if the user wants to automate it. If you do not see a repetitive pattern, reply with EXACTLY the word "NONE".\n\nHistory:\n${recent}`;

      const res = await fetch(`${host}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt, stream: false }),
      });
      if (!res.ok) return;

      const json = await res.json();
      const suggestion = decideSuggestion(state, json.response ?? "", Date.now());
      if (suggestion) speak(`Ghost mode noticed a pattern. ${suggestion}`);
    } catch (e) {
      // Offline or Ollama not running: staying silent is the correct outcome.
    }
  }, CHECK_INTERVAL_MS);
}

/** Stop the pattern watcher. */
export function stopGhostMode(): void {
  toggleGhostMode(false);
}
