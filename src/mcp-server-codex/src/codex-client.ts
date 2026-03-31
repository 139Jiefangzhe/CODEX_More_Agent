import OpenAI from 'openai';

import type {
  CodexClientConfig,
  CodexExecutionPayload,
  CodexResult,
  CodexTask,
  UsageInfo,
} from './types.js';

interface ApiResponse {
  id?: string;
  status?: string;
  output_text?: string;
  output?: unknown;
  error?: {
    message?: string;
  };
  incomplete_details?: {
    reason?: string;
  };
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
  };
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'incomplete', 'expired']);
const RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files', 'logs'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          operation: {
            type: 'string',
            enum: ['create', 'modify', 'delete', 'rename'],
          },
          path: { type: 'string' },
          old_path: { type: 'string' },
          new_path: { type: 'string' },
          content: { type: 'string' },
          diff: { type: 'string' },
        },
      },
    },
    logs: { type: 'string' },
    tests_passed: { type: 'boolean' },
  },
} as const;
const SYSTEM_PROMPT = [
  'You are gpt-5.3-codex acting as the implementation worker underneath a gpt-5.4 orchestrator.',
  'Focus on concrete code execution, not architecture commentary.',
  'Return strictly valid JSON matching the provided schema.',
  'Each file entry must include operation and path.',
  'Supported operations: create, modify, delete, rename.',
  'For create/modify/rename, return full resulting content in content.',
  'For rename, include old_path.',
  'For delete, do not include content.',
  'Do not wrap the JSON in markdown fences.',
].join('\n');

export class CodexClient {
  private readonly client: OpenAI;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly timeoutSeconds: number;
  private readonly pollIntervalMs: number;

  constructor(config: CodexClientConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutSeconds = config.timeoutSeconds;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.client = new OpenAI({ apiKey: this.apiKey });
  }

  async submit(task: CodexTask): Promise<string> {
    this.assertConfigured();

    const response = await this.client.responses.create({
      model: this.model,
      background: true,
      instructions: SYSTEM_PROMPT,
      input: task.instructions,
      max_output_tokens: task.maxOutputTokens,
      metadata: {
        task_id: task.taskId,
      },
      text: {
        format: {
          type: 'json_schema',
          name: 'codex_task_result',
          schema: RESULT_JSON_SCHEMA,
          strict: true,
        },
        verbosity: 'high',
      },
    });

    return response.id;
  }

  async waitForResult(responseId: string, timeoutSeconds = this.timeoutSeconds): Promise<CodexResult> {
    this.assertConfigured();

    const startedAt = Date.now();
    const deadline = startedAt + Math.max(timeoutSeconds, 1) * 1_000;

    while (Date.now() <= deadline) {
      const response = (await this.client.responses.retrieve(responseId)) as unknown as ApiResponse;
      const status = String(response.status ?? '');

      if (status === 'completed') {
        return buildCompletedResult(response, responseId, startedAt);
      }

      if (status === 'cancelled') {
        return buildCancelledResult(response, responseId, startedAt);
      }

      if (TERMINAL_FAILURE_STATUSES.has(status)) {
        return buildFailedResult(response, responseId, startedAt);
      }

      await delay(this.pollIntervalMs);
    }

    await this.cancel(responseId).catch(() => undefined);

    return {
      response_id: responseId,
      status: 'failed',
      files: [],
      logs: '',
      usage: {
        tokens_in: 0,
        tokens_out: 0,
        duration_seconds: toDurationSeconds(startedAt),
      },
      error: `Timed out after ${timeoutSeconds} seconds`,
    };
  }

  async cancel(responseId: string): Promise<void> {
    this.assertConfigured();
    await this.client.responses.cancel(responseId);
  }

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
  }
}

function buildCompletedResult(response: ApiResponse, responseId: string, startedAt: number): CodexResult {
  const rawOutput = extractOutputText(response);
  const parsedOutput = parseExecutionPayload(rawOutput);

  return {
    response_id: response.id ?? responseId,
    status: 'completed',
    files: parsedOutput.files,
    logs: parsedOutput.logs,
    tests_passed: parsedOutput.tests_passed,
    usage: toUsageInfo(response, startedAt),
  };
}

