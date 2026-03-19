from __future__ import annotations

import io
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock
from urllib import error as urllib_error

from westcity_sync import westcity_db_push


class FakeCursor:
    def __init__(self, rows):
        self.rows = list(rows)
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params):
        self.executed.append((sql, params))

    def fetchone(self):
        if not self.rows:
            return None
        return self.rows.pop(0)


class FakeConnection:
    def __init__(self, rows):
        self.cursor_instance = FakeCursor(rows)
        self.closed = False

    def cursor(self):
        return self.cursor_instance

    def close(self):
        self.closed = True


class FakeHttpResponse:
    def __init__(self, status, body):
        self.status = status
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return self._body


class FakeOpener:
    def __init__(self, response=None, error=None, responses=None):
        self.response = response
        self.error = error
        self.responses = list(responses or [])
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if self.responses:
            next_item = self.responses.pop(0)
            if isinstance(next_item, Exception):
                raise next_item
            return next_item
        if self.error is not None:
            raise self.error
        return self.response


class WestcityDbPushTests(unittest.TestCase):
    def setUp(self):
        self.config = westcity_db_push.WestcityConfig(  # nosec B106 - deterministic test vector
            base_url="https://datahub.renniting.cn/apis/v1",
            app_key="parking-app-key",
            app_secret="parking-app-secret",  # nosec B106 - deterministic test vector
            data_key="aes-test-key-001",
            app_uuid="tea-trade-device-01",
            sig_method="HMAC-SHA1",
            timeout_seconds=5,
            retry_count=0,
            max_free_berth=300,
        )

    def test_normalize_platform_base64(self):
        self.assertEqual(westcity_db_push.normalize_platform_base64("ab+/="), "ab*-")

    def test_hydrate_environment_loads_dotenv_without_overriding_existing_env(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_path = Path(tmpdir) / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "# comment",
                        "WESTCITY_APP_UUID=dotenv-app-uuid",
                        "MYSQL_HOST=127.0.0.1",
                        "MYSQL_USER=dotenv-user",
                    ]
                ),
                encoding="utf-8",
            )

            hydrated = westcity_db_push.hydrate_environment(
                {"MYSQL_USER": "existing-user"},
                explicit_env_file=str(env_path),
            )

        self.assertEqual(hydrated["WESTCITY_APP_UUID"], "dotenv-app-uuid")
        self.assertEqual(hydrated["MYSQL_HOST"], "127.0.0.1")
        self.assertEqual(hydrated["MYSQL_USER"], "existing-user")

    def test_hydrate_environment_respects_empty_base_env(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_path = Path(tmpdir) / ".env"
            env_path.write_text("WESTCITY_APP_UUID=dotenv-app-uuid\n", encoding="utf-8")

            with mock.patch.dict(westcity_db_push.os.environ, {"MYSQL_HOST": "from-process"}, clear=True):
                hydrated = westcity_db_push.hydrate_environment({}, explicit_env_file=str(env_path))

        self.assertEqual(hydrated, {"WESTCITY_APP_UUID": "dotenv-app-uuid"})

    def test_build_signature_matches_node_vector(self):
        signature = westcity_db_push.build_signature(  # nosec B106 - deterministic test vector
            app_key="parking-app-key",
            app_uuid="tea-trade-device-01",
            req_uuid="7ec04880-cd0b-402d-bd92-b4e582ddc09e",
            sig_method="HMAC-SHA1",
            timestamp=1697942682,
            app_secret="parking-app-secret",  # nosec B106 - deterministic test vector
        )
        self.assertEqual(signature, "OEEw*7dK5A4tG0tOG4Wg-Y9jkrE")

    def test_build_signed_url_preserves_explicit_zero_timestamp(self):
        url = westcity_db_push.build_signed_url(
            self.config,
            "/parkings/parking-app-key/operations",
            timestamp=0,
            req_uuid="fixed-uuid",
        )

        self.assertIn("timestamp=0", url)
        self.assertIn("req_uuid=fixed-uuid", url)

    def test_encrypt_business_payload_matches_node_vector(self):
        encrypted = westcity_db_push.encrypt_business_payload(
            {
                "dotime": 1697942682,
                "freeberth": 100,
                "in": 50,
                "out": 40,
            },
            "aes-test-key-001",
        )
        self.assertEqual(
            encrypted,
            "bvpLR3TermecQEvvvrmMHaCsUm9WefZoWKi1mWIA86AmC8a4et9*IUbKhT*FanykBKswJjOC8eGjXObG1wCPXA",
        )

    def test_build_operation_snapshot_clamps_free_berth(self):
        snapshot = westcity_db_push.build_operation_snapshot(
            as_of=datetime.fromisoformat("2026-03-18T10:00:00+08:00"),
            in_count=20,
            out_count=10,
            inside_count=305,
            max_free_berth=300,
        )
        self.assertEqual(snapshot.freeberth, 0)
        self.assertEqual(snapshot.record_day, "20260318")
        self.assertEqual(snapshot.as_payload()["in"], 20)

    def test_load_timeout_seconds_supports_milliseconds_and_detects_conflict(self):
        self.assertEqual(westcity_db_push.load_timeout_seconds({"WESTCITY_TIMEOUT_MS": "1500"}), 1.5)
        self.assertEqual(westcity_db_push.load_timeout_seconds({"WESTCITY_TIMEOUT_SECONDS": "2"}), 2.0)
        with self.assertRaises(westcity_db_push.ConfigurationError):
            westcity_db_push.load_timeout_seconds(
                {
                    "WESTCITY_TIMEOUT_MS": "1500",
                    "WESTCITY_TIMEOUT_SECONDS": "2",
                }
            )

    def test_query_operation_snapshot_reads_counts_and_inside_count(self):
        connection = FakeConnection(
            [
                {"in_count": 56, "out_count": 40},
                {"inside_count": 18},
            ]
        )
        db_config = westcity_db_push.DatabaseConfig(  # nosec B106 - fake database password for tests
            host="127.0.0.1",
            port=3306,
            user="root",
            password="secret",  # nosec B106 - fake database password for tests
            database="parking",
            charset="utf8mb4",
            table_name="cp_order_trip_real_record",
            source_park_id="PARK-001",
        )

        snapshot = westcity_db_push.query_operation_snapshot(
            connection,
            db_config,
            as_of=datetime.fromisoformat("2026-03-18T10:00:00+08:00"),
            max_free_berth=300,
        )

        self.assertEqual(snapshot.in_count, 56)
        self.assertEqual(snapshot.out_count, 40)
        self.assertEqual(snapshot.inside_count, 18)
        self.assertEqual(snapshot.freeberth, 282)
        self.assertEqual(len(connection.cursor_instance.executed), 2)
        first_sql, first_params = connection.cursor_instance.executed[0]
        self.assertIn("FROM `cp_order_trip_real_record`", first_sql)
        self.assertEqual(first_params[0], "PARK-001")
        self.assertEqual(first_params[1], "20260318")
        inside_sql, inside_params = connection.cursor_instance.executed[1]
        self.assertIn("i.`plate`", inside_sql)
        self.assertIn("COALESCE(NULLIF(TRIM(i.`plate`)", inside_sql)
        self.assertEqual(inside_params[1], datetime.fromisoformat("2026-03-18T10:00:00"))

    def test_query_operation_snapshot_converts_to_mysql_timezone(self):
        connection = FakeConnection(
            [
                {"in_count": 1, "out_count": 0},
                {"inside_count": 1},
            ]
        )
        db_config = westcity_db_push.DatabaseConfig(  # nosec B106 - fake database password for tests
            host="127.0.0.1",
            port=3306,
            user="root",
            password="secret",  # nosec B106 - fake database password for tests
            database="parking",
            charset="utf8mb4",
            table_name="cp_order_trip_real_record",
            source_park_id="PARK-001",
        )

        westcity_db_push.query_operation_snapshot(
            connection,
            db_config,
            as_of=datetime.fromisoformat("2026-03-18T10:00:00+08:00"),
            max_free_berth=300,
            mysql_timezone="UTC",
        )

        _, count_params = connection.cursor_instance.executed[0]
        self.assertEqual(count_params[2], datetime.fromisoformat("2026-03-18T02:00:00"))

    def test_post_operations_redacts_signature_on_http_error(self):
        http_error = urllib_error.HTTPError(
            url="https://datahub.renniting.cn/apis/v1/parkings/parking-app-key/operations",
            code=400,
            msg="Bad Request",
            hdrs=None,
            fp=io.BytesIO(b'{"code":"1024","msg":"invalid app key"}'),
        )
        opener = FakeOpener(error=http_error)

        with self.assertRaises(westcity_db_push.WestcityRequestError) as context:
            westcity_db_push.post_operations(
                self.config,
                {"dotime": 1697942682, "freeberth": 100, "in": 50, "out": 40},
                opener=opener,
            )

        details = context.exception.details
        self.assertEqual(details["status"], 400)
        self.assertIn("signature=%2A%2A%2A", details["url"])
        self.assertEqual(details["response"]["code"], "1024")

    def test_post_operations_retries_with_fresh_signed_url(self):
        opener = FakeOpener(
            responses=[
                urllib_error.URLError("temporary outage"),
                FakeHttpResponse(201, b'{"code":"0","msg":"ok"}'),
            ]
        )
        retrying_config = westcity_db_push.WestcityConfig(
            base_url=self.config.base_url,
            app_key=self.config.app_key,
            app_secret=self.config.app_secret,
            data_key=self.config.data_key,
            app_uuid=self.config.app_uuid,
            sig_method=self.config.sig_method,
            timeout_seconds=1.5,
            retry_count=1,
            max_free_berth=self.config.max_free_berth,
        )

        with mock.patch.object(
            westcity_db_push,
            "build_signed_url",
            side_effect=[
                "https://example.com/operations?timestamp=1&req_uuid=first&signature=abc",
                "https://example.com/operations?timestamp=2&req_uuid=second&signature=def",
            ],
        ):
            result = westcity_db_push.post_operations(
                retrying_config,
                {"dotime": 1697942682, "freeberth": 100, "in": 50, "out": 40},
                opener=opener,
            )

        self.assertEqual(result["status"], 201)
        self.assertEqual(len(opener.requests), 2)
        self.assertNotEqual(opener.requests[0][0].full_url, opener.requests[1][0].full_url)

    def test_load_configs_requires_max_free_berth(self):
        env = {
            "WESTCITY_APP_KEY": "parking-app-key",
            "WESTCITY_APP_SECRET": "parking-app-secret",
            "WESTCITY_DATA_KEY": "aes-test-key-001",
            "WESTCITY_APP_UUID": "tea-trade-device-01",
            "WESTCITY_SOURCE_PARK_ID": "PARK-001",
            "MYSQL_HOST": "127.0.0.1",
            "MYSQL_USER": "root",
            "MYSQL_PASSWORD": "secret",
            "MYSQL_DATABASE": "parking",
        }

        with self.assertRaises(westcity_db_push.ConfigurationError):
            westcity_db_push.load_configs(env, None)

    def test_main_dry_run_prints_snapshot(self):
        env = {
            "WESTCITY_BASE_URL": "https://datahub.renniting.cn/apis/v1",
            "WESTCITY_APP_KEY": "parking-app-key",
            "WESTCITY_APP_SECRET": "parking-app-secret",
            "WESTCITY_DATA_KEY": "aes-test-key-001",
            "WESTCITY_APP_UUID": "tea-trade-device-01",
            "WESTCITY_MAX_FREE_BERTH": "300",
            "WESTCITY_SOURCE_PARK_ID": "PARK-001",
            "MYSQL_HOST": "127.0.0.1",
            "MYSQL_PORT": "3306",
            "MYSQL_USER": "root",
            "MYSQL_PASSWORD": "secret",
            "MYSQL_DATABASE": "parking",
        }
        snapshot = westcity_db_push.OperationSnapshot(
            dotime=1710727200,
            freeberth=128,
            in_count=560,
            out_count=432,
            inside_count=172,
            record_day="20260318",
        )
        fake_connection = FakeConnection([])
        with tempfile.TemporaryDirectory() as tmpdir:
            env_file = Path(tmpdir) / ".env"
            env_file.write_text(
                "\n".join(f"{key}={value}" for key, value in env.items()),
                encoding="utf-8",
            )

            stdout = io.StringIO()
            with (
                mock.patch.dict(westcity_db_push.os.environ, {}, clear=True),
                mock.patch.object(westcity_db_push, "connect_mysql", return_value=fake_connection),
                mock.patch.object(westcity_db_push, "query_operation_snapshot", return_value=snapshot),
                mock.patch.object(westcity_db_push, "build_signed_url", return_value="https://example.com?a=1&signature=abc"),
                mock.patch.object(westcity_db_push, "redact_signed_url", return_value="https://example.com?a=1&signature=***"),
                mock.patch("sys.stdout", stdout),
            ):
                exit_code = westcity_db_push.main(
                    ["--dry-run", "--env-file", str(env_file), "--as-of", "2026-03-18T10:00:00+08:00"]
                )

        self.assertEqual(exit_code, 0)
        output = json.loads(stdout.getvalue())
        self.assertEqual(output["snapshot"]["freeberth"], 128)
        self.assertEqual(output["request"]["url"], "https://example.com?a=1&signature=***")
        self.assertTrue(fake_connection.closed)


if __name__ == "__main__":
    unittest.main()
