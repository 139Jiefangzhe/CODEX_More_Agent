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
const require = createRequire(import.meta.url);
const Database = require(path.join(DASHBOARD_DIR, 'node_modules/better-sqlite3'));

async function main() {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'claude-arch-restart-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  const dbPath = path.join(tempRoot, 'dashboard.db');
  const port = 3121;
  const host = '127.0.0.1';
  const token = 'restart-token';
  const baseUrl = `http://${host}:${port}`;
  mkdirSync(workspaceDir, { recursive: true });

  let child = null;

  try {
    await runCommand('npm', ['run', 'build'], { cwd: DASHBOARD_DIR });
    await runCommand('node', ['server/db/init-db.mjs'], {
      cwd: DASHBOARD_DIR,
      env: {
        DATABASE_URL: dbPath,
      },
    });

    const db = new Database(dbPath);
    const projectId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      'INSERT INTO projects (id, name, root_path, language, framework, test_command, ignore_paths, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(projectId, 'restart-project', workspaceDir, 'typescript', 'none', null, '[]', now, now);

    db.prepare(
      'INSERT INTO sessions (id, project_id, project_path, goal, start_time, status, phase, trigger_source, metadata, active_change_set_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    ).run(sessionId, projectId, workspaceDir, 'restart-recovery', now, 'running', 'planning', 'dashboard', JSON.stringify({ goal: 'restart-recovery' }));

    db.prepare(
      'INSERT INTO session_dispatch_jobs (session_id, reason, status, error_message, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)',
    ).run(sessionId, 'startup_seed', 'running', now, now);

    db.prepare(
      'INSERT INTO write_slot_locks (project_id, session_id, acquired_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(projectId, sessionId, now, now);

    db.close();

    child = spawn('node', ['dist/server/index.js'], {
      cwd: DASHBOARD_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: host,
        DATABASE_URL: dbPath,
        DASHBOARD_TOKEN: token,
        WORKSPACE_ROOTS: tempRoot,
        OPENAI_API_KEY: 'dummy',
        CONTROL_PLANE_MODE: 'queue',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', () => undefined);

    await waitForHealth(baseUrl);

    const deadline = Date.now() + 30_000;
    let dispatchRecovered = false;
    let lockRecovered = false;

    while (Date.now() < deadline) {
      const checkDb = new Database(dbPath);
      const jobs = checkDb
        .prepare('SELECT status FROM session_dispatch_jobs WHERE session_id = ? ORDER BY id DESC LIMIT 1')
        .all(sessionId);
      const locks = checkDb.prepare('SELECT * FROM write_slot_locks WHERE project_id = ?').all(projectId);
      checkDb.close();

      dispatchRecovered = jobs.length > 0 && jobs[0].status !== 'running';
      lockRecovered = locks.length === 0;

      if (dispatchRecovered && lockRecovered) {
        break;
      }

      await sleep(500);
    }

    if (!dispatchRecovered) {
      throw new Error('session_dispatch_jobs running state was not recovered');
    }

    if (!lockRecovered) {
      throw new Error('stale write_slot_locks row was not recovered');
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          checks: {
            dispatchRecovered,
            lockRecovered,
          },
          dbPath,
        },
        null,
        2,
      ),
    );
  } finally {
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }
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

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }

    await sleep(300);
  }

  throw new Error('Dashboard health check timed out');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
