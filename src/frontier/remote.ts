import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import {
  SessionStore, sessionFrom, verifyPassword, hasPassword, getStableToken,
} from "./remoteauth.js";
import {
  Signalling, ConfirmRelay, normaliseCommand, type Sdp, type IceCandidate,
} from "./remotesignal.js";
import { moveMouse, getMousePosition, click } from "../tools/computer-actions.js";

/**
 * Watching a long job from your phone.
 *
 * A refactor running on the Mac is a job you cannot watch, and a job you cannot
 * watch is a job you cannot trust. The action feed already exists as a stream
 * of events; this puts it somewhere you can see from the sofa.
 *
 * The security thinking matters more than the feature. This opens a port on
 * whatever network the machine is on — which may be a cafe, an airport, or an
 * office full of strangers — so the assumptions are:
 *
 *   - OFF by default, and started only when asked. It is not a background
 *     service; it exists for the duration of a job you are watching.
 *   - A long random token is required on EVERY request. Without one the server
 *     answers 404, not 401: a 401 confirms something is listening, which is
 *     information a scanner should not get for free.
 *   - The token is new every time it starts. A link you showed someone once
 *     does not work tomorrow.
 *   - It can show you things and STOP things. It cannot start anything, type
 *     anything, or approve anything. Approving a destructive action should
 *     take a deliberate act at the machine itself, not a tap on a phone that
 *     might be in someone else's hand.
 *   - It expires on its own, so forgetting to turn it off is not a permanent
 *     hole in the network.
 */

export interface FeedItem {
  at: number;
  line: string;
  kind: string;
}

/** Events kept for the phone to catch up on. */
export const MAX_ITEMS = 200;
/** Shut down on its own after this long. Long, since the link is meant to be
 *  saved and reused; a forgotten-open port on a private tailnet behind a
 *  password is a small risk, and the whole point is that it stays reachable. */
export const DEFAULT_TTL_MS = 12 * 3600_000;
/** Wrong tokens from one address before it stops answering that address. */
export const MAX_BAD_ATTEMPTS = 5;

export function newToken(): string {
  // 32 hex characters. Long enough that guessing is not a strategy, short
  // enough to type from a screen if the QR code will not scan.
  return randomBytes(16).toString("hex");
}

/**
 * Compare tokens without leaking their contents through timing.
 *
 * `a === b` on a secret returns as soon as it finds a differing character, so
 * how long it takes reveals how much of the prefix was right. That is a real
 * attack against something reachable over a network.
 */
export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  // timingSafeEqual throws on a length mismatch, which is itself a leak — but
  // only of the length, which is fixed and public here.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the token out of a request URL. */
export function tokenFrom(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const q = url.indexOf("?");
  if (q < 0) return undefined;
  const params = new URLSearchParams(url.slice(q + 1));
  return params.get("t") ?? undefined;
}

export type Route =
  | "page"
  | "events"
  | "stop"
  | "login"
  | "command"
  | "confirm"
  | "confirm-poll"
  | "rtc-offer"
  | "rtc-answer"
  | "rtc-ice-phone"
  | "rtc-ice-mac"
  | "voice"
  | "mouse"
  | "log"
  | "unknown";

export function routeOf(url: string | undefined): Route {
  const path = (url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
  if (path === "/") return "page";
  if (path === "/events") return "events";
  if (path === "/stop") return "stop";
  if (path === "/login") return "login";
  if (path === "/command") return "command";
  if (path === "/confirm") return "confirm"; // phone POSTs an answer
  if (path === "/pending") return "confirm-poll"; // phone GETs the current question
  if (path === "/rtc/offer") return "rtc-offer"; // phone POSTs its SDP offer
  if (path === "/rtc/answer") return "rtc-answer"; // phone GETs the Mac's answer + ICE
  if (path === "/rtc/ice") return "rtc-ice-phone"; // phone POSTs a candidate
  if (path === "/rtc/ice-mac") return "rtc-ice-mac"; // phone GETs the Mac's candidates
  if (path === "/voice") return "voice"; // phone POSTs raw wav audio
  if (path === "/mouse") return "mouse"; // phone POSTs mouse events
  if (path === "/log") return "log"; // phone POSTs client logs
  return "unknown";
}

/**
 * A Tailscale address on this machine, if it is on a tailnet.
 *
 * Tailscale hands every device an address in the 100.64.0.0/10 range (the
 * carrier-grade NAT block it borrows for the purpose). Preferring it over the
 * ordinary LAN address is what makes the remote reachable from anywhere: the
 * phone and the Mac are on the same private, encrypted tailnet even when they
 * are on opposite sides of the world, and nothing is ever exposed to the public
 * internet.
 */
export function tailscaleAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [o1, o2] = a.address.split(".").map(Number);
      // 100.64.0.0 – 100.127.255.255
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return null;
}

