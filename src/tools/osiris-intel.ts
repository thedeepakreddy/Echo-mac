/**
 * Osiris — the open-source global intelligence grid Echo shows and questions.
 *
 * Osiris (github.com/simplifaisoul/osiris, MIT) is a Next.js + MapLibre OSINT
 * dashboard: a 3D globe layered with live flights, earthquakes, fires, CCTV,
 * satellites, conflict zones and news. Two halves of it are useful to Echo and
 * they are deliberately kept apart:
 *
 *   - the PICTURE — the globe itself, shown in its own window (see osiris.ts).
 *   - the NUMBERS — the same feeds its client reads, at /api/*, which Echo can
 *     query directly and answer out loud without the user reading anything.
 *
 * This module owns the numbers plus the vocabulary shared with the window: the
 * layer catalogue, the spoken aliases for both layers and feeds, and where the
 * instance lives. It deliberately imports nothing from Electron so the whole
 * thing stays testable in plain Node (`npm run osiristest`).
 */
import { loadConfig } from "../config.js";
import { getAppPath } from "../utils/appPath.js";

/** The project's own hosted deployment. Note the spelling: osiris + ai. */
export const HOSTED_BASE = "https://osirisai.live";
/** Where `npm run dev` in a checkout of the repo puts it. */
export const LOCAL_BASE = "http://localhost:3000";

/**
 * Osiris identifies itself to its own API with a browser User-Agent, and its
 * host answers some routes differently without one. Ask the way its client asks.
 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** Strip a trailing slash so `${base}/api/x` never doubles it. */
export function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

// ── layers ────────────────────────────────────────────────────────────────

/**
 * Every layer id Osiris's client knows, taken from the `activeLayers` state in
 * its src/app/page.tsx. An id that is not in that object is silently ignored by
 * the page, so this list is what "a layer" can mean.
 */
export const LAYER_IDS = [
  "flights", "private", "jets", "military",
  "maritime",
  "satellites", "sat_comms", "sat_military", "sat_navigation", "sat_earth", "sat_science",
  "balloons",
  "cctv", "cctv_previews",
  "live_news",
  "earthquakes", "fires", "weather", "radiation",
  "infrastructure", "global_incidents", "war_alerts",
  "day_night", "cables",
  "sdk_sea", "sdk_air", "sdk_naval",
  "terrain_3d", "terrain_elevation",
  "malware", "cyber_attacks", "gdelt_events", "cf_outages", "cf_attacks",
];

/** What Osiris switches on for a visitor who arrives with no `?layers=`. */
export const DEFAULT_LAYERS = [
  "maritime", "cctv", "cctv_previews", "live_news", "earthquakes",
  "global_incidents", "day_night", "cables", "sdk_sea", "sdk_air", "sdk_naval",
];

/**
 * The view Echo opens the grid with: everything worth watching at a glance.
 *
 * Wider than Osiris's own defaults on purpose — this is the "put the world on
 * screen" picture, so air traffic, satellites, fires, weather and the cyber
 * layers are on from the start rather than needing a second command. The four
 * left off (balloons, radiation, infrastructure, war_alerts, and the heavier
 * terrain_elevation / gdelt / Cloudflare layers) are either noisy or slow, and
 * are one "add the war alerts" away. Override it in config.json.
 */
export const STANDARD_VIEW = [
  "flights", "private", "jets", "military",
  "maritime",
  "satellites", "sat_comms", "sat_military", "sat_navigation", "sat_earth", "sat_science",
  "cctv", "cctv_previews", "live_news",
  "earthquakes", "fires", "weather",
  "global_incidents", "day_night", "cables",
  "sdk_sea", "sdk_air", "sdk_naval",
  "terrain_3d", "malware", "cyber_attacks",
];

/**
 * Spoken names for layers. Nobody says "sat_navigation" — they say "GPS
 * satellites" — and the model should not have to guess an internal id from a
 * voice command, so every phrase anyone is likely to use maps to real ids here.
 */
