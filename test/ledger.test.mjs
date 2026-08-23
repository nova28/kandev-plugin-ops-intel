/**
 * Unit tests for the pure half of the task ledger.
 *
 * These cover the decisions that would be silently plausible if wrong — a rail in the wrong
 * order still renders, a dropped off-ledger count still shows a confident total, an
 * unreadable query still looks like a free task. None of those would throw; all of them
 * would mislead. That is what is worth a test here.
 *
 * Run with `make test` (node --test, no dependencies).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleLedger, ledgerQueries, stepSegments, stepTotal } from "../ui/src/ledger.mjs";
import { mergeBy } from "../ui/src/ledger.mjs";

/**
 * A step at the grain the cost query actually returns: one entry per (model, profile).
 * Building fixtures from `models` instead was how these tests drifted from the code.
 */
function stepOf(entries) {
  return {
    entries: entries.map((e) => ({
      model: e.model, profile: e.profile || "(none)", subcents: e.subcents, out: e.out || 0,
    })),
    subcents: entries.reduce((n, e) => n + e.subcents, 0),
    models: mergeBy(entries.map((e) => ({ model: e.model, subcents: e.subcents, out: 0 })), "model"),
  };
}

/** The workflow order every fixture below is laid against. */
var ORDER = [
  { step: "Spec", pos: 1 },
  { step: "Build", pos: 3 },
  { step: "Testing", pos: 4 },
  { step: "Review", pos: 5 },
];

function costRow(step, model, subcents, firstAt, extra) {
  return Object.assign({
    step: step, model: model, subcents: subcents, events: 1, first_at: firstAt,
    cached_in: 0, fresh_in: 0, out_tokens: 0, synthesized_events: 0, is_verdict: false,
  }, extra || {});
}

test("a refused read is 'blocked', never a free task", () => {
  assert.equal(assembleLedger(null, null, null, null, null).state, "blocked");
});

test("a readable but empty answer is 'empty', and keeps peer context", () => {
  var r = assembleLedger([], [], [], [{ n_tasks: 9 }], ORDER);
  assert.equal(r.state, "empty");
  assert.equal(r.peers.n_tasks, 9);
});

test("the rail follows the workflow's step order, not the order spend was first seen", () => {
  // Deliberately scrambled: Testing and Review are observed BEFORE Build, which is what two
  // interleaved sessions plus partial step stamping actually produces. Sorting by first_at
  // would publish that stamping artifact as a process bounce.
  var cost = [
    costRow("Spec", "opus", 100, "2026-08-08T05:00:00Z"),
    costRow("Testing", "sonnet", 200, "2026-08-08T15:09:00Z"),
    costRow("Review", "sonnet", 300, "2026-08-08T15:25:00Z"),
    costRow("Build", "sonnet", 400, "2026-08-08T15:42:00Z"),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER);
  assert.deepEqual(r.rail.map((s) => s.step), ["Spec", "Build", "Testing", "Review"]);
});

test("a step the workflow no longer defines keeps its spend and sorts last", () => {
  var cost = [
    costRow("Retired Step", "sonnet", 50, "2026-08-08T04:00:00Z"),
    costRow("Spec", "opus", 100, "2026-08-08T05:00:00Z"),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER);
  assert.deepEqual(r.rail.map((s) => s.step), ["Spec", "Retired Step"]);
  assert.deepEqual(r.undefinedSteps, ["Retired Step"]);
  assert.equal(r.total, 150); // it is still counted, not dropped
});

test("both unattributed sentinels collapse into one bucket, out of the rail", () => {
  var cost = [
    costRow("(step not attributable)", "opus", 70, "2026-08-07T15:00:00Z"),
    costRow("Spec", "opus", 100, "2026-08-08T05:00:00Z"),
  ];
  var external = [{ step: "(before first stamped step)", agent: "codex", n: 2 }];
  var r = assembleLedger(cost, external, [], [], ORDER);

  assert.deepEqual(r.rail.map((s) => s.step), ["Spec"]);
  assert.equal(r.unattributed.subcents, 70);
  assert.equal(r.unattributed.external, 2, "both spellings land in the same bucket");
  assert.equal(r.total, 170, "unattributed spend still counts toward the total");
});

