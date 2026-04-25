import {
  createLogger,
  requirementId as genRequirementId,
  type Requirement,
  type RequirementStatus,
  type RequirementSource,
  type TaskPriority,
} from '@markus/shared';
import type { AgentManager } from '@markus/core';
import type { WSBroadcaster } from './ws-server.js';
import type { HITLService } from './hitl-service.js';

const log = createLogger('requirement-service');

export interface CreateRequirementRequest {
  orgId: string;
  title: string;
  description: string;
  priority?: TaskPriority;
  projectId?: string;
  source: RequirementSource;
  createdBy: string;
  tags?: string[];
}

export class RequirementService {
  private requirements = new Map<string, Requirement>();
  private requirementRepo?: any;
  private ws?: WSBroadcaster;
  private agentManager?: AgentManager;
  private hitlService?: HITLService;

  private static readonly VALID_STATUSES: ReadonlySet<string> = new Set([
    'pending', 'in_progress', 'blocked', 'review', 'completed', 'failed', 'rejected', 'cancelled', 'archived',
  ]);

  setRequirementRepo(repo: any): void {
    this.requirementRepo = repo;
  }

  setWSBroadcaster(ws: WSBroadcaster): void {
    this.ws = ws;
  }

  setAgentManager(am: AgentManager): void {
    this.agentManager = am;
  }

  setHITLService(svc: HITLService): void {
    this.hitlService = svc;
  }

  /**
   * Create a requirement from a user — auto-approved.
   */
  createRequirement(request: CreateRequirementRequest): Requirement {
    if (!request.title?.trim()) {
      throw new Error('Requirement title is required and cannot be empty.');
    }
    if (!request.description?.trim()) {
      throw new Error('Requirement description is required and cannot be empty.');
    }
    if (!request.createdBy?.trim()) {
      throw new Error('Requirement creator (createdBy) is required.');
    }
    if (!request.projectId) {
      throw new Error('Requirement must be linked to a project (projectId is required).');
    }
    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    if (request.priority && !validPriorities.includes(request.priority)) {
      throw new Error(`Invalid priority "${request.priority}". Must be one of: ${validPriorities.join(', ')}.`);
    }
    const isUser = request.source === 'user';
    const now = new Date().toISOString();

    const req: Requirement = {
      id: genRequirementId(),
      orgId: request.orgId,
      projectId: request.projectId,
      title: request.title,
      description: request.description,
      status: isUser ? 'in_progress' : 'pending',
      priority: request.priority ?? 'medium',
      source: request.source,
      createdBy: request.createdBy,
      approvedBy: isUser ? request.createdBy : undefined,
      approvedAt: isUser ? now : undefined,
      taskIds: [],
      tags: request.tags,
      createdAt: now,
      updatedAt: now,
    };

    this.requirements.set(req.id, req);

    if (this.requirementRepo) {
      this.requirementRepo
        .create({
          id: req.id,
          orgId: req.orgId,
          title: req.title,
          description: req.description,
          status: req.status,
          priority: req.priority,
          source: req.source,
          createdBy: req.createdBy,
          projectId: req.projectId,
          approvedBy: req.approvedBy ?? undefined,
          approvedAt: req.approvedAt ? new Date(req.approvedAt) : undefined,
          tags: req.tags,
        })
        .catch((e: unknown) =>
          log.error('Failed to persist requirement', { id: req.id, error: String(e) })
        );
    }

    this.broadcast('requirement:created', req);
    if (this.hitlService && req.source === 'agent') {
      this.hitlService.requestApprovalAndWait({
        agentId: req.createdBy,
        agentName: req.createdBy,
        type: 'custom',
        title: `Requirement approval: ${req.title}`,
        description: `Agent "${req.createdBy}" proposed requirement "${req.title}" (priority: ${req.priority}).`,
        details: { requirementId: req.id, priority: req.priority },
        targetUserId: 'all',
      }).then(result => {
        const current = this.requirements.get(req.id);
        if (!current || current.status !== 'pending') return;
        if (result.approved) {
          this.approveRequirement(req.id, result.respondedBy ?? 'hitl');
        } else {
          this.rejectRequirement(
            req.id,
            result.respondedBy ?? 'hitl',
            result.comment || 'Rejected via approval',
          );
        }
      }).catch(err => {
        log.error('HITL approval flow error for requirement', { requirementId: req.id, error: String(err) });
      });
    }
    log.info('Requirement created', {
      id: req.id,
      source: req.source,
      status: req.status,
      title: req.title,
    });

    return req;
  }