const LAYER_ALIASES: Record<string, string[]> = {
  "flights": ["flights"], "flight": ["flights"], "planes": ["flights"], "plane": ["flights"],
  "aircraft": ["flights"], "air traffic": ["flights"], "airplanes": ["flights"],
  "commercial flights": ["flights"],
  "all flights": ["flights", "private", "jets", "military"],
  "private planes": ["private"], "private flights": ["private"],
  "jets": ["jets"], "private jets": ["jets", "private"],
  "military": ["military"], "military flights": ["military"], "military planes": ["military"],
  "warplanes": ["military"],
  "ships": ["maritime"], "shipping": ["maritime"], "vessels": ["maritime"],
  "maritime": ["maritime"], "ports": ["maritime"], "navy": ["sdk_naval", "maritime"],
  "satellites": ["satellites"], "sats": ["satellites"], "orbit": ["satellites"],
  "space": ["satellites"],
  "comms satellites": ["sat_comms"], "communication satellites": ["sat_comms"],
  "military satellites": ["sat_military"],
  "gps satellites": ["sat_navigation"], "navigation satellites": ["sat_navigation"],
  "earth satellites": ["sat_earth"], "science satellites": ["sat_science"],
  "balloons": ["balloons"],
  "cameras": ["cctv", "cctv_previews"], "cctv": ["cctv", "cctv_previews"],
  "webcams": ["cctv", "cctv_previews"], "street cameras": ["cctv", "cctv_previews"],
  "camera previews": ["cctv_previews"],
  "news": ["live_news"], "live news": ["live_news"], "broadcasts": ["live_news"],
  "tv": ["live_news"], "channels": ["live_news"],
  "earthquakes": ["earthquakes"], "quakes": ["earthquakes"], "seismic": ["earthquakes"],
  "tremors": ["earthquakes"],
  "fires": ["fires"], "wildfires": ["fires"], "hotspots": ["fires"], "volcanoes": ["fires"],
  "weather": ["weather"], "storms": ["weather"], "severe weather": ["weather"],
  "radiation": ["radiation"],
  "infrastructure": ["infrastructure"], "power plants": ["infrastructure"],
  "nuclear": ["infrastructure"], "reactors": ["infrastructure"],
  "incidents": ["global_incidents"], "global incidents": ["global_incidents"],
  "war": ["war_alerts", "global_incidents"], "conflicts": ["war_alerts", "global_incidents"],
  "conflict zones": ["war_alerts", "global_incidents"], "war alerts": ["war_alerts"],
  "frontlines": ["war_alerts"],
  "day night": ["day_night"], "daylight": ["day_night"], "night": ["day_night"],
  "terminator": ["day_night"], "day and night": ["day_night"],
  "cables": ["cables"], "undersea cables": ["cables"], "subsea cables": ["cables"],
  "internet cables": ["cables"],
  "terrain": ["terrain_3d", "terrain_elevation"], "elevation": ["terrain_elevation"],
  "3d terrain": ["terrain_3d"],
  "malware": ["malware"],
  "cyber": ["cyber_attacks", "malware"], "cyber attacks": ["cyber_attacks"],
  "hacking": ["cyber_attacks", "malware"], "attacks": ["cyber_attacks"],
  "events": ["gdelt_events"], "gdelt": ["gdelt_events"],
  "outages": ["cf_outages"], "internet outages": ["cf_outages"],
};

