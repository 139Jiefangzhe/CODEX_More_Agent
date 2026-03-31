import 'dotenv/config';

import { existsSync } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';

import { registerAgentRoutes } from './routes/agents.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerTriggerRoutes } from './routes/trigger.js';
import { createDatabase } from './services/db.js';
import { createEventBus } from './services/event-bus.js';
import { createExecutionProvider } from './services/execution-provider.js';
import { AgentService } from './services/agent-service.js';
import { ChangeSetService } from './services/change-set-service.js';
import { ConfigService } from './services/config-service.js';
import { OrchestratorService } from './services/orchestrator-service.js';
import { ProjectService } from './services/project-service.js';
import { SessionService } from './services/session-service.js';
import { registerWebSocket } from './ws/handler.js';

async function main() {
  const app = Fastify({ logger: false });
  const databaseUrl = process.env.DATABASE_URL || './data/dashboard.db';
  const openaiBaseUrl = process.env.OPENAI_BASE_URL || process.env.BASE_URL || undefined;
  const eventBusType = process.env.EVENT_BUS_TYPE || 'emitter';
  const redisUrl = process.env.REDIS_URL || '';
  const db = createDatabase(databaseUrl);
  const eventBus = await createEventBus({
    type: eventBusType,
    redisUrl,
  });
  const projectService = new ProjectService(db);
  const sessionService = new SessionService(db, eventBus);
  const agentService = new AgentService(db, eventBus);
  const changeSetService = new ChangeSetService(db, eventBus);
  const executionProvider = createExecutionProvider({
    provider: process.env.CODEX_PROVIDER || 'responses',
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: openaiBaseUrl,
    model: process.env.CODEX_MODEL || 'gpt-5.3-codex',
    timeoutSeconds: Number.parseInt(process.env.CODEX_TIMEOUT || '600', 10),
    pollIntervalMs: Number.parseInt(process.env.CODEX_POLL_INTERVAL_MS || '1500', 10),
    mcpCommand: process.env.CODEX_MCP_COMMAND || 'node',
    mcpArgsRaw: process.env.CODEX_MCP_ARGS || '',
    mcpEntry: process.env.CODEX_MCP_ENTRY || '',
    mcpCwd: process.env.CODEX_MCP_CWD || '',
  });
  const configService = new ConfigService({
    sessionService,
    eventBus,
  });
  const orchestrator = new OrchestratorService({
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: openaiBaseUrl,
    controllerModel: process.env.DASHBOARD_CONTROLLER_MODEL || 'gpt-5.4',
    codexModel: process.env.CODEX_MODEL || 'gpt-5.3-codex',
    codexTimeoutSeconds: Number.parseInt(process.env.CODEX_TIMEOUT || '600', 10),
    controlPlaneMode: process.env.CONTROL_PLANE_MODE || 'direct',
    projectService,
    sessionService,
    agentService,
    changeSetService,
    executionProvider,
  });
  const services = {
    db,
    eventBus,
    projectService,
    sessionService,
    agentService,
    changeSetService,
    configService,
    orchestrator,
  };

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin) {
        callback(null, false);
        return;
      }

      callback(null, isAllowedOrigin(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-dashboard-token'],
    maxAge: 600,
  });
  await app.register(websocket);

  app.addHook('onRequest', async function (request, reply) {
    if (!requiresDashboardToken(request.method, request.url)) {
      return;
    }

    const expectedToken = String(process.env.DASHBOARD_TOKEN || '').trim();

    if (!expectedToken) {
      reply.code(503);
      reply.send({ error: 'DASHBOARD_TOKEN is required for protected API requests' });
      return;
    }

    const providedToken = String(request.headers['x-dashboard-token'] || '').trim();

    if (!providedToken || providedToken !== expectedToken) {
      reply.code(401);
      reply.send({ error: 'Invalid or missing x-dashboard-token' });
      return;
    }

    const originHeader = String(request.headers.origin || '').trim();

    if (originHeader && !isAllowedOrigin(originHeader, request.headers.host)) {
      reply.code(403);
      reply.send({ error: 'Origin is not allowed' });
      return;
    }
  });

  registerProjectRoutes(app, services);
  registerSessionRoutes(app, services);
  registerAgentRoutes(app, services);
  registerTriggerRoutes(app, services);
  registerConfigRoutes(app, services);
  registerHistoryRoutes(app, services);
  registerInternalRoutes(app, services);
  registerSystemRoutes(app, services);
  registerWebSocket(app, services);

  app.addHook('onClose', async function () {
    if (typeof executionProvider.close === 'function') {
      await executionProvider.close();
    }

    if (typeof eventBus.close === 'function') {
      await eventBus.close();
    }
  });

  const clientRoot = path.resolve(process.cwd(), 'dist/client');
  const clientIndexFile = path.join(clientRoot, 'index.html');
  const hasClientBundle = existsSync(clientIndexFile);

  if (hasClientBundle) {
    await app.register(fastifyStatic, {
      root: clientRoot,
      prefix: '/',
    });
  }

  app.setNotFoundHandler(function (request, reply) {
    if (hasClientBundle && shouldServeSpaFallback(request)) {
      reply.type('text/html; charset=utf-8');
      reply.sendFile('index.html');
      return;
    }

    const pathname = String(request.url || '').split('?')[0] || '/';
    reply.code(404).send({
      message: 'Route ' + request.method + ':' + pathname + ' not found',
      error: 'Not Found',
      statusCode: 404,
    });
  });

  await app.listen({
    port: Number.parseInt(process.env.PORT || '3100', 10),
    host: process.env.HOST || '127.0.0.1',
  });
}

