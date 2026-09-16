-- Claude Code agent telemetry -> flat CSV, for the Rill project two directories up.
--
-- SECOND SOURCE, SEPARATE STORE. `extract.sql` reads Kandev's own SQLite and owns the
-- orchestration facts (cards, steps, transitions, cost events). This file reads the
-- claude-telemetry-collector store (~/Library/Application Support/claude-telemetry/metrics.db),
-- which holds what the AGENT saw rather than what Kandev recorded: per-query-source cost,
-- cache token split, compaction, skill activation, tool errors, subagent completion.
--
-- THE SAME REDACTION RULE APPLIES, and it has more work to do here. The collector stores
-- `user.email`, `user.account_uuid` and `organization.id` on every metric row, and event
-- bodies can carry free text. Neither leaves this file: the rule is still a column
-- whitelist of identifiers, timestamps, numbers and low-cardinality enums.
--
--   * `events.body` is NEVER selected. It is the event payload and carries prose.
--   * `metrics.extra` / `events.extra` are read ONLY through json_extract of named,
--     enumerable keys (query_source, effort, type). The blobs themselves never ship.
--   * `account_uuid`, `user.email`, `organization.id` are NEVER selected.
--
-- PRE-AGGREGATED ON PURPOSE, unlike extract.sql. Kandev's store is 3.6 GB and its extract is
-- a full row-level re-derive; this store is 5.7 GB across 1.6M metric and 3.6M event rows, and
-- shipping those as CSV every refresh would dominate the refresh budget for data whose only
-- consumer is a per-session rollup. One row per agent session is the grain that joins to a
-- Kandev card, so that is the grain that leaves.
--
-- THE PATH IS RESOLVED HERE AND NEVER SHIPPED. `sessions.cwd` is the only thing linking an
-- agent session to a Kandev card, but a task worktree path is `~/.kandev/tasks/<slug>_<id>/`
-- and that slug is derived from the card's TITLE — it is prose, and prose does not leave.
-- `dim_session` already made this call and exports only `has_workspace_path`. So this file
-- ATTACHes the Kandev snapshot extract.sh has already taken, resolves cwd -> task_id and
-- session_id there, and emits the identifiers alone. Nothing downstream ever sees a path.
--
-- THE KEY IS ONLY SOMETIMES A PATH. The collector registers a
-- session two ways: `sync_sessions()` reads ~/.claude/sessions and records the real working
-- directory, but `upsert_session_from_otlp()` — the path taken when telemetry arrives for a
-- session the sync has not seen — writes `cwd = terminal.type` ("iTerm.app", "xterm-256color",
-- "unknown"). Those rows are not locations and must never reach a join against Kandev's
-- `task_sessions.workspace_path`. The `cwd LIKE '/%'` filter below is that guard; without it
-- a terminal name silently becomes a workspace that matches nothing, and the resulting miss
-- looks like missing telemetry rather than a bad key.
--
-- COLUMN NAMES MIRROR OPENLIT'S `coding_agent.session.*` ROLLUP where an equivalent exists
-- (tool_call_count, subagent_count, edit accept/reject counts), so the two vocabularies stay
-- comparable. Kandev supplies commit and PR counts from its own records rather than from
-- OpenLIT's approach of parsing `git commit` out of shell stdout.

.bail on
.mode csv
.headers on

-- ---------------------------------------------------------------------------
-- Sessions that are real locations. Everything downstream joins through this.
-- ---------------------------------------------------------------------------
-- extract.sh has already written snapshot.db beside us and cd'd into $WORK.
ATTACH 'snapshot.db' AS k;

