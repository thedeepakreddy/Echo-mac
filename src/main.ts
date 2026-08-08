import { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer } from "electron";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, JarvisConfig } from "./config.js";
import { loadEnv } from "./env.js";
import { applyKeys, needsSetup } from "./keystore.js";
import { openSetupWindow, wireSetupIpc, closeSetupWindow } from "./setup.js";
import { createBrain, Brain } from "./brain/index.js";
import { VoiceListener } from "./voice/listener.js";
import { transcribe, warmUpStt, stopSttServer } from "./voice/stt.js";
import { matchWakeWord, isNameOnly } from "./voice/wakeword.js";
import { isHallucination } from "./voice/vocabulary.js";
import { currentContext } from "./memory/context.js";
import { compact, stats } from "./memory/store.js";
import { playSound } from "./voice/sfx.js";
import { Tts } from "./voice/tts.js";
import { setActiveTts } from "./voice/speaker.js";
import { prefetch } from "./brain/prefetch.js";
import { closeOrbitalPanel } from "./orbital.js";
import { confirmations, ConfirmationBroker } from "./safety/confirm.js";
import { classify } from "./safety/risk.js";
import { shellQuote } from "./safety/shellquote.js";
import { matchReflex } from "./frontier/reflex.js";
import { replay } from "./frontier/replay.js";
import { replayWithGate } from "./frontier/gatedreplay.js";
import { Workflow } from "./frontier/demonstrate.js";
import { capture } from "./safety/snapshot.js";
import { attention, urgencyOf } from "./frontier/attention.js";
import { resetIdleTimer, stopDreamingNow, setDreamingEnabled, isDreaming } from "./frontier/dreamer.js";
import { onHudState, setAway } from "./frontier/hudstate.js";
import { narrateState, narrateSaid, feed } from "./frontier/narrate.js";
import { presenceMonitor } from "./frontier/presence.js";
import { noteLeft, noteReturned } from "./frontier/changed.js";
import { stopResearchNow } from "./frontier/researcher.js";
import {
  setInterruptHandler, stopRemote, setCommandHandler, macConfirmRelay, startRemote, record as remoteRecord
} from "./frontier/remote.js";
import { hasPassword as hasRemotePassword } from "./frontier/remoteauth.js";
import { saveRemoteUrl } from "./frontier/remotelink.js";
import { startCaptureBridge, stopCaptureBridge } from "./frontier/remotecapture.js";
import { toggleGestures } from "./tools/gestures.js";
import { toggleEyeTracking } from "./tools/eyetrack.js";
import { toggleSonar } from "./tools/sonar.js";
import { releaseCamera, releaseCameraSync } from "./frontier/camera.js";
import { setShutdownHandler } from "./lifecycle.js";
import {
  configureLearning,
  startTurn,
  finishTurn,
  datasetStats,
  describeStats,
  type Source as LearnSource,
} from "./learn/trajectory.js";
import { startRewind, stopRewind } from "./tools/rewind.js";
import { upcomingEvents } from "./tools/system.js";
import { startWatchdog, stopWatchdog } from "./tools/watchdog.js";
import { startGhostMode, stopGhostMode } from "./tools/ghost.js";
import { startAutoDebug, stopAutoDebug } from "./tools/autodebug.js";
import { embedRecentMemory } from "./tools/long_term_memory.js";
import { isRecordingMeeting } from "./tools/meeting.js";
import { createOverlayWindow, destroyOverlayWindow, setOverlayInteractive, sendToOverlay } from "./overlay.js";
import { startShadowMode, stopShadowMode } from "./tools/shadow.js";
import { openApp, typeText } from "./tools/computer-actions.js";
import * as ax from "./tools/ax.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let cfg: JarvisConfig;
let brain: Brain;
let listener: VoiceListener | null = null;
let tts: Tts;
let lastBrainStatus = "idle";
let lastAssistantText = "";
let expectAnswer = false;
/** Holds the detected project between memory init and brain creation. */
const createBrainProjectHint: { value?: string } = {};

function send(channel: string, payload: any) {
  win?.webContents.send(channel, payload);
}

function setStatus(status: string, extra: Record<string, any> = {}) {
  send("state", { status, ...extra });
}

/**
 * Which brain is about to act, named so the trainer can exclude the student.
 *
 * A model trained on its own output degrades a little each cycle until it is
 * useless, and the local brain is exactly where DeepakLLM will be served from —
 * so "ollama" alone is not a safe label. Once the model in use is the student,
 * its rows are tagged as such and the training set can drop them.
 */
function learnSource(): LearnSource {
  const provider = ((brain as any)?.provider ?? cfg.brain) as string;
  if (provider === "ollama" && /deepak/i.test(cfg.ollama?.model ?? "")) return "deepakllm";
  if (provider === "claude" || provider === "gemini" || provider === "ollama") return provider;
  return "unknown";
}

function learnModel(): string {
  const provider = ((brain as any)?.provider ?? cfg.brain) as string;
  if (provider === "gemini") return cfg.gemini?.model ?? "";
  if (provider === "ollama") return cfg.ollama?.model ?? "";
  return cfg.claude?.model ?? "";
}

