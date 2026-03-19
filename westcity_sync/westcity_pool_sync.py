from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from .westcity_db_push import (
    ConfigurationError,
    DatabaseConfig,
    WestcityConfig,
    WestcityRequestError,
    build_signed_url,
    connect_mysql as open_mysql_connection,
    hydrate_environment,
    load_configs,
    load_mysql_timezone,
    parse_as_of,
    parse_positive_int,
    post_operations,
    redact_signed_url,
    require_non_empty,
    to_mysql_naive,
)
from .logging_utils import configure_logging


DEFAULT_POOL_BATCH_SIZE = 200
DEFAULT_POOL_MAX_EVENTS = 5_000
DEFAULT_POOL_KEY_PREFIX = "wc:pool"
DEFAULT_COUNTER_TTL_SECONDS = 90 * 24 * 3600
DEFAULT_EVENT_LOOKBACK_SECONDS = 7 * 24 * 3600
DEFAULT_PUSH_REPLAY_LIMIT = 20
DEFAULT_LOCK_TIMEOUT_SECONDS = 1
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class RedisConfig:
    host: str
    port: int
    db: int
    password: str | None
    use_ssl: bool
    key_prefix: str


@dataclass(frozen=True)
class PoolRuntimeConfig:
    report_capacity: int
    physical_capacity: int
    hidden_capacity: int
    hidden_auth_types: frozenset[str]
    batch_size: int
    max_events: int
    counter_ttl_seconds: int
    lookback_seconds: int
    push_replay_limit: int
    lock_timeout_seconds: int


@dataclass(frozen=True)
class SourceEvent:
    event_id: str
    source_event_id: str
    park_id: str
    session_id: str
    plate: str | None
    event_type: str
    event_time: datetime
    auth_type: str
    vehicle_group: str
    raw_payload: dict[str, Any]


@dataclass(frozen=True)
class PoolSnapshot:
    dotime: int
    counter_day: str
    report_inside: int
    hidden_inside: int
    in_count: int
    out_count: int
    freeberth: int

    def as_payload(self) -> dict[str, int]:
        return {
            "dotime": self.dotime,
            "freeberth": self.freeberth,
            "in": self.in_count,
            "out": self.out_count,
        }


@dataclass(frozen=True)
class Checkpoint:
    last_event_time: datetime
    last_event_id: str


def parse_bool(value: str | None, *, default: bool = False) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized == "":
        return default
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigurationError(f"invalid boolean value: {value}")


def parse_auth_type_set(value: str | None) -> frozenset[str]:
    if not value:
        return frozenset()
    return frozenset(item.strip() for item in value.split(",") if item.strip())


def resolve_session_id(row: dict[str, Any]) -> str:
    plate = str(row.get("plate") or "").strip()
    if plate:
        return f"plate:{plate}"

    trip_id = str(row.get("trip_id") or "").strip()
    if trip_id:
        return f"trip:{trip_id}"

    order_id = str(row.get("order_id") or "").strip()
    if order_id:
        return f"order:{order_id}"

    return f"event:{row['pk_trip_real_id']}"


def classify_vehicle_group(auth_type: str, hidden_auth_types: frozenset[str]) -> str:
    return "hidden-first" if auth_type in hidden_auth_types else "report-first"


def choose_pool(
    *,
    vehicle_group: str,
    report_inside: int,
    hidden_inside: int,
    report_capacity: int,
    hidden_capacity: int,
) -> str | None:
    report_remaining = report_capacity - report_inside
    hidden_remaining = hidden_capacity - hidden_inside

    if vehicle_group == "hidden-first":
        if hidden_remaining > 0:
            return "hidden"
        if report_remaining > 0:
            return "report"
        return None

    if report_remaining > 0:
        return "report"
    if hidden_remaining > 0:
        return "hidden"
    return None


def build_pool_snapshot(
    *,
    as_of: datetime,
    report_inside: int,
    hidden_inside: int,
    in_count: int,
    out_count: int,
    report_capacity: int,
) -> PoolSnapshot:
    for value, name in (
        (report_inside, "report_inside"),
        (hidden_inside, "hidden_inside"),
        (in_count, "in_count"),
        (out_count, "out_count"),
        (report_capacity, "report_capacity"),
    ):
        if value < 0:
            raise ValueError(f"{name} must not be negative")

    freeberth = report_capacity - report_inside
    if freeberth < 0:
        freeberth = 0
    if freeberth > report_capacity:
        freeberth = report_capacity

    return PoolSnapshot(
        dotime=int(as_of.timestamp()),
        counter_day=as_of.strftime("%Y%m%d"),
        report_inside=report_inside,
        hidden_inside=hidden_inside,
        in_count=in_count,
        out_count=out_count,
        freeberth=freeberth,
    )


