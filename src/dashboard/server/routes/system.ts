export function registerSystemRoutes(app, services) {
  app.get('/api/health', async function () {
    return { status: 'ok' };
  });

  app.get('/api/control-plane', async function () {
    const queuedJobs = services.db.prepare("SELECT COUNT(*) AS total FROM session_dispatch_jobs WHERE status = 'queued'").get().total;
    const runningJobs = services.db.prepare("SELECT COUNT(*) AS total FROM session_dispatch_jobs WHERE status = 'running'").get().total;

    return {
      mode: services.orchestrator.controlPlaneMode || 'direct',
      activeLoops: services.orchestrator.activeSessionLoops?.size || 0,
      dispatchQueue: {
        queued: queuedJobs,
        running: runningJobs,
      },
      executionProvider: services.orchestrator.executionProvider?.name || 'responses',
    };
  });

  app.get('/api/stats', async function () {
    return services.agentService.getStats();
  });

  app.get('/api/overview', async function () {
    return {
      activeSessions: services.sessionService.listActiveSessions(),
      recentEvents: services.agentService.getRecentEvents(),
      projects: services.projectService.listProjects(),
      stats: services.agentService.getStats(),
    };
  });
}
