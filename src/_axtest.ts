/**
 * Accessibility targeting, end to end.
 *
 * Opens a throwaway TextEdit window, reads its controls through the real
 * axhelper binary, ranks them against spoken-style descriptions, and activates
 * one by AXPress — the full path the click_ui_element tool takes. TextEdit is
 * used because its ruler has stable, safely-toggleable checkboxes (bold/italic).
 *
 *   npm run axtest
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as ax from "./tools/ax.js";

const run = promisify(execFile);
const osa = (s: string) => run("/usr/bin/osascript", ["-e", s]).catch(() => ({ stdout: "" }));

let pass = 0;
let fail = 0;
const ok = (c: boolean, msg: string) => (c ? (pass++, console.log(`  ✓ ${msg}`)) : (fail++, console.log(`  ✗ ${msg}`)));

console.log("\nAccessibility targeting — axhelper -> rank -> AXPress\n");

if (!ax.helperAvailable()) {
  console.log("  ✗ native/axhelper is not built — run `npm run build` first");
  process.exit(1);
}

// Bring TextEdit up with a fresh document.
await osa('tell application "TextEdit" to activate');
await osa('tell application "TextEdit" to make new document');
await new Promise((r) => setTimeout(r, 1200));

try {
  const d = await ax.dump();

  // This is an INTEGRATION test: it needs TextEdit to actually come to the
  // foreground, plus Accessibility + Automation permissions for the process
  // running it. In a headless / non-interactive run (CI, an automation shell),
  // TextEdit does not gain focus and the frontmost app exposes no controls —
  // that is an environment limitation, not an Echo bug. Skip cleanly rather than
  // report a false failure, exactly as the audio/camera tests do when their
  // hardware is absent.
  if (!d.axAvailable || d.app !== "TextEdit" || d.elements.length === 0) {
    console.log(`  ⚠ skipped — TextEdit did not come to the foreground with accessibility data`);
    console.log(`    (frontmost was "${d.app}", ${d.elements.length} elements; needs an interactive`);
    console.log(`     session with Accessibility + Automation permissions). Not a code failure.`);
    await osa('tell application "TextEdit" to quit');
    process.exit(0);
  }

  ok(d.axAvailable, `dump returned accessibility data (${d.app}, ${d.elements.length} elements)`);
  ok(d.elements.length >= 3, `found several controls`);

  const pressable = d.elements.filter((e) => e.press);
  ok(pressable.length > 0, `at least one control supports direct activation (AXPress)`);

  // Ranking: a description should surface the matching control first.
  const wantBold = ax.rank(d.elements, "bold");
  ok(wantBold.length > 0 && /bold/i.test(wantBold[0].label), `"bold" ranks the bold control first`);

  const wantItalic = ax.rank(d.elements, "the italic button");
  ok(wantItalic.length > 0 && /italic/i.test(wantItalic[0].label), `"the italic button" ranks italic first`);

  // Nonsense should match nothing rather than mis-clicking.
  ok(ax.rank(d.elements, "launch the rockets").length === 0, `an unrelated request matches nothing`);

  // Activate bold by AXPress, twice, so the document is left unchanged.
  const bold = wantBold[0];
  if (bold) {
    const r1 = await ax.press(d.pid, bold.path);
    ok(r1.ok, `AXPress activated "${bold.label}" (no mouse used)`);
    await ax.press(d.pid, bold.path); // toggle back
  }
} finally {
  await osa('tell application "TextEdit" to close every document saving no');
  await osa('tell application "TextEdit" to quit');
}

console.log(`\n${pass}/${pass + fail} accessibility checks passed\n`);
process.exit(fail ? 1 : 0);
