export type AgentType =
  | 'architect'
  | 'coder'
  | 'reviewer'
  | 'tester'
  | 'devops'
  | 'security'
  | 'uiux';

export type SessionStatus = 'running' | 'completed' | 'failed' | 'aborted';

export type SessionPhase =
  | 'planning'
  | 'implementing'
  | 'reviewing'
  | 'awaiting_approval'
  | 'applying'
  | 'testing'
  | 'completed'
  | 'failed'
  | 'aborted';

export type TriggerSource = 'dashboard' | 'api' | 'system' | 'hook' | 'approval';

export type AgentRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'skipped' | 'aborted';

export type EventType =
  | 'step_start'
  | 'step_end'
  | 'tool_call'
  | 'output'
  | 'error'
  | 'checkpoint'
  | 'changeset'
  | 'system';

export type ChangeSetStatus =
  | 'draft'
  | 'awaiting_approval'
  | 'approved'
  | 'applied'
  | 'rejected'
  | 'apply_failed'
  | 'test_failed';

export type ChangeFileStatus = 'create' | 'modify';

export type AuditActor = 'user' | 'system' | 'agent';
export type AuditAction = 'create' | 'update' | 'delete' | 'control' | 'trigger' | 'config_change';
export type AuditTargetType = 'project' | 'session' | 'agent' | 'change_set' | 'config' | 'command';

export interface ProjectCommandConfig {
  test_command?: string;
  lint_command?: string;
  build_command?: string;
}

export interface Project {
  id: string;
  name: string;
  root_path: string;
  language: string;
  framework: string | null;
  test_command: string | null;
  lint_command: string | null;
  build_command: string | null;
  ignore_paths: string[];
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  project_id: string;
  project_path: string;
  goal: string;
  start_time: string;
  end_time: string | null;
  status: SessionStatus;
  phase: SessionPhase;
  trigger_source: TriggerSource;
  metadata: Record<string, unknown> | null;
  active_change_set_id: string | null;
}

export interface AgentRun {
  id: string;
  session_id: string;
  agent_type: AgentType;
  started_at: string;
  finished_at: string | null;
  status: AgentRunStatus;
  trigger: string;
  input_summary: string | null;
  output_summary: string | null;
  step_current: number;
  step_total: number | null;
}

export interface AgentEvent {
  id: number;
  agent_run_id: string;
  session_id: string;
  timestamp: string;
  event_type: EventType;
  event_data: Record<string, unknown>;
}

export interface ChangeSetFile {
  path: string;
  status: ChangeFileStatus;
  before_content: string | null;
  after_content: string;
}

export interface ChangeSet {
  id: string;
  session_id: string;
  status: ChangeSetStatus;
  summary: string;
  review_notes: string;
  files: ChangeSetFile[];
  diff_text: string;
  test_command_snapshot: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  actor: AuditActor;
  action: AuditAction;
  target_type: AuditTargetType;
  target_id: string | null;
  details: Record<string, unknown> | null;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface SessionFilters {
  status?: SessionStatus;
  project_id?: string;
  page?: number;
  limit?: number;
}

export interface EventFilters {
  event_type?: EventType;
  page?: number;
  limit?: number;
}

export interface CreateProjectInput {
  name: string;
  root_path: string;
  language: string;
  framework?: string;
  test_command?: string;
  lint_command?: string;
  build_command?: string;
  ignore_paths?: string[];
}

export interface UpdateProjectInput extends CreateProjectInput {}

export interface CreateSessionInput {
  projectId: string;
  goal: string;
}

export interface ApproveChangeSetInput {
  runTests?: boolean;
}

export interface SessionDetail {
  session: Session;
  project: Project;
  agents: AgentRun[];
  changeSet: ChangeSet | null;
}

export interface OverviewData {
  activeSessions: Session[];
  recentEvents: AgentEvent[];
  projects: Project[];
  stats: DashboardStats;
}

export interface AgentStats {
  runs: number;
  successRate: number;
  avgDuration: number;
}

export interface DashboardStats {
  totals: {
    runs: number;
    successRate: number;
    avgDuration: number;
  };
  byAgent: Partial<Record<AgentType, AgentStats>>;
}

export interface WsAgentEvent {
  type: 'agent:event';
  data: {
    sessionId: string;
    agentRunId: string;
    agentType: AgentType;
    eventType: EventType;
    payload: Record<string, unknown>;
    timestamp: string;
  };
}

export interface WsAgentStatusChange {
  type: 'agent:status_change';
  data: {
    sessionId: string;
    agentRunId: string;
    agentType: AgentType;
    oldStatus: AgentRunStatus | null;
    newStatus: AgentRunStatus;
    timestamp: string;
  };
}

export interface WsSessionUpdate {
  type: 'session:update';
  data: {
    sessionId: string;
    phase: SessionPhase;
    status: SessionStatus;
    timestamp: string;
  };
}

export interface WsAgentControlSignal {
  type: 'agent:control_signal';
  data: {
    sessionId: string;
    agentRunId: string;
    action: 'pause' | 'resume' | 'skip' | 'retry' | 'abort';
    signalId: number;
    mode: 'checkpoint' | 'immediate';
    timestamp: string;
  };
}

export interface WsAgentControlApplied {
  type: 'agent:control_applied';
  data: {
    sessionId: string;
    agentRunId: string;
    action: 'pause' | 'resume' | 'skip' | 'retry' | 'abort';
    signalId: number;
    mode: 'checkpoint' | 'immediate';
    result: string;
    timestamp: string;
  };
}

export interface WsChangeSetUpdate {
  type: 'changeset:update';
  data: {
    sessionId: string;
    changeSetId: string;
    status: ChangeSetStatus;
    timestamp: string;
  };
}

export interface WsPing {
  type: 'ping';
}

export type WsServerMessage =
  | WsAgentEvent
  | WsAgentStatusChange
  | WsAgentControlSignal
  | WsAgentControlApplied
  | WsSessionUpdate
  | WsChangeSetUpdate
  | WsPing;

export interface WsSubscribe {
  type: 'subscribe';
  channels: string[];
}

export interface WsUnsubscribe {
  type: 'unsubscribe';
  channels: string[];
}

export interface WsPong {
  type: 'pong';
}

export type WsClientMessage = WsSubscribe | WsUnsubscribe | WsPong;

export interface ApiErrorResponse {
  error: string;
  code?: string;
  details?: unknown;
}
