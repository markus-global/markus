import { describe, it, expect, vi } from 'vitest';
import { RequirementService } from '../src/requirement-service.js';

function mockRepo() {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    clearRejectionMetadata: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    listByOrg: vi.fn().mockResolvedValue([]),
  };
}

function freshService() {
  const repo = mockRepo();
  const svc = new RequirementService();
  svc.setRequirementRepo(repo);
  svc.setStatusTransitionRepo({ record: vi.fn(), getByEntity: vi.fn(() => []) });
  svc.setWSBroadcaster({ broadcast: vi.fn() } as never);
  return { svc, repo };
}

function req(overrides: Record<string, unknown> = {}) {
  return { orgId: 'org-1', title: 'Feature', description: 'Do it', projectId: 'proj-1', source: 'agent' as const, createdBy: 'agent-1', ...overrides };
}

describe('requirement FSM enforcement + blocked reason (cut 4)', () => {
  it('blocks a requirement with a reason and persists it', () => {
    const { svc, repo } = freshService();
    const r = svc.createRequirement(req());
    expect(r.status).toBe('pending');

    svc.updateRequirementStatus(r.id, 'blocked', 'user-1', 'human', 'workflow');

    expect(svc.getRequirement(r.id)!.status).toBe('blocked');
    expect(svc.getRequirement(r.id)!.blockedReason).toBe('workflow');
    expect(repo.updateStatus).toHaveBeenCalledWith(r.id, 'blocked', 'workflow');
  });

  it('defaults a blocked reason to hold when none is given', () => {
    const { svc } = freshService();
    const r = svc.createRequirement(req());
    svc.updateRequirementStatus(r.id, 'blocked');
    expect(svc.getRequirement(r.id)!.blockedReason).toBe('hold');
  });

  it('rejects an illegal transition instead of applying it', () => {
    const { svc } = freshService();
    const r = svc.createRequirement(req({ source: 'user' })); // user → in_progress
    svc.updateRequirementStatus(r.id, 'completed');            // in_progress → completed: legal
    expect(() => svc.updateRequirementStatus(r.id, 'blocked'))
      .toThrow(/Illegal requirement state transition/);
    expect(svc.getRequirement(r.id)!.status).toBe('completed');
  });
});
