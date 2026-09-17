import { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer } from "electron";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { loadConfig, JarvisConfig } from "./config.js";
import { loadEnv } from "./env.js";
import { applyKeys, needsSetup } from "./keystore.js";
import { openSetupWindow, wireSetupIpc, closeSetupWindow } from "./setup.js";
import { createBrain, Brain, type Provider } from "./brain/index.js";
import { PROVIDER_LABELS, parseBrainSwitch, unavailableReason } from "./brain/switching.js";
import { VoiceListener } from "./voice/listener.js";
import { transcribe, transcribeLocal, warmUpStt, stopSttServer } from "./voice/stt.js";
import { audioTurnFor, describeTurn } from "./voice/audio-turn.js";
import { listen, useHearingBridge, withTone } from "./voice/hearing.js";
import { matchWakeWord, isNameOnly } from "./voice/wakeword.js";
import { isHallucination } from "./voice/vocabulary.js";
import { currentContext } from "./memory/context.js";
import { memoryService } from "./memory/service.js";
import { memoryRoot, atomicWrite } from "./memory/paths.js";
import { enforceRetention } from "./memory/deletion.js";
import { ProviderMemoryContext } from "./memory/provider-context.js";
import { executeMemoryCommand, isMemoryCommand } from "./memory/commands.js";
import type { MemoryScope } from "./memory/types.js";
import { compact, stats } from "./memory/store.js";
import { playSound } from "./voice/sfx.js";
import { Tts } from "./voice/tts.js";
import { setActiveTts } from "./voice/speaker.js";
import { VoiceSession, type Turn, type WakeKind } from "./voice/session.js";
import { voiceLog, describeSummary } from "./voice/voice-log.js";
import { SileroVad } from "./voice/vad.js";
import { DEFAULT_NO_SPEECH_MS, type CaptureMeta } from "./voice/listener.js";
import { createSttStream, type SttStream } from "./voice/stt-stream.js";
import { SpeechStream } from "./voice/speech-stream.js";
import { createPlayer, type AudioPlayer } from "./voice/player.js";
import { createWakeDetector } from "./voice/wake/index.js";
import type { AudioTurn } from "./brain/types.js";
import { prefetch } from "./brain/prefetch.js";
import { closeOrbitalPanel } from "./orbital.js";
import { closeOsirisPanel, isOsirisOpen, isOsirisPinned, openOsirisPanel, reloadOsiris, setOsirisPinned } from "./osiris.js";
import { closeNeuralCore, openNeuralCore } from "./neural.js";
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
import { startTelegram, type TelegramBridge } from "./frontier/telegram.js";
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
import { installProcessHandlers, pendingRecoveries, recordRendererError } from "./agent-replay/runtime.js";
import { swarm } from "./frontier/swarm.js";
import { loadMcpConfig } from "./brain/mcp.js";
import {
  controlTelemetry,
  observeControlEvent,
  openControlPanel,
  wireControlPanel,
  type ControlAction,
  type ControlRuntime,
} from "./control-panel.js";

// Before anything else boots. A rejection thrown during startup — a missing
// binary, a failed keychain read — used to happen before any recorder existed
// and left nothing behind but a process that had quietly stopped doing things.
// Neither handler swallows: uncaughtException is observed through
// uncaughtExceptionMonitor, so Node still dies exactly as it did before.
installProcessHandlers();

const __dirname = dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let cfg: JarvisConfig;
let brain: Brain;
let listener: VoiceListener | null = null;
let tts: Tts;
let voiceSession: VoiceSession;
/** The streaming voice: sentences to TTS as the model writes them, audio to one persistent player. */
let speech: SpeechStream | null = null;
let player: AudioPlayer | null = null;
/** They said the name and nothing else: the mic is open for the command, and "Yes?" is owed only if silence follows. */
let awaitingCommand: { turnId: string; asked: boolean } | null = null;
/** A spoken command was accepted this turn, so the conversation window opens once Echo has replied. */
let conversationWanted = false;
/** Streaming transcriptions in flight, one per capture, keyed by when the capture started. */
const sttStreams = new Map<number, { stream: SttStream; turnId?: string }>();

/**
 * Start transcribing a capture while it is still being spoken. Only captures
 * already addressed to Echo get here (a wake, a click, the window); always-on
 * captures stay local until their transcript proves they were for Echo.
 */
function startSttStream(meta: CaptureMeta) {
  if (meta.needsWakeWord || sttStreams.has(meta.captureStartAt)) return;
  const stream = createSttStream(cfg, meta.turnId, app.getAppPath());
  if (!stream) return;
  const entry = { stream, turnId: meta.turnId };
  sttStreams.set(meta.captureStartAt, entry);
  stream.on("partial", (text: string) => {
    voiceLog.event("stt.partial", { turnId: entry.turnId, text });
    send("state", { hearing: text });
    // What the sentence sounds like so far shapes how long to wait for its end.
    listener?.setEndpointHint(
      /[.?!]\s*$/.test(text) ? "punctuated"
        : /\b(and|or|but|so|um|uh|to|the|a|an|of|in|on|with|for|then)\s*$/i.test(text) ? "midclause"
          : null
    );
  });
  stream.on("error", (m: string) => console.log(`[voice] stt stream: ${m}`));
  stream.start(listener?.capturedFrames() ?? []).catch((err: any) => {
    console.log(`[voice] stt stream failed to start: ${err?.message ?? err}`);
    sttStreams.delete(meta.captureStartAt);
  });
}

/** The capture ended: collect the streamed transcript, bounded so a stall cannot hold the turn. */
async function finishSttStream(captureStartAt: number | undefined, turnId?: string): Promise<string | undefined> {
  if (captureStartAt === undefined) return undefined;
  const entry = sttStreams.get(captureStartAt);
  if (!entry) return undefined;
  sttStreams.delete(captureStartAt);
  const t0 = Date.now();
  const text = await Promise.race([
    entry.stream.end(),
    new Promise<string | null>((r) => setTimeout(() => r(null), 1800)),
  ]);
  if (!text) {
    entry.stream.abort();
    console.log(`[voice] stt stream gave nothing (${Date.now() - t0}ms) — falling back to the file path`);
    return undefined;
  }
  voiceLog.event("stt.final", { turnId, engine: entry.stream.name, ms: Date.now() - t0, text: text.slice(0, 80) });
  return text;
}

function abortSttStreams(why: string) {
  for (const [, e] of sttStreams) e.stream.abort();
  if (sttStreams.size) console.log(`[voice] aborted ${sttStreams.size} stt stream(s): ${why}`);
  sttStreams.clear();
}
let telegram: TelegramBridge | null = null;
let lastBrainStatus = "idle";
let lastAssistantText = "";
let expectAnswer = false;
/** Holds the detected project between memory init and brain creation. */
const createBrainProjectHint: { value?: string } = {};

/**
 * The scope every turn is remembered and recalled under.
 *
 * Without this, memory is written with no project and the router cannot keep
 * one project's decisions out of another's task — which is the whole point of
 * scoping it. The frontmost window is a hint about which project the user is
 * in, refreshed per turn because they switch apps between sentences; it is
 * never a permission boundary, and a memory can still be explicitly global.
 */
