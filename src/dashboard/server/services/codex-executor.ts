import { ResponsesHttpClient, normalizeBaseUrl } from './openai-responses-client.js';

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
};
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'incomplete', 'expired']);
const CREATE_MAX_ATTEMPTS = 3;
const SYSTEM_PROMPT = [
  'You are gpt-5.3-codex acting as the implementation worker underneath a gpt-5.4 orchestrator.',
  'Focus on concrete code changes, not architecture discussion.',
  'Return valid JSON only.',
  'Use exactly these top-level keys: files, logs, tests_passed.',
  'Each entry in files must include operation and path.',
  'Supported operations: create, modify, delete, rename.',
  'For create/modify/rename operations, include the full resulting file content.',
  'For rename operations, include old_path and set path/new_path to the destination path.',
  'For delete operations, do not include content.',
  'Do not wrap the output in markdown fences.'
].join('\n');

export class CodexExecutor {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string;
  timeoutSeconds: number;
  pollIntervalMs: number;
  client: ResponsesHttpClient | null;
  cachedResponses: Map<string, any>;

  constructor(config) {
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.model = config.model;
    this.timeoutSeconds = config.timeoutSeconds ?? 600;
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
    this.client = config.apiKey ? new ResponsesHttpClient({ apiKey: config.apiKey, baseUrl: this.baseUrl }) : null;
    this.cachedResponses = new Map();
  }

  async submitTask(taskId, instructions, maxOutputTokens) {
    this.assertConfigured();
    const requestBody = {
      model: this.model,
      background: true,
      instructions: SYSTEM_PROMPT,
      input: instructions,
      max_output_tokens: maxOutputTokens,
      metadata: { task_id: taskId },
      text: {
        verbosity: 'high',
      },
    };

    let response;

    try {
      response = await this.getClient().create(requestBody, { maxAttempts: CREATE_MAX_ATTEMPTS });
    } catch (error) {
      if (!isUnsupportedBackgroundError(error)) {
        throw error;
      }

      const fallbackBody = {
        ...requestBody,
      };

      delete fallbackBody.background;
      response = await this.getClient().create(fallbackBody, { maxAttempts: CREATE_MAX_ATTEMPTS });
    }

    if (!response?.id) {
      throw new Error('No response id returned from gpt-5.3-codex');
    }

    if (response.status && response.status !== 'in_progress' && response.status !== 'queued') {
      this.cachedResponses.set(response.id, response);
    }

    return response.id;
  }

  async waitForResult(responseId, timeoutSeconds = this.timeoutSeconds, options: any = {}): Promise<any> {
    this.assertConfigured();
    const startedAt = Date.now();
    const deadline = startedAt + timeoutSeconds * 1000;
    const cachedResponse = this.cachedResponses.get(responseId);
    const onPending = typeof options.onPending === 'function' ? options.onPending : null;
    const pollIntervalMs =
      Number.isFinite(options.pollIntervalMs) && Number(options.pollIntervalMs) > 0
        ? Number(options.pollIntervalMs)
        : this.pollIntervalMs;

    if (cachedResponse) {
      this.cachedResponses.delete(responseId);
      return buildResultFromResponse(cachedResponse, startedAt);
    }

    while (Date.now() <= deadline) {
      if (onPending) {
        await onPending({
          responseId,
          elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
        });
      }

      let response;

      try {
        response = await this.getClient().retrieve(responseId, {
          maxAttempts: 1,
          timeoutMs: pollIntervalMs,
        });
      } catch (error) {
        if (isTransientPollError(error)) {
          await delay(pollIntervalMs);
          continue;
        }

        throw error;
      }

      const status = String(response.status ?? '');

      if (status === 'completed') {
        return buildCompletedResult(response, startedAt);
      }

      if (status === 'cancelled') {
        return buildCancelledResult(response, startedAt);
      }

      if (TERMINAL_FAILURE_STATUSES.has(status)) {
        return buildFailedResult(response, startedAt);
      }

      await delay(pollIntervalMs);
    }

    await this.cancel(responseId).catch(function () {
      return undefined;
    });

    return {
      status: 'failed',
      responseId,
      files: [],
      logs: '',
      testsPassed: false,
      usage: {
        tokensIn: 0,
        tokensOut: 0,
        durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      },
      error: 'Timed out waiting for gpt-5.3-codex result',
    };
  }

  async cancel(responseId) {
    this.assertConfigured();
    this.cachedResponses.delete(responseId);
    await this.getClient().cancel(responseId, { maxAttempts: 2 });
  }

