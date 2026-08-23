/**
 * THE OPS COST TAB — a full-bleed route framing a locally running Rill, filtered to whichever
 * workspace is open in Kandev.
 *
 * WHY THE FILTER IS PROBED BEFORE IT IS APPLIED. Rill reads a point-in-time snapshot, so a
 * workspace can be perfectly real in Kandev and absent from Rill — filtering to it would
 * render an empty dashboard indistinguishable from a broken plugin. The page asks Rill
 * whether the workspace has any spend first, and shows everything (with a reason) when it
 * does not.
 *
 * WHY AN IFRAME AND NOT NATIVE PANELS. Each Rill measure carries the reasoning for its
 * expression in a reviewable YAML file. Porting those charts to React would fork that logic
 * into a second place and guarantee the two drift.
 *
 * WHY THIS DOES NOT START RILL. The authoring guide is explicit — "Do not launch a second
 * long-running server from the plugin" — and Kandev supervises the plugin binary's lifecycle,
 * so anything else it spawned would be fought over on every restart. The page probes for an
 * already-running Rill and hands over the command when nothing answers. A blank iframe that
 * silently fails is worse than an honest empty state.
 */

import { RILL_ORIGIN, VIEWS, START_COMMAND, START_COMMAND_HINT } from "./config.mjs";
import { copyTextToClipboard } from "./clipboard.mjs";
import { probeRill, probeWorkspace, viewSrc, activeWorkspaceName } from "./rill.mjs";

