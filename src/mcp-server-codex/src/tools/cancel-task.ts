import { z } from 'zod';

import { CodexClient } from '../codex-client.js';
import { TaskStore } from '../task-store.js';
import type { CancelTaskOutput } from '../types.js';

export const cancelTaskInputSchema = z.object({
  task_id: z.string().min(1),
});

export interface CancelTaskDependencies {
  taskStore: TaskStore;
  codexClient: CodexClient;
}

export async function handleCancelTask(
  input: z.infer<typeof cancelTaskInputSchema>,
  dependencies: CancelTaskDependencies,
): Promise<CancelTaskOutput> {
  const task = dependencies.taskStore.get(input.task_id);

  if (!task) {
    return {
      ok: false,
      message: `Task not found: ${input.task_id}`,
    };
  }

  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
    return {
      ok: false,
      message: `Task is already in terminal status: ${task.status}`,
    };
  }

  if (task.response_id) {
    await dependencies.codexClient.cancel(task.response_id);
  }

  dependencies.taskStore.updateStatus(task.task_id, 'cancelled', {
    logs: appendCancellationLog(task.logs),
    error: undefined,
  });

  return {
    ok: true,
    message: `Task cancelled: ${task.task_id}`,
  };
}

function appendCancellationLog(logs?: string): string {
  const cancellationMessage = 'Cancellation requested by orchestrator.';

  if (!logs || logs.trim().length === 0) {
    return cancellationMessage;
  }

  return `${logs.trim()}\n${cancellationMessage}`;
}
