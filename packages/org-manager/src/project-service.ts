import {
  createLogger,
  generateId,
  type Project,
  type Iteration,
  type IterationStatus,
  type ProjectRepository,
  type TaskGovernancePolicy,
  type ArchivePolicy,
  type ReportSchedule,
  type ProjectOnboardingConfig,
} from '@markus/shared';

const log = createLogger('project-service');

interface ProjectRepo {
  create(data: Record<string, unknown>): Promise<unknown>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  listByOrg(orgId: string): unknown[];
  listAll(): unknown[];
}

interface IterationRepo {
  create(data: Record<string, unknown>): Promise<unknown>;
  updateStatus(id: string, status: string): Promise<unknown>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  listByProject(projectId: string): unknown[];
}

export class ProjectService {
  private projects = new Map<string, Project>();
  private iterations = new Map<string, Iteration>();
  private projectRepo?: ProjectRepo;
  private iterationRepo?: IterationRepo;

  setProjectRepo(repo: ProjectRepo): void {
    this.projectRepo = repo;
  }

  setIterationRepo(repo: IterationRepo): void {
    this.iterationRepo = repo;
  }

  async loadFromDB(orgId: string): Promise<void> {
    if (this.projectRepo) {
      try {
        const rows = this.projectRepo.listByOrg(orgId) as any[];
        for (const r of rows) {
          const project: Project = {
            id: r.id,
            orgId: r.orgId,
            name: r.name,
            description: r.description ?? '',
            status: r.status ?? 'active',
            iterationModel: (r.iterationModel as Project['iterationModel']) ?? 'kanban',
            repositories: (r.repositories as ProjectRepository[]) ?? [],
            teamIds: (r.teamIds as string[]) ?? [],
            governancePolicy: r.governancePolicy as TaskGovernancePolicy | undefined,
            archivePolicy: r.archivePolicy as ArchivePolicy | undefined,
            reportSchedule: r.reportSchedule as ReportSchedule | undefined,
            onboardingConfig: r.onboardingConfig as ProjectOnboardingConfig | undefined,
            createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(r.createdAt).toISOString(),
            updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date(r.updatedAt).toISOString(),
          };
          this.projects.set(project.id, project);
        }
        log.info(`Loaded ${this.projects.size} projects from DB`);
      } catch (err) {
        log.warn('Failed to load projects from DB', { error: String(err) });
      }
    }

    if (this.iterationRepo) {
      for (const project of this.projects.values()) {
        try {
          const rows = this.iterationRepo.listByProject(project.id) as any[];
          for (const r of rows) {
            const iter: Iteration = {
              id: r.id,
              projectId: r.projectId,
              name: r.name,
              status: r.status as IterationStatus,
              goal: r.goal ?? undefined,
              startDate: r.startDate ?? undefined,
              endDate: r.endDate ?? undefined,
              createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(r.createdAt).toISOString(),
              updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date(r.updatedAt).toISOString(),
            };
            this.iterations.set(iter.id, iter);
          }
        } catch (err) {
          log.warn('Failed to load iterations from DB', { projectId: project.id, error: String(err) });
        }
      }
      log.info(`Loaded ${this.iterations.size} iterations from DB`);
    }
  }

  // ─── Project CRUD ──────────────────────────────────────────────────────────

