import {
  createLogger,
  parseInterval,
  type WorkflowScheduleState,
} from '@markus/shared';
import { CronExpressionParser } from 'cron-parser';
import type { WorkflowService } from './workflow-service.js';
import type { WorkflowRunner } from './workflow-runner.js';
import type { OrganizationService } from './org-service.js';

const log = createLogger('workflow-scheduler');

/**
 * Polls scheduled workflow templates on a fixed interval and auto-triggers runs
 * when their next-run time has passed. Parallel to ScheduledTaskRunner but
 * operates on workflow templates (DAGs) rather than individual tasks.
 */
export class WorkflowScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  private scheduleStates = new Map<string, WorkflowScheduleState>();

  constructor(
    private workflowService: WorkflowService,
    private workflowRunner: WorkflowRunner,
    private orgService: OrganizationService,
    private pollIntervalMs = 60_000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    this.initScheduleStates();

    this.timer = setInterval(() => {
      this.tick().catch(e =>
        log.error('Workflow scheduler tick failed', { error: String(e) }),
      );
    }, this.pollIntervalMs);

    log.info('WorkflowScheduler started', { pollIntervalMs: this.pollIntervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.running = false;
    log.info('WorkflowScheduler stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  private stateKey(teamId: string, workflowName: string): string {
    return `${teamId}:${workflowName}`;
  }

  private initScheduleStates(): void {
    try {
      const teams = this.orgService.listTeams('default');
      for (const team of teams) {
        const workflows = this.workflowService.listWorkflows(team.id);
        for (const wf of workflows) {
          if (!wf.hasSchedule || !wf.schedule) continue;

          const key = this.stateKey(team.id, wf.name);
          if (!this.scheduleStates.has(key)) {
            const nextRunAt = this.computeNextRun(wf.schedule, null);
            this.scheduleStates.set(key, {
              teamId: team.id,
              workflowName: wf.name,
              schedule: wf.schedule,
              nextRunAt,
              totalRuns: 0,
              lastRunAt: null,
              paused: false,
              lastRoleMapping: {},
            });
          }
        }
      }
    } catch (err) {
      log.warn('Failed to initialize schedule states', { error: String(err) });
    }
  }

  private async tick(): Promise<void> {
    this.initScheduleStates();

    const now = Date.now();

    for (const [key, state] of this.scheduleStates) {
      if (state.paused) continue;

      if (!state.nextRunAt) {
        state.nextRunAt = this.computeNextRun(state.schedule, state.lastRunAt);
        if (!state.nextRunAt) continue;
      }

      const nextRunTime = new Date(state.nextRunAt).getTime();
      if (nextRunTime > now) continue;

      // Check max_runs
      const sched = state.schedule;
      if (sched.max_runs && sched.max_runs > 0 && state.totalRuns >= sched.max_runs) {
        state.paused = true;
        log.info('Workflow schedule reached max_runs', { key, totalRuns: state.totalRuns });
        continue;
      }

      // Check no active run already in progress for this workflow
      const activeRuns = this.workflowRunner.getActiveRuns(state.teamId);
      if (activeRuns.some(r => r.workflowName === state.workflowName)) {
        log.info('Skipping scheduled trigger — previous run still active', { key });
        continue;
      }

      try {
        await this.triggerScheduledRun(state);
      } catch (err) {
        log.error('Failed to trigger scheduled workflow run', { key, error: String(err) });
      }
    }
  }

  private async triggerScheduledRun(state: WorkflowScheduleState): Promise<void> {
    const template = this.workflowService.getWorkflow(state.teamId, state.workflowName);
    if (!template) {
      log.warn('Scheduled workflow template not found', { teamId: state.teamId, name: state.workflowName });
      return;
    }

    // Build params: use defaults from template, add auto-generated date params
    const params: Record<string, string> = {};
    for (const p of template.params ?? []) {
      if (p.default) params[p.name] = p.default;
    }
    params['_run_date'] = new Date().toISOString().slice(0, 10);
    params['_run_timestamp'] = new Date().toISOString();

    // Resolve roles: reuse last mapping if available, otherwise auto-resolve
    let roleMapping = state.lastRoleMapping;
    if (!roleMapping || Object.keys(roleMapping).length === 0) {
      roleMapping = this.workflowService.buildDefaultRoleMapping(state.teamId, template);
    }

    // Find a project for this team
    const projectId = await this.findProjectForTeam(state.teamId);
    if (!projectId) {
      log.warn('No project found for scheduled workflow', { teamId: state.teamId, name: state.workflowName });
      return;
    }

    const run = await this.workflowRunner.createRun(
      state.teamId, template, params, roleMapping, projectId, 'schedule',
    );

    // Update schedule state
    state.lastRunAt = new Date().toISOString();
    state.totalRuns++;
    state.lastRoleMapping = roleMapping;
    state.nextRunAt = this.computeNextRun(state.schedule, state.lastRunAt);

    log.info('Scheduled workflow run triggered', {
      teamId: state.teamId,
      workflow: state.workflowName,
      runId: run.id,
      runNumber: run.runNumber,
      nextRunAt: state.nextRunAt,
    });
  }

  private computeNextRun(
    schedule: WorkflowScheduleState['schedule'],
    lastRunAt: string | null,
  ): string | null {
    // One-shot run_at
    if ('run_at' in schedule && schedule.run_at) {
      if (!lastRunAt) return schedule.run_at as string;
      return null;
    }

    // Interval-based
    if ('every' in schedule && schedule.every) {
      const intervalMs = parseInterval(schedule.every as string);
      if (!intervalMs) return null;

      const base = lastRunAt ? new Date(lastRunAt).getTime() : Date.now();
      return new Date(base + intervalMs).toISOString();
    }

    // Cron-based: compute next cron fire from now
    if ('cron' in schedule && schedule.cron) {
      return this.computeCronNext(schedule.cron as string, (schedule as any).timezone);
    }

    return null;
  }

  private computeCronNext(cron: string, timezone?: string): string | null {
    try {
      const interval = CronExpressionParser.parse(cron, {
        currentDate: new Date(),
        tz: timezone || undefined,
      });
      return interval.next().toISOString() ?? null;
    } catch {
      log.warn('Failed to parse cron expression', { cron });
      return null;
    }
  }

  private async findProjectForTeam(teamId: string): Promise<string | null> {
    try {
      const storage = this.orgService.getStorage?.();
      if (storage?.projectRepo) {
        const projects = await storage.projectRepo.listAll();
        for (const p of projects) {
          const teamIds: string[] = typeof p.teamIds === 'string' ? JSON.parse(p.teamIds) : (p.teamIds ?? []);
          if (teamIds.includes(teamId)) return p.id;
        }
        if (projects.length > 0) return projects[0].id;
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}
