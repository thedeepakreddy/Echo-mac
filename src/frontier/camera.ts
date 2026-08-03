import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { getAppPath } from "../utils/appPath.js";

const run = promisify(execFile);

/**
 * Makes sure nothing is left holding the camera.
 *
 * The camera helpers are separate processes. If Jarvis exits without stopping
 * them — a crash, a force-quit, or a shutdown path that forgot — they are
 * reparented to launchd and keep running: the camera stays open and its green
 * light stays on with nothing visibly using it. Seen in the wild: a handtracker
 * orphaned for seven minutes after its parent died.
 *
 * Two defences, because either alone leaves a gap:
 *   - release on the way out, for the ordinary case
 *   - reap on the way in, for when the way out never ran
 *
 * NOT implemented with `pkill -f <path>`, which was the obvious approach and is
 * quietly wrong: -f matches any process whose command line merely CONTAINS the
 * string, so it hits shells and editors that happen to mention the path, exits
 * 0 having killed one of those, and leaves the real helper running. It reported
 * success while the camera stayed on. Matching the executable name exactly and
 * then verifying the path is what actually works.
 */

const HELPERS = ["handtracker", "facetracker", "sonar", "visionhelper"];

function helperPath(name: string): string {
  return join(getAppPath(), "native", name);
}

/** PIDs whose executable really is our helper — not merely a mention of it. */
async function findHelperPids(name: string): Promise<number[]> {
  let out = "";
  try {
    // -x matches the process NAME exactly, so a shell that references the path
    // in its arguments is never selected.
    ({ stdout: out } = await run("/usr/bin/pgrep", ["-x", name]));
  } catch {
    return []; // pgrep exits non-zero when nothing matches
  }

  const pids = out.split("\n").map((l) => parseInt(l.trim(), 10)).filter(Number.isFinite);
  const wanted = helperPath(name);
  const mine: number[] = [];

  for (const pid of pids) {
    try {
      const { stdout: cmd } = await run("/bin/ps", ["-o", "command=", "-p", String(pid)]);
      // Confirm it is OUR binary and not something else with the same name.
      if (cmd.trim().startsWith(wanted)) mine.push(pid);
    } catch {
      /* process vanished between listing and inspecting */
    }
  }
  return mine;
}

/** Stop every camera helper belonging to this install. Returns how many. */
export async function releaseCamera(reason: string): Promise<number> {
  let stopped = 0;
  for (const name of HELPERS) {
    for (const pid of await findHelperPids(name)) {
      try {
        process.kill(pid, "SIGTERM");
        stopped++;
      } catch {
        /* already gone */
      }
    }
  }

  if (stopped) {
    // Give them a moment to exit, then insist. A helper stuck in a capture
    // callback would otherwise keep the camera despite the polite request.
    await new Promise((r) => setTimeout(r, 400));
    for (const name of HELPERS) {
      for (const pid of await findHelperPids(name)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    console.log(`[jarvis] released the camera — stopped ${stopped} helper(s) (${reason})`);
  }
  return stopped;
}

/**
 * Same, synchronously. Electron's will-quit does not await promises, so an
 * async cleanup there simply never finishes and the camera stays on.
 */
export function releaseCameraSync(reason: string): number {
  let stopped = 0;
  for (const name of HELPERS) {
    const wanted = helperPath(name);
    let out = "";
    try {
      out = execFileSync("/usr/bin/pgrep", ["-x", name], { encoding: "utf8", timeout: 2000 });
    } catch {
      continue; // nothing running under that name
    }
    for (const line of out.split("\n")) {
      const pid = parseInt(line.trim(), 10);
      if (!Number.isFinite(pid)) continue;
      try {
        const cmd = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
          encoding: "utf8",
          timeout: 2000,
        });
        if (!cmd.trim().startsWith(wanted)) continue;
        // No time to be polite on the way out; the camera must be freed now.
        process.kill(pid, "SIGKILL");
        stopped++;
      } catch {
        /* gone, or not ours */
      }
    }
  }
  if (stopped) console.log(`[jarvis] released the camera — stopped ${stopped} helper(s) (${reason})`);
  return stopped;
}
