/*
 * Reactor-only HUD.
 *
 * There is no text UI, so state is expressed entirely through the reactor:
 * body[data-status] drives its colour and spin speed, and --level makes the
 * core breathe with your voice. Anything wordy (replies, actions, errors) is
 * spoken aloud, mirrored to the console, and kept on the hover tooltip so no
 * information is silently lost.
 */
const body = document.body;
const orb = document.getElementById("orb");
const chat = document.getElementById("chat");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");

const LONG_PRESS_MS = 500;

const STATUS_LABEL = {
  idle: "ready",
  listening: "listening…",
  thinking: "thinking…",
  acting: "taking action…",
  speaking: "speaking…",
  error: "error",
};

let hint = "Click the core to talk · long-press to type · right-click to stop";
let lastLine = "";

function refreshTooltip(status) {
  const label = STATUS_LABEL[status] ?? status ?? "";
  orb.title = [label && `[${label}]`, lastLine, hint].filter(Boolean).join("\n");
}

function setStatus(status) {
  if (!status || body.dataset.status === status) return;
  
  // Trigger sci-fi glitch effect on transition
  orb.classList.remove('glitch');
  void orb.offsetWidth; // Trigger reflow
  orb.classList.add('glitch');

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
    if (s.wakeEnabled !== undefined) {
      hint = s.wakeEnabled
        ? 'Say "Echo" · click the core · long-press to type'
        : "Click the core to talk · long-press to type · ⌘⇧J";
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

// ---- chat box ----
/** Show/hide the composer and ask main to grow/shrink the window to match. */
function openChat(open) {
  chat.hidden = !open;
  // Called directly (not via bridge()) so merely opening the box can't raise
  // a bridge error — that only matters when there's something to send.
  window.jarvis?.setChatOpen(open);
  if (open) setTimeout(() => input.focus(), 60);
  else input.blur();
}

function sendText() {
  const text = input.value.trim();
  if (!text) return;
  const b = bridge();
  if (!b) return; // leave the text in place so it isn't lost
  b.sendText(text);
  input.value = "";
}

sendBtn.addEventListener("click", sendText);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendText();
  else if (e.key === "Escape") openChat(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !chat.hidden) openChat(false);
});

// ---- reactor press handling ----
// Short click talks; a long press opens the chat box. The click event still
// fires after a long press, so it has to be swallowed or Jarvis would start
// listening every time you opened the composer.
let pressTimer = null;
let longPressFired = false;

orb.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  longPressFired = false;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    longPressFired = true;
    openChat(chat.hidden);
  }, LONG_PRESS_MS);
});

const cancelPress = () => clearTimeout(pressTimer);
orb.addEventListener("pointerup", cancelPress);
orb.addEventListener("pointerleave", cancelPress);
orb.addEventListener("pointercancel", cancelPress);

orb.addEventListener("click", () => {
  if (longPressFired) {
    longPressFired = false;
    return;
  }
  bridge()?.listen();
});

// Right-click the reactor to stop Jarvis mid-task (the old stop button).
orb.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  bridge()?.interrupt();
});

setStatus("idle");

if (!window.jarvis) {
  note("error", "UI bridge failed to load — Jarvis cannot receive input.");
  setStatus("error");
}

// ---- Sci-Fi Parallax Effect ----
document.addEventListener("mousemove", (e) => {
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