export type HostKind = "tailscale" | "lan";

/**
 * The address to hand the phone, preferring the tailnet.
 *
 * Tailscale first, because it works from anywhere; the LAN address is the
 * fallback for when you are on the same Wi-Fi and have not set Tailscale up.
 */
export function preferredHost(): { host: string; kind: HostKind } | null {
  const ts = tailscaleAddress();
  if (ts) return { host: ts, kind: "tailscale" };
  const lan = lanAddress();
  if (lan) return { host: lan, kind: "lan" };
  return null;
}

// ---- what the phone is shown ---------------------------------------------

const items: FeedItem[] = [];
let running = false;
let startedAt = 0;
let token = "";
let server: any = null;
let expiry: NodeJS.Timeout | null = null;
let onStop: (() => void) | null = null;
const badAttempts = new Map<string, number>();

// The three relays that make full remote control work, shared between the HTTP
// server (which talks to the phone) and the Electron side (which owns the
// WebRTC peer and the brain). Created once; reset when the remote restarts.
const sessions = new SessionStore();
const signalling = new Signalling();
const confirmRelay = new ConfirmRelay();

/** What to do with a command the phone sends. Set by the process that owns the brain. */
let commandHandler: ((text: string, via: "typed" | "voice") => void) | null = null;
export function setCommandHandler(fn: (text: string, via: "typed" | "voice") => void) {
  commandHandler = fn;
}

/** The Mac side (main process) reaches the WebRTC mailbox and the confirm relay through these. */
export function macSignalling(): Signalling {
  return signalling;
}
export function macConfirmRelay(): ConfirmRelay {
  return confirmRelay;
}
/** True while a phone has a live session — so confirmations know to also ask it. */
export function hasLiveSession(): boolean {
  return sessions.count() > 0;
}

/** Record something for the phone to see. */
export function record(line: string, kind = "") {
  if (!running || !line) return;
  items.push({ at: Date.now(), line, kind });
  // A ring buffer: a long job would otherwise grow this without limit.
  if (items.length > MAX_ITEMS) items.splice(0, items.length - MAX_ITEMS);
}

export function recentItems(sinceIndex = 0): { items: FeedItem[]; nextIndex: number } {
  const from = Math.max(0, Math.min(sinceIndex, items.length));
  return { items: items.slice(from), nextIndex: items.length };
}

export function isRunning(): boolean {
  return running;
}

/** The address to open on the phone, or null when not running. */
export function remoteUrl(port: number): string | null {
  if (!running) return null;
  const pref = preferredHost();
  return pref ? `http://${pref.host}:${port}/?t=${token}` : null;
}

/**
 * This machine's address on the local network.
 *
 * Explicitly not the loopback address — the whole point is reaching it from
 * another device, and a link to 127.0.0.1 would work perfectly on the Mac and
 * fail silently on the phone, which is the most confusing possible outcome.
 */
export function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

/** Has this address failed too many times to keep answering? */
export function isLockedOut(ip: string): boolean {
  return (badAttempts.get(ip) ?? 0) >= MAX_BAD_ATTEMPTS;
}

export function noteBadAttempt(ip: string): void {
  badAttempts.set(ip, (badAttempts.get(ip) ?? 0) + 1);
}

export function resetAttempts(): void {
  badAttempts.clear();
}

/**
 * The whole phone app, in one self-contained page.
 *
 * Login first, then a live view of the Mac's screen over WebRTC, a push-to-talk
 * mic, a box to send commands, the action feed, and — because the phone has
 * full control — Approve / Deny buttons for anything irreversible Jarvis is
 * about to do. No external anything: the WebRTC uses only host candidates,
 * which is all that is needed over Tailscale or a shared LAN.
 */
