/**
 * The task ledger — spend for one card, laid out along the workflow steps it passed through.
 *
 * WHY THIS IS A FEATURE AND NOT A CHART. Kandev stores no step on a cost event, and a card's
 * `workflow_step_id` is where the card ended up, not where the money went. "Which part of my
 * process is expensive" is therefore unanswerable upstream and answerable here — which is
 * also exactly why the readout has to stay candid about the reconstruction it rests on.
 *
 * The file is split in two on purpose:
 *
 *   `ledgerQueries()`  builds SQL — a pure string function.
 *   `assembleLedger()` turns five result sets into one readout — pure, no I/O.
 *   `loadTaskLedger()` is the thin shell that runs one against the other.
 *
 * The two pure halves carry every decision worth getting wrong (step ordering, the
 * unattributed bucket, the off-ledger roll-up, degraded reads) and are unit-tested directly.
 */

import { COST_MODEL, ACTIVITY_MODEL, TURNS_MODEL, STEPS_MODEL } from "./config.mjs";
import { sqlQuote, isUnattributed } from "./format.mjs";
import { rillQuery } from "./rill.mjs";

/**
 * FIVE QUERIES AND NOT ONE. Each answers an independent question against a different model,
 * and each degrades on its own: lose the timing query and the rail still shows money; lose
 * the peer query and the total still shows. One giant CTE would make every part fail
 * together, and would be far harder to read against the definitions in rill/models/.
 *
 * Returns them in the order `assembleLedger` expects.
 */
