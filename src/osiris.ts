import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  activeBase,
  forgetBase,
  layersFromUrl,
  layersUrl,
  normalizeBase,
  openingLayers,
} from "./tools/osiris-intel.js";

const nodeRequire = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The Osiris panel: the open-source global intelligence grid, in Echo's frame.
 *
 * Built on the same shape as the orbital panel, for the same reasons — a solid
 * (never transparent) window, because transparency plus live WebGL makes
 * Chromium reject frames and pins the machine; and a <webview> rather than an
 * iframe, because a webview is a real embedded browser and is not subject to
 * the framing headers a site like this sets.
 *
 * What is different here is that the panel is not just a picture. Osiris is MIT
 * licensed and its client is readable, so Echo drives the real thing:
 *
 *   - LAYERS are set through the page's own `?layers=` contract, the same
 *     parameter its share links use, so a layer change is a state Osiris itself
 *     defines rather than a click Echo guesses at.
 *   - THE CAMERA moves through the map handle when a local checkout exposes it
 *     (`window.__osirisMap`, dev builds only), and otherwise through the site's
 *     own search box, driven as a person would.
 *   - DATA can be read through the page when a deployment refuses a plain
 *     server-side fetch — the webview has already cleared whatever the direct
 *     request has not.
 *
 * It stays open until it is explicitly closed. Nothing in Echo — not a finished
 * turn, not away mode, not a new command — closes this window; only the ✕ on
 * its own title bar, a spoken "close Osiris", or quitting Echo.
 */

let win: any = null;
/** The <webview>'s own webContents, captured when the host page attaches it. */
let feed: any = null;
let pinned = false;
/** The base URL the panel was opened against, so later calls stay on it. */
let openedBase: string | null = null;

function electron(): any | null {
  try {
    return nodeRequire("electron");
  } catch {
    return null; // not in the main process (tests, tooling)
  }
}

export function isOsirisOpen(): boolean {
  return !!win && !win.isDestroyed();
}

/** Which instance the open panel is showing — a checkout, or the hosted grid. */
export function osirisBase(): string | null {
  return openedBase;
}

export function isOsirisPinned(): boolean {
  return isOsirisOpen() && pinned;
}

/**
 * Open the grid, or bring it forward if it is already up.
 *
 * `layers` is applied as the page loads rather than toggled afterwards, so
 * "show me the flights" arrives already showing flights instead of flickering
 * through the defaults first.
 */
