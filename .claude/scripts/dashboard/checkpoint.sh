#!/usr/bin/env bash
# Dashboard 控制信号检查点

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEFAULT_DB="$REPO_ROOT/src/dashboard/data/dashboard.db"
DASHBOARD_DB="${DASHBOARD_DB:-$DEFAULT_DB}"
DASHBOARD_AGENT_RUN="${DASHBOARD_AGENT_RUN:-}"
PAUSE_TIMEOUT_SECONDS="${PAUSE_TIMEOUT_SECONDS:-1800}"
DASHBOARD_SCRIPT_DIR="$SCRIPT_DIR"
DASHBOARD_REPO_ROOT="$REPO_ROOT"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/db-utils.sh"

ACTION_CONTINUE="CONTINUE"
ACTION_SKIP="SKIP"
ACTION_RETRY="RETRY"
ACTION_ABORT="ABORT"
RUN_SESSION_ID=""

now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

is_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

has_db() {
  dashboard_has_db
}

run_sql() {
  dashboard_run_sql "$1"
}

fetch_next_signal() {
  run_sql "
    SELECT id || '|' || action
    FROM control_signals
    WHERE
      agent_run_id = '$(sql_escape "$DASHBOARD_AGENT_RUN")'
      AND consumed_at IS NULL
      AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
    ORDER BY created_at ASC, id ASC
    LIMIT 1;
  "
}

fetch_run_status() {
  run_sql "
    SELECT status
    FROM agent_runs
    WHERE id = '$(sql_escape "$DASHBOARD_AGENT_RUN")'
    LIMIT 1;
  " | head -n 1
}

fetch_run_session_id() {
  run_sql "
    SELECT session_id
    FROM agent_runs
    WHERE id = '$(sql_escape "$DASHBOARD_AGENT_RUN")'
    LIMIT 1;
  " | head -n 1
}

ensure_run_session_id() {
  if [ -n "$RUN_SESSION_ID" ]; then
    printf '%s\n' "$RUN_SESSION_ID"
    return 0
  fi

  RUN_SESSION_ID="$(fetch_run_session_id)"
  printf '%s\n' "$RUN_SESSION_ID"
}

emit_control_applied() {
  local action="$1"
  local signal_id="$2"
  local result="$3"
  local mode="${4:-checkpoint}"
  local session_id
  local payload

  session_id="$(ensure_run_session_id)"

  if [ -z "$session_id" ] || [ -z "$action" ]; then
    return 0
  fi

  payload="{\"sessionId\":\"$(dashboard_json_escape "$session_id")\",\"agentRunId\":\"$(dashboard_json_escape "$DASHBOARD_AGENT_RUN")\",\"action\":\"$(dashboard_json_escape "$action")\",\"signalId\":$(printf '%s' "${signal_id:-0}"),\"mode\":\"$(dashboard_json_escape "$mode")\",\"result\":\"$(dashboard_json_escape "$result")\",\"timestamp\":\"$(dashboard_json_escape "$(now_iso)")\"}"
  dashboard_notify "control_applied" "$payload"
}

is_terminal_status() {
  case "$1" in
    completed|failed|aborted|skipped)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

consume_signal() {
  local signal_id="$1"
  run_sql "
    UPDATE control_signals
    SET consumed_at = '$(sql_escape "$(now_iso)")'
    WHERE id = $(printf '%s' "$signal_id") AND consumed_at IS NULL;
  "
}

set_run_status() {
  local next_status="$1"
  local now

  now="$(now_iso)"

  case "$next_status" in
    completed|failed|aborted|skipped)
      run_sql "
        UPDATE agent_runs
        SET
          status = '$(sql_escape "$next_status")',
          finished_at = CASE WHEN finished_at IS NULL THEN '$(sql_escape "$now")' ELSE finished_at END
        WHERE id = '$(sql_escape "$DASHBOARD_AGENT_RUN")';
      "
      ;;
    *)
      run_sql "
        UPDATE agent_runs
        SET
          status = '$(sql_escape "$next_status")',
          finished_at = NULL
        WHERE id = '$(sql_escape "$DASHBOARD_AGENT_RUN")';
      "
      ;;
  esac
}

write_timeout_audit() {
  local details

  details='{"reason":"pause timeout auto-resume"}'

  run_sql "
    INSERT INTO audit_log (timestamp, actor, action, target_type, target_id, details)
    VALUES (
      '$(sql_escape "$(now_iso)")',
      'system',
      'control_timeout',
      'agent',
      '$(sql_escape "$DASHBOARD_AGENT_RUN")',
      '$(sql_escape "$details")'
    );
  "
}

