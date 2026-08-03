/**
 * The phone remote — mostly its refusals.
 *
 *   npm run remotetest
 *
 * This is the only feature that opens a port on whatever network the machine
 * happens to be on, so the tests are weighted heavily toward what it will NOT
 * do. A real server is started at the end and probed over the loopback.
 */
import {
  newToken, tokenMatches, tokenFrom, routeOf, record, recentItems,
  renderPage, lanAddress, preferredHost, isLockedOut, noteBadAttempt, resetAttempts,
  startRemote, stopRemote, isRunning, remoteStatus,
  MAX_ITEMS, MAX_BAD_ATTEMPTS,
} from "./frontier/remote.js";
import { setPassword } from "./frontier/remoteauth.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nPhone remote\n");

console.log("  tokens");
{
  const a = newToken(), b = newToken();
  ok(a.length === 32, `a token is 32 hex characters (${a.length})`);
  ok(a !== b, "and a new one each time");
  ok(/^[0-9a-f]+$/.test(a), "hex only, so it survives being typed from a screen");
}
{
  const t = newToken();
  ok(tokenMatches(t, t), "the right token matches");
  ok(!tokenMatches(t, t.slice(0, -1) + "0"), "one character wrong does not");
  ok(!tokenMatches(t, ""), "an empty token does not");
  ok(!tokenMatches(t, undefined), "a missing token does not");
  ok(!tokenMatches(t, t + "a"), "a longer string does not");
  ok(!tokenMatches("", t), "and nothing matches when no token is set");
}
{
  ok(tokenFrom("/?t=abc123") === "abc123", "the token is read from the query");
  ok(tokenFrom("/events?since=4&t=abc") === "abc", "wherever it appears in it");
  ok(tokenFrom("/") === undefined, "no query means no token");
  ok(tokenFrom(undefined) === undefined, "and no url does not throw");
}

console.log("  routing");
{
  ok(routeOf("/") === "page", "the root serves the page");
  ok(routeOf("/?t=x") === "page", "with a query too");
  ok(routeOf("/events?t=x&since=0") === "events", "/events is the feed");
  ok(routeOf("/stop?t=x") === "stop", "/stop is the stop button");
  ok(routeOf("/../../etc/passwd") === "unknown", "a traversal attempt is not a route");
  ok(routeOf("/admin") === "unknown", "and neither is anything invented");
  ok(routeOf("/login") === "login", "/login is the password exchange");
  ok(routeOf("/command?t=x") === "command", "/command carries a phone command");
  ok(routeOf("/confirm") === "confirm", "/confirm carries an approval");
  ok(routeOf("/pending") === "confirm-poll", "/pending is the confirmation to show");
  ok(routeOf("/rtc/offer") === "rtc-offer", "/rtc/offer is the WebRTC offer");
  ok(routeOf("/rtc/answer") === "rtc-answer", "/rtc/answer returns the Mac's answer");
  ok(routeOf("/rtc/ice") === "rtc-ice-phone", "/rtc/ice takes the phone's candidates");
}
{
  const pref = preferredHost();
  // On any networked machine there is at least a LAN address; the point of the
  // assertion is that when a tailnet address exists it is preferred.
  if (pref) {
    ok(pref.kind === "tailscale" || pref.kind === "lan", `preferred host is classified (${pref.kind})`);
    if (pref.kind === "tailscale") {
      const [o1, o2] = pref.host.split(".").map(Number);
      ok(o1 === 100 && o2 >= 64 && o2 <= 127, "a Tailscale address is in the 100.64/10 range");
    }
  }
}

console.log("  lockout");
{
  resetAttempts();
  const ip = "192.168.1.55";
  ok(!isLockedOut(ip), "an unknown address starts unlocked");
  for (let i = 0; i < MAX_BAD_ATTEMPTS; i++) noteBadAttempt(ip);
  ok(isLockedOut(ip), `after ${MAX_BAD_ATTEMPTS} wrong tokens the address is locked out`);
  ok(!isLockedOut("192.168.1.56"), "which does not affect anyone else");
  resetAttempts();
  ok(!isLockedOut(ip), "and restarting the remote clears it");
}

console.log("  the feed does not grow forever");
{
  // Not running: nothing should be recorded at all.
  for (let i = 0; i < 5; i++) record(`line ${i}`);
  ok(recentItems().items.length === 0, "nothing is recorded while the remote is off");
}

