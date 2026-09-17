# Echo silent-stop: code audit findings

Read-only audit, 2026-09-16. Source: `src/agent-replay/` plus the three tapes in
`~/.echo/replays`. No file was modified except the creation of this one.

**Evidence standard:** every finding below names the file and line. Nothing here
was confirmed by running Echo, so each is `CODE-EVIDENT`, not `REPRODUCED`.

---

## What is already solved, and should not be touched

The original root cause is fixed. `loop-log.ts` states it plainly: every way the
loop could end used to emit `turnEnd`, which the recorder wrote as `completed`,
so the evidence always said the run succeeded. The current contract, that every
path out of the loop must name itself, is the right fix.

Also already correct, and worth protecting:

- The stall watchdog forces a real exit rather than only warning (`runtime.ts:703-712`)
- Each recovery attempt gets a fresh `Recorder` and a fresh `runId` (`runtime.ts:665`), so a suppressed `turnEnd` cannot leak into the resumed run
- `beginRun`'s catch emits both `error` and `turnEnd` (`runtime.ts:732-740`), so a failure to start is not silent
- Private mode and the redacted metadata-only trace are handled carefully

The conclusion this leads to is in section 8.

---

## 1. The stall watchdog and the request deadline fire at the same moment

`loop-log.ts:74`

```
export const STALL_AFTER_MS = 120_000;
```

`runtime.ts:355`

```
withDeadline(action, timeoutFromEnv("ECHO_LLM_TIMEOUT_MS", 120_000), "model request")
```

Both are 120000 ms. When a provider hangs, the request deadline and the stall
watchdog become eligible at the same instant, and which one wins is a scheduling
accident.

If the watchdog wins it calls `log.exit("stream_closed")` and `inner.interrupt()`
while `withDeadline` is about to reject the same request. Two terminal paths
race for one run.

**Suggested fix:** the watchdog must be strictly slower than the slowest thing it
watches. Request deadline 120s, stall 180s or more. Assert the ordering in code
so the two cannot be configured back into equality.

---

## 2. `willRetry` is hardcoded false, so replay cannot reproduce retry bugs

`runtime.ts:377`, the live recording path:

```
rec.emit({ type: "llm.error", reqId, message: err.message, stack: err.stack, willRetry: false });
```

`willRetry` is never computed. It is the literal `false` on every recorded error.

`runtime.ts:334`, the replay path, then trusts it:

```
willRetry: Boolean(exchange.errorEvent.willRetry),
```

Confirmed in a real tape. In `~/.echo/replays/fdaa93f8-.../events.jsonl`:

```
seq 5  llm.error    503 high demand   willRetry: False
seq 6  llm.request  attempt: 1          <- it retried anyway
seq 7  llm.response complete
```

The recorder said it would not retry, then retried.

**Why this matters more than it looks.** The recovery path is the most complex
code in the runtime, so it is where a silent stop is most likely to live. It is
also the one path the deterministic replay cannot faithfully reproduce, because
the tape asserts a retry decision that was never true. The debugger has a blind
spot exactly over the suspect.

**Suggested fix:** pass the real decision into `recordLLM`, or remove the field.
A field that is always false is worse than no field, because the replay believes it.

---

## 3. The recovery timer does not hold the process open

`runtime.ts:618-624`

```
this.recoveryTimer = setTimeout(() => {
  this.recoveryTimer = null;
  this.beginRun(recoveryPrompt(checkpoint), checkpoint);
}, delay);
this.recoveryTimer.unref?.();
```

`unref()` means this timer will not keep the Node event loop alive. If nothing
else is holding the loop open when the delay elapses, the process exits and the
scheduled recovery never runs.

The user has already been told `"stopped before finishing, so I'm continuing from
its checkpoint"` at `runtime.ts:616`. Then nothing. That is a silent stop
produced by the recovery mechanism itself.

In the Electron main process something else usually holds the loop open, which is
probably why this has not been obvious. It would bite in a headless run, a
detached worker, or a rehearsal actor.

**Suggested fix:** do not unref the recovery timer, or record a
`recovery.scheduled` event and assert on the next start that every scheduled
recovery either fired or was cancelled.

---

## 4. Cancelling during the recovery delay is silently ignored

`runtime.ts:608` calls `this.cleanup(context)` **before** scheduling the timer.
`cleanup` sets `this.context = null`.

