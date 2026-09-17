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

# EVERY ROOT, NOT ONE. Claude Code writes transcripts under whichever CLAUDE_CONFIG_DIR the
# process was started with, and this machine has two live ones: agents launched by Kandev land
# in ~/.claude/projects, an isolated worker config in ~/.claude-work/projects. Reading a single
# root is not a partial answer, it is a silent one — with only ~/.claude-work scanned, 48 of
# 655 tasks had any request row at all and every per-task context figure for the other 607 read
# as empty rather than as missing. Both roots are scanned and the union is emitted; a root that
# does not exist is skipped, so this stays correct on a machine that has only one.
#
# CLAUDE_TRANSCRIPTS overrides the default and takes an os.pathsep-separated LIST, so a caller
# can still pin one root (tests do) without losing the ability to name several.
#
# DISCOVERED, NOT LISTED. Found 2026-09-17: from 2026-09-01 Kandev launched agents with a third
# config dir, ~/.claude-kandev, and a hard-coded two-root list never saw it. Every Kandev request
# after that date was missing, not merely unattributed — ~447K assistant records — so the
# request-to-session join rate read 53% in W36 and 0% in W37 and W38 while the fleet was busier
# than ever. The failure was silent in exactly the way the note above warns about. So every
# ~/.claude*/projects directory is scanned, and main() prints a per-root count, so a new config
# dir shows up as a new line in the extract log rather than as a hole in the dashboard.
_DEFAULT_TRANSCRIPT_ROOTS = sorted(
    glob.glob(os.path.expanduser("~/.claude*/projects")))
TRANSCRIPT_ROOTS = [
    p for p in (
        os.environ["CLAUDE_TRANSCRIPTS"].split(os.pathsep)
        if os.environ.get("CLAUDE_TRANSCRIPTS") else _DEFAULT_TRANSCRIPT_ROOTS
    ) if p and os.path.isdir(p)
]
KANDEV_DB = os.environ.get("KANDEV_DB", os.path.expanduser("~/.kandev/data/kandev.db"))
OUT = sys.argv[1] if len(sys.argv) > 1 else "data"
# Session -> card attribution, one row per Claude session id, ids only. Persisted OUTSIDE data/
# and merged on every run, because the transcripts it is derived from are deleted by Claude
# Code's retention sweep: without a durable copy, a session's card vanishes from the telemetry
# extract the day its transcript does, and a past week's cost silently rewrites itself. Unset,
# no attribution file is read or written.
ATTRIBUTION_STATE = os.environ.get("ATTRIBUTION_STATE", "")

