import { nowIso, parseJson } from '../services/helpers.js';

export function registerInternalRoutes(app, services) {
  app.post('/api/internal/notify', async function (request, reply) {
    if (!isInternalAuthorized(request)) {
      reply.code(401);
      return { error: 'Unauthorized internal notify request' };
    }

    const kind = String(request.body?.kind || '').trim();
    const payload = request.body?.payload && typeof request.body.payload === 'object' ? request.body.payload : {};

    if (!kind) {
      reply.code(400);
      return { error: 'kind is required' };
    }

    if (kind === 'agent_event') {
      const publishedCount = publishAgentEvents(services, payload);
      return { ok: true, kind, publishedCount };
    }

    if (kind === 'control_applied') {
      const event = buildControlAppliedEvent(payload);

      if (!event) {
        reply.code(400);
        return { error: 'Invalid control_applied payload' };
      }

      services.eventBus.publish('session:' + event.data.sessionId, event);
      services.eventBus.publish('system', event);
      return { ok: true, kind, publishedCount: 1 };
    }

    return { ok: true, ignored: true, kind };
  });
}

function isInternalAuthorized(request) {
  const expectedToken = String(process.env.DASHBOARD_TOKEN || '').trim();
  const providedToken = String(request.headers['x-dashboard-token'] || '').trim();
  return Boolean(expectedToken) && Boolean(providedToken) && providedToken === expectedToken;
}

function publishAgentEvents(services, payload) {
  const runId = String(payload.agentRunId || payload.runId || '').trim();
  const sessionId = String(payload.sessionId || '').trim();
  const eventId = toInteger(payload.eventId);
  const rows = loadAgentEventRows(services, {
    runId,
    sessionId,
    eventId,
  });
  let publishedCount = 0;

  for (const row of rows) {
    const event = {
      type: 'agent:event',
      timestamp: row.timestamp,
      data: {
        sessionId: row.session_id,
        agentRunId: row.agent_run_id,
        agentType: findAgentType(services, row.agent_run_id),
        eventType: row.event_type,
        payload: parseJson(row.event_data, {}),
        timestamp: row.timestamp,
        eventId: Number(row.id),
      },
    };

    services.eventBus.publish('session:' + row.session_id, event);
    services.eventBus.publish('system', event);
    publishedCount += 1;
  }

  return publishedCount;
}

function loadAgentEventRows(services, input) {
  if (input.eventId) {
    const row = services.db.prepare('SELECT * FROM agent_events WHERE id = ?').get(input.eventId);
    return row ? [row] : [];
  }

  if (input.runId) {
    const row = services.db.prepare('SELECT * FROM agent_events WHERE agent_run_id = ? ORDER BY id DESC LIMIT 1').get(input.runId);
    return row ? [row] : [];
  }

  if (input.sessionId) {
    const row = services.db.prepare('SELECT * FROM agent_events WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(input.sessionId);
    return row ? [row] : [];
  }

  return [];
}

function findAgentType(services, runId) {
  if (!runId) {
    return 'reviewer';
  }

  const run = services.agentService.getRun(runId);
  return run?.agent_type || 'reviewer';
}

function buildControlAppliedEvent(payload) {
  const sessionId = String(payload.sessionId || '').trim();
  const agentRunId = String(payload.agentRunId || '').trim();
  const action = String(payload.action || '').trim().toLowerCase();

  if (!sessionId || !agentRunId || !action) {
    return null;
  }

  const signalId = toInteger(payload.signalId) || 0;
  const mode = String(payload.mode || 'checkpoint').trim().toLowerCase() === 'immediate' ? 'immediate' : 'checkpoint';
  const result = String(payload.result || action).trim().toLowerCase();
  const timestamp = String(payload.timestamp || nowIso());

  return {
    type: 'agent:control_applied',
    timestamp,
    data: {
      sessionId,
      agentRunId,
      action,
      signalId,
      mode,
      result,
      timestamp,
    },
  };
}

function toInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}