function currentScope(): MemoryScope {
  const projectId = createBrainProjectHint.value;
  return { projectId: projectId && projectId !== "global" ? projectId : undefined };
}

/** Re-read the frontmost window's project, cheaply and never fatally. */
async function refreshScope(): Promise<void> {
  try {
    const ctx = await currentContext();
    if (ctx?.project) createBrainProjectHint.value = ctx.project;
  } catch { /* a scope hint is never worth failing a turn over */ }
}

function send(channel: string, payload: any) {
  win?.webContents.send(channel, payload);
  observeControlEvent(channel, payload);
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

// Sized only for the reactor and its glow. The control panel is a separate
// centered window, so the always-on-top HUD never grows or shifts position.
const HUD_COMPACT = { width: 240, height: 240 };

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
function acknowledgeWake(turnId?: string) {
  voiceLog.event("wake.ack", { turnId });
  const file = cfg.voice.wakeSound;
  if (!file) return;
  // The chirp used to PAUSE the mic for its whole 2.2 s, and pausing threw away
  // the capture in progress — so anything said right after the name was lost.
  // Now the mic keeps recording; only NEW captures are held off while it plays.
  listener?.holdOff(350);
  void playSound(file, cfg.voice.wakeSoundSeconds);
}

/** What the listener knew about the capture, so the turn's timings are real. */
interface UtteranceMeta {
  turnId?: string;
  wake?: WakeKind;
  captureStartAt?: number;
  speechStartAt?: number;
  speechEndAt?: number;
  /** Streaming STT already produced the transcript while the user spoke. */
  transcript?: string;
}

/** The whole utterance is an instruction to stop, not something for the brain. */
function isStopIntent(command: string): boolean {
  return /^(?:(?:hey|ok|okay)\s+)?(?:echo[,!.]?\s*)?(?:stop|cancel|never\s*mind|shut up|be quiet|quiet|enough|hold on|hang on|wait)(?:\s+(?:it|that|please|echo))?[.!]?$/i.test(command.trim());
}

/**
 * They said the name and nothing else. Open the mic for the command NOW rather
 * than after a spoken "Yes?" — the old round trip took ~2.5 s during which the
 * mic was paused, so the command that naturally follows a beat after the name
 * was exactly what got dropped. "Yes?" is said only if nothing follows.
 */
function awaitCommand(turn: Turn) {
  void refreshScope();
  awaitingCommand = { turnId: turn.id, asked: false };
  expectAnswer = false;
  setStatus("listening");
  listener?.triggerListen({ turnId: turn.id, wake: turn.wake, noSpeechMs: DEFAULT_NO_SPEECH_MS });
}

/** Status to fall back to when a capture came to nothing. */
function idleStatus(): string {
  return tts.isSpeaking() ? "speaking" : lastBrainStatus;
}

/**
 * Every path into the brain goes through here, so the session knows which
 * output is current and every turn is stamped in the voice log.
 */
function dispatchToBrain(text: string, audio?: AudioTurn, turn: Turn | null = null, modality: "voice" | "text" = "voice") {
  controlTelemetry.beginTask(text);
  voiceSession.noteBrainSend(turn, text, (brain as any).provider ?? cfg.brain);
  speech?.newTurn();
  // Open the TTS socket while the model thinks, so the first sentence does not wait for it.
  if (cfg.voice.ttsEnabled) speech?.warm(text);
  brain.send(text, audio, { modality, turnId: turn?.id, scope: currentScope() });
}

/**
 * @param needsWakeWord true when the mic opened on its own (always-on keyless
 * mode), so the transcript has to actually contain "Echo" to count.
 */
async function handleUtterance(wavPath: string, needsWakeWord = false, meta: UtteranceMeta = {}) {
  const t0 = Date.now();
  // A turn exists already when the capture was started deliberately (a wake, a
  // click, speech inside the window). An always-on capture only becomes a
  // turn once its transcript proves it was addressed to Echo.
  let turn: Turn | null = meta.turnId && voiceSession.isCurrent(meta.turnId) ? voiceSession.current : null;
  const stampCapture = (t: Turn) => {
    if (meta.captureStartAt) voiceLog.stampAt("capture.start", t.id, meta.captureStartAt);
    if (meta.speechStartAt) voiceLog.stampAt("vad.speech_start", t.id, meta.speechStartAt);
    if (meta.speechEndAt) voiceLog.stampAt("vad.speech_end", t.id, meta.speechEndAt);
    voiceLog.event("capture.end", { turnId: t.id, wake: t.wake });
  };
  if (turn) stampCapture(turn);
  if (!needsWakeWord) setStatus("thinking");
  console.log(`[echo] captured utterance -> ${wavPath}${needsWakeWord ? " (awaiting wake word)" : ""}`);

  // On a cloud provider the wake-word pass is still done locally: most captures
  // are room noise that was never addressed to Echo, and none of that should
  // leave the machine (or be paid for). The real command is re-transcribed with
  // the configured provider once the name actually matches.
  const wakeGatesCloud = needsWakeWord && cfg.voice.sttProvider === "sarvam";

  // Whether Echo listens to this turn itself rather than only reading it. The
  // bridge stands in for a brain that cannot hear; when the brain can, the
  // recording goes to it directly further down and no extra call happens here.
  const bridging = useHearingBridge(cfg, brain?.hearsAudio ?? false);

  let text = "";
  let sttEngine = "whisper";
  if (meta.transcript === undefined && !needsWakeWord) {
    meta.transcript = await finishSttStream(meta.captureStartAt, turn?.id);
  }
  if (meta.transcript !== undefined && meta.transcript.trim()) {
    text = meta.transcript;
    sttEngine = "stream";
  } else {
    try {
      // Either gate means the first pass is only there to find the wake word and
      // to hint the real one, so it stays local: cheap, offline, and nothing that
      // was never addressed to Echo leaves the machine.
      const localFirst = wakeGatesCloud || bridging;
      text = localFirst ? await transcribeLocal(wavPath, cfg) : await transcribe(wavPath, cfg);
      sttEngine = localFirst ? "whisper" : cfg.voice.sttProvider ?? "whisper";
    } catch (err: any) {
      console.error(`[echo] transcription failed: ${err?.message ?? err}`);
      send("notice", { level: "error", text: String(err?.message ?? err) });
      setStatus(idleStatus());
      return;
    }
  }
  if (turn) voiceLog.event("stt.final", { turnId: turn.id, engine: sttEngine, ms: Date.now() - t0, text: text.slice(0, 80) });
  console.log(`[echo] transcript (${Date.now() - t0}ms): ${JSON.stringify(text)}`);

  let command = text.replace(/\[.*?\]|\(.*?\)/g, "").trim();

  /**
   * Transcribe this utterance again with the configured cloud engine.
   *
   * Two callers — the wake-word gate and the hearing pass's fallback — so it
   * lives in one place. Returns null rather than throwing: a failure here must
   * leave the local transcript standing, never drop a spoken command.
   */
  const reTranscribeWithCloud = async (): Promise<string | null> => {
    try {
      const remote = await transcribe(wavPath, cfg);
      if (!remote) return null;
      const again = matchWakeWord(remote);
      return (again.matched ? again.command : remote).trim();
    } catch (err: any) {
      console.error(
        `[echo] ${cfg.voice.sttProvider} transcription failed, using local: ${err?.message ?? err}`
      );
      return null;
    }
  };

  // Whisper invents words for near-silence — "(laughing)", "Thank you.", "you".
  // These reached the brain as real commands; drop them before anything acts.
  if (isHallucination(command)) {
    console.log(`[echo] ignoring noise: ${JSON.stringify(text.trim().slice(0, 40))}`);
    if (turn) voiceLog.event("capture.discarded", { turnId: turn.id, reason: "noise" });
    // Noise inside the conversation window no longer ends the conversation —
    // that closed it on a cough. The window's own timer ends it.
    setStatus(idleStatus());
    return;
  }

  // Continuous Audio Log
  if (isRecordingMeeting) {
    const audioLogPath = join(app.getAppPath(), "audio_log.txt");
    try {
      appendFileSync(audioLogPath, `[${new Date().toISOString()}] ${command}\n`, "utf8");
    } catch (err) {
        console.error("[echo] could not append to the audio log:", (err as any)?.message ?? err);
      }
  }

  // A pending confirmation takes priority over everything, and needs no wake
  // word — Echo just asked you a direct question, so answer it.
  if (confirmations.isWaiting) {
    const answer = ConfirmationBroker.readAnswer(command);
    if (answer !== null) {
      confirmations.settle(null, answer);
      return;
    }
    // Neither yes nor no: re-ask rather than guessing at a destructive action.
    console.log(`[echo] ambiguous confirmation reply: ${JSON.stringify(command)}`);
    tts.say("Sorry — yes or no?");
    expectAnswer = true;
    if (!cfg.voice.ttsEnabled) maybeAutoListen();
    return;
  }

  if (needsWakeWord) {
    const { matched, command: rest } = matchWakeWord(text);
    if (!matched) {
      // Ordinary conversation in the room — not addressed to Echo. Stay quiet.
      console.log("[echo] no wake word — ignoring");
      setStatus(idleStatus());
      return;
    }
    // The transcript proved it: this capture is a turn.
    turn = voiceSession.beginTurn("transcript", meta.captureStartAt);
    stampCapture(turn);
    voiceLog.event("wake.detected", { turnId: turn.id, engine: "transcript", score: 1 });
    voiceLog.event("stt.final", { turnId: turn.id, engine: sttEngine, ms: Date.now() - t0 });
    console.log(`[echo] wake word matched; command = ${JSON.stringify(rest)}`);
    acknowledgeWake(turn.id);
    setStatus("thinking");

    // They only said the name: open the mic for the command.
    if (isNameOnly(rest)) {
      awaitCommand(turn);
      return;
    }
    command = rest;

    // Addressed to Echo, so the audio is worth sending to the better engine.
    // Skipped when the hearing pass is on: that reads the same recording with a
    // better ear a few lines below, and two cloud transcriptions of one spoken
    // sentence is one too many.
    if (wakeGatesCloud && !bridging) {
      const better = await reTranscribeWithCloud();
      if (better) {
        command = better;
        console.log(`[echo] re-transcribed via ${cfg.voice.sttProvider}: ${JSON.stringify(command)}`);
      }
    }
  } else {
    // A capture that started on the name being heard, a click, or speech in
    // the window. The recording begins before the name, so strip it if the
    // transcriber wrote it down — but never REQUIRE it: the detector already
    // decided this was addressed to Echo.
    const { matched, command: rest } = matchWakeWord(text);
    if (matched) command = rest;
    if (!turn) {
      turn = voiceSession.beginTurn(meta.wake ?? "manual", meta.captureStartAt);
      stampCapture(turn);
      voiceLog.event("stt.final", { turnId: turn.id, engine: sttEngine, ms: Date.now() - t0 });
    }
    if (isNameOnly(command) && meta.wake !== "answer") {
      awaitCommand(turn);
      return;
    }
  }
  awaitingCommand = null;

  // "Stop" means stop, whichever way the mic opened.
  if (isStopIntent(command)) {
    stopEverything(`you said ${JSON.stringify(command)}`);
    return;
  }

  // Hear the turn rather than only reading it. The same recording, read by a
  // model that can listen: it returns what was actually said (the local whisper
  // pass above is only a hint to it) plus a short note on HOW it was said —
  // the part a text-only brain can never recover from a transcript.
  let tone: string | undefined;
  if (bridging) {
    const audioTurn = audioTurnFor(wavPath, { enabled: true, hearsAudio: true });
    const heard = audioTurn ? await listen(audioTurn, cfg, command) : null;
    if (heard?.transcript) {
      const again = matchWakeWord(heard.transcript);
      command = (again.matched ? again.command : heard.transcript).trim();
      tone = heard.tone;
      console.log(
        `[echo] heard (${Date.now() - t0}ms): ${JSON.stringify(command)}${tone ? ` · ${tone}` : ""}`
      );
    } else {
      // The ear is what failed, so fall back to the engine it replaced rather
      // than acting on the local pass's guess at a Telugu sentence.
      const better = await reTranscribeWithCloud();
      if (better) command = better;
    }
  }

  // Whisper returns "" or markers like [BLANK_AUDIO] for silence. Say so rather
  // than going quiet, which is indistinguishable from being ignored.
  if (command.length < 2) {
    console.log("[echo] nothing intelligible in that utterance — ignoring");
    if (!needsWakeWord) send("notice", { level: "warn", text: "I didn't catch that." });
    voiceLog.event("capture.discarded", { turnId: turn.id, reason: "empty" });
    setStatus(idleStatus());
    return;
  }
  send("message", { kind: "user", text: command });
  voiceLog.event("note", { turnId: turn.id, transcript: command, wake: turn.wake });
  // A real command means the user is talking to Echo — keep (or start) the
  // conversation open so replies re-arm the mic without the wake word.
  if (conversationOn()) startConversation();

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

  // "Gemini." — just the name is the whole command. Handled here, before the
  // brain sees it, because the brain being replaced cannot be the one to decide
  // that it is being replaced.
  if (await maybeSwitchBrain(command)) return;

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
    dispatchToBrain(prompt, undefined, turn);
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

  // Let the brain hear the turn, not just read it. The transcript still goes as
  // the text of the turn — it is what the HUD shows, what memory keeps, and a
  // second opinion the model can weigh against what it hears.
  const heard = audioTurnFor(wavPath, {
    enabled: cfg.voice?.sendAudioToBrain === true,
    hearsAudio: brain.hearsAudio,
  });
  if (heard) console.log(`[echo] sending ${describeTurn(heard)} of audio to the brain`);
  // A brain that heard the turn needs no note about it; one that didn't gets
  // what the hearing pass noticed, which is the whole point of that pass.
  dispatchToBrain(heard ? command : withTone(command, tone), heard ?? undefined, turn);
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
    voiceSession.transition("confirming", "question pending");
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
      } catch (err) {
        console.error("[jarvis] could not dismiss the phone confirmation:", (err as any)?.message ?? err);
      }
    if (!approved && why === "no answer") tts.say("No answer, so I'll leave it.");
    setStatus(lastBrainStatus);
  });
}

