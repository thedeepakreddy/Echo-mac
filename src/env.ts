import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load key=value pairs from a .env file into process.env.
 *
 * Real environment variables always win, so you can override a stored key for a
 * single run (e.g. `GEMINI_API_KEY=... npm start`). Kept dependency-free and
 * deliberately simple: no interpolation, no multiline values.
 */
export function loadEnv(appRoot: string): string[] {
  const file = join(appRoot, ".env");
  if (!existsSync(file)) return [];

  const loaded: string[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip one layer of matching quotes.
    if (value.length >= 2 && /^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);

    if (!value) continue; // empty placeholder — treat as unset
    if (process.env[key] !== undefined) continue; // real env wins
    process.env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

/** Mask a secret for logs: sk-ant-api03-abc…7w-u5 -> sk-ant-…SgAA */
export function mask(value: string | undefined): string {
  if (!value) return "unset";
  if (value.length <= 12) return "set";
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}