/** Open a recorded turn, so everything the brain does next is captured. */
function beginLearnedTurn(command: string) {
  startTurn(command, learnSource(), learnModel());
  // Learn the user's command patterns for safe pre-fetch/prediction. Only the
  // commands they give Echo — never keystrokes elsewhere.
  try {
    prefetch.learn(command);
  } catch {
    /* prediction is a nicety; never let it disturb a turn */
  }
}

/**
 * Is the local Ollama server up? The background helpers that lean on it should
 * start when it is actually there, not when some unrelated cloud brain is
 * selected. A short timeout so a missing server never stalls startup.
 */
async function ollamaReachable(host = "http://localhost:11434"): Promise<boolean> {
  try {
    const res = await fetch(`${host.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Compact = reactor only. Expanded adds room above it for the chat box.
// Sized to clear the reactor's glow (a 170px reactor throws a ~32px halo);
// any larger and the transparent always-on-top window starts eating clicks
// meant for the app underneath.
const HUD_COMPACT = { width: 240, height: 240 };
const HUD_EXPANDED = { width: 360, height: 270 };

/**
 * Resize around the reactor rather than the window origin. The reactor sits at
 * the bottom-centre of the HUD, so anchoring that point keeps it visually still
 * while the chat box grows upward — otherwise it would jump across the screen.
 */
function setHudExpanded(expanded: boolean) {
  if (!win) return;
  const b = win.getBounds();
  const target = expanded ? HUD_EXPANDED : HUD_COMPACT;
  if (b.width === target.width && b.height === target.height) return;

  const anchorX = b.x + b.width / 2;
  const anchorY = b.y + b.height;
  win.setBounds({
    width: target.width,
    height: target.height,
    x: Math.round(anchorX - target.width / 2),
    y: Math.round(anchorY - target.height),
  });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  // Just big enough for the reactor plus its glow. The window is transparent
  // and always-on-top, so any extra size would sit over other apps swallowing
  // clicks that were never meant for Jarvis.
  const width = HUD_COMPACT.width;
  const height = HUD_COMPACT.height;
  win = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + workArea.height - height - 20,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: "#00000000",
    // macOS: an ordinary window cannot be drawn over ANOTHER app's fullscreen
    // Space, no matter how high its always-on-top level. Only an NSPanel can,
    // and that is what Jarvis needs to stay visible while you work fullscreen.
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  // Float above everything, including other apps and fullscreen spaces.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(join(__dirname, "..", "renderer", "index.html"));

  win.on("closed", () => {
    win = null;
  });
}

/**
 * @param needsWakeWord true when the mic opened on its own (always-on keyless
 * mode), so the transcript has to actually start with "Jarvis" to count.
 */
/** Chirp so the user knows they were heard, without waiting on it. */
function acknowledgeWake(isInstant = false) {
  const file = cfg.voice.wakeSound;
  if (!file) return;
  // Mute the mic for the chirp, or the next capture transcribes the sound
  // itself. Don't unmute if Jarvis has already started speaking.
  if (!isInstant) listener?.setPaused(true);
  void playSound(file, cfg.voice.wakeSoundSeconds).finally(() => {
    if (!isInstant && !tts.isSpeaking()) listener?.setPaused(false);
  });
}

async function handleUtterance(wavPath: string, needsWakeWord = false) {
  if (!needsWakeWord) setStatus("thinking");
  const t0 = Date.now();
  console.log(`[jarvis] captured utterance -> ${wavPath}${needsWakeWord ? " (awaiting wake word)" : ""}`);

  let text = "";
  try {
    text = await transcribe(wavPath, cfg);
  } catch (err: any) {
    console.error(`[jarvis] transcription failed: ${err?.message ?? err}`);
    send("notice", { level: "error", text: String(err?.message ?? err) });
    setStatus(lastBrainStatus);
    return;
  }
  console.log(`[jarvis] transcript (${Date.now() - t0}ms): ${JSON.stringify(text)}`);

  let command = text.replace(/\[.*?\]|\(.*?\)/g, "").trim();

  // Whisper invents words for near-silence — "(laughing)", "Thank you.", "you".
  // These reached the brain as real commands; drop them before anything acts.
  if (isHallucination(command)) {
    console.log(`[jarvis] ignoring noise: ${JSON.stringify(text.trim().slice(0, 40))}`);
    setStatus("idle");
    return;
  }

  // Continuous Audio Log
  if (isRecordingMeeting) {
    const audioLogPath = join(app.getAppPath(), "audio_log.txt");
    try {
      appendFileSync(audioLogPath, `[${new Date().toISOString()}] ${command}\n`, "utf8");
    } catch (e) { }
  }

  // A pending confirmation takes priority over everything, and needs no wake
  // word — Jarvis just asked you a direct question, so answer it.
  if (confirmations.isWaiting) {
    const answer = ConfirmationBroker.readAnswer(command);
    if (answer !== null) {
      confirmations.settle(null, answer);
      return;
    }
    // Neither yes nor no: re-ask rather than guessing at a destructive action.
    console.log(`[jarvis] ambiguous confirmation reply: ${JSON.stringify(command)}`);
    tts.say("Sorry — yes or no?");
    expectAnswer = true;
    if (!cfg.voice.ttsEnabled) maybeAutoListen();
    return;
  }

  if (needsWakeWord) {
    const { matched, command: rest } = matchWakeWord(text);
    if (!matched) {
      // Ordinary conversation in the room — not addressed to Jarvis. Stay quiet.
      console.log("[jarvis] no wake word — ignoring");
      setStatus("idle");
      return;
    }
    console.log(`[jarvis] wake word matched; command = ${JSON.stringify(rest)}`);
    acknowledgeWake();
    setStatus("thinking");

    // They only said the name: acknowledge and open the mic for the command.
    if (isNameOnly(rest)) {
      send("notice", { level: "info", text: "Yes?" });
      tts.say("Yes?");
      expectAnswer = true;
      maybeAutoListen();
      return;
    }
    command = rest;
  }

  // Whisper returns "" or markers like [BLANK_AUDIO] for silence. Say so rather
  // than going quiet, which is indistinguishable from being ignored.
  if (command.length < 2) {
    console.log("[jarvis] nothing intelligible in that utterance — ignoring");
    if (!needsWakeWord) {
      send("notice", { level: "warn", text: "I didn't catch that." });
    }
    setStatus("idle");
    return;
  }
  send("message", { kind: "user", text: command });

  const lowercaseCmd = command.toLowerCase();
  
  // Custom Shortcuts Intercept
  const cleanCmd = lowercaseCmd.replace(/[.,!?]/g, "").trim();
  const shortcutsPath = join(app.getAppPath(), "shortcuts.json");
  if (existsSync(shortcutsPath)) {
    try {
      const shortcuts = JSON.parse(readFileSync(shortcutsPath, "utf8"));
      for (const [phrase, action] of Object.entries(shortcuts)) {
        const cleanPhrase = phrase.toLowerCase().replace(/[.,!?]/g, "").trim();
        let match = false;
        let param = "";
        
        if (cleanPhrase.includes("*")) {
          const regexStr = "^" + cleanPhrase.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "(.*)") + "$";
          const regex = new RegExp(regexStr);
          const res = cleanCmd.match(regex);
          if (res) {
            match = true;
            param = res[1].trim();
          }
        } else if (cleanCmd === cleanPhrase || cleanCmd.endsWith(cleanPhrase) || cleanCmd.startsWith(cleanPhrase)) {
          match = true;
        }

        if (match) {
          const actObj = action as any;
          let cmdToRun = actObj.command;
          if (param && cmdToRun.includes("$1")) {
            // The parameter comes from speech and lands inside a shell string,
            // so it must be neutralised. Injecting it raw meant that saying
            // "...x'; rm -rf ~; echo '" would run the injected command.
            const injected = cmdToRun.includes("http")
              ? encodeURIComponent(param)
              : shellQuote(param);
            cmdToRun = cmdToRun.replace(/\$1/g, injected);
          }

          // Shortcuts skip the model, so they used to skip the risk gate with
          // it — "empty the trash" deleted files with no confirmation. Classify
          // the command that will actually run, exactly as a tool call would be.
          const assessment = classify("Bash", { command: cmdToRun }, {
            workingDir: cfg.control.workingDir,
          });
          console.log(`[jarvis] shortcut "${phrase}" -> ${assessment.tier}: ${cmdToRun.slice(0, 80)}`);

          if (assessment.tier === "high") {
            const snap = assessment.snapshot
              ? await capture(assessment.snapshot, assessment.reason).catch(() => null)
              : null;
            const approved = await confirmations.request(
              `That shortcut will ${assessment.reason}.${snap ? " I've taken a snapshot first." : ""} Should I go ahead?`
            );
            if (!approved) {
              send("notice", { level: "warn", text: "Shortcut cancelled." });
              tts.say("Cancelled.");
              return;
            }
          }

          send("notice", { level: "info", text: `Shortcut: ${actObj.reply}` });
          tts.say(actObj.reply);
          exec(cmdToRun, (err) => {
            if (err) console.error("[jarvis] Shortcut failed:", err);
          });
          return;
        }
      }
    } catch (e) {
      console.error("[jarvis] Failed to read shortcuts.json:", e);
    }
  }

  const switchMatch = lowercaseCmd.match(/(?:switch|change) (your )?brain to (claude|gemini|llama|ollama)/);
  if (switchMatch) {
    let targetBrain = switchMatch[2] as "claude" | "gemini" | "ollama" | "llama";
    if (targetBrain === "llama") targetBrain = "ollama";
    
    send("notice", { level: "info", text: `Switching brain to ${targetBrain}...` });
    tts.say(`Switching my brain to ${targetBrain}.`);
    
    const configPath = join(app.getAppPath(), "config.json");
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, "utf8");
        const configData = JSON.parse(raw);
        configData.brain = targetBrain;
        writeFileSync(configPath, JSON.stringify(configData, null, 2), "utf8");
        
        setTimeout(() => {
          // Tear down before exiting. app.exit() skips will-quit, so without
          // this the announcement still playing through `say` — and the whisper
          // server — outlive the process and overlap the new instance.
          shutdown();
          app.relaunch();
          app.exit(0);
        }, 1000);
      } catch (err: any) {
        console.error("[jarvis] Failed to switch brain:", err);
      }
      return;
    }
  }

  // Reflex Engine: Offline bypass for instantaneous GUI driving
  const reflexGmail = lowercaseCmd.match(/^(?:write|compose|send) a g?mail$/i) || lowercaseCmd.match(/^open gmail and click new message$/i);
  if (reflexGmail) {
    const prompt = `[SYSTEM: Strict Sequence Override]
The user wants you to write a Gmail interactively. You must follow these exact steps in order. DO NOT skip ahead. Use your screenshot and click_text or click_ui_element tools to explicitly click the correct text boxes on the screen instead of relying on tab navigation.
Step 1: Use run_terminal_command to open "https://mail.google.com/mail/u/0/#inbox?compose=new". Then ask the user: "Whom should I send it to? You can spell it out." End your turn.
Step 2: When the user replies with the recipient, look at the screen, find the 'To' or 'Recipients' box, click it, and type the email address. Then ask the user: "Got it. What is the message?". End your turn.
Step 3: When the user replies with the message, look at the screen, find the main Message Body text box, click it, and type the message.
Step 4: Immediately generate a 3-word subject. Look at the screen, find the 'Subject' box, click it, and type the subject. Ask the user: "I have drafted the message and subject. Should I send it?". End your turn.
Step 5: When the user confirms (e.g. "send it", "perfect"), look at the screen, find the 'Send' button, click it, and then close the browser tab.

If you see any popups blocking your view, close them before continuing.`;

    send("notice", { level: "info", text: "Starting Agentic Gmail Workflow..." });
    beginLearnedTurn(command);
    brain.send(prompt);
    return;
  }

  const reflexOpen = lowercaseCmd.match(/^open (.*)$/i);
  if (reflexOpen) {
    const targetApp = reflexOpen[1].trim();
    send("notice", { level: "info", text: `Reflex: Opening ${targetApp}...` });
    tts.say(`Opening ${targetApp}.`);
    void openApp(targetApp);
    return;
  }

  const reflexType = lowercaseCmd.match(/^type (.*)$/i);
  if (reflexType) {
    const targetText = lowercaseCmd.substring(5).trim();
    send("notice", { level: "info", text: `Reflex: Typing text...` });
    void typeText(targetText);
    return;
  }

  const reflexClick = lowercaseCmd.match(/^click (.*)$/i);
  if (reflexClick) {
    const targetBtn = reflexClick[1].trim();
    send("notice", { level: "info", text: `Reflex: Clicking ${targetBtn}...` });
    void (async () => {
      const d = await ax.dump();
      if (d.axAvailable && d.elements.length) {
        const matches = ax.rank(d.elements, targetBtn);
        if (matches.length > 0) {
          const el = matches[0];
          if (el.press) await ax.press(d.pid, el.path);
        }
      }
    })();
    return;
  }

  const reflexEmail = lowercaseCmd.match(/^(?:write|send) an? (?:email|mail) to (.*) saying (.*)$/i);
  if (reflexEmail) {
    const targetPerson = reflexEmail[1].trim();
    const targetMessage = reflexEmail[2].trim();
    send("notice", { level: "info", text: `Reflex: Emailing ${targetPerson}...` });
    tts.say(`Drafting email to ${targetPerson}.`);
    const script = `tell application "Mail"
      set newMessage to make new outgoing message with properties {subject:"Message from Jarvis", content:"${targetMessage}", visible:true}
      tell newMessage
        make new to recipient at end of to recipients with properties {name:"${targetPerson}"}
      end tell
      activate
    end tell`;
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
      if (err) console.error("Reflex email failed:", err);
    });
    return;
  }

  const cached = matchReflex(lowercaseCmd);
  if (cached) {
    send("notice", { level: "info", text: `Reflex Cache Hit! Executing instantly...` });
    tts.say("Got it, executing from reflex memory.");
    const wf: Workflow = {
      name: cached.query,
      createdAt: cached.createdAt,
      steps: cached.steps,
      parameters: [],
      runs: cached.successes,
      repairs: 0
    };
    // Through the gate, not around it: a cached workflow can contain "click
    // Send" just as easily as "click Inbox", and replaying it directly meant
    // those never asked for confirmation.
    void replayWithGate(wf, wf.steps, cfg.control.workingDir).then((r) => {
      if (!r.ok) {
        send("notice", { level: "warn", text: r.summary });
        tts.say(r.summary);
      }
    });
    return;
  }

  beginLearnedTurn(command);
  brain.send(command);
}

/**
 * When Jarvis ends a turn by asking something ("what kind of app?"), re-open the
 * mic automatically once it has finished speaking, so the user can just answer
 * out loud instead of waking it again.
 */
/**
 * A pending confirmation owns the next thing you say. Wired here because the
 * broker deliberately knows nothing about audio.
 */
function wireConfirmations() {
  confirmations.on("ask", ({ id, question }: { id: string; question: string }) => {
    console.log(`[jarvis] confirm: ${question}`);
    send("message", { kind: "assistant", text: question });
    send("state", { status: "confirming" });
    tts.say(question);
    // Open the mic once the question has been spoken, so an answer is expected.
    expectAnswer = true;
    if (!cfg.voice.ttsEnabled) maybeAutoListen();

    // Mirror the question to a connected phone, carrying the SAME id so an
    // approval from the phone settles this exact action. The relay's timeout is
    // longer than the broker's, so it never denies ahead of the local prompt —
    // only a real tap on the phone resolves it early.
    try {
      const { answered } = macConfirmRelay().ask(question, "high", 40_000, id);
      answered.then((approved) => {
        if (approved) confirmations.settle(id, true, "approved from phone");
        else confirmations.settle(id, false, "denied from phone");
      });
    } catch {
      /* the phone mirror must never break the local confirmation */
    }
  });

  confirmations.on("settled", ({ id, approved, why }: { id: string; approved: boolean; why: string }) => {
    console.log(`[jarvis] confirm -> ${approved ? "APPROVED" : "DENIED"}${why ? ` (${why})` : ""}`);
    // However it was answered, clear it from the phone's screen.
    try {
      macConfirmRelay().dismiss(id);
    } catch {
      /* ignore */
    }
    if (!approved && why === "no answer") tts.say("No answer, so I'll leave it.");
    setStatus(lastBrainStatus);
  });
}

function maybeAutoListen() {
  if (!expectAnswer || tts.isSpeaking()) return;
  expectAnswer = false;
  setTimeout(() => listener?.triggerListen(), 250);
}

function wireBrain() {
  brain.on("text", (t: string) => {
    console.log(`[jarvis] says: ${t}`);
    remoteRecord(`Jarvis: ${t}`, "jarvis");
    narrateSaid(t);
    lastAssistantText = t;
    send("message", { kind: "assistant", text: t });
    // Answers and questions go out immediately; unprompted observations wait
    // until the user is not mid-keystroke. Nothing is dropped — anything held
    // is released by the timer below once it is overdue.
    const now = attention.offer(t, urgencyOf(t));
    if (now) tts.say(now);
  });
  brain.on("tool", (info: { name: string; summary: string }) => {
    console.log(`[jarvis] doing: ${info.summary}`);
    remoteRecord(`Action: ${info.summary}`, "action");
    send("message", { kind: "action", text: info.summary });
  });
  brain.on("risk", (r: { tool: string; tier: string; reason: string }) => {
    // Low risk is the overwhelming majority; logging it would bury everything else.
    if (r.tier !== "low") {
      console.log(`[jarvis] risk=${r.tier.padEnd(6)} ${r.reason}`);
      remoteRecord(`Risk [${r.tier}]: ${r.reason}`, "warn");
    }
  });
  brain.on("status", (s: string) => {
    lastBrainStatus = s;
    narrateState(s);
    if (!tts.isSpeaking()) setStatus(s);
  });
  brain.on("turnEnd", () => {
    lastBrainStatus = "idle";
    expectAnswer = /\?\s*$/.test(lastAssistantText.trim());
    lastAssistantText = "";
    // Reaching the end of a turn without an error is the weakest useful success
    // signal. It is provisional: an "undo that" a moment later overrides it.
    finishTurn("success", "turn completed");
    // If TTS is off there is no speech-finished callback, so arm the mic now.
    maybeAutoListen();
  });
  brain.on("error", (msg: string) => {
    console.error(`[jarvis] brain error: ${msg}`);
    remoteRecord(`Error: ${msg}`, "stop");
    finishTurn("failure", msg.slice(0, 200));
    send("notice", { level: "error", text: msg });
  });
}

async function wireVoice() {
  listener = new VoiceListener(cfg);
  listener.on("ready", (wakeEnabled: boolean, engine: string) => {
    console.log(
      wakeEnabled
        ? `[echo] voice ready — wake word "Echo" is ACTIVE (${engine})`
        : "[jarvis] voice ready — wake word OFF. Click the reactor core or press ⌘⇧J to talk."
    );
    send("state", { wakeEnabled, provider: (brain as any).provider ?? cfg.brain });
    send("notice", {
      level: "info",
      text: wakeEnabled
        ? 'Listening. Say "Jarvis" to wake me.'
        : "Push-to-talk ready. Click the reactor core or press ⌘⇧J to talk.",
    });
  });
  listener.on("discarded", (reason: string) => {
    console.log(`[jarvis] audio discarded: ${reason}`);
    // Only worth telling the user when they explicitly asked to be heard;
    // in always-on mode this fires constantly on room noise.
    if (/peak level/.test(reason)) {
      send("notice", { level: "warn", text: `I couldn't hear you — ${reason}` });
      setStatus("idle");
    }
  });
  listener.on("device", (name: string) => {
    console.log(`[jarvis] microphone: ${name}`);
    // A headset that's connected but not being worn is a common false alarm.
    if (/airpod|headphone|headset|buds/i.test(name)) {
      send("notice", {
        level: "warn",
        text: `Listening through ${name}. If it isn't in your ear, switch input in Sound settings.`,
      });
    }
  });
  listener.on("bargein", (level: number, bar: number) => {
    console.log(`[jarvis] barge-in (level ${level} over ${bar}) — stopping speech`);
    // Cut the sentence off mid-word, the way a person stops when interrupted.
    tts.stop();
    // Anything said while interrupting is aimed at Jarvis, so skip the wake word.
    expectAnswer = false;
    listener?.triggerListen();
  });

  listener.on("wake", () => {
    resetIdleTimer();
    console.log('[jarvis] wake word "Jarvis" detected');
    setStatus("listening");
    acknowledgeWake(true);
  });
  listener.on("listening", () => {
    console.log("[jarvis] listening — capturing until you stop speaking");
    setStatus("listening");
  });
  listener.on("level", (n: number) => send("level", n));
  listener.on("utterance", (wav: string, needsWakeWord: boolean) =>
    void handleUtterance(wav, needsWakeWord)
  );
  listener.on("unavailable", (reason: string) =>
    send("notice", { level: "warn", text: reason })
  );
  listener.on("error", (msg: string) => send("notice", { level: "warn", text: msg }));
  warmUpStt(cfg); // load the STT model now, not on the first command
  await listener.start();
}

