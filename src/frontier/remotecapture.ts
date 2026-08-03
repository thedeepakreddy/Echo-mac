import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { macSignalling, isRunning as remoteRunning } from "./remote.js";

/**
 * The Mac end of the phone-remote video link, wired into Electron.
 *
 * The pure signalling lives in remotesignal.ts and is fully tested; this is the
 * part that cannot be tested without a real screen and a real phone, so it is
 * kept as small as possible. It does three things:
 *
 *   1. Hosts a hidden window whose only job is to capture the screen and answer
 *      the phone's WebRTC offer. WebRTC needs a browser context and screen
 *      capture needs a renderer, so a window is unavoidable — but it is never
 *      shown and carries no UI.
 *   2. Routes the browser's getDisplayMedia request to the primary screen with
 *      no picker, so the phone just sees the screen without anyone clicking a
 *      dialog on the Mac.
 *   3. Shuttles SDP and ICE between that window (over IPC) and the signalling
 *      relay the phone talks to (over HTTP). Neither side knows about the other;
 *      this is the only thing that does.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

let captureWin: any = null;
let bridge: NodeJS.Timeout | null = null;
let lastGeneration = -1;

/**
 * Stand up the capture window and the SDP/ICE bridge.
 *
 * Called once at startup. The window sits idle — and captures nothing — until a
 * phone actually offers a connection, so the screen-recording indicator does not
 * come on just because the remote is available.
 */
export function startCaptureBridge(electron: any): void {
  const { BrowserWindow, ipcMain, session, desktopCapturer } = electron;
  if (captureWin) return;

  // Route getDisplayMedia to the primary screen automatically. Without this the
  // renderer's getDisplayMedia would either be denied or pop a source picker on
  // the Mac, which defeats the point of an unattended remote.
  try {
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request: any, callback: any) => {
        desktopCapturer.getSources({ types: ["screen"] }).then((sources: any[]) => {
          callback(sources.length ? { video: sources[0], audio: false } : {});
        }).catch(() => callback({}));
      },
      { useSystemPicker: false }
    );
  } catch (e) {
    console.error("[jarvis] could not install display-media handler:", (e as any)?.message ?? e);
  }

  captureWin = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    // Never in the way, never in the Dock or a Space.
    skipTaskbar: true,
    webPreferences: {
      // Loads only the local, trusted capture.html and needs both ipcRenderer
      // and the WebRTC APIs; no remote content is ever loaded here.
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  captureWin.loadFile(join(__dirname, "..", "renderer", "capture.html"))
    .then(() => console.log("[jarvis] capture.html loaded successfully"))
    .catch((err: any) => console.error("[jarvis] failed to load capture.html:", err));
  captureWin.on("closed", () => {
    captureWin = null;
  });

  // ---- IPC from the capture window -> the signalling relay ----
  ipcMain.on("rtc-answer", (_e: any, answer: any) => {
    if (answer?.type === "answer" && typeof answer.sdp === "string") {
      macSignalling().setAnswer(answer);
    }
  });
  ipcMain.on("rtc-ice", (_e: any, candidate: any) => {
    if (candidate?.candidate) macSignalling().addCandidate("mac", candidate);
  });
  ipcMain.on("rtc-error", (_e: any, msg: string) => {
    console.error("[jarvis] remote capture:", msg);
  });
  ipcMain.on("rtc-state", (_e: any, state: string) => {
    if (state === "connected") console.log("[jarvis] phone video connected");
  });

  // ---- the poll that moves the phone's offer + candidates to the window ----
  // The phone talks HTTP to the signalling relay; the window talks IPC to us.
  // This is the seam between them. Half a second is imperceptible for a
  // connection that is set up once and then streams on its own.
  bridge = setInterval(() => {
    if (!captureWin) return;
    // When the remote closes, drop the peer so the screen-capture indicator goes
    // off — without the tool layer needing to know this window exists.
    if (!remoteRunning()) {
      if (lastGeneration !== -1) {
        lastGeneration = -1;
        try {
          captureWin.webContents.send("rtc-close");
        } catch {
          /* window may be gone */
        }
      }
      return;
    }
    const sig = macSignalling();

    // A new offer generation means the phone (re)connected; hand it to the window.
    const off = sig.takeOffer();
    if (off && off.generation !== lastGeneration) {
      lastGeneration = off.generation;
      console.log(`[jarvis] sending rtc-offer to captureWin (generation ${lastGeneration})`);
      captureWin.webContents.send("rtc-offer", off.offer);
    }

    // The phone's trickled ICE candidates, destined for the Mac.
    const forMac = sig.drainCandidates("mac");
    if (forMac.length) captureWin.webContents.send("rtc-remote-ice", forMac);
  }, 500);
}

/** Tell the capture window to drop its peer — the remote closed. */
export function notifyCaptureClosed(): void {
  lastGeneration = -1;
  try {
    captureWin?.webContents.send("rtc-close");
  } catch {
    /* window may be gone */
  }
}

export function stopCaptureBridge(): void {
  if (bridge) clearInterval(bridge);
  bridge = null;
  lastGeneration = -1;
  try {
    captureWin?.close();
  } catch {
    /* ignore */
  }
  captureWin = null;
}
