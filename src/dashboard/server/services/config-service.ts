import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { nowIso } from './helpers.js';

const HOOK_TYPES = ['postEdit', 'preCommit', 'prePush'];
const VERSION_FILENAME = '.dashboard-config-version';

export class ConfigVersionConflictError extends Error {
  code: string;
  expected: number;
  actual: number;

  constructor(expected, actual) {
    super('Config version mismatch: expected ' + expected + ', current ' + actual);
    this.name = 'ConfigVersionConflictError';
    this.code = 'VERSION_CONFLICT';
    this.expected = expected;
    this.actual = actual;
  }
}

export class ConfigService {
  sessionService: any;
  eventBus: any;
  claudeDir: string;
  settingsPath: string;
  commandsDir: string;
  versionPath: string;
  version: number;
  versionReady: Promise<void>;
  writeChain: Promise<void>;

  constructor(config) {
    this.sessionService = config.sessionService;
    this.eventBus = config.eventBus;
    this.claudeDir = resolveClaudeDir(config.cwd || process.cwd());
    this.settingsPath = path.join(this.claudeDir, 'settings.json');
    this.commandsDir = path.join(this.claudeDir, 'commands');
    this.versionPath = path.join(this.claudeDir, VERSION_FILENAME);
    this.version = 0;
    this.versionReady = this.initializeVersion();
    this.writeChain = Promise.resolve();
  }

  async getVersion() {
    await this.ensureVersionLoaded();
    return this.version;
  }

  async listMcpServers() {
    const settings = await this.readSettings();
    const mcpServers = settings.mcpServers || {};

    return Object.keys(mcpServers)
      .sort()
      .map(function (name) {
        const value = mcpServers[name] || {};

        return {
          name,
          command: typeof value.command === 'string' ? value.command : '',
          args: Array.isArray(value.args) ? value.args.map(String) : [],
          env: isPlainObject(value.env) ? value.env : {},
          enabled: value.enabled !== false,
        };
      });
  }

  async upsertMcpServer(name, input, options: any = {}) {
    const trimmedName = String(name || '').trim();

    if (!trimmedName) {
      throw new Error('MCP name is required');
    }

    return this.withWriteLock(async () => {
      await this.assertExpectedVersion(options.expectedVersion);
      const next = await this.readSettings();
      const normalizedInput = isPlainObject(input) ? input : {};

      next.mcpServers = next.mcpServers || {};
      next.mcpServers[trimmedName] = {
        command: String(normalizedInput.command || '').trim(),
        args: normalizeStringList(normalizedInput.args),
        env: normalizeStringMap(normalizedInput.env),
        enabled: normalizedInput.enabled !== false,
      };

      if (!next.mcpServers[trimmedName].command) {
        throw new Error('MCP command is required');
      }

      await this.writeSettings(next);
      const version = await this.finalizeMutation('mcp_server', trimmedName, { action: 'upsert' });
      return { version };
    });
  }

  async deleteMcpServer(name, options: any = {}) {
    const trimmedName = String(name || '').trim();

    if (!trimmedName) {
      throw new Error('MCP name is required');
    }

    return this.withWriteLock(async () => {
      await this.assertExpectedVersion(options.expectedVersion);
      const next = await this.readSettings();

      next.mcpServers = next.mcpServers || {};

      if (!next.mcpServers[trimmedName]) {
        throw new Error('MCP server not found: ' + trimmedName);
      }

      delete next.mcpServers[trimmedName];
      await this.writeSettings(next);
      const version = await this.finalizeMutation('mcp_server', trimmedName, { action: 'delete' });
      return { version };
    });
  }

  async syncMcpServers(options: any = {}) {
    return this.withWriteLock(async () => {
      await this.assertExpectedVersion(options.expectedVersion);
      const next = await this.readSettings();
      const normalized = normalizeSettings(next);
      const backupPath = await this.writeSettings(normalized, { backup: true });
      const version = await this.finalizeMutation('mcp_servers', 'settings.json', {
        action: 'sync',
        backupPath,
      });

      return {
        synced: true,
        backupPath,
        version,
        message: 'MCP 配置已同步到 settings.json',
      };
    });
  }

  async listHooks() {
    const settings = await this.readSettings();
    const hooks = normalizeHooks(settings.hooks || {});
    const output = [];

    for (const hookType of HOOK_TYPES) {
      const entries = hooks[hookType] || [];

      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        output.push({
          id: toHookId(hookType, index),
          hook_type: hookType,
          match_pattern: typeof entry.match === 'string' ? entry.match : '',
          command: entry.command,
          enabled: entry.enabled !== false,
          sort_order: index,
        });
      }
    }

