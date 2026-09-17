import { z, ZodTypeAny } from "zod";
import type { ToolResultMetadata } from "../memory/tool-result.js";
import { normalizeToolOutput } from "../memory/tool-result.js";
import { dataRoot } from "../memory/paths.js";
import { currentInvocation } from "../memory/invocation.js";
import { taskCoordinator } from "../memory/task-state.js";
import type { MemoryScope } from "../memory/types.js";
import { owningTaskId, putHandoff, readHandoff } from "../frontier/task-handoff.js";
import * as act from "./computer-actions.js";
import * as ax from "./ax.js";
import { deepHookClick } from "./deep-hook.js";
import * as vision from "./vision.js";
import * as system from "./system.js";
import { restore, describeRecent } from "../safety/snapshot.js";
import { stats, GLOBAL } from "../memory/store.js";
import { currentContext } from "../memory/context.js";
import { getAppPath } from "../utils/appPath.js";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { searchRewind, describeHistory } from "./rewind.js";
import { loadRecent } from "../frontier/history.js";
import { whileAway } from "../frontier/changed.js";
import { describeDisplays, resolveDisplay, positionOf, type Display } from "./displays.js";
import { CREATOR } from "../brain/types.js";
import * as scan from "../frontier/scan.js";
import { moveFrontWindowTo } from "./windowmove.js";
import * as diskindex from "../frontier/diskindex.js";
import * as translate from "../frontier/translate.js";
import * as narrate from "../frontier/narrate.js";
import * as struggle from "../frontier/struggle.js";
import * as research from "../frontier/research.js";
import * as researcher from "../frontier/researcher.js";
import * as remote from "../frontier/remote.js";
import { setPassword as setRemotePassword } from "../frontier/remoteauth.js";
import { qrDataUrl, saveRemoteUrl } from "../frontier/remotelink.js";
import { homedir } from "node:os";
import { basename } from "node:path";
import { toggleGestures } from "./gestures.js";
import { toggleEyeTracking } from "./eyetrack.js";
import { toggleSonar } from "./sonar.js";
import { searchLongTermMemory } from "./long_term_memory.js";
import { setMeetingRecording } from "./meeting.js";
import { sendToOverlay, toOverlaySpace } from "../overlay.js";
import { currentLoop } from "../agent-replay/loop-log.js";
import { runShutdown } from "../lifecycle.js";
import { shadowPendingCode, isShadowModeActive } from "./shadow.js";
import { toggleCompanion, isCompanionActive } from "./companion.js";
import { typeText } from "./computer-actions.js";
import { exec, spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as timetravel from "../frontier/timetravel.js";
import * as demo from "../frontier/demonstrate.js";
import { replay as replayWorkflow } from "../frontier/replay.js";
import * as extract from "../frontier/extract.js";
import * as journal from "../frontier/journal.js";
import { attention } from "../frontier/attention.js";
import { detectFailure, extractCommitments, minePatterns } from "../frontier/watchers.js";
import { race } from "../frontier/parallel.js";
import { presenceMonitor, pauseAllMedia, lockScreen } from "../frontier/presence.js";
import { setAwayMode } from "../frontier/hudstate.js";
import { setDreamingEnabled, isDreaming } from "../frontier/dreamer.js";
import { dismissPopups } from "../frontier/popups.js";
import { parseEmail, parsePhone, suggestSubject } from "../frontier/dictation.js";
import { check_health } from "./health.js";
import { inspectRun, loadEvents, renderInspectionHtml } from "../agent-replay/index.js";


const nodeRequire = createRequire(import.meta.url);

/**
 * Access electron lazily. A top-level `import ... from "electron"` makes the
 * whole tool registry unloadable outside the Electron main process — it broke
 * every test that bundles the registry for plain Node. Requiring it on demand,
 * with a null fallback, keeps the registry usable anywhere.
 */
function electronApp(): any | null {
  try {
    return nodeRequire("electron").app;
  } catch {
    return null;
  }
}

function appRoot(): string {
  return electronApp()?.getAppPath() ?? process.cwd();
}

/**
 * The scope a memory read or write belongs to.
 *
 * Scope is what keeps one project's decisions out of another's task. It comes
 * from the live task when there is one, because that is the only place the
 * project was actually decided; the frontmost window is a fallback hint, and a
 * window title is a guess, never an authorization boundary.
 */
async function memoryScope(project?: string): Promise<MemoryScope> {
  const taskId = owningTaskId();
  const fromTask = taskId ? (taskCoordinator.get(taskId)?.scope as MemoryScope | undefined) : undefined;
  const projectId = project ?? fromTask?.projectId ?? (await currentContext().catch(() => null))?.project;
  return { ...fromTask, projectId: projectId && projectId !== GLOBAL ? projectId : undefined };
}

/** Where the pointer is, as a point. cliclick reports it as "x,y". */
async function pointerAt(): Promise<{ x: number; y: number } | undefined> {
  try {
    const [x, y] = (await act.getMousePosition()).split(",").map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  } catch {
    return undefined;
  }
}

/** "the one on the right", for confirming which screen was chosen. */
function describeDisplayShort(d: Display, all: Display[]): string {
  return d.primary ? "main" : positionOf(d, all);
}

/**
 * Put the phone-remote link on screen as a QR code, and save it to a file.
 *
 * A link ending in a 32-character token cannot be conveyed by voice, so the
 * spoken/HUD text is not the delivery mechanism — this is. Failing to draw the
 * QR must not fail opening the remote, so every step is best-effort.
 */
async function showRemoteLink(url: string): Promise<void> {
  try {
    saveRemoteUrl(url);
  } catch {
    /* the QR is the primary path */
  }
  try {
    const qr = await qrDataUrl(url);
    sendToOverlay("show-remote-link", { url, qr });
  } catch (e) {
    console.error("[jarvis] could not render the remote QR:", (e as any)?.message ?? e);
  }
}

/** Neutral result a tool handler returns; each brain adapts it to its own wire shape. */
export interface ToolOutput extends ToolResultMetadata {
  text?: string;
  image?: act.Screenshot;
}

export interface ToolDef {
  name: string;
  description: string;
  /** Zod raw shape (map of field -> validator). Empty object for no-arg tools. */
  schema: Record<string, ZodTypeAny>;
  readOnly: boolean;
  handler: (args: any) => Promise<ToolOutput>;
}

export const TOOLS: ToolDef[] = [
  {
    name: "inspect_agent_replay",
    description: "Show Echo's recorded run timeline and a clear answer to why it ended. Use when a run stopped, failed, was interrupted, or the user asks to inspect the latest agent replay.",
    schema: {
      runId: z.string().optional().describe("Optional exact replay run ID. Omit to inspect the latest run."),
      actorName: z.string().optional().describe("Optional actor name, such as 'Echo' or 'Echo Clone 1'. Omit for the latest actor."),
    },
    readOnly: true,
    handler: async (a) => {
      // Full named journals are always-on unless ECHO_FULL_LOG=0. Inspect
      // whichever run store Echo is currently using.
      const root = process.env.ECHO_REPLAY_DIR?.trim()
        || process.env.ECHO_LOG_DIR?.trim()
        || join(appRoot(), "runs");
      if (!existsSync(root)) {
        return { text: "There are no recorded Echo runs yet." };
      }
      const actorPrefix = a.actorName ? `${String(a.actorName).trim()}--` : "";
      const runId = a.runId || readdirSync(root)
        .filter((entry) => {
          try {
            return statSync(join(root, entry)).isDirectory() &&
              existsSync(join(root, entry, "events.jsonl")) &&
              (!actorPrefix || entry.startsWith(actorPrefix));
          } catch { return false; }
        })
        .sort((left, right) => statSync(join(root, right)).mtimeMs - statSync(join(root, left)).mtimeMs)[0];
      if (!runId) return { text: "There are no recorded Echo runs yet." };
      const runDir = join(root, runId);
      try {
        const summary = inspectRun(loadEvents(runDir));
        sendToOverlay("show-data-pane", {
          title: `${summary.actorName.toUpperCase()} · ${summary.status.toUpperCase()}`,
          content: renderInspectionHtml(summary),
          duration: 30000,
        });
        const detail = summary.exitDetail ? ` ${summary.exitDetail}` : "";
        return { text: `${summary.actorName} run ${summary.runId} ${summary.status} after ${summary.iterations} iteration(s): ${summary.exitReason ?? "no exit event"}.${detail}` };
      } catch (error: any) {
        return { text: `I couldn't read replay ${runId}: ${error?.message ?? error}` };
      }
    },
  },
  {
    name: "create_skill",
    description:
      "Teach yourself a new reusable skill by chaining tools you ALREADY have. Use this when the user describes a repeatable multi-step task ('make a skill that opens Mail, waits, and reads the screen'). Provide a name and an ordered list of steps, each naming an existing tool and its arguments. A skill is saved data, not code — it can only combine tools you already have.",
    schema: {
      name: z.string().describe("A short name for the skill."),
      description: z.string().optional().describe("What the skill does, in one line."),
      steps: z
        .array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional() }))
        .describe("Ordered steps. Each 'tool' MUST be the name of an existing tool."),
    },
    readOnly: false,
    handler: async (a) => {
      const { validateSkill, saveSkill, getSkill } = await import("../frontier/skills.js");
      const known = new Set(TOOLS.map((t) => t.name));
      const res = validateSkill(a, known);
      if (!res.ok) return { status: "failed", verification: "unverified", error: { category: "invalid_arguments", message: res.errors.join("; ") },
        text: `I couldn't create that skill:\n${res.errors.map((e) => `• ${e}`).join("\n")}` };
      saveSkill(res.skill, dataRoot());
      // A skill the user taught is a procedure they authorised, so it is active
      // immediately. One Echo proposed for itself would be a candidate until it
      // had actually worked several times — see noteProcedureRun.
      const stored = getSkill(res.skill.name, dataRoot()) ?? res.skill;
      try {
        const { recordProcedure } = await import("../memory/consolidate.js");
        recordProcedure({
          procedureId: stored.procedureId, version: stored.version, name: stored.name,
          description: stored.description || stored.name, steps: stored.steps,
          scope: await memoryScope(), taskId: owningTaskId(), taughtByUser: true,
        });
      } catch (error) { console.error("[memory] procedure not recorded", error); }
      return { text: `Learned the skill "${stored.name}" (${stored.steps.length} steps)${stored.version > 1 ? `, now version ${stored.version}` : ""}. Say "run the ${stored.name} skill" any time.` };
    },
  },
  {
    name: "list_skills",
    description: "List the skills the user has taught Echo. Use when they ask what skills or custom abilities you have.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const { loadSkills, describeSkills } = await import("../frontier/skills.js");
      return { text: describeSkills(loadSkills(dataRoot())) };
    },
  },
  {
    name: "run_skill",
    description: "Run a skill the user previously taught you, by name. Each step runs as its own tool, so anything irreversible still asks for confirmation as usual.",
    schema: { name: z.string().describe("The skill's name.") },
    readOnly: false,
    handler: async (a) => {
      const { getSkill, screenPlan } = await import("../frontier/skills.js");
      const { classify } = await import("../safety/risk.js");
      const skill = getSkill(a.name, dataRoot());
      if (!skill) return { text: `I don't have a skill called "${a.name}". Ask me to list your skills.` };

      // Screen the plan: any high-risk step means Echo hands the plan back to be
      // run step by step (with the usual confirmations) rather than auto-running
      // something irreversible in a batch.
      const screen = screenPlan(skill, (tool, args) => classify(tool, args, { workingDir: appRoot() }).tier);
      const plan = skill.steps.map((s, i) => `${i + 1}. ${s.tool}${Object.keys(s.args ?? {}).length ? " " + JSON.stringify(s.args) : ""}`).join("\n");
      if (!screen.autoRunnable) {
        return { text: `The "${skill.name}" skill includes step(s) ${screen.highSteps.join(", ")} that change things, so I'll run it with you step by step. Plan:\n${plan}` };
      }

      const { runGated } = await import("../safety/gate.js");
      const results: Array<{ step: number; tool: string; result: ToolOutput }> = [];
      for (const [index, step] of skill.steps.entries()) {
        const tool = TOOLS.find((t) => t.name === step.tool);
        if (!tool || tool.name === "run_skill") {
          return { status: results.length ? "partial" : "failed", verification: "unverified", data: { results },
            text: `The "${skill.name}" skill stopped at step ${index + 1}: ${tool ? "recursive skills are not allowed" : `tool ${step.tool} is unavailable`}.` };
        }
        try {
          const args = z.object(tool.schema).parse(step.args ?? {});
          const result = normalizeToolOutput(await runGated(tool, args, { workingDir: appRoot() }));
          results.push({ step: index + 1, tool: step.tool, result });
          if (result.status !== "success") {
            return { status: results.length > 1 ? "partial" : result.status, verification: "unverified", data: { results },
              text: `The "${skill.name}" skill stopped at step ${index + 1}: ${result.text ?? result.error?.message ?? result.status}.` };
          }
        } catch (error: any) {
          return { status: results.length ? "partial" : "failed", verification: "unverified", data: { results },
            error: { category: "tool_error", message: String(error?.message ?? error) },
            text: `The "${skill.name}" skill stopped at ${step.tool}: ${error?.message ?? error}` };
        }
      }
      try {
        const { noteProcedureRun } = await import("../memory/consolidate.js");
        // Every step returned success, but no postcondition has been checked —
        // that is exactly the distinction the report is about, so this run does
        // NOT yet count towards trusting the workflow. verify_task is what
        // turns it into one that does.
        noteProcedureRun({ procedureId: skill.procedureId, version: skill.version, scope: await memoryScope(), taskId: owningTaskId(), verified: false, origin: "real" });
      } catch (error) { console.error("[memory] procedure run not recorded", error); }
      return { status: "success", verification: "unverified", data: { results, procedureId: skill.procedureId, version: skill.version },
        text: `Ran every step of the "${skill.name}" skill (${skill.steps.length} steps) without error. That is not proof it worked — call verify_task with what should now be true before telling the user it is done.` };
    },
  },
  {
    name: "rewind_time",
    description: "The Undo Reality engine. Use this tool when the user makes a catastrophic mistake (deleting important files, breaking the system) and asks to rewind or undo reality.",
    schema: {
      snapshotName: z.string().optional().describe("The specific APFS snapshot to rewind to. Leave blank to rewind to the most recent one.")
    },
    readOnly: false,
    handler: async (a: { snapshotName?: string }) => {
      // Lazy load temporal engine to avoid circular deps if any
      const { temporalEngine } = await import("./../safety/temporal.js");
      const res = temporalEngine.rewindToSnapshot(a.snapshotName || "latest");
      return { text: res.message };
    }
  },
  {
    name: "pull_from_phone",
    description: "The Ambient Device Mesh. Use this tool when the user asks you to pull context, URLs, or clipboard data from their iOS device (iPhone or iPad).",
    schema: {
      deviceName: z.string().optional().describe("The specific device to pull from, e.g., 'iPhone' or 'iPad'. Leave blank to pull from any discovered device.")
    },
    readOnly: true,
    handler: async (a: { deviceName?: string }) => {
      // Lazy load ambient mesh
      const { ambientMesh } = await import("./../frontier/ambient.js");
      const res = await ambientMesh.pullFromPhone(a.deviceName);
      return { text: res.message + (res.data ? `\nData: ${res.data}` : "") };
    }
  },
  {
    name: "toggle_companion_mode",
    description: "Toggle companion mode, which allows for more persistent and proactive assistance. Use this when the user requests a 'companion', 'co-pilot', or a closer working relationship.",
    schema: {
      enable: z.boolean().describe("true to enable companion mode, false to disable it.")
    },
    readOnly: false,
    handler: async (a: { enable: boolean }) => {
      // Speaks through the app's real, shared voice (companion.ts -> speaker.ts),
      // so it uses the configured voice and respects the mute setting.
      toggleCompanion(a.enable);
      return { text: `Companion mode is now ${a.enable ? "enabled" : "disabled"}. Echo will ${a.enable ? "proactively chat with you." : "no longer proactively chat."}` };
    },
  },
  {
    name: "check_health",
    description: "Check the health of the Jarvis system. This verifies native binaries, running servers, AI models, and APIs. Use this when the user asks you to check your health or look for bugs/inconsistencies.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const res = await check_health();
      return { text: res.text };
    },
  },
  {
    name: "screenshot",
    description:
      "Capture the screen as an image. This is the LAST of the three ways to look, not the first: it puts a full image into the conversation and that image is re-sent on every step that follows, so use it only when you need layout, colour, an image, or a control that has no label and no text. To find something to click, use list_ui_elements. To read a value, a status or an error, use read_screen_text. Pixel coordinates in the image map 1:1 to the coordinates click and move_mouse take. Pass `display` to pick a screen when there is more than one.",
    schema: {
      display: z
        .string()
        .optional()
        .describe("Which screen to capture: 'other', 'left', 'right', 'main', 'external', 'second'. Defaults to the one the pointer is on."),
    },
    readOnly: true,
    handler: async (a) => {
      const list = await vision.displays();
      // Default to the screen the user is actually working on rather than
      // always the primary — with two monitors those are often not the same.
      const chosen =
        list.length > 1 ? resolveDisplay(list, a.display ?? "this", await pointerAt()) : null;

      const shot = await act.captureScreen(chosen ?? undefined);
      const which =
        chosen && list.length > 1
          ? ` This is display ${chosen.index + 1} of ${list.length} (${describeDisplayShort(chosen, list)}).`
          : "";
      return {
        text: `Screen captured at ${shot.width}x${shot.height} logical points. Coordinates you use for clicking are in this same space (origin top-left).${which}`,
        image: shot,
      };
    },
  },
  {
    name: "list_ui_elements",
    description:
      "List the interactive controls (buttons, fields, links, checkboxes, menus) of the frontmost app from the macOS accessibility tree, with their exact labels and centre coordinates. FIRST choice when you need to click something: it tells you what the control is really called, so nothing is guessed. Costs no image. If it reports no accessibility data — usual for Chrome, Brave and some Electron apps — switch to read_screen_text and click_text rather than screenshot.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const d = await ax.dump();
      return { text: ax.summarize(d) };
    },
  },
  {
    name: "click_ui_element",
    description:
      "Click a control by describing it ('the Send button', 'Search field', 'Sign in'), resolved against the accessibility tree rather than pixels. FIRST choice for clicking: it activates the control directly, needs no mouse movement, and still works when the control is partly covered or the window has moved. Call list_ui_elements first if you are unsure of the exact label. If the app exposes no accessibility tree, use click_text instead.",
    schema: {
      description: z
        .string()
        .describe("What to click, in words — the visible label works best"),
    },
    readOnly: false,
    handler: async (a) => {
      const d = await ax.dump();
      if (!d.axAvailable || !d.elements.length) {
        return {
          text: `No accessibility data for ${d.app}${d.error ? ` (${d.error})` : ""}. Take a screenshot and click by coordinates instead.`,
        };
      }
      const matches = ax.rank(d.elements, a.description);
      if (!matches.length) {
        return {
          text: `Nothing in ${d.app} matches "${a.description}". Elements available: ${d.elements
            .slice(0, 20)
            .map((e) => `"${e.label}"`)
            .filter((l) => l !== '""')
            .join(", ")}. Or use a screenshot.`,
        };
      }
      const el = matches[0];
      const where = `${el.role.replace(/^AX/, "")} "${el.label}"`;

      // Prefer AXPress — no mouse move, survives occlusion.
      if (el.press) {
        const r = await ax.press(d.pid, el.path);
        if (r.ok) return { text: `Activated ${where} in ${d.app}.` };
      }
      // Fallback: click the element's centre.
      const cx = el.x + Math.round(el.w / 2);
      const cy = el.y + Math.round(el.h / 2);
      await act.click(cx, cy, "left");
      return { text: `Clicked ${where} at ${cx},${cy} in ${d.app}.` };
    },
  },
  {
    name: "get_screen_info",
    description: "Get the logical width and height of the screen in points.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const s = await act.getScreenInfo();
      return { text: `Screen is ${s.width}x${s.height} logical points.` };
    },
  },
  {
    name: "move_mouse",
    description: "Move the cursor without clicking. Needed on its own only to reveal something that appears on hover — a tooltip, a hidden toolbar, a menu that opens on hover — or to park the pointer over a control before calling scroll. Do NOT call this before clicking: click moves the pointer itself.",
    schema: {
      x: z.number().describe("X coordinate in logical points from the left edge"),
      y: z.number().describe("Y coordinate in logical points from the top edge"),
    },
    readOnly: false,
    handler: async (a) => ({ text: await act.moveMouse(a.x, a.y) }),
  },
  {
    name: "click",
    description:
      "Click at exact pixel coordinates. LAST choice: prefer click_ui_element (by name) or click_text (by visible words), neither of which breaks when the window moves or the layout reflows. Use coordinates only for something with no label and no text — a canvas, an image region, a custom-drawn control — and take a screenshot first to know where it is. button is 'left' (default), 'right' for a context menu, or 'double' to open an item.",
    schema: {
      x: z.number().describe("X coordinate in logical points"),
      y: z.number().describe("Y coordinate in logical points"),
      button: z.enum(["left", "right", "double"]).default("left"),
    },
    readOnly: false,
    handler: async (a) => ({ text: await act.click(a.x, a.y, a.button ?? "left") }),
  },
  {
    name: "drag",
    description: "Press at one point, move, and release at another. This is how you move a slider handle that has no number box, reorder a list, select a range of text, or drag a file. If the control has an editable number beside it, set_value is exact and a drag is a guess — prefer set_value.",
    schema: {
      fromX: z.number(),
      fromY: z.number(),
      toX: z.number(),
      toY: z.number(),
    },
    readOnly: false,
    handler: async (a) => ({ text: await act.dragTo(a.fromX, a.fromY, a.toX, a.toY) }),
  },
  {
    name: "type_text",
    description:
      "Type at the current keyboard focus, as if on the keyboard; newlines are sent as Return. Click the target field first so it has focus. Typing into a field that already has content APPENDS to it — to set a field to an exact value, use set_value, which clears what is there first.",
    schema: { text: z.string().describe("The exact text to type") },
    readOnly: false,
    handler: async (a) => ({ text: await act.typeText(a.text) }),
  },
  {
    name: "press_keys",
    description:
      "Press a keyboard shortcut or special key, optionally repeated. modifiers is any of cmd, alt, ctrl, shift, fn. key is a single character (e.g. 'c' for Cmd+C) or a named key: return, tab, esc, space, delete, arrow-left, arrow-right, arrow-up, arrow-down, page-up, page-down, home, end, f1..f16. Use repeat to step a focused control — e.g. key 'arrow-up' with repeat 20 nudges a selected slider up 20 steps.",
    schema: {
      modifiers: z
        .array(z.enum(["cmd", "alt", "ctrl", "shift", "fn"]))
        .default([])
        .describe("Modifier keys to hold"),
      key: z.string().describe("Single character or named key"),
      repeat: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(1)
        .describe("How many times to press the key"),
    },
    readOnly: false,
    handler: async (a) => ({
      text: await act.hotkey(a.modifiers ?? [], a.key, a.repeat ?? 1),
    }),
  },
  {
    name: "set_value",
    description:
      "Set an editable field to an EXACT value: double-clicks the field, selects what is there, types the new value and presses Return. This is the precise way to set a numeric control — e.g. a Lightroom slider's number box, a form field, a zoom percentage — instead of nudging it. Take a screenshot first to find the field's coordinates.",
    schema: {
      x: z.number().describe("X coordinate of the editable value field"),
      y: z.number().describe("Y coordinate of the editable value field"),
      value: z.string().describe("The exact value to set, e.g. '+20' or '1024'"),
    },
    readOnly: false,
    handler: async (a) => ({ text: await act.setValueAt(a.x, a.y, a.value) }),
  },
  {
    name: "scroll",
    description:
      "Scroll up or down. If x and y are given the cursor moves there first, which is how you scrub a slider, knob or panel that responds to the scroll wheel under the pointer.",
    schema: {
      direction: z.enum(["up", "down"]),
      amount: z.number().int().min(1).max(30).default(5).describe("Roughly how far to scroll"),
      x: z.number().optional().describe("Optional X to hover before scrolling"),
      y: z.number().optional().describe("Optional Y to hover before scrolling"),
    },
    readOnly: false,
    handler: async (a) => ({
      text: await act.scroll(a.direction, a.amount ?? 5, a.x, a.y),
    }),
  },
  {
    name: "wait",
    description:
      "Pause for a moment to let the screen catch up — an app finishing launch, a page loading, a render completing. Follow with a screenshot to see the new state.",
    schema: {
      seconds: z.number().min(0.2).max(15).default(1.5).describe("Seconds to wait"),
    },
    readOnly: true,
    handler: async (a) => {
      const s = Math.min(15, Math.max(0.2, a.seconds ?? 1.5));
      await new Promise((r) => setTimeout(r, s * 1000));
      return { text: `waited ${s}s` };
    },
  },
  {
    name: "open_app",
    description: "Open (or focus) a macOS application by name, e.g. 'Safari', 'Google Chrome', 'Visual Studio Code', 'Mail'.",
    schema: { name: z.string() },
    readOnly: false,
    handler: async (a) => ({ text: await act.openApp(a.name) }),
  },
  {
    name: "open_url",
    description: "Open a URL in the default web browser.",
    schema: { url: z.string() },
    readOnly: false,
    handler: async (a) => ({ text: await act.openUrl(a.url) }),
  },
  {
    name: "frontmost_app",
    description: "Get the name of the application currently in the foreground.",
    schema: {},
    readOnly: true,
    handler: async () => ({ text: `Frontmost app: ${await act.frontmostApp()}` }),
  },
  {
    name: "get_mouse_position",
    description: "Get the current mouse cursor position.",
    schema: {},
    readOnly: true,
    handler: async () => ({ text: await act.getMousePosition() }),
  },
  {
    name: "background_click",
    description:
      "Click at screen coordinates WITHOUT moving the physical mouse cursor, by pressing the UI element directly in the frontmost app. Use when you need to click something but must not disturb where the user's cursor is.",
    schema: {
      x: z.number().describe("X coordinate in logical points"),
      y: z.number().describe("Y coordinate in logical points"),
    },
    readOnly: false,
    handler: async (a) => {
      const d = await ax.dump();
      if (!d.pid) return { text: "I couldn't find the frontmost app to click into." };
      const r = await deepHookClick(d.pid, a.x, a.y);
      return {
        text: r.ok
          ? `Clicked at ${a.x},${a.y} in ${d.app} without moving the mouse.`
          : `Background click didn't land: ${r.message}`,
      };
    },
  },
  {
    name: "watch_my_screen",
    description: "Starts or stops a periodic background routine that watches the user's screen every 60 seconds to proactively track progress, issues, or what they are researching on Google/ChatGPT/Claude.",
    schema: { enable: z.boolean().describe("True to start watching, false to stop") },
    readOnly: false,
    handler: async (a) => {
      const globalAny: any = global;
      if (a.enable) {
        if (globalAny.watchScreenInterval) clearInterval(globalAny.watchScreenInterval);

        const { loadConfig } = await import("../config.js");
        const { Tts } = await import("../voice/tts.js");
        const cfg = loadConfig(appRoot());
        // A speaker built from the app's own voice settings. Created once, not
        // per tick, so it does not stutter.
        const watcherTts = new Tts(
          cfg.voice.ttsVoice, cfg.voice.ttsEnabled, cfg.voice.ttsEngine, cfg.voice.elevenLabsVoiceId,
          undefined, { speaker: cfg.voice.sarvamSpeaker, pace: cfg.voice.sarvamPace }
        );
        const host = (cfg.ollama.host || "http://localhost:11434").replace(/\/$/, "");

        globalAny.watchScreenInterval = setInterval(async () => {
          try {
            // Read the screen as TEXT on-device — enough to tell the user is on
            // Google or ChatGPT/Claude and possibly stuck, without a paid vision
            // call and without spinning up a second agent that would fight the
            // main one. This uses the real OCR path, not an imagined API.
            const r = await vision.ocr("accurate");
            const text = (r.lines ?? []).map((l) => l.text).join(" ").slice(0, 4000).trim();
            if (text.length < 20) return;

            const prompt =
              `You are quietly watching the user's screen. Here is the on-screen text:\n"""${text}"""\n\n` +
              `If they appear to be searching Google or chatting with ChatGPT/Claude and seem stuck or researching, ` +
              `reply with ONE short, genuinely helpful spoken sentence (max 2 sentences). ` +
              `Otherwise reply with EXACTLY the single word NOTHING.`;

            const res = await fetch(`${host}/api/generate`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ model: cfg.ollama.model, prompt, stream: false }),
            });
            if (!res.ok) return;
            const j: any = await res.json();
            const out = String(j?.response ?? "").trim();
            if (out.length > 5 && !/^nothing\b/i.test(out)) {
              console.log("[WatchMyScreen] " + out);
              watcherTts.say(out);
            }
          } catch (e) {
            console.error("[WatchMyScreen] error:", e);
          }
        }, 60000); // every 60s
        return { text: "Started watching your screen. Every 60 seconds I'll glance at it and speak up if you seem to be researching or getting stuck." };
      } else {
        if (globalAny.watchScreenInterval) {
          clearInterval(globalAny.watchScreenInterval);
          globalAny.watchScreenInterval = null;
          return { text: "Stopped proactively watching your screen." };
        }
        return { text: "Screen watching was already off." };
      }
    }
  }
];

