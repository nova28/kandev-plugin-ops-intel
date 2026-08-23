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

import { COST_MODEL, ACTIVITY_MODEL } from "./config.mjs";
import { rillQuery } from "./rill.mjs";

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
export function assembleCostIndex(totals, external) {
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
export function costIndexQueries() {
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
export function loadCostIndex(query) {
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
export function resetCostIndex() {
  cached = null;
  cachedAt = 0;
  inFlight = null;
}
