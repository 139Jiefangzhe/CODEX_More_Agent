from __future__ import annotations

import argparse
import json
import sys

from .logging_utils import configure_logging
from .westcity_db_push import ConfigurationError, connect_mysql, hydrate_environment, load_database_config, parse_positive_int
from .westcity_pool_sync import connect_redis, load_redis_config


def prune_history(connection, park_id: str, *, retain_days: int) -> dict[str, int]:
    deleted: dict[str, int] = {}
    with connection.cursor() as cursor:
        cursor.execute(
            """
            DELETE FROM wc_pool_push_log
            WHERE park_id = %s
              AND created_at < DATE_SUB(NOW(), INTERVAL %s DAY)
            """,
            (park_id, retain_days),
        )
        deleted["wc_pool_push_log"] = cursor.rowcount

        cursor.execute(
            """
            DELETE FROM wc_pool_event_log
            WHERE park_id = %s
              AND created_at < DATE_SUB(NOW(), INTERVAL %s DAY)
            """,
            (park_id, retain_days),
        )
        deleted["wc_pool_event_log"] = cursor.rowcount

        cursor.execute(
            """
            DELETE FROM wc_pool_allocation
            WHERE park_id = %s
              AND status = 'out'
              AND COALESCE(exit_time, created_at) < DATE_SUB(NOW(), INTERVAL %s DAY)
            """,
            (park_id, retain_days),
        )
        deleted["wc_pool_allocation"] = cursor.rowcount

        cursor.execute(
            """
            DELETE FROM wc_pool_daily_counter
            WHERE park_id = %s
              AND updated_at < DATE_SUB(NOW(), INTERVAL %s DAY)
            """,
            (park_id, retain_days),
        )
        deleted["wc_pool_daily_counter"] = cursor.rowcount
    connection.commit()
    return deleted


def run_healthcheck(
    connection,
    park_id: str,
    *,
    max_push_age_seconds: int,
    redis_available: bool,
    require_redis: bool,
) -> tuple[bool, dict[str, object]]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT MAX(created_at) AS last_success_at
            FROM wc_pool_push_log
            WHERE park_id = %s AND success = 1
            """,
            (park_id,),
        )
        last_success = (cursor.fetchone() or {}).get("last_success_at")
        cursor.execute(
            """
            SELECT COUNT(*) AS pending_failed_pushes
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
            """,
            (park_id,),
        )
        pending_failed_pushes = int((cursor.fetchone() or {}).get("pending_failed_pushes", 0))
        cursor.execute(
            """
            SELECT
              CASE
                WHEN MAX(created_at) IS NULL THEN NULL
                ELSE TIMESTAMPDIFF(SECOND, MAX(created_at), NOW())
              END AS push_lag_seconds
            FROM wc_pool_push_log
            WHERE park_id = %s AND success = 1
            """,
            (park_id,),
        )
        push_lag_seconds = (cursor.fetchone() or {}).get("push_lag_seconds")

    ok = True
    if require_redis and not redis_available:
        ok = False
    if push_lag_seconds is None:
        ok = False
    elif int(push_lag_seconds) > max_push_age_seconds:
        ok = False

    result = {
        "park_id": park_id,
        "redis_available": redis_available,
        "last_success_at": last_success.isoformat(sep=" ") if last_success is not None else None,
        "push_lag_seconds": int(push_lag_seconds) if push_lag_seconds is not None else None,
        "pending_failed_pushes": pending_failed_pushes,
        "max_push_age_seconds": max_push_age_seconds,
    }
    return ok, result


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Maintenance helpers for parking-westcity-sync.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    prune_parser = subparsers.add_parser("prune", help="Delete old audit rows.")
    prune_parser.add_argument("--env-file", help="Optional .env path.")
    prune_parser.add_argument("--source-park-id", help="Optional source park id.")
    prune_parser.add_argument("--retain-days", type=int, help="Retention in days.")

    health_parser = subparsers.add_parser("healthcheck", help="Validate runtime health.")
    health_parser.add_argument("--env-file", help="Optional .env path.")
    health_parser.add_argument("--source-park-id", help="Optional source park id.")
    health_parser.add_argument("--max-push-age-seconds", type=int, help="Maximum age of the last successful push.")
    health_parser.add_argument("--allow-redis-down", action="store_true", help="Treat Redis as optional for healthcheck.")

    return parser


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    args = build_argument_parser().parse_args(argv)

    try:
        env = hydrate_environment(explicit_env_file=getattr(args, "env_file", None))
        database_config = load_database_config(env, getattr(args, "source_park_id", None))
        connection = connect_mysql(database_config, autocommit=False)
        try:
            if args.command == "prune":
                retain_days = args.retain_days or parse_positive_int(
                    env.get("WESTCITY_RETENTION_DAYS", "30"),
                    "WESTCITY_RETENTION_DAYS",
                    minimum=1,
                    maximum=3650,
                )
                result = {
                    "park_id": database_config.source_park_id,
                    "retain_days": retain_days,
                    "deleted": prune_history(connection, database_config.source_park_id, retain_days=retain_days),
                }
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0

            redis_available = True
            try:
                redis_client = connect_redis(load_redis_config(env))
                redis_client.close()
            except Exception:
                redis_available = False
                if not args.allow_redis_down:
                    raise

            max_push_age_seconds = args.max_push_age_seconds or parse_positive_int(
                env.get("WESTCITY_MAX_PUSH_AGE_SECONDS", "600"),
                "WESTCITY_MAX_PUSH_AGE_SECONDS",
                minimum=60,
                maximum=86400,
            )
            ok, result = run_healthcheck(
                connection,
                database_config.source_park_id,
                max_push_age_seconds=max_push_age_seconds,
                redis_available=redis_available,
                require_redis=not args.allow_redis_down,
            )
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if ok else 1
        finally:
            connection.close()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