  private static readonly MAX_PENDING_PROPOSALS_PER_AGENT = 3;

  /**
   * Agent proposes a requirement — needs user approval.
   * Each agent can have at most 3 pending proposals at a time.
   */
  proposeRequirement(request: CreateRequirementRequest): Requirement {
    const pendingCount = [...this.requirements.values()].filter(
      r =>
        r.source === 'agent' &&
        r.createdBy === request.createdBy &&
        r.status === 'pending'
    ).length;

    if (pendingCount >= RequirementService.MAX_PENDING_PROPOSALS_PER_AGENT) {
      throw new Error(
        `Agent ${request.createdBy} already has ${pendingCount} pending requirement proposals (max ${RequirementService.MAX_PENDING_PROPOSALS_PER_AGENT}). Wait for existing proposals to be reviewed before proposing more.`
      );
    }

    return this.createRequirement({ ...request, source: 'agent' });
  }

  /**
   * User approves an agent-proposed requirement.
   */
  approveRequirement(id: string, userId: string): Requirement {
    const req = this.requirements.get(id);
    if (!req) throw new Error(`Requirement ${id} not found`);
    if (req.status !== 'pending') {
      throw new Error(`Requirement ${id} is in status '${req.status}' and cannot be approved`);
    }

    if (this.hitlService) {
      const pending = this.hitlService.listApprovals('pending');
      const hitl = pending.find(a => (a.details as Record<string, unknown>)?.['requirementId'] === id);
      if (hitl) this.hitlService.respondToApproval(hitl.id, true, userId);
    }

    const now = new Date().toISOString();
    req.status = 'in_progress';
    req.approvedBy = userId;
    req.approvedAt = now;
    req.updatedAt = now;

    if (this.requirementRepo) {
      this.requirementRepo
        .approve(id, userId)
        .catch((e: unknown) =>
          log.error('Failed to persist requirement approval', { id, error: String(e) })
        );
    }

    this.broadcast('requirement:approved', req);
    log.info('Requirement approved', { id, approvedBy: userId });

    this.notifyCreatorOnDecision(req, 'approved', userId);

    return req;
  }

  /**
   * User rejects an agent-proposed requirement.
   */
  rejectRequirement(id: string, userId: string, reason: string): Requirement {
    const req = this.requirements.get(id);
    if (!req) throw new Error(`Requirement ${id} not found`);
    if (req.status !== 'pending') {
      throw new Error(`Requirement ${id} is in status '${req.status}' and cannot be rejected`);
    }

    if (this.hitlService) {
      const pending = this.hitlService.listApprovals('pending');
      const hitl = pending.find(a => (a.details as Record<string, unknown>)?.['requirementId'] === id);
      if (hitl) this.hitlService.respondToApproval(hitl.id, false, userId, reason);
    }

    const now = new Date().toISOString();
    req.status = 'rejected';
    req.rejectedReason = reason;
    req.rejectedBy = userId;
    req.updatedAt = now;

    if (this.requirementRepo) {
      this.requirementRepo
        .reject(id, reason, userId)
        .catch((e: unknown) =>
          log.error('Failed to persist requirement rejection', { id, error: String(e) })
        );
    }

    this.broadcast('requirement:rejected', req);
    log.info('Requirement rejected', { id, reason });

    this.notifyCreatorOnDecision(req, 'rejected', userId, reason);

    return req;
  }

