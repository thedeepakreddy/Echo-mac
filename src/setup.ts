import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { KEY_FIELDS, readKeys, writeKeys, applyKeys, keysPath } from "./keystore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The window where someone pastes their API keys.
 *
 * Deliberately a normal, closeable window rather than part of the reactor HUD:
 * it is a one-off task, it needs a real text field, and it should feel finished
 * and dismissable rather than always present.
 */
let setupWin: any = null;

function electron(): any | null {
  try {
    // Required lazily so this module stays importable from plain Node tests.
    return require("electron");
  } catch {
    return null;
  }
}

export function openSetupWindow(): void {
  const e = electron();
  if (!e?.BrowserWindow) return;

  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.focus();
    return;
  }

  setupWin = new e.BrowserWindow({
    width: 560,
    height: 620,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "J.A.R.V.I.S — Setup",
    // Hidden title bar, but the traffic lights stay so the window can be closed
    // the way every other Mac window is.
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0d1418",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupWin.loadFile(join(__dirname, "..", "renderer", "setup.html"));
  // Shown only once painted, so it never appears as an empty grey rectangle.
  setupWin.once("ready-to-show", () => setupWin?.show());
  setupWin.on("closed", () => {
    setupWin = null;
  });
}

export function closeSetupWindow(): void {
  if (setupWin && !setupWin.isDestroyed()) setupWin.close();
  setupWin = null;
}

/** Wire the window's requests. Called once at startup. */
export function wireSetupIpc(onSaved?: () => void): void {
  const e = electron();
  if (!e?.ipcMain) return;

  e.ipcMain.handle("setup:load", () => ({
    // Only the shape each field needs — never send stored keys back in full.
    fields: KEY_FIELDS.map((f) => ({
      env: f.env,
      label: f.label,
      help: f.help,
      url: f.url,
      optional: f.optional,
      hint: f.env === "ANTHROPIC_API_KEY" ? "sk-ant-" : undefined,
    })),
    // Presence, not content: the form shows "saved" without redisplaying a key.
    values: Object.fromEntries(Object.keys(readKeys()).map((k) => [k, ""])),
    path: keysPath,
  }));

  e.ipcMain.handle("setup:save", (_evt: unknown, values: Record<string, string>) => {
    try {
      const existing = readKeys();
      // A blank field means "leave what is already saved", so reopening the
      // window and pressing save does not silently wipe every key.
      const merged: Record<string, string> = { ...existing };
      for (const f of KEY_FIELDS) {
        const v = (values?.[f.env] ?? "").trim();
        if (v) merged[f.env] = v;
      }
      writeKeys(merged);
      applyKeys();
      onSaved?.();
      return { ok: true, count: Object.keys(merged).length };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  e.ipcMain.on("setup:close", () => closeSetupWindow());
  e.ipcMain.on("setup:open-url", (_evt: unknown, url: string) => {
    // Only ever hand a real https link to the browser.
    if (/^https:\/\//.test(url)) e.shell.openExternal(url);
  });
}
