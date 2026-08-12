/**
 * Every constant the plugin is configured by, in one place.
 *
 * These are compile-time constants on purpose. A private plugin does not justify a config
 * round trip through the backend to learn one port number, and the alternative — reading
 * settings at runtime — would add a failure mode to a surface whose whole job is to be
 * honest about failure.
 */

export var PLUGIN_ID = "kandev-plugin-opscost";

// The local Rill dev server. Edit here if you run it on another port.
export var RILL_ORIGIN = "http://localhost:9009";

// Rill's dev server always names its single instance "default".
export var RILL_INSTANCE = "default";

// The four models the plugin reads.
//
// The first three record what HAPPENED, and each carries `step_at_event` — the step resolved
// by ASOF join onto the step-stamp timeline. That column is the only reason a per-step
// readout is possible at all: no cost event, message or turn in Kandev records a step.
//
// The fourth records what was SUPPOSED to happen — the workflow's declared step order — and
// is what lets the ledger be laid out in the same sequence as the rail on a task page.
export var COST_MODEL = "kandev_cost";
export var ACTIVITY_MODEL = "kandev_activity";
export var TURNS_MODEL = "kandev_turns";
export var STEPS_MODEL = "src_dim_workflow_step";

export var VIEWS = [
  { id: "embedded", label: "Cost, steps & anomalies", path: "/canvas/embedded" },
  { id: "steps", label: "Workspace & step deep dive", path: "/canvas/step_deep_dive" },
  { id: "overview", label: "Overview", path: "/canvas/overview" },
  { id: "anomalies", label: "Anomalies (explore)", path: "/explore/anomalies" },
];

// --allowed-origins is what lets every read in rill.mjs return a response instead of an
// opaque one. Without it the tab still works — the filter just applies unverified — but the
// task panel cannot read anything at all, and says so.
export var START_COMMAND =
  "cd ~/Projects/SoftwareFactory/kandev-plugin-opscost/rill && ./extract/extract.sh && " +
  "rill start . --allowed-origins http://localhost:8817";

// Both sentinels mean the same thing — the event happened before its session's first step
// stamp, so it belongs to no step. The models spell it differently and the ledger must treat
// them as one bucket rather than rendering two mystery rows in the rail.
export var UNATTRIBUTED = ["(step not attributable)", "(before first stamped step)"];
