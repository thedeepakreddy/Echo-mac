/**
 * Decides what a tracked hand frame should actually do.
 *
 * Kept separate from the camera plumbing so it can be tested without one, and
 * because this is where the feel of the feature is decided — the tracker only
 * reports positions, these rules turn them into a usable pointer.
 */

export interface HandFrame {
  x: number; // 0-1, origin bottom-left
  y: number;
  fingers: number;
  /** Fires once as thumb and index meet. */
  tap: boolean;
  /** True for as long as they stay together. */
  pinching: boolean;
  swipe: "none" | "up" | "down" | "left" | "right";
  confidence: number;
}

export type GestureAction =
  | { kind: "none" }
  | { kind: "move"; x: number; y: number }
  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right" };

export interface GestureState {
  lastMoveAt: number;
  lastX: number;
  lastY: number;
  /** What the hand has actually been observed to reach, learned as you move. */
  seen: { xMin: number; xMax: number; yMin: number; yMax: number } | null;
}

export const newGestureState = (): GestureState => ({
  lastMoveAt: 0,
  lastX: -1,
  lastY: -1,
  seen: null,
});

/**
 * The narrowest range that may be stretched to the full screen.
 *
 * Without a floor, a hand held nearly still would collapse the range to almost
 * nothing and every tremor would fling the cursor across the display.
 */
const MIN_SPAN = 0.12;

/**
 * Guarantee a usable span without shifting where the hand sits.
 *
 * Widening only upward (max = min + MIN_SPAN) would drag the mapping's centre
 * away from the hand, so a hand that has barely moved would find itself pinned
 * to one edge. Growing equally in both directions keeps the current position
 * where it belongs.
 */
function widened(seen: { xMin: number; xMax: number; yMin: number; yMax: number }): ActiveRegion {
  const grow = (min: number, max: number) => {
    const span = max - min;
    if (span >= MIN_SPAN) return [min, max] as const;
    const pad = (MIN_SPAN - span) / 2;
    return [min - pad, max + pad] as const;
  };
  const [xMin, xMax] = grow(seen.xMin, seen.xMax);
  const [yMin, yMax] = grow(seen.yMin, seen.yMax);
  return { xMin, xMax, yMin, yMax };
}

/**
 * Learn the range the hand actually covers.
 *
 * Guessing a fixed comfortable rectangle did not work: how low you can reach
 * depends on your camera angle, your chair, your desk and your arm, and being
 * wrong by a little leaves part of the screen unreachable. So instead of
 * assuming, this widens to whatever it observes — reach a bit lower than before
 * and the bottom of the screen comes with you.
 *
 * It only ever grows, apart from a slow inward creep, because shrinking on the
 * basis of a moment's stillness is what makes adaptive pointers feel unstable.
 */
export function observeReach(state: GestureState, frame: { x: number; y: number }): void {
  if (!state.seen) {
    // Seed at exactly where the hand is, with NO width.
    //
    // Padding the seed into a box was subtly wrong: it invented reach the hand
    // does not have. Starting at 0.68 pretended a maximum of 0.74, so raising
    // as far as you could still only reached three-quarters up the screen, and
    // the top was unreachable no matter what you did.
    state.seen = { xMin: frame.x, xMax: frame.x, yMin: frame.y, yMax: frame.y };
    return;
  }
  const s = state.seen;
  s.xMin = Math.min(s.xMin, frame.x);
  s.xMax = Math.max(s.xMax, frame.x);
  s.yMin = Math.min(s.yMin, frame.y);
  s.yMax = Math.max(s.yMax, frame.y);

  // A very slow inward creep, so moving the laptop or changing posture is
  // eventually forgotten rather than leaving the range stuck wide forever.
  const creep = 0.00004;
  s.xMin += creep; s.xMax -= creep;
  s.yMin += creep; s.yMax -= creep;
}

/**
 * The part of the camera's view that maps to the screen.
 *
 * Mapping the WHOLE frame to the whole screen sounds right and is not: sitting
 * at a desk you can only comfortably reach the middle band of what the camera
 * sees. Reaching the bottom of the screen needed a hand position at or below
 * the edge of the frame — near your lap — so the cursor never got past halfway
 * however far you reached.
 *
 * Mapping a comfortable rectangle onto the full screen is what a trackpad does:
 * a small movement covers everything, and the edges stay reachable because
 * anything beyond the region is clamped rather than lost.
 *
 * Measured in Vision's space: origin bottom-left, so yMin is the LOW hand
 * position that should reach the BOTTOM of the screen.
 */
