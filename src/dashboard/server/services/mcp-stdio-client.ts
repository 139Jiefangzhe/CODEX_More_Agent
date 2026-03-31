import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const INIT_PROTOCOL_VERSION = '2025-11-25';

export class McpStdioClient {
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  process: any;
  initialized: boolean;
  starting: Promise<void> | null;
  nextId: number;
  readBuffer: string;
  pending: Map<number, any>;

  constructor(config: any = {}) {
    this.command = String(config.command || 'node').trim() || 'node';
    this.args = Array.isArray(config.args) ? config.args.map((entry) => String(entry)) : [];
    this.cwd = config.cwd ? path.resolve(String(config.cwd)) : null;
    this.env = buildEnv(config.env);
    this.process = null;
    this.initialized = false;
    this.starting = null;
    this.nextId = 1;
    this.readBuffer = '';
    this.pending = new Map();
  }

  async callTool(name, args: Record<string, unknown> = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const result = await this.request('tools/call', {
      name,
      arguments: args,
    }, timeoutMs);

    return extractToolStructuredContent(result);
  }

  async listTools(timeoutMs = 30_000) {
    const result = await this.request('tools/list', {}, timeoutMs);
    return result?.tools ?? [];
  }

  async close() {
    const processRef = this.process;
    this.process = null;
    this.initialized = false;
    this.starting = null;

    if (!processRef) {
      return;
    }

    try {
      processRef.kill('SIGTERM');
    } catch {
      return;
    }
  }

  async request(method, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    await this.ensureStarted();
    return this.sendRequest(method, params, timeoutMs);
  }

  async ensureStarted() {
    if (this.initialized && this.process) {
      return;
    }

    if (this.starting) {
      return this.starting;
    }

    this.starting = this.startInternal()
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  async startInternal() {
    if (this.process) {
      return;
    }

    if (this.cwd && !existsSync(this.cwd)) {
      throw new Error('MCP working directory does not exist: ' + this.cwd);
    }

    const child = spawn(this.command, this.args, {
      cwd: this.cwd || undefined,
      env: {
        ...process.env,
        ...this.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    this.process = child;
    this.readBuffer = '';
    this.initialized = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.onStdout(String(chunk));
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {
      // stderr only used for diagnostics; request failures are surfaced via process exit or JSON-RPC error.
    });

    child.on('error', (error) => {
      this.rejectPendingRequests(error instanceof Error ? error : new Error(String(error)));
      this.process = null;
      this.initialized = false;
    });

    child.on('exit', (code, signal) => {
      this.rejectPendingRequests(new Error('MCP process exited: code=' + String(code ?? 'null') + ', signal=' + String(signal ?? 'null')));
      this.process = null;
      this.initialized = false;
    });

    const initializeResult = await this.sendRequest('initialize', {
      protocolVersion: INIT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'dashboard-execution-provider',
        version: '0.1.0',
      },
    }, 30_000);

    if (!initializeResult?.protocolVersion) {
      throw new Error('MCP initialize failed: missing protocolVersion');
    }

    await this.sendNotification('notifications/initialized', {});
    this.initialized = true;
  }

  async sendNotification(method, params: Record<string, unknown> = {}) {
    if (!this.process?.stdin) {
      throw new Error('MCP process is not available');
    }

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    }) + '\n';

    await writeLine(this.process.stdin, payload);
  }

  async sendRequest(method, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (!this.process?.stdin) {
      throw new Error('MCP process is not available');
    }

    const id = this.nextId;
    this.nextId += 1;

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }) + '\n';

    const resultPromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MCP request timeout for method ' + method));
      }, Math.max(1, timeoutMs));
      timeout.unref?.();

      this.pending.set(id, {
        resolve,
        reject,
        timeout,
        method,
      });
    });

    await writeLine(this.process.stdin, payload);
    return resultPromise;
  }

  onStdout(chunk: string) {
    this.readBuffer += chunk;

    while (true) {
      const newlineIndex = this.readBuffer.indexOf('\n');

      if (newlineIndex < 0) {
        return;
      }

      const rawLine = this.readBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.readBuffer = this.readBuffer.slice(newlineIndex + 1);

      if (!rawLine.trim()) {
        continue;
      }

      this.onMessageLine(rawLine);
    }
  }

  onMessageLine(line: string) {
    let message: any;

    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (!message || typeof message !== 'object' || message.id === undefined || message.id === null) {
      return;
    }

    const numericId = Number(message.id);
    const pending = this.pending.get(numericId);

    if (!pending) {
      return;
    }

    this.pending.delete(numericId);
    clearTimeout(pending.timeout);

    if (message.error) {
      const errorMessage = String(message.error.message || 'MCP request failed');
      pending.reject(new Error(errorMessage));
      return;
    }

    pending.resolve(message.result ?? null);
  }

  rejectPendingRequests(error: Error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function buildEnv(source: Record<string, string> | undefined) {
  const output: Record<string, string> = {};

  if (!source || typeof source !== 'object') {
    return output;
  }

  for (const key of Object.keys(source)) {
    const value = source[key];

    if (typeof value !== 'string') {
      continue;
    }

    output[key] = value;
  }

  return output;
}

function extractToolStructuredContent(result: any) {
  if (result && typeof result === 'object' && result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }

  const text = result?.content?.[0]?.text;

  if (typeof text === 'string' && text.trim()) {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  return result;
}

async function writeLine(stream, payload: string) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    function done(error?: Error | null) {
      if (settled) {
        return;
      }

      settled = true;

      if (error) {
        reject(error);
        return;
      }

      resolve();
    }

    const ok = stream.write(payload, 'utf8', (error) => {
      done(error ?? null);
    });

    if (!ok) {
      stream.once('drain', () => done(null));
    }
  });
}
