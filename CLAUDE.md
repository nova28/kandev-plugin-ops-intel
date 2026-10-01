# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A private Kandev plugin with two surfaces: an **Ops Intel** tab framing a locally running Rill
instance (`localhost:9009`), and a **Cost** panel in the task-detail workspace that lays one
card's spend along the workflow steps it passed through. Read `README.md` first — it carries the
reasoning behind every constraint below.

There is no linter and no CI. There *are* unit tests (`make test`, node's own runner, no
dependencies) covering the pure halves of the UI — the formatters and the ledger assembly.

## Commands

```bash
make reinstall
```

`install` → `package` → `build`, so one target covers **both** Go and UI changes (the bundle
ships inside the tarball; editing `ui/bundle.js` alone still needs a repackage). But use
`reinstall`, not `install`, when iterating: **Kandev rejects an install over an existing version
with HTTP 409** (`pkgtar: version already installed`), so `make install` only works on a version
that is not currently installed. `reinstall` is just `uninstall` then `install`.

Two things make a "successful" install look like it did nothing:

- The frontend cache-busts the bundle on `?v=<version>`, so an **already-open tab keeps running
  the previously evaluated module**. Reload the page after reinstalling, then confirm what the
  server actually has: `fetch("/api/plugins/<id>/bundle?v=<version>", {cache:"reload"})`.
- The old `install` recipe piped `curl -sf` into `head`, which threw away the exit status and
  printed nothing on a 409. It now checks the status and fails loudly — keep it that way.

Other targets: `make build` (host binary only), `make bundle` (regenerate `ui/bundle.js` from
`ui/src/`), `make test` (unit tests), `make package` (tarball into `.build/`), `make uninstall`,
`make clean`. `package` depends on `build bundle test`, so a failing test or an unbuildable
bundle stops an install rather than shipping a stale one.

The snapshot-refresh targets are separate from the *build*, but are no longer independent of
plugin code — `main.go`'s `OnEvent` feeds `rill/auto-refresh.sh` a signal now, see **The
signal-driven refresh** below. `make refresh-agent-install` / `refresh-agent-uninstall` /
`refresh-agent-status` manage the LaunchAgent, and `make refresh` (`FORCE=1` to ignore its
gates) runs one refresh now.

