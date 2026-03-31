import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 512 * 1024;

export class GitService {
  async inspectApply(rootPath, targetPaths) {
    const isRepo = await this.isGitRepository(rootPath);

    if (!isRepo) {
      return {
        isRepo: false,
        branch: null,
        overlappingDirtyFiles: [],
        otherDirtyFiles: [],
      };
    }

    const dirtyFiles = await this.getDirtyFiles(rootPath);
    const targetSet = new Set(targetPaths);
    const overlappingDirtyFiles = dirtyFiles.filter(function (file) {
      return targetSet.has(file);
    });
    const otherDirtyFiles = dirtyFiles.filter(function (file) {
      return !targetSet.has(file);
    });

    return {
      isRepo: true,
      branch: await this.getCurrentBranch(rootPath),
      overlappingDirtyFiles,
      otherDirtyFiles,
    };
  }

  async applyFiles(rootPath, files) {
    for (const file of files) {
      const operation = normalizeFileOperation(file);
      const targetPath = String(file.path || '').trim();

      if (!targetPath) {
        continue;
      }

      const absoluteTargetPath = resolveWithinRoot(rootPath, targetPath);

      if (operation === 'delete') {
        await fs.rm(absoluteTargetPath, { recursive: true, force: true });
        await pruneEmptyDirectories(rootPath, path.dirname(absoluteTargetPath));
        continue;
      }

      if (operation === 'rename') {
        const oldPath = String(file.old_path || '').trim();

        if (!oldPath) {
          throw new Error('Rename operation requires old_path: ' + targetPath);
        }

        const absoluteSourcePath = resolveWithinRoot(rootPath, oldPath);
        await fs.mkdir(path.dirname(absoluteTargetPath), { recursive: true });
        await fs.writeFile(absoluteTargetPath, String(file.after_content ?? ''), 'utf8');

        if (absoluteSourcePath !== absoluteTargetPath) {
          await fs.rm(absoluteSourcePath, { recursive: true, force: true });
          await pruneEmptyDirectories(rootPath, path.dirname(absoluteSourcePath));
        }

        continue;
      }

      await fs.mkdir(path.dirname(absoluteTargetPath), { recursive: true });
      await fs.writeFile(absoluteTargetPath, String(file.after_content ?? ''), 'utf8');
    }
  }

  async applyFilesWithRollback(rootPath, files) {
    const snapshot = await captureWorkspaceSnapshot(rootPath, files);

    try {
      await this.applyFiles(rootPath, files);
    } catch (error) {
      try {
        await restoreWorkspaceSnapshot(rootPath, snapshot);
      } catch (rollbackError) {
        const rollbackReason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error('Failed to apply change set and rollback failed: ' + rollbackReason);
      }

      const reason = error instanceof Error ? error.message : String(error);
      throw new Error('Failed to apply change set. Workspace was rolled back. Cause: ' + reason);
    }
  }

