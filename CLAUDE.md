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

Overridable variables: `KANDEV` (default `../o/kandev`, the local Kandev checkout), `KANDEV_URL`
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
- **The off-ledger count is not decoration.** Over half the cards in this store hand work to
  codex/agy, which bill to a separate account. The total is a floor and the panel says so; amber
  is reserved for exactly that meaning and is never used for emphasis.
- **Spend before a card's first step stamp gets its own row**, never folded into whichever step
  came first — that would be a guess presented as a measurement.
- **The cost query groups by `step_attribution_basis` as well as step and model**, so one model
  legitimately arrives as several rows for one step. `assembleLedger` merges models **by name**
  into `modelMap` before emitting `models`. Pushing rows instead would render the same model
  twice in the legend and twice in every bar — there is a test for exactly this.
- **A step whose label is partly a majority verdict is marked** (dotted underline, per-step
  amount in the tooltip, card total in the footer). On a real card this runs to 38% of spend, so
  it is not a footnote. The marker is deliberately quiet: a loud badge on most rows would drown
  the off-ledger amber, which is the more actionable warning.
- **The model legend is the filter.** Click isolates a model, click again restores all. Steps
  that never used the isolated model are **dimmed, not removed** — removing rows makes the rail
  jump and breaks the correspondence with the workflow rail above, and "which steps used this
  model" is precisely what the filter is asked. Bar scale and headline both follow the filter,
  and the headline keeps `of $<total>` so isolating never looks like the card got cheaper.
- **Bar segments follow the card's global model order, never the step's own.** The same model
  must occupy the same position in every bar or two steps cannot be compared by eye.
  - In this store **no step has ever had two models**, so segments render as one block each.
    That is a real property, not missing data: workflows assign a model per step (opus to
    Review, sonnet to Build/Verify), so the model switch *is* the step switch. Re-extracting
    cannot change it. The segmenting stays because a mid-step model change would otherwise be
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
    filter expression go through `sqlQuote` — a workspace called `Henry's` breaks an unescaped
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

- **Kandev checkout at `../o/kandev`** — supplies the SDK via a `replace` directive in `go.mod`,
  the `plugin-pack` tool, and the docs. Repoint both `go.mod` and the Makefile's `KANDEV` if it
  moves. Requires Go 1.26.
