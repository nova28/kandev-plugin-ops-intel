#!/usr/bin/env bash
#
# Kandev operational telemetry -> CSV, for the Rill project one directory up.
#
# Run from anywhere:  ./extract/extract.sh
# Point at another store:  KANDEV_DB=/path/to/kandev.db ./extract/extract.sh
#
# Two things this does that a plain `sqlite3 kandev.db < extract.sql` does not:
#
#  1. It reads a SNAPSHOT, never the live file. Kandev is usually running when you want the
#     numbers, and it keeps a multi-megabyte WAL open; copying the file is not supported and a
#     half-copied WAL fails in ways that look like missing data rather than like an error. The
#     Rill project reads only the CSVs, so it is never pointed at the live database at all.
#
#     THE SNAPSHOT IS `VACUUM INTO`, NOT `.backup`, and the difference is not a micro-
#     optimisation. `.backup` uses SQLite's online-backup API, which RESTARTS the page copy
#     whenever the source is written. On a ~700 MB store with Kandev actively writing, a
#     measured run reached 437 MB in 29 minutes and was still slowing — 2 MB/min and falling,
#     i.e. it does not converge while agents are running. `VACUUM INTO` takes one read
#     transaction and writes a compacted copy in a single pass: the same store, 669 MB,
#     **6.5 seconds**. That is the difference between an hourly unattended refresh and a job
#     that can never finish one. Do not switch this back.
#
#  2. It refuses to leave a partial extract in place. A failed run that had already written
#     three of five CSVs would leave the dashboard silently mixing two snapshots, so the
#     write goes to a staging directory and is promoted only once every file exists.
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KANDEV_DB="${KANDEV_DB:-$HOME/.kandev/data/kandev.db}"
DATA_DIR="$PROJECT_DIR/data"

if [[ ! -f "$KANDEV_DB" ]]; then
    echo "error: no Kandev store at $KANDEV_DB" >&2
    echo "       set KANDEV_DB=/path/to/kandev.db if yours lives elsewhere" >&2
    exit 1
fi

# WHICH sqlite3 MATTERS. macOS ships /usr/bin/sqlite3 built with a low function-argument limit, and
# Kandev v0.94 (2026-09-17) added a trigger calling json_object() with 11 arguments. That CLI cannot
# parse the schema at all and reports "database disk image is malformed" — on a store that passes
# PRAGMA quick_check. Prefer Homebrew's build; SQLITE3=/path overrides.
if [[ -z "${SQLITE3:-}" ]]; then
    for c in /opt/homebrew/opt/sqlite/bin/sqlite3 /usr/local/opt/sqlite/bin/sqlite3 sqlite3; do
        command -v "$c" >/dev/null && { SQLITE3="$c"; break; }
    done
