#!/usr/bin/env bash
#
# Kandev operational telemetry -> CSV, for the Rill project one directory up.
#
# Run from anywhere:  ./extract/extract.sh
# Point at another store:  KANDEV_DB=/path/to/kandev.db ./extract/extract.sh
#
# Two things this does that a plain `sqlite3 kandev.db < extract.sql` does not:
#
#  1. It reads a `.backup` SNAPSHOT, never the live file. Kandev is usually running when
#     you want the numbers, and it keeps a multi-megabyte WAL open. `.backup` is the
#     supported way to get a consistent read out from under a live writer; copying the file
#     is not, and a half-copied WAL fails in ways that look like missing data rather than
#     like an error. The Rill project reads only the CSVs, so it is never pointed at the
#     live database at all.
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
sqlite3 "$KANDEV_DB" ".backup '$WORK/snapshot.db'"
printf '    %s\n' "$(du -h "$WORK/snapshot.db" | cut -f1) snapshot taken"

echo "==> extracting"
mkdir -p "$WORK/data"
( cd "$WORK" && sqlite3 snapshot.db < "$PROJECT_DIR/extract/extract.sql" )

# Promote only if every expected file arrived. A missing file here means extract.sql
# failed partway, and a partial promotion is the failure mode worth engineering against.
EXPECTED=(dim_task.csv dim_workflow_step.csv dim_session.csv fct_turn.csv fct_cost_event.csv fct_pull_request.csv fct_git_snapshot.csv fct_plan_revision.csv fct_message.csv _manifest.csv)
for f in "${EXPECTED[@]}"; do
    [[ -s "$WORK/data/$f" ]] || { echo "error: extract produced no $f — not promoting" >&2; exit 1; }
done

mkdir -p "$DATA_DIR"
for f in "${EXPECTED[@]}"; do
    mv "$WORK/data/$f" "$DATA_DIR/$f"
done

echo "==> wrote $DATA_DIR"
for f in "${EXPECTED[@]}"; do
    # -1 for the header row.
    printf '    %-22s %8d rows\n' "$f" "$(($(wc -l < "$DATA_DIR/$f") - 1))"
done

echo
echo "Next:  rill start $PROJECT_DIR"