/** Say anything that was held back, once the moment is right. */
function drainHeldSpeech() {
  for (const text of attention.release()) tts.say(text);
}

function wireTts() {
  console.log("[jarvis] starting TTS with engine:", cfg.voice.ttsEngine);
  // A misconfigured ElevenLabs setup falls back to `say` on every utterance,
  // which sounds exactly like never having configured it at all. The reason is
  // knowable here and nowhere later, so it is stated once at startup rather
  // than left to be inferred from an unchanged voice.
  if (cfg.voice.ttsEngine === "elevenlabs") {
    if (!cfg.voice.elevenLabsVoiceId) {
      console.warn("[jarvis] ttsEngine is elevenlabs but voice.elevenLabsVoiceId is unset — speaking in the built-in voice");
    } else if (!process.env.ELEVENLABS_API_KEY) {
      console.warn("[jarvis] ttsEngine is elevenlabs but ELEVENLABS_API_KEY is unset — speaking in the built-in voice");
    } else {
      console.log(`[jarvis] elevenlabs voice ${cfg.voice.elevenLabsVoiceId} ready`);
    }
  }
  tts = new Tts(cfg.voice.ttsVoice, cfg.voice.ttsEnabled, cfg.voice.ttsEngine, cfg.voice.elevenLabsVoiceId, (speaking) => {
    // Pause the mic while Jarvis speaks so it doesn't transcribe its own voice.
    listener?.setPaused(speaking);
    setStatus(speaking ? "speaking" : lastBrainStatus);
    // Jarvis just finished asking a question — open the mic for the answer.
    if (!speaking) maybeAutoListen();
  });
  // Share this one voice with background features (companion mode, watchers) so
  // they speak through the real pipeline instead of shelling out to `say`.
  setActiveTts(tts);
}

