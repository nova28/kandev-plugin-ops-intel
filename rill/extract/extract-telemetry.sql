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

-- THREE KEYS, IN ORDER OF HOW MUCH THEY KNOW. extract.sh hands over session_attribution.csv, one
-- id-only row per Claude session built by extract_requests.py and persisted across runs (the
-- transcripts it is derived from are deleted after 30 days; the state is not).
--
--   1. acp         Kandev's own record of the agent's session id (task_sessions.metadata). It names
--                  the card by identity, so it overrides the directory: an outside review on
--                  2026-09-17 found 32 sessions in worktrees shared by two cards billed to the wrong
--                  one by the path rules.
--   2. cwd         the collector's directory, resolved through v_workspace above. Unchanged.
--   3. transcript  sessions with telemetry but no usable `sessions` row. The collector did not sync
--                  ~/.claude-kandev from 2026-09-01 to 2026-09-17, and a view driven from `sessions`
--                  dropped those sessions and their cost outright. The label is 'task_worktree' only
--                  when EVERY request resolved to one card inside its worktree; a session that also
--                  ran elsewhere is 'mixed' and not counted as Kandev work, because its cost cannot
--                  be split at this grain.
--
-- NOT EXISTS, never NOT IN: `sessions.session_id` is a nullable TEXT PRIMARY KEY, and a single
-- NULL would make every NOT IN test NULL and drop branch 3 without a word.
.import --csv --schema temp session_attribution.csv attribution

CREATE TEMP TABLE v_session AS
SELECT
    a.session_id,
    NULLIF(a.task_id, '')                                                 AS task_id,
    CAST(a.kandev_task_count AS INTEGER)                                  AS kandev_task_count,
    a.workspace_kind,
    CAST(a.is_kandev_task AS INTEGER)                                     AS is_kandev_task,
    'acp'                                                                 AS attribution_source
FROM temp.attribution a
WHERE a.attribution_source = 'acp'
UNION ALL
SELECT
    s.session_id,
    w.task_id                                                             AS task_id,
    COALESCE(w.task_count, 0)                                             AS kandev_task_count,
    COALESCE(w.workspace_kind, 'none')                                    AS workspace_kind,
    CASE WHEN w.workspace_kind = 'task_worktree' THEN 1 ELSE 0 END        AS is_kandev_task,
    'cwd'                                                                 AS attribution_source
FROM sessions s
LEFT JOIN v_workspace w ON w.workspace_path = s.cwd
WHERE s.cwd LIKE '/%'
  AND s.session_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM temp.attribution a
                  WHERE a.session_id = s.session_id AND a.attribution_source = 'acp')
UNION ALL
SELECT
    a.session_id,
    NULLIF(a.task_id, '')                                                 AS task_id,
    CAST(a.kandev_task_count AS INTEGER)                                  AS kandev_task_count,
    a.workspace_kind,
    CAST(a.is_kandev_task AS INTEGER)                                     AS is_kandev_task,
    'transcript'                                                          AS attribution_source
FROM temp.attribution a
WHERE a.attribution_source <> 'acp'
  AND NOT EXISTS (SELECT 1 FROM sessions s
                  WHERE s.session_id = a.session_id AND s.cwd LIKE '/%');
CREATE INDEX temp.v_session_id ON v_session(session_id);

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
                   THEN m.value ELSE 0 END), 2)                              AS active_time_seconds,
    s.attribution_source
FROM v_session s
JOIN metrics m ON m.session_id = s.session_id
GROUP BY s.session_id, s.task_id, s.kandev_task_count, s.workspace_kind, s.is_kandev_task,
         s.attribution_source;

-- ---------------------------------------------------------------------------
-- fct_agent_session_day: the same cost, dated by when it was SPENT.
--
-- fct_agent_session carries one lifetime total per session, and the dashboard's timeseries is
-- the session's last_date — so a session that ran Sunday to Tuesday put all its cost in the week
-- it ended. On 2026-09-17 that moved ISO W36 from $16,406 (by metric date) to $15,717 (by end
-- date). The metric rows are deltas with their own date, so summing per (session, date) gives the
-- exact daily split; per-session totals still reconcile (check.sh asserts it).
-- ---------------------------------------------------------------------------
.once data/fct_agent_session_day.csv
SELECT
    s.session_id,
    m.date,
    s.task_id,
    s.workspace_kind,
    s.is_kandev_task,
    ROUND(SUM(m.value), 6)                                                   AS cost_usd,
    ROUND(SUM(CASE WHEN json_extract(m.extra,'$.query_source.stringValue')='main'
                   THEN m.value ELSE 0 END), 6)                              AS cost_usd_main,
    ROUND(SUM(CASE WHEN json_extract(m.extra,'$.query_source.stringValue')='subagent'
                   THEN m.value ELSE 0 END), 6)                              AS cost_usd_subagent,
    s.attribution_source
FROM v_session s
JOIN metrics m ON m.session_id = s.session_id AND m.metric_name = 'claude_code.cost.usage'
GROUP BY s.session_id, m.date, s.task_id, s.workspace_kind, s.is_kandev_task, s.attribution_source;

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
    MAX(e.date)   AS last_date,
    s.attribution_source
FROM v_session s
JOIN events e ON e.session_id = s.session_id
WHERE e.event_name IN (
    'tool_result', 'tool_decision', 'api_request', 'api_error', 'api_refusal',
    'api_retries_exhausted', 'compaction', 'skill_activated', 'subagent_completed',
    'mcp_server_connection', 'user_prompt', 'assistant_response',
    'permission_mode_changed', 'internal_error'
)
GROUP BY s.session_id, s.task_id, s.kandev_task_count, s.workspace_kind, s.is_kandev_task, e.event_name,
         s.attribution_source;

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
    sp.status_code,
    s.attribution_source
FROM spans sp
LEFT JOIN v_session s ON s.session_id = sp.session_id;