-- A WORKSPACE PATH IS NOT A KEY, AND JOINING ON IT DIRECTLY DOUBLE-COUNTS MONEY.
-- Kandev reuses a task's worktree across every session that runs in it: measured on the
-- 2026-09-14 snapshot, 254 of 1106 distinct workspace paths carry more than one
-- task_session and the worst carries 40. A plain
--   LEFT JOIN task_sessions ks ON ks.workspace_path = s.cwd
-- therefore emits one row per (agent session x Kandev session) pair, which took 2223 agent
-- sessions to 10893 rows and multiplied every cost figure by ~4.9. The grain of this file is
-- one row per AGENT session, so the Kandev side must be collapsed to one row per path BEFORE
-- it is joined, not after.
--
-- 20 of those paths carry more than one distinct TASK (sibling subtasks sharing a checkout),
-- so a path does not always identify a card either. Rather than pick an arbitrary winner,
-- task_id is NULL when the path is ambiguous and `kandev_task_count` says why — an
-- unattributable session is visibly unattributed instead of being billed to whichever task
-- sorted first.
-- NOT EVERY MATCH IS EVIDENCE. A task worktree under ~/.kandev/tasks/ belongs to Kandev and
-- nothing else runs there, so a cwd match is proof. But 55 of the 1106 matched paths are LIVE
-- CHECKOUTS — Kandev's Local executor runs in the repository you also work in by hand — and
-- those directories accumulate interactive sessions that have nothing to do with any card.
-- Matching on them alone moved the Kandev-attributed total from $13.2K to $24.0K, and the
-- difference is mostly human work being billed to the orchestrator.
--
-- `workspace_kind` carries that distinction as a low-cardinality enum, which is what the
-- whitelist permits; the path itself still never leaves. Downstream, filter to
-- workspace_kind = 'task_worktree' for anything that claims to measure Kandev, and treat
-- 'shared_checkout' as "ran somewhere Kandev also runs", which is a weaker claim.
CREATE TEMP VIEW v_workspace AS
SELECT
    ks.workspace_path                                                     AS workspace_path,
    COUNT(DISTINCT ks.task_id)                                            AS task_count,
    CASE WHEN COUNT(DISTINCT ks.task_id) = 1
         THEN MIN(ks.task_id) END                                         AS task_id,
    CASE WHEN ks.workspace_path LIKE '%/.kandev/tasks/%'
         THEN 'task_worktree' ELSE 'shared_checkout' END                  AS workspace_kind
FROM k.task_sessions ks
WHERE ks.workspace_path <> ''
GROUP BY ks.workspace_path;

CREATE TEMP VIEW v_session AS
SELECT
    s.session_id,
    w.task_id                                                             AS task_id,
    COALESCE(w.task_count, 0)                                             AS kandev_task_count,
    COALESCE(w.workspace_kind, 'none')                                    AS workspace_kind,
    CASE WHEN w.workspace_kind = 'task_worktree' THEN 1 ELSE 0 END        AS is_kandev_task
FROM sessions s
LEFT JOIN v_workspace w ON w.workspace_path = s.cwd
WHERE s.cwd LIKE '/%';

-- ---------------------------------------------------------------------------
-- fct_agent_session: one row per Claude Code session.
--
-- `value` on cost.usage is USD and on token.usage is a token count; both are OTel
-- cumulative counters, so SUM over the delta records the collector stores is the session
-- total. query_source splits the bill three ways — main loop, subagent, auxiliary — which is
-- the axis Kandev's own usage events cannot express at all.
-- ---------------------------------------------------------------------------
.once data/fct_agent_session.csv
SELECT
    s.session_id,
    s.task_id,
    s.kandev_task_count,
    s.workspace_kind,
    s.is_kandev_task,
    MIN(m.date)                                                              AS first_date,
    MAX(m.date)                                                              AS last_date,
    -- DAY GRANULARITY IS NOT ENOUGH TO LOCATE SPEND. A card crosses several steps in a day,
    -- and this project already attributes Kandev's own cost to a step by window ownership
    -- (see kandev_card_steps). Doing the same for agent sessions needs the session's actual
    -- span, not the day it fell in — without these two columns every agent measure can only
    -- be reported against `current_step`, which is where the card sits NOW and was Done for
    -- 634 of 838 Kandev sessions on the 2026-09-14 extract.
    MIN(m.timestamp_ns)                                                      AS first_ts_ns,
    MAX(m.timestamp_ns)                                                      AS last_ts_ns,
    ROUND(SUM(CASE WHEN m.metric_name='claude_code.cost.usage'
                   THEN m.value ELSE 0 END), 6)                              AS cost_usd,
    ROUND(SUM(CASE WHEN m.metric_name='claude_code.cost.usage'
              AND json_extract(m.extra,'$.query_source.stringValue')='main'
                   THEN m.value ELSE 0 END), 6)                              AS cost_usd_main,
    ROUND(SUM(CASE WHEN m.metric_name='claude_code.cost.usage'
              AND json_extract(m.extra,'$.query_source.stringValue')='subagent'
                   THEN m.value ELSE 0 END), 6)                              AS cost_usd_subagent,
    ROUND(SUM(CASE WHEN m.metric_name='claude_code.cost.usage'
              AND json_extract(m.extra,'$.query_source.stringValue')='auxiliary'
                   THEN m.value ELSE 0 END), 6)                              AS cost_usd_auxiliary,
    CAST(SUM(CASE WHEN m.metric_name='claude_code.token.usage'
              AND json_extract(m.extra,'$.type.stringValue')='input'
                   THEN m.value ELSE 0 END) AS INTEGER)                      AS tokens_input,
    CAST(SUM(CASE WHEN m.metric_name='claude_code.token.usage'
              AND json_extract(m.extra,'$.type.stringValue')='output'
                   THEN m.value ELSE 0 END) AS INTEGER)                      AS tokens_output,
    CAST(SUM(CASE WHEN m.metric_name='claude_code.token.usage'
              AND json_extract(m.extra,'$.type.stringValue')='cacheRead'
                   THEN m.value ELSE 0 END) AS INTEGER)                      AS tokens_cache_read,
    CAST(SUM(CASE WHEN m.metric_name='claude_code.token.usage'
              AND json_extract(m.extra,'$.type.stringValue')='cacheCreation'
                   THEN m.value ELSE 0 END) AS INTEGER)                      AS tokens_cache_creation,
    CAST(SUM(CASE WHEN m.metric_name='claude_code.lines_of_code.count'
                   THEN m.value ELSE 0 END) AS INTEGER)                      AS lines_of_code,
    ROUND(SUM(CASE WHEN m.metric_name='claude_code.active_time.total'
                   THEN m.value ELSE 0 END), 2)                              AS active_time_seconds
