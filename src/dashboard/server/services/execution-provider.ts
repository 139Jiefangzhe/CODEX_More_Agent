import { existsSync } from 'node:fs';
import path from 'node:path';

import { CodexExecutor } from './codex-executor.js';
import { McpStdioClient } from './mcp-stdio-client.js';

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function createExecutionProvider(config: any = {}) {
  const provider = normalizeProviderName(config.provider);

  if (provider === 'mcp') {
    return new McpExecutionProvider(config);
  }

  return new ResponsesExecutionProvider(config);
}

class ResponsesExecutionProvider {
  name: string;
  executor: CodexExecutor;

  constructor(config: any = {}) {
    this.name = 'responses';
    this.executor = new CodexExecutor({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutSeconds: config.timeoutSeconds,
      pollIntervalMs: config.pollIntervalMs,
    });
  }

  isConfigured() {
    return this.executor.isConfigured();
  }

  submitTask(taskId, instructions, maxOutputTokens, _options: any = {}) {
    return this.executor.submitTask(taskId, instructions, maxOutputTokens);
  }

  waitForResult(executionId, timeoutSeconds, options: any = {}) {
    return this.executor.waitForResult(executionId, timeoutSeconds, options);
  }

  cancel(executionId) {
    return this.executor.cancel(executionId);
  }

  async close() {
    return undefined;
  }
}

class McpExecutionProvider {
  name: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  pollIntervalMs: number;
  client: McpStdioClient;

