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

import { fmtUsd, OFF_LEDGER } from "./format.mjs";
import { loadTaskLedger } from "./ledger.mjs";
import { createTaskCostPanel } from "./panel.mjs";

export function createTaskCostChip(host) {
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
