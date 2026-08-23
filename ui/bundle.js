/**
 * UI bundle for kandev-plugin-ops-intel.
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

  var PLUGIN_ID = "kandev-plugin-ops-intel";

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
    // An explore, not a canvas, and deliberately. It serves two opposite readings of one grain
    // — one card down its steps, or one step across every card — and a fixed layout would have
    // to promote one and demote the other. See the header of metrics/card_steps.yaml.
    { id: "cardsteps", label: "Card × step (explore)", path: "/explore/card_steps" },
    // The two request-grain views. Both read Claude Code transcripts rather than Kandev's store
    // — see models/kandev_requests.yaml for why that second source exists — so both are blank
    // for steps that ran on codex or agy. Blank meaning "not observable", never "free".
    { id: "requests", label: "Request ledger (explore)", path: "/explore/request_ledger" },
    { id: "tooleconomics", label: "Tool economics (explore)", path: "/explore/tool_economics" },
    { id: "overview", label: "Overview", path: "/canvas/overview" },
    { id: "anomalies", label: "Anomalies (explore)", path: "/explore/anomalies" },
  ];

  // --allowed-origins is what lets every read in rill.mjs return a response instead of an
  // opaque one. Without it the tab still works — the filter just applies unverified — but the
  // task panel cannot read anything at all, and says so.
  //
  // Deliberately relative, with no leading `cd`: every developer clones this plugin somewhere
  // different, and a plugin id or bundle build has no way to know where. The UI that renders
  // this string is responsible for saying "run this from the rill/ directory of your checkout"
  // as prose alongside it — see START_COMMAND_HINT.
  var START_COMMAND =
    "./extract/extract.sh && rill start . --allowed-origins http://localhost:8817";

  var START_COMMAND_HINT = "From the rill/ directory of your plugin checkout, run:";

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

  /**
   * How stale the snapshot is, as "2.3h old" — or null when it cannot be told.
   *
   * Rill reads a point-in-time copy and nothing inside it knows the wall clock, so this is the
   * only way the panel can say whether "no run recorded" means "never ran" or "ran since the
   * extract". A negative age (clock skew, or a snapshot from the future) yields null rather
   * than a nonsense figure.
   */
  function snapshotAge(lastActivityIso, nowMs) {
    if (!lastActivityIso) return null;
    var t = Date.parse(lastActivityIso);
    if (isNaN(t)) return null;
    var secs = ((nowMs == null ? Date.now() : nowMs) - t) / 1000;
    if (secs < 0) return null;
    return secs;
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
  // ui/src/clipboard.mjs
  // ====================================================================================
  /**
   * One copy path for every surface that hands the reader a command.
   *
   * WHY THIS IS SHARED RATHER THAN INLINE. The start command appears in three places — the tab's
   * down state, the panel's "cannot read Rill", and the panel's "not in this snapshot yet" — and
   * each of those is a moment where the reader is already mildly stuck. A copy that silently does
   * nothing there reads as a second failure of the same surface, so the failure has to be visible
   * and the behaviour identical in all three.
   *
   * `navigator.clipboard` is present on localhost (a secure context) but not on a plain-http
   * origin, which is exactly how this plugin would be loaded from another machine on the LAN. The
   * execCommand fallback is deprecated and still the only thing that works there.
   */

  function copyTextToClipboard(host, text, label) {
    var what = label || "Command";
    var toast = (host && host.toast) || null;

    function ok() {
      if (toast && toast.success) toast.success(what + " copied");
    }
    // A failed copy must say so. Silence is indistinguishable from a copy that worked, and the
    // reader finds out only when they paste the wrong thing into a shell.
    function fail() {
      if (toast && toast.error) toast.error("Could not copy — select the text and copy manually");
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () {
        if (!legacyCopy(text)) fail();
        else ok();
      });
      return;
    }
    if (legacyCopy(text)) ok();
    else fail();
  }

  /** Deprecated, and the only path available off a secure origin. */
  function legacyCopy(text) {
    try {
      var area = document.createElement("textarea");
      area.value = text;
      // Off-screen rather than hidden: `display:none` and `visibility:hidden` are not selectable,
      // so the copy silently yields an empty clipboard.
      area.style.position = "fixed";
      area.style.top = "-1000px";
      area.setAttribute("readonly", "readonly");
      document.body.appendChild(area);
      area.select();
      var copied = document.execCommand("copy");
      document.body.removeChild(area);
      return copied;
    } catch (err) {
      return false;
    }
  }


  // ====================================================================================
  // ui/src/icon.mjs
  // ====================================================================================
  /**
   * The plugin's own nav glyph — a gauge.
   *
   * WHY NOT A CURATED NAME. `icon: "chart"` resolved to Tabler's `IconChartBar`, which is the
   * glyph the host's own **Stats** button already uses — and since this item moved into the
   * sidebar footer, the two sat side by side as identical bar charts. An icon that duplicates its
   * neighbour is worse than no icon: it reads as a rendering bug, and neither button says which
   * one you want. None of the 18 curated names is right either (bell, bolt, book, bug, calendar,
   * chart, checklist, cloud, database, flask, globe, message, puzzle, robot, rocket, settings,
   * ticket, users), so this takes the contract's other option: a plugin-owned component.
   *
   * WHY A GAUGE. The surface is not only about money. It answers how the operation is running —
   * spend per model and per step, agent time against idle time, tool mix, how long steps spend
   * waiting, code output per dollar, anomalies. A coin or a receipt would name the narrowest
   * reading of that and would date badly as the plugin grows; a dial reads as "rate and health of
   * a running thing", which is the whole surface.
   *
   * DRAWN FOR 14 PIXELS. The footer renders icons at `h-3.5 w-3.5`, so this is three strokes and
   * nothing else: the dial, the needle, the hub. Tabler's conventions are matched deliberately
   * (24 viewBox, `currentColor`, no fill, 2px round-capped strokes) so it sits in the row as a
   * peer rather than as a foreign asset. The host sizes it through `className`, which wins over
   * the width/height attributes, so those stay as the natural size for any surface that does not
   * pass one.
   */

  function createGaugeIcon(host) {
    var jsx = host.jsx;

    return function OpsGaugeIcon(props) {
      var p = props || {};
      return jsx(
        "svg",
        {
          xmlns: "http://www.w3.org/2000/svg",
          width: 24,
          height: 24,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          className: p.className,
          // The label lives on the button, so the glyph must not be announced twice.
          "aria-hidden": p["aria-hidden"] == null ? "true" : p["aria-hidden"],
        },
        // The dial: a half turn, open at the bottom where a gauge's scale ends.
        jsx("path", { d: "M4 15a8 8 0 0 1 16 0" }),
        // The needle, deliberately off-centre. A needle straight up reads as a decoration; one
        // swung to a value reads as a measurement.
        jsx("path", { d: "M12 15l3.6-4.2" }),
        // The hub, which is what stops the two paths looking like an unrelated arc and slash.
        jsx("circle", { cx: 12, cy: 15, r: 1.2 })
      );
    };
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
  function assembleLedger(cost, external, timing, peers, order, modelTiming, presence,
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
        return assembleLedger(res[0], res[1], res[2], res[3], res[4], res[5], res[6], res[7],
                              res[8]);
      });
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

    /**
     * "codex (gpt-5.2-codex × 4, (unspecified) × 12)" per agent, one array entry each — the
     * shared shape behind both the per-step tooltip and the card-level floor chip, so the two
     * never drift apart. `models` is best-effort (see extract.sql); an agent with no breakdown
     * at all falls back to the plain count rather than an empty parenthesis.
     */
    function agentModelBreakdown(agents, models) {
      return Object.keys(agents).map(function (a) {
        var byModel = models && models[a] ? models[a] : null;
        var modelKeys = byModel ? Object.keys(byModel) : [];
        if (!modelKeys.length) return a + " × " + agents[a];
        var parts = modelKeys
          .sort(function (x, y) { return byModel[y] - byModel[x]; })
          .map(function (m) { return m + " × " + byModel[m]; })
          .join(", ");
        return a + " (" + parts + ")";
      });
    }

    /**
     * Tooltip for the off-ledger badge: which agent, which model, how many calls — and an
     * explicit statement that there is no price, rather than a number quietly implying $0.
     */
    function offLedgerTitle(s) {
      var byAgent = agentModelBreakdown(s.externalAgents, s.externalAgentModels).join(", ");
      return byAgent + " — billed to a separate account, no price recorded here";
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
                  title: offLedgerTitle(s),
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

      // The command plus a copy button, because selecting 120 characters of shell out of a
      // panel is the one gesture this surface should never require: the panel is anchored to a
      // toolbar button, and a drag-select inside it starts by moving the pointer away from that
      // anchor. Popover semantics keep the panel open while you do it either way (see
      // step-analysis.mjs), but one click still beats a careful drag.
      function commandBlock(key) {
        return jsx("div", { key: key, style: { display: "flex", flexDirection: "column", gap: "6px" } },
          jsx("span", { style: { opacity: 0.6, fontSize: "11px" } }, START_COMMAND_HINT),
          jsx("pre", { style: {
            padding: "10px", borderRadius: "5px", background: SUNK, fontSize: "11px",
            overflowX: "auto", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all",
            userSelect: "text",
          } }, START_COMMAND),
          jsx("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
            jsx(Button, {
              size: "sm",
              variant: "outline",
              onClick: function () { copyTextToClipboard(host, START_COMMAND, "Refresh command"); },
            }, "Copy command"),
            // Named, not hinted at. The refresh this command performs by hand is the same one
            // `make refresh-agent-install` runs hourly; a reader doing it manually every time
            // deserves to know that once.
            jsx("span", { style: { fontFamily: MONO, fontSize: "10px", opacity: 0.5 } },
              "or install the hourly refresh: make refresh-agent-install"))
        );
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
            "read — the dashboards in the Ops Intel tab still work, because an iframe needs no " +
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

        var age = snapshotAge(data.snapshotAt);
        var ageText = age == null ? null : fmtDuration(age) + " old";

        var heading = absent ? "Not in this snapshot yet" : "No metered spend yet";

        var body = absent
          // The extract predates the card. This is the only case re-running it fixes.
          //
          // The age belongs in this sentence rather than only in the "no run recorded" one below:
          // it is the difference between "the snapshot is 20 minutes old, the hourly refresh will
          // collect this card shortly" and "the snapshot is two days old, nothing is refreshing".
          ? "Rill reads a point-in-time copy of Kandev's database and does not hot-reload it, so a " +
            "card created since the last extract is not in it" +
            (ageText ? " — this snapshot is " + ageText + ". " : ". ") +
            "Re-run the extract and restart Rill to pick it up."
          : ran
            // Present, and it ran — but nothing billed. Cost events are written when a session
            // flushes, which happens at a step transition, so a card still working through its
            // first step has no cost row anywhere, live database included.
            ? "This card is in the snapshot and has " + data.turns + " recorded turn" +
              (data.turns === 1 ? "" : "s") + ", but no cost event anywhere — not in Rill, and " +
              "not in Kandev either. Kandev writes spend only when an agent response completes, " +
              "which on this store takes about an hour from session start on average. " +
              "Re-extracting cannot conjure a number that has not been written yet."
            // Present, but the snapshot records no run.
            //
            // THIS CANNOT DISTINGUISH "never ran" FROM "ran after the extract", and it used to
            // assert the first — on a card whose agent was running as it said so, because the
            // snapshot was two hours older than the turn. Report what the snapshot contains and
            // how old it is; let the reader draw the conclusion.
            // DO NOT REFLEXIVELY SEND THE READER TO RE-EXTRACT. That is the advice that turns
            // this panel into a chore: on this store a session takes ~55 minutes on average to
            // write its first cost event, and 25 of 82 sessions never wrote one at all. A
            // freshly started card is blank no matter how recently the extract ran, so the
            // honest framing is "there may be nothing to find yet", not "go fetch it again".
            : "No agent run is recorded for this card" +
              (ageText ? " in this snapshot, which is " + ageText : " in this snapshot") +
              ". A run that started since the extract would not appear — but note that cost is " +
              "only written when a session flushes, roughly an hour into it, so a card started " +
              "recently has nothing to find yet either way. Kandev writes spend only when an " +
              "agent response completes.";

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
          // Shown when re-running the extract could actually change the answer: the card is
          // missing entirely, or the snapshot records no run and may simply be older than one.
          // Withheld for a card that ran and did not flush, where it changes nothing.
          absent || !ran ? commandBlock("c") : null,
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

      var agentNames = agentModelBreakdown(data.externalAgents, data.externalAgentModels)
        .join(" · ");

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
        // UNATTRIBUTED SPEND, SIZED TO ITS SHARE.
        //
        // This was a dim 10px footnote at 0.6 opacity — fine when it is a rounding error, badly
        // wrong when it is most of the card. One real card put $74.87 of $80.75 here (93%)
        // while the rail showed a $5.88 step as though that were the story: Kandev stamped no
        // step for the first 44 minutes of the session, and the first stamp landed one second
        // AFTER the flush it would have explained.
        //
        // So it scales. Below a quarter of the card it stays a footnote; at or above, it gets a
        // step row's weight and a bar, because at that point it IS the finding — not a caveat
        // to one.
        (function () {
          if (!data.unattributed) return null;
          var amt = stepTotal(data.unattributed, selected, selectedProfile);
          var share = shownTotal > 0 ? amt / shownTotal : 0;
          var dim = (selected || selectedProfile) && amt === 0;
          var hatch = "repeating-linear-gradient(45deg, currentColor 0 1.5px," +
            " transparent 1.5px 4px)";

          if (share < 0.25) {
            return jsx("div", { key: "un", style: {
              display: "flex", alignItems: "center", gap: "7px", fontFamily: MONO,
              fontSize: "10px", opacity: dim ? 0.25 : 0.6, paddingTop: "8px",
              borderTop: "1px solid " + BORDER,
            } },
              jsx("span", { style: {
                width: "16px", height: "9px", flex: "none", borderRadius: "2px",
                border: "1px solid currentColor", backgroundImage: hatch, opacity: 0.5,
              } }),
              jsx("span", { style: { fontVariantNumeric: "tabular-nums" } }, fmtUsd(amt)),
              jsx("span", null, "before the first step stamp — not attributable"));
          }

          return jsx("div", { key: "un", style: {
            display: "grid", gridTemplateColumns: "14px 1fr", gap: "9px",
            padding: "9px 0", borderTop: "1px solid " + BORDER, opacity: dim ? 0.32 : 1,
          } },
            jsx("div", { style: { display: "flex", justifyContent: "center", paddingTop: "5px" } },
              jsx("div", { style: {
                width: "7px", height: "7px", borderRadius: "50%",
                border: "1px solid " + OFF_LEDGER, backgroundImage: hatch, color: OFF_LEDGER,
              } })),
            jsx("div", { style: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 } },
              jsx("div", { style: { display: "flex", alignItems: "baseline", gap: "7px" } },
                jsx("span", { style: { fontFamily: MONO, fontSize: "12px", color: OFF_LEDGER } },
                  "no step recorded"),
                jsx("span", { style: {
                  marginLeft: "auto", fontFamily: MONO, fontSize: "12.5px", fontWeight: 600,
                  fontVariantNumeric: "tabular-nums", flex: "none", color: OFF_LEDGER,
                } }, fmtUsd(amt))),
              jsx("div", { style: {
                height: "5px", background: SUNK, borderRadius: "1px", overflow: "hidden",
              } },
                jsx("div", { style: {
                  height: "100%", width: Math.min(100, share * 100) + "%", color: OFF_LEDGER,
                  border: "1px solid " + OFF_LEDGER + "80", backgroundImage: hatch, opacity: 0.9,
                } })),
              jsx("div", { style: { fontFamily: MONO, fontSize: "9.5px", opacity: 0.6 } },
                Math.round(share * 100) + "% of this card billed before Kandev stamped any " +
                "step, so it belongs to no step here")));
        })(),

        jsx("div", { key: "sep2", style: { height: "1px", background: BORDER } }),

        // ---- compact provenance. The full explanations belong in tooltips and docs;
        // this surface should prioritise the rail rather than repeat a paragraph on
        // every task.
        jsx("div", { key: "foot", style: {
          fontFamily: MONO, fontSize: "9.5px", lineHeight: 1.45, opacity: 0.55,
        } },
          jsx("div", {
            title: "in " + fmtCount(data.fresh) + " · cache " + fmtCount(data.cached) +
              " · out " + fmtCount(data.out),
            style: { cursor: "help" },
          }, "Tokens: " + fmtTokenSplit(data.fresh, data.cached, data.out)),
          (function () {
            var a = snapshotAge(data.snapshotAt);
            return a == null ? null : jsx("div", null,
              "Snapshot " + fmtDuration(a) + " old");
          })(),
          data.stepBasis === "stamp"
            ? jsx("div", null, "Step source: turn stamps (exact)")
            : data.stepBasis === "inferred"
              ? jsx("div", null, "Step source: billing windows (approximate)")
              : data.stepBasis === "mixed"
                ? jsx("div", null, "Step source: turn stamps + billing windows")
                : null,
          data.verdict > 0
            ? jsx("div", null, fmtUsd(data.verdict) + " uses multi-step attribution")
            : null,
          // Most cost events carry no agent_profile_id; the account is then read off the
          // session, which runs under one profile for its whole life. Sound, but an inference.
          data.inferredProfile > 0
            ? jsx("div", null, "Account inferred for " + fmtUsd(data.inferredProfile))
            : null,
          data.degraded.timing ? jsx("div", { style: { color: OFF_LEDGER } },
            "Timing unavailable — hours omitted.") : null,
          data.degraded.external ? jsx("div", { style: { color: OFF_LEDGER } },
            "External-agent count unavailable — the total may be understated further.") : null,
          // Without the step definitions the rail falls back to first-observed order, which can
          // look like a workflow sequence while not being one. Say so.
          data.degraded.order ? jsx("div", { style: { color: OFF_LEDGER } },
            "Workflow order unavailable.") : null,
          data.undefinedSteps && data.undefinedSteps.length
            ? jsx("div", null, data.undefinedSteps.join(", ") +
                " — not in this workflow's current definition, listed last.")
            : null,
          jsx("div", { style: { paddingTop: "4px" } },
            jsx("a", {
              href: "#", onClick: function (e) { e.preventDefault(); load(); },
              style: { opacity: 0.8 },
            }, "Refresh snapshot"))
        ),
      ]);
    };
  }


  // ====================================================================================
  // ui/src/step-analysis.mjs
  // ====================================================================================
  // A compact, always-mounted entry point. The full Rill ledger renders directly
  // in an anchored popover, matching the chat-toolbar interaction pattern rather
  // than taking over the screen with a modal.
  function createStepAnalysisAction(host) {
    var React = host.React;
    var h = host.jsx;
    var Panel = createTaskCostPanel(host);
    var ui = host.ui || {};
    var Button = ui.Button || "button";

    // POPOVER, NOT TOOLTIP — and the difference is not cosmetic.
    //
    // This surface used to be a Radix Tooltip with `pointer-events-auto`, on the reasoning that a
    // hover-anchored panel is cheaper to open than a click target. A tooltip closes when the
    // pointer leaves the grace polygon between trigger and content, and that polygon is a narrow
    // corridor: the trigger sits in the chat toolbar while the content is up to 820px wide above
    // it, so reaching anything on the far side of the panel — the start command, most obviously —
    // left the corridor and dismissed the panel mid-gesture. Selecting text inside it was worse
    // still, because the drag begins by moving away from the trigger.
    //
    // A popover is dismissed only by an explicit gesture (Escape, or a click outside), which is
    // what a surface you read, select from and click buttons inside has to be. Keep it a popover.
    var hasPopover = !!(ui.Popover && ui.PopoverTrigger && ui.PopoverContent);
    var Root = hasPopover ? ui.Popover : ui.Tooltip || "div";
    var Trigger = hasPopover ? ui.PopoverTrigger : ui.TooltipTrigger || "div";
    var Content = hasPopover ? ui.PopoverContent : ui.TooltipContent || "div";

    return function StepAnalysisAction(props) {
      var context = (props && props.slotProps) || {};
      var taskId = context.taskId;
      var stateHook = React.useState(null);
      var ledger = stateHook[0];
      var setLedger = stateHook[1];
      var openHook = React.useState(false);
      var open = openHook[0];
      var setOpen = openHook[1];

      React.useEffect(function () {
        if (!taskId) return undefined;
        var cancelled = false;
        setLedger(null);
        loadTaskLedger(taskId).then(
          function (next) { if (!cancelled) setLedger(next); },
          function () { if (!cancelled) setLedger({ state: "blocked" }); }
        );
        return function () { cancelled = true; };
      }, [taskId]);

      if (!taskId) return null;

      var ready = ledger && ledger.state === "ok";
      var label = ready
        ? fmtUsd(ledger.total) + " attributed across workflow steps" +
          (ledger.external ? "; " + ledger.external + " external calls are unpriced" : "")
        : "Open step analysis";

      return h(
        Root,
        { open: open, onOpenChange: setOpen },
        h(
          Trigger,
          { asChild: true },
          h(
            Button,
            {
              type: "button",
              variant: "ghost",
              size: ready ? "sm" : "icon",
              className: (ready ? "h-7 px-1.5 " : "h-7 w-7 ") +
                "cursor-pointer text-muted-foreground hover:text-foreground hover:bg-primary/10",
              title: label,
              "aria-label": "Open step analysis",
              "aria-expanded": open,
              // The popover trigger toggles `open` itself; adding our own handler on top of it
              // toggles twice in one click and the panel never opens. The tooltip fallback has
              // no such handler, so there it is the only thing that opens the panel.
              onClick: hasPopover ? undefined : function () { setOpen(!open); },
            },
            h("svg", { xmlns: "http://www.w3.org/2000/svg", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, h("circle", { cx: 8, cy: 8, r: 6 }), h("path", { d: "M18.09 10.37A6 6 0 1 1 10.34 18" })),
            ready ? h("span", { style: { marginLeft: "3px", fontSize: "11px", fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, fmtUsd(ledger.total)) : null,
            ready && ledger.external ? h("span", { style: { width: "10px", height: "7px", borderRadius: "2px", border: "1px solid " + OFF_LEDGER + "80", backgroundImage: "repeating-linear-gradient(45deg," + OFF_LEDGER + "6b 0 2px,transparent 2px 5px)" } }) : null
          )
        ),
        h(
          Content,
          {
            side: "top",
            align: "end",
            className: "pointer-events-auto p-0",
            // The ledger is a dense diagnostic, not a hint. Give the step rail
            // almost the whole viewport so model/account labels and its evidence
            // footer stay readable; only genuinely overlong cards scroll.
            // Both primitives carry a host width for ordinary content, so override
            // it explicitly: this is a full diagnostic surface.
            style: { width: "min(820px, calc(100vw - 32px))", maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 32px)", overflowY: "auto" },
          },
          h("div", { style: { padding: "20px 24px" } }, h(Panel, { taskId: taskId }))
        )
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

      // Off a secure origin `navigator.clipboard` is simply absent, and this used to do nothing
      // at all in that case — no copy, no message. The shared path falls back and, either way,
      // says what happened.
      function copyCommand() {
        copyTextToClipboard(host, START_COMMAND, "Start command");
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
            "p",
            { style: { opacity: 0.6, fontSize: "12px", marginBottom: "6px" } },
            START_COMMAND_HINT
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
      // THE FOOTER ICON ROW, not the sidebar list. This is a surface you open when you wonder
      // what something cost, not one you navigate every few minutes — the same class as Stats
      // and Settings, which already live down there. A full-width row above the task list spends
      // permanent vertical space on an occasional question.
      //
      // "sidebar-footer" is the plugin-facing name; the host maps it onto its own internal
      // "insights" group (kandev#2562), which is what the footer strip and the phone menu's
      // utility group render. A host that predates that mapping degrades this to a plugin-rail
      // row rather than dropping the item, so there is no version guard to write here.
      registry.registerNavItem({
        id: "ops-intel",
        label: "Ops Intel",
        path: "/plugins/ops-intel",
        // A plugin-owned glyph, not the curated "chart" name: that resolved to the same
        // IconChartBar the host's Stats button uses, and in this row they were indistinguishable.
        icon: createGaugeIcon(host),
        section: "sidebar-footer",
      });

      // topbar:false — Rill draws its own filter bar and time-range control, so host chrome on
      // top would be a second header competing with it for the same job.
      registry.registerRoute("/plugins/ops-intel", createOpsCostPage(host), { topbar: false });

      // This toolbar slot is always mounted beside the model/send controls. It
      // is the entry point for the Rill-backed, step-attributed task analysis;
      // operators never add a panel or first see a session-only cost.
      registry.registerComponent("chat-input-actions", createStepAnalysisAction(host));
    },
  });

})();