  assertConfigured() {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  getClient() {
    this.assertConfigured();

    if (!this.client) {
      this.client = new ResponsesHttpClient({ apiKey: this.apiKey, baseUrl: this.baseUrl });
    }

    return this.client;
  }
}

export function buildCodexInstructions(input) {
  const sections = [
    'Implement the following coding task.',
    '',
    'Goal:',
    input.goal,
    '',
    'Architecture summary:',
    input.plan.architecture_summary,
    '',
    'Implementation plan:',
    input.plan.implementation_plan,
    '',
    'Review focus:',
    '- ' + input.plan.review_focus.join('\n- '),
    '',
    'Constraints:',
    '- language: ' + input.project.language,
    '- framework: ' + (input.project.framework ?? 'unknown'),
    '- test command: ' + (input.project.test_command ?? 'not configured'),
    '',
    'Expected output files:',
    '- ' + input.plan.expected_output_files.join('\n- '),
    '',
    'Project context files:',
    formatContextFiles(input.filesContext),
    '',
    'Response contract:',
    '- Return valid JSON only.',
    '- files[].operation must be one of create|modify|delete|rename.',
    '- files[].path is required for every item.',
    '- For create/modify/rename, include full file content in files[].content.',
    '- For rename, include files[].old_path and destination in files[].path.',
    '- For delete, omit files[].content.',
    '- Put implementation notes into logs.',
    '- Only set tests_passed to true if you are certain the relevant tests passed in the execution environment.'
  ];

  return sections.join('\n');
}

function buildCompletedResult(response, startedAt) {
  const parsed = normalizeCodexPayload(parseResultPayload(extractOutputText(response)));

  return {
    status: 'completed',
    responseId: response.id,
    files: parsed.files ?? [],
    logs: parsed.logs ?? '',
    testsPassed: parsed.tests_passed ?? false,
    usage: toUsage(response, startedAt),
  };
}

function parseResultPayload(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Invalid JSON from gpt-5.3-codex: ' + (error instanceof Error ? error.message : String(error)));
  }
}

function normalizeCodexPayload(payload) {
  const fileEntries = Array.isArray(payload?.files)
    ? payload.files
    : Array.isArray(payload?.generated_files)
      ? payload.generated_files
      : [];

  return {
    files: fileEntries
      .map(function (entry) {
        const operation = normalizeFileOperation(entry?.operation);
        const targetPath = firstString(entry?.path, entry?.new_path, entry?.file, entry?.filename);
        const oldPath = firstString(entry?.old_path, entry?.from_path, entry?.source_path);

        return {
          operation,
          path: targetPath,
          old_path: oldPath || null,
          content: firstString(entry?.content, entry?.after_content, entry?.text, entry?.full_content),
          diff: firstString(entry?.diff, entry?.patch),
        };
      })
      .filter(function (entry) {
        if (!entry.path) {
          return false;
        }

        if (entry.operation === 'delete') {
          return true;
        }

        if (entry.operation === 'rename') {
          return Boolean(entry.old_path);
        }

        return Boolean(entry.content);
      }),
    logs: firstString(payload?.logs, payload?.summary, payload?.notes),
    tests_passed: payload?.tests_passed === true || payload?.testsPassed === true,
  };
}

function normalizeFileOperation(value) {
  const operation = String(value || '').trim().toLowerCase();

  if (operation === 'create' || operation === 'modify' || operation === 'delete' || operation === 'rename') {
    return operation;
  }

  return 'modify';
}

function buildFailedResult(response, startedAt) {
  return {
    status: 'failed',
    responseId: response.id,
    files: [],
    logs: extractOutputText(response),
    testsPassed: false,
    usage: toUsage(response, startedAt),
    error: response.error?.message ?? response.incomplete_details?.reason ?? 'Codex execution failed',
  };
}

function buildCancelledResult(response, startedAt) {
  return {
    status: 'cancelled',
    responseId: response.id,
    files: [],
    logs: extractOutputText(response),
    testsPassed: false,
    usage: toUsage(response, startedAt),
    error: 'Task cancelled',
  };
}

function toUsage(response, startedAt) {
  return {
    tokensIn: response.usage?.input_tokens ?? 0,
    tokensOut: response.usage?.output_tokens ?? 0,
    durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
  };
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const fragments = [];
  collectText(response.output, fragments);
  return fragments.join('\n').trim();
}

function collectText(value, fragments) {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectText(entry, fragments);
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  if (typeof value.text === 'string') {
    fragments.push(value.text);
  }

  if (Array.isArray(value.content)) {
    collectText(value.content, fragments);
  }
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function formatContextFiles(files) {
  if (!files.length) {
    return '- No context files supplied';
  }

  return files.map(function (file) {
    return ['File: ' + file.path, '```', file.content, '```'].join('\n');
  }).join('\n\n');
}

function buildResultFromResponse(response, startedAt) {
  const status = String(response.status ?? '');

  if (status === 'completed') {
    return buildCompletedResult(response, startedAt);
  }

  if (status === 'cancelled') {
    return buildCancelledResult(response, startedAt);
  }

  return buildFailedResult(response, startedAt);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function isTransientPollError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('aborted') ||
    message.includes('AbortError') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ECONNRESET') ||
    message.includes('fetch failed') ||
    message.includes('OpenAI relay request failed (408)') ||
    message.includes('OpenAI relay request failed (429)') ||
    message.includes('OpenAI relay request failed (500)') ||
    message.includes('OpenAI relay request failed (502)') ||
    message.includes('OpenAI relay request failed (503)') ||
    message.includes('OpenAI relay request failed (504)')
  );
}

function isUnsupportedBackgroundError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Unsupported parameter: background');
}
