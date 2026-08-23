-- Kandev operational telemetry -> flat CSV, for the Rill project one directory up.
--
-- THIS FILE IS THE REDACTION BOUNDARY. `2026-08-11-workspace-telemetry-inventory.md` § 5
-- records that Kandev's own redactor is wired into exactly one call site (the public-gist
-- export path), so anything reading the database directly gets no redaction for free and
-- must implement its own. That is this file, and the rule it enforces is a column
-- whitelist, not a blocklist:
--
--   * `task_session_messages.content` is NEVER selected. Not truncated, not hashed — not
--     selected. It is the transcript, and it carries secrets, prompts and terminal output.
--   * `tasks.description`, `workflow_steps.prompt`, `workflows.prompt` and
--     `agent_profiles.custom_prompt` are NEVER selected, for the same reason.
--   * Tool arguments are selected only for `tool_read` / `tool_edit` / `tool_search`, where
--     the argument is a repo-relative path or a search pattern. `tool_execute` arguments
--     are shell command lines and are dropped after the leading binary name — a command
--     line is the single most likely place for a credential to appear in this store.
--
-- If you add a column here, ask which of the four it is: an identifier, a timestamp, a
-- number, or a low-cardinality enum. If it is none of those, it is prose, and prose does
-- not leave the database.
--
-- Consumed by extract.sh, which runs it against a `VACUUM INTO` snapshot rather than the live
-- file (see that script's header for why `.backup` doesn't work). Every derivation beyond
-- flattening belongs in the Rill models, not here.
--
-- EVERY QUERY BELOW IS A FULL RE-DERIVE, NOT A DELTA. There is no `WHERE updated_at > :last`
-- anywhere in this file, and that is deliberate, not an oversight: several downstream
-- derivations (the git-snapshot LAG deltas in kandev_code_output.yaml, the config-epoch cut,
-- the rebase/base-commit-change detection) need each session's *entire* history to compute
-- correctly, not just what changed since the last extract — an incremental version of this
-- file would have to re-derive those from scratch anyway. A refresh's cost is therefore fixed
-- regardless of how little actually changed; see rill/auto-refresh.sh's SIGNAL-DRIVEN FAST
-- PATH for how the plugin avoids running this needlessly rather than making each run cheaper.

.bail on
.mode csv
.headers on


-- ---------------------------------------------------------------------------
-- Shared dimensional spine.
--
-- NOTE ON `step`: `tasks.workflow_step_id` is the card's CURRENT step, not the step it was
-- in when a given turn ran, so everything downstream names it `current_step` and nobody may
-- read it as history.
--
-- CORRECTED 2026-08-19. The original note said `session_step_history` and
-- `workflow_step_decisions` were BOTH zero rows (inventory § 3.1) and that no per-event step
-- was therefore available. That is now half wrong and the half that changed matters:
-- `session_step_history` carries 580+ rows and IS extracted below as `fct_step_transition`,
-- the real per-event ledger. `workflow_step_decisions` remains genuinely empty.
-- Leaving the old note in place had a cost — it was read three separate times on 2026-08-19
-- as evidence that step history is unavailable, once far enough to nearly block an
-- experiment on a defect that had already resolved.
-- ---------------------------------------------------------------------------
CREATE TEMP VIEW v_task AS
SELECT
    t.id                                              AS task_id,
    t.workspace_id                                    AS workspace_id,
    COALESCE(NULLIF(w.name, ''), '(unknown)')         AS workspace,
    COALESCE(NULLIF(wf.name, ''), '(none)')           AS workflow,
    COALESCE(NULLIF(ws.name, ''), '(none)')           AS current_step,
    COALESCE(ws.position, -1)                         AS current_step_position,
    COALESCE(NULLIF(ws.stage_type, ''), '(none)')     AS stage_type,
    -- Card titles are operator-authored labels, not agent output. Newlines stripped so a
    -- title can never terminate a CSV record early.
    REPLACE(REPLACE(COALESCE(t.title, ''), CHAR(10), ' '), CHAR(13), ' ') AS task_title,
    COALESCE(NULLIF(t.state, ''), '(none)')           AS task_state,
    COALESCE(NULLIF(t.priority, ''), '(none)')        AS priority,
    COALESCE(NULLIF(t.origin, ''), '(none)')          AS origin,
    CASE WHEN t.is_ephemeral = 1 THEN 'yes' ELSE 'no' END       AS is_ephemeral,
    CASE WHEN t.autopilot_enabled = 1 THEN 'yes' ELSE 'no' END  AS autopilot_enabled,
    CASE WHEN COALESCE(t.parent_id, '') <> '' THEN 'yes' ELSE 'no' END AS is_child_task,
    CASE WHEN t.archived_at IS NULL THEN 'no' ELSE 'yes' END    AS is_archived,
    strftime('%Y-%m-%dT%H:%M:%SZ', t.created_at)      AS task_created_at
FROM tasks t
LEFT JOIN workspaces      w  ON w.id  = t.workspace_id
LEFT JOIN workflows       wf ON wf.id = t.workflow_id
LEFT JOIN workflow_steps  ws ON ws.id = t.workflow_step_id;


-- Per-turn runtime configuration. `config_options` is the array actually in force;
-- `config_baseline` is the profile default. 1,656 of 1,724 turns carry the array and the
-- remainder carry a truncated snapshot (inventory § 2.1) — so fall back to the baseline and
-- expose `config_completeness` rather than silently emitting NULL, because a dashboard
-- cannot tell "ran at default effort" from "we failed to record the effort".
CREATE TEMP VIEW v_turn_config AS
WITH rc AS (
    SELECT id AS turn_id, json_extract(metadata, '$.runtime_config_snapshot') AS snap
    FROM task_session_turns
),
opts AS (
    SELECT
        rc.turn_id,
        MAX(CASE WHEN json_extract(j.value, '$.id') = 'effort' THEN json_extract(j.value, '$.value') END) AS effort,
        MAX(CASE WHEN json_extract(j.value, '$.id') = 'fast'   THEN json_extract(j.value, '$.value') END) AS fast_mode,
        MAX(CASE WHEN json_extract(j.value, '$.id') = 'agent'  THEN json_extract(j.value, '$.value') END) AS agent,
        MAX(CASE WHEN json_extract(j.value, '$.id') = 'mode'   THEN json_extract(j.value, '$.value') END) AS mode
    FROM rc, json_each(rc.snap, '$.config_options') j
    GROUP BY rc.turn_id
)
SELECT
    rc.turn_id,
    COALESCE(NULLIF(json_extract(rc.snap, '$.model'), ''), '(unrecorded)') AS model,
    COALESCE(o.mode,      json_extract(rc.snap, '$.config_baseline.mode'),   '(unrecorded)') AS mode,
    COALESCE(o.effort,    json_extract(rc.snap, '$.config_baseline.effort'), '(unrecorded)') AS effort,
    COALESCE(o.fast_mode, json_extract(rc.snap, '$.config_baseline.fast'),   '(unrecorded)') AS fast_mode,
    COALESCE(o.agent,     json_extract(rc.snap, '$.config_baseline.agent'),  '(unrecorded)') AS agent,
    CASE
        WHEN o.turn_id IS NOT NULL THEN 'full'
        WHEN json_extract(rc.snap, '$.config_baseline') IS NOT NULL THEN 'baseline_only'
        ELSE 'truncated'
    END AS config_completeness