function isMutatingApiRequest(method, rawUrl) {
  const normalizedMethod = String(method || '').toUpperCase();
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod);
}

function requiresDashboardToken(method, rawUrl) {
  const normalizedMethod = String(method || '').toUpperCase();

  if (normalizedMethod === 'OPTIONS') {
    return false;
  }

  const pathname = String(rawUrl || '').split('?')[0];

  if (!pathname.startsWith('/api/')) {
    return false;
  }

  if (pathname === '/api/config' || pathname.startsWith('/api/config/')) {
    return true;
  }

  return isMutatingApiRequest(method, rawUrl);
}

function isAllowedOrigin(origin, requestHostHeader = '') {
  const source = String(origin || '').trim();

  if (!source) {
    return false;
  }

  try {
    const parsed = new URL(source);
    const protocol = parsed.protocol;
    const originHost = parsed.hostname.toLowerCase();
    const requestHost = normalizeHostHeader(requestHostHeader);

    if (protocol !== 'http:' && protocol !== 'https:') {
      return false;
    }

    if (originHost === 'localhost' || originHost === '127.0.0.1' || originHost === '::1') {
      return true;
    }

    if (!requestHost) {
      return false;
    }

    return originHost === requestHost;
  } catch {
    return false;
  }
}

function normalizeHostHeader(rawHostHeader) {
  const rawHost = String(rawHostHeader || '').trim().toLowerCase();

  if (!rawHost) {
    return '';
  }

  const hostWithoutPort = rawHost.split(',')[0].trim();

  if (!hostWithoutPort) {
    return '';
  }

  if (hostWithoutPort.startsWith('[')) {
    const endIndex = hostWithoutPort.indexOf(']');
    return endIndex > 1 ? hostWithoutPort.slice(1, endIndex) : hostWithoutPort;
  }

  const firstColon = hostWithoutPort.indexOf(':');

  if (firstColon === -1) {
    return hostWithoutPort;
  }

  return hostWithoutPort.slice(0, firstColon);
}

function shouldServeSpaFallback(request) {
  const method = String(request.method || '').toUpperCase();

  if (method !== 'GET') {
    return false;
  }

  const pathname = String(request.url || '').split('?')[0] || '/';

  if (!pathname || pathname.startsWith('/api/') || pathname === '/api' || pathname === '/ws' || pathname.startsWith('/ws/')) {
    return false;
  }

  if (path.extname(pathname)) {
    return false;
  }

  const accept = String(request.headers?.accept || '').toLowerCase();

  if (!accept) {
    return true;
  }

  return accept.includes('text/html') || accept.includes('*/*');
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
