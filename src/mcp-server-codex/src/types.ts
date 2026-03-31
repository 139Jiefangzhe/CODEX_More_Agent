export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface FileContext {
  path: string;
  content: string;
}

export interface TaskConstraints {
  language: string;
  framework?: string;
  style_guide?: string;
  security_rules?: string[];
}

export interface ExpectedOutput {
  files: string[];
  include_tests?: boolean;
}

export interface TaskConfig {
  timeout_seconds?: number;
  max_tokens?: number;
}

export interface SubmitTaskInput {
  prompt: string;
  files_context: FileContext[];
  constraints: TaskConstraints;
  expected_output: ExpectedOutput;
  config?: TaskConfig;
}

export interface GetResultInput {
  task_id: string;
}

export interface CancelTaskInput {
  task_id: string;
}

export interface GeneratedFile {
  operation?: 'create' | 'modify' | 'delete' | 'rename';
  path: string;
  old_path?: string;
  content?: string;
  diff?: string;
}

export interface UsageInfo {
  tokens_in: number;
  tokens_out: number;
  duration_seconds: number;
}

export interface SubmitTaskOutput {
  task_id: string;
  status: 'queued' | 'running';
}

export interface GetResultOutput {
  task_id: string;
  status: TaskStatus;
  files_generated?: GeneratedFile[];
  logs?: string;
  tests_passed?: boolean;
  error?: string;
  usage?: UsageInfo;
}

export interface TaskSummary {
  task_id: string;
  status: TaskStatus;
  prompt_summary: string;
  created_at: string;
  completed_at?: string;
}

export interface ListTasksOutput {
  tasks: TaskSummary[];
}

export interface CancelTaskOutput {
  ok: boolean;
  message: string;
}

export interface CreateTaskParams {
  prompt: string;
  files_context: FileContext[];
  constraints: TaskConstraints;
  expected_output: ExpectedOutput;
  config?: TaskConfig;
}

export interface TaskRecord {
  task_id: string;
  status: TaskStatus;
  prompt_summary: string;
  created_at: string;
  completed_at?: string;
  full_prompt: string;
  files_context: FileContext[];
  constraints: TaskConstraints;
  expected_output: ExpectedOutput;
  config?: TaskConfig;
  response_id?: string;
  files_generated?: GeneratedFile[];
  logs?: string;
  tests_passed?: boolean;
  error?: string;
  usage?: UsageInfo;
}

export interface TaskStoreOptions {
  cleanupIntervalMs?: number;
  retentionMs?: number;
  maxRecords?: number;
  storagePath?: string;
}

export interface CodexClientConfig {
  apiKey?: string;
  model: string;
  timeoutSeconds: number;
  pollIntervalMs?: number;
}

export interface CodexTask {
  taskId: string;
  instructions: string;
  maxOutputTokens?: number;
  timeoutSeconds?: number;
}

export interface CodexExecutionPayload {
  files: GeneratedFile[];
  logs: string;
  tests_passed?: boolean;
}

export interface CodexResult {
  response_id: string;
  status: 'completed' | 'failed' | 'cancelled';
  files: GeneratedFile[];
  logs: string;
  tests_passed?: boolean;
  usage: UsageInfo;
  error?: string;
}
