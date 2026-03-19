from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from .logging_utils import configure_logging


SUPPORTED_SIG_METHODS = {
    "HMAC-SHA1": hashlib.sha1,
    "HMAC-SHA256": hashlib.sha256,
}
DEFAULT_BASE_URL = "https://datahub.renniting.cn/apis/v1"
DEFAULT_SOURCE_TABLE = "cp_order_trip_real_record"
DEFAULT_TIMEOUT_SECONDS = 5
DEFAULT_RETRY_COUNT = 1
DEFAULT_TZ_NAME = "Asia/Shanghai"
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9_]+$")
ENV_LINE_PATTERN = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
LOGGER = logging.getLogger(__name__)


class ConfigurationError(ValueError):
    pass


class WestcityRequestError(RuntimeError):
    def __init__(self, message: str, *, details: dict[str, Any]) -> None:
        super().__init__(message)
        self.details = details


@dataclass(frozen=True)
class WestcityConfig:
    base_url: str
    app_key: str
    app_secret: str
    data_key: str
    app_uuid: str
    sig_method: str
    timeout_seconds: float
    retry_count: int
    max_free_berth: int


@dataclass(frozen=True)
class DatabaseConfig:
    host: str
    port: int
    user: str
    password: str
    database: str
    charset: str
    table_name: str
    source_park_id: str


@dataclass(frozen=True)
class OperationSnapshot:
    dotime: int
    freeberth: int
    in_count: int
    out_count: int
    inside_count: int
    record_day: str

    def as_payload(self) -> dict[str, int]:
        return {
            "dotime": self.dotime,
            "freeberth": self.freeberth,
            "in": self.in_count,
            "out": self.out_count,
        }


def normalize_platform_base64(value: str) -> str:
    return value.replace("=", "").replace("+", "*").replace("/", "-")


def build_signature(
    *,
    app_key: str,
    app_uuid: str,
    req_uuid: str,
    sig_method: str,
    timestamp: int,
    app_secret: str,
) -> str:
    hash_factory = SUPPORTED_SIG_METHODS.get(sig_method)
    if hash_factory is None:
        raise ConfigurationError(f"unsupported signature method: {sig_method}")

    raw_string = (
        f"app_key={app_key}"
        f"&app_uuid={app_uuid}"
        f"&req_uuid={req_uuid}"
        f"&sig_method={sig_method}"
        f"&timestamp={timestamp}"
    )
    digest = hmac.new(app_secret.encode("utf-8"), raw_string.encode("utf-8"), hash_factory).digest()
    return normalize_platform_base64(base64.b64encode(digest).decode("ascii"))


def encrypt_business_payload(payload: dict[str, Any], data_key: str) -> str:
    key_bytes = data_key.encode("utf-8")
    if len(key_bytes) not in {16, 24, 32}:
        raise ConfigurationError("WESTCITY_DATA_KEY must be 16, 24, or 32 bytes for AES-ECB")

    json_payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    padder = padding.PKCS7(128).padder()
    padded = padder.update(json_payload) + padder.finalize()
    cipher = Cipher(algorithms.AES(key_bytes), modes.ECB())  # nosec B305 - required by Westcity API spec
    encryptor = cipher.encryptor()
    encrypted = encryptor.update(padded) + encryptor.finalize()
    return normalize_platform_base64(base64.b64encode(encrypted).decode("ascii"))


def redact_signed_url(url: str) -> str:
    parsed = urllib_parse.urlsplit(url)
    query_items = urllib_parse.parse_qsl(parsed.query, keep_blank_values=True)
    redacted_items = [(key, "***" if key == "signature" else value) for key, value in query_items]
    return urllib_parse.urlunsplit(parsed._replace(query=urllib_parse.urlencode(redacted_items)))


def validate_identifier(identifier: str, name: str) -> str:
    if not identifier or not IDENTIFIER_PATTERN.fullmatch(identifier):
        raise ConfigurationError(f"{name} must contain only letters, numbers, and underscores")
    return identifier


