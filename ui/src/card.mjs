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

import { fmtUsd, fmtUsdShort, OFF_LEDGER } from "./format.mjs";
import { loadCostIndex } from "./cost-index.mjs";

export function createTaskCardCost(host) {
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