handle_pause_loop() {
  local timeout_seconds
  local deadline

  if is_integer "$PAUSE_TIMEOUT_SECONDS" && [ "$PAUSE_TIMEOUT_SECONDS" -gt 0 ]; then
    timeout_seconds="$PAUSE_TIMEOUT_SECONDS"
  else
    timeout_seconds=1800
  fi

  set_run_status "paused"
  deadline=$(( $(date +%s) + timeout_seconds ))

  while [ "$(date +%s)" -lt "$deadline" ]; do
    local next
    local next_id
    local next_action
    local current_status

    current_status="$(fetch_run_status)"

    if is_terminal_status "$current_status"; then
      if [ "$current_status" = "aborted" ]; then
        emit_control_applied "abort" 0 "aborted" "immediate"
        printf '%s\n' "$ACTION_ABORT"
      else
        printf '%s\n' "$ACTION_CONTINUE"
      fi
      return 0
    fi

    next="$(fetch_next_signal)"

    if [ -z "$next" ]; then
      sleep 2
      continue
    fi

    next_id="${next%%|*}"
    next_action="${next#*|}"

    if ! is_integer "$next_id"; then
      sleep 2
      continue
    fi

    case "$next_action" in
      resume)
        consume_signal "$next_id"
        set_run_status "running"
        emit_control_applied "resume" "$next_id" "continued" "checkpoint"
        printf '%s\n' "$ACTION_CONTINUE"
        return 0
        ;;
      abort)
        consume_signal "$next_id"
        set_run_status "aborted"
        emit_control_applied "abort" "$next_id" "aborted" "checkpoint"
        printf '%s\n' "$ACTION_ABORT"
        return 0
        ;;
      skip)
        consume_signal "$next_id"
        set_run_status "running"
        emit_control_applied "skip" "$next_id" "skipped" "checkpoint"
        printf '%s\n' "$ACTION_SKIP"
        return 0
        ;;
      retry)
        consume_signal "$next_id"
        set_run_status "running"
        emit_control_applied "retry" "$next_id" "retrying" "checkpoint"
        printf '%s\n' "$ACTION_RETRY"
        return 0
        ;;
      pause)
        consume_signal "$next_id"
        emit_control_applied "pause" "$next_id" "paused" "checkpoint"
        ;;
      *)
        consume_signal "$next_id"
        ;;
    esac

    sleep 2
  done

  current_status="$(fetch_run_status)"

  if is_terminal_status "$current_status"; then
    if [ "$current_status" = "aborted" ]; then
      emit_control_applied "abort" 0 "aborted" "immediate"
      printf '%s\n' "$ACTION_ABORT"
    else
      printf '%s\n' "$ACTION_CONTINUE"
    fi
    return 0
  fi

  set_run_status "running"
  write_timeout_audit
  emit_control_applied "pause" 0 "timeout_resume" "checkpoint"
  printf '%s\n' "$ACTION_CONTINUE"
  return 0
}

if ! has_db || [ -z "$DASHBOARD_AGENT_RUN" ]; then
  printf '%s\n' "$ACTION_CONTINUE"
  exit 0
fi

current_status="$(fetch_run_status)"

if [ "$current_status" = "aborted" ]; then
  emit_control_applied "abort" 0 "aborted" "immediate"
  printf '%s\n' "$ACTION_ABORT"
  exit 0
fi

signal_row="$(fetch_next_signal)"

if [ -z "$signal_row" ]; then
  printf '%s\n' "$ACTION_CONTINUE"
  exit 0
fi

signal_id="${signal_row%%|*}"
signal_action="${signal_row#*|}"

if ! is_integer "$signal_id"; then
  printf '%s\n' "$ACTION_CONTINUE"
  exit 0
fi

case "$signal_action" in
  pause)
    consume_signal "$signal_id"
    emit_control_applied "pause" "$signal_id" "paused" "checkpoint"
    handle_pause_loop
    ;;
  resume)
    consume_signal "$signal_id"
    set_run_status "running"
    emit_control_applied "resume" "$signal_id" "continued" "checkpoint"
    printf '%s\n' "$ACTION_CONTINUE"
    ;;
  skip)
    consume_signal "$signal_id"
    set_run_status "running"
    emit_control_applied "skip" "$signal_id" "skipped" "checkpoint"
    printf '%s\n' "$ACTION_SKIP"
    ;;
  retry)
    consume_signal "$signal_id"
    set_run_status "running"
    emit_control_applied "retry" "$signal_id" "retrying" "checkpoint"
    printf '%s\n' "$ACTION_RETRY"
    ;;
  abort)
    consume_signal "$signal_id"
    set_run_status "aborted"
    emit_control_applied "abort" "$signal_id" "aborted" "checkpoint"
    printf '%s\n' "$ACTION_ABORT"
    ;;
  *)
    consume_signal "$signal_id"
    printf '%s\n' "$ACTION_CONTINUE"
    ;;
esac

exit 0
