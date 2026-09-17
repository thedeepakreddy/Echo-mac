/**
 * The Osiris grid — what Echo shows, and what it can say about it.
 *
 *   npm run osiristest
 *
 * Offline by design. Every network call in this feature is either a fetch to an
 * Osiris instance or a call into Electron, and both are absent here, so what is
 * checked is the part that is easy to get quietly wrong: the vocabulary between
 * a spoken phrase and a layer id, the `?layers=` contract this integration
 * leans on, and the summarisers — which must survive a feed answering with an
 * empty list, an error field, or nothing at all, since that is what a live
 * OSINT API does on a bad day.
 */
import {
  DEFAULT_LAYERS,
  FEEDS,
  HOSTED_BASE,
  LAYER_IDS,
  LOCAL_PORTS,
  STANDARD_VIEW,
  ago,
  openingLayers,
  configuredBase,
  isHosted,
  layersFromUrl,
  layersUrl,
  normalizeBase,
  probeLocal,
  resolveFeed,
  resolveLayers,
  speakList,
  summarize,
} from "./tools/osiris-intel.js";
import { TOOLS } from "./tools/registry.js";
import { classify } from "./safety/risk.js";
import { toolsForLocalModel } from "./brain/localtools.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nOsiris grid\n");

console.log("  Echo has the tools to show and read the grid");
{
  const names = ["show_osiris", "osiris_layers", "osiris_intel", "osiris_focus"];
  for (const name of names) ok(!!TOOLS.find((t) => t.name === name), `${name} exists`);

  const show = TOOLS.find((t) => t.name === "show_osiris");
  ok(/stays on screen/i.test(show?.description ?? ""),
     "show_osiris tells the model the panel stays up until it is told to close");
  ok(!!show?.schema?.show && !!show?.schema?.layers,
     "show_osiris takes both an open/close flag and layers");

  const intel = TOOLS.find((t) => t.name === "osiris_intel");
  ok(intel?.readOnly === true, "reading a feed is marked read-only");
}

console.log("  every brain can reach them");
{
  for (const name of ["show_osiris", "osiris_layers", "osiris_focus"]) {
    ok(classify(name, {}, { workingDir: "/tmp" }).tier !== "high",
       `${name} is not treated as a dangerous action`);
  }
  ok(classify("osiris_intel", {}, { workingDir: "/tmp" }).tier === "low",
     "reading a feed needs no confirmation at all");

  const local = toolsForLocalModel(TOOLS.map((t) => ({ name: t.name, function: { name: t.name } })));
  const offered = new Set(local.map((t: any) => t.function?.name ?? t.name));
  ok(offered.has("show_osiris") && offered.has("osiris_intel"),
     "the local model is offered the grid too, so it works on the Ollama brain");
}

console.log("  spoken names resolve to real layers");
{
  ok(resolveLayers(["planes"]).ids.join() === "flights", "\"planes\" is the flights layer");
  ok(resolveLayers(["quakes"]).ids.join() === "earthquakes", "\"quakes\" is the earthquakes layer");
  ok(resolveLayers(["camera"]).ids.includes("cctv"), "a singular \"camera\" still finds the CCTV layer");
  ok(resolveLayers(["gps satellites"]).ids.join() === "sat_navigation", "\"GPS satellites\" is sat_navigation");
  ok(resolveLayers(["private jets"]).ids.length === 2, "\"private jets\" expands to the two layers it means");
  ok(resolveLayers(["sat_comms"]).ids.join() === "sat_comms", "a raw layer id passes straight through");
  ok(resolveLayers(["day-night"]).ids.join() === "day_night", "punctuation doesn't matter");
  ok(resolveLayers(["flights", "planes"]).ids.length === 1, "the same layer asked for twice is listed once");

  const junk = resolveLayers(["unicorns"]);
  ok(junk.ids.length === 0 && junk.unknown.join() === "unicorns",
     "a layer that doesn't exist is reported rather than silently dropped");

  ok(resolveLayers(LAYER_IDS).ids.length === LAYER_IDS.length, "every catalogued id resolves to itself");
  ok(DEFAULT_LAYERS.every((id) => LAYER_IDS.includes(id)), "the defaults are all real layers");
  ok(STANDARD_VIEW.every((id) => LAYER_IDS.includes(id)), "the standard view is all real layers");
  ok(STANDARD_VIEW.length === new Set(STANDARD_VIEW).size, "and lists none of them twice");

  // The layers the grid comes up with when nothing was named.
  const opening = openingLayers();
  ok(opening.length > 0 && opening.every((id) => LAYER_IDS.includes(id)),
     "the opening view is a non-empty set of real layers");
  ok(opening.includes("flights") && opening.includes("earthquakes"),
     "and has the things worth seeing at a glance on it");
}