export function ledgerQueries(taskId) {
  var id = sqlQuote(taskId);

  // Spend, by step and by model. `cost_subcents` is the only trustworthy money grain here.
  //
  // `step_attribution_basis` comes along because a step label is not always a fact. A cost
  // event bills the window since the previous event, and a window that spanned several steps
  // is labelled with the step that held most of it — a majority verdict. The model publishes
  // which case each row is; hiding that would present a verdict as a measurement.
  //
  // `agent_profile` is the ACCOUNT the spend billed to, and on a machine running several
  // accounts it is the dimension that decides whose bill this is. Two profiles can run the
  // same model — "1acc - Sonnet" and "Sonnet" are the same model and different money — so
  // the model alone cannot answer "which account paid for this card".
  var cost =
    "SELECT step_at_event AS step, model, agent_profile AS profile," +
    " step_attribution_basis LIKE 'dominant of%' AS is_verdict," +
    " agent_profile_basis LIKE 'inherited%' AS profile_inferred," +
    " sum(cost_subcents) AS subcents, count(*) AS events," +
    " min(occurred_at) AS first_at," +
    " sum(tokens_cached_in) AS cached_in, sum(tokens_in) AS fresh_in," +
    " sum(tokens_out) AS out_tokens," +
    " count(*) FILTER (WHERE token_basis = 'synthesized') AS synthesized_events" +
    " FROM " + COST_MODEL + " WHERE task_id = '" + id + "' GROUP BY 1, 2, 3, 4, 5";

  // Work handed to codex/agy. Real calls with NO cost row anywhere in this store — they bill
  // to a separate account. Counting them is the only way the panel can state how incomplete
  // its own total is. `model` is a best-effort label (see extract.sql), never a price — that
  // figure does not exist anywhere in this store for an off-ledger call.
  var external =
    "SELECT step_at_event AS step, external_agent AS agent, external_agent_model AS model," +
    " count(*) AS n" +
    " FROM " + ACTIVITY_MODEL + " WHERE task_id = '" + id + "'" +
    " AND is_external_agent_call GROUP BY 1, 2, 3";

  // Timing. Negative gaps are real in this store (overlapping turns) and are clamped to zero
  // rather than allowed to deflate a step's idle total.
  var timing =
    "SELECT step_at_event AS step, count(*) AS turns," +
    " sum(agent_seconds) AS agent_s," +
    " sum(CASE WHEN idle_seconds_before > 0 THEN idle_seconds_before ELSE 0 END) AS idle_s," +
    " min(started_at) AS first_at" +
    " FROM " + TURNS_MODEL + " WHERE task_id = '" + id + "' GROUP BY 1";

  // Peer position, scoped to this card's own workspace. A dollar figure alone is unreadable —
  // $271 means nothing until you know the median is $41 — and ranking against a different
  // workspace's economics would be worse than showing nothing.
  //
  // Orphaned rows are excluded on purpose: they belong to deleted cards and have no
  // card-level total to be ranked against.
  var peers =
    "WITH me AS (SELECT any_value(workspace) AS ws, any_value(task_title) AS title," +
    " any_value(task_state) AS state, any_value(workflow) AS workflow" +
    " FROM " + COST_MODEL + " WHERE task_id = '" + id + "')," +
    " per AS (SELECT c.task_id AS tid, sum(c.cost_subcents) AS s" +
    " FROM " + COST_MODEL + " c, me WHERE c.workspace = me.ws" +
    " AND c.cost_attribution = 'attributed to a card' GROUP BY 1)" +
    " SELECT (SELECT title FROM me) AS title, (SELECT ws FROM me) AS workspace," +
    " (SELECT state FROM me) AS state, (SELECT workflow FROM me) AS workflow," +
    " (SELECT median(s) FROM per) AS median_subcents," +
    " (SELECT max(s) FROM per) AS max_subcents," +
    " (SELECT count(*) FROM per) AS n_tasks," +
    " (SELECT s FROM per WHERE tid = '" + id + "') AS mine," +
    " (SELECT count(*) FROM per WHERE s > (SELECT s FROM per WHERE tid = '" + id + "')) + 1" +
    " AS rank_pos";

  // The workflow's DEFINED step order, so the rail reads down in the same sequence as the
  // step rail at the top of the task page. See the sort in assembleLedger for why this is
  // not optional.
  var order =
    "SELECT s.step AS step, min(s.step_position) AS pos" +
    " FROM " + STEPS_MODEL + " s" +
    " WHERE s.workflow IN (SELECT any_value(workflow) FROM " + COST_MODEL +
    " WHERE task_id = '" + id + "') GROUP BY 1";

  // Per-model turn time, for the throughput figure in the legend.
  //
  // This is a SEPARATE query from the per-step timing above and cannot be folded into it: that
  // one groups by step, and a turn's model and a cost event's step are not the same cut.
  var modelTiming =
    "SELECT model, sum(agent_seconds) AS secs, count(*) AS turns" +
    " FROM " + TURNS_MODEL + " WHERE task_id = '" + id + "' AND agent_seconds > 0 GROUP BY 1";

  // Is this card in the snapshot AT ALL?
  //
  // Without this the empty state cannot tell "the extract predates this card" from "this card
  // genuinely never billed anything", and the panel used to assert the first — sending the
  // reader off to re-run an extract that would change nothing. A card can run turns and still
  // bill nothing, and that is a fact about the card, not about the snapshot.
  var presence =
    "SELECT count(*) AS in_snapshot FROM src_dim_task WHERE task_id = '" + id + "'";

  // HOW OLD IS THE SNAPSHOT? The newest message in it, which is effectively when the extract
  // ran. Without this the empty state cannot tell "no agent has ever run on this card" from
  // "the agent started after the extract" — and it asserted the first, on a card whose agent
  // was running as it said so. Nothing in Rill knows the wall clock; only the caller does.
  var freshness = "SELECT max(created_at) AS last_activity FROM src_fct_message";

  // HOW THIS CARD'S PER-STEP SPLIT WAS RESOLVED, weighted by the money it moves.
  //
  // This used to report the card's step TIMELINE source (transition ledger vs message
  // stamps). That was the wrong question: the timeline is an input to the fallback, and a
  // card can have a perfect ledger and still have every figure on this rail inferred. What a
  // reader needs to know is whether the SPEND was attributed by reading each turn's own
  // stamp or by reconstructing which step owned a billing window — the second is what puts
  // Review's Opus dollars on a Sonnet-only Build row when a workflow runs steps under
  // different agent profiles. See models/kandev_cost.yaml.
  //
  // Weighted by subcents rather than counted by rows, because one inferred event carrying
  // most of a card is the case worth warning about and a row count would bury it.
  var stepSource =
    "SELECT" +
    " COALESCE(SUM(CASE WHEN step_attribution_basis = 'turn stamp'" +
    "   THEN cost_subcents ELSE 0 END), 0) AS stamped," +
    " COALESCE(SUM(CASE WHEN step_attribution_basis <> 'turn stamp'" +
    "   THEN cost_subcents ELSE 0 END), 0) AS inferred" +
    " FROM kandev_cost WHERE task_id = '" + id + "' AND step_attributed = 'yes'";

  return [cost, external, timing, peers, order, modelTiming, presence, freshness, stepSource];
}