export function renderPage(tok: string): string {
  const T = JSON.stringify(tok);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>Echo</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #000000;
    --surface: rgba(28, 28, 30, 0.7);
    --surface-solid: #1c1c1e;
    --text: #ffffff;
    --text-dim: #98989d;
    --accent: #0a84ff;
    --danger: #ff453a;
    --border: rgba(255, 255, 255, 0.15);
    --font: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; width: 100%; overflow: hidden; touch-action: pan-y; margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 15px/1.4 var(--font);
    display: flex; flex-direction: column;
    padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
  }
  
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadein { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

  button {
    font-family: var(--font); font-size: 15px; font-weight: 600;
    border-radius: 14px; border: none;
    background: var(--accent); color: #fff;
    padding: 14px 20px; cursor: pointer;
    transition: transform 0.15s, opacity 0.15s;
  }
  button:active { transform: scale(0.96); opacity: 0.8; }
  .danger { background: var(--danger); }
  .secondary { background: var(--surface-solid); border: 1px solid var(--border); color: var(--text); }
  
  #login { 
    display: flex; flex-direction: column; justify-content: space-between; 
    height: 100%; padding: 40px 24px; animation: fadein 0.6s ease-out; 
  }
  .login-top { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .login-top .mark { width: 80px; height: 80px; margin-bottom: 24px; position: relative; }
  .login-top .mark svg { width: 100%; height: 100%; }
  .login-top .mark .ring { animation: spin 8s linear infinite; transform-origin: 50% 50%; }
  .login-top h2 { font-size: 34px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.02em; }
  .login-top p { font-size: 16px; color: var(--text-dim); margin: 0; }
  .login-bottom { width: 100%; max-width: 400px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
  #login input {
    width: 100%; padding: 18px; font-size: 17px; font-family: var(--font);
    border-radius: 14px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); text-align: center;
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  }
  #login input:focus { outline: none; border-color: var(--accent); }
  #err { color: var(--danger); text-align: center; font-size: 13px; height: 16px; }

  #app { display: none; flex-direction: column; height: 100%; animation: fadein 0.5s ease-out; }
  header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 20px; border-bottom: 1px solid var(--border);
    background: rgba(0,0,0,0.6); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    z-index: 10;
  }
  .header-left { display: flex; align-items: center; gap: 10px; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  header h1 { font-size: 17px; font-weight: 600; margin: 0; letter-spacing: -0.02em; }
  header button { padding: 8px 16px; font-size: 13px; border-radius: 20px; }

  #stage {
    position: relative; background: #000; aspect-ratio: 16/10;
    margin: 16px; border-radius: 16px; overflow: hidden;
    border: 1px solid var(--border);
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    flex-shrink: 0;
  }
  #screen { width: 100%; height: 100%; object-fit: contain; }
  #novid { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-dim); }

  #mouse-pad {
    display: flex; align-items: center; justify-content: space-between;
    margin: 0 16px 16px; padding: 20px;
    background: var(--surface); border-radius: 20px; border: 1px solid var(--border);
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    flex-shrink: 0;
  }
  .dpad {
    display: grid; grid-template-columns: repeat(3, 44px); grid-template-rows: repeat(3, 44px); gap: 6px;
  }
  .dbtn {
    background: var(--surface-solid); border: 1px solid var(--border); border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    color: var(--text); font-size: 20px; cursor: pointer; transition: 0.1s;
    user-select: none; -webkit-user-select: none;
  }
  .dbtn:active { background: var(--accent); transform: scale(0.92); }
  .dbtn.up { grid-column: 2; grid-row: 1; }
  .dbtn.left { grid-column: 1; grid-row: 2; }
  .dbtn.down { grid-column: 2; grid-row: 3; }
  .dbtn.right { grid-column: 3; grid-row: 2; }
  
  .click-pad {
    display: flex; flex-direction: column; gap: 12px; align-items: stretch; flex: 1; margin-left: 24px;
  }
  .click-btn {
    background: var(--surface-solid); border: 1px solid var(--border); border-radius: 14px;
    padding: 14px; font-weight: 500; text-align: center; color: var(--text);
    user-select: none; -webkit-user-select: none;
  }
  .click-btn:active { background: var(--accent); transform: scale(0.96); }

  #feed-wrap { flex: 1; overflow-y: auto; padding: 0 16px; position: relative; }
  ol { list-style: none; margin: 0; padding: 0 0 20px; }
  li {
    padding: 12px 16px; margin-bottom: 8px; border-radius: 14px;
    background: rgba(255,255,255,0.05); border: 1px solid transparent;
    display: flex; flex-direction: column; gap: 4px;
  }
  li.user { background: rgba(10, 132, 255, 0.1); border-color: rgba(10, 132, 255, 0.2); }
  li.stop { border-color: rgba(255, 69, 58, 0.3); }
  li span { color: var(--text-dim); font-size: 14px; }
  li.user span { color: var(--text); }
  time { color: var(--text-dim); font-size: 11px; align-self: flex-end; }
  #empty { text-align: center; color: var(--text-dim); font-size: 13px; margin-top: 40px; }

  #cmdform {
    padding: 12px 16px 24px;
    background: rgba(28, 28, 30, 0.85); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    border-top: 1px solid var(--border);
    display: flex; gap: 10px; flex-shrink: 0;
  }
  #cmd {
    flex: 1; padding: 14px 18px; font-size: 15px; font-family: var(--font);
    border-radius: 20px; border: 1px solid var(--border);
    background: #000; color: var(--text);
  }
  #cmd:focus { outline: none; border-color: var(--accent); }
  #cmdform button { flex: none; border-radius: 20px; padding: 14px 22px; }

  #confirm {
    display: none; position: absolute; bottom: 90px; left: 16px; right: 16px; z-index: 20;
    padding: 20px; border-radius: 16px; background: rgba(44, 44, 46, 0.95);
    backdrop-filter: blur(30px); -webkit-backdrop-filter: blur(30px);
    border: 1px solid rgba(255,255,255,0.2); box-shadow: 0 10px 40px rgba(0,0,0,0.5);
  }
  #confirm p { margin: 0 0 16px; font-weight: 500; font-size: 15px; }
  .row { display: flex; gap: 12px; }
  .row button { flex: 1; }
