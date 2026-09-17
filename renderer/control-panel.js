const bridge = window.echoControl;
const byId = (id) => document.getElementById(id);
let snapshot = null;
let feedbackTimer = null;
let activeView = "overview";
let selectedMissionId = "";
const expandedMissionTasks = new Set();

const valueText = (value, fallback = "—") => value === undefined || value === null || value === "" ? fallback : String(value);
const escapeHtml = (value) => valueText(value, "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
const eventTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const relativeTime = (value) => {
  const elapsed = Math.max(0, Date.now() - Number(value || Date.now()));
  if (elapsed < 45_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });
};
const duration = (seconds) => {
  const total = Math.max(0, Number(seconds) || 0);
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), Math.floor(total % 60)]
    .map((part) => String(part).padStart(2, "0")).join(":");
};
const plural = (count, singular, pluralValue = `${singular}s`) => `${count} ${count === 1 ? singular : pluralValue}`;
const terminalMissionStatus = (status) => ["completed", "partial", "blocked", "failed", "cancelled"].includes(String(status));
const statusLabel = (status) => String(status || "pending").replace(/_/g, " ");
const budgetTime = (milliseconds) => {
  const minutes = Math.max(1, Math.round((Number(milliseconds) || 0) / 60_000));
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
};
const elapsedTime = (startedAt, completedAt) => {
  if (!startedAt) return "Not started";
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - Number(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

function iconForKind(kind) {
  const normalized = String(kind || "").toLowerCase();
  if (/error|failed|warn/.test(normalized)) return "alert";
  if (/done|complete|success/.test(normalized)) return "check";
  if (/tool|code|action|assistant/.test(normalized)) return "code";
  if (/agent|swarm|delegate/.test(normalized)) return "agent";
  return "file";
}

function toneForKind(kind) {
  const normalized = String(kind || "").toLowerCase();
  if (/error|failed/.test(normalized)) return "error";
  if (/done|complete|success/.test(normalized)) return "done";
  return "";
}

function notify(message, error = false) {
  const element = byId("feedback");
  element.textContent = message || "";
  element.className = `feedback show${error ? " error" : ""}`;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { element.className = "feedback"; }, 4000);
}

async function act(action) {
  if (!bridge) {
    notify("The control bridge is unavailable.", true);
    return { ok: false, message: "The control bridge is unavailable." };
  }
  try {
    const result = await bridge.action(action);
    if (!result?.ok && result?.message) notify(result.message, true);
    else if (result?.message) notify(result.message);
    return result || { ok: false, message: "Echo returned no result." };
  } catch (error) {
    const message = error?.message || String(error);
    notify(message, true);
    return { ok: false, message };
  }
}

function setView(name) {
  if (!byId(`${name}-view`)) return;
  activeView = name;
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const visible = panel.dataset.viewPanel === name;
    panel.hidden = !visible;
    panel.classList.toggle("active", visible);
  });
  document.querySelectorAll(".section-nav [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
}