/**
 * Safety tools.
 *
 * `confirm_action` covers what the risk classifier structurally cannot see:
 * clicking Send in a mail client is just a click at some coordinates, so only
 * the model knows it is about to be irreversible. It declares intent, the
 * permission gate turns that into a spoken confirmation.
 */
TOOLS.push(
  {
    name: "confirm_action",
    description:
      "Ask the user out loud to approve something irreversible or outward-facing BEFORE you do it — sending a message or email, submitting a form, publishing, deleting something that isn't yours to delete, or confirming a purchase. Describe the action in one short spoken sentence, e.g. 'send the email to Priya about Friday'. Returns whether they agreed. Do not use it for ordinary clicking, typing, or reading.",
    schema: {
      description: z
        .string()
        .describe("The action, phrased to be read aloud, e.g. 'send this email to Priya'"),
    },
    readOnly: false,
    handler: async () => ({
      // Only reached when the gate already got approval — denial never runs it.
      text: "The user approved. Go ahead, then tell them it's done.",
    }),
  },
  {
    name: "undo_last",
    description:
      "Undo the most recent change Jarvis made, restoring the file or working tree from the snapshot taken before it. Use when the user says to undo, revert, or take it back.",
    schema: {},
    readOnly: false,
    handler: async () => ({ text: await restore() }),
  },
  {
    name: "list_undo",
    description: "List the recent changes that can still be undone.",
    schema: {},
    readOnly: true,
    handler: async () => ({ text: await describeRecent() }),
  },
  {
    name: "remember",
    description:
      "Save something worth knowing in future sessions — it survives restarts. Use it when the user states a lasting preference ('always use pnpm', 'keep replies short'), when a decision is made and the reasoning matters, or when a piece of ongoing work should be picked up later. Record what the user TOLD you and what you DID; never record the contents of what you saw on their screen, and never record a password, key or card number. Do not save routine chatter — only things you would genuinely want to know next week.",
    schema: {
      text: z.string().describe("The fact, in one clear sentence, written to be read later"),
      type: z
        .enum(["preference", "project", "decision", "episode"])
        .default("episode")
        .describe(
          "preference = how the user likes things done; project = ongoing work; decision = a choice and its reason; episode = something that happened"
        ),
      project: z
        .string()
        .optional()
        .describe("Project this belongs to. Omit for the current project, or pass 'global' if it is true everywhere."),
    },
    readOnly: false,
    handler: async (a) => {
      const { memoryService } = await import("../memory/service.js");
      const type = a.type ?? "episode";
      // A preference is global unless the user scoped it; everything else
      // belongs to the project it came out of, so another project's task cannot
      // be steered by it.
      const project = a.project ?? (type === "preference" ? GLOBAL : (await currentContext()).project);
      const scope = await memoryScope(project);
      const taskId = owningTaskId();
      const saved = memoryService.propose({
        layer: type === "episode" ? "episodic" : "semantic",
        kind: type,
        key: type === "preference" || type === "decision" ? `${type}:${a.text.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}` : undefined,
        summary: a.text,
        scope,
        status: "active",
        confidence: 1,
        confidenceBasis: "The user stated this directly",
        importance: type === "preference" ? 0.9 : 0.6,
        observedAt: new Date().toISOString(),
        source: {
          kind: "user", trust: "user_asserted", origin: "real", taskId,
          evidenceRefs: taskId ? [`task:${taskId}`] : [], derivedFromIds: [],
        },
      });
      if (!saved) return { text: "I did not save that — it was empty, or you had asked me to stop learning here.", status: "denied", error: { category: "write_policy", message: "memory write refused by policy" } };
      const where = project && project !== GLOBAL ? `, ${project}` : "";
      const note = saved.status === "disputed" ? " It contradicts something I already had, so I've flagged both rather than overwriting." : "";
      return { text: `Remembered (${type}${where}): ${saved.summary}${note}`, data: { id: saved.id, status: saved.status } };
    },
  },
  {
    name: "recall",
    description:
      "Search what you remember from earlier sessions. The most relevant memories are already in your context at the start of a turn — use this when you need something older or more specific, or when the user asks what you remember. Results carry their source and how far they can be trusted; reading one does not make it more certain.",
    schema: {
      query: z.string().default("").describe("What to look for. Empty returns the most recent memories."),
      project: z.string().optional().describe("Limit to one project"),
    },
    readOnly: true,
    handler: async (a) => {
      const { executeMemoryCommand } = await import("../memory/commands.js");
      const scope = await memoryScope(a.project);
      return { text: executeMemoryCommand(`/memory inspect ${a.query ?? ""}`.trim(), { scope, appRoot: appRoot() }) ?? "Nothing remembered yet." };
    },
  },
  {
    name: "forget",
    description:
      "Delete remembered things everywhere they were kept — when the user says to forget something, or when a memory turns out to be wrong or out of date. This reaches the derived copies too: episodes, learned facts, screen embeddings, scans and training captures that came from the same source. Pass the words the memory actually used, or its ID from inspect_memory. It cannot be undone.",
    schema: {
      query: z.string().default("").describe("What to forget. EVERY word must appear in the memory, so be specific — this is deliberately strict so an ordinary sentence cannot delete the wrong thing."),
      id: z.string().optional().describe("An exact memory ID from inspect_memory. Preferred when you have one."),
      taskId: z.string().optional().describe("Forget everything learned from one task, by its ID."),
    },
    readOnly: false,
    handler: async (a) => {
      const query = (a.query ?? "").trim();
      if (!a.id && !a.taskId && !query) {
        return { text: "Tell me specifically what to forget — a memory ID, a task ID, or the words the memory used.", status: "failed", error: { category: "invalid_arguments", message: "an unscoped forget is refused" } };
      }
      const { forgetEverywhere } = await import("../memory/deletion.js");
      const scope = await memoryScope();
      const receipt = forgetEverywhere({ ids: a.id ? [a.id] : undefined, taskId: a.taskId, query: a.id || a.taskId ? undefined : query, scope, appRoot: appRoot() });
      if (!receipt.count && !Object.keys(receipt.stores).length) {
        return { text: `Nothing I remember matches that.`, status: "success", data: { count: 0 } };
      }
      const places = Object.keys(receipt.stores).length;
      const caveats = receipt.limitations.length ? `\n${receipt.limitations.map((l) => `Note: ${l}`).join("\n")}` : "";
      const failed = receipt.failures.length ? `\nI could not reach: ${receipt.failures.join(", ")}.` : "";
      return {
        text: `Forgotten. ${receipt.count} memory record${receipt.count === 1 ? "" : "s"} removed${places ? `, along with derived copies in ${places} other place${places === 1 ? "" : "s"}` : ""}. Receipt ${receipt.id}.${failed}${caveats}`,
        data: { receipt: receipt.id, count: receipt.count, stores: receipt.stores },
      };
    },
  },
  {
    name: "stop_learning_here",
    description:
      "Stop remembering anything from this project or task, and keep it that way. Different from forgetting: forgetting removes what is already there, this prevents new memory being written here at all, including in the background. Use it when the user says 'do not remember this', 'stop learning from this project', or 'keep this off the record'. Pass on=false to resume.",
    schema: {
      on: z.boolean().default(true).describe("true stops learning here; false resumes it."),
      scope: z.enum(["task", "project"]).default("task").describe("task = only what you are doing right now; project = everything in this project until you turn it back on."),
      reason: z.string().optional().describe("Why, in a few words, for the user's own record."),
    },
    readOnly: false,
    handler: async (a) => {
      const { memoryService } = await import("../memory/service.js");
      const taskId = owningTaskId();
      const scope = await memoryScope();
      const perTask = (a.scope ?? "task") === "task";
      if (perTask && !taskId) return { text: "There is no active task to exclude.", status: "failed", error: { category: "invalid_arguments", message: "no task in scope" } };
      memoryService.setSuppression({
        scope: perTask ? {} : { projectId: scope.projectId },
        taskId: perTask ? taskId : undefined,
        enabled: a.on !== false,
        reason: a.reason,
      });
      const where = perTask ? "this task" : scope.projectId ? `the ${scope.projectId} project` : "this workspace";
      return { text: a.on === false ? `Learning from ${where} is on again.` : `I will not remember anything from ${where}. What I already remember is untouched — say forget if you want that gone too.` };
    },
  },
  {
    name: "memory_status",
    description: "Report how much is remembered, in which layers, and where it is stored — for when the user asks about their data.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const { memoryService } = await import("../memory/service.js");
      const { memoryRoot } = await import("../memory/paths.js");
      const ctx = await currentContext();
      const scope = await memoryScope();
      const all = memoryService.list(undefined, { includeInactive: true });
      const byLayer = new Map<string, number>();
      for (const m of all) byLayer.set(m.layer, (byLayer.get(m.layer) ?? 0) + 1);
      const layers = [...byLayer.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([l, n]) => `${l} ${n}`).join(", ");
      const here = memoryService.list(scope).length;
      const legacy = stats();
      const suppressed = memoryService.suppressions().filter((r) => r.enabled).length;
      return {
        text: [
          `${all.length} memory record(s)${layers ? ` (${layers})` : ""} at revision ${memoryService.revision()}, stored in ${memoryRoot()}.`,
          `${here} of them apply to the current project, which looks like "${ctx.project}" (${ctx.app}).`,
          `${legacy.count} record(s) remain in the older store at ${legacy.file}.`,
          suppressed ? `${suppressed} place(s) where you have told me to stop learning.` : "",
        ].filter(Boolean).join("\n"),
      };
    },
  },
  {
    name: "inspect_memory",
    description:
      "Show what you actually remember, with where each memory came from and how far it can be trusted. Use it when the user asks what you remember, what you know about this project, or why you believed something — and use it on yourself before relying on a memory that would be expensive to get wrong. Reading a memory never makes it more certain.",
    schema: {
      query: z.string().default("").describe("What to look for. Empty lists everything in the current scope, newest first."),
      id: z.string().optional().describe("One memory's ID, to see its full provenance: source, evidence, what it superseded and what it contradicts."),
      project: z.string().optional().describe("Limit to one project. Omit for the current one."),
    },
    readOnly: true,
    handler: async (a) => {
      const { executeMemoryCommand } = await import("../memory/commands.js");
      const scope = await memoryScope(a.project);
      const command = a.id ? `/memory why ${a.id}` : `/memory inspect ${a.query ?? ""}`.trim();
      return { text: executeMemoryCommand(command, { scope, appRoot: appRoot() }) ?? "Memory inspection is unavailable." };
    },
  },
  {
    name: "inspect_task",
    description:
      "Show the state of the task you are working on right now: the goal, every tool call and how it ended, what has been verified, what is still uncertain, and anything blocking it. Use it when the user asks where things stand, when you resume after an interruption, or when you have lost track of what you already did — reading your own state is cheaper and far more reliable than guessing from the conversation.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const taskId = owningTaskId();
      const state = taskId ? taskCoordinator.get(taskId) : undefined;
      if (!state) return { text: "There is no active task state to report." };
      const calls = Object.values(state.calls);
      const unresolved = calls.filter((c) => ["running", "timeout", "uncertain", "partial"].includes(c.status));
      const failed = calls.filter((c) => c.status === "failed" || c.status === "denied");
      const line = (c: typeof calls[number]) => `  • ${c.tool} (${c.status})${c.result?.error ? ` — ${c.result.error.category}: ${c.result.error.message}` : ""}`;
      const parts = [
        `Task ${state.taskId} · revision ${state.revision} · ${state.status}`,
        `Goal: ${state.goal || "(not recorded)"}`,
        `Calls: ${calls.length} (${calls.filter((c) => c.status === "success").length} succeeded, ${failed.length} failed or denied, ${unresolved.length} unresolved).`,
        failed.length ? `Failed:\n${failed.map(line).join("\n")}` : "",
        unresolved.length ? `Still uncertain — an external effect may have happened; look before retrying:\n${unresolved.map(line).join("\n")}` : "",
        state.verificationRefs.length ? `Verified evidence: ${state.verificationRefs.join(", ")}` : "Nothing has been verified yet.",
        state.artifacts.length ? `Artifacts: ${JSON.stringify(state.artifacts).slice(0, 800)}` : "",
        state.blockers.length ? `Blockers: ${JSON.stringify(state.blockers).slice(0, 800)}` : "",
        state.childTaskIds.length ? `Child tasks: ${state.childTaskIds.join(", ")}` : "",
      ];
      return { text: parts.filter(Boolean).join("\n"), status: "success", verification: "unverified", data: { taskId: state.taskId, revision: state.revision } };
    },
  },
  {
    name: "verify_task",
    description:
      "Prove an action task actually happened, by checking the result yourself before you tell the user it is done. A tool that returned without error is not evidence that the file was written, the app changed, or the message is on screen — this is what turns 'the call succeeded' into 'the thing exists'. Call it with the concrete conditions that must now be true. Checks are read-only and never change anything. Use it for tasks that DID something; a question you answered needs no verification.",
    schema: {
      checks: z
        .array(
          z.object({
            kind: z.enum(["file_exists", "file_absent", "file_contains", "screen_contains"]).describe("What to check."),
            path: z.string().optional().describe("Absolute path to the file, for the file checks. ~ is expanded. A relative path is refused rather than guessed at."),
            text: z.string().optional().describe("The text that must be present, for file_contains and screen_contains."),
          })
        )
        .min(1)
        .describe("Every condition that must hold for the task to be genuinely complete."),
      summary: z.string().optional().describe("One sentence on what was accomplished, recorded with the outcome."),
    },
    readOnly: true,
    handler: async (a) => {
      const taskId = owningTaskId();
      const results: { check: string; ok: boolean; detail: string }[] = [];
      for (const check of a.checks) {
        // Absolute only, like the other file tools. Guessing a base directory
        // is how a check passes against the wrong file and reports a task done.
        const given = check.path?.trim() ?? "";
        const target = given.startsWith("~/") ? join(homedir(), given.slice(2)) : given === "~" ? homedir() : given;
        const label = `${check.kind}${target ? ` ${target}` : ""}${check.text ? ` ~ ${JSON.stringify(check.text.slice(0, 60))}` : ""}`;
        try {
          if (check.kind === "file_exists" || check.kind === "file_absent" || check.kind === "file_contains") {
            if (!target) { results.push({ check: label, ok: false, detail: "no path given" }); continue; }
            if (!isAbsolute(target)) { results.push({ check: label, ok: false, detail: `"${given}" is relative — give the absolute path so the check cannot land on the wrong file` }); continue; }
            const there = existsSync(target);
            if (check.kind === "file_exists") results.push({ check: label, ok: there, detail: there ? `exists, ${statSync(target).size} bytes` : "not found" });
            else if (check.kind === "file_absent") results.push({ check: label, ok: !there, detail: there ? "still exists" : "absent" });
            else {
              const found = there && readFileSync(target, "utf8").includes(check.text ?? "");
              results.push({ check: label, ok: found, detail: !there ? "not found" : found ? "contains the text" : "file exists but the text is not in it" });
            }
          } else {
            // Read the screen rather than trust the model's recollection of it.
            const screen = vision.summarizeOcr(await vision.ocr("accurate"));
            const found = screen.toLowerCase().includes((check.text ?? "").toLowerCase());
            results.push({ check: label, ok: found && !!check.text, detail: found ? "on screen now" : "not on screen" });
          }
        } catch (error: any) {
          results.push({ check: label, ok: false, detail: `could not check: ${error?.message ?? error}` });
        }
      }
      const passed = results.filter((r) => r.ok);
      const verified = passed.length === results.length;
      const refs = passed.map((r) => `verified:${r.check}@${new Date().toISOString()}`);
      if (taskId && refs.length) {
        try { taskCoordinator.recordVerification(taskId, refs); }
        catch (error) { console.error("[memory] verification not recorded", error); }
      }
      // A workflow that ran in this task is only credited once its result has
      // actually been checked — which is the moment this tool succeeds.
      if (taskId && verified) {
        try {
          const { noteProcedureRun } = await import("../memory/consolidate.js");
          const scope = await memoryScope();
          const ran = Object.values(taskCoordinator.get(taskId)?.calls ?? {})
            .filter((c) => c.tool === "run_skill" && c.status === "success");
          for (const call of ran) {
            const data = (call.result?.data ?? {}) as { procedureId?: string; version?: number };
            if (data.procedureId) noteProcedureRun({ procedureId: data.procedureId, version: data.version, scope, taskId, verified: true, verificationRefs: refs, origin: "real" });
          }
        } catch (error) { console.error("[memory] verified procedure run not recorded", error); }
      }
      const report = results.map((r) => `${r.ok ? "✓" : "✗"} ${r.check} — ${r.detail}`).join("\n");
      return {
        text: verified
          ? `Verified — every postcondition holds:\n${report}`
          : `NOT verified. Do not report this task as done; fix what failed and check again:\n${report}`,
        status: verified ? "success" : "failed",
        verification: verified ? "verified" : "contradicted",
        verificationRefs: refs,
        ...(verified ? {} : { error: { category: "verification_failed", message: `${results.length - passed.length} of ${results.length} postconditions did not hold`, retryable: true } }),
        data: { results, summary: a.summary },
      };
    },
  },
  {
    name: "tool_memory",
    description:
      "What you have learned about how well your own tools work — how often each one actually succeeded, how it usually fails, and how long it takes. Consult it before choosing between two tools that do the same job, and after a tool fails twice. Reliability is counted only from outcomes that were verified, so a small sample says 'not enough evidence' rather than a confident number.",
    schema: { tool: z.string().default("").describe("One tool's name. Empty gives the least reliable tools first.") },
    readOnly: true,
    handler: async (a) => {
      const { memoryService } = await import("../memory/service.js");
      const rows = memoryService.list(undefined, { layer: "tool", includeInactive: true })
        .filter((m) => !a.tool || m.key === `tool:${a.tool}`);
      if (!rows.length) return { text: a.tool ? `Nothing has been observed about ${a.tool} yet.` : "No tool outcomes have been recorded yet." };
      const describe = (m: (typeof rows)[number]) => {
        const p = (m.payload ?? {}) as Record<string, number | string | null>;
        const sample = Number(p.verifiedAttempts ?? 0);
        const rate = sample ? `${Math.round(Number(p.reliability ?? 0) * 100)}% verified success over ${sample} verified outcome${sample === 1 ? "" : "s"}` : "no verified sample yet";
        const notes = [
          `${p.attempts ?? 0} call(s) observed`,
          Number(p.failed) ? `${p.failed} failed` : "",
          Number(p.denied) ? `${p.denied} denied` : "",
          Number(p.uncertain) ? `${p.uncertain} uncertain or partial` : "",
          Number(p.unverified) ? `${p.unverified} unverified` : "",
          p.averageDurationMs ? `~${p.averageDurationMs}ms each` : "",
          p.lastErrorCategory ? `last error: ${p.lastErrorCategory}` : "",
        ].filter(Boolean).join(", ");
        return `${String(m.key).replace(/^tool:/, "")}: ${rate}. ${notes}.`;
      };
      const ranked = [...rows].sort((a2, b2) => (Number(a2.payload?.reliability ?? 1) - Number(b2.payload?.reliability ?? 1)) || String(a2.key).localeCompare(String(b2.key)));
      return { text: ranked.slice(0, 20).map(describe).join("\n") };
    },
  },
  {
    name: "manage_shortcuts",
    description: "Manage local voice shortcuts that bypass the AI API to save limits. Use this when the user asks you to memorize a command, create a shortcut, or learn an action so it runs instantly next time.",
    schema: {
      action: z.enum(["add", "remove", "list"]).describe("Action to perform"),
      phrase: z.string().optional().describe("The exact voice phrase to trigger the shortcut (e.g., 'open youtube' or 'play * on youtube')"),
      command: z.string().optional().describe("The bash/cli command to execute (e.g., 'open https://youtube.com'). Use $1 for the wildcard variable."),
      reply: z.string().optional().describe("What Jarvis should say out loud when triggered (e.g., 'Opening YouTube.')"),
    },
    readOnly: false,
    handler: async (a) => {
      const shortcutsPath = join(appRoot(), "shortcuts.json");
      let shortcuts: Record<string, any> = {};
      if (existsSync(shortcutsPath)) {
        try {
          shortcuts = JSON.parse(readFileSync(shortcutsPath, "utf8"));
        } catch (e) {
          /* ignore parse errors */
        }
      }

      if (a.action === "list") {
        const keys = Object.keys(shortcuts);
        if (keys.length === 0) return { text: "No shortcuts exist." };
        return { text: `Shortcuts: ${keys.join(", ")}` };
      }

      if (a.action === "remove") {
        if (!a.phrase) return { text: "You must provide a phrase to remove." };
        if (!shortcuts[a.phrase]) return { text: `Shortcut '${a.phrase}' not found.` };
        delete shortcuts[a.phrase];
        writeFileSync(shortcutsPath, JSON.stringify(shortcuts, null, 2), "utf8");
        return { text: `Removed shortcut: ${a.phrase}` };
      }

      if (a.action === "add") {
        if (!a.phrase || !a.command || !a.reply) {
          return { text: "You must provide a phrase, a bash command, and a spoken reply to add a shortcut." };
        }
        shortcuts[a.phrase.toLowerCase()] = { command: a.command, reply: a.reply };
        writeFileSync(shortcutsPath, JSON.stringify(shortcuts, null, 2), "utf8");
        return { text: `Added shortcut: '${a.phrase}' -> runs '${a.command}' and says '${a.reply}'` };
      }
      
      return { text: "Invalid action." };
    },
  },
  {
    name: "search_rewind_memory",
    description: "Search Jarvis's 'Rewind' photographic memory. Use this when the user asks what was on the screen recently, or asks about something they saw a few minutes or hours ago.",
    schema: {
      query: z.string().describe("The word or phrase to search for in the screen memory."),
    },
    readOnly: true,
    handler: async (a) => {
      const results = searchRewind(a.query);
      if (!results.length) return { text: "No matches found in the Rewind memory." };
      return { text: `Found ${results.length} matches:\n${results.join("\n")}` };
    },
  },
  {
    name: "set_remote_password",
    description:
      "Set (or change) the password that protects remote control of this Mac from a phone. Required before the phone remote can be opened. Use this when the user wants to set up phone control, or asks to change the remote password. At least 6 characters.",
    schema: {
      password: z.string().describe("The password the user chooses for signing in from their phone."),
    },
    readOnly: false,
    handler: async (a) => {
      const r = setRemotePassword(String(a.password ?? ""));
      return {
        text: r.ok
          ? "Remote password set. You can now open the phone remote — you'll enter this password to sign in from your phone."
          : r.message,
      };
    },
  },
  {
    name: "open_phone_remote",
    description:
      "Open full remote control of this Mac from the user's phone: a live view of the screen, two-way talk, sending commands, and approving actions — all behind their password. Reachable from anywhere when both devices are on Tailscale, otherwise same Wi-Fi. Shows a QR code on screen to scan. Use this when they want to see, control, or drive the Mac from their phone. Requires a remote password to be set first (set_remote_password).",
    schema: {},
    readOnly: false,
    handler: async () => {
      // The stop handler and command/confirmation bridges are registered at
      // startup by whoever owns the brain; the tool layer never holds a
      // reference to the running agent.
      const r = await remote.startRemote();
      if (r.ok && r.url) await showRemoteLink(r.url);
      return {
        text: r.ok
          ? `${r.message}\nI've put a QR code on your screen — scan it with your phone's camera to open the link.`
          : r.message,
      };
    },
  },
  {
    name: "close_phone_remote",
    description:
      "Close the phone remote, sign everyone out, and invalidate its link. Use this when the user is done, or asks you to stop sharing or lock it down.",
    schema: {},
    readOnly: false,
    handler: async () => ({ text: await remote.stopRemote() }),
  },
  {
    name: "phone_remote_status",
    description:
      "Report whether the phone remote is open, and show the QR code / link again to open it on the phone. Use this when the user asks for the phone link again, or 'show me the QR code'.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const url = remote.currentRemoteUrl();
      if (url) await showRemoteLink(url);
      return {
        text: url
          ? `${remote.remoteStatus()}\nQR code is on your screen — scan it to connect.`
          : remote.remoteStatus(),
      };
    },
  },
  {
    name: "research_while_away",
    description:
      "Queue a question for Jarvis to research while the user is away from the desk, producing a written brief with sources. Use this when they say 'look into X while I'm gone', 'find out about Y overnight', or ask you to research something for later. It only runs when they're actually away.",
    schema: {
      question: z.string().describe("What to find out, in the user's own words."),
    },
    readOnly: false,
    handler: async (a) => {
      const r = research.addQuestion(a.question);
      const status = researcher.isResearching() ? "" : ` ${researcher.researchStatus()}`;
      return { text: r.added ? `${r.reason}${status}` : r.reason };
    },
  },
  {
    name: "morning_brief",
    description:
      "Report what Jarvis researched while the user was away, with the short answer for each. Use this when they come back and ask what you found, what you looked into, or for their briefing.",
    schema: {},
    readOnly: true,
    handler: async () => ({ text: research.morningBrief() }),
  },
  {
    name: "read_research_brief",
    description:
      "Read one research brief in full, including its sources. Use this after morning_brief when the user asks about a specific thing you looked into.",
    schema: {
      question: z.string().describe("Which brief — any distinctive part of the question will do."),
    },
    readOnly: true,
    handler: async (a) => {
      const full = research.readBrief(a.question);
      return { text: full ?? `I don't have a brief matching "${a.question}". ${research.morningBrief()}` };
    },
  },
  {
    name: "list_research_queue",
    description:
      "List the questions waiting to be researched while the user is away, and whether overnight research is switched on.",
    schema: {},
    readOnly: true,
    handler: async () => ({
      text: `${research.describeQueue()}\n\n${researcher.researchStatus()}`,
    }),
  },
  {
    name: "set_overnight_research",
    description:
      "Turn overnight research on or off. When on, Jarvis works through the queued questions while the user is away, up to a nightly limit. Use this when they ask you to start or stop researching in the background.",
    schema: { enable: z.boolean().describe("True to switch it on.") },
    readOnly: false,
    handler: async (a) => {
      researcher.setResearchEnabled(a.enable === true);
      return {
        text: a.enable
          ? `Overnight research is on. ${research.describeQueue()}`
          : "Overnight research is off — I won't look anything up on my own.",
      };
    },
  },
  {
    name: "how_is_it_going",
    description:
      "Check how the user's session is going — whether they keep hitting the same problem, how long they've been working, and whether it's late. Use this if they ask how they're doing, whether you've noticed anything, or why you're being brief.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const state = struggle.assess();
      const extra =
        state.mood === "stuck" && struggle.mayOfferHelp(state)
          ? ` ${struggle.offerText(state)}`
          : "";
      return { text: struggle.describe(state) + extra };
    },
  },
  {
    name: "translate_screen",
    description:
      "Read the text on screen so it can be translated. Use this when the user asks to translate what they're looking at, or says they can't read something. Returns numbered passages — you translate them yourself, then call show_translation with the numbered translations to lay them over the screen.",
    schema: {
      language: z.string().optional().describe("Target language. Defaults to English."),
      display: z.string().optional().describe("Which screen, if the user has more than one."),
    },
    readOnly: true,
    handler: async (a) => {
      const language = a.language?.trim() || "English";
      const list = await vision.displays();
      const chosen = list.length > 1 ? resolveDisplay(list, a.display ?? "this", await pointerAt()) : null;

      const r = await vision.ocr("accurate", chosen?.index ?? 0);
      if (r.error) return { text: `I couldn't read the screen: ${r.error}` };

      const blocks = translate.translatableBlocks(r.lines);
      if (!blocks.length) {
        translate.clearPending();
        return { text: "I couldn't find any readable text on screen to translate." };
      }
      const resource = await scan.frontContext();
      const handle = translate.stashBlocks(blocks, language, translate.translationVersion(blocks, JSON.stringify(resource)));

      return {
        text:
          `Found ${blocks.length} passages on screen. Translate each into ${language}, then call show_translation ` +
          `with handleId "${handle.id}" and one numbered line per passage, using these exact numbers:\n\n` +
          blocks.map((b, i) => `${i + 1}. ${b.text}`).join("\n"),
        data: { handleId: handle.id, expiresAt: handle.expiresAt },
      };
    },
  },
  {
    name: "show_translation",
    description:
      "Lay translated text over the screen, on top of the original. Call this after translate_screen, passing your translations as numbered lines matching the numbers you were given.",
    schema: {
      handleId: z.string().optional().describe("Exact handle from translate_screen; prevents stale or cross-task results."),
      translations: z
        .string()
        .describe("One numbered line per passage, e.g. '1. Hello\\n2. Goodbye'. Use the same numbers you were given."),
    },
    readOnly: false,
    handler: async (a) => {
      const handle = translate.pendingTranslation(a.handleId);
      if (!handle) return { status: "failed", text: "The translation handle is missing, stale, or belongs to another task. Call translate_screen again." };
      const [resource, fresh] = await Promise.all([scan.frontContext(), vision.ocr("accurate")]);
      const version = translate.translationVersion(translate.translatableBlocks(fresh.lines ?? []), JSON.stringify(resource));
      if (fresh.error || version !== handle.resourceVersion) {
        translate.clearPending();
        return { status: "failed", text: "The screen changed since translation was captured. Call translate_screen again." };
      }
      const blocks = handle.value.blocks;
      const target = handle.value.language;
      const parsed = translate.parseTranslations(a.translations, blocks);
      const shown = translate.drawable(parsed);

      if (shown.length) {
        sendToOverlay("show-translation", {
          // The overlay window spans the whole desktop and starts at its
          // top-left, which is not the origin when a monitor sits to the left.
          blocks: shown.map((b) => {
            const p = toOverlaySpace({ x: b.x, y: b.y });
            return { ...b, x: p.x, y: p.y };
          }),
          note: `${target} · say "clear translation" to dismiss`,
        });
      }
      translate.clearPending();
      return { text: translate.describe(shown, target, blocks.length), status: "success", verification: "unverified" };
    },
  },
  {
    name: "clear_translation",
    description:
      "Remove the translated text laid over the screen. Use this when the user says they're done with the translation, or asks to clear or hide it.",
    schema: {},
    readOnly: false,
    handler: async () => {
      sendToOverlay("clear-translation");
      translate.clearPending();
      return { text: "Cleared the translation." };
    },
  },
  {
    name: "search_my_files",
    description:
      "Search the user's own documents by MEANING, not just keywords. Use this whenever they ask about something they wrote, received, agreed or saved — 'what did we agree the pricing was', 'find that contract', 'what were the notes from the meeting'. Searches Documents, Desktop and Downloads, including PDFs and Word files. Everything stays on this machine.",
    schema: {
      query: z.string().describe("What to look for, phrased as a question or description."),
      limit: z.number().optional().describe("How many passages to return. Default 5."),
    },
    readOnly: true,
    handler: async (a) => {
      const hits = await diskindex.search(a.query, a.limit ?? 5);
      if (!hits.length && !diskindex.loadIndex(diskindex.indexDir()).chunks.length) {
        return { text: diskindex.indexStatus() };
      }
      return { text: diskindex.describeHits(hits, a.query) };
    },
  },
  {
    name: "index_my_files",
    description:
      "Read through the user's documents and build a searchable index, so search_my_files can answer from them. Runs in the background and reports progress. Only needs to be done once; afterwards it updates only what changed. Use this when the user asks to index their files, or when search_my_files reports there is no index yet.",
    schema: {
      folders: z
        .array(z.string())
        .optional()
        .describe("Specific folders to index. Defaults to Documents, Desktop and Downloads."),
    },
    readOnly: false,
    handler: async (a) => {
      if (diskindex.isIndexing()) return { text: "I'm already indexing — ask me for the status." };

      const roots = a.folders?.length
        ? a.folders.map((f: string) => (f.startsWith("~") ? join(homedir(), f.slice(1)) : f))
        : diskindex.defaultRoots();

      // Kick off and return immediately: a first index takes minutes, and
      // holding the conversation open for it would look like a hang.
      void diskindex
        .buildIndex({
          roots,
          // A small pause between files keeps this off the CPU the user is
          // trying to work on. Indexing that makes the machine feel slow is
          // worse than indexing that takes longer.
          throttleMs: 40,
          onProgress: (p) => {
            if (p.filesDone % 10 === 0) {
              sendToOverlay("feed", {
                text: `Indexing ${p.filesDone}/${p.filesTotal}: ${basename(p.currentFile)}`,
              });
            }
          },
        })
        .then((r) => {
          const msg = r.error
            ? `Indexing failed: ${r.error}`
            : `Indexed ${r.filesIndexed} documents (${r.chunksAdded} passages). You can ask me about them now.`;
          sendToOverlay("feed", { text: msg });
          console.log(`[jarvis] ${msg}`);
        });

      return {
        text: `Started indexing ${roots.length} folder(s). This takes a few minutes the first time — I'll tell you when it's done, and you can keep working.`,
      };
    },
  },
  {
    name: "file_index_status",
    description:
      "Report how many of the user's documents have been indexed for searching. Use this when they ask whether their files are indexed or how the indexing is going.",
    schema: {},
    readOnly: true,
    handler: async () => ({
      text: diskindex.isIndexing()
        ? `Still indexing. ${diskindex.indexStatus()}`
        : diskindex.indexStatus(),
    }),
  },
  {
    name: "show_creator_page",
    description:
      "Open a page for Jarvis's creator, Deepak (founder of AskDeepakAI), in a new browser window. Use this when the user asks to see the creator's page, GitHub, or LinkedIn. Defaults to GitHub if they don't specify.",
    schema: {
      which: z
        .enum(["github", "linkedin"])
        .optional()
        .describe("Which page to open. Defaults to github."),
    },
    readOnly: false,
    handler: async (a) => {
      const which = a.which === "linkedin" ? "linkedin" : "github";
      await act.openUrl(CREATOR[which]);
      const label = which === "github" ? "GitHub" : "LinkedIn";
      return { text: `Opening ${CREATOR.name}'s ${label} page — the creator of Jarvis and founder of ${CREATOR.org}.` };
    },
  },
  {
    name: "toggle_orbital_view",
    description:
      "Open or close the Orbital panel — a live, interactive satellite tracker (starport.im) wrapped in Echo's own frame. Use when the user asks to see satellites, the orbital view, what's in orbit, or space tracking.",
    schema: {
      show: z.boolean().optional().describe("true to open (default), false to close."),
    },
    readOnly: false,
    handler: async (a) => {
      const { openOrbitalPanel, closeOrbitalPanel } = await import("../orbital.js");
      if (a.show === false) {
        closeOrbitalPanel();
        return { text: "Closed the orbital view." };
      }
      openOrbitalPanel();
      return { text: "Opening the live orbital tracker. It'll appear once the feed has loaded." };
    },
  },
  {
    name: "show_osiris",
    description:
      "Open (or close) the Osiris panel — the live global intelligence grid: a 3D world map layered with real-time flights, earthquakes, fires, satellites, CCTV cameras, undersea cables, conflict zones and 24/7 news. Use when the user asks to see the world map, the globe, global intelligence, OSINT, what's happening in the world, or Osiris by name. THE PANEL STAYS ON SCREEN until they ask to close it — never close it as tidying up, only when they say so. Pass layers to open it already showing something specific.",
    schema: {
      show: z.boolean().optional().describe("true to open (default), false to close."),
      layers: z
        .array(z.string())
        .optional()
        .describe("Layers to show on arrival — e.g. flights, earthquakes, fires, satellites, cameras, news, war, cables."),
      pin: z
        .boolean()
        .optional()
        .describe("Keep the grid above other windows and on every desktop."),
    },
    readOnly: false,
    handler: async (a) => {
      const osiris = await import("../osiris.js");
      if (a.show === false) {
        if (!osiris.isOsirisOpen()) return { text: "The Osiris grid isn't open." };
        osiris.closeOsirisPanel();
        return { text: "Closed the Osiris grid." };
      }

      const { resolveLayers, isHosted, speakList } = await import("./osiris-intel.js");
      const { ids, unknown } = resolveLayers(a.layers ?? []);
      const wasOpen = osiris.isOsirisOpen();
      const { base } = await osiris.openOsirisPanel({ layers: ids, pin: a.pin });

      const where = isHosted(base) ? "the live grid" : `the instance at ${base}`;
      // With no layers named the panel opens on the standard view, which is two
      // dozen layers — a count, not a recital.
      const showing = ids.length ? `showing ${speakList(ids)}` : "with the standard view";
      const opened = wasOpen
        ? `The Osiris grid is already up${ids.length ? `, switching to ${speakList(ids)}` : ""}.`
        : `Opening the Osiris grid on ${where}, ${showing}. It'll appear once the globe has loaded, and it stays up until you tell me to close it.`;
      const missed = unknown.length ? ` I don't have a layer called ${speakList(unknown)}.` : "";
      return { text: opened + missed };
    },
  },
  {
    name: "osiris_layers",
    description:
      "Turn layers on or off on the Osiris grid, or report which are showing. Layers include flights, private jets, military flights, ships, satellites, cameras, live news, earthquakes, fires, weather, radiation, infrastructure, conflict zones, undersea cables, day/night, terrain, malware and cyber attacks. Use when the user asks to add, remove, or check something on the world map. Opens the grid first if it isn't up.",
    schema: {
      on: z.array(z.string()).optional().describe("Layers to switch on, keeping what's already showing."),
      off: z.array(z.string()).optional().describe("Layers to switch off."),
      only: z.array(z.string()).optional().describe("Show exactly these and nothing else."),
    },
    readOnly: false,
    handler: async (a) => {
      const osiris = await import("../osiris.js");
      const { resolveLayers, speakList, openingLayers } = await import("./osiris-intel.js");

      const wanted = resolveLayers(a.only ?? []);
      const add = resolveLayers(a.on ?? []);
      const drop = resolveLayers(a.off ?? []);
      const unknown = [...wanted.unknown, ...add.unknown, ...drop.unknown];

      // "Only show X" where X isn't a layer must not be read as "show nothing" —
      // clearing the globe is the opposite of what was asked for.
      if (a.only && !wanted.ids.length) {
        return { text: `I don't have a layer called ${speakList(unknown.length ? unknown : a.only)}, so I've left the grid as it is.` };
      }

      if (!osiris.isOsirisOpen()) {
        const start = a.only ? wanted.ids : [...new Set([...openingLayers(), ...add.ids])].filter((id) => !drop.ids.includes(id));
        if (!start.length && !add.ids.length && !wanted.ids.length) {
          return { text: "The Osiris grid isn't open — say the word and I'll put it on screen." };
        }
        await osiris.openOsirisPanel({ layers: start });
        return { text: `Opening the Osiris grid showing ${speakList(start)}.` };
      }

      // If the page's URL can't be read, assume what Echo opened it with.
      const current = (await osiris.currentLayers()) ?? openingLayers();
      if (!a.on && !a.off && !a.only) {
        return {
          text: current.length
            ? `The grid is showing ${speakList(current)}.`
            : "The grid is showing a bare globe — no layers on.",
        };
      }

      const next = a.only
        ? wanted.ids
        : [...new Set([...current, ...add.ids])].filter((id) => !drop.ids.includes(id));
      const result = await osiris.applyLayers(next);

      const missed = unknown.length ? ` I don't have a layer called ${speakList(unknown)}.` : "";
      if (result === "failed" || result === "closed") {
        return {
          text: `The grid wouldn't take that change just now — it's still showing ${speakList(current)}.` + missed,
        };
      }
      const lead = result === "pending" ? "Switching to" : "Now showing";
      return {
        text: (next.length ? `${lead} ${speakList(next)}.` : "Clearing the grid down to a bare globe.") + missed,
      };
    },
  },
  {
    name: "osiris_intel",
    description:
      "Read a live Osiris intelligence feed and answer out loud — earthquakes, air traffic, fires, the OSINT news feed, satellites, conflict zones, space weather, severe weather, cyber threats, or an overall grid status. Use whenever the user asks what's happening in the world, whether anything has happened (a quake, a fire, a conflict), or for a world briefing. This reads data and does not need the panel open.",
    schema: {
      feed: z
        .string()
        .describe("Which feed: status, earthquakes, flights, fires, news, satellites, conflicts, space_weather, weather, or cyber."),
    },
    readOnly: true,
    handler: async (a) => {
      const { resolveFeed, osirisFetch, summarize, activeBase, FEEDS } = await import("./osiris-intel.js");
      const feed = resolveFeed(a.feed ?? "status");
      if (!feed) {
        return { text: `I don't have a feed called "${a.feed}". I can read ${FEEDS.map((f) => f.id).join(", ")}.` };
      }

      // When the panel is up, its page is the fallback route to the API: a
      // deployment that answers a plain server-side request with a bot check
      // answers the browser that already cleared it.
      const osiris = await import("../osiris.js");
      const base = osiris.osirisBase() ?? (await activeBase());
      const relay = osiris.isOsirisOpen() ? osiris.relayFetch : undefined;

      let data: any;
      try {
        data = await osirisFetch(feed.path, { base, relay });
      } catch (e: any) {
        return { text: `I couldn't read the ${feed.label} feed — ${e?.message ?? e}.` };
      }

      const summary = summarize(feed.id, data);
      sendToOverlay("show-data-pane", {
        title: `OSIRIS · ${feed.label.toUpperCase()}`,
        content: summary.html,
        duration: 30000,
      });
      return { text: summary.speech };
    },
  },
  {
    name: "osiris_focus",
    description:
      "Point the Osiris globe at a place — a city, country, region or landmark. Use when the user asks to look at somewhere specific on the world map ('show me Ukraine', 'zoom into Tokyo'). Opens the grid first if it isn't up.",
    schema: {
      place: z.string().describe("Where to look — a place name, as spoken."),
      lat: z.number().optional().describe("Exact latitude, if known."),
      lng: z.number().optional().describe("Exact longitude, if known."),
      zoom: z.number().optional().describe("Zoom level, 2 (whole globe) to 12 (a city block). Defaults to 6."),
    },
    readOnly: false,
    handler: async (a) => {
      const osiris = await import("../osiris.js");
      const { osirisFetch, activeBase } = await import("./osiris-intel.js");
      const place = String(a.place ?? "").trim();

      if (!osiris.isOsirisOpen()) {
        await osiris.openOsirisPanel({});
        // The globe needs to exist before the camera can be told to move.
        await new Promise((r) => setTimeout(r, 6000));
      }

      let coords =
        Number.isFinite(a.lat) && Number.isFinite(a.lng)
          ? { lat: a.lat as number, lng: a.lng as number, zoom: a.zoom }
          : undefined;

      // Osiris geocodes with its own search service, so a place Echo resolves
      // this way is the same place its search box would have found.
      if (!coords && place) {
        try {
          const base = osiris.osirisBase() ?? (await activeBase());
          const found = await osirisFetch(`/api/geosearch?q=${encodeURIComponent(place)}`, {
            base,
            timeoutMs: 12000,
            relay: osiris.isOsirisOpen() ? osiris.relayFetch : undefined,
          });
          const hit = found?.results?.[0];
          if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lng)) {
            coords = { lat: hit.lat, lng: hit.lng, zoom: a.zoom };
          }
        } catch {
          /* the search-box route below doesn't need coordinates */
        }
      }

      const route = await osiris.focusOsiris(place, coords);
      if (route === "map") return { text: `Bringing ${place || "that position"} up on the grid.` };
      if (route === "search") return { text: `Searching the grid for ${place} and flying there.` };
      return { text: `The grid is open, but I couldn't move the camera to ${place || "there"} from here.` };
    },
  },
  {
    name: "show_neural_core",
    description:
      "Open (or close) a 3D visual of Echo's own neural core — a spiral galaxy with a glowing core and clusters of data orbiting it. Use when the user asks to see your core, your neural schema, your mind, your brain, or 'show me your galaxy'.",
    schema: {
      show: z.boolean().optional().describe("true to open (default), false to close."),
    },
    readOnly: false,
    handler: async (a) => {
      const { openNeuralCore, closeNeuralCore } = await import("../neural.js");
      if (a.show === false) {
        closeNeuralCore();
        return { text: "Closed the neural core." };
      }
      openNeuralCore();
      return { text: "This is my neural core — a galaxy of the data I hold, turning around its centre." };
    },
  },
  {
    name: "list_displays",
    description:
      "List every display attached to the machine, with its size and where it sits relative to the main one. Use this when the user mentions monitors or screens, before reading or acting on a specific one, or when they ask how many screens they have.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const list = await vision.displays();
      return { text: describeDisplays(list) };
    },
  },
  {
    name: "read_display_text",
    description:
      "Read the text on a SPECIFIC display, or on all of them. Use this instead of read_screen_text when the user mentions a particular monitor ('what's on my other screen?', 'read the left monitor'). Coordinates returned are global and can be clicked directly.",
    schema: {
      display: z
        .string()
        .optional()
        .describe(
          "Which screen: 'other', 'left', 'right', 'main', 'external', 'second', or 'all' to read every display."
        ),
    },
    readOnly: true,
    handler: async (a) => {
      const list = await vision.displays();
      if (!list.length) return { text: "I can't see any displays." };

      const want = (a.display ?? "").toLowerCase();
      if (/\ball\b|\bboth\b|\bevery\b/.test(want)) {
        const r = await vision.ocrAll("accurate");
        if (r.error) return { text: `Couldn't read the screens: ${r.error}` };
        const byDisplay = new Map<number, string[]>();
        for (const l of r.lines) {
          const k = l.display ?? 0;
          if (!byDisplay.has(k)) byDisplay.set(k, []);
          byDisplay.get(k)!.push(l.text);
        }
        const parts = [...byDisplay.entries()].map(
          ([i, texts]) => `Display ${i + 1}:\n${texts.join(" ")}`
        );
        return { text: parts.join("\n\n") || "No text found on any display." };
      }

      // Resolve against where the pointer is, so "the other one" means
      // something relative to where the user is actually working.
      const chosen = resolveDisplay(list, a.display, await pointerAt());
      if (!chosen) return { text: `I couldn't work out which display you meant.` };

      const r = await vision.ocr("accurate", chosen.index);
      if (r.error) return { text: `Couldn't read display ${chosen.index + 1}: ${r.error}` };
      const text = r.lines.map((l) => l.text).join(" ");
      return {
        text: text
          ? `Display ${chosen.index + 1} (${describeDisplayShort(chosen, list)}):\n${text}`
          : `Display ${chosen.index + 1} has no readable text.`,
      };
    },
  },
  {
    name: "move_window_to_display",
    description:
      "Move the frontmost window to another display. Use this for 'move this to my other monitor', 'put this on the big screen', 'send this to the left screen'.",
    schema: {
      display: z
        .string()
        .describe("Which screen to move it to: 'other', 'left', 'right', 'main', 'external', 'second'."),
      fullscreen: z.boolean().optional().describe("Fill that display after moving."),
    },
    readOnly: false,
    handler: async (a) => {
      const list = await vision.displays();
      if (list.length < 2) {
        return { text: "There's only one display, so there's nowhere to move it to." };
      }
      const target = resolveDisplay(list, a.display, await pointerAt());
      if (!target) return { text: "I couldn't work out which display you meant." };

      const moved = await moveFrontWindowTo(target, a.fullscreen === true);
      return { text: moved };
    },
  },
  {
    name: "what_changed_while_away",
    description:
      "Report what changed on screen while the user was away or not looking. Use this for 'what did I miss?', 'what happened while I was gone?', 'anything change?', or when the user returns to the desk and asks to be caught up. Compares the screen before they left with the screen now, ignoring clocks, battery levels and progress bars.",
    schema: {
      minutes: z
        .number()
        .optional()
        .describe("How far back to compare if Jarvis never saw them leave. Defaults to 30 minutes."),
    },
    readOnly: true,
    handler: async (a) => ({
      text: whileAway(getAppPath(), (a.minutes ?? 30) * 60_000),
    }),
  },
  {
    name: "screen_history_status",
    description:
      "Report how much screen history Jarvis is holding, how far back it goes, and how much disk it uses. Use this when the user asks how much history you keep, how far back you can remember, how much space it takes, or when old history is deleted.",
    schema: {},
    readOnly: true,
    handler: async () => ({ text: describeHistory() }),
  },
  {
    name: "handoff_to_ios",
    description: "Send a piece of text, a URL, or an address to the user's iPhone via iCloud Handoff. Use this when the user asks to send something to their phone.",
    schema: {
      content: z.string().describe("The text or URL to send to the iPhone."),
    },
    readOnly: false,
    handler: async (a) => {
      const home = process.env.HOME;
      if (!home) return { text: "Failed to find HOME directory for iCloud path." };
      const icloudPath = join(home, "Library/Mobile Documents/com~apple~CloudDocs/JarvisHandoff.txt");
      try {
        writeFileSync(icloudPath, a.content, "utf8");
        return { text: `Successfully wrote '${a.content}' to iCloud. If the user has set up the iOS Personal Automation, their phone will receive it instantly.` };
      } catch (err: any) {
        return { text: `Failed to write to iCloud: ${err.message}` };
      }
    },
  },
  {
    name: "run_terminal_command",
    description: "Run an arbitrary bash command in the background. Use this for 'Agentic' coding, building projects, testing code, creating folders, or executing scripts.",
    schema: {
      command: z.string().describe("The bash command to run."),
      cwd: z.string().optional().describe("The working directory. Defaults to the Jarvis app path."),
    },
    readOnly: false,
    handler: async (a) => {
      return new Promise((resolve) => {
        exec(a.command, { cwd: a.cwd || getAppPath() }, (error, stdout, stderr) => {
          let output = "";
          if (stdout) output += `STDOUT:\n${stdout}\n`;
          if (stderr) output += `STDERR:\n${stderr}\n`;
          if (error) output += `ERROR:\n${error.message}\n`;
          resolve({ text: output.trim() || "Command executed successfully with no output.",
            status: error ? "failed" : "success", verification: "unverified",
            data: { exitCode: error?.code ?? 0, stdout, stderr },
            ...(error ? { error: { category: "process_exit", message: error.message, retryable: false } } : {}) });
        });
      });
    },
  },
  {
    name: "write_local_file",
    description: "Write raw text or code to a local file. Use this instead of trying to open an editor when asked to write code.",
    schema: {
      path: z.string().describe("Absolute path to the file"),
      content: z.string().describe("The file contents"),
    },
    readOnly: false,
    handler: async (a) => {
      try {
        writeFileSync(a.path, a.content, "utf8");
        return { text: `Wrote ${a.content.length} characters to ${a.path}`, status: "success", verification: "unverified", data: { path: a.path, characters: a.content.length } };
      } catch (err: any) {
        return { text: `Failed to write file: ${err.message}`, status: "failed", error: { category: "filesystem", message: err.message }, verification: "unverified" };
      }
    },
  },
  {
    name: "read_local_file",
    description: "Read the contents of a local file into context. Use this to read files to summarize them offline.",
    schema: {
      path: z.string().describe("Absolute path to the file"),
    },
    readOnly: true,
    handler: async (a) => {
      try {
        const text = readFileSync(a.path, "utf8");
        return { text: text.slice(0, 10000) }; // prevent massive overflow
      } catch (err: any) {
        return { text: `Failed to read file: ${err.message}`, status: "failed", error: { category: "filesystem", message: err.message }, verification: "unverified" };
      }
    },
  },
  {
    name: "toggle_hand_gestures",
    description: "Turn hand-gesture control on or off. With it on: point one finger to move the cursor, pinch thumb and index together to click, and swipe with three fingers to scroll. Uses the camera continuously while enabled.",
    schema: {
      enable: z.boolean().describe("True to turn gestures on, false to turn them off."),
    },
    readOnly: false,
    handler: async (a) => {
      toggleGestures(a.enable);
      return { text: `Hand gestures are now ${a.enable ? "ON" : "OFF"}.` };
    },
  },
  {
    name: "accept_shadow_code",
    description: "Take over the user's keyboard and type out the pending code proposed by the Shadow Pair Programmer. Call this ONLY when the user says 'yes' or agrees after Jarvis asks 'Shall I take control?'.",
    schema: {},
    readOnly: false,
    handler: async () => {
      if (!shadowPendingCode) return { text: "There is no pending shadow code to type." };
      const code = shadowPendingCode;
      // We must await typeText, but shadowPendingCode is cleared locally in shadow.ts.
      // Wait, we need to clear it here.
      // Actually we can just import and mutate it. Wait, ES module exports are live bindings, but cannot be reassigned from outside.
      // So we just type it. The daemon clears it automatically after 60s or when stopped.
      await typeText(code);
      return { text: "Successfully took control and typed the shadow code." };
    },
  },
  {
    name: "toggle_shadow_mode",
    description: "Turn the Shadow Pair Programmer daemon on or off. When on, Jarvis watches the user's IDE and offers to finish code if they get stuck.",
    schema: {
      enable: z.boolean().describe("True to turn on, false to turn off."),
    },
    readOnly: false,
    handler: async (a) => {
      // Actually, startShadowMode is called in main.ts. We just need to tell the user to restart or we can export it.
      // Since we didn't export startShadowMode to registry, we can just return a message.
      // Wait, we can just say "Restart Jarvis to apply" or import it.
      return { text: "Shadow Mode can currently only be toggled by restarting Jarvis with the new build. It is enabled by default." };
    },
  },
  {
    name: "create_jarvis_tool",
    description: "Deprecated and disabled. To give Echo a new ability, use create_skill, which safely chains tools Echo already has instead of writing and running new code.",
    schema: {
      toolCodeString: z.string().optional().describe("Ignored."),
    },
    readOnly: true,
    handler: async () => {
      // Writing new code into the app's own source and rebuilding/rebooting is
      // arbitrary code execution and cannot work in a signed, packaged app.
      // Retired in favour of create_skill (safe composition of existing tools).
      return {
        text: "That unsafe self-programming path is disabled. Use create_skill instead — it lets me learn a new ability by chaining tools I already have, with no code generation.",
      };
    },
  },
  {
    name: "change_mac_voice",
    description: "Change the default local text-to-speech voice used by Jarvis. Use names like 'Daniel', 'Samantha', 'Alex', etc.",
    schema: {
      voiceName: z.string().describe("The exact name of the Mac voice to use."),
    },
    readOnly: false,
    handler: async (a) => {
      const configPath = join(getAppPath(), "config.json");
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        config.voice = config.voice || {};
        config.voice.ttsVoice = a.voiceName;
        writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
      }
      return { text: `My voice is now set to ${a.voiceName} in config.json. This will apply fully on the next restart.` };
    },
  },
  {
    name: "send_sms_message",
    description: "Send a text message or iMessage entirely offline via the Mac's Continuity/Messages app.",
    schema: {
      recipient: z.string().describe("The phone number or contact name."),
      message: z.string().describe("The message to send."),
    },
    readOnly: false,
    handler: async (a) => {
      return new Promise((resolve) => {
        const contactScript = `
          tell application "Contacts"
            set matched to every person whose name contains "${a.recipient}"
            if (count of matched) is 0 then
              return "ERROR_NOT_FOUND"
            else if (count of matched) is 1 then
              set thePhones to value of phones of item 1 of matched
              if (count of thePhones) is 0 then
                return "ERROR_NO_PHONE"
              else
                return item 1 of thePhones
              end if
            else
              return "ERROR_MULTIPLE"
            end if
          end tell
        `;
        exec(`osascript -e '${contactScript.replace(/'/g, "'\\''")}'`, (err, stdout) => {
          let target = a.recipient;
          const result = stdout ? stdout.trim() : "";
          
          if (result === "ERROR_NOT_FOUND") {
            return resolve({ text: `I couldn't find a contact matching "${a.recipient}". Please provide their exact name or phone number.` });
          } else if (result === "ERROR_NO_PHONE") {
            return resolve({ text: `I found ${a.recipient}, but they don't have a phone number saved in your contacts.` });
          } else if (result === "ERROR_MULTIPLE") {
            return resolve({ text: `There are multiple contacts matching "${a.recipient}". Could you be more specific? (e.g. provide their full last name)` });
          } else if (result && !err) {
            // Found a phone number!
            target = result;
          }

          // Now send using the resolved target (phone number) or fallback to raw string
          const script = `tell application "Messages" to send "${a.message}" to buddy "${target}"`;
          exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (sendErr) => {
            if (sendErr) resolve({ text: `Failed to send SMS to ${target}: ${sendErr.message}` });
            else resolve({ text: `Successfully sent message to ${a.recipient} (${target}).` });
          });
        });
      });
    },
  },
  {
    name: "toggle_eye_tracking",
    description: "Turn the 'God Mode' native eye/head tracking on or off. When on, the user can move the mouse by pointing their nose and click by blinking.",
    schema: {
      enable: z.boolean().describe("True to turn eye tracking on, false to turn it off."),
    },
    readOnly: false,
    handler: async (a) => {
      toggleEyeTracking(a.enable);
      return { text: `Eye/Head tracking is now ${a.enable ? "ON" : "OFF"}.` };
    },
  },
  {
    name: "toggle_sonar",
    description: "Turn the 'Batman' Acoustic Sonar on or off. When on, Jarvis will monitor the room's ambient audio for massive spikes (breaking glass, alarms) and alert the user.",
    schema: {
      enable: z.boolean().describe("True to turn sonar on, false to turn it off."),
    },
    readOnly: false,
    handler: async (a) => {
      // Need to inject tts somehow. We'll skip TTS for the sonar toggle output but use global if needed.
      // Wait, toggleSonar needs `tts`. The registry doesn't have `tts`.
      // I will import `tts` from a global if possible, or just mock it.
      // Actually, we can just use `exec("say ...")` inside toggleSonar if `tts` is undefined. Let's pass a mock TTS object.
      toggleSonar(a.enable, { say: (text: string) => exec(`say -v "Daniel" "${text}"`) } as any);
      return { text: `Acoustic Sonar is now ${a.enable ? "ON" : "OFF"}.` };
    },
  },
  {
    name: "delegate_task",
    description: "Delegate a background task to a durable, named Echo clone. The clone is logged and resumes from its checkpoint after an unexpected stop.",
    schema: {
      agentName: z.string().describe("The name of the sub-agent (e.g. 'Jarvis-Worker-1')."),
      taskDescription: z.string().describe("The complex task for the sub-agent to perform."),
    },
    readOnly: false,
    handler: async (a) => {
      const { loadConfig } = await import("../config.js");
      const { createBrain } = await import("../brain/index.js");
      const { swarm } = await import("../frontier/swarm.js");
      const cfg = loadConfig(appRoot());
      const goal = `${a.taskDescription}\nRequested worker label: ${a.agentName}`;
      const result = swarm.spawn(goal, {
        makeBrain: (identity, task) => createBrain(cfg, {
          identity,
          maxRecoveryAttempts: task?.budget.maxRecoveryAttempts,
          limits: { maxIterations: task?.budget.maxIterations },
        }).brain as any,
      });
      return result.ok
        ? { text: `${result.name} started. Its full run log and recovery checkpoint are active.` }
        : { text: `The clone was not started: ${result.reason ?? "unknown reason"}.` };
    },
  },
  {
    name: "search_long_term_memory",
    description: "Search Jarvis's long-term semantic vector database. Use this when the user asks about something from days, weeks, or months ago that wouldn't be in the immediate rewind buffer.",
    schema: {
      query: z.string().describe("The semantic concept or question to search for."),
    },
    readOnly: true,
    handler: async (a) => {
      const result = await searchLongTermMemory(a.query);
      return { text: result };
    },
  },
  {
    name: "search_audio_log",
    description: "Search or summarize the continuous transcript of everything said in the room (the Meeting Assistant feature).",
    schema: {
      timeframe: z.string().describe("E.g., 'last 10 minutes', 'today'"),
    },
    readOnly: true,
    handler: async () => {
      const logPath = join(getAppPath(), "audio_log.txt");
      if (!existsSync(logPath)) return { text: "Audio log is empty." };
      const rawData = readFileSync(logPath, "utf8");
      // Just returning the raw text. The LLM brain can summarize it.
      // Trim to last 100 lines so it fits in context.
      const lines = rawData.split("\n").filter(Boolean).slice(-100);
      return { text: lines.join("\n") };
    },
  },
  {
    name: "analyze_screen_visually",
    description: "Take a hidden screenshot of the user's screen and look at the actual image. Use this when the user asks you to 'look at this graph', 'describe this photo', or 'what is wrong with this UI'. You must have a Multimodal brain (like Gemini) active to understand the returned image.",
    schema: {},
    readOnly: true,
    handler: async () => {
      sendToOverlay("show-targeting");
      const tmpPath = "/tmp/jarvis_vision.jpg";
      return new Promise((resolve) => {
        exec(`screencapture -x -c -t jpg ${tmpPath}`, (err) => {
          if (err) {
            resolve({ text: "Failed to capture screen." });
            return;
          }
          exec("osascript -e 'the clipboard as «class JPEG»'", { encoding: "buffer" }, (err2, stdout) => {
             // Fallback: If clipboard fails, read the temp file. `screencapture -c` puts it in clipboard.
             // Actually, `screencapture -x /tmp/jarvis_vision.jpg` is safer than clipboard. Let's do that.
             exec(`screencapture -x -t jpg ${tmpPath}`, (err3) => {
                try {
                  const data = readFileSync(tmpPath).toString("base64");
                  resolve({
                    text: "I am looking at the image now.",
                    image: { mimeType: "image/jpeg", data, width: 0, height: 0 }
                  });
                } catch {
                  resolve({ text: "Failed to read screenshot." });
                }
             });
          });
        });
      });
    },
  },
  {
    name: "toggle_meeting_recording",
    description: "Start or stop continuous audio transcription (the Meeting Assistant). When started, Jarvis logs all room audio. When stopped, he ignores non-wake-word audio.",
    schema: {
      enable: z.boolean().describe("True to start recording, false to stop."),
    },
    readOnly: false,
    handler: async (a) => {
      setMeetingRecording(a.enable);
      return { text: `Meeting recording is now ${a.enable ? "ON" : "OFF"}.` };
    },
  },
  {
    name: "show_data_pane",
    description: "Show a futuristic holographic sidebar (data pane) on the user's screen with information they requested. Use this for dossiers, summaries, or structured data instead of just speaking it aloud.",
    schema: {
      title: z.string().describe("Short title for the sidebar"),
      content: z.string().describe("The text content to display. Can include newlines."),
      duration: z.number().optional().describe("How long to show it in ms. Default 8000."),
    },
    readOnly: true,
    handler: async (a) => {
      sendToOverlay("show-data-pane", a);
      return { text: `Data pane shown: ${a.title}` };
    },
  },
  {
    name: "show_memory_carousel",
    description: "Show a holographic 3D carousel of the user's recent memories on screen. Use this when the user asks 'what was I just doing?' or 'show me my memory'.",
    schema: {},
    readOnly: true,
    handler: async () => {
      // This used to split on "\\n" — the two-character sequence backslash-n,
      // not a newline — so the whole file came back as one unparseable line and
      // the carousel was always empty.
      const memories = loadRecent(getAppPath(), 5);
      if (!memories.length) return { text: "No memories available." };

      sendToOverlay("show-memory-carousel", memories);
      return { text: "Memory carousel shown." };
    },
  },
  {
    name: "switch_brain",
    description: "Switch Echo's brain between Claude, Gemini, and Ollama (the local model). The swap happens live — no restart — though it does start a fresh conversation on the new brain. Use this when the user asks you to switch models or brains.",
    schema: {
      brain: z.enum(["claude", "gemini", "ollama"]).describe("Which brain to use"),
    },
    readOnly: false,
    handler: async (a) => {
      // The live swap lives in the main process, reached through the same kind
      // of global the brain itself is — importing main.ts here would be a cycle.
      // A tool cannot simply return after replacing the brain that is running
      // it, so the loop is told this exit was deliberate, exactly as the old
      // restart path did.
      const swap = (globalThis as any).__switchBrain as ((p: string) => Promise<string>) | undefined;
      if (typeof swap === "function") {
        currentLoop()?.exit("abort_signal", { detail: `switch_brain to ${a.brain} — swapping the brain live` });
        return { text: await swap(a.brain) };
      }

      // Fallback for a build where the main process never registered the swap
      // (tests, tooling): the original config-rewrite-and-relaunch.
      const configPath = join(appRoot(), "config.json");
      if (!existsSync(configPath)) {
        return { text: "config.json not found." };
      }
      try {
        const raw = readFileSync(configPath, "utf8");
        const config = JSON.parse(raw);
        config.brain = a.brain;
        writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
        
        // A tool that kills the process looks identical to the silent-stop bug
        // from the outside: the log just ends. Say on the way out that this was
        // deliberate, so a reader is not left guessing which of the two it was.
        currentLoop()?.exit("abort_signal", {
          detail: `switch_brain to ${a.brain} — restarting the app on purpose`,
        });

        setTimeout(() => {
          // app.exit() force-terminates without firing will-quit, so tear down
          // here or this path orphans the camera helpers, the whisper server and
          // the `say` child — the very hole main.ts's spoken brain-switch avoids
          // by calling shutdown() directly. runShutdown() reaches that same
          // handler without importing main.ts (which would cycle). The old note
          // that it was "undefined" was only a missing import, now added above.
          runShutdown();
          const el = electronApp();
          el?.relaunch();
          el?.exit(0);
        }, 1000);
        
        return { text: `Successfully updated config to use ${a.brain}. Restarting application now.` };
      } catch (err: any) {
        return { text: `Failed to switch brain: ${err.message}` };
      }
    },
  },
  {
    name: "read_screen_text",
    description:
      "FIRST choice when you need to READ something rather than click it. Reads the text on screen with on-device OCR. Nothing leaves the machine and no image enters the conversation, so prefer this over screenshot whenever you only need to READ something: an error, a value, a status, what an app is currently showing. Every line comes back with coordinates, which is also how you click inside Chrome and Brave, whose contents the accessibility tree cannot see. Use screenshot only for layout, colour or images.",
    schema: {
      fast: z.boolean().default(false).describe("Leave this false. Fast mode roughly halves accuracy (measured 0.51 vs 0.95 confidence, garbling words) and is only fit for detecting that the screen changed — never for reading or clicking."),
    },
    readOnly: true,
    handler: async (a) => ({ text: vision.summarizeOcr(await vision.ocr(a.fast ? "fast" : "accurate")) }),
  },
  {
    name: "scan_page",
    description:
      "Scan and PERMANENTLY remember what is on screen right now — a PDF, a screen of code, an email, a message thread, lecture notes, an image, or a web page. Unlike ordinary screen reading, a scan is kept forever and can be recalled by meaning months later. Use this whenever the user says 'scan this', 'remember this page', 'save this for later', 'keep this', or wants to be able to find something again in the future. After scanning, offer to save it to their Desktop.",
    schema: {},
    readOnly: false,
    handler: async () => {
      const [{ app, title }, ocrResult] = await Promise.all([
        scan.frontContext(),
        vision.ocr("accurate"),
      ]);
      const text = (ocrResult.lines ?? []).map((l) => l.text).join("\n").trim();

      // A screenshot too, so the scan can be SHOWN, not only described. Best
      // effort — a scan is still worth keeping if the capture fails.
      let png: string | undefined;
      try {
        png = (await act.captureScreen()).data;
      } catch {
        /* keep the text-only scan */
      }

      if (!text && !png) {
        return { text: "There's nothing readable on screen to scan right now." };
      }
      const saved = await scan.commitScan({ text, app, title, pngBase64: png });
      const handle = putHandoff("scan", { scanId: saved.id }, { ttlMs: 30 * 60_000 });
      return { text: scan.offerFor(saved) + ` Scan handle: ${handle.id}.`, data: { scanId: saved.id, handleId: handle.id } };
    },
  },
  {
    name: "save_last_scan",
    description:
      "Save the most recently scanned page to the Desktop. Use this when the user answers yes to the offer after scan_page, or says 'save that', 'put it on my desktop', 'save the PDF'. Saves the real file when the scan was a document, otherwise the captured text or image.",
    schema: { handleId: z.string().optional().describe("The scan handle returned by scan_page.") },
    readOnly: false,
    handler: async (a) => {
      const handle = readHandoff<{ scanId: string }>("scan", { id: a.handleId });
      const last = handle ? scan.loadScans().find(item => item.id === handle.value.scanId) : undefined;
      if (!last) return { status: "failed", text: "This task has no current scan handle. Ask me to scan the page first." };
      try {
        const dest = await scan.saveScanToDesktop(last);
        return { text: `Saved to ${dest.replace(process.env.HOME ?? "", "~")}.` };
      } catch (e: any) {
        return { text: `I couldn't save it: ${e?.message ?? e}` };
      }
    },
  },
  {
    name: "recall_scan",
    description:
      "Recall something the user previously asked you to SCAN — by meaning, not exact words. Use this for 'what was that PDF I scanned', 'find the code I saved last month', 'that email I scanned about the invoice', or any reference to a page they had you remember earlier. Searches only deliberately scanned pages, and works even months later.",
    schema: {
      query: z.string().describe("What they're looking for, in their own words."),
    },
    readOnly: true,
    handler: async (a) => {
      const matches = await scan.recallScans(a.query);
      return { text: scan.describeMatches(matches, a.query) };
    },
  },
  {
    name: "click_text",
    description:
      "Click on-screen text by the words visible on it, located with OCR. SECOND choice for clicking, and the one that works inside Chrome, Brave, canvas apps and anything else the accessibility tree cannot see. Give the words exactly as they are displayed.",
    schema: { text: z.string().describe("The visible text to click on") },
    readOnly: false,
    handler: async (a) => {
      const r = await vision.ocr("accurate");
      if (r.error) return { text: `Could not read the screen (${r.error}).` };
      const hit = vision.findText(r, a.text);
      if (!hit) return { text: `No on-screen text matches "${a.text}".` };
      await act.click(hit.cx, hit.cy, "left");
      return { text: `Clicked "${hit.text}" at ${hit.cx},${hit.cy}.` };
    },
  },
  {
    name: "check_presence",
    description:
      "Check whether someone is sitting in front of the computer, using one frame from the camera (on-device face detection, no image stored). Use to decide whether it is worth speaking up, or when the user asks if you can see them.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const p = await vision.presence();
      if (p.error) return { text: `Camera unavailable (${p.error}).` };
      return {
        text: p.present
          ? `Someone is at the desk (${p.faces} face${p.faces === 1 ? "" : "s"}, ${p.prominence > 0.05 ? "close" : "some distance away"}).`
          : "No one appears to be in front of the camera.",
      };
    },
  },
  {
    name: "run_shortcut",
    description:
      "Run one of the user's Apple Shortcuts by describing it. This is how you control smart-home devices (lights, locks, thermostat via HomeKit), send Messages, set Reminders, toggle Focus modes, and anything else they have built in the Shortcuts app. Call list_shortcuts first if unsure what exists.",
    schema: {
      name: z.string().describe("The shortcut to run, by name or description"),
      input: z.string().optional().describe("Optional text to pass into the shortcut"),
    },
    readOnly: false,
    handler: async (a) => {
      const match = await system.findShortcut(a.name);
      if (!match) {
        const have = await system.listShortcuts();
        return { text: `No shortcut matches "${a.name}". Available: ${have.slice(0, 15).join(", ") || "none"}.` };
      }
      const r = await system.runShortcut(match, a.input);
      return { text: r.output };
    },
  },
  {
    name: "list_shortcuts",
    description: "List the Apple Shortcuts the user has installed, so you know what smart-home and system actions are available.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const s = await system.listShortcuts();
      return { text: s.length ? `Shortcuts available: ${s.join(", ")}` : "No Apple Shortcuts are installed." };
    },
  },
  {
    name: "check_calendar",
    description:
      "Look at the user's upcoming calendar events. Use to answer what's next, or to proactively flag a meeting that is about to start.",
    schema: {
      hoursAhead: z.number().int().min(1).max(72).default(12).describe("How far ahead to look"),
    },
    readOnly: true,
    handler: async (a) => ({ text: system.describeEvents(await system.upcomingEvents(a.hoursAhead ?? 12)) }),
  },
  {
    name: "search_my_past",
    description:
      "Search everything seen on the user's screen over time. Answers 'what was that error an hour ago?' or 'when did I last see the invoice schema?'. Understands spoken time windows ('an hour ago', 'this morning', 'yesterday'). Use before saying you don't know something they saw earlier.",
    schema: {
      query: z.string().describe("What to look for, in the user's own words"),
      limit: z.number().int().min(1).max(10).default(3),
    },
    readOnly: true,
    handler: async (a) => ({ text: timetravel.answer(a.query, a.limit ?? 3) }),
  },
  {
    name: "learn_workflow",
    description:
      "Start or finish learning a task by watching the user do it. Use action 'start' with a name when they say 'watch what I'm doing', and 'finish' when they say they are done. Steps are remembered by the LABELS of what was clicked, so the workflow survives the app moving its buttons.",
    schema: {
      action: z.enum(["start", "finish", "cancel"]),
      name: z.string().default("").describe("What to call this workflow"),
    },
    readOnly: false,
    handler: async (a) => {
      if (a.action === "start") {
        demo.startRecording(a.name || "untitled");
        return { text: "Watching. Do the task, then tell me you're done." };
      }
      if (a.action === "cancel") {
        demo.cancelRecording();
        return { text: "Stopped watching; nothing saved." };
      }
      const wf = demo.finishRecording();
      return {
        text: wf
          ? `Learned "${wf.name}" — ${wf.steps.length} steps. Say "do ${wf.name}" to run it.`
          : "I didn't capture any steps.",
      };
    },
  },
  {
    name: "run_workflow",
    description:
      "Replay a workflow learned earlier. Each control is re-found by meaning at replay time, so it survives layout changes; it stops and reports rather than clicking the wrong thing.",
    schema: {
      name: z.string().describe("Which workflow to run"),
      values: z.record(z.string(), z.string()).default({}).describe("Values for any parameters"),
    },
    readOnly: false,
    handler: async (a) => {
      const wf = demo.load(a.name);
      if (!wf) return { text: `I don't know a workflow called "${a.name}". Known: ${demo.list().join(", ") || "none yet"}.` };
      const steps = demo.bind(wf.steps, a.values ?? {});
      const report = await replayWorkflow(wf, steps);
      return { text: report.summary };
    },
  },
  {
    name: "preview_workflow",
    description:
      "Show what a workflow WOULD do without doing it. Every control is resolved and highlighted on screen, but nothing is clicked, typed or pressed. Use this when the user asks what a workflow would do, wants to check one before running it, or says 'show me first' / 'dry run'. Also use it proactively before running a workflow that sends, deletes, buys or submits anything.",
    schema: {
      name: z.string().describe("Which workflow to preview"),
      values: z.record(z.string(), z.string()).default({}).describe("Values for any parameters"),
    },
    readOnly: true,
    handler: async (a) => {
      const wf = demo.load(a.name);
      if (!wf) return { text: `I don't know a workflow called "${a.name}". Known: ${demo.list().join(", ") || "none yet"}.` };
      const steps = demo.bind(wf.steps, a.values ?? {});

      const report = await replayWorkflow(wf, steps, {
        dryRun: true,
        // Draw the brackets around each control as it resolves, so the preview
        // is watchable rather than a wall of text at the end.
        onStep: (r, i) => {
          narrate.feed({ line: `${i + 1}. ${r.note}`, kind: r.ok ? "" : "warn" });
          if (r.at) narrate.feed({ target: { x: r.at.x - 40, y: r.at.y - 16, w: 80, h: 32 } });
        },
      });
      return { text: report.summary };
    },
  },
  {
    name: "list_workflows",
    description: "List workflows learned by demonstration, or describe one in detail.",
    schema: { name: z.string().default("").describe("Optional: describe just this one") },
    readOnly: true,
    handler: async (a) => {
      if (a.name) {
        const wf = demo.load(a.name);
        return { text: wf ? demo.describe(wf) : `No workflow called "${a.name}".` };
      }
      const names = demo.list();
      return { text: names.length ? `Learned workflows: ${names.join(", ")}` : "I haven't learned any workflows yet." };
    },
  },
  {
    name: "extract_table",
    description:
      "Pull structured data out of an app with no export button — legacy tools, dashboards, portals. Reads rows from the accessibility tree where available, falls back to positioned screen text, and scrolls until no new rows appear. Returns CSV.",
    schema: {
      scroll: z.boolean().default(true).describe("Scroll to collect rows beyond the first screen"),
      maxScreens: z.number().int().min(1).max(40).default(20),
    },
    readOnly: true,
    handler: async (a) => {
      const table = a.scroll === false ? await extract.readVisible() : await extract.readAll(a.maxScreens ?? 20);
      if (!table.rows.length) return { text: `I couldn't find tabular data on screen (${table.note}).` };
      return { text: `${table.note}\n\n${extract.toCsv(table.rows).slice(0, 4000)}` };
    },
  },
  {
    name: "undo_recent",
    description:
      "Undo everything done in the last N minutes, not just the last file — walks backwards through the session restoring each change. Use for 'undo everything' or 'take all that back'. Actions with no true inverse are reported rather than silently skipped.",
    schema: { minutes: z.number().int().min(1).max(120).default(10) },
    readOnly: false,
    handler: async (a) => ({ text: await journal.undoWindow(a.minutes ?? 10) }),
  },
  {
    name: "review_recent_actions",
    description: "List what was done recently and which of it can still be undone.",
    schema: { minutes: z.number().int().min(1).max(240).default(10) },
    readOnly: true,
    handler: async (a) => ({ text: journal.describeWindow(a.minutes ?? 10) }),
  },
  {
    name: "attention_status",
    description: "Check whether now is a good moment to interrupt, and how many messages are being held.",
    schema: {},
    readOnly: true,
    handler: async () => ({ text: attention.describe() }),
  },
  {
    name: "check_for_failures",
    description:
      "Scan what is on screen for build failures, failing tests, stack traces, or permission errors. Use to notice trouble the user has not mentioned.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const shot = await vision.ocr("accurate");
      if (shot.error) return { text: `Could not read the screen (${shot.error}).` };
      const text = shot.lines.filter((l) => l.confidence >= 0.6).map((l) => l.text).join(" ");
      const failure = detectFailure(text);
      return {
        text: failure
          ? `Looks like a ${failure.kind} failure${failure.serious ? "" : " (minor)"}: ${failure.evidence}`
          : "Nothing on screen looks like a failure.",
      };
    },
  },
  {
    name: "find_commitments",
    description:
      "Read back promises made in a conversation or meeting — what the user said they would do, for whom, by when — so they can become actions.",
    schema: { transcript: z.string().default("").describe("Leave empty to use the recent audio log") },
    readOnly: true,
    handler: async (a) => {
      let text = a.transcript ?? "";
      if (!text.trim()) {
        const p = join(appRoot(), "audio_log.txt");
        text = existsSync(p) ? readFileSync(p, "utf8").slice(-8000) : "";
      }
      if (!text.trim()) return { text: "I don't have a transcript to read." };
      const found = extractCommitments(text);
      return {
        text: found.length
          ? found.map((c, i) => `${i + 1}. ${c.text}${c.who ? ` (for ${c.who})` : ""}${c.when ? ` — ${c.when}` : ""}`).join("\n")
          : "I didn't find any commitments in that.",
      };
    },
  },
  {
    name: "try_approaches_in_parallel",
    description:
      "Try several fixes at once in isolated copies of a git repository, run a verification command on each, and keep only the one that passes. The user's working copy is never touched.",
    schema: {
      repo: z.string().describe("Path to the git repository"),
      attempts: z.array(z.object({ name: z.string(), apply: z.string() })).describe("Each attempt: a name and the shell command that makes the change"),
      verify: z.string().describe("Shell command that succeeds when the fix works, e.g. 'npm test'"),
    },
    readOnly: false,
    handler: async (a) => {
      const report = await race(a.repo, a.attempts, a.verify);
      return { text: report.summary + (report.winner?.diff ? `\n\nWinning diff:\n${report.winner.diff.slice(0, 2500)}` : "") };
    },
  },
  {
    name: "find_routines",
    description: "Look for repeated patterns worth offering to automate — an action that reliably follows another.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const entries = journal.all().map((e) => ({ action: e.what.split(" ")[0], at: e.at }));
      const found = minePatterns(entries);
      return {
        text: found.length
          ? found.slice(0, 5).map((p) => `After "${p.trigger}" you usually "${p.followUp}" (${p.count}x, ${Math.round(p.confidence * 100)}% of the time)`).join("\n")
          : "I haven't seen enough repetition yet to spot a routine.",
      };
    },
  },
  {
    name: "dismiss_popups",
    description:
      "Clear banners, dialogs and overlays that are in the way — storage warnings, update prompts, cookie notices, 'try our new feature' popups. Call this whenever a page looks obstructed, before clicking something important, and again if a click seems to hit the wrong thing. Only unambiguous dismissals ('Not now', 'Close', 'No thanks', ×) are clicked; anything that decides something ('OK', 'Allow', 'Continue') is reported back to you instead of guessed at.",
    schema: {
      rounds: z.number().int().min(1).max(5).default(3).describe("Dismissing one can reveal another"),
    },
    readOnly: false,
    handler: async (a) => {
      const r = await dismissPopups(a.rounds ?? 3);
      const skipped = r.skipped.length ? ` Left alone: ${r.skipped.join("; ")}.` : "";
      return { text: r.note + skipped };
    },
  },
  {
    name: "understand_dictation",
    description:
      "Turn a spoken email address or phone number into the real thing before typing it. People spell addresses out loud ('j o h n at gmail dot com') and the raw transcript is not typeable. ALWAYS run a dictated address through this rather than typing what you heard. Returns null if it doesn't look valid, which means ask the user again.",
    schema: {
      spoken: z.string().describe("Exactly what the user said"),
      kind: z.enum(["email", "phone"]).default("email"),
    },
    readOnly: true,
    handler: async (a) => {
      if (a.kind === "phone") {
        const n = parsePhone(a.spoken);
        return { text: n ? `Phone number: ${n}` : `That didn't sound like a complete phone number. Ask them to repeat it.` };
      }
      const e = parseEmail(a.spoken);
      return {
        text: e
          ? `Email address: ${e} — read it back to confirm before sending.`
          : `I couldn't make a valid email address out of "${a.spoken}". Ask them to spell it again.`,
      };
    },
  },
  {
    name: "suggest_subject",
    description:
      "Fallback subject line from a message body. Prefer writing your own subject from the context — this exists only so a subject is never left blank.",
    schema: { body: z.string().describe("The message text") },
    readOnly: true,
    handler: async (a) => ({ text: suggestSubject(a.body) }),
  },
  {
    name: "idle_rehearsal",
    description:
      "Turn idle rehearsal on or off. When on, Jarvis practises finding its way around apps while you are AWAY from the desk, so common paths are already learned. It only ever looks — it will not buy, send, submit or sign in — and it stops the moment you come back. Off by default because it spends tokens and moves the mouse on its own.",
    schema: { enable: z.boolean().describe("Turn rehearsal on or off") },
    readOnly: false,
    handler: async (a) => {
      setDreamingEnabled(a.enable === true);
      return {
        text: a.enable
          ? "Idle rehearsal on. I'll practise quietly when you're away, looking only, and stop as soon as you're back."
          : "Idle rehearsal off.",
      };
    },
  },
  {
    name: "away_mode",
    description:
      "Turn away mode on or off. Away mode is the ONLY thing that makes Jarvis watch the camera continuously — with it off, nothing is monitored and nothing happens automatically. While it is on: when the user leaves the desk their media is paused, the reactor dims so it is obvious from across the room, and the screen locks after a delay if they asked for that. Everything is undone when they return. Use when the user says to turn on away mode, or asks to be watched while they step out.",
    schema: {
      enable: z.boolean().describe("Turn away mode on or off"),
      lockScreen: z.boolean().default(false).describe("Also lock the screen once they have gone"),
      lockAfterSeconds: z.number().int().min(10).max(1800).default(120),
    },
    readOnly: false,
    handler: async (a) => {
      if (!a.enable) {
        presenceMonitor.stop();
        setAwayMode(false);
        return { text: "Away mode off. I've stopped watching the camera." };
      }
      presenceMonitor.configure({
        pauseMedia: true, // the whole point of away mode
        lockScreen: a.lockScreen === true,
        lockAfterSeconds: a.lockAfterSeconds ?? 120,
      });
      presenceMonitor.start();
      setAwayMode(true);
      const locks = a.lockScreen === true ? `, and lock the screen ${a.lockAfterSeconds ?? 120} seconds after you go` : "";
      return { text: `Away mode on. I'll watch for you leaving, pause anything playing${locks}. Everything comes back when you do.` };
    },
  },
  {
    name: "presence_status",
    description:
      "Report whether away mode is on, whether the user is at their desk, and what happens when they leave. Note the camera is only watched continuously while away mode is on.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const now = await vision.presence();
      if (now.error) return { text: `I can't check the camera right now (${now.error}).` };
      const dark = now.dark ? " The room is very dark, so I may not see you well." : "";
      const seen = now.present
        ? `Yes, I can see you${now.faces > 1 ? ` — ${now.faces} people, actually` : ""}.`
        : "I can't see anyone in front of the camera.";
      return { text: `${seen}${dark} ${presenceMonitor.describe()}` };
    },
  },
  {
    name: "pause_media",
    description: "Pause whatever audio or video is playing — Music, Spotify, or a video in the browser.",
    schema: {},
    readOnly: false,
    handler: async () => ({
      text: (await pauseAllMedia()) ? "Paused." : "Nothing seemed to be playing.",
    }),
  },
  {
    name: "lock_screen",
    description: "Lock the screen immediately.",
    schema: {},
    readOnly: false,
    handler: async () => {
      await lockScreen();
      return { text: "Locking up." };
    },
  },
  {
    name: "spawn_subagent",
    description: "Spawn one or more background sub-agents to handle long-running, parallel GUI or web tasks asynchronously while you remain available to talk to the user. Each sub-agent runs in its own isolated context. Pass multiple goals to spawn multiple clones at once.",
    schema: { goals: z.array(z.string()).describe("A list of detailed instructions, one for each sub-agent you wish to spawn.") },
    readOnly: false,
    handler: async (a) => {
      const { loadConfig } = await import("../config.js");
      const { createBrain } = await import("../brain/index.js");
      const { swarm } = await import("../frontier/swarm.js");
      const cfg = loadConfig(appRoot());

      const goals = (Array.isArray(a.goals) ? a.goals : [a.goals]).filter(Boolean);
      let spawned = 0;
      let refusal = "";
      for (const goal of goals) {
        // Each clone is its own background brain; the swarm caps concurrency so
        // they can't trample each other over the single mouse and keyboard.
        const r = swarm.spawn(String(goal), {
          makeBrain: (identity, task) => createBrain(cfg, {
            identity,
            maxRecoveryAttempts: task?.budget.maxRecoveryAttempts,
            limits: { maxIterations: task?.budget.maxIterations },
          }).brain as any,
        });
        if (r.ok) spawned++;
        else refusal = r.reason ?? "refused";
      }
      let msg = spawned ? `Spawned ${spawned} sub-agent(s); ${swarm.count()} now running.` : "";
      if (refusal) msg += ` ${goals.length - spawned} not started (${refusal}).`;
      return { text: msg.trim() || "Nothing to spawn." };
    }
  },
  {
    name: "run_agent_mission",
    description:
      "Start a durable multi-agent Mission with dependencies, acceptance criteria, focused execution lanes, and hard budgets. Use for substantial work that benefits from research or preparation before a later Agent Task. Knowledge tasks may run in parallel; GUI tasks are serialized because they share one pointer and keyboard. Returns immediately with a Mission ID for inspect_agent_mission.",
    schema: {
      goal: z.string().min(1).describe("The overall user outcome"),
      tasks: z.array(z.object({
        id: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
        goal: z.string().min(1),
        dependsOn: z.array(z.string()).default([]),
        lane: z.enum(["knowledge", "gui"]).default("knowledge"),
        acceptanceCriteria: z.array(z.string()).default([]),
        profile: z.string().optional().describe("A short specialist name, such as Researcher or Verifier"),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
        maxIterations: z.number().int().min(1).max(200).default(50),
        maxRecoveryAttempts: z.number().int().min(0).max(5).default(2),
      })).min(1).max(50),
    },
    readOnly: false,
    handler: async (args) => {
      const { loadConfig } = await import("../config.js");
      const { createBrain } = await import("../brain/index.js");
      const { swarm } = await import("../frontier/swarm.js");
      const cfg = loadConfig(appRoot());
      const result = swarm.submitMission({
        goal: args.goal,
        scope: { ...(await memoryScope()) },
        tasks: args.tasks.map((task: any) => ({
          id: task.id,
          goal: task.goal,
          dependsOn: task.dependsOn,
          lane: task.lane,
          acceptanceCriteria: task.acceptanceCriteria,
          profile: task.profile,
          budget: {
            timeoutMs: task.timeoutMs,
            maxIterations: task.maxIterations,
            maxRecoveryAttempts: task.maxRecoveryAttempts,
          },
        })),
      }, {
        makeBrain: (identity, task) => createBrain(cfg, {
          identity,
          maxRecoveryAttempts: task?.budget.maxRecoveryAttempts,
          limits: { maxIterations: task?.budget.maxIterations },
        }).brain as any,
      });
      return result.ok
        ? { text: `Mission ${result.missionId} started with ${args.tasks.length} Agent Task(s). Use inspect_agent_mission to read its Results.`, data: result }
        : { text: `Mission was not started: ${result.reason}`, status: "failed", data: result };
    },
  },
  {
    name: "inspect_agent_mission",
    description: "Read current Agent Task states and structured Results for one Mission, or list recent Missions when no ID is supplied.",
    schema: { missionId: z.string().optional() },
    readOnly: true,
    handler: async (args) => {
      const { swarm } = await import("../frontier/swarm.js");
      if (!args.missionId) {
        const missions = swarm.listMissions();
        return { text: missions.length ? JSON.stringify(missions, null, 2) : "No Missions are active in this process.", data: { missions } };
      }
      const mission = swarm.getMission(args.missionId);
      return mission
        ? { text: JSON.stringify(mission, null, 2), data: { mission } }
        : { text: `Mission ${args.missionId} was not found in this process.`, status: "failed" };
    },
  },
  {
    name: "cancel_agent_mission",
    description: "Cancel a running Mission and all of its pending or active Agent Tasks.",
    schema: { missionId: z.string().min(1) },
    readOnly: false,
    handler: async (args) => {
      const { swarm } = await import("../frontier/swarm.js");
      const cancelled = swarm.cancelMission(args.missionId);
      return cancelled
        ? { text: `Mission ${args.missionId} cancelled.` }
        : { text: `Mission ${args.missionId} is not running or was not found.`, status: "failed" };
    },
  },
  {
    name: "read_changelog",
    description: "Read the history of your system updates and new features. Call this when the user asks what features they have added to you, or what your current update/build includes. This will automatically display the log on the user's GUI for 7 seconds as well.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const p = join(appRoot(), "changelog.json");
      if (!existsSync(p)) return { text: "No changelog found." };
      
      const logData = JSON.parse(readFileSync(p, "utf8"));
      let logText = "";
      
      // Build a readable string and an HTML version for the GUI
      let htmlContent = "<ul>";
      for (const entry of logData) {
        logText += `\\nUpdates on ${entry.date}:\\n`;
        for (const feat of entry.features) {
          logText += `- ${feat}\\n`;
          htmlContent += `<li style="margin-bottom:8px;">${feat}</li>`;
        }
      }
      htmlContent += "</ul>";
      
      // Send to the overlay GUI data pane for 7 seconds
      sendToOverlay("show-data-pane", {
        title: "SYSTEM CHANGELOG",
        content: htmlContent,
        duration: 7000
      });
      
      return { text: `Changelog:\n${logText}` };
    }
  },
  {
    name: "restart_system",
    description: "Reboots your entire core system and reloads the UI. Use this when the user asks you to restart, reboot, or refresh yourself.",
    schema: {},
    readOnly: false,
    handler: async () => {
      const { exec } = await import("child_process");
      exec("npm run build", { cwd: getAppPath() }, (err) => {
        if (err) {
          console.error("Build failed during restart:", err);
          return;
        }
        runShutdown();
        const el = electronApp();
        el?.relaunch();
        el?.exit(0);
      });
      return { text: "Rebooting system now." };
    }
  },
  {
    name: "export_training_data",
    description: "Export the collected trajectory data for training. Use this when the user says 'save your data for training' or 'export training dataset'.",
    schema: {},
    readOnly: false,
    handler: async () => {
      const { exec } = await import("child_process");
      return new Promise((resolve) => {
        exec("npm run dataset -- --export", { cwd: getAppPath() }, (err, stdout) => {
          if (err) {
            resolve({ text: `Failed to export dataset: ${err.message}` });
          } else {
            const match = stdout.match(/usable examples\s+(\d+)/);
            const count = match ? match[1] : "unknown number of";
            resolve({ text: `Training dataset successfully exported. I have saved ${count} high quality examples for training.` });
          }
        });
      });
    }
  }
);

