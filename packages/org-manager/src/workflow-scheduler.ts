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

export interface WorkflowScheduleRepo {
  upsert(row: {
    team_id: string;
    workflow_name: string;
    schedule: string;
    next_run_at: string | null;
    total_runs: number;
    last_run_at: string | null;
    paused: number;
    last_role_mapping: string;
    updated_at: string;
  }): Promise<void>;
  findAll(): Promise<Array<{
    team_id: string;
    workflow_name: string;
    schedule: string;
    next_run_at: string | null;
    total_runs: number;
    last_run_at: string | null;
    paused: number;
    last_role_mapping: string;
    updated_at: string;
  }>>;
  remove(teamId: string, workflowName: string): Promise<void>;
}

/**
 * Polls scheduled workflow templates on a fixed interval and auto-triggers runs
 * when their next-run time has passed. Parallel to ScheduledTaskRunner but
 * operates on workflow templates (DAGs) rather than individual tasks.
 */
export class WorkflowScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private scheduleRepo?: WorkflowScheduleRepo;
  private paramGenerator?: (prompt: string) => Promise<string | null>;

  private scheduleStates = new Map<string, WorkflowScheduleState>();

  constructor(
    private workflowService: WorkflowService,
    private workflowRunner: WorkflowRunner,
    private orgService: OrganizationService,
    private pollIntervalMs = 60_000,
  ) {}

  setScheduleRepo(repo: WorkflowScheduleRepo): void {
    this.scheduleRepo = repo;
  }

  setParamGenerator(gen: (prompt: string) => Promise<string | null>): void {
    this.paramGenerator = gen;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.loadFromDB();
    this.refreshScheduleStates();

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

  private async loadFromDB(): Promise<void> {
    if (!this.scheduleRepo) return;
    try {
      const rows = await this.scheduleRepo.findAll();
      for (const row of rows) {
        const key = this.stateKey(row.team_id, row.workflow_name);
        this.scheduleStates.set(key, {
          teamId: row.team_id,
          workflowName: row.workflow_name,
          schedule: JSON.parse(row.schedule),
          nextRunAt: row.next_run_at,
          totalRuns: row.total_runs,
          lastRunAt: row.last_run_at,
          paused: row.paused === 1,
          lastRoleMapping: JSON.parse(row.last_role_mapping),
        });
      }
      if (rows.length > 0) {
        log.info(`Loaded ${rows.length} workflow schedule state(s) from DB`);
      }
    } catch (err) {
      log.warn('Failed to load workflow schedule states from DB', { error: String(err) });
    }
  }

  private async persistState(state: WorkflowScheduleState): Promise<void> {
    if (!this.scheduleRepo) return;
    try {
      await this.scheduleRepo.upsert({
        team_id: state.teamId,
        workflow_name: state.workflowName,
        schedule: JSON.stringify(state.schedule),
        next_run_at: state.nextRunAt,
        total_runs: state.totalRuns,
        last_run_at: state.lastRunAt,
        paused: state.paused ? 1 : 0,
        last_role_mapping: JSON.stringify(state.lastRoleMapping),
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      log.warn('Failed to persist workflow schedule state', { error: String(err) });
    }
  }

  /**
   * Refresh schedule states from YAML templates. Picks up new/removed/changed
   * schedules without requiring a server restart. Iterates all orgs dynamically.
   */
  private refreshScheduleStates(): void {
    try {
      const orgs = (this.orgService as any).listOrgs?.() ?? [{ id: 'default' }];
      const seenKeys = new Set<string>();

      for (const org of orgs) {
        const teams = this.orgService.listTeams(org.id);
        for (const team of teams) {
          const workflows = this.workflowService.listWorkflows(team.id);
          for (const wf of workflows) {
            if (!wf.hasSchedule || !wf.schedule) continue;

            const key = this.stateKey(team.id, wf.name);
            seenKeys.add(key);

            const existing = this.scheduleStates.get(key);
            if (existing) {
              existing.schedule = wf.schedule;
            } else {
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
      }

      for (const key of this.scheduleStates.keys()) {
        if (!seenKeys.has(key)) {
          this.scheduleStates.delete(key);
        }
      }
    } catch (err) {
      log.warn('Failed to refresh schedule states', { error: String(err) });
    }
  }

  private async tick(): Promise<void> {
    this.refreshScheduleStates();

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
        await this.persistState(state);
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

    const params: Record<string, string> = {};
    for (const p of template.params ?? []) {
      if (p.default) params[p.name] = p.default;
      if (p.auto_generate && this.paramGenerator) {
        try {
          const generated = await this.paramGenerator(p.auto_prompt ?? `Generate a value for "${p.name}": ${p.description ?? ''}`);
          if (generated) params[p.name] = generated;
        } catch (err) {
          log.warn('Failed to auto-generate param', { param: p.name, error: String(err) });
        }
      }
    }
    params['_run_date'] = new Date().toISOString().slice(0, 10);
    params['_run_timestamp'] = new Date().toISOString();

    let roleMapping = state.lastRoleMapping;
    if (!roleMapping || Object.keys(roleMapping).length === 0) {
      roleMapping = this.workflowService.buildDefaultRoleMapping(state.teamId, template);
    }

    const projectId = await this.findProjectForTeam(state.teamId);
    if (!projectId) {
      log.warn('No project linked to team for scheduled workflow — skipping', { teamId: state.teamId, name: state.workflowName });
      return;
    }

    const run = await this.workflowRunner.createRun(
      state.teamId, template, params, roleMapping, projectId, 'schedule',
    );

    state.lastRunAt = new Date().toISOString();
    state.totalRuns++;
    state.lastRoleMapping = roleMapping;
    state.nextRunAt = this.computeNextRun(state.schedule, state.lastRunAt);
    await this.persistState(state);

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
    if ('run_at' in schedule && schedule.run_at) {
      if (!lastRunAt) return schedule.run_at as string;
      return null;
    }

    if ('every' in schedule && schedule.every) {
      const intervalMs = parseInterval(schedule.every as string);
      if (!intervalMs) return null;

      const base = lastRunAt ? new Date(lastRunAt).getTime() : Date.now();
      return new Date(base + intervalMs).toISOString();
    }

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
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}