  /**
   * Resubmit a rejected requirement for review, optionally updating its fields.
   * Transitions rejected → pending so the human can re-evaluate.
   */
  resubmitRequirement(
    id: string,
    updates?: { title?: string; description?: string; priority?: TaskPriority; tags?: string[] },
  ): Requirement {
    const req = this.requirements.get(id);
    if (!req) throw new Error(`Requirement ${id} not found`);
    if (req.status !== 'rejected') {
      throw new Error(`Requirement ${id} is in status '${req.status}' — only rejected requirements can be resubmitted`);
    }

    const now = new Date().toISOString();
    if (updates?.title !== undefined) req.title = updates.title;
    if (updates?.description !== undefined) req.description = updates.description;
    if (updates?.priority !== undefined) req.priority = updates.priority;
    if (updates?.tags !== undefined) req.tags = updates.tags;

    req.status = 'pending';
    req.rejectedReason = undefined;
    req.rejectedBy = undefined;
    req.approvedBy = undefined;
    req.approvedAt = undefined;
    req.updatedAt = now;

    if (this.requirementRepo) {
      const persistErr = (e: unknown) =>
        log.error('Failed to persist requirement resubmission', { id, error: String(e) });
      this.requirementRepo.updateStatus(id, 'pending').catch(persistErr);
      this.requirementRepo.clearRejectionMetadata(id).catch(persistErr);
      if (updates) {
        this.requirementRepo.update(id, updates).catch(persistErr);
      }
    }

    this.broadcast('requirement:resubmitted', req);
    log.info('Requirement resubmitted for review', { id, hasUpdates: !!updates });

    if (this.hitlService && req.source === 'agent') {
      this.hitlService.requestApprovalAndWait({
        agentId: req.createdBy,
        agentName: req.createdBy,
        type: 'custom',
        title: `Requirement approval (resubmitted): ${req.title}`,
        description: `Agent "${req.createdBy}" resubmitted requirement "${req.title}" (priority: ${req.priority}).`,
        details: { requirementId: req.id, priority: req.priority },
        targetUserId: 'all',
      }).then(result => {
        const current = this.requirements.get(req.id);
        if (!current || current.status !== 'pending') return;
        if (result.approved) {
          this.approveRequirement(req.id, result.respondedBy ?? 'hitl');
        } else {
          this.rejectRequirement(
            req.id,
            result.respondedBy ?? 'hitl',
            result.comment || 'Rejected via approval',
          );
        }
      }).catch(err => {
        log.error('HITL approval flow error for resubmitted requirement', { requirementId: req.id, error: String(err) });
      });
    }

    return req;
  }

