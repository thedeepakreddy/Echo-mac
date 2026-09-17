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
  /** Open the centered intelligence control panel. */
  openControlPanel: () => ipcRenderer.send("open-control-panel"),

  /** Report a renderer-side failure so it lands in the same run log as the loop's. */
  reportError: (payload: { kind: string; message: string; stack?: string; source?: string }) =>
    ipcRenderer.send("renderer:error", payload),
});

/** Restricted bridge for the centered intelligence control panel. */
contextBridge.exposeInMainWorld("echoControl", {
  snapshot: () => ipcRenderer.invoke("control:snapshot"),
  action: (action: unknown) => ipcRenderer.invoke("control:action", action),
  weather: (request?: { query?: string; latitude?: number; longitude?: number }) =>
    ipcRenderer.invoke("control:weather", request),
  close: () => ipcRenderer.send("control:close"),
  onUpdate: (cb: (snapshot: any) => void) => {
    const listener = (_event: unknown, snapshot: any) => cb(snapshot);
    ipcRenderer.on("control:update", listener);
    return () => ipcRenderer.removeListener("control:update", listener);
  },
  onState: (cb: (state: any) => void) => {
    const listener = (_event: unknown, state: any) => cb(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
  onLevel: (cb: (level: number) => void) => {
    const listener = (_event: unknown, level: number) => cb(level);
    ipcRenderer.on("level", listener);
    return () => ipcRenderer.removeListener("level", listener);
  },
});

/**
 * Catch failures in the preload's own isolated world.
 *
 * contextIsolation gives the preload a different `window` from the page, so
 * these do NOT see errors thrown by hud.js — that side registers its own pair
 * through `reportError` above. Both are needed to cover the whole renderer.
 */
window.addEventListener("error", (e) => {
  ipcRenderer.send("renderer:error", {
    kind: "error",
    message: String(e.message ?? e),
    stack: (e.error as any)?.stack,
    source: `preload:${e.filename ?? "?"}:${e.lineno ?? 0}`,
  });
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = (e as PromiseRejectionEvent).reason;
  ipcRenderer.send("renderer:error", {
    kind: "unhandledrejection",
    message: String(reason?.message ?? reason),
    stack: reason?.stack,
    source: "preload",
  });
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

/**
 * Bridge for the Osiris panel (the live global intelligence grid).
 *
 * Closing is a one-way send on purpose: the panel stays up until someone says
 * to close it, and this is one of only two doors that do (the other being a
 * spoken command). The pinned state is owned by the main process and pushed
 * back here, so the button can never disagree with the window.
 */
contextBridge.exposeInMainWorld("echoOsiris", {
  close: () => ipcRenderer.send("osiris:close"),
  reload: () => ipcRenderer.send("osiris:reload"),
  togglePin: () => ipcRenderer.send("osiris:toggle-pin"),
  onPinned: (cb: (on: boolean) => void) =>
    ipcRenderer.on("osiris:pinned", (_e, on) => cb(Boolean(on))),
  onTrouble: (cb: (t: { code: number; status: string; hint: string }) => void) =>
    ipcRenderer.on("osiris:trouble", (_e, t) => cb(t)),
});

/** Bridge for the Neural Core panel (the 3D galaxy schema). */
contextBridge.exposeInMainWorld("echoNeural", {
  close: () => ipcRenderer.send("neural:close"),
});

/** Bridge for the Setup window, where API keys are entered. */
contextBridge.exposeInMainWorld("jarvisSetup", {
  load: () => ipcRenderer.invoke("setup:load"),
  save: (values: Record<string, string>) => ipcRenderer.invoke("setup:save", values),
  close: () => ipcRenderer.send("setup:close"),
  openUrl: (url: string) => ipcRenderer.send("setup:open-url", url),
});
