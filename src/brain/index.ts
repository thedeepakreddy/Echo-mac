import { Brain } from "./types.js";
import { ClaudeBrain } from "./claude.js";
import { GeminiBrain } from "./gemini.js";
import { OllamaBrain } from "./ollama.js";
import { setCliclickBin } from "../tools/computer-actions.js";
import type { JarvisConfig } from "../config.js";

export { Brain } from "./types.js";

export type Provider = "claude" | "gemini" | "ollama";

/** Build the brain named in config, falling back to Claude if a key is missing. */
export function createBrain(cfg: JarvisConfig): { brain: Brain; provider: Provider } {
  setCliclickBin(cfg.control.cliclickBin);

  if (cfg.brain === "gemini") {
    const key = process.env[cfg.gemini.apiKeyEnv];
    if (key) return { brain: new GeminiBrain(cfg, key), provider: "gemini" };
    console.warn(
      `[brain] config selects gemini but ${cfg.gemini.apiKeyEnv} is not set — falling back to Claude.`
    );
  }

  if (cfg.brain === "ollama") {
    return { brain: new OllamaBrain(cfg, cfg.ollama?.host), provider: "ollama" };
  }

  return { brain: new ClaudeBrain(cfg), provider: "claude" };
}