FROM rc
LEFT JOIN opts o ON o.turn_id = rc.turn_id;


-- ---------------------------------------------------------------------------
-- dim_task — one row per card.
-- ---------------------------------------------------------------------------
.output data/dim_task.csv
SELECT * FROM v_task;


-- ---------------------------------------------------------------------------
-- dim_workflow_step — one row per step of a workflow definition. The step ORDER.
--
-- Everything else in this extract records what happened; this records what was supposed to
-- happen. It exists so a per-step readout can be laid out in the workflow's own sequence
-- rather than in the order steps happened to be observed.
--
-- That distinction is load-bearing. Step attribution is reconstructed from ~400 stamps
-- across 42 of 67 sessions, and a card with two concurrent sessions can easily produce a
-- first-observed order of Spec -> Testing -> Review -> Build. That is a stamping artifact,
-- not a card that bounced, and ordering a chart by it would publish the artifact as a
-- finding. Ordering by `position` puts the readout on the same axis as the step rail the
-- operator already reads at the top of a task.
--
-- `prompt` is NEVER selected here — it is agent-directed prose and is named in the header's
-- whitelist as one of the four columns that do not leave the database.
-- ---------------------------------------------------------------------------
.output data/dim_workflow_step.csv
SELECT
    ws.id                                             AS workflow_step_id,
    ws.workflow_id                                    AS workflow_id,
    COALESCE(NULLIF(wf.name, ''), '(none)')           AS workflow,
    -- Step names are operator-authored labels, same class as a card title. Newlines are
    -- stripped so a name can never terminate a CSV record early.
    REPLACE(REPLACE(COALESCE(ws.name, ''), CHAR(10), ' '), CHAR(13), ' ') AS step,
    ws.position                                       AS step_position,
    COALESCE(NULLIF(ws.stage_type, ''), '(none)')     AS stage_type
FROM workflow_steps ws
LEFT JOIN workflows wf ON wf.id = ws.workflow_id;


-- ---------------------------------------------------------------------------
-- fct_step_transition — the REAL step-transition ledger. One row per transition.
--
-- This table was zero rows for the entire life of the analysis that built this project, and
-- everything downstream was engineered around its absence: the step timeline was
-- reconstructed from `workflow_step_name` stamps that Kandev writes only when the workflow
-- ENGINE injects a message, which covered ~400 messages across 42 of 67 sessions and could
-- never see a human dragging a card.
--
-- It started filling on 2026-08-12 (kandev `feature/wire-session-step-hi-u06`, now on
-- local/integration). It records what the stamps could not:
--
--   * `from_step_id` — so the step a session was in BEFORE its first transition is knowable,
--     which is exactly the window that used to swallow spend. One card put $74.87 there.
--   * `trigger` — 'manual' vs 'auto_complete'. Manual moves are invisible to message stamps
--     by construction, and they are half the rows.
--
-- Step IDs, not names: joined to dim_workflow_step downstream rather than flattened here,
-- because a step can be renamed and the id is the stable key.
--
-- `metadata` is NOT selected. It is free-form TEXT and this file's whitelist rule applies:
-- an identifier, a timestamp, a number, or a low-cardinality enum — otherwise it is prose.
-- ---------------------------------------------------------------------------
.output data/fct_step_transition.csv
SELECT
    h.id                                              AS transition_id,
    h.session_id                                      AS session_id,
    COALESCE(h.from_step_id, '')                      AS from_step_id,
    h.to_step_id                                      AS to_step_id,
    COALESCE(NULLIF(h.trigger, ''), '(none)')         AS trigger,
    CASE WHEN COALESCE(h.actor_id, '') <> '' THEN 'yes' ELSE 'no' END AS has_actor,
    strftime('%Y-%m-%dT%H:%M:%SZ', h.created_at)      AS occurred_at
FROM session_step_history h;


-- ---------------------------------------------------------------------------
-- dim_session — one row per agent session.
--
-- `cost_subcents` / `tokens_in` / `tokens_out` are carried ONLY so the Rill layer can
-- expose the discrepancy as a data-quality measure. `tokens_in` excludes cached input and
-- is wrong by ~5 orders of magnitude (inventory § 3.4). Never aggregate them as volume.
-- ---------------------------------------------------------------------------
.output data/dim_session.csv
SELECT
    s.id                                                AS session_id,
    s.task_id                                           AS task_id,
    COALESCE(NULLIF(s.state, ''), '(none)')             AS session_state,
    COALESCE(NULLIF(s.review_status, ''), '(none)')     AS review_status,
    COALESCE(NULLIF(ap.name, ''), '(none)')             AS agent_profile,
    COALESCE(NULLIF(r.name, ''), '(none)')              AS repository,
    COALESCE(NULLIF(s.base_branch, ''), '(none)')       AS base_branch,
    CASE WHEN s.is_primary = 1 THEN 'yes' ELSE 'no' END AS is_primary,
    -- Load-bearing for the transcript join, and blank on a material fraction of rows
    -- (inventory § 4). Surfaced as a dimension so the miss rate is visible, not guessed.
    CASE WHEN COALESCE(s.workspace_path, '') <> '' THEN 'yes' ELSE 'no' END AS has_workspace_path,
    CASE WHEN s.completed_at IS NULL THEN 'no' ELSE 'yes' END               AS is_completed,
    strftime('%Y-%m-%dT%H:%M:%SZ', s.started_at)        AS session_started_at,
    strftime('%Y-%m-%dT%H:%M:%SZ', s.completed_at)      AS session_completed_at,
    s.cost_subcents                                     AS rollup_cost_subcents,
    s.tokens_in                                         AS rollup_tokens_in_UNTRUSTED,
    s.tokens_out                                        AS rollup_tokens_out
