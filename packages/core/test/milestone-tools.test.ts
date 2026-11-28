/**
 * Milestone agent tools — behaviour tests for the layer that had none.
 *
 * Bite: `milestone_assign` must report a PARTIAL result when one id fails. A tool that returns
 * `status: 'success'` while half the requirements were never attached is the failure mode these
 * assertions exist for (an agent would then believe the phase contains work it does not).
 */
import { describe, it, expect, vi } from 'vitest';
import { createProjectTools, type ProjectToolsContext } from '../src/tools/project-tools.js';

function makeCtx() {
  const milestoneService = {
    list: vi.fn(() => [{
      id: 'ms_1', projectId: 'proj_001', name: 'Phase 1', description: '', dueDate: '2026-12-31',
      progress: { total: 2, done: 1, active: 1, blocked: 0, percent: 50 },
    }]),
    get: vi.fn(() => undefined),
    create: vi.fn((o: { name: string }) => ({ id: 'ms_new', name: o.name })),
    update: vi.fn(() => ({ id: 'ms_1', name: 'Phase 1b' })),
    delete: vi.fn(() => ({ deleted: true, detachedRequirements: 3 })),
    assignRequirements: vi.fn(() => ({
      updated: ['req_1'],
      failed: [{ id: 'req_2', error: 'Milestone belongs to project proj_b' }],
    })),
  };
  const ctx = { agentId: 'agt_test', orgId: 'org_default', milestoneService } as unknown as ProjectToolsContext;
  return { ctx, milestoneService };
}

const tool = (ctx: ProjectToolsContext, name: string) => {
  const found = createProjectTools(ctx).find(t => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
};

describe('milestone tools', () => {
  it('milestone_list hands the derived progress through unchanged', async () => {
    const { ctx } = makeCtx();
    const out = JSON.parse(await tool(ctx, 'milestone_list').execute({ project_id: 'proj_001' })) as {
      status: string; milestones: Array<{ progress: Record<string, number> }>;
    };
    expect(out.status).toBe('success');
    expect(out.milestones[0]!.progress).toEqual({ total: 2, done: 1, active: 1, blocked: 0, percent: 50 });
  });

  it('milestone_create forwards org + acting agent (so the audit fact names someone)', async () => {
    const { ctx, milestoneService } = makeCtx();
    const out = JSON.parse(await tool(ctx, 'milestone_create').execute({ project_id: 'proj_001', name: 'Phase 2' }));
    expect(out.status).toBe('success');
    expect(milestoneService.create).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org_default', createdBy: 'agt_test', projectId: 'proj_001',
    }));
  });

  it('milestone_assign reports PARTIAL when an id fails — never a bare success', async () => {
    const { ctx } = makeCtx();
    const out = JSON.parse(await tool(ctx, 'milestone_assign').execute({
      milestone_id: 'ms_1', requirement_ids: ['req_1', 'req_2'],
    })) as { status: string; updated: string[]; failed: Array<{ id: string; error: string }> };
    expect(out.status).toBe('partial');
    expect(out.updated).toEqual(['req_1']);
    expect(out.failed[0]!.id).toBe('req_2');
  });

  it('milestone_assign with detach unbinds (null milestone), it does not attach', async () => {
    const { ctx, milestoneService } = makeCtx();
    await tool(ctx, 'milestone_assign').execute({ milestone_id: 'ms_1', requirement_ids: ['req_1'], detach: true });
    expect(milestoneService.assignRequirements).toHaveBeenCalledWith(['req_1'], null);
  });

  it('milestone_delete returns the unlink count the human will ask about', async () => {
    const { ctx } = makeCtx();
    const out = JSON.parse(await tool(ctx, 'milestone_delete').execute({ milestone_id: 'ms_1' }));
    expect(out).toMatchObject({ status: 'success', detachedRequirements: 3 });
  });

  it('clearing the deadline passes real `null` to the service, not the string "null"', async () => {
    const { ctx, milestoneService } = makeCtx();
    // Live test 2026-11-28: the arg arrived JSON-encoded as the STRING "null", so the service
    // rejected it as an invalid date and a deadline could never be cleared through the tool.
    for (const raw of [null, 'null', '  ', '']) {
      await tool(ctx, 'milestone_update').execute({ milestone_id: 'ms_1', due_date: raw });
    }
    for (const call of milestoneService.update.mock.calls) {
      expect(call[1].dueDate).toBeNull();
    }
    expect(milestoneService.update).toHaveBeenCalledTimes(4);
  });

  it('omitting due_date leaves the deadline untouched (undefined, not null)', async () => {
    const { ctx, milestoneService } = makeCtx();
    await tool(ctx, 'milestone_update').execute({ milestone_id: 'ms_1', name: 'renamed' });
    expect(milestoneService.update.mock.calls[0]![1].dueDate).toBeUndefined();
  });

  it('a service rejection surfaces as status:error, not a thrown tool', async () => {    const { ctx, milestoneService } = makeCtx();
    milestoneService.update = vi.fn(() => { throw new Error('Invalid milestone due date "2026-02-31"'); });
    const out = JSON.parse(await tool(ctx, 'milestone_update').execute({ milestone_id: 'ms_1', due_date: '2026-02-31' }));
    expect(out.status).toBe('error');
    expect(String(out.error)).toMatch(/Invalid milestone due date/);
  });
});
