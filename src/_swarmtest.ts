/**
 * The clone swarm — tracking, the concurrency cap, and cleanup on completion.
 *
 *   npm run swarmtest
 *
 * A fake brain (a tiny EventEmitter with a send()) stands in for a real one, so
 * this runs with no model and no Electron.
 */
import { SwarmManager, MAX_CONCURRENT_CLONES, type CloneBrain } from "./frontier/swarm.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

/** A controllable fake brain: capture handlers so the test can fire turnEnd/error. */
function fakeBrain() {
  const handlers: Record<string, ((a?: any) => void)[]> = {};
  let sent = "";
  const brain: CloneBrain & { fire: (e: string, a?: any) => void; sent: () => string } = {
    on(event, cb) { (handlers[event] ??= []).push(cb); return brain; },
    send(text) { sent = text; },
    fire(e, a) { (handlers[e] ?? []).forEach((h) => h(a)); },
    sent: () => sent,
  };
  return brain;
}

console.log("\nClone swarm\n");

console.log("  spawning tracks a clone and briefs it");
{
  const sw = new SwarmManager();
  const brains: ReturnType<typeof fakeBrain>[] = [];
  let broadcasts = 0;
  const deps = { makeBrain: () => { const b = fakeBrain(); brains.push(b); return b; }, broadcast: () => broadcasts++ };

  const r = sw.spawn("research the pricing", deps);
  ok(r.ok && !!r.name, `spawn returns a name (${r.name})`);
  ok(sw.count() === 1, "one clone is tracked");
  ok(/pricing/.test(brains[0].sent()), "the goal is in the clone's briefing");
  ok(/remember/i.test(brains[0].sent()), "and it's told to save a summary with remember");
  ok(broadcasts >= 1, "the roster was broadcast to the UI");
}

console.log("  a finished clone is cleaned up");
{
  const sw = new SwarmManager();
  const brains: ReturnType<typeof fakeBrain>[] = [];
  const deps = { makeBrain: () => { const b = fakeBrain(); brains.push(b); return b; }, broadcast: () => {} };
  sw.spawn("task one", deps);
  ok(sw.count() === 1, "running");
  brains[0].fire("turnEnd");
  ok(sw.count() === 0, "removed from the roster when it finishes");
}
{
  const sw = new SwarmManager();
  const brains: ReturnType<typeof fakeBrain>[] = [];
  const deps = { makeBrain: () => { const b = fakeBrain(); brains.push(b); return b; }, broadcast: () => {} };
  sw.spawn("task", deps);
  brains[0].fire("error");
  ok(sw.count() === 0, "a failed clone is cleaned up too");
}

console.log("  the concurrency cap protects the one mouse");
{
  const sw = new SwarmManager();
  const deps = { makeBrain: () => fakeBrain(), broadcast: () => {} };
  const results = [];
  for (let i = 0; i < MAX_CONCURRENT_CLONES + 3; i++) results.push(sw.spawn(`goal ${i}`, deps));
  ok(sw.count() === MAX_CONCURRENT_CLONES, `capped at ${MAX_CONCURRENT_CLONES} (${sw.count()})`);
  ok(results.filter((r) => r.ok).length === MAX_CONCURRENT_CLONES, "exactly the cap spawned");
  const refused = results.filter((r) => !r.ok);
  ok(refused.length === 3, "the rest were refused");
  ok(/max/.test(refused[0].reason ?? ""), "with a reason that names the cap");
}
{
  // Finishing one frees a slot.
  const sw = new SwarmManager();
  const brains: ReturnType<typeof fakeBrain>[] = [];
  const deps = { makeBrain: () => { const b = fakeBrain(); brains.push(b); return b; }, broadcast: () => {} };
  for (let i = 0; i < MAX_CONCURRENT_CLONES; i++) sw.spawn(`g${i}`, deps);
  ok(!sw.spawn("one too many", deps).ok, "full -> refused");
  brains[0].fire("turnEnd");
  ok(sw.spawn("now there's room", deps).ok, "a finished clone frees a slot");
}

console.log("  bad input is refused, not crashed");
{
  const sw = new SwarmManager();
  const deps = { makeBrain: () => fakeBrain(), broadcast: () => {} };
  ok(!sw.spawn("", deps).ok, "empty goal refused");
  ok(!sw.spawn("   ", deps).ok, "whitespace goal refused");
  ok(sw.count() === 0, "nothing was tracked for a refused spawn");
}

console.log(`\n${pass}/${pass + fail} swarm checks passed\n`);
process.exit(fail ? 1 : 0);