FROM task_sessions s
LEFT JOIN agent_profiles ap ON ap.id = s.agent_profile_id
LEFT JOIN repositories   r  ON r.id  = s.repository_id;


-- ---------------------------------------------------------------------------
-- fct_turn — one row per turn. The timing grain.
--
-- `step_at_start` is the exact step this turn ran in — see the column comment. It is what
-- `kandev_cost` now joins through, and it is the reason per-step cost stopped being a
-- reconstruction for post-2026-08-16 data.
--
-- `idle_seconds_before` is the gap from the previous turn's completion in the same
-- session. Inventory § 2.3 is emphatic that this measures a gap and does NOT identify its
-- cause — orchestration delay, queued dispatch and operator latency are indistinguishable
-- here. The first turn of a session gets NULL, not 0, because the pre-first-turn gap is
-- invisible in this table and a 0 would understate it silently.
-- ---------------------------------------------------------------------------
.output data/fct_turn.csv
SELECT
    t.id                                            AS turn_id,
    t.task_session_id                               AS session_id,
    t.task_id                                       AS task_id,
    ROW_NUMBER() OVER (PARTITION BY t.task_session_id ORDER BY t.started_at) AS turn_index,
    strftime('%Y-%m-%dT%H:%M:%SZ', t.started_at)    AS started_at,
    strftime('%Y-%m-%dT%H:%M:%SZ', t.completed_at)  AS completed_at,
    CASE WHEN t.completed_at IS NULL THEN NULL
         ELSE strftime('%s', t.completed_at) - strftime('%s', t.started_at) END AS agent_seconds,
    strftime('%s', t.started_at)
        - LAG(strftime('%s', t.completed_at)) OVER (PARTITION BY t.task_session_id ORDER BY t.started_at)
                                                    AS idle_seconds_before,
    CASE WHEN t.completed_at IS NULL THEN 'no' ELSE 'yes' END AS is_complete,
    c.model, c.mode, c.effort, c.fast_mode, c.agent, c.config_completeness,
    COALESCE(NULLIF(json_extract(t.metadata, '$.agent_type'), ''), '(none)') AS agent_type,
    -- THE STEP THIS TURN STARTED IN, READ RATHER THAN RECONSTRUCTED.
    --
    -- Kandev stamps `workflow_step_id_at_start` into the turn's metadata inside the same
    -- transaction that inserts the turn, reading the card's step directly
    -- (`CreateTurnWithStepStamp`, task/repository/sqlite/session.go). It is the only
    -- per-event step signal in this store that is a READING — every other one, including
    -- `kandev_step_points`, is inferred from a timeline.
    --
    -- Null before 2026-08-16 and on the small number of turns whose stamp write degraded
    -- (the backend deliberately falls back to an unstamped insert rather than failing turn
    -- creation for telemetry). Left NULL rather than defaulted: an unstamped turn has an
    -- UNKNOWN step, and the window reconstruction downstream is what handles that case.
    ws.name                                         AS step_at_start
FROM task_session_turns t
LEFT JOIN v_turn_config c ON c.turn_id = t.id
LEFT JOIN workflow_steps ws
       ON ws.id = json_extract(t.metadata, '$.workflow_step_id_at_start');


-- ---------------------------------------------------------------------------
-- fct_cost_event — one row per metered event. THE ONLY TRUSTWORTHY COST GRAIN.
--
-- 1 subcent = $0.0001, read from the frontend formatter, not back-derived from token
-- prices (inventory § 3.4 — the back-derivation was wrong by 10x). The USD conversion is
-- deliberately left to the Rill measure so the raw integer survives here unrounded.
--
-- `turn_id` WAS NULL ON EVERY EVENT AND IS NOT ANY MORE. Kandev began stamping it on
-- 2026-08-16; before that date no event carries one and none can be backfilled. It is the
-- single most valuable column here, because `fct_turn.step_at_start` carries the step the
-- card was in when that turn BEGAN — read from the task, at turn creation, by the backend
-- that knew the answer. That makes step attribution a join rather than a reconstruction for
-- every event from the cutover onward. See the attribution note in models/kandev_cost.yaml.
--
-- Emitted raw and empty-as-empty: the cutover is a fact about the data and the model layer
-- decides what to do on each side of it.
-- ---------------------------------------------------------------------------
.output data/fct_cost_event.csv
SELECT
    e.id                                              AS cost_event_id,
    strftime('%Y-%m-%dT%H:%M:%SZ', e.occurred_at)     AS occurred_at,
    e.session_id                                      AS session_id,
    COALESCE(e.turn_id, '')                           AS turn_id,
    COALESCE(NULLIF(e.task_id, ''), s.task_id, '')    AS task_id,
    COALESCE(NULLIF(e.model, ''), '(unrecorded)')     AS model,
    COALESCE(NULLIF(e.provider, ''), '(unrecorded)')  AS provider,
    COALESCE(NULLIF(ap.name, ''), '(none)')           AS agent_profile,
    e.tokens_in                                       AS tokens_in,
    e.tokens_cached_in                                AS tokens_cached_in,
    e.tokens_out                                      AS tokens_out,
    e.cost_subcents                                   AS cost_subcents,
    -- WHAT `estimated` ACTUALLY FLAGS, AND WHAT IT DOES NOT.
    --
    -- This column used to be published as `cost_basis`, with the two values `estimated`
    -- and `metered`. The second was a false claim about 99.7% of the money: Kandev's flag
    -- is `data.Usage.Estimated`, which says the TOKEN COUNTS were synthesized (the codex
    -- ACP bridge emits no usage frame, so input tokens are inferred from context growth).
    -- It says nothing whatever about where the dollars came from.
    --
    -- `resolveCostForUsage` (office/service/event_subscribers.go) prices a row one of two
    -- ways — a provider-reported amount when the adapter forwarded one, otherwise a
    -- models.dev list-price calculation — and returns THE SAME flag on both branches.
    -- Cost provenance is therefore not recorded anywhere, and 671 of 673 events read
    -- "metered" purely because their token counts were not synthesized.
    --
    -- Renamed rather than repaired, because the honest column is a different column: this
    -- one is about tokens. Whether a figure is a bill or a list-price reconstruction is
    -- unanswerable from this store and must not be implied by a label.
    CASE WHEN e.estimated = 1 THEN 'synthesized' ELSE 'reported' END AS token_basis
