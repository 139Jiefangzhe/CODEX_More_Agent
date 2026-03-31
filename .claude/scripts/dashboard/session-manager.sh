#!/usr/bin/env bash
# Dashboard 会话生命周期管理

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEFAULT_DB="$REPO_ROOT/src/dashboard/data/dashboard.db"
DASHBOARD_DB="${DASHBOARD_DB:-$DEFAULT_DB}"
DASHBOARD_SCRIPT_DIR="$SCRIPT_DIR"
DASHBOARD_REPO_ROOT="$REPO_ROOT"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/db-utils.sh"

command="${1:-}"

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

gen_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
    return
  fi

  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
    return
  fi

  printf '%s-%s-%s' "$(date +%s)" "$RANDOM" "$RANDOM"
}

start_session() {
  local project_path="${1:-}"
  local trigger_source="${2:-cli}"
  local goal="${DASHBOARD_GOAL:-CLI session}"

  if [ -z "$project_path" ] || ! has_db; then
    printf '\n'
    return 0
  fi

  local project_path_escaped
  local trigger_source_escaped
  local goal_escaped
  local project_id
  local session_id
  local now

  project_path_escaped="$(sql_escape "$project_path")"
  trigger_source_escaped="$(sql_escape "$trigger_source")"
  goal_escaped="$(sql_escape "$goal")"

  project_id="$(run_sql "SELECT id FROM projects WHERE root_path = '$project_path_escaped' LIMIT 1;")"

  if [ -z "$project_id" ]; then
    printf '\n'
    return 0
  fi

  session_id="$(gen_uuid)"
  now="$(now_iso)"

  run_sql "
    INSERT INTO sessions (
      id, project_id, project_path, goal,
      start_time, status, phase, trigger_source,
      metadata, active_change_set_id
    ) VALUES (
      '$(sql_escape "$session_id")',
      '$(sql_escape "$project_id")',
      '$project_path_escaped',
      '$goal_escaped',
      '$(sql_escape "$now")',
      'running',
      'planning',
      '$trigger_source_escaped',
      '{}',
      NULL
    );
  "

  if [ "$?" -eq 0 ]; then
    printf '%s\n' "$session_id"
  else
    printf '\n'
  fi

  return 0
}

start_agent_run() {
  local session_id="${1:-}"
  local agent_type="${2:-}"
  local trigger="${3:-hook}"
  local input_summary="${DASHBOARD_AGENT_INPUT_SUMMARY:-Agent run started via session-manager}"
  local step_total="${DASHBOARD_AGENT_STEP_TOTAL:-}"

  if [ -z "$session_id" ] || [ -z "$agent_type" ] || ! has_db; then
    printf '\n'
    return 0
  fi

  local session_exists
  session_exists="$(run_sql "SELECT 1 FROM sessions WHERE id = '$(sql_escape "$session_id")' LIMIT 1;")"

  if [ "$session_exists" != "1" ]; then
    printf '\n'
    return 0
  fi

  local agent_run_id
  local now
  local step_total_sql

  if is_integer "$step_total"; then
    step_total_sql="$step_total"
  else
    step_total_sql="NULL"
  fi

  agent_run_id="$(gen_uuid)"
  now="$(now_iso)"

  run_sql "
    INSERT INTO agent_runs (
      id, session_id, agent_type,
      started_at, finished_at, status, trigger,
      input_summary, output_summary, step_current, step_total
    ) VALUES (
      '$(sql_escape "$agent_run_id")',
      '$(sql_escape "$session_id")',
      '$(sql_escape "$agent_type")',
      '$(sql_escape "$now")',
      NULL,
      'running',
      '$(sql_escape "$trigger")',
      '$(sql_escape "$input_summary")',
      NULL,
      0,
      $step_total_sql
    );
  "

  if [ "$?" -eq 0 ]; then
    printf '%s\n' "$agent_run_id"
  else
    printf '\n'
  fi

  return 0
}

end_agent_run() {
  local agent_run_id="${1:-}"
  local status="${2:-completed}"
  local output_summary="${DASHBOARD_AGENT_OUTPUT_SUMMARY:-}"

  if [ -z "$agent_run_id" ] || ! has_db; then
    return 0
  fi

  local now
  now="$(now_iso)"

  run_sql "
    UPDATE agent_runs
    SET
      status = '$(sql_escape "$status")',
      finished_at = '$(sql_escape "$now")',
      output_summary = CASE
        WHEN '$(sql_escape "$output_summary")' = '' THEN output_summary
        ELSE '$(sql_escape "$output_summary")'
      END
    WHERE id = '$(sql_escape "$agent_run_id")';
  "

  return 0
}

end_session() {
  local session_id="${1:-}"
  local status="${2:-completed}"

  if [ -z "$session_id" ] || ! has_db; then
    return 0
  fi

  local phase
  local now

  case "$status" in
    aborted)
      phase="aborted"
      ;;
    failed)
      phase="failed"
      ;;
    *)
      phase="completed"
      status="completed"
      ;;
  esac

  now="$(now_iso)"

  run_sql "
    UPDATE sessions
    SET
      status = '$(sql_escape "$status")',
      phase = '$(sql_escape "$phase")',
      end_time = '$(sql_escape "$now")'
    WHERE id = '$(sql_escape "$session_id")';
  "

  run_sql "
    UPDATE agent_runs
    SET
      status = 'aborted',
      finished_at = CASE WHEN finished_at IS NULL THEN '$(sql_escape "$now")' ELSE finished_at END
    WHERE
      session_id = '$(sql_escape "$session_id")'
      AND status IN ('pending', 'running', 'paused');
  "

  return 0
}

case "$command" in
  start)
    start_session "$2" "$3"
    ;;
  agent-start)
    start_agent_run "$2" "$3" "$4"
    ;;
  agent-end)
    end_agent_run "$2" "$3"
    ;;
  end)
    end_session "$2" "$3"
    ;;
  *)
    printf '\n'
    ;;
esac

exit 0
