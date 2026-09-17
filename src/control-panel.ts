import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { getControlWeather, type ControlWeatherRequest } from "./control-weather.js";
import type { MissionState } from "./frontier/swarm.js";

const nodeRequire = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
export type ControlTaskStatus = "working" | "queued" | "done" | "failed" | "stopped";
export interface ControlTask {
  id: string; title: string; status: ControlTaskStatus; agent: string;
  startedAt: number; finishedAt?: number;
}
export interface ControlLog { id: number; at: number; kind: string; text: string }
export interface ControlAction {
  type: "command" | "listen" | "interrupt" | "toggle-voice" | "settings" | "neural" | "osiris" |
    "refresh-connections" | "switch-model" | "spawn-agent" | "assign-agent";
  text?: string; goal?: string; provider?: string; name?: string;
}
export interface ControlResult { ok: boolean; message?: string }
export interface ControlRuntime {
  voiceEnabled: boolean;
  agents: Array<{ id: string; name: string; goal: string; status: string; startedAt: number; progress: string;
    missionId?: string; agentTaskId?: string; lane?: "knowledge" | "gui" }>;
  missions: MissionState[];
  models: Array<{ id: string; label: string; model: string; active: boolean; available: boolean; reason?: string }>;
  connections: Array<{ name: string; status: string; tools: number | null; error?: string; lastActivityAt?: number }>;
}

/** Session observations only: no fabricated traffic, tasks, or model usage. */
export class ControlTelemetry {
  readonly sessionStartedAt = Date.now();
  state: Record<string, unknown> = { status: "idle" };
  logs: ControlLog[] = [];
  tasks: ControlTask[] = [];
  commands = 0;
  toolCalls = 0;
  errors = 0;
  completedTasks = 0;
  private sequence = 0;
  private taskSequence = 0;
  private mcpActivity = new Map<string, number>();

  observe(channel: string, payload: any): void {
    if (channel === "state") this.state = { ...this.state, ...payload };
    if (channel === "message" && typeof payload?.text === "string") {
      const kind = String(payload.kind ?? "info");
      if (kind === "user") this.commands++;
      this.log(kind, payload.text);
    }
    if (channel === "notice" && typeof payload?.text === "string") {
      if (payload.level === "error") this.errors++;
      this.log(String(payload.level ?? "info"), payload.text);
    }
  }
  log(kind: string, text: string): void {
    this.logs.push({ id: ++this.sequence, at: Date.now(), kind, text: text.slice(0, 12000) });
    if (this.logs.length > 240) this.logs.splice(0, this.logs.length - 240);
  }
  tool(name: string): void {
    this.toolCalls++;
    const server = /^mcp__([^]+?)__/.exec(name)?.[1];
    if (server) this.mcpActivity.set(server, Date.now());
  }
  connectionActivity(name: string): number | undefined {
    return this.mcpActivity.get(name.replace(/[^a-zA-Z0-9_]/g, "_"));
  }
  beginTask(title: string, agent = "Echo"): string {
    const id = `session-${++this.taskSequence}`;
    this.tasks.push({ id, title: title.slice(0, 2000), agent, startedAt: Date.now(),
      status: this.tasks.some((task) => task.agent === agent && task.status === "working") ? "queued" : "working" });
    // Retain active work, and the most recent sixty finished turns.
    const finished = this.tasks.filter((task) => task.finishedAt);
    const drop = new Set(finished.slice(0, Math.max(0, finished.length - 60)).map((task) => task.id));
    this.tasks = this.tasks.filter((task) => !drop.has(task.id));
    return id;
  }
  finishTask(status: "done" | "failed" | "stopped", agent = "Echo"): void {
    const task = this.tasks.find((item) => item.agent === agent && item.status === "working");
    if (!task) return;
    task.status = status;
    task.finishedAt = Date.now();
    if (status === "done") this.completedTasks++;
    const queued = this.tasks.find((item) => item.agent === agent && item.status === "queued");
    if (queued) queued.status = "working";
  }
  stopMainTasks(): void {
    for (const task of this.tasks) {
      if (task.agent === "Echo" && (task.status === "working" || task.status === "queued")) {
        task.status = "stopped"; task.finishedAt = Date.now();
      }
    }
  }
  snapshot(runtime: ControlRuntime) {
    return { ...runtime, state: this.state, sessionStartedAt: this.sessionStartedAt,
      logs: this.logs, tasks: this.tasks,
      analytics: { commands: this.commands, toolCalls: this.toolCalls, errors: this.errors,
        completedTasks: this.completedTasks, uptimeSeconds: Math.floor((Date.now() - this.sessionStartedAt) / 1000) } };
  }
}

