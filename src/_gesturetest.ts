/**
 * Hand-gesture decisions, without needing a camera.
 *
 *   npm run gesturetest
 */
import { decide, newGestureState, toScreen, DEFAULT_REGION, MOVE_INTERVAL_MS, type HandFrame, type GestureState } from "./tools/gesturelogic.js";

const SCREEN = { width: 1440, height: 900 };
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const frame = (p: Partial<HandFrame> = {}): HandFrame => ({
  x: 0.5, y: 0.5, fingers: 1, tap: false, pinching: false, swipe: "none", confidence: 0.9, ...p,
});

console.log("\nHand gestures\n");

console.log("  whatever range you can actually reach maps to the whole screen");
// The real complaint: a fixed guess at the comfortable band still left the
// bottom unreachable, because reach depends on camera angle, chair and arm.
// These simulate someone with a NARROW reach and confirm they still get there.
{
  const st = newGestureState();
  // Someone who can only move between 0.50 and 0.68 vertically — far less than
  // any fixed guess would have assumed.
  const low = 0.50, high = 0.68;
  let t = 1000;
  for (const fy of [high, low, high, low]) {
    decide(frame({ x: 0.5, y: fy }), st, SCREEN, (t += 100));
  }
  // Each check must follow a DIFFERENT position, or the "no visible movement"
  // guard correctly reports nothing and the test measures its own mistake.
  decide(frame({ x: 0.5, y: high }), st, SCREEN, (t += 100));
  const atLow = decide(frame({ x: 0.5, y: low }), st, SCREEN, (t += 100));
  decide(frame({ x: 0.5, y: low }), st, SCREEN, (t += 100));
  const atHigh = decide(frame({ x: 0.5, y: high }), st, SCREEN, (t += 100));
  ok(atLow.kind === "move" && atLow.y >= SCREEN.height - 2,
     `a narrow reach still gets to the bottom (${atLow.kind === "move" ? atLow.y : "?"}px of ${SCREEN.height})`);
  ok(atHigh.kind === "move" && atHigh.y <= 2, "and to the top");
}
{
  // And someone with a wide reach is not made hypersensitive.
  const st = newGestureState();
  let t = 1000;
  for (const fy of [0.9, 0.2, 0.9, 0.2]) decide(frame({ x: 0.5, y: fy }), st, SCREEN, (t += 100));
  const mid = decide(frame({ x: 0.5, y: 0.55 }), st, SCREEN, (t += 100));
  ok(mid.kind === "move" && Math.abs(mid.y - SCREEN.height / 2) < 60,
     "a wide reach still puts the middle near the middle");
}
{
  // A hand that barely moves must not make the cursor fling about.
  const st = newGestureState();
  let t = 1000;
  for (let i = 0; i < 20; i++) decide(frame({ x: 0.5, y: 0.5 + (i % 2) * 0.001 }), st, SCREEN, (t += 100));
  const a1 = decide(frame({ x: 0.5, y: 0.500 }), st, SCREEN, (t += 100));
  const a2 = decide(frame({ x: 0.5, y: 0.503 }), st, SCREEN, (t += 100));
  const jump = a1.kind === "move" && a2.kind === "move" ? Math.abs(a2.y - a1.y) : 0;
  ok(jump < SCREEN.height / 2, `a nearly-still hand does not fling the cursor (${jump}px)`);
}

console.log("  the fixed fallback region also covers the screen");
// The bug: mapping the whole camera frame meant the bottom of the screen sat
// past the edge of what the camera could see, so the cursor stopped halfway.
const lowest  = toScreen({ x: 0.5, y: DEFAULT_REGION.yMin }, SCREEN);
const highest = toScreen({ x: 0.5, y: DEFAULT_REGION.yMax }, SCREEN);
ok(lowest.y >= SCREEN.height - 1, `lowering your hand reaches the bottom (${lowest.y}px of ${SCREEN.height})`);
ok(highest.y <= 1, `raising it reaches the top (${highest.y}px)`);

const left  = toScreen({ x: DEFAULT_REGION.xMin, y: 0.5 }, SCREEN);
const right = toScreen({ x: DEFAULT_REGION.xMax, y: 0.5 }, SCREEN);
ok(left.x <= 1 && right.x >= SCREEN.width - 1, "and both side edges are reachable");

// Overshooting must stay pinned to the edge, not wrap or overflow.
const past = toScreen({ x: 0.99, y: 0.02 }, SCREEN);
ok(past.x === SCREEN.width && past.y === SCREEN.height, "reaching past the region clamps to the edge");
const under = toScreen({ x: 0.01, y: 0.99 }, SCREEN);
ok(under.x === 0 && under.y === 0, "and the same at the other corner");

// The midpoint should land mid-screen, or the mapping is skewed.
const mid = toScreen({ x: 0.5, y: (DEFAULT_REGION.yMin + DEFAULT_REGION.yMax) / 2 }, SCREEN);
ok(Math.abs(mid.y - SCREEN.height / 2) <= 2, "the middle of your reach is the middle of the screen");

console.log("  one finger points");
let s = newGestureState();
let a = decide(frame({ x: 0.5, y: (DEFAULT_REGION.yMin + DEFAULT_REGION.yMax) / 2 }), s, SCREEN, 1000);
ok(a.kind === "move", "one finger moves the cursor");
ok(a.kind === "move" && a.x === 720, "x maps to the middle of the width");

