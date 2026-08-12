# kandev-plugin-opscost

Operational cost and efficiency intelligence for Kandev — what a run costs, which model spent
it, which build step it went to, and what looks abnormal. Today that surface is an **Ops
Cost** tab framing a local Rill instance; the scope is the question, not the mechanism.

The analysis it frames lives in `rill/`, alongside the plugin. The findings and the reasoning
behind them are in the Forge repo at `docs/research/kandev/2026-08-12-kandev-operational-bi.md`.

> **On the name.** The first draft was `kandev-plugin-rill`. That named the implementation,
> and it would have had to change the moment the plugin grew anything native — a cost
> readout on a task card, the model in force, a budget warning. A plugin id is expensive to
> change once installs exist, so it now names the purpose. If Rill is ever replaced, the id
> survives.

## The Cost panel on a task

The dashboards answer questions *across* runs. The **Cost** panel answers them on the card you
have open, which is where a cost signal can still change a decision. Add it from the "+" menu in
the task workspace.

It lays the card's spend along the workflow steps it passed through — the same rail already
drawn at the top of the task page. That axis is the point. A bill tells you a number; money on
the rail tells you *where your process leaks*, and on real cards it does: one card here spends
more in Testing than in Build, and another carries 52 codex calls inside Review, which means
Review's printed figure is the most understated number on the card.

Three things it refuses to do, each for a reason the data forced:

- **It does not order the rail by when spend was observed.** Two interleaved sessions plus
  partial step stamping produce a first-seen order like Spec → Testing → Review → Build. That is
  an artifact of stamping, not a card that bounced. The rail follows the workflow's declared
  step order; first-seen is the fallback only for a step the workflow no longer defines.
- **It does not print a confident total.** Over half the cards in this store hand work to
  codex/agy, which bill to a separate account. The headline carries an explicit unpriced line,
  and amber means that and only that anywhere in the panel.
- **It does not show a per-turn figure.** Cost events carry no turn id. Any per-turn dollar
  amount would be invented, so none is drawn.

**Where the numbers come from: Rill, not Kandev's database.** The chain is
`~/.kandev/data/kandev.db` → `extract.sh` → CSVs → Rill/DuckDB → its query API → the panel, over
the same endpoint the workspace probe already used. That is why the plugin still requests **no
capabilities** — and why the snapshot is point-in-time. A card created since the last extract has
no rows, and gets an explicit empty state rather than a `$0.00` that reads like a free task.

Reading live spend would mean `capabilities.api_read` plus a Kandev endpoint over
`office_cost_events` — and a second definition of a dollar, which is the thing the iframe exists
to avoid. Worth doing only for a figure Rill genuinely cannot serve.

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

`rill/data/` (the extractor's CSV output) and `rill/tmp/` (Rill's DuckDB scratch) are
gitignored — both are regenerated, and both hold real telemetry. The packaged plugin does not
contain `rill/` at all; `make package` stages only the manifest, the binary and the bundle.

## Design notes, and the constraints behind them

**The plugin does not start Rill.** The authoring guide is explicit — *"Do not launch a second
long-running server from the plugin"* — and Kandev supervises the plugin binary's lifecycle,
so anything else it spawned would be fought over on every restart. The page probes
`localhost:9009` instead and hands over the command when nothing answers. An honest empty
state beats an iframe that silently fails.

**The backend is a deliberate no-op.** This is a UI-only plugin, but Kandev's installer
requires `runtime.type: binary`, so `main.go` embeds `pluginsdk.UnimplementedPlugin` purely to
give Kandev a process to supervise. It requests **no capabilities** — it reads nothing from
Kandev and writes nothing back.

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
Go is older). Only `darwin-arm64` is built — a published plugin would cross-compile the full
matrix, but this one runs on one machine and five binaries would be 95 MB of pretence.

The SDK is resolved from a local checkout via a `replace` directive in `go.mod`, because the
Kandev module is not published to a proxy. Repoint it if your checkout moves.
