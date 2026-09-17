#!/usr/bin/env node
/**
 * Open the production control-panel renderer against deterministic Mission data.
 * No Echo runtime, microphone, network service, memory store, or model starts.
 *
 *   npm run panelpreview
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const now = Date.now();
const result = (summary, label) => ({
  status: "completed",
  summary,
  artifacts: [{ kind: "file", label, value: `/workspace/${label}` }],
  verificationRefs: [`check:${label}:passed`],
  blockers: [],
  completedAt: new Date(now - 90_000).toISOString(),
});
const budget = { timeoutMs: 600_000, maxIterations: 50, maxRecoveryAttempts: 2 };
const mission = {
  schemaVersion: 1,
  id: "launch-brief",
  taskId: "mission.launch-brief",
  goal: "Research, verify, and prepare the launch brief",
  status: "running",
  scope: { project: "Echo" },
  createdAt: now - 780_000,
  updatedAt: now - 8_000,
  tasks: {
    research: { id: "research", goal: "Collect current launch facts from approved sources", dependsOn: [], acceptanceCriteria: ["Every claim has a source", "Conflicts are called out"], lane: "knowledge", budget, status: "completed", recoveryAttempts: 0, actorName: "Echo Agent 7", startedAt: now - 740_000, result: result("Collected and cross-checked eleven launch facts.", "launch-research.md") },
    analysis: { id: "analysis", goal: "Identify risks, decisions, and unresolved questions", dependsOn: ["research"], acceptanceCriteria: ["Risks include impact and mitigation"], lane: "knowledge", budget, status: "completed", recoveryAttempts: 1, actorName: "Echo Agent 8", startedAt: now - 510_000, result: result("Risk analysis verified against the research artifact.", "risk-analysis.json") },
    draft: { id: "draft", goal: "Draft the concise launch brief", dependsOn: ["research", "analysis"], acceptanceCriteria: ["Uses verified facts only", "Includes decisions and owners"], lane: "knowledge", budget, status: "working", recoveryAttempts: 0, actorName: "Echo Agent 9", startedAt: now - 126_000 },
    review: { id: "review", goal: "Verify the brief against every acceptance criterion", dependsOn: ["draft"], acceptanceCriteria: ["No unsupported claim remains"], lane: "knowledge", budget, status: "pending", recoveryAttempts: 0 },
    deliver: { id: "deliver", goal: "Save the verified brief in the project workspace", dependsOn: ["review"], acceptanceCriteria: ["Final file is readable and linked"], lane: "gui", budget, status: "pending", recoveryAttempts: 0 },
  },
};
const snapshot = {
  voiceEnabled: true,
  state: { status: "acting", provider: "gemini" },
  sessionStartedAt: now - 3_200_000,
  logs: [
    { id: 1, at: now - 35_000, kind: "agent", text: "Echo Agent 8 submitted a verified Result." },
    { id: 2, at: now - 8_000, kind: "assistant", text: "Echo Agent 9 is drafting from the approved evidence." },
  ],
  tasks: [{ id: "session-1", title: mission.goal, status: "working", agent: "Echo", startedAt: mission.createdAt }],
  agents: [{ id: "launch-brief.draft", name: "Echo Agent 9", goal: mission.tasks.draft.goal, status: "working", startedAt: mission.tasks.draft.startedAt, progress: "Structuring the decision and risk sections from verified inputs.", missionId: mission.id, agentTaskId: "draft", lane: "knowledge" }],
  missions: [mission],
  models: [{ id: "gemini", label: "Gemini", model: "gemini-3.7-flash", active: true, available: true }],
  connections: [{ name: "workspace", status: "active", tools: 12, lastActivityAt: now - 8_000 }],
  analytics: { commands: 1, toolCalls: 17, errors: 0, completedTasks: 0, uptimeSeconds: 3200 },
};

ipcMain.handle("control:snapshot", () => structuredClone(snapshot));
ipcMain.handle("control:action", () => ({ ok: true, message: "Preview mode" }));
ipcMain.handle("control:weather", () => ({ status: "ok", place: "Preview Lab", temperature: 21, feelsLike: 20, humidity: 43, wind: 7, condition: "Clear", source: "timezone-estimate", updatedAt: now }));
ipcMain.on("control:close", () => app.quit());

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    title: "ECHO — Mission Monitor Preview",
    backgroundColor: "#030809",
    webPreferences: {
      preload: resolve(root, "dist", "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadFile(resolve(root, "renderer", "control-panel.html"));
  await window.webContents.executeJavaScript("document.querySelector('[data-view=tasks]').click()", true);
});

app.on("window-all-closed", () => app.quit());