/** Lowercase, de-punctuate and collapse whitespace, so "Day-Night" ≡ "day night". */
function normalizeName(name: string): string {
  return String(name ?? "").toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Turn whatever the user said into real layer ids.
 *
 * Both directions are accepted: a raw id ("sat_comms") passes through, and a
 * spoken phrase ("gps satellites") expands — sometimes to several ids, because
 * "private jets" is two layers in Osiris and one thing to a person.
 */
export function resolveLayers(names: string[]): { ids: string[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const raw of names ?? []) {
    const spoken = normalizeName(raw);
    if (!spoken) continue;
    const asId = spoken.replace(/ /g, "_");
    if (LAYER_IDS.includes(asId)) {
      ids.push(asId);
      continue;
    }
    // Spoken input arrives in whatever number the sentence needed — "show the
    // camera" and "show cameras" are the same request — so both are tried.
    const alias =
      LAYER_ALIASES[spoken] ??
      LAYER_ALIASES[spoken.replace(/s$/, "")] ??
      LAYER_ALIASES[`${spoken}s`];
    if (alias) ids.push(...alias);
    else unknown.push(raw);
  }
  return { ids: [...new Set(ids)], unknown };
}

/**
 * The URL that puts Osiris in a given layer state.
 *
 * Its client reads `?layers=` once, on mount, and treats every id NOT listed as
 * off — so this one string is the whole state, and an empty list would be read
 * as "no parameter at all" and silently restore the defaults. "none" is the
 * sentinel for a truly bare globe: it matches no id, so everything goes off.
 */
export function layersUrl(base: string, ids: string[]): string {
  const list = ids.length ? [...new Set(ids)].join(",") : "none";
  return `${normalizeBase(base)}/?layers=${encodeURIComponent(list)}`;
}

/** Read the layer state back out of a URL Osiris is currently showing. */
export function layersFromUrl(url: string): string[] {
  try {
    const value = new URL(url).searchParams.get("layers");
    if (!value || value === "none") return [];
    return value.split(",").map((s) => s.trim()).filter((s) => LAYER_IDS.includes(s));
  } catch {
    return [];
  }
}

/** "flights, earthquakes and fires" — a list for the ear, not a JSON array. */
export function speakList(items: string[]): string {
  const clean = items.map((s) => s.replace(/_/g, " "));
  if (clean.length === 0) return "nothing";
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

// ── where the instance lives ──────────────────────────────────────────────

/**
 * An explicitly configured instance, if there is one.
 *
 * OSIRIS_URL wins over config.json so a checkout can be pointed at for one run
 * without editing anything. Neither is required — with both absent Echo uses
 * the project's hosted deployment.
 */
export function configuredBase(): string | null {
  const fromEnv = process.env.OSIRIS_URL?.trim();
  if (fromEnv) return normalizeBase(fromEnv);
  try {
    const configured = loadConfig(getAppPath()).osiris?.baseUrl;
    if (typeof configured === "string" && configured.trim()) return normalizeBase(configured);
  } catch {
    /* a missing or broken config must not stop the hosted grid from opening */
  }
  return null;
}

/**
 * The layers Echo opens the grid with, when the command didn't name any.
 *
 * config.json wins so the opening view is editable without touching code; an id
 * that is not a real layer is dropped rather than sent, since Osiris would
 * silently ignore it and the reported state would then disagree with the map.
 */
export function openingLayers(): string[] {
  try {
    const configured = loadConfig(getAppPath()).osiris?.defaultLayers;
    if (Array.isArray(configured) && configured.length) {
      const known = configured.filter((id) => LAYER_IDS.includes(id));
      if (known.length) return known;
    }
  } catch {
    /* fall through to the standard view */
  }
  return STANDARD_VIEW;
}

/** Whether to look for a local checkout before falling back to the hosted one. */
export function prefersLocal(): boolean {
  try {
    return loadConfig(getAppPath()).osiris?.preferLocal !== false;
  } catch {
    return true;
  }
}

/**
 * Ports a Next.js app lands on. 3000 is the documented one, but it is also the
 * single most contested port on a developer's machine — this very integration
 * was first tested against someone else's app sitting on 3000 — so the next two
 * are checked as well, and the answer is only accepted if it IS Osiris.
 */
export const LOCAL_PORTS = [3000, 3001, 3002];

/**
 * Is the thing at this URL an Osiris instance?
 *
 * Deliberately a short, cheap look at the page itself rather than an API call:
 * /api/stats fans out to every upstream feed and can take fifteen seconds, far
 * too long to spend deciding which URL to open. Two markers rather than one,
 * because "osiris" alone could appear on any page.
 */
export async function probeLocal(base = LOCAL_BASE, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${normalizeBase(base)}/`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return false;
    const html = (await res.text()).slice(0, 8000);
    return /osiris/i.test(html) && /(open source intelligence|osint|maplibre|intelligence platform)/i.test(html);
  } catch {
    return false;
  }
}

/**
 * The first local port actually running Osiris, if any.
 *
 * Every port is tried at once, and the timeout is generous by the standards of
 * a localhost request: measured in Electron, the FIRST fetch of a process pays
 * about 1.5s of connection setup before any server answers, so a tight budget
 * here reported "no local instance" for one that was running perfectly.
 * warmOsiris() below pays this cost at launch, off the user's critical path.
 */
export async function findLocal(timeoutMs = 3000): Promise<string | null> {
  const found = await Promise.all(
    LOCAL_PORTS.map(async (port) => {
      const url = `http://localhost:${port}`;
      return (await probeLocal(url, timeoutMs)) ? url : null;
    })
  );
  return found.find((url): url is string => !!url) ?? null;
}

