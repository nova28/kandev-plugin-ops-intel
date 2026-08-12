/**
 * The board index. The property under test is mostly a COST property, not a correctness one:
 * a board with forty cards must produce two queries, not eighty. That is easy to regress by
 * moving one line and impossible to notice locally, where everything is fast.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleCostIndex, costIndexQueries, loadCostIndex, resetCostIndex }
  from "../ui/src/cost-index.mjs";

test("a refused read yields ok:false, so cards render nothing rather than $0.00", () => {
  var i = assembleCostIndex(null, null);
  assert.equal(i.ok, false);
  assert.deepEqual(i.byTask, {});
});

test("spend and off-ledger calls merge per task", () => {
  var i = assembleCostIndex(
    [{ task_id: "a", subcents: 9046200 }, { task_id: "b", subcents: 781210 }],
    [{ task_id: "a", n: 63 }]
  );
  assert.deepEqual(i.byTask.a, { subcents: 9046200, external: 63 });
  assert.deepEqual(i.byTask.b, { subcents: 781210, external: 0 });
});

test("a card with only off-ledger calls still gets an entry", () => {
  // Every one of its agents billed somewhere else — the most understated card on the board.
  // Skipping it for having no dollar figure would hide exactly the case worth seeing.
  var i = assembleCostIndex([], [{ task_id: "c", n: 4 }]);
  assert.deepEqual(i.byTask.c, { subcents: 0, external: 4 });
});

test("rows without a task id are dropped rather than keyed under empty string", () => {
  var i = assembleCostIndex([{ task_id: "", subcents: 500 }, { task_id: null, subcents: 5 }], []);
  assert.deepEqual(Object.keys(i.byTask), []);
});

test("the whole board costs two queries, and both are aggregates", () => {
  var qs = costIndexQueries();
  assert.equal(qs.length, 2);
  qs.forEach(function (sql) {
    assert.ok(/GROUP BY/.test(sql), "must aggregate server-side, not stream rows per card");
  });
  assert.ok(!/task_id = /.test(qs.join(" ")), "must not be scoped to a single card");
});

test("forty cards mounting at once issue two queries, not eighty", async () => {
  resetCostIndex();
  var calls = 0;
  var query = function () {
    calls++;
    return new Promise(function (r) { setTimeout(function () { r([]); }, 5); });
  };
  await Promise.all(Array.from({ length: 40 }, function () { return loadCostIndex(query); }));
  assert.equal(calls, 2, "concurrent callers share one in-flight load");
});

test("a second board render inside the TTL re-queries nothing", async () => {
  resetCostIndex();
  var calls = 0;
  var query = function () { calls++; return Promise.resolve([]); };
  await loadCostIndex(query);
  await loadCostIndex(query);
  await loadCostIndex(query);
  assert.equal(calls, 2, "the memo serves every later card");
});

test("a failed load is not cached, so fixing Rill does not need a reload", async () => {
  resetCostIndex();
  var calls = 0;
  var query = function () {
    calls++;
    // First pair fails (null = unreadable), second pair succeeds.
    return Promise.resolve(calls <= 2 ? null : [{ task_id: "a", subcents: 100 }]);
  };
  var first = await loadCostIndex(query);
  assert.equal(first.ok, false);
  var second = await loadCostIndex(query);
  assert.equal(second.ok, true, "the retry actually re-queries instead of serving the failure");
  assert.equal(calls, 4);
});
