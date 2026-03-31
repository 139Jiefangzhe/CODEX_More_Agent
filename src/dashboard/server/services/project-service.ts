import { promises as fs } from 'node:fs';
import path from 'node:path';

import { v4 as uuidv4 } from 'uuid';

import { parseJson, toJson } from './helpers.js';

const DEFAULT_IGNORES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '.idea',
  '.vscode',
]);
const MANIFEST_FILES = [
  'README.md',
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'src/main.ts',
  'src/main.tsx',
  'src/index.ts',
  'src/index.tsx',
  'src/App.tsx',
];
const SYSTEM_ROOT_DENYLIST = new Set([
  '/',
  '/root',
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/var',
  '/proc',
  '/sys',
  '/dev',
]);

export class ProjectService {
  db: any;

  constructor(db) {
    this.db = db;
  }

  listProjects() {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    return rows.map(normalizeProject);
  }

  getProject(id) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return row ? normalizeProject(row) : null;
  }

  createProject(input) {
    const resolvedPath = path.resolve(input.root_path);
    const now = new Date().toISOString();
    const sql = 'INSERT INTO projects (id, name, root_path, language, framework, test_command, lint_command, build_command, ignore_paths, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

    this.db.prepare(sql).run(
      uuidv4(),
      input.name.trim(),
      resolvedPath,
      input.language.trim(),
      input.framework ? input.framework.trim() : null,
      input.test_command ? input.test_command.trim() : null,
      input.lint_command ? input.lint_command.trim() : null,
      input.build_command ? input.build_command.trim() : null,
      toJson(input.ignore_paths ?? []),
      now,
      now,
    );

    return this.getByRootPath(resolvedPath);
  }

  updateProject(id, input) {
    const current = this.getProject(id);

    if (!current) {
      throw new Error('Project not found: ' + id);
    }

    const resolvedPath = path.resolve(input.root_path);
    const now = new Date().toISOString();
    const sql = 'UPDATE projects SET name = ?, root_path = ?, language = ?, framework = ?, test_command = ?, lint_command = ?, build_command = ?, ignore_paths = ?, updated_at = ? WHERE id = ?';

    this.db.prepare(sql).run(
      input.name.trim(),
      resolvedPath,
      input.language.trim(),
      input.framework ? input.framework.trim() : null,
      input.test_command ? input.test_command.trim() : null,
      input.lint_command ? input.lint_command.trim() : null,
      input.build_command ? input.build_command.trim() : null,
      toJson(input.ignore_paths ?? []),
      now,
      id,
    );

    return this.getProject(id);
  }

  async validateProjectRoot(rootPath) {
    const normalizedInput = String(rootPath || '').trim();

    if (!normalizedInput) {
      throw new Error('root_path is required');
    }

    const candidatePath = path.resolve(normalizedInput);
    const realRootPath = await fs.realpath(candidatePath);
    const stats = await fs.stat(realRootPath);

    if (!stats.isDirectory()) {
      throw new Error('Project path is not a directory: ' + rootPath);
    }

    if (SYSTEM_ROOT_DENYLIST.has(realRootPath)) {
      throw new Error('Project root is not allowed: ' + realRootPath);
    }

    const workspaceRoots = await loadWorkspaceRoots();

    if (workspaceRoots.length === 0) {
      throw new Error('No valid workspace roots configured. Set WORKSPACE_ROOTS.');
    }

    const isWithinWorkspace = workspaceRoots.some(function (workspaceRoot) {
      return realRootPath === workspaceRoot || realRootPath.startsWith(workspaceRoot + path.sep);
    });

    if (!isWithinWorkspace) {
      throw new Error('Project path must be inside WORKSPACE_ROOTS');
    }

    return realRootPath;
  }

  async buildContext(project) {
    const fileTree = [];
    const ignorePaths = new Set([...DEFAULT_IGNORES, ...project.ignore_paths]);

    await walk(project.root_path, '', 0, fileTree, ignorePaths);

    return {
      fileTree,
      keyFiles: await this.readExistingFiles(project, selectKeyFiles(fileTree)),
    };
  }

  async readExistingFiles(project, relativePaths) {
    const files = [];

    for (const relativePath of relativePaths) {
      const absolutePath = resolveWithinRoot(project.root_path, relativePath);

      try {
        const content = await fs.readFile(absolutePath, 'utf8');
        files.push({ path: relativePath, content });
      } catch {
        continue;
      }
    }

    return files;
  }

  getByRootPath(rootPath) {
    const row = this.db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath);

    if (!row) {
      throw new Error('Project not found by root path: ' + rootPath);
    }

    return normalizeProject(row);
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

function normalizeProject(row) {
  return {
    ...row,
    ignore_paths: parseJson(row.ignore_paths, []),
  };
}

function selectKeyFiles(fileTree) {
  const selected = new Set();

  for (const manifest of MANIFEST_FILES) {
    if (fileTree.includes(manifest)) {
      selected.add(manifest);
    }
  }

  for (const filePath of fileTree) {
    if (selected.size >= 12) {
      break;
    }

    if (filePath.startsWith('src/') && /\.(ts|tsx|js|jsx|py|go|rs)$/.test(filePath)) {
      selected.add(filePath);
    }
  }

  return Array.from(selected);
}

async function walk(rootPath, relativePath, depth, output, ignorePaths) {
  if (depth > 3 || output.length >= 200) {
    return;
  }

  const absolutePath = path.join(rootPath, relativePath);
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (output.length >= 200) {
      break;
    }

    const nextRelativePath = relativePath ? relativePath + '/' + entry.name : entry.name;

    if (shouldIgnore(nextRelativePath, ignorePaths)) {
      continue;
    }

    if (entry.isDirectory()) {
      output.push(nextRelativePath + '/');
      await walk(rootPath, nextRelativePath, depth + 1, output, ignorePaths);
    } else {
      output.push(nextRelativePath);
    }
  }
}

function shouldIgnore(relativePath, ignorePaths) {
  const firstSegment = relativePath.split('/')[0];

  if (ignorePaths.has(firstSegment) || ignorePaths.has(relativePath)) {
    return true;
  }

  for (const ignorePath of ignorePaths) {
    if (relativePath.startsWith(ignorePath + '/')) {
      return true;
    }
  }

  return false;
}

async function loadWorkspaceRoots() {
  const raw = String(process.env.WORKSPACE_ROOTS || '').trim();
  const candidates = raw
    ? raw.split(',').map(function (item) {
      return item.trim();
    }).filter(Boolean)
    : [defaultWorkspaceRoot()];
  const roots = [];

  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(path.resolve(candidate));
      roots.push(real);
    } catch {
      continue;
    }
  }

  return Array.from(new Set(roots));
}

function defaultWorkspaceRoot() {
  const cwd = path.resolve(process.cwd());
  const normalized = cwd.replace(/\\/g, '/');

  if (normalized.endsWith('/src/dashboard')) {
    return path.resolve(cwd, '../..');
  }

  return cwd;
}
