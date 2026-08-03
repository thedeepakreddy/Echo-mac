#!/usr/bin/env node
/**
 * Opens the Claude Code CLI that the Agent SDK actually uses, so `/login` writes
 * credentials to the store the brain reads. Resolves the binary rather than
 * hardcoding a path — the SDK moved it between versions (bundled cli.js -> a
 * per-platform package) and it differs on Intel vs Apple Silicon.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MODULES = join(ROOT, "node_modules/@anthropic-ai");

const candidates = [
  // Current layout: per-platform native binary.
  join(MODULES, `claude-agent-sdk-${process.platform}-${process.arch}/claude`),
  // Older layout: a bundled JS entry point.
  join(MODULES, "claude-agent-sdk/cli.js"),
];

const found = candidates.find((p) => existsSync(p));

if (!found) {
  console.error("\nCould not find the Claude Code CLI inside the Agent SDK.");
  console.error("Looked in:");
  candidates.forEach((p) => console.error(`  ${p}`));
  console.error("\nTry: npm install\n");
  process.exit(1);
}

console.log(`\nOpening Claude Code — type "/login" and sign in, then quit with Ctrl+C.\n`);

// .js entries need node; the native binary is executed directly.
const [cmd, args] = found.endsWith(".js")
  ? [process.execPath, [found, ...process.argv.slice(2)]]
  : [found, process.argv.slice(2)];

spawn(cmd, args, { stdio: "inherit", cwd: ROOT }).on("exit", (code) => process.exit(code ?? 0));