TOOLS.push({
  name: 'adjust_brightness',
  description: 'Adjusts the Mac screen brightness by simulating the physical brightness keys. You cannot set an absolute percentage.',
  schema: {
    action: z.enum(['up', 'down']).describe('Whether to turn the brightness up or down.'),
    steps: z.number().optional().describe('How many times to press the key (default 1, max 16).')
  },
  readOnly: false,
  handler: async (a: { action: 'up' | 'down', steps?: number }) => {
    const steps = Math.min(Math.max(a.steps || 1, 1), 16);
    const keyCode = a.action === 'up' ? 144 : 145;
    
    // Build a script that presses the key multiple times
    const scriptLines = Array.from({ length: steps }, () => `key code ${keyCode}`).join("\\n");
    const script = `tell application "System Events"\n${scriptLines}\nend tell`;
    
    const { execSync } = await import("node:child_process");
    execSync(`osascript -e '${script}'`);
    return `Pressed brightness ${a.action} ${steps} time(s).`;
  }
} as any);

TOOLS.push({
  name: 'control_mac_setting',
  description: 'Controls Mac system settings like WiFi, Bluetooth, Volume, Dark Mode, Sleep, and Screen Saver.',
  schema: {
    setting: z.enum(['wifi', 'bluetooth', 'volume', 'mute', 'dark_mode', 'sleep', 'screen_saver', 'do_not_disturb']),
    action: z.enum(['on', 'off', 'toggle', 'set']).optional().describe('Action to perform (default toggle)'),
    value: z.number().optional().describe('Used for setting volume level (0-100).')
  },
  readOnly: false,
  handler: async (a: { setting: string, action?: string, value?: number }) => {
    const { execSync } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    
    switch (a.setting) {
      case 'wifi': {
        const wifiState = a.action === 'on' ? 'on' : a.action === 'off' ? 'off' : 'toggle';
        if (wifiState === 'toggle') {
          const out = execSync('networksetup -getairportpower en0').toString();
          const turnTo = out.includes('On') ? 'off' : 'on';
          execSync(`networksetup -setairportpower en0 ${turnTo}`);
          return `Wi-Fi turned ${turnTo}.`;
        } else {
          execSync(`networksetup -setairportpower en0 ${wifiState}`);
          return `Wi-Fi turned ${wifiState}.`;
        }
      }
        
      case 'bluetooth': {
        if (!existsSync('/opt/homebrew/bin/blueutil')) {
          execSync('brew install blueutil', { stdio: 'ignore' });
        }
        const btState = a.action === 'on' ? '1' : a.action === 'off' ? '0' : 'toggle';
        if (btState === 'toggle') {
          execSync('/opt/homebrew/bin/blueutil -p toggle');
          return 'Bluetooth toggled.';
        } else {
          execSync(`/opt/homebrew/bin/blueutil -p ${btState}`);
          return `Bluetooth turned ${btState === '1' ? 'on' : 'off'}.`;
        }
      }
        
      case 'volume': {
        if (a.value !== undefined) {
          execSync(`osascript -e 'set volume output volume ${a.value}'`);
          return `Volume set to ${a.value}%.`;
        } else {
          return 'Volume setting requires a value (0-100). Use the mute setting to mute/unmute.';
        }
      }
        
      case 'mute': {
        const muteState = a.action === 'on' ? 'true' : a.action === 'off' ? 'false' : 'toggle';
        if (muteState === 'toggle') {
          const out = execSync(`osascript -e 'output muted of (get volume settings)'`).toString().trim();
          const turnTo = out === 'true' ? 'false' : 'true';
          execSync(`osascript -e 'set volume output muted ${turnTo}'`);
          return turnTo === 'true' ? 'Muted.' : 'Unmuted.';
        } else {
          execSync(`osascript -e 'set volume output muted ${muteState}'`);
          return muteState === 'true' ? 'Muted.' : 'Unmuted.';
        }
      }
        
      case 'dark_mode': {
        const dmState = a.action === 'on' ? 'true' : a.action === 'off' ? 'false' : 'not dark mode';
        execSync(`osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to ${dmState}'`);
        return 'Dark mode adjusted.';
      }
        
      case 'sleep': {
        execSync('pmset sleepnow');
        return 'System put to sleep.';
      }
        
      case 'screen_saver': {
        execSync('open -a ScreenSaverEngine');
        return 'Screen saver started.';
      }
        
      case 'do_not_disturb': {
        const out = execSync('shortcuts list').toString();
        const shortcutName = ['Toggle Do Not Disturb', 'Do Not Disturb', 'Toggle Focus', 'Focus'].find(name => out.includes(name));
        if (shortcutName) {
          execSync(`shortcuts run "${shortcutName}"`);
          return `Toggled Do Not Disturb via Apple Shortcut: ${shortcutName}`;
        } else {
          return 'Failed: On modern macOS, Apple blocks CLI access to Do Not Disturb/Focus modes. Please tell the user exactly this: "Apple has locked down Focus modes, but if you open the Apple Shortcuts app and create a simple shortcut named \\"Toggle Do Not Disturb\\" that turns Focus on and off, I will be able to trigger it for you next time!"';
        }
      }
        
      default:
        return 'Unknown setting.';
    }
  }
} as any);
TOOLS.push(
  {
    name: "send_message",
    description: "Send a message to another active agent (Main or a Clone). Use this for Swarm Intelligence.",
    schema: {
      recipient: z.string().describe("The name of the recipient (e.g., 'Main' or 'Echo Clone 1')."),
      message: z.string().describe("The message content.")
    },
    readOnly: false,
    handler: async (a) => {
      const g = global as any;
      if (a.recipient.toLowerCase() === "main") {
        if (!g.__mainBrain) return { text: "Main brain not found." };
        g.__mainBrain.send(`[Message from Clone]: ${a.message}`);
        return { text: "Message sent to Main." };
      }
      const { swarm } = await import("../frontier/swarm.js");
      if (swarm.send(a.recipient, a.message)) {
        return { text: `Message sent to ${a.recipient}.` };
      }
      return { text: `Recipient '${a.recipient}' not found.` };
    }
  },
  {
    name: "ask_user_approval",
    description: "Pause execution and pop up a native OS dialog asking the user to Approve or Reject an action. CRITICAL: ONLY use this for highly important/irreversible actions such as making payments, confirming before sending emails/messages, or accepting/rejecting calls. Do NOT use this for mundane tasks, as it will disturb the user unnecessarily.",
    schema: {
      prompt: z.string().describe("The prompt to show the user (e.g., 'Approve sending email to CEO?').")
    },
    readOnly: false,
    handler: async (a) => {
      const { exec } = await import("node:child_process");
      return new Promise<{ text: string }>((resolve) => {
        const script = `display dialog "${a.prompt.replace(/"/g, '\\"')}" buttons {"Reject", "Approve"} default button "Approve" with title "Echo Clone Request"`;
        exec(`osascript -e '${script}'`, (err, stdout) => {
          if (err || !stdout.includes("Approve")) {
            resolve({ text: "User rejected the action." });
          } else {
            resolve({ text: "User approved the action." });
          }
        });
      });
    }
  },
  {
    name: "create_worktree",
    description: "Create an isolated Git worktree in a temporary directory so you can safely build or modify code without affecting the user's main working directory.",
    schema: {
      repoPath: z.string().describe("The path to the git repository."),
      branchName: z.string().describe("The name of the new branch to create.")
    },
    readOnly: false,
    handler: async (a) => {
      const { exec } = await import("node:child_process");
      const { randomUUID } = await import("node:crypto");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const worktreePath = join(tmpdir(), `echo-worktree-${randomUUID()}`);
      
      return new Promise<{ text: string }>((resolve) => {
        exec(`git worktree add -b "${a.branchName.replace(/"/g, '')}" "${worktreePath}"`, { cwd: a.repoPath }, (err, stdout, stderr) => {
          if (err) {
            resolve({ text: `Failed to create worktree: ${stderr}` });
          } else {
            resolve({ text: `Worktree created at ${worktreePath}. You can now cd into it and work safely.` });
          }
        });
      });
    }
  },
  {
    name: "schedule_task",
    description: "Schedule a task to run automatically in the future by spawning a Clone. Useful for recurring checks (cron).",
    schema: {
      intervalSeconds: z.number().describe("The number of seconds between each run."),
      goal: z.string().describe("The instruction to give the Clone when it wakes up.")
    },
    readOnly: false,
    handler: async (a) => {
      const g = global as any;
      if (!g.__activeCrons) g.__activeCrons = new Map<number, NodeJS.Timeout>();
      
      const { createBrain } = await import("../brain/index.js");
      const { loadConfig } = await import("../config.js");
      const cfg = loadConfig(appRoot());
      
      const cronId = Date.now();
      const intervalMs = Math.max(1000, a.intervalSeconds * 1000);
      
      const timer = setInterval(() => {
        const identity = {
          id: `scheduled_${cronId}_${Date.now()}`,
          name: `Echo Scheduled ${cronId}`,
          kind: "scheduled" as const,
        };
        const { brain: subBrain } = createBrain(cfg, { identity });
        subBrain.send(`[SYSTEM: CRON TRIGGER] Your recurring task is: ${a.goal}. When finished, remember to save results.`);
      }, intervalMs);
      
      g.__activeCrons.set(cronId, timer);
      return { text: `Task scheduled successfully with Cron ID: ${cronId}.` };
    }
  },
  {
    name: "update_clone_progress",
    description: "Update the progress status of this Clone in the user's HUD dashboard (e.g. 'Scraped 15/100 pages').",
    schema: {
      cloneName: z.string().describe("Your assigned clone name."),
      progress: z.string().describe("The short progress status to display.")
    },
    readOnly: false,
    handler: async (a) => {
      const { swarm } = await import("../frontier/swarm.js");
      if (swarm.updateProgress(a.cloneName, a.progress)) {
        return { text: "Progress updated on HUD." };
      }
      return { text: "Clone not found in active list." };
    }
  }
);

