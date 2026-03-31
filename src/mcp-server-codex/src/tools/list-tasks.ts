import { z } from 'zod';

import { TaskStore } from '../task-store.js';
import type { ListTasksOutput } from '../types.js';

export const listTasksInputSchema = z.object({});

export interface ListTasksDependencies {
  taskStore: TaskStore;
}

export async function handleListTasks(
  _input: z.infer<typeof listTasksInputSchema>,
  dependencies: ListTasksDependencies,
): Promise<ListTasksOutput> {
  const tasks = dependencies.taskStore.list().map((task) => ({
    task_id: task.task_id,
    status: task.status,
    prompt_summary: task.prompt_summary,
    created_at: task.created_at,
    completed_at: task.completed_at,
  }));

  return { tasks };
}
