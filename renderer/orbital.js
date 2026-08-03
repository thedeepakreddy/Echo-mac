// Orbital panel: reveal the live Starport feed only once it has fully loaded,
// with an Echo-themed loader until then.

const feed = document.getElementById("feed");
const loading = document.getElementById("loading");
const sub = document.getElementById("ldrsub");

let revealed = false;
function reveal() {
  if (revealed) return;
  revealed = true;
  clearTimeout(watchdog);
  loading.classList.add("gone");
  feed.classList.add("show");
}

// The webview signals a completed load. did-stop-loading is the reliable "the
// page finished" event; did-finish-load covers the main frame specifically.
feed.addEventListener("did-finish-load", reveal);
feed.addEventListener("did-stop-loading", reveal);

// While loading, surface progress so the wait doesn't feel dead.
feed.addEventListener("did-start-loading", () => { sub.textContent = "acquiring satellite feed…"; });
feed.addEventListener("dom-ready", () => { sub.textContent = "rendering orbital map…"; });

// If the site can't be reached, say so instead of spinning forever.
feed.addEventListener("did-fail-load", (e) => {
  // -3 is ABORTED (e.g. a sub-resource) — not a real page failure; ignore it.
  if (e.errorCode === -3 || revealed) return;
  sub.textContent = "couldn't reach the feed — check your connection";
  sub.classList.add("error");
  clearTimeout(watchdog);
});

// Safety net: never leave the loader up forever. If load events never fire
// (some SPAs settle oddly), reveal after a bounded wait.
const watchdog = setTimeout(reveal, 12000);

// Controls
document.getElementById("close").addEventListener("click", () => window.echoOrbital?.close());
document.getElementById("reload").addEventListener("click", () => {
  revealed = false;
  feed.classList.remove("show");
  loading.classList.remove("gone");
  sub.classList.remove("error");
  sub.textContent = "reconnecting…";
  try { feed.reload(); } catch { /* webview not ready */ }
  setTimeout(reveal, 12000);
});
