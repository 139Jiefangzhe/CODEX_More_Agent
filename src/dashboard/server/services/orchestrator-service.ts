import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { v4 as uuidv4 } from 'uuid';

import { ControllerClient } from './controller-client.js';
import { CodexExecutor, buildCodexInstructions } from './codex-executor.js';
import { GitService } from './git-service.js';
import { nowIso, toJson } from './helpers.js';

const CONTROL_CHECKPOINT_ACTIONS = new Set(['pause', 'resume', 'skip', 'retry', 'abort']);
const RETRYABLE_RUN_STATUSES = new Set(['completed', 'failed', 'aborted', 'skipped']);
const SLOT_HOLD_PHASES = new Set(['awaiting_approval', 'applying', 'testing']);
const IDEMPOTENT_PHASES = new Set(['planning', 'applying', 'testing']);

export class OrchestratorService {
  projectService: any;
  sessionService: any;
  agentService: any;
  changeSetService: any;
  controlPlaneMode: 'direct' | 'queue';
  controllerClient: ControllerClient;
  codexExecutor: any;
  executionProvider: any;
  gitService: GitService;
  activeCodexResponses: Map<string, string>;
  activeSessionLoops: Set<string>;
  dispatchTimer: any;

  constructor(config) {
    this.projectService = config.projectService;
    this.sessionService = config.sessionService;
    this.agentService = config.agentService;
    this.changeSetService = config.changeSetService;
    this.controlPlaneMode = normalizeControlPlaneMode(config.controlPlaneMode);
    this.controllerClient = new ControllerClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.controllerModel,
    });
    this.executionProvider = config.executionProvider ?? new CodexExecutor({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.codexModel,
      timeoutSeconds: config.codexTimeoutSeconds,
    });
    this.codexExecutor = this.executionProvider;
    this.gitService = new GitService();
    this.activeCodexResponses = new Map();
    this.activeSessionLoops = new Set();
    this.dispatchTimer = null;

    if (this.controlPlaneMode === 'queue') {
      const timer = setInterval(() => {
        void this.processDispatchQueue().catch(() => undefined);
      }, 500);
      timer.unref?.();
      this.dispatchTimer = timer;
    }

    queueMicrotask(() => {
      void this.recoverRunningSessions();
      if (this.controlPlaneMode === 'queue') {
        void this.processDispatchQueue().catch(() => undefined);
      }
    });
  }

  async startSession(projectId, goal) {
    this.ensureRuntimeConfigured();
    const project = this.projectService.getProject(projectId);

    if (!project) {
      throw new Error('Project not found: ' + projectId);
    }

    const session = this.sessionService.createSession(project, goal, 'dashboard');
    this.sessionService.appendAudit('user', 'trigger', 'session', session.id, {
      projectId,
      goal,
    });
    this.scheduleSessionExecution(session.id, 'new_session');

    return session;
  }

  async approveSession(sessionId, runTests) {
    const session = this.requireSession(sessionId);
    const changeSet = this.changeSetService.getBySession(sessionId);

    if (!changeSet || changeSet.status !== 'awaiting_approval') {
      throw new Error('No awaiting approval change set for session ' + sessionId);
    }
    const nextMetadata = {
      ...(session.metadata ?? {}),
      approval: {
        runTests: Boolean(runTests),
        approvedAt: nowIso(),
      },
    };
    this.changeSetService.updateStatus(sessionId, 'approved');
    this.sessionService.updateSession(sessionId, {
      status: 'running',
      phase: 'applying',
      end_time: null,
      metadata: nextMetadata,
    });
    this.scheduleSessionExecution(sessionId, 'approval');
    return this.sessionService.getSession(sessionId);
  }

  async rejectSession(sessionId) {
    const session = this.requireSession(sessionId);
    const changeSet = this.changeSetService.getBySession(sessionId);

    if (changeSet) {
      this.changeSetService.updateStatus(sessionId, 'rejected');
    }

    this.releaseWriteSlotIfHeld(session, 'rejected');
    return this.sessionService.markAborted(session.id, 'Change set rejected by user');
  }

  async abortSession(sessionId) {
    const session = this.requireSession(sessionId);
    const executionId = this.activeCodexResponses.get(sessionId);

    if (executionId) {
      await this.executionProvider.cancel(executionId).catch(function () {
        return undefined;
      });
    }

    this.releaseWriteSlotIfHeld(session, 'aborted');
    return this.sessionService.markAborted(session.id, 'Session aborted by user');
  }

  async runSession(sessionId) {
    if (this.controlPlaneMode === 'queue') {
      this.scheduleSessionExecution(sessionId, 'manual_run');
      return;
    }

    await this.runSessionLoop(sessionId);
  }

  startSessionLoop(sessionId, reason = 'manual') {
    if (this.activeSessionLoops.has(sessionId)) {
      return false;
    }

    this.activeSessionLoops.add(sessionId);
    this.sessionService.appendAudit('system', 'loop_start', 'session', sessionId, {
      reason,
      timestamp: nowIso(),
    });

    void this.runSessionLoop(sessionId)
      .catch((error) => {
        console.error('Orchestrator loop failed for session', sessionId, error);
      })
      .finally(() => {
        this.activeSessionLoops.delete(sessionId);
      });

    return true;
  }

  scheduleSessionExecution(sessionId, reason = 'manual') {
    if (this.controlPlaneMode !== 'queue') {
      return this.startSessionLoop(sessionId, reason);
    }

    this.enqueueDispatchJob(sessionId, reason);
    void this.processDispatchQueue().catch(() => undefined);
    return true;
  }

  enqueueDispatchJob(sessionId, reason = 'manual') {
    const db = this.agentService.db;
    const existing = db
      .prepare("SELECT id FROM session_dispatch_jobs WHERE session_id = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1")
      .get(sessionId);

    if (existing?.id) {
      return Number(existing.id);
    }

    const now = nowIso();
    const result = db
      .prepare('INSERT INTO session_dispatch_jobs (session_id, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, String(reason || 'manual'), 'queued', now, now);

    return Number(result.lastInsertRowid);
  }

  async processDispatchQueue() {
    if (this.controlPlaneMode !== 'queue') {
      return;
    }

    const db = this.agentService.db;
    const jobs = db
      .prepare("SELECT id, session_id, reason FROM session_dispatch_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 20")
      .all();

    for (const job of jobs) {
      const now = nowIso();
      const claimed = db
        .prepare("UPDATE session_dispatch_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(now, job.id);

      if (Number(claimed.changes || 0) === 0) {
        continue;
      }

      let nextStatus = 'done';
      let errorMessage = null;

      try {
        const session = this.sessionService.getSession(job.session_id);

        if (!session) {
          throw new Error('Session not found: ' + job.session_id);
        }

        if (session.status === 'running') {
          this.startSessionLoop(job.session_id, 'dispatch:' + String(job.reason || 'manual'));
        }
      } catch (error) {
        nextStatus = 'failed';
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      db
        .prepare('UPDATE session_dispatch_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run(nextStatus, errorMessage, nowIso(), job.id);
    }
  }

  async recoverRunningSessions() {
    this.resetStaleDispatchJobs();
    this.resetStalePhaseExecutions();
    this.reconcileWriteSlotState();
    const sessions = this.sessionService.listActiveSessions();

    for (const session of sessions) {
      const normalizedPhase = normalizeRecoveryPhase(session.phase);

      if (normalizedPhase !== session.phase) {
        this.sessionService.updateSession(session.id, {
          phase: normalizedPhase,
        });
      }

      if (normalizedPhase === 'awaiting_approval') {
        continue;
      }

      this.scheduleSessionExecution(session.id, 'startup_recovery');
    }
  }

  async runSessionLoop(sessionId) {
    while (true) {
      const session = this.sessionService.getSession(sessionId);

      if (!session) {
        return;
      }

      if (session.status !== 'running') {
        return;
      }

      const normalizedPhase = normalizeRecoveryPhase(session.phase);

      if (normalizedPhase !== session.phase) {
        this.sessionService.updateSession(session.id, { phase: normalizedPhase });
        continue;
      }

      const project = this.requireProject(session.project_id);

      if (normalizedPhase === 'planning') {
        const planningResult = await this.executePhaseWithIdempotency(session.id, 'planning', async () => {
          await this.runPlanningToApproval(session.id, project);
        });

        if (planningResult?.skipped) {
          return;
        }

        continue;
      }

      if (normalizedPhase === 'awaiting_approval') {
        return;
      }

      if (normalizedPhase === 'applying') {
        const runTests = this.resolveRunTestsSetting(session);
        const applyingResult = await this.executePhaseWithIdempotency(session.id, 'applying', async () => {
          await this.applyApprovedChangeSet(session.id, runTests);
        });

        if (applyingResult?.skipped) {
          return;
        }

        return;
      }

      if (normalizedPhase === 'testing') {
        const testingResult = await this.executePhaseWithIdempotency(session.id, 'testing', async () => {
          await this.resumeTestingPhase(session.id, project);
        });

        if (testingResult?.skipped) {
          return;
        }

        return;
      }

      if (normalizedPhase === 'completed' || normalizedPhase === 'failed' || normalizedPhase === 'aborted') {
        return;
      }

      this.sessionService.updateSession(session.id, { phase: 'planning' });
    }
  }

  async runPlanningToApproval(sessionId, project) {
    this.ensureRuntimeConfigured();
    const context = await this.projectService.buildContext(project);

    try {
      const plan = await this.runArchitectStep(sessionId, project, context);
      const codexResult = await this.runCoderStep(sessionId, project, context, plan);
      const changeFiles = await this.buildChangeFiles(project.root_path, codexResult.files);
      const diffText = buildDiffText(changeFiles);
      const review = await this.runReviewerStep(sessionId, project, plan, codexResult, diffText);
      await this.runTesterPreparation(sessionId, project);
      await this.waitForWriteSlot(sessionId, project.id);

      const changeSet = this.createOrReplaceChangeSet(sessionId, {
        summary: review.summary,
        reviewNotes: review.review_notes + (review.risks.length ? '\n\nRisks:\n- ' + review.risks.join('\n- ') : ''),
        files: changeFiles,
        diffText,
        testCommandSnapshot: project.test_command,
      });

      const nextMetadata = {
        ...(this.requireSession(sessionId).metadata ?? {}),
        plan,
        review,
      };

      this.sessionService.updateSession(sessionId, {
        phase: 'awaiting_approval',
        active_change_set_id: changeSet.id,
        metadata: nextMetadata,
      });
    } catch (error) {
      const latestSession = this.sessionService.getSession(sessionId);

      if (latestSession?.status !== 'aborted') {
        this.sessionService.markFailed(sessionId, error instanceof Error ? error.message : String(error));
        this.releaseWriteSlot(sessionId, project.id, 'planning_failed');
      }

      throw error;
    }
  }

  async applyApprovedChangeSet(sessionId, runTests) {
    const session = this.requireSession(sessionId);
    const project = this.requireProject(session.project_id);
    const changeSet = this.changeSetService.getBySession(sessionId);

    if (!changeSet) {
      throw new Error('Change set not found for session ' + sessionId);
    }

    if (!this.sessionOwnsWriteSlot(sessionId, project.id)) {
      await this.waitForWriteSlot(sessionId, project.id);
    }

    this.sessionService.updateSession(sessionId, {
      status: 'running',
      phase: 'applying',
      end_time: null,
    });

    const applyRun = this.agentService.createAgentRun(sessionId, 'coder', 'approval', 'Apply approved change set', 2);
    this.agentService.updateRunStatus(applyRun.id, sessionId, 'coder', 'running');
    this.agentService.appendEvent({
      runId: applyRun.id,
      sessionId,
      agentType: 'coder',
      eventType: 'step_start',
      eventData: { message: 'Applying approved change set to workspace' },
    });

    try {
      const checkpoint = await this.applyRunControlCheckpoint(applyRun, {
        allowSkip: false,
        allowRetry: false,
      });

      if (checkpoint.action === 'abort') {
        this.agentService.updateRunStatus(applyRun.id, sessionId, 'coder', 'aborted', 'Aborted by control signal');
        throw new Error('Session aborted by control signal');
      }

      const inspectionTargets = dedupePaths(
        changeSet.files.flatMap(function (file) {
          return [file.path, file.old_path].filter(Boolean);
        }),
      );
      const inspection = await this.gitService.inspectApply(project.root_path, inspectionTargets);

      if (inspection.overlappingDirtyFiles.length > 0) {
        this.changeSetService.updateStatus(sessionId, 'apply_failed');
        this.agentService.appendEvent({
          runId: applyRun.id,
          sessionId,
          agentType: 'coder',
          eventType: 'error',
          eventData: { message: 'Dirty files overlap with approved change set', files: inspection.overlappingDirtyFiles },
        });
        this.agentService.updateRunStatus(applyRun.id, sessionId, 'coder', 'failed', 'Apply blocked by dirty files');
        this.sessionService.markFailed(sessionId, 'Dirty files overlap with approved change set');
        return;
      }

      if (inspection.otherDirtyFiles.length > 0) {
        this.agentService.appendEvent({
          runId: applyRun.id,
          sessionId,
          agentType: 'coder',
          eventType: 'output',
          eventData: { message: 'Non-overlapping dirty files detected', files: inspection.otherDirtyFiles },
        });
      }

      await this.gitService.applyFilesWithRollback(project.root_path, changeSet.files);
      this.agentService.appendEvent({
        runId: applyRun.id,
        sessionId,
        agentType: 'coder',
        eventType: 'step_end',
        eventData: { message: 'Change set written to workspace', fileCount: changeSet.files.length, branch: inspection.branch },
      });
      this.agentService.updateRunStatus(applyRun.id, sessionId, 'coder', 'completed', 'Approved change set applied');
      this.changeSetService.updateStatus(sessionId, 'applied');

      if (runTests && project.test_command) {
        await this.runTesterExecution(sessionId, project, project.test_command);
      }

      this.sessionService.markCompleted(sessionId);
      this.releaseWriteSlot(sessionId, project.id, 'completed');
    } catch (error) {
      const currentChangeSet = this.changeSetService.getBySession(sessionId);
      const latestRun = this.agentService.getRun(applyRun.id);
      const latestSession = this.sessionService.getSession(sessionId);
      const message = error instanceof Error ? error.message : String(error);

      if (latestSession?.status !== 'aborted' && currentChangeSet?.status !== 'test_failed') {
        this.changeSetService.updateStatus(sessionId, 'apply_failed');
      }

      if (latestRun?.status !== 'aborted') {
        this.agentService.updateRunStatus(applyRun.id, sessionId, 'coder', 'failed', message);
        this.agentService.appendEvent({
          runId: applyRun.id,
          sessionId,
          agentType: 'coder',
          eventType: 'error',
          eventData: { message },
        });
      }

      if (latestSession?.status !== 'aborted') {
        this.sessionService.markFailed(sessionId, message);
        this.releaseWriteSlot(sessionId, project.id, 'failed:' + message);
      }

      throw error;
    }
  }

  async retryRun(runId, options: any = {}) {
    const run = this.agentService.getRun(runId);

    if (!run) {
      throw new Error('Agent run not found: ' + runId);
    }

    if (!RETRYABLE_RUN_STATUSES.has(String(run.status || ''))) {
      throw new Error('Run status does not support retry: ' + run.status);
    }

    const session = this.requireSession(run.session_id);
    const reason = String(options.reason || '').trim() || null;

    if (run.trigger === 'approval' && run.agent_type === 'tester') {
      const project = this.requireProject(session.project_id);
      const command = this.resolveTestCommandForRetry(session, project);

      if (!command) {
        throw new Error('No test command available for retry');
      }

      this.prepareSessionForRetry(session, 'testing', reason, run.id);

      const existingRunIds = new Set(
        this.agentService.listSessionRuns(session.id).map(function (item) {
          return item.id;
        }),
      );

      void this.executePhaseWithIdempotency(session.id, 'testing', async () => {
        await this.resumeTestingPhase(session.id, project);
      }).catch((error) => {
        console.error('Retry tester execution failed:', error);
      });

      const retryRunId = this.findCreatedRunId(session.id, existingRunIds, 'tester', 'approval');
      return {
        started: true,
        retryRunId,
      };
    }

    if (run.trigger === 'approval' && run.agent_type === 'coder') {
      this.prepareSessionForRetry(session, 'applying', reason, run.id);
      const runTests = this.resolveRunTestsSetting(session);
      const existingRunIds = new Set(
        this.agentService.listSessionRuns(session.id).map(function (item) {
          return item.id;
        }),
      );

      void this.executePhaseWithIdempotency(session.id, 'applying', async () => {
        await this.applyApprovedChangeSet(session.id, runTests);
      }).catch((error) => {
        console.error('Retry apply flow failed:', error);
      });

      const retryRunId = this.findCreatedRunId(session.id, existingRunIds, 'coder', 'approval');
      return {
        started: true,
        retryRunId,
      };
    }

    if (run.trigger === 'system') {
      const retryPhase = normalizeRecoveryPhase(session.phase);
      const nextPhase = retryPhase === 'awaiting_approval' ? 'planning' : retryPhase;

      this.prepareSessionForRetry(session, nextPhase, reason, run.id);
      const started = this.scheduleSessionExecution(session.id, 'retry_system');
      return {
        started,
        retryRunId: null,
      };
    }

    throw new Error('Retry is only supported for approval tester/apply runs or system wait runs');
  }

  prepareSessionForRetry(session, phase, reason, sourceRunId) {
    const metadata = isPlainObject(session.metadata) ? { ...session.metadata } : {};
    const phaseAttempts = isPlainObject(metadata.phase_attempts) ? { ...metadata.phase_attempts } : {};
    const previousAttemptValue = Number(phaseAttempts[phase] ?? 0);
    const safePreviousAttempt = Number.isFinite(previousAttemptValue) && previousAttemptValue > 0 ? Math.floor(previousAttemptValue) : 0;
    const nextAttempt = safePreviousAttempt + 1;
    const history = Array.isArray(metadata.retry_history) ? metadata.retry_history.slice(-19) : [];

    phaseAttempts[phase] = nextAttempt;
    history.push({
      phase,
      attempt: nextAttempt,
      source_run_id: sourceRunId,
      reason,
      timestamp: nowIso(),
    });

    const nextMetadata = {
      ...metadata,
      phase_attempts: phaseAttempts,
      retry_history: history,
    };

    this.sessionService.updateSession(session.id, {
      status: 'running',
      phase,
      end_time: null,
      metadata: nextMetadata,
    });

    this.sessionService.appendAudit('user', 'retry', 'agent', sourceRunId, {
      sessionId: session.id,
      phase,
      attempt: nextAttempt,
      reason,
    });
  }

  resolveRunTestsSetting(session) {
    return Boolean((session.metadata ?? {}).approval?.runTests);
  }

  resolveTestCommandForRetry(session, project) {
    const changeSet = this.changeSetService.getBySession(session.id);
    return String(project.test_command || changeSet?.test_command_snapshot || '').trim();
  }

  findCreatedRunId(sessionId, existingRunIds, agentType, trigger) {
    const runs = this.agentService.listSessionRuns(sessionId);

    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index];

      if (existingRunIds.has(run.id)) {
        continue;
      }

      if (run.agent_type !== agentType) {
        continue;
      }

      if (run.trigger !== trigger) {
        continue;
      }

      return run.id;
    }

    return null;
  }

  createOrReplaceChangeSet(sessionId, input) {
    const existing = this.changeSetService.getBySession(sessionId);

    if (!existing) {
      return this.changeSetService.createChangeSet(
        sessionId,
        input.summary,
        input.reviewNotes,
        input.files,
        input.diffText,
        input.testCommandSnapshot,
        'awaiting_approval',
      );
    }

    const now = nowIso();
    this.changeSetService.db
      .prepare(
        'UPDATE change_sets SET status = ?, summary = ?, review_notes = ?, files_json = ?, diff_text = ?, test_command_snapshot = ?, updated_at = ? WHERE session_id = ?',
      )
      .run('awaiting_approval', input.summary, input.reviewNotes, toJson(input.files), input.diffText, input.testCommandSnapshot, now, sessionId);

    const next = this.changeSetService.getBySession(sessionId);

    if (!next) {
      throw new Error('Failed to update change set for session ' + sessionId);
    }

    this.changeSetService.publish(sessionId, next.id, next.status);
    return next;
  }

  async resumeTestingPhase(sessionId, project) {
    const command = this.resolveTestCommandForRetry(this.requireSession(sessionId), project);

    if (!command) {
      throw new Error('No test command configured for testing phase');
    }

    await this.runTesterExecution(sessionId, project, command);
    const latest = this.sessionService.getSession(sessionId);

    if (latest?.status === 'running') {
      this.sessionService.markCompleted(sessionId);
      this.releaseWriteSlot(sessionId, project.id, 'completed');
    }
  }

  async runArchitectStep(sessionId, project, context) {
    const run = this.agentService.createAgentRun(sessionId, 'architect', 'dashboard', 'Plan architecture and implementation', 3);
    this.agentService.updateRunStatus(run.id, sessionId, 'architect', 'running');
    this.sessionService.updateSession(sessionId, { phase: 'planning' });
    this.agentService.appendEvent({
      runId: run.id,
      sessionId,
      agentType: 'architect',
      eventType: 'step_start',
      eventData: { message: 'Planning architecture and implementation strategy' },
    });

    try {
      const checkpoint = await this.applyRunControlCheckpoint(run, {
        allowSkip: false,
        allowRetry: false,
      });

      if (checkpoint.action === 'abort') {
        throw new Error('Session aborted by control signal');
      }

      const plan = await this.controllerClient.planSession({
        project,
        goal: this.requireSession(sessionId).goal,
        context,
      });

      this.agentService.appendEvent({
        runId: run.id,
        sessionId,
        agentType: 'architect',
        eventType: 'output',
        eventData: plan,
      });
      this.agentService.updateRunStatus(run.id, sessionId, 'architect', 'completed', plan.architecture_summary);
      return plan;
    } catch (error) {
      const latestRun = this.agentService.getRun(run.id);

      if (latestRun?.status !== 'aborted') {
        this.agentService.updateRunStatus(run.id, sessionId, 'architect', 'failed', error instanceof Error ? error.message : String(error));
      }

      throw error;
    }
  }

  async runCoderStep(sessionId, project, context, plan) {
    const run = this.agentService.createAgentRun(sessionId, 'coder', 'dashboard', 'Generate implementation with gpt-5.3-codex', 4);
    this.agentService.updateRunStatus(run.id, sessionId, 'coder', 'running');
    this.sessionService.updateSession(sessionId, { phase: 'implementing' });

    const filesToRead = dedupePaths(context.keyFiles.map((file) => file.path).concat(plan.files_to_read || [])).slice(0, 16);
    const filesContext = await this.projectService.readExistingFiles(project, filesToRead);
    const instructions = buildCodexInstructions({
      goal: this.requireSession(sessionId).goal,
      plan,
      project,
      filesContext,
    });
    let responseId = null;
    let controlMonitor = null;

    try {
      const checkpoint = await this.applyRunControlCheckpoint(run, {
        allowSkip: false,
        allowRetry: false,
      });

      if (checkpoint.action === 'abort') {
        throw new Error('Session aborted by control signal');
      }

      responseId = await this.executionProvider.submitTask(uuidv4(), instructions, 12000, {
        filesContext,
        language: project.language,
        framework: project.framework,
        expectedOutputFiles: plan.expected_output_files || [],
        timeoutSeconds: 600,
      });
      this.activeCodexResponses.set(sessionId, responseId);
      controlMonitor = this.startCoderControlMonitor(run, responseId);

      this.agentService.appendEvent({
        runId: run.id,
        sessionId,
        agentType: 'coder',
        eventType: 'tool_call',
        eventData: {
          tool: this.executionProvider?.name === 'mcp' ? 'mcp:codex.submit_task' : 'gpt-5.3-codex',
          provider: this.executionProvider?.name || 'responses',
          responseId,
          filesContext: filesToRead,
        },
      });

      const result = await this.executionProvider.waitForResult(responseId, undefined, {
        pollIntervalMs: 1500,
      });
      const abortError = controlMonitor.getAbortError();
      controlMonitor.stop();
      controlMonitor = null;

      if (abortError) {
        throw abortError;
      }

      if (this.agentService.getRun(run.id)?.status === 'paused') {
        const pausedResult = await this.waitForResumeSignal(run, {
          allowSkip: false,
          allowRetry: false,
        });

        if (pausedResult.action === 'abort') {
          throw new Error('Session aborted by control signal');
        }
      }

      this.activeCodexResponses.delete(sessionId);

      if (result.status !== 'completed') {
        throw new Error(result.error || 'Codex execution did not complete successfully');
      }

      this.agentService.appendEvent({
        runId: run.id,
        sessionId,
        agentType: 'coder',
        eventType: 'output',
        eventData: {
          message: 'Codex execution completed',
          files: result.files.map(function (file) {
            return file.path;
          }),
          logs: result.logs,
        },
      });
      this.agentService.updateRunStatus(run.id, sessionId, 'coder', 'completed', result.logs || 'Implementation generated');
      return result;
    } catch (error) {
      if (controlMonitor) {
        controlMonitor.stop();
        controlMonitor = null;
      }

      if (responseId) {
        this.activeCodexResponses.delete(sessionId);
      }

      const message = error instanceof Error ? error.message : String(error);
      const latestRun = this.agentService.getRun(run.id);

      if (latestRun?.status !== 'aborted') {
        this.agentService.appendEvent({
          runId: run.id,
          sessionId,
          agentType: 'coder',
          eventType: 'error',
          eventData: { message },
        });
        this.agentService.updateRunStatus(run.id, sessionId, 'coder', 'failed', message);
      }

      throw error;
    }
  }

  async runReviewerStep(sessionId, project, plan, codexResult, diffText) {
    const run = this.agentService.createAgentRun(sessionId, 'reviewer', 'dashboard', 'Review generated implementation', 3);
    this.agentService.updateRunStatus(run.id, sessionId, 'reviewer', 'running');
    this.sessionService.updateSession(sessionId, { phase: 'reviewing' });

    try {
      const checkpoint = await this.applyRunControlCheckpoint(run, {
        allowSkip: false,
        allowRetry: false,
      });

      if (checkpoint.action === 'abort') {
        throw new Error('Session aborted by control signal');
      }

      const review = await this.controllerClient.reviewChangeSet({
        goal: this.requireSession(sessionId).goal,
        project,
        plan,
        generatedFiles: codexResult.files,
        codexLogs: codexResult.logs,
        diffText,
      });

      this.agentService.appendEvent({
        runId: run.id,
        sessionId,
        agentType: 'reviewer',
        eventType: 'output',
        eventData: review,
      });
      this.agentService.updateRunStatus(run.id, sessionId, 'reviewer', 'completed', review.summary);
      return review;
    } catch (error) {
      const latestRun = this.agentService.getRun(run.id);

      if (latestRun?.status !== 'aborted') {
        this.agentService.updateRunStatus(run.id, sessionId, 'reviewer', 'failed', error instanceof Error ? error.message : String(error));
      }

      throw error;
    }
  }

  async runTesterPreparation(sessionId, project) {
    const run = this.agentService.createAgentRun(sessionId, 'tester', 'dashboard', 'Prepare test command for approval stage', 1);
    this.agentService.updateRunStatus(run.id, sessionId, 'tester', 'running');

    const checkpoint = await this.applyRunControlCheckpoint(run, {
      allowSkip: false,
      allowRetry: false,
    });

    if (checkpoint.action === 'abort') {
      this.agentService.updateRunStatus(run.id, sessionId, 'tester', 'aborted', 'Aborted by control signal');
      throw new Error('Session aborted by control signal');
    }

    const message = project.test_command
      ? 'Test command ready: ' + project.test_command
      : 'No test command configured for this project';

    this.agentService.appendEvent({
      runId: run.id,
      sessionId,
      agentType: 'tester',
      eventType: 'output',
      eventData: { message },
    });
    this.agentService.updateRunStatus(run.id, sessionId, 'tester', 'completed', message);
  }

  async runTesterExecution(sessionId, project, command) {
    const run = this.agentService.createAgentRun(sessionId, 'tester', 'approval', 'Run configured test command', 2);
    this.agentService.updateRunStatus(run.id, sessionId, 'tester', 'running');
    this.sessionService.updateSession(sessionId, { phase: 'testing' });
    this.agentService.appendEvent({
      runId: run.id,
      sessionId,
      agentType: 'tester',
      eventType: 'step_start',
      eventData: { message: 'Executing test command', command },
    });

    const checkpoint = await this.applyRunControlCheckpoint(run, {
      allowSkip: true,
      allowRetry: true,
    });

    if (checkpoint.action === 'abort') {
      this.agentService.updateRunStatus(run.id, sessionId, 'tester', 'aborted', 'Aborted by control signal');
      throw new Error('Session aborted by control signal');
    }

    if (checkpoint.action === 'skip') {
      this.agentService.appendEvent({
        runId: run.id,
        sessionId,
        agentType: 'tester',
        eventType: 'checkpoint',
        eventData: { message: 'Test command skipped by control signal' },
      });
      this.agentService.updateRunStatus(run.id, sessionId, 'tester', 'skipped', 'Skipped by control signal');
      return;
    }

    const result = await this.gitService.runShellCommand(project.root_path, command, (chunk, stream) => {
      this.agentService.appendEvent({
        runId: run.id,
        sessionId,
        agentType: 'tester',
        eventType: 'output',
        eventData: { stream, chunk },
      });
    });

    if (result.code !== 0) {
      this.changeSetService.updateStatus(sessionId, 'test_failed');
      this.agentService.updateRunStatus(run.id, sessionId, 'tester', 'failed', 'Tests failed');
      this.sessionService.markFailed(sessionId, 'Configured test command failed');
      throw new Error('Configured test command failed');
    }

    this.agentService.updateRunStatus(run.id, sessionId, 'tester', 'completed', 'Configured test command passed');
    this.agentService.appendEvent({
      runId: run.id,
      sessionId,
      agentType: 'tester',
      eventType: 'step_end',
      eventData: { message: 'Test command completed successfully', command },
    });
  }

  startCoderControlMonitor(run, responseId) {
    const state = {
      stopped: false,
      busy: false,
      abortError: null,
    };
    const timer = setInterval(() => {
      if (state.stopped || state.busy || state.abortError) {
        return;
      }

      state.busy = true;
      void this.processCoderControlSignal(run, responseId, state)
        .catch(() => undefined)
        .finally(() => {
          state.busy = false;
        });
    }, 800);
    timer.unref?.();

    return {
      stop() {
        state.stopped = true;
        clearInterval(timer);
      },
      getAbortError() {
        return state.abortError;
      },
    };
  }

  async processCoderControlSignal(run, responseId, state) {
    const signal = this.fetchNextControlSignal(run.id);

    if (!signal) {
      return;
    }

    this.consumeControlSignal(signal.id);

    if (!CONTROL_CHECKPOINT_ACTIONS.has(signal.action)) {
      return;
    }

    const currentRun = this.agentService.getRun(run.id);

    if (!currentRun) {
      return;
    }

    if (currentRun.status === 'completed' || currentRun.status === 'failed' || currentRun.status === 'aborted' || currentRun.status === 'skipped') {
      this.emitControlApplied(run, signal.action, signal.id, 'ignored_terminal', 'checkpoint');
      return;
    }

    if (signal.action === 'pause') {
      if (currentRun.status !== 'paused') {
        this.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, 'paused');
        this.emitControlApplied(run, signal.action, signal.id, 'paused', 'checkpoint');
      } else {
        this.emitControlApplied(run, signal.action, signal.id, 'already_paused', 'checkpoint');
      }

      return;
    }

    if (signal.action === 'resume') {
      if (currentRun.status === 'paused') {
        this.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, 'running');
        this.emitControlApplied(run, signal.action, signal.id, 'continued', 'checkpoint');
      } else {
        this.emitControlApplied(run, signal.action, signal.id, 'already_running', 'checkpoint');
      }

      return;
    }

    if (signal.action === 'abort') {
      this.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, 'aborted', 'Aborted by control signal');
      this.emitControlApplied(run, signal.action, signal.id, 'aborted', 'checkpoint');
      state.abortError = new Error('Session aborted by control signal');
      await this.executionProvider.cancel(responseId).catch(() => undefined);
      await this.abortSession(run.session_id).catch(() => undefined);
      return;
    }

    if (signal.action === 'skip' || signal.action === 'retry') {
      this.emitControlApplied(run, signal.action, signal.id, 'ignored_unsupported_phase', 'checkpoint');
    }
  }

  async waitForWriteSlot(sessionId, projectId) {
    const queueEntryId = this.ensureWriteSlotQueueEntry(sessionId, projectId);
    let waitingNotified = false;
    let lastWaitState = null;

    while (true) {
      const current = this.requireSession(sessionId);

      if (current.status !== 'running') {
        this.markWriteSlotQueueReleased(queueEntryId, 'session_not_running');
        throw new Error('Session is no longer running');
      }

      const acquisition = this.tryAcquireWriteSlot(sessionId, projectId, queueEntryId);

      if (acquisition.state === 'acquired') {
        this.emitSlotEvent(sessionId, projectId, 'acquired', {
          waited: waitingNotified,
          queueEntryId,
          queuePosition: acquisition.queuePosition,
          blockingSessionId: acquisition.blockingSessionId,
        });
        return;
      }

      const currentWaitState = {
        queuePosition: acquisition.queuePosition,
        blockingSessionId: acquisition.blockingSessionId,
      };

      if (!waitingNotified) {
        this.emitSlotEvent(sessionId, projectId, 'waiting', {
          queueEntryId,
          queuePosition: acquisition.queuePosition,
          blockingSessionId: acquisition.blockingSessionId,
        });
        waitingNotified = true;
      } else if (!sameWaitState(lastWaitState, currentWaitState)) {
        this.emitSlotEvent(sessionId, projectId, 'waiting', {
          queueEntryId,
          queuePosition: acquisition.queuePosition,
          blockingSessionId: acquisition.blockingSessionId,
          updated: true,
        });
      }

      lastWaitState = currentWaitState;
      await delay(1500);
    }
  }

  async buildChangeFiles(rootPath, generatedFiles) {
    const files = [];

    for (const file of generatedFiles || []) {
      const operation = normalizeGeneratedFileOperation(file);
      const targetPath = String(file?.path || file?.new_path || '').trim();
      const oldPath = String(file?.old_path || '').trim();

      if (!targetPath) {
        continue;
      }

      if (operation === 'rename') {
        if (!oldPath) {
          continue;
        }

        const beforeContent = await safeReadFile(resolveWithinRoot(rootPath, oldPath));
        const renameContent = typeof file?.content === 'string' ? file.content : beforeContent;

        files.push({
          path: targetPath,
          old_path: oldPath,
          status: 'rename',
          before_content: beforeContent,
          after_content: renameContent,
        });
        continue;
      }

      const beforeContent = await safeReadFile(resolveWithinRoot(rootPath, targetPath));
      const inferredStatus = operation === 'modify' && beforeContent === null ? 'create' : operation;

      files.push({
        path: targetPath,
        status: inferredStatus,
        before_content: beforeContent,
        after_content: inferredStatus === 'delete' ? null : String(file?.content ?? ''),
      });
    }

    return files;
  }

  async applyRunControlCheckpoint(run, options: { allowSkip?: boolean; allowRetry?: boolean } = {}) {
    while (true) {
      const signal = this.fetchNextControlSignal(run.id);

      if (!signal) {
        return { action: 'continue' as const };
      }

      this.consumeControlSignal(signal.id);

      if (!CONTROL_CHECKPOINT_ACTIONS.has(signal.action)) {
        continue;
      }

      if (signal.action === 'pause') {
        this.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, 'paused');
        this.emitControlApplied(run, signal.action, signal.id, 'paused', 'checkpoint');
        const pausedResult = await this.waitForResumeSignal(run, options);

        if (pausedResult.action !== 'continue') {
          return pausedResult;
        }

        continue;
      }

      if (signal.action === 'resume') {
        this.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, 'running');
        this.emitControlApplied(run, signal.action, signal.id, 'continued', 'checkpoint');
        return { action: 'continue' as const };
      }

      if (signal.action === 'abort') {
        this.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, 'aborted', 'Aborted by control signal');
        this.emitControlApplied(run, signal.action, signal.id, 'aborted', 'checkpoint');
        await this.abortSession(run.session_id).catch(() => undefined);
        return { action: 'abort' as const };
      }

      if (signal.action === 'skip') {
        this.emitControlApplied(run, signal.action, signal.id, 'skipped', 'checkpoint');

        if (options.allowSkip) {
          return { action: 'skip' as const };
        }

        continue;
      }

      if (signal.action === 'retry') {
        this.emitControlApplied(run, signal.action, signal.id, 'retrying', 'checkpoint');

        if (options.allowRetry) {
          return { action: 'retry' as const };
        }
      }
    }
  }

  async waitForResumeSignal(run, options: { allowSkip?: boolean; allowRetry?: boolean }) {
    const timeoutSeconds = 30 * 60;
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      const signal = this.fetchNextControlSignal(run.id);

      if (!signal) {
        await delay(2000);
        continue;
      }

      this.consumeControlSignal(signal.id);

      if (!CONTROL_CHECKPOINT_ACTIONS.has(signal.action)) {
        continue;
      }

      if (signal.action === 'resume') {
        this.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, 'running');
        this.emitControlApplied(run, signal.action, signal.id, 'continued', 'checkpoint');
        return { action: 'continue' as const };
      }

      if (signal.action === 'abort') {
        this.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, 'aborted', 'Aborted by control signal');
        this.emitControlApplied(run, signal.action, signal.id, 'aborted', 'checkpoint');
        await this.abortSession(run.session_id).catch(() => undefined);
        return { action: 'abort' as const };
      }

      if (signal.action === 'skip') {
        this.emitControlApplied(run, signal.action, signal.id, 'skipped', 'checkpoint');

        if (options.allowSkip) {
          this.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, 'running');
          return { action: 'skip' as const };
        }

        continue;
      }

      if (signal.action === 'retry') {
        this.emitControlApplied(run, signal.action, signal.id, 'retrying', 'checkpoint');

        if (options.allowRetry) {
          this.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, 'running');
          return { action: 'retry' as const };
        }

        continue;
      }

      if (signal.action === 'pause') {
        this.emitControlApplied(run, signal.action, signal.id, 'paused', 'checkpoint');
      }
    }

    this.agentService.updateRunStatus(run.id, run.session_id, run.agent_type, 'running');
    this.sessionService.appendAudit('system', 'control_timeout', 'agent', run.id, {
      reason: 'pause timeout auto-resume',
    });
    this.emitControlApplied(run, 'pause', 0, 'timeout_resume', 'checkpoint');
    return { action: 'continue' as const };
  }

  fetchNextControlSignal(runId) {
    return this.agentService.db
      .prepare(
        "SELECT id, action FROM control_signals WHERE agent_run_id = ? AND consumed_at IS NULL AND (expires_at IS NULL OR julianday(expires_at) > julianday('now')) ORDER BY created_at ASC, id ASC LIMIT 1",
      )
      .get(runId);
  }

  consumeControlSignal(signalId) {
    this.agentService.db
      .prepare('UPDATE control_signals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
      .run(nowIso(), signalId);
  }

  emitControlApplied(run, action, signalId, result, mode: 'checkpoint' | 'immediate') {
    const timestamp = nowIso();
    const payload = {
      type: 'agent:control_applied',
      timestamp,
      data: {
        sessionId: run.session_id,
        agentRunId: run.id,
        action,
        signalId,
        mode,
        result,
        timestamp,
      },
    };

    this.sessionService.appendAudit('system', 'control', 'agent', run.id, {
      action,
      signalId,
      mode,
      result,
    });
    this.agentService.eventBus.publish('session:' + run.session_id, payload);
    this.agentService.eventBus.publish('system', payload);
  }

  emitSlotEvent(sessionId, projectId, state, details = {}) {
    const timestamp = nowIso();
    const payload = {
      type: 'slot_event',
      timestamp,
      data: {
        sessionId,
        projectId,
        state,
        timestamp,
        ...(details || {}),
      },
    };

    this.sessionService.appendAudit('system', 'slot_event', 'project', projectId, {
      sessionId,
      state,
      ...(details || {}),
    });
    this.agentService.eventBus.publish('session:' + sessionId, payload);
    this.agentService.eventBus.publish('system', payload);
  }

  releaseWriteSlotIfHeld(session, reason) {
    if (!session) {
      return;
    }

    if (!this.sessionOwnsWriteSlot(session.id, session.project_id)) {
      return;
    }

    this.releaseWriteSlot(session.id, session.project_id, reason);
  }

  ensureWriteSlotQueueEntry(sessionId, projectId) {
    const db = this.agentService.db;
    const existing = db
      .prepare(
        "SELECT id FROM write_slot_queue WHERE session_id = ? AND project_id = ? AND status IN ('waiting', 'acquired') ORDER BY id DESC LIMIT 1",
      )
      .get(sessionId, projectId);

    if (existing?.id) {
      return Number(existing.id);
    }

    const now = nowIso();
    const inserted = db
      .prepare('INSERT INTO write_slot_queue (project_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, sessionId, 'waiting', now, now);

    return Number(inserted.lastInsertRowid);
  }

  tryAcquireWriteSlot(sessionId, projectId, queueEntryId) {
    const db = this.agentService.db;
    const now = nowIso();

    const transaction = db.transaction(() => {
      const queueEntry = db.prepare('SELECT * FROM write_slot_queue WHERE id = ?').get(queueEntryId);

      if (!queueEntry) {
        throw new Error('Write slot queue entry not found: ' + queueEntryId);
      }

      if (queueEntry.status === 'released' || queueEntry.status === 'cancelled') {
        return {
          state: 'waiting',
          queuePosition: 0,
          blockingSessionId: null,
        };
      }

      const lockRow = db.prepare('SELECT project_id, session_id, acquired_at, updated_at FROM write_slot_locks WHERE project_id = ?').get(projectId);

      if (lockRow && lockRow.session_id !== sessionId && this.isWriteSlotLockStale(lockRow.session_id, projectId)) {
        db.prepare('DELETE FROM write_slot_locks WHERE project_id = ?').run(projectId);
        db
          .prepare(
            "UPDATE write_slot_queue SET status = 'released', release_reason = ?, released_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND status = 'acquired'",
          )
          .run('stale_recovered', now, now, projectId, lockRow.session_id);
      }

      const currentLock = db.prepare('SELECT project_id, session_id FROM write_slot_locks WHERE project_id = ?').get(projectId);

      if (currentLock?.session_id === sessionId) {
        db
          .prepare("UPDATE write_slot_queue SET status = 'acquired', acquired_at = COALESCE(acquired_at, ?), updated_at = ? WHERE id = ?")
          .run(now, now, queueEntryId);

        return {
          state: 'acquired',
          queuePosition: 1,
          blockingSessionId: null,
        };
      }

      const waitingRows = db
        .prepare("SELECT id, session_id FROM write_slot_queue WHERE project_id = ? AND status = 'waiting' ORDER BY id ASC")
        .all(projectId);
      const waitingIndex = waitingRows.findIndex((row) => Number(row.id) === Number(queueEntryId));
      const queuePosition = waitingIndex >= 0 ? waitingIndex + 1 : Math.max(waitingRows.length, 1);

      if (!currentLock && waitingRows.length > 0 && Number(waitingRows[0].id) === Number(queueEntryId)) {
        db
          .prepare('INSERT OR REPLACE INTO write_slot_locks (project_id, session_id, acquired_at, updated_at) VALUES (?, ?, ?, ?)')
          .run(projectId, sessionId, now, now);
        db
          .prepare("UPDATE write_slot_queue SET status = 'acquired', acquired_at = COALESCE(acquired_at, ?), updated_at = ? WHERE id = ?")
          .run(now, now, queueEntryId);

        return {
          state: 'acquired',
          queuePosition: 1,
          blockingSessionId: null,
        };
      }

      db.prepare("UPDATE write_slot_queue SET status = 'waiting', updated_at = ? WHERE id = ?").run(now, queueEntryId);

      return {
        state: 'waiting',
        queuePosition,
        blockingSessionId: currentLock?.session_id ?? (waitingRows[0]?.session_id ?? null),
      };
    });

    return transaction();
  }

  sessionOwnsWriteSlot(sessionId, projectId) {
    const db = this.agentService.db;
    const lockRow = db.prepare('SELECT session_id FROM write_slot_locks WHERE project_id = ?').get(projectId);

    if (!lockRow) {
      return false;
    }

    return String(lockRow.session_id) === String(sessionId);
  }

  releaseWriteSlot(sessionId, projectId, reason = 'released') {
    const db = this.agentService.db;
    const now = nowIso();
    const transaction = db.transaction(() => {
      const lockRow = db.prepare('SELECT session_id FROM write_slot_locks WHERE project_id = ?').get(projectId);
      const lockOwnedBySession = lockRow && String(lockRow.session_id) === String(sessionId);

      if (lockOwnedBySession) {
        db.prepare('DELETE FROM write_slot_locks WHERE project_id = ?').run(projectId);
      }

      const updateResult = db
        .prepare(
          "UPDATE write_slot_queue SET status = 'released', release_reason = ?, released_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND status IN ('waiting', 'acquired')",
        )
        .run(reason, now, now, projectId, sessionId);

      return {
        releasedLock: Boolean(lockOwnedBySession),
        releasedRows: Number(updateResult.changes || 0),
      };
    });
    const released = transaction();

    if (!released.releasedLock && released.releasedRows === 0) {
      return;
    }

    this.emitSlotEvent(sessionId, projectId, 'released', {
      reason,
      releasedLock: released.releasedLock,
      releasedRows: released.releasedRows,
    });
  }

  markWriteSlotQueueReleased(queueEntryId, reason) {
    const now = nowIso();
    this.agentService.db
      .prepare("UPDATE write_slot_queue SET status = 'released', release_reason = ?, released_at = ?, updated_at = ? WHERE id = ?")
      .run(reason, now, now, queueEntryId);
  }

  reconcileWriteSlotState() {
    const db = this.agentService.db;
    const locks = db.prepare('SELECT project_id, session_id FROM write_slot_locks').all();

    for (const lock of locks) {
      if (!this.isWriteSlotLockStale(lock.session_id, lock.project_id)) {
        continue;
      }

      this.releaseWriteSlot(lock.session_id, lock.project_id, 'startup_recovery');
    }
  }

  isWriteSlotLockStale(sessionId, projectId) {
    const session = this.sessionService.getSession(sessionId);

    if (!session) {
      return true;
    }

    if (session.status !== 'running') {
      return true;
    }

    if (!SLOT_HOLD_PHASES.has(String(session.phase || ''))) {
      return true;
    }

    if (String(session.project_id || '') !== String(projectId || '')) {
      return true;
    }

    return false;
  }

  async executePhaseWithIdempotency(sessionId, phase, runner) {
    if (!IDEMPOTENT_PHASES.has(phase)) {
      return runner();
    }

    const claim = this.claimPhaseExecution(sessionId, phase);

    if (!claim.claimed) {
      this.sessionService.appendAudit('system', 'phase_dedupe_skip', 'session', sessionId, {
        phase,
        attempt: claim.attempt,
        reason: claim.reason,
      });

      return {
        skipped: true,
        reason: claim.reason,
        attempt: claim.attempt,
      };
    }

    try {
      const result = await runner();
      this.finishPhaseExecution(sessionId, phase, claim.attempt, 'completed', null);
      return result;
    } catch (error) {
      const session = this.sessionService.getSession(sessionId);
      const status = session?.status === 'aborted' ? 'aborted' : 'failed';
      this.finishPhaseExecution(sessionId, phase, claim.attempt, status, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  claimPhaseExecution(sessionId, phase) {
    const db = this.agentService.db;
    const attempt = this.resolvePhaseAttempt(sessionId, phase);
    const executionId = uuidv4();
    const now = nowIso();

    try {
      db
        .prepare(
          'INSERT INTO phase_execution_attempts (session_id, phase, attempt, execution_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(sessionId, phase, attempt, executionId, 'running', now, now);

      return {
        claimed: true,
        reason: 'inserted',
        attempt,
      };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }

    const existing = db
      .prepare('SELECT status FROM phase_execution_attempts WHERE session_id = ? AND phase = ? AND attempt = ?')
      .get(sessionId, phase, attempt);

    if (!existing) {
      return {
        claimed: false,
        reason: 'missing_after_conflict',
        attempt,
      };
    }

    if (existing.status === 'completed' || existing.status === 'running') {
      return {
        claimed: false,
        reason: existing.status,
        attempt,
      };
    }

    const updated = db
      .prepare(
        "UPDATE phase_execution_attempts SET execution_id = ?, status = 'running', error_message = NULL, updated_at = ? WHERE session_id = ? AND phase = ? AND attempt = ? AND status != 'completed'",
      )
      .run(executionId, now, sessionId, phase, attempt);

    return {
      claimed: Number(updated.changes || 0) > 0,
      reason: Number(updated.changes || 0) > 0 ? 'recovered' : 'conflict',
      attempt,
    };
  }

  finishPhaseExecution(sessionId, phase, attempt, status, errorMessage) {
    this.agentService.db
      .prepare('UPDATE phase_execution_attempts SET status = ?, error_message = ?, updated_at = ? WHERE session_id = ? AND phase = ? AND attempt = ?')
      .run(status, errorMessage || null, nowIso(), sessionId, phase, attempt);
  }

  resetStaleDispatchJobs() {
    this.agentService.db
      .prepare("UPDATE session_dispatch_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'")
      .run(nowIso());
  }

  resetStalePhaseExecutions() {
    this.agentService.db
      .prepare("UPDATE phase_execution_attempts SET status = 'failed', error_message = COALESCE(error_message, ?), updated_at = ? WHERE status = 'running'")
      .run('orchestrator_restarted', nowIso());
  }

  resolvePhaseAttempt(sessionId, phase) {
    const session = this.requireSession(sessionId);
    const metadata = isPlainObject(session.metadata) ? { ...session.metadata } : {};
    const phaseAttempts = isPlainObject(metadata.phase_attempts) ? { ...metadata.phase_attempts } : {};
    const rawAttempt = Number(phaseAttempts[phase]);

    if (Number.isFinite(rawAttempt) && rawAttempt >= 1) {
      return Math.floor(rawAttempt);
    }

    phaseAttempts[phase] = 1;
    metadata.phase_attempts = phaseAttempts;
    this.sessionService.updateSession(sessionId, {
      metadata,
    });
    return 1;
  }

  requireSession(sessionId) {
    const session = this.sessionService.getSession(sessionId);

    if (!session) {
      throw new Error('Session not found: ' + sessionId);
    }

    return session;
  }

  requireProject(projectId) {
    const project = this.projectService.getProject(projectId);

    if (!project) {
      throw new Error('Project not found: ' + projectId);
    }

    return project;
  }

  ensureRuntimeConfigured() {
    if (!this.controllerClient.isConfigured() || !this.executionProvider.isConfigured()) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
  }
}

function buildDiffText(files) {
  if (!files.length) {
    return 'No file changes';
  }

  return files.map(function (file) {
    const status = String(file.status || 'modify');
    const beforeText = file.before_content == null ? '[file did not exist]' : file.before_content;
    const afterText = file.after_content == null ? '[file deleted]' : file.after_content;
    const fromPath = file.old_path ? ' (from ' + file.old_path + ')' : '';

    return [
      '--- ' + (file.old_path || file.path),
      '+++ ' + file.path,
      '@@ ' + status + fromPath + ' @@',
      'Before:',
      beforeText,
      '',
      'After:',
      afterText,
    ].join('\n');
  }).join('\n\n');
}

function dedupePaths(paths) {
  return Array.from(new Set(paths.filter(Boolean)));
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function resolveWithinRoot(rootPath, relativePath) {
  const resolvedRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(resolvedRoot, relativePath);

  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Path escapes project root: ' + relativePath);
  }

  return absolutePath;
}

function normalizeRecoveryPhase(phase) {
  const value = String(phase || '').trim();

  if (value === 'planning' || value === 'awaiting_approval' || value === 'applying' || value === 'testing') {
    return value;
  }

  if (value === 'implementing' || value === 'reviewing') {
    return 'planning';
  }

  if (value === 'completed' || value === 'failed' || value === 'aborted') {
    return value;
  }

  return 'planning';
}

function normalizeControlPlaneMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'queue' ? 'queue' : 'direct';
}

function sameWaitState(left, right) {
  if (!left || !right) {
    return false;
  }

  return Number(left.queuePosition || 0) === Number(right.queuePosition || 0)
    && String(left.blockingSessionId || '') === String(right.blockingSessionId || '');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeGeneratedFileOperation(file) {
  const operation = String(file?.operation || file?.status || '').trim().toLowerCase();

  if (operation === 'create' || operation === 'modify' || operation === 'delete' || operation === 'rename') {
    return operation;
  }

  if (String(file?.old_path || file?.from_path || '').trim()) {
    return 'rename';
  }

  if (file?.after_content === null || file?.content === null || file?.deleted === true || file?.remove === true) {
    return 'delete';
  }

  return 'modify';
}

async function safeReadFile(absolutePath) {
  try {
    return await readFile(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function isUniqueConstraintError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed');
}
