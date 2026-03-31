#!/usr/bin/env bash
# Dashboard 事件发射器

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEFAULT_DB="$REPO_ROOT/src/dashboard/data/dashboard.db"
DASHBOARD_DB="${DASHBOARD_DB:-$DEFAULT_DB}"
DASHBOARD_SCRIPT_DIR="$SCRIPT_DIR"
DASHBOARD_REPO_ROOT="$REPO_ROOT"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/db-utils.sh"

raw_event_type="${1:-}"
shift || true

now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

json_escape() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' \
          -e 's/"/\\"/g' \
          -e ':a;N;$!ba;s/\n/\\n/g'
}

has_db() {
  dashboard_has_db
}

run_sql() {
  dashboard_run_sql "$1"
}

if [ -z "$raw_event_type" ] || ! has_db; then
  exit 0
fi

if [ -z "${DASHBOARD_SESSION:-}" ] || [ -z "${DASHBOARD_AGENT_RUN:-}" ]; then
  exit 0
fi

event_type="checkpoint"
message=""
extra_json=""

case "$raw_event_type" in
  edit)
    event_type="checkpoint"
    message="postEdit hook executed"
    extra_json=",\"hook\":\"postEdit\",\"file\":\"$(json_escape "${1:-}")\""
    ;;
  commit)
    event_type="checkpoint"
    message="preCommit hook executed"
    extra_json=",\"hook\":\"preCommit\""
    ;;
  push)
    event_type="checkpoint"
    message="prePush hook executed"
    extra_json=",\"hook\":\"prePush\""
    ;;
  step_start|step_end|output|error|tool_call|checkpoint)
    event_type="$raw_event_type"
    message="$*"
    ;;
  *)
    event_type="$raw_event_type"
    message="$*"
    ;;
esac

if [ -z "$message" ]; then
  message="event: $raw_event_type"
fi

payload="{\"message\":\"$(json_escape "$message")\"$extra_json}"
event_timestamp="$(now_iso)"

run_sql "
  INSERT INTO agent_events (agent_run_id, session_id, timestamp, event_type, event_data)
  VALUES (
    '$(sql_escape "$DASHBOARD_AGENT_RUN")',
    '$(sql_escape "$DASHBOARD_SESSION")',
    '$(sql_escape "$event_timestamp")',
    '$(sql_escape "$event_type")',
    '$(sql_escape "$payload")'
  );
"

event_id="$(run_sql "
  SELECT id
  FROM agent_events
  WHERE
    agent_run_id = '$(sql_escape "$DASHBOARD_AGENT_RUN")'
    AND session_id = '$(sql_escape "$DASHBOARD_SESSION")'
    AND timestamp = '$(sql_escape "$event_timestamp")'
  ORDER BY id DESC
  LIMIT 1;
")"

notify_payload="{\"sessionId\":\"$(json_escape "$DASHBOARD_SESSION")\",\"agentRunId\":\"$(json_escape "$DASHBOARD_AGENT_RUN")\",\"eventType\":\"$(json_escape "$event_type")\",\"timestamp\":\"$(json_escape "$event_timestamp")\",\"eventId\":${event_id:-0}}"
dashboard_notify "agent_event" "$notify_payload"

exit 0