/**
 * Conversation mode: after you wake Echo once, the session keeps a window open
 * after each reply in which speech alone starts the next turn — no wake word.
 * The window is owned by the VoiceSession (see voice/session.ts): it opens once
 * Echo has finished replying, every user turn extends it, and only its timer
 * or an explicit stop closes it. Noise no longer ends it, which used to make a
 * cough the end of the conversation.
 */
const conversationOn = () => cfg.voice?.conversationMode !== false;

function startConversation() {
  conversationWanted = true;
  voiceSession.extendWindow();
}
function endConversation(why = "stopped") {
  conversationWanted = false;
  voiceSession.closeWindow(why);
}

/**
 * Called whenever Echo falls silent (speech finished, or a turn ended with
 * nothing to say). Re-opens the mic for an answer Echo asked for, or opens the
 * conversation window so the user can simply keep talking.
 */
function maybeAutoListen() {
  if (tts.isSpeaking()) return;
  if (expectAnswer || awaitingCommand) {
    // Echo asked something, or heard only its name: open the mic explicitly
    // and give up quietly if nothing follows.
    const asked = !!awaitingCommand;
    expectAnswer = false;
    const turn = voiceSession.beginTurn("answer");
    if (awaitingCommand) awaitingCommand = { turnId: turn.id, asked: true };
    setTimeout(() => listener?.triggerListen({ turnId: turn.id, wake: "answer", noSpeechMs: asked ? 4000 : 6000 }), 250);
    return;
  }
  if (conversationOn() && conversationWanted) voiceSession.openWindow("reply finished");
}