def require_non_empty(env: dict[str, str], key: str) -> str:
    value = str(env.get(key, "")).strip()
    if not value:
        raise ConfigurationError(f"missing required environment variable: {key}")
    return value


def parse_positive_int(value: str, name: str, *, minimum: int = 0, maximum: int = 10**9) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ConfigurationError(f"{name} must be an integer") from exc
    if parsed < minimum or parsed > maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return parsed


def normalize_base_url(base_url: str) -> str:
    parsed = urllib_parse.urlsplit(base_url or DEFAULT_BASE_URL)
    if parsed.scheme != "https":
        raise ConfigurationError("WESTCITY_BASE_URL must use HTTPS")
    return urllib_parse.urlunsplit(parsed).rstrip("/")


def parse_dotenv_line(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None

    match = ENV_LINE_PATTERN.match(stripped)
    if not match:
        return None

    key, raw_value = match.groups()
    value = raw_value.strip()
    if value and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return key, value


def load_dotenv_file(path: Path) -> dict[str, str]:
    loaded: dict[str, str] = {}
    if not path.is_file():
        return loaded

    for line in path.read_text(encoding="utf-8").splitlines():
        parsed = parse_dotenv_line(line)
        if parsed is None:
            continue
        key, value = parsed
        loaded[key] = value
    return loaded


def hydrate_environment(base_env: dict[str, str] | None = None, *, explicit_env_file: str | None = None) -> dict[str, str]:
    env = dict(os.environ if base_env is None else base_env)
    candidates: list[Path] = []

    if explicit_env_file:
        candidates.append(Path(explicit_env_file).expanduser())
    else:
        candidates.append(Path.cwd() / ".env")
        candidates.append(Path(__file__).resolve().parent / ".env")

    for candidate in candidates:
        loaded = load_dotenv_file(candidate)
        if not loaded:
            continue
        for key, value in loaded.items():
            env.setdefault(key, value)
        break

    return env


def load_timeout_seconds(env: dict[str, str]) -> float:
    timeout_ms_raw = env.get("WESTCITY_TIMEOUT_MS")
    timeout_seconds_raw = env.get("WESTCITY_TIMEOUT_SECONDS")

    timeout_ms: int | None = None
    timeout_seconds: int | None = None

    if timeout_ms_raw is not None and timeout_ms_raw.strip() != "":
        timeout_ms = parse_positive_int(
            timeout_ms_raw,
            "WESTCITY_TIMEOUT_MS",
            minimum=100,
            maximum=60000,
        )

    if timeout_seconds_raw is not None and timeout_seconds_raw.strip() != "":
        timeout_seconds = parse_positive_int(
            timeout_seconds_raw,
            "WESTCITY_TIMEOUT_SECONDS",
            minimum=1,
            maximum=60,
        )

    if timeout_ms is not None and timeout_seconds is not None and timeout_ms != timeout_seconds * 1000:
        raise ConfigurationError("WESTCITY_TIMEOUT_MS and WESTCITY_TIMEOUT_SECONDS conflict; keep them consistent or set only one")

    if timeout_ms is not None:
        return timeout_ms / 1000.0
    if timeout_seconds is not None:
        return float(timeout_seconds)
    return float(DEFAULT_TIMEOUT_SECONDS)


def load_mysql_timezone(env: dict[str, str]) -> str:
    timezone_name = (env.get("MYSQL_TIMEZONE") or DEFAULT_TZ_NAME).strip() or DEFAULT_TZ_NAME
    try:
        ZoneInfo(timezone_name)
    except Exception as exc:  # pragma: no cover - defensive validation
        raise ConfigurationError(f"invalid MYSQL_TIMEZONE: {timezone_name}") from exc
    return timezone_name


def to_mysql_naive(value: datetime, mysql_timezone: str) -> datetime:
    return value.astimezone(ZoneInfo(mysql_timezone)).replace(tzinfo=None)


def load_database_config(
    env: dict[str, str],
    source_park_id: str | None,
    *,
    require_source_park_id: bool = True,
) -> DatabaseConfig:
    db_source_park_id = (source_park_id or env.get("WESTCITY_SOURCE_PARK_ID") or "").strip()
    if require_source_park_id and not db_source_park_id:
        raise ConfigurationError("missing source park id; set --source-park-id or WESTCITY_SOURCE_PARK_ID")

    return DatabaseConfig(
        host=require_non_empty(env, "MYSQL_HOST"),
        port=parse_positive_int(env.get("MYSQL_PORT", "3306"), "MYSQL_PORT", minimum=1, maximum=65535),
        user=require_non_empty(env, "MYSQL_USER"),
        password=require_non_empty(env, "MYSQL_PASSWORD"),
        database=require_non_empty(env, "MYSQL_DATABASE"),
        charset=env.get("MYSQL_CHARSET", "utf8mb4").strip() or "utf8mb4",
        table_name=validate_identifier(env.get("WESTCITY_SOURCE_TABLE", DEFAULT_SOURCE_TABLE), "WESTCITY_SOURCE_TABLE"),
        source_park_id=db_source_park_id,
    )


def load_configs(env: dict[str, str], source_park_id: str | None) -> tuple[WestcityConfig, DatabaseConfig]:
    app_key = require_non_empty(env, "WESTCITY_APP_KEY")
    app_secret = require_non_empty(env, "WESTCITY_APP_SECRET")
    data_key = require_non_empty(env, "WESTCITY_DATA_KEY")
    app_uuid = require_non_empty(env, "WESTCITY_APP_UUID")
    sig_method = env.get("WESTCITY_SIG_METHOD", "HMAC-SHA1").strip() or "HMAC-SHA1"
    if sig_method not in SUPPORTED_SIG_METHODS:
        raise ConfigurationError("WESTCITY_SIG_METHOD must be HMAC-SHA1 or HMAC-SHA256")

    westcity_config = WestcityConfig(
        base_url=normalize_base_url(env.get("WESTCITY_BASE_URL", DEFAULT_BASE_URL)),
        app_key=app_key,
        app_secret=app_secret,
        data_key=data_key,
        app_uuid=app_uuid,
        sig_method=sig_method,
        timeout_seconds=load_timeout_seconds(env),
        retry_count=parse_positive_int(
            env.get("WESTCITY_RETRY_COUNT", str(DEFAULT_RETRY_COUNT)),
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

    database_config = load_database_config(env, source_park_id)

    return westcity_config, database_config


def parse_as_of(value: str | None, tz_name: str = DEFAULT_TZ_NAME) -> datetime:
    tz = ZoneInfo(tz_name)
    if not value:
        return datetime.now(tz)

    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=tz)
    return parsed.astimezone(tz)


def build_signed_url(config: WestcityConfig, pathname: str, *, timestamp: int | None = None, req_uuid: str | None = None) -> str:
    request_timestamp = int(time.time()) if timestamp is None else timestamp
    request_uuid = str(uuid.uuid4()) if req_uuid is None else req_uuid
    signature = build_signature(
        app_key=config.app_key,
        app_uuid=config.app_uuid,
        req_uuid=request_uuid,
        sig_method=config.sig_method,
        timestamp=request_timestamp,
        app_secret=config.app_secret,
    )
    query_items = [
        ("app_key", config.app_key),
        ("app_uuid", config.app_uuid),
        ("req_uuid", request_uuid),
        ("sig_method", config.sig_method),
        ("timestamp", str(request_timestamp)),
        ("signature", signature),
    ]
    base = f"{config.base_url}{pathname}"
    return f"{base}?{urllib_parse.urlencode(query_items)}"


def build_operation_snapshot(*, as_of: datetime, in_count: int, out_count: int, inside_count: int, max_free_berth: int) -> OperationSnapshot:
    for value, name in (
        (in_count, "in_count"),
        (out_count, "out_count"),
        (inside_count, "inside_count"),
        (max_free_berth, "max_free_berth"),
    ):
        if value < 0:
            raise ValueError(f"{name} must not be negative")

    freeberth = max_free_berth - inside_count
    if freeberth < 0:
        freeberth = 0
    if freeberth > max_free_berth:
        freeberth = max_free_berth

    return OperationSnapshot(
        dotime=int(as_of.timestamp()),
        freeberth=freeberth,
        in_count=in_count,
        out_count=out_count,
        inside_count=inside_count,
        record_day=as_of.strftime("%Y%m%d"),
    )


def query_operation_snapshot(
    connection: Any,
    database_config: DatabaseConfig,
    *,
    as_of: datetime,
    max_free_berth: int,
    mysql_timezone: str = DEFAULT_TZ_NAME,
) -> OperationSnapshot:
    table_name = database_config.table_name
    record_day = as_of.strftime("%Y%m%d")
    as_of_naive = to_mysql_naive(as_of, mysql_timezone)
    active_where = "(`deleted` IS NULL OR `deleted` = 0)"

    count_sql = f"""
        SELECT
          COALESCE(SUM(CASE WHEN `type` = '00' THEN 1 ELSE 0 END), 0) AS in_count,
          COALESCE(SUM(CASE WHEN `type` = '01' THEN 1 ELSE 0 END), 0) AS out_count
        FROM `{table_name}`
        WHERE `park_id` = %s
          AND `record_day` = %s
          AND `time` <= %s
          AND {active_where}
    """
    inside_sql = f"""
        SELECT COUNT(*) AS inside_count
        FROM `{table_name}` AS i
        WHERE i.`park_id` = %s
          AND i.`type` = '00'
          AND i.`time` <= %s
          AND (i.`deleted` IS NULL OR i.`deleted` = 0)
          AND COALESCE(NULLIF(TRIM(i.`plate`), ''), NULLIF(TRIM(i.`trip_id`), ''), NULLIF(TRIM(i.`order_id`), '')) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM `{table_name}` AS o
            WHERE o.`park_id` = i.`park_id`
              AND o.`type` = '01'
              AND o.`time` <= %s
              AND (o.`deleted` IS NULL OR o.`deleted` = 0)
              AND (
                o.`time` > i.`time`
                OR (o.`time` = i.`time` AND o.`pk_trip_real_id` > i.`pk_trip_real_id`)
              )
              AND (
                (i.`plate` IS NOT NULL AND i.`plate` <> '' AND o.`plate` = i.`plate`)
                OR
                (i.`trip_id` IS NOT NULL AND i.`trip_id` <> '' AND o.`trip_id` = i.`trip_id`)
                OR
                (i.`order_id` IS NOT NULL AND i.`order_id` <> '' AND o.`order_id` = i.`order_id`)
              )
          )
    """

    with connection.cursor() as cursor:
        cursor.execute(count_sql, (database_config.source_park_id, record_day, as_of_naive))
        counts = cursor.fetchone() or {}
        cursor.execute(inside_sql, (database_config.source_park_id, as_of_naive, as_of_naive))
        occupancy = cursor.fetchone() or {}

    return build_operation_snapshot(
        as_of=as_of,
        in_count=int(counts.get("in_count", 0)),
        out_count=int(counts.get("out_count", 0)),
        inside_count=int(occupancy.get("inside_count", 0)),
        max_free_berth=max_free_berth,
    )


def connect_mysql(database_config: DatabaseConfig, *, autocommit: bool = True) -> Any:
    try:
        import pymysql
    except ModuleNotFoundError as exc:
        raise ConfigurationError("PyMySQL is required. Install it with: pip install -r requirements-python.txt") from exc

    return pymysql.connect(
        host=database_config.host,
        port=database_config.port,
        user=database_config.user,
        password=database_config.password,
        database=database_config.database,
        charset=database_config.charset,
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=autocommit,
    )


def parse_response_body(raw_body: bytes) -> Any:
    text = raw_body.decode("utf-8", errors="replace")
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def post_operations(
    config: WestcityConfig,
    payload: dict[str, Any],
    *,
    opener: Any | None = None,
) -> dict[str, Any]:
    body = urllib_parse.urlencode({"data": encrypt_business_payload(payload, config.data_key)}).encode("utf-8")
    http_opener = opener or urllib_request.build_opener()
    last_error: Exception | None = None

    for attempt in range(config.retry_count + 1):
        request_url = build_signed_url(config, f"/parkings/{config.app_key}/operations")
        request = urllib_request.Request(
            request_url,
            data=body,
            headers={
                "accept": "application/json",
                "content-type": "application/x-www-form-urlencoded",
            },
            method="POST",
        )
        try:
            with http_opener.open(request, timeout=config.timeout_seconds) as response:
                response_body = parse_response_body(response.read())
                return {
                    "status": getattr(response, "status", 200),
                    "url": redact_signed_url(request_url),
                    "response": response_body,
                }
        except urllib_error.HTTPError as exc:
            body_data = exc.read()
            details = {
                "status": exc.code,
                "url": redact_signed_url(request_url),
                "response": parse_response_body(body_data),
            }
            if exc.code >= 500 and attempt < config.retry_count:
                time.sleep(0.2 * (attempt + 1))
                continue
            raise WestcityRequestError(f"Westcity API request failed with status {exc.code}", details=details) from exc
        except (urllib_error.URLError, TimeoutError) as exc:
            last_error = exc
            if attempt < config.retry_count:
                time.sleep(0.2 * (attempt + 1))
                continue
            raise WestcityRequestError(
                "Westcity API request failed before receiving a response",
                details={"url": redact_signed_url(request_url), "error": str(exc)},
            ) from exc

    if last_error is not None:
        raise last_error
    raise RuntimeError("unreachable")


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read cp_order_trip_real_record from MySQL and push Westcity operations data."
    )
    parser.add_argument(
        "--env-file",
        help="Optional .env file path. Defaults to .env in the current directory, then script directory.",
    )
    parser.add_argument(
        "--source-park-id",
        help="Local database park_id to aggregate. Falls back to WESTCITY_SOURCE_PARK_ID.",
    )
    parser.add_argument(
        "--as-of",
        help="ISO 8601 time in Asia/Shanghai if timezone is omitted. Defaults to now.",
    )
    parser.add_argument(
        "--timezone",
        default=DEFAULT_TZ_NAME,
        help=f"Timezone used for --as-of and record_day calculation. Defaults to {DEFAULT_TZ_NAME}.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the computed payload and redacted request URL without sending the HTTP request.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    args = build_argument_parser().parse_args(argv)
    try:
        env = hydrate_environment(os.environ, explicit_env_file=args.env_file)
        westcity_config, database_config = load_configs(env, args.source_park_id)
        mysql_timezone = load_mysql_timezone(env)
        as_of = parse_as_of(args.as_of, args.timezone)
        connection = connect_mysql(database_config)
        try:
            snapshot = query_operation_snapshot(
                connection,
                database_config,
                as_of=as_of,
                max_free_berth=westcity_config.max_free_berth,
                mysql_timezone=mysql_timezone,
            )
        finally:
            connection.close()

        payload = snapshot.as_payload()
        if args.dry_run:
            print(
                json.dumps(
                    {
                        "source_park_id": database_config.source_park_id,
                        "table_name": database_config.table_name,
                        "snapshot": {
                            "record_day": snapshot.record_day,
                            "inside_count": snapshot.inside_count,
                            **payload,
                        },
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
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0

        result = post_operations(westcity_config, payload)
        print(
            json.dumps(
                {
                    "source_park_id": database_config.source_park_id,
                    "snapshot": {
                        "record_day": snapshot.record_day,
                        "inside_count": snapshot.inside_count,
                        **payload,
                    },
                    "push_result": result,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except (ConfigurationError, WestcityRequestError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        details = getattr(exc, "details", None)
        if details is not None:
            print(json.dumps(details, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    except Exception as exc:  # nosec B110 - top-level failure capture for CLI diagnostics
        LOGGER.exception("westcity_db_push failed")
        print(f"unexpected error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