console.log("  the ?layers= contract is what Osiris actually reads");
{
  const url = layersUrl(HOSTED_BASE, ["flights", "earthquakes"]);
  ok(url === `${HOSTED_BASE}/?layers=flights%2Cearthquakes`, "layers go on the URL as one comma-separated value");
  ok(layersFromUrl(url).join() === "flights,earthquakes", "and read back out of it");

  // Osiris restores its defaults when the parameter is missing OR empty, so a
  // bare globe needs a value that matches no layer rather than no value.
  ok(layersUrl(HOSTED_BASE, []).endsWith("layers=none"), "an empty list becomes the 'none' sentinel");
  ok(layersFromUrl(`${HOSTED_BASE}/?layers=none`).length === 0, "which reads back as nothing on");

  ok(layersFromUrl(`${HOSTED_BASE}/?layers=flights,made_up`).join() === "flights",
     "an id the client doesn't know is dropped on the way back in");
  ok(layersFromUrl(`${HOSTED_BASE}/`).length === 0, "a URL with no parameter reports nothing on");
  ok(layersFromUrl("not a url").length === 0, "a malformed URL is survivable");

  ok(normalizeBase("http://localhost:3000/") === "http://localhost:3000", "a trailing slash never doubles up");
  ok(isHosted(`${HOSTED_BASE}/`) && !isHosted("http://localhost:3000"),
     "a checkout is told apart from the hosted grid");
}

console.log("  feeds resolve the way they are asked for");
{
  ok(resolveFeed("earthquakes")?.id === "earthquakes", "by name");
  ok(resolveFeed("quakes")?.id === "earthquakes", "by nickname");
  ok(resolveFeed("air traffic")?.id === "flights", "by what the layer is actually called");
  ok(resolveFeed("what's the solar weather")?.id === "space_weather", "inside a phrase");
  ok(resolveFeed("")?.id === undefined, "an empty ask resolves to nothing");
  ok(FEEDS.every((f) => f.path.startsWith("/api/")), "every feed points at a real API route");
}