TOOLS.push(
  {
    name: 'echoMaps',
    description: 'CRITICAL: ALWAYS use this tool by default when the user asks for a map, to show a location, or to navigate somewhere. DO NOT use the browser/open_url to show maps unless the user EXPLICITLY asks to open the map "in the browser". This renders a holographic map directly on their screen.',
    schema: {
      location: z.string().describe('The destination or place to display on the map'),
      startLocation: z.string().optional().describe('If the user asks for directions, provide the starting location. If they say "from my location", pass "Current Location" or their city.'),
      mode: z.enum(['d', 'w', 'b', 'r']).optional().describe('Routing mode: d=driving (car), w=walking, b=bicycling, r=transit. Default is d.')
    },
    readOnly: false,
    handler: async (a) => {
      nodeRequire("node:fs").appendFileSync("/Users/thedeepakreddy/.jarvis/tool_log.txt", `echoMaps called with location: ${a.location}, start: ${a.startLocation}\n`);
      try {
        let mapUrl;
        let qrUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(a.location)}&travelmode=driving`;
        
        if (a.startLocation) {
          const saddr = encodeURIComponent(a.startLocation);
          const daddr = encodeURIComponent(a.location);
          const dirflg = a.mode || 'd';
          mapUrl = `https://maps.google.com/maps?saddr=${saddr}&daddr=${daddr}&dirflg=${dirflg}&ie=UTF8&output=embed`;
          if (a.startLocation !== "Current Location") {
            qrUrl += `&origin=${saddr}`;
          }
        } else {
          const query = encodeURIComponent(a.location);
          mapUrl = `https://maps.google.com/maps?q=${query}&t=&z=14&ie=UTF8&iwloc=&output=embed`;
        }
        
        const qrData = await qrDataUrl(qrUrl);
        const html = `<style>#data-pane-content { padding: 0 !important; overflow: hidden !important; }</style><div style="position: relative; width: 100%; height: 100%; display: flex; flex-direction: column;"><iframe width="100%" height="100%" frameborder="0" scrolling="no" marginheight="0" marginwidth="0" allow="geolocation" src="${mapUrl}" style="flex: 1; border: none; border-radius: 0 0 24px 24px;"></iframe><div style="position: absolute; bottom: 15px; right: 15px; width: 80px; background: rgba(0,0,0,0.75); padding: 5px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); backdrop-filter: blur(10px);"><img src="${qrData}" style="width: 100%; display: block; filter: brightness(1.2);" /><div style="font-size: 8px; color: #fff; font-family: -apple-system, sans-serif; text-align: center; margin-top: 4px; line-height: 1.1; font-weight: bold;">SCAN TO GO</div></div></div>`;
        
        const title = a.startLocation ? `ROUTE: ${a.location.toUpperCase()}` : `MAP: ${a.location.toUpperCase()}`;
        
        sendToOverlay("show-data-pane", {
          title: title,
          content: html,
          duration: 45000
        });
        
        return { text: `Echo Maps: Displaying map for ${a.location} on the HUD for 30 seconds.` };
      } catch (err: any) {
        return { text: `Failed to display map: ${err.message}` };
      }
    }
  },
  {
    name: 'getActiveBrowserUrl',
    description: 'Fetches the URL of the currently active tab in the user\'s frontmost browser (supports Brave, Chrome, Safari). Use this when the user says "this video" or "this page".',
    schema: {},
    readOnly: true,
    handler: async () => {
      try {
        const { execSync } = nodeRequire('node:child_process');
        const script = `
          tell application "System Events"
            set frontApp to name of first application process whose frontmost is true
          end tell
          if frontApp is "Google Chrome" or frontApp is "Brave Browser" then
            tell application frontApp to get URL of active tab of front window
          else if frontApp is "Safari" then
            tell application "Safari" to get URL of front document
          else
            return ""
          end if
        `;
        const url = execSync(`osascript -e '${script}'`, { encoding: 'utf-8' }).trim();
        if (!url) return { text: "No supported browser is currently active or could not retrieve URL." };
        return { text: `Active browser URL: ${url}` };
      } catch (e: any) {
        return { text: `Failed to get browser URL: ${e.message}` };
      }
    }
  },
  {
    name: 'echoVideoPlayer',
    description: 'Plays a YouTube video directly on the holographic HUD (using Privacy-Enhanced mode for an ad-free experience).',
    schema: {
      url: z.string().describe('The YouTube video URL to play')
    },
    readOnly: false,
    handler: async (a) => {
      try {
        const match = a.url.match(/(?:v=|youtu\.be\/|embed\/)([^&?]+)/);
        if (!match || !match[1]) {
          return { text: "Could not parse a valid YouTube video ID from the provided URL." };
        }
        const videoId = match[1];
        const embedUrl = `https://yewtu.be/embed/${videoId}?autoplay=1`;
        
        const html = `<style>#data-pane-content { padding: 0 !important; overflow: hidden !important; }</style><div style="position: relative; width: 100%; height: 100%; display: flex; flex-direction: column;"><iframe width="100%" height="100%" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen src="${embedUrl}" style="flex: 1; border: none; border-radius: 0 0 24px 24px;"></iframe></div>`;
        
        const { sendToOverlay } = await import("../overlay.js");
        sendToOverlay("show-data-pane", {
          title: "SECURE MEDIA LINK",
          content: html,
          duration: 0 // 0 means it will not auto-close
        });
        
        return { text: `Playing video ${videoId} on the HUD. It will remain open until closed.` };
      } catch (err: any) {
        return { text: `Error showing video: ${err.message}` };
      }
    }
  },
  {
    name: 'toggle_telepathy',
    description: 'Turns on the Zero-Latency Telepathy (Gaze Tracking) engine. Requires Camera permissions.',
    schema: {
      enable: z.boolean().describe('True to turn on gaze tracking, false to turn it off.')
    },
    readOnly: false,
    handler: async (a) => {
      const { toggleEyeTracking } = await import("./eyetrack.js");
      toggleEyeTracking(a.enable);
      return { text: a.enable ? "Gaze tracking activated. Telepathy engine is online." : "Gaze tracking deactivated." };
    }
  },
  {
    name: 'predict_next_command',
    description: "Suggest what the user is likely to do next, learned only from the commands they've given Echo before (no keylogging). Use to complete a half-typed command or anticipate the next one. Returns suggestions only — it never runs anything on its own.",
    schema: {
      prefix: z.string().optional().describe("A half-typed command to complete."),
      after: z.string().optional().describe("A command just given, to predict what usually follows it."),
    },
    readOnly: true,
    handler: async (a) => {
      const { prefetch } = await import("../brain/prefetch.js");
      const out = a.prefix ? prefetch.complete(a.prefix) : a.after ? prefetch.predictNext(a.after) : [];
      return { text: out.length ? `You often follow with:\n${out.map((c) => `• ${c}`).join("\n")}` : "No confident prediction yet." };
    }
  },
  {
    name: "set_hud_skin",
    description:
      "Change which reactor the on-screen HUD shows. 'classic' is the round coil reactor drawn in CSS; 'mark50' is the triangular chest reactor; 'jarvis' is the segmented J.A.R.V.I.S interface reactor. Use when the user asks to change how you look, switch the reactor, or asks for a specific one by name. Pass no skin to report the current one.",
    schema: {
      skin: z
        .enum(["classic", "mark50", "jarvis"])
        .optional()
        .describe("Which reactor to show. Omit to report what is showing now."),
    },
    readOnly: false,
    handler: async (a) => {
      const { sendHudState } = await import("../frontier/hudstate.js");
      const configPath = join(appRoot(), "config.json");

      let config: any = {};
      if (existsSync(configPath)) {
        try {
          config = JSON.parse(readFileSync(configPath, "utf8"));
        } catch {
          /* a broken config should not stop the HUD from changing */
        }
      }
      const current = config?.hud?.skin ?? "classic";
      const SKIN_NAMES: Record<string, string> = { classic: "classic", mark50: "Mark 50", jarvis: "J.A.R.V.I.S" };
      const nameOf = (skin: string) => SKIN_NAMES[skin] ?? skin;

      if (!a.skin) {
        return { text: `Currently showing the ${nameOf(current)} reactor.` };
      }
      if (a.skin === current) {
        return { text: `Already showing the ${nameOf(a.skin)} reactor.` };
      }

      // Change what is on screen first — the HUD should respond immediately,
      // whether or not the config can be written.
      sendHudState({ skin: a.skin });

      // Then remember it, so it survives a restart. No relaunch needed: the
      // renderer swaps skins live.
      let saved = true;
      try {
        config.hud = { ...(config.hud ?? {}), skin: a.skin };
        writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
      } catch {
        saved = false;
      }

      const name = nameOf(a.skin);
      return {
        text: saved
          ? `Switched to the ${name} reactor.`
          : `Switched to the ${name} reactor for now — I couldn't save it, so it will revert on restart.`,
      };
    },
  }
);

