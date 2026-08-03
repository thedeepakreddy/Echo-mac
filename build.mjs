import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { platform } from "node:os";

/**
 * Compile the Swift accessibility helper, but only when its source is newer
 * than the binary — swiftc takes a couple of seconds and the source rarely
 * changes, so recompiling on every build would be pure tax. macOS only; the
 * helper's absence degrades gracefully to screenshot-based clicking.
 */
function buildNativeHelper(name, disabledFeature) {
  if (platform() !== "darwin") return;
  const src = `native/${name}.swift`;
  const bin = `native/${name}`;
  if (!existsSync(src)) return;
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) {
    console.log(`${name} up to date`);
    return;
  }
  try {
    execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "inherit" });
    console.log(`compiled native/${name}`);
  } catch (err) {
    console.warn(`${name} compile failed (${disabledFeature} will be unavailable):`, err.message);
  }
}

function buildNativeHelpers() {
  if (platform() !== "darwin") return;
  // Compile EVERY .swift under native/, rather than a hand-maintained list.
  // facetracker.swift and sonar.swift were added later and never got added
  // here, so editing them silently rebuilt nothing and the stale binary kept
  // running — a bug that is invisible until the feature misbehaves.
  const described = {
    axhelper: "accessibility targeting",
    visionhelper: "screen OCR and presence",
    facetracker: "eye tracking",
    sonar: "presence sensing",
  };
  let files = [];
  try {
    files = readdirSync("native").filter((f) => f.endsWith(".swift"));
  } catch {
    return;
  }
  for (const file of files) {
    const name = file.replace(/\.swift$/, "");
    buildNativeHelper(name, described[name] ?? `the ${name} feature`);
  }
}

/**
 * Bundles the Electron main + preload from TypeScript to ESM.
 * node_modules stay external so the Agent SDK resolves its bundled `claude`
 * binary and the optional native voice addons load normally at runtime.
 */
const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  packages: "external",
  logLevel: "info",
};

const entries = [
  // Main runs as ESM (Electron >=28 supports an ESM entry point).
  { in: "src/main.ts", out: "dist/main.js", format: "esm" },
  // Preload MUST be CommonJS with a .cjs extension. Electron only treats a
  // preload as ESM when it ends in .mjs, so an ESM bundle named .js fails to
  // load — contextBridge never runs and window.jarvis is undefined in the HUD.
  { in: "src/preload.ts", out: "dist/preload.cjs", format: "cjs" },
];

const watch = process.argv.includes("--watch");

for (const e of entries) {
  const opts = { ...common, format: e.format, entryPoints: [e.in], outfile: e.out };
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log(`[watch] ${e.in} -> ${e.out}`);
  } else {
    await esbuild.build(opts);
  }
}

buildNativeHelpers();

if (!watch) console.log("build complete");
