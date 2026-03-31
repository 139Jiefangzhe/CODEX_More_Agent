#!/usr/bin/env bash
# Shared database helpers for dashboard hook scripts.

set +e

DASHBOARD_SCRIPT_DIR="${DASHBOARD_SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
DASHBOARD_REPO_ROOT="${DASHBOARD_REPO_ROOT:-$(cd "$DASHBOARD_SCRIPT_DIR/../../.." && pwd)}"
DASHBOARD_NODE_MODULES="${DASHBOARD_NODE_MODULES:-$DASHBOARD_REPO_ROOT/src/dashboard/node_modules}"
DASHBOARD_NOTIFY_URL="${DASHBOARD_NOTIFY_URL:-http://127.0.0.1:${DASHBOARD_PORT:-3100}/api/internal/notify}"

dashboard_json_escape() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' \
          -e 's/"/\\"/g' \
          -e ':a;N;$!ba;s/\n/\\n/g'
}

dashboard_has_node_sqlite() {
  command -v node >/dev/null 2>&1 && [ -d "$DASHBOARD_NODE_MODULES/better-sqlite3" ]
}

dashboard_has_db() {
  [ -f "$DASHBOARD_DB" ] && (command -v sqlite3 >/dev/null 2>&1 || dashboard_has_node_sqlite)
}

dashboard_notify() {
  local kind="$1"
  local payload_json="${2:-{}}"
  local body
  local token

  if [ -z "$kind" ] || ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  body="{\"kind\":\"$(dashboard_json_escape "$kind")\",\"payload\":$payload_json}"
  token="${DASHBOARD_TOKEN:-}"

  if [ -z "$token" ]; then
    return 0
  fi

  curl -sS --max-time 2 \
    -H "Content-Type: application/json" \
    -H "x-dashboard-token: $token" \
    -X POST \
    -d "$body" \
    "$DASHBOARD_NOTIFY_URL" >/dev/null 2>&1 || true
  return 0
}

dashboard_run_sql() {
  local sql="$1"

  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 -batch -noheader "$DASHBOARD_DB" "$sql" 2>/dev/null
    return $?
  fi

  if ! dashboard_has_node_sqlite; then
    return 1
  fi

  DASHBOARD_SQL="$sql" DASHBOARD_DB="$DASHBOARD_DB" DASHBOARD_NODE_MODULES="$DASHBOARD_NODE_MODULES" node - <<'NODE' 2>/dev/null
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const dbPath = process.env.DASHBOARD_DB || '';
const sql = process.env.DASHBOARD_SQL || '';
const nodeModulesPath = process.env.DASHBOARD_NODE_MODULES || '';

if (!dbPath || !sql || !fs.existsSync(dbPath)) {
  process.exit(1);
}

const requireFn = createRequire(process.cwd() + '/');
const candidates = ['better-sqlite3'];

if (nodeModulesPath) {
  candidates.push(path.join(nodeModulesPath, 'better-sqlite3'));
}

let Database = null;

for (const candidate of candidates) {
  try {
    Database = requireFn(candidate);
    break;
  } catch (error) {
    continue;
  }
}

if (!Database) {
  process.exit(1);
}

const db = new Database(dbPath, { fileMustExist: true });

try {
  const statement = db.prepare(sql);

  if (statement.reader) {
    const rows = statement.all();

    for (const row of rows) {
      const values = Object.values(row).map((value) => {
        if (value === null || value === undefined) {
          return '';
        }

        return String(value);
      });

      process.stdout.write(values.join('|') + '\n');
    }
  } else {
    statement.run();
  }

  process.exit(0);
} catch (error) {
  process.exit(1);
} finally {
  try {
    db.close();
  } catch (error) {
    // ignore close errors
  }
}
NODE
}
