import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash, type ReplayEvent } from "./recorder.js";

export interface Override {
  target: { type: "tool"; callId: string } | { type: "llm"; reqId: string };
  replaceWith: unknown;
}

export class DivergenceError extends Error {
  constructor(
    readonly seq: number | null,
    readonly expected: unknown,
    readonly actual: unknown
  ) {
    super(`Replay diverged${seq === null ? "" : ` at event ${seq}`}`);
    this.name = "DivergenceError";
  }
}

export class ReplayedError extends Error {
  constructor(message: string, readonly recordedStack?: string) {
    super(message);
    this.name = "ReplayedError";
    if (recordedStack) this.stack = recordedStack;
  }
}

/** A counterfactual was applied; no later cassette is safe to serve. */
export class CounterfactualDivergence extends DivergenceError {
  constructor(seq: number | null, readonly override: Override) {
    super(seq, "the original trajectory", "a counterfactual override");
    this.name = "CounterfactualDivergence";
  }
}

/** A partial final JSONL line is expected after a crash, and is safely ignored. */
export function loadEvents(runDir: string): ReplayEvent[] {
  const source = readFileSync(join(runDir, "events.jsonl"), "utf8");
  const events: ReplayEvent[] = [];
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as ReplayEvent);
    } catch {
      break;
    }
  }
  return events;
}

export class BlobStore {
  constructor(private readonly runDir: string) {}

  get(ref: string): unknown {
    return JSON.parse(readFileSync(join(this.runDir, "blobs", ref), "utf8"));
  }
}

type ToolEvent = ReplayEvent & { type: "tool.call"; callId: string; name: string; argsHash: string };

export interface LLMExchange {
  request: ReplayEvent;
  response: unknown;
  responseEvent?: ReplayEvent;
  errorEvent?: ReplayEvent;
  chunks: unknown[];
  deltasMs: number[];
}

export interface ToolExchange {
  call: ToolEvent;
  value: unknown;
  terminal: ReplayEvent;
}

/**
 * Plays values back ordinally and verifies their normalised hashes. The
 * ordinal keeps faithful replays simple; the hash turns code/prompt drift into
 * a useful divergence report instead of silently serving a wrong response.
 */
export class ReplaySource {
  private llmCursor = 0;
  private toolCursor = 0;
  private ambientCursor = 0;
  public divergedAt: number | null = null;
  private readonly llmRequests: ReplayEvent[];
  private readonly toolCalls: ToolEvent[];
  private readonly ambient: ReplayEvent[];
  private appliedOverride: Override | null = null;

  constructor(readonly events: ReplayEvent[], readonly blobs: BlobStore, private readonly override?: Override) {
    this.llmRequests = events.filter((event) => event.type === "llm.request");
    this.toolCalls = events.filter((event): event is ToolEvent => event.type === "tool.call") as ToolEvent[];
    this.ambient = events.filter((event) => ["clock.now", "random.value", "uuid.value", "env.value"].includes(event.type));
  }

  private diverge(event: ReplayEvent | undefined, expected: unknown, actual: unknown): never {
    if (this.divergedAt === null) this.divergedAt = event?.seq ?? null;
    throw new DivergenceError(this.divergedAt, expected, actual);
  }

  /** Used by replay dependencies to identify a named ambient-input mismatch. */
  divergeAtAmbient(event: ReplayEvent, expected: unknown, actual: unknown): never {
    return this.diverge(event, expected, actual);
  }

  nextAmbient(type: string): ReplayEvent {
    const event = this.ambient[this.ambientCursor++];
    if (!event || event.type !== type) this.diverge(event, type, event?.type);
    return event;
  }

  private ensureOriginalTrajectory(next: ReplayEvent | undefined): void {
    if (this.appliedOverride) {
      if (this.divergedAt === null) this.divergedAt = next?.seq ?? null;
      throw new CounterfactualDivergence(this.divergedAt, this.appliedOverride);
    }
  }

  nextLLMExchange(request: unknown): LLMExchange {
    const recorded = this.llmRequests[this.llmCursor++];
    if (!recorded) this.diverge(undefined, "a recorded LLM request", request);
    this.ensureOriginalTrajectory(recorded);
    const actualHash = contentHash(request);
    if (actualHash !== recorded.bodyHash) this.diverge(recorded, recorded.bodyHash, actualHash);
    const chunks = this.events
      .filter((event) => event.type === "llm.chunk" && event.reqId === recorded.reqId)
      .sort((a, b) => Number(a.idx) - Number(b.idx));
    const responseEvent = this.events.find((event) => event.type === "llm.response" && event.reqId === recorded.reqId);
    const errorEvent = this.events.find((event) => event.type === "llm.error" && event.reqId === recorded.reqId);
    if (this.override?.target.type === "llm" && this.override.target.reqId === recorded.reqId) {
      this.appliedOverride = this.override;
      return { request: recorded, response: this.override.replaceWith, responseEvent, chunks: chunks.map((event) => event.chunk), deltasMs: chunks.map((event) => Number(event.dtMs ?? 0)) };
    }
    if (errorEvent) {
      return {
        request: recorded,
        response: undefined,
        errorEvent,
        chunks: [],
        deltasMs: [],
      };
    }
    if (!responseEvent && !chunks.length) this.diverge(recorded, "a recorded LLM response", request);
    return {
      request: recorded,
      response: responseEvent ? this.blobs.get(String(responseEvent.bodyRef)) : chunks.map((event) => event.chunk),
      responseEvent,
      chunks: chunks.map((event) => event.chunk),
      deltasMs: chunks.map((event) => Number(event.dtMs ?? 0)),
    };
  }

  nextLLM(request: unknown): { chunks: unknown[]; deltasMs: number[] } {
    const exchange = this.nextLLMExchange(request);
    if (exchange.errorEvent) {
      throw new ReplayedError(String(exchange.errorEvent.message), typeof exchange.errorEvent.stack === "string" ? exchange.errorEvent.stack : undefined);
    }
    return { chunks: exchange.chunks, deltasMs: exchange.deltasMs };
  }

  nextToolExchange(name: string, args: unknown): ToolExchange {
    const call = this.toolCalls[this.toolCursor++];
    if (!call) this.diverge(undefined, "a recorded tool call", { name, args });
    this.ensureOriginalTrajectory(call);
    const argsHash = contentHash(args);
    if (call.name !== name || call.argsHash !== argsHash) {
      this.diverge(call, { name: call.name, argsHash: call.argsHash }, { name, argsHash });
    }
    const terminal = this.events.find(
      (event) => (event.type === "tool.result" || event.type === "tool.error") && event.callId === call.callId
    );
    if (!terminal) this.diverge(call, "a recorded tool result", { name, args });
    if (this.override?.target.type === "tool" && this.override.target.callId === call.callId) {
      this.appliedOverride = this.override;
      return { call, value: this.override.replaceWith, terminal };
    }
    return {
      call,
      value: terminal.type === "tool.error" ? undefined : this.blobs.get(String(terminal.resultRef)),
      terminal,
    };
  }

  nextTool(name: string, args: unknown): unknown {
    const exchange = this.nextToolExchange(name, args);
    if (exchange.terminal.type === "tool.error") {
      throw new ReplayedError(String(exchange.terminal.message), typeof exchange.terminal.stack === "string" ? exchange.terminal.stack : undefined);
    }
    return exchange.value;
  }
}

/** Side-effect firewall for replay mode: calls return cassettes, never live tools. */
export function replayTools(source: ReplaySource) {
  return async (name: string, args: unknown): Promise<unknown> => source.nextTool(name, args);
}