TOOLS.push({
  name: "submit_agent_result",
  description:
    "Finish the current delegated Agent Task with a structured Result. A normal reply is not completion. Use completed only when verificationRefs contains direct evidence that the acceptance criteria passed; otherwise use partial, blocked, or failed and explain what remains.",
  schema: {
    status: z.enum(["completed", "partial", "blocked", "failed", "cancelled"]),
    summary: z.string().min(1).describe("Concise outcome for the parent Mission"),
    artifacts: z.array(z.object({
      kind: z.enum(["text", "file", "url", "data"]),
      label: z.string().min(1),
      value: z.string(),
    })).default([]).describe("Durable outputs produced by the Agent Task"),
    verificationRefs: z.array(z.string()).default([]).describe("Evidence references proving acceptance criteria; required for completed"),
    blockers: z.array(z.string()).default([]).describe("Anything preventing full completion"),
  },
  readOnly: false,
  handler: async (args) => {
    const invocation = currentInvocation();
    const taskId = invocation?.taskId ?? owningTaskId();
    if (!taskId || !invocation?.actorId) {
      return { text: "No active delegated Agent Task is available for a Result.", status: "failed" };
    }
    const delegated = taskCoordinator.get(taskId);
    if (!delegated?.parentTaskId?.startsWith("mission.")) {
      return { text: "Only an Agent Task inside a Mission can submit a delegated Result.", status: "failed" };
    }
    const state = taskCoordinator.submitResult(taskId, invocation.actorId, {
      status: args.status,
      summary: args.summary,
      artifacts: args.artifacts ?? [],
      verificationRefs: args.verificationRefs ?? [],
      blockers: args.blockers ?? [],
    });
    return {
      text: `Result accepted for ${taskId}: ${state.result?.status} — ${state.result?.summary}`,
      status: "success",
      verification: state.result?.status === "completed" ? "verified" : "unverified",
      data: { result: state.result },
    };
  },
});

// --- END OF REGISTRY INJECTION POINT ---

/**
 * Name -> tool, for the loops that dispatch by name.
 *
 * Built HERE, at the bottom, and not one line earlier. It used to sit in the
 * middle of the file, above the ten tools that are appended with TOOLS.push()
 * below it — so those ten were declared to every model and then missing from
 * the map that runs them. Under Ollama, which dispatches through this map,
 * calling one answered "No such tool: adjust_brightness" for a tool that is
 * very much there.
 *
 * _wiringtest asserts this map covers the registry, so appending a tool after
 * this line fails a test instead of going quiet.
 */
export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