  /**
   * Update requirement status via drag-and-drop or manual action.
   * Handles side-effects (clearing rejection, setting approval, etc.)
   */
  updateRequirementStatus(
    id: string,
    newStatus: RequirementStatus,
    userId?: string
  ): Requirement {
    if (!RequirementService.VALID_STATUSES.has(newStatus)) {
      throw new Error(`Invalid requirement status "${newStatus}". Valid values: ${[...RequirementService.VALID_STATUSES].join(', ')}`);
    }
    const req = this.requirements.get(id);
    if (!req) throw new Error(`Requirement ${id} not found`);
    if (req.status === newStatus) return req;

    const now = new Date().toISOString();
    const oldStatus = req.status;
    req.status = newStatus;
    req.updatedAt = now;

    if (newStatus === 'in_progress' && oldStatus === 'pending') {
      req.approvedBy = userId ?? req.approvedBy ?? 'unknown';
      req.approvedAt = now;
      req.rejectedReason = undefined;
      req.rejectedBy = undefined;
    } else if (newStatus === 'rejected') {
      if (!req.rejectedReason) req.rejectedReason = 'Moved to closed';
      req.rejectedBy = userId ?? req.rejectedBy;
    } else if (newStatus === 'pending') {
      req.rejectedReason = undefined;
      req.rejectedBy = undefined;
    }

    if (this.requirementRepo) {
      const persistErr = (e: unknown) =>
        log.error('Failed to persist requirement status update', { id, error: String(e) });

      if (newStatus === 'in_progress' && oldStatus === 'pending') {
        this.requirementRepo.approve(id, req.approvedBy ?? 'unknown').catch(persistErr);
      } else if (newStatus === 'rejected') {
        this.requirementRepo.reject(id, req.rejectedReason ?? '', userId).catch(persistErr);
      } else {
        this.requirementRepo.updateStatus(id, newStatus).catch(persistErr);
      }
    }

    // Notify the creator agent of every requirement status transition
    if (req.createdBy && this.agentManager) {
      try {
        const agent = this.agentManager.getAgent(req.createdBy);
        if (agent) {
          agent.enqueueToMailbox('requirement_update', {
            summary: `Requirement "${req.title}" status: ${oldStatus} → ${newStatus}`,
            content: [
              `[REQUIREMENT STATUS UPDATE] "${req.title}" (ID: ${id})`,
              `Status changed: ${oldStatus} → ${newStatus}`,
              userId ? `Updated by: ${userId}` : '',
            ].filter(Boolean).join('\n'),
            requirementId: id,
          }, {
            metadata: { senderName: 'System', senderRole: 'manager' },
          });
        }
      } catch { /* agent not found — skip */ }
    }

    this.broadcast('requirement:updated', req);
    log.info('Requirement status updated', { id, from: oldStatus, to: newStatus });

    return req;
  }

  /**
   * Update a requirement's fields (title, description, priority, etc.)
   */
  updateRequirement(
    id: string,
    data: { title?: string; description?: string; priority?: TaskPriority; tags?: string[] }
  ): Requirement {
    const req = this.requirements.get(id);
    if (!req) throw new Error(`Requirement ${id} not found`);

    if (data.title !== undefined) req.title = data.title;
    if (data.description !== undefined) req.description = data.description;
    if (data.priority !== undefined) req.priority = data.priority;
    if (data.tags !== undefined) req.tags = data.tags;
    req.updatedAt = new Date().toISOString();

    if (this.requirementRepo) {
      this.requirementRepo
        .update(id, data)
        .catch((e: unknown) =>
          log.error('Failed to persist requirement update', { id, error: String(e) })
        );
    }

    this.broadcast('requirement:updated', req);
    return req;
  }

