export function registerConfigRoutes(app, services) {
  app.get('/api/config/mcp-servers', async function (request, reply) {
    const data = await services.configService.listMcpServers();
    await setConfigVersionHeader(reply, services.configService);
    return data;
  });

  app.post('/api/config/mcp-servers', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.upsertMcpServer(request.body?.name, request.body, {
        expectedVersion,
      });

      setConfigVersionHeaderValue(reply, result.version);
      reply.code(201);
      return { ok: true, version: result.version };
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.put('/api/config/mcp-servers/:name', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.upsertMcpServer(request.params.name, request.body, {
        expectedVersion,
      });

      setConfigVersionHeaderValue(reply, result.version);
      return { ok: true, version: result.version };
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.delete('/api/config/mcp-servers/:name', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.deleteMcpServer(request.params.name, {
        expectedVersion,
      });

      setConfigVersionHeaderValue(reply, result.version);
      return { ok: true, version: result.version };
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.post('/api/config/mcp-servers/sync', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.syncMcpServers({
        expectedVersion,
      });
      setConfigVersionHeaderValue(reply, result.version);
      return result;
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.get('/api/config/hooks', async function (request, reply) {
    const data = await services.configService.listHooks();
    await setConfigVersionHeader(reply, services.configService);
    return data;
  });

  app.post('/api/config/hooks', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.upsertHook(null, request.body, {
        expectedVersion,
      });

      setConfigVersionHeaderValue(reply, result.version);
      reply.code(201);
      return { ok: true, version: result.version };
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.put('/api/config/hooks/:id', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.upsertHook(request.params.id, request.body, {
        expectedVersion,
      });

      setConfigVersionHeaderValue(reply, result.version);
      return { ok: true, version: result.version };
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.delete('/api/config/hooks/:id', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.deleteHook(request.params.id, {
        expectedVersion,
      });

      setConfigVersionHeaderValue(reply, result.version);
      return { ok: true, version: result.version };
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.post('/api/config/hooks/reorder', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.reorderHooks(request.body?.hook_type, request.body?.ordered_ids || [], {
        expectedVersion,
      });

      setConfigVersionHeaderValue(reply, result.version);
      return { ok: true, version: result.version };
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.post('/api/config/hooks/sync', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.syncHooks({
        expectedVersion,
      });
      setConfigVersionHeaderValue(reply, result.version);
      return result;
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.get('/api/config/commands', async function (request, reply) {
    const data = await services.configService.listCommands();
    await setConfigVersionHeader(reply, services.configService);
    return data;
  });

  app.get('/api/config/commands/:name', async function (request, reply) {
    try {
      const command = await services.configService.getCommand(request.params.name);
      await setConfigVersionHeader(reply, services.configService);

      if (!command) {
        reply.code(404);
        return { error: 'Command not found' };
      }

      return command;
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.post('/api/config/commands', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.upsertCommand(request.body?.name, request.body?.content ?? '', {
        expectedVersion,
      });

      setConfigVersionHeaderValue(reply, result.version);
      reply.code(201);
      return { ok: true, version: result.version };
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.put('/api/config/commands/:name', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.upsertCommand(request.params.name, request.body?.content ?? '', {
        expectedVersion,
      });

      setConfigVersionHeaderValue(reply, result.version);
      return { ok: true, version: result.version };
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.delete('/api/config/commands/:name', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.deleteCommand(request.params.name, {
        expectedVersion,
      });

      setConfigVersionHeaderValue(reply, result.version);
      return { ok: true, version: result.version };
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });

  app.post('/api/config/commands/sync', async function (request, reply) {
    try {
      const expectedVersion = readExpectedVersion(request);
      const result = await services.configService.syncCommands({
        expectedVersion,
      });
      setConfigVersionHeaderValue(reply, result.version);
      return result;
    } catch (error) {
      return handleConfigError(reply, error);
    }
  });
}

async function setConfigVersionHeader(reply, configService) {
  const version = await configService.getVersion();
  setConfigVersionHeaderValue(reply, version);
}

function setConfigVersionHeaderValue(reply, version) {
  if (version === undefined || version === null) {
    return;
  }

  reply.header('x-config-version', String(version));
}

function readExpectedVersion(request) {
  const fromBody = request.body?.expected_version;

  if (fromBody !== undefined && fromBody !== null && fromBody !== '') {
    return parseExpectedVersionValue(fromBody);
  }

  const fromHeader = request.headers?.['x-config-version'] ?? request.headers?.['if-match'];

  if (fromHeader === undefined || fromHeader === null || fromHeader === '') {
    return undefined;
  }

  const normalized = Array.isArray(fromHeader) ? String(fromHeader[0] || '') : String(fromHeader);
  return parseExpectedVersionValue(normalizeIfMatchHeader(normalized));
}

function normalizeIfMatchHeader(value) {
  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }

  return text;
}

function parseExpectedVersionValue(value) {
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

function handleConfigError(reply, error) {
  const statusCode = (error as any)?.code === 'VERSION_CONFLICT' ? 409 : 400;
  reply.code(statusCode);

  const base = {
    error: error instanceof Error ? error.message : String(error),
  } as Record<string, unknown>;

  if ((error as any)?.code === 'VERSION_CONFLICT') {
    base.code = 'version_conflict';
    base.expected_version = (error as any)?.expected;
    base.current_version = (error as any)?.actual;
  }

  return base;
}
