import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  CreateTaskParams,
  ExpectedOutput,
  FileContext,
  GeneratedFile,
  TaskConstraints,
  TaskRecord,
  TaskStatus,
  TaskStoreOptions,
  UsageInfo,
} from './types.js';

const DEFAULT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 100;
const DEFAULT_STORAGE_PATH = './data/codex-task-store.json';
const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);

export class TaskStore {
  private readonly tasks: Map<string, TaskRecord>;
  private readonly cleanupIntervalMs: number;
  private readonly retentionMs: number;
  private readonly maxRecords: number;
  private readonly storagePath: string;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options: TaskStoreOptions = {}) {
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.storagePath = resolveStoragePath(options.storagePath);
    this.tasks = new Map<string, TaskRecord>();

    for (const task of loadFromDisk(this.storagePath)) {
      this.tasks.set(task.task_id, task);
    }

    this.cleanup();
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  create(params: CreateTaskParams): TaskRecord {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      task_id: randomUUID(),
      status: 'queued',
      prompt_summary: summarizePrompt(params.prompt),
      created_at: now,
      full_prompt: params.prompt,
      files_context: cloneFileContextList(params.files_context),
      constraints: cloneConstraints(params.constraints),
      expected_output: cloneExpectedOutput(params.expected_output),
      config: params.config ? { ...params.config } : undefined,
    };

    this.tasks.set(task.task_id, cloneTaskRecord(task));
    this.cleanup();
    this.persist();
    return cloneTaskRecord(task);
  }

  get(taskId: string): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    return task ? cloneTaskRecord(task) : undefined;
  }

  list(): TaskRecord[] {
    return Array.from(this.tasks.values())
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
      .map(cloneTaskRecord);
  }

  update(taskId: string, update: Partial<TaskRecord>): TaskRecord | undefined {
    const current = this.tasks.get(taskId);

    if (!current) {
      return undefined;
    }

    const next: TaskRecord = {
      ...current,
      ...update,
      files_context: update.files_context
        ? cloneFileContextList(update.files_context)
        : cloneFileContextList(current.files_context),
      constraints: update.constraints
        ? cloneConstraints(update.constraints)
        : cloneConstraints(current.constraints),
      expected_output: update.expected_output
        ? cloneExpectedOutput(update.expected_output)
        : cloneExpectedOutput(current.expected_output),
      config: update.config
        ? { ...update.config }
        : current.config
          ? { ...current.config }
          : undefined,
      files_generated: update.files_generated
        ? cloneGeneratedFiles(update.files_generated)
        : current.files_generated
          ? cloneGeneratedFiles(current.files_generated)
          : undefined,
      usage: update.usage ? { ...update.usage } : current.usage ? { ...current.usage } : undefined,
    };

    if (update.status) {
      if (TERMINAL_STATUSES.has(update.status)) {
        next.completed_at = update.completed_at ?? current.completed_at ?? new Date().toISOString();
      } else {
        next.completed_at = undefined;
      }
    }

    this.tasks.set(taskId, next);
    this.cleanup();
    this.persist();
    return cloneTaskRecord(next);
  }

  updateStatus(taskId: string, status: TaskStatus, update: Partial<TaskRecord> = {}): TaskRecord | undefined {
    return this.update(taskId, {
      ...update,
      status,
    });
  }

  setResponseId(taskId: string, responseId: string): TaskRecord | undefined {
    return this.update(taskId, { response_id: responseId });
  }

  cleanup(): void {
    const now = Date.now();
    let changed = false;

    for (const [taskId, task] of this.tasks.entries()) {
      if (!TERMINAL_STATUSES.has(task.status) || !task.completed_at) {
        continue;
      }

      if (now - Date.parse(task.completed_at) > this.retentionMs) {
        this.tasks.delete(taskId);
        changed = true;
      }
    }

    if (this.tasks.size > this.maxRecords) {
      const removableTasks = Array.from(this.tasks.values())
        .filter((task) => TERMINAL_STATUSES.has(task.status))
        .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));

      while (this.tasks.size > this.maxRecords && removableTasks.length > 0) {
        const oldestTask = removableTasks.shift();

        if (!oldestTask) {
          break;
        }

        this.tasks.delete(oldestTask.task_id);
        changed = true;
      }
    }

    if (changed) {
      this.persist();
    }
  }

  private persist(): void {
    const directory = path.dirname(this.storagePath);

    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    const payload = {
      version: 1,
      tasks: Array.from(this.tasks.values()),
    };
    const tempPath = this.storagePath + '.tmp';
    writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tempPath, this.storagePath);
  }
}

function summarizePrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function cloneTaskRecord(task: TaskRecord): TaskRecord {
  return {
    ...task,
    files_context: cloneFileContextList(task.files_context),
    constraints: cloneConstraints(task.constraints),
    expected_output: cloneExpectedOutput(task.expected_output),
    config: task.config ? { ...task.config } : undefined,
    files_generated: task.files_generated ? cloneGeneratedFiles(task.files_generated) : undefined,
    usage: task.usage ? cloneUsage(task.usage) : undefined,
  };
}

function cloneFileContextList(files: FileContext[]): FileContext[] {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
  }));
}

function cloneGeneratedFiles(files: GeneratedFile[]): GeneratedFile[] {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
    diff: file.diff,
  }));
}

function cloneConstraints(constraints: TaskConstraints): TaskConstraints {
  return {
    ...constraints,
    security_rules: constraints.security_rules ? [...constraints.security_rules] : undefined,
  };
}

function cloneExpectedOutput(expectedOutput: ExpectedOutput): ExpectedOutput {
  return {
    ...expectedOutput,
    files: [...expectedOutput.files],
  };
}

function cloneUsage(usage: UsageInfo): UsageInfo {
  return {
    ...usage,
  };
}

function resolveStoragePath(inputPath?: string): string {
  const fromEnv = String(process.env.CODEX_TASK_STORE_PATH || '').trim();
  const source = String(inputPath || fromEnv || DEFAULT_STORAGE_PATH).trim();
  return path.resolve(source);
}

function loadFromDisk(storagePath: string): TaskRecord[] {
  if (!existsSync(storagePath)) {
    return [];
  }

  try {
    const raw = readFileSync(storagePath, 'utf8');
    const payload = JSON.parse(raw);
    const records = Array.isArray(payload?.tasks) ? payload.tasks : [];

    return records
      .map(normalizeTaskRecord)
      .filter(function (task: TaskRecord | null): task is TaskRecord {
        return task !== null;
      });
  } catch {
    return [];
  }
}

function normalizeTaskRecord(value: unknown): TaskRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const task = value as TaskRecord;

  if (!task.task_id || !task.status || !task.created_at) {
    return null;
  }

  return cloneTaskRecord({
    ...task,
    files_context: Array.isArray(task.files_context) ? task.files_context : [],
    constraints: task.constraints ?? { language: 'unknown' },
    expected_output: task.expected_output ?? { files: [] },
  });
}
