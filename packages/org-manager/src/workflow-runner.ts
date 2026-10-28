import {
  createLogger,
  generateId,
  renderStepPrompt,
  topologicalSort,
  type WorkflowTemplate,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowRunTrigger,
  type WorkflowStepConfig,
  type StepDef,
  type Task,
  TERMINAL_STATUSES,
} from '@markus/shared';
import { createHash } from 'node:crypto';
import type { RequirementService } from './requirement-service.js';
import type { TaskService } from './task-service.js';
import type { OrganizationService } from './org-service.js';
import type { WSBroadcaster } from './ws-server.js';

const log = createLogger('workflow-runner');

export interface WorkflowRunRepo {
  create(run: WorkflowRunRow): Promise<void>;
  findById(id: string): Promise<WorkflowRunRow | null>;
  findByTeamAndWorkflow(teamId: string, workflowName: string, limit?: number): Promise<WorkflowRunRow[]>;
  findByRequirementId(requirementId: string): Promise<WorkflowRunRow | null>;
  updateStatus(id: string, status: WorkflowRunStatus, completedAt?: string): Promise<void>;
  getNextRunNumber(teamId: string, workflowName: string): Promise<number>;
  findRunning(teamId: string, workflowName: string): Promise<WorkflowRunRow[]>;
  findAllRunning(): Promise<WorkflowRunRow[]>;
}

export interface WorkflowRunRow {
  id: string;
  team_id: string;
  workflow_name: string;
  run_number: number;
  requirement_id: string;
  task_ids: string;
  params: string;
  role_mapping: string;
  status: string;
  triggered_by: string;
  project_id: string | null;
  started_at: string;
  completed_at: string | null;
  /** JSON-encoded WorkflowTemplate as of run start (null on pre-2026-10 runs). */
  template_version?: string | null;
  template_hash?: string | null;
  template_snapshot?: string | null;
}

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    teamId: row.team_id,
    workflowName: row.workflow_name,
    runNumber: row.run_number,
    requirementId: row.requirement_id,
    taskIds: JSON.parse(row.task_ids) as string[],
    params: JSON.parse(row.params) as Record<string, string>,
    roleMapping: JSON.parse(row.role_mapping) as Record<string, string>,
    status: row.status as WorkflowRunStatus,
    triggeredBy: row.triggered_by as WorkflowRunTrigger,
    projectId: row.project_id ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    templateVersion: row.template_version ?? undefined,
    templateHash: row.template_hash ?? undefined,
    templateSnapshot: row.template_snapshot
      ? (JSON.parse(row.template_snapshot) as WorkflowTemplate)
      : undefined,
  };
}

function runToRow(run: WorkflowRun): WorkflowRunRow {
  return {
    id: run.id,
    team_id: run.teamId,
    workflow_name: run.workflowName,
    run_number: run.runNumber,
    requirement_id: run.requirementId,
    task_ids: JSON.stringify(run.taskIds),
    params: JSON.stringify(run.params),
    role_mapping: JSON.stringify(run.roleMapping),
    status: run.status,
    triggered_by: run.triggeredBy,
    project_id: run.projectId ?? null,
    started_at: run.startedAt,
    template_version: run.templateVersion ?? null,
    template_hash: run.templateHash ?? null,
    template_snapshot: run.templateSnapshot ? JSON.stringify(run.templateSnapshot) : null,
    completed_at: run.completedAt ?? null,
  };
}

/** Raised when a team already has its maximum number of running workflows. */
export class WorkflowConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowConcurrencyError';
  }
}

/**
 * Parse a step's `timeout` shorthand (`"30s"`, `"15m"`, `"2h"`, `"1d"`, or raw ms).
 * Returns `null` for anything unparseable so callers can ignore bad config rather
 * than silently treating it as "no timeout".
 */
