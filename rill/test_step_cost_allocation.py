"""Offline regression of the shipped SQL; requires duckdb + PyYAML (not live Rill)."""
import unittest
from pathlib import Path

import duckdb
import yaml

ROOT = Path(__file__).resolve().parent


class StepCostAllocationTests(unittest.TestCase):
    def setUp(self):
        self.db = duckdb.connect()
        self.db.execute("""
            CREATE TABLE src_fct_cost_event (
              cost_event_id VARCHAR, occurred_at TIMESTAMP, session_id VARCHAR,
              task_id VARCHAR, turn_id VARCHAR, model VARCHAR, provider VARCHAR,
              agent_profile VARCHAR, token_basis VARCHAR, tokens_in BIGINT,
              tokens_cached_in BIGINT, tokens_out BIGINT, cost_subcents BIGINT);
            CREATE TABLE src_fct_turn (turn_id VARCHAR, step_at_start VARCHAR);
            CREATE TABLE src_dim_session (
              session_id VARCHAR, session_started_at TIMESTAMP, agent_profile VARCHAR,
              repository VARCHAR, base_branch VARCHAR, session_state VARCHAR, review_status VARCHAR);
            CREATE TABLE src_dim_task (
              task_id VARCHAR, workspace VARCHAR, workflow VARCHAR, current_step VARCHAR,
              stage_type VARCHAR, task_title VARCHAR, task_state VARCHAR, priority VARCHAR,
              origin VARCHAR, autopilot_enabled VARCHAR, is_child_task VARCHAR);
            CREATE TABLE dim_model_family (model VARCHAR, model_family VARCHAR);
            CREATE TABLE kandev_step_points (session_id VARCHAR, step VARCHAR, effective_from TIMESTAMP);
            CREATE TABLE src_fct_message (message_id VARCHAR, session_id VARCHAR, created_at TIMESTAMP);
            INSERT INTO src_dim_session (session_id, session_started_at) VALUES
              ('recovered', '2026-10-26 00:00'), ('mixed', '2026-10-26 00:00'),
              ('unknown', '2026-10-26 00:00');
            INSERT INTO src_fct_turn VALUES ('recovery-turn', 'Create MR');
            INSERT INTO kandev_step_points VALUES
              ('recovered', 'Review', '2026-10-26 00:01'),
              ('mixed', 'Build', '2026-10-26 00:01'),
              ('mixed', 'Review', '2026-10-26 00:03');
            INSERT INTO src_fct_message VALUES
              ('old-review-work', 'recovered', '2026-10-26 00:09'),
              ('m1', 'mixed', '2026-10-26 00:02'),
              ('m2', 'mixed', '2026-10-26 00:03:30'),
              ('m3', 'mixed', '2026-10-26 00:03:40');
            INSERT INTO src_fct_cost_event VALUES
              ('flush', '2026-10-26 00:10', 'recovered', 'card', 'recovery-turn',
               'opus', 'anthropic', 'Deep', 'metered', 1, 100, 1, 500),
              ('mixed-window', '2026-10-26 00:04', 'mixed', 'card', '',
               'opus', 'anthropic', 'Deep', 'metered', 1, 100, 1, 300),
              ('unattributed', '2026-10-26 00:04', 'unknown', 'card', '',
               'opus', 'anthropic', 'Deep', 'metered', 1, 100, 1, 200);
        """)
        sql = yaml.safe_load((ROOT / 'models/kandev_cost.yaml').read_text())['sql']
        self.db.execute('CREATE VIEW actual AS ' + sql)

    def tearDown(self):
        self.db.close()

    def test_recovered_review_flush_is_board_observation_not_verified_mr_work(self):
        row = self.db.execute("""SELECT step_at_event, step_attribution_basis,
            step_observation, work_step_verification, cost_subcents
            FROM actual WHERE cost_event_id = 'flush'""").fetchone()
        self.assertEqual(row, ('Create MR', 'turn stamp',
                              'board position observed at turn start', 'unverified', 500))

    def test_mixed_window_retains_inferred_label_and_money(self):
        row = self.db.execute("""SELECT step_at_event, step_attribution_basis,
            step_observation, work_step_verification, cost_subcents
            FROM actual WHERE cost_event_id = 'mixed-window'""").fetchone()
        self.assertEqual(row, ('Review', 'dominant of 2 steps in window',
                              'session-window allocation inferred', 'unverified', 300))

    def test_total_and_event_grain_are_preserved_including_unknown(self):
        self.assertEqual(self.db.execute('SELECT count(*), sum(cost_subcents) FROM actual').fetchone(), (3, 1000))
        self.assertEqual(self.db.execute("SELECT step_attributed, work_step_verification FROM actual WHERE cost_event_id='unattributed'").fetchone(), ('no', 'unverified'))
        self.assertEqual(self.db.execute("SELECT count(*) FROM actual WHERE work_step_verification <> 'unverified'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT sum(cost_subcents) FILTER (WHERE step_attribution_basis='turn stamp') FROM actual").fetchone()[0], 500)


if __name__ == '__main__':
    unittest.main()
