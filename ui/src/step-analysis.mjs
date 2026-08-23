import { fmtUsd, OFF_LEDGER } from "./format.mjs";
import { loadTaskLedger } from "./ledger.mjs";
import { createTaskCostPanel } from "./panel.mjs";

// A compact, always-mounted entry point. The full Rill ledger renders directly
// in an anchored popover, matching the chat-toolbar interaction pattern rather
// than taking over the screen with a modal.
export function createStepAnalysisAction(host) {
  var React = host.React;
  var h = host.jsx;
  var Panel = createTaskCostPanel(host);
  var ui = host.ui || {};
  var Button = ui.Button || "button";

  // POPOVER, NOT TOOLTIP — and the difference is not cosmetic.
  //
  // This surface used to be a Radix Tooltip with `pointer-events-auto`, on the reasoning that a
  // hover-anchored panel is cheaper to open than a click target. A tooltip closes when the
  // pointer leaves the grace polygon between trigger and content, and that polygon is a narrow
  // corridor: the trigger sits in the chat toolbar while the content is up to 820px wide above
  // it, so reaching anything on the far side of the panel — the start command, most obviously —
  // left the corridor and dismissed the panel mid-gesture. Selecting text inside it was worse
  // still, because the drag begins by moving away from the trigger.
  //
  // A popover is dismissed only by an explicit gesture (Escape, or a click outside), which is
  // what a surface you read, select from and click buttons inside has to be. Keep it a popover.
  var hasPopover = !!(ui.Popover && ui.PopoverTrigger && ui.PopoverContent);
  var Root = hasPopover ? ui.Popover : ui.Tooltip || "div";
  var Trigger = hasPopover ? ui.PopoverTrigger : ui.TooltipTrigger || "div";
  var Content = hasPopover ? ui.PopoverContent : ui.TooltipContent || "div";

  return function StepAnalysisAction(props) {
    var context = (props && props.slotProps) || {};
    var taskId = context.taskId;
    var stateHook = React.useState(null);
    var ledger = stateHook[0];
    var setLedger = stateHook[1];
    var openHook = React.useState(false);
    var open = openHook[0];
    var setOpen = openHook[1];

    React.useEffect(function () {
      if (!taskId) return undefined;
      var cancelled = false;
      setLedger(null);
      loadTaskLedger(taskId).then(
        function (next) { if (!cancelled) setLedger(next); },
        function () { if (!cancelled) setLedger({ state: "blocked" }); }
      );
      return function () { cancelled = true; };
    }, [taskId]);

    if (!taskId) return null;

    var ready = ledger && ledger.state === "ok";
    var label = ready
      ? fmtUsd(ledger.total) + " attributed across workflow steps" +
        (ledger.external ? "; " + ledger.external + " external calls are unpriced" : "")
      : "Open step analysis";

    return h(
      Root,
      { open: open, onOpenChange: setOpen },
      h(
        Trigger,
        { asChild: true },
        h(
          Button,
          {
            type: "button",
            variant: "ghost",
            size: ready ? "sm" : "icon",
            className: (ready ? "h-7 px-1.5 " : "h-7 w-7 ") +
              "cursor-pointer text-muted-foreground hover:text-foreground hover:bg-primary/10",
            title: label,
            "aria-label": "Open step analysis",
            "aria-expanded": open,
            // The popover trigger toggles `open` itself; adding our own handler on top of it
            // toggles twice in one click and the panel never opens. The tooltip fallback has
            // no such handler, so there it is the only thing that opens the panel.
            onClick: hasPopover ? undefined : function () { setOpen(!open); },
          },
          h("svg", { xmlns: "http://www.w3.org/2000/svg", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, h("circle", { cx: 8, cy: 8, r: 6 }), h("path", { d: "M18.09 10.37A6 6 0 1 1 10.34 18" })),
          ready ? h("span", { style: { marginLeft: "3px", fontSize: "11px", fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, fmtUsd(ledger.total)) : null,
          ready && ledger.external ? h("span", { style: { width: "10px", height: "7px", borderRadius: "2px", border: "1px solid " + OFF_LEDGER + "80", backgroundImage: "repeating-linear-gradient(45deg," + OFF_LEDGER + "6b 0 2px,transparent 2px 5px)" } }) : null
        )
      ),
      h(
        Content,
        {
          side: "top",
          align: "end",
          className: "pointer-events-auto p-0",
          // The ledger is a dense diagnostic, not a hint. Give the step rail
          // almost the whole viewport so model/account labels and its evidence
          // footer stay readable; only genuinely overlong cards scroll.
          // Both primitives carry a host width for ordinary content, so override
          // it explicitly: this is a full diagnostic surface.
          style: { width: "min(820px, calc(100vw - 32px))", maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 32px)", overflowY: "auto" },
        },
        h("div", { style: { padding: "20px 24px" } }, h(Panel, { taskId: taskId }))
      )
    );
  };
}
