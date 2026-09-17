/** Transport success and verified task achievement are intentionally distinct. */
export type ToolStatus = "success" | "failed" | "denied" | "cancelled" | "timeout" | "uncertain" | "partial";
export type ToolVerification = "unverified" | "verified" | "contradicted";
export interface ToolResultMetadata {
  status?: ToolStatus;
  data?: unknown;
  error?: { category: string; message: string; retryable?: boolean };
  verification?: ToolVerification;
  verificationRefs?: string[];
  callId?: string;
  taskId?: string;
  durationMs?: number;
}
const STATUSES = new Set<ToolStatus>(["success", "failed", "denied", "cancelled", "timeout", "uncertain", "partial"]);
/** Legacy textual errors must not silently become successful training examples. */
export function normalizeToolOutput<T extends { text?: string }>(output: T & ToolResultMetadata): T & ToolResultMetadata {
  const out = output ?? ({} as T);
  const legacyFailure = /^(?:error\b|failed\b|.*? failed:|i (?:couldn['’]t|cannot|can['’]t)\b)|(?:^|\n)ERROR:\s*/i.test(out.text ?? "");
  const status = out.status && STATUSES.has(out.status) ? out.status : out.error || legacyFailure ? "failed" : "success";
  return { ...out, status, verification: out.verification ?? "unverified",
    ...(status === "failed" && !out.error ? { error: { category: "legacy_tool_error", message: out.text ?? "Tool failed" } } : {}) };
}
