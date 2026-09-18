# Echo Mac

A voice-activated, always-on-screen autonomous desktop assistant for macOS. A glowing
floating HUD stays above every other app. Call it by name, ask it to do something, and it
**sees your screen and drives your Mac** — clicking, typing, opening apps, browsing, and
writing/running code — narrating each step so you can watch it work.

The core loop is: **hear → see the screen → think → act → speak.**

```
 mic ──► wake word "Echo" (acoustic detector) ──► streaming STT ──► BRAIN (streamed) ──► sentence chunker ──► streaming TTS ──► voiceio player + HUD
         Silero VAD decides speech/turn ends · talk over Echo to stop it (barge-in) · see "Voice pipeline" below
                                                          │
                                    ┌─────────────────────┴─────────────────────┐
                                    │  Agent brain (Claude Agent SDK or Gemini)  │
                                    │  tools: screenshot · click · type · keys · │
                                    │  scroll · open app/url  +  Bash/Read/Write │
                                    └────────────────────────────────────────────┘
```


## Voice pipeline (real-time)

Echo's voice is a streaming, interruptible front-end to the same agent: tools,
the risk gate and confirmations are untouched, only the path from the microphone
to the speaker changed.

| Stage | How | Where |
|---|---|---|
| Wake word | An acoustic detector on the raw 16 kHz frames — Porcupine (`models/wake/echo_mac.ppn` + `PICOVOICE_ACCESS_KEY`), an openWakeWord `.onnx` you train, or the built-in template spotter (`npm run enroll -- --seed`, then `npm run enroll` per person) verified by whisper. Ack pulse + 250 ms chirp within ~100 ms. | `src/voice/wake/` |
| Speech / turn end | Silero VAD per 32 ms frame (`models/silero_vad.onnx`); endpoint shortens when the streamed transcript ends in punctuation | `src/voice/vad.ts`, `listener.ts` |
| Transcription | Streamed while you speak: Sarvam realtime (`saaras:v4`, any Indian language). whisper.cpp stays as the offline fallback and the always-on transcript check. Apple on-device (`sttProvider: "apple"`, en/hi, `native/speechhelper`) is wired but macOS attributes Speech access to the *responsible* app, so it only runs once the packaged app's Info.plist carries `NSSpeechRecognitionUsageDescription` (electron-builder `extendInfo`); until then it falls back automatically. | `src/voice/stt-stream.ts`, `stt.ts` |
| Brain | Gemini `generateContentStream`, Claude partial messages, Ollama NDJSON — text fragments are spoken as they arrive; spoken turns carry a brevity contract | `src/brain/*` |
| Speech | Sentence chunker → Sarvam WS (`bulbul:v3`) / ElevenLabs WS / `say` → one persistent AVAudioEngine player (`native/voiceio`): first sentence plays while the second is written, stop is instant | `src/voice/chunker.ts`, `tts-stream.ts`, `speech-stream.ts`, `player.ts` |
| Barge-in | The helper's voice-processing (echo-cancelled) mic keeps the VAD and wake word working while Echo talks; speech over Echo stops it and starts a new turn; "stop"/"cancel" cancels the task | `listener.ts`, `main.ts` |
| Session | One state machine (`sleeping → waking → listening → thinking → speaking → active_idle`) with turn ids, a cancellation contract that never kills a running tool, and a conversation window where speech alone starts a turn | `src/voice/session.ts` |
| Logging | Every stage stamps `runs/voice/*.jsonl`; `npm run voicelog` prints per-turn "end of speech → first audio" | `src/voice/voice-log.ts` |

Tests: `npm run sessiontest chunkertest vadtest wakeenginetest voicelatencytest playertest`
(live: `sttstreamtest ttsstreamtest applestttest livetest`).

## What it can do

