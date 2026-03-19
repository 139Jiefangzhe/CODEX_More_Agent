from __future__ import annotations

import unittest
from datetime import datetime
from unittest import mock

from westcity_sync import westcity_pool_sync


def make_source_event(
    *,
    source_event_id: str = "evt-1",
    session_id: str = "plate:京A12345",
    event_type: str = "00",
    event_time: str = "2026-03-18T10:00:00+08:00",
    auth_type: str = "temporary",
    vehicle_group: str = "report-first",
) -> westcity_pool_sync.SourceEvent:
    return westcity_pool_sync.SourceEvent(
        event_id=f"hash-{source_event_id}",
        source_event_id=source_event_id,
        park_id="PARK-001",
        session_id=session_id,
        plate="京A12345",
        event_type=event_type,
        event_time=datetime.fromisoformat(event_time),
        auth_type=auth_type,
        vehicle_group=vehicle_group,
        raw_payload={
            "pk_trip_real_id": source_event_id,
            "park_id": "PARK-001",
            "type": event_type,
            "trip_id": "",
            "order_id": "",
            "plate": "京A12345",
            "auth_type": auth_type,
            "time": event_time,
        },
    )


class ScriptedCursor:
    def __init__(self, script: list[dict[str, object]], executed: list[tuple[str, object]], strict: bool = True):
        self.script = script
        self.executed = executed
        self.rowcount = 0
        self._fetchone = None
        self._fetchall = None
        self.strict = strict

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if not self.script:
            if self.strict:
                raise AssertionError(f"unexpected SQL: {sql}")
            self.rowcount = 0
            self._fetchone = None
            self._fetchall = None
            return

        step = self.script.pop(0)
        expected = step.get("match")
        if expected and str(expected) not in sql:
            raise AssertionError(f"expected SQL containing {expected!r}, got: {sql}")
        error = step.get("raise")
        if error is not None:
            raise error
        self.rowcount = int(step.get("rowcount", 0))
        self._fetchone = step.get("fetchone")
        self._fetchall = step.get("fetchall")

    def fetchone(self):
        return self._fetchone

    def fetchall(self):
        return self._fetchall


class ScriptedConnection:
    def __init__(self, script: list[dict[str, object]], *, strict: bool = True):
        self.script = list(script)
        self.strict = strict
        self.executed: list[tuple[str, object]] = []
        self.commit_count = 0
        self.rollback_count = 0

    def cursor(self):
        return ScriptedCursor(self.script, self.executed, strict=self.strict)

    def commit(self):
        self.commit_count += 1

    def rollback(self):
        self.rollback_count += 1


class FakeRedisPipeline:
    def __init__(self, responses=None):
        self.commands: list[tuple[str, tuple[object, ...]]] = []
        self.responses = list(responses or [])

    def setex(self, *args):
        self.commands.append(("setex", args))
        return self

    def get(self, *args):
        self.commands.append(("get", args))
        return self

    def execute(self):
        return list(self.responses)


class FakeRedis:
    def __init__(self, responses=None):
        self.pipeline_instance = FakeRedisPipeline(responses)

    def pipeline(self, transaction=True):
        self.transaction = transaction
        return self.pipeline_instance


