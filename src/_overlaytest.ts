/**
 * Overlay wiring: can what Jarvis does actually reach the screen?
 *
 * The overlay failed silently for its whole existence — overlay.js read
 * `window.ipcRenderer`, which contextIsolation makes undefined, so it threw on
 * its first line and drew nothing. Nothing errored visibly. These checks make
 * that class of break loud.
 *
 *   npm run overlaytest
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeAction } from "./frontier/narrate.js";

const root = process.cwd();
const html = readFileSync(join(root, "renderer/overlay.html"), "utf8");
const css = readFileSync(join(root, "renderer/overlay.css"), "utf8");
const js = readFileSync(join(root, "renderer/overlay.js"), "utf8");
const preload = readFileSync(join(root, "src/preload.ts"), "utf8");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nOverlay wiring\n");

// ---- the bridge that was broken -------------------------------------------
console.log("  bridge");
ok(preload.includes("jarvisOverlay"), "preload exposes an overlay bridge");
ok(!/const\s*\{\s*ipcRenderer\s*\}\s*=\s*window\s*;/.test(js),
   "overlay.js no longer reads ipcRenderer straight off window");
ok(js.includes("window.jarvisOverlay"), "overlay.js uses the exposed bridge");

// ---- every element the JS drives must exist in the markup -----------------
console.log("  elements");
const wanted = ["action-feed", "feed-lines", "feed-state", "strike", "target-box", "scanbeam"];
for (const id of wanted) {
  ok(html.includes(`id="${id}"`), `#${id} exists in the markup`);
  // Styled by id OR by a class of the same name — both are real styling; the
  // point is that the element is not left unstyled entirely.
  ok(css.includes(`#${id}`) || css.includes(`.${id}`), `#${id} is styled`);
}

// ---- narration produces something for real actions ------------------------
console.log("  narration");
const cases: Array<[string, Record<string, unknown>, RegExp]> = [
  ["click_ui_element", { description: "Send" }, /Clicking .Send./],
  ["type_text", { text: "hello there" }, /Typing/],
  ["open_app", { name: "Google Chrome" }, /Opening Google Chrome/],
  ["Bash", { command: "npm test" }, /Running: npm test/],
  ["screenshot", {}, /Looking at the screen/],
  ["send_sms_message", { recipient: "+1555" }, /Sending a message/],
  ["dismiss_popups", {}, /Clearing/],
];
for (const [tool, input, want] of cases) {
  const e = describeAction(tool, input);
  ok(!!e?.line && want.test(e.line), `${tool} -> ${JSON.stringify(e?.line ?? "")}`);
}

// A click must carry coordinates so the marker lands in the right place.
const clickEvent = describeAction("click", { x: 640, y: 400 });
ok(clickEvent?.strike?.x === 640 && clickEvent?.strike?.y === 400, "a click carries its coordinates to the marker");

// Reading the screen should sweep.
ok(describeAction("read_screen_text", {})?.sweep === true, "reading the screen triggers the sweep");

// Nothing may act invisibly — an unknown tool still produces a line.
ok(!!describeAction("some_new_tool", {})?.line, "an unlisted tool still shows something");

// Dangerous actions are coloured so the pause has a visible cause.
ok(describeAction("send_sms_message", { recipient: "x" })?.kind === "stop", "outward-facing actions are flagged");

console.log(`\n${pass}/${pass + fail} overlay checks passed\n`);
process.exit(fail ? 1 : 0);
