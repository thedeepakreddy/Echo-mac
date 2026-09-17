/*
 * Reactor-only HUD.
 *
 * There is no text UI, so state is expressed entirely through the reactor:
 * body[data-status] drives its colour and spin speed, and --level makes the
 * core breathe with your voice. Anything wordy (replies, actions, errors) is
 * spoken aloud, mirrored to the console, and kept on the hover tooltip so no
 * information is silently lost.
 */
/**
 * Page-world failure reporting.
 *
 * The preload registers the same pair, but contextIsolation means it sees a
 * different `window` — an exception thrown in this file never reaches it. A
 * renderer crash used to leave the reactor spinning with no trace anywhere.
 */
window.addEventListener("error", (e) => {
  try {
    window.jarvis?.reportError?.({
      kind: "error",
      message: String(e.message ?? e),
      stack: e.error?.stack,
      source: `hud:${e.filename ?? "?"}:${e.lineno ?? 0}`,
    });
  } catch {
    console.error("[hud] could not report error to main:", e.message ?? e);
  }
});
window.addEventListener("unhandledrejection", (e) => {
  try {
    window.jarvis?.reportError?.({
      kind: "unhandledrejection",
      message: String(e.reason?.message ?? e.reason),
      stack: e.reason?.stack,
      source: "hud",
    });
  } catch {
    console.error("[hud] could not report rejection to main:", e.reason);
  }
});

const body = document.body;
const orb = document.getElementById("orb");
const orb50 = document.getElementById("orb50");

const SKINS = ["classic", "mark50", "jarvis"];

/**
 * The render each image skin is composited from.
 *
 * One DOM block serves them all: the three stacked <img> layers are the same
 * machinery whatever the artwork, so a new reactor is a file and a line here
 * rather than a second copy of the markup and its stylesheet.
 */
const SKIN_ART = {
  mark50: { full: "../assets/reactor-mark50.png" },
  jarvis: {
    full: "../assets/reactor-jarvis.png",
    // Rings cut from the same render, so they can turn at their own rates.
    layers: {
      core: "../assets/reactor-jarvis-core.png",
      mid: "../assets/reactor-jarvis-mid.png",
      outer: "../assets/reactor-jarvis-outer.png",
    },
  },
};

/**
 * Switch which reactor is drawn.
 *
 * Both live in the DOM permanently and CSS shows one — swapping markup instead
 * would mean re-binding every listener on each change, and a missed binding
 * leaves a reactor that looks right but ignores clicks.
 */
function setSkin(skin) {
  if (!SKINS.includes(skin)) return;
  body.dataset.skin = skin;
  // [hidden] is kept in sync for assistive tech; CSS owns the actual display.
  const art = SKIN_ART[skin];
  if (orb) orb.hidden = skin !== "classic";
  if (orb50) {
    orb50.hidden = !art;
    if (art) {
      // The flat render drives the artwork and both bloom copies; the glow has
      // to come from the whole reactor, not from one ring of it.
      for (const img of orb50.querySelectorAll(".m50-art, .m50-bloom, .m50-bloom-wide")) {
        img.src = art.full;
      }
      for (const [ring, src] of Object.entries(art.layers ?? {})) {
        const el = orb50.querySelector(".m50-l-" + ring);
        if (el) el.src = src;
      }
      // The light pass is the outer ring again, so it lights exactly the
      // segments that are there rather than an approximation of them.
      const sweep = orb50.querySelector(".m50-l-sweep");
      if (sweep) sweep.src = art.layers?.outer ?? art.full;
    }
  }
}

const LONG_PRESS_MS = 500;

const STATUS_LABEL = {
  idle: "ready",
  listening: "listening…",
  thinking: "thinking…",
  acting: "taking action…",
  speaking: "speaking…",
  error: "error",
};

let hint = "Click the core to talk · long-press for controls · right-click to stop";
let lastLine = "";

/** Whichever reactor the current skin is showing. */
function activeOrb() {
  // Every image skin is drawn by the same element, so this asks whether the
  // current skin has artwork rather than naming one. Naming one meant a new
  // skin silently bound its clicks and drag to the hidden classic reactor.
  return SKIN_ART[body.dataset.skin] ? orb50 : orb;
}

function refreshTooltip(status) {
  const label = (STATUS_LABEL[status] ?? status ?? "") + (body.dataset.session ? " · in conversation" : "");
  const text = [label && `[${label}]`, lastLine, hint].filter(Boolean).join("\n");
  // Set on both, so the tooltip is already right the moment a skin is swapped.
  if (orb) orb.title = text;
  if (orb50) orb50.title = text;
  // The hit patch sits ON TOP of the reactor, so its own title is the one that
  // actually shows on hover — without this it would keep its static markup text
  // and never report the live status.
  const hit = orb50?.querySelector(".m50-hit");
  if (hit) hit.title = text;
}

function setStatus(status) {
  if (!status || body.dataset.status === status) return;

  // Trigger sci-fi glitch effect on transition
  const el = activeOrb();
  if (el) {
    el.classList.remove('glitch');
    void el.offsetWidth; // Trigger reflow
    el.classList.add('glitch');
  }

  body.dataset.status = status;
  refreshTooltip(status);
}

