import { createLogger } from '@markus/shared';

const log = createLogger('hitl');

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type BountyStatus = 'open' | 'claimed' | 'completed' | 'cancelled';
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

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
  expiresAt?: string;
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
  type: 'approval_request' | 'bounty_posted' | 'task_completed' | 'agent_alert' | 'system';
  title: string;
  body: string;
  priority: NotificationPriority;
  read: boolean;
  actionUrl?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

type NotificationHandler = (notification: Notification) => void;

let idCounter = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

export class HITLService {
  private approvals = new Map<string, ApprovalRequest>();
  private pendingResolvers = new Map<string, (approved: boolean) => void>();
  private bounties = new Map<string, BountyTask>();
  private notifications = new Map<string, Notification>();
  private notificationHandlers: NotificationHandler[] = [];

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
    };
    this.approvals.set(id, approval);
    log.info(`Approval requested: ${id} by ${opts.agentName}`);

    const notification: Notification = {
      id: genId('ntf'),
      targetUserId: opts.targetUserId ?? 'default',
      type: 'approval_request',
      title: `Approval needed: ${opts.title}`,
      body: opts.description,
      priority: 'high',
      read: false,
      actionUrl: `/approvals/${id}`,
      createdAt: now,
      metadata: { approvalId: id },
    };
    this.notifications.set(notification.id, notification);
    this.emit(notification);

    return approval;
  }

  /** Request approval and wait for human response. Resolves when approve/reject is called via API. */
  async requestApprovalAndWait(opts: {
    agentId: string;
    agentName: string;
    type: ApprovalRequest['type'];
    title: string;
    description: string;
    details?: Record<string, unknown>;
    targetUserId?: string;
    expiresInMs?: number;
  }): Promise<boolean> {
    const approval = this.requestApproval(opts);
    return new Promise<boolean>((resolve) => {
      this.pendingResolvers.set(approval.id, resolve);
      if (opts.expiresInMs) {
        setTimeout(() => {
          if (this.pendingResolvers.has(approval.id)) {
            this.pendingResolvers.delete(approval.id);
            resolve(false);
          }
        }, opts.expiresInMs);
      }
    });
  }

  respondToApproval(id: string, approved: boolean, respondedBy: string): ApprovalRequest | undefined {
    const approval = this.approvals.get(id);
    if (!approval || approval.status !== 'pending') return undefined;

    approval.status = approved ? 'approved' : 'rejected';
    approval.respondedAt = new Date().toISOString();
    approval.respondedBy = respondedBy;
    log.info(`Approval ${id} ${approval.status} by ${respondedBy}`);

    for (const notif of this.notifications.values()) {
      if (notif.type === 'approval_request' && notif.metadata?.approvalId === id && !notif.read) {
        notif.read = true;
      }
    }

    const resolve = this.pendingResolvers.get(id);
    if (resolve) {
      this.pendingResolvers.delete(id);
      resolve(approved);
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

    const notification: Notification = {
      id: genId('ntf'),
      targetUserId: 'all',
      type: 'bounty_posted',
      title: `New bounty: ${opts.title}`,
      body: `${opts.agentName} needs help: ${opts.description}`,
      priority: 'normal',
      read: false,
      actionUrl: `/bounties/${id}`,
      createdAt: now,
      metadata: { bountyId: id },
    };
    this.notifications.set(notification.id, notification);
    this.emit(notification);

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

  listNotifications(userId?: string, unreadOnly = false): Notification[] {
    let result = [...this.notifications.values()];
    if (userId) {
      result = result.filter(n => n.targetUserId === userId || n.targetUserId === 'all');
    }
    if (unreadOnly) {
      result = result.filter(n => !n.read);
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  markNotificationRead(id: string): boolean {
    const n = this.notifications.get(id);
    if (!n) return false;
    n.read = true;
    return true;
  }

  notify(opts: {
    targetUserId: string;
    type: Notification['type'];
    title: string;
    body: string;
    priority?: NotificationPriority;
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
      createdAt: new Date().toISOString(),
      metadata: opts.metadata,
    };
    this.notifications.set(notification.id, notification);
    this.emit(notification);
    return notification;
  }
}