def load_pool_runtime_config(
    env: dict[str, str],
    *,
    report_capacity: int,
    batch_size_override: int | None,
    max_events_override: int | None,
) -> PoolRuntimeConfig:
    physical_capacity = parse_positive_int(
        require_non_empty(env, "WESTCITY_PHYSICAL_CAPACITY"),
        "WESTCITY_PHYSICAL_CAPACITY",
        minimum=report_capacity,
        maximum=1_000_000,
    )
    hidden_capacity = physical_capacity - report_capacity

    batch_size = batch_size_override or parse_positive_int(
        env.get("WESTCITY_POOL_BATCH_SIZE", str(DEFAULT_POOL_BATCH_SIZE)),
        "WESTCITY_POOL_BATCH_SIZE",
        minimum=1,
        maximum=10_000,
    )
    max_events = max_events_override or parse_positive_int(
        env.get("WESTCITY_POOL_MAX_EVENTS", str(DEFAULT_POOL_MAX_EVENTS)),
        "WESTCITY_POOL_MAX_EVENTS",
        minimum=1,
        maximum=200_000,
    )

    return PoolRuntimeConfig(
        report_capacity=report_capacity,
        physical_capacity=physical_capacity,
        hidden_capacity=hidden_capacity,
        hidden_auth_types=parse_auth_type_set(env.get("WESTCITY_HIDDEN_AUTH_TYPES")),
        batch_size=batch_size,
        max_events=max_events,
        counter_ttl_seconds=parse_positive_int(
            env.get("WESTCITY_POOL_COUNTER_TTL_SECONDS", str(DEFAULT_COUNTER_TTL_SECONDS)),
            "WESTCITY_POOL_COUNTER_TTL_SECONDS",
            minimum=3600,
            maximum=365 * 24 * 3600,
        ),
        lookback_seconds=parse_positive_int(
            env.get("WESTCITY_POOL_LOOKBACK_SECONDS", str(DEFAULT_EVENT_LOOKBACK_SECONDS)),
            "WESTCITY_POOL_LOOKBACK_SECONDS",
            minimum=60,
            maximum=30 * 24 * 3600,
        ),
        push_replay_limit=parse_positive_int(
            env.get("WESTCITY_POOL_PUSH_REPLAY_LIMIT", str(DEFAULT_PUSH_REPLAY_LIMIT)),
            "WESTCITY_POOL_PUSH_REPLAY_LIMIT",
            minimum=1,
            maximum=500,
        ),
        lock_timeout_seconds=parse_positive_int(
            env.get("WESTCITY_POOL_LOCK_TIMEOUT_SECONDS", str(DEFAULT_LOCK_TIMEOUT_SECONDS)),
            "WESTCITY_POOL_LOCK_TIMEOUT_SECONDS",
            minimum=0,
            maximum=60,
        ),
    )


def load_redis_config(env: dict[str, str]) -> RedisConfig:
    return RedisConfig(
        host=env.get("REDIS_HOST", "127.0.0.1").strip() or "127.0.0.1",
        port=parse_positive_int(env.get("REDIS_PORT", "6379"), "REDIS_PORT", minimum=1, maximum=65535),
        db=parse_positive_int(env.get("REDIS_DB", "0"), "REDIS_DB", minimum=0, maximum=15),
        password=(env.get("REDIS_PASSWORD") or "").strip() or None,
        use_ssl=parse_bool(env.get("REDIS_SSL"), default=False),
        key_prefix=env.get("WESTCITY_POOL_KEY_PREFIX", DEFAULT_POOL_KEY_PREFIX).strip() or DEFAULT_POOL_KEY_PREFIX,
    )


def connect_mysql(database_config: DatabaseConfig) -> Any:
    return open_mysql_connection(database_config, autocommit=False)


def connect_redis(redis_config: RedisConfig) -> Any:
    try:
        import redis
    except ModuleNotFoundError as exc:
        raise ConfigurationError("redis package is required. Install it with: pip install -r requirements-python.txt") from exc

    client = redis.Redis(
        host=redis_config.host,
        port=redis_config.port,
        db=redis_config.db,
        password=redis_config.password,
        ssl=redis_config.use_ssl,
        decode_responses=True,
        socket_timeout=3,
        socket_connect_timeout=3,
        health_check_interval=30,
    )
    client.ping()
    return client


def redis_key(redis_config: RedisConfig, park_id: str, *parts: str) -> str:
    return ":".join([redis_config.key_prefix, park_id, *parts])