function buildFailedResult(response: ApiResponse, responseId: string, startedAt: number): CodexResult {
  return {
    response_id: response.id ?? responseId,
    status: 'failed',
    files: [],
    logs: extractOutputText(response),
    usage: toUsageInfo(response, startedAt),
    error: extractErrorMessage(response),
  };
}

function buildCancelledResult(response: ApiResponse, responseId: string, startedAt: number): CodexResult {
  return {
    response_id: response.id ?? responseId,
    status: 'cancelled',
    files: [],
    logs: extractOutputText(response),
    usage: toUsageInfo(response, startedAt),
    error: 'Task cancelled',
  };
}

function parseExecutionPayload(rawOutput: string): CodexExecutionPayload {
  const cleanedOutput = rawOutput
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  const parsedJson = JSON.parse(cleanedOutput) as any;
  return normalizeExecutionPayload(parsedJson);
}

function normalizeExecutionPayload(payload: any): CodexExecutionPayload {
  const entries = Array.isArray(payload?.files) ? payload.files : [];

  return {
    files: entries
      .map((entry: any) => {
        const operation = normalizeOperation(entry?.operation);
        const pathValue = firstString(entry?.path, entry?.new_path, entry?.file, entry?.filename);
        const oldPath = firstString(entry?.old_path, entry?.from_path, entry?.source_path);
        const content = firstString(entry?.content, entry?.after_content, entry?.text, entry?.full_content);
        const diff = firstString(entry?.diff, entry?.patch);

        if (!pathValue) {
          return null;
        }

        if (operation === 'delete') {
          return {
            operation,
            path: pathValue,
            diff,
          };
        }

        if (operation === 'rename') {
          if (!oldPath) {
            return null;
          }

          return {
            operation,
            path: pathValue,
            old_path: oldPath,
            content: content || undefined,
            diff,
          };
        }

        if (!content) {
          return null;
        }

        return {
          operation,
          path: pathValue,
          content,
          diff,
        };
      })
      .filter((entry: any): entry is any => Boolean(entry)),
    logs: firstString(payload?.logs, payload?.summary, payload?.notes),
    tests_passed: payload?.tests_passed === true || payload?.testsPassed === true,
  };
}

function normalizeOperation(value: unknown): 'create' | 'modify' | 'delete' | 'rename' {
  const operation = String(value ?? '').trim().toLowerCase();

  if (operation === 'create' || operation === 'modify' || operation === 'delete' || operation === 'rename') {
    return operation;
  }

  return 'modify';
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return '';
}

function extractOutputText(response: ApiResponse): string {
  if (typeof response.output_text === 'string' && response.output_text.trim().length > 0) {
    return response.output_text.trim();
  }

  const fragments: string[] = [];
  collectTextFragments(response.output, fragments);
  return fragments.join('\n').trim();
}

function collectTextFragments(value: unknown, fragments: string[]): void {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTextFragments(entry, fragments);
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.text === 'string') {
    fragments.push(record.text);
  }

  if (Array.isArray(record.content)) {
    collectTextFragments(record.content, fragments);
  }
}

function extractErrorMessage(response: ApiResponse): string {
  if (typeof response.error?.message === 'string' && response.error.message.length > 0) {
    return response.error.message;
  }

  if (typeof response.incomplete_details?.reason === 'string' && response.incomplete_details.reason.length > 0) {
    return response.incomplete_details.reason;
  }

  return `Response finished with status ${String(response.status ?? 'unknown')}`;
}

function toUsageInfo(response: ApiResponse, startedAt: number): UsageInfo {
  const usage = response.usage;
  return {
    tokens_in: usage?.input_tokens ?? 0,
    tokens_out: usage?.output_tokens ?? 0,
    duration_seconds: toDurationSeconds(startedAt),
  };
}

function toDurationSeconds(startedAt: number): number {
  return Number(((Date.now() - startedAt) / 1_000).toFixed(2));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
