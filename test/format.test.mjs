/**
 * Unit tests for the formatting and encoding helpers.
 *
 * The subcent conversion is the one worth guarding hardest: it was previously back-derived
 * from token prices and the answer was wrong by 10x, which is exactly the class of error
 * that renders as a perfectly plausible dollar figure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { sqlQuote, isUnattributed, fmtUsd, fmtDuration } from "../ui/src/format.mjs";
import { fmtCount, fmtMTok, fmtTokenSplit, modelColor, MODEL_HUES } from "../ui/src/format.mjs";
import { fmtUsdShort, snapshotAge } from "../ui/src/format.mjs";

test("1 subcent is $0.0001, and the scale holds at both ends", () => {
  assert.equal(fmtUsd(10000), "$1.00");
  assert.equal(fmtUsd(2713976), "$271.40");
  assert.equal(fmtUsd(9046200), "$904.62");
  assert.equal(fmtUsd(1), "$0.00", "sub-cent spend rounds, it does not vanish into NaN");
});

test("a missing cost formats as zero, never as NaN or undefined", () => {
  assert.equal(fmtUsd(null), "$0.00");
  assert.equal(fmtUsd(undefined), "$0.00");
  assert.equal(fmtUsd(0), "$0.00");
});

test("quotes in user text are doubled, so a workspace named Henry's cannot break the SQL", () => {
  assert.equal(sqlQuote("Henry's"), "Henry''s");
  assert.equal(sqlQuote("a'b'c"), "a''b''c");
  assert.equal(sqlQuote("plain"), "plain");
});

test("both unattributed sentinels are recognised, and a real step is not", () => {
  assert.equal(isUnattributed("(step not attributable)"), true);
  assert.equal(isUnattributed("(before first stamped step)"), true);
  assert.equal(isUnattributed(null), true);
  assert.equal(isUnattributed(""), true);
  assert.equal(isUnattributed("Build"), false);
});

test("durations read at the scale they are, and zero is an em dash not '0s'", () => {
  assert.equal(fmtDuration(0), "—");
  assert.equal(fmtDuration(null), "—");
  assert.equal(fmtDuration(45), "45s");
  assert.equal(fmtDuration(600), "10m");
  assert.equal(fmtDuration(101520), "28.2h");
});

test("token counts are grouped, because nine digits are unreadable otherwise", () => {
  assert.equal(fmtCount(481481893), "481,481,893");
  assert.equal(fmtCount(0), "0");
});

test("token counts roll all the way up to billions", () => {
  // A single card's cache reads passed 1.7 billion. "1714.07M" is not a readable number.
  assert.equal(fmtMTok(1714070000), "1.71B");
  assert.equal(fmtMTok(1052450000), "1.05B");
  assert.equal(fmtMTok(106120000), "106.12M");
  assert.equal(fmtMTok(3795812), "3.80M");
  assert.equal(fmtMTok(36000), "36K");
  assert.equal(fmtMTok(1417), "1.4K");
  assert.equal(fmtMTok(611), "611");
  assert.equal(fmtMTok(0), "0");
});

test("the token split names all three classes, which bill differently", () => {
  assert.equal(fmtTokenSplit(1417, 62622226, 218700), "in 1.4K · cache 62.62M · out 219K");
});

test("a known model family always gets the same colour", () => {
  assert.equal(modelColor("opus[1m]"), MODEL_HUES.opus);
  assert.equal(modelColor("sonnet"), MODEL_HUES.sonnet);
  assert.equal(modelColor("gpt-5.6-sol"), MODEL_HUES.gpt);
  assert.equal(modelColor("claude-fable-5[1m]"), MODEL_HUES.fable);
});

test("two unknown models get different colours, so a split is never rendered as one model", () => {
  var a = modelColor("some-new-model");
  var b = modelColor("another-new-model");
  assert.notEqual(a, b);
  assert.equal(modelColor("some-new-model"), a, "and the same one on every render");
});

test("a missing model name still yields a usable colour", () => {
  assert.ok(/^hsl\(/.test(modelColor(null)));
  assert.ok(/^hsl\(/.test(modelColor(undefined)));
});

test("compact money fits a card badge, and never fakes a measured zero", () => {
  assert.equal(fmtUsdShort(9046200), "$905");
  assert.equal(fmtUsdShort(12000000), "$1.2k");
  assert.equal(fmtUsdShort(781210), "$78");
  assert.equal(fmtUsdShort(43000), "$4.3");
  assert.equal(fmtUsdShort(2398), "<$1");
  assert.equal(fmtUsdShort(0), null, "no badge beats a $0.00 that reads as measured");
  assert.equal(fmtUsdShort(null), null);
});


test("snapshot age is measured from the newest activity in the extract", () => {
  var now = Date.parse("2026-08-12T12:32:00Z");
  assert.equal(snapshotAge("2026-08-12T10:12:00Z", now), 8400); // 2h20m
  assert.equal(snapshotAge("2026-08-12T12:32:00Z", now), 0);
});

test("an unknowable age is null, never a fabricated number", () => {
  var now = Date.parse("2026-08-12T12:32:00Z");
  assert.equal(snapshotAge(null, now), null);
  assert.equal(snapshotAge("not a date", now), null);
  // Clock skew, or a snapshot stamped in the future. Better to say nothing than "-3.0h old".
  assert.equal(snapshotAge("2026-08-12T14:00:00Z", now), null);
});
