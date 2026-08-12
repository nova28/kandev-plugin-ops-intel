#!/usr/bin/env bash
#
# Integrity assertions + the canonical baseline metric set, against a running Rill.
#
# WHY THIS EXISTS. Two of this project's numbers are reconstructions, not readings: per-step
# cost is attributed by window ownership, and code output is a LAG delta over a cumulative
# column guarded against re-bases. Both were validated once, by hand, in a conversation. A
# validation that lives in a conversation is not a validation — it cannot be re-run after the
# next extract, and the next extract is exactly when it would break.
#
# It also prints the baseline metric set, so "did that workflow change help" is a diff of two
# runs of one command rather than an argument about which numbers were quoted.
#
#   ./check.sh              assertions + baseline
#   ./check.sh --baseline   baseline only
#
# Requires Rill running (rill start . --allowed-origins http://localhost:8817).
set -euo pipefail

RILL="${RILL_ORIGIN:-http://localhost:9009}"
INSTANCE="${RILL_INSTANCE:-default}"

q() { # q <sql> -> JSON rows
    curl -s --max-time 60 -X POST "$RILL/v1/instances/$INSTANCE/query" \
        -H 'Content-Type: application/json' \
        --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"sql": sys.stdin.read()}))' <<<"$1")"
}

curl -s -o /dev/null --max-time 5 "$RILL/" || { echo "error: no Rill at $RILL" >&2; exit 1; }

FAILED=0
assert() { # assert <name> <sql returning ok BOOLEAN and detail VARCHAR>
    local name="$1" out ok detail
    out=$(q "$2")
    ok=$(python3 -c 'import json,sys; d=json.load(sys.stdin)["data"][0]; print(d["ok"])' <<<"$out")
    detail=$(python3 -c 'import json,sys; d=json.load(sys.stdin)["data"][0]; print(d.get("detail",""))' <<<"$out")
    if [[ "$ok" == "True" || "$ok" == "true" ]]; then
        printf '  PASS  %-46s %s\n' "$name" "$detail"
    else
        printf '  FAIL  %-46s %s\n' "$name" "$detail"; FAILED=1
    fi
}

if [[ "${1:-}" != "--baseline" ]]; then
echo "== integrity assertions =="

# The code-output delta must reconstruct each session's final cumulative diffstat. A session may
# legitimately differ ONLY if it rewound (rebase/reset drops the cumulative figure). A session
# that differs without a rewind means the LAG logic or the base-commit guard is broken.
assert "code deltas reconstruct cumulative totals" "
  WITH d AS (SELECT session_id, SUM(lines_added) AS s, SUM(is_rewind) AS rw, SUM(is_base_change) AS bc
             FROM kandev_code_output GROUP BY 1),
       f AS (SELECT session_id, MAX(branch_additions) AS m FROM src_fct_git_snapshot GROUP BY 1),
       j AS (SELECT d.*, f.m FROM d JOIN f USING (session_id))
  SELECT COUNT(*) FILTER (WHERE s <> m AND rw = 0 AND bc = 0) = 0 AS ok,
         COUNT(*) FILTER (WHERE s = m)::VARCHAR || '/' || COUNT(*)::VARCHAR
           || ' exact, ' || COUNT(*) FILTER (WHERE s <> m AND (rw > 0 OR bc > 0))::VARCHAR
           || ' differ with a rewind or base change' AS detail
  FROM j"

# No single snapshot delta may exceed the entire store's output. A re-based branch produced
# +440,418 lines in one delta before the base-commit guard existed; this is the tripwire for
# that class of defect returning.
assert "no single delta dominates the store" "
  SELECT MAX(lines_added) < SUM(lines_added) * 0.5 AS ok,
         'largest single delta ' || MAX(lines_added)::VARCHAR || ' of ' || SUM(lines_added)::VARCHAR AS detail
  FROM kandev_code_output"

# The wait classifier must not drift back to leading-token matching. `echo`/`cat` commands are
# overwhelmingly heredocs and file writes; only the handful that actually contain a sleep
# (`echo waiting; sleep 240; echo done`) are waits, and those SHOULD count. The guard is
# therefore a share, not a zero: the old classifier scored ~100% of echo-led commands as
# polling, this one scores about 1%. A regression shows up as this share jumping.
assert "wait classifier is not leading-token matching" "
  SELECT COUNT(*) FILTER (WHERE is_wait_poll) < COUNT(*) * 0.10 AS ok,
         COUNT(*) FILTER (WHERE is_wait_poll)::VARCHAR || ' of ' || COUNT(*)::VARCHAR
           || ' echo/cat-led commands counted as waiting' AS detail
  FROM kandev_activity WHERE message_type = 'tool_execute' AND lower(tool_name) IN ('echo','cat')"

# Cost must reconcile between the step-grain model and its source, or the step table is
# quietly describing a subset.
assert "step diagnostics reconcile to kandev_cost" "
  SELECT abs(a - b) < 0.01 AS ok, 'diagnostics \$' || round(a,2)::VARCHAR || ' vs source \$' || round(b,2)::VARCHAR AS detail
  FROM (SELECT (SELECT SUM(cost_subcents)/10000.0 FROM kandev_step_diagnostics) AS a,
               (SELECT SUM(cost_subcents)/10000.0 FROM kandev_cost WHERE step_attributed='yes') AS b)"

