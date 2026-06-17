import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProjectService } from '../src/project-service.js';

function createMockProjectRepo() {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    listByOrg: vi.fn(() => []),
    listAll: vi.fn(() => []),
  };
}

describe('ProjectService', () => {
  let service: ProjectService;
  let repo: ReturnType<typeof createMockProjectRepo>;

  beforeEach(() => {
    repo = createMockProjectRepo();
    service = new ProjectService();
    service.setProjectRepo(repo);
  });

  describe('CRUD', () => {
    it('creates a project and persists to repo', () => {
      const project = service.createProject({
        orgId: 'org-1',
        name: 'Alpha',
        description: 'First project',
        teamIds: ['team-1'],
        createdBy: 'user-1',
      });
      expect(project.name).toBe('Alpha');
      expect(project.status).toBe('active');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ id: project.id, name: 'Alpha' }));
      expect(service.getProject(project.id)).toEqual(project);
    });

    it('lists projects by org', () => {
      service.createProject({ orgId: 'org-1', name: 'A', description: 'a' });
      service.createProject({ orgId: 'org-2', name: 'B', description: 'b' });
      expect(service.listProjects('org-1')).toHaveLength(1);
      expect(service.listProjects()).toHaveLength(2);
    });

    it('updates a project', () => {
      const project = service.createProject({ orgId: 'org-1', name: 'A', description: 'a' });
      const updated = service.updateProject(project.id, { name: 'Renamed', status: 'archived' });
      expect(updated.name).toBe('Renamed');
      expect(updated.status).toBe('archived');
      expect(repo.update).toHaveBeenCalledWith(project.id, expect.objectContaining({ name: 'Renamed' }));
    });

    it('deletes a project', () => {
      const project = service.createProject({ orgId: 'org-1', name: 'A', description: 'a' });
      service.deleteProject(project.id);
      expect(service.getProject(project.id)).toBeUndefined();
      expect(repo.delete).toHaveBeenCalledWith(project.id);
    });

    it('throws when updating missing project', () => {
      expect(() => service.updateProject('missing', { name: 'X' })).toThrow(/Project not found/);
    });
  });

  describe('loadFromDB', () => {
    it('loads projects from repo', async () => {
      repo.listByOrg.mockReturnValue([{
        id: 'proj-db',
        orgId: 'org-1',
        name: 'From DB',
        description: 'desc',
        status: 'active',
        repositories: [{ role: 'primary', localPath: '/repo', defaultBranch: 'main' }],
        teamIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }]);
      await service.loadFromDB('org-1');
      expect(service.getProject('proj-db')?.name).toBe('From DB');
    });
  });

  describe('onboardAgent', () => {
    it('returns onboarding document with project details', async () => {
      const project = service.createProject({
        orgId: 'org-1',
        name: 'Web App',
        description: 'Customer portal',
        repositories: [{ role: 'frontend', localPath: '/apps/web', defaultBranch: 'main' }],
        governancePolicy: {
          enabled: true,
          defaultTier: 'manager',
          maxPendingTasksPerAgent: 5,
        },
      });

      const doc = await service.onboardAgent('agent-1', project.id);
      expect(doc).toContain('Web App');
      expect(doc).toContain('Customer portal');
      expect(doc).toContain('/apps/web');
      expect(doc).toContain('Governance Policy');
    });

    it('throws for missing project', async () => {
      await expect(service.onboardAgent('agent-1', 'missing')).rejects.toThrow(/Project not found/);
    });
  });
});
