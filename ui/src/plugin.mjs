/**
 * Registration — the only file that touches Kandev's registry, and the last one in the
 * bundle. Everything above it is either pure or a factory waiting for `host`.
 */

import { PLUGIN_ID } from "./config.mjs";
import { createOpsCostPage } from "./page.mjs";
import { createTaskCostPanel } from "./panel.mjs";
import { createTaskCostChip } from "./chip.mjs";
import { createTaskCardCost } from "./card.mjs";

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