test("off-ledger calls roll up per step and across the card", () => {
  var cost = [costRow("Review", "sonnet", 300, "2026-08-08T15:25:00Z")];
  var external = [
    { step: "Review", agent: "codex", n: 7 },
    { step: "Review", agent: "agy", n: 3 },
  ];
  var r = assembleLedger(cost, external, [], [], ORDER);
  assert.equal(r.external, 10);
  assert.deepEqual(r.externalAgents, { codex: 7, agy: 3 });
  assert.equal(r.rail[0].external, 10);
});

test("off-ledger calls carry a best-effort model breakdown, never a price", () => {
  var cost = [costRow("Review", "sonnet", 300, "2026-08-08T15:25:00Z")];
  var external = [
    { step: "Review", agent: "codex", model: "gpt-5.2-codex", n: 4 },
    // Most codex/agy calls name no model at all — extract.sql reports that as NULL, which the
    // query layer never sees because the row is absent from `model`, not present as null.
    { step: "Review", agent: "codex", n: 12 },
    { step: "Review", agent: "agy", model: "gpt-5.1", n: 3 },
  ];
  var r = assembleLedger(cost, external, [], [], ORDER);

  assert.deepEqual(r.rail[0].externalAgentModels, {
    codex: { "gpt-5.2-codex": 4, "(unspecified)": 12 },
    agy: { "gpt-5.1": 3 },
  });
  assert.deepEqual(r.externalAgentModels, {
    codex: { "gpt-5.2-codex": 4, "(unspecified)": 12 },
    agy: { "gpt-5.1": 3 },
  });
  // The agent-level count is unaffected — it was already right and nothing here should change it.
  assert.deepEqual(r.externalAgents, { codex: 16, agy: 3 });
});

test("off-ledger model breakdown rolls up across steps at the card level", () => {
  // A non-empty on-ledger cost keeps this out of the "empty" early return (see the test above
  // this one for that case) — the point here is the cross-step model rollup, not zero-spend.
  var cost = [costRow("Spec", "opus", 100, "2026-08-08T05:00:00Z")];
  var external = [
    { step: "Review", agent: "codex", model: "gpt-5.2-codex", n: 2 },
    { step: "Build", agent: "codex", model: "gpt-5.2-codex", n: 5 },
    { step: "Build", agent: "codex", model: "gpt-5", n: 1 },
  ];
  var r = assembleLedger(cost, external, [], [], ORDER);
  assert.deepEqual(r.externalAgentModels, { codex: { "gpt-5.2-codex": 7, "gpt-5": 1 } });
});

test("a step with only off-ledger calls survives, at zero on-ledger cost", () => {
  var cost = [costRow("Spec", "opus", 100, "2026-08-08T05:00:00Z")];
  var external = [{ step: "Build", agent: "codex", n: 4 }];
  var r = assembleLedger(cost, external, [], [], ORDER);
  var build = r.rail.filter((s) => s.step === "Build")[0];
  assert.ok(build, "a step that spent nothing here but called out is still shown");
  assert.equal(build.subcents, 0);
  assert.equal(build.external, 4);
});

test("models within a step are ordered by spend, heaviest first", () => {
  var cost = [
    costRow("Build", "sonnet", 100, "2026-08-08T15:00:00Z"),
    costRow("Build", "opus", 900, "2026-08-08T15:30:00Z"),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER);
  assert.deepEqual(r.rail[0].models.map((m) => m.model), ["opus", "sonnet"]);
  assert.equal(r.rail[0].subcents, 1000);
});

test("negative idle gaps never deflate a step's wall time", () => {
  // The SQL clamps at source; this asserts the assembler does not reintroduce a negative.
  var cost = [costRow("Build", "sonnet", 100, "2026-08-08T15:00:00Z")];
  var timing = [{ step: "Build", turns: 3, agent_s: 600, idle_s: 0, first_at: "2026-08-08T14:00:00Z" }];
  var r = assembleLedger(cost, timing.length ? [] : [], timing, [], ORDER);
  assert.equal(r.rail[0].agentS, 600);
  assert.ok(r.rail[0].idleS >= 0);
});

test("each optional query degrades on its own, and says so", () => {
  var cost = [costRow("Spec", "opus", 100, "2026-08-08T05:00:00Z")];
  var r = assembleLedger(cost, null, null, null, null);
  assert.equal(r.state, "ok", "money still renders when the extras are unreadable");
  assert.deepEqual(r.degraded, { timing: true, external: true, peers: true, order: true });
});