    return output;
  }

  async upsertHook(id, input, options: any = {}) {
    const normalizedInput = isPlainObject(input) ? input : {};
    const hookType = ensureHookType(normalizedInput.hook_type);
    const command = String(normalizedInput.command || '').trim();

    if (!command) {
      throw new Error('Hook command is required');
    }

    return this.withWriteLock(async () => {
      await this.assertExpectedVersion(options.expectedVersion);
      const next = await this.readSettings();
      const hooks = normalizeHooks(next.hooks || {});
      const payload = {
        command,
        enabled: normalizedInput.enabled !== false,
        ...(hookType === 'postEdit' && normalizedInput.match_pattern ? { match: String(normalizedInput.match_pattern).trim() } : {}),
      };

      if (id) {
        const parsed = parseHookId(String(id));

        if (!parsed) {
          throw new Error('Invalid hook id: ' + id);
        }

        const sourceList = hooks[parsed.hook_type] || [];

        if (parsed.index < 0 || parsed.index >= sourceList.length) {
          throw new Error('Hook not found: ' + id);
        }

        sourceList.splice(parsed.index, 1);
        hooks[parsed.hook_type] = sourceList;
        hooks[hookType] = hooks[hookType] || [];
        hooks[hookType].push(payload);
      } else {
        hooks[hookType] = hooks[hookType] || [];
        hooks[hookType].push(payload);
      }

      next.hooks = hooks;
      await this.writeSettings(next);
      const version = await this.finalizeMutation('hook', id || 'new', {
        action: 'upsert',
        hookType,
      });
      return { version };
    });
  }

  async deleteHook(id, options: any = {}) {
    const parsed = parseHookId(String(id));

    if (!parsed) {
      throw new Error('Invalid hook id: ' + id);
    }

    return this.withWriteLock(async () => {
      await this.assertExpectedVersion(options.expectedVersion);
      const next = await this.readSettings();
      const hooks = normalizeHooks(next.hooks || {});
      const sourceList = hooks[parsed.hook_type] || [];

      if (parsed.index < 0 || parsed.index >= sourceList.length) {
        throw new Error('Hook not found: ' + id);
      }

      sourceList.splice(parsed.index, 1);
      hooks[parsed.hook_type] = sourceList;
      next.hooks = hooks;
      await this.writeSettings(next);
      const version = await this.finalizeMutation('hook', id, {
        action: 'delete',
        hookType: parsed.hook_type,
      });
      return { version };
    });
  }

  async reorderHooks(hookType, orderedIds, options: any = {}) {
    const ensuredType = ensureHookType(hookType);

    return this.withWriteLock(async () => {
      await this.assertExpectedVersion(options.expectedVersion);
      const next = await this.readSettings();
      const hooks = normalizeHooks(next.hooks || {});
      const sourceList = hooks[ensuredType] || [];
      const indexes = [];
      const seen = new Set();

      for (const id of orderedIds || []) {
        const parsed = parseHookId(String(id));

        if (!parsed || parsed.hook_type !== ensuredType) {
          continue;
        }

        if (parsed.index < 0 || parsed.index >= sourceList.length) {
          continue;
        }

        if (seen.has(parsed.index)) {
          continue;
        }

        indexes.push(parsed.index);
        seen.add(parsed.index);
      }

      if (indexes.length === 0) {
        return { version: this.version };
      }

      const reordered = indexes.map(function (index) {
        return sourceList[index];
      });

      for (let index = 0; index < sourceList.length; index += 1) {
        if (!seen.has(index)) {
          reordered.push(sourceList[index]);
        }
      }

      hooks[ensuredType] = reordered;
      next.hooks = hooks;
      await this.writeSettings(next);
      const version = await this.finalizeMutation('hook', ensuredType, { action: 'reorder' });
      return { version };
    });
  }

  async syncHooks(options: any = {}) {
    return this.withWriteLock(async () => {
      await this.assertExpectedVersion(options.expectedVersion);
      const next = await this.readSettings();
      const normalized = normalizeSettings(next);
      const backupPath = await this.writeSettings(normalized, { backup: true });
      const version = await this.finalizeMutation('hooks', 'settings.json', {
        action: 'sync',
        backupPath,
      });

      return {
        synced: true,
        backupPath,
        version,
        message: 'Hook 配置已同步到 settings.json',
      };
    });
  }

  async listCommands() {
    await fs.mkdir(this.commandsDir, { recursive: true });
    const entries = await fs.readdir(this.commandsDir, { withFileTypes: true });
    const markdownFiles = entries
      .filter(function (entry) {
        return entry.isFile() && entry.name.endsWith('.md');
      })
      .map(function (entry) {
        return entry.name;
      })
      .sort();
    const output = [];

    for (const filename of markdownFiles) {
      const absolutePath = path.join(this.commandsDir, filename);
      const content = await fs.readFile(absolutePath, 'utf8');
      output.push({
        name: filename.replace(/\.md$/, ''),
        content,
        path: absolutePath,
      });
    }

    return output;
  }

  async getCommand(name) {
    const normalizedName = normalizeCommandName(name);
    const absolutePath = path.join(this.commandsDir, normalizedName + '.md');

    try {
      const content = await fs.readFile(absolutePath, 'utf8');
      return {
        name: normalizedName,
        content,
        path: absolutePath,
      };
    } catch {
      return null;
    }
  }

  async upsertCommand(name, content, options: any = {}) {
    const normalizedName = normalizeCommandName(name);
    const absolutePath = path.join(this.commandsDir, normalizedName + '.md');

    return this.withWriteLock(async () => {
      await this.assertExpectedVersion(options.expectedVersion);
      await fs.mkdir(this.commandsDir, { recursive: true });
      await atomicWrite(absolutePath, String(content || ''));
      const version = await this.finalizeMutation('command', normalizedName, { action: 'upsert' });
      return { version };
    });
  }

  async deleteCommand(name, options: any = {}) {
    const normalizedName = normalizeCommandName(name);
    const absolutePath = path.join(this.commandsDir, normalizedName + '.md');

    return this.withWriteLock(async () => {
      await this.assertExpectedVersion(options.expectedVersion);

      try {
        await fs.unlink(absolutePath);
      } catch (error) {
        if ((error as any)?.code === 'ENOENT') {
          throw new Error('Command not found: ' + normalizedName);
        }

        throw error;
      }

      const version = await this.finalizeMutation('command', normalizedName, { action: 'delete' });
      return { version };
    });
  }

  async syncCommands(options: any = {}) {
    return this.withWriteLock(async () => {
      await this.assertExpectedVersion(options.expectedVersion);
      await fs.mkdir(this.commandsDir, { recursive: true });
      const version = await this.finalizeMutation('commands', 'commands', { action: 'sync' });

      return {
        synced: true,
        backupPath: null,
        version,
        message: '命令文件目录已同步',
      };
    });
  }

  async readSettings() {
    await fs.mkdir(this.claudeDir, { recursive: true });

    if (!existsSync(this.settingsPath)) {
      const defaults = createDefaultSettings();
      await this.writeSettings(defaults);
      await this.ensureDefaultVersion();
      return defaults;
    }

    const content = await fs.readFile(this.settingsPath, 'utf8');
    const parsed = JSON.parse(content);
    return normalizeSettings(parsed);
  }

  async writeSettings(input, options: any = {}) {
    const normalized = normalizeSettings(input);
    const backupPath = await this.maybeBackupSettings(Boolean(options.backup));
    const body = JSON.stringify(normalized, null, 2) + '\n';

    await atomicWrite(this.settingsPath, body);
    return backupPath;
  }

  async maybeBackupSettings(backupEnabled) {
    if (!backupEnabled || !existsSync(this.settingsPath)) {
      return null;
    }

    const backupPath = this.settingsPath + '.bak';
    await fs.copyFile(this.settingsPath, backupPath);
    return backupPath;
  }

  appendAudit(action, targetType, targetId, details) {
    if (!this.sessionService?.appendAudit) {
      return;
    }

    this.sessionService.appendAudit('user', action, targetType, targetId, details);
  }

  async withWriteLock(task) {
    const run = this.writeChain.then(task, task);

    this.writeChain = run.then(
      function () {
        return undefined;
      },
      function () {
        return undefined;
      },
    );

    return run;
  }

  async initializeVersion() {
    await fs.mkdir(this.claudeDir, { recursive: true });
    const loadedVersion = await this.readVersionFromDisk();

    if (loadedVersion !== null) {
      this.version = loadedVersion;
      return;
    }

    const baselineVersion = existsSync(this.settingsPath) ? 1 : 0;
    this.version = baselineVersion;
    await this.writeVersionToDisk(baselineVersion);
  }

  async readVersionFromDisk() {
    if (!existsSync(this.versionPath)) {
      return null;
    }

    try {
      const content = await fs.readFile(this.versionPath, 'utf8');
      const parsed = Number.parseInt(String(content || '').trim(), 10);

      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  async ensureVersionLoaded() {
    await this.versionReady;
  }

  async ensureDefaultVersion() {
    await this.ensureVersionLoaded();

    if (this.version > 0) {
      return;
    }

    this.version = 1;
    await this.writeVersionToDisk(this.version);
  }

  async bumpVersion() {
    await this.ensureVersionLoaded();
    this.version += 1;
    await this.writeVersionToDisk(this.version);
    return this.version;
  }

  async writeVersionToDisk(value) {
    await atomicWrite(this.versionPath, String(value) + '\n');
  }

  async assertExpectedVersion(value) {
    await this.ensureVersionLoaded();

    if (value === undefined || value === null || value === '') {
      return;
    }

    const expectedVersion = parseExpectedVersion(value);

    if (expectedVersion !== this.version) {
      throw new ConfigVersionConflictError(expectedVersion, this.version);
    }
  }

  async finalizeMutation(targetType, targetId, details) {
    const version = await this.bumpVersion();
    const action = String(details?.action || 'update');
    const payload = {
      ...(details || {}),
      action,
      version,
    };

    this.appendAudit('config_change', targetType, targetId, payload);
    this.emitConfigUpdate({
      action,
      targetType,
      targetId,
      version,
      details: payload,
    });

    return version;
  }

  emitConfigUpdate(input) {
    if (!this.eventBus?.publish) {
      return;
    }

    const timestamp = nowIso();
    const payload = {
      type: 'config:update',
      timestamp,
      data: {
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        version: input.version,
        details: input.details,
        timestamp,
      },
    };

    this.eventBus.publish('system', payload);
    this.eventBus.publish('config', payload);
  }
}

function createDefaultSettings() {
  return {
    mcpServers: {},
    hooks: {
      postEdit: [],
      preCommit: [],
      prePush: [],
    },
  };
}

function normalizeSettings(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const settings = createDefaultSettings();
  const mcpServers = isPlainObject(source.mcpServers) ? source.mcpServers : {};

  for (const name of Object.keys(mcpServers)) {
    const value = mcpServers[name] || {};
    const command = typeof value.command === 'string' ? value.command.trim() : '';

    if (!command) {
      continue;
    }

    settings.mcpServers[name] = {
      command,
      args: normalizeStringList(value.args),
      env: normalizeStringMap(value.env),
      ...(value.enabled === false ? { enabled: false } : {}),
    };
  }

  settings.hooks = normalizeHooks(source.hooks || {});
  return settings;
}

function normalizeHooks(rawHooks) {
  const source = isPlainObject(rawHooks) ? rawHooks : {};
  const next = {
    postEdit: [],
    preCommit: [],
    prePush: [],
  };

  for (const hookType of HOOK_TYPES) {
    const entries = Array.isArray(source[hookType]) ? source[hookType] : [];

    for (const entry of entries) {
      if (!isPlainObject(entry)) {
        continue;
      }

      const command = typeof entry.command === 'string' ? entry.command.trim() : '';

      if (!command) {
        continue;
      }

      const payload: Record<string, unknown> = {
        command,
      };

      if (entry.enabled === false) {
        payload.enabled = false;
      }

      if (hookType === 'postEdit') {
        payload.match = typeof entry.match === 'string' && entry.match.trim() ? entry.match.trim() : '.*';
      }

      next[hookType].push(payload);
    }
  }

  return next;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(function (entry) {
      return String(entry || '').trim();
    })
    .filter(Boolean);
}

function normalizeStringMap(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  const output = {};

  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = String(key || '').trim();

    if (!normalizedKey) {
      continue;
    }

    output[normalizedKey] = String(entry ?? '');
  }

  return output;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensureHookType(value) {
  const hookType = String(value || '').trim();

  if (!HOOK_TYPES.includes(hookType)) {
    throw new Error('Invalid hook type: ' + hookType);
  }

  return hookType;
}

function toHookId(hookType, index) {
  return hookType + ':' + String(index);
}

function parseHookId(id) {
  const [hookType, indexText] = String(id || '').split(':');

  if (!HOOK_TYPES.includes(hookType)) {
    return null;
  }

  const index = Number.parseInt(indexText || '', 10);

  if (Number.isNaN(index)) {
    return null;
  }

  return {
    hook_type: hookType,
    index,
  };
}

function normalizeCommandName(name) {
  const normalized = String(name || '').trim();

  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(normalized)) {
    throw new Error('Invalid command name: ' + normalized);
  }

  return normalized;
}

function parseExpectedVersion(value) {
  const normalized = String(value ?? '').trim();

  if (!/^\d+$/.test(normalized)) {
    throw new Error('expected_version must be a non-negative integer');
  }

  const parsed = Number.parseInt(normalized, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('expected_version must be a non-negative integer');
  }

  return parsed;
}

function resolveClaudeDir(startDir) {
  const envPath = process.env.CLAUDE_DIR;

  if (envPath) {
    return path.resolve(envPath);
  }

  let cursor = path.resolve(startDir);

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(cursor, '.claude');

    if (existsSync(path.join(candidate, 'settings.json')) || existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(cursor);

    if (parent === cursor) {
      break;
    }

    cursor = parent;
  }

  return path.join(path.resolve(startDir), '.claude');
}

async function atomicWrite(targetPath, content) {
  const directory = path.dirname(targetPath);
  const temporaryPath = targetPath + '.tmp-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporaryPath, content, 'utf8');
  await fs.rename(temporaryPath, targetPath);
}
