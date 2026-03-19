from __future__ import annotations

import argparse
import json
import os
import random
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .westcity_db_push import (
    ConfigurationError,
    SUPPORTED_SIG_METHODS,
    WestcityConfig,
    build_signed_url,
    hydrate_environment,
    load_timeout_seconds,
    normalize_base_url,
    parse_as_of,
    parse_positive_int,
    post_operations,
    redact_signed_url,
    require_non_empty,
)
from .westcity_pool_sync import (
    build_pool_snapshot,
    choose_pool,
    classify_vehicle_group,
    load_pool_runtime_config,
)
from .logging_utils import configure_logging


DEFAULT_SIM_SEED = 20260318
DEFAULT_SIM_CAR_COUNT = 160
DEFAULT_SIM_DURATION_MINUTES = 180
DEFAULT_SIM_EXIT_RATE = 75
DEFAULT_SIM_HIDDEN_RATIO = 20
DEFAULT_SIM_MIN_DWELL_MINUTES = 15
DEFAULT_SIM_MAX_DWELL_MINUTES = 240
DEFAULT_SIM_PARK_ID = "SIM_PARK"
DEFAULT_HIDDEN_AUTH_TYPES = ("monthly",)
DEFAULT_REPORT_AUTH_TYPES = ("temporary", "visitor", "scan")


@dataclass(frozen=True)
class SimulatedEvent:
    source_event_id: str
    park_id: str
    session_id: str
    plate: str
    event_type: str
    event_time: datetime
    auth_type: str
    vehicle_group: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "source_event_id": self.source_event_id,
            "park_id": self.park_id,
            "session_id": self.session_id,
            "plate": self.plate,
            "event_type": self.event_type,
            "event_time": self.event_time.isoformat(),
            "auth_type": self.auth_type,
            "vehicle_group": self.vehicle_group,
        }


@dataclass(frozen=True)
class SimulationConfig:
    park_id: str
    seed: int
    car_count: int
    duration_minutes: int
    exit_rate: int
    hidden_ratio: int
    min_dwell_minutes: int
    max_dwell_minutes: int


def parse_ratio(value: int, name: str) -> int:
    if value < 0 or value > 100:
        raise ConfigurationError(f"{name} must be between 0 and 100")
    return value


def load_westcity_config(env: dict[str, str]) -> WestcityConfig:
    sig_method = env.get("WESTCITY_SIG_METHOD", "HMAC-SHA1").strip() or "HMAC-SHA1"
    if sig_method not in SUPPORTED_SIG_METHODS:
        raise ConfigurationError("WESTCITY_SIG_METHOD must be HMAC-SHA1 or HMAC-SHA256")

    return WestcityConfig(
        base_url=normalize_base_url(env.get("WESTCITY_BASE_URL")),
        app_key=require_non_empty(env, "WESTCITY_APP_KEY"),
        app_secret=require_non_empty(env, "WESTCITY_APP_SECRET"),
        data_key=require_non_empty(env, "WESTCITY_DATA_KEY"),
        app_uuid=require_non_empty(env, "WESTCITY_APP_UUID"),
        sig_method=sig_method,
        timeout_seconds=load_timeout_seconds(env),
        retry_count=parse_positive_int(
            env.get("WESTCITY_RETRY_COUNT", "1"),
            "WESTCITY_RETRY_COUNT",
            minimum=0,
            maximum=5,
        ),
        max_free_berth=parse_positive_int(
            require_non_empty(env, "WESTCITY_MAX_FREE_BERTH"),
            "WESTCITY_MAX_FREE_BERTH",
            minimum=0,
            maximum=1_000_000,
        ),
    )


def build_simulation_config(args: argparse.Namespace, env: dict[str, str]) -> SimulationConfig:
    park_id = (args.park_id or env.get("WESTCITY_SOURCE_PARK_ID") or DEFAULT_SIM_PARK_ID).strip()
    if not park_id:
        raise ConfigurationError("park_id must not be empty")

    car_count = parse_positive_int(str(args.car_count), "car_count", minimum=1, maximum=20_000)
    duration_minutes = parse_positive_int(
        str(args.duration_minutes),
        "duration_minutes",
        minimum=1,
        maximum=7 * 24 * 60,
    )
    min_dwell_minutes = parse_positive_int(
        str(args.min_dwell_minutes),
        "min_dwell_minutes",
        minimum=1,
        maximum=7 * 24 * 60,
    )
    max_dwell_minutes = parse_positive_int(
        str(args.max_dwell_minutes),
        "max_dwell_minutes",
        minimum=min_dwell_minutes,
        maximum=7 * 24 * 60,
    )

    return SimulationConfig(
        park_id=park_id,
        seed=parse_positive_int(str(args.seed), "seed", minimum=0, maximum=2**31 - 1),
        car_count=car_count,
        duration_minutes=duration_minutes,
        exit_rate=parse_ratio(args.exit_rate, "exit_rate"),
        hidden_ratio=parse_ratio(args.hidden_ratio, "hidden_ratio"),
        min_dwell_minutes=min_dwell_minutes,
        max_dwell_minutes=max_dwell_minutes,
    )


