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
    # A query against a model still mid-reconcile (or genuinely broken SQL) comes back without a
    # "data" row rather than as a query error — refresh.sh now waits for reconcile before calling
    # this, but report the actual response instead of letting python's KeyError read as an
    # unrelated crash if that wait was ever skipped or timed out.
    if ! ok=$(python3 -c 'import json,sys
d=json.load(sys.stdin)
rows=d.get("data")
print(rows[0]["ok"] if rows else "__missing__")' <<<"$out" 2>/dev/null) || [[ "$ok" == "__missing__" ]]; then
        printf '  FAIL  %-46s no "data" in response: %s\n' "$name" "$(head -c 200 <<<"$out")"
        FAILED=1
        return
    fi
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

# EMPTINESS CLAIMS EXPIRE, AND NOTHING ELSE NOTICES. Several documented facts here are
# assertions that a source table is empty or populated, and every one of them is a fact about
# UPSTREAM that becomes false without a signal reaching this repo. Measured cost on
# 2026-08-19: the note "`session_step_history` is zero rows" survived seven days past the
# table filling, was read three times as proof a per-step measurement was impossible, and
# nearly left an experiment blocked on a defect that had already resolved. Two claims are
# encoded here; when one fires, the failure IS the news — go update the prose that depends
# on it.
#
#   n_step_history_rows > 0   `fct_step_transition` is the real per-event ledger. If this
#                             drops to zero the extract or the upstream writer has broken.
#   n_step_decision_rows = 0  the human-gate metric is genuinely unmeasurable. The day this
#                             fires, it stops being unmeasurable — that is a good failure,
#                             and several documents claim otherwise.
assert "documented emptiness claims still hold" "
  SELECT n_step_history_rows > 0 AND n_step_decision_rows = 0 AS ok,
         'step_history ' || n_step_history_rows::VARCHAR || ' (want >0), step_decisions '
           || n_step_decision_rows::VARCHAR || ' (want 0)' AS detail
  FROM src__manifest"

# A DECLARED CEILING MUST BE AN OBSERVED ONE. `kandev_requests.config_epoch` labels each transcript
# by the environment it STARTED in, and `ceiling_declared` records what that environment claims about
# CLAUDE_CODE_AUTO_COMPACT_WINDOW. This asserts the claim against behaviour: an epoch declaring a 300K
# ceiling must show essentially no requests above it.
#
# It is the self-checking half of a hand-maintained boundary table, and it earns its place twice over.
# It catches (a) config changing without an ENV being minted — which happened unnoticed for three days
# from 2026-08-16 — and (b) the boundary table itself going stale as new ids are issued. On its first
# run it caught a third thing nobody was looking for: ENV-002 declared the ceiling from 11:02 and new
# processes did not observe it until ~16:00, so five hours of requests were labelled with a ceiling
# they never had. Cut at the observed boundary, not the declared one.
#
# 1% rather than 0%: a single request can cross mid-turn before auto-compact runs between turns.
assert "declared ceiling is an observed ceiling" "
  WITH e AS (
    SELECT config_epoch,
           COUNT(*) AS n,
           COUNT(*) FILTER (WHERE context_tokens > 300000) AS over
    FROM kandev_requests
    WHERE parent_transcript_session_id IS NULL AND ceiling_declared = '300K'
    GROUP BY 1 HAVING COUNT(*) >= 50)
  SELECT COALESCE(MAX(over * 1.0 / n) < 0.01, TRUE) AS ok,
         COALESCE(string_agg(config_epoch || ' ' || ROUND(100.0*over/n,1)::VARCHAR || '%', ', '),
                  'no epoch declares a ceiling yet') AS detail
  FROM e"

# THE EPOCH CUT MUST REACH EVERY SESSION, OR IT SILENTLY BECOMES A SAMPLE.
# `kandev_config_epoch` is what lets every other model exclude a retired environment, and its whole
# value is that it covers the store. A session it cannot bind is not merely missing a label — it
# drops out of any filtered total while still appearing in the unfiltered one, which is the exact
# shape of error the model was built to stop.
assert "every session binds to an environment" "
  SELECT COUNT(*) FILTER (WHERE config_epoch = '(unbound)') = 0 AS ok,
         COUNT(*)::VARCHAR || ' sessions, '
           || COUNT(*) FILTER (WHERE epoch_basis = 'transcript')::VARCHAR || ' by transcript, '
           || COUNT(*) FILTER (WHERE epoch_basis = 'session start')::VARCHAR || ' by session start, '
           || COUNT(*) FILTER (WHERE config_epoch = '(unbound)')::VARCHAR || ' unbound' AS detail
  FROM kandev_config_epoch"

# THE DUPLICATED BOUNDARY TABLE MUST STAY IN STEP, AND THE FALLBACK KEY MUST STAY A FALLBACK.
# The boundaries live in two files (see the header of kandev_config_epoch.yaml). This is the
# assertion that makes that duplication safe: on every session both keys reach, they must agree —
# or differ only in the one direction physics allows, transcript first and session row after.
#
# An INVERSION (session stamped before its own transcript opened) means the fallback is no longer a
# proxy for spawn time, and every ENV-007 figure in the project rests on the fallback because no
# transcript in that environment was ever captured. That is what this catches.
assert "epoch bases agree, and differ only forward" "
  WITH d AS (SELECT * FROM kandev_config_epoch WHERE epoch_agreement IN ('agree','differs'))
  SELECT COUNT(*) FILTER (WHERE epoch_agreement = 'differs' AND transcript_at >= session_at) = 0 AS ok,
         COUNT(*) FILTER (WHERE epoch_agreement = 'agree')::VARCHAR || '/' || COUNT(*)::VARCHAR
           || ' agree, ' || COUNT(*) FILTER (WHERE epoch_agreement = 'differs')::VARCHAR
           || ' differ (transcript earlier), '
           || COUNT(*) FILTER (WHERE epoch_agreement = 'differs' AND transcript_at >= session_at)::VARCHAR
           || ' inverted' AS detail
  FROM d"

# SPEND MUST BE REACHABLE BY THE CUT. A cost event whose session is not in the epoch model
# disappears the moment anyone filters on environment, and reappears when they do not — so the
# filtered and unfiltered totals disagree for a reason that looks like the filter working.
assert "all Kandev spend is reachable by the epoch cut" "
  WITH c AS (
    SELECT SUM(k.cost_subcents)/10000.0 AS total,
           SUM(k.cost_subcents) FILTER (WHERE e.session_id IS NULL)/10000.0 AS orphan
    FROM kandev_cost k
    LEFT JOIN kandev_config_epoch e ON e.session_id = k.session_id
    WHERE k.workspace = 'Kandev')
  SELECT COALESCE(orphan, 0) < 0.01 AS ok,
         '\$' || round(total,2)::VARCHAR || ' total, \$' || round(COALESCE(orphan,0),2)::VARCHAR
           || ' on sessions with no epoch' AS detail
  FROM c"

# Cost must reconcile between the step-grain model and its source, or the step table is
# quietly describing a subset.
assert "step diagnostics reconcile to kandev_cost" "
  SELECT abs(a - b) < 0.01 AS ok, 'diagnostics \$' || round(a,2)::VARCHAR || ' vs source \$' || round(b,2)::VARCHAR AS detail
  FROM (SELECT (SELECT SUM(cost_subcents)/10000.0 FROM kandev_step_diagnostics) AS a,
               (SELECT SUM(cost_subcents)/10000.0 FROM kandev_cost WHERE step_attributed='yes') AS b)"

# ---------------------------------------------------------------------------------------
# STEP ATTRIBUTION. Four assertions, all guarding the same regression from different sides.
#
# The bug they exist for: `kandev_cost` used to resolve every event's step from the billing
# window, read off the SESSION's own step timeline. `session_step_history` records the step a
# session SIGNALS A MOVE INTO, not the step it works — so on a workflow that runs different
# steps under different agent profiles, a session parks on a label another session is
# executing and its next wake bills there. It read `Build $21.93, sonnet + opus[1m]` on a card
# whose Build ran Sonnet only for $15.02, while Review — the step that spent every one of
# those Opus dollars — read $12.08 of sonnet and Create PR disappeared from the panel.
# 25.4% of post-cutover dollars were on the wrong step. The fix is to prefer each event's turn
# stamp; the window rule survives only for events with no turn_id, which cannot be repaired.
#
# None of this throws. Every wrong number renders perfectly, which is why it needs assertions.
# ---------------------------------------------------------------------------------------

# The stamp must actually be reaching the model. If the extract stops emitting `turn_id` or
# `step_at_start` — a column drop, a rename, a join that silently misses — attribution
# degrades all the way back to the window rule and NOTHING else fails. The panel just quietly
# starts lying again. Phrased as a floor rather than an exact figure so ordinary new spend
# does not trip it; it was 100% of post-cutover events when written.
# COALESCE GOES INSIDE THE SUM, NOT AROUND THE COMPARISON. A filtered SUM returns NULL, not
# zero, when nothing matches — so the obvious phrasing, COALESCE(ratio >= 0.95, TRUE), reports
# PASS in exactly the case this assertion exists for: the extract stops emitting turn_id, no
# row is a turn stamp, the ratio is NULL and the fallback calls it fine. That false pass was
# observed here, not theorised. Only a genuinely empty post-cutover window may excuse this.
#
# Keep SQL comments OUT of these double-quoted assert strings: the shell substitutes anything
# in backticks before sqlite ever sees it.
assert "post-cutover spend is attributed by turn stamp" "
  WITH e AS (SELECT * FROM kandev_cost WHERE occurred_at >= TIMESTAMP '2026-08-16 15:00:00'
                                         AND step_attributed = 'yes')
  SELECT CASE WHEN SUM(cost_subcents) IS NULL THEN TRUE
              ELSE COALESCE(SUM(cost_subcents) FILTER (WHERE step_attribution_basis = 'turn stamp'), 0)
                     / NULLIF(SUM(cost_subcents), 0)::DOUBLE >= 0.95 END AS ok,
         CASE WHEN SUM(cost_subcents) IS NULL THEN 'no post-cutover spend in snapshot'
              ELSE round(100.0 * COALESCE(SUM(cost_subcents)
                     FILTER (WHERE step_attribution_basis = 'turn stamp'), 0)
                     / SUM(cost_subcents), 1)::VARCHAR || '% of \$'
                   || round(SUM(cost_subcents)/10000.0, 2)::VARCHAR || ' by stamp' END AS detail
  FROM e"

# THE CROSS-SESSION LEAK ITSELF, stated directly: spend may only be attributed to a step that
# the session which incurred it actually ran a turn in. This is the assertion that would have
# caught the original bug on its own — every one of those Opus-dollars-on-Build rows names a
# step whose owning session never ran a turn there.
#
# Restricted to the turn_id era because pre-cutover rows are known to violate it and cannot be
# fixed; leaving them in would make this permanently red and therefore ignored.
assert "no spend is billed to a step its session never worked" "
  WITH e AS (
      SELECT c.cost_event_id, c.session_id, c.step_at_event, c.cost_subcents
      FROM kandev_cost c
      WHERE c.step_attributed = 'yes'
        AND c.occurred_at >= TIMESTAMP '2026-08-16 15:00:00'
  ),
  ran AS (SELECT DISTINCT session_id, step_at_start AS step FROM src_fct_turn
           WHERE step_at_start IS NOT NULL)
  SELECT COUNT(*) FILTER (WHERE r.step IS NULL) = 0 AS ok,
         COUNT(*) FILTER (WHERE r.step IS NULL)::VARCHAR || ' leaked events, \$'
           || COALESCE(round(SUM(e.cost_subcents) FILTER (WHERE r.step IS NULL)/10000.0, 2), 0)::VARCHAR
           || ' of \$' || round(SUM(e.cost_subcents)/10000.0, 2)::VARCHAR AS detail
  FROM e LEFT JOIN ran r ON r.session_id = e.session_id AND r.step = e.step_at_event"

# MONEY IS CONSERVED. Changing how an event is LABELLED must never change how much there is.
# A join that fans out — two turn rows for one turn_id, say — would double-count spend while
# every per-step figure still looked plausible.
assert "attribution moves no money" "
  SELECT a = b AND c = 0 AS ok,
         'model \$' || round(a/10000.0,2)::VARCHAR || ' vs source \$' || round(b/10000.0,2)::VARCHAR
           || ', ' || c::VARCHAR || ' duplicated events' AS detail
  FROM (SELECT (SELECT SUM(cost_subcents) FROM kandev_cost)          AS a,
               (SELECT SUM(cost_subcents) FROM src_fct_cost_event)   AS b,
               (SELECT COUNT(*) FROM (SELECT cost_event_id FROM kandev_cost
                  GROUP BY 1 HAVING COUNT(*) > 1))                   AS c)"

# The multi-profile workflows are the population this bug lived in, so keep them visible: if
# the store stops containing any, these assertions have stopped testing the thing they exist
# for and the next regression will pass unnoticed.
assert "multi-profile cards are still in the snapshot" "
  WITH m AS (SELECT task_id FROM src_dim_session WHERE agent_profile <> '(none)'
              GROUP BY 1 HAVING COUNT(DISTINCT agent_profile) > 1)
  SELECT COUNT(*) > 0 AS ok,
         COUNT(*)::VARCHAR || ' cards ran more than one agent profile' AS detail
  FROM m"

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
         SUM(cost_subcents) FILTER (WHERE step_attribution_basis IN ('turn stamp', 'window sat in one step'))
               / NULLIF(SUM(cost_subcents), 0)::DOUBLE             AS clean_attr
  FROM kandev_cost WHERE step_attributed = 'yes'
  GROUP BY 1 ORDER BY cost_usd DESC" | python3 -c '
import json, sys
resp = json.load(sys.stdin)
rows = resp.get("data")
if rows is None:
    print("  (query failed: {})".format(str(resp.get("message", resp))[:150]))
    rows = []
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
resp = json.load(sys.stdin)
rows = resp.get("data")
if rows is None:
    print("  (query failed: {})".format(str(resp.get("message", resp))[:150]))
    rows = []
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
resp = json.load(sys.stdin)
rows = resp.get("data")
if rows is None:
    print("  (query failed: {})".format(str(resp.get("message", resp))[:150]))
    rows = []
print("  {:<18}{:>9}{:>8}{:>11}{:>10}".format("step", "episodes", "checks", "wall time", "med gap"))
for r in rows:
    print("  {:<18}{:>9}{:>8}{:>10,.1f}h{:>9,.0f}s".format(
        str(r["step"])[:17], r["episodes"], r["checks"], r["hrs"] or 0, r["med_gap_s"] or 0))'

echo
[[ $FAILED -eq 0 ]] || { echo "ASSERTIONS FAILED"; exit 1; }