// Below this much recorded agent time, a throughput figure is one or two turns' luck and is
// not shown at all. A rate is the kind of number that gets quoted; a noisy one is worse than
// none.
var MIN_RATE_SECONDS = 120;

/**
 * Output tokens per agent-second, per model.
 *
 * READ THIS AS THROUGHPUT, NOT DECODE SPEED. `agent_seconds` is the whole turn — tool calls,
 * shell commands and file reads included — so this is what the model delivered per second of
 * elapsed agent work, which is a much lower number than its generation rate and the more
 * useful one for comparing what a model actually costs in time.
 *
 * It also cannot be exact: cost events carry a turn_id only from 2026-08-16, and this join
 * has to cover the whole store, so tokens are matched to time through the model label both
 * sides happen to carry. Aggregate, not per-turn.
 */
export function modelRates(models, timingRows) {
  var secs = {};
  (timingRows || []).forEach(function (r) {
    if (r.model != null) secs[r.model] = Number(r.secs || 0);
  });
  return models.map(function (m) {
    var s = secs[m.model] || 0;
    return Object.assign({}, m, {
      agentS: s,
      tokPerSec: s >= MIN_RATE_SECONDS && m.out > 0 ? m.out / s : null,
    });
  });
}

/**
 * Five result sets in, one readout out. Pure — every argument is either an array of rows or
 * null, and null always means "could not read", never "no rows".
 */
