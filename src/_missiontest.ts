/**
 * Mission scheduling and structured agent results.
 *
 *   npm run missiontest
 *
 * Tests exercise the Mission interface: submit, inspect, cancel, and Result.
 * They do not reach into scheduler internals.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SwarmManager,
  type CloneBrain,
  type MissionSpec,
} from "./frontier/swarm.js";
import { TaskCoordinator } from "./memory/task-state.js";

const root = mkdtempSync(join(tmpdir(), "echo-mission-"));
let pass = 0;
const failures: string[] = [];
const ok = (condition: boolean, message: string) => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${message}`);
  } else {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
};

class FakeBrain extends EventEmitter implements CloneBrain {
  sent: Array<{ text: string; opts?: any }> = [];
  interrupted = false;
  stopped = false;
  send(text: string, _audio?: unknown, opts?: any): void {
    this.sent.push({ text, opts });
  }
  interrupt(): void { this.interrupted = true; }
  async stop(): Promise<void> { this.stopped = true; }
}

const missionSpec = (tasks: MissionSpec["tasks"]): MissionSpec => ({
  id: "launch",
  goal: "Prepare a verified launch brief",
  tasks,
});

console.log("\nMission runtime\n");

console.log("  dependency graph and structured Results");
{
  const coordinator = new TaskCoordinator(join(root, "dependency"));
  const swarm = new SwarmManager();
  const brains = new Map<string, FakeBrain>();
  const submitted = swarm.submitMission(missionSpec([
    {
      id: "research",
      goal: "Collect launch facts",
      lane: "knowledge",
      acceptanceCriteria: ["Facts cite their source"],
    },
    {
      id: "brief",
      goal: "Write the launch brief",
      lane: "knowledge",
      dependsOn: ["research"],
      acceptanceCriteria: ["Brief uses verified research"],
    },
  ]), {
    coordinator,
    makeBrain: (identity) => {
      const brain = new FakeBrain();
      brains.set(identity.id, brain);
      return brain;
    },
    broadcast: () => {},
  });

  ok(submitted.ok && submitted.missionId === "launch", "a valid Mission is accepted");
  let mission = swarm.getMission("launch")!;
  ok(mission.tasks.research.status === "working", "a dependency-free Agent Task starts");
  ok(mission.tasks.brief.status === "pending", "a dependent Agent Task waits");
  ok(brains.size === 1, "only the ready Agent Task receives a brain");

  const research = mission.tasks.research;
  coordinator.submitResult(research.taskId!, research.actorId!, {
    status: "completed",
    summary: "Three sourced launch facts",
    artifacts: [{ kind: "text", label: "research", value: "facts" }],
    verificationRefs: ["source:https://example.test/launch"],
    blockers: [],
  });
  brains.get(research.actorId!)!.emit("turnEnd");

  mission = swarm.getMission("launch")!;
  ok(mission.tasks.research.status === "completed", "the structured Result completes its Agent Task");
  ok(mission.tasks.brief.status === "working", "completion unlocks the dependent Agent Task");
  ok(brains.size === 2, "the dependent Agent Task starts with a fresh brain");

  const brief = mission.tasks.brief;
  coordinator.submitResult(brief.taskId!, brief.actorId!, {
    status: "completed",
    summary: "Launch brief ready",
    artifacts: [{ kind: "text", label: "brief", value: "ready" }],
    verificationRefs: ["check:brief-uses-research"],
    blockers: [],
  });
  brains.get(brief.actorId!)!.emit("turnEnd");

  mission = swarm.getMission("launch")!;
  ok(mission.status === "completed", "the Mission completes after every Result is verified");
  ok(mission.result?.artifacts.length === 2, "the Mission aggregates child artifacts");
}

console.log("  knowledge work is parallel and GUI work has one lane");
{
  const coordinator = new TaskCoordinator(join(root, "lanes"));
  const swarm = new SwarmManager();
  const brains = new Map<string, FakeBrain>();
  const submitted = swarm.submitMission({
    id: "lanes",
    goal: "Research two facts while operating two GUI flows",
    tasks: [
      { id: "fact-a", goal: "Research A", lane: "knowledge" },
      { id: "fact-b", goal: "Research B", lane: "knowledge" },
      { id: "gui-a", goal: "Operate A", lane: "gui" },
      { id: "gui-b", goal: "Operate B", lane: "gui" },
    ],
  }, {
    coordinator,
    makeBrain: (identity) => {
      const brain = new FakeBrain();
      brains.set(identity.id, brain);
      return brain;
    },
    broadcast: () => {},
  });
  ok(submitted.ok, "the mixed-lane Mission is accepted");
  let mission = swarm.getMission("lanes")!;
  ok(mission.tasks["fact-a"].status === "working" && mission.tasks["fact-b"].status === "working",
    "independent knowledge Agent Tasks start in parallel");
  ok(mission.tasks["gui-a"].status === "working" && mission.tasks["gui-b"].status === "pending",
    "only one independent GUI Agent Task owns the lane");

  const firstGui = mission.tasks["gui-a"];
  coordinator.submitResult(firstGui.taskId!, firstGui.actorId!, {
    status: "completed",
    summary: "First GUI flow verified",
    artifacts: [{ kind: "data", label: "gui-a", value: "completed" }],
    verificationRefs: ["screen:gui-a-complete"],
    blockers: [],
  });
  brains.get(firstGui.actorId!)!.emit("turnEnd");
  mission = swarm.getMission("lanes")!;
  ok(mission.tasks["gui-b"].status === "working", "releasing the GUI lane starts the next GUI Agent Task");
  swarm.cancelMission("lanes");
}

console.log("  turnEnd is not success");
{
  const coordinator = new TaskCoordinator(join(root, "missing-result"));
  const swarm = new SwarmManager();
  let brain: FakeBrain | null = null;
  swarm.submitMission(missionSpec([
    { id: "work", goal: "Do important work", lane: "knowledge" },
  ]), {
    coordinator,
    makeBrain: () => (brain = new FakeBrain()),
    broadcast: () => {},
  });
  brain!.emit("turnEnd");
  const mission = swarm.getMission("launch")!;
  ok(mission.tasks.work.status === "failed", "an Agent Task without a structured Result fails");
  ok(mission.status === "failed", "missing Result prevents Mission success");
  ok(mission.tasks.work.result?.blockers.includes("missing_result") === true,
    "the failure names the missing Result rather than pretending the work completed");
}

console.log("  success requires an artifact and verification evidence");
{
  const coordinator = new TaskCoordinator(join(root, "result-contract"));
  coordinator.create({
    taskId: "artifact-contract",
    ownerActorId: "agent:artifact-contract",
    goal: "Produce verifiable work",
  });
  let rejected = false;
  try {
    coordinator.submitResult("artifact-contract", "agent:artifact-contract", {
      status: "completed",
      summary: "Claims completion without producing anything",
      artifacts: [],
      verificationRefs: ["check:claimed"],
      blockers: [],
    });
  } catch (error) {
    rejected = /artifact/i.test(String(error));
  }
  ok(rejected, "completion without an artifact is rejected");
}

console.log("  invalid graphs are rejected before agents start");
{
  const coordinator = new TaskCoordinator(join(root, "invalid"));
  const swarm = new SwarmManager();
  let made = 0;
  const result = swarm.submitMission({
    id: "cycle",
    goal: "Impossible cycle",
    tasks: [
      { id: "a", goal: "A", dependsOn: ["b"] },
      { id: "b", goal: "B", dependsOn: ["a"] },
    ],
  }, { coordinator, makeBrain: () => { made++; return new FakeBrain(); }, broadcast: () => {} });
  ok(!result.ok && /cycle/i.test(result.reason ?? ""), "a cyclic Mission is rejected with a useful reason");
  ok(made === 0, "invalid work consumes no agent");
}

console.log("  wall-time budgets stop runaway Agent Tasks");
{
  const coordinator = new TaskCoordinator(join(root, "timeout"));
  const swarm = new SwarmManager();
  const brains: FakeBrain[] = [];
  swarm.submitMission({
    id: "timeout",
    goal: "Bounded work",
    tasks: [{ id: "slow", goal: "Never finish", budget: { timeoutMs: 5 } }],
  }, {
    coordinator,
    makeBrain: () => { const brain = new FakeBrain(); brains.push(brain); return brain; },
    broadcast: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const mission = swarm.getMission("timeout")!;
  ok(mission.tasks.slow.status === "failed", "the Agent Task fails when its wall-time budget expires");
  ok(mission.tasks.slow.result?.blockers.includes("budget:timeout") === true, "the Result identifies budget exhaustion");
  ok(brains[0]?.interrupted === true && brains[0]?.stopped === true, "the runaway brain is interrupted and stopped");
}

console.log("  a process restart restores the Mission around a recovering agent");
{
  const coordinator = new TaskCoordinator(join(root, "recovery"));
  const beforeCrash = new SwarmManager();
  beforeCrash.submitMission({
    id: "recoverable",
    goal: "Survive a process restart",
    tasks: [{ id: "resume", goal: "Resume from the durable checkpoint" }],
  }, {
    coordinator,
    makeBrain: () => new FakeBrain(),
    broadcast: () => {},
  });
  const savedTask = beforeCrash.getMission("recoverable")!.tasks.resume;
  let recoveredPrompt = false;
  let recoveredBrain: (FakeBrain & { recoverFromCheckpoint: (checkpoint: any) => boolean }) | null = null;
  const afterCrash = new SwarmManager();
  const checkpoint: any = {
    version: 1,
    taskId: savedTask.taskId,
    actor: {
      id: savedTask.actorId,
      name: savedTask.actorName,
      kind: "clone",
      parentTaskId: "mission.recoverable",
    },
    originalPrompt: "Resume from the durable checkpoint",
    restartable: true,
    status: "running",
    recoveryAttempts: 0,
    maxRecoveryAttempts: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastRunId: "run-before-crash",
    runDirs: ["/tmp/run-before-crash"],
    actions: [],
  };
  const recovered = afterCrash.recover(checkpoint, {
    coordinator,
    makeBrain: () => {
      const brain = new FakeBrain() as FakeBrain & { recoverFromCheckpoint: (checkpoint: any) => boolean };
      brain.recoverFromCheckpoint = (value) => (recoveredPrompt = value.taskId === savedTask.taskId);
      recoveredBrain = brain;
      return brain;
    },
    broadcast: () => {},
  });
  ok(recovered && recoveredPrompt, "the agent resumes from its persisted checkpoint");
  ok(afterCrash.getMission("recoverable")?.tasks.resume.status === "working",
    "the Mission graph is restored around the recovered Agent Task");
  ok(afterCrash.getMission("recoverable")?.tasks.resume.recoveryAttempts === 1,
    "the recovered Agent Task exposes its recovery count");

  coordinator.submitResult(savedTask.taskId!, savedTask.actorId!, {
    status: "completed",
    summary: "Recovered work completed",
    artifacts: [{ kind: "data", label: "recovered-work", value: "completed" }],
    verificationRefs: ["checkpoint:recovered-and-verified"],
    blockers: [],
  });
  recoveredBrain!.emit("turnEnd");
  ok(afterCrash.getMission("recoverable")?.status === "completed",
    "the recovered Result completes the restored Mission");
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + failures.length} mission checks passed\n`);
if (failures.length) {
  console.error(`${failures.length} problem(s):\n  - ${failures.join("\n  - ")}\n`);
}
process.exit(failures.length ? 1 : 0);