- **[Rill Developer](https://docs.rilldata.com)** (`brew install rilldata/tap/rill`) — a
  third-party BI engine, not something this repo vendors. The project it serves lives in `rill/`
  in this repo and is started separately (`cd rill && ./extract/extract.sh && rill start .`).
  Its `extract/extract.sh` snapshots `~/.kandev/data/kandev.db`; Rill does not hot-reload the
  snapshot, so re-extracting needs a Rill restart. `rill/data/` and `rill/tmp/` are gitignored
  build outputs.
  - **The signal-driven refresh.** `rill/auto-refresh.sh` is the unattended wrapper around
    `rill/refresh.sh`, run by the `com.kandev-plugin-ops-intel.refresh` LaunchAgent (installed by
    `make refresh-agent-install`, template in `rill/launchd/`) on a short poll (`REFRESH_POLL_SECONDS`,
    default 60s) — but most wake-ups do nothing. It exists because a snapshot is only as good as
    its age, and the manual loop is three commands people forget.
  - **`capabilities.events: ["task.moved"]` in manifest.yaml is what makes this signal-driven
    rather than purely periodic.** `main.go`'s `OnEvent` fires on every `task.moved` delivery
    (a card's step moving, manually or by the workflow engine) and rewrites
    `$STATE_DIR/refresh-signal` — the one thing auto-refresh.sh (a separate process with no
    Kandev API access) can poll instead of the bus itself. `task.moved` is a proxy for a real
    cost-write event: `office.cost.recorded` is declared in Kandev's event vocabulary but never
    actually published anywhere in Kandev's source (checked directly — the write path that
    inserts an `office_cost_events` row has no `Publish` call), and per this file's own domain
    facts, Kandev flushes cost events *at* a step transition, so `task.moved` is the closest
    thing that exists today.
  - **Debounce, not per-event triggering.** A burst of moves (every step advance on a busy
    workflow publishes one) would otherwise mean overlapping extracts and Rill restarting every
    few seconds. `signal_should_refresh` (pure arithmetic, exercised by `--self-test`) waits for
    a **quiet window** since the last move or a **max wait** since the first pending one,
    whichever comes first — both operator-configurable in Settings > Plugins > Ops Intel
    (`config_schema.quiet_minutes` / `max_wait_minutes`, default 2/5 **minutes**, not seconds: a
    single refresh already costs ~35s + a ~20s Rill restart, so sub-minute values are false
    precision). `main.go` clamps both to a 1-minute floor before writing them into the signal
    file — `config_schema` validates `required`/`type`/`enum`/`format`/`secret` but not a
    numeric minimum, so an unclamped 0 would defeat debouncing entirely.
  - **Extraction is not incremental — a refresh costs the same regardless of trigger.** See
    `extract.sql`'s header: several derivations (git-snapshot LAG deltas, the config-epoch cut)
    need each session's full history, not a delta, so this design buys lower latency and no
    wasted work while idle, never a cheaper individual run.
  - **`config_schema.event_driven` (default true) is a real off switch, not just a slower
    setting.** Off means `rill/auto-refresh.sh` ignores `first_seen`/`last_seen` entirely and
    refreshes on a plain `config_schema.fixed_interval_minutes` interval (default 60) instead —
    e.g. to cap this at once an hour regardless of how often cards move. Both are carried as the
    5th/6th fields of `$STATE_DIR/refresh-signal` (`event_driven_s`, `fixed_interval_s`), and
    `main.go`'s `syncSignal` writes them on **every** `task.moved` delivery AND on `SetHost`
    (host injection) — the latter exists because Kandev restarts the plugin on any config
    change, and `OnEvent` alone would leave the shell script reading a stale value until the
    next real task move, which could be a long wait right after flipping this off. The success
    path only clears `$SIGNAL` when it read `event_driven_s == 1`: in fixed-time mode the file
    holds persistent config, not a per-burst debounce state, and blindly deleting it there would
    silently fall back to the env-var backstop default instead of the operator's chosen
    interval until the next lucky event resynced it.
  - **The BACKSTOP.** If `$STATE_DIR/refresh-signal` doesn't exist at all — an older Kandev, the
    event capability declined at install, or the plugin hasn't synced yet — auto-refresh.sh
    falls back to the old periodic gates: a working-hours window; Rill must already answer on
    `:9009` (**this never starts Rill** — same rule as the plugin, applied from the outside); a
    50-minute minimum gap (`REFRESH_WINDOW`/`OPS_INTEL_REFRESH_MIN_GAP_MIN`); and a `mkdir`
    lock, because an extract can outlast the poll interval. Every skip logs its reason to
    `~/Library/Logs/kandev-ops-intel-refresh.log` — a silent refresher is indistinguishable from
    a working one. A failed run does **not** stamp or clear the signal, so the next poll retries.
    `./auto-refresh.sh --self-test` asserts both the window arithmetic (including the
    leading-zero trap that made `08:00` unparseable octal) and the debounce arithmetic.
  - **`$STATE_DIR` (`~/Library/Caches/kandev-ops-intel`) is deliberately not
    `KANDEV_PLUGIN_DATA_DIR`.** That directory is injected only into the Go plugin process's own
    environment; auto-refresh.sh has no way to discover its resolved path. `$HOME` is the one
    thing both sides can compute identically — see `main.go`'s `stateDir()`.
  - **launchd hands a job `PATH=/usr/bin:/bin:/usr/sbin:/sbin`.** Without `/opt/homebrew/bin`
    the extract half succeeds and only the `rill` restart fails, leaving a fresh snapshot the
    running Rill never reads. Both the plist and the script set PATH; keep both.
  - **The snapshot is `VACUUM INTO`, never `.backup`, and this is load-bearing.** SQLite's
    online-backup API restarts its page copy whenever the source is written, so under a running
    Kandev it does not converge: a measured run reached 437 MB of 692 MB in 29 minutes and was
    still slowing. `VACUUM INTO` writes a compacted copy from one read transaction — 669 MB in
    6 seconds, whole refresh 35 seconds. The signal-driven refresh — which can fire several
    times an hour on a busy workflow, not once — is only viable at that speed because of it.
  - **`extract.sh` has an `EXPECTED` whitelist** and promotes only the files named in it. Adding a
    `.output` to `extract.sql` without adding the filename there writes the CSV to the staging
    directory and silently drops it — the guard exists so a partial extract is never promoted, and
    it is doing its job when this happens.
  - **`extract.sql` is the redaction boundary**, and the rule is a column whitelist: an identifier,
    a timestamp, a number, or a low-cardinality enum. Anything else is prose and does not leave the
    database. This is why `fct_pull_request` selects no `pr_title` (prose), no `author_login` (a
    person), and no `head_branch` (routinely a slugged card title — the description arriving by
    another door).
  - **Anything needing the full command line must be classified IN `extract.sql`**, where the line
    still exists, and emitted as an enum only — `external_agent` and `wait_kind` both do this.
    Deriving it downstream from `tool_name` does not work: nearly every command in this store is
    compound (`cd <path> && …`), so the leading token is `cd`.
- **`rill/check.sh` is the integrity harness — run it after any extract or model change.** Five
  assertions plus the baseline metric set; exits non-zero on failure. It exists because the two
  most load-bearing numbers here are reconstructions (per-step cost attribution, code-output
  deltas) that were originally validated once, by hand, in a conversation — which is not a
  validation, because it cannot be re-run after the next extract.
  - `dim_workflow_step` is the one extract that records **intent** rather than observation: the
    workflow's declared step order, which is what lets the Cost panel lay out along the same rail
    the task page shows. `workflow_steps.prompt` is agent-directed prose and is never selected.

Authoritative plugin API docs: `../o/kandev/docs/public/plugins-authoring.md` (canonical entry
point) and `../o/kandev/docs/specs/plugins/spec.md` (registry surface, host APIs, capabilities).
Read these before adding any registration hook — `registerTaskPanel`, `registerComponent`,
`registerWsHandler` are the ones the README's roadmap targets.

## Domain facts that must survive edits

These come from the underlying research (`docs/research/kandev/2026-08-12-kandev-operational-bi.md`
in Forge) and constrain any future cost readout:

- `task_sessions.tokens_in` **excludes cached input** and is wrong by ~5 orders of magnitude. Always
  read `office_cost_events`.
- codex/agy work bills to a **separate account**, so any per-task cost figure is a floor, not a
  total.
- `office_cost_events` carries **no `turn_id`**. There is no per-turn dollar figure and there
  cannot be one — anything claiming one invented it. `rill/models/kandev_step_diagnostics.yaml`
  puts cost and turn timing on one row by aggregating both sides to the same *step-day* and
  joining those aggregates; `$ per turn` there is a step-level ratio, not a per-turn bill.
- Cost events are **flushed at a step transition** — 122 of the 313 New Feature Dev events carry
  a timestamp equal to a step stamp. So `kandev_cost` must **not** ASOF-join the step timeline:
  nearest-stamp-at-or-before bills the step that just *started*, and the money belongs to the one
  that just *ended*. It reported `Testing` at $797 and first in the step table against an actual
  $331 and third. Each event is attributed to the step owning the window it bills, and
  `step_attribution_basis` flags the 142 windows that crossed a boundary. `kandev_turns` keeps its
  ASOF join and should — a turn's work happens *after* its `started_at`.
- That joined model is **day-grained**, so distinct counts (cards, sessions) cannot be re-derived
  from it — a card worked on across three days would count three times. Read `cards_touched` on
  `cost_and_tokens` for a card count, and `turn_timing` for medians/p90, which a day-grained
  aggregate also cannot recover.
- **Code output comes from `task_session_git_snapshots`, and three things about it are traps.**
  `fct_git_snapshot` → `kandev_code_output` → the `code` CTE in `kandev_step_diagnostics`.
  - Read **`metadata.branch_additions`**, never the `files` blob. `files` is the *uncommitted*
    working-tree diff: it repeats across consecutive snapshots and collapses to zero the moment
    work is committed. `branch_additions` is cumulative against the base and climbs monotonically.
    `files[].diff` **is the source code** and must never be extracted.
  - Because it is cumulative, every downstream figure is a **LAG delta**. Summing the raw column
    would count one session's work once per snapshot (up to 175 times).
  - **A moved `base_commit` invalidates the delta.** Both `branch_additions` and `ahead` are
    counted against that commit, so when it changes the two readings are on different rulers. One
    session re-based and produced a single delta of +440,418 lines and +8,263 commits — 77% of all
    lines and 95% of all commits in the store. `is_base_change` discards those; without the guard
    the totals were 568k lines / 8,656 commits against a corrected 114.6k / 292.
  - **Half the remaining lines (49%) are session baselines** — first-snapshot deltas that may
    include commits made before the session opened. Counted, but flagged by
    `is_session_baseline`, and `baseline_line_share` sits beside the line count in the dashboard
    so the softness is quoted with the number.
  - Validation to repeat after any change: summed deltas must equal each session's final
    cumulative value. 63 of 71 sessions match exactly and all 8 that differ have rewinds; **zero
    differ without one**.
- **Read `clean_attribution_share` before quoting any per-step ratio.** `step_attributed = 'yes'`
  admits both events whose billing window sat inside one step and events whose window crossed a
  boundary and was assigned by message-count majority. Only 47% of spend store-wide is the former,
  and it varies wildly by step — Build 87%, **Review 19%**, PR Fixup 55%. Blending them silently is
  how PR Fixup came to read 725:1 input:output, "the worst churn on the board", when the figure
  restricted to clean windows is 524:1 against Build's 523. The ratio was an artifact.
- **`wait_kind` replaced a classifier that was wrong in both directions.** The old rule matched the
  leading token against `('echo','sleep','true','wait')`, so it saw 12 sleeps where the store has
  421 and counted 449 heredoc `echo`s as polling — then fed a "Poll storm" anomaly and a dashboard
  measure. `wait_kind` is `blocking watch | polling loop | sleep | state check`, classified from
  the whole command line in the extract. **`state check` is deliberately not a wait**: reading PR
  state once is work. Keeping them apart changed the PR Fixup story from "82 waits, middling" to
  "463 state checks, 40x Build's 11" — a different diagnosis, and the first evidence-based one.
- Kandev's own **success signal is not an outcome label** — it counts budget-blocked, idle-skipped
  and user-stopped runs as successes, so it is never mirrored here. The one real outcome signal in
  the store is **`github_task_prs.state`**: a merged PR is work that landed. It is extracted as
  `fct_pull_request` and joined to card spend in `kandev_outcomes` / the `outcomes` metrics view.
  - A merged PR is evidence work **shipped**, not that it was **correct** — nothing counts a
    revert or a follow-up fix. Ranking on cost-per-merged-PR rewards small PRs the same way
    ranking on cost alone rewards giving up early.
  - **Coverage is partial and must stay visible.** Only 18 of 73 cards ever opened a PR. Cards
    without one keep their full spend under `outcome = 'no PR opened'` rather than being dropped,
    and `merged_cost_share` is published next to `cost_per_merged_pr` so the gap cannot be missed.
  - `outcomes` is built on `kandev_cards`, so **deleted-card spend is absent by construction**
    ($820.41 — the card is gone, so it cannot be joined to an outcome). `kandev_outcomes` totals
    $4,121.52 against the store's $4,941.93; the difference is exactly that orphaned spend.
  - PRs are aggregated **to the card before the join**. The store has 18 PR rows, but
    `UNIQUE(task_id, repository_id, pr_number)` permits several per card — joining per-PR would
    double a card's cost the day a second PR is opened.
  - **A card is not a pull request, and here they disagree.** PR `kandev#2418` is shared by two
    cards, so the 18 rows are **17 distinct PRs and 11 merged**, not 18 and 12. `merged_pr_key`
    carries PR identity so `merged_prs` / `cost_per_merged_pr` count pull requests, while
    `merged_cards` counts cards. Counting cards and labelling them PRs was a real bug here.
  - **`closed` is not `abandoned`.** The store records no closure reason and no superseding-PR
    link, so a closed PR may have been split, superseded or exploratory. Per *card* the
    closed-unmerged group looks 5.3× a merged one; per *line changed* it is 1.2×, on n=2. Quote
    the per-line figure, or quote neither.
  - GitHub reports a merged PR as **closed as well**, so `merged` must be tested before any
    `closed` branch or every successful merge scores as an abandonment.