class WestcityPoolSyncTests(unittest.TestCase):
    def setUp(self):
        self.pool_config = westcity_pool_sync.PoolRuntimeConfig(
            report_capacity=268,
            physical_capacity=420,
            hidden_capacity=152,
            hidden_auth_types=frozenset({"monthly", "staff"}),
            batch_size=200,
            max_events=5000,
            counter_ttl_seconds=7776000,
            lookback_seconds=604800,
            push_replay_limit=20,
            lock_timeout_seconds=1,
        )

    def test_parse_bool_treats_empty_string_as_default(self):
        self.assertFalse(westcity_pool_sync.parse_bool("", default=False))
        self.assertTrue(westcity_pool_sync.parse_bool("", default=True))

    def test_resolve_session_id_prefers_plate(self):
        row = {
            "pk_trip_real_id": "event-1",
            "plate": "京A12345",
            "trip_id": "trip-100",
            "order_id": "order-200",
        }
        self.assertEqual(westcity_pool_sync.resolve_session_id(row), "plate:京A12345")

    def test_resolve_session_id_falls_back_to_order_id(self):
        row = {
            "pk_trip_real_id": "event-1",
            "plate": "",
            "trip_id": "",
            "order_id": "order-200",
        }
        self.assertEqual(westcity_pool_sync.resolve_session_id(row), "order:order-200")

    def test_resolve_session_id_falls_back_to_source_event(self):
        row = {
            "pk_trip_real_id": "event-1",
            "plate": "",
            "trip_id": "",
            "order_id": "",
        }
        self.assertEqual(westcity_pool_sync.resolve_session_id(row), "event:event-1")

    def test_classify_vehicle_group(self):
        hidden_auth_types = frozenset({"monthly", "staff"})
        self.assertEqual(
            westcity_pool_sync.classify_vehicle_group("monthly", hidden_auth_types),
            "hidden-first",
        )
        self.assertEqual(
            westcity_pool_sync.classify_vehicle_group("temporary", hidden_auth_types),
            "report-first",
        )

    def test_choose_pool_hidden_first(self):
        self.assertEqual(
            westcity_pool_sync.choose_pool(
                vehicle_group="hidden-first",
                report_inside=10,
                hidden_inside=30,
                report_capacity=268,
                hidden_capacity=152,
            ),
            "hidden",
        )
        self.assertEqual(
            westcity_pool_sync.choose_pool(
                vehicle_group="hidden-first",
                report_inside=10,
                hidden_inside=152,
                report_capacity=268,
                hidden_capacity=152,
            ),
            "report",
        )

    def test_choose_pool_report_first(self):
        self.assertEqual(
            westcity_pool_sync.choose_pool(
                vehicle_group="report-first",
                report_inside=120,
                hidden_inside=20,
                report_capacity=268,
                hidden_capacity=152,
            ),
            "report",
        )
        self.assertEqual(
            westcity_pool_sync.choose_pool(
                vehicle_group="report-first",
                report_inside=268,
                hidden_inside=20,
                report_capacity=268,
                hidden_capacity=152,
            ),
            "hidden",
        )

    def test_choose_pool_returns_none_when_full(self):
        self.assertIsNone(
            westcity_pool_sync.choose_pool(
                vehicle_group="report-first",
                report_inside=268,
                hidden_inside=152,
                report_capacity=268,
                hidden_capacity=152,
            )
        )

    def test_build_pool_snapshot_clamps_freeberth(self):
        snapshot = westcity_pool_sync.build_pool_snapshot(
            as_of=datetime.fromisoformat("2026-03-18T10:00:00+08:00"),
            report_inside=300,
            hidden_inside=10,
            in_count=100,
            out_count=80,
            report_capacity=268,
        )
        self.assertEqual(snapshot.freeberth, 0)
        self.assertEqual(snapshot.counter_day, "20260318")
        self.assertEqual(snapshot.as_payload()["in"], 100)

    def test_load_pool_runtime_config_requires_physical_capacity(self):
        env = {
            "WESTCITY_POOL_BATCH_SIZE": "100",
            "WESTCITY_POOL_MAX_EVENTS": "1000",
        }
        with self.assertRaises(westcity_pool_sync.ConfigurationError):
            westcity_pool_sync.load_pool_runtime_config(
                env,
                report_capacity=268,
                batch_size_override=None,
                max_events_override=None,
            )

    def test_load_pool_runtime_config(self):
        env = {
            "WESTCITY_PHYSICAL_CAPACITY": "420",
            "WESTCITY_HIDDEN_AUTH_TYPES": "monthly,staff",
            "WESTCITY_POOL_BATCH_SIZE": "150",
            "WESTCITY_POOL_MAX_EVENTS": "900",
            "WESTCITY_POOL_LOOKBACK_SECONDS": "7200",
            "WESTCITY_POOL_PUSH_REPLAY_LIMIT": "10",
            "WESTCITY_POOL_LOCK_TIMEOUT_SECONDS": "2",
        }
        config = westcity_pool_sync.load_pool_runtime_config(
            env,
            report_capacity=268,
            batch_size_override=None,
            max_events_override=None,
        )
        self.assertEqual(config.report_capacity, 268)
        self.assertEqual(config.physical_capacity, 420)
        self.assertEqual(config.hidden_capacity, 152)
        self.assertIn("monthly", config.hidden_auth_types)
        self.assertEqual(config.batch_size, 150)
        self.assertEqual(config.max_events, 900)
        self.assertEqual(config.lookback_seconds, 7200)
        self.assertEqual(config.push_replay_limit, 10)
        self.assertEqual(config.lock_timeout_seconds, 2)

    def test_fetch_source_events_uses_lookback_and_failed_filter(self):
        connection = ScriptedConnection(
            [
                {
                    "match": "LEFT JOIN wc_pool_event_log",
                    "fetchall": [
                        {
                            "pk_trip_real_id": "1001",
                            "park_id": "PARK-001",
                            "type": "00",
                            "trip_id": "",
                            "order_id": "",
                            "plate": "京A12345",
                            "auth_type": "temporary",
                            "time": datetime.fromisoformat("2026-03-18T10:00:00"),
                        }
                    ],
                }
            ]
        )
        checkpoint = westcity_pool_sync.Checkpoint(
            last_event_time=datetime.fromisoformat("2026-03-18T09:30:00"),
            last_event_id="999",
        )

        events = westcity_pool_sync.fetch_source_events(
            connection,
            westcity_pool_sync.DatabaseConfig(  # nosec B106 - fake database password for tests
                host="127.0.0.1",
                port=3306,
                user="root",
                password="secret",  # nosec B106 - fake database password for tests
                database="parking",
                charset="utf8mb4",
                table_name="cp_order_trip_real_record",
                source_park_id="PARK-001",
            ),
            "PARK-001",
            checkpoint,
            as_of=datetime.fromisoformat("2026-03-18T10:30:00+08:00"),
            limit=50,
            hidden_auth_types=frozenset({"monthly"}),
            lookback_seconds=3600,
            mysql_timezone="Asia/Shanghai",
        )

        self.assertEqual(len(events), 1)
        sql, params = connection.executed[0]
        self.assertIn("LEFT JOIN wc_pool_event_log", sql)
        self.assertIn("log.processed_status = 'failed'", sql)
        self.assertIn("CASE WHEN src.type = '00' THEN 0", sql)
        self.assertEqual(params[2], datetime.fromisoformat("2026-03-18T08:30:00"))

    def test_process_source_event_marks_failure_after_rollback(self):
        connection = ScriptedConnection(
            [
                {"match": "INSERT IGNORE INTO wc_pool_event_log", "rowcount": 1},
                {
                    "match": "SELECT report_inside, hidden_inside, report_capacity, hidden_capacity",
                    "fetchone": {
                        "report_inside": 10,
                        "hidden_inside": 5,
                        "report_capacity": 268,
                        "hidden_capacity": 152,
                    },
                },
                {"match": "SELECT allocation_id, pool_type", "fetchone": None},
                {"match": "SELECT event_id", "fetchone": None},
                {"match": "UPDATE wc_pool_state", "raise": RuntimeError("boom")},
                {"match": "INSERT INTO wc_pool_event_log", "rowcount": 1},
                {"match": "UPDATE wc_pool_checkpoint", "rowcount": 1},
            ]
        )

        with mock.patch.object(westcity_pool_sync.LOGGER, "exception"):
            status, assigned_pool = westcity_pool_sync.process_source_event(
                connection,
                "PARK-001",
                make_source_event(),
                self.pool_config,
            )

        self.assertEqual(status, "failed")
        self.assertIsNone(assigned_pool)
        self.assertEqual(connection.rollback_count, 1)
        self.assertEqual(connection.commit_count, 1)
        self.assertTrue(
            any("processed_status, error_message" in sql for sql, _ in connection.executed),
            "failed event should be persisted with an error message",
        )

    def test_process_source_event_returns_overflow_entry_when_capacity_is_full(self):
        connection = ScriptedConnection(
            [
                {"match": "INSERT IGNORE INTO wc_pool_event_log", "rowcount": 1},
                {
                    "match": "SELECT report_inside, hidden_inside, report_capacity, hidden_capacity",
                    "fetchone": {
                        "report_inside": 268,
                        "hidden_inside": 152,
                        "report_capacity": 268,
                        "hidden_capacity": 152,
                    },
                },
                {"match": "SELECT allocation_id, pool_type", "fetchone": None},
                {"match": "SELECT event_id", "fetchone": None},
                {"match": "UPDATE wc_pool_event_log", "rowcount": 1},
                {"match": "UPDATE wc_pool_checkpoint", "rowcount": 1},
            ]
        )

        status, assigned_pool = westcity_pool_sync.process_source_event(
            connection,
            "PARK-001",
            make_source_event(),
            self.pool_config,
        )

        self.assertEqual(status, "overflow_entry")
        self.assertIsNone(assigned_pool)
        self.assertEqual(connection.commit_count, 1)
        self.assertFalse(
            any("INSERT INTO wc_pool_allocation" in sql for sql, _ in connection.executed),
            "overflow entries must not create inside allocations",
        )

    def test_sync_snapshot_to_redis_uses_pipeline_and_ttl(self):
        redis_client = FakeRedis()
        redis_config = westcity_pool_sync.RedisConfig(
            host="127.0.0.1",
            port=6379,
            db=0,
            password=None,
            use_ssl=False,
            key_prefix="wc:pool",
        )
        snapshot = westcity_pool_sync.build_pool_snapshot(
            as_of=datetime.fromisoformat("2026-03-18T10:00:00+08:00"),
            report_inside=10,
            hidden_inside=2,
            in_count=5,
            out_count=4,
            report_capacity=268,
        )

        westcity_pool_sync.sync_snapshot_to_redis(
            redis_client,
            redis_config,
            "PARK-001",
            snapshot,
            counter_ttl_seconds=7776000,
        )

        self.assertTrue(redis_client.transaction)
        self.assertEqual(len(redis_client.pipeline_instance.commands), 4)
        self.assertTrue(
            all(command[0] == "setex" for command in redis_client.pipeline_instance.commands),
            "all redis writes should go through setex with ttl",
        )

    def test_read_snapshot_from_redis_returns_fallback_when_any_key_missing(self):
        redis_client = FakeRedis(responses=["10", None, "5", "4"])
        redis_config = westcity_pool_sync.RedisConfig(
            host="127.0.0.1",
            port=6379,
            db=0,
            password=None,
            use_ssl=False,
            key_prefix="wc:pool",
        )
        fallback = westcity_pool_sync.build_pool_snapshot(
            as_of=datetime.fromisoformat("2026-03-18T10:00:00+08:00"),
            report_inside=11,
            hidden_inside=3,
            in_count=5,
            out_count=4,
            report_capacity=268,
        )

        snapshot = westcity_pool_sync.read_snapshot_from_redis(
            redis_client,
            redis_config,
            "PARK-001",
            as_of=datetime.fromisoformat("2026-03-18T10:00:00+08:00"),
            report_capacity=268,
            fallback=fallback,
        )

        self.assertEqual(snapshot.report_inside, fallback.report_inside)
        self.assertEqual(snapshot.hidden_inside, fallback.hidden_inside)


if __name__ == "__main__":
    unittest.main()
