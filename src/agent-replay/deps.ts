import { randomUUID } from "node:crypto";
import type { Recorder } from "./recorder.js";
import type { ReplaySource } from "./replay-source.js";
import { currentAgentRunContext } from "./context.js";

/** The agent's non-deterministic inputs. Never patch JavaScript globals. */
export interface AgentDeps {
  now(): number;
  random(): number;
  uuid(): string;
  env(name: string): string | undefined;
}

const live: AgentDeps = {
  now: () => Date.now(),
  random: () => Math.random(),
  uuid: () => randomUUID(),
  env: (name) => process.env[name],
};

let active: AgentDeps = live;

export function liveDeps(recorder?: Recorder): AgentDeps {
  if (!recorder) return live;
  return {
    now: () => {
      const value = Date.now();
      recorder.emit({ type: "clock.now", value });
      return value;
    },
    random: () => {
      const value = Math.random();
      recorder.emit({ type: "random.value", value });
      return value;
    },
    uuid: () => {
      const value = randomUUID();
      recorder.emit({ type: "uuid.value", value });
      return value;
    },
    env: (name) => {
      const value = process.env[name];
      recorder.emit({ type: "env.value", name, value });
      return value;
    },
  };
}

export function replayDeps(source: ReplaySource, recorder?: Recorder): AgentDeps {
  const take = (type: string) => {
    const event = source.nextAmbient(type);
    if (recorder) {
      const { seq: _seq, ts: _ts, iso: _iso, mono: _mono, runId: _runId, ...body } = event;
      recorder.emit(body as { type: string });
    }
    return event;
  };
  return {
    now: () => Number(take("clock.now").value),
    random: () => Number(take("random.value").value),
    uuid: () => String(take("uuid.value").value),
    env: (name) => {
      const event = take("env.value");
      if (event.name !== name) source.divergeAtAmbient(event, { name }, { name: event.name });
      return typeof event.value === "string" ? event.value : undefined;
    },
  };
}

export function setAgentDeps(deps: AgentDeps): void {
  const context = currentAgentRunContext();
  if (context) context.deps = deps;
  else active = deps;
}

export function resetAgentDeps(): void {
  const context = currentAgentRunContext();
  if (context) context.deps = live;
  else active = live;
}

const current = (): AgentDeps => (currentAgentRunContext()?.deps as AgentDeps | undefined) ?? active;

export const agentNow = () => current().now();
export const agentRandom = () => current().random();
export const agentUuid = () => current().uuid();
export const agentEnv = (name: string) => current().env(name);
