import { z } from 'zod';

import { TaskStore } from '../task-store.js';
import type { GetResultOutput } from '../types.js';

export const getResultInputSchema = z.object({
  task_id: z.string().min(1),
});

export interface GetResultDependencies {
  taskStore: TaskStore;
}

export async function handleGetResult(
  input: z.infer<typeof getResultInputSchema>,
  dependencies: GetResultDependencies,
): Promise<GetResultOutput> {
  const task = dependencies.taskStore.get(input.task_id);

  if (!task) {
    throw new Error(`Task not found: ${input.task_id}`);
  }

  return {
    task_id: task.task_id,
    status: task.status,
    files_generated: task.files_generated,
    logs: task.logs,
    tests_passed: task.tests_passed,
    error: task.error,
    usage: task.usage,
  };
}