  createProject(opts: {
    orgId: string;
    name: string;
    description: string;
    iterationModel?: 'sprint' | 'kanban';
    repositories?: ProjectRepository[];
    teamIds?: string[];
    governancePolicy?: TaskGovernancePolicy;
    archivePolicy?: ArchivePolicy;
    reportSchedule?: ReportSchedule;
    onboardingConfig?: ProjectOnboardingConfig;
  }): Project {
    const now = new Date().toISOString();
    const project: Project = {
      id: generateId('proj'),
      orgId: opts.orgId,
      name: opts.name,
      description: opts.description,
      status: 'active',
      iterationModel: opts.iterationModel ?? 'kanban',
      repositories: opts.repositories ?? [],
      teamIds: opts.teamIds ?? [],
      governancePolicy: opts.governancePolicy,
      archivePolicy: opts.archivePolicy,
      reportSchedule: opts.reportSchedule,
      onboardingConfig: opts.onboardingConfig,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    this.projectRepo?.create({
      id: project.id, orgId: project.orgId, name: project.name,
      description: project.description, status: project.status,
      iterationModel: project.iterationModel, repositories: project.repositories,
      teamIds: project.teamIds, governancePolicy: project.governancePolicy,
      archivePolicy: project.archivePolicy, reportSchedule: project.reportSchedule,
      onboardingConfig: project.onboardingConfig,
    }).catch(err => log.warn('Failed to persist project', { error: String(err) }));
    log.info('Project created', { id: project.id, name: project.name });
    return project;
  }

  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  listProjects(orgId?: string): Project[] {
    const all = [...this.projects.values()];
    return orgId ? all.filter(p => p.orgId === orgId) : all;
  }

  updateProject(
    id: string,
    updates: Partial<Omit<Project, 'id' | 'orgId' | 'createdAt'>>
  ): Project {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    Object.assign(project, updates, { updatedAt: new Date().toISOString() });
    this.projectRepo?.update(id, updates as Record<string, unknown>)
      .catch(err => log.warn('Failed to persist project update', { error: String(err) }));
    log.info('Project updated', { id });
    return project;
  }

  deleteProject(id: string): void {
    this.projects.delete(id);
    for (const [iterId, iter] of this.iterations) {
      if (iter.projectId === id) this.iterations.delete(iterId);
    }
    this.projectRepo?.delete(id)
      .catch(err => log.warn('Failed to delete project from DB', { error: String(err) }));
    log.info('Project deleted', { id });
  }

  // ─── Iteration CRUD ────────────────────────────────────────────────────────

  createIteration(opts: {
    projectId: string;
    name: string;
    goal?: string;
    startDate?: string;
    endDate?: string;
  }): Iteration {
    const project = this.projects.get(opts.projectId);
    if (!project) throw new Error(`Project not found: ${opts.projectId}`);

    const now = new Date().toISOString();
    const iteration: Iteration = {
      id: generateId('iter'),
      projectId: opts.projectId,
      name: opts.name,
      status: 'planning',
      goal: opts.goal,
      startDate: opts.startDate,
      endDate: opts.endDate,
      createdAt: now,
      updatedAt: now,
    };
    this.iterations.set(iteration.id, iteration);
    this.iterationRepo?.create({
      id: iteration.id, projectId: iteration.projectId, name: iteration.name,
      status: iteration.status, goal: iteration.goal,
      startDate: iteration.startDate, endDate: iteration.endDate,
    }).catch(err => log.warn('Failed to persist iteration', { error: String(err) }));
    log.info('Iteration created', {
      id: iteration.id,
      name: iteration.name,
      projectId: opts.projectId,
    });
    return iteration;
  }

  getIteration(id: string): Iteration | undefined {
    return this.iterations.get(id);
  }

  listIterations(projectId: string): Iteration[] {
    return [...this.iterations.values()].filter(i => i.projectId === projectId);
  }

  getActiveIteration(projectId: string): Iteration | undefined {
    return [...this.iterations.values()].find(
      i => i.projectId === projectId && i.status === 'active'
    );
  }

  updateIterationStatus(id: string, status: IterationStatus): Iteration {
    const iter = this.iterations.get(id);
    if (!iter) throw new Error(`Iteration not found: ${id}`);
    iter.status = status;
    iter.updatedAt = new Date().toISOString();
    this.iterationRepo?.updateStatus(id, status)
      .catch(err => log.warn('Failed to persist iteration status', { error: String(err) }));
    log.info('Iteration status updated', { id, status });
    return iter;
  }

  updateIteration(
    id: string,
    updates: Partial<Omit<Iteration, 'id' | 'projectId' | 'createdAt'>>
  ): Iteration {
    const iter = this.iterations.get(id);
    if (!iter) throw new Error(`Iteration not found: ${id}`);
    Object.assign(iter, updates, { updatedAt: new Date().toISOString() });
    this.iterationRepo?.update(id, updates as Record<string, unknown>)
      .catch(err => log.warn('Failed to persist iteration update', { error: String(err) }));
    return iter;
  }

  // ─── Team-Project Associations ─────────────────────────────────────────────

  getProjectsForTeam(teamId: string): Project[] {
    return [...this.projects.values()].filter(p => p.teamIds.includes(teamId));
  }

  getTeamsForProject(projectId: string): string[] {
    return this.projects.get(projectId)?.teamIds ?? [];
  }

  addTeamToProject(projectId: string, teamId: string): void {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (!project.teamIds.includes(teamId)) {
      project.teamIds.push(teamId);
      project.updatedAt = new Date().toISOString();
    }
  }

  removeTeamFromProject(projectId: string, teamId: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    project.teamIds = project.teamIds.filter(t => t !== teamId);
    project.updatedAt = new Date().toISOString();
  }

  // ─── Agent Onboarding ──────────────────────────────────────────────────────

  async onboardAgent(agentId: string, projectId: string): Promise<string> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const parts: string[] = [
      `# Project Onboarding: ${project.name}`,
      '',
      `**Description:** ${project.description}`,
      `**Iteration Model:** ${project.iterationModel}`,
      `**Status:** ${project.status}`,
    ];

    if (project.repositories.length > 0) {
      parts.push('', '## Repositories');
      for (const repo of project.repositories) {
        parts.push(`- ${repo.role}: ${repo.localPath} (branch: ${repo.defaultBranch})`);
      }
    }

    const activeIter = this.getActiveIteration(projectId);
    if (activeIter) {
      parts.push('', '## Current Iteration');
      parts.push(`- **${activeIter.name}** (${activeIter.status})`);
      if (activeIter.goal) parts.push(`- Goal: ${activeIter.goal}`);
      if (activeIter.endDate) parts.push(`- Ends: ${activeIter.endDate}`);
    }

    if (project.governancePolicy?.enabled) {
      parts.push('', '## Governance Policy');
      parts.push(`- Default approval tier: ${project.governancePolicy.defaultTier}`);
      parts.push(
        `- Max pending tasks per agent: ${project.governancePolicy.maxPendingTasksPerAgent}`
      );
    }

    const onboardingDoc = parts.join('\n');
    log.info('Agent onboarded to project', { agentId, projectId });
    return onboardingDoc;
  }

  // ─── Periodic Review ───────────────────────────────────────────────────────

  checkOverdueIterations(): Iteration[] {
    const now = new Date();
    const overdue: Iteration[] = [];
    for (const iter of this.iterations.values()) {
      if (iter.status === 'active' && iter.endDate) {
        const end = new Date(iter.endDate);
        if (now > end) {
          overdue.push(iter);
        }
      }
    }
    return overdue;
  }
}
