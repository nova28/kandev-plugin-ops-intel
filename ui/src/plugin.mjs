/**
 * Registration — the only file that touches Kandev's registry, and the last one in the
 * bundle. Everything above it is either pure or a factory waiting for `host`.
 */

import { PLUGIN_ID } from "./config.mjs";
import { createGaugeIcon } from "./icon.mjs";
import { createOpsCostPage } from "./page.mjs";
import { createStepAnalysisAction } from "./step-analysis.mjs";

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
