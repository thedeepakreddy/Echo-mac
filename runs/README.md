# Reading a run log

One named directory per attempt: `runs/Echo--{uuid}/` for the main assistant,
or `runs/Echo Clone 1--{uuid}/`, `Echo Clone 2--{uuid}/`, and so on. Each has
`events.jsonl`, `checkpoint.json`, and `blobs/{sha256}`. The checkpoint connects
several recovery attempts into one logical task.

Every line carries `ts`, `iso`, `seq`, `runId` and `type`. Lines are flushed as
they are written, and the ones that matter most (`run.start`, `loop.exit`,
`run.end`, `loop.stall_suspected`, crashes) are fsynced — so a run that died
hard still leaves a readable file up to the last complete line.

## Start here

```bash
# Actor, checkpoint attempt, and why the most recent run ended
./check-run.sh
```

**`loop.exit` is the only event you need first.** Its `reason` field is a closed
set, and the table below says what each one means. If there is no `loop.exit`
line at all, see "No exit event" below — that is a different and more serious
finding.

Useful follow-ups:

```bash
R="$(ls -td runs/*/ | head -1)"
grep -c . "$R/events.jsonl"                        # how many events
grep '"type":"turn.end"' "$R/events.jsonl" | tail  # the last few model turns
grep '"isError":true' "$R/events.jsonl"            # tool failures
grep 'stall_suspected' "$R/events.jsonl"           # did it hang?
tail -3 "$R/events.jsonl"                          # the last thing that happened
```

## What each `reason` means

| `reason` | What happened | Where to look next |
|---|---|---|
| `completed` | The model answered and wanted nothing more. An ordinary end. | Nothing to chase. |
| `max_iterations` | Ran out of steps. A fresh attempt is automatically started from the checkpoint. | Compare `iteration` against `config.maxIterations`, then inspect the next run with the same `taskId`. |
| `model_stop_no_tool_call` | The model stopped calling tools while still mid-task. Either it returned nothing, or it ran out of in-context continuation nudges. It is incomplete and automatically recovered. | `rawFinishReason`, `detail`, and the next run with the same `taskId`. |
| `abort_signal` | You interrupted it, or the app shut down mid-run. | Expected if you pressed stop. |
| `tool_error` | A tool failed in a way that ended the run rather than being reported back to the model. Rare — most tool failures are handed to the model as text and the run continues. | The last `tool.end` with `isError: true`. |
| `provider_error` | The provider rejected the request, or a safety filter blocked the response. | `error.message` on the exit. A `SAFETY` / `RECITATION` `rawFinishReason` means content filtering, not a bug. |
| `rate_limit_429` | Rate limited or out of quota. For Gemini this means every model in the fallback ladder was exhausted — check for `llm.model_fallback` events before it. | Wait and retry. If it happens fast, the ladder is being burned through by retries. |
| `context_overflow` | The conversation outgrew the window, or the reply was truncated at the token limit. | `approxTokensInContext` on the exit, and `totalContextTokens` on the last `turn.end`. Screenshots are the usual cause. |
| `stream_closed` | The connection to the model dropped, or the Claude SDK's subprocess died without sending a result. | `error` on the exit. If it recurs, suspect auth or the CLI rather than the network. |
| `unknown_fallthrough` | **A path out of the loop exists that does not name itself.** | This is a bug in the instrumentation, not a diagnosis. Tell me and I'll find the path — `detail` says which layer noticed. |

## Hang or stop?

They look identical from outside. In the log they don't:

- **Log ends with `loop.heartbeat` lines still ticking** → it hung. `state` says
  what it was blocked on (`awaiting_llm`, `awaiting_tool`, `reflecting`) and
  `waitingOn` names the specific provider call or tool. A `loop.stall_suspected`
  line means one state lasted over 120 seconds. The stall is recorded first,
  then the watchdog ends that attempt and recovery continues in a new one.
- **Log ends with `loop.exit`** → it stopped on purpose. Read the reason.
- **Log ends with neither** → the process died. Look for
  `process.uncaughtException`, `process.unhandledRejection`, or
  `renderer.error` as the last line. If there is nothing, it was killed from
  outside (OOM or a crash in native code).
  `checkpoint.json` remains `running`; the next app launch resumes it.

## Event types

| Type | When |
|---|---|
| `run.start` | Once, first. Carries the git SHA, node and Electron versions, provider, model, and **every loop cap** so the log can be read without the source. |
| `agent.input` | The user's request (in a blob). |
| `agent.tool` / `agent.risk` / `agent.error` | What the named brain announced, how the safety gate classified it, and provider errors. |
| `iteration.start` | Top of each loop iteration, with `messageCount` and `approxTokensInContext` — watch these grow. |
| `turn.end` | One per model response: normalized `finishReason` plus the provider's own `rawFinishReason`, token counts, latency, tool names. |
| `tool.start` / `tool.end` | Every tool, from the shared risk gate, so all three providers report identically. `argsHash` identifies repeat calls. |
| `loop.heartbeat` | Every 15s while the loop is alive. |
| `loop.stall_suspected` | One state lasted over 120s; the owning brain is interrupted and recovered. |
| `loop.exit` | Once, last-but-one. The whole point. |
| `run.end` | Once, last. `ok` is false for every incomplete reason. |
| `llm.model_fallback` | Gemini moved down the model ladder. |
| `process.*` / `renderer.error` | Something escaped the loop entirely. |

## Normalized vs. raw finish reasons

`turn.end.finishReason` is one of `stop | tool_calls | length | content_filter |
error | unknown`, the same vocabulary for all three providers.
`rawFinishReason` is what the provider actually said. Keep both in view: the
normalized one lets you compare runs, the raw one is what you search the
provider's docs for.

This distinction is the reason the bug was hard. "Model decided it was done"
(`stop`), "output was truncated" (`length`), and "context overflowed"
(`context_overflow` at exit) are three different bugs that look identical from
outside the process.

## Turning it off

Full logging and durable recovery are on by default and write here.
`ECHO_LOG=0` disables both. `ECHO_LOG_DIR=/some/path` moves them,
`ECHO_LOG_QUIET=1` stops the console mirror, and `ECHO_FULL_LOG=0` keeps only
diagnostic metadata (with no prompt reconstruction or automatic recovery).

`ECHO_RECOVERY_ATTEMPTS` defaults to 3. `ECHO_LLM_TIMEOUT_MS` and
`ECHO_TOOL_TIMEOUT_MS` default to 120000 so a request cannot wait forever.
User interrupts become `cancelled` checkpoints and are never resumed.

A log holds the request text and tool arguments in its blobs. If you are going
to share one, read `blobs/` first.