export function assembleLedger(cost, external, timing, peers, order, modelTiming, presence,
                               freshness, stepSource) {
  var snapshotAt = freshness && freshness.length ? freshness[0].last_activity || null : null;
  var src = stepSource && stepSource.length ? stepSource[0] : null;
  // "stamp" | "inferred" | "mixed" | null. Mixed means a card whose spend straddles the
  // 2026-08-16 turn_id cutover; part of its rail is read and part reconstructed.
  //
  // A card with neither (no attributed spend at all) is null, not "stamp" — an empty sum is
  // not evidence of an exact reading.
  var stamped = src ? Number(src.stamped || 0) : 0;
  var inferred = src ? Number(src.inferred || 0) : 0;
  var stepBasis = !src || (!stamped && !inferred) ? null
    : stamped && inferred ? "mixed"
    : stamped ? "stamp"
    : "inferred";
  // The cost query decides whether the panel can say anything at all. A null answer means
  // the read was refused, not that the task was free.
  if (cost === null) return { state: "blocked" };

  // EMPTY IS THREE DIFFERENT FACTS, AND THEY HAVE DIFFERENT FIXES.
  //
  // This used to be one message that blamed the snapshot and told the reader to re-run the
  // extract. That is right for exactly one of the three cases and actively wastes their time
  // in the other two — a card can be fully present in the snapshot and still have billed
  // nothing, because cost events are flushed at a step transition and a session that has not
  // reached one yet has no cost row anywhere, live database included.
  if (!cost.length) {
    // Absent (undefined) is treated the same as unreadable (null): unknown. Guessing
    // "absent from the snapshot" is the one answer that sends the reader off to re-run an
    // extract, so it is never the fallback.
    var known = !presence || !presence.length
      ? null
      : Number(presence[0].in_snapshot || 0) > 0;
    var ranTurns = (timing || []).reduce(function (n, r) {
      return n + Number(r.turns || 0);
    }, 0);
    var extCalls = (external || []).reduce(function (n, r) {
      return n + Number(r.n || 0);
    }, 0);
    return {
      state: "empty",
      peers: (peers && peers[0]) || null,
      // null = unknown, true = the extract knows this card, false = the extract predates it.
      inSnapshot: known,
      turns: ranTurns,
      external: extCalls,
      snapshotAt: snapshotAt,
    };
  }

  var steps = {};
  function slot(name) {
    var key = isUnattributed(name) ? " unattributed" : name;
    if (!steps[key]) {
      steps[key] = {
        step: key === " unattributed" ? null : name,
        // `entries` is the grain the query returns: one row per (model, profile). `models`
        // is derived from it. Keeping both means a step can be sliced by model, by account,
        // or by both, without re-querying.
        subcents: 0, events: 0, entries: [], models: [], firstAt: null,
        cached: 0, fresh: 0, out: 0, synthesized: 0, verdict: 0, inferredProfile: 0,
        // externalAgents is agent -> count, unchanged. externalAgentModels adds a second cut,
        // agent -> { model -> count }, so the off-ledger badge can say WHAT ran, not just how
        // many calls — still never a price, which this store has nowhere for an off-ledger call.
        external: 0, externalAgents: {}, externalAgentModels: {},
        turns: 0, agentS: 0, idleS: 0,
      };
    }
    return steps[key];
  }

  function earliest(a, b) {
    if (!b) return a;
    if (!a) return b;
    return b < a ? b : a;
  }

  cost.forEach(function (r) {
    var s = slot(r.step);
    var sub = Number(r.subcents || 0);
    s.subcents += sub;
    s.events += Number(r.events || 0);
    s.cached += Number(r.cached_in || 0);
    s.fresh += Number(r.fresh_in || 0);
    s.out += Number(r.out_tokens || 0);
    s.synthesized += Number(r.synthesized_events || 0);
    if (r.is_verdict) s.verdict += sub;
    // The account came from the session, not from the cost event. Sound — a session runs
    // under one profile for its whole life — but an inference, and published as one.
    if (r.profile_inferred) s.inferredProfile += sub;
    s.firstAt = earliest(s.firstAt, r.first_at);
    // Merged by NAME, not pushed. The query groups by basis as well as model, so one model
    // can arrive as several rows for the same step — pushing them would render the same
    // model twice in the legend and twice in every bar.
    s.entries.push({
      model: r.model,
      profile: r.profile == null ? "(none)" : r.profile,
      subcents: sub,
      out: Number(r.out_tokens || 0),
    });
  });

  (external || []).forEach(function (r) {
    var s = slot(r.step);
    var n = Number(r.n || 0);
    var model = r.model || "(unspecified)";
    s.external += n;
    s.externalAgents[r.agent] = (s.externalAgents[r.agent] || 0) + n;
    if (!s.externalAgentModels[r.agent]) s.externalAgentModels[r.agent] = {};
    s.externalAgentModels[r.agent][model] = (s.externalAgentModels[r.agent][model] || 0) + n;
  });

  (timing || []).forEach(function (r) {
    var s = slot(r.step);
    s.turns += Number(r.turns || 0);
    s.agentS += Number(r.agent_s || 0);
    s.idleS += Number(r.idle_s || 0);
    s.firstAt = earliest(s.firstAt, r.first_at);
  });

  var all = Object.keys(steps).map(function (k) {
    var s = steps[k];
    // Heaviest-spending model first, so a step's colour reads as "what mostly paid for this"
    // rather than whichever row the database happened to return first. Merged by NAME across
    // entries, because the query's grain is (model, profile, basis) and one model routinely
    // arrives as several rows.
    s.models = mergeBy(s.entries, "model").sort(function (a, b) {
      return b.subcents - a.subcents;
    });
    return s;
  });

  // ORDERED BY THE WORKFLOW'S DEFINED STEP SEQUENCE — the same order as the step rail at the
  // top of the task page, which is the whole point of laying money along it.
  //
  // Not by when each step was first observed. Step attribution is reconstructed from partial
  // stamps, and a card with two concurrent sessions readily produces a first-observed order
  // like Spec -> Testing -> Review -> Build. That is an artifact of stamping, not a card that
  // bounced, and sorting by it would publish the artifact as a process finding — exactly the
  // kind of laundered number this project exists to distrust.
  //
  // First-observed time is the fallback, and only for a step the workflow no longer defines:
  // a renamed or deleted step still holds real spend, so it stays in the rail rather than
  // vanishing. Timestamps are ISO-8601, so a lexicographic compare is a chronological one.
  var position = {};
  (order || []).forEach(function (r) {
    if (r.step != null && r.pos != null) position[r.step] = Number(r.pos);
  });

  var rail = all.filter(function (s) { return s.step; }).sort(function (a, b) {
    var pa = position[a.step], pb = position[b.step];
    if (pa != null && pb != null) return pa - pb;
    // A step missing from the definition sorts after every defined one, so the rail still
    // reads as the workflow first and the leftovers after it.
    if (pa != null) return -1;
    if (pb != null) return 1;
    if (!a.firstAt) return b.firstAt ? 1 : 0;
    if (!b.firstAt) return -1;
    return a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : 0;
  });

  // Steps the workflow defines but that hold no spend are simply absent — rendering seven
  // zero rows to explain that a card skipped them would bury the six that cost something.
  var undefinedSteps = rail.filter(function (s) { return position[s.step] == null; })
    .map(function (s) { return s.step; });
  var unattributed = all.filter(function (s) { return !s.step; })[0] || null;

  function sum(key) {
    return all.reduce(function (n, s) { return n + s[key]; }, 0);
  }

  // Every model that paid for any part of this card, heaviest first. This ordering is used
  // for the legend AND for the segment order inside every step bar — the same model must sit
  // in the same position in every bar, or the eye cannot compare two steps at a glance.
  //
  // Unattributed spend is included: it was still paid to a model, and a legend whose totals
  // did not add up to the headline would be its own bug.
  var everyEntry = all.reduce(function (acc, s) { return acc.concat(s.entries); }, []);

  var models = modelRates(
    mergeBy(everyEntry, "model").sort(function (a, b) { return b.subcents - a.subcents; }),
    modelTiming
  );

  // THE ACCOUNTS. On a machine running several agent profiles this is whose bill the card
  // landed on, and it is not derivable from the model: two profiles can run the same model
  // and bill different accounts entirely.
  var profiles = mergeBy(everyEntry, "profile")
    .sort(function (a, b) { return b.subcents - a.subcents; });

  var agents = {};
  var agentModels = {};
  all.forEach(function (s) {
    Object.keys(s.externalAgents).forEach(function (a) {
      agents[a] = (agents[a] || 0) + s.externalAgents[a];
    });
    Object.keys(s.externalAgentModels).forEach(function (a) {
      if (!agentModels[a]) agentModels[a] = {};
      Object.keys(s.externalAgentModels[a]).forEach(function (m) {
        agentModels[a][m] = (agentModels[a][m] || 0) + s.externalAgentModels[a][m];
      });
    });
  });

  return {
    state: "ok",
    rail: rail,
    unattributed: unattributed,
    total: sum("subcents"),
    external: sum("external"),
    externalAgents: agents,
    externalAgentModels: agentModels,
    // Events whose TOKEN COUNTS were synthesized rather than reported. Deliberately not
    // called "estimated cost": cost provenance is not recorded anywhere in this store, so
    // whether a figure is a bill or a list-price reconstruction is unanswerable and must
    // not be implied by a label. See the note on token_basis in extract.sql.
    synthesized: sum("synthesized"),
    // Spend whose step label is a majority verdict over a window that spanned more than one
    // step, rather than a window that sat wholly inside one. Published, not smoothed away.
    verdict: sum("verdict"),
    inferredProfile: sum("inferredProfile"),
    cached: sum("cached"),
    fresh: sum("fresh"),
    out: sum("out"),
    peers: (peers && peers[0]) || null,
    snapshotAt: snapshotAt,
    stepBasis: stepBasis,
    models: models,
    profiles: profiles,
    undefinedSteps: undefinedSteps,
    // A partial read is still worth rendering, but the footer has to admit which parts are
    // missing rather than showing a rail with silently absent hours — or, worse, a rail in
    // observation order that looks like the workflow order and is not.
    degraded: {
      timing: timing === null,
      external: external === null,
      peers: peers === null,
      order: order === null || !Object.keys(position).length,
    },
  };
}