export async function openOsirisPanel(
  opts: { layers?: string[]; pin?: boolean; base?: string } = {}
): Promise<{ url: string; base: string }> {
  const api = electron();
  const base = normalizeBase(opts.base ?? (await activeBase()));
  // No layers named means the standard view, not Osiris's own defaults — "show
  // me the world" should arrive with the world on it.
  const layers = opts.layers?.length ? opts.layers : openingLayers();
  const url = layersUrl(base, layers);
  openedBase = base;

  if (!api) return { url, base }; // nothing to show outside Electron

  const { BrowserWindow, screen } = api;

  if (isOsirisOpen()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (opts.layers?.length) await applyLayers(opts.layers);
    if (opts.pin !== undefined) setOsirisPinned(opts.pin);
    return { url: (await osirisUrl()) ?? url, base };
  }

  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1440, Math.round(area.width * 0.9));
  const height = Math.min(900, Math.round(area.height * 0.88));

  win = new BrowserWindow({
    width,
    height,
    center: true,
    frame: false,
    transparent: false,
    backgroundColor: "#05070c",
    resizable: true,
    hasShadow: true,
    minWidth: 720,
    minHeight: 480,
    title: "Echo — Osiris",
    webPreferences: {
      webviewTag: true, // the live grid is hosted in a <webview>
      contextIsolation: true,
      sandbox: false,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  // The webview's webContents is the handle for everything below — layers,
  // camera, keys, data. It only exists once the host page has attached it.
  win.webContents.on("did-attach-webview", (_e: any, contents: any) => {
    feed = contents;
    contents.on("destroyed", () => {
      feed = null;
    });
    // A refused page still "loads": the hosted grid sits behind Cloudflare and
    // answers a rate limit with a styled error page (HTTP 503, Cloudflare 1200),
    // which did-fail-load never reports. Without this the panel would show that
    // error inside Echo's chrome as though it were the globe.
    //
    // It has to be did-frame-navigate, not did-navigate: only the frame event
    // carries the HTTP status, and the plain one reports the URL alone.
    contents.on(
      "did-frame-navigate",
      (_ev: any, _url: string, code: number, status: string, isMainFrame: boolean) => {
        if (isMainFrame && typeof code === "number" && code >= 400) reportTrouble(code, status);
      }
    );
  });

  win.loadFile(join(__dirname, "..", "renderer", "osiris.html"), {
    query: { src: url, base },
  });

  win.on("closed", () => {
    win = null;
    feed = null;
    pinned = false;
    openedBase = null;
  });

  if (opts.pin) setOsirisPinned(true);
  return { url, base };
}

/** What Echo says when the grid refuses to load, per kind of refusal. */
function troubleHint(code: number): string {
  if (code === 429 || code === 503) {
    return "the public grid is rate-limiting — give it a minute and hit reconnect, or run a local copy of Osiris";
  }
  if (code === 403) return "the grid refused the request";
  if (code >= 500) return "the grid is having trouble at its end";
  return "the grid wouldn't serve that page";
}

/**
 * Say out loud that the grid did not load, rather than leaving its error page
 * dressed up in Echo's frame looking like the product.
 */
function reportTrouble(code: number, status: string): void {
  const hint = troubleHint(code);
  try {
    win?.webContents.send("osiris:trouble", { code, status, hint });
  } catch {
    /* the chrome's own banner is the nicety, the HUD line below is the report */
  }
  void import("./overlay.js")
    .then(({ sendToOverlay }) =>
      sendToOverlay("feed", { line: `osiris: ${code} — ${hint}`, kind: "warn" })
    )
    .catch(() => {
      /* no overlay outside the app */
    });
}

/**
 * Close the panel. Called only from the ✕ on its title bar, a spoken command,
 * or Echo quitting — see the note at the top of this file.
 */
export function closeOsirisPanel(): void {
  if (win && !win.isDestroyed()) win.close();
  win = null;
  feed = null;
  pinned = false;
  openedBase = null;
}

/** Keep the grid above other windows, and on every desktop, while it is up. */
export function setOsirisPinned(on: boolean): boolean {
  if (!isOsirisOpen()) return false;
  pinned = on;
  win.setAlwaysOnTop(on, "floating");
  win.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: true });
  try {
    win.webContents.send("osiris:pinned", on);
  } catch {
    /* the chrome catching up is cosmetic */
  }
  return true;
}

/** Reload the grid from scratch, re-deciding which instance to talk to. */
export async function reloadOsiris(): Promise<boolean> {
  if (!feed) return false;
  forgetBase();
  const base = await activeBase();
  openedBase = base;
  feed.loadURL(`${base}/`);
  return true;
}

/** The URL the grid is showing right now — the layer state lives in it. */
export async function osirisUrl(): Promise<string | null> {
  if (!feed) return null;
  try {
    return feed.getURL() || null;
  } catch {
    return null;
  }
}

/**
 * Which layers are on.
 *
 * Osiris writes its own live layer state back into the address bar (a debounced
 * replaceState in its page), so reading the URL reports what the user is
 * actually looking at, including toggles they flipped by hand.
 */
export async function currentLayers(): Promise<string[] | null> {
  const url = await osirisUrl();
  return url ? layersFromUrl(url) : null;
}

export type LayerResult = "ok" | "pending" | "failed" | "closed";

/**
 * Put the grid into an exact layer state by reloading it with that state.
 *
 * The outcome is reported rather than assumed. A navigation can be refused
 * outright — a rate limit, a dropped connection — and in that case the panel
 * keeps showing the layers it already had, so claiming the change landed would
 * be a lie the user can see on screen. A load that is merely slow (the globe
 * takes a few seconds) comes back as "pending", which is honest too.
 */
export async function applyLayers(ids: string[]): Promise<LayerResult> {
  if (!feed) return "closed";
  const base = openedBase ?? (await activeBase());
  const navigation = feed
    .loadURL(layersUrl(base, ids))
    .then(() => "ok" as const)
    .catch(() => "failed" as const);
  return Promise.race([navigation, pause(6000).then(() => "pending" as const)]);
}

