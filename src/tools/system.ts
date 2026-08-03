import { run, osascript } from "./shell.js";

/**
 * Bridges to the rest of macOS: Apple Shortcuts and Calendar.
 *
 * The Shortcuts app is the single biggest capability multiplier available —
 * one `shortcuts run <name>` reaches HomeKit (lights, locks, thermostat),
 * Messages, Reminders, Notes, Focus modes, and anything else the user has built.
 * Rather than reimplement each integration, Jarvis drives the shortcuts the user
 * already has.
 */

export async function listShortcuts(): Promise<string[]> {
  const { stdout, code } = await run("/usr/bin/shortcuts", ["list"]);
  if (code !== 0) return [];
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Run a Shortcut by name, optionally with text input. Returns its output. */
export async function runShortcut(name: string, input?: string): Promise<{ ok: boolean; output: string }> {
  const args = ["run", name];
  if (input) args.push("--input-path", "-");
  const res = await run("/usr/bin/shortcuts", args, 60000);
  const ok = res.code === 0;
  return {
    ok,
    output: ok ? res.stdout.trim() || `Ran shortcut "${name}".` : res.stderr.trim() || `Shortcut "${name}" failed.`,
  };
}

/**
 * Match a spoken request to an installed shortcut. Exact name first, then a
 * loose word-overlap so "turn on the lights" finds a "Lights On" shortcut.
 */
export async function findShortcut(query: string): Promise<string | null> {
  const shortcuts = await listShortcuts();
  if (!shortcuts.length) return null;
  const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim();

  const exact = shortcuts.find((s) => s.toLowerCase() === q);
  if (exact) return exact;

  const qWords = new Set(q.split(/\s+/).filter((w) => w.length > 2));
  let best: { name: string; score: number } | null = null;
  for (const s of shortcuts) {
    const sWords = s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/);
    let score = 0;
    for (const w of sWords) if (qWords.has(w)) score++;
    if (score && (!best || score > best.score)) best = { name: s, score };
  }
  return best?.name ?? null;
}

// ---- Calendar ------------------------------------------------------------

export interface CalEvent {
  title: string;
  start: string;
  minutesAway: number;
}

/**
 * Upcoming events in the next `hoursAhead` hours via AppleScript. Calendar's
 * scripting is slow, so this asks only for a narrow window.
 */
export async function upcomingEvents(hoursAhead = 12): Promise<CalEvent[]> {
  const script = `
    set output to ""
    set now to current date
    set laterDate to now + (${hoursAhead} * hours)
    tell application "Calendar"
      repeat with cal in calendars
        repeat with e in (every event of cal whose start date is greater than now and start date is less than laterDate)
          set output to output & (summary of e) & "|||" & ((start date of e) as string) & "\n"
        end repeat
      end repeat
    end tell
    return output`;
  let raw = "";
  try {
    raw = await osascript(script);
  } catch {
    return [];
  }
  const now = Date.now();
  const events: CalEvent[] = [];
  for (const line of raw.split("\n")) {
    const [title, startStr] = line.split("|||");
    if (!title || !startStr) continue;
    const start = new Date(startStr).getTime();
    if (Number.isNaN(start)) continue;
    events.push({
      title: title.trim(),
      start: startStr.trim(),
      minutesAway: Math.round((start - now) / 60000),
    });
  }
  return events.sort((a, b) => a.minutesAway - b.minutesAway);
}

export function describeEvents(events: CalEvent[]): string {
  if (!events.length) return "Nothing on your calendar in the next several hours.";
  return events
    .slice(0, 6)
    .map((e) => {
      const when =
        e.minutesAway < 60
          ? `in ${e.minutesAway} min`
          : `in ${Math.round(e.minutesAway / 60)}h`;
      return `${e.title} — ${when}`;
    })
    .join("; ");
}
