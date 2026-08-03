# Jarvis Tool Registry

### check_health
Check the health of the Jarvis system. This verifies native binaries, running servers, AI models, and APIs. Use this when the user asks you to check your health or look for bugs/inconsistencies.

### screenshot
Capture the current screen and see it as an image. Call this FIRST whenever you need to understand what is on screen before acting. The image is at the display's logical resolution, so pixel coordinates in the image map 1:1 to coordinates you pass to click/move_mouse. If the user has more than one display, pass `display` to choose which one.

### list_ui_elements
List the interactive controls (buttons, fields, links, checkboxes, menus) of the frontmost app, read from the macOS accessibility tree with their exact labels and centre coordinates. Prefer this over screenshot when you need to click a specific named control — it is far more reliable than guessing pixels. If it reports no accessibility data (common for Chrome/Brave and some Electron apps), fall back to screenshot + click.

### click_ui_element
Click a control by describing it (e.g. 'the Send button', 'Search field', 'Sign in'), resolved against the accessibility tree rather than pixel coordinates. Activates the control directly when possible — no mouse movement, and it works even if the control is partially covered. Call list_ui_elements first if unsure of the exact label. Falls back to a coordinate click when direct activation is unavailable.

### get_screen_info
Get the logical width and height of the screen in points.

### move_mouse
Move the mouse cursor to the given screen coordinates (points).

### click
Click the mouse at the given coordinates. Use button 'left' (default), 'right' for context menus, or 'double' to open items.

### drag
Press the mouse button at one point and release at another (drag).

### type_text
Type text at the current keyboard focus, as if typed on the keyboard. Newlines are sent as Return. Click the target field first so it has focus.

### press_keys
Press a keyboard shortcut or special key, optionally repeated. modifiers is any of cmd, alt, ctrl, shift, fn. key is a single character (e.g. 'c' for Cmd+C) or a named key: return, tab, esc, space, delete, arrow-left, arrow-right, arrow-up, arrow-down, page-up, page-down, home, end, f1..f16. Use repeat to step a focused control — e.g. key 'arrow-up' with repeat 20 nudges a selected slider up 20 steps.

### set_value
Set an editable field to an EXACT value: double-clicks the field, selects what is there, types the new value and presses Return. This is the precise way to set a numeric control — e.g. a Lightroom slider's number box, a form field, a zoom percentage — instead of nudging it. Take a screenshot first to find the field's coordinates.

### scroll
Scroll up or down. If x and y are given the cursor moves there first, which is how you scrub a slider, knob or panel that responds to the scroll wheel under the pointer.

### wait
Pause for a moment to let the screen catch up — an app finishing launch, a page loading, a render completing. Follow with a screenshot to see the new state.

### open_app
Open (or focus) a macOS application by name, e.g. 'Safari', 'Google Chrome', 'Visual Studio Code', 'Mail'.

### open_url
Open a URL in the default web browser.

### frontmost_app
Get the name of the application currently in the foreground.

### get_mouse_position
Get the current mouse cursor position.

### confirm_action
Ask the user out loud to approve something irreversible or outward-facing BEFORE you do it — sending a message or email, submitting a form, publishing, deleting something that isn't yours to delete, or confirming a purchase. Describe the action in one short spoken sentence, e.g. 'send the email to Priya about Friday'. Returns whether they agreed. Do not use it for ordinary clicking, typing, or reading.

### undo_last
Undo the most recent change Jarvis made, restoring the file or working tree from the snapshot taken before it. Use when the user says to undo, revert, or take it back.

### list_undo
List the recent changes that can still be undone.

### remember
Save something worth knowing in future sessions — it survives restarts. Use it when the user states a lasting preference ('always use pnpm', 'keep replies short'), when a decision is made and the reasoning matters, or when a piece of ongoing work should be picked up later. Record what the user TOLD you and what you DID; never record the contents of what you saw on their screen. Do not save routine chatter — only things you would genuinely want to know next week.

### recall
Search what you remember from earlier sessions. The most relevant memories are already in your context at the start of a session — use this when you need something older or more specific, or when the user asks what you remember.

### forget
Delete remembered things — when the user says to forget something, or when a memory turns out to be wrong or out of date. Pass the same words the memory used.

### memory_status
Report how much is remembered and where it is stored, for when the user asks about their data.

