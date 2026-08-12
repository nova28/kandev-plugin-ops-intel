#!/usr/bin/env bash
#
# Re-snapshot, reload, verify. The whole weekly habit in one command.
#
# WHY THIS IS A SCRIPT AND NOT A NOTE IN A DOCUMENT. Almost every open question about this
# store is limited by sample size rather than by missing columns — 18 pull requests, 12 merged,
# 2 closed unmerged. Several findings are "a signal to go measure properly" purely because the
# n is small, and the only thing that fixes that is the extract running again. A habit that
# needs three commands in the right order, one of which is a Rill restart people forget, is a
# habit that lapses. This is one command.
#
# Rill does NOT hot-reload the CSVs, and a schema change (a new column in the extract) needs a
# restart even when it does notice new rows. Restarting is therefore part of the refresh, not
# an optional extra.
#
#   ./refresh.sh          re-extract, restart Rill, run check.sh
#   ./refresh.sh --no-restart   re-extract and check against whatever Rill already has
#
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ORIGIN="${RILL_ORIGIN:-http://localhost:9009}"
KANDEV_ORIGIN="${KANDEV_ORIGIN:-http://localhost:8817}"

echo "==> 1/3 extract"
./extract/extract.sh

if [[ "${1:-}" == "--no-restart" ]]; then
    echo "==> 2/3 restart skipped (--no-restart); Rill may be serving the previous snapshot"
else
    echo "==> 2/3 restart Rill"
    pkill -f "rill start" 2>/dev/null || true
    # Wait for BOTH ports. Rill's gRPC port (49009) lingers after the HTTP port frees, and
    # starting into it fails with "port in use" in a way that reads like a Rill bug.
    for _ in $(seq 1 30); do
        if ! lsof -ti :9009 >/dev/null 2>&1 && ! lsof -ti :49009 >/dev/null 2>&1; then break; fi
        sleep 1
    done
    # --allowed-origins is what lets the Kandev plugin tab READ a response rather than an
    # opaque one; without it the tab still works but its workspace filter applies unverified.
    nohup rill start . --no-open --allowed-origins "$KANDEV_ORIGIN" > /tmp/rill-refresh.log 2>&1 &
    for _ in $(seq 1 60); do
        [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$ORIGIN/" || true)" == "200" ]] && break
        sleep 1
    done
    # Models are materialized on first reconcile; querying before that returns empty tables
    # rather than an error, which would make check.sh report a false failure.
    sleep 15
fi

echo "==> 3/3 verify"
./check.sh