def ensure_runtime_rows(connection: Any, park_id: str, pool_config: PoolRuntimeConfig) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT report_inside, hidden_inside
            FROM wc_pool_state
            WHERE park_id = %s
            FOR UPDATE
            """,
            (park_id,),
        )
        existing = cursor.fetchone()
        if existing is not None:
            if int(existing["report_inside"]) > pool_config.report_capacity:
                raise ConfigurationError(
                    f"report_inside exceeds report_capacity for park_id={park_id}; reconcile state before shrinking capacity"
                )
            if int(existing["hidden_inside"]) > pool_config.hidden_capacity:
                raise ConfigurationError(
                    f"hidden_inside exceeds hidden_capacity for park_id={park_id}; reconcile state before shrinking capacity"
                )
        cursor.execute(
            """
            INSERT INTO wc_pool_state (
              park_id, report_capacity, physical_capacity, hidden_capacity, report_inside, hidden_inside
            )
            VALUES (%s, %s, %s, %s, 0, 0)
            ON DUPLICATE KEY UPDATE
              report_capacity = VALUES(report_capacity),
              physical_capacity = VALUES(physical_capacity),
              hidden_capacity = VALUES(hidden_capacity)
            """,
            (park_id, pool_config.report_capacity, pool_config.physical_capacity, pool_config.hidden_capacity),
        )
        cursor.execute(
            """
            INSERT INTO wc_pool_checkpoint (park_id, last_event_time, last_event_id)
            VALUES (%s, %s, %s)
            ON DUPLICATE KEY UPDATE park_id = park_id
            """,
            (park_id, datetime(1970, 1, 1), ""),
        )
    connection.commit()


def read_checkpoint(connection: Any, park_id: str) -> Checkpoint:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT last_event_time, last_event_id FROM wc_pool_checkpoint WHERE park_id = %s",
            (park_id,),
        )
        row = cursor.fetchone() or {}

    return Checkpoint(
        last_event_time=row.get("last_event_time") or datetime(1970, 1, 1),
        last_event_id=str(row.get("last_event_id") or ""),
    )


def fetch_source_events(
    connection: Any,
    db_config: DatabaseConfig,
    park_id: str,
    checkpoint: Checkpoint,
    *,
    as_of: datetime,
    limit: int,
    hidden_auth_types: frozenset[str],
    lookback_seconds: int,
    mysql_timezone: str,
) -> list[SourceEvent]:
    table_name = db_config.table_name
    as_of_naive = to_mysql_naive(as_of, mysql_timezone)
    lookback_start = checkpoint.last_event_time - timedelta(seconds=lookback_seconds)
    if lookback_start < datetime(1970, 1, 1):
        lookback_start = datetime(1970, 1, 1)
    sql = f"""
        SELECT
          src.pk_trip_real_id,
          src.park_id,
          src.type,
          src.trip_id,
          src.order_id,
          src.plate,
          src.auth_type,
          src.time
        FROM `{table_name}` AS src
        LEFT JOIN wc_pool_event_log AS log
          ON log.park_id = src.park_id
         AND log.source_event_id = CAST(src.pk_trip_real_id AS CHAR)
        WHERE src.park_id = %s
          AND src.time <= %s
          AND src.time >= %s
          AND (src.deleted IS NULL OR src.deleted = 0)
          AND (log.event_id IS NULL OR log.processed_status = 'failed')
        ORDER BY
          src.time ASC,
          CASE WHEN src.type = '00' THEN 0 WHEN src.type = '01' THEN 1 ELSE 2 END ASC,
          src.pk_trip_real_id ASC
        LIMIT %s
    """

    with connection.cursor() as cursor:
        cursor.execute(
            sql,
            (
                park_id,
                as_of_naive,
                lookback_start,
                limit,
            ),
        )
        rows = cursor.fetchall() or []

    events: list[SourceEvent] = []
    for row in rows:
        source_event_id = str(row["pk_trip_real_id"])
        event_id = hashlib.sha256(f"{park_id}:{source_event_id}".encode("utf-8")).hexdigest()
        auth_type = str(row.get("auth_type") or "").strip()
        events.append(
            SourceEvent(
                event_id=event_id,
                source_event_id=source_event_id,
                park_id=park_id,
                session_id=resolve_session_id(row),
                plate=(str(row.get("plate") or "").strip() or None),
                event_type=str(row.get("type") or "").strip(),
                event_time=row["time"],
                auth_type=auth_type,
                vehicle_group=classify_vehicle_group(auth_type, hidden_auth_types),
                raw_payload={
                    "pk_trip_real_id": source_event_id,
                    "park_id": park_id,
                    "type": str(row.get("type") or ""),
                    "trip_id": str(row.get("trip_id") or ""),
                    "order_id": str(row.get("order_id") or ""),
                    "plate": str(row.get("plate") or ""),
                    "auth_type": auth_type,
                    "time": row["time"].isoformat(sep=" "),
                },
            )
        )

    return events


def update_checkpoint(cursor: Any, park_id: str, event_time: datetime, source_event_id: str) -> None:
    cursor.execute(
        """
        UPDATE wc_pool_checkpoint
        SET last_event_time = %s, last_event_id = %s
        WHERE park_id = %s
        """,
        (event_time, source_event_id, park_id),
    )


def bump_daily_counter(cursor: Any, park_id: str, counter_day: str, event_time: datetime, *, in_inc: int = 0, out_inc: int = 0) -> None:
    if in_inc == 0 and out_inc == 0:
        return
    cursor.execute(
        """
        INSERT INTO wc_pool_daily_counter (park_id, counter_day, report_in, report_out, last_event_time)
        VALUES (%s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
          report_in = report_in + VALUES(report_in),
          report_out = report_out + VALUES(report_out),
          last_event_time = GREATEST(COALESCE(last_event_time, VALUES(last_event_time)), VALUES(last_event_time))
        """,
        (park_id, counter_day, in_inc, out_inc, event_time),
    )


def acquire_run_lock(connection: Any, park_id: str, *, timeout_seconds: int) -> bool:
    with connection.cursor() as cursor:
        cursor.execute("SELECT GET_LOCK(%s, %s) AS acquired", (f"westcity_pool_sync:{park_id}", timeout_seconds))
        row = cursor.fetchone() or {}
    return bool(int(row.get("acquired") or 0))


def release_run_lock(connection: Any, park_id: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT RELEASE_LOCK(%s)", (f"westcity_pool_sync:{park_id}",))


def persist_failed_event(connection: Any, park_id: str, event: SourceEvent, error_message: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO wc_pool_event_log (
              event_id, park_id, source_event_id, session_id, event_type, event_time, plate,
              auth_type, vehicle_group, raw_payload, processed_status, error_message
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'failed', %s)
            ON DUPLICATE KEY UPDATE
              session_id = VALUES(session_id),
              event_type = VALUES(event_type),
              event_time = VALUES(event_time),
              plate = VALUES(plate),
              auth_type = VALUES(auth_type),
              vehicle_group = VALUES(vehicle_group),
              raw_payload = VALUES(raw_payload),
              processed_status = 'failed',
              error_message = VALUES(error_message),
              updated_at = NOW()
            """,
            (
                event.event_id,
                park_id,
                event.source_event_id,
                event.session_id,
                event.event_type,
                event.event_time,
                event.plate,
                event.auth_type,
                event.vehicle_group,
                json.dumps(event.raw_payload, ensure_ascii=False),
                error_message[:255],
            ),
        )
        update_checkpoint(cursor, park_id, event.event_time, event.source_event_id)
    connection.commit()


