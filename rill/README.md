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
  - `kandev_cost` does **not** ASOF-join. A cost event looks *backwards*: it bills the work
    done since the previous event, and Kandev flushes those events at a step transition, so
    "nearest stamp at or before" credited the money to the step that had just started. It
    reported `Testing` at $797 and first in the New Feature Dev table against an actual $331
    and third. Each event is now attributed to the step holding the most messages in the
    window it bills. `step_attribution_basis` says whether that window sat in one step or the
    label is a majority verdict over a window that crossed a boundary (142 of 668 events).
- **`current_step`** — where the card sits *now*. Its final resting place. Only useful for
  "what is stuck where".

Filter `step_attributed = 'yes'` before comparing steps. About a fifth of spend happens
before its session's first stamp, and the unattributed pile is larger than most real steps —
left in, it sits at the top of every leaderboard looking like the most expensive stage of the
board.

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
