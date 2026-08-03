/**
 * Lets non-UI code change how the reactor looks.
 *
 * The presence monitor and the away-mode tool both need to dim the HUD, but
 * neither should import Electron or reach into the window — that coupling is
 * what makes modules untestable outside the app. They publish here instead, and
 * main.ts subscribes.
 */
type Listener = (patch: Record<string, unknown>) => void;

let listener: Listener | null = null;

/** main.ts registers the real sender at startup. */
export function onHudState(fn: Listener) {
  listener = fn;
}

export function sendHudState(patch: Record<string, unknown>) {
  listener?.(patch);
}

/** Away mode armed or disarmed — the reactor shows this even before you leave. */
export function setAwayMode(on: boolean) {
  sendHudState({ awayMode: on, ...(on ? {} : { away: false }) });
}

/** You have actually left, or come back. */
export function setAway(away: boolean) {
  sendHudState({ away });
}