function render(next) {
  if (!next || typeof next !== "object") return;
  snapshot = next;
  const status = String(next.state?.status || "idle").toLowerCase();
  document.body.dataset.status = status;
  byId("system-state").textContent = status.toUpperCase();
  byId("core-status").textContent = status.toUpperCase();

  const analytics = next.analytics || {};
  byId("metric-commands").textContent = valueText(analytics.commands, "0");
  byId("metric-tools").textContent = valueText(analytics.toolCalls, "0");
  byId("metric-completed").textContent = valueText(analytics.completedTasks, "0");
  byId("metric-errors").textContent = valueText(analytics.errors, "0");
  byId("metric-uptime").textContent = duration(analytics.uptimeSeconds);
  byId("voice-state").textContent = `VOICE ${next.voiceEnabled ? "ON" : "MUTED"}`;
  byId("voice-toggle").classList.toggle("enabled", Boolean(next.voiceEnabled));

  const logs = Array.isArray(next.logs) ? next.logs : [];
  const tasks = Array.isArray(next.tasks) ? next.tasks : [];
  const agents = Array.isArray(next.agents) ? next.agents : [];
  const missions = Array.isArray(next.missions) ? next.missions : [];
  const models = Array.isArray(next.models) ? next.models : [];
  const connections = Array.isArray(next.connections) ? next.connections : [];
  const activeModel = models.find((model) => model.active);
  const activeModelName = activeModel?.label || valueText(next.state?.provider, "No active route");
  const activeModelVersion = activeModel?.model || "Waiting for runtime";
  byId("active-model").textContent = `${activeModelName} · ${activeModelVersion}`;
  byId("route-name").textContent = activeModelName;
  byId("route-model").textContent = activeModelVersion;
  byId("current-route-name").textContent = activeModelName;
  byId("current-route-model").textContent = activeModelVersion;
  byId("core-agent-count").textContent = plural(agents.length, "AGENT");

  renderLogs(logs);
  renderMissions(missions, agents);
  renderTasks(tasks);
  renderAgents(agents);
  renderModels(models);
  renderConnections(connections);
}

function activityMarkup(logs) {
  const recent = logs.slice(-8).reverse();
  if (!recent.length) return '<div class="empty-state">Waiting for live activity…</div>';
  return recent.map((item) => {
    const icon = iconForKind(item.kind);
    const tone = toneForKind(item.kind);
    return `<article class="activity-entry ${tone}">
      <span class="activity-icon"><svg><use href="#icon-${icon}"></use></svg></span>
      <div class="activity-copy"><p>${escapeHtml(item.text)}</p><small>${escapeHtml(relativeTime(item.at))} · ${escapeHtml(item.kind || "event")}</small></div>
      <i class="activity-dot"></i>
    </article>`;
  }).join("");
}

function renderLogs(logs) {
  const markup = activityMarkup(logs);
  byId("live-log").innerHTML = markup;
  byId("routing-log").innerHTML = markup;
}

