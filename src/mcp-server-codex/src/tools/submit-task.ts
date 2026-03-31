import { z } from 'zod';

import { CodexClient } from '../codex-client.js';
import { TaskStore } from '../task-store.js';
import type { SubmitTaskInput, SubmitTaskOutput } from '../types.js';

const MAX_CONTEXT_BYTES = 100 * 1024;
const fileContextSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const submitTaskInputSchema = z.object({
  prompt: z.string().min(1),
  files_context: z.array(fileContextSchema),
  constraints: z.object({
    language: z.string().min(1),
    framework: z.string().min(1).optional(),
    style_guide: z.string().min(1).optional(),
    security_rules: z.array(z.string().min(1)).optional(),
  }),
  expected_output: z.object({
    files: z.array(z.string().min(1)).min(1),
    include_tests: z.boolean().optional(),
  }),
  config: z
    .object({
      timeout_seconds: z.number().int().positive().max(3_600).optional(),
      max_tokens: z.number().int().positive().max(200_000).optional(),
    })
    .optional(),
});

export interface SubmitTaskDependencies {
  taskStore: TaskStore;
  codexClient: CodexClient;
}

export async function handleSubmitTask(
  input: SubmitTaskInput,
  dependencies: SubmitTaskDependencies,
): Promise<SubmitTaskOutput> {
  const contextBytes = calculateContextBytes(input);

  if (contextBytes > MAX_CONTEXT_BYTES) {
    throw new Error(`Task context is too large (${contextBytes} bytes). Limit is ${MAX_CONTEXT_BYTES} bytes.`);
  }

  const task = dependencies.taskStore.create({
    prompt: input.prompt,
    files_context: input.files_context,
    constraints: input.constraints,
    expected_output: input.expected_output,
    config: input.config,
  });

  const instructions = buildInstructions(input);

  void runTask(task.task_id, instructions, input, dependencies);

  return {
    task_id: task.task_id,
    status: 'queued',
  };
}

async function runTask(
  taskId: string,
  instructions: string,
  input: SubmitTaskInput,
  dependencies: SubmitTaskDependencies,
): Promise<void> {
  let responseId: string | undefined;

  try {
    responseId = await dependencies.codexClient.submit({
      taskId,
      instructions,
      maxOutputTokens: input.config?.max_tokens,
      timeoutSeconds: input.config?.timeout_seconds,
    });
    const currentTask = dependencies.taskStore.get(taskId);

    if (!currentTask || currentTask.status === 'cancelled') {
      if (responseId) {
        await dependencies.codexClient.cancel(responseId).catch(() => undefined);
      }
      return;
    }

    dependencies.taskStore.updateStatus(taskId, 'running', {
      response_id: responseId,
      error: undefined,
    });

    const result = await dependencies.codexClient.waitForResult(responseId, input.config?.timeout_seconds);
    const latestTask = dependencies.taskStore.get(taskId);

    if (!latestTask || latestTask.status === 'cancelled') {
      return;
    }

    if (result.status === 'completed') {
      dependencies.taskStore.updateStatus(taskId, 'completed', {
        response_id: result.response_id,
        files_generated: result.files,
        logs: result.logs,
        tests_passed: result.tests_passed,
        usage: result.usage,
        error: undefined,
      });
      return;
    }

    if (result.status === 'cancelled') {
      dependencies.taskStore.updateStatus(taskId, 'cancelled', {
        response_id: result.response_id,
        logs: result.logs,
        usage: result.usage,
        error: undefined,
      });
      return;
    }

    dependencies.taskStore.updateStatus(taskId, 'failed', {
      response_id: result.response_id,
      logs: result.logs,
      usage: result.usage,
      error: result.error ?? 'Task execution failed',
    });
  } catch (error) {
    const latestTask = dependencies.taskStore.get(taskId);

    if (!latestTask || latestTask.status === 'cancelled') {
      return;
    }

    dependencies.taskStore.updateStatus(taskId, 'failed', {
      response_id: responseId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function calculateContextBytes(input: SubmitTaskInput): number {
  const promptBytes = Buffer.byteLength(input.prompt, 'utf8');
  const fileBytes = input.files_context.reduce((total, file) => {
    return total + Buffer.byteLength(file.path, 'utf8') + Buffer.byteLength(file.content, 'utf8');
  }, 0);

  return promptBytes + fileBytes;
}

function buildInstructions(input: SubmitTaskInput): string {
  const sections = [
    'Implement the following coding task.',
    '',
    'Task:',
    input.prompt.trim(),
    '',
    'Constraints:',
    formatConstraints(input),
    '',
    'Expected output:',
    formatExpectedOutput(input),
    '',
    'Project context files:',
    formatFilesContext(input),
    '',
    'Response contract:',
    '- Return valid JSON only.',
    '- files[].operation must be one of create|modify|delete|rename.',
    '- files[].path is required for every item.',
    '- For create/modify/rename, include full content in files[].content.',
    '- For rename, include files[].old_path.',
    '- For delete, do not include files[].content.',
    '- Put a concise implementation summary and any validation notes into "logs".',
    '- Set "tests_passed" to true only when the relevant tests clearly pass; otherwise use false or omit it.',
  ];

  return sections.join('\n');
}

function formatConstraints(input: SubmitTaskInput): string {
  const lines = [`- language: ${input.constraints.language}`];

  if (input.constraints.framework) {
    lines.push(`- framework: ${input.constraints.framework}`);
  }

  if (input.constraints.style_guide) {
    lines.push(`- style_guide: ${input.constraints.style_guide}`);
  }

  if (input.constraints.security_rules && input.constraints.security_rules.length > 0) {
    lines.push(`- security_rules: ${input.constraints.security_rules.join('; ')}`);
  }

  return lines.join('\n');
}

function formatExpectedOutput(input: SubmitTaskInput): string {
  const lines = [`- files: ${input.expected_output.files.join(', ')}`];

  if (typeof input.expected_output.include_tests === 'boolean') {
    lines.push(`- include_tests: ${String(input.expected_output.include_tests)}`);
  }

  if (input.config?.timeout_seconds) {
    lines.push(`- timeout_seconds: ${input.config.timeout_seconds}`);
  }

  if (input.config?.max_tokens) {
    lines.push(`- max_tokens: ${input.config.max_tokens}`);
  }

  return lines.join('\n');
}

function formatFilesContext(input: SubmitTaskInput): string {
  if (input.files_context.length === 0) {
    return '- No file context supplied.';
  }

  return input.files_context
    .map((file) => {
      return [`File: ${file.path}`, '```', file.content, '```'].join('\n');
    })
    .join('\n\n');
}