test("an empty order table degrades to first-seen and flags it", () => {
  var cost = [
    costRow("Testing", "sonnet", 200, "2026-08-08T15:09:00Z"),
    costRow("Spec", "opus", 100, "2026-08-08T05:00:00Z"),
  ];
  var r = assembleLedger(cost, [], [], [], []);
  assert.equal(r.degraded.order, true, "the footer must admit the order is not the workflow's");
  assert.deepEqual(r.rail.map((s) => s.step), ["Spec", "Testing"]);
});

test("token totals sum across every step, attributed or not", () => {
  var cost = [
    costRow("Spec", "opus", 100, "2026-08-08T05:00:00Z", { cached_in: 62622226, fresh_in: 1417 }),
    costRow("(step not attributable)", "opus", 50, "2026-08-07T15:00:00Z", { cached_in: 10, fresh_in: 5 }),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER);
  assert.equal(r.cached, 62622236);
  assert.equal(r.fresh, 1422);
});

test("models roll up across every step, heaviest first, and add up to the total", () => {
  var cost = [
    costRow("Build", "sonnet", 100, "2026-08-08T15:00:00Z"),
    costRow("Build", "opus", 300, "2026-08-08T15:10:00Z"),
    costRow("Testing", "sonnet", 600, "2026-08-08T16:00:00Z"),
    costRow("(step not attributable)", "opus", 50, "2026-08-07T15:00:00Z"),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER);
  assert.deepEqual(r.models.map((m) => [m.model, m.subcents]), [
    ["sonnet", 700],
    ["opus", 350],
  ]);
  assert.equal(r.models.reduce((n, m) => n + m.subcents, 0), r.total,
    "a legend whose totals do not sum to the headline would be its own bug");
});

test("segments follow the card's model order, not the step's own", () => {
  // opus is the card's heaviest model, so it leads the legend — and must lead every bar,
  // including a step where it was the lesser spender.
  var order = ["opus", "sonnet"];
  var step = stepOf([{ model: "sonnet", subcents: 900 }, { model: "opus", subcents: 100 }]);
  assert.deepEqual(stepSegments(step, order, null).map((s) => s.model), ["opus", "sonnet"]);
});

test("a model a step never used produces no segment, rather than a zero-width one", () => {
  var step = stepOf([{ model: "sonnet", subcents: 500 }]);
  assert.deepEqual(stepSegments(step, ["opus", "sonnet"], null),
    [{ model: "sonnet", subcents: 500 }]);
});

test("isolating a model narrows both the segments and the step total", () => {
  var step = stepOf([{ model: "sonnet", subcents: 900 }, { model: "opus", subcents: 100 }]);
  assert.deepEqual(stepSegments(step, ["sonnet", "opus"], "opus"),
    [{ model: "opus", subcents: 100 }]);
  assert.equal(stepTotal(step, "opus"), 100);
  assert.equal(stepTotal(step, null), 1000, "unfiltered is the step's whole spend");
});

test("isolating a model a step never used gives zero, not the step's full cost", () => {
  var step = stepOf([{ model: "sonnet", subcents: 500 }]);
  assert.equal(stepTotal(step, "opus"), 0);
  assert.deepEqual(stepSegments(step, ["sonnet", "opus"], "opus"), []);
});

test("segment widths within a step sum to the step's filtered total", () => {
  var step = stepOf([{ model: "sonnet", subcents: 700 }, { model: "opus", subcents: 300 }]);
  var segs = stepSegments(step, ["sonnet", "opus"], null);
  assert.equal(segs.reduce((n, s) => n + s.subcents, 0), stepTotal(step, null));
});

test("one model split across attribution bases is merged, not listed twice", () => {
  // The cost query groups by step, model AND basis, so the same model legitimately arrives
  // as two rows for one step. Pushing them would double it in the legend and in every bar.
  var cost = [
    costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z", { is_verdict: false }),
    costRow("Build", "sonnet", 600, "2026-08-08T15:20:00Z", { is_verdict: true }),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER);
  assert.equal(r.rail[0].models.length, 1, "sonnet appears once");
  assert.equal(r.rail[0].models[0].subcents, 1000);
  assert.equal(r.models.length, 1, "and once in the card-level legend too");
  assert.equal(r.models[0].model, "sonnet");
  assert.equal(r.models[0].subcents, 1000);
  assert.equal(stepSegments(r.rail[0], ["sonnet"], null).length, 1);
});

