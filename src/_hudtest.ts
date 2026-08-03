/**
 * HUD wiring: does every state the CSS styles actually get set by the JS?
 *
 * A dead selector is invisible — the reactor simply never changes and nothing
 * errors. This catches the specific trap that dataset.awayMode becomes the
 * attribute data-away-mode, so a camelCase selector silently matches nothing.
 *
 *   npm run hudtest
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const css = readFileSync(join(root, "renderer/hud.css"), "utf8");
const js = readFileSync(join(root, "renderer/hud.js"), "utf8");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nHUD state wiring\n");

/** dataset.fooBar sets the attribute data-foo-bar. */
const attrFor = (camel: string) => "data-" + camel.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

// Every data-* attribute the stylesheet depends on.
const styled = new Set([...css.matchAll(/\[(data-[a-z-]+)\s*[=\]]/g)].map((m) => m[1]));
// Every dataset property the renderer assigns, converted to its real attribute.
const set = new Set([...js.matchAll(/dataset\.([A-Za-z]+)\s*=/g)].map((m) => attrFor(m[1])));

ok(styled.size > 0, `stylesheet reacts to ${styled.size} state attribute(s)`);
for (const attr of styled) {
  ok(set.has(attr), `${attr} is actually set by the renderer`);
}

// No camelCase attribute selectors — they can never match a dataset assignment.
const camelSelectors = [...css.matchAll(/\[data-[a-z]*[A-Z][A-Za-z-]*/g)].map((m) => m[0]);
ok(camelSelectors.length === 0, `no camelCase attribute selectors${camelSelectors.length ? ` (found ${camelSelectors.join(", ")})` : ""}`);

// The away states specifically, since they drive the dimming.
ok(css.includes('[data-away="yes"]'), "away state has styling");
ok(js.includes("dataset.away"), "away state is set by the renderer");
ok(/opacity/.test(css.split('[data-away="yes"]')[1] ?? ""), "away styling actually dims the reactor");

console.log(`\n${pass}/${pass + fail} HUD wiring checks passed\n`);
process.exit(fail ? 1 : 0);
