import { describe, it, expect, beforeEach } from 'vitest';
import type { TaskService } from '../src/task-service.js';
import { createTestServer, request, type TestContext } from './api-server-test-helpers.js';

/**
 * Covers the remote-access payload optimizations:
 *  - gzip/brotli compression of JSON responses
 *  - content-addressed ETag + 304 revalidation
 *  - lean + paginated requirements list
 *  - bounded terminal buckets / summary board
 */

const BIG_DESC = 'x'.repeat(4000);

function setRequirements(ctx: TestContext, rows: Array<Record<string, unknown>>): void {
  ctx.server.setRequirementService({
    listRequirements: () => rows,
    getRequirement: (id: string) => rows.find(r => r.id === id) ?? null,
    createRequirement: (d: Record<string, unknown>) => ({ id: 'req-new', ...d }),
    updateRequirement: (id: string, d: Record<string, unknown>) => ({ id, ...d }),
    updateRequirementStatus: (id: string, status: string) => ({ id, status }),
    approveRequirement: (id: string) => ({ id, status: 'approved' }),
    rejectRequirement: (id: string) => ({ id, status: 'rejected' }),
    cancelRequirement: (id: string) => ({ id, status: 'cancelled' }),
    getRequirementStatusHistory: () => [],
    postRequirementComment: async () => ({ comment: { id: 'rc-1' } }),
  } as never);
}

function seedTasks(ts: TaskService, specs: Array<{ id: string; status: string; updatedAt: string }>): void {
  const map = (ts as unknown as { tasks: Map<string, unknown> }).tasks;
  for (const s of specs) {
    map.set(s.id, { id: s.id, orgId: 'default', projectId: 'proj-1', title: s.id, status: s.status, updatedAt: s.updatedAt });
  }
}

