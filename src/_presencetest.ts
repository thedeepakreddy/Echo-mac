/**
 * Presence debounce rules.
 *
 * These decide whether your screen locks, so the failure that matters is
 * declaring you absent when you merely leaned out of frame.
 *
 *   npm run presencetest
 */
import { PresenceMonitor, DEFAULT_PRESENCE } from "./frontier/presence.js";
import type { Presence } from "./tools/vision.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const reading = (p: Partial<Presence>): Presence =>
  ({ present: false, faces: 0, prominence: 0, brightness: 0.5, dark: false, ...p });

console.log("\nPresence detection\n");

// Never act on side effects during tests.
const quiet = { ...DEFAULT_PRESENCE, pauseMedia: false, lockScreen: false, missesBeforeAway: 3 };

// ---- leaving needs confirmation ------------------------------------------
let next: Presence = reading({ present: true, faces: 1 });
const m = new PresenceMonitor(quiet, async () => next);
const events: string[] = [];
m.on("left", () => events.push("left"));
m.on("returned", () => events.push("returned"));
m.on("tooDark", () => events.push("dark"));

await m.checkOnce();
ok(m.current === "present", "seeing a face means present");

next = reading({ present: false });
await m.checkOnce();
ok(m.current === "present", "one missed reading does NOT mean you left");
await m.checkOnce();
ok(m.current === "present", "two missed readings still does not");
await m.checkOnce();
ok(m.current === "away", "three consecutive misses does");
ok(events.filter((e) => e === "left").length === 1, "leaving fires exactly once");

// ---- returning is immediate ----------------------------------------------
next = reading({ present: true, faces: 1 });
await m.checkOnce();
ok(m.current === "present", "a single sighting brings you straight back");
ok(events.includes("returned"), "returning is announced");

// ---- a miss part-way through resets the count ----------------------------
next = reading({ present: false });
await m.checkOnce();
await m.checkOnce();
next = reading({ present: true, faces: 1 });
await m.checkOnce();          // seen again — counter must reset
next = reading({ present: false });
await m.checkOnce();
await m.checkOnce();
ok(m.current === "present", "the miss counter resets when you are seen again");

// ---- darkness is not absence ---------------------------------------------
const darkEvents: string[] = [];
let darkReading: Presence = reading({ present: false, dark: true, brightness: 0.01 });
const d = new PresenceMonitor(quiet, async () => darkReading);
d.on("left", () => darkEvents.push("left"));
d.on("tooDark", () => darkEvents.push("dark"));
for (let i = 0; i < 6; i++) await d.checkOnce();
ok(d.current !== "away", "a dark room is never treated as you having left");
ok(darkEvents.includes("dark") && !darkEvents.includes("left"), "it reports darkness instead");

// ---- a camera error changes nothing --------------------------------------
const e = new PresenceMonitor(quiet, async () => reading({ error: "camera busy" }));
for (let i = 0; i < 5; i++) await e.checkOnce();
ok(e.current === "unknown", "a camera error leaves the state unknown, not away");

console.log(`\n${pass}/${pass + fail} presence checks passed\n`);
process.exit(fail ? 1 : 0);