a = decide(frame({ x: 0.0, y: 1.0 }), s, SCREEN, 2000);
ok(a.kind === "move" && a.x === 0 && a.y === 0, "top-left corner is reachable");
a = decide(frame({ x: 1.0, y: 0.0 }), s, SCREEN, 3000);
ok(a.kind === "move" && a.x === 1440 && a.y === 900, "bottom-right corner is reachable");

console.log("  the pointer is not flooded with work");
s = newGestureState();
decide(frame({ x: 0.5 }), s, SCREEN, 1000);
ok(decide(frame({ x: 0.6 }), s, SCREEN, 1000 + 5).kind === "none", "moves faster than the interval are dropped");
ok(decide(frame({ x: 0.6 }), s, SCREEN, 1000 + MOVE_INTERVAL_MS + 1).kind === "move", "and allowed once the interval passes");

s = newGestureState();
decide(frame({ x: 0.5, y: 0.5 }), s, SCREEN, 1000);
ok(decide(frame({ x: 0.5005, y: 0.5 }), s, SCREEN, 5000).kind === "none", "sub-pixel drift is ignored");

console.log("  pinching thumb to index clicks");
s = newGestureState();
decide(frame({ x: 0.3, y: 0.7 }), s, SCREEN, 1000);      // aim with one finger
const aimedX = s.lastX, aimedY = s.lastY;

const click = decide(frame({ tap: true, pinching: true, x: 0.9, y: 0.1 }), s, SCREEN, 2000);
ok(click.kind === "click", "the pinch clicks");
ok(click.kind === "click" && click.x === aimedX && click.y === aimedY,
   "it clicks where you AIMED, not where the pinch pulled your finger");

// Bringing the thumb across physically drags the index tip; tracking that
// would slide the cursor off target at the worst moment.
ok(decide(frame({ pinching: true, x: 0.95, y: 0.05 }), s, SCREEN, 3000).kind === "none",
   "the cursor is frozen while the fingers are together");
ok(decide(frame({ pinching: false, x: 0.6, y: 0.4 }), s, SCREEN, 4000).kind === "move",
   "and moves again once released");

// Holding a pinch must not machine-gun clicks.
let clicks = 0;
for (let t = 5000; t < 6000; t += 40) {
  if (decide(frame({ pinching: true, tap: false }), s, SCREEN, t).kind === "click") clicks++;
}
ok(clicks === 0, "holding the pinch does not keep clicking");

console.log("  the hand can reach every display");
{
  // Two 1440x900 screens side by side: the pointer must be able to reach x=2879,
  // not stop dead at 1439 as it did when the surface was the primary display.
  const WIDE = { width: 2880, height: 900, x: 0, y: 0 };
  const st = newGestureState();
  let t = 1000;
  for (const fx of [0.2, 0.8, 0.2, 0.8]) decide(frame({ x: fx, y: 0.5 }), st, WIDE, (t += 100));
  decide(frame({ x: 0.2, y: 0.5 }), st, WIDE, (t += 100));
  const far = decide(frame({ x: 0.8, y: 0.5 }), st, WIDE, (t += 100));
  ok(far.kind === "move" && far.x >= WIDE.width - 2,
     `reaches the far edge of the second screen (${far.kind === "move" ? far.x : "?"}px of ${WIDE.width})`);
}
{
  // A monitor to the LEFT of the primary occupies NEGATIVE coordinates. Any
  // mapping that assumes the desktop starts at zero cannot reach it at all.
  const LEFTOF = { width: 2880, height: 900, x: -1440, y: 0 };
  const st = newGestureState();
  let t = 1000;
  for (const fx of [0.2, 0.8, 0.2, 0.8]) decide(frame({ x: fx, y: 0.5 }), st, LEFTOF, (t += 100));
  decide(frame({ x: 0.8, y: 0.5 }), st, LEFTOF, (t += 100));
  const left = decide(frame({ x: 0.2, y: 0.5 }), st, LEFTOF, (t += 100));
  ok(left.kind === "move" && left.x <= -1438,
     `reaches into negative coordinates (${left.kind === "move" ? left.x : "?"})`);
}
{
  const p = toScreen({ x: 0.5, y: 0.5 }, { width: 1440, height: 900 });
  const q = toScreen({ x: 0.5, y: 0.5 }, { width: 1440, height: 900, x: 0, y: 0 });
  ok(p.x === q.x && p.y === q.y, "an absent origin behaves exactly like (0,0)");
}

console.log("  three fingers scroll");
for (const dir of ["up", "down", "left", "right"] as const) {
  const r = decide(frame({ fingers: 3, swipe: dir }), newGestureState(), SCREEN, 1000);
  ok(r.kind === "scroll" && r.direction === dir, `swiping ${dir} scrolls ${dir}`);
}
ok(decide(frame({ fingers: 3 }), newGestureState(), SCREEN, 1000).kind === "none",
   "three fingers held still does nothing");

console.log("  a resting hand is not an input");
ok(decide(frame({ fingers: 0 }), newGestureState(), SCREEN, 1000).kind === "none", "a closed fist does nothing");
ok(decide(frame({ fingers: 4 }), newGestureState(), SCREEN, 1000).kind === "none", "an open palm does nothing");

console.log(`\n${pass}/${pass + fail} gesture checks passed\n`);
process.exit(fail ? 1 : 0);
