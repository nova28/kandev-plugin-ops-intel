/**
 * Every network read the plugin performs. All of it goes to Rill; none of it goes to Kandev.
 *
 * That is the architectural choice this whole plugin rests on: the analysis lives in a Rill
 * semantic layer where each measure carries the reasoning for its expression in a reviewable
 * YAML file, so there is exactly one definition of what a dollar means. The price is that
 * Rill reads a point-in-time snapshot, and every caller here has to be honest about it.
 */

import { RILL_ORIGIN, RILL_INSTANCE, COST_MODEL } from "./config.mjs";
import { sqlQuote } from "./format.mjs";

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
export function lastQueryError() {
  return lastError;
}
export function rillQuery(sql, timeoutMs) {
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
export function probeRill() {
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
export function probeWorkspace(name) {
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
export function viewSrc(path, workspaceName) {
  if (!workspaceName) return RILL_ORIGIN + path;
  var expr = "workspace IN ('" + sqlQuote(workspaceName) + "')";
  return RILL_ORIGIN + path + "?f=" + encodeURIComponent(expr);
}

/** The active workspace's name, or null when the host store has not settled yet. */
export function activeWorkspaceName(store) {
  if (!store || !store.getState) return null;
  var ws = store.getState().workspaces;
  if (!ws || !ws.activeId || !ws.items) return null;
  var match = ws.items.filter(function (w) { return w.id === ws.activeId; })[0];
  return (match && match.name) || null;
}