/** Remember the answer briefly — one probe per minute, not one per tool call. */
let cachedBase: { url: string; at: number } | null = null;
const BASE_TTL_MS = 60_000;

/**
 * The instance Echo should be talking to right now: an explicit setting, else a
 * local checkout if one is running, else the hosted grid.
 */
export async function activeBase(): Promise<string> {
  const explicit = configuredBase();
  if (explicit) return explicit;
  if (cachedBase && Date.now() - cachedBase.at < BASE_TTL_MS) return cachedBase.url;
  const local = prefersLocal() ? await findLocal() : null;
  const url = local ?? HOSTED_BASE;
  cachedBase = { url, at: Date.now() };
  return url;
}

/** Forget the probe result — used when the panel is told to reconnect. */
export function forgetBase(): void {
  cachedBase = null;
}

/**
 * Work out which instance to use now, in the background, so the first "show me
 * the world" opens immediately instead of waiting on a port scan.
 */
export function warmOsiris(): void {
  void activeBase().catch(() => {
    /* the decision is remade on demand */
  });
}

/** True when this base is the project's public deployment rather than a checkout. */
export function isHosted(base: string): boolean {
  return normalizeBase(base) === HOSTED_BASE;
}

// ── feeds ─────────────────────────────────────────────────────────────────

export interface FeedDef {
  id: string;
  path: string;
  /** Spoken name, used in Echo's answer. */
  label: string;
  aliases: string[];
}

/**
 * The feeds worth asking about out loud. Osiris exposes sixty-nine routes; most
 * are lookups that need a target (an IP, a wallet, a CVE) and belong to its own
 * RECON panel. These are the ones that answer "what's happening" with no input.
 */
export const FEEDS: FeedDef[] = [
  {
    id: "status", path: "/api/stats", label: "grid status",
    aliases: ["status", "overview", "summary", "stats", "everything", "world", "briefing"],
  },
  {
    id: "earthquakes", path: "/api/earthquakes", label: "earthquakes",
    aliases: ["earthquake", "quakes", "quake", "seismic", "tremors"],
  },
  {
    id: "flights", path: "/api/flights", label: "air traffic",
    aliases: ["flight", "planes", "aircraft", "air traffic", "aviation", "military flights"],
  },
  {
    id: "fires", path: "/api/fires", label: "fires",
    aliases: ["fire", "wildfires", "hotspots", "volcanoes"],
  },
  {
    id: "news", path: "/api/news", label: "intel feed",
    aliases: ["headlines", "intel", "feed", "stories", "osint"],
  },
  {
    id: "satellites", path: "/api/satellites", label: "satellites",
    aliases: ["satellite", "sats", "orbit", "space objects"],
  },
  {
    id: "conflicts", path: "/api/conflicts", label: "conflict zones",
    aliases: ["conflict", "war", "wars", "warzones", "frontlines"],
  },
  {
    id: "space_weather", path: "/api/space-weather", label: "space weather",
    aliases: ["solar", "solar weather", "geomagnetic", "aurora", "kp", "solar flares"],
  },
  {
    id: "weather", path: "/api/weather", label: "severe weather",
    aliases: ["storms", "severe weather", "hurricanes", "cyclones"],
  },
  {
    id: "cyber", path: "/api/cyber-threats", label: "cyber threats",
    aliases: ["cyber", "cve", "vulnerabilities", "threats", "hacking"],
  },
];

