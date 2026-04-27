import { createLogger } from '@markus/shared';
import type { OrganizationService } from './org-service.js';

const log = createLogger('hitl');

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export type NotificationType =
  | 'approval_request'
  | 'task_created'
  | 'task_completed'
  | 'task_review'
  | 'task_failed'
  | 'requirement_created'
  | 'requirement_decision'
  | 'agent_report'
  | 'direct_message'
  | 'group_message'
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
  /** When set, only these users (plus admins/owners) see and may respond to the approval in the API. */
  approverUserIds?: string[];
  /** The intended recipient; used for visibility filtering when approverUserIds is not set. */
  targetUserId?: string;
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

export interface ApprovalRepo {
  upsert(a: {
    id: string;
    agentId: string;
    agentName: string;
    type: string;
    title: string;
    description: string;
    details: Record<string, unknown>;
    status: string;
    requestedAt: string;
    respondedAt?: string;
    respondedBy?: string;
    responseComment?: string;
    expiresAt?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean;
    selectedOption?: string;
    approverUserIds?: string[];
    targetUserId?: string;
  }): void;
  list(status?: string): Array<{
    id: string;
    agentId: string;
    agentName: string;
    type: string;
    title: string;
    description: string;
    details: Record<string, unknown>;
    status: string;
    requestedAt: string;
    respondedAt?: string;
    respondedBy?: string;
    responseComment?: string;
    expiresAt?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean;
    selectedOption?: string;
    approverUserIds?: string[];
    targetUserId?: string;
  }>;
  get(id: string): {
    id: string;
    agentId: string;
    agentName: string;
    type: string;
    title: string;
    description: string;
    details: Record<string, unknown>;
    status: string;
    requestedAt: string;
    respondedAt?: string;
    respondedBy?: string;
    responseComment?: string;
    expiresAt?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean;
    selectedOption?: string;
    approverUserIds?: string[];
    targetUserId?: string;
  } | undefined;
}

type NotificationHandler = (notification: Notification) => void;

let idCounter = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

export class HITLService {
  private approvals = new Map<string, ApprovalRequest>();
  private pendingResolvers = new Map<
    string,
    (result: { approved: boolean; comment?: string; selectedOption?: string; respondedBy?: string }) => void
  >();
  private notificationHandlers: NotificationHandler[] = [];
  private notificationRepo?: NotificationRepo;
  private approvalRepo?: ApprovalRepo;
  private orgService?: OrganizationService;

  setOrgService(service: OrganizationService): void {
    this.orgService = service;
  }

  setNotificationRepo(repo: NotificationRepo): void {
    this.notificationRepo = repo;
  }

  setApprovalRepo(repo: ApprovalRepo): void {
    this.approvalRepo = repo;
    // Restore persisted approvals into memory on startup
    try {
      const rows = repo.list();
      for (const row of rows) {
        if (!this.approvals.has(row.id)) {
          this.approvals.set(row.id, {
            id: row.id,
            agentId: row.agentId,
            agentName: row.agentName,
            type: row.type as ApprovalRequest['type'],
            title: row.title,
            description: row.description,
            details: row.details,
            status: row.status as ApprovalStatus,
            requestedAt: row.requestedAt,
            respondedAt: row.respondedAt,
            respondedBy: row.respondedBy,
            responseComment: row.responseComment,
            expiresAt: row.expiresAt,
            options: row.options,
            allowFreeform: row.allowFreeform,
            selectedOption: row.selectedOption,
            approverUserIds: row.approverUserIds,
            targetUserId: row.targetUserId,
          });
        }
      }
      log.info(`Restored ${rows.length} approvals from storage`);
    } catch (err) {
      log.warn('Failed to restore approvals from storage', { error: String(err) });
    }
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
    approverUserIds?: string[];
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
      approverUserIds: opts.approverUserIds,
      targetUserId: opts.targetUserId,
    };
    this.approvals.set(id, approval);
    this.persistApproval(approval);
    log.info(`Approval requested: ${id} by ${opts.agentName}`);

    this.notify({
      targetUserId: opts.targetUserId ?? 'all',
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
    approverUserIds?: string[];
  }): Promise<{ approved: boolean; comment?: string; selectedOption?: string; respondedBy?: string }> {
    const approval = this.requestApproval(opts);
    return new Promise<{ approved: boolean; comment?: string; selectedOption?: string; respondedBy?: string }>((resolve) => {
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
    this.persistApproval(approval);
    log.info(`Approval ${id} ${approval.status} by ${respondedBy}`, { comment, selectedOption });

    this.markApprovalNotificationsRead(id);

    const resolve = this.pendingResolvers.get(id);
    if (resolve) {
      this.pendingResolvers.delete(id);
      resolve({ approved, comment, selectedOption, respondedBy });
    }
    return approval;
  }

  private persistApproval(approval: ApprovalRequest): void {
    if (!this.approvalRepo) return;
    try {
      this.approvalRepo.upsert({
        id: approval.id,
        agentId: approval.agentId,
        agentName: approval.agentName,
        type: approval.type,
        title: approval.title,
        description: approval.description,
        details: approval.details,
        status: approval.status,
        requestedAt: approval.requestedAt,
        respondedAt: approval.respondedAt,
        respondedBy: approval.respondedBy,
        responseComment: approval.responseComment,
        expiresAt: approval.expiresAt,
        options: approval.options,
        allowFreeform: approval.allowFreeform,
        selectedOption: approval.selectedOption,
        approverUserIds: approval.approverUserIds,
        targetUserId: approval.targetUserId,
      });
    } catch (err) {
      log.warn('Failed to persist approval', { id: approval.id, error: String(err) });
    }
  }

  listApprovals(status?: ApprovalStatus): ApprovalRequest[] {
    const all = [...this.approvals.values()];
    return status ? all.filter(a => a.status === status) : all;
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.approvals.get(id);
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
    let targetUserIds: string[];
    if (opts.targetUserId === 'all') {
      if (this.orgService) {
        const humans = this.orgService.listHumanUsers('default');
        targetUserIds = humans.map(h => h.id);
        if (targetUserIds.length === 0) targetUserIds = ['all'];
      } else {
        targetUserIds = ['all'];
      }
    } else {
      targetUserIds = [opts.targetUserId];
    }

    let first: Notification | undefined;
    for (const targetUserId of targetUserIds) {
      const n = this.notifySingle({ ...opts, targetUserId });
      first ??= n;
    }
    return first!;
  }

  private notifySingle(opts: {
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

  /** Mark unread approval_request rows for this approval across per-user and legacy shared user_ids. */
  private markApprovalNotificationsRead(approvalId: string): void {
    if (!this.notificationRepo) return;
    const userIds = new Set<string>(['all', 'default']);
    if (this.orgService) {
      for (const h of this.orgService.listHumanUsers('default')) {
        userIds.add(h.id);
      }
    }
    for (const userId of userIds) {
      try {
        const rows = this.notificationRepo.list(userId, { type: 'approval_request', limit: 200 });
        for (const row of rows) {
          if (row.metadata && (row.metadata as Record<string, unknown>).approvalId === approvalId && !row.read) {
            this.notificationRepo.markRead(row.id);
          }
        }
      } catch { /* best effort */ }
    }
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
