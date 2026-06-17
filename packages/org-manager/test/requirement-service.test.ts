import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequirementService } from '../src/requirement-service.js';

function createMockRepo() {
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

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    orgId: 'org-1',
    title: 'Build feature',
    description: 'Implement the feature',
    projectId: 'proj-1',
    source: 'user' as const,
    createdBy: 'user-1',
    ...overrides,
  };
}

describe('RequirementService', () => {
  let service: RequirementService;
  let repo: ReturnType<typeof createMockRepo>;
  let wsBroadcast: ReturnType<typeof vi.fn>;
  let statusTransitionRepo: { record: ReturnType<typeof vi.fn>; getByEntity: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    repo = createMockRepo();
    wsBroadcast = vi.fn();
    statusTransitionRepo = {
      record: vi.fn(),
      getByEntity: vi.fn(() => []),
    };
    service = new RequirementService();
    service.setRequirementRepo(repo);
    service.setStatusTransitionRepo(statusTransitionRepo);
    service.setWSBroadcaster({ broadcast: wsBroadcast } as never);
    service.setUserNameLookup((id) => (id === 'user-1' ? 'Alice' : null));
  });

  describe('createRequirement', () => {
    it('creates auto-approved user requirement', () => {
      const req = service.createRequirement(baseRequest());
      expect(req.status).toBe('in_progress');
      expect(req.approvedBy).toBe('user-1');
      expect(repo.create).toHaveBeenCalled();
      expect(wsBroadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'requirement:created' }));
    });

    it('creates pending agent requirement', () => {
      const req = service.createRequirement(baseRequest({ source: 'agent', createdBy: 'agent-1' }));
      expect(req.status).toBe('pending');
      expect(req.approvedBy).toBeUndefined();
    });

    it('validates required fields', () => {
      expect(() => service.createRequirement(baseRequest({ title: '  ' }))).toThrow(/title is required/);
      expect(() => service.createRequirement(baseRequest({ description: '' }))).toThrow(/description is required/);
      expect(() => service.createRequirement(baseRequest({ projectId: undefined }))).toThrow(/projectId is required/);
      expect(() => service.createRequirement(baseRequest({ priority: 'invalid' as never }))).toThrow(/Invalid priority/);
    });
  });

  describe('proposeRequirement', () => {
    it('limits pending proposals per agent', () => {
      for (let i = 0; i < 3; i++) {
        service.proposeRequirement(baseRequest({ source: 'agent', createdBy: 'agent-1', title: `Req ${i}` }));
      }
      expect(() => service.proposeRequirement(baseRequest({ source: 'agent', createdBy: 'agent-1', title: 'One more' })))
        .toThrow(/already has 3 pending/);
    });
  });

  describe('approve and reject', () => {
    it('approves pending agent requirement', () => {
      const req = service.createRequirement(baseRequest({ source: 'agent', createdBy: 'agent-1' }));
      const approved = service.approveRequirement(req.id, 'user-1');
      expect(approved.status).toBe('in_progress');
      expect(approved.approvedBy).toBe('user-1');
      expect(repo.approve).toHaveBeenCalledWith(req.id, 'user-1');
      expect(statusTransitionRepo.record).toHaveBeenCalledWith(expect.objectContaining({
        entityId: req.id,
        fromStatus: 'pending',
        toStatus: 'in_progress',
      }));
    });

    it('rejects pending agent requirement', () => {
      const req = service.createRequirement(baseRequest({ source: 'agent', createdBy: 'agent-1' }));
      const rejected = service.rejectRequirement(req.id, 'user-1', 'Not needed');
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectedReason).toBe('Not needed');
      expect(repo.reject).toHaveBeenCalledWith(req.id, 'Not needed', 'user-1');
    });

    it('throws when approving non-pending requirement', () => {
      const req = service.createRequirement(baseRequest());
      expect(() => service.approveRequirement(req.id, 'user-1')).toThrow(/cannot be approved/);
    });
  });

  describe('resubmitRequirement', () => {
    it('resubmits rejected requirement to pending', () => {
      const req = service.createRequirement(baseRequest({ source: 'agent', createdBy: 'agent-1' }));
      service.rejectRequirement(req.id, 'user-1', 'Too vague');
      const resubmitted = service.resubmitRequirement(req.id, { title: 'Better title' });
      expect(resubmitted.status).toBe('pending');
      expect(resubmitted.title).toBe('Better title');
      expect(resubmitted.rejectedReason).toBeUndefined();
      expect(repo.updateStatus).toHaveBeenCalledWith(req.id, 'pending');
    });

    it('throws when resubmitting non-rejected requirement', () => {
      const req = service.createRequirement(baseRequest());
      expect(() => service.resubmitRequirement(req.id)).toThrow(/only rejected requirements/);
    });
  });

  describe('updateRequirementStatus', () => {
    it('transitions status and records history', () => {
      const req = service.createRequirement(baseRequest({ source: 'agent', createdBy: 'agent-1' }));
      const updated = service.updateRequirementStatus(req.id, 'blocked', 'user-1', 'human');
      expect(updated.status).toBe('blocked');
      expect(statusTransitionRepo.record).toHaveBeenCalled();
    });

    it('rejects invalid status', () => {
      const req = service.createRequirement(baseRequest());
      expect(() => service.updateRequirementStatus(req.id, 'invalid' as never)).toThrow(/Invalid requirement status/);
    });

    it('is no-op when status unchanged', () => {
      const req = service.createRequirement(baseRequest());
      const result = service.updateRequirementStatus(req.id, 'in_progress');
      expect(result.status).toBe('in_progress');
    });
  });

  describe('CRUD helpers', () => {
    it('updates, links tasks, lists, and deletes', () => {
      const req = service.createRequirement(baseRequest());
      service.updateRequirement(req.id, { priority: 'high' });
      expect(service.getRequirement(req.id)?.priority).toBe('high');

      service.linkTask(req.id, 'task-1');
      expect(service.getRequirement(req.id)?.taskIds).toContain('task-1');
      service.unlinkTask(req.id, 'task-1');
      expect(service.getRequirement(req.id)?.taskIds).not.toContain('task-1');

      expect(service.isApproved(req.id)).toBe(true);
      expect(service.listRequirements({ orgId: 'org-1' })).toHaveLength(1);

      service.deleteRequirement(req.id);
      expect(service.getRequirement(req.id)).toBeUndefined();
    });

    it('cancels requirement', () => {
      const req = service.createRequirement(baseRequest());
      const cancelled = service.cancelRequirement(req.id, 'user-1', 'human');
      expect(cancelled.status).toBe('cancelled');
    });
  });

  describe('checkCompletion', () => {
    it('returns true when all tasks are terminal', () => {
      const agentManager = {
        hasAgent: vi.fn(() => true),
        getAgent: vi.fn(() => ({ enqueueToMailbox: vi.fn() })),
      };
      service.setAgentManager(agentManager as never);

      const req = service.createRequirement(baseRequest({ source: 'agent', createdBy: 'agent-1' }));
      service.linkTask(req.id, 'task-1');
      service.linkTask(req.id, 'task-2');

      const statuses = new Map([['task-1', 'completed'], ['task-2', 'cancelled']]);
      expect(service.checkCompletion(req.id, statuses)).toBe(true);
    });
  });

  describe('loadFromStorage', () => {
    it('loads requirements from repo', async () => {
      repo.listByOrg.mockResolvedValue([{
        id: 'req-db',
        orgId: 'org-1',
        projectId: 'proj-1',
        title: 'Loaded',
        description: 'From DB',
        status: 'in_progress',
        priority: 'medium',
        source: 'user',
        createdBy: 'user-1',
        tags: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }]);
      await service.loadFromStorage('org-1');
      expect(service.getRequirement('req-db')?.title).toBe('Loaded');
    });
  });

  describe('rebuildTaskLinks', () => {
    it('rebuilds task linkage from loaded tasks', () => {
      const req = service.createRequirement(baseRequest());
      service.rebuildTaskLinks([
        { id: 'task-a', requirementId: req.id },
        { id: 'task-b', requirementId: req.id },
        { id: 'task-c', requirementId: 'other' },
      ]);
      expect(service.getRequirement(req.id)?.taskIds).toEqual(['task-a', 'task-b']);
    });
  });

  describe('listRequirements filters', () => {
    it('filters by org, project, status, source, and creator', () => {
      service.createRequirement(baseRequest({ projectId: 'proj-1', source: 'user', createdBy: 'user-1' }));
      service.createRequirement(baseRequest({
        title: 'Agent req',
        source: 'agent',
        createdBy: 'agent-1',
        projectId: 'proj-2',
      }));

      expect(service.listRequirements({ orgId: 'org-1' })).toHaveLength(2);
      expect(service.listRequirements({ source: 'agent' })).toHaveLength(1);
      expect(service.listRequirements({ createdBy: 'agent-1' })).toHaveLength(1);
      expect(service.listRequirements({ projectId: 'proj-2' })).toHaveLength(1);
    });
  });

  describe('agent notifications', () => {
    it('notifies proposing agent on approval and rejection', () => {
      const enqueue = vi.fn();
      const agentManager = {
        hasAgent: vi.fn(() => true),
        getAgent: vi.fn(() => ({ enqueueToMailbox: enqueue })),
      };
      const hitlService = {
        listApprovals: vi.fn(() => []),
        respondToApproval: vi.fn(),
        notify: vi.fn(),
        requestApprovalAndWait: vi.fn().mockResolvedValue({ approved: true, respondedBy: 'user-1' }),
      };
      service.setAgentManager(agentManager as never);
      service.setHITLService(hitlService as never);

      const req = service.createRequirement(baseRequest({ source: 'agent', createdBy: 'agent-1' }));
      service.approveRequirement(req.id, 'user-1');
      expect(enqueue).toHaveBeenCalledWith(
        'requirement_update',
        expect.objectContaining({ requirementId: req.id }),
        expect.any(Object),
      );
      expect(hitlService.notify).toHaveBeenCalled();

      enqueue.mockClear();
      const rejected = service.createRequirement(baseRequest({
        source: 'agent',
        createdBy: 'agent-1',
        title: 'Second proposal',
      }));
      service.rejectRequirement(rejected.id, 'user-1', 'Too vague');
      expect(enqueue).toHaveBeenCalled();
    });

    it('notifies agent when all tasks complete', () => {
      const enqueue = vi.fn();
      service.setAgentManager({
        hasAgent: vi.fn(() => true),
        getAgent: vi.fn(() => ({ enqueueToMailbox: enqueue })),
      } as never);

      const req = service.createRequirement(baseRequest({ source: 'agent', createdBy: 'agent-1' }));
      service.linkTask(req.id, 'task-1');
      const statuses = new Map([['task-1', 'completed']]);
      expect(service.checkCompletion(req.id, statuses)).toBe(true);
      expect(enqueue).toHaveBeenCalledWith(
        'requirement_update',
        expect.objectContaining({ summary: expect.stringContaining('review needed') }),
        expect.any(Object),
      );
    });
  });

  describe('deleteRequirement', () => {
    it('cancels pending HITL approvals on delete', () => {
      const hitlService = {
        cancelApprovalsByDetail: vi.fn(),
        requestApprovalAndWait: vi.fn().mockResolvedValue({ approved: false, respondedBy: 'user-1' }),
      };
      service.setHITLService(hitlService as never);
      const req = service.createRequirement(baseRequest({ source: 'agent', createdBy: 'agent-1' }));
      service.deleteRequirement(req.id);
      expect(hitlService.cancelApprovalsByDetail).toHaveBeenCalledWith(
        'requirementId', req.id, 'system', 'Requirement deleted',
      );
      expect(service.getRequirement(req.id)).toBeUndefined();
    });
  });

  describe('updateRequirementStatus side effects', () => {
    it('notifies creator agent on status change', () => {
      const enqueue = vi.fn();
      service.setAgentManager({
        getAgent: vi.fn(() => ({ enqueueToMailbox: enqueue })),
      } as never);

      const req = service.createRequirement(baseRequest({ source: 'agent', createdBy: 'agent-1' }));
      service.updateRequirementStatus(req.id, 'blocked', 'user-1', 'human');
      expect(enqueue).toHaveBeenCalled();
    });
  });
});
