/**
 * Making a small local model's tool calls usable.
 *   npm run localtest
 */
import { parseCallsFromText, resolveToolName, toolsForLocalModel } from "./brain/localtools.js";
import { TOOLS } from "./tools/registry.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nLocal model tool handling\n");

console.log("  recovering a call written as text");
// Exactly what llama3.2:3b produced when asked to turn on hand gestures.
const real = '{"type":"function","name":"update_hand_gesture_params","parameters": {"v": "True"}}';
const got = parseCallsFromText(real);
ok(got.length === 1, "the observed real-world output is recovered");
ok(got[0]?.name === "update_hand_gesture_params", "the name is read out");

ok(parseCallsFromText('{"name":"screenshot","arguments":{}}').length === 1, "the arguments spelling works too");
ok(parseCallsFromText('```json\n{"name":"screenshot","parameters":{}}\n```').length === 1, "a fenced code block works");
ok(parseCallsFromText('{"function":{"name":"click","arguments":{"x":1,"y":2}}}')[0]?.args.x === 1, "a nested function object works");
ok(parseCallsFromText("I'll take a screenshot for you.").length === 0, "ordinary prose yields no call");
ok(parseCallsFromText("").length === 0, "empty text yields no call");

console.log("  resolving an invented name to a real tool");
const pairs: Array<[string, string]> = [
  ["update_hand_gesture_params", "toggle_hand_gestures"],  // the real failure
  ["toggle_hand_gestures", "toggle_hand_gestures"],        // exact still works
  ["TOGGLE_HAND_GESTURES", "toggle_hand_gestures"],        // case
  ["enable_eye_tracking", "toggle_eye_tracking"],
  ["take_screenshot", "screenshot"],
  ["open_application", "open_app"],
];
for (const [called, want] of pairs) {
  const r = resolveToolName(called);
  ok(r === want, `"${called}" -> ${r ?? "no match"}`);
}
ok(resolveToolName("launch_the_rockets") === null, "an unrelated name matches nothing");
ok(resolveToolName("") === null, "an empty name matches nothing");

console.log("  a shorter list for a small model");
const all = TOOLS.map((t) => ({ function: { name: t.name } }));
const few = toolsForLocalModel(all);
ok(few.length < all.length, `${all.length} tools trimmed to ${few.length}`);
ok(few.some((t: any) => t.function.name === "toggle_hand_gestures"), "the gesture switch is still offered");
ok(few.some((t: any) => t.function.name === "screenshot"), "seeing the screen is still offered");
// Every name in the list must be real, or trimming reintroduces the very
// problem it exists to solve.
const names = new Set(TOOLS.map((t) => t.name));
ok(few.every((t: any) => names.has(t.function.name)), "every offered tool actually exists");

console.log(`\n${pass}/${pass + fail} local-model checks passed\n`);
process.exit(fail ? 1 : 0);
