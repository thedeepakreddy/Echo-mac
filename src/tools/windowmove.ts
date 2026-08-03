import { createRequire } from "node:module";
import { osascript } from "./shell.js";
import type { Display } from "./displays.js";

const nodeRequire = createRequire(import.meta.url);

/**
 * Moving the front window to another screen.
 *
 * Two details decide whether this feels right:
 *
 *   - Place into the display's WORK AREA, not its full bounds. The full bounds
 *     include the menu bar and the Dock, so a window positioned there has its
 *     title bar tucked under the menu bar and cannot be dragged.
 *   - "Full screen it" here means filling that display, not macOS's green
 *     button. Native fullscreen moves the window to its own Space, which hides
 *     everything else and is almost never what someone means when they are
 *     arranging two monitors.
 */

/** The usable rectangle of a display, excluding menu bar and Dock. */
export function workAreaFor(target: Display): { x: number; y: number; width: number; height: number } {
  try {
    const screen = nodeRequire("electron")?.screen;
    const match = screen?.getAllDisplays?.()?.find(
      (d: any) => d.bounds.x === target.x && d.bounds.y === target.y
    );
    if (match?.workArea) return match.workArea;
  } catch {
    /* outside the Electron main process; fall through */
  }
  // Without Electron, inset the top by a menu-bar's height so the title bar
  // stays reachable. Better a slightly small window than an undraggable one.
  return { x: target.x, y: target.y + 25, width: target.width, height: target.height - 25 };
}

/** Window frame to use on the target display. */
export function frameFor(target: Display, fill: boolean): { x: number; y: number; w: number; h: number } {
  const area = workAreaFor(target);
  if (fill) return { x: area.x, y: area.y, w: area.width, h: area.height };
  // Otherwise keep it comfortable and centred rather than edge to edge.
  const w = Math.round(area.width * 0.8);
  const h = Math.round(area.height * 0.85);
  return {
    x: Math.round(area.x + (area.width - w) / 2),
    y: Math.round(area.y + (area.height - h) / 2),
    w,
    h,
  };
}

export async function moveFrontWindowTo(target: Display, fill: boolean): Promise<string> {
  const f = frameFor(target, fill);
  const script = `
    tell application "System Events"
      set frontApp to first application process whose frontmost is true
      set appName to name of frontApp
      if (count of windows of frontApp) is 0 then return "no-window"
      set win to first window of frontApp
      set position of win to {${f.x}, ${f.y}}
      set size of win to {${f.w}, ${f.h}}
      return appName
    end tell`;

  const res = await osascript(script).catch((e: any) => `error:${e?.message ?? e}`);
  const out = String(res).trim();

  if (out === "no-window") return "That app has no window I can move.";
  if (out.startsWith("error:")) {
    return `I couldn't move the window — ${out.slice(6)}. This needs Accessibility permission for Jarvis.`;
  }
  const where = fill ? "and filled the screen" : "";
  return `Moved ${out} to display ${target.index + 1} ${where}`.trim() + ".";
}