/** Keep the newest line on the tooltip and in the console. */
function note(kind, text) {
  if (!text) return;
  lastLine = `${kind}: ${text}`.slice(0, 300);
  console.log(`[jarvis] ${lastLine}`);
  refreshTooltip(body.dataset.status);
}

// ---- bridge ----
if (window.jarvis) {
  window.jarvis.onState((s) => {
    if (s.status) setStatus(s.status);
    if (s.skin) setSkin(s.skin);
    // Away mode: the reactor idles dim while you are gone, so a glance across
    // the room tells you Jarvis is watching but you are not there.
    if (s.awayMode !== undefined) {
      body.dataset.awayMode = s.awayMode ? "on" : "off";
      if (!s.awayMode) delete body.dataset.away;
    }
    if (s.away !== undefined) {
      if (s.away) body.dataset.away = "yes";
      else delete body.dataset.away;
      refreshTooltip(body.dataset.status);
    }
    // The name was just heard: one bright pulse, at once — before any
    // transcription, before the chirp finishes. This is the "I heard you".
    if (s.wake) {
      const el = activeOrb();
      if (el) {
        el.classList.remove("wake");
        void el.offsetWidth;
        el.classList.add("wake");
        setTimeout(() => el.classList.remove("wake"), 700);
      }
    }
    // Words as they are recognised, while you are still talking.
    if (s.hearing !== undefined) note("hearing", s.hearing);
    // Conversation window: Echo keeps listening without the name.
    if (s.session !== undefined) {
      if (s.session) body.dataset.session = "open";
      else delete body.dataset.session;
      refreshTooltip(body.dataset.status);
    }
    if (s.wakeEnabled !== undefined) {
      hint = s.wakeEnabled
        ? 'Say "Echo" · click the core · long-press for controls'
        : "Click the core to talk · long-press for controls · ⌘⇧J";
      refreshTooltip(body.dataset.status);
    }
  });

  window.jarvis.onMessage((m) => note(m.kind, m.text));

  window.jarvis.onLevel((n) => {
    document.documentElement.style.setProperty("--level", String(n ?? 0));
  });

  window.jarvis.onNotice((n) => {
    note(n.level || "notice", n.text);
    if (n.level === "error") setStatus("error");
  });
}

// ---- interaction ----
/**
 * window.jarvis comes from the preload script. If that ever fails to load the
 * reactor would look alive while doing nothing, so go red instead.
 */
function bridge() {
  if (!window.jarvis) {
    note("error", "UI bridge failed to load. Quit, then: npm run build && npm start");
    setStatus("error");
    return null;
  }
  return window.jarvis;
}

// ---- reactor press handling ----
// Short click talks; a long press opens the control panel. The click event still
// fires after a long press, so it has to be swallowed or Jarvis would start
// listening every time you opened the panel.
let pressTimer = null;
let longPressFired = false;

const cancelPress = () => clearTimeout(pressTimer);

/**
 * Give a reactor its behaviour. Applied to every skin, so switching skins can
 * never leave one that looks alive but ignores clicks.
 */
function bindReactor(el) {
  if (!el) return;

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    longPressFired = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      longPressFired = true;
      bridge()?.openControlPanel();
    }, LONG_PRESS_MS);
  });

  el.addEventListener("pointerup", cancelPress);
  el.addEventListener("pointerleave", cancelPress);
  el.addEventListener("pointercancel", cancelPress);

  el.addEventListener("click", () => {
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    bridge()?.listen();
  });

  // Right-click the reactor to stop Echo mid-task (the old stop button).
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    bridge()?.interrupt();
  });
}

bindReactor(orb);
bindReactor(orb50);

// Default until main reports the saved skin, so the HUD is never blank.
setSkin("classic");
setStatus("idle");

// The Mark 50 skin needs its render present. Say so clearly rather than
// showing an empty glow and leaving the cause a mystery.
if (orb50) {
  orb50.querySelectorAll("img").forEach((img) => {
    img.addEventListener("error", () => {
      note(
        "error",
        "Mark 50 render missing — save it as assets/reactor-mark50.png (transparent PNG)."
      );
    });
  });
}

if (!window.jarvis) {
  note("error", "UI bridge failed to load — Jarvis cannot receive input.");
  setStatus("error");
}

// ---- Sci-Fi Parallax Effect ----
document.addEventListener("mousemove", (e) => {
  const orb = activeOrb();
  if (!orb) return;
  const rect = orb.getBoundingClientRect();
  const orbX = rect.left + rect.width / 2;
  const orbY = rect.top + rect.height / 2;
  
  const deltaX = e.clientX - orbX;
  const deltaY = e.clientY - orbY;
  
  const maxTilt = 12; // Degrees
  const tiltX = Math.max(-maxTilt, Math.min(maxTilt, (deltaY / (rect.height / 2)) * -maxTilt));
  const tiltY = Math.max(-maxTilt, Math.min(maxTilt, (deltaX / (rect.width / 2)) * maxTilt));
  
  // Only apply tilt if mouse is nearby to keep it subtle
  const dist = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  if (dist < 250 && !orb.classList.contains('glitch')) {
    const factor = Math.max(0, 1 - dist / 250);
    orb.style.transform = `rotateX(${tiltX * factor}deg) rotateY(${tiltY * factor}deg) scale(1.02)`;
  } else {
    orb.style.transform = `rotateX(0deg) rotateY(0deg) scale(1)`;
  }
});
