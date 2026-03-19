from __future__ import annotations

import io
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

from westcity_sync import westcity_operations_simulator


def make_event(
    *,
    source_event_id: str,
    session_id: str,
    event_type: str,
    event_time: str,
    auth_type: str = "temporary",
    vehicle_group: str = "report-first",
) -> westcity_operations_simulator.SimulatedEvent:
    return westcity_operations_simulator.SimulatedEvent(
        source_event_id=source_event_id,
        park_id="SIM_PARK",
        session_id=session_id,
        plate="TEST00001",
        event_type=event_type,
        event_time=datetime.fromisoformat(event_time),
        auth_type=auth_type,
        vehicle_group=vehicle_group,
    )


class WestcityOperationsSimulatorTests(unittest.TestCase):
    def test_generate_simulated_events_is_sorted_and_deterministic(self):
        config = westcity_operations_simulator.SimulationConfig(
            park_id="SIM_PARK",
            seed=123,
            car_count=8,
            duration_minutes=90,
            exit_rate=100,
            hidden_ratio=50,
            min_dwell_minutes=10,
            max_dwell_minutes=30,
        )
        as_of = datetime.fromisoformat("2026-03-18T10:00:00+08:00")

        first = westcity_operations_simulator.generate_simulated_events(
            simulation_config=config,
            as_of=as_of,
            hidden_auth_types=frozenset({"monthly"}),
        )
        second = westcity_operations_simulator.generate_simulated_events(
            simulation_config=config,
            as_of=as_of,
            hidden_auth_types=frozenset({"monthly"}),
        )

        self.assertEqual([event.as_dict() for event in first], [event.as_dict() for event in second])
        self.assertTrue(all(first[index].event_time <= first[index + 1].event_time for index in range(len(first) - 1)))
        self.assertEqual(sum(1 for event in first if event.event_type == "00"), 8)
        self.assertGreaterEqual(sum(1 for event in first if event.event_type == "01"), 1)

    def test_replay_simulated_events_respects_logical_pool_accounting(self):
        events = [
            make_event(
                source_event_id="SIM-IN-1",
                session_id="sim:1",
                event_type="00",
                event_time="2026-03-18T08:00:00+08:00",
                auth_type="monthly",
                vehicle_group="hidden-first",
            ),
            make_event(
                source_event_id="SIM-IN-2",
                session_id="sim:2",
                event_type="00",
                event_time="2026-03-18T08:01:00+08:00",
            ),
            make_event(
                source_event_id="SIM-OUT-2",
                session_id="sim:2",
                event_type="01",
                event_time="2026-03-18T08:30:00+08:00",
            ),
        ]

        result = westcity_operations_simulator.replay_simulated_events(
            events,
            as_of=datetime.fromisoformat("2026-03-18T10:00:00+08:00"),
            report_capacity=1,
            hidden_capacity=5,
        )

        snapshot = result["snapshot"]
        self.assertEqual(snapshot.report_inside, 0)
        self.assertEqual(snapshot.hidden_inside, 1)
        self.assertEqual(snapshot.in_count, 1)
        self.assertEqual(snapshot.out_count, 1)
        self.assertEqual(snapshot.freeberth, 1)
        self.assertEqual(result["pool_counter"]["hidden_entries"], 1)
        self.assertEqual(result["pool_counter"]["report_entries"], 1)
        self.assertEqual(result["pool_counter"]["report_exits"], 1)

    def test_replay_simulated_events_marks_overflow_entries_without_inflating_inside(self):
        events = [
            make_event(
                source_event_id="SIM-IN-1",
                session_id="sim:1",
                event_type="00",
                event_time="2026-03-18T08:00:00+08:00",
            ),
            make_event(
                source_event_id="SIM-IN-2",
                session_id="sim:2",
                event_type="00",
                event_time="2026-03-18T08:01:00+08:00",
            ),
        ]

        result = westcity_operations_simulator.replay_simulated_events(
            events,
            as_of=datetime.fromisoformat("2026-03-18T10:00:00+08:00"),
            report_capacity=1,
            hidden_capacity=0,
        )

        snapshot = result["snapshot"]
        self.assertEqual(snapshot.report_inside, 1)
        self.assertEqual(result["status_counter"]["overflow_entry"], 1)

    def test_main_dry_run_writes_output_file(self):
        env_lines = [
            "WESTCITY_BASE_URL=https://datahub.renniting.cn/apis/v1",
            "WESTCITY_APP_KEY=test-app-key",
            "WESTCITY_APP_SECRET=test-app-secret",
            "WESTCITY_DATA_KEY=aes-test-key-001",
            "WESTCITY_APP_UUID=test-app-uuid",
            "WESTCITY_MAX_FREE_BERTH=268",
            "WESTCITY_PHYSICAL_CAPACITY=420",
            "WESTCITY_HIDDEN_AUTH_TYPES=monthly",
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            env_file = Path(tmpdir) / ".env"
            output_file = Path(tmpdir) / "simulation.json"
            env_file.write_text("\n".join(env_lines), encoding="utf-8")

            stdout = io.StringIO()
            with mock.patch("sys.stdout", stdout):
                exit_code = westcity_operations_simulator.main(
                    [
                        "--env-file",
                        str(env_file),
                        "--as-of",
                        "2026-03-18T10:00:00+08:00",
                        "--car-count",
                        "12",
                        "--duration-minutes",
                        "60",
                        "--seed",
                        "7",
                        "--output",
                        str(output_file),
                    ]
                )

            self.assertEqual(exit_code, 0)
            printed = json.loads(stdout.getvalue())
            self.assertEqual(printed["push"]["reason"], "dry-run")
            self.assertEqual(printed["generated"]["entry_count"], 12)
            self.assertEqual(printed["output_file"], str(output_file))

            stored = json.loads(output_file.read_text(encoding="utf-8"))
            self.assertIn("events", stored)
            self.assertGreaterEqual(len(stored["events"]), 12)
            self.assertEqual(stored["snapshot"]["freeberth"], printed["snapshot"]["freeberth"])


if __name__ == "__main__":
    unittest.main()