/** Everything stops: speech, the brain, the conversation. The one path for every stop control. */
function stopEverything(why: string) {
  const heard = speech?.spokenSoFar() ?? "";
  voiceSession.cancel("stop", why);
  abortSttStreams(why);
  tts.stop();
  brain.noteInterrupted?.(heard);
  voiceLog.event("audio.stopped", { turnId: voiceSession.current?.id, why });
  brain.interrupt();
  endConversation(why);
  awaitingCommand = null;
  expectAnswer = false;
  setStatus("idle");
  // Being stopped mid-task is the user saying this was going wrong. Recording
  // it as a success would teach exactly the behaviour they just cut short.
  finishTurn("rejected", why);
  controlTelemetry.stopMainTasks();
  send("notice", { level: "info", text: "Stopped." });
}

function wireBrain() {
  brain.on("text", (t: string) => {
    console.log(`[echo] says: ${t}`);
    const live = voiceSession.brainOutputIsLive();
    voiceSession.noteBrainText(t);
    remoteRecord(`Echo: ${t}`, "jarvis");
    void telegram?.reply(t).catch((error) => console.error("[telegram] reply failed:", error));
    narrateSaid(t);
    lastAssistantText = t;
    send("message", { kind: "assistant", text: t });
    // Output the user has already cancelled is shown, never spoken: a stale
    // answer read out a moment after "stop" is the most confusing thing a voice
    // assistant can do.
    if (!live) {
      console.log("[voice] not speaking output from a cancelled turn");
      return;
    }
    // Streamed blocks were spoken sentence by sentence as they arrived; this
    // is the same text again, whole, for the consumers above. Not twice.
    if (speech?.tookDeltas()) {
      speech.ackBlock();
      return;
    }
    // Answers and questions go out immediately; unprompted observations wait
    // until the user is not mid-keystroke. Nothing is dropped — anything held
    // is released by the timer below once it is overdue.
    const now = attention.offer(t, urgencyOf(t));
    if (now) tts.say(now);
  });
  brain.on("textDelta", ({ text }: { text: string }) => {
    if (!speech || !cfg.voice.ttsEnabled) return;
    if (!voiceSession.brainOutputIsLive()) return; // cancelled: shown later, never spoken
    speech.feed(text);
  });
  brain.on("textDone", () => {
    if (speech && voiceSession.brainOutputIsLive()) speech.endBlock();
  });
  brain.on("tool", (info: { name: string; summary: string }) => {
    controlTelemetry.tool(info.name);
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
    controlTelemetry.finishTask("done");
    telegram?.finishTurn();
    voiceSession.noteBrainDone();
    // If TTS is off there is no speech-finished callback, so arm the mic now.
    maybeAutoListen();
  });
  brain.on("error", (msg: string) => {
    console.error(`[jarvis] brain error: ${msg}`);
    remoteRecord(`Error: ${msg}`, "stop");
    finishTurn("failure", msg.slice(0, 200));
    controlTelemetry.finishTask("failed");
    telegram?.finishTurn();
    send("notice", { level: "error", text: msg });
  });
}

/**
 * Remember the choice, so a restart comes back on the brain you last asked for.
 *
 * Only the one key is touched: config.json is hand-edited and full of `//`
 * comment keys, and rewriting it wholesale from a runtime object is how those
 * get quietly reordered or dropped.
 */
function persistBrainChoice(provider: Provider): void {
  const configPath = join(app.getAppPath(), "config.json");
  try {
    if (!existsSync(configPath)) return;
    const configData = JSON.parse(readFileSync(configPath, "utf8"));
    if (configData.brain === provider) return;
    configData.brain = provider;
    writeFileSync(configPath, JSON.stringify(configData, null, 2), "utf8");
  } catch (err: any) {
    // Not fatal: the brain has already changed for this session.
    console.error(`[jarvis] could not save the brain choice: ${err?.message ?? err}`);
  }
}

/**
 * Swap the brain in place, without restarting Echo.
 *
 * This used to relaunch the app — config.json rewritten, `app.exit(0)`, about
 * fifteen seconds of nothing, and every window, panel and open conversation
 * gone. For a request as light as "gemini" that is absurd, and it made the
 * feature something you avoid using.
 *
 * Three things have to happen in order, and the order is the whole trick:
 * interrupt whatever the old brain is doing, take its listeners off (an
 * EventEmitter left wired keeps speaking through the HUD long after it was
 * replaced, so every answer arrives twice), and only then build the new one.
 */
async function switchBrain(target: Provider): Promise<string> {
  const current = ((brain as any)?.provider ?? cfg.brain) as Provider;
  const label = PROVIDER_LABELS[target] ?? target;
  if (current === target) return `Already running on ${label}.`;

  const blocked = unavailableReason(target, process.env, cfg.gemini?.apiKeyEnv);
  if (blocked) return `I can't switch to ${label} — ${blocked}. Staying on ${PROVIDER_LABELS[current] ?? current}.`;

  try {
    brain?.interrupt();
  } catch {
    /* nothing in flight */
  }
  try {
    await brain?.stop();
  } catch (err: any) {
    console.error(`[jarvis] the old brain didn't stop cleanly: ${err?.message ?? err}`);
  }
  try {
    brain?.removeAllListeners?.();
  } catch {
    /* already gone */
  }

  cfg.brain = target;
  const built = createBrain(cfg);
  brain = built.brain;
  (brain as any).projectHint = (createBrainProjectHint as any).value;
  (brain as any).provider = built.provider;
  (global as any).__mainBrain = brain;
  wireBrain();
  // Claude spawns its agent subprocess up front, as it does at startup.
  if (built.provider === "claude") (brain as any).start?.();

  send("state", { provider: built.provider });
  setStatus("idle");
  lastBrainStatus = "idle";
  persistBrainChoice(built.provider);
  console.log(`[jarvis] brain switched: ${current} -> ${built.provider}`);

  // createBrain falls back to Claude rather than failing, so report what is
  // actually running instead of what was asked for.
  if (built.provider !== target) {
    return `I couldn't start ${label}, so I'm on ${PROVIDER_LABELS[built.provider] ?? built.provider}.`;
  }
  return `Now running on ${label}.`;
}