# Outcomes must cover all card-attributed spend; the only permitted gap is deleted-card spend.
assert "outcomes coverage gap is deleted-card spend only" "
  SELECT abs((a - b) - c) < 0.01 AS ok,
         'gap \$' || round(a-b,2)::VARCHAR || ' vs deleted-card \$' || round(c,2)::VARCHAR AS detail
  FROM (SELECT (SELECT SUM(cost_subcents)/10000.0 FROM kandev_cost) AS a,
               (SELECT SUM(cost_subcents)/10000.0 FROM kandev_outcomes) AS b,
               (SELECT SUM(cost_subcents)/10000.0 FROM kandev_cost
                 WHERE cost_attribution <> 'attributed to a card') AS c)"
echo
fi

echo "== baseline =="

q "
  SELECT step_at_event AS step,
         round(SUM(cost_subcents)/10000.0, 2)                       AS cost_usd,
         SUM(tokens_input_total) / NULLIF(SUM(tokens_out), 0)       AS in_per_out,
         SUM(cost_subcents) FILTER (WHERE step_attribution_basis = 'window sat in one step')
               / NULLIF(SUM(cost_subcents), 0)::DOUBLE             AS clean_attr
  FROM kandev_cost WHERE step_attributed = 'yes'
  GROUP BY 1 ORDER BY cost_usd DESC" | python3 -c '
import json, sys
rows = json.load(sys.stdin)["data"]
print("  {:<18}{:>10}{:>9}{:>12}".format("step", "cost", "in:out", "clean attr"))
for r in rows:
    print("  {:<18}{:>10,.2f}{:>9,.0f}{:>11,.0f}%".format(
        str(r["step"])[:17], r["cost_usd"] or 0, r["in_per_out"] or 0, (r["clean_attr"] or 0) * 100))'

echo
q "
  SELECT step_at_event AS step,
         COUNT(*) FILTER (WHERE is_wait_poll)                  AS waits,
         COUNT(*) FILTER (WHERE wait_kind = 'state check')     AS state_checks
  FROM kandev_activity GROUP BY 1
  HAVING COUNT(*) > 1000 ORDER BY state_checks DESC" | python3 -c '
import json, sys
rows = json.load(sys.stdin)["data"]
print("  {:<18}{:>8}{:>14}".format("step", "waits", "state checks"))
for r in rows:
    print("  {:<18}{:>8}{:>14}".format(str(r["step"])[:17], r["waits"] or 0, r["state_checks"] or 0))'

echo
# Polling cadence. This is the before/after measure for any change to how a step waits, so it
# belongs in the baseline rather than in a notebook: "did the deterministic waiter help" is
# `checks` and `episodes` moving, not a cost total moving (cost has no turn_id to attribute).
#
# Episodes partition by (session, step) — NOT session alone. Sessions span steps, so grouping
# by session lets one episode straddle two steps and be assigned to whichever ANY_VALUE picks;
# that inversion once made Create PR look like the heaviest polling step when it is PR Fixup.
# The 900s split is arbitrary but the RANKING is stable from 300s to 3600s.
q "
  WITH ev AS (
    SELECT session_id, step_at_event AS step, created_at,
           date_diff('second', LAG(created_at) OVER (PARTITION BY session_id, step_at_event
                                                     ORDER BY created_at), created_at) AS gap_s
    FROM kandev_activity WHERE wait_kind IS NOT NULL
  ), m AS (SELECT *, CASE WHEN gap_s IS NULL OR gap_s > 900 THEN 1 ELSE 0 END AS ne FROM ev),
  g AS (SELECT *, SUM(ne) OVER (PARTITION BY session_id, step ORDER BY created_at
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ep FROM m),
  e AS (SELECT session_id, step, ep, COUNT(*) AS checks,
               date_diff('second', MIN(created_at), MAX(created_at)) AS span FROM g GROUP BY 1,2,3)
  SELECT step, COUNT(*) AS episodes, SUM(checks) AS checks, SUM(span)/3600.0 AS hrs,
         MEDIAN(span*1.0/NULLIF(checks-1,0)) AS med_gap_s
  FROM e GROUP BY 1 HAVING SUM(checks) >= 25 ORDER BY checks DESC" | python3 -c '
import json, sys
rows = json.load(sys.stdin)["data"]
print("  {:<18}{:>9}{:>8}{:>11}{:>10}".format("step", "episodes", "checks", "wall time", "med gap"))
for r in rows:
    print("  {:<18}{:>9}{:>8}{:>10,.1f}h{:>9,.0f}s".format(
        str(r["step"])[:17], r["episodes"], r["checks"], r["hrs"] or 0, r["med_gap_s"] or 0))'

echo
[[ $FAILED -eq 0 ]] || { echo "ASSERTIONS FAILED"; exit 1; }