export const controlTelemetry = new ControlTelemetry();
let panel: BrowserWindow | null = null;
let runtime: (() => ControlRuntime) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let publishTimer: ReturnType<typeof setTimeout> | null = null;

export function publishControlUpdate(): void {
  if (!panel || panel.isDestroyed() || publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    if (panel && !panel.isDestroyed() && runtime) panel.webContents.send("control:update", controlTelemetry.snapshot(runtime()));
  }, 60);
}

export function observeControlEvent(channel: string, payload: unknown): void {
  controlTelemetry.observe(channel, payload);
  if (panel && !panel.isDestroyed() && (channel === "state" || channel === "level")) {
    panel.webContents.send(channel, payload);
  }
  if (channel !== "level") publishControlUpdate();
}

export function openControlPanel(anchor?: BrowserWindow | null): void {
  const { BrowserWindow, screen } = nodeRequire("electron") as typeof import("electron");
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  const display = anchor && !anchor.isDestroyed() ? screen.getDisplayMatching(anchor.getBounds()) : screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.min(1180, Math.max(320, area.width - 48));
  const height = Math.min(760, Math.max(320, area.height - 48));
  panel = new BrowserWindow({ width, height,
    x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
    title: "ECHO — Intelligence Control", frame: false, transparent: false, backgroundColor: "#050b10",
    resizable: false, fullscreenable: false, roundedCorners: false, show: false,
    webPreferences: { preload: join(here, "preload.cjs"), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true },
  });
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  panel.webContents.on("will-navigate", (event) => event.preventDefault());
  panel.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); closeControlPanel(); }
  });
  panel.once("ready-to-show", () => { panel?.show(); panel?.focus(); publishControlUpdate(); });
  panel.on("closed", () => {
    panel = null;
    if (refreshTimer) clearInterval(refreshTimer);
    if (publishTimer) clearTimeout(publishTimer);
    refreshTimer = null; publishTimer = null;
  });
  refreshTimer = setInterval(publishControlUpdate, 1000);
  refreshTimer.unref();
  void panel.loadFile(join(here, "..", "renderer", "control-panel.html"));
}

export function closeControlPanel(): void {
  if (panel && !panel.isDestroyed()) panel.close();
}

function authorized(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!panel && !panel.isDestroyed() && event.sender === panel.webContents && event.senderFrame === panel.webContents.mainFrame;
}

export function wireControlPanel(deps: {
  runtime: () => ControlRuntime;
  action: (action: ControlAction) => Promise<ControlResult>;
}): void {
  runtime = deps.runtime;
  const { ipcMain } = nodeRequire("electron") as typeof import("electron");
  ipcMain.handle("control:snapshot", (event) => {
    if (!authorized(event)) throw new Error("Only the control panel can read its session.");
    return controlTelemetry.snapshot(deps.runtime());
  });
  ipcMain.handle("control:action", async (event, input: unknown) => {
    if (!authorized(event)) return { ok: false, message: "Untrusted control-panel sender." };
    if (!input || typeof input !== "object" || typeof (input as any).type !== "string") return { ok: false, message: "Invalid action." };
    try {
      const result = await deps.action(input as ControlAction);
      publishControlUpdate();
      return result;
    } catch (error: any) {
      const message = String(error?.message ?? error);
      controlTelemetry.observe("notice", { level: "error", text: message });
      publishControlUpdate();
      return { ok: false, message };
    }
  });
  ipcMain.handle("control:weather", (event, request?: ControlWeatherRequest) => {
    if (!authorized(event)) throw new Error("Untrusted control-panel sender.");
    return getControlWeather(request);
  });
  ipcMain.on("control:close", (event) => { if (authorized(event)) closeControlPanel(); });
}
