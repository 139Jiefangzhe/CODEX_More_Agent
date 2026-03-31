function buildSessionDetail(services, sessionId) {
  const session = services.sessionService.getSession(sessionId);

  if (!session) {
    return null;
  }

  const project = services.projectService.getProject(session.project_id);

  if (!project) {
    return null;
  }

  return {
    session,
    project,
    agents: services.agentService.listSessionRuns(sessionId),
    changeSet: services.changeSetService.getBySession(sessionId),
  };
}

export function registerSessionRoutes(app, services) {
  app.get('/api/sessions', async function (request, reply) {
    try {
      const normalizedQuery = normalizeSessionListQuery(request.query ?? {});
      return services.sessionService.listSessions(normalizedQuery);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/sessions', async function (request, reply) {
    try {
      const session = await services.orchestrator.startSession(request.body.projectId, request.body.goal);
      reply.code(202);
      return session;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get('/api/sessions/:id', async function (request, reply) {
    const detail = buildSessionDetail(services, request.params.id);

    if (!detail) {
      reply.code(404);
      return { error: 'Session not found' };
    }

    return detail;
  });

  app.post('/api/sessions/:id/approve', async function (request, reply) {
    try {
      await services.orchestrator.approveSession(request.params.id, request.body?.runTests);
      return buildSessionDetail(services, request.params.id);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/sessions/:id/reject', async function (request, reply) {
    try {
      await services.orchestrator.rejectSession(request.params.id);
      return buildSessionDetail(services, request.params.id);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/sessions/:id/abort', async function (request, reply) {
    try {
      await services.orchestrator.abortSession(request.params.id);
      return buildSessionDetail(services, request.params.id);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function normalizeSessionListQuery(rawQuery) {
  const query = rawQuery || {};
  const output: Record<string, unknown> = {
    page: parsePositiveInteger(query.page, 'page', 1, 100000, 1),
    limit: parsePositiveInteger(query.limit, 'limit', 1, 100, 20),
  };
  const normalizedStatus = normalizeOptionalString(query.status);
  const normalizedProjectId = normalizeOptionalString(query.project_id);

  if (normalizedStatus) {
    output.status = normalizedStatus;
  }

  if (normalizedProjectId) {
    output.project_id = normalizedProjectId;
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
