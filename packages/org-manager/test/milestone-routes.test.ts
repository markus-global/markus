/**
 * Milestone HTTP routes — the regression test for "route registered, dispatch missing".
 *
 * Owner report 2026-11-28: creating a milestone in the Work page showed the literal text
 * `not found`. Root cause: the five handlers were never added to the dispatch if-chain (only the
 * route TABLE entry landed), so every request fell through to the generic 404 `{error:'Not found'}`.
 *
 * The bite is the DISTINCTION between the two 404s: a real `:id` handler answers
 * `Milestone not found`, while the fallback answers `Not found`. A test that only checked
 * "404 for unknown id" would pass in both worlds — this one cannot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { APIServer } from '../src/api-server.js';
import { MilestoneService } from '../src/milestone-service.js';
import { RequirementService } from '../src/requirement-service.js';
import { request, createTestServer } from './api-server-test-helpers.js';

// The milestone routes sit behind the global auth gate. `AUTH_ENABLED=false` is the product's own
// local single-user mode (the gate then hands out an owner identity), so the test exercises the
// real handlers instead of re-implementing the auth stack.
beforeEach(() => { process.env['AUTH_ENABLED'] = 'false'; });
afterEach(() => { delete process.env['AUTH_ENABLED']; });

function makeServer() {
  // Use the shared full-server fixture: APIServer's constructor touches the agent manager, so a
  // hand-rolled stub is a latent 500 (that is exactly what a partial mock did here first).
  const { server } = createTestServer();
  const ms = new MilestoneService();
  ms.setProjectService({ getProject: (id: string) => ({ id }) });
  ms.setRequirementBridge({ listByMilestone: () => [], detachMilestone: () => 2 });
  server.setMilestoneService(ms);
  const milestone = ms.createMilestone({ orgId: 'default', projectId: 'proj_a', name: 'Phase 1', dueDate: '2026-12-31' });

  // Requirement side: real service so the cross-project invariant is the REAL one, not a stub.
  const rs = new RequirementService();
  rs.setProjectService({ getProject: (id: string) => (['proj_a', 'proj_b'].includes(id) ? { id } : undefined) });
  rs.setMilestoneLookup((id: string) => {
    const m = ms.getMilestone(id);
    return m ? { id: m.id, projectId: m.projectId, name: m.name } : null;
  });
  ms.setRequirementBridge(rs);
  server.setRequirementService(rs);
  return { server, ms, milestone, rs };
}

describe('GET /api/milestones', () => {
  it('lists the project milestones with DERIVED progress', async () => {
    const { server } = makeServer();
    const res = await request(server, 'GET', '/api/milestones?projectId=proj_a');
    expect(res.status).toBe(200);
    const list = res.json['milestones'] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]!['name']).toBe('Phase 1');
    expect(list[0]!['progress']).toEqual({ total: 0, done: 0, active: 0, blocked: 0, percent: 0 });
  });

  it('filters by project so another project does not leak in', async () => {
    const { server } = makeServer();
    const res = await request(server, 'GET', '/api/milestones?projectId=proj_other');
    expect((res.json['milestones'] as unknown[])).toHaveLength(0);
  });
});

describe('GET /api/milestones/:id', () => {
  it('returns the milestone with progress', async () => {
    const { server, milestone } = makeServer();
    const res = await request(server, 'GET', `/api/milestones/${milestone.id}`);
    expect(res.status).toBe(200);
    expect((res.json['milestone'] as Record<string, unknown>)['id']).toBe(milestone.id);
  });

  it('answers with its OWN 404 message — the generic `Not found` means the route is missing', async () => {
    const { server } = makeServer();
    const res = await request(server, 'GET', '/api/milestones/ms_ghost');
    expect(res.status).toBe(404);
    expect(res.json['error']).toBe('Milestone not found');
    expect(res.json['error']).not.toBe('Not found');
  });
});

describe('DELETE /api/milestones/:id', () => {
  it('reports how many requirements were unlinked and removes the milestone', async () => {
    const { server, ms, milestone, rs } = makeServer();
    for (const t of ['R1', 'R2']) {
      rs.createRequirement({
        orgId: 'default', title: t, description: 'd', projectId: 'proj_a',
        milestoneId: milestone.id, source: 'user', createdBy: 'usr_owner',
      });
    }
    const res = await request(server, 'DELETE', `/api/milestones/${milestone.id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ deleted: true, detachedRequirements: 2 });
    expect(ms.getMilestone(milestone.id)).toBeUndefined();
  });
});

describe('requirement ↔ milestone over HTTP', () => {
  it('rejects a cross-project bind as 400 (a client error), not 404', async () => {
    const { server, rs, milestone } = makeServer();
    const req = rs.createRequirement({
      orgId: 'default', title: 'R', description: 'd', projectId: 'proj_a',
      milestoneId: milestone.id, source: 'user', createdBy: 'usr_owner',
    });

    const res = await request(server, 'PUT', `/api/requirements/${req.id}`, { projectId: 'proj_b' });

    // Live test 2026-11-28: this used to answer 404 with 'Error: <message>' — an invariant
    // rejection read as "that requirement does not exist".
    expect(res.status).toBe(400);
    expect(String(res.json['error'])).toMatch(/belongs to project proj_a/);
    expect(String(res.json['error']).startsWith('Error: ')).toBe(false);
  });

  it('still answers 404 for a requirement that really does not exist', async () => {
    const { server } = makeServer();
    const res = await request(server, 'PUT', '/api/requirements/req_ghost', { title: 'x' });
    expect(res.status).toBe(404);
    expect(String(res.json['error'])).toMatch(/not found/i);
  });
});

describe('PUT /api/milestones/:id', () => {
  it('clears the deadline on an explicit null', async () => {
    const { server, milestone } = makeServer();
    const res = await request(server, 'PUT', `/api/milestones/${milestone.id}`, { dueDate: null });
    expect(res.status).toBe(200);
    expect((res.json['milestone'] as Record<string, unknown>)['dueDate']).toBeNull();
  });

  it('rejects an impossible date with the service message, not the fallback 404', async () => {
    const { server, milestone } = makeServer();
    const res = await request(server, 'PUT', `/api/milestones/${milestone.id}`, { dueDate: '2026-02-31' });
    expect(res.status).toBe(400);
    expect(String(res.json['error'])).toMatch(/Invalid milestone due date/);
  });
});
