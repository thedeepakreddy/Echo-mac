#!/usr/bin/env node
/**
 * Checks everything the permission doctor doesn't: binaries, the Whisper model,
 * and — most importantly — whether the brain can actually authenticate.
 *
 *   npm run doctor        # permissions + this
 *   node scripts/doctor.mjs
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// Load .env exactly like the app does, so this tests the real credentials.
for (const raw of existsSync(join(ROOT, ".env"))
  ? readFileSync(join(ROOT, ".env"), "utf8").split("\n")
  : []) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq < 1) continue;
  const k = line.slice(0, eq).trim();
  let v = line.slice(eq + 1).trim();
  if (v.length >= 2 && /^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
  if (v && process.env[k] === undefined) process.env[k] = v;
}
const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const OK = g("OK      ");
const BAD = r("MISSING ");
const WARN = y("WARN    ");

function cfg() {
  for (const f of ["config.json", "config.example.json"]) {
    const p = join(ROOT, f);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8"));
      } catch {
        /* try the next candidate */
      }
    }
  }
  return {};
}

const c = cfg();
const problems = [];

console.log(bold("\nJ.A.R.V.I.S — system check\n"));

// --- binaries -------------------------------------------------------------
const bins = [
  [c?.control?.cliclickBin ?? "/opt/homebrew/bin/cliclick", "cliclick (mouse + keyboard)", "brew install cliclick"],
  [c?.voice?.whisperBin ?? "/opt/homebrew/bin/whisper-cli", "whisper-cli (speech to text)", "brew install whisper-cpp"],
  ["/usr/bin/say", "say (speech out)", "built into macOS"],
  ["/usr/sbin/screencapture", "screencapture (vision)", "built into macOS"],
];
for (const [path, label, fix] of bins) {
  if (existsSync(path)) console.log(`  ${OK} ${label}`);
  else {
    console.log(`  ${BAD} ${label} ${dim(`— ${fix}`)}`);
    problems.push(`install ${label}: ${fix}`);
  }
}

// --- whisper model --------------------------------------------------------
const modelRel = c?.voice?.sttModel ?? "models/ggml-base.en.bin";
const model = isAbsolute(modelRel) ? modelRel : join(ROOT, modelRel);
if (existsSync(model)) {
  const mb = Math.round(statSync(model).size / 1e6);
  if (mb < 20) {
    console.log(`  ${WARN} Whisper model looks truncated (${mb}MB) ${dim(`— ${model}`)}`);
    problems.push("re-download the Whisper model (see README)");
  } else console.log(`  ${OK} Whisper model (${mb}MB)`);
} else {
  console.log(`  ${BAD} Whisper model ${dim(`— expected ${model}`)}`);
  problems.push("download the Whisper model (see README)");
}

// --- brain ----------------------------------------------------------------
const brain = c?.brain ?? "claude";
console.log(`\n${bold("Brain")} ${dim(`(${brain})`)}`);

if (brain === "gemini") {
  const envName = c?.gemini?.apiKeyEnv ?? "GEMINI_API_KEY";
  if (process.env[envName]) console.log(`  ${OK} ${envName} is set`);
  else {
    console.log(`  ${BAD} ${envName} is not set`);
    problems.push(`export ${envName}=...`);
  }
} else if (brain === "openai") {
  const envName = c?.openai?.apiKeyEnv ?? "OPENAI_API_KEY";
  if (process.env[envName]) console.log(`  ${OK} ${envName} is set`);
  else {
    console.log(`  ${BAD} ${envName} is not set`);
    problems.push(`export ${envName}=...`);
  }
} else {
  process.stdout.write(`  ${dim("checking Claude login…")}\r`);
  let verdict;
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let text = "";
    for await (const m of query({
      prompt: "Reply with exactly: OK",
      options: { model: c?.claude?.model ?? "claude-opus-4-8", maxTurns: 1 },
    })) {
      if (m.type === "result") text = `${m.is_error ? "ERROR " : ""}${m.result ?? ""}`;
    }
    verdict = /invalid api key|\/login/i.test(text) ? "login" : text.startsWith("ERROR") ? text : "ok";
  } catch (err) {
    const msg = String(err?.message ?? err);
    verdict = /exited with code 1|invalid api key|\/login/i.test(msg) ? "login" : msg;
  }

  if (verdict === "ok") {
    console.log(`  ${OK} Claude is logged in and responding          `);
  } else if (verdict === "login") {
    console.log(`  ${BAD} Claude is not logged in                     `);
    console.log(`\n    ${bold("Fix:")} run ${bold("npm run login")}, then type ${bold("/login")} and sign in.`);
    console.log(`    ${dim("Uses your existing Claude subscription — no API key needed.")}`);
    problems.push("log in: npm run login  ->  /login");
  } else {
    console.log(`  ${WARN} Claude check inconclusive ${dim(`— ${String(verdict).slice(0, 120)}`)}`);
  }
}

// --- verdict --------------------------------------------------------------
if (!problems.length) {
  console.log(g("\nAll clear. Run: npm start\n"));
  process.exit(0);
}
console.log(bold(`\n${problems.length} thing${problems.length > 1 ? "s" : ""} to fix:\n`));
problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
console.log(`\n${dim("Also run: npm run permissions")}\n`);
process.exit(1);
