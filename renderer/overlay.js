// contextIsolation means `window.ipcRenderer` does not exist; the preload
// exposes a narrow bridge instead. Reading it off window threw immediately,
// which is why none of the overlay effects below ever ran.
const ipcRenderer = window.jarvisOverlay ?? { on: () => {} };

// Phone-remote link: a QR to scan, plus the URL as a fallback. Stays up long
// enough to scan comfortably; re-triggered by asking for the link again.
// NOTE: the jarvisOverlay bridge delivers ONLY the payload to the callback —
// not (event, payload). Taking two args here made `data` undefined and the
// handler returned early, which is exactly why the QR never appeared.
let remoteLinkTimer = null;
ipcRenderer.on("show-remote-link", (data) => {
  const el = document.getElementById("remote-link");
  const img = document.getElementById("rl-qr");
  const url = document.getElementById("rl-url");
  if (!el || !data) return;
  if (data.qr) img.src = data.qr;
  url.textContent = data.url || "";
  el.classList.remove("hidden");
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(remoteLinkTimer);
  // Two minutes to scan or photograph — the link is permanent, so once saved
  // it never needs showing again (and "show me the QR" brings it back). The
  // close button lets you dismiss it sooner.
  remoteLinkTimer = setTimeout(hideRemoteLink, 120000);
});
ipcRenderer.on("hide-remote-link", hideRemoteLink);

function hideRemoteLink() {
  const el = document.getElementById("remote-link");
  if (!el) return;
  clearTimeout(remoteLinkTimer);
  el.classList.remove("show");
  setTimeout(() => el.classList.add("hidden"), 500);
  // Hand clicks back to the app underneath.
  window.jarvisOverlay?.setInteractive?.(false);
}

// The overlay is click-through, so the close button only receives a click while
// the pointer is over it and we have asked main for interactivity. `forward:true`
// on the window keeps these hover events flowing even while ignoring clicks.
(function wireRemoteClose() {
  const btn = document.getElementById("rl-close");
  if (!btn) return;
  btn.addEventListener("mouseenter", () => window.jarvisOverlay?.setInteractive?.(true));
  btn.addEventListener("mouseleave", () => window.jarvisOverlay?.setInteractive?.(false));
  btn.addEventListener("click", hideRemoteLink);
})();

// 1. Holographic Targeting HUD
ipcRenderer.on("show-targeting", () => {
  const el = document.getElementById("targeting-hud");
  el.classList.remove("hidden");
  // Auto-hide after 3 seconds
  setTimeout(() => {
    el.classList.add("hidden");
  }, 3000);
});

let dataPaneTimer = null;

function hideDataPane() {
  const el = document.getElementById("data-pane");
  if (!el) return;
  clearTimeout(dataPaneTimer);
  el.classList.remove("show");
  setTimeout(() => el.classList.add("hidden"), 600);
  window.jarvisOverlay?.setInteractive?.(false);
}

(function wireDataPaneClose() {
  const pane = document.getElementById("data-pane");
  const btn = document.getElementById("data-pane-close");
  if (!pane || !btn) return;
  
  pane.addEventListener("mouseenter", () => window.jarvisOverlay?.setInteractive?.(true));
  pane.addEventListener("mouseleave", () => window.jarvisOverlay?.setInteractive?.(false));
  btn.addEventListener("click", hideDataPane);
})();

// 2. Context-Aware Data Pane
ipcRenderer.on("show-data-pane", (data) => {
  const el = document.getElementById("data-pane");
  const title = document.getElementById("data-pane-title");
  const content = document.getElementById("data-pane-content");
  
  title.innerText = data.title || "DOSSIER";
  content.innerHTML = (data.content || "").replace(/\n/g, "<br>");
  
  el.classList.remove("hidden");
  // Give CSS a frame to apply display:block before starting transition
  requestAnimationFrame(() => {
    el.classList.add("show");
  });
  
  clearTimeout(dataPaneTimer);
  if (data.duration !== 0) {
    dataPaneTimer = setTimeout(hideDataPane, data.duration || 8000);
  }
});

// 3. Friday Protocol Override
ipcRenderer.on("show-friday-protocol", () => {
  const el = document.getElementById("friday-protocol");
  el.classList.remove("hidden");
  // This stays on until manually dismissed or auto dismiss after 10s for demo
  setTimeout(() => {
    el.classList.add("hidden");
  }, 10000);
});

