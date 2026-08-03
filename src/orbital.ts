import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The orbital panel: the live starport.im tracker, wrapped in Echo's own chrome.
 *
 * This is a SEPARATE window from the always-on reactor overlay, deliberately.
 * The overlay is locked down (strict CSP, no network, self-contained) and must
 * stay that way. Showing a live external site needs the opposite — a webview
 * that can reach the network — so it lives in its own window with its own
 * settings, and nothing about the overlay's guarantees changes.
 *
 * A <webview> is used rather than an <iframe> because most sites (Starport
 * included) refuse to be framed; a webview is a real embedded browser and is
 * not subject to those framing headers. It runs sandboxed with no Node access —
 * it only displays the page.
 */

let win: any = null;

export function openOrbitalPanel(): void {
  let electron: any;
  try {
    electron = nodeRequire("electron");
  } catch {
    return; // not in the main process
  }
  const { BrowserWindow, screen } = electron;
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }

  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1180, Math.round(area.width * 0.82));
  const height = Math.min(820, Math.round(area.height * 0.84));

  win = new BrowserWindow({
    width,
    height,
    center: true,
    frame: false,
    // SOLID, not transparent. A transparent window hosting the live WebGL globe
    // forces a software-compositing path that Chromium rejects
    // ("blink.mojom.WidgetHost message rejected") and which pins the CPU/GPU and
    // starved the rest of Echo. A solid window lets the feed be GPU-composited
    // normally, which is smooth.
    transparent: false,
    backgroundColor: "#060c14",
    resizable: true,
    hasShadow: true,
    title: "Echo — Orbital",
    webPreferences: {
      // Enables the <webview> tag used to host the live site.
      webviewTag: true,
      contextIsolation: true,
      sandbox: false,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  win.loadFile(join(__dirname, "..", "renderer", "orbital.html"));
  win.on("closed", () => {
    win = null;
  });
}

export function closeOrbitalPanel(): void {
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

export function isOrbitalOpen(): boolean {
  return !!win && !win.isDestroyed();
}