/** Send one of Osiris's own keyboard shortcuts to the page. */
export async function pressInOsiris(key: string): Promise<boolean> {
  if (!feed) return false;
  try {
    feed.focus();
    feed.sendInputEvent({ type: "keyDown", keyCode: key });
    feed.sendInputEvent({ type: "char", keyCode: key });
    feed.sendInputEvent({ type: "keyUp", keyCode: key });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run JS inside the grid's page and hand back whatever it returns.
 *
 * Bounded, because executeJavaScript can simply never settle — a page busy
 * rendering thousands of WebGL entities, or one whose promise never resolves,
 * leaves the caller waiting forever. A tool call that never returns hangs the
 * whole turn, so a missed answer is reported as null instead.
 */
async function inPage<T>(code: string, timeoutMs = 5000): Promise<T | null> {
  if (!feed) return null;
  const evaluation = feed
    .executeJavaScript(code, true)
    .then((value: T) => value)
    .catch(() => null);
  return Promise.race([evaluation, pause(timeoutMs).then(() => null)]);
}

/**
 * Fetch an Osiris route from inside the page.
 *
 * Same origin, same session, same cleared bot check as the globe itself — this
 * is the fallback for a deployment that answers a plain server-side request
 * with an interstitial. Returns the raw body so the caller parses it once.
 */
export async function relayFetch(path: string): Promise<string | null> {
  const safe = JSON.stringify(path);
  return inPage<string>(
    `fetch(${safe}, { headers: { Accept: 'application/json' } }).then(r => r.text()).catch(() => null)`,
    // A real upstream call rather than a DOM read: some of these feeds aggregate
    // a dozen sources and genuinely take ten seconds.
    20_000
  );
}

export type FocusRoute = "map" | "search" | "none";

/**
 * Point the globe at a place.
 *
 * Two routes, because only one of them exists on any given instance. A local
 * checkout running `npm run dev` publishes its MapLibre handle on
 * `window.__osirisMap` and can be flown precisely. A production build does not,
 * so the camera is moved the way a person moves it: open the site's search,
 * type the place, take the first hit. The caller is told which route was used,
 * because they are not equally exact and the answer should say so.
 */
export async function focusOsiris(
  place: string,
  coords?: { lat: number; lng: number; zoom?: number }
): Promise<FocusRoute> {
  if (!feed) return "none";

  if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
    const flown = await inPage<string>(
      `(() => { const m = window.__osirisMap;` +
        ` if (!m || typeof m.flyTo !== 'function') return 'no-map';` +
        ` m.flyTo({ center: [${coords.lng}, ${coords.lat}], zoom: ${coords.zoom ?? 6}, duration: 2200, essential: true });` +
        ` return 'flown'; })()`
    );
    if (flown === "flown") return "map";
  }

  if (!place.trim()) return "none";

  // The search route. `s` opens Osiris's search panel; Enter takes the first
  // result when nothing is highlighted, which is exactly "go to that place".
  await pressInOsiris("s");
  await pause(450);
  const typed = await typeInOsiris(place.trim());
  if (!typed) return "none";
  await pause(1400); // let the geocoder answer before committing
  feed.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  feed.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  return "search";
}

/**
 * Type into whatever the grid has focused.
 *
 * insertText is one call and usually enough; a controlled React input that
 * ignores it is then typed into character by character, which no input can
 * tell from a person. The value is read back so the difference is detected
 * rather than assumed.
 */
async function typeInOsiris(text: string): Promise<boolean> {
  if (!feed) return false;
  try {
    feed.insertText(text);
  } catch {
    /* fall through to the per-character path */
  }
  await pause(250);
  const landed = await inPage<string>(
    `(document.activeElement && 'value' in document.activeElement ? document.activeElement.value : '') || ''`
  );
  if (landed && landed.includes(text.slice(0, 3))) return true;

  for (const ch of text) {
    feed.sendInputEvent({ type: "keyDown", keyCode: ch });
    feed.sendInputEvent({ type: "char", keyCode: ch });
    feed.sendInputEvent({ type: "keyUp", keyCode: ch });
  }
  await pause(200);
  const second = await inPage<string>(
    `(document.activeElement && 'value' in document.activeElement ? document.activeElement.value : '') || ''`
  );
  return !!second;
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
