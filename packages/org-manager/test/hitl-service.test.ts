import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HITLService } from '../src/hitl-service.js';

function createMockNotificationRepo() {
  const notifications: Array<Record<string, unknown>> = [];
  return {
    insert: vi.fn((n: Record<string, unknown>) => { notifications.push(n); }),
    list: vi.fn((_userId: string, opts?: { unreadOnly?: boolean; type?: string }) =>
      notifications.filter(n =>
        (!opts?.unreadOnly || !n.read) &&
        (!opts?.type || n.type === opts.type)
      ) as never[],
    ),
    count: vi.fn((_userId: string, unreadOnly?: boolean) =>
      notifications.filter(n => !unreadOnly || !n.read).length,
    ),
    markRead: vi.fn((id: string) => {
      const n = notifications.find(x => x.id === id);
      if (n) { n.read = true; return true; }
      return false;
    }),
    markAllRead: vi.fn(() => notifications.length),
    _notifications: notifications,
  };
}

function createMockApprovalRepo() {
  const approvals: Array<Record<string, unknown>> = [];
  return {
    upsert: vi.fn((a: Record<string, unknown>) => {
      const idx = approvals.findIndex(x => x.id === a.id);
      if (idx >= 0) approvals[idx] = a;
      else approvals.push(a);
    }),
    list: vi.fn(() => approvals as never[]),
    get: vi.fn((id: string) => approvals.find(a => a.id === id) as never),
  };
}

describe('HITLService', () => {
  let service: HITLService;
  let notificationRepo: ReturnType<typeof createMockNotificationRepo>;
  let approvalRepo: ReturnType<typeof createMockApprovalRepo>;

  beforeEach(() => {
    service = new HITLService();
    notificationRepo = createMockNotificationRepo();
    approvalRepo = createMockApprovalRepo();
    service.setNotificationRepo(notificationRepo);
    service.setApprovalRepo(approvalRepo);
    service.setOrgService({
      listHumanUsers: vi.fn(() => [{ id: 'user-1', name: 'Alice' }]),
    } as never);
  });

  describe('approval flow', () => {
    it('creates approval and notifies users', () => {
      const handler = vi.fn();
      service.onNotification(handler);

      const approval = service.requestApproval({
        agentId: 'agent-1',
        agentName: 'Bot',
        type: 'custom',
        title: 'Approve action',
        description: 'Please review',
        targetUserId: 'all',
      });

      expect(approval.status).toBe('pending');
      expect(approvalRepo.upsert).toHaveBeenCalled();
      expect(notificationRepo.insert).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval_request' }));
    });

    it('responds to approval and resolves waiters', async () => {
      const waitPromise = service.requestApprovalAndWait({
        agentId: 'agent-1',
        agentName: 'Bot',
        type: 'action',
        title: 'Deploy',
        description: 'Deploy to prod',
      });
      const pending = service.listApprovals('pending');
      const result = service.respondToApproval(pending[0]!.id, true, 'user-1', 'LGTM');
      expect(result?.status).toBe('approved');
      await expect(waitPromise).resolves.toEqual(expect.objectContaining({
        approved: true,
        respondedBy: 'user-1',
        comment: 'LGTM',
      }));
    });

    it('cancels approval', () => {
      const approval = service.requestApproval({
        agentId: 'agent-1',
        agentName: 'Bot',
        type: 'action',
        title: 'Cancel me',
        description: 'test',
      });
      const cancelled = service.cancelApproval(approval.id, 'user-1', 'No longer needed');
      expect(cancelled?.status).toBe('cancelled');
    });

    it('cancels approvals by detail key', () => {
      service.requestApproval({
        agentId: 'agent-1',
        agentName: 'Bot',
        type: 'custom',
        title: 'Req',
        description: 'desc',
        details: { requirementId: 'req-1' },
      });
      const count = service.cancelApprovalsByDetail('requirementId', 'req-1', 'system', 'Cancelled');
      expect(count).toBe(1);
      expect(service.listApprovals('pending')).toHaveLength(0);
    });

    it('returns undefined when responding to non-pending approval', () => {
      const approval = service.requestApproval({
        agentId: 'agent-1',
        agentName: 'Bot',
        type: 'action',
        title: 'Done',
        description: 'test',
      });
      service.respondToApproval(approval.id, true, 'user-1');
      expect(service.respondToApproval(approval.id, false, 'user-2')).toBeUndefined();
    });
  });

  describe('notifications', () => {
    it('creates and lists notifications', () => {
      service.notify({
        targetUserId: 'user-1',
        type: 'system',
        title: 'Hello',
        body: 'World',
        priority: 'high',
      });
      const listed = service.listNotifications('user-1');
      expect(listed).toHaveLength(1);
      expect(listed[0]?.title).toBe('Hello');
    });

    it('counts and marks notifications read', () => {
      service.notify({ targetUserId: 'user-1', type: 'system', title: 'A', body: 'a' });
      service.notify({ targetUserId: 'user-1', type: 'system', title: 'B', body: 'b' });
      const counts = service.countNotifications('user-1');
      expect(counts.total).toBe(2);
      expect(counts.unread).toBe(2);

      const id = service.listNotifications('user-1')[0]!.id;
      expect(service.markNotificationRead(id)).toBe(true);
      expect(service.markAllNotificationsRead('user-1')).toBe(2);
    });
  });

  describe('restoration from repo', () => {
    it('restores approvals on setApprovalRepo', () => {
      const fresh = new HITLService();
      const repo = createMockApprovalRepo();
      repo.list.mockReturnValue([{
        id: 'apr-restored',
        agentId: 'agent-1',
        agentName: 'Bot',
        type: 'action',
        title: 'Restored',
        description: 'from db',
        details: {},
        status: 'pending',
        requestedAt: new Date().toISOString(),
      }] as never[]);
      fresh.setApprovalRepo(repo);
      expect(fresh.getApproval('apr-restored')?.title).toBe('Restored');
    });
  });
});