FROM v_session s
JOIN metrics m ON m.session_id = s.session_id
GROUP BY s.session_id, s.task_id, s.kandev_task_count, s.workspace_kind, s.is_kandev_task;

-- ---------------------------------------------------------------------------
-- fct_agent_session_event: per-session counts of the event types that describe
-- how a run BEHAVED rather than what it cost.
--
-- `compaction` and `skill_activated` are here because they are the only context/memory
-- signals Claude Code emits over OTel at all — nothing reports context-window utilisation,
-- so a compaction is the sole observable evidence that the window filled.
-- ---------------------------------------------------------------------------
.once data/fct_agent_session_event.csv
SELECT
    s.session_id,
    s.task_id,
    s.kandev_task_count,
    s.workspace_kind,
    s.is_kandev_task,
    e.event_name,
    COUNT(*)      AS event_count,
    MIN(e.date)   AS first_date,
    MAX(e.date)   AS last_date
FROM v_session s
JOIN events e ON e.session_id = s.session_id
WHERE e.event_name IN (
    'tool_result', 'tool_decision', 'api_request', 'api_error', 'api_refusal',
    'api_retries_exhausted', 'compaction', 'skill_activated', 'subagent_completed',
    'mcp_server_connection', 'user_prompt', 'assistant_response',
    'permission_mode_changed', 'internal_error'
)
GROUP BY s.session_id, s.task_id, s.kandev_task_count, s.workspace_kind, s.is_kandev_task, e.event_name;

-- ---------------------------------------------------------------------------
-- fct_agent_span: the trace tier.
--
-- Empty until CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 and OTEL_TRACES_EXPORTER=otlp have been
-- set AND the agent processes carrying them have restarted — agent environment freezes at
-- spawn, so already-running sessions never start emitting. Exported anyway rather than
-- conditionally, so the Rill model exists and simply reports zero instead of failing
-- reconcile on a missing file the day tracing is switched on.
--
-- duration_ms on `claude_code.tool.blocked_on_user` is the measure with no equivalent
-- anywhere else in this project: time an agent spent waiting on a human.
-- ---------------------------------------------------------------------------
.once data/fct_agent_span.csv
SELECT
    sp.span_id,
    sp.trace_id,
    sp.parent_span_id,
    sp.name                AS span_name,
    sp.date,
    sp.duration_ms,
    sp.session_id,
    s.task_id,
    s.kandev_task_count,
    s.workspace_kind,
    s.is_kandev_task,
    sp.model,
    sp.tool_name,
    sp.status_code
FROM spans sp
LEFT JOIN v_session s ON s.session_id = sp.session_id;
