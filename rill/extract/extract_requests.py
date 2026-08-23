#!/usr/bin/env python3
"""Claude Code transcripts -> fct_request.csv + fct_tool_call.csv.

THE SECOND SOURCE, AND WHY THERE IS ONE.

Everything else in this project reads Kandev's SQLite store. That store has no request grain:
857 cost events describe the whole fleet, while ONE card issues 867 API requests. Three facts
that decide what a build step costs are therefore unanswerable from it, and no amount of
modelling downstream can recover them:

  * CONTEXT SIZE PER REQUEST. Kandev records none. It is the single most actionable number in
    the whole system — cost is requests x window size — and 74% of one card's requests ran
    above 200K without anything in the product being able to say so.
  * READS SPLIT FROM WRITES. `office_cost_events.tokens_cached_in` sums them into one column
    at a 20x price difference ($0.30 read against $6.00 for a 1h write).
  * WHAT A TOOL RESULT COST. Kandev stores the tool INVOCATION and never the result, so the
    tail a large result imposes on every later request is invisible.

WHAT LEAVES THIS FILE. Integers, ids, timestamps and low-cardinality enums — the same rule
extract.sql holds itself to. Tool RESULTS are measured and discarded: `result_tokens` is a
length, never the text. Command lines are classified into `tool_class` here, where they are
still readable, and dropped. No message content, no file contents, no prompts.

COVERAGE IS CLAUDE CODE ONLY, AND THE MODELS MUST SAY SO. Codex and agy write no transcripts,
so a step that ran on them appears here not at all. Every consumer carries `usage_basis` for
this reason: absence here means "not observable", never "cost nothing".

SUBAGENTS ARE INCLUDED, AND THE PATH IS WHY. A Task subagent writes its own transcript at
`<project>/<parent-session-id>/subagents/agent-*.jsonl` with `isSidechain` set. The parent
session id is therefore IN THE PATH, which is the link needed to bill a subagent's requests to
the step its parent was in. This matters more than it sounds: a Review step that fans out to
three reviewers does most of its spending in those files, and counting only the parent reports
roughly half the step. `agent_kind` keeps the two separable so a reader can still ask what the
parent alone did.
"""
import csv, glob, json, os, sqlite3, sys

TRANSCRIPT_ROOT = os.environ.get(
    "CLAUDE_TRANSCRIPTS",
    os.path.expanduser("~/.claude-work/projects"))
KANDEV_DB = os.environ.get("KANDEV_DB", os.path.expanduser("~/.kandev/data/kandev.db"))
OUT = sys.argv[1] if len(sys.argv) > 1 else "data"


def classify(name, cmd):
    """Tool name and purpose. `cmd` is read here and never emitted.

    Ordering mirrors extract.sql's `tool_purpose`: verify before recon, because a test run
    piped to a filter is verification wearing a search's clothes; recon before vcs, because
    `git grep` is a search whatever binary it starts with.
    """
    if name != "Bash":
        cls = {"Read": "recon", "Glob": "recon", "Grep": "recon",
               "Edit": "edit", "Write": "edit", "NotebookEdit": "edit"}.get(name, "agent control")
        return name, cls
    c = (cmd or "").lower()
    if any(k in c for k in ("go test", "pytest", "playwright", "vitest", "jest")):
        return "Bash: go test", "verify"
    if "go build" in c or "go vet" in c:
        return "Bash: go build / vet", "verify"
    if "gofmt" in c:
        return "Bash: gofmt", "verify"
    if "make " in c:
        return "Bash: make", "verify"
    if "pnpm" in c or "npm " in c:
        return "Bash: pnpm", "verify"
    if "grep" in c or c.startswith("rg ") or " rg " in c:
        return "Bash: grep / rg", "recon"
    if "git " in c:
        return "Bash: git", "vcs"
    return "Bash: other", "other shell"


