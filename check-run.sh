#!/bin/bash
# Read the most recent run: why it ended, and whether anything went unexplained.
F="$(find runs -mindepth 2 -maxdepth 2 -type f -name events.jsonl -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)"
[ -z "$F" ] && { echo "No runs yet. Start Echo and give it a task."; exit 1; }
R="$(dirname "$F")"
echo "run: $(basename "$R")   events: $(grep -c . "$F")"
echo
python3 - "$F" <<'PY'
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
start = next((e for e in ev if e["type"] == "run.start"), {})
exit_ = next((e for e in reversed(ev) if e["type"] == "loop.exit"), None)
beats = [e for e in ev if e["type"] == "loop.heartbeat"]
stalls = [e for e in ev if e["type"] == "loop.stall_suspected"]
tools = [e for e in ev if e["type"] == "tool.end"]
turns = [e for e in ev if e["type"] == "turn.end"]

cfg = start.get("config", {})
print(f"  provider    {start.get('provider')} / {start.get('model')}   build {start.get('gitSha')}")
actor = start.get("actor") or cfg.get("actor") or {"name": "Echo"}
print(f"  actor       {actor.get('name')}   task {start.get('taskId') or cfg.get('taskId') or 'legacy'}")
print(f"  recovery    attempt {start.get('recoveryAttempt', cfg.get('recoveryAttempt', 0))}")
print(f"  caps        {({k: v for k, v in cfg.items() if k != 'env' and 'max' in k.lower() or 'imit' in k})}")
print(f"  turns       {len(turns)}   tools {len(tools)} ({sum(1 for t in tools if t.get('isError'))} failed)")
if turns:
    print(f"  context     {turns[-1].get('totalContextTokens')} tokens at the last turn")
print()
if exit_:
    print(f"  EXIT        {exit_['reason']}   (incomplete={exit_.get('incomplete')})")
    print(f"  at          iteration {exit_.get('iteration')}   after {round(exit_.get('elapsedMs',0)/1000)}s")
    print(f"  detail      {exit_.get('detail')}")
    print(f"  finish      {exit_.get('finishReason')} (provider said: {exit_.get('rawFinishReason')})")
    if exit_.get("lastTool"):
        print(f"  last tool   {exit_['lastTool']}")
    if exit_["reason"] == "unknown_fallthrough":
        print("\n  *** unknown_fallthrough: a path out of the loop does not name itself.")
        print("  *** This is the tripwire. Send me this file.")
else:
    print("  NO EXIT EVENT — the process died before the loop could report.")
    print(f"  last events: {', '.join(e['type'] for e in ev[-4:])}")
    if beats:
        print(f"  {len(beats)} heartbeat(s); last state was "
              f"{beats[-1].get('state')} on {beats[-1].get('waitingOn')} "
              f"for {round(beats[-1].get('elapsedInStateMs',0)/1000)}s  -> it HUNG")
    else:
        print("  no heartbeats either -> the process was killed")
if stalls:
    print(f"\n  {len(stalls)} STALL(S): " + "; ".join(
        f"{s.get('state')} on {s.get('waitingOn')} for {round(s.get('elapsedInStateMs',0)/1000)}s" for s in stalls))
names = {}
for t in tools:
    names[t["name"]] = names.get(t["name"], 0) + 1
if names:
    print("\n  tools used: " + ", ".join(f"{k}×{v}" for k, v in sorted(names.items(), key=lambda x: -x[1])))
PY
