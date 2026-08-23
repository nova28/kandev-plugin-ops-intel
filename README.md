# kandev-plugin-ops-intel

Operational cost and efficiency intelligence for Kandev — what a run costs, which model spent
it, which build step it went to, and what looks abnormal. Two surfaces: an **Ops Intel** tab
and a per-task **Cost panel**, both backed by a local [Rill](https://docs.rilldata.com) instance.

## How it works

```
~/.kandev/data/kandev.db  --extract.sh-->  rill/data/*.csv  --rill start-->  localhost:9009
   (Kandev's SQLite)         VACUUM INTO         (redacted,                  (Rill: models,
                              snapshot +           column-                    metrics views,
                              extract.sql)          whitelisted)               dashboards)
                                                                                     |
                                                            iframe (Ops Intel tab) --+-- query API (Cost panel)
```

1. **Kandev** writes every event to a local SQLite database. Neither this plugin nor Rill ever
   opens it directly.
2. **`rill/extract/extract.sh`** takes a point-in-time snapshot with SQLite's `VACUUM INTO` (a
   `.backup` never converges under a running Kandev — see the script's header) and runs
   `extract.sql` against it, writing a fixed, whitelisted set of CSVs to `rill/data/`.
   `extract.sql` is the redaction boundary: only identifiers, timestamps, numbers, and
   low-cardinality enums leave the database — no message text, no names, no diffs.
3. **[Rill Developer](https://docs.rilldata.com)** (`rill start .` in `rill/`) ingests those
   CSVs into an embedded DuckDB and reconciles the model/metrics-view/dashboard definitions
   also in `rill/`, serving the result on `localhost:9009`. This plugin doesn't define any of
   that logic itself — every chart's definition lives in reviewable YAML there.
4. **The plugin reads Rill only, never Kandev's data API.** The **Ops Intel** tab iframes
   Rill's own dashboards; the **Cost panel** queries Rill's query API directly to lay one card's
   spend along its workflow steps. Its one Kandev capability is a `task.moved` event
   subscription — not a data read — used only to trigger step 2 sooner than a blind timer would;
   see [Keeping the snapshot fresh](#keeping-the-snapshot-fresh).

Because step 2 is a snapshot, every number is exactly as old as the last extract — see
[Keeping the snapshot fresh](#keeping-the-snapshot-fresh) for how that stays automatic.

## Dependencies

| | |
|---|---|
| A running **Kandev** instance | `localhost:8817` by default |
| **[Rill Developer](https://docs.rilldata.com)** | `brew install rilldata/tap/rill`. Started separately — the plugin never launches it (see [Design notes](#design-notes)). |
| **Go 1.26** | to build the plugin binary; `GOTOOLCHAIN=go1.26.0` fetches it if your system Go is older |
| **Node** | to build/test the UI bundle |
| A local **Kandev source checkout** | for the plugin SDK (`go.mod`'s `replace` directive) and `plugin-pack`; see `KANDEV` in the Makefile |

## Install

```bash
make reinstall
```

POSTs the built tarball to `/api/plugins/install` on your running Kandev. Use `reinstall` over
`install` when iterating — Kandev 409s an install over an already-installed version, and the
frontend caches the UI bundle per version, so an open tab needs a reload either way.

Then start Rill separately — the tab frames it and shows a copyable command when it's down:

```bash
cd rill && ./extract/extract.sh && rill start . --allowed-origins http://localhost:8817
```

`--allowed-origins` lets the tab check whether your active workspace exists in the snapshot
before filtering to it; omit it and the tab still works, just without that check.

### Keeping the snapshot fresh

Rill doesn't hot-reload the snapshot, so every figure is only as current as the last extract.
Install the agent once and stop thinking about it:

```bash
make refresh-agent-install
```

A LaunchAgent runs `rill/auto-refresh.sh` on a short poll (60s by default), at login, and on
wake — but most wake-ups do nothing. The plugin subscribes to Kandev's `task.moved` bus event
(a card's step moving, manually or by the workflow engine) and, on every delivery, drops a
signal the script reads: it waits for a **quiet window** since the last move, or a **max wait**
since the first pending one, whichever comes first, so a burst of moves collapses into one
refresh instead of one per event. All of this is operator-configurable in **Settings > Plugins
> Ops Intel**, no rebuild or reinstall needed:

| Setting | Default | |
|---|---|---|
| React to task moves | on | Turn off for a plain fixed schedule instead — see below. |
| Quiet window | 2 min | |
| Max wait | 5 min | |
| Fixed interval | 60 min | Used when "React to task moves" is off, or as a backstop before the first task move ever arrives even while it's on. |

Turning "React to task moves" off is how to keep this at a fixed cadence — e.g. once an hour,
same as before this mechanism existed — regardless of how often cards actually move; the fixed
interval is still operator-configurable, it just stops reacting to real activity. See `main.go`'s
`OnEvent`/`SetHost` and `rill/auto-refresh.sh`'s SIGNAL-DRIVEN FAST PATH for the mechanics.

If nothing has ever synced at all (an older Kandev, the event capability declined at install, or
the plugin hasn't started yet), it falls back to a periodic **backstop**: refresh if **within
working hours** (`08:00-23:00` by default, override with `REFRESH_WINDOW=...`), **Rill is
already answering** on `:9009` (this never starts Rill), and **the last refresh was over 50
minutes ago**. Every skip is logged, with its reason, to
`~/Library/Logs/kandev-ops-intel-refresh.log`.

A single refresh always costs the same regardless of what triggered it — extraction here isn't
incremental (see `extract.sql`'s header), so this design buys lower latency and no wasted work
while idle, not a cheaper individual refresh.

```bash
make refresh-agent-status      # loaded? last exit? last 15 log lines
make refresh                   # one refresh now, gates and all (FORCE=1 ignores them)
make refresh-agent-uninstall
```

A refresh restarts Rill — the only way it re-reads the CSVs — so an open dashboard blinks for
about 20 seconds each time. End to end it's ~35 seconds on a ~700 MB store, which is why a
signal-driven cadence — potentially several refreshes an hour on a busy workflow, not one — is
viable at all; see `extract.sh`'s header for the `VACUUM INTO` vs `.backup` story.

`rill/data/` and `rill/tmp/` are gitignored, regenerated outputs that hold real telemetry — the
packaged plugin never contains `rill/` at all; `make package` stages only the manifest, the
binary, and the UI bundle.

## Why this exists next to Kandev's own dashboards

Kandev already ships **Settings → Workspace → Costs** and an agent success-rate dashboard. This
plugin doesn't reproduce either — it adds what neither can show:

- **Cost per unit of output**, not per model used — the two orderings disagree in this data.
- **Cost per build step** — Kandev stores no step on a cost event; this is reconstructed against
  each session's step-stamp timeline (see `rill/models/kandev_cost.yaml` for the attribution
  logic and its known error rate).
- **Agent time vs. idle time** — nothing upstream measures waiting, which runs ~78% of elapsed time.
- **Anomaly detection** — nothing upstream does this in any form.
- **The two blind spots**: spend on **deleted cards** (invisible to every per-card total) and
  **external agents** (codex/agy bill to a separate account entirely).

It deliberately shows **no success or completion rate** — Kandev's own success signal counts
budget-blocked and idle-skipped runs as successes, and mirroring that here would launder a number
the underlying research exists to distrust.

## Step analysis in the task composer

The dashboards answer questions *across* runs; the task composer shows the same
**step-attributed cost** for *one* run. A compact snapshot total sits beside the model and send
controls — click it for the full ledger in a popover: workflow-step rail, attribution basis,
agent/idle time, model and account economics, and off-ledger work. Rill is the source for both
surfaces, so the ledger visibly reports its snapshot freshness rather than implying a live figure.

## Design notes

- **The plugin never starts Rill.** Kandev supervises the plugin binary's lifecycle; anything
  else the plugin spawned would be fought over on every restart. The tab probes `localhost:9009`
  and hands over a copyable command when nothing answers.
- **The backend does exactly one thing beyond being a supervised process** (`main.go`): bridge
  Kandev's `task.moved` event to a signal file, so `rill/auto-refresh.sh` — which has no Kandev
  API access of its own — knows when to check sooner than its poll interval. It still declares
  no `api_read`/`api_write` capability and never calls a Host data method; Rill owns all of the
  actual semantics, and is still started separately, deliberately never by the Go process
  itself (see the previous bullet — that rule is *why* the signal is a file, not a direct call).
- **An iframe, not native React panels.** Every Rill measure carries its own reasoning in
  reviewable YAML in `rill/`; porting those charts into React would fork that logic into a second
  place and guarantee drift.
- **`ui/bundle.js` is generated** from `ui/src/*.mjs` by `ui/build.mjs` (`make bundle`) — Kandev
  serves exactly one file, so the sources are concatenated into one IIFE. They stay real ES
  modules so their pure halves (formatters, ledger assembly) are unit-tested with `make test` —
  no browser, no React, no Rill.

See `CLAUDE.md` for the full constraint list and the reasoning behind each one — command
reference, the UI source layout, and every domain fact the cost figures depend on.

## License

[MIT](LICENSE).
