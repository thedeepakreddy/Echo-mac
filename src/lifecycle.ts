/**
 * One shutdown routine, reachable from anywhere.
 *
 * The app can exit from more than one place — the will-quit handler, the spoken
 * "switch your brain" intercept in main.ts, and the switch_brain tool in the
 * registry. `app.exit()` force-terminates without firing will-quit, so each of
 * those paths has to release resources itself or it orphans the spawned `say`
 * process and the whisper server.
 *
 * main.ts owns the actual teardown (it holds the listener, brain and TTS); this
 * module just hands other files a way to trigger it without importing main.ts
 * and creating a cycle.
 */
type ShutdownFn = () => void;

let handler: ShutdownFn | null = null;

export function setShutdownHandler(fn: ShutdownFn): void {
  handler = fn;
}

export function runShutdown(): void {
  try {
    handler?.();
  } catch (err) {
    console.error("[jarvis] shutdown failed:", err);
  }
}
