# kandev-plugin-ops-intel

Operational cost and efficiency intelligence for Kandev — what a run costs, which model spent
it, which build step it went to, and what looks abnormal. Today that surface is an **Ops
Intel** tab framing a local Rill instance; the scope is the question, not the mechanism.

The analysis it frames lives in `rill/`, alongside the plugin. The findings and the reasoning
behind them are in the Forge repo at `docs/research/kandev/2026-08-12-kandev-operational-bi.md`.

> **On the name.** The first draft was `kandev-plugin-rill`. That named the implementation,
> and it would have had to change the moment the plugin grew anything native — a cost
> readout on a task card, the model in force, a budget warning. A plugin id is expensive to
> change once installs exist, so it now names the purpose. If Rill is ever replaced, the id
> survives.

## Step analysis in the task composer

The dashboards answer questions *across* runs. The task composer shows the same **step-attributed
cost** from day one: a compact Rill snapshot total sits beside the model and send controls. Click
it to open the detailed ledger in an anchored, scrollable popover—workflow-step rail, attribution
basis, agent/idle time, model and account economics, peer context, and external/unpriced work.
It does not need a task-panel "Add" action and does not provide a session-cost view.

Rill remains both the source of this task detail and the separate Ops Intel analytics surface. The
task ledger visibly reports its snapshot freshness; refresh the Rill extract when current data is
required.

## Still ahead

| Next | Surface | What it needs |
|---|---|---|
| Spend indicator on a kanban card | `registerComponent("task-card-indicators", …)` | A cheap precomputed aggregate — a per-card query on every card render is the obvious way to make the board slow. The panel's queries are per-card and are not that. |
| Budget warning as work runs | `registerWsHandler` on a cost event | Kandev's bus must emit one; check before designing around it. Also needs a live read path, per above. |

Two constraints that shape both, learned the hard way: **`task_sessions.tokens_in` excludes
cached input** and is wrong by ~5 orders of magnitude — always read `office_cost_events`; and
**codex/agy work bills to a separate account**, so any per-task figure is a floor, not a total.

## Why this exists next to Kandev's own dashboards

Kandev already ships **Settings → Workspace → Costs** (spend by model and provider, budgets)
and an agent dashboard (runs succeeded/failed/other, success-rate band). This plugin does not
reproduce either. It adds the five things neither can show:

| | Why Kandev cannot show it |
|---|---|
| Cost per unit of **output** | The costs page groups spend by model, which answers "which model did I use most", never "which model was expensive". The two orderings disagree in our data. |
| Cost per **build step** | Kandev stores no step on a cost event, and `session_step_history` is zero rows. Reconstructed here against a timeline built from step stamps on messages — by asking which step owned the window an event bills, not which stamp is nearest to it. Cost events flush *at* a step transition, so "nearest stamp" bills the step that just started and has done no work yet. |
| **Agent time vs idle time** | Nothing upstream measures waiting. It is ~78% of elapsed time. |
| **Anomaly detection** | Nothing upstream does this in any form. |
| The two blind spots | Spend on **deleted cards** ($820, invisible to every per-card total) and **external agents** (codex/agy bill to another account entirely). |

It deliberately shows **no success or completion rate**. This store has no outcome label, and
the success signal Kandev does compute counts budget-blocked, idle-skipped and
user-pressed-Stop runs as successes — mirroring it here would launder a number the underlying
research exists to distrust.

## Install

```bash
make reinstall
```

Requires a running Kandev on `localhost:8817`. It POSTs the tarball to `/api/plugins/install`,
which activates it immediately. Use `reinstall` rather than `install` when iterating: Kandev
answers 409 to an install over an already-installed version, and the frontend caches the UI
bundle per version, so an open tab needs a reload to pick up a new one.

Then start Rill separately — the tab frames it, and shows a copyable command when it is down:

```bash
cd rill && ./extract/extract.sh && rill start . --allowed-origins http://localhost:8817
```

`--allowed-origins` is what lets the tab check whether your active workspace exists in the
snapshot before filtering to it. Omit it and the tab still works — the filter is just applied
without that check, and the chip in the toolbar is the escape hatch.

### Keeping the snapshot fresh

Rill serves a point-in-time extract and does not hot-reload it, so every figure in the tab and in
the task panel is exactly as old as the last refresh. Install the hourly agent once and stop
thinking about it:

```bash
make refresh-agent-install
```