During the delay, `interrupt()` and `stop()` run
`context?.loop.exit("abort_signal", ...)` (`runtime.ts:854`, `runtime.ts:866`)
against a null context. The optional chain makes this a no-op.

So a user who cancels during the recovery window is ignored, and the recovery
fires afterwards and resumes the task they cancelled.

For a desktop agent with 100+ tool schemas and real machine access, a silent
*continue* is a worse failure than a silent stop.

**Suggested fix:** track a pending recovery independently of `context`. An
interrupt during the delay must clear `recoveryTimer`, mark the checkpoint
cancelled, and emit a terminal event.

---

## 5. Every recorded tape contains an `llm.request` that never resolves

All three tapes show the same shape. Taking `b0c5b135`:

```
seq 1  iteration.start  messagesHash a4fc02be...
seq 2  llm.request      reqId 75987ffd  bodyHash a4fc02be...   <- never resolves
seq 4  llm.request      reqId 6be015a0  bodyHash e845e1a9...
seq 5  llm.response     reqId 6be015a0
```

The sequence-2 request has neither an `llm.response` nor an `llm.error`. Its body
hash equals the iteration's messages blob, and that blob is 11 bytes, while the
real request body is 71 KB. The same pattern appears in `c025f040` (reqId
`15c84880`) and `fdaa93f8` (reqId `68f95581`).

Only `recordLLM` emits `llm.request` (`runtime.ts:326` replay, `runtime.ts:361`
live), and the only production callers are `brain/gemini.ts:362` and
`brain/ollama.ts:103`. So a third caller is passing a small object as `request`,
or these tapes came from a harness rather than a real session.

**Open question for the author.** Whatever the cause, the consequence is fixed:
"an `llm.request` with no terminal event" is precisely the signature of an
abandoned call, and it currently appears in 100% of clean runs. The tape has a
permanent false positive for the exact pattern being hunted.

**Suggested fix:** add a `seam` or `speculative` field so expected orphans are
labelled, and add an end-of-run assertion that every unlabelled `reqId` has a
terminal event.

---

## 6. `pendingError` is one slot with two conflicting precedence rules

`runtime.ts:535` overwrites: `this.pendingError = String(args[0] ?? ...)`

`runtime.ts:636` keeps the first: `this.pendingError = this.pendingError ?? message`

Two code paths, two opposite rules, one field. With more than one error in a run,
which one the user finally sees depends on the order the paths happened to run.

**Suggested fix:** keep a list, surface the first and the last, and record the count.

---

## 7. The replay system has never recorded a failure

`~/.echo/replays` holds three runs, all from 10 September, all
`coverage: inspection`, all `provider: gemini`, all `ok: true`. Not one contains
a `tool.*` event, so tool execution, the largest surface in Echo, has zero replay
coverage. Every response carries `usage: {}` and every run carries
`codeVersion: "unknown"`, so no tape can be tied to a build or a cost.

The instrument built to catch the silent stop has never observed one.

**Suggested fix, and it is the cheapest item here:** turn on full coverage, run
Echo normally until it stops, and keep the tape. Populate `codeVersion` from the
build so tapes are comparable across changes.

---

## 8. On integrating AgentOS

Before reading this code I suggested wiring AgentOS into Echo to trace the bug.
Having read it: that is the wrong call, and I withdraw it.

`loop-log.ts` is a more disciplined black box than AgentOS currently has. It has
a named reason for every exit, an incomplete-exit classification, a stall
watchdog that forces termination, checkpointed recovery, and fsync ordering
guarantees around `run.end`. AgentOS does not yet do most of that, and its own
recent audit scored it 3.4 out of 10.

Adding AgentOS underneath Echo would add layers to an unexplained failure and
make it harder to find, not easier.

**The influence should run the other way.** The `loop-log.ts` exit contract is
the single best piece of engineering in this portfolio and AgentOS should adopt it.

---

## Suggested order

1. Turn on full replay coverage and capture one real failure (section 7)
2. Separate the stall timeout from the request deadline (section 1)
3. Fix or delete `willRetry` (section 2)
4. Label or fix the orphaned `llm.request` (section 5)
5. Handle cancel during the recovery window (section 4)
6. Un-unref the recovery timer (section 3)
7. Make `pendingError` a list (section 6)

Items 2, 3 and 6 are a few lines each. Item 1 is a config change. None of them
is a rewrite.