</style>
</head>
<body>

<div id="login">
  <div class="login-top">
    <div class="mark">
      <svg viewBox="0 0 60 60" fill="none">
        <circle cx="30" cy="30" r="28" style="stroke:rgba(255,255,255,0.15)" stroke-width="1.5"/>
        <g class="ring"><circle cx="30" cy="30" r="22" style="stroke:var(--accent)" stroke-width="2" stroke-dasharray="1.5 8" opacity="0.8"/></g>
        <circle cx="30" cy="30" r="13" style="stroke:var(--accent)" stroke-width="1.5" opacity="0.6"/>
        <circle cx="30" cy="30" r="4.5" style="fill:var(--text)"/>
      </svg>
    </div>
    <h2>Echo</h2>
    <p>Remote Access</p>
  </div>
  <div class="login-bottom">
    <div id="err"></div>
    <input id="pw" type="password" placeholder="Enter Password" autocomplete="current-password" enterkeyhint="go">
    <button id="signin">Log In</button>
  </div>
</div>

<div id="app">
  <header>
    <div class="header-left">
      <span id="dot"></span>
      <h1>Echo</h1>
    </div>
    <button id="talk" class="secondary">Hold to Talk</button>
  </header>

  <div id="stage">
    <video id="screen" autoplay playsinline muted></video>
    <div id="novid">Connecting to screen...</div>
  </div>
  <audio id="macaudio" autoplay></audio>

  <div id="mouse-pad">
    <div class="dpad">
      <div class="dbtn up" onmousedown="m('up')" ontouchstart="event.preventDefault(); m('up')">↑</div>
      <div class="dbtn left" onmousedown="m('left')" ontouchstart="event.preventDefault(); m('left')">←</div>
      <div class="dbtn down" onmousedown="m('down')" ontouchstart="event.preventDefault(); m('down')">↓</div>
      <div class="dbtn right" onmousedown="m('right')" ontouchstart="event.preventDefault(); m('right')">→</div>
    </div>
    <div class="click-pad">
      <div class="click-btn" onmousedown="m('click')" ontouchstart="event.preventDefault(); m('click')">Left Click</div>
      <div class="click-btn" onmousedown="m('rclick')" ontouchstart="event.preventDefault(); m('rclick')">Right Click</div>
      <button id="stop" class="danger" style="margin-top: 4px;">Stop</button>
    </div>
  </div>

  <div id="confirm">
    <p id="ctext"></p>
    <div class="row">
      <button id="deny" class="secondary">Deny</button>
      <button id="approve">Approve</button>
    </div>
  </div>

  <div id="feed-wrap">
    <ol id="feed"></ol>
    <div id="empty">No activity yet.</div>
  </div>

  <form id="cmdform">
    <input id="cmd" placeholder="Message Echo..." enterkeyhint="send">
    <button type="submit">Send</button>
  </form>
</div>

