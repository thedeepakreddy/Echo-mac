#!/usr/bin/env node
/**
 * Run Osiris on this machine, for Echo to show and read.
 *
 *   npm run osiris:setup    clone the project into vendor/osiris and install it
 *   npm run osiris:start    start it on http://localhost:3000
 *
 * Echo works perfectly well against the project's hosted grid — this is not
 * required. It is worth it for three things the hosted one cannot give:
 *
 *   - no rate limit. The public deployment sits behind Cloudflare and will
 *     refuse a page when it is busy; a local copy never does.
 *   - an exact camera. A dev build publishes its MapLibre handle, so "show me
 *     Tokyo" flies there precisely instead of driving the site's search box.
 *   - your own API keys (OpenSky, N2YO) in .env.local, which fill in the feeds
 *     the public instance leaves empty.
 *
 * Deliberately explicit: it clones and installs only when you run it, and it
 * prints every command before running it. Nothing here happens on its own.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "vendor", "osiris");
const REPO = "https://github.com/simplifaisoul/osiris.git";

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(" ")}${cwd === ROOT ? "" : `   (in ${cwd})`}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function setup() {
  if (!existsSync(DIR)) {
    console.log(`Cloning Osiris (MIT) into ${DIR}`);
    await run("git", ["clone", "--depth", "1", REPO, DIR], ROOT);
  } else {
    console.log(`Already cloned at ${DIR} — pulling the latest instead.`);
    await run("git", ["pull", "--ff-only"], DIR);
  }
  console.log("\nInstalling its dependencies. This is a full Next.js app, so it is not small.");
  await run("npm", ["install"], DIR);
  console.log(`
Done.

  npm run osiris:start        start it on http://localhost:3000

Echo finds it on its own while it is running — no configuration needed, because
osiris.preferLocal is on by default in config.json. Optional: put OPENSKY_* and
N2YO_API_KEY in ${join(DIR, ".env.local")} to fill in the credential-gated feeds.
`);
}

async function start() {
  if (!existsSync(DIR)) {
    console.error(`No checkout at ${DIR}. Run "npm run osiris:setup" first.`);
    process.exit(1);
  }
  console.log("Starting Osiris. Leave this running; ask Echo to show the grid.");
  await run("npm", ["run", "dev"], DIR);
}

const command = process.argv[2];
try {
  if (command === "setup") await setup();
  else if (command === "start") await start();
  else {
    console.log("Usage: node scripts/osiris_local.mjs [setup|start]");
    process.exit(1);
  }
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