function renderTasks(tasks) {
  const active = tasks.filter((task) => task.status === "working" || task.status === "queued");
  byId("task-summary-count").textContent = `${active.length} active`;

  const statusCounts = tasks.reduce((counts, task) => {
    const status = String(task.status || "unknown");
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  byId("task-legend").innerHTML = Object.entries(statusCounts).map(([status, count]) => `<span class="legend-item ${escapeHtml(status)}"><i></i>${escapeHtml(count)} ${escapeHtml(status)}</span>`).join("");

  const ordered = [...tasks].reverse().slice(0, 8);
  byId("task-list").innerHTML = ordered.length ? ordered.map((task) => {
    const icon = task.status === "failed" ? "alert" : task.status === "done" ? "check" : "file";
    const timing = task.finishedAt ? `Ended ${eventTime(task.finishedAt)}` : `Started ${eventTime(task.startedAt)}`;
    return `<article class="task-card ${escapeHtml(task.status)}">
      <span class="task-card-icon"><svg><use href="#icon-${icon}"></use></svg></span>
      <div class="task-copy"><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.agent || "Echo")} · ${escapeHtml(timing)}</p></div>
      <div class="task-meta"><span class="status-tag ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span><span>${escapeHtml(relativeTime(task.finishedAt || task.startedAt))}</span></div>
    </article>`;
  }).join("") : '<div class="empty-state large">No task activity in this session.</div>';
}

function resultItems(items, emptyText, className = "") {
  if (!Array.isArray(items) || !items.length) return `<span class="mission-result-empty">${escapeHtml(emptyText)}</span>`;
  return `<ul class="mission-result-list ${escapeHtml(className)}">${items.map((item) => {
    const label = typeof item === "object" && item ? valueText(item.label, item.kind) : valueText(item);
    const value = typeof item === "object" && item ? valueText(item.value, "") : "";
    return `<li><strong>${escapeHtml(label)}</strong>${value ? `<span>${escapeHtml(value)}</span>` : ""}</li>`;
  }).join("")}</ul>`;
}

function missionTaskMarkup(task, index, missionId, activeAgents) {
  const status = statusLabel(task.status);
  const key = `${missionId}:${task.id}`;
  const result = task.result || null;
  const runningAgent = activeAgents.find((agent) => agent.missionId === missionId && agent.agentTaskId === task.id);
  const dependencies = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
  const isExpanded = expandedMissionTasks.has(key);
  const completedAt = result?.completedAt;
  const icon = task.status === "failed" || task.status === "blocked" ? "alert" : task.status === "completed" ? "check" : task.lane === "gui" ? "monitor" : "brain";
  return `<details class="mission-task ${escapeHtml(task.status)}" data-mission-task-key="${escapeHtml(key)}"${isExpanded ? " open" : ""}>
    <summary>
      <span class="mission-task-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="mission-task-icon"><svg><use href="#icon-${icon}"></use></svg></span>
      <span class="mission-task-copy"><strong>${escapeHtml(task.goal)}</strong><small>${dependencies.length ? `Depends on ${dependencies.map(escapeHtml).join(", ")}` : "Ready without dependencies"}</small></span>
      <span class="lane-tag ${escapeHtml(task.lane)}">${escapeHtml(task.lane)}</span>
      <span class="mission-task-agent">${escapeHtml(task.actorName || (task.status === "pending" ? "Unassigned" : "Echo agent"))}</span>
      <span class="status-tag ${escapeHtml(task.status)}">${escapeHtml(status)}</span>
      <svg class="mission-task-chevron"><use href="#icon-chevron"></use></svg>
    </summary>
    <div class="mission-task-detail">
      <dl class="mission-task-metrics">
        <div><dt>Elapsed</dt><dd>${escapeHtml(elapsedTime(task.startedAt, completedAt))}</dd></div>
        <div><dt>Wall-time cap</dt><dd>${escapeHtml(budgetTime(task.budget?.timeoutMs))}</dd></div>
        <div><dt>Iteration cap</dt><dd>${escapeHtml(task.budget?.maxIterations ?? "—")}</dd></div>
        <div><dt>Recoveries</dt><dd>${escapeHtml(task.recoveryAttempts ?? 0)} / ${escapeHtml(task.budget?.maxRecoveryAttempts ?? "—")}</dd></div>
      </dl>
      ${runningAgent?.progress ? `<p class="mission-live-progress"><span>Live</span>${escapeHtml(runningAgent.progress)}</p>` : ""}
      <section><h3>Acceptance criteria</h3>${resultItems(criteria, "No explicit criteria recorded")}</section>
      <section><h3>Result</h3><p class="mission-result-summary">${escapeHtml(result?.summary || "No structured Result submitted yet.")}</p></section>
      <div class="mission-result-grid">
        <section><h3>Artifacts</h3>${resultItems(result?.artifacts, "No artifacts yet")}</section>
        <section><h3>Verification</h3>${resultItems(result?.verificationRefs, "No evidence yet")}</section>
        <section><h3>Blockers</h3>${resultItems(result?.blockers, "No blockers", "blockers")}</section>
      </div>
    </div>
  </details>`;
}

function renderMissions(missions, agents) {
  const running = missions.filter((mission) => mission.status === "running");
  byId("mission-summary-count").textContent = `${running.length} active`;
  byId("mission-summary").innerHTML = missions.length ? missions.slice(0, 3).map((mission) =>
    `<span class="summary-row"><i class="${escapeHtml(mission.status)}"></i><strong>${escapeHtml(mission.goal)}</strong><small>${escapeHtml(statusLabel(mission.status))}</small></span>`
  ).join("") : '<span class="summary-empty">No missions yet</span>';

  if (!missions.length) {
    selectedMissionId = "";
    byId("mission-select").innerHTML = '<option value="">No missions</option>';
    byId("mission-panel").innerHTML = '<div class="empty-state large"><strong>No agent missions yet</strong><span>Long tasks delegated by Echo will appear here with live execution details.</span></div>';
    return;
  }

  if (!missions.some((mission) => mission.id === selectedMissionId)) {
    selectedMissionId = running[0]?.id || missions[0].id;
  }
  const picker = byId("mission-select");
  picker.innerHTML = missions.map((mission) => `<option value="${escapeHtml(mission.id)}">${escapeHtml(mission.goal)} · ${escapeHtml(statusLabel(mission.status))}</option>`).join("");
  picker.value = selectedMissionId;

  const mission = missions.find((item) => item.id === selectedMissionId) || missions[0];
  const tasks = Object.entries(mission.tasks || {}).map(([id, task]) => ({ id, ...task }));
  const terminalCount = tasks.filter((task) => terminalMissionStatus(task.status)).length;
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const percent = tasks.length ? Math.round((terminalCount / tasks.length) * 100) : 0;
  const knowledgeCount = tasks.filter((task) => task.lane === "knowledge").length;
  const guiCount = tasks.filter((task) => task.lane === "gui").length;
  const result = mission.result;

  byId("mission-panel").innerHTML = `<article class="mission-overview ${escapeHtml(mission.status)}">
    <header class="mission-overview-header">
      <div><span class="mission-id">${escapeHtml(mission.id)}</span><h2>${escapeHtml(mission.goal)}</h2><p>Updated ${escapeHtml(relativeTime(mission.updatedAt))} · Started ${escapeHtml(eventTime(mission.createdAt))}</p></div>
      <span class="status-tag ${escapeHtml(mission.status)}">${escapeHtml(statusLabel(mission.status))}</span>
    </header>
    <div class="mission-progress-row"><progress class="mission-progress-track" aria-label="Mission tasks resolved" max="100" value="${percent}">${percent}%</progress><strong>${percent}%</strong></div>
    <dl class="mission-overview-metrics">
      <div><dt>Resolved</dt><dd>${terminalCount} / ${tasks.length}</dd></div>
      <div><dt>Verified</dt><dd>${completedCount}</dd></div>
      <div><dt>Knowledge lane</dt><dd>${knowledgeCount}</dd></div>
      <div><dt>GUI lane</dt><dd>${guiCount}</dd></div>
    </dl>
  </article>
  <section class="mission-pipeline" aria-label="Agent Task execution pipeline">
    <header><div><h2>Agent Tasks</h2><p>Dependencies, execution lanes, budgets, and Results</p></div><span>${plural(tasks.length, "task")}</span></header>
    <div class="mission-task-list">${tasks.map((task, index) => missionTaskMarkup(task, index, mission.id, agents)).join("")}</div>
  </section>
  ${result ? `<section class="mission-final-result ${escapeHtml(result.status)}"><header><h2>Mission Result</h2><span class="status-tag ${escapeHtml(result.status)}">${escapeHtml(statusLabel(result.status))}</span></header><p>${escapeHtml(result.summary)}</p><div class="mission-result-grid"><section><h3>Artifacts</h3>${resultItems(result.artifacts, "No artifacts")}</section><section><h3>Verification</h3>${resultItems(result.verificationRefs, "No evidence")}</section><section><h3>Blockers</h3>${resultItems(result.blockers, "No blockers", "blockers")}</section></div></section>` : ""}`;
}

function renderAgents(agents) {
  byId("agent-summary-count").textContent = `${agents.length} connected`;
  byId("agent-summary").innerHTML = agents.length ? agents.slice(0, 2).map((agent) => `<span class="summary-row"><i class="active"></i><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.status)}</small></span>`).join("") : '<span class="summary-empty">No background agents</span>';
  byId("agent-count").textContent = `${agents.length} / 4 active`;
  byId("agent-list").innerHTML = agents.length ? agents.map((agent) => `<article class="agent-card"><span class="agent-avatar"><svg><use href="#icon-agent"></use></svg></span><div><strong>${escapeHtml(agent.name)}</strong><p>${escapeHtml(agent.goal)}</p><p>${escapeHtml(agent.progress || agent.status)}</p></div><i></i></article>`).join("") : '<div class="empty-state">No background agents connected.</div>';

  const target = byId("agent-target");
  const previous = target.value;
  target.innerHTML = '<option value="">Deploy a new agent</option>' + agents.map((agent) => `<option value="${escapeHtml(agent.name)}">Assign to ${escapeHtml(agent.name)}</option>`).join("");
  if ([...target.options].some((option) => option.value === previous)) target.value = previous;
}

function renderModels(models) {
  byId("model-list").innerHTML = models.length ? models.map((model) => `<article class="model-card${model.active ? " active" : ""}">
    <span class="model-mark"><svg><use href="#icon-brain"></use></svg></span>
    <div class="model-copy"><header><strong>${escapeHtml(model.label)}</strong><span class="availability${model.available ? "" : " unavailable"}">${model.available ? "Available" : "Unavailable"}</span></header><p>${escapeHtml(model.model)}${model.reason ? ` · ${escapeHtml(model.reason)}` : ""}</p></div>
    <button type="button" data-provider="${escapeHtml(model.id)}" ${model.active || !model.available ? "disabled" : ""}>${model.active ? "In use" : "Use model"}</button>
  </article>`).join("") : '<div class="empty-state large">No configured models reported.</div>';
}

function connectionDescription(connection) {
  const details = [];
  details.push(connection.tools === null || connection.tools === undefined ? "Tool count unavailable" : plural(connection.tools, "tool"));
  if (connection.lastActivityAt) details.push(`active ${relativeTime(connection.lastActivityAt)}`);
  if (connection.error) details.push(connection.error);
  return details.join(" · ");
}

function renderConnections(connections) {
  const activeCount = connections.filter((connection) => connection.status === "active").length;
  byId("connection-summary-count").textContent = `${connections.length} configured`;
  byId("connection-health").textContent = activeCount ? `${activeCount} recently active` : `${connections.length} configured`;
  byId("connection-summary").innerHTML = connections.length ? connections.slice(0, 4).map((connection) => `<span class="connection-chip ${escapeHtml(connection.status)}"><i></i><span>${escapeHtml(connection.name)}</span></span>`).join("") : '<span class="summary-empty">No external connections</span>';
  byId("connection-list").innerHTML = connections.length ? connections.map((connection) => `<article class="connection-card"><header><strong>${escapeHtml(connection.name)}</strong><span class="connection-status ${escapeHtml(connection.status)}">${escapeHtml(connection.status)}</span></header><p>${escapeHtml(connectionDescription(connection))}</p></article>`).join("") : '<div class="empty-state">No external MCP servers configured.</div>';
  byId("route-connection-list").innerHTML = connections.length ? connections.map((connection) => `<div class="route-connection-row"><strong>${escapeHtml(connection.name)}</strong><span class="connection-status ${escapeHtml(connection.status)}">${escapeHtml(connection.status)}</span></div>`).join("") : '<div class="empty-state">No connections reported</div>';
}

function renderWeather(weather) {
  byId("weather-place").textContent = valueText(weather?.place, weather?.status === "needs-location" ? "Choose a location" : "Weather unavailable");
  byId("weather-temperature").textContent = weather?.temperature === null || weather?.temperature === undefined ? "—°" : `${Math.round(weather.temperature)}°`;
  byId("weather-condition").textContent = valueText(weather?.condition, valueText(weather?.error, "No live observation"));
  byId("weather-feels").textContent = weather?.feelsLike === null || weather?.feelsLike === undefined ? "—" : `${Math.round(weather.feelsLike)}°`;
  byId("weather-humidity").textContent = weather?.humidity === null || weather?.humidity === undefined ? "—" : `${Math.round(weather.humidity)}%`;
  byId("weather-wind").textContent = weather?.wind === null || weather?.wind === undefined ? "—" : `${Math.round(weather.wind)} km/h`;
  const source = weather?.source === "timezone-estimate" ? "TIMEZONE ESTIMATE" : weather?.source === "device" ? "DEVICE LOCATION" : "OPEN-METEO";
  byId("weather-updated").textContent = `${source}${weather?.updatedAt ? ` · ${eventTime(weather.updatedAt)}` : ""}`;
}

async function loadWeather(request) {
  if (!bridge?.weather) return;
  byId("weather-condition").textContent = "Updating live conditions…";
  try {
    renderWeather(await bridge.weather(request));
  } catch (error) {
    renderWeather({ status: "unavailable", error: error?.message || String(error) });
  }
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => act({ type: button.dataset.action })));
byId("mission-select").addEventListener("change", (event) => {
  selectedMissionId = event.target.value;
  expandedMissionTasks.clear();
  renderMissions(Array.isArray(snapshot?.missions) ? snapshot.missions : [], Array.isArray(snapshot?.agents) ? snapshot.agents : []);
});
byId("mission-panel").addEventListener("toggle", (event) => {
  const details = event.target.closest?.("[data-mission-task-key]");
  if (!details || details !== event.target) return;
  if (details.open) expandedMissionTasks.add(details.dataset.missionTaskKey);
  else expandedMissionTasks.delete(details.dataset.missionTaskKey);
}, true);
byId("panel-close").addEventListener("click", () => bridge?.close());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") bridge?.close();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    byId("command-input").focus();
  }
});