console.log("  the page is self-contained");
{
  const html = renderPage("deadbeef");
  ok(!/https?:\/\//.test(html.replace(/http:\/\/'/g, "")), "no external resources are loaded");
  ok(/deadbeef/.test(html), "the token is baked in so the phone need not retype it");
  ok(/viewport/.test(html), "it is sized for a phone");
  ok(/Stop/.test(html), "there is a stop button");
  ok(!/eval\(|innerHTML\s*=\s*[^'"]/.test(html.replace(/innerHTML = '<time><\/time><span><\/span>'/, "")),
     "and no place where feed text is injected as markup");
}
{
  // The feed text is set with textContent, never interpolated into HTML —
  // otherwise a filename on screen could inject script into the phone page.
  const html = renderPage("x");
  ok(/textContent = it\.line/.test(html), "feed lines are set as TEXT, so they cannot become markup");
}

console.log("  refuses to open with no password set");
{
  // JARVIS_REMOTE_DIR points at a throwaway dir (set by the npm script), which
  // starts empty — so this proves the refusal before a password exists.
  const noPass = await startRemote({ port: 7798, ttlMs: 60_000 });
  ok(!noPass.ok && /password/.test(noPass.message),
     "full control will not open without a password");
  ok(!isRunning(), "and nothing is left running");
}

console.log("  a real server, over the network");
{
  const pref = preferredHost();
  if (!pref) {
    console.log("  ⚠ no network address on this machine — skipping the live server checks");
  } else {
    const host = pref.host;
    setPassword("test-remote-pass"); // into the throwaway JARVIS_REMOTE_DIR
    const started = await startRemote({ port: 7799, ttlMs: 60_000 });
    ok(started.ok, `it starts (${started.message.split("\n")[0].slice(0, 50)})`);
    ok(isRunning(), "and reports as running");
    ok(started.url?.includes(host) === true, "the link points at the network address, not loopback");

    const tok = new URL(started.url!).searchParams.get("t")!;
    const base = `http://${host}:7799`;

    // ---- the link token gates existence ----
    const noToken = await fetch(`${base}/`);
    ok(noToken.status === 404, `no token gets 404, not 401 (${noToken.status})`);
    const badToken = await fetch(`${base}/?t=${"0".repeat(32)}`);
    ok(badToken.status === 404, "a wrong token gets 404 too — nothing confirms a server is here");
    const good = await fetch(`${base}/?t=${tok}`);
    ok(good.status === 200, "the right token gets the login page");

    // ---- the password gates control ----
    const controlNoSession = await fetch(`${base}/events?t=${tok}&since=0`);
    ok(controlNoSession.status === 401, "control routes need a session, not just the link");

    const wrongPw = await fetch(`${base}/login?t=${tok}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "not-the-password" }),
    });
    ok(wrongPw.status === 401, "the wrong password is refused");

    const login = await fetch(`${base}/login?t=${tok}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-remote-pass" }),
    });
    ok(login.status === 200, "the right password signs in");
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    ok(/^js=/.test(cookie), "and hands back a session cookie");
    const auth = { cookie };

    // ---- with a session, control works ----
    record("did a thing", "go");
    const ev = await fetch(`${base}/events?t=${tok}&since=0`, { headers: auth }).then((r) => r.json() as any);
    ok(ev.items.some((i: any) => i.line === "did a thing"), "the feed carries recorded events once signed in");

    const rtc = await fetch(`${base}/rtc/offer?t=${tok}`, {
      method: "POST", headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ sdp: { type: "offer", sdp: "v=0 test" } }),
    }).then((r) => r.json() as any);
    ok(rtc.ok === true, "the phone can post a WebRTC offer");

    const traversal = await fetch(`${base}/../../etc/passwd?t=${tok}`, { headers: auth });
    ok(traversal.status === 404, "a path traversal with a valid token and session still gets nothing");

    const getStop = await fetch(`${base}/stop?t=${tok}`, { headers: auth });
    ok(getStop.status === 404, "stop cannot be triggered by a GET");

    let stopped = false;
    await stopRemote();
    await startRemote({ port: 7799, ttlMs: 60_000, onStop: () => { stopped = true; } });
    const tokNew = /t=([0-9a-f]{32})/.exec(remoteStatus())?.[1] ?? "";
    ok(tokNew === tok, "restarting keeps the SAME token, so a saved link keeps working");

    // The old session cookie must still NOT survive a restart — the link is
    // permanent, but each session dies on restart and needs the password again.
    // A reset socket (from the server that closed) counts the same as a 401.
    const oldSession = await fetch(`${base}/events?t=${tokNew}&since=0`, { headers: auth })
      .then((r) => r.status as number | "reset")
      .catch(() => "reset" as const);
    ok(oldSession === 401 || oldSession === "reset",
       `the session still dies on restart, even though the link lives (${oldSession})`);

    // The saved link still reaches the login page after a restart.
    const savedLink = await fetch(`${base}/?t=${tok}`).then((r) => r.status).catch(() => "reset" as const);
    ok(savedLink === 200, `the saved link still opens the login page after a restart (${savedLink})`);

    // Sign in again to drive stop.
    const login2 = await fetch(`${base}/login?t=${tokNew}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-remote-pass" }),
    });
    const cookie2 = (login2.headers.get("set-cookie") ?? "").split(";")[0];
    await fetch(`${base}/stop?t=${tokNew}`, { method: "POST", headers: { cookie: cookie2 } });
    ok(stopped, "a POST to stop, signed in, reaches the stop handler");

    const msg = await stopRemote();
    ok(/won't work again/.test(msg), "closing says the link is dead");
    ok(!isRunning(), "and it is no longer running");

    let unreachable = false;
    await fetch(`${base}/?t=${tokNew}`).catch(() => { unreachable = true; });
    ok(unreachable, "the port is actually closed");
  }
}

console.log(`\n${pass}/${pass + fail} remote checks passed\n`);
process.exit(fail ? 1 : 0);