// 4. Memory Scrubbing Carousel
ipcRenderer.on("show-memory-carousel", (memories) => {
  const el = document.getElementById("memory-carousel");
  const track = document.getElementById("carousel-track");
  track.innerHTML = "";
  
  if (!memories || memories.length === 0) return;
  
  // Create cards
  memories.forEach((mem, i) => {
    const card = document.createElement("div");
    card.className = "memory-card";
    
    // Calculate 3D position
    // Center card is z=0, others are pushed back and to the sides
    const offset = i - Math.floor(memories.length / 2);
    const z = Math.abs(offset) * -100;
    const x = offset * 250;
    const opacity = 1 - Math.abs(offset) * 0.2;
    
    card.style.transform = `translateX(${x}px) translateZ(${z}px) rotateY(${-offset * 15}deg)`;
    card.style.opacity = opacity;
    card.style.zIndex = 100 - Math.abs(offset);
    
    card.innerHTML = `
      <div class="ts">${mem.timestamp}</div>
      <div class="txt">${mem.text.substring(0, 200)}...</div>
    `;
    track.appendChild(card);
  });
  
  el.classList.remove("hidden");
  requestAnimationFrame(() => {
    el.classList.add("show");
  });
  
  // Auto-hide after 10s
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.classList.add("hidden"), 500);
  }, 10000);
});

/* ===========================================================================
 * Live action feed.
 *
 * Every tool Jarvis runs arrives here and is shown as it happens, so the work
 * is visible rather than inferred from a moving cursor. The feed hides itself
 * after a lull — an always-on panel stops being information and becomes decor.
 * ======================================================================== */

const feed = document.getElementById("action-feed");
const feedLines = document.getElementById("feed-lines");
const feedState = document.getElementById("feed-state");
const strike = document.getElementById("strike");
const targetBox = document.getElementById("target-box");
const scanbeam = document.getElementById("scanbeam");

const MAX_LINES = 12;
let idleTimer = null;

function clock() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function wake() {
  feed?.classList.add("live");
  clearTimeout(idleTimer);
  // Fade out when nothing has happened for a while.
  idleTimer = setTimeout(() => feed?.classList.remove("live"), 12000);
}

function pushLine(text, kind = "") {
  if (!feedLines || !text) return;
  const li = document.createElement("li");
  if (kind) li.className = kind;
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = clock();
  const m = document.createElement("span");
  m.className = "m";
  m.textContent = text;
  li.append(t, m);
  // Newest at the top: the eye starts there, and older work recedes downward.
  feedLines.prepend(li);
  while (feedLines.children.length > MAX_LINES) feedLines.lastChild.remove();
  wake();
}

/** Flash a marker exactly where a click is about to land. */
function showStrike(x, y) {
  if (!strike) return;
  strike.style.left = `${x}px`;
  strike.style.top = `${y}px`;
  strike.classList.remove("hidden");
  // Restart the animation even if a strike is already running.
  strike.querySelectorAll(".strike-ring, .strike-dot").forEach((el) => {
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = "";
  });
  setTimeout(() => strike.classList.add("hidden"), 700);
}

