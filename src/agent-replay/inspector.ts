import type { ReplayEvent } from "./recorder.js";

export interface InspectionSummary {
  runId: string;
  actorName: string;
  taskId: string | null;
  recoveryAttempt: number;
  status: "completed" | "failed" | "aborted" | "incomplete";
  iterations: number;
  durationMs: number | null;
  exitReason: string | null;
  exitDetail: string | null;
  lastEvents: ReplayEvent[];
  inconsistency: string | null;
}

/** The view model behind Echo's “Why did this end?” panel. */
export function inspectRun(events: ReplayEvent[]): InspectionSummary {
  const start = events.find((event) => event.type === "run.start");
  const exit = [...events].reverse().find((event) => event.type === "loop.exit");
  const end = [...events].reverse().find((event) => event.type === "run.end");
  // A COUNT, not the highest index. Loops number iterations from zero, so
  // reporting the raw index made a run that used its whole 150-step budget
  // report 149 — and the cap check below compared an index against a count and
  // was quietly off by one.
  //
  // `iteration` is the current field name; `n` is what recordings written
  // before the loop named its own exits used. Read either, so an old trace
  // still summarises.
  const starts = events.filter((event) => event.type === "iteration.start");
  const highest = Math.max(-1, ...starts.map((event) => Number(event.iteration ?? event.n ?? -1)));
  const iterations = starts.length ? highest + 1 : 0;
  const reason = typeof exit?.reason === "string" ? exit.reason : null;
  const cap = Number((start?.config as any)?.maxIterations);
  const inconsistency = Number.isFinite(cap) && reason === "max_iterations" && iterations < cap
    ? `loop reported max_iterations at ${iterations}, but its cap was ${cap}`
    : reason === "unknown" || reason === "unknown_fallthrough"
      ? "the agent exited through an uninstrumented path"
      : null;
  return {
    runId: String(start?.runId ?? events[0]?.runId ?? "unknown"),
    actorName: String((start?.actor as any)?.name ?? (start?.config as any)?.actor?.name ?? "Echo"),
    taskId: typeof start?.taskId === "string" ? start.taskId : null,
    recoveryAttempt: Number(start?.recoveryAttempt ?? (start?.config as any)?.recoveryAttempt ?? 0),
    status: !end
      ? "incomplete"
      : reason === "completed"
        ? "completed"
        : reason === "aborted" || reason === "abort_signal"
          ? "aborted"
          : "failed",
    iterations,
    durationMs: typeof end?.durationMs === "number" ? end.durationMs : null,
    exitReason: reason,
    exitDetail: typeof exit?.detail === "string" ? exit.detail : null,
    lastEvents: events.slice(-3),
    inconsistency,
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Compact, dependency-free HTML for Echo's existing overlay data pane. */
export function renderInspectionHtml(summary: InspectionSummary): string {
  const color = summary.status === "completed" ? "#54e39a" : summary.status === "aborted" ? "#f4c15d" : "#ff6b7a";
  const duration = summary.durationMs === null ? "still running or crashed" : `${(summary.durationMs / 1000).toFixed(1)}s`;
  const events = summary.lastEvents.map((event) => {
    const id = event.type === "tool.call" ? event.callId : event.type === "llm.request" ? event.reqId : undefined;
    return `${event.seq}  ${event.type}${id ? `  ${id}` : ""}`;
  }).join("\n") || "No events were recorded.";
  return `<div style="font:13px/1.5 ui-monospace,Menlo,monospace;color:#d9f7ff">
    <div style="color:${color};font-weight:700;letter-spacing:.08em">${escapeHtml(summary.status.toUpperCase())}</div>
    <div style="margin:10px 0"><strong>${escapeHtml(summary.actorName)}</strong> · ${summary.iterations} iteration(s) · ${escapeHtml(duration)}</div>
    ${summary.taskId ? `<div style="color:#9ed6e6">task ${escapeHtml(summary.taskId)} · recovery attempt ${summary.recoveryAttempt}</div>` : ""}
    <div style="padding:10px;border-left:2px solid ${color};background:rgba(0,240,255,.07)">
      <strong>WHY DID THIS END?</strong><br>
      reason: ${escapeHtml(summary.exitReason ?? "no loop.exit recorded")}<br>
      ${summary.exitDetail ? `detail: ${escapeHtml(summary.exitDetail)}<br>` : ""}
      ${summary.inconsistency ? `<span style="color:#f4c15d">inconsistency: ${escapeHtml(summary.inconsistency)}</span>` : ""}
    </div>
    <div style="margin-top:14px"><strong>LAST EVENTS</strong><pre style="white-space:pre-wrap;color:#9ed6e6">${escapeHtml(events)}</pre></div>
  </div>`;
}
