import { contextBridge, ipcRenderer } from "electron";

/** Safe bridge between the HUD renderer and the main process. */
contextBridge.exposeInMainWorld("jarvis", {
  // main -> renderer
  onState: (cb: (s: any) => void) =>
    ipcRenderer.on("state", (_e, s) => cb(s)),
  onMessage: (cb: (m: any) => void) =>
    ipcRenderer.on("message", (_e, m) => cb(m)),
  onLevel: (cb: (n: number) => void) =>
    ipcRenderer.on("level", (_e, n) => cb(n)),
  onNotice: (cb: (n: any) => void) =>
    ipcRenderer.on("notice", (_e, n) => cb(n)),

  // renderer -> main
  listen: () => ipcRenderer.send("listen"),
  sendText: (text: string) => ipcRenderer.send("send-text", text),
  interrupt: () => ipcRenderer.send("interrupt"),
  /** Grow/shrink the window so the chat box has room to appear. */
  setChatOpen: (open: boolean) => ipcRenderer.send("set-chat-open", open),
});

/**
 * Bridge for the overlay window.
 *
 * overlay.js previously did `const { ipcRenderer } = window`, which is always
 * undefined under contextIsolation — it threw on its first line, so nothing the
 * overlay could draw ever appeared. This exposes the one thing it needs.
 */
contextBridge.exposeInMainWorld("jarvisOverlay", {
  on: (channel: string, cb: (payload: any) => void) =>
    ipcRenderer.on(channel, (_e, payload) => cb(payload)),
  // Ask the main process to let the overlay receive clicks (for the QR's close
  // button); the overlay is otherwise click-through.
  setInteractive: (on: boolean) => ipcRenderer.send("overlay:set-interactive", on),
});

/** Bridge for the Orbital panel (the live Starport feed). */
contextBridge.exposeInMainWorld("echoOrbital", {
  close: () => ipcRenderer.send("orbital:close"),
});

/** Bridge for the Setup window, where API keys are entered. */
contextBridge.exposeInMainWorld("jarvisSetup", {
  load: () => ipcRenderer.invoke("setup:load"),
  save: (values: Record<string, string>) => ipcRenderer.invoke("setup:save", values),
  close: () => ipcRenderer.send("setup:close"),
  openUrl: (url: string) => ipcRenderer.send("setup:open-url", url),
});