# ONLY A CARD WORKTREE MAY CLAIM A PREFIX. Per-card worktrees live under ~/.kandev/tasks/<slug>/,
# where exactly one card runs, so a cwd beneath one identifies that card. Every other path is a
# SHARED checkout — the operator's own dev tree — where the fleet, the operator's interactive
# sessions, and any card launched without an executor profile all run in the same directory.
# Attributing by prefix there does not identify a card, it invents one.
#
# Found 2026-09-01. Card `99670243` held a single CANCELLED session whose workspace_path was
# `~/Projects/<workspace>/kandev`. That one row let it claim 137 transcripts and
# 24,454 requests spanning 07-30 to 09-01, nearly all of them the operator's own interactive
# sessions — including the very session that found this bug. 40 sessions across 36 tasks name that
# same directory, so the winner was decided by prefix-sort order rather than by fact. Downstream it
# read as a runaway agent: this card alone pushed ENV-008's Opus requests-over-ceiling to 21.4% and
# failed check.sh's "declared ceiling is an observed ceiling" assertion.
#
# `kandev-measure-run.py` already draws this line (`CARD_WORKTREE_PREFIX`, flagging such rows
# `partial-shared` rather than counting them). Same rule here: a request in a shared checkout is
# emitted UNATTRIBUTED rather than billed to whichever card sorts first. Unattributed is honest and
# visible downstream; misattributed is neither.
#
# The cost: cards that genuinely ran in a shared checkout lose their request rows. That is the
# correct trade — those requests cannot be distinguished from the operator's own, and a card
# reading "not observable" is recoverable while a card reading someone else's 717K context is not.
CARD_WORKTREE_PREFIX = os.environ.get(
    "CARD_WORKTREE_PREFIX", os.path.expanduser("~/.kandev/tasks/"))


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
    # TWO PATH SOURCES, BECAUSE `task_sessions.workspace_path` IS NOT RELIABLE. It is empty on
    # 256 of 738 sessions here and, on 33 more, holds a path the task never ran in — several
    # name the operator's own dev checkout while the session actually ran in an isolated
    # worktree. `task_environments.workspace_path` is the materialized workspace and is correct
    # in every one of those cases, so both are loaded and the environment is preferred.
    #
    # This is why a card could show a full cost rail and an empty context chart: the cost path
    # resolves a step without needing a directory, and only this join needs one. Reading just
    # the session table dropped 39% of sessions before the prefix match even ran.
    db = sqlite3.connect(KANDEV_DB)
    ws_task = []
    shared_paths = set()   # dropped, not attributed — reported at the end so it stays visible
    # IDENTITY BEFORE LOCATION. Kandev records the agent's own session id in
    # task_sessions.metadata.acp.session_id — for Claude Code that IS the transcript's sessionId
    # and the telemetry session.id. Where it exists it names the Kandev session and card exactly,
    # so it outranks any path rule. Found 2026-09-17 by an outside review: 32 transcripts in
    # worktrees shared by two cards were billed to the wrong one by longest-prefix order, and
    # 3,122 requests to the wrong session of the right card. Kandev keeps only the LATEST agent
    # session id per Kandev session, so this covers the current run of each session and the path
    # join below still carries every earlier one.
    acp = {}
    for ksid, tid, meta in db.execute(
            "SELECT id, task_id, metadata FROM task_sessions WHERE task_id <> ''"):
        try:
            a = json.loads(meta or "{}").get("acp")
        except (ValueError, AttributeError):
            continue
        if isinstance(a, dict) and a.get("session_id"):
            acp[a["session_id"]] = (ksid, tid)

    for sql in (
            "SELECT DISTINCT task_id, workspace_path FROM task_environments "
            "WHERE workspace_path <> '' AND task_id <> ''",
            "SELECT DISTINCT task_id, workspace_path FROM task_sessions "
            "WHERE workspace_path <> '' AND task_id <> ''"):
        try:
            rows = list(db.execute(sql))
        except sqlite3.Error:
            # A schema without task_environments still works off sessions alone.
            continue
        for tid, path in rows:
            norm = os.path.normpath(path)
            # Shared checkouts identify no card — see CARD_WORKTREE_PREFIX above.
            if not norm.startswith(os.path.normpath(CARD_WORKTREE_PREFIX) + os.sep):
                shared_paths.add(norm)
                continue
            ws_task.append((norm, tid))
    # Longest prefix first (PART 1). A worktree can belong to MORE THAN ONE card — a parent and
    # its subtask share a checkout — so a path keeps every card that names it. The old rule kept
    # whichever sorted first, and silently billed one card's requests to its sibling.
    path_tasks = {}
    for norm, tid in ws_task:
        path_tasks.setdefault(norm, [])
        if tid not in path_tasks[norm]:
            path_tasks[norm].append(tid)
    ws_paths = sorted(path_tasks, key=lambda x: -len(x))

    sessions = {}
    for sid, tid, st, en in db.execute(
            "SELECT id, task_id, started_at, COALESCE(completed_at,'9999') "
            "FROM task_sessions WHERE task_id <> ''"):
        sessions.setdefault(tid, []).append((str(st)[:19].replace(" ", "T"),
                                             str(en)[:19].replace(" ", "T"), sid))
    for v in sessions.values():
        v.sort()

    _cwd_cache = {}

    ambiguous = 0

    def resolve(cwd, ts):
        nonlocal ambiguous
        if not cwd:
            return "", ""
        tids = _cwd_cache.get(cwd, KeyError)
        if tids is KeyError:
            tids = []
            for path in ws_paths:
                if cwd == path or cwd.startswith(path + os.sep):
                    tids = path_tasks[path]
                    break
            _cwd_cache[cwd] = tids
        if not tids:
            return "", ""
        # Every card on this path whose session lifetime contains the request.
        hits = [(sid, tid) for tid in tids for st, en, sid in (sessions.get(tid) or [])
                if st <= ts <= en]
        if len({t for _, t in hits}) == 1:
            return hits[0]
        if len(tids) == 1 and not hits:
            # Outside every recorded lifetime — keep the card, admit no session. Dropping the row
            # would understate the card; inventing a session would misplace its step.
            return "", tids[0]
        # Shared worktree and time does not pick one card: unattributed, not guessed.
        ambiguous += 1
        return "", ""

    reqs, calls, results, use_tool = {}, [], {}, {}
    sidechain_reqs = set()

    # Recursive: main transcripts sit at <project>/<session>.jsonl, subagents one level
    # deeper at <project>/<session>/subagents/agent-*.jsonl. Missing the nested level is a
    # silent 0-subagent result, which reads as "no fan-out happened" rather than "not looked".
    # Across every root (see TRANSCRIPT_ROOTS). Sorted per root and concatenated rather than
    # globally sorted, so a file's provenance stays adjacent in the scan order; nothing
    # downstream depends on cross-root ordering because rows carry their own timestamps.
    files = []
    root_of = {}
    for root in TRANSCRIPT_ROOTS:
        found = sorted(glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True))
        files.extend(found)
        for f in found:
            root_of[f] = root
    per_root = {root: 0 for root in TRANSCRIPT_ROOTS}
    for f in files:
        # The directory above `subagents/` is the PARENT session id. This is the only link
        # between a subagent's spend and the step that caused it.
        parent_sid = ""
        parts = f.split(os.sep)
        if "subagents" in parts:
            i = parts.index("subagents")
            if i >= 1:
                parent_sid = parts[i - 1]
        # A subagent's records carry the PARENT's `sessionId`, so `transcript_session_id` cannot
        # tell two concurrent subagents apart, or a subagent from its parent: one stream then
        # interleaves contexts of very different sizes, and a context-size drop at every
        # main/subagent switch reads as a compaction. The file stem is the subagent's own
        # identity. Emitted as a separate column so `transcript_session_id` keeps the meaning
        # kandev_requests.yaml partitions on.
        own_transcript = os.path.splitext(os.path.basename(f))[0] if parent_sid else ""
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
                u = msg.get("usage") or {}
                cc = u.get("cache_creation") or {}
                read = u.get("cache_read_input_tokens", 0) or 0
                w1 = cc.get("ephemeral_1h_input_tokens", 0) or 0
                w5 = cc.get("ephemeral_5m_input_tokens", 0) or 0
                inp = u.get("input_tokens", 0) or 0
                out_tok = u.get("output_tokens", 0) or 0
                if rid in reqs:
                    # ONE RESPONSE IS WRITTEN AS SEVERAL RECORDS, and usage is a running snapshot:
                    # a streamed turn logs output_tokens 2, 2, then 533 under one requestId. Keeping
                    # the first record dropped ~11% of output tokens (outside review, 2026-09-17).
                    # Take the largest value per field — never a sum, because the snapshots are
                    # cumulative, and a fork's copied records repeat the same values.
                    r = reqs[rid]
                    for col, v in (("tokens_read", read), ("tokens_write_1h", w1),
                                   ("tokens_write_5m", w5), ("tokens_input", inp),
                                   ("tokens_output", out_tok)):
                        if v > r[col]:
                            r[col] = v
                    r["context_tokens"] = (r["tokens_read"] + r["tokens_write_1h"]
                                           + r["tokens_write_5m"] + r["tokens_input"])
                else:
                    per_root[root_of[f]] += 1
                    cwd = os.path.normpath(d.get("cwd") or "")
                    ts19 = (d.get("timestamp") or "")[:19]
                    tsid = d.get("sessionId", "")
                    if tsid in acp:
                        (sid, tid), source = acp[tsid], "acp"
                    else:
                        sid, tid = resolve(cwd, ts19)
                        source = "path" if tid else ""
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
                        "tokens_output": out_tok,
                        # The whole prefix this request re-sent. THE actionable number.
                        "context_tokens": read + w1 + w5 + inp,
                        "agent_transcript_id": own_transcript or d.get("sessionId", ""),
                        "attribution_source": source,
                        # Not emitted: whether this cwd is a card worktree, for the session map.
                        "_card_cwd": cwd.startswith(os.path.normpath(CARD_WORKTREE_PREFIX) + os.sep),
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
                r["attribution_source"] = "parent"
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
                "tokens_output", "context_tokens",
                # Appended last: src_fct_request loads verbatim and every consumer selects
                # columns by name, so a trailing column changes nothing downstream.
                "agent_transcript_id",
                # acp | path | parent | '' — which rule attributed the row.
                "attribution_source"]
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
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

    if ATTRIBUTION_STATE:
        write_attribution(reqs, acp, db)

    matched = sum(1 for r in reqs.values() if r["task_id"])
    by_source = {}
    for r in reqs.values():
        by_source[r["attribution_source"] or "none"] = by_source.get(r["attribution_source"] or "none", 0) + 1
    subs = sum(1 for r in reqs.values() if r["agent_kind"] == "subagent")
    for root in TRANSCRIPT_ROOTS:
        print(f"    root {root}  {per_root.get(root, 0):8d} requests")
    print(f"    fct_request.csv        {len(reqs):8d} rows "
          f"({matched} joined to a card, {subs} subagent, {adopted} adopted from parent)")
    print(f"    attribution            {by_source}; {ambiguous} shared-worktree requests left "
          f"unattributed")
    if shared_paths:
        print(f"    shared checkouts       {len(shared_paths):8d} paths NOT used for attribution "
              f"(requests there are unattributed, not billed to a card)")
        for p in sorted(shared_paths)[:5]:
            print(f"      - {p}")
    print(f"    fct_tool_call.csv      {len(calls):8d} rows")