function wireIpc() {
  ipcMain.on("listen", () => { resetIdleTimer(); listener?.triggerListen(); });
  ipcMain.on("user-typing", () => { resetIdleTimer(); attention.noteTyping(); });
  ipcMain.on("set-chat-open", (_e, open: boolean) => setHudExpanded(Boolean(open)));
  // The overlay is click-through except when the pointer is over its one
  // interactive control (the QR's close button), which asks for clicks here.
  ipcMain.on("overlay:set-interactive", (_e, on: boolean) => setOverlayInteractive(Boolean(on)));
  ipcMain.on("orbital:close", () => closeOrbitalPanel());
  ipcMain.on("send-text", (_e, text: string) => {
    const clean = String(text ?? "").trim();
    if (!clean) return;
    send("message", { kind: "user", text: clean });
    beginLearnedTurn(clean);
    brain.send(clean);
  });
  ipcMain.on("interrupt", () => {
    tts.stop();
    brain.interrupt();
    setStatus("idle");
    // Being stopped mid-task is the user saying this was going wrong. Recording
    // it as a success would teach exactly the behaviour they just cut short.
    finishTurn("rejected", "user interrupted");
    send("notice", { level: "info", text: "Stopped." });
  });
}

function wireShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+J", () => listener?.triggerListen());
  globalShortcut.register("CommandOrControl+Shift+.", () => {
    tts.stop();
    brain.interrupt();
    setStatus("idle");
    // Same as the on-screen stop: an interrupted turn is a rejection, not a
    // success. Label it before the async turnEnd can mark it done, or the
    // dataset would learn the very behaviour the user just cut off.
    finishTurn("rejected", "user interrupted (hotkey)");
  });
}

