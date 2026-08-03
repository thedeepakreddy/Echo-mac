/**
 * Multi-display geometry and naming.
 *
 *   npm run displaytest
 *
 * Written on a one-screen laptop, which is exactly why the logic lives in a
 * pure module: the arrangements that were broken cannot be plugged in here.
 * The layouts below are the real ones — a monitor to the right, a monitor to
 * the LEFT (negative coordinates, the case that quietly breaks clamping), and
 * a monitor above.
 */
import {
  contains, centerOf, displayAt, primaryOf, resolveDisplay,
  positionOf, describeDisplays, desktopBounds, type Display,
} from "./tools/displays.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const d = (index: number, x: number, y: number, width: number, height: number, primary = false): Display =>
  ({ index, id: 100 + index, x, y, width, height, primary });

// A laptop with an external monitor to its right.
const RIGHT = [d(0, 0, 0, 1440, 900, true), d(1, 1440, 0, 2560, 1440)];
// The same monitor moved to the LEFT: its origin is negative.
const LEFT = [d(0, 0, 0, 1440, 900, true), d(1, -2560, 0, 2560, 1440)];
// A monitor stacked above the laptop.
const ABOVE = [d(0, 0, 0, 1440, 900, true), d(1, 0, -1440, 2560, 1440)];
const SOLO = [d(0, 0, 0, 1440, 900, true)];

console.log("\nDisplays\n");

console.log("  a point lands on the right screen");
{
  ok(displayAt(RIGHT, { x: 100, y: 100 })?.index === 0, "a point on the laptop resolves to the laptop");
  ok(displayAt(RIGHT, { x: 2000, y: 300 })?.index === 1, "a point past 1440 resolves to the external monitor");
  ok(contains(RIGHT[1], { x: 1440, y: 0 }), "the boundary pixel belongs to the display it starts");
  ok(!contains(RIGHT[0], { x: 1440, y: 0 }), "and not to the one it ends");
}
{
  // The case that breaks anything assuming coordinates start at zero.
  ok(displayAt(LEFT, { x: -1000, y: 400 })?.index === 1,
     "a NEGATIVE x resolves to the monitor on the left");
  ok(displayAt(LEFT, { x: 700, y: 400 })?.index === 0, "and a positive one still resolves to the laptop");
  ok(displayAt(ABOVE, { x: 700, y: -700 })?.index === 1, "a negative y resolves to the monitor above");
}
{
  // Just off the edge should still be the screen it plainly belongs to.
  ok(displayAt(RIGHT, { x: 1435, y: 905 })?.index === 0, "a point just past the bottom edge resolves to the nearest screen");
  ok(displayAt([], { x: 0, y: 0 }) === null, "no displays resolves to nothing, rather than throwing");
}

console.log("  centres and bounds");
{
  ok(centerOf(RIGHT[1]).x === 2720 && centerOf(RIGHT[1]).y === 720,
     `the external monitor's centre is global, not local (${centerOf(RIGHT[1]).x},${centerOf(RIGHT[1]).y})`);
  const b = desktopBounds(RIGHT);
  ok(b.width === 4000 && b.x === 0, `the desk spans both screens (${b.width}px from ${b.x})`);
  const bl = desktopBounds(LEFT);
  ok(bl.x === -2560 && bl.width === 4000, `and starts negative when a screen is to the left (${bl.x})`);
  ok(desktopBounds([]).width === 0, "an empty desk has no bounds, and does not throw");
}

console.log("  saying which screen you mean");
{
  const mouseOnLaptop = { x: 200, y: 200 };
  ok(resolveDisplay(RIGHT, "my other monitor", mouseOnLaptop)?.index === 1,
     "'my other monitor' means the one you are not on");
  ok(resolveDisplay(RIGHT, "the other one", { x: 2000, y: 200 })?.index === 0,
     "and it flips when you are on the other one");
  ok(resolveDisplay(RIGHT, "this screen", mouseOnLaptop)?.index === 0, "'this screen' is where you are");
  ok(resolveDisplay(RIGHT, "main display")?.index === 0, "'main' is the primary");
  ok(resolveDisplay(RIGHT, "external monitor")?.index === 1, "'external' is the non-primary one");
  ok(resolveDisplay(RIGHT, "built-in display")?.index === 0, "'built-in' is the primary");
}
{
  ok(resolveDisplay(RIGHT, "the screen on the right")?.index === 1, "'right' picks by geometry");
  ok(resolveDisplay(LEFT, "the screen on the right")?.index === 0,
     "and the SAME words pick differently when the monitor is moved");
  ok(resolveDisplay(LEFT, "left")?.index === 1, "'left' finds the negative-origin monitor");
  ok(resolveDisplay(ABOVE, "the display above")?.index === 1, "'above' picks by vertical position");
  ok(resolveDisplay(RIGHT, "the big one")?.index === 1, "'the big one' compares area");
  ok(resolveDisplay(RIGHT, "the small one")?.index === 0, "and 'small' is the other way");
}
{
  ok(resolveDisplay(RIGHT, "second display")?.index === 1, "an ordinal works");
  ok(resolveDisplay(RIGHT, 1)?.index === 1, "so does a plain index");
  ok(resolveDisplay(RIGHT, 9) === null, "an index that does not exist resolves to nothing");
  ok(resolveDisplay(RIGHT, undefined)?.index === 0, "no preference means the main display");
  ok(resolveDisplay(RIGHT, "gibberish qwertyuiop")?.index === 0, "and so does something unparseable");
}
{
  // With one screen every phrasing must still resolve to it, rather than
  // returning nothing and making the caller handle an impossible case.
  for (const q of ["other monitor", "left", "right", "external", "second", "the big one"]) {
    ok(resolveDisplay(SOLO, q)?.index === 0, `one screen: "${q}" resolves to it anyway`);
  }
  ok(resolveDisplay([], "anything") === null, "no screens resolves to nothing");
}

console.log("  describing the arrangement");
{
  ok(positionOf(RIGHT[1], RIGHT) === "right of the main display", `${positionOf(RIGHT[1], RIGHT)}`);
  ok(positionOf(LEFT[1], LEFT) === "left of the main display", `${positionOf(LEFT[1], LEFT)}`);
  ok(positionOf(ABOVE[1], ABOVE) === "above the main display", `${positionOf(ABOVE[1], ABOVE)}`);
  ok(positionOf(RIGHT[0], RIGHT) === "primary", "the primary says so");
  ok(/2 displays/.test(describeDisplays(RIGHT)), "the description counts them");
  ok(/One display/.test(describeDisplays(SOLO)), "and reads naturally with one");
  ok(/can't see any/.test(describeDisplays([])), "and says so with none");
}

console.log("  primary");
{
  ok(primaryOf(RIGHT)?.index === 0, "the flagged display is primary");
  ok(primaryOf([d(0, 0, 0, 100, 100), d(1, 100, 0, 100, 100)])?.index === 0,
     "with none flagged, the first stands in");
  ok(primaryOf([]) === null, "with none at all, nothing");
}

console.log(`\n${pass}/${pass + fail} display checks passed\n`);
process.exit(fail ? 1 : 0);