FROM office_cost_events e
LEFT JOIN task_sessions  s  ON s.id  = e.session_id
LEFT JOIN agent_profiles ap ON ap.id = e.agent_profile_id;


-- ---------------------------------------------------------------------------
-- fct_message — one row per message, structure only.
--
-- Content is not selected (see the header). What survives is: what kind of message it was,
-- which tool it invoked, which skill it named, and when. That is enough to reconstruct the
-- partial step-transition ledger of inventory § 3.1 — `step_complete_kandev` marks an
-- advance and `move_task_kandev` marks an explicit move — and enough to measure the
-- human-gate proxy (`ask_user_question_kandev`, `clarification_request`).
--
-- `tool_target` is populated for read/edit/search only. For `tool_execute` we keep the
-- leading binary and drop the rest of the command line.
--
-- FOUR ENUMS ARE DERIVED HERE RATHER THAN DOWNSTREAM — `external_agent`, `wait_kind`,
-- `tool_purpose` and `scope_discipline`. All four answer questions that live in the command
-- ARGUMENTS, which are dropped before anything downstream can see them, and the leading token
-- is `cd` on most commands here so the published binary cannot stand in for them. Each emits a
-- low-cardinality enum and never the text it was read from. When adding another classifier of
-- this kind, put it here for the same reason and hold to the same output rule.
-- ---------------------------------------------------------------------------
.output data/fct_message.csv
WITH m AS (
    SELECT
        id, task_session_id, task_id, turn_id, author_type, type, created_at, requests_input,
        REPLACE(REPLACE(COALESCE(json_extract(metadata, '$.title'), ''), CHAR(10), ' '), CHAR(13), ' ') AS title,
        json_extract(metadata, '$.normalized.generic.input.raw_input.skill') AS skill,
        -- The captured stdout of a shell call, kept newline-intact (unlike `title` above,
        -- which flattens them). A codex/agy tool_execute's stdout is where its own usage
        -- report lands — the plain `tokens used\nN` line every mode prints, and Challenge/
        -- Consult's richer `CODEX_USAGE: input=... cached_input=... cache_write=... output=...
        -- reasoning_output=...` line — and the newlines are what bound one line from the next
        -- when parsing either below. NULL for every non-tool_execute message type.
        json_extract(metadata, '$.normalized.shell_exec.output.stdout') AS shell_stdout,
        -- The step the card was in WHEN THIS MESSAGE HAPPENED. This is the only per-event
        -- step signal in the store — `tasks.workflow_step_id` is the card's step now, which
        -- is useless for asking what a step cost. Stamped on ~400 messages across 42 of 67
        -- sessions; the Rill layer forward-fills it within a session.
        json_extract(metadata, '$.workflow_step_name') AS stamped_step,
        -- Work handed to an agent OUTSIDE Kandev's accounting. Computed here because it needs
        -- the full command line, which is dropped two columns later.
        CASE
            WHEN json_extract(metadata, '$.normalized.generic.input.raw_input.skill') IN ('codex', 'agy')
                THEN json_extract(metadata, '$.normalized.generic.input.raw_input.skill')
            WHEN COALESCE(json_extract(metadata, '$.title'), '') LIKE 'codex %'
              OR COALESCE(json_extract(metadata, '$.title'), '') LIKE '%codex exec%' THEN 'codex'
            WHEN COALESCE(json_extract(metadata, '$.title'), '') LIKE 'agy %'        THEN 'agy'
            ELSE NULL
        END AS external_agent
    FROM task_session_messages
)
SELECT
    m.id                                            AS message_id,
    strftime('%Y-%m-%dT%H:%M:%SZ', m.created_at)    AS created_at,
    m.task_session_id                               AS session_id,
    m.task_id                                       AS task_id,
    m.turn_id                                       AS turn_id,
    m.author_type                                   AS author_type,
    m.type                                          AS message_type,
    CASE
        WHEN m.title = '' THEN NULL
        WHEN m.type = 'tool_call' THEN m.title
        -- First whitespace-delimited token: the verb for read/edit/search, the binary for
        -- execute. A shell command may be prefixed with inline environment assignments
        -- (`FOO=bar cmd ...`), in which case the "first token" is `FOO=bar` — and the whole
        -- point of dropping command arguments is that an assignment is exactly where a
        -- credential appears. So a first token containing '=' is discarded, not published.
        WHEN INSTR(SUBSTR(m.title, 1,
                          CASE WHEN INSTR(m.title, ' ') > 0
                               THEN INSTR(m.title, ' ') - 1 ELSE LENGTH(m.title) END), '=') > 0
            THEN '(env-prefixed command)'
        ELSE SUBSTR(m.title, 1,
                    CASE WHEN INSTR(m.title, ' ') > 0 THEN INSTR(m.title, ' ') - 1 ELSE LENGTH(m.title) END)
    END                                             AS tool_name,
    CASE
        WHEN m.type IN ('tool_read', 'tool_edit', 'tool_search') AND INSTR(m.title, ' ') > 0
            THEN SUBSTR(m.title, INSTR(m.title, ' ') + 1)
        ELSE NULL
    END                                             AS tool_target,
    m.skill                                         AS skill,
    m.stamped_step                                  AS stamped_step,
    m.external_agent                                AS external_agent,

    -- THE MODEL an off-ledger codex/agy call actually used, when the invocation named one
    -- explicitly. Parsed from exactly two flag forms documented in the codex skill's own
    -- SKILL.md: `-m <model>` (exec-based modes — Challenge, Consult, the custom-instructions
    -- Review path) and the review-mode translation `-c model="<model>"` (native `codex review`
    -- rejects -m outright, so the skill rewrites it). Nothing else is read from the command
    -- line — the whole point of dropping arguments above is that an assignment is where a
    -- credential appears, and this stays narrowly scoped to those two literal markers on
    -- m.title, which already has its newlines flattened to spaces.
    --
    -- NULL is common and honest, not a bug: most sampled invocations in this store omit -m
    -- entirely and let codex fall back to whatever ~/.codex/config.toml configures on the
    -- machine that ran it — this extract cannot see that file and does not guess its value.
    CASE
        WHEN m.external_agent IS NULL THEN NULL
        WHEN INSTR(m.title, ' -m ') > 0 THEN
            NULLIF(TRIM(SUBSTR(SUBSTR(m.title, INSTR(m.title, ' -m ') + 4), 1,
                    CASE WHEN INSTR(SUBSTR(m.title, INSTR(m.title, ' -m ') + 4), ' ') > 0
                         THEN INSTR(SUBSTR(m.title, INSTR(m.title, ' -m ') + 4), ' ') - 1
                         ELSE 40
                    END), ' "' || CHAR(39)), '')
        WHEN INSTR(m.title, 'model="') > 0 THEN
            NULLIF(SUBSTR(SUBSTR(m.title, INSTR(m.title, 'model="') + 7), 1,
                    CASE WHEN INSTR(SUBSTR(m.title, INSTR(m.title, 'model="') + 7), '"') > 0
                         THEN INSTR(SUBSTR(m.title, INSTR(m.title, 'model="') + 7), '"') - 1
                         ELSE 40
                    END), '')
        ELSE NULL
    END                                             AS external_agent_model,

    -- TOKENS AN OFF-LEDGER CALL ACTUALLY USED, read from its own captured stdout rather than
    -- its command line. Two independent sources, in order of preference:
    --
    --   1. `CODEX_USAGE: input=N cached_input=N cache_write=N output=N reasoning_output=N` —
    --      printed by the codex skill's Challenge/Consult JSONL parser directly off codex's
    --      own `turn.completed.usage` object (verified live against codex-cli 0.146.0: the
    --      object really does carry all five fields, split by cache read/write and reasoning
    --      vs response — see the skill's `## Cost Estimation` section). Gives all five numbers.
    --   2. `tokens used\nN` — codex's own plain total, printed natively by `codex review`
    --      (the only mode with no `--json`, hence no breakdown) and also by Challenge/Consult
    --      as the human-readable half of the same line CODEX_USAGE rides beside. Comma-
    --      formatted in the wild (`62,791`), so the comma is stripped before casting.
    --
    -- Neither source exists for every call — most sampled invocations in this store have
    -- neither, because the run never reached a `turn.completed` (still in progress, timed
    -- out, or an earlier tool-boundary truncated the capture). NULL there is the honest
    -- answer, not a parsing failure to paper over.
    -- Every CAST below is guarded with NULLIF(..., '') on the extracted substring first. An
    -- INSTR hit whose value is truncated away (capture cut off mid-line — observed for real:
    -- a stored stdout ending in a bare "tokens used\n" with no number after it, presumably a
    -- killed/timed-out run) would otherwise SUBSTR to an empty string, and SQLite's
    -- CAST('' AS INTEGER) is 0, not NULL — silently reporting "zero tokens" for a call that
    -- was actually truncated, not free. NULLIF makes the empty case fall through to NULL.
    CASE WHEN m.external_agent IS NULL OR m.shell_stdout IS NULL THEN NULL
         WHEN INSTR(m.shell_stdout, 'CODEX_USAGE: input=') > 0 THEN
             CAST(NULLIF(SUBSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, 'CODEX_USAGE: input=') + 20), 1,
                     CASE WHEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, 'CODEX_USAGE: input=') + 20), ' ') > 0
                          THEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, 'CODEX_USAGE: input=') + 20), ' ') - 1
                          ELSE 12 END), '') AS INTEGER)
         ELSE NULL
    END                                             AS external_agent_tokens_in,

    CASE WHEN m.external_agent IS NULL OR m.shell_stdout IS NULL THEN NULL
         WHEN INSTR(m.shell_stdout, ' cached_input=') > 0 THEN
             CAST(NULLIF(SUBSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, ' cached_input=') + 14), 1,
                     CASE WHEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, ' cached_input=') + 14), ' ') > 0
                          THEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, ' cached_input=') + 14), ' ') - 1
                          ELSE 12 END), '') AS INTEGER)
         ELSE NULL
    END                                             AS external_agent_tokens_cached_input,

    CASE WHEN m.external_agent IS NULL OR m.shell_stdout IS NULL THEN NULL
         WHEN INSTR(m.shell_stdout, ' cache_write=') > 0 THEN
             CAST(NULLIF(SUBSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, ' cache_write=') + 13), 1,
                     CASE WHEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, ' cache_write=') + 13), ' ') > 0
                          THEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, ' cache_write=') + 13), ' ') - 1
                          ELSE 12 END), '') AS INTEGER)
         ELSE NULL
    END                                             AS external_agent_tokens_cache_write,

    CASE WHEN m.external_agent IS NULL OR m.shell_stdout IS NULL THEN NULL
         WHEN INSTR(m.shell_stdout, ' output=') > 0 THEN
             CAST(NULLIF(SUBSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, ' output=') + 8), 1,
                     CASE WHEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, ' output=') + 8), ' ') > 0
                          THEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, ' output=') + 8), ' ') - 1
                          ELSE 12 END), '') AS INTEGER)
         ELSE NULL
    END                                             AS external_agent_tokens_out,

    -- Last field on the line: bounded by the newline print() always ends a line with, not by
    -- a following space — there is no field after it.
    CASE WHEN m.external_agent IS NULL OR m.shell_stdout IS NULL THEN NULL
         WHEN INSTR(m.shell_stdout, ' reasoning_output=') > 0 THEN
             CAST(NULLIF(SUBSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, ' reasoning_output=') + 18), 1,
                     CASE WHEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, ' reasoning_output=') + 18), CHAR(10)) > 0
                          THEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, ' reasoning_output=') + 18), CHAR(10)) - 1
                          ELSE 12 END), '') AS INTEGER)
         ELSE NULL
    END                                             AS external_agent_tokens_reasoning_output,

    -- The plain total, independent of whether CODEX_USAGE was present. Covers `codex review`
    -- (no --json, no breakdown, ever) and stands in for Challenge/Consult calls that predate
    -- this skill printing CODEX_USAGE at all — same number either way (input + output), just
    -- without the split.
    --
    -- TWO SEPARATORS, BOTH OBSERVED IN THIS STORE. `tokens used\nN` (newline, no colon) is
    -- what the skill's own SKILL.md documents and what most rows use (221 of 261 sampled
    -- `tokens used` rows). But 29 real rows read `tokens used: N` (colon, same line) instead —
    -- an older codex-native format the skill's doc doesn't mention. Try the documented form
    -- first, fall back to the colon form so those 29 aren't silently dropped.
    CASE WHEN m.external_agent IS NULL OR m.shell_stdout IS NULL THEN NULL
         WHEN INSTR(m.shell_stdout, 'tokens used' || CHAR(10)) > 0 THEN
             CAST(NULLIF(REPLACE(SUBSTR(
                     SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, 'tokens used' || CHAR(10)) + 12),
                     1,
                     CASE WHEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, 'tokens used' || CHAR(10)) + 12), CHAR(10)) > 0
                          THEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, 'tokens used' || CHAR(10)) + 12), CHAR(10)) - 1
                          ELSE 12 END
                 ), ',', ''), '') AS INTEGER)
         WHEN INSTR(m.shell_stdout, 'tokens used:') > 0 THEN
             CAST(NULLIF(TRIM(REPLACE(SUBSTR(
                     SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, 'tokens used:') + 12),
                     1,
                     CASE WHEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, 'tokens used:') + 12), CHAR(10)) > 0
                          THEN INSTR(SUBSTR(m.shell_stdout, INSTR(m.shell_stdout, 'tokens used:') + 12), CHAR(10)) - 1
                          ELSE 12 END
                 ), ',', '')), '') AS INTEGER)
         ELSE NULL
    END                                             AS external_agent_tokens_total,

    -- WAITING, CLASSIFIED WHERE THE COMMAND LINE STILL EXISTS. Like `external_agent` above,
    -- this must be computed here: the full command line is dropped two columns up, and it is
    -- the only place the answer is visible. Only the enum leaves the database.
    --
    -- IT REPLACES A CLASSIFIER THAT WAS WRONG IN BOTH DIRECTIONS. The previous rule lived
    -- downstream and tested the LEADING TOKEN against ('echo','sleep','true','wait'). Because
    -- nearly every command here is compound (`cd <path> && ...`), that rule saw 12 sleeps in
    -- this store where there are 421, and counted 449 `echo`s as waiting when they are
    -- heredocs and file writes (`echo hi > f.txt`, `cat > /tmp/x <<'EOF'`). It then fed a
    -- "Poll storm" anomaly and a dashboard measure. A counter that is wrong in both
    -- directions is worse than no counter, because it gets quoted.
    --
    -- Precedence is deliberate: a polling loop contains a sleep, and a blocking watch may
    -- contain neither, so the most specific shape wins. `state check` is NOT waiting — it is
    -- one-shot state reading, kept separate so "how often do we look" and "how long do we
    -- wait" cannot be conflated the way the old counter conflated them.
    CASE
        WHEN m.type <> 'tool_execute'                             THEN NULL
        WHEN m.title LIKE '%--watch%'                             THEN 'blocking watch'
        WHEN (m.title LIKE '%until %' OR m.title LIKE '%while %')
         AND m.title GLOB '*sleep [0-9]*'                         THEN 'polling loop'
        WHEN m.title GLOB '*sleep [0-9]*'                         THEN 'sleep'
        WHEN m.title LIKE '%gh pr checks%'
          OR m.title LIKE '%gh pr view%'
          OR m.title LIKE '%gh run list%'
          OR m.title LIKE '%pr-state%'
          OR m.title LIKE '%pr-resolve%'
          OR m.title LIKE '%gh api%'                              THEN 'state check'
        ELSE NULL
    END                                             AS wait_kind,

    -- WHAT A ROUND TRIP WAS FOR. Classified here for exactly the reason `wait_kind` is: the
    -- leading token is `cd` on most commands in this store, so the downstream `shell_binary`
    -- cannot answer it. Only the enum leaves the database.
    --
    -- THE SPLIT THAT EARNS THIS COLUMN IS RECON AGAINST EDIT. A tool call is both the unit of
    -- agent action and the unit of context re-read — every call re-sends the whole prefix — so
    -- a step that searches a lot pays for that search again on every later round trip, because
    -- the results stay in the window. On the card this was built for, Build issued 164 recon
    -- calls against 48 edits, and the recon carried about a third of the step's cost.
    --
    -- READ A HIGH RECON SHARE AS A PROMPT, NEVER A SCORE. An unfamiliar subsystem legitimately
    -- costs more to search than a familiar one, and nothing in this store knows which it was.
    -- This column says where the round trips went, not whether they were deserved.
    --
    -- PRECEDENCE IS DELIBERATE. `verify` is tested before `recon` because a test run piped to
    -- a filter (`go test ./... | grep FAIL`) is verification wearing a search's clothes, and
    -- the pipe is the more common shape here. `recon` is tested before `vcs` for the mirror
    -- reason: `git grep` is a search, whatever binary it starts with.
    CASE
        WHEN m.type IN ('tool_read', 'tool_search')                 THEN 'recon'
        WHEN m.type = 'tool_edit'                                   THEN 'edit'
        -- An MCP call and a todo write are round trips like any other: they re-send the whole
        -- prefix and they bill. They are classified rather than left NULL so that `tool_calls`
        -- counts every request the step actually paid for. `thinking` and `message` stay NULL
        -- because they are parts of a reply, not requests of their own.
        WHEN m.type IN ('tool_call', 'todo')                        THEN 'agent control'
        WHEN m.type <> 'tool_execute'                               THEN NULL
        WHEN m.title LIKE '%go test%' OR m.title LIKE '%go build%'
          OR m.title LIKE '%go vet%'  OR m.title LIKE '%gofmt%'
          OR m.title LIKE '%make %'   OR m.title LIKE '%pytest%'
          OR m.title LIKE '%pnpm %'   OR m.title LIKE '%npm %'
          OR m.title LIKE '%cargo %'  OR m.title LIKE '%playwright%' THEN 'verify'
        -- SHORT BINARY NAMES NEED A WORD BOUNDARY, and LIKE cannot express one. A bare
        -- `LIKE '%rg %'` also matches `--arg ` and `LIKE '%ls %'` matches `tools `, which is
        -- the both-directions failure the `wait_kind` note above was written about. GLOB has
        -- character classes, so a short name is anchored either at the start of the command or
        -- behind a shell separator. `grep` is long enough to be safe unanchored.
        WHEN m.title LIKE '%grep%'                                  THEN 'recon'
        WHEN m.title GLOB 'rg *'   OR m.title GLOB '*[ &|;(]rg *'   THEN 'recon'
        WHEN m.title GLOB 'ls *'   OR m.title GLOB '*[ &|;(]ls *'   THEN 'recon'
        WHEN m.title GLOB 'find *' OR m.title GLOB '*[ &|;(]find *' THEN 'recon'
        WHEN m.title GLOB 'tree *' OR m.title GLOB '*[ &|;(]tree *' THEN 'recon'
        WHEN m.title LIKE '%git %'                                  THEN 'vcs'
        ELSE 'other shell'
    END                                             AS tool_purpose,

    -- HOW BROADLY A SEARCH OR TEST WAS AIMED. Same placement, same reason, same redaction: the
    -- breadth lives in the arguments, and the arguments do not leave this file.
    --
    -- THIS COLUMN EXISTS TO BE ABLE TO SAY "NO". The analysis that prompted it opened with the
    -- assumption that an expensive Build step was running unscoped commands, and the fix that
    -- followed would have been a prompt change telling the agent to narrow them. The data said
    -- 87 of 121 `go test` runs already carried `-run`, 30 more were package-scoped, and 4 were
    -- recursive; greps were path-scoped 134 times in 188. The recommendation was withdrawn.
    -- A column whose main use is retiring a plausible theory is worth more than one that
    -- confirms them.
    --
    -- NULL means the question does not apply — this is not a search or a test, so there is no
    -- breadth to judge. Do not read NULL as unscoped.
    --
    -- Name-scoping is tested first because it binds hardest: `go test ./... -run TestFoo` walks
    -- the whole tree to find one test and runs one test, so it is scoped by name despite the
    -- recursive path.
    --
    -- PATH SCOPING IS DETECTED ON `./`, NOT ON `/`. Nearly every command in this store is
    -- `cd <path> && ...`, so a bare test for a slash would find one in the prefix of almost
    -- every row and report the whole board as path-scoped. A relative package argument
    -- (`./internal/office`) is the shape that actually narrows the command, and an absolute
    -- `cd /Users/...` does not match it.
    --
    -- THE PRICE OF THAT CHOICE IS AN HONEST FIFTH VALUE. A grep written `rg pattern internal/`
    -- is path-scoped with no leading `./`, and nothing in the surviving title separates it from
    -- an unscoped one. Those rows are `not determinable` rather than being called unscoped, and
    -- the model excludes them from the denominator. Undercounting a share is recoverable;
    -- reporting disciplined commands as sloppy is what sends someone to fix a prompt that was
    -- already correct.
    CASE
        WHEN m.type <> 'tool_execute'                               THEN NULL
        WHEN m.title NOT LIKE '%go test%' AND m.title NOT LIKE '%grep%'
         AND m.title NOT LIKE '%pytest%'  AND m.title NOT LIKE '%playwright%'
         AND NOT (m.title GLOB 'rg *' OR m.title GLOB '*[ &|;(]rg *') THEN NULL
        WHEN m.title LIKE '%-run %' OR m.title LIKE '%--grep%'
          OR m.title LIKE '%-k %'                                   THEN 'scoped by name'
        WHEN m.title LIKE '%./...%'                                 THEN 'unscoped recursive'
        WHEN m.title LIKE '%./%'                                    THEN 'scoped by path'
        ELSE 'not determinable'
    END                                             AS scope_discipline,

    CASE WHEN m.requests_input = 1 THEN 'yes' ELSE 'no' END AS requests_input
