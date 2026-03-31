#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';

const ROOT = '/data/claude_moreagent';
const DASHBOARD_DIR = path.join(ROOT, 'src/dashboard');
const MCP_DIR = path.join(ROOT, 'src/mcp-server-codex');
const PORT = 3120;
const HOST = '127.0.0.1';
const TOKEN = 'regression-token';
const BASE_URL = `http://${HOST}:${PORT}`;
const require = createRequire(import.meta.url);
const Database = require(path.join(DASHBOARD_DIR, 'node_modules/better-sqlite3'));

async function main() {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'claude-arch-reg-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  const dbPath = path.join(tempRoot, 'dashboard.db');
  mkdirSync(workspaceDir, { recursive: true });

  let serverProcess = null;

  try {
    await runCommand('npm', ['run', 'build'], { cwd: DASHBOARD_DIR });
    await runCommand('npm', ['run', 'build'], { cwd: MCP_DIR });

    serverProcess = startServer({
      PORT: String(PORT),
      HOST,
      DATABASE_URL: dbPath,
      DASHBOARD_TOKEN: TOKEN,
      WORKSPACE_ROOTS: tempRoot,
      OPENAI_API_KEY: 'dummy',
      CODEX_PROVIDER: 'mcp',
      CODEX_MCP_COMMAND: 'node',
      CODEX_MCP_ARGS: '../mcp-server-codex/dist/index.js',
      CODEX_MCP_CWD: '../mcp-server-codex',
      CONTROL_PLANE_MODE: 'queue',
    });

    await waitForHealth();

    const project = await api('/api/projects', {
      method: 'POST',
      body: {
        name: 'regression-project',
        root_path: workspaceDir,
        language: 'typescript',
        framework: 'none',
        test_command: 'sleep 2',
      },
    });

    const controlPlane = await api('/api/control-plane');
    assert(controlPlane.mode === 'queue', 'control plane mode should be queue');

    const triggerResult = await api('/api/trigger/agent', {
      method: 'POST',
      body: {
        projectId: project.id,
        agent: 'devops',
        args: '生成一段说明文本',
      },
    });
    const toolEvent = await waitForToolCallEvent(triggerResult.agentRunId, 30_000);
    assert(toolEvent?.event_data?.provider === 'mcp', 'single-agent run should use mcp provider');

    const db = new Database(dbPath);
    const { firstSessionId, secondSessionId } = seedApprovalSessions(db, project.id, workspaceDir);
    db.close();

    await Promise.all([
      api(`/api/sessions/${firstSessionId}/approve`, {
        method: 'POST',
        body: { runTests: true },
      }),
      (async () => {
        await sleep(200);
        return api(`/api/sessions/${secondSessionId}/approve`, {
          method: 'POST',
          body: { runTests: false },
        });
      })(),
    ]);

    await waitForSessionTerminal(firstSessionId, 45_000);
    await waitForSessionTerminal(secondSessionId, 45_000);

    const verifyDb = new Database(dbPath);
    const queueRows = verifyDb
      .prepare('SELECT session_id, status, release_reason FROM write_slot_queue WHERE session_id IN (?, ?) ORDER BY id ASC')
      .all(firstSessionId, secondSessionId);
    const lockRows = verifyDb.prepare('SELECT * FROM write_slot_locks').all();
    const phaseRows = verifyDb
      .prepare("SELECT session_id, phase, attempt, status FROM phase_execution_attempts WHERE session_id IN (?, ?) AND phase = 'applying'")
      .all(firstSessionId, secondSessionId);
    const slotAudit = verifyDb
      .prepare("SELECT details FROM audit_log WHERE action = 'slot_event' ORDER BY id ASC")
      .all()
      .map((row) => {
        try {
          return JSON.parse(row.details || '{}');
        } catch {
          return {};
        }
      });
    verifyDb.close();

    assert(queueRows.length >= 2, 'write_slot_queue should contain released rows for two sessions');
    assert(queueRows.every((row) => row.status === 'released'), 'all queued rows should be released');
    assert(lockRows.length === 0, 'write_slot_locks should be empty after completion');
    assert(phaseRows.length >= 2, 'phase_execution_attempts should record applying phase');
    assert(slotAudit.some((entry) => entry.state === 'waiting'), 'slot_event waiting should be emitted');

    console.log(JSON.stringify({
      ok: true,
      projectId: project.id,
      sessions: [firstSessionId, secondSessionId],
      checks: {
        provider: 'mcp',
        controlPlaneMode: 'queue',
        queueRows: queueRows.length,
        phaseRows: phaseRows.length,
        waitingEvent: true,
      },
    }, null, 2));
  } finally {
    if (serverProcess) {
      stopProcess(serverProcess);
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function seedApprovalSessions(db, projectId, workspaceDir) {
  const now = new Date().toISOString();
  const firstSessionId = randomUUID();
  const secondSessionId = randomUUID();
  const firstChangeSetId = randomUUID();
  const secondChangeSetId = randomUUID();

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, project_id, project_path, goal, start_time, status, phase, trigger_source, metadata, active_change_set_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertChangeSet = db.prepare(
    'INSERT INTO change_sets (id, session_id, status, summary, review_notes, files_json, diff_text, test_command_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  insertSession.run(
    firstSessionId,
    projectId,
    workspaceDir,
    'queue-test-1',
    now,
    'running',
    'awaiting_approval',
    'dashboard',
    JSON.stringify({ goal: 'queue-test-1' }),
    firstChangeSetId,
  );
  insertSession.run(
    secondSessionId,
    projectId,
    workspaceDir,
    'queue-test-2',
    now,
    'running',
    'awaiting_approval',
    'dashboard',
    JSON.stringify({ goal: 'queue-test-2' }),
    secondChangeSetId,
  );

  insertChangeSet.run(
    firstChangeSetId,
    firstSessionId,
    'awaiting_approval',
    'first',
    'notes',
    JSON.stringify([{ path: 'first.txt', status: 'create', before_content: null, after_content: 'first' }]),
    'diff',
    'sleep 2',
    now,
    now,
  );
  insertChangeSet.run(
    secondChangeSetId,
    secondSessionId,
    'awaiting_approval',
    'second',
    'notes',
    JSON.stringify([{ path: 'second.txt', status: 'create', before_content: null, after_content: 'second' }]),
    'diff',
    'sleep 2',
    now,
    now,
  );

  return {
    firstSessionId,
    secondSessionId,
  };
}

async function waitForSessionTerminal(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const detail = await api(`/api/sessions/${sessionId}`);
    const status = String(detail?.session?.status || '');

    if (status === 'completed' || status === 'failed' || status === 'aborted') {
      return status;
    }

    await sleep(500);
  }

  throw new Error(`Session did not reach terminal status in time: ${sessionId}`);
}

async function waitForToolCallEvent(runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const events = await api(`/api/agents/${runId}/events?limit=200`);
    const toolCall = (events?.data || []).find((entry) => entry.event_type === 'tool_call');

    if (toolCall) {
      return toolCall;
    }

    await sleep(400);
  }

  throw new Error(`tool_call event not found for run: ${runId}`);
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // ignore and retry
    }

    await sleep(300);
  }

  throw new Error('Dashboard health check timed out');
}

function startServer(extraEnv) {
  const child = spawn('node', ['dist/server/index.js'], {
    cwd: DASHBOARD_DIR,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => undefined);
  child.stderr.on('data', () => undefined);
  return child;
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed: ${stderr}`));
    });
  });
}

async function api(route, options = {}) {
  const response = await fetch(`${BASE_URL}${route}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      'x-dashboard-token': TOKEN,
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`API ${route} failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

function stopProcess(child) {
  if (!child || child.killed) {
    return;
  }

  child.kill('SIGTERM');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
