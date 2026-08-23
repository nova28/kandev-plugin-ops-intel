# Kandev operational telemetry — a Rill project

A local BI surface over the Kandev SQLite store, so questions about what our agent runs cost
and where their time goes can be answered by looking rather than by writing another ad-hoc
query. Reasoning, findings and the argument for the shape of it are in
[`../2026-08-12-kandev-operational-bi.md`](../2026-08-12-kandev-operational-bi.md). This
file is operating instructions.

## Run it

```bash
cd docs/research/kandev/rill && ./extract/extract.sh && rill start .
```

`rill` is the [Rill Developer](https://docs.rilldata.com) CLI (`brew install rilldata/tap/rill`).
Nothing else is required — DuckDB is embedded, and the project reads only the CSVs the
extractor writes. It never touches the live Kandev database.

Point it at a different store with `KANDEV_DB=/path/to/kandev.db ./extract/extract.sh`.

### The one trap

**Re-running the extract does not refresh a running Rill.** `invalidate_on_change` does not
fire on these CSVs in practice — verified, not assumed: after a re-extract that visibly
changed the file on disk, the dashboard still served the previous numbers until the server
was restarted. So the loop is:

```bash
./extract/extract.sh && kill %1 2>/dev/null; rill start .
```

A stale dashboard looks exactly like a correct one, which is what makes this worth a line in
a README rather than a comment in a file nobody opens.

`rill validate .` refuses to run while `rill start` holds the port — stop the server first.

## Layout

```
extract/extract.sh     snapshot the live store, run the SQL, promote atomically
extract/extract.sql    THE REDACTION BOUNDARY — a column whitelist, not a blocklist
models/src_*.yaml      the five CSVs, loaded verbatim
models/kandev_*.yaml   the analysis tables (turns, cost, activity, cards, step timeline)
metrics/*.yaml         four metrics views, each with an inline explore dashboard
dashboards/            overview canvas + workspace & step deep dive
data/                  extractor output — gitignored, regenerable
```

Four metrics views, one per grain:

| Metrics view | Grain | Answers |
|---|---|---|
| **Cost & tokens** | one metered cost event | What did it cost, per model, per step, per unit of output |
| **Turn timing** | one agent turn | Where the time went — agent time against idle time |
| **Agent activity** | one message | What the agent did — tool mix, skills, human gates |
| **Card economics** | one card | Cost, time and activity joined on the unit humans reason about |

Plus two canvases: `/canvas/overview` and `/canvas/step_deep_dive`.

## Which step dimension to use

Every fact table carries two, and picking the wrong one silently answers a different question:

- **`step_at_event`** — the step in force *when the thing happened*. Use this for anything of
  the form "what does step X cost / take / involve". It is reconstructed against
  `kandev_step_points`, a timeline built from the ~400 `workflow_step_name` stamps Kandev
  writes onto messages. The two fact tables resolve it differently, on purpose:
  - `kandev_turns` ASOF-joins on `started_at`, because a turn's work happens *after* its
    start — a turn beginning at the same instant as a stamp belongs to the step being entered.
  - `kandev_cost` resolves its step from the event's **turn stamp** wherever it has one.
    Kandev stamps `workflow_step_id_at_start` on every turn and `turn_id` on every cost event
    from 2026-08-16, so from that date the step is a join, not a reconstruction.
    `step_attribution_basis = 'turn stamp'` marks those rows.
  - Before the cutover there is no stamp, and `kandev_cost` falls back to a window rule. It
    does **not** ASOF-join: a cost event looks *backwards*, billing the work done since the
    previous event, and Kandev flushes those events at a step transition — so "nearest stamp
    at or before" credited the money to the step that had just started. It reported `Testing`
    at $797 and first in the New Feature Dev table against an actual $331 and third. The
    fallback instead attributes each event to the step holding the most messages in the
    window it bills, and `step_attribution_basis` says whether that window sat in one step or
    the label is a majority verdict over a window that crossed a boundary.
  - **The fallback is wrong on multi-profile workflows, and that is why the stamp exists.**
    A session's timeline records the step it *signals a move into*, not the step it works. On
    a workflow that runs different steps under different agent profiles, a session parks on a
    label another session is executing, and its next wake is billed there. Measured against
    the stamp: 25.4% of post-cutover dollars landed on the wrong step, moving whole models
    between steps. Pre-cutover rows still carry that error and cannot be repaired.
- **`current_step`** — where the card sits *now*. Its final resting place. Only useful for
  "what is stuck where".

Filter `step_attributed = 'yes'` before comparing steps. About a fifth of spend happens
before its session's first stamp, and the unattributed pile is larger than most real steps —
left in, it sits at the top of every leaderboard looking like the most expensive stage of the
board.

## Cutting to a config epoch

**Read this before quoting any total.** The store spans several config environments, and most of it
is not evidence about the machine running today. On the 2026-08-20 extract, **$5,798 of the Kandev
workspace's $8,778 was spent before the epoch series began** — 1M window, no compaction ceiling,
workflow revisions that no longer exist. Summed undifferentiated, every headline is wrong by
roughly 3x.

`models/kandev_config_epoch.yaml` is the cut, one row per session. Join it and filter:

```sql
SELECT c.workflow, c.step_at_event, SUM(c.cost_subcents)/10000.0 AS usd
FROM kandev_cost c
JOIN kandev_config_epoch e USING (session_id)
WHERE e.is_current_series      -- ENV-005 onward: the first OBSERVED ceiling
  AND e.is_measurable          -- excludes ENV-003, void on a collapsed 200K proxy
  AND c.origin = 'manual'      -- automation runs are a different population
GROUP BY 1, 2
```

Two columns gate what you may claim from a row:

| Column | Read it as |
|---|---|
| `epoch_basis` | `transcript` is exact (the environment binds at process spawn). `session start` is a proxy — Kandev stamps the session row, not the process. |
| `is_measurable` | Validity, not age. Only ENV-003 is false. ENV-001 is old and perfectly good *as ENV-001 evidence*. |

**`epoch_basis` matters more than it looks.** The transcript key reaches 69 of 404 sessions and
**zero in ENV-007, the current environment** — so any statement about today's config rests on the
`session start` fallback. Where both keys exist they agree on 59 of 69, and `check.sh` asserts the
10 disagreements never invert (transcript always earlier). If that assertion ever fails, every
ENV-007 figure here is suspect.

Boundaries are duplicated between this model and `kandev_requests.yaml` because Rill has no shared
scalar macro. Edit one, edit both, re-run `./check.sh` — the agreement assertion is what makes the
duplication safe.

## Three things this cannot tell you

Worth knowing before the first meeting where someone points at a chart.

**There is no outcome.** Nothing in the store records whether a card succeeded. `task_state`
separates COMPLETED from IN_PROGRESS and carries no notion of correctness or rework, and
Kandev's own success chart counts budget-blocked, idle-skipped and user-pressed-Stop runs as
successes — so it is not merely missing, it is misleading, and it is deliberately not
reproduced here. Everything on these dashboards is cost-side. **Ranking cards by cost alone
rewards giving up early**, because the cheapest card may be the one that was abandoned.

**Idle is a gap, not a cause.** The store cannot distinguish orchestration delay from a
queued dispatch from an operator at lunch. Idle also understates true waiting: the gap before
a session's first turn is invisible, and on one measured card that excluded gap was longer
than the card's entire recorded wall time.

**Step history is partial.** `session_step_history` and `workflow_step_decisions` are both
zero rows, so transitions are reconstructed from stamps and tool calls. An operator dragging
a card on the board issues no tool call and writes no row — only *agent*-initiated
transitions are visible. A workflow that looks smooth may be one a human kept nudging.

**Codex and agy cost nothing here, and that is wrong.** They run as subprocesses billed to a
separate account, so their tokens never reach Kandev's ledger: 313 codex invocations against
five OpenAI events totalling $0.28. They concentrate in Review and Spec Review, which means
**the two steps that look cheapest are the two most understated.** The `external_agent`
dimension and `external_agent_calls` measure exist so this is visible rather than silently
absent — they do not fix it.

## Two traps in the source data, already handled

Both cost someone real time before they were written down; neither is obvious from the schema.

- **`task_sessions.tokens_in` excludes cached input**, understating real input volume by more
  than 99.99% — it is the obvious column, and it is wrong by roughly five orders of
  magnitude. Everything here reads `office_cost_events` instead. The rollup survives in
  `src_dim_session` only as `rollup_tokens_in_UNTRUSTED`, so the gap can be shown rather than
  silently inherited.
- **1 subcent = $0.0001**, read from Kandev's own frontend currency formatter. This was
  previously back-derived from token prices and the answer was wrong by 10×. An undocumented
  unit is not something to infer from an arithmetic check that looks plausible.

## Redaction

`extract/extract.sql` is the only place raw Kandev data is read, and it is a whitelist.
Message content, task descriptions and every prompt-bearing field are never selected — not
truncated, not hashed, not selected. Tool arguments survive only for read/edit/search, where
they are file paths; shell command lines are reduced to the leading binary, and a leading
token containing `=` is dropped entirely as `(env-prefixed command)` because an inline
environment assignment is exactly where a credential appears. That last rule exists because
the first version of this extractor leaked 731 of them.

Kandev's own redactor is wired into a single call site (the public-gist export path), so
anything reading the database directly gets no redaction for free.

## Vendored agent skills

`.claude/skills/` holds [rilldata/agent-skills](https://github.com/rilldata/agent-skills) at
commit `b69fe4d`, synced verbatim so an agent editing this project reads Rill's own
documentation for each resource type instead of guessing YAML properties.

`rill init --agent claude` installs these, but the copy bundled with the CLI is behind
upstream and omits `rill-analysis` — hence the direct sync. **Version skew is live and worth
knowing:** upstream documents Rill v0.88, and the CLI here is v0.86.6, so a property the
skills describe may not exist in the installed binary. `rill validate .` is the backstop —
it will reject one, and it is fast.