ATTRIBUTION_COLS = ["session_id", "task_id", "kandev_task_count", "workspace_kind",
                    "is_kandev_task", "attribution_source", "last_seen"]


def write_attribution(reqs, acp, db):
    """One row per Claude session id -> card, merged into the persisted state file.

    The telemetry extract has no per-request grain, so a session's whole cost goes to one label.
    That label must therefore claim only what EVERY request in the session supports:

      acp          the session is Kandev's by identity. is_kandev_task=1 whatever the checkout;
                   workspace_kind still reports where it ran.
      task_worktree  path-attributed, one card, every request in that card's worktree.
      mixed        some requests resolved to a card and some did not, or to several cards. Cost
                   cannot be split at session grain, so it is not billed as Kandev work.
      none         nothing resolved.

    A row from this run replaces the stored row for the same session; a stored row whose
    transcript has since been deleted is kept. Written to a temp file and renamed, so a failed
    run never leaves a truncated state.
    """
    per = {}
    for r in reqs.values():
        sid = r["transcript_session_id"]
        if not sid:
            continue
        p = per.setdefault(sid, {"tasks": set(), "unattr": 0, "shared": 0, "acp": False,
                                 "last": ""})
        if r["task_id"]:
            p["tasks"].add(r["task_id"])
        else:
            p["unattr"] += 1
        if not r["_card_cwd"]:
            p["shared"] += 1
        p["acp"] = p["acp"] or r["attribution_source"] == "acp"
        p["last"] = max(p["last"], r["occurred_at"])
    rows = {}
    for sid, p in per.items():
        n = len(p["tasks"])
        if p["acp"]:
            kind = "task_worktree" if not p["shared"] else "shared_checkout"
            rows[sid] = [sid, acp[sid][1], 1, kind, 1, "acp", p["last"]]
        elif n == 1 and not p["unattr"] and not p["shared"]:
            rows[sid] = [sid, next(iter(p["tasks"])), 1, "task_worktree", 1, "transcript", p["last"]]
        elif n:
            rows[sid] = [sid, next(iter(p["tasks"])) if n == 1 else "", n, "mixed", 0,
                         "transcript", p["last"]]
        else:
            rows[sid] = [sid, "", 0, "none", 0, "transcript", p["last"]]
    # Kandev sessions whose transcript is already gone still carry their identity.
    for asid, (_, tid) in acp.items():
        rows.setdefault(asid, [asid, tid, 1, "unknown", 1, "acp", ""])

    stored = {}
    if os.path.exists(ATTRIBUTION_STATE):
        with open(ATTRIBUTION_STATE, newline="") as fh:
            for r in csv.DictReader(fh):
                stored[r["session_id"]] = [r.get(c, "") for c in ATTRIBUTION_COLS]
    kept = sum(1 for k in stored if k not in rows)
    for k, v in stored.items():
        if k not in rows:
            rows[k] = v
        elif rows[k][3] == "unknown" and v[3] not in ("", "unknown"):
            rows[k][3] = v[3]   # identity row with no transcript: keep the kind seen earlier
    os.makedirs(os.path.dirname(ATTRIBUTION_STATE) or ".", exist_ok=True)
    tmp = ATTRIBUTION_STATE + ".tmp"
    with open(tmp, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(ATTRIBUTION_COLS)
        w.writerows(rows.values())
    os.replace(tmp, ATTRIBUTION_STATE)
    print(f"    session attribution    {len(rows):8d} sessions ({kept} kept from earlier runs "
          f"whose transcripts are gone) -> {ATTRIBUTION_STATE}")


if __name__ == "__main__":
    main()
