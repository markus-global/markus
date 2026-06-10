import {
  createLogger,
  generateId,
  parseInterval,
  type WorkflowTemplate,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowRunTrigger,
  type WorkflowStepConfig,
  type StepDef,
  type Task,
  TERMINAL_STATUSES,
} from '@markus/shared';
import { renderStepPrompt, topologicalSort } from '@markus/shared';
import type { RequirementService, CreateRequirementRequest } from './requirement-service.js';
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
    completed_at: run.completedAt ?? null,
  };
}

export class WorkflowRunner {
  private runRepo?: WorkflowRunRepo;
  private requirementService: RequirementService;
  private taskService: TaskService;
  private orgService: OrganizationService;
  private ws?: WSBroadcaster;

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
        const workflowContext = this.buildWorkflowContext(step, template, params, runNumber, sortedSteps);

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
          notes: `[Workflow] ${template.name} run #${runNumber}, step: ${step.id}`,
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
      id: generateId('wfr'),
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
    if (this.runRepo) {
      const rows = await this.runRepo.findByTeamAndWorkflow(teamId, workflowName, limit);
      return rows.map(rowToRun);
    }
    return [...this.runs.values()]
      .filter(r => r.teamId === teamId && r.workflowName === workflowName)
      .sort((a, b) => b.runNumber - a.runNumber)
      .slice(0, limit);
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
    if (!run || run.status !== 'running') return;

    const allTasks = run.taskIds.map(id => this.taskService.getTask(id)).filter(Boolean) as Task[];
    const newStatus: WorkflowRunStatus = this.deriveRunStatus(allTasks);

    // Still running — check for step failure and apply retry logic
    if (newStatus === 'running') {
      if (task.status === 'failed') {
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

    run.status = newStatus;
    run.completedAt = new Date().toISOString();
    this.runs.set(run.id, run);

    if (this.runRepo) {
      await this.runRepo.updateStatus(run.id, newStatus, run.completedAt).catch(err =>
        log.warn('Failed to update workflow run status', { error: String(err) }),
      );
    }

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
        failedTaskId: task.id,
        failedTaskTitle: task.title,
        actionRequired: true,
      });
    }

    this.ws?.broadcast?.({
      type: `workflow:run_${newStatus}` as const,
      payload: { runId: run.id, status: newStatus, teamId: run.teamId },
      timestamp: new Date().toISOString(),
    });

    log.info('Workflow run status changed', {
      runId: run.id,
      workflow: run.workflowName,
      newStatus,
      taskId: task.id,
    });
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
      const agentManager = this.orgService.getAgentManager();
      const agents = agentManager.listAgents();
      const secretary = agents.find(a =>
        a.agentRole === 'secretary' || a.role?.toLowerCase() === 'secretary'
      );
      return secretary?.id;
    } catch {
      return undefined;
    }
  }

  private buildWorkflowContext(
    step: StepDef,
    template: WorkflowTemplate,
    params: Record<string, string>,
    runNumber: number,
    sortedSteps: StepDef[],
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

    // Dependencies
    if (step.depends_on && step.depends_on.length > 0) {
      lines.push('');
      lines.push('Step dependencies (review their outputs using `task_get`):');
      for (const depId of step.depends_on) {
        const depStep = template.steps.find(s => s.id === depId);
        lines.push(`- "${depStep?.name || depId}" (${depId})`);
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
