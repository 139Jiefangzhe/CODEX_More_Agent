import { nowIso } from '../services/helpers.js';

const CONTROL_ACTIONS = new Set(['pause', 'resume', 'skip', 'retry', 'abort']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted', 'skipped']);
const DEFAULT_SIGNAL_TTL_SECONDS = 30 * 60;
const MAX_SIGNAL_TTL_SECONDS = 24 * 60 * 60;
const CORE_WORKFLOW_AGENT_TYPES = new Set(['architect', 'coder', 'reviewer', 'tester']);
const SAFE_SKIP_RETRY_TRIGGERS = new Set(['hook', 'system', 'approval']);

export function registerAgentRoutes(app, services) {
  app.get('/api/agents/:runId/events', async function (request, reply) {
    const run = services.agentService.getRun(request.params.runId);

    if (!run) {
      reply.code(404);
      return { error: 'Agent run not found' };
    }

    try {
      const normalizedFilters = normalizeEventListFilters(request.query ?? {});
      return services.agentService.listEvents(request.params.runId, normalizedFilters);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/agents/:runId/control', async function (request, reply) {
    const run = services.agentService.getRun(request.params.runId);

    if (!run) {
      reply.code(404);
      return { error: 'Agent run not found' };
    }

    const action = normalizeAction(request.body?.action);

    if (!CONTROL_ACTIONS.has(action)) {
      reply.code(400);
      return { error: 'Invalid action. Expected pause|resume|skip|retry|abort' };
    }

    if (!isActionAllowed(action, run.status)) {
      reply.code(400);
      return { error: 'Action ' + action + ' is not allowed when run status is ' + run.status };
    }

    const session = services.sessionService.getSession(run.session_id);
    const unsafeReason = getUnsafeActionReason(action, run, session);

    if (unsafeReason) {
      reply.code(409);
      return {
        error: unsafeReason,
        code: 'unsafe_phase',
        details: {
          action,
          phase: session?.phase ?? 'unknown',
          trigger: run.trigger,
          agent_type: run.agent_type,
        },
      };
    }

    let ttlSeconds;

    try {
      ttlSeconds = parseTtlSeconds(request.body?.ttl_seconds);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }

    const reason = normalizeReason(request.body?.reason);
    let retryResult = null;

    if (action === 'retry') {
      try {
        retryResult = await services.orchestrator.retryRun(run.id, {
          reason,
        });
      } catch (error) {
        reply.code(400);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }

    const softImmediateControl = isSoftImmediateControl(action, run, session);
    const mode = action === 'abort' || action === 'retry' || softImmediateControl ? 'immediate' : 'checkpoint';
    const now = nowIso();
    const effectiveTtl = ttlSeconds ?? DEFAULT_SIGNAL_TTL_SECONDS;
    const expiresAt = mode === 'checkpoint' ? new Date(Date.now() + effectiveTtl * 1000).toISOString() : null;
    const consumedAt = mode === 'immediate' ? now : null;

    try {
      const insertResult = services.db
        .prepare(
          'INSERT INTO control_signals (session_id, agent_run_id, action, reason, created_at, consumed_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(run.session_id, run.id, action, reason, now, consumedAt, expiresAt, 'dashboard');
      const signalId = Number(insertResult.lastInsertRowid);
      const eventPayload = {
        type: 'agent:control_signal',
        timestamp: now,
        data: {
          sessionId: run.session_id,
          agentRunId: run.id,
          action,
          signalId,
          mode,
          timestamp: now,
        },
      };

      services.sessionService.appendAudit('user', 'control', 'agent', run.id, {
        sessionId: run.session_id,
        action,
        mode,
        reason,
        signalId,
        expiresAt,
      });
      services.eventBus.publish('session:' + run.session_id, eventPayload);
      services.eventBus.publish('system', eventPayload);

      if (action === 'retry') {
        const appliedEvent = buildControlAppliedEvent({
          sessionId: run.session_id,
          agentRunId: run.id,
          action,
          signalId,
          mode: 'immediate',
          result: retryResult?.started ? 'retry_started' : 'retry_in_progress',
          timestamp: now,
          extra: {
            retryRunId: retryResult?.retryRunId ?? null,
          },
        });
        services.eventBus.publish('session:' + run.session_id, appliedEvent);
        services.eventBus.publish('system', appliedEvent);
      }

      if (softImmediateControl) {
        if (!TERMINAL_STATUSES.has(run.status)) {
          const status = action === 'pause' ? 'paused' : 'running';
          const summary = action === 'pause' ? 'Paused by control signal' : 'Resumed by control signal';
          services.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, status, summary);
        }

        const appliedEvent = buildControlAppliedEvent({
          sessionId: run.session_id,
          agentRunId: run.id,
          action,
          signalId,
          mode: 'immediate',
          result: action === 'pause' ? 'paused' : 'continued',
          timestamp: now,
        });
        services.eventBus.publish('session:' + run.session_id, appliedEvent);
        services.eventBus.publish('system', appliedEvent);
      }

      if (action === 'abort') {
        if (!TERMINAL_STATUSES.has(run.status)) {
          services.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, 'aborted', 'Aborted by control signal');
        }

        await services.orchestrator.abortSession(run.session_id);

        const appliedEvent = buildControlAppliedEvent({
          sessionId: run.session_id,
          agentRunId: run.id,
          action,
          signalId,
          mode: 'immediate',
          result: 'aborted',
          timestamp: now,
        });
        services.eventBus.publish('session:' + run.session_id, appliedEvent);
        services.eventBus.publish('system', appliedEvent);
      }
      const latestRun = services.agentService.getRun(run.id);

      return {
        accepted: true,
        signal_id: signalId,
        mode,
        session_id: run.session_id,
        agent_run_id: run.id,
        action,
        expires_at: expiresAt,
        session_status: session?.status ?? null,
        run_status: latestRun?.status ?? run.status,
        retry_run_id: action === 'retry' ? retryResult?.retryRunId ?? null : null,
      };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function normalizeAction(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeReason(value) {
  const reason = String(value || '').trim();
  return reason || null;
}

function parseTtlSeconds(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_SIGNAL_TTL_SECONDS) {
    throw new Error('ttl_seconds must be an integer between 1 and ' + MAX_SIGNAL_TTL_SECONDS);
  }

  return parsed;
}

function isActionAllowed(action, status) {
  if (action === 'pause') {
    return status === 'running';
  }

  if (action === 'resume') {
    return status === 'paused';
  }

  if (action === 'skip') {
    return status === 'pending' || status === 'running' || status === 'paused';
  }

  if (action === 'retry') {
    return status === 'completed' || status === 'failed' || status === 'aborted' || status === 'skipped';
  }

  if (action === 'abort') {
    return status === 'pending' || status === 'running' || status === 'paused';
  }

  return false;
}

function getUnsafeActionReason(action, run, session) {
  if (action !== 'skip' && action !== 'retry') {
    return null;
  }

  if (SAFE_SKIP_RETRY_TRIGGERS.has(String(run.trigger || '')) && String(run.agent_type || '') !== 'coder') {
    return null;
  }

  if (run.trigger === 'dashboard' && !CORE_WORKFLOW_AGENT_TYPES.has(String(run.agent_type || ''))) {
    return null;
  }

  if (session && String(session.phase || '') === 'testing') {
    return null;
  }

  if (run.trigger === 'approval' && String(run.agent_type || '') === 'tester') {
    return null;
  }

  if (run.trigger === 'approval' && String(run.agent_type || '') === 'coder') {
    return null;
  }

  return 'Action ' + action + ' is blocked in current phase for safety. Use pause/resume/abort or wait for applying/testing phase.';
}

function buildControlAppliedEvent(input) {
  return {
    type: 'agent:control_applied',
    timestamp: input.timestamp,
    data: {
      sessionId: input.sessionId,
      agentRunId: input.agentRunId,
      action: input.action,
      signalId: input.signalId,
      mode: input.mode,
      result: input.result,
      timestamp: input.timestamp,
      ...(input.extra || {}),
    },
  };
}

function isSoftImmediateControl(action, run, session) {
  if (action !== 'pause' && action !== 'resume') {
    return false;
  }

  return run.agent_type === 'coder' && run.trigger === 'dashboard' && String(session?.phase || '') === 'implementing';
}

function normalizeEventListFilters(rawQuery) {
  const query = rawQuery || {};
  const output: Record<string, unknown> = {
    page: parsePositiveInteger(query.page, 'page', 1, 100000, 1),
    limit: parsePositiveInteger(query.limit, 'limit', 1, 1000, 200),
  };
  const normalizedEventType = normalizeOptionalString(query.event_type);

  if (normalizedEventType) {
    output.event_type = normalizedEventType;
  }

  return output;
}

function parsePositiveInteger(value, fieldName, min, max, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim();

  if (!/^\d+$/.test(normalized)) {
    throw new Error(fieldName + ' must be an integer between ' + min + ' and ' + max);
  }

  const parsed = Number.parseInt(normalized, 10);

  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(fieldName + ' must be an integer between ' + min + ' and ' + max);
  }

  return parsed;
}

function normalizeOptionalString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}