  /**
   * Link a task to a requirement.
   */
  linkTask(requirementId: string, taskId: string): void {
    const req = this.requirements.get(requirementId);
    if (!req) return;
    if (!req.taskIds.includes(taskId)) {
      req.taskIds.push(taskId);
      req.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Unlink a task from a requirement (e.g. on task deletion).
   */
  unlinkTask(requirementId: string, taskId: string): void {
    const req = this.requirements.get(requirementId);
    if (!req) return;
    req.taskIds = req.taskIds.filter(id => id !== taskId);
    req.updatedAt = new Date().toISOString();
  }

  /**
   * Check if all tasks for a requirement are done. Instead of auto-completing,
   * notify the creator agent so they can review results and decide whether to
   * complete the requirement or create additional tasks.
   */
  checkCompletion(requirementId: string, taskStatuses: Map<string, string>): boolean {
    const req = this.requirements.get(requirementId);
    if (!req || req.status === 'completed' || req.status === 'cancelled') return false;
    if (req.taskIds.length === 0) return false;

    const allDone = req.taskIds.every(tid => {
      const status = taskStatuses.get(tid);
      return status === 'completed' || status === 'cancelled' || status === 'archived';
    });

    if (allDone && req.createdBy && this.agentManager) {
      try {
        const agent = this.agentManager.getAgent(req.createdBy);
        if (agent) {
          agent.enqueueToMailbox('requirement_update', {
            summary: `All tasks for requirement "${req.title}" are done — review needed`,
            content: [
              `[REQUIREMENT REVIEW NEEDED] All linked tasks for "${req.title}" (ID: ${requirementId}) have reached terminal state.`,
              '',
              'Please review the results and decide:',
              `1. If the requirement is fully satisfied, complete it: requirement_update_status(requirement_id="${requirementId}", status="completed")`,
              `2. If more work is needed, create additional tasks with task_create(requirement_id="${requirementId}", ...)`,
            ].join('\n'),
            requirementId,
            extra: { actionRequired: true },
          }, {
            priority: 2,
            metadata: { senderName: 'System', senderRole: 'manager' },
          });
        }
      } catch { /* agent not found */ }
      return true;
    }
    return false;
  }

  /**
   * Cancel a requirement and all its associations.
   */
  cancelRequirement(id: string): Requirement {
    const req = this.requirements.get(id);
    if (!req) throw new Error(`Requirement ${id} not found`);

    req.status = 'cancelled';
    req.updatedAt = new Date().toISOString();

    if (this.requirementRepo) {
      this.requirementRepo.updateStatus(id, 'cancelled').catch((e: unknown) =>
        log.error('Failed to persist requirement cancellation', { id, error: String(e) })
      );
    }

    this.broadcast('requirement:cancelled', req);
    log.info('Requirement cancelled', { id });

    return req;
  }

  getRequirement(id: string): Requirement | undefined {
    return this.requirements.get(id);
  }

  /**
   * Check if a requirement is approved and valid for task creation.
   */
  isApproved(id: string): boolean {
    const req = this.requirements.get(id);
    return req !== undefined && req.status === 'in_progress';
  }

  listRequirements(filters?: {
    orgId?: string;
    projectId?: string;
    status?: RequirementStatus;
    source?: RequirementSource;
    createdBy?: string;
  }): Requirement[] {
    let result = [...this.requirements.values()];

    if (filters?.orgId) result = result.filter(r => r.orgId === filters.orgId);
    if (filters?.projectId) result = result.filter(r => r.projectId === filters.projectId);
    if (filters?.status) result = result.filter(r => r.status === filters.status);
    if (filters?.source) result = result.filter(r => r.source === filters.source);
    if (filters?.createdBy) result = result.filter(r => r.createdBy === filters.createdBy);

    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Load requirements from DB into memory on startup.
   */
  async loadFromStorage(orgId: string): Promise<void> {
    if (!this.requirementRepo) return;
    try {
      const rows = await this.requirementRepo.listByOrg(orgId);
      for (const row of rows) {
        const req: Requirement = {
          id: row.id,
          orgId: row.orgId,
          projectId: row.projectId ?? undefined,
          title: row.title,
          description: row.description,
          status: row.status as RequirementStatus,
          priority: row.priority as TaskPriority,
          source: row.source as RequirementSource,
          createdBy: row.createdBy,
          approvedBy: row.approvedBy ?? undefined,
          approvedAt: row.approvedAt ? new Date(row.approvedAt as any).toISOString() : undefined,
          rejectedReason: row.rejectedReason ?? undefined,
          rejectedBy: row.rejectedBy ?? undefined,
          taskIds: [],
          tags: (row.tags as string[]) ?? [],
          createdAt: new Date(row.createdAt as any).toISOString(),
          updatedAt: new Date(row.updatedAt as any).toISOString(),
        };
        this.requirements.set(req.id, req);
      }
      log.info('Loaded requirements from storage', { orgId, count: rows.length });
    } catch (e) {
      log.error('Failed to load requirements from storage', { orgId, error: String(e) });
    }
  }

  /**
   * Rebuild in-memory taskIds linkage from loaded tasks.
   * Must be called after both requirements and tasks are loaded from DB,
   * since taskIds are not persisted in the requirements table.
   */
  rebuildTaskLinks(tasks: Iterable<{ id: string; requirementId?: string }>): void {
    for (const req of this.requirements.values()) {
      req.taskIds = [];
    }
    for (const task of tasks) {
      if (task.requirementId) {
        const req = this.requirements.get(task.requirementId);
        if (req && !req.taskIds.includes(task.id)) {
          req.taskIds.push(task.id);
        }
      }
    }
    const linked = [...this.requirements.values()].filter(r => r.taskIds.length > 0).length;
    if (linked > 0) {
      log.info('Rebuilt requirement-task links', { linkedRequirements: linked });
    }
  }

  deleteRequirement(id: string): void {
    this.requirements.delete(id);
    if (this.requirementRepo) {
      this.requirementRepo.delete(id).catch((e: unknown) =>
        log.error('Failed to delete requirement from storage', { id, error: String(e) })
      );
    }
  }

  /**
   * Notify the proposing agent when a requirement decision is made.
   * For approved: agent should create tasks to fulfill the requirement.
   * For rejected: agent should review feedback and either propose a refined
   * requirement or abandon the idea.
   */
  private notifyCreatorOnDecision(
    req: Requirement,
    decision: 'approved' | 'rejected',
    decidedBy: string,
    reason?: string,
  ): void {
    if (req.source !== 'agent') return;

    const creatorId = req.createdBy;

    // Notify the proposing agent via handleMessage
    if (this.agentManager && this.agentManager.hasAgent(creatorId)) {
      const parts: string[] = [];

      if (decision === 'approved') {
        parts.push(`[REQUIREMENT APPROVED] Your proposed requirement "${req.title}" (ID: ${req.id}) has been approved.`);
        parts.push('');
        parts.push(`The requirement is now **in progress**. You should create tasks to fulfill it.`);
        parts.push('');
        parts.push(`**Title:** ${req.title}`);
        parts.push(`**Description:** ${req.description}`);
        if (req.projectId) parts.push(`**Project:** ${req.projectId}`);
        parts.push('');
        parts.push(`Please use \`task_create\` to create tasks for this requirement, setting requirement_id to "${req.id}".`);
      } else {
        parts.push(`[REQUIREMENT REJECTED] Your proposed requirement "${req.title}" (ID: ${req.id}) has been rejected.`);
        parts.push('');
        if (reason) parts.push(`**Reason:** ${reason}`);
        parts.push('');
        parts.push(`**Title:** ${req.title}`);
        parts.push(`**Description:** ${req.description}`);
        parts.push('');
        parts.push('You may:');
        parts.push(`1. Update and resubmit this requirement using \`requirement_resubmit\` with requirement_id "${req.id}" — you can include updated title, description, or other fields that address the feedback`);
        parts.push('2. Abandon this requirement if the feedback indicates it is not needed');
      }

      const agent = this.agentManager.getAgent(creatorId);
      agent.enqueueToMailbox('requirement_update', {
        summary: `Requirement "${req.title}" ${decision}`,
        content: parts.join('\n'),
        requirementId: req.id,
        extra: { actionRequired: true },
      }, {
        priority: 1,
        metadata: { senderName: 'System', senderRole: 'manager' },
      });

      log.info('Notified creator agent about requirement decision', {
        requirementId: req.id, creatorId, decision,
      });
    }

    // Create HITL notification for UI bell
    if (this.hitlService) {
      const title = decision === 'approved'
        ? `Requirement approved: ${req.title}`
        : `Requirement rejected: ${req.title}`;
      const body = decision === 'approved'
        ? `Requirement "${req.title}" has been approved and is now in progress.`
        : `Requirement "${req.title}" has been rejected.${reason ? ` Reason: ${reason}` : ''}`;

      this.hitlService.notify({
        targetUserId: 'all',
        type: 'requirement_decision',
        title,
        body,
        actionType: 'navigate',
        actionTarget: JSON.stringify({ path: `/work?openRequirement=${req.id}` }),
        metadata: { requirementId: req.id, decision, createdBy: creatorId },
      });
    }
  }

  private broadcast(type: string, data: unknown): void {
    if (this.ws) {
      this.ws.broadcast({
        type,
        payload: data,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