- **See** — `screenshot` captures the screen (downscaled to logical resolution so the
  model's pixel coordinates line up exactly with the cursor).
- **Control** — move/click/drag the mouse, type text, press shortcuts, scroll, open apps
  and URLs — any GUI app: browser, VS Code, Lightroom, Mail, streaming sites, delivery sites.
- **Edit precisely** — `set_value` sets a control to an exact value (double-click → select →
  type → Return), `press_keys` takes a `repeat` count to step a slider N notches, and
  `scroll` can hover a specific control first to scrub it. This is what makes
  *"increase brightness by 20%"* land on the number instead of near it.
- **Verify** — the brain is instructed to screenshot *after* acting and self-correct, rather
  than firing off long blind sequences.
- **Ask** — when a task depends on something only you know ("what kind of app should I
  build?"), it asks out loud and ends its turn; the mic re-opens automatically so you just
  answer. The session is continuous, so it keeps full context.
- **Code** — inherits the Claude Agent SDK's built-in `Bash`, `Read`, `Write`, `Edit`,
  `Grep` tools, so it reads, writes, compiles and runs code directly (no clicking around
  the editor needed).
- **Talk** — speaks replies aloud (macOS `say`) and shows a live transcript + action log.
- **Phone remote** — scan the QR code Echo shows after you say “open phone remote”; send typed or spoken commands, see the Mac screen, and control it from the phone. It uses a password and works anywhere when both devices use Tailscale.
- **Telegram** — optionally chat with Echo from a private Telegram bot; only the chat IDs you allow can issue commands.
- **World grid** — *"show me the world"* puts [Osiris](https://github.com/simplifaisoul/osiris) on screen: a live globe of flights, earthquakes, fires, satellites, CCTV, undersea cables, conflict zones and news. Echo drives its layers and camera, reads its feeds aloud, and leaves the panel up until you say to close it.

### Operating an app it has never seen

There is no per-app code. Any application is driven by the same loop the brain is taught in
`src/brain/types.ts`: **look** (screenshot) → **locate** the control → **read its current
value** (needed for relative requests like "+20%") → **choose the most reliable input**
(exact field / stepped keys / drag / click) → **act** → **verify** with another screenshot.

That generalizes to things like Lightroom (read the slider's number, compute the target,
`set_value` it, verify) and AI/coding apps such as Antigravity or Cursor (open it, start a
chat, expand your rough idea into a proper build prompt, type it, submit, then watch the
output and keep going).

### Changing brains by saying the name

*"Gemini."* — that's the whole command. So is *"switch to Claude"*, *"use the local model"*,
*"sonnet"*, *"llama3.2"*. The swap is **live**: no restart, the windows and panels stay put,
and it takes about as long as the sentence did. The choice is written back to `config.json`,
so a restart comes back on the brain you last asked for.

It deliberately only fires when the command is a name and nothing else. *"Ask Claude what it
thinks"*, *"open Claude Code"* and *"is Claude better than Gemini"* are ordinary commands and
go to the brain untouched — switching by accident would throw away the conversation you were
in the middle of, which is the one mistake here worth engineering against.

Two things to know: the new brain starts with a fresh conversation (long-term memory
persists; the current thread doesn't), and asking for a brain whose key is missing changes
nothing — it says why and stays where it is.

### Hearing, not just transcribing

By default a voice assistant's model never hears you: audio becomes a string, and
everything that wasn't a word — tone, emphasis, hesitation, whether "no, stop" was shouted
or muttered — is gone before the brain sees anything. `voice.sendAudioToBrain` keeps it.

The recording of the turn goes to the brain *with* its transcript, and the transcript is
demoted to a second opinion. Two routes, picked automatically:

- **Gemini brain** — the model listens to the recording itself. No extra call; the audio is
  dropped from the conversation after its first reply, so one spoken command doesn't
  re-upload itself through a hundred agent-loop iterations.
- **Claude or Ollama brain** — they take text, so a short Gemini *hearing pass* reads the
  same recording and returns what was actually said plus a note on how. It **replaces** the
  cloud transcription rather than adding a round trip, so the latency is the one Echo was
  already paying. Needs `GEMINI_API_KEY`; without one, nothing changes.

Measured on a real recording, with a deliberately wrong hint fed in as the "local
transcript":

```
hint  : "echo open my email and check if praveen replied about the osiris built"
heard : "Echo, open my email and check if Praveen replied about the Osiris build."

hint  : "no no stop don't delete that folder"
heard : "No, no, stop. Don't delete the folder."   (heard: urgent, firm)
```

That second line is the point: the brain now knows it was said urgently, which is exactly
the kind of turn where it should stop and ask rather than proceed.

**Off by default**, because it changes where audio goes: on the local-whisper route nothing
spoken currently leaves the machine at all. The wake-word pass stays local either way, so
speech that was never addressed to Echo is still never sent.

### The Osiris grid

[Osiris](https://github.com/simplifaisoul/osiris) is an MIT-licensed OSINT dashboard — a
MapLibre globe layered with live flights, earthquakes, fires, satellites, 17,000+ CCTV
cameras, undersea cables, conflict zones and 24/7 news. Echo hosts it in its own window and
drives the real thing rather than a picture of it:

- **Show it** — *"show me the world map"*, *"open Osiris with flights and earthquakes"*.
  The panel **stays on screen until you say to close it**; nothing in Echo closes it for you
  except quitting the app.
- **Layers** — *"add fires"*, *"turn off the cameras"*, *"just the conflict zones"*. Layers
  are set through Osiris's own `?layers=` contract — the same one its share links use — so
  the state Echo sets is a state Osiris itself defines.
- **Camera** — *"show me Ukraine"*. Places are geocoded through Osiris's own search service,
  then flown to directly on a local checkout (a dev build exposes its map handle) or through
  the site's search box otherwise.
- **Ask it things** — *"any earthquakes today?"*, *"what's the space weather?"*, *"give me a
  world briefing"*. Echo reads the same `/api/*` feeds the globe reads and answers out loud;
  the panel does not need to be open for this.

By default it uses the project's hosted grid at <https://osirisai.live>. Running your own
copy is optional and better — no Cloudflare rate limit, an exact camera, and your own
OpenSky/N2YO keys filling in the credential-gated feeds:

```bash
npm run osiris:setup    # clone it into vendor/osiris and install (one time)
npm run osiris:start    # serve it on http://localhost:3000
```

Echo finds a running local copy on its own (`osiris.preferLocal`, on by default): it checks
ports 3000–3002 and only accepts one whose page identifies as Osiris, so another dev server
on 3000 is skipped rather than mistaken for it. Pin one instance with `osiris.baseUrl` in
`config.json`, or `OSIRIS_URL` for a single run. The layers it opens with live in
`osiris.defaultLayers`.

### Platform scope — read this

**macOS only today.** The control layer is deliberately native: `cliclick`, `screencapture`,
`sips`, `osascript`, and `say`. Nothing here runs on Windows yet. Porting means writing a
Windows backend behind `src/tools/computer-actions.ts` (the rest of the stack — brain,
registry, voice, HUD — is platform-agnostic and would carry over unchanged).

## Architecture

| Layer | File(s) | Role |
|---|---|---|
| Electron shell / HUD | `src/main.ts`, `renderer/*` | Always-on-top floating window, orchestration, IPC |
| Brain (provider) | `src/brain/*` | `claude.ts` = Agent SDK streaming session; `gemini.ts` = manual function-calling loop; swap via `config.json` |
| Computer tools | `src/tools/*` | One tool registry (`registry.ts`) both brains share; actions in `computer-actions.ts` via `cliclick` / `screencapture` / AppleScript |
| Voice | `src/voice/*` | `listener.ts` (mic + Porcupine wake word), `stt.ts` (whisper.cpp), `tts.ts` (`say`) |

The Claude brain runs **one long-lived `query()`** fed by a streaming async iterable, so
the whole conversation is a single continuous session. Its computer tools are an
**in-process MCP server** (`createSdkMcpServer` + `tool()`) — no subprocess, and the
`screenshot` tool returns a real image block. It authenticates by **riding your existing
Claude Code login** — no API key needed.

## Setup

```bash
npm install          # installs deps + the optional native voice addons
npm run build        # bundles src/ -> dist/ with esbuild
npm start            # build + launch the HUD
```

Prerequisites (macOS, Apple Silicon):

```bash
brew install cliclick whisper-cpp     # mouse/keyboard control + local speech-to-text
# Whisper model (≈150MB) — already placed at models/ggml-base.en.bin if you ran the setup;
# otherwise:
curl -L -o models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

### Log in the brain (required)

```bash
npm run login     # opens the bundled Claude Code CLI -> type /login and sign in
```

The Agent SDK ships its own Claude Code CLI, so you do **not** need `claude` on your PATH.
But it authenticates through that CLI's own credential store, which is **separate from the
Claude desktop app** — being signed into the desktop app is not enough. Log in once with the
command above and it uses your existing Claude subscription (no API key).

Symptom if you skip it: Echo launches, the HUD works, and every message — spoken or typed —
gets no reply, because the brain process exits immediately with `Invalid API key`.

### Check everything at once

```bash
npm run doctor        # binaries, Whisper model, and whether the brain can authenticate
npm run permissions   # macOS Screen Recording / Accessibility / Microphone
```

### Grant macOS permissions (required)

```bash
npm run permissions          # report what's granted
npm run permissions -- --fix # also open the panes that need action
```

Three permissions matter, all under **System Settings → Privacy & Security**:

| Permission | Why | If missing |
|---|---|---|
| **Screen Recording** | `screenshot` can see the screen | Echo is blind — it captures only the wallpaper |
| **Accessibility** | `cliclick` can move the mouse and type | **Fails silently** — Echo narrates actions that never land |
| **Microphone** | hearing you | No voice; the HUD text box still works |

**Which app do I grant?** macOS attaches these to the app that *launches* Echo, not to
Echo itself. Running `npm start` from a terminal means granting your **terminal app**
(Terminal, iTerm, Ghostty…) and/or **Electron** at:

```
node_modules/electron/dist/Electron.app
```

In the Settings pane click **+**, press **Cmd+Shift+G**, paste that path, add it. The surest
route is simply to run `npm start` and let macOS prompt you — the dialog names the exact app.

> **Permissions only take effect on a fresh launch.** After granting, fully quit Echo
> (and the terminal, if you granted the terminal) and start again.

Accessibility is the one that bites: without it screenshots still work, so Echo looks
like it's working while nothing it clicks or types actually happens.

## Using it

- **Wake word:** say **"Echo"**, then your command (needs a Picovoice key, below).
- **Push-to-talk:** click the orb or press **⌘⇧J**, speak, and it endpoints on silence.
- **Type:** use the text box in the HUD — always works, even with no mic/keys.
- **Stop:** press **⌘⇧.** or the ◼ button to interrupt speaking/acting.

Examples: *"open the Titanic trailer on YouTube and play it"*, *"look at my screen and
suggest a fix for this code"*, *"finish the half-written function in the open file"*.

## Configuration

Copy `config.example.json` to `config.json` and edit. Key fields:

- `brain`: `"claude"` (default), `"gemini"` or `"ollama"` — the brain it starts on. You can
  change it while it's running by just saying the name (see below), and the choice is saved
  back here.
- `claude.model`: e.g. `claude-opus-4-8`.
- `gemini.model` + `GEMINI_API_KEY` env var: to use Gemini instead. If the key is missing
  it falls back to Claude automatically.
- `voice.ttsVoice`: any macOS voice (`say -v '?'` lists them; `Daniel` is a good default).
- `voice.wakeWord` + `PICOVOICE_ACCESS_KEY` env var: enables the "Echo" wake word via
  Picovoice Porcupine (free key at <https://console.picovoice.ai>). Without a key, the app
  runs in push-to-talk mode.

### Environment variables

```bash
export PICOVOICE_ACCESS_KEY=...   # optional — enables the "Echo" wake word
export GEMINI_API_KEY=...         # optional — only if brain: "gemini"
export TELEGRAM_BOT_TOKEN=...     # optional — BotFather token for private Echo chat
export ECHO_LOG_DIR="/path/to/echo-runs"  # optional — full durable journal; enabled by default
export ECHO_FULL_LOG=0                    # optional — metadata only; disables task reconstruction
export ECHO_RECOVERY_ATTEMPTS=3           # optional — automatic retries after an incomplete stop
export ECHO_LLM_TIMEOUT_MS=120000         # optional — recover a stuck model request
export ECHO_TOOL_TIMEOUT_MS=120000        # optional — stop waiting forever on a stuck tool
export ECHO_REPLAY_DIR="$HOME/.echo/replays"  # optional — separate exact replay recordings
export OSIRIS_URL=http://localhost:3000       # optional — pin which Osiris instance to use
```

### Agent failure replay

Echo writes a crash-tolerant, full journal to `Echo Mac/runs/` (or `ECHO_LOG_DIR`) by
default. Every main run is named `Echo--…`; background workers are named
`Echo Clone 1--…`, `Echo Clone 2--…`, and so on. Each directory contains `events.jsonl`,
redacted content-addressed payload blobs, and `checkpoint.json`. The tape includes the
original task, provider exchanges, tool arguments/results/errors, iteration exits and hang
heartbeats. Use `Echo Mac/check-run.sh` to print the latest actor, task, recovery attempt,
and exit diagnosis. Set `ECHO_FULL_LOG=0` if a metadata-only trace is more important than
automatic reconstruction of an interrupted task.

When a model stops mid-task, a request/tool times out, or the provider stream closes, Echo
starts a separate recovery attempt from the checkpoint instead of reporting a false turn
end. After a process crash, app startup discovers checkpoints left in `running` state and
restores the main Echo plus named clones. Completed actions are passed to the fresh brain;
an action that began without a recorded result is marked uncertain and must be verified
against the current screen/files before it can be repeated. User interrupts are always
treated as cancellations and are never auto-resumed. Recovery is capped (three retries by
default) so a permanently broken service cannot loop forever.

Set `ECHO_REPLAY_DIR` before starting Echo to put exact replay recordings in a separate
directory. Ordinary run journals already contain the same payload boundaries; the replay
variable is useful when keeping a dedicated cassette set. Secret-shaped fields are
redacted before bytes are written.

```bash
ECHO_REPLAY_DIR="$HOME/.echo/replays" npm start
```

Replay tooling in `src/agent-replay/` can load a recording, return recorded tool values
without re-executing side effects, flag the first request or tool mismatch, and build the
data behind a “why did this end?” panel. Gemini and Ollama recordings can be replayed
faithfully with the original provider response and tool results - no model or tool is
called live. Claude recordings use safe presentation playback because the installed Agent
SDK does not expose a transport/cassette hook; Echo never starts a live Claude query in
that mode.

```bash
# Run the exact provider recorded in RUN_DIR. A new trace is written separately
# so it can be compared with the original.
ECHO_REPLAY_RUN="/absolute/path/to/RUN_DIR" \
ECHO_REPLAY_OUTPUT_DIR="$HOME/.echo/replays/replay-output" \
npm start

# Counterfactual mode: replace one call, then stop at the first new trajectory.
ECHO_REPLAY_RUN="/absolute/path/to/RUN_DIR" \
ECHO_REPLAY_OVERRIDE_JSON='{"target":{"type":"tool","callId":"CALL_ID"},"replaceWith":{"text":"forced timeout"}}' \
npm start
```

Replays deliberately stop as soon as a counterfactual changes the trajectory. They never
fall through to an unrecorded live model response or a real tool call.

### Phone and Telegram access

For the phone remote, tell Echo “set a remote password” and then “open phone remote.”
Scan the QR code and sign in. Echo speaks replies aloud from the Mac; the phone also shows the conversation and accepts its own microphone input. Install Tailscale on both devices for access away from the same Wi-Fi.

To enable Telegram, create a bot with BotFather, find your numeric chat ID, then add this to `Echo Mac/config.json` (keep the token in your shell environment, never in the file):

```json
{
  "telegram": {
    "enabled": true,
    "botTokenEnv": "TELEGRAM_BOT_TOKEN",
    "allowedChatIds": ["YOUR_NUMERIC_CHAT_ID"]
  }
}
```

Restart Echo and send `/start` to the bot. Replies appear in Telegram and are spoken on the Mac through Echo’s configured voice.

## Development

```bash
npm run dev        # esbuild watch mode
npm run typecheck  # tsc --noEmit
npm run check      # plumbing self-test (MCP tools, Gemini schema, screen, Whisper STT)
ECHO_NO_VOICE=1 npm start   # launch without the mic (type-only) — handy for quick checks
npx esbuild src/_replaytest.ts --bundle --platform=node --format=esm --target=node20 --packages=external --outfile=/tmp/echo-replaytest.mjs && node /tmp/echo-replaytest.mjs
```

## Safety notes

- The Claude brain runs with `permissionMode: "bypassPermissions"` so it can act without a
  prompt on every click — that's the point of an autonomous assistant. Every action is
  shown in the HUD action log as it happens.
- It will **not** type passwords, card numbers, or other credentials. When a task needs a
  login or a payment authorization, it stops and asks you to do that step yourself.
- Everything runs locally except the model inference (Claude/Gemini) and any browsing the
  agent does on your behalf.