/**
 * Handle a command that is only a brain name, wherever it came from.
 *
 * Returns true when it took the command, so the caller stops: voice, typed
 * chat, phone remote and Telegram all route through here and all get the same
 * behaviour, rather than the spoken path being the only one that works.
 */
/**
 * A pending confirmation owns the next thing you SAY OR TYPE.
 *
 * The voice path has always routed "yes" to the waiting question. Typed input
 * did not: it started a fresh turn, left the question hanging until it timed
 * out into a denial, and the model — told it had been refused — asked again.
 * From the user's side that is "I keep saying yes and it keeps asking me".
 *
 * Every way into Echo goes through here now, so the answer lands wherever it
 * was typed: the HUD, the phone remote, or Telegram.
 */
function maybeAnswerConfirmation(text: string): boolean {
  if (!confirmations.isWaiting) return false;
  const answer = ConfirmationBroker.readAnswer(text);
  if (answer !== null) {
    console.log(`[jarvis] typed confirmation: ${answer ? "yes" : "no"}`);
    confirmations.settle(null, answer);
    return true;
  }
  // Neither yes nor no. Re-ask rather than guessing at something irreversible,
  // and say so in writing — the person is typing, so they may not have sound on.
  const said = "I still need a yes or no on the question above before I can go ahead.";
  console.log(`[jarvis] ambiguous typed confirmation: ${JSON.stringify(text.slice(0, 60))}`);
  send("message", { kind: "assistant", text: said });
  if (cfg.voice.ttsEnabled) tts.say(said);
  remoteRecord(`Jarvis: ${said}`, "jarvis");
  void telegram?.reply(said).catch(() => {});
  return true;
}

/**
 * Answer a memory inspection or deletion command locally, before any model.
 *
 * "What do you remember?" and "forget that" must not depend on which brain is
 * running or on a model choosing to call a tool. A deletion in particular is
 * irreversible, so it is answered by code with an exact scope and a receipt,
 * identically on Claude, Gemini and the local 3B model. Returns true when it
 * took the command.
 */
async function maybeMemoryCommand(command: string): Promise<boolean> {
  if (!isMemoryCommand(command)) return false;
  let said: string;
  try {
    await refreshScope();
    said = executeMemoryCommand(command, { scope: currentScope(), appRoot: app.getAppPath() })
      ?? "I did not understand that memory command.";
  } catch (err: any) {
    said = `That memory command failed: ${err?.message ?? err}`;
    console.error("[jarvis] memory command failed:", err);
  }
  send("message", { kind: "assistant", text: said });
  remoteRecord(`Jarvis: ${said}`, "jarvis");
  void telegram?.reply(said).catch(() => {});
  return true;
}

async function maybeSwitchBrain(command: string): Promise<boolean> {
  const target = parseBrainSwitch(command);
  if (!target) return false;

  const current = ((brain as any)?.provider ?? cfg.brain) as Provider;
  if (current !== target) {
    send("notice", { level: "info", text: `Switching to ${PROVIDER_LABELS[target] ?? target}…` });
  }
  const said = await switchBrain(target);
  send("message", { kind: "assistant", text: said });
  send("notice", {
    level: "info",
    text: current === target ? said : `${said} This is a new conversation — the old one stayed with ${PROVIDER_LABELS[current] ?? current}.`,
  });
  tts.say(said);
  remoteRecord(`Jarvis: ${said}`, "jarvis");
  void telegram?.reply(said).catch(() => {});
  return true;
}

async function wireVoice() {
  listener = new VoiceListener(cfg, player?.frameSource ?? undefined);

  // Speech detector: Silero when its model is present, the RMS level otherwise.
  const vadPath = cfg.voice.vadModel ? (isAbsolute(cfg.voice.vadModel) ? cfg.voice.vadModel : join(app.getAppPath(), cfg.voice.vadModel)) : "";
  const vad = vadPath ? await SileroVad.load(vadPath) : null;
  if (vad) listener.setVad(vad);
  console.log(`[voice] speech detector: ${vad ? "silero VAD" : "RMS level (models/silero_vad.onnx not loaded)"}`);

  // Wake word: a detector on the raw audio when one can be built, the
  // transcript matcher otherwise (and alongside, if wakeTranscriptFallback).
  try {
    const wake = await createWakeDetector(cfg, app.getAppPath());
    if (wake) listener.setWakeDetector(wake);
    console.log(`[voice] wake word: ${wake ? wake.name : "transcript match (no acoustic detector available)"}`);
  } catch (err: any) {
    console.error(`[voice] wake detector unavailable: ${err?.message ?? err}`);
  }

  listener.on("ready", (wakeEnabled: boolean, engine: string) => {
    console.log(
      wakeEnabled
        ? `[echo] voice ready — wake word "Echo" is ACTIVE (${engine})`
        : "[echo] voice ready — wake word OFF. Click the reactor core or press ⌘⇧J to talk."
    );
    send("state", { wakeEnabled, provider: (brain as any).provider ?? cfg.brain });
    send("notice", {
      level: "info",
      text: wakeEnabled
        ? 'Listening. Say "Echo" to wake me.'
        : "Push-to-talk ready. Click the reactor core or press ⌘⇧J to talk.",
    });
  });
  listener.on("discarded", (reason: string, meta?: { turnId?: string; wake?: WakeKind; captureStartAt?: number }) => {
    console.log(`[echo] audio discarded: ${reason}`);
    if (meta?.captureStartAt !== undefined) {
      sttStreams.get(meta.captureStartAt)?.stream.abort();
      sttStreams.delete(meta.captureStartAt);
    }
    if (meta?.turnId) voiceLog.event("capture.discarded", { turnId: meta.turnId, reason });
    if (/^no speech/.test(reason) && meta?.turnId) {
      // The name with nothing after it. Ask once, then let it go.
      if (awaitingCommand?.turnId === meta.turnId && !awaitingCommand.asked) {
        send("notice", { level: "info", text: "Yes?" });
        tts.say("Yes?"); // speech end → maybeAutoListen re-arms once more
        return;
      }
      awaitingCommand = null;
      setStatus(idleStatus());
      return;
    }
    // Only worth telling the user when they explicitly asked to be heard;
    // in always-on mode this fires constantly on room noise.
    if (/peak level/.test(reason) && meta?.wake && meta.wake !== "transcript") {
      send("notice", { level: "warn", text: `I couldn't hear you — ${reason}` });
      setStatus(idleStatus());
    }
  });
  // A microphone that has gone deaf is the one failure the user cannot see:
  // the HUD still says "listening" and nothing is being heard. Say it.
  listener.on("deaf", (was: string, now: string | null) => {
    if (now) {
      console.log(`[echo] "${was}" went silent — switched to "${now}"`);
      send("notice", { level: "warn", text: `${was} went silent. Listening on ${now} now.` });
    } else {
      console.warn(`[echo] every input is silent — last tried "${was}"`);
      send("notice", {
        level: "error",
        text: "I can't hear anything from any microphone. Check the input device in System Settings.",
      });
    }
  });

  listener.on("device", (name: string) => {
    console.log(`[echo] microphone: ${name}`);
    // A headset that's connected but not being worn is a common false alarm.
    if (/airpod|headphone|headset|buds/i.test(name)) {
      send("notice", {
        level: "warn",
        text: `Listening through ${name}. If it isn't in your ear, switch input in Sound settings.`,
      });
    }
  });
  listener.on("bargein", (level: number, bar: number) => onBargeIn(level, bar));
  listener.on("wakeCandidate", () => send("state", { wakeCandidate: true }));
  listener.on("wake", (det: { engine: string; score: number; at: number }) => {
    resetIdleTimer();
    const turn = voiceSession.beginTurn("acoustic", det.at);
    listener?.setCaptureTurn(turn.id);
    voiceLog.event("wake.detected", { turnId: turn.id, engine: det.engine, score: Number(det.score.toFixed(3)) });
    console.log(`[echo] wake word "Echo" detected (${det.engine})`);
    setStatus("listening");
    send("state", { wake: true });
    acknowledgeWake(turn.id);
  });
  listener.on("listening", (meta: CaptureMeta) => {
    setStatus("listening");
    startSttStream(meta);
  });
  listener.setFrameTap((frame, _at, capture) => {
    if (!capture || capture.needsWakeWord) return;
    sttStreams.get(capture.captureStartAt)?.stream.push(frame);
  });
  // Confirmed speech in an always-on capture: let the reactor react to the
  // person talking, which it never did before the transcript came back.
  listener.on("speech", () => {
    if (!tts.isSpeaking()) setStatus("listening");
  });
  listener.on("level", (n: number) => send("level", n));
  listener.on("utterance", (wav: string, needsWakeWord: boolean, meta: any) =>
    void voiceSession.enqueue("utterance", () =>
      handleUtterance(wav, needsWakeWord, {
        turnId: meta?.turnId,
        wake: meta?.wake,
        captureStartAt: meta?.captureStartAt,
        speechStartAt: meta?.speechStartAt,
        speechEndAt: meta?.speechEndAt,
      })
    )
  );
  listener.on("unavailable", (reason: string) =>
    send("notice", { level: "warn", text: reason })
  );
  listener.on("error", (msg: string) => send("notice", { level: "warn", text: msg }));

  voiceSession.on("window", (open: boolean) => {
    listener?.setSessionOpen(open);
    send("state", { session: open });
    if (!open && !tts.isSpeaking()) setStatus(lastBrainStatus);
  });

  warmUpStt(cfg); // load the STT model now, not on the first command
  await listener.start();
}

