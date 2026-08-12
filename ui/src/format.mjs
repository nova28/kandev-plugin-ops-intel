/**
 * Pure formatting and encoding. No DOM, no fetch, no host — so this file is directly
 * testable under `node --test`, and every unit in it is a place a wrong answer would be
 * silently plausible.
 */

import { UNATTRIBUTED } from "./config.mjs";

/**
 * Rill's `workspace` dimension holds the workspace NAME, not its id — extract.sql resolves
 * it as `COALESCE(NULLIF(w.name,''),'(unknown)')` and never carries workspace_id into the
 * models. So the join between Kandev and Rill is by name, and a name is user-supplied text:
 * doubling the quote is what keeps a workspace called "Henry's" from breaking both the SQL
 * and the filter expression in an iframe URL.
 */
export function sqlQuote(name) {
  return String(name).replace(/'/g, "''");
}

export function isUnattributed(step) {
  return !step || UNATTRIBUTED.indexOf(step) >= 0;
}

// 1 subcent = $0.0001, read from Kandev's own frontend currency formatter. Do NOT back-derive
// this from token prices — that was tried and the answer was wrong by 10x.
export function fmtUsd(subcents) {
  return "$" + (Number(subcents || 0) / 10000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtDuration(seconds) {
  var s = Number(seconds || 0);
  if (s <= 0) return "—";
  if (s < 90) return Math.round(s) + "s";
  if (s < 5400) return Math.round(s / 60) + "m";
  return (s / 3600).toFixed(1) + "h";
}

export function fmtCount(n) {
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
export function fmtMTok(n) {
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
export function fmtUsdShort(subcents) {
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
export function snapshotAge(lastActivityIso, nowMs) {
  if (!lastActivityIso) return null;
  var t = Date.parse(lastActivityIso);
  if (isNaN(t)) return null;
  var secs = ((nowMs == null ? Date.now() : nowMs) - t) / 1000;
  if (secs < 0) return null;
  return secs;
}

/** "in 1,417 · cache 62.62M · out 219K" — the three that bill differently. */
export function fmtTokenSplit(fresh, cached, out) {
  return "in " + fmtMTok(fresh) + " · cache " + fmtMTok(cached) + " · out " + fmtMTok(out);
}

// Amber is reserved throughout the panel for exactly one meaning: spend that is real but
// unpriced. It is never used for emphasis, so that when it appears the reader knows what it
// says without a legend.
export var OFF_LEDGER = "#d9a441";

// Model families get a stable hue so the same model reads the same colour on every card.
export var MODEL_HUES = {
  opus: "#b0567e", sonnet: "#4f8fa8", haiku: "#5f9e6e",
  gpt: "#8a7fbd", gemini: "#c08a4a", fable: "#a8618f", passthrough: "#7b7b7b",
};

/**
 * A colour for a model name. An unrecognised model gets a deterministic hue rather than a
 * shared grey: two unknown models sharing a swatch would render a two-model split as though
 * one model paid for everything.
 */
export function modelColor(name) {
  var n = String(name || "").toLowerCase();
  var keys = Object.keys(MODEL_HUES);
  for (var i = 0; i < keys.length; i++) {
    if (n.indexOf(keys[i]) >= 0) return MODEL_HUES[keys[i]];
  }
  var h = 0;
  for (var j = 0; j < n.length; j++) h = (h * 31 + n.charCodeAt(j)) % 360;
  return "hsl(" + h + ", 34%, 55%)";
}