FROM m;


-- ---------------------------------------------------------------------------
-- fct_pull_request — one row per GitHub PR opened for a card. THE OUTCOME SIGNAL.
--
-- Everything else in this extract measures effort. This measures what the effort produced,
-- and it is the only table in the store that does: `state` distinguishes a card that
-- shipped from one that was abandoned, and `additions`/`deletions` count the code that
-- survived rather than the tokens a model emitted. Cost per merged PR is a number the
-- other five files cannot express between them at any grain.
--
-- COVERAGE IS PARTIAL AND THE MODELS MUST SAY SO. Only cards that opened a PR appear, and
-- a card can finish without one. A cost total filtered to merged PRs is therefore a subset
-- of spend, never a reconciliation of it — kandev_outcomes carries the unmatched spend as
-- its own bucket rather than letting it vanish into a denominator.
--
-- REDACTION (see the header — identifier, timestamp, number or low-cardinality enum only):
--   * `pr_title` is prose and is NEVER selected.
--   * `author_login` is a person and is NEVER selected. One human uses this store; the
--     column would add a name to every row and answer nothing.
--   * `pr_url` and `owner` carry the org path; `repo` alone already matches the
--     `repository` column dim_session publishes, so the extra locator earns nothing.
--   * `head_branch` is high-cardinality and routinely carries a slugged card title, which
--     is the description prose arriving by another door. `base_branch` is an enum.
-- ---------------------------------------------------------------------------
.output data/fct_pull_request.csv
SELECT
    p.task_id                                          AS task_id,
    p.repo                                             AS repository,
    -- CANONICAL REPOSITORY IDENTITY, carried alongside the display name rather than
    -- instead of it. `repo` is the bare name with `owner` deliberately dropped, so two
    -- repositories called `kandev` under different owners would share a key — and the PR
    -- key is what `merged_prs` counts. This store has exactly one repository, so nothing
    -- is currently miscounted; the column is here so that stops being load-bearing.
    p.repository_id                                    AS repository_id,
    p.pr_number                                        AS pr_number,
    -- 'open' | 'closed' | 'merged'. `merged` is the only one that means shipped: GitHub
    -- reports a merged PR as closed too, so a two-value read of this column would score
    -- every merge as an abandonment.
    COALESCE(NULLIF(p.state, ''), '(unrecorded)')      AS pr_state,
    COALESCE(NULLIF(p.review_state, ''), '(none)')     AS review_state,
    COALESCE(NULLIF(p.checks_state, ''), '(none)')     AS checks_state,
    COALESCE(NULLIF(p.mergeable_state, ''), '(none)')  AS mergeable_state,
    COALESCE(NULLIF(p.base_branch, ''), '(none)')      AS base_branch,
    p.review_count                                     AS review_count,
    p.pending_review_count                             AS pending_review_count,
    p.comment_count                                    AS comment_count,
    p.unresolved_review_threads                        AS unresolved_review_threads,
    p.checks_total                                     AS checks_total,
    p.checks_passing                                   AS checks_passing,
    p.additions                                        AS additions,
    p.deletions                                        AS deletions,
    strftime('%Y-%m-%dT%H:%M:%SZ', p.created_at)       AS created_at,
    strftime('%Y-%m-%dT%H:%M:%SZ', p.merged_at)        AS merged_at,
    strftime('%Y-%m-%dT%H:%M:%SZ', p.closed_at)        AS closed_at