<script>
(function(){
  var T = ${T};
  var sess = localStorage.getItem('js_sess') || '';
  var q = function(id){ return document.getElementById(id); };
  var u = function(path){ return path + (path.indexOf('?')<0?'?':'&') + 't=' + T + (sess ? '&s=' + sess : ''); };
  var time = function(ms){ return new Date(ms).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); };
  window.onerror = function(msg, url, line, col, error) {
    fetch(u('/log'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg: msg, line: line, col: col }) }).catch(function(){});
  };

  window.m = function(action) {
    fetch(u('/mouse'), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({action:action}) }).catch(function(){});
  };

  q('signin').onclick = signin;
  q('pw').addEventListener('keydown', function(e){ if(e.key==='Enter') signin(); });
  function signin(){
    var pw = q('pw').value;
    q('err').textContent = '';
    fetch(u('/login'), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({password:pw}) })
      .then(function(r){ if(r.ok) return r.json(); throw r.status; })
      .then(function(d){
        sess = d.s || '';
        localStorage.setItem('js_sess', sess);
        q('login').style.display='none';
        q('app').style.display='flex';
        start();
      })
      .catch(function(s){ q('err').textContent = s===401 ? 'Wrong password.' : 'Could not sign in.'; });
  }

  var feed, empty, next=0, pc=null, micTrack=null, connected=false;
  function start(){
    feed = q('feed'); empty = q('empty');
    q('stop').onclick = function(e){ e.preventDefault(); fetch(u('/stop'), {method:'POST'}).catch(function(){}); };
    q('cmdform').onsubmit = function(e){ e.preventDefault(); sendCommand(); };
    setupTalk();
    connectRTC();
    pollEvents();
    setInterval(pollEvents, 1500);
    pollConfirm();
    setInterval(pollConfirm, 1200);
    fetch(u('/log'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg: 'Phone UI started successfully', line: 0, col: 0 }) }).catch(function(){});
  }

  function sendCommand(){
    var box = q('cmd');
    var text = box.value.trim();
    if(!text) return;
    box.value='';
    fetch(u('/command'), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({text:text, via:'typed'}) }).catch(function(){});
  }

  function setupTalk(){
    var btn = q('talk');
    if (!btn) return;
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var recognition = SR ? new SR() : null;
    var finalTranscript = '';
    if (recognition) {
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = function(event) {
        finalTranscript = '';
        for (var i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
        }
      };
      recognition.onend = function() {
        if (finalTranscript.trim()) {
          var text = finalTranscript.trim();
          fetch(u('/command'), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({text:text, via:'voice'}) }).catch(function(){});
        }
        finalTranscript = '';
      };
    }
    var audioCtx = null, mediaStream = null, scriptNode = null, pcmData = [];
    var press = function(on){
      if (recognition) {
        if (on) { finalTranscript = ''; try { recognition.start(); } catch(e){} }
        else { try { recognition.stop(); } catch(e){} }
      } else {
        if(on) {
          navigator.mediaDevices.getUserMedia({ audio:true, video:false }).then(function(stream){
            mediaStream = stream;
            audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            var source = audioCtx.createMediaStreamSource(stream);
            scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
            scriptNode.onaudioprocess = function(e){ pcmData.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
            source.connect(scriptNode);
            scriptNode.connect(audioCtx.destination);
          }).catch(function(){});
        } else if (scriptNode) {
          scriptNode.disconnect();
          mediaStream.getTracks().forEach(function(t){ t.stop(); });
          var length = 0;
          for (var p=0; p<pcmData.length; p++) length += pcmData[p].length;
          var wavBuffer = new Int16Array(length);
          var offset = 0;
          for (var p=0; p<pcmData.length; p++) {
            for (var i = 0; i < pcmData[p].length; i++) {
              var s = Math.max(-1, Math.min(1, pcmData[p][i]));
              wavBuffer[offset++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
          }
          pcmData = [];
          var buffer = new ArrayBuffer(44 + wavBuffer.length * 2);
          var view = new DataView(buffer);
          var ws = function(v, o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
          ws(view, 0, 'RIFF'); view.setUint32(4, 36 + wavBuffer.length * 2, true); ws(view, 8, 'WAVE');
          ws(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
          view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
          ws(view, 36, 'data'); view.setUint32(40, wavBuffer.length * 2, true);
          var dataOffset = 44;
          for (var i = 0; i < wavBuffer.length; i++, dataOffset+=2) view.setInt16(dataOffset, wavBuffer[i], true);
          fetch(u('/voice'), { method: "POST", body: buffer }).catch(function(){});
          scriptNode = null;
        }
      }
      btn.style.opacity = on ? '0.6' : '1';
      btn.textContent = on ? (recognition ? 'Listening…' : 'Recording…') : 'Hold to Talk';
    };
    btn.addEventListener('touchstart', function(e){ e.preventDefault(); press(true); }, {passive:false});
    btn.addEventListener('touchend', function(e){ e.preventDefault(); press(false); }, {passive:false});
    btn.addEventListener('mousedown', function(){ press(true); });
    btn.addEventListener('mouseup', function(){ press(false); });
    btn.addEventListener('mouseleave', function(){ press(false); });
  }

  function connectRTC(){
    pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.ontrack = function(ev){
      var stream = ev.streams[0];
      if(ev.track.kind === 'video'){ q('screen').srcObject = stream; q('novid').style.display='none'; }
      else { q('macaudio').srcObject = stream; }
    };
    pc.onicecandidate = function(ev){
      if(ev.candidate){ fetch(u('/rtc/ice'), {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({candidate:ev.candidate})}).catch(function(){}); }
    };
    pc.onconnectionstatechange = function(){
      connected = pc.connectionState === 'connected';
      if(pc.connectionState === 'failed'){ setTimeout(connectRTC, 2000); }
    };
    pc.addTransceiver('audio', {direction:'recvonly'});
    pc.addTransceiver('video', {direction:'recvonly'});
    negotiate();
  }

  function negotiate(){
    pc.createOffer().then(function(offer){ return pc.setLocalDescription(offer); }).then(function(){
      return fetch(u('/rtc/offer'), {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({sdp:{type:pc.localDescription.type, sdp:pc.localDescription.sdp}})});
    }).then(function(){ pollAnswer(); }).catch(function(){});
  }

  var answered = false;
  function pollAnswer(){
    fetch(u('/rtc/answer')).then(function(r){ return r.json(); }).then(function(d){
      if(d.answer && !answered){ answered = true; pc.setRemoteDescription(d.answer); }
      if(d.ice && d.ice.length){ d.ice.forEach(function(c){ pc.addIceCandidate(c).catch(function(){}); }); }
      if(!connected) setTimeout(pollAnswer, 1000);
    }).catch(function(){ if(!connected) setTimeout(pollAnswer, 1000); });
  }

  function pollEvents(){
    fetch(u('/events?since='+next)).then(function(r){
      if(r.status === 401) { localStorage.removeItem('js_sess'); location.reload(); }
      return r.json();
    }).then(function(d){
      if(!d || !d.items) return;
      next = d.nextIndex;
      d.items.forEach(function(it){
        var li = document.createElement('li');
        var isUser = String(it.line || '').indexOf('You (phone)') === 0;
        li.className = (it.kind === 'stop' ? 'stop' : (it.kind === 'go' ? 'go' : (isUser ? 'user' : '')));
        // Scaffold with a fixed literal, then set the text with textContent so a
        // filename or a message on screen can never inject markup into the phone.
        li.innerHTML = '<time></time><span></span>';
        li.querySelector('time').textContent = time(it.at);
        li.querySelector('span').textContent = it.line;
        feed.appendChild(li);
        empty.style.display='none';
        q('feed-wrap').scrollTop = feed.scrollHeight;
      });
    }).catch(function(){});
  }

  function pollConfirm(){
    // Poll /pending for the question to SHOW; POST the answer to /confirm.
    // (These are two different routes: earlier the client polled /confirm, which
    // only accepts POST, so prompts never appeared and Approve never registered.)
    fetch(u('/pending')).then(function(r){ return r.json(); }).then(function(d){
      var box = q('confirm');
      var c = d && d.pending;
      if (!c || !c.id) { box.style.display='none'; return; }
      box.style.display='block';
      q('ctext').textContent = c.prompt;
      var act = function(approved){ fetch(u('/confirm'), {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({id:c.id, approved:approved})}).then(function(){ box.style.display='none'; }).catch(function(){}); };
      q('approve').onclick = function(){ act(true); };
      q('deny').onclick = function(){ act(false); };
    }).catch(function(){});
  }

  function escape(t){ return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  
  if (sess) {
    q('login').style.display = 'none';
    q('app').style.display = 'flex';
    start();
  }
})();
</script>
</body>
</html>`;
}

// ---- the server -----------------------------------------------------------

export interface StartResult {
  ok: boolean;
  url?: string;
  message: string;
}

/**
 * What "stop" does.
 *
 * Registered once at startup by the process that owns the brain. The tool that
 * opens the remote has no handle on it, and threading one through would mean
 * the registry holding a reference to the running agent — which is exactly the
 * coupling the tool layer avoids everywhere else.
 */
let interruptHandler: (() => void) | null = null;

export function setInterruptHandler(fn: () => void) {
  interruptHandler = fn;
}

/** Read a JSON request body, capped so a flood cannot exhaust memory. */
function readJsonBody(req: any, cb: (body: any | null) => void): void {
  let data = "";
  let aborted = false;
  req.on("data", (chunk: any) => {
    data += chunk;
    if (data.length > 256 * 1024) {
      aborted = true;
      req.destroy();
    }
  });
  req.on("end", () => {
    console.log(`[jarvis] readJsonBody received payload of length ${data.length}`);
    if (aborted) return cb(null);
    if (!data) return cb({});
    try {
      cb(JSON.parse(data));
    } catch (e) {
      console.log(`[jarvis] readJsonBody JSON parse failed:`, e);
      cb(null);
    }
  });
  req.on("error", () => cb(null));
}

export async function startRemote(opts: {
  port?: number;
  ttlMs?: number;
  onStop?: () => void;
} = {}): Promise<StartResult> {
  if (running) {
    return { ok: true, url: remoteUrl(currentPort) ?? undefined, message: "The remote is already running." };
  }
  const pref = preferredHost();
  if (!pref) {
    return { ok: false, message: "I can't find a network address — is this machine on Wi-Fi or Tailscale?" };
  }
  // Full control from a phone with no password is a door with no lock. Refuse.
  if (!hasPassword()) {
    return {
      ok: false,
      message: "Set a remote password first — I won't open control of the machine without one.",
    };
  }

  const http = await import("node:http");

  const port = opts.port ?? 7717;
  // The SAME token every time, so the link can be saved on the phone once and
  // reused forever. The password is what actually guards control.
  token = getStableToken();
  onStop = opts.onStop ?? null;
  items.length = 0;
  resetAttempts();
  sessions.revokeAll(); // a restart re-authenticates everyone
  signalling.reset();
  confirmRelay.cancel();

  server = http.createServer((req: any, res: any) => {
    const ip = req.socket?.remoteAddress ?? "?";
    const route = routeOf(req.url);
    console.log(`[jarvis] HTTP ${req.method} ${req.url} -> route=${route}`);

    // Never let a page on another site drive this, and never let it be framed.
    const secure = {
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "connection": "close",
      "content-security-policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: mediastream:; connect-src 'self'",
    };

    // Anything without the right LINK TOKEN is indistinguishable from a path
    // that does not exist. No headers, no hint, no difference in shape.
    const deny = () => {
      noteBadAttempt(ip);
      res.writeHead(404, { "content-type": "text/plain", ...secure });
      res.end("Not found");
    };
    const json = (obj: any, code = 200, extra: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...secure, ...extra });
      res.end(JSON.stringify(obj));
    };

    if (isLockedOut(ip)) return deny();
    if (!tokenMatches(token, tokenFrom(req.url))) return deny();
    if (route === "unknown") return deny();

    // ---- routes reachable with only the link token ----
    if (route === "page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...secure });
      return res.end(renderPage(token));
    }
    if (route === "login") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        if (!verifyPassword(String(body?.password ?? ""))) {
          // A wrong PASSWORD (they have the link) counts toward lockout, then a
          // plain 401 — they have already proven they hold the link.
          noteBadAttempt(ip);
          return json({ ok: false }, 401);
        }
        const s = sessions.issue(ip);
        badAttempts.delete(ip); // a correct password clears this address's strikes
        record("A phone signed in", "go");
        return json({ ok: true, s }, 200, {
          "set-cookie": `js=${s}; Path=/; HttpOnly; SameSite=Strict`,
        });
      });
    }

    // ---- everything past here needs a valid PASSWORD SESSION ----
    // This is the line that actually enforces "the password guards control".
    // With it commented out, anyone holding the link could drive the machine
    // without ever proving the password — the whole security model rests here.
    const sess = sessionFrom(req.headers?.cookie, req.url);
    if (!sessions.valid(sess, ip)) return json({ error: "unauthorized" }, 401);

    if (route === "events") {
      const since = parseInt(new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("since") ?? "0", 10);
      // The whole {items, nextIndex} shape, so the phone knows where to resume.
      return json(recentItems(Number.isFinite(since) ? since : 0));
    }
    if (route === "log") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        console.error("[jarvis] phone JS error:", body);
        return json({ ok: true });
      });
    }
    if (route === "stop") {
      if (req.method !== "POST") return deny();
      record("Stopped from your phone", "stop");
      try {
        (onStop ?? interruptHandler)?.();
      } catch {
        /* stopping must never throw back at the network */
      }
      return json({ stopped: true });
    }
    if (route === "mouse") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, async (body) => {

        try {
          const action = body?.action;
          if (action === "click") {
            const pos = await getMousePosition();
            const [x, y] = pos.split(",").map(Number);
            await click(x, y, "left");
          } else if (action === "rclick") {
            const pos = await getMousePosition();
            const [x, y] = pos.split(",").map(Number);
            await click(x, y, "right");
          } else {
            const pos = await getMousePosition();
            let [x, y] = pos.split(",").map(Number);
            const delta = 40;
            if (action === "up") y -= delta;
            else if (action === "down") y += delta;
            else if (action === "left") x -= delta;
            else if (action === "right") x += delta;
            await moveMouse(x, y);
          }
          return json({ ok: true });
        } catch (e) {
          return json({ ok: false }, 500);
        }
      });
    }
    if (route === "command") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {

        const norm = normaliseCommand(body?.text);
        if (!norm.ok) return json({ ok: false, reason: norm.reason }, 400);
        const via = body?.via === "voice" ? "voice" : "typed";
        record(`You (phone): ${norm.text}`, "go");
        try {
          commandHandler?.(norm.text, via);
        } catch {
          /* a bad command must not crash the server */
        }
        return json({ ok: true });
      });
    }
    if (route === "voice") {
      if (req.method !== "POST") return deny();
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        const wav = Buffer.concat(chunks);
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { writeFileSync, unlinkSync } = await import("node:fs");
        const { getAppPath } = await import("../utils/appPath.js");
        const wavPath = join(tmpdir(), "remote-voice-" + Date.now() + ".wav");
        writeFileSync(wavPath, wav);
        try {
          const { transcribe } = await import("../voice/stt.js");
          const { loadConfig } = await import("../config.js");
          const text = await transcribe(wavPath, loadConfig(getAppPath()));
          if (text) {
            record(`You (phone): ${text}`, "go");
            try { commandHandler?.(text, "voice"); } catch {}
          }
        } catch (e) {
          console.error("[jarvis] remote voice failed:", e);
        } finally {
          try { unlinkSync(wavPath); } catch {}
        }
      });
      return json({ ok: true });
    }
    if (route === "confirm") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        const id = String(body?.id ?? "");
        const approved = body?.approved === true;
        const matched = confirmRelay.answer(id, approved);
        return json({ ok: matched });
      });
    }
    if (route === "confirm-poll") {
      return json({ pending: confirmRelay.current() });
    }
    if (route === "rtc-offer") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        const sdp = body?.sdp;
        if (!sdp || (sdp.type !== "offer") || typeof sdp.sdp !== "string") {
          return json({ ok: false }, 400);
        }
        const generation = signalling.setOffer(sdp as Sdp);
        return json({ ok: true, generation });
      });
    }
    if (route === "rtc-answer") {
      // The phone polls this for the Mac's answer and the Mac's ICE trickle.
      return json({ answer: signalling.getAnswer(), ice: signalling.drainCandidates("phone") });
    }
    if (route === "rtc-ice-phone") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        const c = body?.candidate;
        if (c && typeof c.candidate === "string") signalling.addCandidate("phone", c as IceCandidate);
        return json({ ok: true });
      });
    }
    return deny();
  });

  currentPort = port;
  return new Promise<StartResult>((resolve) => {
    server.once("error", (err: any) => {
      running = false;
      resolve({
        ok: false,
        message:
          err?.code === "EADDRINUSE"
            ? `Port ${port} is already in use.`
            : `I couldn't start the remote: ${err?.message ?? err}`,
      });
    });
    // Bound to the chosen address (Tailscale or LAN) rather than every
    // interface, so it is reachable from the phone without also listening
    // anywhere it need not.
    server.listen(port, pref.host, () => {
      running = true;
      startedAt = Date.now();
      const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
      // ttl of 0 means "always on" — no auto-close. Otherwise, forgetting to
      // turn it off must not leave a port open indefinitely.
      expiry = ttl > 0 ? setTimeout(() => void stopRemote(), ttl) : null;
      record("Remote opened", "go");
      const reach =
        pref.kind === "tailscale"
          ? "Open this on your phone from anywhere (both on your Tailscale)"
          : "Open this on your phone (same Wi-Fi — install Tailscale on both to reach it from anywhere)";
      const life = ttl > 0 ? "Reopen the remote if it's been closed." : "It stays on, even across restarts.";
      resolve({
        ok: true,
        url: remoteUrl(port) ?? undefined,
        message: `${reach}: ${remoteUrl(port)}\nThis link is permanent — save it on your phone and sign in with your password any time. ${life}`,
      });
    });
  });
}

let currentPort = 7717;

export async function stopRemote(): Promise<string> {
  if (!running) return "The remote isn't running.";
  running = false;
  if (expiry) {
    clearTimeout(expiry);
    expiry = null;
  }
  // A new token next time, so the old link is dead the moment this closes.
  token = "";
  onStop = null;
  // Everyone signed out, the WebRTC mailbox emptied, any pending confirmation
  // denied — closing the remote leaves nothing behind that could still act.
  sessions.revokeAll();
  signalling.reset();
  confirmRelay.cancel();
  await new Promise<void>((resolve) => {
    try {
      server?.close(() => resolve());
      // close() waits for open connections; the phone polls, so force it.
      server?.closeAllConnections?.();
    } catch {
      resolve();
    }
  });
  server = null;
  return "Remote closed. That link won't work again.";
}

export function remoteStatus(): string {
  if (!running) return "The phone remote is off.";
  const mins = Math.round((Date.now() - startedAt) / 60_000);
  return `Remote has been open ${mins} minute${mins === 1 ? "" : "s"} at ${remoteUrl(currentPort)}`;
}

/** The current link (with its live token), or null when the remote is off. */
export function currentRemoteUrl(): string | null {
  return running ? remoteUrl(currentPort) : null;
}