/** Trace corner brackets around the element being acted on. */
function showTarget(x, y, w, h) {
  if (!targetBox) return;
  Object.assign(targetBox.style, {
    left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`,
  });
  targetBox.classList.remove("hidden");
  targetBox.classList.remove("on");
  void targetBox.offsetWidth;
  targetBox.classList.add("on");
  setTimeout(() => targetBox.classList.add("hidden"), 1400);
}

function sweep() {
  if (!scanbeam) return;
  scanbeam.classList.remove("hidden");
  scanbeam.style.animation = "none";
  void scanbeam.offsetWidth;
  scanbeam.style.animation = "";
  setTimeout(() => scanbeam.classList.add("hidden"), 1200);
}

if (window.jarvisOverlay?.on) {
  window.jarvisOverlay.on("feed", (e) => {
    if (!e) return;
    if (e.line) pushLine(e.line, e.kind || "");
    if (e.state && feedState) feedState.textContent = e.state.toUpperCase();
    if (e.strike) showStrike(e.strike.x, e.strike.y);
    if (e.target) showTarget(e.target.x, e.target.y, e.target.w, e.target.h);
    if (e.sweep) sweep();
    if (e.clear && feedLines) feedLines.innerHTML = "";
  });
}

// ---- translated text laid over the screen ----------------------------------

const translationLayer = document.getElementById("translation-layer");
let translationNote = null;

function clearTranslation() {
  if (translationLayer) {
    translationLayer.innerHTML = "";
    translationLayer.classList.add("hidden");
  }
  if (translationNote) {
    translationNote.remove();
    translationNote = null;
  }
}

/**
 * Draw each translation over the text it replaces.
 *
 * The source box is a floor, not a ceiling: a translation is often longer than
 * the original (German and Finnish especially), so the block is allowed to grow
 * downward and to a sensible minimum width rather than clipping the text. It
 * stays anchored at the original's top-left so it still reads as belonging to
 * what is underneath.
 */
function showTranslation(payload) {
  if (!translationLayer || !payload?.blocks?.length) return;
  clearTranslation();

  for (const b of payload.blocks) {
    const el = document.createElement("div");
    el.className = "tr-block";
    const width = Math.max(b.w, 90);
    Object.assign(el.style, {
      left: `${b.x}px`,
      top: `${b.y}px`,
      width: `${width}px`,
      minHeight: `${Math.max(b.h, 16)}px`,
    });
    // Scale the type to the source text's height so a heading stays a heading.
    const size = Math.max(10, Math.min(22, Math.round(b.h * 0.62)));
    el.style.fontSize = `${size}px`;

    const span = document.createElement("span");
    span.textContent = b.translated;
    el.appendChild(span);
    translationLayer.appendChild(el);
  }
  translationLayer.classList.remove("hidden");

  if (payload.note) {
    translationNote = document.createElement("div");
    translationNote.id = "translation-note";
    translationNote.textContent = payload.note;
    document.body.appendChild(translationNote);
  }
}

if (window.jarvisOverlay?.on) {
  window.jarvisOverlay.on("show-translation", (e) => showTranslation(e));
}

// ---- Matrix Rain Data Stream ----------------------------------------------
const canvas = document.getElementById("matrix-rain");
const ctx = canvas?.getContext("2d");

if (canvas && ctx) {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()";
  const fontSize = 14;
  const columns = canvas.width / fontSize;
  const drops = Array.from({ length: columns }).fill(1);

  function drawMatrix() {
    if (!isAway) return; // Completely stop drawing when not in away mode
    
    ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = "#0F0"; // Default green
    ctx.font = fontSize + "px monospace";
    
    for (let i = 0; i < drops.length; i++) {
      const text = characters.charAt(Math.floor(Math.random() * characters.length));
      ctx.fillText(text, i * fontSize, drops[i] * fontSize);
      
      if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
  }

  window.addEventListener("resize", () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    drops.length = Math.ceil(canvas.width / fontSize);
    drops.fill(1);
  });
  
  setInterval(drawMatrix, 50);
}

let isAway = false;

function updateMatrixRainState() {
  if (!canvas || !ctx) return;
  if (isAway) {
    canvas.className = 'away';
    ctx.fillStyle = "#0F0"; // Classic green for away mode screensaver
  } else {
    canvas.className = '';
  }
}

// Hook into HUD away state
if (window.jarvisOverlay?.on) {
  window.jarvisOverlay.on("state", (s) => {
    if (s && s.away !== undefined) {
      isAway = s.away;
      updateMatrixRainState();
    }
  });

  // Active clones tracker
  window.jarvisOverlay.on("clones", (cloneData) => {
    const container = document.getElementById("active-clones");
    if (!container) return;
    
    if (!cloneData || cloneData.length === 0) {
      container.classList.add("hidden");
      container.innerHTML = "";
    } else {
      container.classList.remove("hidden");
      container.innerHTML = cloneData
        .map((data) => {
          // Backward compatibility in case string is passed
          if (typeof data === "string") return `<div class="clone-chip">${data}</div>`;
          return `
            <div class="clone-chip">
              <div class="clone-chip-name">${data.name}</div>
              <div class="clone-chip-progress">${data.progress || 'Working...'}</div>
            </div>
          `;
        })
        .join("");
    }
  });
}
