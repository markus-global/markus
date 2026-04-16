import { createLogger } from '@markus/shared';

const log = createLogger('hitl');

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type BountyStatus = 'open' | 'claimed' | 'completed' | 'cancelled';
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export type NotificationType =
  | 'approval_request'
  | 'bounty_posted'
  | 'task_created'
  | 'task_completed'
  | 'task_review'
  | 'task_failed'
  | 'task_status_changed'
  | 'requirement_created'
  | 'requirement_decision'
  | 'agent_alert'
  | 'agent_report'
  | 'agent_chat_request'
  | 'agent_notification'
  | 'agent_escalation'
  | 'mention'
  | 'system';

export type NotificationActionType = 'none' | 'navigate' | 'open_chat';

export interface ApprovalRequest {
  id: string;
  agentId: string;
  agentName: string;
  type: 'action' | 'expense' | 'access' | 'deployment' | 'custom';
  title: string;
  description: string;
  details: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: string;
  respondedAt?: string;
  respondedBy?: string;
  responseComment?: string;
  expiresAt?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  allowFreeform?: boolean;
  selectedOption?: string;
}

export interface BountyTask {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  description: string;
  reward?: string;
  skills: string[];
  status: BountyStatus;
  claimedBy?: string;
  createdAt: string;
  completedAt?: string;
  result?: string;
}

export interface Notification {
  id: string;
  targetUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  priority: NotificationPriority;
  read: boolean;
  actionType: NotificationActionType;
  actionTarget?: string;
  actionUrl?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationRepo {
  insert(n: {
    id: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    priority: string;
    read: boolean;
    actionType: string;
    actionTarget: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }): void;
  list(userId: string, opts?: { unreadOnly?: boolean; limit?: number; offset?: number; type?: string }): Array<{
    id: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    priority: string;
    read: boolean;
    actionType: string;
    actionTarget: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }>;
  count(userId: string, unreadOnly?: boolean): number;
  markRead(id: string): boolean;
  markAllRead(userId: string): number;
}

type NotificationHandler = (notification: Notification) => void;

let idCounter = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

export class HITLService {
  private approvals = new Map<string, ApprovalRequest>();
  private pendingResolvers = new Map<string, (result: { approved: boolean; comment?: string; selectedOption?: string }) => void>();
  private bounties = new Map<string, BountyTask>();
  private notificationHandlers: NotificationHandler[] = [];
  private notificationRepo?: NotificationRepo;

  setNotificationRepo(repo: NotificationRepo): void {
    this.notificationRepo = repo;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      const idx = this.notificationHandlers.indexOf(handler);
      if (idx >= 0) this.notificationHandlers.splice(idx, 1);
    };
  }

  private emit(n: Notification): void {
    for (const h of this.notificationHandlers) {
      try { h(n); } catch { /* ignore */ }
    }
  }

  requestApproval(opts: {
    agentId: string;
    agentName: string;
    type: ApprovalRequest['type'];
    title: string;
    description: string;
    details?: Record<string, unknown>;
    targetUserId?: string;
    expiresInMs?: number;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean;
  }): ApprovalRequest {
    const id = genId('apr');
    const now = new Date().toISOString();
    const approval: ApprovalRequest = {
      id,
      agentId: opts.agentId,
      agentName: opts.agentName,
      type: opts.type,
      title: opts.title,
      description: opts.description,
      details: opts.details ?? {},
      status: 'pending',
      requestedAt: now,
      expiresAt: opts.expiresInMs ? new Date(Date.now() + opts.expiresInMs).toISOString() : undefined,
      options: opts.options,
      allowFreeform: opts.allowFreeform,
    };
    this.approvals.set(id, approval);
    log.info(`Approval requested: ${id} by ${opts.agentName}`);

    this.notify({
      targetUserId: opts.targetUserId ?? 'default',
      type: 'approval_request',
      title: `Approval needed: ${opts.title}`,
      body: opts.description,
      priority: 'high',
      actionType: 'navigate',
      actionTarget: JSON.stringify({ path: `/approvals/${id}` }),
      metadata: { approvalId: id },
    });

    return approval;
  }

  async requestApprovalAndWait(opts: {
    agentId: string;
    agentName: string;
    type: ApprovalRequest['type'];
    title: string;
    description: string;
    details?: Record<string, unknown>;
    targetUserId?: string;
    expiresInMs?: number;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean;
  }): Promise<{ approved: boolean; comment?: string; selectedOption?: string }> {
    const approval = this.requestApproval(opts);
    return new Promise<{ approved: boolean; comment?: string; selectedOption?: string }>((resolve) => {
      this.pendingResolvers.set(approval.id, resolve);
      if (opts.expiresInMs) {
        setTimeout(() => {
          if (this.pendingResolvers.has(approval.id)) {
            this.pendingResolvers.delete(approval.id);
            resolve({ approved: false, comment: 'Approval timed out' });
          }
        }, opts.expiresInMs);
      }
    });
  }

