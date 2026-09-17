# Echo — SILENT STOP REMEDIATION

Repository:

```
/Users/thedeepakreddy/J.A.R.V.I.S/Echo Mac
```

Echo halts mid-task without reporting failure. The original root cause (every
loop exit emitting `turnEnd`, recorded as `completed`) was already fixed by the
exit contract in `src/agent-replay/loop-log.ts`. This task fixes the remaining
paths that can still end a run in silence, and repairs the instrumentation that
is currently unable to see them.

A read-only audit with full evidence is at `docs/SILENT_STOP_FINDINGS.md`. Read
it first.

---

## SCOPE AND LIMITS

DO:

- Work on a branch: `git checkout -b fix/silent-stop`
- Make each fix a separate commit
- Add a test for every fix, in the existing `src/_*test.ts` harnesses
- Keep changes minimal and local

DO NOT:

- Change the `loop-log.ts` exit contract. Every path out of the loop must still
  name itself. That design is correct and is not in scope
- Refactor anything not named below
- Add, remove or reorder tool schemas
- Touch `.env`, `config.json` secrets, or print any key material
- Modify any other repository (ToolOS, AgentOS, ResearchOS, EvalOS, cosmos)
- Integrate any external OS or service
- Push to `origin` unless asked

## EVIDENCE STANDARD

Use `VERIFIED`, `PARTIALLY_VERIFIED`, `NOT_REPRODUCED`, `NOT_FOUND`, `FAILED`.

A fix is `VERIFIED` only when a test fails without it and passes with it.
Demonstrate that for every fix. **No evidence = not fixed.**

---

## TASK 0 — BASELINE

Record before changing anything:

```
git status --short | wc -l        # expected: ~134 modified files already present
git log --oneline -2
npm run typecheck
npm run check
npm run exittest
npm run recoverytest
npm run replaytest
```

Report each command's exit code and output summary. If a gate already fails on
the current tree, record that as pre-existing and do not attempt to fix it as
part of this task.

The working tree is already dirty. Do not stash or revert existing changes.
Report what is already modified so your commits can be distinguished from it.

---

## FIX 1 — The stall watchdog and the request deadline are equal

**Status: VERIFIED defect.**

`src/agent-replay/loop-log.ts:74`

```ts
export const STALL_AFTER_MS = 120_000;
```

`src/agent-replay/runtime.ts:354`

```ts
const run = () => withDeadline(action, timeoutFromEnv("ECHO_LLM_TIMEOUT_MS", 120_000), "model request");
```

Both are 120000 ms. When a provider hangs, the request deadline and the stall
watchdog become eligible in the same tick, and which fires first is a scheduling
accident. The watchdog calls `log.exit("stream_closed")` and `inner.interrupt()`
while `withDeadline` is about to reject the same request. Two terminal paths race
for one run.

**Change:** the watchdog must be strictly slower than the slowest operation it
watches.

- Derive `STALL_AFTER_MS` from the request deadline rather than hardcoding it,
  or set it to a value with clear headroom (180000 suggested)
- Add a startup assertion or a clamped accessor so the stall interval can never
  be configured less than or equal to the request deadline
- If the request deadline is configurable via `ECHO_LLM_TIMEOUT_MS`, the stall
  interval must track it

**Test:** in `_exittest.ts`, add a case with a provider that never resolves.
Assert exactly one `loop.exit` is written, that its reason is the request
deadline path and not `stream_closed`, and that no second terminal event follows.

---

## FIX 2 — `willRetry` is hardcoded false

**Status: VERIFIED defect, reproducible from an existing tape.**

`src/agent-replay/runtime.ts:377`, live recording path:

```ts
rec.emit({ type: "llm.error", reqId, message: err.message, stack: err.stack, willRetry: false });
```

The value is never computed. `src/agent-replay/runtime.ts:334`, the replay path,
then trusts it:

```ts
willRetry: Boolean(exchange.errorEvent.willRetry),
```

Proof in `~/.echo/replays/fdaa93f8-c572-45ff-8fdc-44320fdb331f/events.jsonl`:

```
seq 5  llm.error    503 high demand   willRetry: false
seq 6  llm.request  attempt: 1          <- retried anyway
seq 7  llm.response complete
```

Consequence: deterministic replay cannot faithfully reproduce any retry-dependent
behaviour, and recovery is the most complex path in the runtime. The debugger is
blind exactly where the bug is most likely to be.

**Change, pick one and justify it:**

- (a) Plumb the real decision into `recordLLM`. Callers at
  `src/brain/gemini.ts:362` and `src/brain/ollama.ts:103` know their retry policy
- (b) Remove the field entirely from both the emit and the replay read

Prefer (a) if the retry decision is knowable at the error site. A field that is
always false is worse than no field, because the replay believes it.

**Test:** in `_replaytest.ts`, record a run where a retryable provider error is
followed by a successful retry. Assert the recorded `willRetry` matches what
actually happened, and that replaying the tape reproduces the retry.

---

## FIX 3 — The recovery timer does not hold the process open

**Status: VERIFIED defect. Impact depends on host, so confirm before and after.**

`src/agent-replay/runtime.ts:618-624`

```ts
this.recoveryTimer = setTimeout(() => {
  this.recoveryTimer = null;
  this.beginRun(recoveryPrompt(checkpoint), checkpoint);
}, delay);
this.recoveryTimer.unref?.();
```

`unref()` means this timer will not keep the Node event loop alive. If nothing
else holds it open when the delay elapses, the process exits and the scheduled
recovery never runs. The user has already been told at line 616 that the task is
continuing from its checkpoint. Then nothing.

**Change:** remove the `unref()`, or keep it and emit a `recovery.scheduled`
event plus an assertion on the next start that every scheduled recovery either
fired or was explicitly cancelled. State which you chose and why.

**Test:** in `_recoverytest.ts`, run the recovery path in a bare node process
with no other handles open. Assert the recovery actually fires.

---

## FIX 4 — Cancelling during the recovery delay is silently ignored

**Status: VERIFIED defect. Highest user-visible severity.**

`src/agent-replay/runtime.ts:608` calls `this.cleanup(context)` before scheduling
the recovery timer. `cleanup` sets `this.context = null`.

During the delay, `interrupt()` at line 854 and `stop()` at line 866 both run:

```ts
context?.loop.exit("abort_signal", { detail: "user interrupted" });
```

against a null context. The optional chain makes this a silent no-op. The
recovery then fires and resumes the task the user cancelled.

For a desktop agent with 100+ tool schemas and real machine access, a silent
**continue** is a worse failure than a silent stop.

**Change:**

- Track the pending recovery independently of `context`
- `interrupt()` and `stop()` during the delay must clear `recoveryTimer`, mark
  the checkpoint `cancelled`, and emit a terminal event
- The user must see that the cancel took effect

**Test:** in `_recoverytest.ts`, trigger a recoverable exit, call `interrupt()`
during the delay window, and assert no new run begins and a terminal event is
emitted.

---

## FIX 5 — `pendingError` is one slot with two conflicting rules

**Status: VERIFIED defect.**

`src/agent-replay/runtime.ts:419` declares `private pendingError: string | null`.

Line 535 overwrites:

```ts
this.pendingError = String(args[0] ?? "Unknown brain error");
```

Line 636 keeps the first:

```ts
this.pendingError = this.pendingError ?? message;
```

Two paths, opposite precedence, one field. With more than one error in a run,
which one the user sees depends on execution order.

**Change:** keep an ordered list. Surface the first and the last, and record the
count. Update `emitTerminal` (lines 556-565) accordingly.

**Test:** in `_exittest.ts`, drive two distinct errors into one run and assert
both are represented in the terminal output.

---

## FIX 6 — Unpaired `llm.request` in every recorded tape

**Status: NOT_REPRODUCED. Investigate before changing anything.**

All three tapes in `~/.echo/replays` show the same shape. Taking `b0c5b135`:

```
seq 1  iteration.start  messagesHash a4fc02be...
seq 2  llm.request      reqId 75987ffd  bodyHash a4fc02be...   <- never resolves
seq 4  llm.request      reqId 6be015a0  bodyHash e845e1a9...
seq 5  llm.response     reqId 6be015a0
```

The sequence-2 request gets neither `llm.response` nor `llm.error`. Its body hash
equals the iteration's messages blob (11 bytes), while the real request body is
71 KB. Identical pattern in `c025f040` (reqId `15c84880`) and `fdaa93f8` (reqId
`68f95581`).

Only `recordLLM` emits `llm.request` (runtime.ts:326 replay, runtime.ts:361
live). The only production callers are `src/brain/gemini.ts:362` and
`src/brain/ollama.ts:103`.

**Step 1, investigate and report before changing code.** Identify what emits the
sequence-2 request. Candidates: a third `recordLLM` caller, `src/brain/prefetch.ts`,
or these tapes came from a test harness rather than a real session. Say which,
with evidence.

**Step 2, then fix.** Whatever the cause, the consequence is fixed: "an
`llm.request` with no terminal event" is exactly the signature of an abandoned
call, and it currently appears in 100% of clean runs. The tape has a permanent
false positive for the pattern being hunted.

- Add a `seam` or `speculative` field so expected orphans are labelled
- Add an end-of-run assertion that every unlabelled `reqId` has a terminal event

**Test:** in `_replaytest.ts`, assert a clean run contains zero unlabelled
unpaired `llm.request` events.

---

## FIX 7 — The replay system has never recorded a failure

**Status: VERIFIED gap. Cheapest item here, and the most valuable.**

`~/.echo/replays` contains three runs, all from 10 September, all
`coverage: inspection`, all `provider: gemini`, all `ok: true`. Not one contains a
`tool.*` event, so tool execution has zero replay coverage. Every response
carries `usage: {}`. Every run carries `codeVersion: "unknown"`.

**Investigate and report:**

1. What sets `coverage: "inspection"` in the `run.start` config, and what the
   other modes are. `payloadRecordingEnabled()` (runtime.ts:50) is
   `ECHO_FULL_LOG !== "0"`, so payload recording was already on. Something else
   suppressed the tool events. Find it.
2. Why `tool.call` and `tool.result` were not recorded in those runs
3. Where `codeVersion` is populated, and why it is `"unknown"`
4. Why `usage` is `{}` on every `llm.response`

**Then change:**

- Make the default coverage record `tool.call`, `tool.result` and `tool.error`
- Populate `codeVersion` from the build (git short SHA is fine) so tapes are
  comparable across changes
- Populate `usage` from the provider response where the provider supplies it

**Test:** in `_replaytest.ts`, assert a run that calls a tool produces both
`tool.call` and `tool.result`, and that `codeVersion` is not `"unknown"`.

---

## FINAL GATES

Run all of these and report exit codes:

```
npm run typecheck
npm run check
npm run exittest
npm run recoverytest
npm run replaytest
npm run safetytest
npm run risktest
```

Do not modify a test to make it pass. If a fix breaks an existing test, that is
a finding: report it and stop.

---

## FINAL REPORT

```
ECHO SILENT STOP REMEDIATION

BASELINE
  Pre-existing dirty files:
  Gates passing before changes:
  Gates already failing before changes:

FIXES
  For each of 1-7:
    Status:            VERIFIED / PARTIALLY_VERIFIED / NOT_REPRODUCED / FAILED
    Files changed:
    What changed:
    Test added:
    Fails without fix:  YES / NO
    Commit:

INVESTIGATIONS
  Fix 6 — what emits the unpaired request:
  Fix 7 — what suppressed tool events:
  Fix 7 — where codeVersion comes from:

FINAL GATES
  typecheck / check / exittest / recoverytest / replaytest / safetytest / risktest

REMAINING SILENT-STOP PATHS
  Any path you found that can still end a run without a terminal event

ISOLATION
  Other repositories modified:  0
  Pushed to origin:             NO
  Secrets printed or changed:   NO
```

**No evidence = not fixed.**