export interface ActiveRegion {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export const DEFAULT_REGION: ActiveRegion = {
  // Leaves the extreme left and right out: hand tracking degrades near the
  // frame edge, where part of the hand is already cut off.
  xMin: 0.2,
  xMax: 0.8,
  // Deliberately narrow vertically. This is the axis that was broken, and a
  // shorter band means less reach is needed to cover the full height.
  yMin: 0.35,
  yMax: 0.8,
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The area the pointer can reach.
 *
 * `x`/`y` are the top-left of that area in the global coordinate space, which
 * is (0,0) for a single screen but NEGATIVE when a monitor sits to the left of
 * or above the primary one. Without them the hand could only ever reach the
 * primary display, which is what happened.
 */
export interface Surface {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

/** Map a point in the camera frame to screen coordinates. */
export function toScreen(
  frame: { x: number; y: number },
  screen: Surface,
  region: ActiveRegion = DEFAULT_REGION
): { x: number; y: number } {
  const spanX = Math.max(0.05, region.xMax - region.xMin);
  const spanY = Math.max(0.05, region.yMax - region.yMin);

  const nx = clamp01((frame.x - region.xMin) / spanX);
  const ny = clamp01((frame.y - region.yMin) / spanY);

  return {
    x: Math.round((screen.x ?? 0) + nx * screen.width),
    // Vision's origin is bottom-left; the screen's is top-left.
    y: Math.round((screen.y ?? 0) + (1 - ny) * screen.height),
  };
}

/** Below this the move is invisible on screen but still costs a process. */
export const MIN_MOVE_PX = 3;
/** Faster than this only queues cliclick processes and makes the cursor stutter. */
export const MOVE_INTERVAL_MS = 25;

export function decide(
  frame: HandFrame,
  state: GestureState,
  screen: Surface,
  now: number,
  region: ActiveRegion = DEFAULT_REGION
): GestureAction {
  // Learn how far this hand actually reaches, and map THAT to the screen. A
  // fixed guess left the bottom unreachable for anyone whose reach differed
  // from the guess.
  observeReach(state, frame);
  // Use the learned range only once the hand has genuinely covered some ground.
  // Stretching a barely-observed range to the whole screen makes the first few
  // seconds hypersensitive — every tremor throws the cursor across the display
  // — so the configured region carries it until there is real evidence.
  const observedSpan = state.seen
    ? Math.max(state.seen.xMax - state.seen.xMin, state.seen.yMax - state.seen.yMin)
    : 0;
  const effective = state.seen && observedSpan >= MIN_SPAN ? widened(state.seen) : region;
  const { x, y } = toScreen(frame, screen, effective);

  // A click is decided before any movement, so it lands where you aimed rather
  // than where the hand drifted as the fingers came together.
  if (frame.tap) {
    const cx = state.lastX >= 0 ? state.lastX : x;
    const cy = state.lastY >= 0 ? state.lastY : y;
    return { kind: "click", x: cx, y: cy };
  }

  // Freeze the pointer while the fingers are together. Bringing thumb to index
  // physically drags the index tip a little, so tracking it through a pinch
  // slides the cursor off whatever you were aiming at — which is exactly when
  // precision matters most.
  if (frame.pinching) return { kind: "none" };

  if (frame.swipe !== "none") {
    return { kind: "scroll", direction: frame.swipe };
  }

  // Only one finger means "point". With two or three the hand is mid-gesture,
  // and moving the cursor then ruins both the gesture and the aim.
  if (frame.fingers !== 1) return { kind: "none" };

  if (now - state.lastMoveAt < MOVE_INTERVAL_MS) return { kind: "none" };
  if (
    state.lastX >= 0 &&
    Math.abs(x - state.lastX) < MIN_MOVE_PX &&
    Math.abs(y - state.lastY) < MIN_MOVE_PX
  ) {
    return { kind: "none" };
  }

  state.lastMoveAt = now;
  state.lastX = x;
  state.lastY = y;
  return { kind: "move", x, y };
}