FROM github_task_prs p;


-- ---------------------------------------------------------------------------
-- fct_git_snapshot — one row per git status snapshot. CODE OUTPUT OVER TIME.
--
-- Output tokens measure how much a model SAID. This measures how much code it left behind,
-- which is a different number and the one worth dividing money by.
--
-- READ `branch_additions`, NOT THE WORKING-TREE DIFF. The `files` blob is the UNCOMMITTED
-- diff at that instant, so it rises while work is in progress and collapses the moment it
-- is committed — three consecutive snapshots of the same 1,356 uncommitted lines are one
-- piece of work, not three, and once committed they read as zero. `metadata.branch_additions`
-- is the cumulative diffstat of the whole branch against its base and climbs monotonically
-- (3365 -> 4220 -> 4809 -> 5634 -> 5949 on one measured session), which is what makes a
-- per-step delta meaningful. The uncommitted figures are still carried, as work-in-flight —
-- never as output.
--
-- REDACTION (see the header). `files[].diff` IS THE ACTUAL SOURCE CODE and is never
-- selected — this extract does not enter the blob at all except to COUNT its entries and
-- sum two integers out of it. `branch` is not selected either: a session's working branch is
-- routinely a slugged card title, which is the description prose arriving by another door,
-- and `head_branch` was dropped from fct_pull_request for the same reason. `metadata` also
-- carries `added`/`modified`/`renamed` path arrays; paths would be permissible, but the
-- per-file grain is not needed for a per-step total and 4,246 exploded rows of it would be
-- carried for nothing.
-- ---------------------------------------------------------------------------
.output data/fct_git_snapshot.csv
SELECT
    g.id                                              AS snapshot_id,
    g.session_id                                      AS session_id,
    strftime('%Y-%m-%dT%H:%M:%SZ', g.created_at)      AS created_at,
    g.snapshot_type                                   AS snapshot_type,
    -- Commits ahead of the base branch. The other monotonic output signal, and the one that
    -- survives a squash where a line count does not.
    g.ahead                                           AS commits_ahead,
    g.behind                                          AS commits_behind,
    -- THE SCALE THE OTHER TWO NUMBERS ARE MEASURED AGAINST, and the reason it is extracted:
    -- `ahead` and `branch_additions` are both counted against this commit, so when it moves
    -- the two readings either side are on different scales and their difference is not work.
    -- One measured session re-based from d6ad48ff to 2b4a44b7 and jumped 0 -> 8,263 commits
    -- and 553 -> 440,971 lines in 35 minutes; without this column that arrives downstream as
    -- 77% of all code the store has ever produced.
    substr(g.base_commit, 1, 12)                      AS base_commit,
    json_extract(g.metadata, '$.branch_additions')    AS branch_additions,
    json_extract(g.metadata, '$.branch_deletions')    AS branch_deletions,
    -- Work in flight at this instant: how much is sitting uncommitted. Never summed as
    -- output downstream — a large figure here is unlanded work, which is a risk signal.
    (SELECT COUNT(*) FROM json_each(g.files))         AS dirty_files,
    (SELECT COALESCE(SUM(json_extract(v.value, '$.additions')), 0)
       FROM json_each(g.files) v)                     AS uncommitted_additions,
    (SELECT COALESCE(SUM(json_extract(v.value, '$.deletions')), 0)
       FROM json_each(g.files) v)                     AS uncommitted_deletions
