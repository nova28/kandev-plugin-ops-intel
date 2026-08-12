/**
 * UI bundle for kandev-plugin-opscost.
 *
 * GENERATED — DO NOT EDIT. Sources live in ui/src/, built by ui/build.mjs (`make bundle`).
 * Editing this file directly means the next build silently discards your change.
 *
 * The sources are ES modules so their pure halves can be unit-tested with `make test`;
 * they are concatenated here into one IIFE because Kandev serves exactly one file and a
 * relative import would have nothing to resolve against.
 *
 * NO IMPORTS AND NO BUNDLED REACT, by rule. Everything comes from the injected `host` —
 * a second React instance would break the host's contexts and portals.
 */
(function () {
  "use strict";

  // ====================================================================================
  // ui/src/config.mjs
  // ====================================================================================
  /**
   * Every constant the plugin is configured by, in one place.
   *
   * These are compile-time constants on purpose. A private plugin does not justify a config
   * round trip through the backend to learn one port number, and the alternative — reading
   * settings at runtime — would add a failure mode to a surface whose whole job is to be
   * honest about failure.
   */

  var PLUGIN_ID = "kandev-plugin-opscost";

  // The local Rill dev server. Edit here if you run it on another port.
  var RILL_ORIGIN = "http://localhost:9009";

  // Rill's dev server always names its single instance "default".
  var RILL_INSTANCE = "default";

  // The four models the plugin reads.
  //
  // The first three record what HAPPENED, and each carries `step_at_event` — the step resolved
  // by ASOF join onto the step-stamp timeline. That column is the only reason a per-step
  // readout is possible at all: no cost event, message or turn in Kandev records a step.
  //
  // The fourth records what was SUPPOSED to happen — the workflow's declared step order — and
  // is what lets the ledger be laid out in the same sequence as the rail on a task page.
  var COST_MODEL = "kandev_cost";
  var ACTIVITY_MODEL = "kandev_activity";
  var TURNS_MODEL = "kandev_turns";
  var STEPS_MODEL = "src_dim_workflow_step";

  var VIEWS = [
    { id: "embedded", label: "Cost, steps & anomalies", path: "/canvas/embedded" },
    { id: "steps", label: "Workspace & step deep dive", path: "/canvas/step_deep_dive" },
    { id: "overview", label: "Overview", path: "/canvas/overview" },
    { id: "anomalies", label: "Anomalies (explore)", path: "/explore/anomalies" },
  ];

  // --allowed-origins is what lets every read in rill.mjs return a response instead of an
  // opaque one. Without it the tab still works — the filter just applies unverified — but the
  // task panel cannot read anything at all, and says so.
  var START_COMMAND =
    "cd ~/Projects/SoftwareFactory/kandev-plugin-opscost/rill && ./extract/extract.sh && " +
    "rill start . --allowed-origins http://localhost:8817";

  // Both sentinels mean the same thing — the event happened before its session's first step
  // stamp, so it belongs to no step. The models spell it differently and the ledger must treat
  // them as one bucket rather than rendering two mystery rows in the rail.
  var UNATTRIBUTED = ["(step not attributable)", "(before first stamped step)"];


  // ====================================================================================
  // ui/src/format.mjs
  // ====================================================================================
  /**
   * Pure formatting and encoding. No DOM, no fetch, no host — so this file is directly
   * testable under `node --test`, and every unit in it is a place a wrong answer would be
   * silently plausible.
   */

  /**
   * Rill's `workspace` dimension holds the workspace NAME, not its id — extract.sql resolves
   * it as `COALESCE(NULLIF(w.name,''),'(unknown)')` and never carries workspace_id into the
   * models. So the join between Kandev and Rill is by name, and a name is user-supplied text:
   * doubling the quote is what keeps a workspace called "Henry's" from breaking both the SQL
   * and the filter expression in an iframe URL.
   */
  function sqlQuote(name) {
    return String(name).replace(/'/g, "''");
  }

  function isUnattributed(step) {
    return !step || UNATTRIBUTED.indexOf(step) >= 0;
  }

  // 1 subcent = $0.0001, read from Kandev's own frontend currency formatter. Do NOT back-derive
  // this from token prices — that was tried and the answer was wrong by 10x.
  function fmtUsd(subcents) {
    return "$" + (Number(subcents || 0) / 10000).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function fmtDuration(seconds) {
    var s = Number(seconds || 0);
    if (s <= 0) return "—";
    if (s < 90) return Math.round(s) + "s";
    if (s < 5400) return Math.round(s / 60) + "m";
    return (s / 3600).toFixed(1) + "h";
  }

  function fmtCount(n) {
    return Number(n || 0).toLocaleString("en-US");
  }

  /**
   * Token counts at reading scale — 62.62M, 218.7K, 1,417.
   *
   * Cache reads run to hundreds of millions against a few thousand fresh input tokens on the
   * same card, and a column of raw nine-digit integers next to four-digit ones is unreadable.
   * Two significant decimals at M keeps 62.62M distinguishable from 62.75M, which is the
   * comparison anyone actually makes.
   */
  function fmtMTok(n) {
    var v = Number(n || 0);
    // Cache reads on a single card run past a billion, and "1714.07M" is not a number anyone
    // can read at a glance. The tier has to go up to B or the unit stops doing its job.
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e4) return (v / 1e3).toFixed(0) + "K";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return v.toLocaleString("en-US");
  }

  /**
   * Money for a cramped spot — a kanban card badge, where "$904.62" is four characters more
   * than the slot can spare and the cents were never the point at a glance.
   *
   * Returns null below a cent, so a card with a rounding-error of spend renders no badge at
   * all rather than a "$0.00" that reads as a measured zero.
   */
  function fmtUsdShort(subcents) {
    var v = Number(subcents || 0) / 10000;
    if (v <= 0) return null;
    if (v >= 1000) return "$" + (v / 1000).toFixed(1) + "k";
    if (v >= 10) return "$" + Math.round(v);
    if (v >= 1) return "$" + v.toFixed(1);
    return "<$1";
  }

  /** "in 1,417 · cache 62.62M · out 219K" — the three that bill differently. */
  function fmtTokenSplit(fresh, cached, out) {
    return "in " + fmtMTok(fresh) + " · cache " + fmtMTok(cached) + " · out " + fmtMTok(out);
  }

  // Amber is reserved throughout the panel for exactly one meaning: spend that is real but
  // unpriced. It is never used for emphasis, so that when it appears the reader knows what it
  // says without a legend.
  var OFF_LEDGER = "#d9a441";

  // Model families get a stable hue so the same model reads the same colour on every card.
  var MODEL_HUES = {
    opus: "#b0567e", sonnet: "#4f8fa8", haiku: "#5f9e6e",
    gpt: "#8a7fbd", gemini: "#c08a4a", fable: "#a8618f", passthrough: "#7b7b7b",
  };

  /**
   * A colour for a model name. An unrecognised model gets a deterministic hue rather than a
   * shared grey: two unknown models sharing a swatch would render a two-model split as though
   * one model paid for everything.
   */
  function modelColor(name) {
    var n = String(name || "").toLowerCase();
    var keys = Object.keys(MODEL_HUES);
    for (var i = 0; i < keys.length; i++) {
      if (n.indexOf(keys[i]) >= 0) return MODEL_HUES[keys[i]];
    }
    var h = 0;
    for (var j = 0; j < n.length; j++) h = (h * 31 + n.charCodeAt(j)) % 360;
    return "hsl(" + h + ", 34%, 55%)";
  }


  // ====================================================================================
  // ui/src/rill.mjs
  // ====================================================================================
  /**
   * Every network read the plugin performs. All of it goes to Rill; none of it goes to Kandev.
   *
   * That is the architectural choice this whole plugin rests on: the analysis lives in a Rill
   * semantic layer where each measure carries the reasoning for its expression in a reviewable
   * YAML file, so there is exactly one definition of what a dollar means. The price is that
   * Rill reads a point-in-time snapshot, and every caller here has to be honest about it.
   */

  /**
   * One raw-SQL round trip to the Rill dev server.
   *
   * Resolves to an array of rows, or NULL when the answer could not be read at all — Rill
   * down, or (the usual cause) Rill started without `--allowed-origins`, which makes this a
   * cross-origin read the browser will not hand back.
   *
   * Callers must treat null as "unknown" and never as "no rows". That distinction is the whole
   * difference between an honest empty state and a panel that quietly reports a task cost
   * nothing because it could not read the answer.
   *
   * A REJECTED QUERY IS NOT AN UNREACHABLE SERVER. Rill answers a malformed statement with 400
   * and an explanatory body. Collapsing that into the same null as a refused connection made
   * the panel say "cannot read Rill" — sending a reader to check CORS and restart servers when
   * the actual fault was a column this plugin renamed out from under itself. The message is
   * kept in `lastQueryError` so the blocked state can show the real reason.
   */
  var lastError = null;

  /** The last query rejection, or null. Cleared by the next successful read. */
  function lastQueryError() {
    return lastError;
  }
  function rillQuery(sql, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs || 6000);
    return fetch(RILL_ORIGIN + "/v1/instances/" + RILL_INSTANCE + "/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify({ sql: sql }),
    })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) return null;
        return res.json().then(function (body) {
          return (body && body.data) || null;
        });
      })
      .catch(function () {
        clearTimeout(timer);
        return null;
      });
  }

  /**
   * Liveness probe. `no-cors` yields an opaque response we cannot read, which is fine — the
   * only question is whether anything is listening. AbortController bounds the wait so a hung
   * port cannot leave the page spinning forever.
   */
  function probeRill() {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, 4000);
    return fetch(RILL_ORIGIN + "/", {
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(function () {
        clearTimeout(timer);
        return true;
      })
      .catch(function () {
        clearTimeout(timer);
        return false;
      });
  }

  /**
   * Does this workspace exist in the Rill snapshot?
   *
   * Resolves "present" | "absent" | "unknown". The snapshot is point-in-time, so a workspace
   * created or renamed since the last extract is simply not in there, and filtering to it
   * would render an empty page that looks like a bug. "unknown" is the honest answer when the
   * cross-origin read is blocked: the caller filters optimistically rather than pretending
   * to know.
   */
  function probeWorkspace(name) {
    return rillQuery(
      "SELECT count(*) AS n FROM " + COST_MODEL +
        " WHERE workspace = '" + sqlQuote(name) + "'",
      4000
    ).then(function (rows) {
      if (!rows || !rows[0]) return "unknown";
      return Number(rows[0].n) > 0 ? "present" : "absent";
    });
  }

  /** Rill canvas/explore URL state: `?f=<expression>` applies a filter on load. */
  function viewSrc(path, workspaceName) {
    if (!workspaceName) return RILL_ORIGIN + path;
    var expr = "workspace IN ('" + sqlQuote(workspaceName) + "')";
    return RILL_ORIGIN + path + "?f=" + encodeURIComponent(expr);
  }

  /** The active workspace's name, or null when the host store has not settled yet. */
  function activeWorkspaceName(store) {
    if (!store || !store.getState) return null;
    var ws = store.getState().workspaces;
    if (!ws || !ws.activeId || !ws.items) return null;
    var match = ws.items.filter(function (w) { return w.id === ws.activeId; })[0];
    return (match && match.name) || null;
  }


  // ====================================================================================
  // ui/src/ledger.mjs
  // ====================================================================================
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

  /**
   * FIVE QUERIES AND NOT ONE. Each answers an independent question against a different model,
   * and each degrades on its own: lose the timing query and the rail still shows money; lose
   * the peer query and the total still shows. One giant CTE would make every part fail
   * together, and would be far harder to read against the definitions in rill/models/.
   *
   * Returns them in the order `assembleLedger` expects.
   */
  function ledgerQueries(taskId) {
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
    // its own total is.
    var external =
      "SELECT step_at_event AS step, external_agent AS agent, count(*) AS n" +
      " FROM " + ACTIVITY_MODEL + " WHERE task_id = '" + id + "'" +
      " AND is_external_agent_call GROUP BY 1, 2";

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

    return [cost, external, timing, peers, order, modelTiming, presence];
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
   * It also cannot be exact: `office_cost_events` carries no turn_id, so tokens are matched to
   * time only through the model label both sides happen to carry. Aggregate, not per-turn.
   */
  function modelRates(models, timingRows) {
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
  function assembleLedger(cost, external, timing, peers, order, modelTiming, presence) {
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
          external: 0, externalAgents: {},
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
      s.external += n;
      s.externalAgents[r.agent] = (s.externalAgents[r.agent] || 0) + n;
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
    all.forEach(function (s) {
      Object.keys(s.externalAgents).forEach(function (a) {
        agents[a] = (agents[a] || 0) + s.externalAgents[a];
      });
    });

    return {
      state: "ok",
      rail: rail,
      unattributed: unattributed,
      total: sum("subcents"),
      external: sum("external"),
      externalAgents: agents,
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
  function mergeBy(entries, key) {
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
  function stepSegments(step, order, selectedModel, selectedProfile) {
    var merged = mergeBy(keep(step, selectedModel, selectedProfile), "model");
    return order
      .map(function (m) {
        var hit = merged.filter(function (x) { return x.model === m; })[0];
        return { model: m, subcents: hit ? hit.subcents : 0 };
      })
      .filter(function (seg) { return seg.subcents > 0; });
  }

  /** What a step costs under the current filters. */
  function stepTotal(step, selectedModel, selectedProfile) {
    if (!selectedModel && !selectedProfile) return step.subcents;
    return keep(step, selectedModel, selectedProfile).reduce(function (n, e) {
      return n + e.subcents;
    }, 0);
  }

  /**
   * Run the queries and assemble. `query` is injectable so a test can drive the whole path
   * without a network or a Rill.
   */
  function loadTaskLedger(taskId, query) {
    var run = query || rillQuery;
    return Promise.all(ledgerQueries(taskId).map(function (sql) { return run(sql); }))
      .then(function (res) {
        return assembleLedger(res[0], res[1], res[2], res[3], res[4], res[5], res[6]);
      });
  }


  // ====================================================================================
  // ui/src/cost-index.mjs
  // ====================================================================================
  /**
   * ONE QUERY FOR THE WHOLE BOARD.
   *
   * The kanban card slot renders per card, and a board can hold dozens. The task panel's
   * six-query load is right for one open card and catastrophic for forty — that is the
   * "per-card query on every card render" this repo's notes have warned about from the start.
   *
   * So card contributions do not query. They read a workspace-wide index built by two queries
   * total, memoised at module scope and shared by every card instance: one for spend per task,
   * one for off-ledger calls per task. Both return roughly one row per card — tens of rows, not
   * tens of queries.
   *
   * The index is deliberately coarse. It carries a total and a count, nothing per-step and
   * nothing per-model, because that is all a card has room to say. Anything richer is what
   * opening the card is for.
   */

  // Rill reads a point-in-time snapshot that only changes when someone re-runs the extract and
  // restarts it, so this could be cached for the session. A minute is the compromise: long
  // enough that scrolling a board never re-queries, short enough that a fresh extract shows up
  // without a reload.
  var TTL_MS = 60000;

  var cached = null;
  var cachedAt = 0;
  var inFlight = null;

  /**
   * Two result sets in, one lookup out. Pure.
   *
   * Returns `{ ok, byTask }`. `ok` is false when the spend query could not be read at all —
   * cards then render nothing rather than a row of $0.00, which would libel every card on the
   * board as free.
   */
  function assembleCostIndex(totals, external) {
    if (totals === null) return { ok: false, byTask: {} };
    var byTask = {};
    totals.forEach(function (r) {
      if (!r.task_id) return;
      byTask[r.task_id] = { subcents: Number(r.subcents || 0), external: 0 };
    });
    (external || []).forEach(function (r) {
      if (!r.task_id) return;
      // A card can have off-ledger calls and no metered spend of its own — every one of its
      // agents billed somewhere else. That card is the most understated on the board, so it
      // gets an entry rather than being skipped for having no dollar figure.
      if (!byTask[r.task_id]) byTask[r.task_id] = { subcents: 0, external: 0 };
      byTask[r.task_id].external += Number(r.n || 0);
    });
    return { ok: true, byTask: byTask };
  }

  /** The two queries, exported so a test can assert they stay task-scoped and cheap. */
  function costIndexQueries() {
    return [
      "SELECT task_id, sum(cost_subcents) AS subcents FROM " + COST_MODEL +
        " WHERE cost_attribution = 'attributed to a card' GROUP BY 1",
      "SELECT task_id, count(*) AS n FROM " + ACTIVITY_MODEL +
        " WHERE is_external_agent_call AND task_id <> '' GROUP BY 1",
    ];
  }

  /**
   * The shared index. Concurrent callers during a cold load get the SAME promise — forty cards
   * mounting in one frame must produce two queries, not eighty.
   */
  function loadCostIndex(query) {
    var run = query || rillQuery;
    var now = Date.now();
    if (cached && now - cachedAt < TTL_MS) return Promise.resolve(cached);
    if (inFlight) return inFlight;

    inFlight = Promise.all(costIndexQueries().map(function (sql) { return run(sql); }))
      .then(function (res) {
        var index = assembleCostIndex(res[0], res[1]);
        // A failed read is not cached. The usual cause is Rill being down or started without
        // --allowed-origins, both of which get fixed while the board is open; caching the
        // failure for a minute would make the fix look like it did not work.
        if (index.ok) {
          cached = index;
          cachedAt = Date.now();
        }
        inFlight = null;
        return index;
      }, function () {
        inFlight = null;
        return { ok: false, byTask: {} };
      });
    return inFlight;
  }

  /** Drop the memo — used by tests, and after anything that would change the snapshot. */
  function resetCostIndex() {
    cached = null;
    cachedAt = 0;
    inFlight = null;
  }


  // ====================================================================================
  // ui/src/panel.mjs
  // ====================================================================================
  /**
   * THE TASK LEDGER PANEL — money laid along the steps a card passed through.
   *
   * The workflow rail at the top of a task page is already the sequence the reader navigates.
   * Putting spend on that same axis turns a bill into a process diagnosis: a Fixup step
   * costing more than Build says work is escaping Testing, and knowing that is worth more than
   * knowing the total.
   *
   * Everything here reads Rill, for the same reason the main tab is an iframe — one definition
   * of what a dollar means, kept in reviewable YAML in rill/models/. The cost of that choice is
   * a point-in-time snapshot, and the panel says so rather than letting a running card look
   * free.
   *
   * Exported as a factory because React and the design-system components arrive on `host` at
   * initialize time; nothing here may import React (a second copy breaks the host's contexts
   * and portals).
   */

  // Two lines from one module because the build takes only single-line named imports; it says
  // so loudly rather than emitting a bundle with a stray `import` in it.

  function createTaskCostPanel(host) {
    var React = host.React;
    var jsx = host.jsx;
    var ui = host.ui || {};
    var Button = ui.Button || "button";

    var MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
    var BORDER = "var(--border, rgba(128,128,128,0.25))";
    var SUNK = "var(--muted, rgba(128,128,128,0.14))";

    function Label(props) {
      return jsx("div", {
        style: {
          fontFamily: MONO, fontSize: "9.5px", letterSpacing: "0.14em",
          textTransform: "uppercase", opacity: 0.55, fontWeight: 500,
        },
      }, props.children);
    }

    /** Where this card sits against its workspace's other cards, by spend. */
    function PeerScale(props) {
      var p = props.peers;
      if (!p || !p.n_tasks || Number(p.n_tasks) < 3) return null;
      var n = Number(p.n_tasks);
      var rank = Number(p.rank_pos || n);
      // Positioned by RANK, not by dollars. Spend is so skewed — the dearest handful of cards
      // hold well over half of it — that a linear dollar axis collapses every ordinary card
      // onto the left edge and says nothing about any of them.
      var pos = n > 1 ? (1 - (rank - 1) / (n - 1)) * 100 : 50;
      return jsx(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "5px" } },
        jsx("div", { style: { position: "relative", height: "20px" } },
          jsx("div", { style: {
            position: "absolute", top: "10px", left: 0, right: 0, height: "1px",
            background: BORDER,
          } }),
          jsx("div", { style: {
            position: "absolute", top: "4px", left: "50%", width: "1px", height: "13px",
            background: "currentColor", opacity: 0.3,
          } }),
          jsx("div", { style: {
            position: "absolute", top: 0, left: pos + "%", width: "2px", height: "20px",
            background: OFF_LEDGER, transform: "translateX(-50%)",
          } })
        ),
        jsx("div", { style: {
          display: "flex", justifyContent: "space-between", fontFamily: MONO,
          fontSize: "9.5px", opacity: 0.6, letterSpacing: "0.04em",
        } },
          jsx("span", null, "cheapest"),
          jsx("span", { style: { color: OFF_LEDGER, opacity: 1 } },
            rank + " of " + n + " in " + (p.workspace || "this workspace")),
          jsx("span", null, "median " + fmtUsd(p.median_subcents))
        )
      );
    }

    /**
     * The model legend, which doubles as the filter.
     *
     * Click isolates one model; clicking the isolated one restores all. Isolate rather than
     * toggle-off because the question this answers is "where did opus actually get used", and
     * on a two-model card the two gestures are identical anyway.
     */
    function ModelLegend(props) {
      var models = props.models || [];
      if (models.length < 2) return null;
      var total = models.reduce(function (n, m) { return n + m.subcents; }, 0);

      return jsx(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: "5px" } },
        models.map(function (m) {
          var on = !props.selected || props.selected === m.model;
          var colour = modelColor(m.model);
          var share = total > 0 ? Math.round((m.subcents / total) * 100) : 0;
          return jsx(
            "button",
            {
              key: m.model,
              type: "button",
              "aria-pressed": props.selected === m.model,
              title: [
                m.model + " — " + fmtUsd(m.subcents),
                "output " + fmtMTok(m.out) + " tokens over " + fmtDuration(m.agentS) +
                  " of agent time",
                m.tokPerSec != null
                  ? m.tokPerSec.toFixed(1) + " output tokens per agent-second — whole-turn " +
                    "throughput including tool calls, not decode speed"
                  : "too little recorded agent time for a throughput figure",
                props.selected === m.model
                  ? "Click to show every model"
                  : "Click to show only this model",
              ].join("\n"),
              onClick: function () {
                props.onSelect(props.selected === m.model ? null : m.model);
              },
              style: {
                display: "flex", alignItems: "center", gap: "5px",
                fontFamily: MONO, fontSize: "10px", letterSpacing: "0.02em",
                padding: "3px 7px", borderRadius: "3px", cursor: "pointer",
                // The selected chip keeps its model's colour on the border; the rest recede.
                // Opacity alone carries the state so the swatch hue is never misread as a
                // different model.
                border: "1px solid " + (props.selected === m.model ? colour : BORDER),
                background: "transparent",
                color: "inherit",
                opacity: on ? 1 : 0.4,
              },
            },
            jsx("span", { style: {
              width: "7px", height: "7px", borderRadius: "50%", background: colour, flex: "none",
            } }),
            jsx("span", null, m.model),
            jsx("span", { style: { opacity: 0.6, fontVariantNumeric: "tabular-nums" } },
              fmtUsd(m.subcents) + " · " + share + "%" +
                // Throughput is omitted, never zeroed, when the sample is too thin — a rate is
                // the kind of number that gets quoted, and a noisy one is worse than none.
                (m.tokPerSec != null ? " · " + m.tokPerSec.toFixed(0) + " tok/s" : ""))
          );
        })
      );
    }

    /**
     * The account legend — which agent profile the money billed to.
     *
     * Separate from the model legend on purpose. Two profiles can run the same model and bill
     * different accounts, so on a machine running several this is the dimension that answers
     * "whose bill is this card", and the model cannot. No colour swatch: hue means model
     * everywhere in this panel, and giving accounts their own palette would put two competing
     * colour languages in one 450px column.
     */
    function AccountLegend(props) {
      var profiles = (props.profiles || []).filter(function (p) { return p.subcents > 0; });
      if (!profiles.length) return null;
      var total = profiles.reduce(function (n, p) { return n + p.subcents; }, 0);

      // ONE ACCOUNT IS STILL THE ANSWER. Gating this at "two or more", the way the model legend
      // is gated, would hide the account on every card in this store — no card here bills to
      // more than one — and "which account is this" is the whole question. With a single
      // account there is nothing to filter, so it renders as a plain label, not a dead button.
      if (profiles.length === 1) {
        var only = profiles[0].profile;
        return jsx("div", { style: {
          fontFamily: MONO, fontSize: "10px", opacity: 0.6, letterSpacing: "0.02em",
        } }, only === "(none)"
          ? "acct not recorded on these events, or on their sessions"
          : "acct " + only);
      }

      return jsx(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: "5px", alignItems: "center" } },
        jsx("span", { style: {
          fontFamily: MONO, fontSize: "9.5px", letterSpacing: "0.12em",
          textTransform: "uppercase", opacity: 0.45,
        } }, "acct"),
        profiles.map(function (p) {
          var on = !props.selected || props.selected === p.profile;
          var share = total > 0 ? Math.round((p.subcents / total) * 100) : 0;
          return jsx(
            "button",
            {
              key: p.profile,
              type: "button",
              "aria-pressed": props.selected === p.profile,
              title: p.profile + " — " + fmtUsd(p.subcents) + " of " + fmtUsd(total) +
                "\n" + (props.selected === p.profile
                  ? "Click to show every account"
                  : "Click to show only this account"),
              onClick: function () {
                props.onSelect(props.selected === p.profile ? null : p.profile);
              },
              style: {
                display: "flex", alignItems: "center", gap: "5px",
                fontFamily: MONO, fontSize: "10px", letterSpacing: "0.02em",
                padding: "3px 7px", borderRadius: "3px", cursor: "pointer",
                border: "1px solid " + (props.selected === p.profile
                  ? "var(--foreground, rgba(200,200,200,0.55))" : BORDER),
                background: "transparent", color: "inherit",
                opacity: on ? 1 : 0.4,
              },
            },
            jsx("span", null, p.profile),
            jsx("span", { style: { opacity: 0.6, fontVariantNumeric: "tabular-nums" } },
              fmtUsd(p.subcents) + " · " + share + "%")
          );
        })
      );
    }

    /** One step of the rail: what it cost, which models paid for it, how long it held the card. */
    function StepRow(props) {
      var s = props.step;
      var segments = stepSegments(s, props.order, props.selected, props.selectedProfile);
      var mine = stepTotal(s, props.selected, props.selectedProfile);
      var costPct = props.maxCost > 0 ? (mine / props.maxCost) * 100 : 0;
      var timePct = props.maxTime > 0 ? ((s.agentS + s.idleS) / props.maxTime) * 100 : 0;
      var wall = s.agentS + s.idleS;
      // A step the filtered-out model never touched is dimmed, not removed. Removing rows would
      // make the rail jump and break the correspondence with the workflow rail above; dimming
      // answers "which steps used this model" directly, which is the point of filtering.
      var muted = (props.selected || props.selectedProfile) && mine === 0;
      // Which accounts touched this step. Shown only when the card used more than one, because
      // on a single-account card the answer is on every row and says nothing.
      var stepProfiles = props.showProfiles
        ? mergeBy(s.entries, "profile").filter(function (p) { return p.subcents > 0; })
            .sort(function (a, b) { return b.subcents - a.subcents; })
        : [];

      return jsx(
        "div",
        {
          style: {
            display: "grid", gridTemplateColumns: "14px 1fr", gap: "9px",
            padding: "9px 0",
            borderTop: props.first ? "none" : "1px solid " + BORDER,
            opacity: muted ? 0.32 : 1,
          },
        },
        jsx("div", { style: { display: "flex", justifyContent: "center", paddingTop: "5px" } },
          jsx("div", { style: {
            width: "7px", height: "7px", borderRadius: "50%",
            background: modelColor((segments[0] || s.models[0] || {}).model),
          } })
        ),
        jsx("div", { style: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 } },
          jsx("div", { style: { display: "flex", alignItems: "baseline", gap: "7px" } },
            // A dotted underline marks a step whose label is partly a majority verdict over a
            // window that spanned several steps. Quiet on purpose — the tooltip carries the
            // detail and the footer carries the total; a loud badge on most rows would drown
            // the off-ledger amber, which is the more actionable warning.
            jsx("span", {
              title: s.verdict > 0
                ? fmtUsd(s.verdict) + " of this step's spend billed a window that covered more " +
                  "than one step, and is labelled with the step that held most of it"
                : undefined,
              style: {
                fontFamily: MONO, fontSize: "12px", overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap",
                borderBottom: s.verdict > 0 ? "1px dotted currentColor" : "none",
                opacity: s.verdict > 0 ? 0.92 : 1,
              },
            }, s.step),
            s.external
              ? jsx("span", {
                  title: Object.keys(s.externalAgents).map(function (a) {
                    return a + " × " + s.externalAgents[a];
                  }).join(", ") + " — billed to a separate account",
                  style: {
                    fontFamily: MONO, fontSize: "9px", letterSpacing: "0.05em",
                    color: OFF_LEDGER, border: "1px solid " + OFF_LEDGER + "59",
                    borderRadius: "2px", padding: "1px 4px", whiteSpace: "nowrap", flex: "none",
                  },
                }, "+" + s.external + " off-ledger")
              : null,
            jsx("span", {
              style: {
                marginLeft: "auto", fontFamily: MONO, fontSize: "12.5px",
                fontWeight: 600, fontVariantNumeric: "tabular-nums", flex: "none",
              },
            }, fmtUsd(mine))
          ),
          // SEGMENTED BY MODEL. The bar's full width is this step against the dearest step, and
          // its internal divisions are which model paid — so one glance answers both "how big"
          // and "on what". Segments follow the card's global model order, never the step's, or
          // the same colour would sit in a different place in each bar.
          jsx("div", { style: {
            height: "5px", background: SUNK, borderRadius: "1px", overflow: "hidden",
            display: "flex", width: "100%",
          } },
            jsx("div", { style: { display: "flex", width: costPct + "%", height: "100%" } },
              segments.map(function (seg) {
                return jsx("div", {
                  key: seg.model,
                  title: seg.model + " · " + fmtUsd(seg.subcents),
                  style: {
                    height: "100%",
                    // Proportion WITHIN the bar, so the segments fill exactly the step's width.
                    width: mine > 0 ? (seg.subcents / mine) * 100 + "%" : "0%",
                    background: modelColor(seg.model),
                  },
                });
              })
            )
          ),
          jsx("div", { style: {
            display: "flex", alignItems: "center", gap: "7px", fontFamily: MONO,
            fontSize: "10px", opacity: 0.6,
          } },
            jsx("div", { style: { flex: 1, maxWidth: "110px", height: "2px", background: SUNK } },
              jsx("div", { style: {
                height: "100%", width: timePct + "%", background: "currentColor", opacity: 0.45,
              } })
            ),
            jsx("span", { style: { fontVariantNumeric: "tabular-nums" } },
              wall > 0 ? fmtDuration(wall) : "—"),
            jsx("span", { style: { marginLeft: "auto", whiteSpace: "nowrap" } },
              (segments.length > 1
                ? segments.map(function (g) { return g.model; }).join(" + ")
                : (segments[0] ? segments[0].model : "—")) + " · " + s.events + " ev")
          ),
          // The account(s) this step billed to. Only rendered on a multi-account card.
          stepProfiles.length
            ? jsx("div", { style: {
                fontFamily: MONO, fontSize: "9.5px", opacity: 0.5,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              } }, "acct " + stepProfiles.map(function (p) {
                return stepProfiles.length > 1
                  ? p.profile + " " + fmtUsd(p.subcents)
                  : p.profile;
              }).join(" · "))
            : null,
          // The three token classes, ALWAYS VISIBLE rather than hidden behind a hover.
          //
          // This started as a `title` tooltip and that was the wrong call: a native tooltip
          // needs a second of hovering, renders in OS chrome, and advertises itself with
          // nothing but a cursor change. A number worth asking for is a number worth showing.
          // It is set quiet — 9.5px at low opacity — so it stays subordinate to the money.
          jsx("div", {
            title: "in " + fmtCount(s.fresh) + " · cache " + fmtCount(s.cached) +
              " · out " + fmtCount(s.out) +
              (props.selected ? "\n(the step's total, across every model)" : ""),
            style: {
              fontFamily: MONO, fontSize: "9.5px", opacity: 0.45,
              fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis",
            },
          }, fmtTokenSplit(s.fresh, s.cached, s.out))
        )
      );
    }

    return function TaskCostPanel(props) {
      var taskId = props.taskId;
      var dataState = React.useState({ state: "loading" });
      var data = dataState[0];
      var setData = dataState[1];

      // null = every model. A model name isolates it. Reset on task change, because a filter
      // is a decision about the card that was open when it was made.
      var selectedState = React.useState(null);
      var selected = selectedState[0];
      var setSelected = selectedState[1];

      // The account filter is INDEPENDENT of the model filter — they answer different
      // questions ("which model cost this" vs "whose account paid") and combine.
      var profileState = React.useState(null);
      var selectedProfile = profileState[0];
      var setSelectedProfile = profileState[1];

      React.useEffect(function () {
        setSelected(null);
        setSelectedProfile(null);
      }, [taskId]);

      var load = React.useCallback(function () {
        if (!taskId) return;
        setData({ state: "loading" });
        loadTaskLedger(taskId).then(setData, function () {
          setData({ state: "blocked" });
        });
      }, [taskId]);

      React.useEffect(function () {
        if (!taskId) return undefined;
        var cancelled = false;
        setData({ state: "loading" });
        loadTaskLedger(taskId).then(
          function (d) { if (!cancelled) setData(d); },
          function () { if (!cancelled) setData({ state: "blocked" }); }
        );
        return function () { cancelled = true; };
      }, [taskId]);

      function shell(children) {
        return jsx("div", {
          style: {
            padding: "14px", display: "flex", flexDirection: "column", gap: "12px",
            fontSize: "13px", lineHeight: 1.5, height: "100%",
            overflowY: "auto", minHeight: 0,
          },
        }, children);
      }

      function commandBlock(key) {
        return jsx("pre", { key: key, style: {
          padding: "10px", borderRadius: "5px", background: SUNK, fontSize: "11px",
          overflowX: "auto", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all",
        } }, START_COMMAND);
      }

      if (data.state === "loading") {
        return shell(jsx("div", { style: { opacity: 0.6, fontFamily: MONO, fontSize: "11.5px" } },
          "Reading the ledger…"));
      }

      // The read was refused, which on a local setup almost always means one thing.
      if (data.state === "blocked") {
        // Rill answered and REJECTED the query — a fault in this plugin, not in the reader's
        // setup. Saying "cannot read Rill" here sends them to check CORS and restart servers
        // for a renamed column. Show what Rill actually said.
        var rejected = lastQueryError();
        if (rejected) {
          return shell([
            jsx(Label, { key: "l" }, "Rill rejected the query"),
            jsx("p", { key: "p", style: { opacity: 0.75, margin: 0 } },
              "Rill is running and reachable — it refused the statement. This is a bug in the " +
              "plugin, usually a column that moved in rill/models/. Nothing to restart."),
            jsx("pre", { key: "e", style: {
              padding: "10px", borderRadius: "5px", background: SUNK, fontSize: "11px",
              overflowX: "auto", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
            } }, String(rejected).slice(0, 400)),
            jsx("div", { key: "b" },
              jsx(Button, { size: "sm", variant: "outline", onClick: load }, "Retry")),
          ]);
        }
        return shell([
          jsx(Label, { key: "l" }, "Cannot read Rill"),
          jsx("p", { key: "p", style: { opacity: 0.75, margin: 0 } },
            "This panel queries Rill on " + RILL_ORIGIN + " directly, so Rill has to be running " +
            "and started with an allowed origin for Kandev. Without it the browser blocks the " +
            "read — the dashboards in the Ops Cost tab still work, because an iframe needs no " +
            "such permission."),
          commandBlock("c"),
          jsx("div", { key: "b" },
            jsx(Button, { size: "sm", variant: "outline", onClick: load }, "Retry")),
        ]);
      }

      // Readable, but no spend. THREE DIFFERENT FACTS with three different fixes — telling a
      // reader to re-run the extract when the card simply has not billed yet is a wild goose
      // chase, and this panel used to do exactly that for every one of them.
      if (data.state === "empty") {
        var absent = data.inSnapshot === false;
        var ran = data.turns > 0;

        var heading = absent ? "Not in this snapshot yet" : "No metered spend yet";

        var body = absent
          // The extract predates the card. This is the only case re-running it fixes.
          ? "Rill reads a point-in-time copy of Kandev's database and does not hot-reload it, " +
            "so a card created since the last extract is not in it. Re-run the extract and " +
            "restart Rill to pick it up."
          : ran
            // Present, and it ran — but nothing billed. Cost events are written when a session
            // flushes, which happens at a step transition, so a card still working through its
            // first step has no cost row anywhere, live database included.
            ? "This card is in the snapshot and has " + data.turns + " recorded turn" +
              (data.turns === 1 ? "" : "s") + ", but no cost event. Spend is written when a " +
              "session flushes, at a step transition — a card still working through its first " +
              "step has none yet, in Rill or in Kandev. Re-running the extract will not " +
              "change that; completing a step will."
            // Present, never ran. Nothing to bill, and nothing to fix.
            : "This card is in the snapshot and no agent has run on it, so there is nothing to " +
              "bill. Nothing is wrong and nothing needs re-extracting.";

        return shell([
          jsx(Label, { key: "l" }, heading),
          jsx("p", { key: "p", style: { opacity: 0.75, margin: 0 } }, body),
          // Work that billed elsewhere is the one thing that DOES belong on a card with no
          // spend of its own — it is the most understated card there is.
          data.external
            ? jsx("div", { key: "x", style: {
                display: "flex", alignItems: "center", gap: "7px", fontFamily: MONO,
                fontSize: "11px", color: OFF_LEDGER,
              } },
                jsx("span", { style: {
                  width: "24px", height: "10px", flex: "none", borderRadius: "2px",
                  border: "1px solid " + OFF_LEDGER + "80",
                  backgroundImage: "repeating-linear-gradient(45deg," + OFF_LEDGER +
                    "6b 0 2px, transparent 2px 5px)",
                } }),
                jsx("span", null, data.external + " call" + (data.external === 1 ? "" : "s") +
                  " to codex/agy — billed to a separate account, never to this card"))
            : null,
          // The command is only shown when re-running it is actually the fix.
          absent ? commandBlock("c") : null,
          jsx("div", { key: "b" },
            jsx(Button, { size: "sm", variant: "outline", onClick: load }, "Check again")),
        ]);
      }

      // The card's global model order — the legend's order, and the segment order inside every
      // bar. Held in one place so the two can never disagree.
      var order = (data.models || []).map(function (m) { return m.model; });

      // Both the bar scale and the headline follow the filter. Keeping the unfiltered maximum
      // would render an isolated minority model as a row of slivers and say nothing about how
      // its own spend is distributed across the steps.
      var maxCost = data.rail.reduce(function (m, s) {
        return Math.max(m, stepTotal(s, selected, selectedProfile));
      }, 0);
      var maxTime = data.rail.reduce(function (m, s) {
        return Math.max(m, s.agentS + s.idleS);
      }, 0);
      // Summed from the steps rather than read off a legend, because two filters can apply at
      // once and no single legend row knows about the other one.
      var shownTotal = selected || selectedProfile
        ? data.rail.concat(data.unattributed ? [data.unattributed] : [])
            .reduce(function (n, s) { return n + stepTotal(s, selected, selectedProfile); }, 0)
        : data.total;

      var agentNames = Object.keys(data.externalAgents).map(function (a) {
        return a + " × " + data.externalAgents[a];
      }).join(" · ");

      return shell([
        // ---- headline
        jsx("div", { key: "head", style: { display: "flex", flexDirection: "column", gap: "9px" } },
          jsx("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" } },
            jsx("span", { style: {
              fontFamily: MONO, fontSize: "26px", fontWeight: 600,
              letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums",
            } }, fmtUsd(shownTotal)),
            // Part and whole together while filtered, so isolating a model never looks like
            // the card suddenly got cheaper.
            selected
              ? jsx("span", { style: {
                  fontFamily: MONO, fontSize: "11px", opacity: 0.55,
                  fontVariantNumeric: "tabular-nums",
                } }, "of " + fmtUsd(data.total))
              : null,
            // NO "METERED" BADGE. It used to read `metered` by default, which asserts the
            // figure is a bill. Cost provenance is recorded nowhere in this store — whether a
            // number is a bill or a list-price reconstruction is unanswerable — so the badge
            // was stating something the data cannot support. What IS knowable is whether the
            // TOKEN COUNTS were reported or synthesized, and that only merits a badge when
            // some were synthesized.
            data.synthesized
              ? jsx("span", {
                  title: data.synthesized + " event" + (data.synthesized === 1 ? "" : "s") +
                    " carry synthesized token counts rather than reported ones",
                  style: {
                    fontFamily: MONO, fontSize: "9.5px", letterSpacing: "0.1em",
                    textTransform: "uppercase", opacity: 0.55, border: "1px solid " + BORDER,
                    borderRadius: "3px", padding: "2px 5px",
                  },
                }, data.synthesized + " synthesized")
              : null
          ),
          jsx(ModelLegend, { models: data.models, selected: selected, onSelect: setSelected }),
          jsx(AccountLegend, {
            profiles: data.profiles, selected: selectedProfile, onSelect: setSelectedProfile,
          }),
          // THE FLOOR. Half the cards in this store hand work to codex or agy, which bill
          // elsewhere. A confident total would eventually drive a model or process decision on
          // a number missing a large slice of the real spend.
          data.external
            ? jsx("div", { style: {
                display: "flex", alignItems: "center", gap: "7px", fontFamily: MONO,
                fontSize: "11px", color: OFF_LEDGER,
              } },
                jsx("span", { style: {
                  width: "24px", height: "10px", flex: "none", borderRadius: "2px",
                  border: "1px solid " + OFF_LEDGER + "80",
                  backgroundImage: "repeating-linear-gradient(45deg," + OFF_LEDGER +
                    "6b 0 2px, transparent 2px 5px)",
                } }),
                jsx("span", null, agentNames + " — not priced here"))
            : null,
          jsx(PeerScale, { peers: data.peers })
        ),

        jsx("div", { key: "sep", style: { height: "1px", background: BORDER } }),

        jsx(Label, { key: "rl" }, "Spend by step"),

        // ---- the rail
        jsx("div", { key: "rail", style: { display: "flex", flexDirection: "column" } },
          data.rail.map(function (s, i) {
            return jsx(StepRow, {
              key: s.step, step: s, first: i === 0, maxCost: maxCost, maxTime: maxTime,
              order: order, selected: selected, selectedProfile: selectedProfile,
              showProfiles: (data.profiles || []).length > 1,
            });
          })
        ),

        // Spend before the card's first step stamp. Shown, never folded into a step —
        // attributing it to whichever step happened to come first would be a guess presented
        // as a measurement.
        data.unattributed
          ? jsx("div", { key: "un", style: {
              display: "flex", alignItems: "center", gap: "7px", fontFamily: MONO,
              fontSize: "10px",
              opacity: (selected || selectedProfile) &&
                stepTotal(data.unattributed, selected, selectedProfile) === 0 ? 0.25 : 0.6,
              paddingTop: "8px", borderTop: "1px solid " + BORDER,
            } },
              jsx("span", { style: {
                width: "16px", height: "9px", flex: "none", borderRadius: "2px",
                border: "1px solid currentColor",
                backgroundImage: "repeating-linear-gradient(45deg, currentColor 0 1.5px," +
                  " transparent 1.5px 4px)", opacity: 0.5,
              } }),
              jsx("span", { style: { fontVariantNumeric: "tabular-nums" } },
                fmtUsd(stepTotal(data.unattributed, selected, selectedProfile))),
              jsx("span", null, "before the first step stamp — not attributable"))
          : null,

        jsx("div", { key: "sep2", style: { height: "1px", background: BORDER } }),

        // ---- provenance. Every figure above is as of an extract, from a reconstruction.
        jsx("div", { key: "foot", style: {
          fontFamily: MONO, fontSize: "9.5px", lineHeight: 1.65, opacity: 0.55,
        } },
          jsx("div", {
            title: "in " + fmtCount(data.fresh) + " · cache " + fmtCount(data.cached) +
              " · out " + fmtCount(data.out),
            style: { cursor: "help" },
          }, "Tokens: " + fmtTokenSplit(data.fresh, data.cached, data.out) +
            ". Cache reads bill at a tenth of fresh input."),
          // Kandev records no step on a cost event. An event bills the window since the previous
          // event in its session, and that window is attributed to the step holding most of its
          // messages — NOT to the nearest preceding stamp. Cost events flush at a step
          // transition, so "nearest stamp" bills the step that just started and has done no work.
          jsx("div", null, "Kandev records no step on a cost event. Each event bills the window " +
            "since the previous one, attributed to the step that held most of it. Cost carries " +
            "no turn id, so no per-turn figure exists."),
          data.verdict > 0
            ? jsx("div", null, fmtUsd(data.verdict) + " of that billed windows covering more " +
                "than one step — those labels (dotted) are a majority verdict, not a fact.")
            : null,
          // Most cost events carry no agent_profile_id; the account is then read off the
          // session, which runs under one profile for its whole life. Sound, but an inference.
          data.inferredProfile > 0
            ? jsx("div", null, "Account for " + fmtUsd(data.inferredProfile) + " of that came " +
                "from the session, not the cost event — the event recorded none.")
            : null,
          data.degraded.timing ? jsx("div", { style: { color: OFF_LEDGER } },
            "Timing unavailable — hours omitted.") : null,
          data.degraded.external ? jsx("div", { style: { color: OFF_LEDGER } },
            "External-agent count unavailable — the total may be understated further.") : null,
          // Without the step definitions the rail falls back to first-observed order, which can
          // look like a workflow sequence while not being one. Say so.
          data.degraded.order ? jsx("div", { style: { color: OFF_LEDGER } },
            "Workflow step order unavailable — listed in the order spend was first seen, which " +
            "may not be the workflow's sequence.") : null,
          data.undefinedSteps && data.undefinedSteps.length
            ? jsx("div", null, data.undefinedSteps.join(", ") +
                " — not in this workflow's current definition, listed last.")
            : null,
          jsx("div", { style: { paddingTop: "4px" } },
            jsx("a", {
              href: "#", onClick: function (e) { e.preventDefault(); load(); },
              style: { opacity: 0.8 },
            }, "Refresh"))
        ),
      ]);
    };
  }


  // ====================================================================================
  // ui/src/chip.mjs
  // ====================================================================================
  /**
   * THE ALWAYS-THERE COST CHIP — a compact readout in the session top bar.
   *
   * WHY THIS EXISTS. `registerTaskPanel` only adds a row to the "+" menu; its contract is
   * `{ id, title, icon?, Component, mobileEnabled? }` and there is no way for a plugin to
   * declare itself a default panel. A slot component is the one surface that mounts on every
   * task without being asked, so this is what "I don't want to add it every time" can actually
   * be built out of. (The other route is Kandev's own saved layouts, which round-trip plugin
   * panels — that gives the full panel by default and needs no plugin code at all.)
   *
   * WHAT IT DELIBERATELY IS NOT. A top bar is not a dashboard. This shows one number and one
   * warning marker, and hands off to the full ledger on click. Anything more would be competing
   * with the task title for the most valuable strip of the page.
   *
   * WHEN IT SHOWS NOTHING. If Rill is unreachable or the card has no rows, the chip renders
   * nothing at all rather than an error. A top bar is the wrong place to explain a local server
   * being down — the panel does that, at length, with a copyable command. Silence here is not a
   * swallowed error; it is the error being reported somewhere it can be acted on.
   */

  function createTaskCostChip(host) {
    var React = host.React;
    var jsx = host.jsx;
    var Panel = createTaskCostPanel(host);

    var MONO_CHIP = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

    return function TaskCostChip(props) {
      // A SLOT COMPONENT IS NOT A PANEL COMPONENT. `registerComponent` types its component as
      // `{ slotProps?: unknown }` — the slot's payload arrives as ONE prop, not spread — while
      // `registerTaskPanel` passes `{ panelId, taskId, ... }` directly. Reading `props.taskId`
      // here yields undefined, and because a chip with no data renders null, the mistake looks
      // exactly like "this card has no spend". Accept both shapes so the failure cannot recur
      // silently if this component is ever mounted the other way.
      var slot = props.slotProps || props;
      var taskId = slot.taskId;
      var dataState = React.useState(null);
      var data = dataState[0];
      var setData = dataState[1];

      React.useEffect(function () {
        if (!taskId) return undefined;
        var cancelled = false;
        setData(null);
        loadTaskLedger(taskId).then(
          function (d) { if (!cancelled) setData(d); },
          function () { if (!cancelled) setData({ state: "blocked" }); }
        );
        return function () { cancelled = true; };
      }, [taskId]);

      if (!data || data.state !== "ok") return null;

      function openLedger() {
        host.openModal({
          title: "Cost — spend by workflow step",
          size: "lg",
          content: function () {
            return jsx(Panel, { taskId: taskId });
          },
        });
      }

      return jsx(
        "button",
        {
          type: "button",
          onClick: openLedger,
          title: fmtUsd(data.total) + " metered" +
            (data.external ? ", plus " + data.external + " off-ledger calls not priced" : "") +
            "\nOpen the full spend-by-step ledger",
          style: {
            display: "inline-flex", alignItems: "center", gap: "5px",
            fontFamily: MONO_CHIP, fontSize: "11px", fontVariantNumeric: "tabular-nums",
            padding: "2px 7px", borderRadius: "4px", cursor: "pointer",
            border: "1px solid var(--border, rgba(128,128,128,0.25))",
            background: "transparent", color: "inherit", lineHeight: 1.6,
          },
        },
        jsx("span", null, fmtUsd(data.total)),
        // The floor marker, and the only colour the chip ever uses. Same meaning as everywhere
        // else in this plugin: spend that is real and not priced here.
        data.external
          ? jsx("span", {
              style: {
                width: "14px", height: "8px", flex: "none", borderRadius: "2px",
                border: "1px solid " + OFF_LEDGER + "80",
                backgroundImage: "repeating-linear-gradient(45deg," + OFF_LEDGER +
                  "6b 0 2px, transparent 2px 5px)",
              },
            })
          : null
      );
    };
  }


  // ====================================================================================
  // ui/src/card.mjs
  // ====================================================================================
  /**
   * THE KANBAN CARD COST BADGE.
   *
   * Renders beside the PR status icon on every board card: one compact figure, plus the
   * off-ledger hatch when the card handed work to codex/agy.
   *
   * IT DOES NOT QUERY. Every instance reads the shared workspace index in cost-index.mjs, which
   * is two queries for the entire board no matter how many cards are on it. A card slot that
   * fetched per card is the specific mistake this plugin's notes have warned about since before
   * the panel existed.
   *
   * IT RENDERS NOTHING RATHER THAN A ZERO. No index (Rill down, or a read the browser refused),
   * or no row for this card (created since the last extract), means no badge. A "$0.00" on a
   * card that simply is not in the snapshot yet is a claim, and a false one.
   */

  function createTaskCardCost(host) {
    var React = host.React;
    var jsx = host.jsx;

    return function TaskCardCost(props) {
      // `registerComponent` delivers the slot payload as one `slotProps` prop rather than
      // spreading it. Both shapes are accepted so this cannot silently render nothing again.
      var slot = props.slotProps || props;
      var taskId = slot.taskId;

      var indexState = React.useState(null);
      var index = indexState[0];
      var setIndex = indexState[1];

      React.useEffect(function () {
        var cancelled = false;
        loadCostIndex().then(function (i) {
          if (!cancelled) setIndex(i);
        });
        return function () { cancelled = true; };
      }, []);

      if (!index || !index.ok || !taskId) return null;
      var row = index.byTask[taskId];
      if (!row) return null;

      var short = fmtUsdShort(row.subcents);
      if (!short && !row.external) return null;

      return jsx(
        "span",
        {
          title: (short ? fmtUsd(row.subcents) + " metered" : "no metered spend") +
            (row.external
              ? ", plus " + row.external + " off-ledger call" +
                (row.external === 1 ? "" : "s") + " billed to a separate account"
              : "") +
            "\nAs of the last Rill extract",
          style: {
            display: "inline-flex", alignItems: "center", gap: "3px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: "10px", fontVariantNumeric: "tabular-nums",
            opacity: 0.75, whiteSpace: "nowrap", flex: "none",
          },
        },
        short ? jsx("span", null, short) : null,
        row.external
          ? jsx("span", {
              style: {
                width: "10px", height: "7px", flex: "none", borderRadius: "1px",
                border: "1px solid " + OFF_LEDGER + "80",
                backgroundImage: "repeating-linear-gradient(45deg," + OFF_LEDGER +
                  "6b 0 2px, transparent 2px 5px)",
              },
            })
          : null
      );
    };
  }


  // ====================================================================================
  // ui/src/page.mjs
  // ====================================================================================
  /**
   * THE OPS COST TAB — a full-bleed route framing a locally running Rill, filtered to whichever
   * workspace is open in Kandev.
   *
   * WHY THE FILTER IS PROBED BEFORE IT IS APPLIED. Rill reads a point-in-time snapshot, so a
   * workspace can be perfectly real in Kandev and absent from Rill — filtering to it would
   * render an empty dashboard indistinguishable from a broken plugin. The page asks Rill
   * whether the workspace has any spend first, and shows everything (with a reason) when it
   * does not.
   *
   * WHY AN IFRAME AND NOT NATIVE PANELS. Each Rill measure carries the reasoning for its
   * expression in a reviewable YAML file. Porting those charts to React would fork that logic
   * into a second place and guarantee the two drift.
   *
   * WHY THIS DOES NOT START RILL. The authoring guide is explicit — "Do not launch a second
   * long-running server from the plugin" — and Kandev supervises the plugin binary's lifecycle,
   * so anything else it spawned would be fought over on every restart. The page probes for an
   * already-running Rill and hands over the command when nothing answers. A blank iframe that
   * silently fails is worse than an honest empty state.
   */

  function createOpsCostPage(host) {
    var React = host.React;
    var jsx = host.jsx;
    var ui = host.ui || {};
    var Button = ui.Button || "button";

    return function OpsCostPage() {
      var statusState = React.useState("checking"); // checking | up | down
      var status = statusState[0];
      var setStatus = statusState[1];

      var viewState = React.useState(VIEWS[0].id);
      var view = viewState[0];
      var setView = viewState[1];

      // Bumped on every retry so the iframe is forced to remount rather than showing a cached
      // error page from the attempt before.
      var nonceState = React.useState(0);
      var nonce = nonceState[0];
      var setNonce = nonceState[1];

      // The active workspace, and what the probe concluded about it:
      //   name  — from Kandev's store, null before it settles
      //   scope — "checking" | "present" | "absent" | "unknown"
      var wsState = React.useState({ name: null, scope: "checking" });
      var ws = wsState[0];
      var setWs = wsState[1];

      // A user who clears the filter means it. Null = follow the probe; true/false = pinned.
      var overrideState = React.useState(null);
      var override = overrideState[0];
      var setOverride = overrideState[1];

      var check = React.useCallback(function () {
        setStatus("checking");
        probeRill().then(function (alive) {
          setStatus(alive ? "up" : "down");
          if (alive) setNonce(function (n) { return n + 1; });
        });
      }, []);

      React.useEffect(function () {
        var cancelled = false;
        probeRill().then(function (alive) {
          if (!cancelled) setStatus(alive ? "up" : "down");
        });
        return function () {
          cancelled = true;
        };
      }, []);

      // Resolve the active workspace, then re-resolve whenever the user switches workspace in
      // Kandev — the tab is long-lived and a stale filter would silently show the wrong
      // workspace's money. Only a change of activeId re-probes; the store ticks constantly.
      React.useEffect(function () {
        if (status !== "up") return undefined;
        var cancelled = false;
        var lastName = null;

        function resolve() {
          var name = activeWorkspaceName(host.store);
          if (name === lastName) return;
          // A pin was a decision about the workspace open at the time; carrying it into a
          // different one would silently apply it to money it was never about.
          if (lastName !== null) setOverride(null);
          lastName = name;
          if (!name) {
            setWs({ name: null, scope: "unknown" });
            return;
          }
          setWs({ name: name, scope: "checking" });
          probeWorkspace(name).then(function (scope) {
            if (!cancelled) setWs({ name: name, scope: scope });
          });
        }

        resolve();
        var unsubscribe = host.store && host.store.subscribe ? host.store.subscribe(resolve) : null;
        return function () {
          cancelled = true;
          if (unsubscribe) unsubscribe();
        };
      }, [status]);

      function copyCommand() {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(START_COMMAND).then(function () {
            if (host.toast && host.toast.success) host.toast.success("Command copied");
          });
        }
      }

      var current = VIEWS.filter(function (v) { return v.id === view; })[0] || VIEWS[0];

      // THE EMPTY FALLBACK. "absent" means the workspace is real in Kandev but not in the Rill
      // snapshot, so filtering to it would render a blank dashboard that reads as a broken
      // plugin. Show everything and explain instead. "unknown" (Rill started without
      // --allowed-origins) still filters — the common case is that the workspace is there —
      // but the chip makes it one click to undo.
      var autoFilter = !!ws.name && ws.scope !== "absent";
      var filtering = override === null ? autoFilter : override && !!ws.name;
      var activeFilter = filtering ? ws.name : null;

      // ---- toolbar: view switcher + a link out to Rill's own UI
      var toolbar = jsx(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "8px 12px",
            borderBottom: "1px solid var(--border, rgba(128,128,128,0.25))",
            flexWrap: "wrap",
          },
        },
        VIEWS.map(function (v) {
          return jsx(
            Button,
            {
              key: v.id,
              variant: v.id === view ? "default" : "ghost",
              size: "sm",
              onClick: function () { setView(v.id); },
            },
            v.label
          );
        }).concat([
          jsx("div", { key: "spacer", style: { flex: 1 } }),
          ws.name
            ? jsx(
                Button,
                {
                  key: "ws",
                  variant: filtering ? "secondary" : "ghost",
                  size: "sm",
                  title: filtering
                    ? "Showing " + ws.name + " only — click to include every workspace"
                    : "Showing every workspace — click to filter to " + ws.name,
                  onClick: function () { setOverride(!filtering); },
                },
                filtering ? "Workspace: " + ws.name + "  ✕" : "All workspaces"
              )
            : null,
          jsx(
            Button,
            {
              key: "open",
              variant: "ghost",
              size: "sm",
              onClick: function () {
                window.open(viewSrc(current.path, activeFilter), "_blank", "noopener");
              },
            },
            "Open in Rill ↗"
          ),
        ])
      );

      // Shown only when the fallback actually fired, and only until the user touches the chip —
      // a permanent banner for a once-per-extract condition would just become noise.
      var fallbackNote =
        ws.scope === "absent" && override === null
          ? jsx(
              "div",
              {
                key: "note",
                style: {
                  padding: "8px 12px",
                  fontSize: "12px",
                  lineHeight: 1.5,
                  opacity: 0.75,
                  borderBottom: "1px solid var(--border, rgba(128,128,128,0.25))",
                },
              },
              "“" + ws.name + "” has no spend in the Rill snapshot, so this is showing every " +
                "workspace. The snapshot is point-in-time — re-run extract.sh and restart Rill " +
                "to pick up a workspace created since the last extract."
            )
          : null;

      if (status === "checking") {
        return jsx(
          "div",
          { style: { padding: "32px", opacity: 0.7 } },
          "Looking for Rill on " + RILL_ORIGIN + "…"
        );
      }

      if (status === "down") {
        return jsx(
          "div",
          { style: { padding: "32px", maxWidth: "760px" } },
          jsx("h2", { style: { fontSize: "18px", fontWeight: 600, marginBottom: "8px" } },
            "Rill isn't running"),
          jsx(
            "p",
            { style: { opacity: 0.75, lineHeight: 1.6, marginBottom: "16px" } },
            "This tab frames a Rill instance on " + RILL_ORIGIN +
              ", and nothing is listening there. The plugin deliberately does not start it — " +
              "Kandev supervises plugin processes, and a plugin that spawned its own server " +
              "would fight that supervision on every restart."
          ),
          jsx(
            "pre",
            {
              style: {
                padding: "12px",
                borderRadius: "6px",
                background: "var(--muted, rgba(128,128,128,0.12))",
                fontSize: "12px",
                overflowX: "auto",
                marginBottom: "12px",
              },
            },
            START_COMMAND
          ),
          jsx(
            "div",
            { style: { display: "flex", gap: "8px" } },
            jsx(Button, { size: "sm", onClick: copyCommand }, "Copy command"),
            jsx(Button, { size: "sm", variant: "outline", onClick: check }, "Retry")
          ),
          jsx(
            "p",
            { style: { opacity: 0.6, fontSize: "12px", marginTop: "16px", lineHeight: 1.6 } },
            "The extract step re-reads a snapshot of ~/.kandev/data/kandev.db. Rill does not " +
              "hot-reload it, so re-running the extract while Rill is up needs a restart to " +
              "take effect."
          )
        );
      }

      // Hold the frame back until the probe answers. It resolves against a local server in
      // milliseconds, and mounting unfiltered first would load the whole dashboard twice —
      // once for every workspace, then again for one.
      var body =
        ws.scope === "checking" && override === null
          ? jsx(
              "div",
              { key: "resolving", style: { padding: "32px", opacity: 0.7 } },
              "Resolving workspace…"
            )
          : jsx("iframe", {
              // The filter lives in the src, so it has to be part of the key: React would
              // otherwise reuse the frame and leave the old filter showing.
              key: current.id + ":" + (activeFilter || "*") + ":" + nonce,
              src: viewSrc(current.path, activeFilter),
              title: "Rill — " + current.label,
              style: { flex: 1, width: "100%", border: "none", minHeight: 0 },
            });

      return jsx(
        "div",
        { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
        toolbar,
        fallbackNote,
        body
      );
    };
  }


  // ====================================================================================
  // ui/src/plugin.mjs
  // ====================================================================================
  /**
   * Registration — the only file that touches Kandev's registry, and the last one in the
   * bundle. Everything above it is either pure or a factory waiting for `host`.
   */

  window.registerKandevPlugin(PLUGIN_ID, {
    initialize: function (registry, host) {
      registry.registerNavItem({
        id: "opscost",
        label: "Ops Cost",
        path: "/plugins/opscost",
        icon: "chart",
        section: "main",
      });

      // topbar:false — Rill draws its own filter bar and time-range control, so host chrome on
      // top would be a second header competing with it for the same job.
      registry.registerRoute("/plugins/opscost", createOpsCostPage(host), { topbar: false });

      // Added to the task workspace's "+" menu. No capability is needed: like the workspace
      // probe on the main tab, this reads Rill cross-origin rather than reading Kandev, so the
      // plugin still requests nothing from the host.
      registry.registerTaskPanel({
        id: "task-cost",
        title: "Cost",
        icon: "chart",
        Component: createTaskCostPanel(host),
        mobileEnabled: true,
      });

      // A slot component is the only surface that mounts on every task WITHOUT being added —
      // `registerTaskPanel` has no way to declare itself a default. This puts the card's total
      // in the session top bar always, and opens the full ledger in a host modal on click.
      //
      // For the full panel to open by default instead, save a layout containing it as the
      // custom Default in Settings > Layouts; Kandev round-trips plugin panels in saved
      // layouts, and no plugin code can substitute for that.
      registry.registerComponent("chat-top-bar", createTaskCostChip(host));

      // Spend on every board card, beside the PR status icon.
      //
      // NOTE: this is the KANBAN board, not the sidebar task list. The sidebar list mounts no
      // plugin slot at all (`app-sidebar/sections/tasks-section.tsx` contains no `PluginSlot`),
      // so there is no way to contribute to it — the board card is the nearest surface Kandev
      // actually opens up.
      //
      // Every instance reads one shared, memoised index rather than querying: two queries for
      // the whole board regardless of card count. See cost-index.mjs.
      registry.registerComponent("task-card-indicators", createTaskCardCost(host));
    },
  });

})();
