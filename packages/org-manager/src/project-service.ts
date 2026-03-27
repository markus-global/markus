import {
  createLogger,
  generateId,
  type Project,
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

export class ProjectService {
  private projects = new Map<string, Project>();
  private projectRepo?: ProjectRepo;

  setProjectRepo(repo: ProjectRepo): void {
    this.projectRepo = repo;
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
  }

  // ─── Project CRUD ──────────────────────────────────────────────────────────

  createProject(opts: {
    orgId: string;
    name: string;
    description: string;
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
      repositories: project.repositories,
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
    this.projectRepo?.delete(id)
      .catch(err => log.warn('Failed to delete project from DB', { error: String(err) }));
    log.info('Project deleted', { id });
  }

  // ─── Agent Onboarding ──────────────────────────────────────────────────────

  async onboardAgent(agentId: string, projectId: string): Promise<string> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const parts: string[] = [
      `# Project Onboarding: ${project.name}`,
      '',
      `**Description:** ${project.description}`,
      `**Status:** ${project.status}`,
    ];

    if (project.repositories.length > 0) {
      parts.push('', '## Repositories');
      for (const repo of project.repositories) {
        parts.push(`- ${repo.role}: ${repo.localPath} (branch: ${repo.defaultBranch})`);
      }
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
}