def generate_simulated_events(
    *,
    simulation_config: SimulationConfig,
    as_of: datetime,
    hidden_auth_types: frozenset[str],
) -> list[SimulatedEvent]:
    rng = random.Random(simulation_config.seed)
    events: list[SimulatedEvent] = []
    start_at = as_of - timedelta(minutes=simulation_config.duration_minutes)
    duration_seconds = max(int((as_of - start_at).total_seconds()), 1)
    hidden_candidates = tuple(hidden_auth_types or DEFAULT_HIDDEN_AUTH_TYPES)

    for index in range(simulation_config.car_count):
        session_id = f"sim:{index:05d}"
        plate = f"TEST{index:05d}"
        entry_offset_seconds = rng.randint(0, duration_seconds - 1)
        entry_time = start_at + timedelta(seconds=entry_offset_seconds)
        auth_type = (
            rng.choice(hidden_candidates)
            if rng.randint(1, 100) <= simulation_config.hidden_ratio
            else rng.choice(DEFAULT_REPORT_AUTH_TYPES)
        )
        vehicle_group = classify_vehicle_group(auth_type, hidden_auth_types)
        events.append(
            SimulatedEvent(
                source_event_id=f"SIM-IN-{index:05d}",
                park_id=simulation_config.park_id,
                session_id=session_id,
                plate=plate,
                event_type="00",
                event_time=entry_time,
                auth_type=auth_type,
                vehicle_group=vehicle_group,
            )
        )

        remaining_seconds = max(int((as_of - entry_time).total_seconds()), 0)
        if remaining_seconds < simulation_config.min_dwell_minutes * 60:
            continue
        if rng.randint(1, 100) > simulation_config.exit_rate:
            continue

        max_dwell_seconds = min(simulation_config.max_dwell_minutes * 60, remaining_seconds)
        min_dwell_seconds = simulation_config.min_dwell_minutes * 60
        if max_dwell_seconds < min_dwell_seconds:
            continue

        dwell_seconds = rng.randint(min_dwell_seconds, max_dwell_seconds)
        exit_time = entry_time + timedelta(seconds=dwell_seconds)
        events.append(
            SimulatedEvent(
                source_event_id=f"SIM-OUT-{index:05d}",
                park_id=simulation_config.park_id,
                session_id=session_id,
                plate=plate,
                event_type="01",
                event_time=exit_time,
                auth_type=auth_type,
                vehicle_group=vehicle_group,
            )
        )

    events.sort(key=lambda event: (event.event_time, event.source_event_id))
    return events


def replay_simulated_events(
    events: list[SimulatedEvent],
    *,
    as_of: datetime,
    report_capacity: int,
    hidden_capacity: int,
) -> dict[str, Any]:
    report_inside = 0
    hidden_inside = 0
    report_in = 0
    report_out = 0
    active_allocations: dict[str, str] = {}
    status_counter: dict[str, int] = {}
    pool_counter = {
        "report_entries": 0,
        "hidden_entries": 0,
        "report_exits": 0,
        "hidden_exits": 0,
        "orphan_exits": 0,
    }
    processed_events: list[dict[str, Any]] = []

    for event in events:
        assigned_pool: str | None = None
        status = "skipped"

        if event.event_type == "00":
            if event.session_id in active_allocations:
                assigned_pool = active_allocations[event.session_id]
                status = "duplicate"
            else:
                assigned_pool = choose_pool(
                    vehicle_group=event.vehicle_group,
                    report_inside=report_inside,
                    hidden_inside=hidden_inside,
                    report_capacity=report_capacity,
                    hidden_capacity=hidden_capacity,
                )
                if assigned_pool == "report":
                    active_allocations[event.session_id] = assigned_pool
                    report_inside += 1
                    report_in += 1
                    pool_counter["report_entries"] += 1
                    status = "applied"
                elif assigned_pool == "hidden":
                    active_allocations[event.session_id] = assigned_pool
                    hidden_inside += 1
                    pool_counter["hidden_entries"] += 1
                    status = "applied"
                else:
                    status = "overflow_entry"
        elif event.event_type == "01":
            assigned_pool = active_allocations.get(event.session_id)
            if assigned_pool is None:
                pool_counter["orphan_exits"] += 1
                status = "orphan_exit"
            else:
                del active_allocations[event.session_id]
                if assigned_pool == "report":
                    report_inside = max(report_inside - 1, 0)
                    report_out += 1
                    pool_counter["report_exits"] += 1
                else:
                    hidden_inside = max(hidden_inside - 1, 0)
                    pool_counter["hidden_exits"] += 1
                status = "applied"

        status_counter[status] = status_counter.get(status, 0) + 1
        processed_events.append(
            {
                **event.as_dict(),
                "status": status,
                "assigned_pool": assigned_pool,
            }
        )

    snapshot = build_pool_snapshot(
        as_of=as_of,
        report_inside=report_inside,
        hidden_inside=hidden_inside,
        in_count=report_in,
        out_count=report_out,
        report_capacity=report_capacity,
    )

    return {
        "snapshot": snapshot,
        "status_counter": status_counter,
        "pool_counter": pool_counter,
        "processed_events": processed_events,
    }