console.log("  a feed becomes something Echo can say");
{
  const quakes = summarize("earthquakes", {
    earthquakes: [
      { magnitude: 6.2, place: "off the coast of Honshu", time: Date.now() - 90 * 60 * 1000 },
      { magnitude: 2.6, place: "Pāhala, Hawaii", time: Date.now() - 10 * 60 * 1000 },
    ],
  });
  ok(/6\.2/.test(quakes.speech) && /Honshu/.test(quakes.speech), "the largest quake leads the answer");
  ok(!/undefined|NaN|\[object/.test(quakes.speech), "and reads as a sentence, not a dump");

  const flights = summarize("flights", {
    commercial_flights: [1, 2, 3], private_flights: [1], private_jets: [1, 2],
    military_flights: [1], gps_jamming: [1], total: 7, source: "opensky",
  });
  ok(/7 aircraft/.test(flights.speech) && /jamming/.test(flights.speech), "air traffic counts every category");

  const space = summarize("space_weather", { kp_index: 1, storm_level: "Quiet", solar_flares: [{ class: "B5.8" }], alerts: [] });
  ok(/quiet/i.test(space.speech) && /B5\.8/.test(space.speech), "space weather names the storm level and the flare");

  const conflicts = summarize("conflicts", {
    zones: [{ label: "UKRAINE WAR", severity: "war", eventCount: 12 }],
    liveEvents: [1, 2], totalLiveEvents: 2, activeWarzones: 1,
  });
  ok(/UKRAINE WAR/.test(conflicts.speech), "conflict zones are named, not just counted");

  // The failure shapes a live OSINT API really produces.
  for (const feed of FEEDS) {
    const empty = summarize(feed.id, {});
    const errored = summarize(feed.id, { error: "USGS unavailable", earthquakes: [], news: [], fires: [] });
    ok(!!empty.speech && !!empty.html, `${feed.id} answers something when the payload is empty`);
    ok(!!errored.speech, `${feed.id} answers something when the feed reports an error`);
  }
  ok(!!summarize("something_new", { widgets: [1, 2, 3] }).speech,
     "a feed added to Osiris later still gets a truthful count");

  ok(summarize("earthquakes", { earthquakes: [{ magnitude: 5, place: "<script>x</script>", time: Date.now() }] }).html
      .includes("&lt;script&gt;"),
     "feed text is escaped before it reaches the HUD pane");
}

console.log("  small things said out loud");
{
  ok(speakList(["flights"]) === "flights", "one item is just the item");
  ok(speakList(["flights", "fires"]) === "flights and fires", "two items get an 'and'");
  ok(speakList(["a", "b", "c"]) === "a, b and c", "three items get commas and an 'and'");
  ok(speakList(["day_night"]) === "day night", "an id is spoken, not spelled");
  ok(ago(Date.now() - 30_000) === "just now", "half a minute ago is 'just now'");
  ok(ago(Date.now() - 2 * 60 * 60 * 1000) === "2 hours ago", "hours are hours");
}

console.log("  choosing which instance to talk to");
{
  const before = process.env.OSIRIS_URL;
  process.env.OSIRIS_URL = "http://localhost:4000/";
  ok(configuredBase() === "http://localhost:4000", "OSIRIS_URL wins, normalised");
  delete process.env.OSIRIS_URL;
  const fromConfig = configuredBase();
  ok(fromConfig === null || /^https?:\/\//.test(fromConfig),
     "with no environment override it is either unset or a real URL from config");
  if (before !== undefined) process.env.OSIRIS_URL = before;
}

console.log("  the panel module survives outside Electron");
{
  const osiris = await import("./osiris.js");
  ok(osiris.isOsirisOpen() === false, "no window is reported when there is no Electron");
  ok(osiris.osirisBase() === null, "and no instance is claimed");
  ok(osiris.setOsirisPinned(true) === false, "pinning a window that isn't there fails quietly");
  ok((await osiris.currentLayers()) === null, "layers are unknown rather than invented");
  ok((await osiris.applyLayers(["fires"])) === "closed",
     "a layer change with no panel says so instead of claiming it worked");
  ok((await osiris.focusOsiris("Tokyo")) === "none", "and the camera reports it couldn't move");
  osiris.closeOsirisPanel(); // must not throw
  ok(true, "closing nothing is a no-op");
}

console.log("  probing for a local checkout");
{
  // Port 1 is never a dev server; this checks the probe fails fast and false
  // rather than throwing, which is what keeps the hosted fallback working.
  const found = await probeLocal("http://127.0.0.1:1", 250);
  ok(found === false, "an unreachable local instance is simply absent");
  // 3000 is the most contested port on a developer's machine — this feature was
  // first tested against someone else's app sitting on it — so more than one is
  // checked, and only a page that identifies as Osiris counts.
  ok(LOCAL_PORTS.length > 1 && LOCAL_PORTS[0] === 3000,
     "more than one local port is considered, starting at the documented one");
}

console.log(`\n${pass}/${pass + fail} Osiris checks passed\n`);
process.exit(fail ? 1 : 0);
