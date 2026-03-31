export function registerHistoryRoutes(app, services) {
  app.get('/api/history', async function (request, reply) {
    try {
      const page = normalizePage(request.query?.page);
      const limit = normalizeLimit(request.query?.limit, 20, 200);
      const conditions = [];
      const params = [];

      if (request.query?.agent_type) {
        conditions.push('ar.agent_type = ?');
        params.push(String(request.query.agent_type));
      }

      if (request.query?.status) {
        conditions.push('ar.status = ?');
        params.push(String(request.query.status));
      }

      if (request.query?.trigger) {
        conditions.push('ar.trigger = ?');
        params.push(String(request.query.trigger));
      }

      if (request.query?.from) {
        conditions.push('ar.started_at >= ?');
        params.push(String(request.query.from));
      }

      if (request.query?.to) {
        conditions.push('ar.started_at <= ?');
        params.push(String(request.query.to));
      }

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      const totalRow = services.db
        .prepare('SELECT COUNT(*) as total FROM agent_runs ar JOIN sessions s ON s.id = ar.session_id ' + whereClause)
        .get(...params);
      const rows = services.db
        .prepare(
          'SELECT ar.*, s.goal, s.project_path FROM agent_runs ar JOIN sessions s ON s.id = ar.session_id ' +
            whereClause +
            ' ORDER BY ar.started_at DESC LIMIT ? OFFSET ?',
        )
        .all(...params, limit, (page - 1) * limit);

      return {
        data: rows.map(function (row) {
          return {
            agent_run_id: row.id,
            session_id: row.session_id,
            project_path: row.project_path,
            goal: row.goal,
            agent_type: row.agent_type,
            status: row.status,
            trigger: row.trigger,
            started_at: row.started_at,
            finished_at: row.finished_at,
            duration_seconds: toDurationSeconds(row.started_at, row.finished_at),
            step_current: row.step_current,
            step_total: row.step_total,
            input_summary: row.input_summary,
            output_summary: row.output_summary,
          };
        }),
        total: totalRow?.total ?? 0,
        page,
        limit,
      };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get('/api/history/:sessionId/timeline', async function (request, reply) {
    const session = services.sessionService.getSession(request.params.sessionId);

    if (!session) {
      reply.code(404);
      return { error: 'Session not found' };
    }

    const runs = services.agentService.listSessionRuns(request.params.sessionId);

    return {
      session,
      timeline: runs.map(function (run) {
        return {
          agentRunId: run.id,
          agentType: run.agent_type,
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          status: run.status,
          trigger: run.trigger,
          durationSeconds: toDurationSeconds(run.started_at, run.finished_at),
        };
      }),
    };
  });

  app.get('/api/audit-log', async function (request, reply) {
    try {
      const page = normalizePage(request.query?.page);
      const limit = normalizeLimit(request.query?.limit, 50, 200);
      const conditions = [];
      const params = [];

      if (request.query?.actor) {
        conditions.push('actor = ?');
        params.push(String(request.query.actor));
      }

      if (request.query?.action) {
        conditions.push('action = ?');
        params.push(String(request.query.action));
      }

      if (request.query?.target_type) {
        conditions.push('target_type = ?');
        params.push(String(request.query.target_type));
      }

      if (request.query?.from) {
        conditions.push('timestamp >= ?');
        params.push(String(request.query.from));
      }

      if (request.query?.to) {
        conditions.push('timestamp <= ?');
        params.push(String(request.query.to));
      }

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      const totalRow = services.db.prepare('SELECT COUNT(*) as total FROM audit_log ' + whereClause).get(...params);
      const rows = services.db
        .prepare('SELECT * FROM audit_log ' + whereClause + ' ORDER BY timestamp DESC LIMIT ? OFFSET ?')
        .all(...params, limit, (page - 1) * limit);

      return {
        data: rows.map(function (row) {
          return {
            ...row,
            details: parseJson(row.details, null),
          };
        }),
        total: totalRow?.total ?? 0,
        page,
        limit,
      };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function normalizePage(value) {
  const page = Number.parseInt(String(value ?? '1'), 10);

  if (Number.isNaN(page) || page < 1) {
    return 1;
  }

  return page;
}

function normalizeLimit(value, fallback, max) {
  const limit = Number.parseInt(String(value ?? fallback), 10);

  if (Number.isNaN(limit) || limit < 1) {
    return fallback;
  }

  return Math.min(limit, max);
}

function toDurationSeconds(startedAt, finishedAt) {
  const started = Date.parse(startedAt || '');

  if (!Number.isFinite(started)) {
    return 0;
  }

  const ended = finishedAt ? Date.parse(finishedAt) : Date.now();

  if (!Number.isFinite(ended)) {
    return 0;
  }

  return Number((Math.max(0, ended - started) / 1000).toFixed(2));
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