// Only ever one Jarvis. A second instance would spawn a rival brain and fight
// the first one for the microphone, while leaving two reactors on screen.
if (!app.requestSingleInstanceLock()) {
  console.log("[jarvis] already running — focusing the existing window");
  app.quit();
}

app.on("second-instance", () => {
  if (!win) return;
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'] },
    (details, callback) => {
      details.requestHeaders['Origin'] = 'https://www.youtube.com';
      details.requestHeaders['Referer'] = 'https://www.youtube.com/';
      callback({ requestHeaders: details.requestHeaders });
    }
  );
  // Secrets first: the brain and the wake word both read from process.env, and
  // the agent subprocess inherits it.
  // A previous run may have died without releasing the camera; clear any
  // orphan before doing anything else, so the light is never on unexplained.
  await releaseCamera("clearing orphans from a previous run").catch(() => {});

  // Keys saved by the Setup window live in the user's own directory, because an
  // installed .app is read-only. Applied before anything reads the environment.
  const stored = applyKeys();
  if (stored.length) console.log(`[jarvis] loaded saved keys (${stored.join(", ")})`);

  wireSetupIpc(() => console.log("[jarvis] keys updated — switch brains or restart to use them"));

  const loaded = loadEnv(app.getAppPath());
  if (loaded.length) console.log(`[jarvis] .env loaded (${loaded.join(", ")})`);

  cfg = loadConfig(app.getAppPath());
  console.log(`[jarvis] config loaded (brain=${cfg.brain})`);

  // Teach-by-demonstration capture. Opt-in: it is the one part of Jarvis that
  // deliberately stores what was on screen, so it should never start unasked.
  configureLearning(cfg.learning ?? { enabled: false, captureScreens: true, maxStepsPerTurn: 60 });
  if (cfg.learning?.enabled) {
    void datasetStats()
      .then((s) => console.log(`[learn] recording trajectories — ${describeStats(s)}`))
      .catch(() => {});
  }
  createWindow();
  createOverlayWindow();

  // The Mac end of the phone-remote video link. Idle until a phone connects —
  // it captures nothing (and lights no recording indicator) until then.
  try {
    startCaptureBridge({ BrowserWindow, ipcMain, session, desktopCapturer });
  } catch (e) {
    console.error("[jarvis] remote capture bridge failed to start:", e);
  }

  // Always-on phone remote: start it silently at launch so the saved link keeps
  // working, and never let it auto-close. Fails closed — a password is required,
  // and nothing is exposed beyond the private tailnet. No QR is shown here; the
  // user already has the link, and popping it up every launch would be noise.
  if (cfg.remote?.alwaysOn) {
    if (!hasRemotePassword()) {
      console.log("[jarvis] remote.alwaysOn is set but no remote password — not starting. Set one first.");
    } else {
      void startRemote({ ttlMs: 0 })
        .then((r) => {
          if (r.ok && r.url) {
            saveRemoteUrl(r.url);
            console.log(`[jarvis] phone remote is ALWAYS ON at ${r.url}`);
          } else {
            console.error(`[jarvis] could not auto-start the phone remote: ${r.message}`);
          }
        })
        .catch((e) => console.error("[jarvis] auto-start phone remote failed:", e));
    }
  }

  // First run with no keys at all: show Setup rather than failing later with an
  // authentication error the user has no way to interpret.
  if (needsSetup()) {
    console.log("[jarvis] no API keys configured — opening Setup");
    openSetupWindow();
  }
  console.log("[jarvis] window created");

  const uiLoaded = new Promise<void>((resolve) => {
    if (win?.webContents) {
      win.webContents.once("did-finish-load", () => resolve());
    } else {
      resolve();
    }
  });

  // Tidy tombstoned records, then scope the session to whatever you are working
  // on so the brain starts with that project's history rather than cold.
  try {
    compact();
    const ctx = await currentContext();
    const s = stats();
    console.log(`[jarvis] memory: ${s.count} records, current project "${ctx.project}" (${ctx.app})`);
    (createBrainProjectHint as any).value = ctx.project;
  } catch (err) {
    console.error("[jarvis] memory init failed:", err);
  }

  const built = createBrain(cfg);
  brain = built.brain;
  (brain as any).projectHint = (createBrainProjectHint as any).value;
  (brain as any).provider = built.provider;
  (global as any).__mainBrain = brain;
  console.log(`[jarvis] brain ready (provider=${built.provider})`);
  wireBrain();
  // Warm the Claude session (spawns the agent subprocess) so the first
  // command isn't slowed by startup.
  if (built.provider === "claude") (brain as any).start?.();

  // Anything that wants to change the reactor's appearance publishes through
  // hudstate; this is the one place that actually talks to the window.
  onHudState((patch) => {
    send("state", patch);
    sendToOverlay("state", patch);
  });

  // Away mode dims the reactor the moment you leave, and restores it when you
  // return — visible from across the room without reading anything.
  presenceMonitor.on("left", () => {
    console.log("[jarvis] you left the desk — dimming and pausing");
    // Remember when, so "what changed while I was away?" knows the window it
    // is being asked about without having to be told.
    noteLeft();
    setAway(true);
  });
  presenceMonitor.on("returned", () => {
    console.log("[jarvis] you're back — restoring");
    noteReturned();
    stopDreamingNow();
    // Research must stand down for the same reason rehearsal does: work you did
    // not ask for should never compete with work you did.
    stopResearchNow();
    setAway(false);
  });
  presenceMonitor.on("tooDark", () => {
    console.log("[jarvis] room too dark to judge presence — taking no action");
  });

  // Rehearsals are opt-in; without this the dreamer is inert.
  setDreamingEnabled(cfg.dreaming?.enabled === true);
  if (cfg.dreaming?.enabled) console.log("[jarvis] idle rehearsal is ON (look-only, when you're away)");

  wireTts();
  // Held speech is checked on a timer so nothing waits indefinitely.
  setInterval(drainHeldSpeech, 4000);
  wireConfirmations();
  wireIpc();
  wireShortcuts();

  // Give the renderer a beat to attach listeners before we start emitting.
  uiLoaded.then(() => {
    console.log("[jarvis] HUD loaded");
    send("state", { status: "idle", provider: built.provider });
    if (process.env.JARVIS_NO_VOICE) {
      send("notice", { level: "info", text: "Voice disabled (JARVIS_NO_VOICE). Type commands below." });
    } else {
      void wireVoice();
    }
    
    // Futuristic Features: Background Tasks
    startRewind();
    startWatchdog();
    prefetch.start(app.getAppPath()); // load the command-prediction model
    // Ghost (pattern spotting), Shadow (pair programmer) and Auto-debug all run
    // on the LOCAL Ollama model — none of them touch Claude or Gemini. They were
    // gated on `brain === "gemini"`, which is unrelated: it left them off under
    // Claude even with Ollama running, and started them under Gemini whether or
    // not Ollama was up. Gate on the thing they actually need instead.
    void ollamaReachable(cfg.ollama?.host).then((up) => {
      if (!up) {
        console.log("[jarvis] Ollama not reachable — ghost, shadow and auto-debug stay off");
        return;
      }
      startGhostMode(tts);
      startAutoDebug(tts);
      startShadowMode(tts);
      console.log("[jarvis] local helpers on (ghost pattern-spotter, shadow pair-programmer, auto-debug)");
    });

    // Embed memory every 5 minutes
    setInterval(() => { void embedRecentMemory(); }, 5 * 60 * 1000);
    
    setInterval(async () => {
      try {
        const events = await upcomingEvents(1);
        if (events.length > 0) {
          const next = events[0];
          if (next.minutesAway === 5) {
            const msg = `Sir, your meeting "${next.title}" starts in exactly 5 minutes.`;
            send("notice", { level: "info", text: msg });
            tts.say(msg);
          }
        }
      } catch (err) {
        console.error("[jarvis] Calendar poll error:", err);
      }
    }, 60000);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * Release everything this process owns: the mic, the brain, the speech child
 * process, and the whisper server.
 *
 * This must run on EVERY exit path. `app.exit()` force-terminates without
 * firing will-quit, so a route that calls it has to invoke this itself —
 * otherwise the spawned `say` and whisper-server survive as orphans owned by
 * launchd. An orphaned `say` is what makes a restarting Jarvis appear to answer
 * in two overlapping voices: the old one is still talking when the new one starts.
 */
function shutdown() {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* already gone */
  }
  listener?.stop();
  brain?.stop();
  tts?.stop(); // kills the in-flight `say`/afplay child
  stopSttServer(); // don't leave the whisper server holding the model
  stopRewind();
  stopWatchdog();
  stopGhostMode();
  stopAutoDebug();
  stopShadowMode();
  // Quitting must close the listening port. Leaving a socket open after the
  // app is gone would be a hole nobody could see to close.
  void stopRemote();
  stopCaptureBridge();
  destroyOverlayWindow();
  closeOrbitalPanel();
  // Turn the camera-driven sensors off through their own toggles first — the
  // ordinary "release on the way out". Each stops its tracker via the child
  // handle we still hold and clears the module's state; a sensor that was never
  // on is a no-op. (toggleSonar's disable path ignores tts, but the signature
  // demands one.) None of this may throw its way out of a quit.
  try {
    toggleGestures(false);
    toggleEyeTracking(false);
    toggleSonar(false, tts);
  } catch {
    /* a sensor that wasn't running is a no-op; never hold up the exit */
  }
  // Backstop: SIGKILL by name anything still holding the camera — a helper the
  // toggle above couldn't reach, or an orphan from a run that never got here.
  // The SYNC variant is deliberate: will-quit does not await promises, so an
  // async release simply never finishes and the camera light stays on with an
  // orphan holding it.
  try {
    releaseCameraSync("app shutting down");
  } catch {
    /* nothing more to do on the way out */
  }
}

// What the phone's stop button actually does. Registered here because this is
// where the brain lives; the tool that opens the remote never touches it.
setInterruptHandler(() => {
  try {
    brain?.interrupt();
    tts?.stop();
    setStatus("idle");
  } catch {
    /* stopping should never throw back at the network */
  }
});

// A command typed or spoken on the phone is fed to the brain exactly as if it
// had been said out loud at the desk — it then flows through the same safety
// gate, so a risky action still surfaces a confirmation (answerable from the
// phone). Echoed to the HUD so the desk shows what the phone asked for.
setCommandHandler((text: string) => {
  try {
    console.log(`[jarvis] phone command: ${text}`);
    send("message", { kind: "user", text: `📱 ${text}` });
    beginLearnedTurn(text);
    brain?.send(text);
  } catch (e) {
    console.error("[jarvis] phone command failed:", e);
  }
});

app.on("will-quit", shutdown);
// Reachable from the switch_brain tool, which force-exits and would otherwise
// leave the speech process and whisper server orphaned.
setShutdownHandler(shutdown);

// Keep running in the background even with no windows (it's a menu-bar-style agent).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