test("majority-verdict spend is counted per step and across the card", () => {
  var cost = [
    costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z", { is_verdict: false }),
    costRow("Build", "sonnet", 600, "2026-08-08T15:20:00Z", { is_verdict: true }),
    costRow("Testing", "sonnet", 200, "2026-08-08T16:00:00Z", { is_verdict: true }),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER);
  assert.equal(r.rail[0].verdict, 600, "only the verdict half of Build counts");
  assert.equal(r.verdict, 800);
  assert.equal(r.total, 1200, "the verdict share is part of the total, not extra to it");
});

test("a card whose windows all sat in one step reports no verdict spend", () => {
  var cost = [costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z")];
  assert.equal(assembleLedger(cost, [], [], [], ORDER).verdict, 0);
});

test("throughput is output tokens over agent seconds, per model", () => {
  var cost = [
    costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z", { out_tokens: 30000 }),
    costRow("Review", "opus", 600, "2026-08-08T16:00:00Z", { out_tokens: 20000 }),
  ];
  var timing = [{ model: "sonnet", secs: 1000 }, { model: "opus", secs: 500 }];
  var r = assembleLedger(cost, [], [], [], ORDER, timing);
  var bySonnet = r.models.filter((m) => m.model === "sonnet")[0];
  var byOpus = r.models.filter((m) => m.model === "opus")[0];
  assert.equal(bySonnet.tokPerSec, 30);
  assert.equal(byOpus.tokPerSec, 40);
});

test("a throughput figure is withheld, not zeroed, when the sample is too thin", () => {
  var cost = [costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z", { out_tokens: 9000 })];
  // 30 seconds is under the floor — one lucky turn is not a rate.
  var r = assembleLedger(cost, [], [], [], ORDER, [{ model: "sonnet", secs: 30 }]);
  assert.equal(r.models[0].tokPerSec, null);
  assert.equal(r.models[0].agentS, 30, "the time itself is still reported");
});

test("a model with no recorded turn time gets no rate rather than a divide by zero", () => {
  var cost = [costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z", { out_tokens: 9000 })];
  var r = assembleLedger(cost, [], [], [], ORDER, []);
  assert.equal(r.models[0].tokPerSec, null);
  assert.ok(Number.isFinite(r.models[0].agentS));
});

test("output tokens roll up per model and across the card", () => {
  var cost = [
    costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z", { out_tokens: 1000, cached_in: 5e6, fresh_in: 40 }),
    costRow("Testing", "sonnet", 200, "2026-08-08T16:00:00Z", { out_tokens: 500, cached_in: 2e6, fresh_in: 10 }),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER, []);
  assert.equal(r.models[0].out, 1500);
  assert.equal(r.out, 1500);
  assert.equal(r.cached, 7e6);
  assert.equal(r.fresh, 50);
});

test("a task id carrying a quote cannot break out of the SQL", () => {
  var sql = ledgerQueries("abc'; DROP TABLE kandev_cost; --").join("\n");
  assert.ok(!/abc'; DROP/.test(sql), "the raw quote must not survive into the statement");
  assert.ok(sql.includes("abc''; DROP TABLE kandev_cost; --"), "it is doubled, not stripped");
});

test("every per-card query names a task id, so none can scan the whole store", () => {
  var qs = ledgerQueries("task-1");
  assert.equal(qs.length, 9);
  // All but the last are per-card and must say so. The last is the snapshot-freshness probe:
  // a global property of the extract, not of any card, so it cannot be task-scoped. It is
  // carved out by name rather than by loosening the check, which is the whole guard against
  // a per-card query quietly becoming a full scan.
  qs.slice(0, 7).concat([qs[8]]).forEach((sql, i) => {
    assert.ok(sql.includes("task-1"), `query ${i} is not scoped to the task`);
  });
  var freshness = qs[7];
  assert.ok(/^SELECT max\(created_at\)/.test(freshness), "the global query is the freshness probe");
  assert.ok(!/task_id/.test(freshness), "and it is deliberately not card-scoped");
});

// ---------------------------------------------------------------------------------------
// The empty state is three different facts with three different fixes. Getting this wrong
// is not a crash — it is a panel confidently sending someone to re-run an extract that
// cannot help, which is what it did before these tests existed.
// ---------------------------------------------------------------------------------------

test("a card missing from the snapshot is flagged as absent — the re-extract case", () => {
  var r = assembleLedger([], [], [], [], ORDER, [], [{ in_snapshot: 0 }]);
  assert.equal(r.state, "empty");
  assert.equal(r.inSnapshot, false);
});

test("a card present in the snapshot that ran turns but billed nothing is NOT absent", () => {
  // Cost events flush at a step transition; a session still on its first step has none
  // anywhere, live database included. Re-extracting cannot fix this one.
  var r = assembleLedger([], [], [{ step: "Build", turns: 1 }], [], ORDER, [],
    [{ in_snapshot: 1 }]);
  assert.equal(r.inSnapshot, true);
  assert.equal(r.turns, 1, "the turn count is what distinguishes 'ran' from 'never started'");
});

test("a card present in the snapshot that never ran reports zero turns", () => {
  var r = assembleLedger([], [], [], [], ORDER, [], [{ in_snapshot: 1 }]);
  assert.equal(r.inSnapshot, true);
  assert.equal(r.turns, 0);
});

test("an unreadable presence check yields unknown, never a false 'absent'", () => {
  var r = assembleLedger([], [], [], [], ORDER, [], null);
  assert.equal(r.inSnapshot, null, "guessing 'absent' would send the reader to re-extract");
});

test("off-ledger calls surface even when the card billed nothing of its own", () => {
  var r = assembleLedger([], [{ step: "Review", agent: "codex", n: 5 }], [], [], ORDER, [],
    [{ in_snapshot: 1 }]);
  assert.equal(r.external, 5, "a card whose every agent billed elsewhere is the most understated");
});


// ---------------------------------------------------------------------------------------
// Accounts. On a machine running several agent profiles, the model does not say whose bill
// a card landed on — two profiles run the same model and bill different accounts.
// ---------------------------------------------------------------------------------------

test("accounts roll up per card and sum to the total", () => {
  var cost = [
    costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z", { profile: "1acc - Sonnet" }),
    costRow("Build", "sonnet", 600, "2026-08-08T15:10:00Z", { profile: "Sonnet" }),
    costRow("Spec", "opus", 300, "2026-08-08T05:00:00Z", { profile: "Opus (1M context)" }),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER, []);
  assert.deepEqual(r.profiles.map((p) => [p.profile, p.subcents]), [
    ["Sonnet", 600], ["1acc - Sonnet", 400], ["Opus (1M context)", 300],
  ]);
  assert.equal(r.profiles.reduce((n, p) => n + p.subcents, 0), r.total);
});

test("one model split across two accounts stays ONE model in the legend", () => {
  // The whole point: same model, different bills. The model legend must not double it.
  var cost = [
    costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z", { profile: "1acc - Sonnet" }),
    costRow("Build", "sonnet", 600, "2026-08-08T15:10:00Z", { profile: "Sonnet" }),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER, []);
  assert.equal(r.models.length, 1);
  assert.equal(r.models[0].subcents, 1000);
  assert.equal(r.profiles.length, 2, "but it is two accounts");
});

test("isolating an account narrows the step, independently of the model filter", () => {
  var step = stepOf([
    { model: "sonnet", profile: "1acc - Sonnet", subcents: 400 },
    { model: "sonnet", profile: "Sonnet", subcents: 600 },
    { model: "opus", profile: "Sonnet", subcents: 300 },
  ]);
  assert.equal(stepTotal(step, null, "1acc - Sonnet"), 400);
  assert.equal(stepTotal(step, null, "Sonnet"), 900);
  assert.equal(stepTotal(step, "sonnet", "Sonnet"), 600, "both filters combine");
  assert.equal(stepTotal(step, null, null), 1300);
});

test("segments stay keyed on model when an account is isolated", () => {
  // Colour means model everywhere in this panel; having it silently mean account under a
  // filter would make the filtered and unfiltered views unreadable against each other.
  var step = stepOf([
    { model: "sonnet", profile: "Sonnet", subcents: 600 },
    { model: "opus", profile: "Sonnet", subcents: 300 },
    { model: "sonnet", profile: "1acc - Sonnet", subcents: 400 },
  ]);
  assert.deepEqual(stepSegments(step, ["sonnet", "opus"], null, "Sonnet"),
    [{ model: "sonnet", subcents: 600 }, { model: "opus", subcents: 300 }]);
});

test("an account that never touched a step yields no segments and zero", () => {
  var step = stepOf([{ model: "sonnet", profile: "Sonnet", subcents: 500 }]);
  assert.deepEqual(stepSegments(step, ["sonnet"], null, "1acc - Sonnet"), []);
  assert.equal(stepTotal(step, null, "1acc - Sonnet"), 0);
});

test("a missing profile becomes '(none)' rather than an undefined key", () => {
  var cost = [costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z", { profile: null })];
  var r = assembleLedger(cost, [], [], [], ORDER, []);
  assert.equal(r.profiles[0].profile, "(none)");
});

test("a single-account card still reports its account", () => {
  // Every card in this store bills to exactly one account, so gating the account display at
  // "two or more" — the way the model legend is gated — would hide it everywhere.
  var cost = [
    costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z", { profile: "2acc- Opus" }),
    costRow("Spec", "opus", 600, "2026-08-08T05:00:00Z", { profile: "2acc- Opus" }),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER, []);
  assert.equal(r.profiles.length, 1);
  assert.equal(r.profiles[0].profile, "2acc- Opus");
  assert.equal(r.profiles[0].subcents, 1000, "one account, the card's whole spend");
});

test("spend whose account came from the session is counted separately", () => {
  var cost = [
    costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z",
      { profile: "1acc - Opus", profile_inferred: true }),
    costRow("Spec", "opus", 600, "2026-08-08T05:00:00Z",
      { profile: "1acc - Opus", profile_inferred: false }),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER, []);
  assert.equal(r.inferredProfile, 400, "only the half read off the session");
  assert.equal(r.total, 1000);
});

// ---------------------------------------------------------------------------------------
// HOW THE PER-STEP SPLIT WAS RESOLVED. Two mechanisms with very different trustworthiness.
//
// 'turn stamp' is a reading: Kandev recorded the step on the turn, at turn creation, in the
// same transaction. Anything else is the billing-window reconstruction, which is wrong on
// any workflow that runs different steps under different agent profiles — a session parks on
// the label of a step another session is executing, and its next wake bills there. Measured
// at 25.4% of post-cutover dollars landing on the wrong step before this was fixed.
//
// So the panel must never call an inferred split exact. These tests pin that, and pin the
// weighting: the basis is decided by DOLLARS, not row counts.
// ---------------------------------------------------------------------------------------

function withSource(rows) {
  var cost = [costRow("Build", "sonnet", 100, "2026-08-08T15:00:00Z")];
  return assembleLedger(cost, [], [], [], ORDER, [], [{ in_snapshot: 1 }], [], rows);
}

test("a card attributed entirely from turn stamps is reported as exact", () => {
  assert.equal(withSource([{ stamped: 5000, inferred: 0 }]).stepBasis, "stamp");
});

test("a card attributed entirely from billing windows says it is inferred", () => {
  assert.equal(withSource([{ stamped: 0, inferred: 5000 }]).stepBasis, "inferred");
});

test("a card straddling the turn_id cutover is reported as mixed, not as either one", () => {
  // Claiming "exact" for a card that is half reconstructed would be the worst of the three.
  assert.equal(withSource([{ stamped: 3000, inferred: 2000 }]).stepBasis, "mixed");
});

test("one inferred dollar on an otherwise-stamped card still downgrades it to mixed", () => {
  // The regression this guards: a threshold or a row count would round this to "exact" and
  // the reader would quote a per-step figure that has a reconstructed component in it. The
  // rail is only as exact as its least exact row.
  assert.equal(withSource([{ stamped: 999999, inferred: 1 }]).stepBasis, "mixed");
});

test("basis is weighted by spend, so one big inferred event cannot hide behind many stamps", () => {
  // Counting rows would call this card exact on a 1:1 split of the money. The event that
  // moves the most money is exactly the one whose attribution matters.
  assert.equal(withSource([{ stamped: 100, inferred: 90000 }]).stepBasis, "mixed");
});

test("a card with no attributed spend yields null, not a false claim of exactness", () => {
  // An empty sum is not evidence of an exact reading. Defaulting to "stamp" here would put
  // "exact" under every card whose spend is entirely unattributable.
  assert.equal(withSource([{ stamped: 0, inferred: 0 }]).stepBasis, null);
  assert.equal(withSource([]).stepBasis, null);
  assert.equal(withSource(null).stepBasis, null);
});

test("a majority-verdict window is still counted as spend needing the caveat", () => {
  // `verdict` is independent of stepBasis and keys off 'dominant of%'. A turn-stamped row
  // must never land in it — the stamp does not straddle anything.
  var cost = [
    costRow("Build", "sonnet", 400, "2026-08-08T15:00:00Z", { is_verdict: true }),
    costRow("Review", "opus", 600, "2026-08-08T16:00:00Z", { is_verdict: false }),
  ];
  var r = assembleLedger(cost, [], [], [], ORDER, []);
  assert.equal(r.verdict, 400, "only the row whose window crossed a boundary");
});
