from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Iterable

from .logging_utils import configure_logging
from .westcity_db_push import ConfigurationError, connect_mysql, hydrate_environment, load_database_config


MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "sql" / "migrations"
IGNORABLE_SCHEMA_ERROR_CODES = {1050, 1060, 1061, 1091}


def split_sql_statements(text: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    in_single_quote = False
    in_double_quote = False
    previous = ""

    for char in text:
        if char == "'" and not in_double_quote and previous != "\\":
            in_single_quote = not in_single_quote
        elif char == '"' and not in_single_quote and previous != "\\":
            in_double_quote = not in_double_quote

        if char == ";" and not in_single_quote and not in_double_quote:
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
        else:
            current.append(char)
        previous = char

    tail = "".join(current).strip()
    if tail:
        statements.append(tail)
    return [statement for statement in statements if statement and not statement.startswith("--")]


def iter_migration_files() -> Iterable[Path]:
    return sorted(MIGRATIONS_DIR.glob("*.sql"))


def ensure_migration_table(connection) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS wc_schema_migrations (
              migration_name varchar(255) NOT NULL,
              checksum varchar(64) NOT NULL,
              applied_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (migration_name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Schema migration history'
            """
        )
    connection.commit()


def load_applied_migrations(connection) -> dict[str, str]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT migration_name, checksum FROM wc_schema_migrations ORDER BY migration_name ASC")
        rows = cursor.fetchall() or []
    return {str(row["migration_name"]): str(row["checksum"]) for row in rows}


def apply_migrations(connection) -> list[str]:
    ensure_migration_table(connection)
    applied = load_applied_migrations(connection)
    applied_now: list[str] = []

    for migration_path in iter_migration_files():
        migration_name = migration_path.name
        checksum = hashlib.sha256(migration_path.read_bytes()).hexdigest()
        if migration_name in applied:
            if applied[migration_name] != checksum:
                raise ConfigurationError(f"migration checksum changed after apply: {migration_name}")
            continue

        statements = split_sql_statements(migration_path.read_text(encoding="utf-8"))
        try:
            with connection.cursor() as cursor:
                for statement in statements:
                    try:
                        cursor.execute(statement)
                    except Exception as exc:
                        error_code = exc.args[0] if getattr(exc, "args", None) else None
                        if error_code in IGNORABLE_SCHEMA_ERROR_CODES:
                            continue
                        raise
                cursor.execute(
                    "INSERT INTO wc_schema_migrations (migration_name, checksum) VALUES (%s, %s)",
                    (migration_name, checksum),
                )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        applied_now.append(migration_name)

    return applied_now


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Apply schema migrations for parking-westcity-sync.")
    parser.add_argument("--env-file", help="Optional .env path.")
    parser.add_argument("--source-park-id", help="Optional source park id used to resolve database config.")
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    args = build_argument_parser().parse_args(argv)

    try:
        env = hydrate_environment(explicit_env_file=args.env_file)
        database_config = load_database_config(env, args.source_park_id, require_source_park_id=False)
        connection = connect_mysql(database_config, autocommit=False)
        try:
            applied_now = apply_migrations(connection)
        finally:
            connection.close()

        print(
            json.dumps(
                {
                    "database": database_config.database,
                    "applied_now": applied_now,
                    "migration_dir": str(MIGRATIONS_DIR),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