### manage_shortcuts
Manage local voice shortcuts that bypass the AI API to save limits. Use this when the user asks you to memorize a command, create a shortcut, or learn an action so it runs instantly next time.

### search_rewind_memory
Search Jarvis's 'Rewind' photographic memory. Use this when the user asks what was on the screen recently, or asks about something they saw a few minutes or hours ago.

### open_phone_remote
Open a page the user can watch from their phone on the same Wi-Fi, showing everything Jarvis is doing, with a stop button. Use this when they want to monitor a long job from away from the desk, or ask to watch progress on their phone. It is view-and-stop only — nothing can be started from the phone.

### close_phone_remote
Close the phone remote and invalidate its link. Use this when the user is done watching, or asks you to stop sharing.

### phone_remote_status
Report whether the phone remote is open, and the address to open on the phone.

### research_while_away
Queue a question for Jarvis to research while the user is away from the desk, producing a written brief with sources. Use this when they say 'look into X while I'm gone', 'find out about Y overnight', or ask you to research something for later. It only runs when they're actually away.

### morning_brief
Report what Jarvis researched while the user was away, with the short answer for each. Use this when they come back and ask what you found, what you looked into, or for their briefing.

### read_research_brief
Read one research brief in full, including its sources. Use this after morning_brief when the user asks about a specific thing you looked into.

### list_research_queue
List the questions waiting to be researched while the user is away, and whether overnight research is switched on.

### set_overnight_research
Turn overnight research on or off. When on, Jarvis works through the queued questions while the user is away, up to a nightly limit. Use this when they ask you to start or stop researching in the background.

### how_is_it_going
Check how the user's session is going — whether they keep hitting the same problem, how long they've been working, and whether it's late. Use this if they ask how they're doing, whether you've noticed anything, or why you're being brief.

### translate_screen
Read the text on screen so it can be translated. Use this when the user asks to translate what they're looking at, or says they can't read something. Returns numbered passages — you translate them yourself, then call show_translation with the numbered translations to lay them over the screen.

### show_translation
Lay translated text over the screen, on top of the original. Call this after translate_screen, passing your translations as numbered lines matching the numbers you were given.

### clear_translation
Remove the translated text laid over the screen. Use this when the user says they're done with the translation, or asks to clear or hide it.

### search_my_files
Search the user's own documents by MEANING, not just keywords. Use this whenever they ask about something they wrote, received, agreed or saved — 'what did we agree the pricing was', 'find that contract', 'what were the notes from the meeting'. Searches Documents, Desktop and Downloads, including PDFs and Word files. Everything stays on this machine.

### index_my_files
Read through the user's documents and build a searchable index, so search_my_files can answer from them. Runs in the background and reports progress. Only needs to be done once; afterwards it updates only what changed. Use this when the user asks to index their files, or when search_my_files reports there is no index yet.

### file_index_status
Report how many of the user's documents have been indexed for searching. Use this when they ask whether their files are indexed or how the indexing is going.

### list_displays
List every display attached to the machine, with its size and where it sits relative to the main one. Use this when the user mentions monitors or screens, before reading or acting on a specific one, or when they ask how many screens they have.

