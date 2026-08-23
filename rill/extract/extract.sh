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

command -v sqlite3 >/dev/null || { echo "error: sqlite3 not on PATH" >&2; exit 1; }

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
if ! python3 "$PROJECT_DIR/extract/extract_requests.py" "$WORK/data"; then
    echo "    warning: request extract failed — promoting the rest without it" >&2
    rm -f "$WORK/data/fct_request.csv" "$WORK/data/fct_tool_call.csv"
fi

# Promote only if every expected file arrived. A missing file here means extract.sql
# failed partway, and a partial promotion is the failure mode worth engineering against.
EXPECTED=(dim_task.csv dim_workflow_step.csv fct_step_transition.csv dim_session.csv fct_turn.csv fct_cost_event.csv fct_pull_request.csv fct_git_snapshot.csv fct_plan_revision.csv fct_message.csv _manifest.csv)
# Promoted when present, absent without complaint when not — see above.
OPTIONAL=(fct_request.csv fct_tool_call.csv)
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