/**
 * The user spoke over Echo. Stop the voice at once and listen — but leave the
 * brain working: talking over a reply is usually a new instruction ("no, the
 * other one"), and "stop" is recognised as such when the words come back.
 */
function onBargeIn(level: number, bar: number) {
  console.log(`[echo] barge-in (level ${level} over ${bar}) — stopping speech`);
  const heard = speech?.spokenSoFar() ?? "";
  voiceSession.cancel("bargein", `level ${level} over ${bar}`);
  tts.stop();
  brain.noteInterrupted?.(heard);
  voiceLog.event("audio.stopped", { turnId: voiceSession.current?.id, level, bar });
  expectAnswer = false;
  awaitingCommand = null;
  const turn = voiceSession.beginTurn("bargein");
  listener?.triggerListen({ turnId: turn.id, wake: "bargein", noSpeechMs: 2500 });
}

/** Say anything that was held back, once the moment is right. */
function drainHeldSpeech() {
  for (const text of attention.release()) tts.say(text);
}

async function wireTts() {
  console.log("[echo] starting TTS with engine:", cfg.voice.ttsEngine);
  // The persistent player (and, with the voiceio helper, the echo-cancelled
  // microphone). Created before the listener so the listener can take its frames.
  try {
    player = await createPlayer(cfg, app.getAppPath());
    console.log(`[voice] player: ${player.name}${player.aec ? " + echo-cancelled capture" : ""}`);
    player.on("error", (m: string) => console.error(`[voice] player: ${m}`));
    player.on("started", () => voiceLog.event("audio.start", { turnId: voiceSession.brainTurnId ?? voiceSession.current?.id }));
    player.on("exit", () => console.error("[voice] player process exited"));
  } catch (err: any) {
    console.error(`[voice] player unavailable: ${err?.message ?? err}`);
  }
  tts = new Tts(cfg.voice.ttsVoice, cfg.voice.ttsEnabled, cfg.voice.ttsEngine, cfg.voice.elevenLabsVoiceId, (speaking) => {
    // The mic keeps hearing while Echo speaks (for barge-in); only capture pauses.
    listener?.setPaused(speaking);
    voiceSession.noteSpeaking(speaking);
    setStatus(speaking ? "speaking" : lastBrainStatus);
    // Echo just finished — open the mic for an answer, or the conversation window.
    if (!speaking) maybeAutoListen();
  }, { speaker: cfg.voice.sarvamSpeaker, pace: cfg.voice.sarvamPace });
  tts.onAudioStart((text) =>
    voiceLog.event("tts.first_audio", { turnId: voiceSession.brainTurnId ?? voiceSession.current?.id, sentence: text.slice(0, 40) })
  );
  if (player && cfg.voice.ttsStreaming !== false && ["sarvam", "elevenlabs", "mac"].includes(cfg.voice.ttsEngine ?? "mac")) {
    speech = new SpeechStream(cfg, player, { maxSentences: () => cfg.voice.maxSpokenSentences ?? 6 });
    speech.on("sentence", (text: string, i: number) => voiceLog.event("llm.text", { turnId: voiceSession.brainTurnId ?? undefined, sentence: text.slice(0, 50), chars: i }));
    speech.on("capped", () => console.log("[voice] spoken reply capped — the rest stays on screen"));
    tts.attachStream(speech);
    console.log("[voice] streaming speech: on");
  } else {
    console.log("[voice] streaming speech: off (file path)");
  }
  // Share this one voice with background features (companion mode, watchers) so
  // they speak through the real pipeline instead of shelling out to `say`.
  setActiveTts(tts);
}

/** Route typed text from either the HUD bridge or the control panel identically. */
function handleTypedInput(value: unknown): void {
  const clean = String(value ?? "").trim();
  if (!clean) return;
  send("message", { kind: "user", text: clean });
  if (maybeAnswerConfirmation(clean)) return;
  void maybeMemoryCommand(clean).then(async (handled) => {
    if (handled) return;
    if (await maybeSwitchBrain(clean)) return;
    await refreshScope();
    beginLearnedTurn(clean);
    dispatchToBrain(clean, undefined, voiceSession.beginTurn("typed"), "text");
  });
}