describe('API response optimizations', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestServer(); });

  describe('compression', () => {
    it('gzip-encodes a large JSON body when the client accepts gzip', async () => {
      setRequirements(ctx, [{ id: 'req-1', title: 'Big', description: BIG_DESC, status: 'draft' }]);
      const res = await request(ctx.server, 'GET', '/api/requirements', undefined, { 'accept-encoding': 'gzip' });
      expect(res.status).toBe(200);
      expect(res.headers['Content-Encoding']).toBe('gzip');
      expect(res.headers['Vary']).toBe('Accept-Encoding');
    });

    it('prefers brotli when the client advertises it', async () => {
      setRequirements(ctx, [{ id: 'req-1', title: 'Big', description: BIG_DESC, status: 'draft' }]);
      const res = await request(ctx.server, 'GET', '/api/requirements', undefined, { 'accept-encoding': 'br, gzip' });
      expect(res.headers['Content-Encoding']).toBe('br');
    });

    it('does not compress when the client accepts nothing', async () => {
      setRequirements(ctx, [{ id: 'req-1', title: 'Big', description: BIG_DESC, status: 'draft' }]);
      const res = await request(ctx.server, 'GET', '/api/requirements');
      expect(res.headers['Content-Encoding']).toBeUndefined();
    });
  });

  describe('ETag / revalidation', () => {
    it('returns a stable ETag and 304 on a matching If-None-Match', async () => {
      setRequirements(ctx, [{ id: 'req-1', title: 'Stable', description: 'd', status: 'draft' }]);
      const first = await request(ctx.server, 'GET', '/api/requirements');
      expect(first.status).toBe(200);
      const etag = first.headers['ETag'];
      expect(etag).toBeTruthy();

      const second = await request(ctx.server, 'GET', '/api/requirements', undefined, { 'if-none-match': etag! });
      expect(second.status).toBe(304);
      expect(second.raw).toBe('');
      expect(second.headers['ETag']).toBe(etag);
    });

    it('returns 200 (not 304) when the ETag does not match', async () => {
      setRequirements(ctx, [{ id: 'req-1', title: 'Stable', description: 'd', status: 'draft' }]);
      const res = await request(ctx.server, 'GET', '/api/requirements', undefined, { 'if-none-match': '"deadbeef"' });
      expect(res.status).toBe(200);
    });
  });

  describe('requirements lean + pagination', () => {
    beforeEach(() => {
      setRequirements(ctx, [
        { id: 'r1', title: 'One', description: BIG_DESC, status: 'draft' },
        { id: 'r2', title: 'Two', description: BIG_DESC, status: 'draft' },
        { id: 'r3', title: 'Three', description: BIG_DESC, status: 'draft' },
      ]);
    });

    it('omits description when lean=1 and reports total', async () => {
      const res = await request(ctx.server, 'GET', '/api/requirements?lean=1');
      const rows = res.json.requirements as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(3);
      expect(rows[0]!).not.toHaveProperty('description');
      expect(res.json.total).toBe(3);
    });

    it('keeps description by default', async () => {
      const res = await request(ctx.server, 'GET', '/api/requirements');
      const rows = res.json.requirements as Array<Record<string, unknown>>;
      expect(rows[0]!).toHaveProperty('description');
    });

    it('honours limit + offset', async () => {
      const res = await request(ctx.server, 'GET', '/api/requirements?limit=1&offset=1');
      const rows = res.json.requirements as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe('r2');
      expect(res.json.total).toBe(3);
    });
  });

  describe('task board bounding', () => {
    beforeEach(() => {
      const specs: Array<{ id: string; status: string; updatedAt: string }> = [];
      for (let i = 0; i < 10; i++) specs.push({ id: `arch-${i}`, status: 'archived', updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` });
      for (let i = 0; i < 5; i++) specs.push({ id: `comp-${i}`, status: 'completed', updatedAt: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` });
      specs.push({ id: 'act-1', status: 'in_progress', updatedAt: '2026-03-01T00:00:00.000Z' });
      seedTasks(ctx.taskService, specs);
    });

    it('caps terminal buckets but keeps active buckets and true counts', () => {
      const { board, counts } = ctx.taskService.getTaskBoard('default', { terminalLimit: 3 });
      expect(board.archived).toHaveLength(3);
      expect(board.completed).toHaveLength(3);
      expect(board.in_progress).toHaveLength(1);
      expect(counts.archived).toBe(10);
      expect(counts.completed).toBe(5);
      expect(counts.in_progress).toBe(1);
    });

    it('keeps the most-recent terminal tasks', () => {
      const { board } = ctx.taskService.getTaskBoard('default', { terminalLimit: 2 });
      const ids = board.archived.map(t => t.id).sort();
      expect(ids).toEqual(['arch-8', 'arch-9']);
    });

    it('returns full buckets when terminalLimit is 0', () => {
      const { board } = ctx.taskService.getTaskBoard('default', { terminalLimit: 0 });
      expect(board.archived).toHaveLength(10);
      expect(board.completed).toHaveLength(5);
    });

    it('summary endpoint returns counts and no terminal lists', async () => {
      const res = await request(ctx.server, 'GET', '/api/taskboard/summary');
      expect(res.status).toBe(200);
      const board = res.json.board as Record<string, unknown[]>;
      const counts = res.json.counts as Record<string, number>;
      expect(board.archived).toBeUndefined();
      expect(board.completed).toBeUndefined();
      expect(board.in_progress).toHaveLength(1);
      expect(counts.archived).toBe(10);
      expect(counts.completed).toBe(5);
    });

    it('full board endpoint caps terminal buckets by default', async () => {
      const res = await request(ctx.server, 'GET', '/api/taskboard');
      expect(res.status).toBe(200);
      const board = res.json.board as Record<string, unknown[]>;
      const counts = res.json.counts as Record<string, number>;
      expect(board.archived!.length).toBeLessThanOrEqual(100);
      expect(counts.archived).toBe(10);
    });
  });
});
