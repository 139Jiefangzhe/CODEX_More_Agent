import { v4 as uuidv4 } from 'uuid';

const CORE_WORKFLOW_AGENTS = new Set(['architect', 'coder', 'reviewer', 'tester']);
const EXTENDED_AGENTS = new Set(['devops', 'security', 'uiux']);

export function registerTriggerRoutes(app, services) {
  app.post('/api/trigger/agent', async function (request, reply) {
    const agent = String(request.body?.agent || '').trim();
    const args = String(request.body?.args || '').trim();
    const projectId = String(request.body?.projectId || '').trim();

    if (!projectId) {
      reply.code(400);
      return { error: 'projectId is required' };
    }

    if (!CORE_WORKFLOW_AGENTS.has(agent) && !EXTENDED_AGENTS.has(agent)) {
      reply.code(400);
      return { error: 'Invalid agent type: ' + agent };
    }

    if (!args) {
      reply.code(400);
      return { error: 'args is required' };
    }

    try {
      if (CORE_WORKFLOW_AGENTS.has(agent)) {
        const session = await services.orchestrator.startSession(projectId, buildCoreGoal(agent, args));
        const firstRunId = await waitForFirstRun(services.agentService, session.id, 5000);

        services.sessionService.appendAudit('user', 'trigger', 'agent', firstRunId || session.id, {
          mode: 'main_workflow',
          sessionId: session.id,
          agent,
        });

        return {
          sessionId: session.id,
          agentRunId: firstRunId || session.id,
          status: 'started',
        };
      }

      const project = services.projectService.getProject(projectId);

      if (!project) {
        reply.code(404);
        return { error: 'Project not found: ' + projectId };
      }

      if (!services.orchestrator.codexExecutor.isConfigured()) {
        reply.code(400);
        return { error: 'OPENAI_API_KEY is not configured' };
      }

      const session = services.sessionService.createSession(project, buildCoreGoal(agent, args), 'dashboard');
      const run = services.agentService.createAgentRun(session.id, agent, 'dashboard', 'Manual agent trigger', 3);

      services.sessionService.appendAudit('user', 'trigger', 'agent', run.id, {
        mode: 'single_agent',
        sessionId: session.id,
        projectId,
        agent,
      });

      void runSingleAgentTask(services, {
        sessionId: session.id,
        runId: run.id,
        project,
        agent,
        args,
      }).catch(function (error) {
        console.error('Single agent trigger failed:', error);
      });

      return {
        sessionId: session.id,
        agentRunId: run.id,
        status: 'started',
      };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function buildCoreGoal(agent, args) {
  return [
    'Dashboard manual trigger',
    'Agent: ' + agent,
    '',
    args,
  ].join('\n');
}

async function waitForFirstRun(agentService, sessionId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const runs = agentService.listSessionRuns(sessionId);

    if (runs.length > 0) {
      return runs[0].id;
    }

    await delay(120);
  }

  return null;
}

async function runSingleAgentTask(services, input) {
  services.agentService.updateRunStatus(input.runId, input.sessionId, input.agent, 'running');
  services.sessionService.updateSession(input.sessionId, { phase: 'implementing' });
  services.agentService.appendEvent({
    runId: input.runId,
    sessionId: input.sessionId,
    agentType: input.agent,
    eventType: 'step_start',
    eventData: { message: 'Running manual ' + input.agent + ' task' },
  });

  try {
    const context = await services.projectService.buildContext(input.project);
    const filesToRead = context.keyFiles.slice(0, 10).map(function (file) {
      return file.path;
    });
    const filesContext = await services.projectService.readExistingFiles(input.project, filesToRead);
    const responseId = await services.orchestrator.codexExecutor.submitTask(
      uuidv4(),
      buildSingleAgentInstructions(input, filesContext),
      8000,
      {
        filesContext,
        language: input.project.language,
        framework: input.project.framework,
        expectedOutputFiles: filesToRead,
        timeoutSeconds: 600,
      },
    );

    services.agentService.appendEvent({
      runId: input.runId,
      sessionId: input.sessionId,
      agentType: input.agent,
      eventType: 'tool_call',
      eventData: {
        tool: services.orchestrator.codexExecutor?.name === 'mcp' ? 'mcp:codex.submit_task' : 'gpt-5.3-codex',
        provider: services.orchestrator.codexExecutor?.name || 'responses',
        responseId,
        filesContext: filesToRead,
      },
    });

    const result = await services.orchestrator.codexExecutor.waitForResult(responseId);

    if (result.status !== 'completed') {
      throw new Error(result.error || 'Agent task failed');
    }

    services.agentService.appendEvent({
      runId: input.runId,
      sessionId: input.sessionId,
      agentType: input.agent,
      eventType: 'output',
      eventData: {
        message: 'Manual agent task completed',
        summary: result.logs || 'No output',
        files: result.files.map(function (file) {
          return file.path;
        }),
      },
    });

    if (result.files.length > 0) {
      services.agentService.appendEvent({
        runId: input.runId,
        sessionId: input.sessionId,
        agentType: input.agent,
        eventType: 'checkpoint',
        eventData: {
          message: 'Generated file proposals are review-only in single-agent mode',
          files: result.files.map(function (file) {
            return file.path;
          }),
        },
      });
    }

    services.agentService.updateRunStatus(input.runId, input.sessionId, input.agent, 'completed', result.logs || 'Task completed');
    services.sessionService.markCompleted(input.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.agentService.appendEvent({
      runId: input.runId,
      sessionId: input.sessionId,
      agentType: input.agent,
      eventType: 'error',
      eventData: { message },
    });
    services.agentService.updateRunStatus(input.runId, input.sessionId, input.agent, 'failed', message);
    services.sessionService.markFailed(input.sessionId, message);
  }
}

function buildSingleAgentInstructions(input, filesContext) {
  return [
    'You are running as a specialized agent in dashboard single-agent mode.',
    'Agent type: ' + input.agent,
    'Project path: ' + input.project.root_path,
    'Language: ' + input.project.language,
    'Framework: ' + (input.project.framework || 'unknown'),
    '',
    'Task:',
    input.args,
    '',
    'Constraints:',
    '- This mode is review-only. Do not assume changes will be applied immediately.',
    '- If you suggest file changes, include them in files as proposals.',
    '- Keep final guidance concise and actionable in logs.',
    '',
    'Context files:',
    formatContextFiles(filesContext),
  ].join('\n');
}

function formatContextFiles(files) {
  if (!files.length) {
    return '- No context files available';
  }

  return files
    .map(function (file) {
      return ['File: ' + file.path, '```', file.content, '```'].join('\n');
    })
    .join('\n\n');
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}
