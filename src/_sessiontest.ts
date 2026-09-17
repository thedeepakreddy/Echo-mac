/**
 * The voice session state machine, driven without a microphone.
 *
 *   npm run sessiontest
 */
import { VoiceSession } from "./voice/session.js";
import { voiceLog } from "./voice/voice-log.js";

voiceLog.init(process.cwd(), { quiet: true });

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nVoice session\n");

const windowMs = { value: 120 };
const s = new VoiceSession({ windowMs: () => windowMs.value });
const states: string[] = [];
s.on("state", (next: string) => states.push(next));

ok(s.state === "sleeping", "starts asleep");

// ---- a plain turn -----------------------------------------------------------
const t1 = s.beginTurn("acoustic");
ok(s.state === "listening" && s.current?.id === "t1", "a wake opens a listening turn");
s.noteBrainSend(t1, "open safari", "test");
ok(s.state === "thinking" && s.brainOutputIsLive(), "sending to the brain: thinking, output live");
s.noteBrainText("Opening Safari.");
s.noteSpeaking(true);
ok(s.state === "speaking", "audio playing: speaking");
s.noteBrainDone();
let summary: any = null;
s.once("turnSummary", (x: any) => (summary = x));
s.openWindow();
s.noteSpeaking(false);
ok(s.state === "active_idle", "after speech with the window open: active_idle");
ok(summary?.turnId === "t1", "a settled turn produces exactly one summary");
ok(s.windowOpen, "conversation window is open");

// ---- window timing ------------------------------------------------------------
await new Promise((r) => setTimeout(r, 60));
s.extendWindow();
await new Promise((r) => setTimeout(r, 90));
ok(s.windowOpen, "a user turn extends the window");
await new Promise((r) => setTimeout(r, 120));
ok(!s.windowOpen && s.state === "sleeping", "the window times out back to sleeping");

// ---- barge-in keeps the brain, drops the speech --------------------------------
const t2 = s.beginTurn("manual");
s.noteBrainSend(t2, "tell me a story", "test");
s.noteSpeaking(true);
const gen = s.generation;
let cancelled: any[] = [];
s.on("cancel", (kind: string, reason: string) => cancelled.push([kind, reason]));
const aborted = new Promise<boolean>((res) => t2.abort.signal.addEventListener("abort", () => res(true)));
s.cancel("bargein", "user spoke");
ok(s.generation === gen + 1, "a cancel moves the generation on");
ok(!s.brainOutputIsLive(), "brain output from before the cancel is no longer live");
ok(cancelled[0]?.[0] === "bargein", "cancel event names the kind");
ok(await Promise.race([aborted, new Promise<boolean>((r) => setTimeout(() => r(false), 50))]), "the turn's abort signal fires");
ok(t2.cancelled, "the turn is marked cancelled");

// ---- a new turn after the cancel is live again --------------------------------
const t3 = s.beginTurn("bargein");
s.noteBrainSend(t3, "actually, stop", "test");
ok(s.brainOutputIsLive(), "the next brain turn is live");

// ---- serialization -------------------------------------------------------------
const order: number[] = [];
const p1 = s.enqueue("a", async () => { await new Promise((r) => setTimeout(r, 30)); order.push(1); });
const p2 = s.enqueue("b", async () => { order.push(2); });
const p3 = s.enqueue("c", async () => { throw new Error("boom"); });
await Promise.all([p1, p2, p3]);
ok(order.join(",") === "1,2", "utterance handlers run one at a time, in order");
ok(s.pending === 0, "a throwing handler does not jam the queue");

ok(states.includes("interrupted") && states.includes("thinking"), "transitions are reported");

console.log(`\n${pass}/${pass + fail} session cases passed\n`);
process.exit(fail ? 1 : 0);
