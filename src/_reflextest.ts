/**
 * The cached-shortcut path must not be a way around the safety layer.
 *
 * Reflex replays saved steps without the model, which is what makes a repeated
 * command instant — but it also meant those steps skipped the risk gate
 * entirely. A cached workflow containing "click Send" fired with no
 * confirmation at all.
 *
 *   npm run reflextest
 */
import { classify } from "./safety/risk.js";
import type { Step } from "./frontier/demonstrate.js";

const ctx = { workingDir: process.env.HOME || "/tmp" };
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nCached shortcuts go through the gate\n");

// Mirrors gatedreplay's mapping from a saved step to the tool it stands for.
function tierOf(step: Step): string {
  const map: Record<string, { tool: string; input: Record<string, unknown> }> = {
    click: { tool: "click_ui_element", input: { description: (step as any).target } },
    type: { tool: "type_text", input: { text: (step as any).text } },
    open: { tool: "open_app", input: { name: (step as any).app } },
    keys: { tool: "press_keys", input: { key: (step as any).key, modifiers: (step as any).modifiers } },
    wait: { tool: "wait", input: {} },
  };
  const m = map[step.kind];
  return classify(`mcp__jarvis__${m.tool}`, m.input, ctx).tier;
}

console.log("  a cached step that sends or spends must still ask");
const dangerous: Step[] = [
  { kind: "click", target: "Send" },
  { kind: "click", target: "Place your order" },
  { kind: "click", target: "Add to Cart" },
  { kind: "click", target: "Delete forever" },
];
for (const s of dangerous) {
  ok(tierOf(s) === "high", `replaying click "${(s as any).target}" -> ${tierOf(s)}`);
}

console.log("  ordinary cached steps stay instant");
const benign: Step[] = [
  { kind: "click", target: "Inbox" },
  { kind: "open", app: "Safari" },
  { kind: "wait", seconds: 1 },
  { kind: "keys", modifiers: ["cmd"], key: "l" },
];
for (const s of benign) {
  ok(tierOf(s) !== "high", `replaying ${s.kind} -> ${tierOf(s)} (no prompt)`);
}

console.log(`\n${pass}/${pass + fail} reflex-safety checks passed\n`);
process.exit(fail ? 1 : 0);