/**
 * Sum a list of (model, profile) entries by one of those keys.
 *
 * Everything downstream — the model legend, the account legend, a step's segments — is this
 * same fold over a different key, so it is written once. Merging by NAME is load-bearing:
 * the query's grain is (step, model, profile, basis), so one model or one account routinely
 * arrives as several rows and appending them would double it in every legend and bar.
 */
export function mergeBy(entries, key) {
  var acc = {};
  (entries || []).forEach(function (e) {
    var k = e[key];
    if (!acc[k]) {
      acc[k] = { subcents: 0, out: 0 };
      acc[k][key] = k;
    }
    acc[k].subcents += e.subcents;
    acc[k].out += e.out;
  });
  return Object.keys(acc).map(function (k) { return acc[k]; });
}

/** Entries surviving the current filters. Both are null for "everything". */
function keep(step, selectedModel, selectedProfile) {
  return (step.entries || []).filter(function (e) {
    if (selectedModel && e.model !== selectedModel) return false;
    if (selectedProfile && e.profile !== selectedProfile) return false;
    return true;
  });
}

/**
 * One step's spend broken into per-model segments, in the card's global model order.
 *
 * The order argument is the whole card's model list, not the step's — a step that used only
 * sonnet must still put sonnet in sonnet's position, so two bars can be compared by looking
 * at them. Zero-spend models are dropped rather than emitted as empty segments.
 *
 * Segments stay keyed on MODEL even when an account is isolated: colour means model
 * everywhere in this panel, and having it quietly mean something else under a filter would
 * make the two states unreadable against each other.
 */
export function stepSegments(step, order, selectedModel, selectedProfile) {
  var merged = mergeBy(keep(step, selectedModel, selectedProfile), "model");
  return order
    .map(function (m) {
      var hit = merged.filter(function (x) { return x.model === m; })[0];
      return { model: m, subcents: hit ? hit.subcents : 0 };
    })
    .filter(function (seg) { return seg.subcents > 0; });
}

/** What a step costs under the current filters. */
export function stepTotal(step, selectedModel, selectedProfile) {
  if (!selectedModel && !selectedProfile) return step.subcents;
  return keep(step, selectedModel, selectedProfile).reduce(function (n, e) {
    return n + e.subcents;
  }, 0);
}

/**
 * Run the queries and assemble. `query` is injectable so a test can drive the whole path
 * without a network or a Rill.
 */
export function loadTaskLedger(taskId, query) {
  var run = query || rillQuery;
  return Promise.all(ledgerQueries(taskId).map(function (sql) { return run(sql); }))
    .then(function (res) {
      return assembleLedger(res[0], res[1], res[2], res[3], res[4], res[5], res[6], res[7],
                            res[8]);
    });
}