def main():
    # THE JOIN, IN TWO PARTS, AND NEITHER IS THE OBVIOUS ONE.
    #
    # PART 1 — cwd -> task, by LONGEST PREFIX, not equality. `cwd` is the agent's CURRENT
    # directory and it moves: on one card only 649 of ~2,000 records sat at the worktree root
    # while 1,350 were in `apps/backend` and the rest deeper still. An equality join silently
    # keeps a third of the requests and loses the rest, which reads downstream as a cheap step
    # rather than a broken join. Longest prefix also disambiguates nested worktrees correctly.
    #
    # PART 2 — task -> session, by TIME, not by path. Sessions are re-created on the same
    # worktree (this card had two, an Opus spec session and a Sonnet build session sharing one
    # directory), so the path cannot choose between them. The step timeline is per session, so
    # picking the wrong one resolves every step wrong. The session whose lifetime contains the
    # request is the right answer and the only one available.
    db = sqlite3.connect(KANDEV_DB)
    ws_task = []
    for tid, path in db.execute(
            "SELECT DISTINCT task_id, workspace_path FROM task_sessions "
            "WHERE workspace_path <> '' AND task_id <> ''"):
        ws_task.append((os.path.normpath(path), tid))
    ws_task.sort(key=lambda x: -len(x[0]))

    sessions = {}
    for sid, tid, st, en in db.execute(
            "SELECT id, task_id, started_at, COALESCE(completed_at,'9999') "
            "FROM task_sessions WHERE task_id <> ''"):
        sessions.setdefault(tid, []).append((str(st)[:19].replace(" ", "T"),
                                             str(en)[:19].replace(" ", "T"), sid))
    for v in sessions.values():
        v.sort()

    _cwd_cache = {}

    def resolve(cwd, ts):
        if not cwd:
            return "", ""
        tid = _cwd_cache.get(cwd, KeyError)
        if tid is KeyError:
            tid = ""
            for path, t in ws_task:
                if cwd == path or cwd.startswith(path + os.sep):
                    tid = t
                    break
            _cwd_cache[cwd] = tid
        if not tid:
            return "", ""
        cands = sessions.get(tid) or []
        for st, en, sid in cands:
            if st <= ts <= en:
                return sid, tid
        # Outside every recorded lifetime — keep the card, admit no session. Dropping the row
        # would understate the card; inventing a session would misplace its step.
        return "", tid

    reqs, calls, results, use_tool = {}, [], {}, {}
    sidechain_reqs = set()

    # Recursive: main transcripts sit at <project>/<session>.jsonl, subagents one level
    # deeper at <project>/<session>/subagents/agent-*.jsonl. Missing the nested level is a
    # silent 0-subagent result, which reads as "no fan-out happened" rather than "not looked".
    files = sorted(glob.glob(os.path.join(TRANSCRIPT_ROOT, "**", "*.jsonl"), recursive=True))
    for f in files:
        # The directory above `subagents/` is the PARENT session id. This is the only link
        # between a subagent's spend and the step that caused it.
        parent_sid = ""
        parts = f.split(os.sep)
        if "subagents" in parts:
            i = parts.index("subagents")
            if i >= 1:
                parent_sid = parts[i - 1]
        for line in open(f, errors="replace"):
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            if t == "assistant" and d.get("requestId"):
                rid = d["requestId"]
                msg = d.get("message") or {}
                if d.get("isSidechain"):
                    sidechain_reqs.add(rid)
                if rid not in reqs:
                    u = msg.get("usage") or {}
                    cc = u.get("cache_creation") or {}
                    cwd = os.path.normpath(d.get("cwd") or "")
                    ts19 = (d.get("timestamp") or "")[:19]
                    sid, tid = resolve(cwd, ts19)
                    read = u.get("cache_read_input_tokens", 0) or 0
                    w1 = cc.get("ephemeral_1h_input_tokens", 0) or 0
                    w5 = cc.get("ephemeral_5m_input_tokens", 0) or 0
                    inp = u.get("input_tokens", 0) or 0
                    reqs[rid] = {
                        "request_id": rid,
                        "occurred_at": (d.get("timestamp") or "")[:19] + "Z",
                        "session_id": sid,
                        "task_id": tid,
                        "transcript_session_id": d.get("sessionId", ""),
                        "parent_transcript_session_id": parent_sid,
                        "model": (msg.get("model") or "(unrecorded)"),
                        "effort": d.get("effort") or "(unrecorded)",
                        # Path is authoritative, not the flag: a record can be written without
                        # `isSidechain` while sitting in a subagents/ directory, and the
                        # directory is what the parent link depends on.
                        "agent_kind": "subagent" if (parent_sid or d.get("isSidechain"))
                                      else "main",
                        "tokens_read": read,
                        "tokens_write_1h": w1,
                        "tokens_write_5m": w5,
                        "tokens_input": inp,
                        "tokens_output": u.get("output_tokens", 0) or 0,
                        # The whole prefix this request re-sent. THE actionable number.
                        "context_tokens": read + w1 + w5 + inp,
                    }
                for blk in msg.get("content") or []:
                    if isinstance(blk, dict) and blk.get("type") == "tool_use":
                        nm, cls = classify(blk.get("name", "?"),
                                           (blk.get("input") or {}).get("command"))
                        use_tool[blk.get("id")] = (rid, nm, cls)
            elif t == "user":
                for blk in ((d.get("message") or {}).get("content") or []):
                    if isinstance(blk, dict) and blk.get("type") == "tool_result":
                        c = blk.get("content")
                        n = len(c) if isinstance(c, str) else len(json.dumps(c))
                        # Length only. The content is not read again after this line.
                        results[blk.get("tool_use_id")] = n

    # A subagent inherits its parent's card. Its own `cwd` usually resolves on its own — it
    # runs in the same worktree — but a subagent launched before the parent's first recorded
    # request, or in a worktree Kandev has since forgotten, would otherwise land card-less and
    # silently drop out of every per-card total. Resolved after the walk because a parent can
    # appear later in file order than its child.
    by_transcript = {}
    for r in reqs.values():
        if r["task_id"] and r["transcript_session_id"]:
            by_transcript.setdefault(r["transcript_session_id"], (r["session_id"], r["task_id"]))
    adopted = 0
    for r in reqs.values():
        if not r["task_id"] and r["parent_transcript_session_id"]:
            got = by_transcript.get(r["parent_transcript_session_id"])
            if got:
                r["session_id"], r["task_id"] = got
                adopted += 1

    for use_id, (rid, nm, cls) in use_tool.items():
        if rid not in reqs:
            continue
        calls.append({
            "request_id": rid,
            "tool_name": nm,
            "tool_class": cls,
            # chars/4 — the same approximation the rest of this project uses for text it is
            # not allowed to tokenize properly. Good to ~10%, and the ranking it feeds is
            # robust to that.
            "result_tokens": round(results.get(use_id, 0) / 4),
        })

    os.makedirs(OUT, exist_ok=True)
    rf = os.path.join(OUT, "fct_request.csv")
    with open(rf, "w", newline="") as fh:
        cols = ["request_id", "occurred_at", "session_id", "task_id", "transcript_session_id",
                "parent_transcript_session_id", "model", "effort", "agent_kind",
                "tokens_read", "tokens_write_1h", "tokens_write_5m", "tokens_input",
                "tokens_output", "context_tokens"]
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for r in reqs.values():
            w.writerow(r)

    cf = os.path.join(OUT, "fct_tool_call.csv")
    with open(cf, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["request_id", "tool_name", "tool_class",
                                           "result_tokens"])
        w.writeheader()
        for c in calls:
            w.writerow(c)

    matched = sum(1 for r in reqs.values() if r["task_id"])
    subs = sum(1 for r in reqs.values() if r["agent_kind"] == "subagent")
    print(f"    fct_request.csv        {len(reqs):8d} rows "
          f"({matched} joined to a card, {subs} subagent, {adopted} adopted from parent)")
    print(f"    fct_tool_call.csv      {len(calls):8d} rows")


if __name__ == "__main__":
    main()