export function parseDurationMs(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const factor = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  const ms = amount * factor;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export class WorkflowRunner {
  private runRepo?: WorkflowRunRepo;
  private requirementService: RequirementService;
  private taskService: TaskService;
  private orgService: OrganizationService;
  private ws?: WSBroadcaster;

  /**
   * Team-level admission control. Without it a cron glitch (or an eager agent)
   * could start unlimited runs for one team — every one of them a real
   * requirement, real tasks and real token spend.
   *
   * Source of truth: `MARKUS_WORKFLOW_MAX_CONCURRENT` (process-wide policy), with
   * a conservative default. `setMaxConcurrentRunsPerTeam` exists for tests and for
   * a future per-team override; nothing else may write this value.
   */
  private maxConcurrentRunsPerTeam = (() => {
    const raw = Number(process.env['MARKUS_WORKFLOW_MAX_CONCURRENT']);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
  })();

  setMaxConcurrentRunsPerTeam(limit: number): void {
    if (Number.isFinite(limit) && limit > 0) this.maxConcurrentRunsPerTeam = Math.floor(limit);
  }

  getMaxConcurrentRunsPerTeam(): number {
    return this.maxConcurrentRunsPerTeam;
  }

  // In-memory cache for fast lookup
  private runs = new Map<string, WorkflowRun>();
  private reqToRun = new Map<string, string>();

  constructor(
    requirementService: RequirementService,
    taskService: TaskService,
    orgService: OrganizationService,
  ) {
    this.requirementService = requirementService;
    this.taskService = taskService;
    this.orgService = orgService;
  }

  setRunRepo(repo: WorkflowRunRepo): void {
    this.runRepo = repo;
  }

  setWSBroadcaster(ws: WSBroadcaster): void {
    this.ws = ws;
  }

  async createRun(
    teamId: string,
    template: WorkflowTemplate,
    params: Record<string, string>,
    roleMapping: Record<string, string>,
    projectId: string,
    triggeredBy: WorkflowRunTrigger = 'manual',
    createdBy?: string,
  ): Promise<WorkflowRun> {
    const team = this.orgService.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    // ── Admission control ───────────────────────────────────────────────────
    // The single entry point for starting a run, so the quota lives here rather
    // than in each caller (API route, scheduler, agent tool). Rejecting *before*
    // any side effect means a refused run leaves no requirement, no tasks and no
    // run row behind.
    const active = this.getActiveRuns(teamId).filter(r => r.status === 'running');
    if (active.length >= this.maxConcurrentRunsPerTeam) {
      throw new WorkflowConcurrencyError(
        `Team already has ${active.length} running workflow(s) (limit ${this.maxConcurrentRunsPerTeam}). ` +
          `Wait for one to finish, or raise workflow.maxConcurrentRunsPerTeam.`,
      );
    }

    // The run id is allocated *before* the tasks are created: a task carries its
    // (run, step) identity from birth, so nothing downstream has to reconstruct
    // the relationship from notes or titles.
    const runId = generateId('wfr');
    // Snapshot the template so this run renders with the definition it started
    // with, even if the YAML is edited afterwards.
    const templateHash = createHash('sha256').update(JSON.stringify(template)).digest('hex').slice(0, 16);

    // Validate required params
    for (const p of template.params ?? []) {
      if (p.required && !params[p.name]) {
        throw new Error(`Required parameter "${p.name}" is missing`);
      }
    }

    // Get run number
    const runNumber = this.runRepo
      ? await this.runRepo.getNextRunNumber(teamId, template.name)
      : this.getNextInMemoryRunNumber(teamId, template.name);

    const displayName = template.displayName || template.name;
    const topicSummary = params.topic || params.name || Object.values(params)[0] || '';
    const reqTitle = topicSummary
      ? `${displayName} #${runNumber} — ${topicSummary}`
      : `${displayName} #${runNumber}`;

    // 1. Create Requirement (source: 'workflow' → auto-approved to in_progress)
    const requirement = this.requirementService.createRequirement({
      orgId: team.orgId,
      title: reqTitle,
      description: `Workflow run #${runNumber}\nTemplate: ${template.name}\nParams: ${JSON.stringify(params)}`,
      projectId,
      source: 'workflow',
      createdBy: createdBy || team.managerId || 'system',
    });

    // 2. Sort steps topologically
    const sortedSteps = topologicalSort(template.steps);

    // 3. Create tasks in dependency order (with cleanup on failure)
    const taskIdMap = new Map<string, string>();
    const createdTaskIds: string[] = [];

    try {
      for (const step of sortedSteps) {
        const description = renderStepPrompt(step, params, runNumber);
        const workflowContext = this.buildWorkflowContext(step, template, params, runNumber, taskIdMap);

        const assignedAgentId = roleMapping[step.role];
        if (!assignedAgentId) {
          throw new Error(`No agent mapped for role "${step.role}" in workflow "${template.name}"`);
        }

        const reviewerId = this.resolveReviewer(step, roleMapping, team);

        const blockedBy = (step.depends_on || [])
          .map(depId => taskIdMap.get(depId))
          .filter((id): id is string => !!id);

        const task = this.taskService.createTask({
          orgId: team.orgId,
          title: `[${displayName}] ${step.name}`,
          description: `${workflowContext}\n\n${description}`,
          priority: step.priority || 'medium',
          assignedAgentId,
          reviewerId,
          reviewerType: 'agent',
          blockedBy,
          requirementId: requirement.id,
          projectId,
          createdBy: createdBy || team.managerId || 'system',
          creatorRole: 'worker',
          approvedVia: 'workflow',
          // Human-readable provenance only — the machine-readable identity is
          // `workflowRunId` / `workflowStepId` on the task itself.
          notes: `[Workflow] ${template.name} run #${runNumber}`,
          workflowRunId: runId,
          workflowStepId: step.id,
        });

        taskIdMap.set(step.id, task.id);
        createdTaskIds.push(task.id);
      }
    } catch (err) {
      for (const taskId of createdTaskIds) {
        try {
          this.taskService.cancelTask(taskId, false, 'system', 'system');
        } catch { /* best-effort cleanup */ }
      }
      throw err;
    }

    // 4. Build step configs for timeout/retry tracking
    const stepConfigs: WorkflowStepConfig[] = sortedSteps
      .filter(s => s.timeout || s.retry_count)
      .map(s => ({
        stepId: s.id,
        taskId: taskIdMap.get(s.id)!,
        timeout: s.timeout,
        retryCount: s.retry_count,
        retriesUsed: 0,
      }));

    // 5. Save run record
    const run: WorkflowRun = {
      id: runId,
      teamId,
      workflowName: template.name,
      runNumber,
      requirementId: requirement.id,
      taskIds: createdTaskIds,
      params,
      roleMapping,
      stepConfigs: stepConfigs.length > 0 ? stepConfigs : undefined,
      status: 'running',
      triggeredBy,
      projectId,
      startedAt: new Date().toISOString(),
      templateVersion: template.version,
      templateHash,
      templateSnapshot: template,
    };

    this.runs.set(run.id, run);
    this.reqToRun.set(requirement.id, run.id);

    if (this.runRepo) {
      await this.runRepo.create(runToRow(run)).catch(err =>
        log.warn('Failed to persist workflow run', { error: String(err) }),
      );
    }

    // 5. Notify manager agent
    this.notifyManager(teamId, 'run_started', {
      workflowName: template.name,
      displayName,
      runId: run.id,
      runNumber,
      params,
      steps: template.steps.map(s => s.name),
    });

    // 6. Broadcast WebSocket event
    this.ws?.broadcast?.({
      type: 'workflow:run_started',
      payload: {
        runId: run.id,
        teamId,
        workflowName: template.name,
        runNumber,
        requirementId: requirement.id,
        taskIds: createdTaskIds,
      },
      timestamp: new Date().toISOString(),
    });

    log.info('Workflow run created', {
      runId: run.id,
      workflow: template.name,
      runNumber,
      taskCount: createdTaskIds.length,
    });

    return run;
  }

  async cancelRun(runId: string, cancelledBy?: string): Promise<WorkflowRun> {
    const run = this.runs.get(runId) ?? (this.runRepo ? await this.loadRun(runId) : null);
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    if (run.status !== 'running') throw new Error(`Run ${runId} is already ${run.status}`);

    for (const taskId of run.taskIds) {
      try {
        const task = this.taskService.getTask(taskId);
        if (task && !TERMINAL_STATUSES.has(task.status)) {
          this.taskService.cancelTask(taskId, false, cancelledBy, 'system');
        }
      } catch (err) {
        log.warn('Failed to cancel task in workflow run', { taskId, error: String(err) });
      }
    }

    run.status = 'cancelled';
    run.completedAt = new Date().toISOString();
    this.runs.set(runId, run);

    if (this.runRepo) {
      await this.runRepo.updateStatus(runId, 'cancelled', run.completedAt).catch(err =>
        log.warn('Failed to update workflow run status', { error: String(err) }),
      );
    }

    this.notifyManager(run.teamId, 'run_cancelled', {
      workflowName: run.workflowName,
      runId,
      runNumber: run.runNumber,
    });

    this.ws?.broadcast?.({
      type: 'workflow:run_updated',
      payload: { runId, status: 'cancelled', teamId: run.teamId },
      timestamp: new Date().toISOString(),
    });

    return run;
  }

  async pauseRun(runId: string, pausedBy?: string): Promise<WorkflowRun> {
    const run = this.runs.get(runId) ?? (this.runRepo ? await this.loadRun(runId) : null);
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    if (run.status !== 'running') throw new Error(`Run ${runId} is not running (current: ${run.status})`);

    for (const taskId of run.taskIds) {
      try {
        const task = this.taskService.getTask(taskId);
        if (task && task.status === 'in_progress') {
          this.taskService.pauseTask(taskId, pausedBy, 'system');
        } else if (task && task.status === 'pending') {
          this.taskService.updateTaskStatus(taskId, 'blocked', pausedBy, true, false, 'system');
        }
      } catch (err) {
        log.warn('Failed to pause task in workflow run', { taskId, error: String(err) });
      }
    }

    run.status = 'paused' as WorkflowRunStatus;
    this.runs.set(runId, run);

    if (this.runRepo) {
      await this.runRepo.updateStatus(runId, 'paused' as WorkflowRunStatus).catch(err =>
        log.warn('Failed to update workflow run status', { error: String(err) }),
      );
    }

    this.ws?.broadcast?.({
      type: 'workflow:run_updated',
      payload: { runId, status: 'paused', teamId: run.teamId },
      timestamp: new Date().toISOString(),
    });

    return run;
  }

  async resumeRun(runId: string, resumedBy?: string): Promise<WorkflowRun> {
    const run = this.runs.get(runId) ?? (this.runRepo ? await this.loadRun(runId) : null);
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    if ((run.status as string) !== 'paused') throw new Error(`Run ${runId} is not paused (current: ${run.status})`);

    for (const taskId of run.taskIds) {
      try {
        const task = this.taskService.getTask(taskId);
        if (task && task.status === 'blocked') {
          this.taskService.resumeTask(taskId, resumedBy, 'system');
        }
      } catch (err) {
        log.warn('Failed to resume task in workflow run', { taskId, error: String(err) });
      }
    }

    run.status = 'running';
    this.runs.set(runId, run);

    if (this.runRepo) {
      await this.runRepo.updateStatus(runId, 'running').catch(err =>
        log.warn('Failed to update workflow run status', { error: String(err) }),
      );
    }

    this.ws?.broadcast?.({
      type: 'workflow:run_updated',
      payload: { runId, status: 'running', teamId: run.teamId },
      timestamp: new Date().toISOString(),
    });

    return run;
  }

  getRun(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  async getRunAsync(runId: string): Promise<WorkflowRun | null> {
    const cached = this.runs.get(runId);
    if (cached) return cached;
    return this.loadRun(runId);
  }

  getRunByRequirement(requirementId: string): WorkflowRun | undefined {
    const runId = this.reqToRun.get(requirementId);
    if (runId) return this.runs.get(runId);
    return undefined;
  }

  async listRuns(teamId: string, workflowName: string, limit = 20): Promise<WorkflowRun[]> {
    const runs = this.runRepo
      ? (await this.runRepo.findByTeamAndWorkflow(teamId, workflowName, limit)).map(rowToRun)
      : [...this.runs.values()]
          .filter(r => r.teamId === teamId && r.workflowName === workflowName)
          .sort((a, b) => b.runNumber - a.runNumber)
          .slice(0, limit);
    // Rows written before the derive-on-every-change fix can carry a stale
    // terminal status; heal them here so the UI never shows "失败 · 9/9 完成".
    return this.reconcileRunStatuses(runs);
  }

  getActiveRuns(teamId: string): WorkflowRun[] {
    return [...this.runs.values()]
      .filter(r => r.teamId === teamId && r.status === 'running');
  }

  /**
   * Called when a task transitions to a terminal status.
   * Checks if the task belongs to a workflow run and updates run status accordingly.
   */
  async onTaskStatusChange(task: Task): Promise<void> {
    // Find which run this task belongs to
    const run = this.findRunForTask(task.id);
    if (!run) return;

    // `paused` / `cancelled` are human decisions, not projections — a task
    // update must never resurrect them. Everything else IS a projection of the
    // tasks, and must therefore be recomputed on *every* task change, not just
    // while the run happens to still be `running`.
    //
    // The old `if (run.status !== 'running') return;` was a one-way ratchet: a
    // run that latched to `failed` could never notice that its failed step was
    // retried and every task then completed. Observed in the Work page as
    // "失败 · 9/9 个任务完成".
    if (run.status === 'paused' || run.status === 'cancelled') return;

    // ── Output contract ─────────────────────────────────────────────────────
    // A step that declares required `outputs` must actually deliver them. This
    // is checked on completion and *before* the run status is derived, so a step
    // that "finishes" without producing its declared artifact fails loudly here
    // instead of the downstream agent improvising from nothing.
    if (task.status === 'completed') {
      const missing = this.missingOutputs(run, task);
      if (missing.length > 0) {
        const reason = `Workflow output contract not met: missing ${missing.join(', ')}`;
        try {
          this.taskService.updateTaskStatus(task.id, 'failed', 'system', false, false, 'system', reason);
        } catch (err) {
          log.warn('Failed to fail a step that missed its declared outputs', { taskId: task.id, error: String(err) });
        }
        this.notifyManager(run.teamId, 'step_failed', {
          workflowName: run.workflowName,
          runId: run.id,
          runNumber: run.runNumber,
          taskId: task.id,
          taskTitle: task.title,
          reason: 'output_contract',
          missing,
          actionRequired: true,
        });
        return; // the transition to `failed` re-enters this method with status=failed
      }
    }

    const allTasks = run.taskIds.map(id => this.taskService.getTask(id)).filter(Boolean) as Task[];
    const newStatus: WorkflowRunStatus = this.deriveRunStatus(allTasks);

    // Unchanged — still running: step failure / retry bookkeeping only.
    if (newStatus === run.status) {
      if (newStatus === 'running' && task.status === 'failed') {
        const retried = this.attemptStepRetry(run, task);
        if (!retried) {
          this.notifyManager(run.teamId, 'step_failed', {
            workflowName: run.workflowName,
            runId: run.id,
            runNumber: run.runNumber,
            taskId: task.id,
            taskTitle: task.title,
            actionRequired: true,
          });
        }
      }
      return;
    }

    await this.applyRunStatus(run, newStatus, { task });
  }

  /**
   * Enforce `steps[].timeout`.
   *
   * The template has always *accepted* a timeout and stored it in
   * `stepConfigs` — nothing ever read it, so a wedged step kept its run
   * `running` forever and the config was a lie. Sweeping from the scheduler tick
   * (rather than per-task timers) means the guarantee survives a restart: the
   * deadline is recomputed from the task's own `startedAt`.
   *
   * Failure policy is shared with the normal failure path: retry if the step has
   * retries left, otherwise fail the task with an explicit reason so the run
   * status derives to `failed`.
   */
  async enforceTimeouts(now: number = Date.now()): Promise<number> {
    let enforced = 0;
    for (const run of [...this.runs.values()]) {
      if (run.status !== 'running') continue; // paused / cancelled / terminal: not ours to judge
      for (const cfg of run.stepConfigs ?? []) {
        const limitMs = parseDurationMs(cfg.timeout);
        if (!limitMs) continue;
        const task = this.taskService.getTask(cfg.taskId);
        if (!task || TERMINAL_STATUSES.has(task.status)) continue;

        const startedAtMs = new Date(task.startedAt ?? task.createdAt).getTime();
        if (!Number.isFinite(startedAtMs)) continue;
        if (now - startedAtMs < limitMs) continue;

        enforced += 1;
        const retried = this.attemptStepRetry(run, task);
        if (!retried) {
          try {
            this.taskService.updateTaskStatus(
              task.id,
              'failed',
              'system',
              false,
              false,
              'system',
              `Step timed out after ${cfg.timeout} (limit ${Math.round(limitMs / 1000)}s)`,
            );
          } catch (err) {
            log.warn('Failed to fail timed-out workflow step', { taskId: task.id, error: String(err) });
          }
          this.notifyManager(run.teamId, 'step_failed', {
            workflowName: run.workflowName,
            runId: run.id,
            runNumber: run.runNumber,
            taskId: task.id,
            taskTitle: task.title,
            reason: 'timeout',
            actionRequired: true,
          });
        }
        log.info('Workflow step timeout enforced', {
          runId: run.id,
          taskId: task.id,
          timeout: cfg.timeout,
          retried,
        });
      }
    }
    return enforced;
  }

  /**
   * The single writer for a *derived* run status.
   *
   * Callers: `onTaskStatusChange` (live) and `reconcileRunStatuses` (read-time
   * healing of historical drift). Keeping it in one place is what stops the two
   * paths from disagreeing about notifications or `completedAt`.
   */
  private async applyRunStatus(
    run: WorkflowRun,
    newStatus: WorkflowRunStatus,
    ctx: { task?: Task; notify?: boolean } = {},
  ): Promise<void> {
    const previous = run.status;
    const notify = ctx.notify ?? true;

    run.status = newStatus;
    if (newStatus === 'running') {
      run.completedAt = undefined;
    } else {
      run.completedAt = run.completedAt ?? new Date().toISOString();
    }
    this.runs.set(run.id, run);

    if (this.runRepo) {
      await this.runRepo.updateStatus(run.id, newStatus, run.completedAt).catch(err =>
        log.warn('Failed to update workflow run status', { error: String(err) }),
      );
    }

    // Notify only on a genuine transition out of `running` — healing an old run
    // on read must not re-ping the manager.
    if (notify && previous === 'running') {
      if (newStatus === 'completed') {
        this.notifyManager(run.teamId, 'run_completed', {
          workflowName: run.workflowName,
          runId: run.id,
          runNumber: run.runNumber,
          taskCount: run.taskIds.length,
          actionRequired: true,
        });
      } else if (newStatus === 'failed') {
        this.notifyManager(run.teamId, 'run_failed', {
          workflowName: run.workflowName,
          runId: run.id,
          runNumber: run.runNumber,
          failedTaskId: ctx.task?.id ?? '',
          failedTaskTitle: ctx.task?.title ?? '',
          actionRequired: true,
        });
      }
    }

    this.ws?.broadcast?.({
      type: `workflow:run_${newStatus}` as const,
      payload: { runId: run.id, status: newStatus, teamId: run.teamId },
      timestamp: new Date().toISOString(),
    });

    log.info('Workflow run status changed', {
      runId: run.id,
      workflow: run.workflowName,
      previousStatus: previous,
      newStatus,
      taskId: ctx.task?.id,
    });
  }

  /**
   * Tasks are the authority; a run's terminal status is a projection of them.
   * Rows written before the fix above are healed here, on read.
   */
  private async reconcileRunStatuses(runs: WorkflowRun[]): Promise<WorkflowRun[]> {
    const healed: WorkflowRun[] = [];
    for (const run of runs) {
      if (run.status === 'paused' || run.status === 'cancelled') {
        healed.push(run);
        continue;
      }
      const tasks = run.taskIds.map(id => this.taskService.getTask(id)).filter(Boolean) as Task[];
      if (tasks.length === 0) {
        healed.push(run);
        continue;
      }
      const derived = this.deriveRunStatus(tasks);
      if (derived !== run.status) {
        await this.applyRunStatus(run, derived, { notify: false });
      }
      healed.push(run);
    }
    return healed;
  }

  async loadFromDB(): Promise<void> {
    if (!this.runRepo) return;
    try {
      const rows = await this.runRepo.findAllRunning();
      for (const row of rows) {
        const run = rowToRun(row);
        this.runs.set(run.id, run);
        this.reqToRun.set(run.requirementId, run.id);
      }
      if (rows.length > 0) {
        log.info(`Loaded ${rows.length} running workflow run(s) from DB`);
      }
    } catch (err) {
      log.warn('Failed to load workflow runs from DB', { error: String(err) });
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Which of the step's *required* declared outputs are missing from the task.
   *
   * The check is deliberately narrow and mechanical:
   *   - `outputs[].type` is compared against `TaskDeliverable.type` (a real
   *     structured field — never free text);
   *   - an output declared without a `type` can only be checked as "produced at
   *     least one deliverable", which is what it says on the tin;
   *   - `required: false` opts an output out entirely;
   *   - runs without a template snapshot (pre-2026-10) have no contract to
   *     enforce and are left alone rather than retro-failed.
   */
  private missingOutputs(run: WorkflowRun, task: Task): string[] {
    const stepId = task.workflowStepId;
    if (!stepId) return [];
    const template = run.templateSnapshot;
    if (!template) return [];
    const step = template.steps.find(s => s.id === stepId);
    const required = (step?.outputs ?? []).filter(o => o.required !== false);
    if (required.length === 0) return [];

    const deliverables = (task.deliverables ?? []) as Array<{ type?: string }>;
    const types = new Set(deliverables.map(d => d.type).filter((t): t is string => !!t));

    return required
      .filter(output => (output.type ? !types.has(output.type) : deliverables.length === 0))
      .map(output => (output.type ? `${output.name}(${output.type})` : output.name));
  }

  private deriveRunStatus(tasks: Task[]): WorkflowRunStatus {
    if (tasks.length === 0) return 'running';
    if (tasks.every(t => t.status === 'completed')) return 'completed';
    if (tasks.every(t => TERMINAL_STATUSES.has(t.status))) {
      if (tasks.some(t => t.status === 'failed')) return 'failed';
      if (tasks.some(t => t.status === 'cancelled')) return 'cancelled';
      return 'completed';
    }
    return 'running';
  }

  private findRunForTask(taskId: string): WorkflowRun | undefined {
    for (const run of this.runs.values()) {
      if (run.taskIds.includes(taskId)) return run;
    }
    return undefined;
  }

  private attemptStepRetry(run: WorkflowRun, task: Task): boolean {
    if (!run.stepConfigs) return false;
    const stepCfg = run.stepConfigs.find(sc => sc.taskId === task.id);
    if (!stepCfg || !stepCfg.retryCount) return false;
    if ((stepCfg.retriesUsed ?? 0) >= stepCfg.retryCount) return false;

    try {
      stepCfg.retriesUsed = (stepCfg.retriesUsed ?? 0) + 1;
      this.taskService.updateTaskStatus(task.id, 'pending', 'system', true, false, 'system', `Workflow auto-retry ${stepCfg.retriesUsed}/${stepCfg.retryCount}`);
      log.info('Retrying failed workflow step', {
        runId: run.id, taskId: task.id, retry: stepCfg.retriesUsed, maxRetries: stepCfg.retryCount,
      });
      return true;
    } catch (err) {
      log.warn('Failed to retry workflow step', { taskId: task.id, error: String(err) });
      return false;
    }
  }

  private resolveReviewer(
    step: StepDef,
    roleMapping: Record<string, string>,
    team: { managerId?: string; memberAgentIds: string[] },
  ): string {
    const assignee = roleMapping[step.role];

    const pickOrFallback = (candidate: string | undefined): string => {
      if (candidate && candidate !== assignee) return candidate;
      // Assignee === candidate (self-review): try another team member first
      const otherMember = team.memberAgentIds.find(id => id !== assignee);
      if (otherMember) return otherMember;
      // Last resort: use the Secretary (system default agent)
      const secretary = this.findSecretaryAgent();
      if (secretary) return secretary;
      // Absolute fallback — self-review (will be caught at review time)
      return candidate || assignee;
    };

    // Explicit reviewer role on the step
    if (step.reviewer && roleMapping[step.reviewer]) {
      return pickOrFallback(roleMapping[step.reviewer]!);
    }
    // Default to team manager
    if (team.managerId) return pickOrFallback(team.managerId);
    // Fallback chain
    return pickOrFallback(undefined);
  }

  private findSecretaryAgent(): string | undefined {
    try {
      return this.orgService.findOrgSecretary()?.id;
    } catch {
      return undefined;
    }
  }

  /**
   * The prompt preamble a step's task starts with.
   *
   * Upstream outputs *are* the data channel in this design: the runner creates
   * every task up front, `blockedBy` orders them, and `task_get` returns an
   * upstream task's `deliverables`. What used to be broken was the **pointer**:
   * this text listed upstream *step* ids (`step-1-research`) while the tool it
   * named (`task_get`) needs a *task* id (`tsk_…`), so the instruction failed
   * verbatim ("Task not found") and a diligent agent had to rediscover the route
   * through `blockedBy` on its own task.
   *
   * Now the upstream task id is written out explicitly. Tasks are created in
   * topological order, so every dependency already has its id by the time a
   * downstream step is rendered.
   */
  private buildWorkflowContext(
    step: StepDef,
    template: WorkflowTemplate,
    params: Record<string, string>,
    runNumber: number,
    taskIdMap: Map<string, string>,
  ): string {
    const displayName = template.displayName || template.name;
    const lines: string[] = [
      `## Workflow Context`,
      `This task is step "${step.name}" (${step.id}) in workflow "${displayName}" run #${runNumber}.`,
    ];

    // Show params
    const paramEntries = Object.entries(params);
    if (paramEntries.length > 0) {
      lines.push(`Parameters: ${paramEntries.map(([k, v]) => `${k}="${v}"`).join(', ')}`);
    }
    lines.push(`Your role in this workflow: ${step.role}`);

    // Declared inputs first: this is the contract, and it names exactly what to
    // read. Falls back to the plain dependency list for templates that declare
    // no `inputs` (backward compatible).
    const declaredInputs = step.inputs ?? [];
    if (declaredInputs.length > 0) {
      lines.push('');
      lines.push('Inputs you must consume (declared by this workflow):');
      for (const input of declaredInputs) {
        const fromStep = template.steps.find(s => s.id === input.from);
        const fromTaskId = taskIdMap.get(input.from);
        const declared = fromStep?.outputs?.find(o => o.name === input.as);
        const typeHint = declared?.type ? ` of type "${declared.type}"` : '';
        if (fromTaskId) {
          lines.push(
            `- \`${input.as}\`${typeHint} from step "${fromStep?.name || input.from}" → task \`${fromTaskId}\` ` +
              `(call \`task_get\` with task_id="${fromTaskId}" and read the deliverable${declared?.type ? ` whose type is "${declared.type}"` : ''})`,
          );
        } else {
          lines.push(`- \`${input.as}\` from step "${fromStep?.name || input.from}" — its task has not been created yet`);
        }
      }
    }

    // Dependencies — with the actual task ids, so the instruction is executable.
    if (step.depends_on && step.depends_on.length > 0) {
      lines.push('');
      lines.push('Upstream steps — read their deliverables before you start:');
      for (const depId of step.depends_on) {
        const depStep = template.steps.find(s => s.id === depId);
        const depTaskId = taskIdMap.get(depId);
        const name = depStep?.name || depId;
        if (depTaskId) {
          lines.push(`- "${name}" → task \`${depTaskId}\` — call \`task_get\` with task_id="${depTaskId}" and use its deliverables as your input`);
        } else {
          lines.push(`- "${name}" (${depId}) — its task has not been created yet (upstream step failed to materialize)`);
        }
      }
    } else {
      lines.push('');
      lines.push('Step dependencies: none (this is the first step)');
    }

    // Downstream consumers
    const downstream = template.steps.filter(s => s.depends_on?.includes(step.id));
    if (downstream.length > 0) {
      lines.push('');
      lines.push('Downstream steps waiting on your output:');
      for (const ds of downstream) {
        lines.push(`- "${ds.name}" (${ds.id}) — will use your deliverables as input`);
      }
    }

    return lines.join('\n');
  }

  private notifyManager(
    teamId: string,
    event: string,
    data: Record<string, unknown>,
  ): void {
    const team = this.orgService.getTeam(teamId);
    if (!team?.managerId) return;

    try {
      const agentManager = this.orgService.getAgentManager();
      const manager = agentManager.getAgent(team.managerId);

      const actionRequired = !!data.actionRequired;
      const summary = this.buildNotificationSummary(event, data);
      const content = this.buildNotificationContent(event, data);

      manager.enqueueToMailbox('workflow_update', {
        summary,
        content,
        extra: {
          ...data,
          event,
          actionRequired,
        },
      }, {
        priority: actionRequired ? 1 : 2,
      });
    } catch (err) {
      log.warn('Failed to notify manager about workflow event', { teamId, event, error: String(err) });
    }
  }

  private buildNotificationSummary(event: string, data: Record<string, unknown>): string {
    const wf = data.workflowName || 'workflow';
    const num = data.runNumber || '';
    switch (event) {
      case 'run_started': return `Workflow "${wf}" run #${num} started`;
      case 'run_completed': return `Workflow "${wf}" run #${num} completed`;
      case 'run_failed': return `Workflow "${wf}" run #${num} failed`;
      case 'run_cancelled': return `Workflow "${wf}" run #${num} cancelled`;
      case 'step_failed': return `Workflow step "${data.taskTitle}" failed in run #${num}`;
      case 'schedule_triggered': return `Scheduled workflow "${wf}" run #${num} auto-triggered`;
      default: return `Workflow "${wf}" update: ${event}`;
    }
  }

  private buildNotificationContent(event: string, data: Record<string, unknown>): string {
    const lines: string[] = [];
    switch (event) {
      case 'run_started':
        lines.push(`Parameters: ${JSON.stringify(data.params ?? {})}`);
        if (Array.isArray(data.steps)) lines.push(`Steps: ${(data.steps as string[]).join(' → ')}`);
        break;
      case 'run_completed':
        lines.push(`All ${data.taskCount} steps completed successfully.`);
        lines.push('ACTION: Review the outputs and confirm the workflow run is satisfactory.');
        break;
      case 'run_failed':
        lines.push(`Step "${data.failedTaskTitle}" failed.`);
        lines.push('ACTION: Investigate and decide whether to retry the step or cancel the workflow run.');
        break;
      case 'step_failed':
        lines.push(`Step "${data.taskTitle}" (${data.taskId}) failed while other steps are still running.`);
        lines.push('ACTION: Decide whether to retry this step or cancel the entire run.');
        break;
      case 'run_cancelled':
        lines.push('The workflow run was cancelled.');
        break;
      case 'schedule_triggered':
        lines.push(`Auto-generated params: ${JSON.stringify(data.params ?? {})}`);
        break;
    }
    return lines.join('\n');
  }

  private getNextInMemoryRunNumber(teamId: string, workflowName: string): number {
    let max = 0;
    for (const run of this.runs.values()) {
      if (run.teamId === teamId && run.workflowName === workflowName && run.runNumber > max) {
        max = run.runNumber;
      }
    }
    return max + 1;
  }

  private async loadRun(runId: string): Promise<WorkflowRun | null> {
    if (!this.runRepo) return null;
    const row = await this.runRepo.findById(runId);
    if (!row) return null;
    const run = rowToRun(row);
    this.runs.set(run.id, run);
    this.reqToRun.set(run.requirementId, run.id);
    return run;
  }
}