### read_display_text
Read the text on a SPECIFIC display, or on all of them. Use this instead of read_screen_text when the user mentions a particular monitor ('what's on my other screen?', 'read the left monitor'). Coordinates returned are global and can be clicked directly.

### move_window_to_display
Move the frontmost window to another display. Use this for 'move this to my other monitor', 'put this on the big screen', 'send this to the left screen'.

### what_changed_while_away
Report what changed on screen while the user was away or not looking. Use this for 'what did I miss?', 'what happened while I was gone?', 'anything change?', or when the user returns to the desk and asks to be caught up. Compares the screen before they left with the screen now, ignoring clocks, battery levels and progress bars.

### screen_history_status
Report how much screen history Jarvis is holding, how far back it goes, and how much disk it uses. Use this when the user asks how much history you keep, how far back you can remember, how much space it takes, or when old history is deleted.

### handoff_to_ios
Send a piece of text, a URL, or an address to the user's iPhone via iCloud Handoff. Use this when the user asks to send something to their phone.

### run_terminal_command
Run an arbitrary bash command in the background. Use this for 'Agentic' coding, building projects, testing code, creating folders, or executing scripts.

### write_local_file
Write raw text or code to a local file. Use this instead of trying to open an editor when asked to write code.

### read_local_file
Read the contents of a local file into context. Use this to read files to summarize them offline.

### toggle_hand_gestures
Turn hand-gesture control on or off. With it on: point one finger to move the cursor, pinch thumb and index together to click, and swipe with three fingers to scroll. Uses the camera continuously while enabled.

### accept_shadow_code
Take over the user's keyboard and type out the pending code proposed by the Shadow Pair Programmer. Call this ONLY when the user says 'yes' or agrees after Jarvis asks 'Shall I take control?'.

### toggle_shadow_mode
Turn the Shadow Pair Programmer daemon on or off. When on, Jarvis watches the user's IDE and offers to finish code if they get stuck.

### create_jarvis_tool
Autonomously program a new tool for yourself. Provide the raw TypeScript object definition of the tool (following the existing ToolDef schema), and it will be permanently injected into your registry.ts. After injection, the system will rebuild and restart automatically.

### change_mac_voice
Change the default local text-to-speech voice used by Jarvis. Use names like 'Daniel', 'Samantha', 'Alex', etc.

### send_sms_message
Send a text message or iMessage entirely offline via the Mac's Continuity/Messages app.

### toggle_eye_tracking
Turn the 'God Mode' native eye/head tracking on or off. When on, the user can move the mouse by pointing their nose and click by blinking.

### toggle_sonar
Turn the 'Batman' Acoustic Sonar on or off. When on, Jarvis will monitor the room's ambient audio for massive spikes (breaking glass, alarms) and alert the user.

### delegate_task
Multi-Agent Swarm: Delegate a massive background task to an independent LLM agent clone. Jarvis will spawn a background worker that completes the task and writes the result to a file.

### search_long_term_memory
Search Jarvis's long-term semantic vector database. Use this when the user asks about something from days, weeks, or months ago that wouldn't be in the immediate rewind buffer.

### search_audio_log
Search or summarize the continuous transcript of everything said in the room (the Meeting Assistant feature).

### analyze_screen_visually
Take a hidden screenshot of the user's screen and look at the actual image. Use this when the user asks you to 'look at this graph', 'describe this photo', or 'what is wrong with this UI'. You must have a Multimodal brain (like Gemini) active to understand the returned image.

### toggle_meeting_recording
Start or stop continuous audio transcription (the Meeting Assistant). When started, Jarvis logs all room audio. When stopped, he ignores non-wake-word audio.

### show_data_pane
Show a futuristic holographic sidebar (data pane) on the user's screen with information they requested. Use this for dossiers, summaries, or structured data instead of just speaking it aloud.

### show_memory_carousel
Show a holographic 3D carousel of the user's recent memories on screen. Use this when the user asks 'what was I just doing?' or 'show me my memory'.

### switch_brain
Switch Jarvis's brain between Claude, Gemini, and Ollama (Llama 3), and instantly restart the application to apply the change. Use this when the user asks you to switch models or brains.

### read_screen_text
Read all the text currently on screen using fast on-device OCR — no image is sent anywhere and it costs nothing, so prefer this over screenshot when you only need to READ what is displayed (an error message, a value, what an app is showing). Each line comes with the coordinates to click it, which also lets you click text in apps that expose no accessibility tree, like Chrome and Brave. Use screenshot only when you need to see layout, images, or colours.

### click_text
Click on-screen text by what it says, located with OCR. This is the fallback for clicking inside Chrome, Brave and other apps whose contents the accessibility tree cannot see. Give the visible words.

### check_presence
Check whether someone is sitting in front of the computer, using one frame from the camera (on-device face detection, no image stored). Use to decide whether it is worth speaking up, or when the user asks if you can see them.

### run_shortcut
Run one of the user's Apple Shortcuts by describing it. This is how you control smart-home devices (lights, locks, thermostat via HomeKit), send Messages, set Reminders, toggle Focus modes, and anything else they have built in the Shortcuts app. Call list_shortcuts first if unsure what exists.

### list_shortcuts
List the Apple Shortcuts the user has installed, so you know what smart-home and system actions are available.

### check_calendar
Look at the user's upcoming calendar events. Use to answer what's next, or to proactively flag a meeting that is about to start.

### search_my_past
Search everything seen on the user's screen over time. Answers 'what was that error an hour ago?' or 'when did I last see the invoice schema?'. Understands spoken time windows ('an hour ago', 'this morning', 'yesterday'). Use before saying you don't know something they saw earlier.

### learn_workflow
Start or finish learning a task by watching the user do it. Use action 'start' with a name when they say 'watch what I'm doing', and 'finish' when they say they are done. Steps are remembered by the LABELS of what was clicked, so the workflow survives the app moving its buttons.

### run_workflow
Replay a workflow learned earlier. Each control is re-found by meaning at replay time, so it survives layout changes; it stops and reports rather than clicking the wrong thing.

### preview_workflow
Show what a workflow WOULD do without doing it. Every control is resolved and highlighted on screen, but nothing is clicked, typed or pressed. Use this when the user asks what a workflow would do, wants to check one before running it, or says 'show me first' / 'dry run'. Also use it proactively before running a workflow that sends, deletes, buys or submits anything.

### list_workflows
List workflows learned by demonstration, or describe one in detail.

### extract_table
Pull structured data out of an app with no export button — legacy tools, dashboards, portals. Reads rows from the accessibility tree where available, falls back to positioned screen text, and scrolls until no new rows appear. Returns CSV.

### undo_recent
Undo everything done in the last N minutes, not just the last file — walks backwards through the session restoring each change. Use for 'undo everything' or 'take all that back'. Actions with no true inverse are reported rather than silently skipped.

### review_recent_actions
List what was done recently and which of it can still be undone.

### attention_status
Check whether now is a good moment to interrupt, and how many messages are being held.

### check_for_failures
Scan what is on screen for build failures, failing tests, stack traces, or permission errors. Use to notice trouble the user has not mentioned.

### find_commitments
Read back promises made in a conversation or meeting — what the user said they would do, for whom, by when — so they can become actions.

### try_approaches_in_parallel
Try several fixes at once in isolated copies of a git repository, run a verification command on each, and keep only the one that passes. The user's working copy is never touched.

### find_routines
Look for repeated patterns worth offering to automate — an action that reliably follows another.

### dismiss_popups
Clear banners, dialogs and overlays that are in the way — storage warnings, update prompts, cookie notices, 'try our new feature' popups. Call this whenever a page looks obstructed, before clicking something important, and again if a click seems to hit the wrong thing. Only unambiguous dismissals ('Not now', 'Close', 'No thanks', ×) are clicked; anything that decides something ('OK', 'Allow', 'Continue') is reported back to you instead of guessed at.

### understand_dictation
Turn a spoken email address or phone number into the real thing before typing it. People spell addresses out loud ('j o h n at gmail dot com') and the raw transcript is not typeable. ALWAYS run a dictated address through this rather than typing what you heard. Returns null if it doesn't look valid, which means ask the user again.

### suggest_subject
Fallback subject line from a message body. Prefer writing your own subject from the context — this exists only so a subject is never left blank.

### idle_rehearsal
Turn idle rehearsal on or off. When on, Jarvis practises finding its way around apps while you are AWAY from the desk, so common paths are already learned. It only ever looks — it will not buy, send, submit or sign in — and it stops the moment you come back. Off by default because it spends tokens and moves the mouse on its own.

### away_mode
Turn away mode on or off. Away mode is the ONLY thing that makes Jarvis watch the camera continuously — with it off, nothing is monitored and nothing happens automatically. While it is on: when the user leaves the desk their media is paused, the reactor dims so it is obvious from across the room, and the screen locks after a delay if they asked for that. Everything is undone when they return. Use when the user says to turn on away mode, or asks to be watched while they step out.

### presence_status
Report whether away mode is on, whether the user is at their desk, and what happens when they leave. Note the camera is only watched continuously while away mode is on.

### pause_media
Pause whatever audio or video is playing — Music, Spotify, or a video in the browser.

### lock_screen
Lock the screen immediately.

### spawn_subagent
Spawn a background sub-agent to handle a long-running, parallel GUI or web task asynchronously while you remain available to talk to the user. The sub-agent runs in its own isolated context.

### read_changelog
Read the history of your system updates and new features. Call this when the user asks what features they have added to you, or what your current update/build includes. This will automatically display the log on the user's GUI for 7 seconds as well.