def process_source_event(connection: Any, park_id: str, event: SourceEvent, pool_config: PoolRuntimeConfig) -> tuple[str, str | None]:
    counter_day = event.event_time.strftime("%Y%m%d")
    assigned_pool: str | None = None
    processed_status = "skipped"

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT IGNORE INTO wc_pool_event_log (
                  event_id, park_id, source_event_id, session_id, event_type, event_time, plate,
                  auth_type, vehicle_group, raw_payload, processed_status
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')
                """,
                (
                    event.event_id,
                    park_id,
                    event.source_event_id,
                    event.session_id,
                    event.event_type,
                    event.event_time,
                    event.plate,
                    event.auth_type,
                    event.vehicle_group,
                    json.dumps(event.raw_payload, ensure_ascii=False),
                ),
            )
            if cursor.rowcount == 0:
                cursor.execute(
                    """
                    SELECT processed_status, assigned_pool
                    FROM wc_pool_event_log
                    WHERE event_id = %s
                    FOR UPDATE
                    """,
                    (event.event_id,),
                )
                existing_log = cursor.fetchone() or {}
                existing_status = str(existing_log.get("processed_status") or "")
                if existing_status == "failed":
                    cursor.execute(
                        """
                        UPDATE wc_pool_event_log
                        SET processed_status = 'pending', error_message = NULL, updated_at = NOW()
                        WHERE event_id = %s
                        """,
                        (event.event_id,),
                    )
                else:
                    update_checkpoint(cursor, park_id, event.event_time, event.source_event_id)
                    connection.commit()
                    return "duplicate", str(existing_log.get("assigned_pool") or "") or None

            cursor.execute(
                """
                SELECT report_inside, hidden_inside, report_capacity, hidden_capacity
                FROM wc_pool_state
                WHERE park_id = %s
                FOR UPDATE
                """,
                (park_id,),
            )
            state_row = cursor.fetchone()
            if state_row is None:
                raise RuntimeError(f"missing wc_pool_state row for park_id={park_id}")

            if event.event_type == "00":
                cursor.execute(
                    """
                    SELECT allocation_id, pool_type
                    FROM wc_pool_allocation
                    WHERE park_id = %s
                      AND session_id = %s
                      AND status = 'inside'
                    ORDER BY enter_time DESC, allocation_id DESC
                    LIMIT 1
                    FOR UPDATE
                    """,
                    (park_id, event.session_id),
                )
                existing = cursor.fetchone()
                if existing is not None:
                    assigned_pool = str(existing["pool_type"])
                    processed_status = "duplicate"
                else:
                    cursor.execute(
                        """
                        SELECT event_id
                        FROM wc_pool_event_log
                        WHERE park_id = %s
                          AND session_id = %s
                          AND event_type = '01'
                          AND processed_status = 'orphan_exit'
                          AND event_time >= %s
                        ORDER BY event_time ASC, event_id ASC
                        LIMIT 1
                        FOR UPDATE
                        """,
                        (park_id, event.session_id, event.event_time),
                    )
                    orphan_exit = cursor.fetchone()
                    if orphan_exit is not None:
                        cursor.execute(
                            """
                            UPDATE wc_pool_event_log
                            SET processed_status = 'reconciled_late_pair', updated_at = NOW()
                            WHERE event_id = %s
                            """,
                            (str(orphan_exit["event_id"]),),
                        )
                        processed_status = "reconciled_late_pair"
                    else:
                        assigned_pool = choose_pool(
                            vehicle_group=event.vehicle_group,
                            report_inside=int(state_row["report_inside"]),
                            hidden_inside=int(state_row["hidden_inside"]),
                            report_capacity=int(state_row["report_capacity"]),
                            hidden_capacity=int(state_row["hidden_capacity"]),
                        )
                        if assigned_pool == "report":
                            cursor.execute(
                                """
                                UPDATE wc_pool_state
                                SET report_inside = report_inside + 1, version = version + 1
                                WHERE park_id = %s
                                """,
                                (park_id,),
                            )
                            bump_daily_counter(cursor, park_id, counter_day, event.event_time, in_inc=1, out_inc=0)
                        elif assigned_pool == "hidden":
                            cursor.execute(
                                """
                                UPDATE wc_pool_state
                                SET hidden_inside = hidden_inside + 1, version = version + 1
                                WHERE park_id = %s
                                """,
                                (park_id,),
                            )
                        else:
                            processed_status = "overflow_entry"

                        if assigned_pool in {"report", "hidden"}:
                            cursor.execute(
                                """
                                INSERT INTO wc_pool_allocation (
                                  park_id, session_id, plate, pool_type, vehicle_group, enter_event_id, enter_time, status
                                )
                                VALUES (%s, %s, %s, %s, %s, %s, %s, 'inside')
                                """,
                                (
                                    park_id,
                                    event.session_id,
                                    event.plate,
                                    assigned_pool,
                                    event.vehicle_group,
                                    event.source_event_id,
                                    event.event_time,
                                ),
                            )
                            processed_status = "applied"

            elif event.event_type == "01":
                cursor.execute(
                    """
                    SELECT allocation_id, pool_type
                    FROM wc_pool_allocation
                    WHERE park_id = %s
                      AND session_id = %s
                      AND status = 'inside'
                    ORDER BY enter_time DESC, allocation_id DESC
                    LIMIT 1
                    FOR UPDATE
                    """,
                    (park_id, event.session_id),
                )
                existing = cursor.fetchone()
                if existing is None:
                    processed_status = "orphan_exit"
                else:
                    assigned_pool = str(existing["pool_type"])
                    cursor.execute(
                        """
                        UPDATE wc_pool_allocation
                        SET status = 'out', exit_event_id = %s, exit_time = %s
                        WHERE allocation_id = %s
                        """,
                        (event.source_event_id, event.event_time, int(existing["allocation_id"])),
                    )

                    if assigned_pool == "report":
                        cursor.execute(
                            """
                            UPDATE wc_pool_state
                            SET report_inside = GREATEST(report_inside - 1, 0), version = version + 1
                            WHERE park_id = %s
                            """,
                            (park_id,),
                        )
                        bump_daily_counter(cursor, park_id, counter_day, event.event_time, in_inc=0, out_inc=1)
                    else:
                        cursor.execute(
                            """
                            UPDATE wc_pool_state
                            SET hidden_inside = GREATEST(hidden_inside - 1, 0), version = version + 1
                            WHERE park_id = %s
                            """,
                            (park_id,),
                        )
                    processed_status = "applied"
            else:
                processed_status = "skipped"

            cursor.execute(
                """
                UPDATE wc_pool_event_log
                SET assigned_pool = %s, processed_status = %s, updated_at = NOW()
                WHERE event_id = %s
                """,
                (assigned_pool, processed_status, event.event_id),
            )
            update_checkpoint(cursor, park_id, event.event_time, event.source_event_id)
        connection.commit()
        return processed_status, assigned_pool
    except Exception as exc:
        connection.rollback()
        LOGGER.exception("failed to process source event %s", event.source_event_id)
        persist_failed_event(connection, park_id, event, str(exc))
        return "failed", None


def reconcile_runtime_state(connection: Any, park_id: str, *, as_of: datetime) -> None:
    counter_day = as_of.strftime("%Y%m%d")
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
              COALESCE(SUM(CASE WHEN status = 'inside' AND pool_type = 'report' THEN 1 ELSE 0 END), 0) AS report_inside,
              COALESCE(SUM(CASE WHEN status = 'inside' AND pool_type = 'hidden' THEN 1 ELSE 0 END), 0) AS hidden_inside,
              COALESCE(SUM(CASE WHEN pool_type = 'report' AND DATE_FORMAT(enter_time, '%%Y%%m%%d') = %s THEN 1 ELSE 0 END), 0) AS report_in,
              COALESCE(SUM(CASE WHEN pool_type = 'report' AND status = 'out' AND DATE_FORMAT(exit_time, '%%Y%%m%%d') = %s THEN 1 ELSE 0 END), 0) AS report_out,
              MAX(GREATEST(COALESCE(enter_time, '1970-01-01 00:00:00'), COALESCE(exit_time, '1970-01-01 00:00:00'))) AS last_event_time
            FROM wc_pool_allocation
            WHERE park_id = %s
            """,
            (counter_day, counter_day, park_id),
        )
        aggregate = cursor.fetchone() or {}

        cursor.execute(
            """
            UPDATE wc_pool_state
            SET report_inside = %s,
                hidden_inside = %s,
                version = version + 1
            WHERE park_id = %s
            """,
            (
                int(aggregate.get("report_inside", 0)),
                int(aggregate.get("hidden_inside", 0)),
                park_id,
            ),
        )
        cursor.execute(
            """
            INSERT INTO wc_pool_daily_counter (park_id, counter_day, report_in, report_out, last_event_time)
            VALUES (%s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              report_in = VALUES(report_in),
              report_out = VALUES(report_out),
              last_event_time = VALUES(last_event_time)
            """,
            (
                park_id,
                counter_day,
                int(aggregate.get("report_in", 0)),
                int(aggregate.get("report_out", 0)),
                aggregate.get("last_event_time"),
            ),
        )
    connection.commit()