  constructor(config: any = {}) {
    this.name = 'mcp';
    this.apiKey = String(config.apiKey || '').trim();
    this.model = String(config.model || 'gpt-5.3-codex').trim();
    this.timeoutSeconds = Number.isFinite(config.timeoutSeconds) && Number(config.timeoutSeconds) > 0
      ? Number(config.timeoutSeconds)
      : DEFAULT_TIMEOUT_SECONDS;
    this.pollIntervalMs = Number.isFinite(config.pollIntervalMs) && Number(config.pollIntervalMs) > 0
      ? Number(config.pollIntervalMs)
      : DEFAULT_POLL_INTERVAL_MS;

    const mcpCommand = String(config.mcpCommand || 'node').trim() || 'node';
    const mcpArgs = resolveMcpArgs(config);
    const mcpCwd = resolveMcpCwd(config, mcpArgs);

    this.client = new McpStdioClient({
      command: mcpCommand,
      args: mcpArgs,
      cwd: mcpCwd,
      env: {
        OPENAI_API_KEY: this.apiKey,
        OPENAI_BASE_URL: String(config.baseUrl || '').trim(),
        CODEX_MODEL: this.model,
        CODEX_TIMEOUT: String(this.timeoutSeconds),
      },
    });
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async submitTask(taskId, instructions, maxOutputTokens, options: any = {}) {
    this.assertConfigured();

    const result = await this.client.callTool('codex.submit_task', {
      prompt: String(instructions || ''),
      files_context: normalizeFilesContext(options.filesContext),
      constraints: buildConstraints(options),
      expected_output: {
        files: normalizeExpectedFiles(options.expectedOutputFiles),
        include_tests: Boolean(options.includeTests),
      },
      config: {
        timeout_seconds: Number.isFinite(options.timeoutSeconds) && Number(options.timeoutSeconds) > 0
          ? Number(options.timeoutSeconds)
          : this.timeoutSeconds,
        max_tokens: Number.isFinite(maxOutputTokens) && Number(maxOutputTokens) > 0
          ? Number(maxOutputTokens)
          : undefined,
      },
    });

    const returnedTaskId = String(result?.task_id || '').trim();

    if (!returnedTaskId) {
      throw new Error('codex.submit_task did not return task_id');
    }

    return returnedTaskId;
  }

  async waitForResult(executionId, timeoutSeconds = this.timeoutSeconds, options: any = {}) {
    this.assertConfigured();

    const startedAt = Date.now();
    const deadline = startedAt + Math.max(Number(timeoutSeconds) || this.timeoutSeconds, 1) * 1000;
    const onPending = typeof options.onPending === 'function' ? options.onPending : null;

    while (Date.now() <= deadline) {
      if (onPending) {
        await onPending({
          responseId: executionId,
          elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
        });
      }

      const payload = await this.client.callTool('codex.get_result', {
        task_id: executionId,
      });
      const status = String(payload?.status || '').trim().toLowerCase();

      if (!status || status === 'queued' || status === 'running') {
        await delay(this.pollIntervalMs);
        continue;
      }

      if (!TERMINAL_STATUSES.has(status)) {
        await delay(this.pollIntervalMs);
        continue;
      }

      const normalizedFiles = normalizeGeneratedFiles(payload?.files_generated);
      const usage = normalizeUsage(payload?.usage, startedAt);

      if (status === 'completed') {
        return {
          status: 'completed',
          responseId: executionId,
          files: normalizedFiles,
          logs: String(payload?.logs || ''),
          testsPassed: payload?.tests_passed === true,
          usage,
        };
      }

      if (status === 'cancelled') {
        return {
          status: 'cancelled',
          responseId: executionId,
          files: [],
          logs: String(payload?.logs || ''),
          testsPassed: false,
          usage,
          error: 'Task cancelled',
        };
      }

      return {
        status: 'failed',
        responseId: executionId,
        files: [],
        logs: String(payload?.logs || ''),
        testsPassed: false,
        usage,
        error: String(payload?.error || 'MCP task execution failed'),
      };
    }

    await this.cancel(executionId).catch(() => undefined);

    return {
      status: 'failed',
      responseId: executionId,
      files: [],
      logs: '',
      testsPassed: false,
      usage: {
        tokensIn: 0,
        tokensOut: 0,
        durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      },
      error: 'Timed out waiting for MCP task result',
    };
  }

  async cancel(executionId) {
    this.assertConfigured();
    await this.client.callTool('codex.cancel_task', {
      task_id: executionId,
    });
  }

  async close() {
    await this.client.close();
  }

  assertConfigured() {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
  }
}

function normalizeProviderName(value) {
  const provider = String(value || 'responses').trim().toLowerCase();
  return provider === 'mcp' ? 'mcp' : 'responses';
}

function parseArgsValue(value) {
  const source = String(value || '').trim();

  if (!source) {
    return [];
  }

  if (source.startsWith('[')) {
    try {
      const parsed = JSON.parse(source);
      return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
    } catch {
      return [];
    }
  }

  return source
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveMcpArgs(config: any = {}) {
  const explicitArgs = Array.isArray(config.mcpArgs) && config.mcpArgs.length > 0
    ? config.mcpArgs.map((entry) => String(entry))
    : parseArgsValue(config.mcpArgsRaw);

  if (explicitArgs.length > 0) {
    return explicitArgs;
  }

  const entryCandidates = [
    String(config.mcpEntry || '').trim(),
    path.resolve(process.cwd(), '../mcp-server-codex/dist/index.js'),
    path.resolve(process.cwd(), 'src/mcp-server-codex/dist/index.js'),
    path.resolve(process.cwd(), '../../src/mcp-server-codex/dist/index.js'),
  ].filter(Boolean);

  for (const candidate of entryCandidates) {
    if (existsSync(candidate)) {
      return [candidate];
    }
  }

  return ['dist/index.js'];
}

function resolveMcpCwd(config: any = {}, args: string[]) {
  if (config.mcpCwd) {
    return String(config.mcpCwd);
  }

  if (args.length === 0) {
    return undefined;
  }

  const firstArg = String(args[0] || '');

  if (!firstArg.endsWith('.js')) {
    return undefined;
  }

  const absoluteArg = path.isAbsolute(firstArg)
    ? firstArg
    : path.resolve(process.cwd(), firstArg);

  return path.dirname(path.dirname(absoluteArg));
}

function normalizeFilesContext(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map(function (file) {
      return {
        path: String(file?.path || '').trim(),
        content: String(file?.content || ''),
      };
    })
    .filter(function (file) {
      return file.path.length > 0;
    })
    .slice(0, 24);
}

function buildConstraints(options: any = {}) {
  const output: Record<string, unknown> = {
    language: String(options.language || 'unknown').trim() || 'unknown',
  };

  const framework = String(options.framework || '').trim();

  if (framework) {
    output.framework = framework;
  }

  const styleGuide = String(options.styleGuide || '').trim();

  if (styleGuide) {
    output.style_guide = styleGuide;
  }

  return output;
}

function normalizeExpectedFiles(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return ['__unspecified_output__.txt'];
  }

  const entries = value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .slice(0, 32);

  return entries.length > 0 ? entries : ['__unspecified_output__.txt'];
}

function normalizeGeneratedFiles(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const operation = normalizeFileOperation(entry?.operation);
      const pathValue = String(entry?.path || entry?.new_path || '').trim();
      const oldPath = String(entry?.old_path || '').trim();
      const content = typeof entry?.content === 'string' ? entry.content : '';

      if (!pathValue) {
        return null;
      }

      return {
        operation,
        path: pathValue,
        old_path: oldPath || null,
        content,
        diff: typeof entry?.diff === 'string' ? entry.diff : '',
      };
    })
    .filter(Boolean);
}

function normalizeFileOperation(value) {
  const operation = String(value || '').trim().toLowerCase();

  if (operation === 'create' || operation === 'modify' || operation === 'delete' || operation === 'rename') {
    return operation;
  }

  return 'modify';
}

function normalizeUsage(value, startedAt) {
  return {
    tokensIn: Number(value?.tokens_in ?? 0) || 0,
    tokensOut: Number(value?.tokens_out ?? 0) || 0,
    durationSeconds: Number(value?.duration_seconds ?? Number(((Date.now() - startedAt) / 1000).toFixed(2))) || 0,
  };
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}