/** Match a spoken feed name ("quakes", "what's on fire") to a feed. */
export function resolveFeed(name: string): FeedDef | undefined {
  const spoken = normalizeName(name);
  if (!spoken) return undefined;
  const key = spoken.replace(/ /g, "_");
  return (
    FEEDS.find((f) => f.id === key) ??
    FEEDS.find((f) => f.aliases.some((a) => normalizeName(a) === spoken)) ??
    FEEDS.find((f) => normalizeName(f.label) === spoken) ??
    FEEDS.find((f) => f.aliases.some((a) => spoken.includes(normalizeName(a))))
  );
}

// ── reading a feed ────────────────────────────────────────────────────────

/**
 * A second way to reach the API, used only if the direct one fails.
 *
 * A deployment behind a bot check answers a plain server-side fetch with an
 * interstitial instead of JSON, while the panel's webview — a real browser that
 * has already cleared it — gets the data. So when the panel is open, its page
 * can run the same request for us.
 */
export type Relay = (path: string) => Promise<string | null>;

/** Fetch one Osiris route as JSON, falling back to the panel when it exists. */
export async function osirisFetch(
  path: string,
  opts: { base?: string; timeoutMs?: number; relay?: Relay } = {}
): Promise<any> {
  const base = normalizeBase(opts.base ?? (await activeBase()));
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const url = `${base}${path}`;

  let directError = "";
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    const body = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(body);
      } catch {
        directError = "the grid answered with a page instead of data";
      }
    } else {
      directError = `the grid answered ${res.status}`;
    }
  } catch (e: any) {
    directError = e?.name === "TimeoutError" ? "the grid took too long to answer" : String(e?.message ?? e);
  }

  if (opts.relay) {
    try {
      const body = await opts.relay(path);
      if (body) return JSON.parse(body);
    } catch {
      /* fall through to the direct error, which is the more useful one */
    }
  }
  throw new Error(directError || "no answer from the grid");
}

// ── turning a feed into an answer ─────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)
  );
}

/** "14 minutes ago" — a timestamp nobody has to convert in their head. */
export function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  // Whole elapsed units, never rounded up: a quake 30 seconds old is "just
  // now", not "a minute ago" — reporting a time that hasn't passed yet is the
  // one error worth avoiding in something read aloud.
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function list(items: string[]): string {
  return items.map((row) => `<li>${row}</li>`).join("");
}

function arrayAt(data: any, key: string): any[] {
  const value = data?.[key];
  return Array.isArray(value) ? value : [];
}

export interface FeedSummary {
  /** One or two sentences, written to be spoken. */
  speech: string;
  /** The same reading, for the HUD's data pane. */
  html: string;
}

/**
 * Render a feed as something Echo can say.
 *
 * Every summariser is written for the payload shapes in the Osiris repo, and
 * every one of them degrades rather than throws: a feed whose upstream is down
 * answers `{ earthquakes: [], error: ... }` with HTTP 200, and "nothing came
 * back" is a perfectly good answer to say out loud.
 */