  respondToApproval(id: string, approved: boolean, respondedBy: string, comment?: string, selectedOption?: string): ApprovalRequest | undefined {
    const approval = this.approvals.get(id);
    if (!approval || approval.status !== 'pending') return undefined;

    approval.status = approved ? 'approved' : 'rejected';
    approval.respondedAt = new Date().toISOString();
    approval.respondedBy = respondedBy;
    if (comment) approval.responseComment = comment;
    if (selectedOption) approval.selectedOption = selectedOption;
    log.info(`Approval ${id} ${approval.status} by ${respondedBy}`, { comment, selectedOption });

    if (this.notificationRepo) {
      try {
        const rows = this.notificationRepo.list(approval.agentId, { type: 'approval_request', limit: 100 });
        for (const row of rows) {
          if (row.metadata && (row.metadata as Record<string, unknown>).approvalId === id && !row.read) {
            this.notificationRepo.markRead(row.id);
          }
        }
      } catch { /* best effort */ }
    }

    const resolve = this.pendingResolvers.get(id);
    if (resolve) {
      this.pendingResolvers.delete(id);
      resolve({ approved, comment, selectedOption });
    }
    return approval;
  }

  listApprovals(status?: ApprovalStatus): ApprovalRequest[] {
    const all = [...this.approvals.values()];
    return status ? all.filter(a => a.status === status) : all;
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.approvals.get(id);
  }

  postBounty(opts: {
    agentId: string;
    agentName: string;
    title: string;
    description: string;
    skills?: string[];
    reward?: string;
  }): BountyTask {
    const id = genId('bnt');
    const now = new Date().toISOString();
    const bounty: BountyTask = {
      id,
      agentId: opts.agentId,
      agentName: opts.agentName,
      title: opts.title,
      description: opts.description,
      reward: opts.reward,
      skills: opts.skills ?? [],
      status: 'open',
      createdAt: now,
    };
    this.bounties.set(id, bounty);
    log.info(`Bounty posted: ${id} by ${opts.agentName}`);

    this.notify({
      targetUserId: 'all',
      type: 'bounty_posted',
      title: `New bounty: ${opts.title}`,
      body: `${opts.agentName} needs help: ${opts.description}`,
      metadata: { bountyId: id },
    });

    return bounty;
  }

  claimBounty(id: string, userId: string): BountyTask | undefined {
    const bounty = this.bounties.get(id);
    if (!bounty || bounty.status !== 'open') return undefined;

    bounty.status = 'claimed';
    bounty.claimedBy = userId;
    log.info(`Bounty ${id} claimed by ${userId}`);
    return bounty;
  }

  completeBounty(id: string, result: string): BountyTask | undefined {
    const bounty = this.bounties.get(id);
    if (!bounty || bounty.status !== 'claimed') return undefined;

    bounty.status = 'completed';
    bounty.completedAt = new Date().toISOString();
    bounty.result = result;
    log.info(`Bounty ${id} completed`);
    return bounty;
  }

  listBounties(status?: BountyStatus): BountyTask[] {
    const all = [...this.bounties.values()];
    return status ? all.filter(b => b.status === status) : all;
  }

  getBounty(id: string): BountyTask | undefined {
    return this.bounties.get(id);
  }

  listNotifications(userId?: string, unreadOnly = false, opts?: { limit?: number; offset?: number; type?: string }): Notification[] {
    if (this.notificationRepo && userId) {
      const rows = this.notificationRepo.list(userId, {
        unreadOnly,
        limit: opts?.limit,
        offset: opts?.offset,
        type: opts?.type,
      });
      return rows.map(r => this.rowToNotification(r));
    }
    return [];
  }

  countNotifications(userId: string, unreadOnly = false): { total: number; unread: number } {
    if (this.notificationRepo) {
      return {
        total: this.notificationRepo.count(userId, false),
        unread: this.notificationRepo.count(userId, true),
      };
    }
    return { total: 0, unread: 0 };
  }

  markNotificationRead(id: string): boolean {
    if (this.notificationRepo) {
      return this.notificationRepo.markRead(id);
    }
    return false;
  }

  markAllNotificationsRead(userId: string): number {
    if (this.notificationRepo) {
      return this.notificationRepo.markAllRead(userId);
    }
    return 0;
  }

  notify(opts: {
    targetUserId: string;
    type: NotificationType;
    title: string;
    body: string;
    priority?: NotificationPriority;
    actionType?: NotificationActionType;
    actionTarget?: string;
    metadata?: Record<string, unknown>;
  }): Notification {
    const notification: Notification = {
      id: genId('ntf'),
      targetUserId: opts.targetUserId,
      type: opts.type,
      title: opts.title,
      body: opts.body,
      priority: opts.priority ?? 'normal',
      read: false,
      actionType: opts.actionType ?? 'none',
      actionTarget: opts.actionTarget,
      createdAt: new Date().toISOString(),
      metadata: opts.metadata,
    };

    if (this.notificationRepo) {
      try {
        this.notificationRepo.insert({
          id: notification.id,
          userId: notification.targetUserId,
          type: notification.type,
          title: notification.title,
          body: notification.body,
          priority: notification.priority,
          read: false,
          actionType: notification.actionType,
          actionTarget: notification.actionTarget ?? null,
          metadata: notification.metadata ?? null,
          createdAt: notification.createdAt,
        });
      } catch (err) {
        log.warn('Failed to persist notification', { error: String(err) });
      }
    }

    this.emit(notification);
    return notification;
  }

  private rowToNotification(r: {
    id: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    priority: string;
    read: boolean;
    actionType: string;
    actionTarget: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }): Notification {
    return {
      id: r.id,
      targetUserId: r.userId,
      type: r.type as NotificationType,
      title: r.title,
      body: r.body,
      priority: r.priority as NotificationPriority,
      read: r.read,
      actionType: r.actionType as NotificationActionType,
      actionTarget: r.actionTarget ?? undefined,
      createdAt: r.createdAt,
      metadata: r.metadata ?? undefined,
    };
  }
}