fi
command -v "${SQLITE3:-}" >/dev/null || { echo "error: sqlite3 not found (set SQLITE3=/path)" >&2; exit 1; }
sqlite3() { "$SQLITE3" "$@"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> snapshotting $KANDEV_DB"
# VACUUM INTO refuses to overwrite, so the target must not exist — mktemp -d gives an empty
# directory, but say so rather than relying on it.
rm -f "$WORK/snapshot.db"
snap_started=$(date +%s)
sqlite3 "$KANDEV_DB" "VACUUM INTO '$WORK/snapshot.db'"
printf '    %s snapshot taken in %ss\n' \
    "$(du -h "$WORK/snapshot.db" | cut -f1)" "$(($(date +%s) - snap_started))"

echo "==> extracting"
mkdir -p "$WORK/data"
( cd "$WORK" && sqlite3 snapshot.db < "$PROJECT_DIR/extract/extract.sql" )

# THE SECOND SOURCE. Claude Code's own transcripts carry a per-REQUEST grain the Kandev store
# does not have at all — context size, reads split from writes, and what a tool result cost
# the requests that came after it. See extract_requests.py for why none of that is recoverable
# downstream from cost events.
#
# It may fail WITHOUT failing the run, and that asymmetry is deliberate. The eleven CSVs above
# are this project's backbone; transcripts are optional and machine-specific (another host may
# have none, or the agent may not be Claude Code at all). Taking the whole dashboard down
# because an optional second source was unavailable would be the wrong trade. The request
# models carry `usage_basis` so absence reads as "not observable" rather than as zero cost.
echo "==> extracting request grain (Claude Code transcripts)"
# Session attribution is state, not output: kept across runs because transcripts are not.
ATTRIBUTION_STATE="${ATTRIBUTION_STATE:-$PROJECT_DIR/state/session_attribution.csv}"
requests_ok=1
if ! ATTRIBUTION_STATE="$ATTRIBUTION_STATE" python3 "$PROJECT_DIR/extract/extract_requests.py" "$WORK/data"; then
    echo "    warning: request extract failed — promoting the rest without it" >&2
    rm -f "$WORK/data/fct_request.csv" "$WORK/data/fct_tool_call.csv"
    requests_ok=0
fi

# THE THIRD SOURCE. The claude-telemetry-collector store holds what the AGENT saw, which is
# neither what Kandev recorded nor what the transcripts carry: cost split by query_source
# (main / subagent / auxiliary), the cache token split, and the only compaction and
# skill-activation signals Claude Code emits at all. See extract-telemetry.sql's header for
# the join key and why it needs guarding.
#
# Optional on the same terms as the transcript source above: another host may run no
# collector, or run a different agent entirely. It is read live rather than snapshotted —
# a VACUUM INTO of a 5.7 GB store on every refresh would dominate a cadence measured in
# minutes — so it opens read-only with a busy timeout and contends politely with the
# collector's own writes.
echo "==> extracting agent telemetry (OTLP collector)"
TELEMETRY_DB="${TELEMETRY_DB:-$HOME/Library/Application Support/claude-telemetry/metrics.db}"
TELEMETRY_CSVS=(fct_agent_session.csv fct_agent_session_day.csv fct_agent_session_event.csv fct_agent_span.csv)
if [[ -f "$TELEMETRY_DB" ]]; then
    # A file: URI is the only way to ask for mode=ro, and the default path contains spaces.
    TELEMETRY_URI="file:${TELEMETRY_DB// /%20}?mode=ro"
    # `.read` rather than a stdin redirect: sqlite3 given ANY command argument executes only
    # the arguments and ignores stdin, so `sqlite3 db ".timeout N" < file.sql` runs the timeout,
    # reads nothing, and exits 0. That failure is completely silent — it produced no CSVs and no
    # error on the first run of this block.
    #
    # Retried, because one busy timeout is not enough: the store runs in rollback-journal mode, so
    # a reader is refused while the collector holds its write lock, and the collector commits
    # continuously. A single attempt hit `database is locked (5)` on 2026-09-16 and the telemetry
    # tables silently stayed at 2026-09-15. Partial CSVs are discarded per attempt so a retry
    # never mixes rows from two reads.
    #
    # SESSION -> CARD ATTRIBUTION, handed to the SQL as an id-only CSV. The collector knows a
    # session's directory only while its session file is live under a config dir it syncs; it
    # missed ~/.claude-kandev from 2026-09-01 until 2026-09-17, so thousands of Kandev sessions have
    # telemetry and no usable `sessions` row. extract_requests.py resolves each Claude session to a
    # card — by Kandev's recorded agent session id first, transcript paths second — and merges the
    # result into $ATTRIBUTION_STATE, which outlives the transcripts it came from. Copied beside
    # snapshot.db, never under data/, so it is not promoted.
    #
    # LOUD WHEN THIN. If the request extract failed this run, the stored state still carries every
    # earlier session, so the fallback degrades to "stale" rather than "empty" — but say so. With no
    # state at all, thousands of sessions would drop out of the telemetry tables and the totals
    # would read as a quiet week.
    if [[ -s "$ATTRIBUTION_STATE" ]]; then
        cp "$ATTRIBUTION_STATE" "$WORK/session_attribution.csv"
        [[ $requests_ok -eq 1 ]] || echo "    WARNING: request extract failed — telemetry attribution uses stored state from $(date -r "$ATTRIBUTION_STATE" '+%Y-%m-%d %H:%M')" >&2
    else
        echo "    WARNING: no session attribution state at $ATTRIBUTION_STATE — telemetry sessions without a collector cwd will be DROPPED" >&2
        echo "session_id,task_id,kandev_task_count,workspace_kind,is_kandev_task,attribution_source,last_seen" > "$WORK/session_attribution.csv"
    fi
    telemetry_ok=0
    for attempt in 1 2 3; do
        if ( cd "$WORK" && sqlite3 "$TELEMETRY_URI" \
                 ".timeout 30000" \
                 ".read $PROJECT_DIR/extract/extract-telemetry.sql" ); then
            telemetry_ok=1
            break
        fi
        for f in "${TELEMETRY_CSVS[@]}"; do rm -f "$WORK/data/$f"; done
        if [[ $attempt -lt 3 ]]; then
            echo "    telemetry extract failed (attempt $attempt/3) — retrying in 20s" >&2
            sleep 20
        fi
    done
    if [[ $telemetry_ok -eq 0 ]]; then
        echo "    warning: telemetry extract failed after 3 attempts — promoting the rest without it" >&2
    fi
    # Exit status is not enough, per the above: assert the files exist. An optional source may
    # legitimately be absent, but it must not be absent while claiming to have succeeded.
    for f in "${TELEMETRY_CSVS[@]}"; do
        [[ -s "$WORK/data/$f" ]] || echo "    warning: telemetry extract produced no $f" >&2
    done
else
    echo "    no collector store at $TELEMETRY_DB — skipping"
fi

# Promote only if every expected file arrived. A missing file here means extract.sql
# failed partway, and a partial promotion is the failure mode worth engineering against.
EXPECTED=(dim_task.csv dim_workflow_step.csv fct_step_transition.csv dim_session.csv fct_turn.csv fct_cost_event.csv fct_pull_request.csv fct_git_snapshot.csv fct_plan_revision.csv fct_message.csv _manifest.csv)
# Promoted when present, absent without complaint when not — see above.
OPTIONAL=(fct_request.csv fct_tool_call.csv fct_agent_session.csv fct_agent_session_day.csv fct_agent_session_event.csv fct_agent_span.csv)
for f in "${EXPECTED[@]}"; do
    [[ -s "$WORK/data/$f" ]] || { echo "error: extract produced no $f — not promoting" >&2; exit 1; }
done

mkdir -p "$DATA_DIR"
for f in "${EXPECTED[@]}"; do
    mv "$WORK/data/$f" "$DATA_DIR/$f"
done
for f in "${OPTIONAL[@]}"; do
    [[ -s "$WORK/data/$f" ]] && mv "$WORK/data/$f" "$DATA_DIR/$f"
done

echo "==> wrote $DATA_DIR"
for f in "${EXPECTED[@]}" "${OPTIONAL[@]}"; do
    # -1 for the header row.
    [[ -s "$DATA_DIR/$f" ]] && \
        printf '    %-22s %8d rows\n' "$f" "$(($(wc -l < "$DATA_DIR/$f") - 1))"
done

echo
echo "Next:  rill start $PROJECT_DIR"