function controlRuntime(): ControlRuntime {
  const provider = (((brain as any)?.provider ?? cfg.brain) as Provider);
  const configured = loadMcpConfig();
  return {
    voiceEnabled: cfg.voice.ttsEnabled,
    agents: swarm.list(),
    missions: swarm.listMissions(),
    models: (["claude", "gemini", "ollama"] as Provider[]).map((id) => ({
      id,
      label: PROVIDER_LABELS[id] ?? id,
      model: id === "claude" ? cfg.claude.model : id === "gemini" ? cfg.gemini.model : cfg.ollama.model,
      active: id === provider,
      available: !unavailableReason(id, process.env, cfg.gemini.apiKeyEnv),
      ...(unavailableReason(id, process.env, cfg.gemini.apiKeyEnv)
        ? { reason: unavailableReason(id, process.env, cfg.gemini.apiKeyEnv)! }
        : {}),
    })),
    connections: Object.keys(configured).map((name) => {
      const lastActivityAt = controlTelemetry.connectionActivity(name);
      return { name, status: lastActivityAt ? "active" : "configured", tools: null, ...(lastActivityAt ? { lastActivityAt } : {}) };
    }),
  };
}

async function handleControlAction(action: ControlAction): Promise<{ ok: boolean; message?: string }> {
  switch (action.type) {
    case "command": {
      const command = String(action.text ?? "").trim();
      if (!command) return { ok: false, message: "Enter a command first." };
      handleTypedInput(command);
      return { ok: true };
    }
    case "listen":
      resetIdleTimer(); listener?.triggerListen(); return { ok: true, message: "Listening." };
    case "interrupt":
      stopEverything("user interrupted from control panel"); return { ok: true, message: "Current run stopped." };
    case "toggle-voice":
      cfg.voice.ttsEnabled = !cfg.voice.ttsEnabled;
      tts.setEnabled(cfg.voice.ttsEnabled);
      return { ok: true, message: `Spoken responses ${cfg.voice.ttsEnabled ? "enabled" : "muted"}.` };
    case "settings":
      openSetupWindow(); return { ok: true };
    case "neural":
      openNeuralCore(); return { ok: true };
    case "osiris":
      await openOsirisPanel(); return { ok: true };
    case "refresh-connections":
      return { ok: true, message: "Connection configuration refreshed." };
    case "switch-model": {
      const target = action.provider as Provider;
      if (!(["claude", "gemini", "ollama"] as string[]).includes(target)) return { ok: false, message: "Unknown model route." };
      const before = ((brain as any)?.provider ?? cfg.brain) as Provider;
      const message = await switchBrain(target);
      const after = ((brain as any)?.provider ?? cfg.brain) as Provider;
      return { ok: after === target, message: before === target ? `Already routed to ${PROVIDER_LABELS[target]}.` : message };
    }
    case "spawn-agent": {
      const goal = String(action.goal ?? "").trim();
      if (!goal) return { ok: false, message: "Describe the task to assign." };
      const result = swarm.spawn(goal, {
        makeBrain: (identity, task) => {
          const clone = createBrain(cfg, {
            identity,
            maxRecoveryAttempts: task?.budget.maxRecoveryAttempts,
            limits: { maxIterations: task?.budget.maxIterations },
          }).brain as any;
          clone.projectHint = (createBrainProjectHint as any).value;
          return clone;
        },
      });
      return result.ok ? { ok: true, message: `${result.name} deployed.` } : { ok: false, message: result.reason ?? "Agent could not be deployed." };
    }
    case "assign-agent": {
      const name = String(action.name ?? "").trim();
      const goal = String(action.goal ?? "").trim();
      if (!name || !goal) return { ok: false, message: "Choose an agent and enter a task." };
      return swarm.send(name, goal) ? { ok: true, message: `Task assigned to ${name}.` } : { ok: false, message: `${name} is not active.` };
    }
    default:
      return { ok: false, message: "Unsupported control action." };
  }
}

function wireIpc() {
  ipcMain.on("renderer:error", (_e, payload) => recordRendererError(payload ?? { kind: "unknown", message: "empty report" }));
  ipcMain.on("listen", () => { resetIdleTimer(); listener?.triggerListen(); });
  ipcMain.on("user-typing", () => { resetIdleTimer(); attention.noteTyping(); });
  ipcMain.on("open-control-panel", () => openControlPanel(win));
  // The overlay is click-through except when the pointer is over its one
  // interactive control (the QR's close button), which asks for clicks here.
  ipcMain.on("overlay:set-interactive", (_e, on: boolean) => setOverlayInteractive(Boolean(on)));
  ipcMain.on("orbital:close", () => closeOrbitalPanel());
  // The Osiris grid stays up until it is told otherwise; these three are the
  // only things in the app that move it, and all three are a deliberate act.
  ipcMain.on("osiris:close", () => closeOsirisPanel());
  ipcMain.on("osiris:reload", () => void reloadOsiris());
  ipcMain.on("osiris:toggle-pin", () => { if (isOsirisOpen()) setOsirisPinned(!isOsirisPinned()); });
  ipcMain.on("neural:close", () => closeNeuralCore());
  ipcMain.on("send-text", (_e, text: string) => handleTypedInput(text));
  ipcMain.on("interrupt", () => stopEverything("user interrupted"));
}

function wireShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+J", () => listener?.triggerListen());
  globalShortcut.register("CommandOrControl+Shift+.", () => stopEverything("user interrupted (hotkey)"));
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
  voiceLog.init(app.getAppPath());
  voiceSession = new VoiceSession({ windowMs: () => (cfg.voice?.conversationMode === false ? 0 : cfg.voice?.conversationWindowMs ?? 12000) });
  voiceSession.on("turnSummary", (summary) => console.log(`[voice] ${describeSummary(summary)}`));
  console.log(`[jarvis] config loaded (brain=${cfg.brain})`);

  // Teach-by-demonstration capture. Opt-in: it is the one part of Jarvis that
  // deliberately stores what was on screen, so it should never start unasked.
  configureLearning(cfg.learning ?? { enabled: false, captureScreens: true, maxStepsPerTurn: 0 });
  if (cfg.learning?.enabled) {
    void datasetStats()
      .then((s) => console.log(`[learn] recording trajectories — ${describeStats(s)}`))
      .catch(() => {});
  }
  createWindow();
  createOverlayWindow();

  // Decide now whether an Osiris checkout is running here, so the first "show me
  // the world" opens on the right instance without pausing to scan for one.
  void import("./tools/osiris-intel.js").then(({ warmOsiris }) => warmOsiris());

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

  // Bring the Memory OS up before the brain, because the brain reads from it on
  // its very first turn. Every step here is survivable: a memory layer that
  // cannot start must not stop Echo from answering, it must say so loudly and
  // leave the assistant working without it.
  try {
    ProviderMemoryContext.enabled = cfg.memory?.enabled !== false;
    ProviderMemoryContext.cloudRecall = cfg.memory?.cloudRecall !== false;
    if (ProviderMemoryContext.enabled) {
      if (cfg.memory?.importLegacy !== false) {
        // One-time, idempotent, and a COPY: the legacy files are left exactly
        // where they are, so this is reversible by turning the flag off.
        const { imported, skipped } = memoryService.importLegacy({ skillsFile: join(app.getAppPath(), "skills", "skills.json") });
        if (imported || skipped) console.log(`[jarvis] memory os: imported ${imported} legacy record(s), skipped ${skipped}`);
      }
      const days = Number(cfg.memory?.retentionDays ?? 0);
      if (days > 0) {
        // Retention is dated from when it was switched on, so turning it on
        // today never silently deletes an archive kept since last year.
        const marker = join(memoryRoot(), "retention-activated.json");
        if (!existsSync(marker)) atomicWrite(marker, JSON.stringify({ activatedAt: new Date().toISOString(), episodeDays: days }));
        const { activatedAt } = JSON.parse(readFileSync(marker, "utf8"));
        const expired = enforceRetention({ enabled: true, activatedAt, episodeDays: days });
        if (expired) console.log(`[jarvis] memory os: retention removed ${expired} expired record(s)`);
      }
      const total = memoryService.list(undefined, { includeInactive: true }).length;
      console.log(`[jarvis] memory os: ${total} record(s) at revision ${memoryService.revision()}, cloud recall ${ProviderMemoryContext.cloudRecall ? "on" : "off"}`);
    } else {
      console.log("[jarvis] memory os: disabled by config; the brain runs without recall");
    }
  } catch (err) {
    console.error("[jarvis] memory os unavailable — Echo will run WITHOUT memory this session:", err);
  }

  const startupRecoveries = pendingRecoveries();
  const startupMainTasks = startupRecoveries.filter((task) => task.actor.kind === "main");
  const startupMainTask = startupMainTasks.at(-1);
  const recoveryProvider = startupMainTask?.provider;
  const startupCfg: JarvisConfig = recoveryProvider === "claude" || recoveryProvider === "gemini" || recoveryProvider === "ollama"
    ? { ...cfg, brain: recoveryProvider }
    : cfg;
  const built = createBrain(startupCfg);
  brain = built.brain;
  (brain as any).projectHint = (createBrainProjectHint as any).value;
  (brain as any).provider = built.provider;
  (global as any).__mainBrain = brain;
  // The switch_brain tool runs inside whichever brain is being replaced, so it
  // reaches the swap the same way the tools reach the brain itself — through a
  // global, because importing main.ts from the registry would be a cycle.
  (global as any).__switchBrain = switchBrain;
  console.log(`[jarvis] brain ready (provider=${built.provider})`);
  wireBrain();
  telegram = startTelegram(cfg, handleTelegramCommand);
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

  await wireTts();
  // Held speech is checked on a timer so nothing waits indefinitely.
  setInterval(drainHeldSpeech, 4000);
  wireConfirmations();
  wireIpc();
  wireControlPanel({ runtime: controlRuntime, action: handleControlAction });
  wireShortcuts();

  // Give the renderer a beat to attach listeners before we start emitting.
  uiLoaded.then(() => {
    console.log("[jarvis] HUD loaded");
    // Include the saved skin, so the reactor the user last chose is the one
    // that appears — not a flash of the default before it corrects itself.
    send("state", { status: "idle", provider: built.provider, skin: cfg.hud?.skin ?? "classic" });
    if (process.env.JARVIS_NO_VOICE) {
      send("notice", { level: "info", text: "Voice disabled (JARVIS_NO_VOICE). Type commands below." });
    } else {
      void wireVoice();
    }

    // A process kill leaves the checkpoint in `running`. Restore the main Echo
    // and every named clone through fresh brains; each recovery prompt carries
    // completed and uncertain actions so mutable tools are verified, not
    // blindly repeated.
    if (startupMainTask && (brain as any).recoverFromCheckpoint?.(startupMainTask)) {
      console.warn(`[echo:recovery] resuming Echo task ${startupMainTask.taskId} after process restart`);
      send("notice", { level: "info", text: "Echo found an interrupted task and is continuing from its checkpoint." });
    }
    for (const task of startupRecoveries.filter((item) => item.actor.kind === "clone")) {
      const recovered = swarm.recover(task, {
        makeBrain: (identity) => {
          const provider = task.provider;
          const cloneCfg: JarvisConfig = provider === "claude" || provider === "gemini" || provider === "ollama"
            ? { ...cfg, brain: provider }
            : cfg;
          const clone = createBrain(cloneCfg, { identity }).brain as any;
          clone.projectHint = (createBrainProjectHint as any).value;
          return clone;
        },
      });
      if (recovered) console.warn(`[echo:recovery] resumed ${task.actor.name} task ${task.taskId}`);
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
    // Each of these polls the SCREEN forever, so "is Ollama up?" is the wrong
    // question — a reachable port is not a request to be watched. Gating on that
    // alone started shadow's 15-second full-screen OCR automatically and drove
    // this machine to a load average of 14 while Echo looked idle. They are
    // opt-in now, and the Ollama check only decides whether an opted-in helper
    // can actually work.
    const want = cfg.helpers ?? { shadow: false, ghost: false, autoDebug: false };
    if (want.shadow || want.ghost || want.autoDebug) {
      void ollamaReachable(cfg.ollama?.host).then((up) => {
        if (!up) {
          console.log("[jarvis] helpers are on in config but Ollama is not reachable — staying off");
          return;
        }
        const on: string[] = [];
        if (want.ghost) { startGhostMode(tts); on.push("ghost"); }
        if (want.autoDebug) { startAutoDebug(tts); on.push("auto-debug"); }
        if (want.shadow) { startShadowMode(tts, cfg.helpers?.shadowIntervalSeconds); on.push("shadow"); }
        console.log(`[jarvis] background helpers on: ${on.join(", ")}`);
      });
    }

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
  telegram?.stop();
  stopSttServer(); // don't leave the whisper server holding the model
  player?.dispose(); // and the audio helper
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
  // Quitting is the one thing other than an explicit "close it" that takes the
  // grid down — leaving a window behind a dead app would be worse.
  closeOsirisPanel();
  closeNeuralCore();
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
    if (maybeAnswerConfirmation(text)) return;
    beginLearnedTurn(text);
    brain?.send(text, undefined, { modality: "text", scope: currentScope() });
  } catch (e) {
    console.error("[jarvis] phone command failed:", e);
  }
});

// Telegram uses the exact same command boundary as the phone remote, so it
// receives the same safety gates, HUD visibility, and spoken replies.
function handleTelegramCommand(text: string): void {
  try {
    console.log(`[jarvis] Telegram command: ${text}`);
    send("message", { kind: "user", text: `✈️ ${text}` });
    if (maybeAnswerConfirmation(text)) return;
    void maybeMemoryCommand(text).then(async (handled) => {
      if (handled) return;
      if (await maybeSwitchBrain(text)) return;
      await refreshScope();
      beginLearnedTurn(text);
      dispatchToBrain(text, undefined, voiceSession.beginTurn("typed"), "text");
    });
  } catch (e) {
    console.error("[jarvis] Telegram command failed:", e);
  }
}

app.on("will-quit", shutdown);
// Reachable from the switch_brain tool, which force-exits and would otherwise
// leave the speech process and whisper server orphaned.
setShutdownHandler(shutdown);

// Keep running in the background even with no windows (it's a menu-bar-style agent).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