That loads a LaunchAgent running `rill/auto-refresh.sh` hourly — and at login, and on wake. Each
run refreshes only if it is **within working hours** (`08:00-23:00` by default; override with
`make refresh-agent-install REFRESH_WINDOW=07:00-23:30`), **Rill is already answering** on
`:9009`, and **the last refresh was over 50 minutes ago**. Everything else is a logged skip with
its reason, in `~/Library/Logs/kandev-ops-intel-refresh.log`.

The Rill gate is the one worth understanding: this never starts Rill. The plugin's own rule is
that it does not launch a second long-running server, and a timer doing it from the outside would
break that rule from another direction. It refreshes what you are already using and stays quiet
otherwise.

```bash
make refresh-agent-status      # loaded? last exit? last 15 log lines
make refresh                   # one refresh now, gates and all (FORCE=1 ignores them)
make refresh-agent-uninstall
```

A refresh restarts Rill, because that is the only way it re-reads the CSVs — so an open dashboard
blinks for about twenty seconds, once an hour. That is the cost of the numbers being current, and
it is why there is a window at all rather than a job running around the clock.

**What a refresh actually costs.** 35 seconds end to end on a ~700 MB store: a 6-second snapshot,
then the SQL, the Rill restart and `check.sh`'s five assertions. The agent runs at background
priority with low-priority I/O, and a run past 10 minutes is killed as stuck
(`OPS_INTEL_REFRESH_TIMEOUT_MIN`) rather than allowed to hold the lock into the next hour.

That number is the whole reason the hourly job is viable, and it is recent: `extract.sh`
snapshotted with `sqlite3 .backup` until the first unattended run exposed it. `.backup` restarts
its page copy whenever the source is written, so under a running Kandev it reached 437 MB of 692
MB in 29 minutes and was still slowing. `VACUUM INTO` does it in one pass, in six seconds. See the
header of `extract/extract.sh`.

`rill/data/` (the extractor's CSV output) and `rill/tmp/` (Rill's DuckDB scratch) are
gitignored — both are regenerated, and both hold real telemetry. The packaged plugin does not
contain `rill/` at all; `make package` stages only the manifest, the binary and the bundle.

## Design notes, and the constraints behind them

**The plugin does not start Rill.** The authoring guide is explicit — *"Do not launch a second
long-running server from the plugin"* — and Kandev supervises the plugin binary's lifecycle,
so anything else it spawned would be fought over on every restart. The page probes
`localhost:9009` instead and hands over the command when nothing answers. An honest empty
state beats an iframe that silently fails.

**The backend is a deliberate no-op.** Kandev requires `runtime.type: binary`, but the plugin
uses no Kandev API capabilities. Rill owns the task-ledger semantics and is started separately.

**An iframe, not native React panels.** Each Rill measure carries the reasoning for its
expression in a reviewable YAML file. Porting those charts to React would fork that logic into
a second place and guarantee the two drift. The iframe keeps exactly one definition of what a
dollar means.

**Rill's own header shows inside the frame, and cannot be removed.** `/-/embed` is a Rill
**Cloud** feature; on local Rill Developer it 404s (it returns 200 for any path because the
SPA shell answers everything — check what renders, not the status code). Rill runs on a
different origin, so its chrome cannot be hidden with injected CSS either. The upside is that
its time-range and filter controls stay usable.

**`RILL_ORIGIN` is a constant in `ui/src/config.mjs`.** A private plugin does not justify a
config round trip through the backend for one string. Edit it there if your port differs, then
`make bundle`.

**`ui/bundle.js` is generated.** The sources live in `ui/src/` as ES modules and are
concatenated into one IIFE by `ui/build.mjs`, because Kandev serves exactly one file and a
relative import would have nothing to resolve against. Keeping them as modules is what lets the
pure halves — the formatters, and the ledger assembly that decides step order, the unattributed
bucket and the off-ledger roll-up — be unit-tested with `make test` against node's own runner,
with no browser, no React, no Rill and no dependencies. `make package` runs the build and the
tests, so a failing test stops an install rather than shipping past it.

## Build requirements

Go **1.26** (Kandev's module requires it; `GOTOOLCHAIN=go1.26.0` will fetch it if your system
Go is older). `make build` targets whatever platform you run it on (`go env GOOS`/`GOARCH`) and
`make package` bakes that into the staged `manifest.yaml` — no cross-compile matrix, each
developer's own build runs on their own machine.

The SDK is resolved from a local checkout via a `replace` directive in `go.mod`, because the
Kandev module is not published to a proxy. Repoint it if your checkout moves.