FROM task_session_git_snapshots g;


-- ---------------------------------------------------------------------------
-- fct_plan_revision — one row per plan revision. AN EXPLORATORY FEATURE, NOT A METRIC.
--
-- Plans are rewritten as a card is worked, so revision counts are the only thing in this
-- store that moves BEFORE the spend does. That makes them a candidate leading indicator of
-- rework — and a candidate is all it is. Nothing here has been shown to predict anything:
-- coverage is 34 of 73 cards (47%), and a high count may reflect autosave behaviour, card
-- duration, or which agent profile was in force rather than churn. Build a metric on it only
-- after it predicts a defined outcome on data collected later than this snapshot.
--
-- REDACTION. `content` is the plan body and is NEVER selected. `title` is NOT selected
-- either, which is less obvious: it looks like metadata but is prose in practice — 88
-- distinct values across 465 rows, reading like "Spec pointer — task external ID (create
-- idempotency) — READY TO BUILD". A column whitelist is a whitelist of SHAPES, not of
-- names, and a title that carries a sentence is a description arriving by another door.
--
-- `revert_of_revision_id` is carried as a FLAG rather than the id: nothing populates it in
-- this store (0 of 465), and a flag is what the analysis wants if that ever changes.
-- ---------------------------------------------------------------------------
.output data/fct_plan_revision.csv
SELECT
    r.id                                              AS revision_id,
    r.task_id                                         AS task_id,
    r.revision_number                                 AS revision_number,
    -- 'agent' | 'user' — the only two values, and the one distinction that matters here:
    -- a plan the operator rewrote is not the same signal as a plan the agent rewrote.
    r.author_kind                                     AS author_kind,
    -- An agent profile name ('2acc - Sonnet') or 'User'. Same shape as `agent_profile`
    -- elsewhere in this extract; no personal names occur.
    COALESCE(NULLIF(r.author_name, ''), '(unrecorded)') AS author_name,
    CASE WHEN COALESCE(r.revert_of_revision_id, '') <> '' THEN 'yes' ELSE 'no' END AS is_revert,
    strftime('%Y-%m-%dT%H:%M:%SZ', r.created_at)      AS created_at
