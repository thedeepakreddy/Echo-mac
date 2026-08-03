import { EventEmitter } from "node:events";
import { run, osascript } from "../tools/shell.js";
import * as vision from "../tools/vision.js";

/**
 * Knows whether you are at the desk, and reacts when you leave.
 *
 * The camera is sampled on a slow timer rather than held open — a webcam light
 * that never goes off is unnerving, and presence changes on the scale of
 * minutes, not frames.
 *
 * Two rules stop this being annoying. Leaving must be confirmed across several
 * consecutive checks, because one missed face (you leaned out of frame, someone
 * walked past the lens) is not an absence. Returning is believed immediately,
 * since the cost of being slow to notice you are back is far higher than the
 * cost of a stray reading.
 */
export type PresenceState = "present" | "away" | "unknown";

export interface PresenceEvents {
  changed: [PresenceState, PresenceState];
  left: [];
  returned: [];
  /** Camera worked but the room is too dark to judge. */
  tooDark: [];
}

export interface PresenceOptions {
  /** Seconds between camera checks. */
  intervalSeconds: number;
  /** Consecutive empty readings before you count as away. */
  missesBeforeAway: number;
  /** Pause playing media when you leave. */
  pauseMedia: boolean;
  /** Lock the screen when you leave. */
  lockScreen: boolean;
  /** Wait this long after you leave before locking. */
  lockAfterSeconds: number;
}

export const DEFAULT_PRESENCE: PresenceOptions = {
  intervalSeconds: 30,
  missesBeforeAway: 3, // ~90s of absence before acting
  pauseMedia: true,
  lockScreen: false, // locking is disruptive; opt in deliberately
  lockAfterSeconds: 120,
};

export class PresenceMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private lockTimer: NodeJS.Timeout | null = null;
  private misses = 0;
  private state: PresenceState = "unknown";
  private lastBrightness = 1;
  private pausedByUs = false;

  /**
   * @param read where readings come from. Injectable so the debounce rules —
   * the part that decides whether to lock your screen — can be tested without
   * a camera, which no automated run has access to.
   */
  constructor(
    private opts: PresenceOptions = DEFAULT_PRESENCE,
    private read: () => Promise<vision.Presence> = () => vision.presence()
  ) {
    super();
  }

  get current(): PresenceState {
    return this.state;
  }

  start() {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.opts.intervalSeconds * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.timer = null;
    this.lockTimer = null;
  }

  configure(patch: Partial<PresenceOptions>) {
    this.opts = { ...this.opts, ...patch };
  }

  /** Run a single check now. Exposed for tests and for "can you see me?". */
  async checkOnce() {
    return this.check();
  }

  private async check() {
    const reading = await this.read().catch(() => null);
    if (!reading || reading.error) return; // camera busy or unavailable; say nothing

    this.lastBrightness = (reading as any).brightness ?? 1;

    // A dark room is not an absent user. Treating it as one would lock the
    // screen every time the lights went down.
    if ((reading as any).dark && !reading.present) {
      this.emit("tooDark");
      return;
    }

    if (reading.present) {
      this.misses = 0;
      if (this.state !== "present") this.transition("present");
      return;
    }

    this.misses++;
    if (this.misses >= this.opts.missesBeforeAway && this.state !== "away") {
      this.transition("away");
    }
  }

  private transition(next: PresenceState) {
    const prev = this.state;
    this.state = next;
    this.emit("changed", next, prev);

    if (next === "away") {
      this.emit("left");
      void this.onLeft();
    } else if (next === "present") {
      this.emit("returned");
      if (this.lockTimer) {
        clearTimeout(this.lockTimer);
        this.lockTimer = null;
      }
      void this.onReturned();
    }
  }

  private async onLeft() {
    if (this.opts.pauseMedia) {
      const paused = await pauseAllMedia();
      // Remember whether we were the one who paused, so returning only resumes
      // what we stopped — never something the user deliberately paused earlier.
      this.pausedByUs = paused;
    }
    if (this.opts.lockScreen) {
      this.lockTimer = setTimeout(() => void lockScreen(), this.opts.lockAfterSeconds * 1000);
    }
  }

  private async onReturned() {
    if (this.pausedByUs) {
      this.pausedByUs = false;
      await resumeMedia();
    }
  }

  /** True when the camera last reported nobody at the desk. */
  isAway(): boolean {
    // "unknown" is deliberately not away: a dark room or an unavailable camera
    // must never be read as an empty desk.
    return this.state === "away";
  }

  describe(): string {
    const where =
      this.state === "present" ? "You're at the desk" :
      this.state === "away" ? "You've been away" : "I haven't checked yet";
    const light = this.lastBrightness < 0.06 ? " (the room is very dark)" : "";
    const acting = [
      this.opts.pauseMedia ? "pause media" : null,
      this.opts.lockScreen ? `lock after ${this.opts.lockAfterSeconds}s` : null,
    ].filter(Boolean).join(" and ");
    return `${where}${light}. When you leave I ${acting || "do nothing"}.`;
  }
}

// ---- actions --------------------------------------------------------------

/**
 * Pause whatever is playing. Returns true if anything was actually paused.
 *
 * Each app is asked only if it is already running — launching Music in order to
 * pause it would be absurd — and each is tried independently so one failure
 * does not stop the rest.
 */
export async function pauseAllMedia(): Promise<boolean> {
  let paused = false;

  for (const app of ["Music", "Spotify"]) {
    const running = await osascript(
      `tell application "System Events" to (name of processes) contains "${app}"`
    ).catch(() => "false");
    if (!/true/i.test(running)) continue;
    const state = await osascript(`tell application "${app}" to player state as string`).catch(() => "");
    if (/playing/i.test(state)) {
      await osascript(`tell application "${app}" to pause`).catch(() => "");
      paused = true;
    }
  }

  // Browser video has no scripting interface, so send the media key instead —
  // macOS routes it to whatever is currently playing, including web players.
  if (!paused) {
    const res = await run("/usr/bin/osascript", [
      "-e",
      'tell application "System Events" to key code 16 using {}', // F8 / play-pause
    ]).catch(() => null);
    paused = res?.code === 0;
  }
  return paused;
}

export async function resumeMedia(): Promise<void> {
  for (const app of ["Music", "Spotify"]) {
    const running = await osascript(
      `tell application "System Events" to (name of processes) contains "${app}"`
    ).catch(() => "false");
    if (!/true/i.test(running)) continue;
    const state = await osascript(`tell application "${app}" to player state as string`).catch(() => "");
    if (/paused/i.test(state)) {
      await osascript(`tell application "${app}" to play`).catch(() => "");
      return;
    }
  }
}

/** Lock the screen the way the keyboard shortcut does. */
export async function lockScreen(): Promise<void> {
  // pmset displaysleepnow sleeps the display; whether that locks depends on the
  // "require password after sleep" setting, so ask the login session directly.
  const r = await run("/usr/bin/osascript", [
    "-e",
    'tell application "System Events" to keystroke "q" using {control down, command down}',
  ]).catch(() => null);
  if (r?.code !== 0) {
    await run("/usr/bin/pmset", ["displaysleepnow"]).catch(() => null);
  }
}

export const presenceMonitor = new PresenceMonitor();
