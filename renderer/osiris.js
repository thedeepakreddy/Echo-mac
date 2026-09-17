// Osiris panel: hold an Echo-themed loader over the grid until it has actually
// loaded, then get out of the way. Which instance to show arrives in the query
// string, because the main process decides it (a local checkout if one is
// running, otherwise the hosted grid) and the page must not second-guess that.

const params = new URLSearchParams(location.search);
const src = params.get("src") || "https://osirisai.live/";
const base = params.get("base") || "";

const feed = document.getElementById("feed");
const loading = document.getElementById("loading");
const sub = document.getElementById("ldrsub");
const retune = document.getElementById("retune");
const origin = document.getElementById("origin");

try {
  const host = new URL(base || src).host;
  origin.textContent = /^(localhost|127\.0\.0\.1)/.test(host) ? `LOCAL · ${host}` : host.toUpperCase();
} catch {
  origin.textContent = "";
}

feed.src = src;

let revealed = false;
function reveal() {
  if (revealed) return;
  revealed = true;
  clearTimeout(watchdog);
  loading.classList.add("gone");
  feed.classList.add("show");
}

feed.addEventListener("did-finish-load", () => { retune.classList.remove("run"); reveal(); });
feed.addEventListener("did-stop-loading", () => { retune.classList.remove("run"); reveal(); });

feed.addEventListener("did-start-loading", () => {
  // Before the first reveal this is the cold start; after it, it is a layer
  // change or a reconnect, and the map should stay on screen while it happens.
  if (revealed) {
    retune.classList.add("run");
    return;
  }
  // Also the path back from a refusal, so the curtain doesn't keep insisting
  // the grid is down while it is visibly loading again.
  document.querySelector(".ldr-text").textContent = "ESTABLISHING INTELLIGENCE LINK";
  sub.classList.remove("error");
  sub.textContent = "contacting the grid…";
});
feed.addEventListener("dom-ready", () => { if (!revealed) sub.textContent = "rendering the globe…"; });

feed.addEventListener("did-fail-load", (e) => {
  // -3 is ABORTED (usually a sub-resource) — not a real page failure.
  if (e.errorCode === -3) return;
  retune.classList.remove("run");
  if (revealed) return;
  sub.textContent = "couldn't reach the grid — check your connection";
  sub.classList.add("error");
  clearTimeout(watchdog);
});

// Never leave the curtain up forever: some single-page apps settle without
// firing a load event Electron surfaces.
const watchdog = setTimeout(reveal, 15000);

// ── controls ───────────────────────────────────────────────────────────────

const pinButton = document.getElementById("pin");

document.getElementById("close").addEventListener("click", () => window.echoOsiris?.close());
pinButton.addEventListener("click", () => window.echoOsiris?.togglePin());
document.getElementById("reload").addEventListener("click", () => {
  sub.classList.remove("error");
  sub.textContent = "reconnecting…";
  retune.classList.add("run");
  window.echoOsiris?.reload();
});

// The main process owns the pinned state; the button only reflects it.
window.echoOsiris?.onPinned((on) => pinButton.classList.toggle("on", !!on));

// A refused page (a rate limit, an outage) loads like any other page. Say what
// happened in Echo's own words instead of framing someone else's error screen.
window.echoOsiris?.onTrouble((t) => {
  revealed = false;
  clearTimeout(watchdog);
  retune.classList.remove("run");
  feed.classList.remove("show");
  loading.classList.remove("gone");
  document.querySelector(".ldr-text").textContent = `GRID UNAVAILABLE · ${t?.code ?? "?"}`;
  sub.textContent = t?.hint || "the grid wouldn't load";
  sub.classList.add("error");
});
