export function registerProjectRoutes(app, services) {
  app.get('/api/projects', async function () {
    return services.projectService.listProjects();
  });

  app.get('/api/projects/:id', async function (request, reply) {
    const project = services.projectService.getProject(request.params.id);

    if (!project) {
      reply.code(404);
      return { error: 'Project not found' };
    }

    return project;
  });

  app.post('/api/projects', async function (request, reply) {
    try {
      const validatedRootPath = await services.projectService.validateProjectRoot(request.body.root_path);
      const payload = {
        ...request.body,
        root_path: validatedRootPath,
      };
      const project = services.projectService.createProject(payload);
      services.sessionService.appendAudit('user', 'create', 'project', project.id, request.body);
      reply.code(201);
      return project;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.put('/api/projects/:id', async function (request, reply) {
    try {
      const validatedRootPath = await services.projectService.validateProjectRoot(request.body.root_path);
      const payload = {
        ...request.body,
        root_path: validatedRootPath,
      };
      const project = services.projectService.updateProject(request.params.id, payload);
      services.sessionService.appendAudit('user', 'update', 'project', project.id, request.body);
      return project;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