  async runShellCommand(rootPath, command, onOutput): Promise<any> {
    const parsed = parseCommand(command);

    return await new Promise(function (resolve, reject) {
      const child = spawn(parsed.program, parsed.args, {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let timeoutTriggered = false;
      let outputLimitTriggered = false;
      const timeout = setTimeout(function () {
        timeoutTriggered = true;
        child.kill('SIGKILL');
      }, DEFAULT_COMMAND_TIMEOUT_MS);
      timeout.unref?.();

      function appendChunk(chunk, stream) {
        const text = chunk.toString();
        const byteSize = Buffer.byteLength(text, 'utf8');
        outputBytes += byteSize;

        if (stream === 'stdout') {
          stdout += text;
        } else {
          stderr += text;
        }

        if (onOutput) {
          onOutput(text, stream);
        }

        if (outputBytes > DEFAULT_OUTPUT_LIMIT_BYTES && !outputLimitTriggered) {
          outputLimitTriggered = true;
          const warning = '\n[dashboard] output limit reached, process terminated\n';
          stderr += warning;
          if (onOutput) {
            onOutput(warning, 'stderr');
          }
          child.kill('SIGKILL');
        }
      }

      child.stdout.on('data', function (chunk) {
        appendChunk(chunk, 'stdout');
      });

      child.stderr.on('data', function (chunk) {
        appendChunk(chunk, 'stderr');
      });

      child.on('error', function (error) {
        clearTimeout(timeout);
        reject(error);
      });

      child.on('close', function (code) {
        clearTimeout(timeout);

        if (timeoutTriggered) {
          stderr += '\n[dashboard] command timed out after ' + DEFAULT_COMMAND_TIMEOUT_MS + 'ms\n';
        }

        resolve({
          code: code ?? (timeoutTriggered || outputLimitTriggered ? 124 : 1),
          stdout,
          stderr,
        });
      });
    });
  }

  async isGitRepository(rootPath) {
    try {
      await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: rootPath });
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentBranch(rootPath) {
    try {
      const result = await execFileAsync('git', ['branch', '--show-current'], { cwd: rootPath });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async getDirtyFiles(rootPath) {
    try {
      const result = await execFileAsync('git', ['status', '--porcelain'], { cwd: rootPath });
      return result.stdout
        .split('\n')
        .map(function (line) {
          return line.trimEnd();
        })
        .filter(Boolean)
        .map(parsePorcelainPath);
    } catch {
      return [];
    }
  }
}

function parsePorcelainPath(line) {
  const value = line.slice(3).trim();
  const arrowIndex = value.indexOf(' -> ');
  return arrowIndex >= 0 ? value.slice(arrowIndex + 4).trim() : value;
}

function parseCommand(command) {
  const source = String(command || '').trim();

  if (!source) {
    throw new Error('Command is required');
  }

  if (/[\r\n]/.test(source)) {
    throw new Error('Multiline commands are not allowed');
  }

  if (/[;&|><`$]/.test(source)) {
    throw new Error('Shell operators are not allowed in test_command');
  }

  const tokens = tokenizeCommand(source);

  if (tokens.length === 0) {
    throw new Error('Command is required');
  }

  return {
    program: tokens[0],
    args: tokens.slice(1),
  };
}

function tokenizeCommand(source) {
  const tokens = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && i + 1 < source.length) {
        i += 1;
        current += source[i];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    if (char === '\\' && i + 1 < source.length) {
      i += 1;
      current += source[i];
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error('Unterminated quote in test_command');
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

async function captureWorkspaceSnapshot(rootPath, files) {
  const snapshot = [];
  const seen = new Set();
  const targetPaths = collectSnapshotTargets(files);

  for (const relativePath of targetPaths) {
    if (!relativePath || seen.has(relativePath)) {
      continue;
    }

    seen.add(relativePath);

    const absolutePath = resolveWithinRoot(rootPath, relativePath);

    try {
      const stats = await fs.stat(absolutePath);

      if (stats.isDirectory()) {
        snapshot.push({
          path: relativePath,
          kind: 'directory',
          content: null,
        });
        continue;
      }

      const content = await fs.readFile(absolutePath, 'utf8');
      snapshot.push({
        path: relativePath,
        kind: 'file',
        content,
      });
    } catch {
      snapshot.push({
        path: relativePath,
        kind: 'missing',
        content: null,
      });
    }
  }

  return snapshot;
}

function collectSnapshotTargets(files) {
  const output = [];

  for (const file of files || []) {
    const targetPath = String(file?.path || '').trim();

    if (targetPath) {
      output.push(targetPath);
    }

    if (normalizeFileOperation(file) === 'rename') {
      const oldPath = String(file?.old_path || '').trim();

      if (oldPath) {
        output.push(oldPath);
      }
    }
  }

  return output;
}

async function restoreWorkspaceSnapshot(rootPath, snapshot) {
  for (const entry of [...snapshot].reverse()) {
    const absolutePath = resolveWithinRoot(rootPath, entry.path);

    if (entry.kind === 'file') {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, entry.content ?? '', 'utf8');
      continue;
    }

    if (entry.kind === 'directory') {
      await fs.mkdir(absolutePath, { recursive: true });
      continue;
    }

    await fs.rm(absolutePath, { recursive: true, force: true });
    await pruneEmptyDirectories(rootPath, path.dirname(absolutePath));
  }
}

async function pruneEmptyDirectories(rootPath, startDir) {
  const root = path.resolve(rootPath);
  let current = path.resolve(startDir);

  while (current.startsWith(root + path.sep) || current === root) {
    if (current === root) {
      break;
    }

    try {
      await fs.rmdir(current);
    } catch {
      break;
    }

    current = path.dirname(current);
  }
}

function resolveWithinRoot(rootPath, relativePath) {
  const resolvedRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(resolvedRoot, relativePath);

  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Path escapes project root: ' + relativePath);
  }

  return absolutePath;
}

function normalizeFileOperation(file) {
  const operation = String(file?.status || file?.operation || '').trim().toLowerCase();

  if (operation === 'create' || operation === 'modify' || operation === 'delete' || operation === 'rename') {
    return operation;
  }

  return 'modify';
}