export function createOpsCostPage(host) {
  var React = host.React;
  var jsx = host.jsx;
  var ui = host.ui || {};
  var Button = ui.Button || "button";

  return function OpsCostPage() {
    var statusState = React.useState("checking"); // checking | up | down
    var status = statusState[0];
    var setStatus = statusState[1];

    var viewState = React.useState(VIEWS[0].id);
    var view = viewState[0];
    var setView = viewState[1];

    // Bumped on every retry so the iframe is forced to remount rather than showing a cached
    // error page from the attempt before.
    var nonceState = React.useState(0);
    var nonce = nonceState[0];
    var setNonce = nonceState[1];

    // The active workspace, and what the probe concluded about it:
    //   name  — from Kandev's store, null before it settles
    //   scope — "checking" | "present" | "absent" | "unknown"
    var wsState = React.useState({ name: null, scope: "checking" });
    var ws = wsState[0];
    var setWs = wsState[1];

    // A user who clears the filter means it. Null = follow the probe; true/false = pinned.
    var overrideState = React.useState(null);
    var override = overrideState[0];
    var setOverride = overrideState[1];

    var check = React.useCallback(function () {
      setStatus("checking");
      probeRill().then(function (alive) {
        setStatus(alive ? "up" : "down");
        if (alive) setNonce(function (n) { return n + 1; });
      });
    }, []);

    React.useEffect(function () {
      var cancelled = false;
      probeRill().then(function (alive) {
        if (!cancelled) setStatus(alive ? "up" : "down");
      });
      return function () {
        cancelled = true;
      };
    }, []);

    // Resolve the active workspace, then re-resolve whenever the user switches workspace in
    // Kandev — the tab is long-lived and a stale filter would silently show the wrong
    // workspace's money. Only a change of activeId re-probes; the store ticks constantly.
    React.useEffect(function () {
      if (status !== "up") return undefined;
      var cancelled = false;
      var lastName = null;

      function resolve() {
        var name = activeWorkspaceName(host.store);
        if (name === lastName) return;
        // A pin was a decision about the workspace open at the time; carrying it into a
        // different one would silently apply it to money it was never about.
        if (lastName !== null) setOverride(null);
        lastName = name;
        if (!name) {
          setWs({ name: null, scope: "unknown" });
          return;
        }
        setWs({ name: name, scope: "checking" });
        probeWorkspace(name).then(function (scope) {
          if (!cancelled) setWs({ name: name, scope: scope });
        });
      }

      resolve();
      var unsubscribe = host.store && host.store.subscribe ? host.store.subscribe(resolve) : null;
      return function () {
        cancelled = true;
        if (unsubscribe) unsubscribe();
      };
    }, [status]);

    // Off a secure origin `navigator.clipboard` is simply absent, and this used to do nothing
    // at all in that case — no copy, no message. The shared path falls back and, either way,
    // says what happened.
    function copyCommand() {
      copyTextToClipboard(host, START_COMMAND, "Start command");
    }

    var current = VIEWS.filter(function (v) { return v.id === view; })[0] || VIEWS[0];

    // THE EMPTY FALLBACK. "absent" means the workspace is real in Kandev but not in the Rill
    // snapshot, so filtering to it would render a blank dashboard that reads as a broken
    // plugin. Show everything and explain instead. "unknown" (Rill started without
    // --allowed-origins) still filters — the common case is that the workspace is there —
    // but the chip makes it one click to undo.
    var autoFilter = !!ws.name && ws.scope !== "absent";
    var filtering = override === null ? autoFilter : override && !!ws.name;
    var activeFilter = filtering ? ws.name : null;

    // ---- toolbar: view switcher + a link out to Rill's own UI
    var toolbar = jsx(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "8px 12px",
          borderBottom: "1px solid var(--border, rgba(128,128,128,0.25))",
          flexWrap: "wrap",
        },
      },
      VIEWS.map(function (v) {
        return jsx(
          Button,
          {
            key: v.id,
            variant: v.id === view ? "default" : "ghost",
            size: "sm",
            onClick: function () { setView(v.id); },
          },
          v.label
        );
      }).concat([
        jsx("div", { key: "spacer", style: { flex: 1 } }),
        ws.name
          ? jsx(
              Button,
              {
                key: "ws",
                variant: filtering ? "secondary" : "ghost",
                size: "sm",
                title: filtering
                  ? "Showing " + ws.name + " only — click to include every workspace"
                  : "Showing every workspace — click to filter to " + ws.name,
                onClick: function () { setOverride(!filtering); },
              },
              filtering ? "Workspace: " + ws.name + "  ✕" : "All workspaces"
            )
          : null,
        jsx(
          Button,
          {
            key: "open",
            variant: "ghost",
            size: "sm",
            onClick: function () {
              window.open(viewSrc(current.path, activeFilter), "_blank", "noopener");
            },
          },
          "Open in Rill ↗"
        ),
      ])
    );

    // Shown only when the fallback actually fired, and only until the user touches the chip —
    // a permanent banner for a once-per-extract condition would just become noise.
    var fallbackNote =
      ws.scope === "absent" && override === null
        ? jsx(
            "div",
            {
              key: "note",
              style: {
                padding: "8px 12px",
                fontSize: "12px",
                lineHeight: 1.5,
                opacity: 0.75,
                borderBottom: "1px solid var(--border, rgba(128,128,128,0.25))",
              },
            },
            "“" + ws.name + "” has no spend in the Rill snapshot, so this is showing every " +
              "workspace. The snapshot is point-in-time — re-run extract.sh and restart Rill " +
              "to pick up a workspace created since the last extract."
          )
        : null;

    if (status === "checking") {
      return jsx(
        "div",
        { style: { padding: "32px", opacity: 0.7 } },
        "Looking for Rill on " + RILL_ORIGIN + "…"
      );
    }

    if (status === "down") {
      return jsx(
        "div",
        { style: { padding: "32px", maxWidth: "760px" } },
        jsx("h2", { style: { fontSize: "18px", fontWeight: 600, marginBottom: "8px" } },
          "Rill isn't running"),
        jsx(
          "p",
          { style: { opacity: 0.75, lineHeight: 1.6, marginBottom: "16px" } },
          "This tab frames a Rill instance on " + RILL_ORIGIN +
            ", and nothing is listening there. The plugin deliberately does not start it — " +
            "Kandev supervises plugin processes, and a plugin that spawned its own server " +
            "would fight that supervision on every restart."
        ),
        jsx(
          "p",
          { style: { opacity: 0.6, fontSize: "12px", marginBottom: "6px" } },
          START_COMMAND_HINT
        ),
        jsx(
          "pre",
          {
            style: {
              padding: "12px",
              borderRadius: "6px",
              background: "var(--muted, rgba(128,128,128,0.12))",
              fontSize: "12px",
              overflowX: "auto",
              marginBottom: "12px",
            },
          },
          START_COMMAND
        ),
        jsx(
          "div",
          { style: { display: "flex", gap: "8px" } },
          jsx(Button, { size: "sm", onClick: copyCommand }, "Copy command"),
          jsx(Button, { size: "sm", variant: "outline", onClick: check }, "Retry")
        ),
        jsx(
          "p",
          { style: { opacity: 0.6, fontSize: "12px", marginTop: "16px", lineHeight: 1.6 } },
          "The extract step re-reads a snapshot of ~/.kandev/data/kandev.db. Rill does not " +
            "hot-reload it, so re-running the extract while Rill is up needs a restart to " +
            "take effect."
        )
      );
    }

    // Hold the frame back until the probe answers. It resolves against a local server in
    // milliseconds, and mounting unfiltered first would load the whole dashboard twice —
    // once for every workspace, then again for one.
    var body =
      ws.scope === "checking" && override === null
        ? jsx(
            "div",
            { key: "resolving", style: { padding: "32px", opacity: 0.7 } },
            "Resolving workspace…"
          )
        : jsx("iframe", {
            // The filter lives in the src, so it has to be part of the key: React would
            // otherwise reuse the frame and leave the old filter showing.
            key: current.id + ":" + (activeFilter || "*") + ":" + nonce,
            src: viewSrc(current.path, activeFilter),
            title: "Rill — " + current.label,
            style: { flex: 1, width: "100%", border: "none", minHeight: 0 },
          });

    return jsx(
      "div",
      { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
      toolbar,
      fallbackNote,
      body
    );
  };
}
