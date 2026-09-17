import { isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";

/**
 * Risk classification for every action Jarvis takes.
 *
 * Deliberately strict: an action is only "low" when it cannot change anything.
 * The policy is to start tight and loosen from real logs, because the cost of
 * the two mistakes is wildly asymmetric — an unnecessary confirmation is mildly
 * annoying, an unconfirmed `rm -rf` or a sent email is not.
 */
export type RiskTier = "low" | "medium" | "high";

export interface Snapshot {
  kind: "file" | "git";
  target: string;
}

export interface RiskAssessment {
  tier: RiskTier;
  /** Spoken aloud when confirmation is needed, so write it for the ear. */
  reason: string;
  /** Full untruncated detail, for logs and the HUD rather than speech. */
  detail?: string;
  /** What to capture before proceeding, so the action can be undone. */
  snapshot?: Snapshot;
}

/**
 * Make a command speakable. Absolute paths are the problem: reading
 * "/var/folders/qn/_1d8zcks5_30pyj9vbwtckj00000gn/T/build-output.log" aloud is
 * noise, and the basename is the part a person actually needs to judge the
 * action. Long commands are also cut, since a confirmation has to stay short
 * enough to hold in your head.
 */
export function speakable(cmd: string, max = 80): string {
  const shortened = cmd
    .replace(/\s+/g, " ")
    .replace(/(\/[^\s'"`]{2,})/g, (m) => m.split("/").filter(Boolean).pop() ?? m)
    .trim();
  return shortened.length > max ? shortened.slice(0, max - 1).trimEnd() + "…" : shortened;
}

/** Tools that only observe. Nothing here can alter the machine. */
export const READ_ONLY = new Set([
  "screenshot",
  "get_screen_info",
  "list_ui_elements",
  "recall",
  "memory_status",
  // Queries and UI affordances — these observe or display, never act.
  "list_undo",
  "read_screen_text",
  "list_shortcuts",
  "check_calendar",
  "search_rewind_memory",
  "screen_history_status",
  "what_changed_while_away",
  "list_displays",
  "read_display_text",
  "recall_scan",
  "search_my_files",
  "file_index_status",
  "translate_screen",
  "how_is_it_going",
  "morning_brief",
  "read_research_brief",
  "list_research_queue",
  "phone_remote_status",
  "search_long_term_memory",
  // Reading a live Osiris feed is a GET against a public intelligence API.
  "osiris_intel",
  "search_audio_log",
  "analyze_screen_visually",
  "show_data_pane",
  "show_memory_carousel",
  // Frontier read-only tools.
  "search_my_past",
  "list_workflows",
  "list_skills",
  "predict_next_command",
  "review_recent_actions",
  "attention_status",
  "check_for_failures",
  "find_commitments",
  "find_routines",
  "presence_status",
  "read_changelog",
  "understand_dictation",
  "suggest_subject",
  "read_screen_text",
  "check_presence",
  "list_shortcuts",
  "check_calendar",
  "frontmost_app",
  "get_mouse_position",
  "wait",
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "TodoWrite",
  "NotebookRead",
]);

/** Tools that act on the UI but stay local and are trivially recoverable. */
export const UI_ACTIONS = new Set([
  "move_mouse",
  "scroll",
  "click",
  "click_ui_element",
  "click_text",
  "drag",
  "type_text",
  "press_keys",
  "set_value",
  "open_app",
  "open_url",
  "toggle_orbital_view",
  "show_osiris",
  "osiris_layers",
  "osiris_focus",
  "show_neural_core",
  "show_creator_page",
  "background_click",
]);

/**
 * Shell commands that destroy data, change the system, or reach the outside
 * world. Ordered roughly by how badly they end when they are wrong.
 */
const DANGEROUS_SHELL: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]*[rf]|--recursive|--force)/, "delete files recursively"],
  [/\brm\s+/, "delete files"],
  // Synonyms for rm. Found the hard way: denied `rm` four times, the model
  // reached for `unlink` on the fifth try and the gate waved it through,
  // because the list named one command rather than the capability.
  [/\b(unlink|shred|rmdir)\s+/, "delete files"],
  [/\btruncate\s+(-s\s*0|--size\s*0)/, "empty a file"],
  [/\bfind\b[^|]*-(delete|exec\s+rm)\b/, "delete files matched by a search"],
  [/\bmv\s+[^|]*\s+\/dev\/null\b/, "discard a file by moving it to /dev/null"],
  // No trailing \b: the method is usually `unlinkSync`/`rmSync`, and a word
  // boundary after "unlink" never matches when a capital letter follows it.
  [/\b(python3?|node|ruby|perl)\b[^|]*(os\.remove|os\.unlink|shutil\.rmtree|rmtree|\.unlink|\.rmSync|\.rmdir|File\.delete)/, "delete files through a script"],
  [/\bgit\s+push\b.*(--force|-f\b)/, "force-push, which can overwrite history on the remote"],
  [/\bgit\s+push\b/, "push to a remote"],
  [/\bgit\s+reset\s+--hard/, "hard-reset, discarding uncommitted work"],
  [/\bgit\s+clean\s+-[a-zA-Z]*[fd]/, "delete untracked files"],
  [/\bgit\s+branch\s+-D\b/, "force-delete a branch"],
  [/\bdd\b\s+if=/, "write a raw disk image"],
  [/\bmkfs\b|\bdiskutil\s+(erase|reformat)/, "format a disk"],
  [/>\s*\/dev\/(disk|rdisk)/, "write directly to a disk device"],
  [/\bsudo\b/, "run something as administrator"],
  [/\b(shutdown|reboot|halt)\b/, "shut down or restart the machine"],
  [/\b(killall|pkill)\b/, "force-quit running programs"],
  [/\bchmod\s+-R|\bchown\s+-R/, "change permissions recursively"],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh/, "download and execute a script"],
  [/\bnpm\s+publish\b|\byarn\s+publish\b/, "publish a package publicly"],
  [/\b(mail|sendmail|mutt)\b/, "send an email"],
  [/\bcurl\b.*(-X\s*(POST|PUT|DELETE|PATCH)|--data|-d\s)/, "send data to an external service"],
  [/\bdefaults\s+write\b|\blaunchctl\b/, "change system settings"],
  [/\bcrontab\b/, "change scheduled jobs"],
  [/\bgh\s+(pr|issue|release)\s+(create|merge|close)/, "act on GitHub on your behalf"],
];

