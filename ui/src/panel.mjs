/**
 * THE TASK LEDGER PANEL — money laid along the steps a card passed through.
 *
 * The workflow rail at the top of a task page is already the sequence the reader navigates.
 * Putting spend on that same axis turns a bill into a process diagnosis: a Fixup step
 * costing more than Build says work is escaping Testing, and knowing that is worth more than
 * knowing the total.
 *
 * Everything here reads Rill, for the same reason the main tab is an iframe — one definition
 * of what a dollar means, kept in reviewable YAML in rill/models/. The cost of that choice is
 * a point-in-time snapshot, and the panel says so rather than letting a running card look
 * free.
 *
 * Exported as a factory because React and the design-system components arrive on `host` at
 * initialize time; nothing here may import React (a second copy breaks the host's contexts
 * and portals).
 */

import { RILL_ORIGIN, START_COMMAND, START_COMMAND_HINT } from "./config.mjs";
import { copyTextToClipboard } from "./clipboard.mjs";
// Two lines from one module because the build takes only single-line named imports; it says
// so loudly rather than emitting a bundle with a stray `import` in it.
import { fmtUsd, fmtDuration, fmtCount, modelColor, OFF_LEDGER } from "./format.mjs";
import { fmtMTok, fmtTokenSplit, snapshotAge } from "./format.mjs";
import { loadTaskLedger, stepSegments, stepTotal, mergeBy } from "./ledger.mjs";
import { lastQueryError } from "./rill.mjs";