def read_snapshot_from_mysql(connection: Any, park_id: str, *, as_of: datetime, report_capacity: int) -> PoolSnapshot:
    counter_day = as_of.strftime("%Y%m%d")
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT report_inside, hidden_inside
            FROM wc_pool_state
            WHERE park_id = %s
            """,
            (park_id,),
        )
        state_row = cursor.fetchone() or {"report_inside": 0, "hidden_inside": 0}
        cursor.execute(
            """
            SELECT report_in, report_out
            FROM wc_pool_daily_counter
            WHERE park_id = %s AND counter_day = %s
            """,
            (park_id, counter_day),
        )
        counter_row = cursor.fetchone() or {"report_in": 0, "report_out": 0}

    return build_pool_snapshot(
        as_of=as_of,
        report_inside=int(state_row.get("report_inside", 0)),
        hidden_inside=int(state_row.get("hidden_inside", 0)),
        in_count=int(counter_row.get("report_in", 0)),
        out_count=int(counter_row.get("report_out", 0)),
        report_capacity=report_capacity,
    )


def sync_snapshot_to_redis(
    redis_client: Any,
    redis_config: RedisConfig,
    park_id: str,
    snapshot: PoolSnapshot,
    *,
    counter_ttl_seconds: int,
) -> None:
    pipeline = redis_client.pipeline(transaction=True)
    pipeline.setex(redis_key(redis_config, park_id, "inside", "report"), counter_ttl_seconds, snapshot.report_inside)
    pipeline.setex(redis_key(redis_config, park_id, "inside", "hidden"), counter_ttl_seconds, snapshot.hidden_inside)
    pipeline.setex(
        redis_key(redis_config, park_id, "counter", snapshot.counter_day, "report_in"),
        counter_ttl_seconds,
        snapshot.in_count,
    )
    pipeline.setex(
        redis_key(redis_config, park_id, "counter", snapshot.counter_day, "report_out"),
        counter_ttl_seconds,
        snapshot.out_count,
    )
    pipeline.execute()


def read_snapshot_from_redis(
    redis_client: Any,
    redis_config: RedisConfig,
    park_id: str,
    *,
    as_of: datetime,
    report_capacity: int,
    fallback: PoolSnapshot,
) -> PoolSnapshot:
    counter_day = as_of.strftime("%Y%m%d")
    pipeline = redis_client.pipeline(transaction=True)
    pipeline.get(redis_key(redis_config, park_id, "inside", "report"))
    pipeline.get(redis_key(redis_config, park_id, "inside", "hidden"))
    pipeline.get(redis_key(redis_config, park_id, "counter", counter_day, "report_in"))
    pipeline.get(redis_key(redis_config, park_id, "counter", counter_day, "report_out"))
    report_inside_raw, hidden_inside_raw, in_count_raw, out_count_raw = pipeline.execute()

    if None in {report_inside_raw, hidden_inside_raw, in_count_raw, out_count_raw}:
        return fallback

    return build_pool_snapshot(
        as_of=as_of,
        report_inside=int(report_inside_raw),
        hidden_inside=int(hidden_inside_raw),
        in_count=int(in_count_raw),
        out_count=int(out_count_raw),
        report_capacity=report_capacity,
    )


def log_push_result(
    connection: Any,
    park_id: str,
    snapshot: PoolSnapshot,
    payload: dict[str, int],
    *,
    success: bool,
    status_code: int | None,
    request_url: str | None,
    response_body: Any,
    retry_count: int,
    error_message: str | None,
) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO wc_pool_push_log (
              park_id, dotime, payload, request_url, status_code, response_body,
              success, retry_count, error_message
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                park_id,
                snapshot.dotime,
                json.dumps(payload, ensure_ascii=False),
                request_url,
                status_code,
                json.dumps(response_body, ensure_ascii=False) if response_body is not None else None,
                1 if success else 0,
                retry_count,
                error_message,
            ),
        )
    connection.commit()


def has_pending_source_events(
    connection: Any,
    db_config: DatabaseConfig,
    park_id: str,
    checkpoint: Checkpoint,
    *,
    as_of: datetime,
    pool_config: PoolRuntimeConfig,
    mysql_timezone: str,
) -> bool:
    events = fetch_source_events(
        connection,
        db_config,
        park_id,
        checkpoint,
        as_of=as_of,
        limit=1,
        hidden_auth_types=pool_config.hidden_auth_types,
        lookback_seconds=pool_config.lookback_seconds,
        mysql_timezone=mysql_timezone,
    )
    return bool(events)


def fetch_pending_pushes(connection: Any, park_id: str, *, limit: int) -> list[dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT p.push_id, p.dotime, p.payload
            FROM wc_pool_push_log AS p
            WHERE p.park_id = %s
              AND p.success = 0
              AND NOT EXISTS (
                SELECT 1
                FROM wc_pool_push_log AS ok
                WHERE ok.park_id = p.park_id
                  AND ok.dotime = p.dotime
                  AND ok.success = 1
              )
            ORDER BY p.dotime ASC, p.push_id ASC
            LIMIT %s
            """,
            (park_id, limit),
        )
        rows = cursor.fetchall() or []

    pending: list[dict[str, Any]] = []
    for row in rows:
        payload = row.get("payload")
        if isinstance(payload, str):
            payload = json.loads(payload)
        pending.append(
            {
                "push_id": int(row["push_id"]),
                "dotime": int(row["dotime"]),
                "payload": payload,
            }
        )
    return pending