/**
 * Paths that are high-risk to write even though they sit inside your home
 * directory — credentials, keys and shell startup files.
 */
const SENSITIVE = [
  /\/\.ssh(\/|$)/,
  /\/\.aws(\/|$)/,
  /\/\.gnupg(\/|$)/,
  /\/\.config\/gh(\/|$)/,
  /\/\.claude(\/|$)/,
  /\/\.(env|netrc|npmrc|pypirc)$/,
  /\/(\.zshrc|\.bashrc|\.zprofile|\.bash_profile|\.profile)$/,
  /\/Library\/Keychains(\/|$)/,
];

/** MCP tools arrive as `mcp__jarvis__click`; compare on the bare name. */
export function bareToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, "");
}

function inside(dir: string, target: string): boolean {
  const d = resolve(dir);
  const t = resolve(target);
  return t === d || t.startsWith(d.endsWith(sep) ? d : d + sep);
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input?.[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

export interface RiskContext {
  /** Writes outside this directory are treated as high risk. */
  workingDir: string;
}

export function classify(
  toolName: string,
  input: Record<string, unknown>,
  ctx: RiskContext
): RiskAssessment {
  const tool = bareToolName(toolName);

  if (READ_ONLY.has(tool)) {
    return { tier: "low", reason: `${tool} only reads` };
  }

  // ---- shell -------------------------------------------------------------
  // run_terminal_command is a second door to the same shell. It MUST share this
  // analysis: classifying by tool name alone let `rm -rf ~/Documents` through as
  // an ordinary action, silently bypassing every confirmation below.
  if (
    tool === "Bash" ||
    tool === "BashOutput" ||
    tool === "KillShell" ||
    tool === "run_terminal_command"
  ) {
    const cmd = firstString(input, ["command", "cmd"]) ?? "";
    for (const [re, what] of DANGEROUS_SHELL) {
      if (re.test(cmd)) {
        return {
          tier: "high",
          reason: `${what} — ${speakable(cmd)}`,
          detail: cmd,
          snapshot: { kind: "git", target: ctx.workingDir },
        };
      }
    }
    return { tier: "medium", reason: `run ${speakable(cmd)}`, detail: cmd };
  }

  // ---- file reads --------------------------------------------------------
  // Reading is harmless except for credentials, which are worth a confirmation
  // even though nothing is modified — an agent can exfiltrate what it can read.
  if (tool === "read_local_file") {
    const path = firstString(input, ["path", "file_path"]);
    if (path) {
      const abs = isAbsolute(path) ? path : resolve(ctx.workingDir, path);
      if (SENSITIVE.some((re) => re.test(abs))) {
        return {
          tier: "high",
          reason: `read ${abs.split("/").pop()}, which holds credentials`,
          detail: abs,
        };
      }
    }
    return { tier: "low", reason: "read a file" };
  }

  // ---- file writes -------------------------------------------------------
  // write_local_file is a second door to the filesystem; same analysis as Write.
  if (
    tool === "Write" ||
    tool === "Edit" ||
    tool === "NotebookEdit" ||
    tool === "write_local_file"
  ) {
    const path = firstString(input, ["file_path", "path", "notebook_path"]);
    if (!path) return { tier: "medium", reason: `${tool} with no path given` };

    const abs = isAbsolute(path) ? path : resolve(ctx.workingDir, path);

    if (SENSITIVE.some((re) => re.test(abs))) {
      return {
        tier: "high",
        reason: `edit ${abs.split("/").pop()}, which holds credentials or shell settings`,
        detail: abs,
        snapshot: { kind: "file", target: abs },
      };
    }
    if (!inside(ctx.workingDir, abs) && !inside(homedir(), abs)) {
      return {
        tier: "high",
        reason: `write outside your home folder, to ${abs}`,
        detail: abs,
        snapshot: { kind: "file", target: abs },
      };
    }
    return {
      tier: "medium",
      reason: `edit ${abs.split("/").pop()}`,
      detail: abs,
      snapshot: { kind: "file", target: abs },
    };
  }

  // ---- Apple Shortcuts ---------------------------------------------------
  // A shortcut can do anything the user built into it — send a message, empty
  // the trash, unlock a door. We cannot see inside it, so it is high risk and
  // confirmed out loud, naming the shortcut.
  if (tool === "run_shortcut") {
    return {
      tier: "high",
      reason: `run your "${firstString(input, ["name"]) ?? "shortcut"}" shortcut`,
    };
  }

  // ---- learned workflows and parallel attempts ----------------------------
  // Replaying a workflow performs a whole recorded sequence of clicks and
  // typing in one call, so it carries the combined weight of every step and
  // must be confirmed rather than fired off silently.
  if (tool === "run_workflow") {
    return {
      tier: "high",
      reason: `replay the whole "${firstString(input, ["name"]) ?? "saved"}" workflow, which will click and type on its own`,
    };
  }
  if (tool === "try_approaches_in_parallel") {
    const repo = firstString(input, ["repo"]) ?? "a repository";
    // Isolated in throwaway worktrees, so the working copy is safe — but it
    // still runs arbitrary shell commands, which the user should hear about.
    return {
      tier: "high",
      reason: `run several attempts against ${repo.split("/").pop()} in isolated copies, each executing shell commands`,
      snapshot: { kind: "git", target: repo },
    };
  }
  if (tool === "undo_recent") {
    const mins = typeof input?.minutes === "number" ? input.minutes : 10;
    return {
      tier: "high",
      reason: `roll back everything I did in the last ${mins} minutes`,
    };
  }
  if (tool === "learn_workflow") {
    return { tier: "low", reason: "start or stop watching what you do" };
  }
  if (tool === "extract_table") {
    // Reads and scrolls only; it changes nothing.
    return { tier: "low", reason: "read the data shown on screen" };
  }

  // ---- watching the user -------------------------------------------------
  if (tool === "idle_rehearsal") {
    // Enabling hands the mouse to an unattended agent, which the user should
    // agree to out loud. Turning it off never needs permission.
    return input?.enable === false
      ? { tier: "low", reason: "turn off idle rehearsal" }
      : { tier: "high", reason: "let me practise on my own while you're away, moving the mouse without you watching" };
  }

  if (tool === "away_mode") {
    if (input?.enable === false) return { tier: "low", reason: "turn off away mode" };
    const locks = input?.lockScreen === true;
    // Turning the camera on you is a privacy decision; locking the screen can
    // interrupt work. Both deserve to be asked about out loud.
    return {
      tier: "high",
      reason: locks
        ? "turn on away mode — watching the camera for when you leave, and locking the screen after you go"
        : "turn on away mode — watching the camera for when you leave, and pausing media when you do",
    };
  }
  // A preview resolves every control and clicks none of them. It is not quite
  // pure observation — it may bring an app to the front so the later steps
  // resolve against the right window — so it is not in the read-only set, but
  // it cannot send, delete or submit anything and should never need asking
  // about. Being awkward to preview would push people to just run the thing.
  if (tool === "preview_workflow") {
    return { tier: "low", reason: "show what a workflow would do, without doing it" };
  }
  // Turning overnight research ON starts an agent that works unattended and
  // spends tokens doing it. Same weight as idle rehearsal: switching it OFF is
  // always fine, switching it on is a decision the user should make out loud.
  if (tool === "set_overnight_research") {
    return input?.enable === false
      ? { tier: "low", reason: "turn off overnight research" }
      : {
          tier: "high",
          reason:
            "turn on overnight research — I'll look up your queued questions on my own while you're away, which uses your account",
        };
  }
  // Queueing a question changes nothing until research is switched on, and the
  // user has just asked for it out loud. Confirming would be asking twice.
  if (tool === "research_while_away") {
    return { tier: "low", reason: "add a question to the research list" };
  }
  // Opening the phone remote now grants FULL control of the machine from a
  // phone — the screen, two-way talk, sending commands, approving actions. It
  // is guarded by a password and a random link token, but handing that much
  // reach to another device is a decision the user must make out loud, every
  // time.
  if (tool === "open_phone_remote") {
    return {
      tier: "high",
      reason:
        "open full control of this Mac from your phone — the screen, talking, and sending commands, behind your password",
    };
  }
  if (tool === "close_phone_remote") {
    return { tier: "low", reason: "close the phone remote and sign everyone out" };
  }
  // Setting the remote password writes only a hash into ~/.jarvis; it is
  // announced but does not need blocking, and the user just asked for it.
  if (tool === "set_remote_password") {
    return { tier: "medium", reason: "set the password for phone control" };
  }
  if (tool === "lock_screen") {
    return { tier: "high", reason: "lock the screen right now" };
  }
  if (tool === "pause_media") {
    return { tier: "medium", reason: "pause whatever is playing" };
  }

  // ---- leaves the machine -------------------------------------------------
  // Anything that reaches another person or device is irreversible in the way
  // that matters: you cannot unsend it. Always confirm, regardless of content.
  if (tool === "send_sms_message") {
    const to = firstString(input, ["recipient", "to"]) ?? "someone";
    const body = firstString(input, ["message", "body"]) ?? "";
    return { tier: "high", reason: `text ${to}: "${speakable(body, 60)}"`, detail: body };
  }
  if (tool === "handoff_to_ios") {
    return {
      tier: "medium",
      reason: `send ${speakable(firstString(input, ["content"]) ?? "content", 40)} to your phone`,
    };
  }

  // ---- changes Jarvis itself ---------------------------------------------
  // Writing new tools is self-modification: the code runs with Jarvis's full
  // privileges and outlives the conversation that created it.
  if (tool === "create_jarvis_tool") {
    return {
      tier: "high",
      reason: "add a new tool to myself, which will run with all my privileges",
      detail: firstString(input, ["toolCodeString"]) ?? "",
    };
  }
  if (tool === "spawn_subagent") {
    // A second agent driving the GUI unattended, alongside this one. Same
    // weight as delegating: the user should agree before it starts.
    return {
      tier: "high",
      reason: `start a background agent to ${speakable(firstString(input, ["task", "taskDescription", "goal"]) ?? "work on its own", 50)}`,
    };
  }

  if (tool === "delegate_task") {
    return {
      tier: "high",
      reason: `hand "${speakable(firstString(input, ["taskDescription"]) ?? "a task", 50)}" to ${
        firstString(input, ["agentName"]) ?? "another agent"
      }, which then acts on its own`,
    };
  }
  if (tool === "switch_brain") {
    // No longer a restart — the swap is live. Still worth asking about when the
    // model reaches for it unprompted, because it ends the conversation it is
    // in the middle of. A spoken "switch to Gemini" never reaches here: that is
    // recognised in the main process before any brain sees it.
    return {
      tier: "medium",
      reason: `switch my brain to ${firstString(input, ["brain"]) ?? "another model"}, which starts a new conversation`,
    };
  }

  // ---- sensors and recording ---------------------------------------------
  // Turning a camera or microphone log ON is a privacy decision the user should
  // make explicitly; turning it OFF never needs permission.
  const SENSORS: Record<string, string> = {
    toggle_meeting_recording: "record this meeting's audio",
    toggle_eye_tracking: "watch you through the camera to track where you look",
    toggle_sonar: "use the camera to sense whether you are there",
    toggle_hand_gestures: "watch the camera for hand gestures",
    toggle_shadow_mode: "watch what you type and suggest code",
  };
  if (tool in SENSORS) {
    const enabling = input?.enable !== false;
    return enabling
      ? { tier: "high", reason: `start to ${SENSORS[tool]}` }
      : { tier: "low", reason: `stop ${tool.replace(/^toggle_/, "")}` };
  }
  if (tool === "check_presence") {
    return { tier: "medium", reason: "take one camera frame to check if you are there" };
  }

  // ---- memory ------------------------------------------------------------
  // These write only to Jarvis's own store in ~/.jarvis, never to the user's
  // files, so they are announced but never block on a confirmation.
  if (tool === "remember" || tool === "forget") {
    const what = firstString(input, ["text", "query"]) ?? "";
    return {
      tier: "medium",
      reason: tool === "remember" ? `remember: ${speakable(what, 60)}` : `forget: ${speakable(what, 60)}`,
    };
  }

  // Scanning stores a screenshot and text permanently in ~/.jarvis. The user
  // asked for it explicitly and it touches none of their files, so it is
  // announced but never blocks. Saving writes one file to the Desktop.
  if (tool === "scan_page") {
    return { tier: "low", reason: "scan and permanently remember what's on screen" };
  }
  if (tool === "save_last_scan") {
    return { tier: "medium", reason: "save the last scan to your Desktop" };
  }

  // ---- explicit self-declaration by the model ----------------------------
  // The model calls this before anything irreversible that we cannot detect
  // mechanically — pressing Send in a mail client, confirming a purchase.
  if (tool === "confirm_action") {
    return {
      tier: "high",
      reason: firstString(input, ["description"]) ?? "take an irreversible action",
    };
  }

  // Clearing an obstruction is a click, but only ever on wording that cannot
  // decide anything, so it does not need a confirmation of its own.
  if (tool === "dismiss_popups") {
    return { tier: "medium", reason: "close whatever is in the way" };
  }

  // ---- clicking something irreversible ------------------------------------
  // A click is usually trivial, but "Send", "Delete" and "Pay" are not, and the
  // tools cannot tell them apart by themselves. Judging the LABEL means any
  // send button in any app is caught, rather than relying on the model to
  // remember to declare it first.
  if (tool === "click_ui_element" || tool === "click_text") {
    const label = firstString(input, ["description", "text"]) ?? "";
    const l = label.toLowerCase();
    const IRREVERSIBLE: Array<[RegExp, string]> = [
      [/\b(send|reply all|reply|forward)\b/, "send this message"],
      [/\b(delete|remove|trash|discard|erase)\b/, "delete something"],
      // Commerce wording varies more than expected. "Place order" missed the
      // real Amazon button, "Place your order", because of the word between —
      // so these tolerate filler words rather than matching exact phrases.
      [/\b(pay|buy|purchase|checkout|check out|subscribe)\b/, "spend your money"],
      [/\bplace\b.{0,12}\border\b/, "place an order"],
      [/\bproceed\b.{0,12}\b(checkout|payment)\b/, "start checking out"],
      [/\badd\b.{0,10}\b(cart|basket|bag)\b/, "add something to your shopping cart"],
      [/\b(post|publish|tweet|share)\b/, "publish this publicly"],
      [/\b(sign in|log in|sign out|log out|deactivate|close account)\b/, "change who is signed in"],
      [/\b(confirm|submit|apply now|book now)\b/, "submit this"],
    ];
    for (const [re, what] of IRREVERSIBLE) {
      if (re.test(l)) {
        return { tier: "high", reason: `click "${label}" — that will ${what}`, detail: label };
      }
    }
    return { tier: "medium", reason: `click "${speakable(label, 40)}"` };
  }

  // ---- GUI ---------------------------------------------------------------
  if (UI_ACTIONS.has(tool)) {
    if (tool === "open_url") {
      const url = firstString(input, ["url"]) ?? "";
      return { tier: "medium", reason: `open ${url}` };
    }
    return { tier: "medium", reason: `${tool} on screen` };
  }

  if (tool === "WebFetch") {
    return { tier: "medium", reason: `fetch ${firstString(input, ["url"]) ?? "a page"}` };
  }

  // Unknown tool: treat as medium rather than silently trusting it.
  return { tier: "medium", reason: `run ${tool}` };
}
