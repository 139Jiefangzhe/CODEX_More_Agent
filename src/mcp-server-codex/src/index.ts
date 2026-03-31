import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { CodexClient } from './codex-client.js';
import { TaskStore } from './task-store.js';
import { handleCancelTask, cancelTaskInputSchema } from './tools/cancel-task.js';
import { handleGetResult, getResultInputSchema } from './tools/get-result.js';
import { handleListTasks, listTasksInputSchema } from './tools/list-tasks.js';
import { handleSubmitTask, submitTaskInputSchema } from './tools/submit-task.js';

const DEFAULT_MODEL = 'gpt-5.3-codex';
const DEFAULT_TIMEOUT_SECONDS = 300;

async function main(): Promise<void> {
  const server = new McpServer({
    name: 'mcp-server-codex',
    version: '0.1.0',
  });
  const taskStore = new TaskStore();
  const codexClient = new CodexClient({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.CODEX_MODEL?.trim() || DEFAULT_MODEL,
    timeoutSeconds: parseTimeout(process.env.CODEX_TIMEOUT),
  });

  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not configured. codex.submit_task will fail until it is set.');
  }

  server.registerTool(
    'codex.submit_task',
    {
      description: 'Submit a coding task to the gpt-5.3-codex execution layer.',
      inputSchema: submitTaskInputSchema,
    },
    async (input) => {
      return wrapToolResult(await handleSubmitTask(input, { taskStore, codexClient }));
    },
  );

  server.registerTool(
    'codex.get_result',
    {
      description: 'Get the current status and result for a submitted coding task.',
      inputSchema: getResultInputSchema,
    },
    async (input) => {
      return wrapToolResult(await handleGetResult(input, { taskStore }));
    },
  );

  server.registerTool(
    'codex.list_tasks',
    {
      description: 'List all coding tasks known to the current MCP server process.',
      inputSchema: listTasksInputSchema,
    },
    async (input) => {
      return wrapToolResult(await handleListTasks(input, { taskStore }));
    },
  );

  server.registerTool(
    'codex.cancel_task',
    {
      description: 'Cancel a queued or running coding task.',
      inputSchema: cancelTaskInputSchema,
    },
    async (input) => {
      return wrapToolResult(await handleCancelTask(input, { taskStore, codexClient }));
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function wrapToolResult(payload: unknown) {
  const structuredContent = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent,
  };
}

function parseTimeout(value: string | undefined): number {
  if (!value) {
    return DEFAULT_TIMEOUT_SECONDS;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_SECONDS;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