def maybe_write_output(path_value: str | None, payload: dict[str, Any]) -> str | None:
    if not path_value:
        return None

    output_path = Path(path_value).expanduser()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(output_path)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate simulated parking events and optionally test-push Westcity operations data."
    )
    parser.add_argument("--env-file", help="Optional .env file path.")
    parser.add_argument("--as-of", help="Simulation end time in ISO 8601 format. Defaults to now.")
    parser.add_argument("--timezone", default="Asia/Shanghai", help="Timezone for --as-of.")
    parser.add_argument("--park-id", help="Simulation label for the source park. Defaults to WESTCITY_SOURCE_PARK_ID.")
    parser.add_argument("--car-count", type=int, default=DEFAULT_SIM_CAR_COUNT, help="Unique simulated sessions.")
    parser.add_argument(
        "--duration-minutes",
        type=int,
        default=DEFAULT_SIM_DURATION_MINUTES,
        help="Spread entries across the previous N minutes.",
    )
    parser.add_argument(
        "--exit-rate",
        type=int,
        default=DEFAULT_SIM_EXIT_RATE,
        help="Percentage of cars that leave before as-of.",
    )
    parser.add_argument(
        "--hidden-ratio",
        type=int,
        default=DEFAULT_SIM_HIDDEN_RATIO,
        help="Percentage of cars marked as hidden-first auth types.",
    )
    parser.add_argument(
        "--min-dwell-minutes",
        type=int,
        default=DEFAULT_SIM_MIN_DWELL_MINUTES,
        help="Minimum stay duration for generated exits.",
    )
    parser.add_argument(
        "--max-dwell-minutes",
        type=int,
        default=DEFAULT_SIM_MAX_DWELL_MINUTES,
        help="Maximum stay duration for generated exits.",
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SIM_SEED, help="Random seed for deterministic output.")
    parser.add_argument("--output", help="Optional JSON file path to store full simulation details.")
    parser.add_argument(
        "--preview-events",
        type=int,
        default=10,
        help="How many processed events to include in stdout JSON preview.",
    )
    parser.add_argument(
        "--push",
        action="store_true",
        help="Actually send the final operations snapshot to Westcity. Default is dry-run only.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    args = build_argument_parser().parse_args(argv)

    try:
        env = hydrate_environment(os.environ, explicit_env_file=args.env_file)
        westcity_config = load_westcity_config(env)
        as_of = parse_as_of(args.as_of, args.timezone)
        simulation_config = build_simulation_config(args, env)
        pool_config = load_pool_runtime_config(
            env,
            report_capacity=westcity_config.max_free_berth,
            batch_size_override=None,
            max_events_override=None,
        )

        events = generate_simulated_events(
            simulation_config=simulation_config,
            as_of=as_of,
            hidden_auth_types=pool_config.hidden_auth_types,
        )
        replay_result = replay_simulated_events(
            events,
            as_of=as_of,
            report_capacity=pool_config.report_capacity,
            hidden_capacity=pool_config.hidden_capacity,
        )
        snapshot = replay_result["snapshot"]
        output_payload = {
            "mode": "simulated-operations",
            "park_id": simulation_config.park_id,
            "seed": simulation_config.seed,
            "simulation": asdict(simulation_config),
            "capacity": {
                "report_capacity": pool_config.report_capacity,
                "physical_capacity": pool_config.physical_capacity,
                "hidden_capacity": pool_config.hidden_capacity,
            },
            "generated": {
                "event_count": len(events),
                "entry_count": sum(1 for event in events if event.event_type == "00"),
                "exit_count": sum(1 for event in events if event.event_type == "01"),
            },
            "status_counter": replay_result["status_counter"],
            "pool_counter": replay_result["pool_counter"],
            "snapshot": {
                "counter_day": snapshot.counter_day,
                "report_inside": snapshot.report_inside,
                "hidden_inside": snapshot.hidden_inside,
                **snapshot.as_payload(),
            },
            "events_preview": replay_result["processed_events"][: max(args.preview_events, 0)],
        }

        request_url = redact_signed_url(
            build_signed_url(
                westcity_config,
                f"/parkings/{westcity_config.app_key}/operations",
                timestamp=snapshot.dotime,
                req_uuid="simulator",
            )
        )

        if args.push:
            response = post_operations(westcity_config, snapshot.as_payload())
            output_payload["push"] = response
        else:
            output_payload["push"] = {
                "skipped": True,
                "reason": "dry-run",
                "request": {
                    "url": request_url,
                    "content_type": "application/x-www-form-urlencoded",
                },
            }

        output_payload["output_file"] = maybe_write_output(
            args.output,
            {
                **output_payload,
                "events": replay_result["processed_events"],
            },
        )
        print(json.dumps(output_payload, ensure_ascii=False, indent=2))
        return 0
    except ConfigurationError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except Exception as exc:  # nosec B110 - CLI wrapper for operational diagnostics
        print(f"unexpected error: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
