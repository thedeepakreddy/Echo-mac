/**
 * Which screen is which, and where each one sits.
 *
 * Everything used to assume there was exactly one display. Six call sites asked
 * for the primary one and the OCR helper captured whichever display happened to
 * be first, so on a two-monitor desk Jarvis read the wrong screen and clicked
 * coordinates that belonged to a different one.
 *
 * The coordinate space here is the one the mouse actually lives in: logical
 * points, top-left origin, primary display at (0,0), other displays offset
 * around it — possibly with NEGATIVE coordinates when a monitor sits to the
 * left of or above the primary. Any code that clamps a coordinate to
 * [0, width] silently breaks that arrangement.
 *
 * The naming logic is separated from the plumbing so it can be tested on a
 * machine with one screen, which is the machine it was written on.
 */

export interface Display {
  index: number;
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface Point {
  x: number;
  y: number;
}

/** Does this display contain the point? */
export function contains(d: Display, p: Point): boolean {
  return p.x >= d.x && p.x < d.x + d.width && p.y >= d.y && p.y < d.y + d.height;
}

/** Middle of a display, in global coordinates. */
export function centerOf(d: Display): Point {
  return { x: Math.round(d.x + d.width / 2), y: Math.round(d.y + d.height / 2) };
}

/**
 * Which display a global point falls on.
 *
 * Falls back to the nearest display rather than null: a point a few pixels off
 * the edge (a cursor at the very bottom, a window dragged half off) should
 * still resolve to the screen it plainly belongs to.
 */
export function displayAt(displays: Display[], p: Point): Display | null {
  if (!displays.length) return null;
  const hit = displays.find((d) => contains(d, p));
  if (hit) return hit;

  let best = displays[0];
  let bestDist = Infinity;
  for (const d of displays) {
    const c = centerOf(d);
    const dist = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/** The primary display, or the first one if none is flagged. */
export function primaryOf(displays: Display[]): Display | null {
  return displays.find((d) => d.primary) ?? displays[0] ?? null;
}

const ORDINALS: Record<string, number> = {
  first: 0, one: 0, "1": 0,
  second: 1, two: 1, "2": 1,
  third: 2, three: 2, "3": 2,
  fourth: 3, four: 3, "4": 3,
};

/**
 * Work out which display someone means.
 *
 * People do not say "display index 1". They say "my other monitor", "the big
 * one", "the screen on the left". Each of those is answerable from the
 * geometry, so each is answered rather than requiring an index.
 *
 * @param current where the user's attention currently is (usually the mouse),
 * which is what makes "the other one" meaningful.
 */
export function resolveDisplay(
  displays: Display[],
  query: string | number | undefined,
  current?: Point
): Display | null {
  if (!displays.length) return null;
  if (displays.length === 1) return displays[0];

  if (typeof query === "number") {
    return displays[query] ?? null;
  }
  const q = (query ?? "").toLowerCase().trim();
  if (!q) return primaryOf(displays);

  const here = current ? displayAt(displays, current) : null;

  // "the other one" — only unambiguous with two displays, but that is the
  // overwhelmingly common case and the one worth getting right.
  if (/\b(other|another|opposite)\b/.test(q)) {
    const others = displays.filter((d) => d.index !== (here ?? primaryOf(displays))?.index);
    return others.length === 1 ? others[0] : (others[0] ?? null);
  }

  if (/\b(this|current|same|here)\b/.test(q)) return here ?? primaryOf(displays);
  if (/\b(main|primary)\b/.test(q)) return primaryOf(displays);

  // "built-in" and "external" are about the hardware, which is not visible from
  // geometry alone. The primary display is the built-in one on a laptop in the
  // ordinary case, so it stands in — noted because it is an assumption, not a
  // fact, and a docked machine with the external set as primary inverts it.
  if (/\b(built.?in|laptop|internal|macbook)\b/.test(q)) return primaryOf(displays);
  if (/\b(external|monitor|second screen)\b/.test(q)) {
    const external = displays.filter((d) => !d.primary);
    if (external.length) return external[0];
  }

  const byEdge = (pick: (a: Display, b: Display) => Display) => displays.reduce(pick);
  if (/\bleft\b/.test(q)) return byEdge((a, b) => (b.x < a.x ? b : a));
  if (/\bright\b/.test(q)) return byEdge((a, b) => (b.x > a.x ? b : a));
  if (/\b(top|above|upper)\b/.test(q)) return byEdge((a, b) => (b.y < a.y ? b : a));
  if (/\b(bottom|below|lower)\b/.test(q)) return byEdge((a, b) => (b.y > a.y ? b : a));
  if (/\b(big|large|main|widest)\b/.test(q)) {
    return byEdge((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  }
  if (/\b(small|smallest)\b/.test(q)) {
    return byEdge((a, b) => (b.width * b.height < a.width * a.height ? b : a));
  }

  for (const [word, idx] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(q)) return displays[idx] ?? null;
  }

  return primaryOf(displays);
}

/** Where a display sits relative to the primary, in words. */
export function positionOf(d: Display, displays: Display[]): string {
  const p = primaryOf(displays);
  if (!p || p.index === d.index) return "primary";
  const parts: string[] = [];
  if (d.x + d.width <= p.x) parts.push("left of");
  else if (d.x >= p.x + p.width) parts.push("right of");
  if (d.y + d.height <= p.y) parts.push("above");
  else if (d.y >= p.y + p.height) parts.push("below");
  return parts.length ? `${parts.join(" and ")} the main display` : "overlapping the main display";
}

/** Speakable description of the whole arrangement. */
export function describeDisplays(displays: Display[]): string {
  if (!displays.length) return "I can't see any displays.";
  if (displays.length === 1) {
    const d = displays[0];
    return `One display, ${d.width} by ${d.height}.`;
  }
  const lines = displays.map((d) => {
    const where = d.primary ? "main" : positionOf(d, displays);
    return `  ${d.index + 1}. ${d.width}x${d.height} — ${where}`;
  });
  return `${displays.length} displays:\n${lines.join("\n")}`;
}

/** Total bounding box across every display, for whole-desk operations. */
export function desktopBounds(displays: Display[]): { x: number; y: number; width: number; height: number } {
  if (!displays.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...displays.map((d) => d.x));
  const y = Math.min(...displays.map((d) => d.y));
  const right = Math.max(...displays.map((d) => d.x + d.width));
  const bottom = Math.max(...displays.map((d) => d.y + d.height));
  return { x, y, width: right - x, height: bottom - y };
}