Overridable variables: `KANDEV` (default `../o/kandev`, a local Kandev checkout), `KANDEV_URL`
(default `http://localhost:8817`), `GO` (defaults to `GOTOOLCHAIN=go1.26.0 go`),
`REFRESH_WINDOW` (default `08:00-23:00`, the backstop's working hours), `REFRESH_POLL_SECONDS`
(default `60`, how often the LaunchAgent wakes to *check* — not how often it refreshes).

`make install` requires a running Kandev; `make package` requires the Kandev checkout, because
packing runs `cmd/plugin-pack` from `$(KANDEV)/apps/backend`.

## Architecture

- **`manifest.yaml`** — the contract with Kandev. Declares `runtime.type: binary` (mandatory, even
  for a UI-only plugin), a single executable keyed by `@@PLATFORM@@` (substituted by `make
  package` with the builder's own GOOS-GOARCH — see the Makefile), `capabilities.events:
  ["task.moved"]`, a `config_schema` for the refresh debounce, and the UI bundle path. `VERSION`
  in the Makefile is parsed out of this file.
- **`main.go`** — no longer a no-op, but still declares no `api_read`/`api_write` capability and
  never calls a Host *data* method. Embeds `pluginsdk.UnimplementedPlugin` (so `HandleWebhook`
  etc. stay no-ops) and overrides `OnEvent` for exactly one purpose: bridging `task.moved` to
  `rill/auto-refresh.sh`'s signal file, since that script has no Kandev API access of its own.
  See **The signal-driven refresh** under External dependencies for why that split exists —
  the Go process is deliberately never the thing that touches Rill.
- **`ui/bundle.js`** — the actual product, and **generated**. Edit `ui/src/*.mjs` and run
  `make bundle`; editing the bundle directly is silently undone by the next build.

### The UI source layout

`ui/build.mjs` concatenates `ui/src/*.mjs` into one IIFE. Kandev serves exactly one file from
`/api/plugins/<id>/bundle`, so a relative import would have nothing to resolve against at
runtime — but the sources are still real ES modules, because that is what lets the pure halves be
imported by `node --test` with no browser, no React and no Rill.

Concatenation order lives in `ORDER` in `build.mjs` and *is* dependency order. The build refuses
to emit on a duplicate top-level name (silent shadowing in one shared scope), an imported name
nothing exports, or an import form it cannot strip. Keep imports to a single line and to the
`import { a, b } from "./x.mjs"` form; `export default` and `export { ... }` are rejected.

| File | Job | Pure? |
|---|---|---|
| `config.mjs` | Every constant — origin, instance, the four model names, views, start command | yes |
| `format.mjs` | `sqlQuote`, `fmtUsd`, `fmtDuration`, `modelColor`, the unattributed sentinels | yes — tested |
| `rill.mjs` | Every network read. `rillQuery` resolves rows or **null**, never `[]`, on a failed read | no |
| `ledger.mjs` | `ledgerQueries()` builds SQL, `assembleLedger()` turns 5 result sets into a readout | both pure — tested |
| `panel.mjs` | `createTaskCostPanel(host)` — the task-detail Cost panel | no |
| `page.mjs` | `createOpsCostPage(host)` — the full-bleed Rill tab | no |
| `plugin.mjs` | The only file that touches `registry`. Must stay last in `ORDER` | no |

`panel.mjs` and `page.mjs` are **factories** taking `host`, not components: React arrives on
`host` at initialize time and nothing here may import it.

`server/` and `.build/` are gitignored build outputs. `rill/` is the Rill project the tab frames
(see External dependencies).

**`plugin-pack` has no ignore mechanism** — it walks every file under the directory it is given.
`make package` therefore stages `manifest.yaml`, `README.md`, `server/<host binary>` and
`ui/bundle.js` into `.build/pkg/` and packs *that*. Packing the repo root instead would ship
`rill/`'s 25 MB of extracted telemetry and nest the previous tarball inside the new one. Anything
a new install genuinely needs must be added to the staging step in the Makefile.

### Rules the code depends on

- **Never bundle React, and never import anything outside `ui/src/`.** Everything comes from the
  injected `host` (`host.React`, `host.jsx`, `host.ui.Button`, `host.toast`). A second React
  instance breaks the host's contexts and portals. Cross-module imports *within* `ui/src/` are
  fine and are stripped at build time.

### The task-detail Cost panel

`registerTaskPanel` adds a **Cost** row to the task workspace's "+" menu; the component receives
`{ panelId, taskId, sessionId, presentation }`. It lays one card's spend along the workflow steps
it passed through — the same rail the operator already reads at the top of the page.

- **It reads Rill, not Kandev.** Four models via the same query endpoint `probeWorkspace` uses,
  which is why the plugin still requests **no capabilities**. The cost is a point-in-time
  snapshot: a card created since the last extract has no rows and gets an explicit empty state,
  never a `$0.00`.
- **`rillQuery` resolves `null` on an unreadable answer, never `[]`.** Callers must treat null as
  "unknown". Collapsing the two would render a blocked cross-origin read as a free task.
- **The rail is ordered by `src_dim_workflow_step.step_position`, never by first-observed time.**
  Two interleaved sessions plus partial step stamping readily produce a first-seen order like
  Spec → Testing → Review → Build. That is a stamping artifact, not a card that bounced, and
  sorting by it would publish the artifact as a process finding. First-seen is the fallback only
  for a step the workflow no longer defines — such a step keeps its spend and sorts last.
- **The off-ledger count is not decoration.** Many cards hand work to external agents
  (codex/agy), which bill to a separate account. The total is a floor and the panel says so; amber
  is reserved for exactly that meaning and is never used for emphasis.
- **Spend before a card's first step stamp gets its own row**, never folded into whichever step
  came first — that would be a guess presented as a measurement.
- **The cost query groups by `step_attribution_basis` as well as step and model**, so one model
  legitimately arrives as several rows for one step. `assembleLedger` merges models **by name**
  into `modelMap` before emitting `models`. Pushing rows instead would render the same model
  twice in the legend and twice in every bar — there is a test for exactly this.
- **A step whose label is partly a majority verdict is marked** (dotted underline, per-step
  amount in the tooltip, card total in the footer). On real cards this can be a large share of spend, so
  it is not a footnote. The marker is deliberately quiet: a loud badge on most rows would drown
  the off-ledger amber, which is the more actionable warning.
- **The model legend is the filter.** Click isolates a model, click again restores all. Steps
  that never used the isolated model are **dimmed, not removed** — removing rows makes the rail
  jump and breaks the correspondence with the workflow rail above, and "which steps used this
  model" is precisely what the filter is asked. Bar scale and headline both follow the filter,
  and the headline keeps `of $<total>` so isolating never looks like the card got cheaper.
- **Bar segments follow the card's global model order, never the step's own.** The same model
  must occupy the same position in every bar or two steps cannot be compared by eye.
  - With per-step model assignment, **a step usually has one model**, so segments render as one
    block each. That is a property of the workflow, not missing data. The segmenting stays because a mid-step model change would otherwise be
    rendered as a single-model step, which is a lie rather than an omission.
- **`tok/s` in the legend is throughput, not decode speed.** Output tokens over
  `agent_seconds`, which is the whole turn including tool calls and shell waits — so it reads
  far below a model's generation rate, and that is the number worth comparing. It is also
  approximate by construction: `office_cost_events` has no turn_id, so tokens and time are
  matched only through the model label both sides carry. Below `MIN_RATE_SECONDS` (120s) the
  figure is **withheld, not zeroed** — a rate gets quoted, and a noisy one is worse than none.
- **Token tooltips report the step's total across every model**, because the cost query groups
  tokens by step, not by step and model. Under a model filter the tooltip says so rather than
  letting a filtered reader take them for the isolated model's own.
- Every optional query degrades on its own and the footer admits which one failed.
- **Never start Rill from the plugin.** Kandev supervises the plugin binary's lifecycle and would
  fight anything else it spawned. The page probes `RILL_ORIGIN` with a `no-cors` fetch and, when
  nothing answers, renders an honest empty state with a copyable start command.
- **Don't add capabilities without a real read path.** The plugin currently reads nothing from
  Kandev and writes nothing back.
- `RILL_ORIGIN` and `START_COMMAND` are constants near the top of `ui/bundle.js`; `VIEWS` maps the
  toolbar buttons to Rill canvas/explore paths.
- **The workspace filter.** The tab auto-filters Rill to Kandev's active workspace. The active
  workspace comes from `host.store.getState().workspaces` (`{items, activeId}`) — no capability
  needed, `host.store` is the live app store. It reaches Rill as `?f=workspace IN ('<name>')`,
  which Rill applies on load to canvas and explore alike.
  - The join is **by name, not id**: `extract.sql` resolves `workspace` from `workspaces.name` and
    never carries `workspace_id` into the models. Names are user text, so both the SQL and the
    filter expression go through `sqlQuote` — a workspace called `O'Brien's` breaks an unescaped
    build of either.
  - Because the snapshot is point-in-time, a workspace can exist in Kandev and not in Rill.
    `probeWorkspace` counts rows in `kandev_cost` and the page falls back to unfiltered with an
    explanation rather than rendering a blank dashboard.
  - That probe **reads a cross-origin response**, which only works because Rill is started with
    `--allowed-origins http://localhost:8817`. Without it the fetch throws, the probe answers
    `"unknown"`, and the filter applies optimistically — degraded, not broken. This is the one
    place the plugin does more than frame an opaque iframe.
- Rill's own chrome renders inside the iframe and cannot be removed — `/-/embed` is Rill *Cloud*
  only, and the cross-origin frame can't be styled. Local Rill returns 200 for any path (SPA
  shell), so probe by what renders, not by status code.

## External dependencies

- **A Kandev checkout at `../o/kandev`** — supplies the SDK via a `replace` directive in `go.mod`,
  the `plugin-pack` tool, and the docs. Repoint both `go.mod` and the Makefile's `KANDEV` if it
  moves. Requires Go 1.26.
- **[Rill Developer](https://docs.rilldata.com)** (`brew install rilldata/tap/rill`) — a
  third-party BI engine, not vendored here. The project it serves lives in `rill/` and is started
  separately (`cd rill && ./extract/extract.sh && rill start .`). `extract/extract.sh` snapshots
  `~/.kandev/data/kandev.db`; Rill does not hot-reload the snapshot, so re-extracting needs a Rill
  restart. `rill/data/`, `rill/tmp/` and `rill/state/` are gitignored build outputs.
  - **Signal-driven refresh.** `rill/auto-refresh.sh` is the unattended wrapper around
    `rill/refresh.sh`, run by a LaunchAgent (`make refresh-agent-install`, template in
    `rill/launchd/`) on a short poll. `main.go`'s `OnEvent` rewrites `$STATE_DIR/refresh-signal` on
    every `task.moved`; the script polls that file because it has no Kandev API access.
  - **Debounce, not per-event triggering.** Refresh waits for a quiet window since the last move or
    a max wait since the first pending one (`config_schema.quiet_minutes` / `max_wait_minutes`).
    `main.go` clamps both to a 1-minute floor because `config_schema` has no numeric minimum.
  - **`config_schema.event_driven` is a real off switch.** Off means a plain
    `fixed_interval_minutes` interval. `syncSignal` writes the settings on every delivery and on
    `SetHost`, because Kandev restarts the plugin on any config change.
  - **Backstop.** With no signal file, `auto-refresh.sh` falls back to a working-hours window, a
    minimum gap, a `mkdir` lock, and "Rill must already answer" — it never starts Rill. Every skip
    logs its reason. `./auto-refresh.sh --self-test` asserts the window and debounce arithmetic.
  - **`$STATE_DIR` (`~/Library/Caches/kandev-ops-intel`) is not `KANDEV_PLUGIN_DATA_DIR`**: the
    latter is only injected into the Go process. `$HOME` is what both sides can compute.
  - **launchd's PATH lacks `/opt/homebrew/bin`.** Both the plist and the script set PATH; keep both.
  - **The snapshot is `VACUUM INTO`, never `.backup`.** The online-backup API restarts whenever the
    source is written and does not converge under a running Kandev.
  - **`extract.sh` has an `EXPECTED` whitelist.** Adding a `.output` to `extract.sql` without adding
    the filename there silently drops the CSV by design.
  - **`extract.sql` is the redaction boundary**: only identifiers, timestamps, numbers and
    low-cardinality enums leave the database. Prose (titles, branches, prompts, authors, diffs)
    does not. Anything needing the full command line is classified in `extract.sql` and emitted as
    an enum.
- **`rill/check.sh` is the integrity harness** — run it after any extract or model change. Set
  `ENVIRONMENTS_DOC` to also check the epoch table against an external environments doc.

Plugin API docs live in the Kandev checkout: `docs/public/plugins-authoring.md` and
`docs/specs/plugins/spec.md`. Read them before adding any registration hook.

## Domain facts that must survive edits

- `task_sessions.tokens_in` excludes cached input and is wrong by orders of magnitude. Read
  `office_cost_events`.
- External-agent work bills to a separate account, so any per-task cost is a floor.
- `office_cost_events` carries `turn_id` only from a cutover date onward; earlier events have none
  and cannot be backfilled. Do not blend the halves silently.
- Cached input is two numbers (reads and writes, priced ~20x apart). A NULL split means "not
  recorded", never "no cache reads". Keep the summed column too, so a step's cost does not change
  at the cutover when only the recording did.
- `cost_source` (provenance of the dollars) and `token_basis` (provenance of the tokens) answer
  different questions; do not conflate them.
- Cost events are flushed at a step transition, so `kandev_cost` must not ASOF-join the step
  timeline; each event is attributed to the step owning the window it bills, and
  `step_attribution_basis` flags windows that crossed a boundary.
- The joined cost model is day-grained: distinct counts (cards, sessions) cannot be re-derived from
  it. Use `cards_touched` and `turn_timing`.
- Code output comes from git snapshots: read `metadata.branch_additions`, never `files` (never
  extract `files[].diff` — it is source code); every figure is a LAG delta; a moved `base_commit`
  invalidates the delta; first-snapshot deltas are baselines and are flagged.
- Read `clean_attribution_share` before quoting any per-step ratio; blending clean and
  majority-assigned windows manufactures artifacts.
- `wait_kind` is classified from the whole command line in the extract; `state check` is
  deliberately not a wait.
- Kandev's own success signal is not an outcome label and is never mirrored. The real outcome
  signal is `github_task_prs.state`; a merged PR is evidence of shipping, not correctness, and
  coverage is partial and must stay visible. A card is not a PR; `closed` is not `abandoned`; test
  `merged` before any `closed` branch.
- Session reliability counts failures, never successes. `executor` is a live join, `failure_class`
  is a LIKE ladder over prose Kandev may reword (asserted zero `other` among failures), and slices
  use `entry_step`, not `current_step`.
