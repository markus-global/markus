import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeliverableService } from '../src/deliverable-service.js';

function createMockRepo() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    create: vi.fn(async (data: Record<string, unknown>) => { rows.set(data.id as string, { ...data }); }),
    update: vi.fn(async (id: string, data: Record<string, unknown>) => {
      const existing = rows.get(id);
      if (existing) rows.set(id, { ...existing, ...data });
    }),
    listAll: vi.fn(async () => [...rows.values()]),
    recordAccess: vi.fn().mockResolvedValue(undefined),
    listTaskIdsWithDeliverables: vi.fn(async () => new Set<string>()),
    _rows: rows,
  };
}

describe('DeliverableService', () => {
  let service: DeliverableService;
  let repo: ReturnType<typeof createMockRepo>;
  let wsBroadcast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    repo = createMockRepo();
    wsBroadcast = vi.fn();
    service = new DeliverableService(repo as never);
    service.setWSBroadcaster({ broadcastDeliverableUpdate: wsBroadcast } as never);
  });

  describe('CRUD', () => {
    it('creates a deliverable', async () => {
      const d = await service.create({
        type: 'file',
        title: 'Report',
        summary: 'Monthly report',
        reference: '/tmp/report.pdf',
        projectId: 'proj-1',
        agentId: 'agent-1',
      });
      expect(d.id).toMatch(/^dlv_/);
      expect(d.status).toBe('active');
      expect(repo.create).toHaveBeenCalled();
      expect(wsBroadcast).toHaveBeenCalledWith(d.id, 'created', expect.any(Object));
    });

    it('gets deliverable and increments access count', async () => {
      const created = await service.create({
        type: 'file',
        title: 'Doc',
        summary: 'doc',
        reference: 'ref-1',
      });
      const fetched = service.get(created.id);
      expect(fetched?.accessCount).toBe(1);
      expect(repo.recordAccess).toHaveBeenCalledWith(created.id);
    });

    it('updates deliverable fields', async () => {
      const created = await service.create({
        type: 'file',
        title: 'Old',
        summary: 'old',
        reference: 'ref-2',
      });
      const updated = await service.update(created.id, { title: 'New', summary: 'new summary' });
      expect(updated?.title).toBe('New');
      expect(repo.update).toHaveBeenCalled();
    });

    it('skips no-op updates', async () => {
      const created = await service.create({
        type: 'file',
        title: 'Same',
        summary: 'same',
        reference: 'ref-3',
      });
      const updated = await service.update(created.id, { title: 'Same' });
      expect(updated?.title).toBe('Same');
    });

    it('flags outdated and removes', async () => {
      const created = await service.create({
        type: 'file',
        title: 'Remove me',
        summary: 'x',
        reference: 'ref-4',
      });
      await service.remove(created.id);
      expect(service.get(created.id)?.status).toBe('outdated');
      expect(service.search({}).results).toHaveLength(0);
    });
  });

  describe('search and find', () => {
    it('searches by project and query', async () => {
      await service.create({ type: 'file', title: 'Alpha doc', summary: 'alpha', reference: 'a', projectId: 'p1' });
      await service.create({ type: 'file', title: 'Beta doc', summary: 'beta', reference: 'b', projectId: 'p2' });

      const byProject = service.search({ projectId: 'p1' });
      expect(byProject.total).toBe(1);

      const byQuery = service.search({ query: 'alpha' });
      expect(byQuery.total).toBe(1);
      expect(service.findByProject('p1')).toHaveLength(1);
    });
  });

  describe('dedup logic', () => {
    it('upserts when same reference and project exist', async () => {
      const first = await service.create({
        type: 'file',
        title: 'V1',
        summary: 'v1',
        reference: 'shared-ref',
        projectId: 'proj-1',
      });
      const second = await service.create({
        type: 'file',
        title: 'V2',
        summary: 'v2',
        reference: 'shared-ref',
        projectId: 'proj-1',
      });
      expect(second.id).toBe(first.id);
      expect(second.title).toBe('V2');
      expect(service.getAll()).toHaveLength(1);
    });

    it('deduplicates by reference keeping newest', async () => {
      const now = new Date().toISOString();
      repo._rows.set('dlv-old', {
        id: 'dlv-old',
        type: 'file',
        title: 'Old',
        summary: 'old',
        reference: 'dup-ref',
        tags: '[]',
        status: 'active',
        projectId: 'proj-1',
        accessCount: 0,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      });
      repo._rows.set('dlv-new', {
        id: 'dlv-new',
        type: 'file',
        title: 'New',
        summary: 'new',
        reference: 'dup-ref',
        tags: '[]',
        status: 'active',
        projectId: 'proj-1',
        accessCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      await service.load();

      const cleaned = await service.deduplicateByReference();
      expect(cleaned).toBe(1);
      const active = service.getAll().filter(d => d.reference === 'dup-ref');
      expect(active).toHaveLength(1);
      expect(active[0]?.title).toBe('New');
    });
  });

  describe('load and migrate', () => {
    it('loads from repo into cache', async () => {
      repo._rows.set('dlv-db', {
        id: 'dlv-db',
        type: 'file',
        title: 'Loaded',
        summary: 'from db',
        reference: 'r',
        tags: '[]',
        status: 'active',
        taskId: null,
        agentId: null,
        projectId: 'p1',
        requirementId: null,
        accessCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await service.load();
      expect(service.get('dlv-db')?.title).toBe('Loaded');
    });

    it('migrates deliverables from tasks', async () => {
      const count = await service.migrateFromTasks([{
        id: 'task-1',
        projectId: 'proj-1',
        assignedAgentId: 'agent-1',
        deliverables: [{ type: 'file', reference: '/out.txt', summary: 'output' }],
      } as never]);
      expect(count).toBe(1);
      expect(service.findByTask('task-1')).toHaveLength(1);
    });

    it('finds deliverables by agent and checks file health', async () => {
      const created = await service.create({
        type: 'file',
        title: 'Missing file',
        summary: 'gone',
        reference: '/tmp/does-not-exist.txt',
        agentId: 'agent-1',
      });
      expect(service.findByAgent('agent-1').some(d => d.id === created.id)).toBe(true);
      expect(service.checkFileHealth('agent-1')).toContain(created.id);
    });

    it('skips re-migrating tasks that already have deliverables', async () => {
      repo.listTaskIdsWithDeliverables.mockResolvedValue(new Set(['task-1']));
      const count = await service.migrateFromTasks([{
        id: 'task-1',
        deliverables: [{ type: 'file', reference: '/out.txt', summary: 'output' }],
      } as never]);
      expect(count).toBe(0);
    });
  });
});