export function createTaskCostPanel(host) {
  var React = host.React;
  var jsx = host.jsx;
  var ui = host.ui || {};
  var Button = ui.Button || "button";

  var MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
  var BORDER = "var(--border, rgba(128,128,128,0.25))";
  var SUNK = "var(--muted, rgba(128,128,128,0.14))";

  function Label(props) {
    return jsx("div", {
      style: {
        fontFamily: MONO, fontSize: "9.5px", letterSpacing: "0.14em",
        textTransform: "uppercase", opacity: 0.55, fontWeight: 500,
      },
    }, props.children);
  }

  /** Where this card sits against its workspace's other cards, by spend. */
  function PeerScale(props) {
    var p = props.peers;
    if (!p || !p.n_tasks || Number(p.n_tasks) < 3) return null;
    var n = Number(p.n_tasks);
    var rank = Number(p.rank_pos || n);
    // Positioned by RANK, not by dollars. Spend is so skewed — the dearest handful of cards
    // hold well over half of it — that a linear dollar axis collapses every ordinary card
    // onto the left edge and says nothing about any of them.
    var pos = n > 1 ? (1 - (rank - 1) / (n - 1)) * 100 : 50;
    return jsx(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "5px" } },
      jsx("div", { style: { position: "relative", height: "20px" } },
        jsx("div", { style: {
          position: "absolute", top: "10px", left: 0, right: 0, height: "1px",
          background: BORDER,
        } }),
        jsx("div", { style: {
          position: "absolute", top: "4px", left: "50%", width: "1px", height: "13px",
          background: "currentColor", opacity: 0.3,
        } }),
        jsx("div", { style: {
          position: "absolute", top: 0, left: pos + "%", width: "2px", height: "20px",
          background: OFF_LEDGER, transform: "translateX(-50%)",
        } })
      ),
      jsx("div", { style: {
        display: "flex", justifyContent: "space-between", fontFamily: MONO,
        fontSize: "9.5px", opacity: 0.6, letterSpacing: "0.04em",
      } },
        jsx("span", null, "cheapest"),
        jsx("span", { style: { color: OFF_LEDGER, opacity: 1 } },
          rank + " of " + n + " in " + (p.workspace || "this workspace")),
        jsx("span", null, "median " + fmtUsd(p.median_subcents))
      )
    );
  }

  /**
   * The model legend, which doubles as the filter.
   *
   * Click isolates one model; clicking the isolated one restores all. Isolate rather than
   * toggle-off because the question this answers is "where did opus actually get used", and
   * on a two-model card the two gestures are identical anyway.
   */
  function ModelLegend(props) {
    var models = props.models || [];
    if (models.length < 2) return null;
    var total = models.reduce(function (n, m) { return n + m.subcents; }, 0);

    return jsx(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: "5px" } },
      models.map(function (m) {
        var on = !props.selected || props.selected === m.model;
        var colour = modelColor(m.model);
        var share = total > 0 ? Math.round((m.subcents / total) * 100) : 0;
        return jsx(
          "button",
          {
            key: m.model,
            type: "button",
            "aria-pressed": props.selected === m.model,
            title: [
              m.model + " — " + fmtUsd(m.subcents),
              "output " + fmtMTok(m.out) + " tokens over " + fmtDuration(m.agentS) +
                " of agent time",
              m.tokPerSec != null
                ? m.tokPerSec.toFixed(1) + " output tokens per agent-second — whole-turn " +
                  "throughput including tool calls, not decode speed"
                : "too little recorded agent time for a throughput figure",
              props.selected === m.model
                ? "Click to show every model"
                : "Click to show only this model",
            ].join("\n"),
            onClick: function () {
              props.onSelect(props.selected === m.model ? null : m.model);
            },
            style: {
              display: "flex", alignItems: "center", gap: "5px",
              fontFamily: MONO, fontSize: "10px", letterSpacing: "0.02em",
              padding: "3px 7px", borderRadius: "3px", cursor: "pointer",
              // The selected chip keeps its model's colour on the border; the rest recede.
              // Opacity alone carries the state so the swatch hue is never misread as a
              // different model.
              border: "1px solid " + (props.selected === m.model ? colour : BORDER),
              background: "transparent",
              color: "inherit",
              opacity: on ? 1 : 0.4,
            },
          },
          jsx("span", { style: {
            width: "7px", height: "7px", borderRadius: "50%", background: colour, flex: "none",
          } }),
          jsx("span", null, m.model),
          jsx("span", { style: { opacity: 0.6, fontVariantNumeric: "tabular-nums" } },
            fmtUsd(m.subcents) + " · " + share + "%" +
              // Throughput is omitted, never zeroed, when the sample is too thin — a rate is
              // the kind of number that gets quoted, and a noisy one is worse than none.
              (m.tokPerSec != null ? " · " + m.tokPerSec.toFixed(0) + " tok/s" : ""))
        );
      })
    );
  }

  /**
   * The account legend — which agent profile the money billed to.
   *
   * Separate from the model legend on purpose. Two profiles can run the same model and bill
   * different accounts, so on a machine running several this is the dimension that answers
   * "whose bill is this card", and the model cannot. No colour swatch: hue means model
   * everywhere in this panel, and giving accounts their own palette would put two competing
   * colour languages in one 450px column.
   */
  function AccountLegend(props) {
    var profiles = (props.profiles || []).filter(function (p) { return p.subcents > 0; });
    if (!profiles.length) return null;
    var total = profiles.reduce(function (n, p) { return n + p.subcents; }, 0);

    // ONE ACCOUNT IS STILL THE ANSWER. Gating this at "two or more", the way the model legend
    // is gated, would hide the account on every card in this store — no card here bills to
    // more than one — and "which account is this" is the whole question. With a single
    // account there is nothing to filter, so it renders as a plain label, not a dead button.
    if (profiles.length === 1) {
      var only = profiles[0].profile;
      return jsx("div", { style: {
        fontFamily: MONO, fontSize: "10px", opacity: 0.6, letterSpacing: "0.02em",
      } }, only === "(none)"
        ? "acct not recorded on these events, or on their sessions"
        : "acct " + only);
    }

    return jsx(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: "5px", alignItems: "center" } },
      jsx("span", { style: {
        fontFamily: MONO, fontSize: "9.5px", letterSpacing: "0.12em",
        textTransform: "uppercase", opacity: 0.45,
      } }, "acct"),
      profiles.map(function (p) {
        var on = !props.selected || props.selected === p.profile;
        var share = total > 0 ? Math.round((p.subcents / total) * 100) : 0;
        return jsx(
          "button",
          {
            key: p.profile,
            type: "button",
            "aria-pressed": props.selected === p.profile,
            title: p.profile + " — " + fmtUsd(p.subcents) + " of " + fmtUsd(total) +
              "\n" + (props.selected === p.profile
                ? "Click to show every account"
                : "Click to show only this account"),
            onClick: function () {
              props.onSelect(props.selected === p.profile ? null : p.profile);
            },
            style: {
              display: "flex", alignItems: "center", gap: "5px",
              fontFamily: MONO, fontSize: "10px", letterSpacing: "0.02em",
              padding: "3px 7px", borderRadius: "3px", cursor: "pointer",
              border: "1px solid " + (props.selected === p.profile
                ? "var(--foreground, rgba(200,200,200,0.55))" : BORDER),
              background: "transparent", color: "inherit",
              opacity: on ? 1 : 0.4,
            },
          },
          jsx("span", null, p.profile),
          jsx("span", { style: { opacity: 0.6, fontVariantNumeric: "tabular-nums" } },
            fmtUsd(p.subcents) + " · " + share + "%")
        );
      })
    );
  }

  /**
   * "codex (gpt-5.2-codex × 4, (unspecified) × 12)" per agent, one array entry each — the
   * shared shape behind both the per-step tooltip and the card-level floor chip, so the two
   * never drift apart. `models` is best-effort (see extract.sql); an agent with no breakdown
   * at all falls back to the plain count rather than an empty parenthesis.
   */
  function agentModelBreakdown(agents, models) {
    return Object.keys(agents).map(function (a) {
      var byModel = models && models[a] ? models[a] : null;
      var modelKeys = byModel ? Object.keys(byModel) : [];
      if (!modelKeys.length) return a + " × " + agents[a];
      var parts = modelKeys
        .sort(function (x, y) { return byModel[y] - byModel[x]; })
        .map(function (m) { return m + " × " + byModel[m]; })
        .join(", ");
      return a + " (" + parts + ")";
    });
  }

  /**
   * Tooltip for the off-ledger badge: which agent, which model, how many calls — and an
   * explicit statement that there is no price, rather than a number quietly implying $0.
   */
  function offLedgerTitle(s) {
    var byAgent = agentModelBreakdown(s.externalAgents, s.externalAgentModels).join(", ");
    return byAgent + " — billed to a separate account, no price recorded here";
  }

  /** One step of the rail: what it cost, which models paid for it, how long it held the card. */
  function StepRow(props) {
    var s = props.step;
    var segments = stepSegments(s, props.order, props.selected, props.selectedProfile);
    var mine = stepTotal(s, props.selected, props.selectedProfile);
    var costPct = props.maxCost > 0 ? (mine / props.maxCost) * 100 : 0;
    var timePct = props.maxTime > 0 ? ((s.agentS + s.idleS) / props.maxTime) * 100 : 0;
    var wall = s.agentS + s.idleS;
    // A step the filtered-out model never touched is dimmed, not removed. Removing rows would
    // make the rail jump and break the correspondence with the workflow rail above; dimming
    // answers "which steps used this model" directly, which is the point of filtering.
    var muted = (props.selected || props.selectedProfile) && mine === 0;
    // Which accounts touched this step. Shown only when the card used more than one, because
    // on a single-account card the answer is on every row and says nothing.
    var stepProfiles = props.showProfiles
      ? mergeBy(s.entries, "profile").filter(function (p) { return p.subcents > 0; })
          .sort(function (a, b) { return b.subcents - a.subcents; })
      : [];

    return jsx(
      "div",
      {
        style: {
          display: "grid", gridTemplateColumns: "14px 1fr", gap: "9px",
          padding: "9px 0",
          borderTop: props.first ? "none" : "1px solid " + BORDER,
          opacity: muted ? 0.32 : 1,
        },
      },
      jsx("div", { style: { display: "flex", justifyContent: "center", paddingTop: "5px" } },
        jsx("div", { style: {
          width: "7px", height: "7px", borderRadius: "50%",
          background: modelColor((segments[0] || s.models[0] || {}).model),
        } })
      ),
      jsx("div", { style: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 } },
        jsx("div", { style: { display: "flex", alignItems: "baseline", gap: "7px" } },
          // A dotted underline marks a step whose label is partly a majority verdict over a
          // window that spanned several steps. Quiet on purpose — the tooltip carries the
          // detail and the footer carries the total; a loud badge on most rows would drown
          // the off-ledger amber, which is the more actionable warning.
          jsx("span", {
            title: s.verdict > 0
              ? fmtUsd(s.verdict) + " of this step's spend billed a window that covered more " +
                "than one step, and is labelled with the step that held most of it"
              : undefined,
            style: {
              fontFamily: MONO, fontSize: "12px", overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap",
              borderBottom: s.verdict > 0 ? "1px dotted currentColor" : "none",
              opacity: s.verdict > 0 ? 0.92 : 1,
            },
          }, s.step),
          s.external
            ? jsx("span", {
                title: offLedgerTitle(s),
                style: {
                  fontFamily: MONO, fontSize: "9px", letterSpacing: "0.05em",
                  color: OFF_LEDGER, border: "1px solid " + OFF_LEDGER + "59",
                  borderRadius: "2px", padding: "1px 4px", whiteSpace: "nowrap", flex: "none",
                },
              }, "+" + s.external + " off-ledger")
            : null,
          jsx("span", {
            style: {
              marginLeft: "auto", fontFamily: MONO, fontSize: "12.5px",
              fontWeight: 600, fontVariantNumeric: "tabular-nums", flex: "none",
            },
          }, fmtUsd(mine))
        ),
        // SEGMENTED BY MODEL. The bar's full width is this step against the dearest step, and
        // its internal divisions are which model paid — so one glance answers both "how big"
        // and "on what". Segments follow the card's global model order, never the step's, or
        // the same colour would sit in a different place in each bar.
        jsx("div", { style: {
          height: "5px", background: SUNK, borderRadius: "1px", overflow: "hidden",
          display: "flex", width: "100%",
        } },
          jsx("div", { style: { display: "flex", width: costPct + "%", height: "100%" } },
            segments.map(function (seg) {
              return jsx("div", {
                key: seg.model,
                title: seg.model + " · " + fmtUsd(seg.subcents),
                style: {
                  height: "100%",
                  // Proportion WITHIN the bar, so the segments fill exactly the step's width.
                  width: mine > 0 ? (seg.subcents / mine) * 100 + "%" : "0%",
                  background: modelColor(seg.model),
                },
              });
            })
          )
        ),
        jsx("div", { style: {
          display: "flex", alignItems: "center", gap: "7px", fontFamily: MONO,
          fontSize: "10px", opacity: 0.6,
        } },
          jsx("div", { style: { flex: 1, maxWidth: "110px", height: "2px", background: SUNK } },
            jsx("div", { style: {
              height: "100%", width: timePct + "%", background: "currentColor", opacity: 0.45,
            } })
          ),
          jsx("span", { style: { fontVariantNumeric: "tabular-nums" } },
            wall > 0 ? fmtDuration(wall) : "—"),
          jsx("span", { style: { marginLeft: "auto", whiteSpace: "nowrap" } },
            (segments.length > 1
              ? segments.map(function (g) { return g.model; }).join(" + ")
              : (segments[0] ? segments[0].model : "—")) + " · " + s.events + " ev")
        ),
        // The account(s) this step billed to. Only rendered on a multi-account card.
        stepProfiles.length
          ? jsx("div", { style: {
              fontFamily: MONO, fontSize: "9.5px", opacity: 0.5,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            } }, "acct " + stepProfiles.map(function (p) {
              return stepProfiles.length > 1
                ? p.profile + " " + fmtUsd(p.subcents)
                : p.profile;
            }).join(" · "))
          : null,
        // The three token classes, ALWAYS VISIBLE rather than hidden behind a hover.
        //
        // This started as a `title` tooltip and that was the wrong call: a native tooltip
        // needs a second of hovering, renders in OS chrome, and advertises itself with
        // nothing but a cursor change. A number worth asking for is a number worth showing.
        // It is set quiet — 9.5px at low opacity — so it stays subordinate to the money.
        jsx("div", {
          title: "in " + fmtCount(s.fresh) + " · cache " + fmtCount(s.cached) +
            " · out " + fmtCount(s.out) +
            (props.selected ? "\n(the step's total, across every model)" : ""),
          style: {
            fontFamily: MONO, fontSize: "9.5px", opacity: 0.45,
            fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis",
          },
        }, fmtTokenSplit(s.fresh, s.cached, s.out))
      )
    );
  }

  return function TaskCostPanel(props) {
    var taskId = props.taskId;
    var dataState = React.useState({ state: "loading" });
    var data = dataState[0];
    var setData = dataState[1];

    // null = every model. A model name isolates it. Reset on task change, because a filter
    // is a decision about the card that was open when it was made.
    var selectedState = React.useState(null);
    var selected = selectedState[0];
    var setSelected = selectedState[1];

    // The account filter is INDEPENDENT of the model filter — they answer different
    // questions ("which model cost this" vs "whose account paid") and combine.
    var profileState = React.useState(null);
    var selectedProfile = profileState[0];
    var setSelectedProfile = profileState[1];

    React.useEffect(function () {
      setSelected(null);
      setSelectedProfile(null);
    }, [taskId]);

    var load = React.useCallback(function () {
      if (!taskId) return;
      setData({ state: "loading" });
      loadTaskLedger(taskId).then(setData, function () {
        setData({ state: "blocked" });
      });
    }, [taskId]);

    React.useEffect(function () {
      if (!taskId) return undefined;
      var cancelled = false;
      setData({ state: "loading" });
      loadTaskLedger(taskId).then(
        function (d) { if (!cancelled) setData(d); },
        function () { if (!cancelled) setData({ state: "blocked" }); }
      );
      return function () { cancelled = true; };
    }, [taskId]);

    function shell(children) {
      return jsx("div", {
        style: {
          padding: "14px", display: "flex", flexDirection: "column", gap: "12px",
          fontSize: "13px", lineHeight: 1.5, height: "100%",
          overflowY: "auto", minHeight: 0,
        },
      }, children);
    }

    // The command plus a copy button, because selecting 120 characters of shell out of a
    // panel is the one gesture this surface should never require: the panel is anchored to a
    // toolbar button, and a drag-select inside it starts by moving the pointer away from that
    // anchor. Popover semantics keep the panel open while you do it either way (see
    // step-analysis.mjs), but one click still beats a careful drag.
    function commandBlock(key) {
      return jsx("div", { key: key, style: { display: "flex", flexDirection: "column", gap: "6px" } },
        jsx("span", { style: { opacity: 0.6, fontSize: "11px" } }, START_COMMAND_HINT),
        jsx("pre", { style: {
          padding: "10px", borderRadius: "5px", background: SUNK, fontSize: "11px",
          overflowX: "auto", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all",
          userSelect: "text",
        } }, START_COMMAND),
        jsx("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
          jsx(Button, {
            size: "sm",
            variant: "outline",
            onClick: function () { copyTextToClipboard(host, START_COMMAND, "Refresh command"); },
          }, "Copy command"),
          // Named, not hinted at. The refresh this command performs by hand is the same one
          // `make refresh-agent-install` runs hourly; a reader doing it manually every time
          // deserves to know that once.
          jsx("span", { style: { fontFamily: MONO, fontSize: "10px", opacity: 0.5 } },
            "or install the hourly refresh: make refresh-agent-install"))
      );
    }

    if (data.state === "loading") {
      return shell(jsx("div", { style: { opacity: 0.6, fontFamily: MONO, fontSize: "11.5px" } },
        "Reading the ledger…"));
    }

    // The read was refused, which on a local setup almost always means one thing.
    if (data.state === "blocked") {
      // Rill answered and REJECTED the query — a fault in this plugin, not in the reader's
      // setup. Saying "cannot read Rill" here sends them to check CORS and restart servers
      // for a renamed column. Show what Rill actually said.
      var rejected = lastQueryError();
      if (rejected) {
        return shell([
          jsx(Label, { key: "l" }, "Rill rejected the query"),
          jsx("p", { key: "p", style: { opacity: 0.75, margin: 0 } },
            "Rill is running and reachable — it refused the statement. This is a bug in the " +
            "plugin, usually a column that moved in rill/models/. Nothing to restart."),
          jsx("pre", { key: "e", style: {
            padding: "10px", borderRadius: "5px", background: SUNK, fontSize: "11px",
            overflowX: "auto", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
          } }, String(rejected).slice(0, 400)),
          jsx("div", { key: "b" },
            jsx(Button, { size: "sm", variant: "outline", onClick: load }, "Retry")),
        ]);
      }
      return shell([
        jsx(Label, { key: "l" }, "Cannot read Rill"),
        jsx("p", { key: "p", style: { opacity: 0.75, margin: 0 } },
          "This panel queries Rill on " + RILL_ORIGIN + " directly, so Rill has to be running " +
          "and started with an allowed origin for Kandev. Without it the browser blocks the " +
          "read — the dashboards in the Ops Intel tab still work, because an iframe needs no " +
          "such permission."),
        commandBlock("c"),
        jsx("div", { key: "b" },
          jsx(Button, { size: "sm", variant: "outline", onClick: load }, "Retry")),
      ]);
    }

    // Readable, but no spend. THREE DIFFERENT FACTS with three different fixes — telling a
    // reader to re-run the extract when the card simply has not billed yet is a wild goose
    // chase, and this panel used to do exactly that for every one of them.
    if (data.state === "empty") {
      var absent = data.inSnapshot === false;
      var ran = data.turns > 0;

      var age = snapshotAge(data.snapshotAt);
      var ageText = age == null ? null : fmtDuration(age) + " old";

      var heading = absent ? "Not in this snapshot yet" : "No metered spend yet";

      var body = absent
        // The extract predates the card. This is the only case re-running it fixes.
        //
        // The age belongs in this sentence rather than only in the "no run recorded" one below:
        // it is the difference between "the snapshot is 20 minutes old, the hourly refresh will
        // collect this card shortly" and "the snapshot is two days old, nothing is refreshing".
        ? "Rill reads a point-in-time copy of Kandev's database and does not hot-reload it, so a " +
          "card created since the last extract is not in it" +
          (ageText ? " — this snapshot is " + ageText + ". " : ". ") +
          "Re-run the extract and restart Rill to pick it up."
        : ran
          // Present, and it ran — but nothing billed. Cost events are written when a session
          // flushes, which happens at a step transition, so a card still working through its
          // first step has no cost row anywhere, live database included.
          ? "This card is in the snapshot and has " + data.turns + " recorded turn" +
            (data.turns === 1 ? "" : "s") + ", but no cost event anywhere — not in Rill, and " +
            "not in Kandev either. Kandev writes spend only when an agent response completes, " +
            "which on this store takes about an hour from session start on average. " +
            "Re-extracting cannot conjure a number that has not been written yet."
          // Present, but the snapshot records no run.
          //
          // THIS CANNOT DISTINGUISH "never ran" FROM "ran after the extract", and it used to
          // assert the first — on a card whose agent was running as it said so, because the
          // snapshot was two hours older than the turn. Report what the snapshot contains and
          // how old it is; let the reader draw the conclusion.
          // DO NOT REFLEXIVELY SEND THE READER TO RE-EXTRACT. That is the advice that turns
          // this panel into a chore: on this store a session takes ~55 minutes on average to
          // write its first cost event, and 25 of 82 sessions never wrote one at all. A
          // freshly started card is blank no matter how recently the extract ran, so the
          // honest framing is "there may be nothing to find yet", not "go fetch it again".
          : "No agent run is recorded for this card" +
            (ageText ? " in this snapshot, which is " + ageText : " in this snapshot") +
            ". A run that started since the extract would not appear — but note that cost is " +
            "only written when a session flushes, roughly an hour into it, so a card started " +
            "recently has nothing to find yet either way. Kandev writes spend only when an " +
            "agent response completes.";

      return shell([
        jsx(Label, { key: "l" }, heading),
        jsx("p", { key: "p", style: { opacity: 0.75, margin: 0 } }, body),
        // Work that billed elsewhere is the one thing that DOES belong on a card with no
        // spend of its own — it is the most understated card there is.
        data.external
          ? jsx("div", { key: "x", style: {
              display: "flex", alignItems: "center", gap: "7px", fontFamily: MONO,
              fontSize: "11px", color: OFF_LEDGER,
            } },
              jsx("span", { style: {
                width: "24px", height: "10px", flex: "none", borderRadius: "2px",
                border: "1px solid " + OFF_LEDGER + "80",
                backgroundImage: "repeating-linear-gradient(45deg," + OFF_LEDGER +
                  "6b 0 2px, transparent 2px 5px)",
              } }),
              jsx("span", null, data.external + " call" + (data.external === 1 ? "" : "s") +
                " to codex/agy — billed to a separate account, never to this card"))
          : null,
        // Shown when re-running the extract could actually change the answer: the card is
        // missing entirely, or the snapshot records no run and may simply be older than one.
        // Withheld for a card that ran and did not flush, where it changes nothing.
        absent || !ran ? commandBlock("c") : null,
        jsx("div", { key: "b" },
          jsx(Button, { size: "sm", variant: "outline", onClick: load }, "Check again")),
      ]);
    }

    // The card's global model order — the legend's order, and the segment order inside every
    // bar. Held in one place so the two can never disagree.
    var order = (data.models || []).map(function (m) { return m.model; });

    // Both the bar scale and the headline follow the filter. Keeping the unfiltered maximum
    // would render an isolated minority model as a row of slivers and say nothing about how
    // its own spend is distributed across the steps.
    var maxCost = data.rail.reduce(function (m, s) {
      return Math.max(m, stepTotal(s, selected, selectedProfile));
    }, 0);
    var maxTime = data.rail.reduce(function (m, s) {
      return Math.max(m, s.agentS + s.idleS);
    }, 0);
    // Summed from the steps rather than read off a legend, because two filters can apply at
    // once and no single legend row knows about the other one.
    var shownTotal = selected || selectedProfile
      ? data.rail.concat(data.unattributed ? [data.unattributed] : [])
          .reduce(function (n, s) { return n + stepTotal(s, selected, selectedProfile); }, 0)
      : data.total;

    var agentNames = agentModelBreakdown(data.externalAgents, data.externalAgentModels)
      .join(" · ");

    return shell([
      // ---- headline
      jsx("div", { key: "head", style: { display: "flex", flexDirection: "column", gap: "9px" } },
        jsx("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" } },
          jsx("span", { style: {
            fontFamily: MONO, fontSize: "26px", fontWeight: 600,
            letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums",
          } }, fmtUsd(shownTotal)),
          // Part and whole together while filtered, so isolating a model never looks like
          // the card suddenly got cheaper.
          selected
            ? jsx("span", { style: {
                fontFamily: MONO, fontSize: "11px", opacity: 0.55,
                fontVariantNumeric: "tabular-nums",
              } }, "of " + fmtUsd(data.total))
            : null,
          // NO "METERED" BADGE. It used to read `metered` by default, which asserts the
          // figure is a bill. Cost provenance is recorded nowhere in this store — whether a
          // number is a bill or a list-price reconstruction is unanswerable — so the badge
          // was stating something the data cannot support. What IS knowable is whether the
          // TOKEN COUNTS were reported or synthesized, and that only merits a badge when
          // some were synthesized.
          data.synthesized
            ? jsx("span", {
                title: data.synthesized + " event" + (data.synthesized === 1 ? "" : "s") +
                  " carry synthesized token counts rather than reported ones",
                style: {
                  fontFamily: MONO, fontSize: "9.5px", letterSpacing: "0.1em",
                  textTransform: "uppercase", opacity: 0.55, border: "1px solid " + BORDER,
                  borderRadius: "3px", padding: "2px 5px",
                },
              }, data.synthesized + " synthesized")
            : null
        ),
        jsx(ModelLegend, { models: data.models, selected: selected, onSelect: setSelected }),
        jsx(AccountLegend, {
          profiles: data.profiles, selected: selectedProfile, onSelect: setSelectedProfile,
        }),
        // THE FLOOR. Half the cards in this store hand work to codex or agy, which bill
        // elsewhere. A confident total would eventually drive a model or process decision on
        // a number missing a large slice of the real spend.
        data.external
          ? jsx("div", { style: {
              display: "flex", alignItems: "center", gap: "7px", fontFamily: MONO,
              fontSize: "11px", color: OFF_LEDGER,
            } },
              jsx("span", { style: {
                width: "24px", height: "10px", flex: "none", borderRadius: "2px",
                border: "1px solid " + OFF_LEDGER + "80",
                backgroundImage: "repeating-linear-gradient(45deg," + OFF_LEDGER +
                  "6b 0 2px, transparent 2px 5px)",
              } }),
              jsx("span", null, agentNames + " — not priced here"))
          : null,
        jsx(PeerScale, { peers: data.peers })
      ),

      jsx("div", { key: "sep", style: { height: "1px", background: BORDER } }),

      jsx(Label, { key: "rl" }, "Spend by step"),

      // ---- the rail
      jsx("div", { key: "rail", style: { display: "flex", flexDirection: "column" } },
        data.rail.map(function (s, i) {
          return jsx(StepRow, {
            key: s.step, step: s, first: i === 0, maxCost: maxCost, maxTime: maxTime,
            order: order, selected: selected, selectedProfile: selectedProfile,
            showProfiles: (data.profiles || []).length > 1,
          });
        })
      ),

      // Spend before the card's first step stamp. Shown, never folded into a step —
      // attributing it to whichever step happened to come first would be a guess presented
      // as a measurement.
      // UNATTRIBUTED SPEND, SIZED TO ITS SHARE.
      //
      // This was a dim 10px footnote at 0.6 opacity — fine when it is a rounding error, badly
      // wrong when it is most of the card. One real card put $74.87 of $80.75 here (93%)
      // while the rail showed a $5.88 step as though that were the story: Kandev stamped no
      // step for the first 44 minutes of the session, and the first stamp landed one second
      // AFTER the flush it would have explained.
      //
      // So it scales. Below a quarter of the card it stays a footnote; at or above, it gets a
      // step row's weight and a bar, because at that point it IS the finding — not a caveat
      // to one.
      (function () {
        if (!data.unattributed) return null;
        var amt = stepTotal(data.unattributed, selected, selectedProfile);
        var share = shownTotal > 0 ? amt / shownTotal : 0;
        var dim = (selected || selectedProfile) && amt === 0;
        var hatch = "repeating-linear-gradient(45deg, currentColor 0 1.5px," +
          " transparent 1.5px 4px)";

        if (share < 0.25) {
          return jsx("div", { key: "un", style: {
            display: "flex", alignItems: "center", gap: "7px", fontFamily: MONO,
            fontSize: "10px", opacity: dim ? 0.25 : 0.6, paddingTop: "8px",
            borderTop: "1px solid " + BORDER,
          } },
            jsx("span", { style: {
              width: "16px", height: "9px", flex: "none", borderRadius: "2px",
              border: "1px solid currentColor", backgroundImage: hatch, opacity: 0.5,
            } }),
            jsx("span", { style: { fontVariantNumeric: "tabular-nums" } }, fmtUsd(amt)),
            jsx("span", null, "before the first step stamp — not attributable"));
        }

        return jsx("div", { key: "un", style: {
          display: "grid", gridTemplateColumns: "14px 1fr", gap: "9px",
          padding: "9px 0", borderTop: "1px solid " + BORDER, opacity: dim ? 0.32 : 1,
        } },
          jsx("div", { style: { display: "flex", justifyContent: "center", paddingTop: "5px" } },
            jsx("div", { style: {
              width: "7px", height: "7px", borderRadius: "50%",
              border: "1px solid " + OFF_LEDGER, backgroundImage: hatch, color: OFF_LEDGER,
            } })),
          jsx("div", { style: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 } },
            jsx("div", { style: { display: "flex", alignItems: "baseline", gap: "7px" } },
              jsx("span", { style: { fontFamily: MONO, fontSize: "12px", color: OFF_LEDGER } },
                "no step recorded"),
              jsx("span", { style: {
                marginLeft: "auto", fontFamily: MONO, fontSize: "12.5px", fontWeight: 600,
                fontVariantNumeric: "tabular-nums", flex: "none", color: OFF_LEDGER,
              } }, fmtUsd(amt))),
            jsx("div", { style: {
              height: "5px", background: SUNK, borderRadius: "1px", overflow: "hidden",
            } },
              jsx("div", { style: {
                height: "100%", width: Math.min(100, share * 100) + "%", color: OFF_LEDGER,
                border: "1px solid " + OFF_LEDGER + "80", backgroundImage: hatch, opacity: 0.9,
              } })),
            jsx("div", { style: { fontFamily: MONO, fontSize: "9.5px", opacity: 0.6 } },
              Math.round(share * 100) + "% of this card billed before Kandev stamped any " +
              "step, so it belongs to no step here")));
      })(),

      jsx("div", { key: "sep2", style: { height: "1px", background: BORDER } }),

      // ---- compact provenance. The full explanations belong in tooltips and docs;
      // this surface should prioritise the rail rather than repeat a paragraph on
      // every task.
      jsx("div", { key: "foot", style: {
        fontFamily: MONO, fontSize: "9.5px", lineHeight: 1.45, opacity: 0.55,
      } },
        jsx("div", {
          title: "in " + fmtCount(data.fresh) + " · cache " + fmtCount(data.cached) +
            " · out " + fmtCount(data.out),
          style: { cursor: "help" },
        }, "Tokens: " + fmtTokenSplit(data.fresh, data.cached, data.out)),
        (function () {
          var a = snapshotAge(data.snapshotAt);
          return a == null ? null : jsx("div", null,
            "Snapshot " + fmtDuration(a) + " old");
        })(),
        data.stepBasis === "stamp"
          ? jsx("div", null, "Step source: turn stamps (exact)")
          : data.stepBasis === "inferred"
            ? jsx("div", null, "Step source: billing windows (approximate)")
            : data.stepBasis === "mixed"
              ? jsx("div", null, "Step source: turn stamps + billing windows")
              : null,
        data.verdict > 0
          ? jsx("div", null, fmtUsd(data.verdict) + " uses multi-step attribution")
          : null,
        // Most cost events carry no agent_profile_id; the account is then read off the
        // session, which runs under one profile for its whole life. Sound, but an inference.
        data.inferredProfile > 0
          ? jsx("div", null, "Account inferred for " + fmtUsd(data.inferredProfile))
          : null,
        data.degraded.timing ? jsx("div", { style: { color: OFF_LEDGER } },
          "Timing unavailable — hours omitted.") : null,
        data.degraded.external ? jsx("div", { style: { color: OFF_LEDGER } },
          "External-agent count unavailable — the total may be understated further.") : null,
        // Without the step definitions the rail falls back to first-observed order, which can
        // look like a workflow sequence while not being one. Say so.
        data.degraded.order ? jsx("div", { style: { color: OFF_LEDGER } },
          "Workflow order unavailable.") : null,
        data.undefinedSteps && data.undefinedSteps.length
          ? jsx("div", null, data.undefinedSteps.join(", ") +
              " — not in this workflow's current definition, listed last.")
          : null,
        jsx("div", { style: { paddingTop: "4px" } },
          jsx("a", {
            href: "#", onClick: function (e) { e.preventDefault(); load(); },
            style: { opacity: 0.8 },
          }, "Refresh snapshot"))
      ),
    ]);
  };
}
