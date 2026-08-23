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
    # RESOLVE `rill` BEFORE KILLING THE ONE THAT IS RUNNING. This block used to pkill first
    # and discover the binary was unreachable afterwards, which turns a recoverable PATH
    # problem into an outage: the old server is gone, the new one never starts, and the plugin
    # tab reads nothing until a human runs this by hand. Under launchd that ran hourly for 24
    # consecutive runs — /usr/local/bin, where Rill's installer puts the binary, was not on the
    # job's PATH. Fail here instead, with the snapshot already written and Rill still serving
    # the previous one, which is a strictly better place to stop.
    if ! command -v rill >/dev/null 2>&1; then
        echo "error: 'rill' not found on PATH — refusing to stop the running server" >&2
        echo "       PATH=$PATH" >&2
        echo "       install location is usually /usr/local/bin; if this is the launchd job," >&2
        echo "       add it to the plist and re-run: make refresh-agent-install" >&2
        exit 1
    fi
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
    # The HTTP port answers as soon as Rill's server starts, well before the models it serves
    # have finished reconciling — src_fct_pull_request alone took 31s on the full store. A fixed
    # sleep either wastes time on a small store or, on this one, is not long enough: check.sh
    # queried mid-reconcile, got a response with no "data" key, and its python parser raised an
    # uncaught KeyError that read as "refresh FAILED" with no indication the extract was fine.
    # Poll the actual reconcile state instead of guessing a duration.
    echo "==> waiting for models to reconcile"
    deadline=$(($(date +%s) + 90))
    while :; do
        pending=$(curl -s --max-time 5 "$ORIGIN/v1/instances/default/resources" | python3 -c '
import json, sys
try:
    resources = json.load(sys.stdin).get("resources", [])
except (json.JSONDecodeError, ValueError):
    print("unknown")
    sys.exit()
models = [r for r in resources if r.get("meta", {}).get("name", {}).get("kind") == "rill.runtime.v1.Model"]
if not models:
    print("unknown")
else:
    print(sum(1 for m in models if m["meta"].get("reconcileStatus") != "RECONCILE_STATUS_IDLE"))
' 2>/dev/null || echo "unknown")
        [[ "$pending" == "0" ]] && break
        if [[ "$pending" == "unknown" ]]; then
            echo "    could not read reconcile status from $ORIGIN — falling back to a fixed wait"
            sleep 15
            break
        fi
        if (($(date +%s) >= deadline)); then
            echo "    $pending model(s) still reconciling after 90s — checking anyway"
            break
        fi
        sleep 2
    done
    # Every Model resource reporting idle is not quite the same instant as Rill's DuckDB
    # catalog finishing its swap to the new schema generation — observed directly as
    # check.sh's own queries hitting "schema ... does not exist" catalog errors seconds after
    # this loop declared 0 pending, right after a full-store reconcile (all 27 models, not an
    # incremental one). check.sh no longer crashes on that (a failed query reports "no data in
    # response" and fails cleanly instead of raising), but there is no reason to invite the
    # race when a few seconds closes most of the window.
    sleep 3
fi

echo "==> 3/3 verify"
./check.sh
