#!/usr/bin/env node
/**
 * Look at the reactor without launching the app.
 *
 *   npm run hudpreview                    every state, two sizes
 *   npm run hudpreview -- --size 300      one size
 *   npm run hudpreview -- --state error   one state
 *
 * Iterating on the HUD by starting Electron is slow, and slow iteration is why
 * visual details go unchecked. This builds a page from the REAL index.html and
 * hud.css — not a copy of them — so what you see is what the app paints, and
 * opens it in your browser.
 *
 * Each state gets its own iframe because the state selectors are
 * `body[data-status=...]`: one document cannot show two states at once, and
 * rewriting the selectors to fake it would stop testing the real CSS.
 *
 * Output goes to .hud-preview/, which is gitignored.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".hud-preview");

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const states = argOf("--state", "idle,listening,thinking,acting,speaking,error").split(",");
const sizes = argOf("--size", "300,170").split(",").map(Number);

const html = readFileSync(join(ROOT, "renderer", "index.html"), "utf8");
const css = readFileSync(join(ROOT, "renderer", "hud.css"), "utf8");

// Pull the reactor markup straight out of the real page, so this preview can
// never drift from what ships.
const start = html.indexOf('<div id="orb"');
const end = html.indexOf('<script src="hud.js"');
if (start < 0 || end < 0) {
  console.error("Could not find the reactor markup in renderer/index.html.");
  console.error("If the markup was restructured, update the anchors in this script.");
  process.exit(1);
}
const orb = html.slice(start, end).trim();

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const frames = [];
for (const size of sizes) {
  for (const state of states) {
    const name = `${state}-${size}.html`;
    writeFileSync(
      join(OUT, name),
      `<!doctype html><meta charset="utf-8"><style>${css}
body{background:#05070a;margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
#orb{--size:${size}px !important}
</style><body data-status="${state}">${orb}</body>`,
      "utf8"
    );
    frames.push({ name, state, size });
  }
}

const box = (f) => `<figure>
  <iframe src="${f.name}" width="${f.size + 90}" height="${f.size + 90}" loading="lazy"></iframe>
  <figcaption>${f.state} &middot; ${f.size}px</figcaption>
</figure>`;

writeFileSync(
  join(OUT, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Echo HUD preview</title>
<style>
  body{background:#0a0c10;color:#8aa;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:28px}
  h1{font-size:14px;font-weight:500;color:#cfe;margin:0 0 4px}
  p{margin:0 0 24px;opacity:.6}
  .grid{display:flex;flex-wrap:wrap;gap:22px}
  figure{margin:0}
  iframe{border:1px solid #1b2430;border-radius:10px;display:block;background:#05070a}
  figcaption{padding-top:8px;text-align:center;opacity:.75}
</style>
<h1>Echo HUD preview</h1>
<p>Rendered from renderer/index.html + renderer/hud.css. Reload after editing either.</p>
<div class="grid">${frames.map(box).join("")}</div>`,
  "utf8"
);

const index = join(OUT, "index.html");
console.log(`Wrote ${frames.length} frames to ${OUT}`);

// `open` is macOS; elsewhere just print the path rather than guessing.
if (process.platform === "darwin") {
  spawn("open", [index], { detached: true, stdio: "ignore" }).unref();
  console.log("Opening in your browser…");
} else {
  console.log(`Open: file://${index}`);
}
