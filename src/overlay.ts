import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { desktopBounds } from "./tools/displays.js";

const nodeRequire = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

let overlayWin: any = null;

/**
 * Top-left of the overlay window in the global coordinate space.
 *
 * Not always (0,0): a monitor placed to the left of or above the primary sits
 * at negative coordinates, so the window that covers everything starts there.
 * Anything drawing at a screen coordinate has to subtract this first.
 */
let overlayOrigin = { x: 0, y: 0 };

/** Convert a global screen coordinate into one the overlay can draw at. */
export function toOverlaySpace(p: { x: number; y: number }): { x: number; y: number } {
  return { x: p.x - overlayOrigin.x, y: p.y - overlayOrigin.y };
}

function electronApp(): any | null {
  try {
    return nodeRequire("electron");
  } catch {
    return null;
  }
}

export function createOverlayWindow() {
  if (overlayWin) return;
  
  const electron = electronApp();
  if (!electron) return;
  
  const { BrowserWindow, screen } = electron;

  // Span EVERY display, not just the primary one. Anchored to the primary, a
  // strike or a target drawn at a coordinate on a second monitor fell outside
  // the window entirely and simply never appeared.
  const all = screen.getAllDisplays?.() ?? [screen.getPrimaryDisplay()];
  const workArea = desktopBounds(
    all.map((d: any, i: number) => ({
      index: i, id: d.id,
      x: d.bounds.x, y: d.bounds.y,
      width: d.bounds.width, height: d.bounds.height,
      primary: false,
    }))
  );
  overlayOrigin = { x: workArea.x, y: workArea.y };

  overlayWin = new BrowserWindow({
    width: workArea.width,
    height: workArea.height,
    x: workArea.x,
    y: workArea.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    backgroundColor: "#00000000",
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWin.setAlwaysOnTop(true, "screen-saver");
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // CRITICAL: Make window completely click-through so it doesn't block the user
  overlayWin.setIgnoreMouseEvents(true, { forward: true });

  overlayWin.loadFile(join(__dirname, "..", "renderer", "overlay.html"));

  overlayWin.on("closed", () => {
    overlayWin = null;
  });
}

export function sendToOverlay(channel: string, payload?: any) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send(channel, payload);
  }
}

/**
 * Briefly let the overlay receive clicks.
 *
 * The overlay is click-through so it never steals a click meant for the app
 * underneath. But an on-screen control — the QR's close button — needs real
 * clicks, so the renderer asks for interactivity while the pointer is over that
 * control and gives it back the moment it leaves. `forward: true` is what keeps
 * hover events flowing to the renderer even while it is ignoring clicks, which
 * is how it can tell when to ask.
 */
export function setOverlayInteractive(on: boolean) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setIgnoreMouseEvents(!on, { forward: true });
  }
}

export function destroyOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close();
  }
  overlayWin = null;
}
