/**
 * Every constant the plugin is configured by, in one place.
 *
 * These are compile-time constants on purpose. A private plugin does not justify a config
 * round trip through the backend to learn one port number, and the alternative — reading
 * settings at runtime — would add a failure mode to a surface whose whole job is to be
 * honest about failure.
 */

export var PLUGIN_ID = "kandev-plugin-ops-intel";

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
  // An explore, not a canvas, and deliberately. It serves two opposite readings of one grain
  // — one card down its steps, or one step across every card — and a fixed layout would have
  // to promote one and demote the other. See the header of metrics/card_steps.yaml.
  { id: "cardsteps", label: "Card × step (explore)", path: "/explore/card_steps" },
  // The two request-grain views. Both read Claude Code transcripts rather than Kandev's store
  // — see models/kandev_requests.yaml for why that second source exists — so both are blank
  // for steps that ran on codex or agy. Blank meaning "not observable", never "free".
  { id: "requests", label: "Request ledger (explore)", path: "/explore/request_ledger" },
  { id: "tooleconomics", label: "Tool economics (explore)", path: "/explore/tool_economics" },
  { id: "overview", label: "Overview", path: "/canvas/overview" },
  { id: "anomalies", label: "Anomalies (explore)", path: "/explore/anomalies" },
];

// --allowed-origins is what lets every read in rill.mjs return a response instead of an
// opaque one. Without it the tab still works — the filter just applies unverified — but the
// task panel cannot read anything at all, and says so.
//
// Deliberately relative, with no leading `cd`: every developer clones this plugin somewhere
// different, and a plugin id or bundle build has no way to know where. The UI that renders
// this string is responsible for saying "run this from the rill/ directory of your checkout"
// as prose alongside it — see START_COMMAND_HINT.
export var START_COMMAND =
  "./extract/extract.sh && rill start . --allowed-origins http://localhost:8817";

export var START_COMMAND_HINT = "From the rill/ directory of your plugin checkout, run:";

// Both sentinels mean the same thing — the event happened before its session's first step
// stamp, so it belongs to no step. The models spell it differently and the ledger must treat
// them as one bucket rather than rendering two mystery rows in the rail.
export var UNATTRIBUTED = ["(step not attributable)", "(before first stamped step)"];