FROM task_plan_revisions r;


-- ---------------------------------------------------------------------------
-- _manifest — provenance. Every figure a dashboard shows is as of this snapshot.
-- ---------------------------------------------------------------------------
.output data/_manifest.csv
SELECT
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')             AS extracted_at_utc,
    (SELECT COUNT(*) FROM tasks)                      AS n_tasks,
    (SELECT COUNT(*) FROM task_sessions)              AS n_sessions,
    (SELECT COUNT(*) FROM task_session_turns)         AS n_turns,
    (SELECT COUNT(*) FROM office_cost_events)         AS n_cost_events,
    (SELECT COUNT(*) FROM task_session_messages)      AS n_messages,
    (SELECT COUNT(*) FROM workspaces)                 AS n_workspaces,
    (SELECT COUNT(*) FROM session_step_history)       AS n_step_history_rows,
    (SELECT COUNT(*) FROM workflow_step_decisions)    AS n_step_decision_rows,
    -- Outcome coverage, published as provenance because every cost-per-outcome figure is a
    -- ratio over these two: a PR count far below the card count is the reason a merged-PR
    -- total will not reconcile against total spend.
    (SELECT COUNT(*) FROM github_task_prs)            AS n_pull_requests,
    (SELECT COUNT(*) FROM github_task_prs WHERE state = 'merged') AS n_merged_pull_requests;

.output stdout
