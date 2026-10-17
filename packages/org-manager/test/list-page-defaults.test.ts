import { describe, it, expect, beforeAll } from 'vitest';
import type { TaskService } from '../src/task-service.js';
import { createTestServer, request, type TestContext } from './api-server-test-helpers.js';

/**
 * First paint must carry a small page. These specs pin the *defaults* — the
 * values a caller gets when it does not pass pageSize/limit. They were 20–200
 * (deliverables: 100) and are now 10–50 so a cold load is cheap over a remote
 * tunnel. Raising them back is a deliberate act, not an accident.
 */

process.env['AUTH_ENABLED'] = 'false';

function seedTasks(ts: TaskService, count: number): void {
  const map = (ts as unknown as { tasks: Map<string, unknown> }).tasks;
  for (let i = 0; i < count; i++) {
    map.set(`task-${i}`, {
      id: `task-${i}`,
      orgId: 'default',
      projectId: 'proj-1',
      title: `task-${i}`,
      status: 'pending',
      priority: 'medium',
      updatedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    });
  }
}

function seedDeliverables(ctx: TestContext, count: number): void {
  const rows = Array.from({ length: count }).map((_, i) => ({
    id: `dlv-${i}`,
    title: `deliverable-${i}`,
    taskId: null,
    agentId: 'agent-1',
    type: 'file',
    status: 'active',
    source: 'agent',
    reference: `/tmp/${i}.md`,
    summary: '',
    createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    updatedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  }));
  ctx.server.setDeliverableService({
    search: (opts: { offset?: number; limit?: number }) => {
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? 30;
      return { results: rows.slice(offset, offset + limit), total: rows.length };
    },
  } as never);
}

describe('list page-size defaults', () => {
  let ctx: TestContext;
  beforeAll(() => { ctx = createTestServer(); });

  it('GET /api/tasks defaults to 10 rows (not the whole board)', async () => {
    seedTasks(ctx.taskService, 40);
    const res = await request(ctx.server, 'GET', '/api/tasks');
    expect(res.status).toBe(200);
    const body = res.json as { tasks: unknown[]; total: number; pageSize: number };
    expect(body.tasks.length).toBe(10);
    expect(body.total).toBe(40);
    expect(body.pageSize).toBe(10);
  });

  it('GET /api/tasks honours an explicit pageSize', async () => {
    const res = await request(ctx.server, 'GET', '/api/tasks?pageSize=25');
    const body = res.json as { tasks: unknown[]; pageSize: number };
    expect(body.tasks.length).toBe(25);
    expect(body.pageSize).toBe(25);
  });

  it('GET /api/deliverables defaults to 30 rows', async () => {
    seedDeliverables(ctx, 80);
    const res = await request(ctx.server, 'GET', '/api/deliverables');
    expect(res.status).toBe(200);
    const body = res.json as { results: unknown[]; total: number };
    expect(body.results.length).toBe(30);
    expect(body.total).toBe(80);
  });
});