byId("refresh-connections").addEventListener("click", async () => {
  const result = await act({ type: "refresh-connections" });
  if (result.ok) bridge?.snapshot?.().then(render).catch(() => {});
});
byId("model-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-provider]");
  if (!button) return;
  const result = await act({ type: "switch-model", provider: button.dataset.provider });
  if (result.ok) bridge?.snapshot?.().then(render).catch(() => {});
});

byId("command-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = byId("command-input");
  const command = input.value.trim();
  if (!command) return;
  const result = await act({ type: "command", text: command });
  if (result.ok) input.value = "";
});

byId("agent-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const goalInput = byId("agent-goal");
  const target = byId("agent-target").value;
  const goal = goalInput.value.trim();
  if (!goal) return notify("Describe a focused task first.", true);
  const action = target ? { type: "assign-agent", name: target, goal } : { type: "spawn-agent", goal };
  const result = await act(action);
  if (result.ok) {
    goalInput.value = "";
    bridge?.snapshot?.().then(render).catch(() => {});
  }
});

byId("weather-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = byId("weather-query").value.trim();
  if (query) loadWeather({ query });
});
byId("weather-locate").addEventListener("click", () => {
  if (!navigator.geolocation) return notify("Device location is unavailable. Search for a city instead.", true);
  navigator.geolocation.getCurrentPosition(
    (position) => loadWeather({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
    () => notify("Location access was not granted. Search for a city instead.", true),
    { enableHighAccuracy: false, timeout: 7000, maximumAge: 600000 },
  );
});

function tick() {
  byId("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (snapshot?.analytics) {
    snapshot.analytics.uptimeSeconds = Math.max(snapshot.analytics.uptimeSeconds || 0, Math.floor((Date.now() - snapshot.sessionStartedAt) / 1000));
    byId("metric-uptime").textContent = duration(snapshot.analytics.uptimeSeconds);
  }
}
setInterval(tick, 1000);
tick();
setView(activeView);

if (bridge) {
  bridge.snapshot().then(render).catch((error) => notify(error?.message || String(error), true));
  bridge.onUpdate?.(render);
  bridge.onState?.((state) => render({ ...(snapshot || {}), state: { ...(snapshot?.state || {}), ...state } }));
  bridge.onLevel?.((level) => document.documentElement.style.setProperty("--level", String(Number(level) || 0)));
  loadWeather();
} else {
  notify("The control panel bridge did not load.", true);
}