def replay_failed_pushes(
    connection: Any,
    park_id: str,
    westcity_config: WestcityConfig,
    *,
    limit: int,
) -> list[dict[str, Any]]:
    replay_results: list[dict[str, Any]] = []
    for pending in fetch_pending_pushes(connection, park_id, limit=limit):
        payload = dict(pending["payload"])
        snapshot = PoolSnapshot(
            dotime=int(payload["dotime"]),
            counter_day=datetime.fromtimestamp(int(payload["dotime"])).strftime("%Y%m%d"),
            report_inside=0,
            hidden_inside=0,
            in_count=int(payload["in"]),
            out_count=int(payload["out"]),
            freeberth=int(payload["freeberth"]),
        )
        try:
            response = post_operations(westcity_config, payload)
            log_push_result(
                connection,
                park_id,
                snapshot,
                payload,
                success=True,
                status_code=int(response.get("status", 200)),
                request_url=str(response.get("url")),
                response_body=response.get("response"),
                retry_count=westcity_config.retry_count,
                error_message=None,
            )
            replay_results.append({"dotime": pending["dotime"], "status": "replayed"})
        except WestcityRequestError as exc:
            details = exc.details
            log_push_result(
                connection,
                park_id,
                snapshot,
                payload,
                success=False,
                status_code=int(details.get("status")) if details.get("status") is not None else None,
                request_url=str(details.get("url")) if details.get("url") is not None else None,
                response_body=details.get("response"),
                retry_count=westcity_config.retry_count,
                error_message=str(exc),
            )
            replay_results.append({"dotime": pending["dotime"], "status": "failed", "error": str(exc)})
    return replay_results


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Logical quota pool worker for Westcity operations push (Redis + MySQL)."
    )
    parser.add_argument("--env-file", help="Optional .env path.")
    parser.add_argument("--source-park-id", help="Local park_id. Falls back to WESTCITY_SOURCE_PARK_ID.")
    parser.add_argument("--as-of", help="ISO 8601 time in Asia/Shanghai if timezone is omitted.")
    parser.add_argument("--timezone", default="Asia/Shanghai", help="Timezone for --as-of and counter day.")
    parser.add_argument("--batch-size", type=int, help="Override WESTCITY_POOL_BATCH_SIZE for this run.")
    parser.add_argument("--max-events", type=int, help="Override WESTCITY_POOL_MAX_EVENTS for this run.")
    parser.add_argument("--skip-push", action="store_true", help="Process events and compute snapshot without HTTP push.")
    parser.add_argument("--dry-run", action="store_true", help="Do not push HTTP request; print computed snapshot and URL.")
    parser.add_argument(
        "--allow-redis-down",
        action="store_true",
        help="Continue with MySQL snapshot mode when Redis is unavailable.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    args = build_argument_parser().parse_args(argv)

    try:
        env = hydrate_environment(os.environ, explicit_env_file=args.env_file)
        westcity_config, db_config = load_configs(env, args.source_park_id)
        mysql_timezone = load_mysql_timezone(env)
        as_of = parse_as_of(args.as_of, args.timezone)
        pool_config = load_pool_runtime_config(
            env,
            report_capacity=westcity_config.max_free_berth,
            batch_size_override=args.batch_size,
            max_events_override=args.max_events,
        )
        redis_config = load_redis_config(env)

        connection = connect_mysql(db_config)
        redis_client: Any | None = None
        redis_warning: str | None = None
        lock_acquired = False
        try:
            redis_client = connect_redis(redis_config)
        except Exception as exc:
            if not args.allow_redis_down:
                raise
            redis_warning = str(exc)

        try:
            park_id = db_config.source_park_id
            lock_acquired = acquire_run_lock(connection, park_id, timeout_seconds=pool_config.lock_timeout_seconds)
            if not lock_acquired:
                print(
                    json.dumps(
                        {
                            "park_id": park_id,
                            "skipped": True,
                            "reason": "lock-not-acquired",
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                )
                return 0

            ensure_runtime_rows(connection, park_id, pool_config)
            checkpoint = read_checkpoint(connection, park_id)

            processed_total = 0
            status_counter: dict[str, int] = {}

            while processed_total < pool_config.max_events:
                remaining = pool_config.max_events - processed_total
                fetch_limit = min(pool_config.batch_size, remaining)
                events = fetch_source_events(
                    connection,
                    db_config,
                    park_id,
                    checkpoint,
                    as_of=as_of,
                    limit=fetch_limit,
                    hidden_auth_types=pool_config.hidden_auth_types,
                    lookback_seconds=pool_config.lookback_seconds,
                    mysql_timezone=mysql_timezone,
                )
                if not events:
                    break

                for event in events:
                    status, _ = process_source_event(connection, park_id, event, pool_config)
                    status_counter[status] = status_counter.get(status, 0) + 1
                    processed_total += 1
                    checkpoint = Checkpoint(last_event_time=event.event_time, last_event_id=event.source_event_id)

                if len(events) < fetch_limit:
                    break

            has_more_events = has_pending_source_events(
                connection,
                db_config,
                park_id,
                checkpoint,
                as_of=as_of,
                pool_config=pool_config,
                mysql_timezone=mysql_timezone,
            )

            reconcile_runtime_state(connection, park_id, as_of=as_of)

            mysql_snapshot = read_snapshot_from_mysql(
                connection,
                park_id,
                as_of=as_of,
                report_capacity=pool_config.report_capacity,
            )
            snapshot = mysql_snapshot
            if redis_client is not None:
                sync_snapshot_to_redis(
                    redis_client,
                    redis_config,
                    park_id,
                    mysql_snapshot,
                    counter_ttl_seconds=pool_config.counter_ttl_seconds,
                )
                snapshot = read_snapshot_from_redis(
                    redis_client,
                    redis_config,
                    park_id,
                    as_of=as_of,
                    report_capacity=pool_config.report_capacity,
                    fallback=mysql_snapshot,
                )

            payload = snapshot.as_payload()
            result: dict[str, Any] = {
                "park_id": park_id,
                "processed_events": processed_total,
                "status_counter": status_counter,
                "snapshot": {
                    "counter_day": snapshot.counter_day,
                    "report_inside": snapshot.report_inside,
                    "hidden_inside": snapshot.hidden_inside,
                    **payload,
                },
                "redis_warning": redis_warning,
                "backlog_remaining": has_more_events,
            }

            if has_more_events:
                result["push"] = {
                    "skipped": True,
                    "reason": "backlog-incomplete",
                }
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0

            if args.skip_push or args.dry_run:
                result["push"] = {
                    "skipped": True,
                    "reason": "dry-run" if args.dry_run else "skip-push",
                    "request": {
                        "url": redact_signed_url(
                            build_signed_url(
                                westcity_config,
                                f"/parkings/{westcity_config.app_key}/operations",
                                timestamp=snapshot.dotime,
                                req_uuid="dry-run",
                            )
                        ),
                        "content_type": "application/x-www-form-urlencoded",
                    },
                }
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0

            try:
                result["replayed_pushes"] = replay_failed_pushes(
                    connection,
                    park_id,
                    westcity_config,
                    limit=pool_config.push_replay_limit,
                )
                response = post_operations(westcity_config, payload)
                log_push_result(
                    connection,
                    park_id,
                    snapshot,
                    payload,
                    success=True,
                    status_code=int(response.get("status", 200)),
                    request_url=str(response.get("url")),
                    response_body=response.get("response"),
                    retry_count=westcity_config.retry_count,
                    error_message=None,
                )
                result["push"] = response
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0
            except WestcityRequestError as exc:
                details = exc.details
                log_push_result(
                    connection,
                    park_id,
                    snapshot,
                    payload,
                    success=False,
                    status_code=int(details.get("status")) if details.get("status") is not None else None,
                    request_url=str(details.get("url")) if details.get("url") is not None else None,
                    response_body=details.get("response"),
                    retry_count=westcity_config.retry_count,
                    error_message=str(exc),
                )
                result["push_error"] = details
                print(json.dumps(result, ensure_ascii=False, indent=2))
                print(str(exc), file=sys.stderr)
                return 1
        finally:
            if lock_acquired:
                try:
                    release_run_lock(connection, park_id)
                except Exception:
                    LOGGER.exception("failed to release MySQL lock for park_id=%s", park_id)
            connection.close()
    except ConfigurationError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except Exception as exc:  # nosec B110 - top-level failure capture for CLI diagnostics
        print(f"unexpected error: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