export function summarize(feedId: string, data: any): FeedSummary {
  const failed = typeof data?.error === "string" ? data.error : "";

  switch (feedId) {
    case "status": {
      const s = data?.stats ?? {};
      const parts = [
        `${s.flights ?? 0} aircraft`,
        `${s.sats ?? 0} satellites`,
        `${s.cctv ?? 0} cameras`,
        `${s.incidents ?? 0} incidents`,
        `${s.weather ?? 0} weather events`,
        `${s.nuclear ?? 0} nuclear sites`,
      ];
      return {
        speech: `The grid is tracking ${parts[0]}, ${parts[1]} and ${parts[2]}, with ${s.incidents ?? 0} global incidents live.`,
        html: `<ul>${list(parts.map(esc))}</ul>`,
      };
    }

    case "earthquakes": {
      const quakes = arrayAt(data, "earthquakes")
        .filter((q) => Number.isFinite(q?.magnitude))
        .sort((a, b) => b.magnitude - a.magnitude);
      if (!quakes.length) {
        return { speech: failed ? `No seismic data — ${failed}.` : "No earthquakes on the feed right now.", html: "<p>No events.</p>" };
      }
      const top = quakes[0];
      const strong = quakes.filter((q) => q.magnitude >= 4.5).length;
      return {
        speech:
          `${quakes.length} earthquakes in the last day. The largest is magnitude ${Number(top.magnitude).toFixed(1)} ` +
          `${top.place ?? "location unknown"}, ${ago(Number(top.time))}` +
          (strong ? `, and ${strong} of them are magnitude four and a half or above.` : "."),
        html: `<ul>${list(
          quakes.slice(0, 8).map((q) => `M${Number(q.magnitude).toFixed(1)} · ${esc(q.place)} · ${ago(Number(q.time))}`)
        )}</ul>`,
      };
    }

    case "flights": {
      const commercial = arrayAt(data, "commercial_flights").length;
      const priv = arrayAt(data, "private_flights").length;
      const jets = arrayAt(data, "private_jets").length;
      const military = arrayAt(data, "military_flights").length;
      const jamming = arrayAt(data, "gps_jamming").length;
      const total = Number(data?.total ?? commercial + priv + jets + military);
      if (!total) {
        return { speech: failed ? `No flight data — ${failed}.` : "The flight feed came back empty.", html: "<p>No aircraft.</p>" };
      }
      return {
        speech:
          `${total} aircraft in the air: ${commercial} commercial, ${priv + jets} private, ${military} military` +
          (jamming ? `, and ${jamming} zones reporting GPS jamming.` : "."),
        html: `<ul>${list([
          `${total} aircraft total`,
          `${commercial} commercial`,
          `${priv} private · ${jets} jets`,
          `${military} military`,
          `${jamming} GPS jamming zones`,
          `source: ${esc(data?.source ?? "unknown")}`,
        ])}</ul>`,
      };
    }

    case "fires": {
      const fires = arrayAt(data, "fires");
      if (!fires.length) {
        return { speech: failed ? `No fire data — ${failed}.` : "No active fire hotspots on the feed.", html: "<p>No hotspots.</p>" };
      }
      const volcanoes = fires.filter((f) => f?.type === "volcano").length;
      const hottest = [...fires].sort((a, b) => (b?.frp ?? 0) - (a?.frp ?? 0))[0];
      return {
        speech:
          `${fires.length} active fire hotspots${volcanoes ? `, including ${volcanoes} volcanic events` : ""}. ` +
          `The most intense is at ${Number(hottest?.lat).toFixed(1)}, ${Number(hottest?.lng).toFixed(1)}.`,
        html: `<ul>${list([
          `${fires.length} hotspots`,
          `${volcanoes} volcanic`,
          `source: ${esc(data?.source ?? "unknown")}`,
        ])}</ul>`,
      };
    }

    case "news": {
      const news = arrayAt(data, "news");
      if (!news.length) {
        return { speech: failed ? `No intel — ${failed}.` : "The intel feed is quiet.", html: "<p>No stories.</p>" };
      }
      const ranked = [...news].sort((a, b) => (b?.risk_score ?? 0) - (a?.risk_score ?? 0));
      const hot = ranked.filter((n) => (n?.risk_score ?? 0) >= 8).length;
      const top = ranked.slice(0, 3);
      return {
        speech:
          `${news.length} stories on the intel feed${hot ? `, ${hot} flagged high priority` : ""}. ` +
          `Top of the list: ${top.map((n) => n?.title).filter(Boolean).slice(0, 2).join("; ")}.`,
        html: `<ul>${list(
          ranked.slice(0, 6).map((n) => `[${n?.risk_score ?? 0}] ${esc(n?.title)} <em>${esc(n?.source)}</em>`)
        )}</ul>`,
      };
    }

    case "satellites": {
      const sats = arrayAt(data, "satellites");
      const counts: Record<string, number> = data?.category_counts ?? {};
      if (!sats.length) {
        return { speech: failed ? `No satellite data — ${failed}.` : "No satellites on the feed.", html: "<p>No objects.</p>" };
      }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
      return {
        speech:
          `${sats.length} satellites are being tracked` +
          (top.length ? `, mostly ${top.map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}.` : "."),
        html: `<ul>${list([`${sats.length} tracked`, ...top.map(([k, v]) => `${esc(k)}: ${v}`)])}</ul>`,
      };
    }

    case "conflicts": {
      const zones = arrayAt(data, "zones");
      const events = Number(data?.totalLiveEvents ?? arrayAt(data, "liveEvents").length);
      const wars = Number(data?.activeWarzones ?? zones.filter((z) => z?.severity === "war").length);
      if (!zones.length) {
        return { speech: failed ? `No conflict data — ${failed}.` : "No conflict zones on the feed.", html: "<p>No zones.</p>" };
      }
      const named = zones.filter((z) => z?.severity === "war").slice(0, 3).map((z) => z?.label).filter(Boolean);
      return {
        speech:
          `${zones.length} conflict zones are being watched, ${wars} of them active wars` +
          (named.length ? ` — ${speakList(named.map(String))}` : "") +
          `, with ${events} live events.`,
        html: `<ul>${list(
          zones.slice(0, 8).map((z) => `${esc(z?.label)} · ${esc(z?.severity)} · ${z?.eventCount ?? 0} events`)
        )}</ul>`,
      };
    }

    case "space_weather": {
      const kp = data?.kp_index;
      const level = data?.storm_level ?? "unknown";
      const flares = arrayAt(data, "solar_flares");
      const alerts = arrayAt(data, "alerts");
      return {
        speech:
          `Space weather is ${String(level).toLowerCase()}, Kp index ${kp ?? "unknown"}` +
          (flares.length ? `, with ${flares.length} solar flares logged, the strongest ${flares[0]?.class}.` : ".") +
          (alerts.length ? ` ${alerts.length} alerts are active.` : ""),
        html: `<ul>${list([
          `Kp ${esc(kp)} · ${esc(level)}`,
          `${flares.length} solar flares`,
          `${alerts.length} alerts`,
        ])}</ul>`,
      };
    }

    case "weather": {
      const events = arrayAt(data, "events");
      if (!events.length) {
        return { speech: failed ? `No weather data — ${failed}.` : "No severe weather events on the feed.", html: "<p>No events.</p>" };
      }
      return {
        speech: `${events.length} severe weather events are live on the grid.`,
        html: `<ul>${list(events.slice(0, 8).map((e) => esc(e?.title ?? e?.name ?? e?.type ?? "event")))}</ul>`,
      };
    }

    case "cyber": {
      const threats = arrayAt(data, "threats");
      const stats = data?.stats ?? {};
      if (!threats.length) {
        return { speech: failed ? `No cyber data — ${failed}.` : "No active cyber threats on the feed.", html: "<p>No threats.</p>" };
      }
      return {
        speech:
          `Threat level ${String(stats.threat_level ?? "unknown").toLowerCase()}, with ${threats.length} actively exploited ` +
          `vulnerabilities listed. The newest is ${threats[0]?.id ?? threats[0]?.cve ?? "unnamed"}.`,
        html: `<ul>${list(
          threats.slice(0, 6).map((t) => `${esc(t?.id ?? t?.cve)} · ${esc(t?.name ?? t?.title ?? "")}`)
        )}</ul>`,
      };
    }

    default: {
      // An unknown feed still deserves a truthful count rather than an error.
      const firstArray = Object.entries(data ?? {}).find(([, v]) => Array.isArray(v));
      const count = firstArray ? (firstArray[1] as any[]).length : 0;
      return {
        speech: firstArray ? `${count} ${firstArray[0].replace(/_/g, " ")} on the feed.` : "The feed answered, but with nothing I can read out.",
        html: `<pre>${esc(JSON.stringify(data ?? {}, null, 2).slice(0, 1200))}</pre>`,
      };
    }
  }
}
