import {
  createLogger,
  requirementId as genRequirementId,
  type Requirement,
  type RequirementStatus,
  type RequirementSource,
  type TaskPriority,
} from '@markus/shared';
import type { WSBroadcaster } from './ws-server.js';

const log = createLogger('requirement-service');

export interface CreateRequirementRequest {
  orgId: string;
  title: string;
  description: string;
  priority?: TaskPriority;
  projectId?: string;
  iterationId?: string;
  source: RequirementSource;
  createdBy: string;
  tags?: string[];
}

export class RequirementService {
  private requirements = new Map<string, Requirement>();
  private requirementRepo?: any;
  private ws?: WSBroadcaster;

  setRequirementRepo(repo: any): void {
    this.requirementRepo = repo;
  }

  setWSBroadcaster(ws: WSBroadcaster): void {
    this.ws = ws;
  }

  /**
   * Create a requirement from a user — auto-approved.
   */
  createRequirement(request: CreateRequirementRequest): Requirement {
    if (!request.projectId) {
      throw new Error('Requirement must be linked to a project (projectId is required).');
    }
    const isUser = request.source === 'user';
    const now = new Date().toISOString();

    const req: Requirement = {
      id: genRequirementId(),
      orgId: request.orgId,
      projectId: request.projectId,
      iterationId: request.iterationId,
      title: request.title,
      description: request.description,
      status: isUser ? 'approved' : 'draft',
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
          iterationId: req.iterationId,
          approvedBy: req.approvedBy ?? undefined,
          approvedAt: req.approvedAt ? new Date(req.approvedAt) : undefined,
          tags: req.tags,
        })
        .catch((e: unknown) =>
          log.error('Failed to persist requirement', { id: req.id, error: String(e) })
        );
    }

    this.broadcast('requirement:created', req);
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
   * Agent proposes a requirement draft — needs user approval.
   * Each agent can have at most 3 pending (draft/pending_review) proposals at a time.
   */
  proposeRequirement(request: CreateRequirementRequest): Requirement {
    const pendingCount = [...this.requirements.values()].filter(
      r =>
        r.source === 'agent' &&
        r.createdBy === request.createdBy &&
        (r.status === 'draft' || r.status === 'pending_review')
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
    if (req.status !== 'draft' && req.status !== 'pending_review') {
      throw new Error(`Requirement ${id} is in status '${req.status}' and cannot be approved`);
    }

    const now = new Date().toISOString();
    req.status = 'approved';
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

    return req;
  }

  /**
   * User rejects an agent-proposed requirement.
   */
  rejectRequirement(id: string, userId: string, reason: string): Requirement {
    const req = this.requirements.get(id);
    if (!req) throw new Error(`Requirement ${id} not found`);
    if (req.status !== 'draft' && req.status !== 'pending_review') {
      throw new Error(`Requirement ${id} is in status '${req.status}' and cannot be rejected`);
    }

    const now = new Date().toISOString();
    req.status = 'rejected';
    req.rejectedReason = reason;
    req.updatedAt = now;

    if (this.requirementRepo) {
      this.requirementRepo
        .reject(id, reason)
        .catch((e: unknown) =>
          log.error('Failed to persist requirement rejection', { id, error: String(e) })
        );
    }

    this.broadcast('requirement:rejected', req);
    log.info('Requirement rejected', { id, reason });

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
    const req = this.requirements.get(id);
    if (!req) throw new Error(`Requirement ${id} not found`);
    if (req.status === newStatus) return req;

    const now = new Date().toISOString();
    const oldStatus = req.status;
    req.status = newStatus;
    req.updatedAt = now;

    if (newStatus === 'approved' && oldStatus !== 'approved') {
      req.approvedBy = userId ?? req.approvedBy ?? 'unknown';
      req.approvedAt = now;
      req.rejectedReason = undefined;
    } else if (newStatus === 'rejected') {
      if (!req.rejectedReason) req.rejectedReason = 'Moved to closed';
    } else if (
      newStatus === 'draft' ||
      newStatus === 'pending_review'
    ) {
      req.rejectedReason = undefined;
    }

    if (this.requirementRepo) {
      const persistErr = (e: unknown) =>
        log.error('Failed to persist requirement status update', { id, error: String(e) });

      if (newStatus === 'approved' && oldStatus !== 'approved') {
        this.requirementRepo.approve(id, req.approvedBy ?? 'unknown').catch(persistErr);
      } else if (newStatus === 'rejected') {
        this.requirementRepo.reject(id, req.rejectedReason ?? '').catch(persistErr);
      } else {
        this.requirementRepo.updateStatus(id, newStatus).catch(persistErr);
      }
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
      if (req.status === 'approved') {
        req.status = 'in_progress';
        if (this.requirementRepo) {
          this.requirementRepo.updateStatus(requirementId, 'in_progress').catch((e: unknown) =>
            log.error('Failed to persist requirement status', { id: requirementId, error: String(e) })
          );
        }
      }
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
   * Check if all tasks for a requirement are done. If so, mark it as completed.
   */
  checkCompletion(requirementId: string, taskStatuses: Map<string, string>): boolean {
    const req = this.requirements.get(requirementId);
    if (!req || req.status === 'completed') return false;
    if (req.taskIds.length === 0) return false;

    const allDone = req.taskIds.every(tid => {
      const status = taskStatuses.get(tid);
      return status === 'completed' || status === 'cancelled' || status === 'archived';
    });

    if (allDone) {
      req.status = 'completed';
      req.updatedAt = new Date().toISOString();
      if (this.requirementRepo) {
        this.requirementRepo.updateStatus(requirementId, 'completed').catch((e: unknown) =>
          log.error('Failed to persist requirement completion', { id: requirementId, error: String(e) })
        );
      }
      this.broadcast('requirement:completed', req);
      log.info('Requirement completed', { id: requirementId });
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
    return req !== undefined && (req.status === 'approved' || req.status === 'in_progress');
  }

  listRequirements(filters?: {
    orgId?: string;
    projectId?: string;
    iterationId?: string;
    status?: RequirementStatus;
    source?: RequirementSource;
  }): Requirement[] {
    let result = [...this.requirements.values()];

    if (filters?.orgId) result = result.filter(r => r.orgId === filters.orgId);
    if (filters?.projectId) result = result.filter(r => r.projectId === filters.projectId);
    if (filters?.iterationId) result = result.filter(r => r.iterationId === filters.iterationId);
    if (filters?.status) result = result.filter(r => r.status === filters.status);
    if (filters?.source) result = result.filter(r => r.source === filters.source);

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
          iterationId: row.iterationId ?? undefined,
          title: row.title,
          description: row.description,
          status: row.status as RequirementStatus,
          priority: row.priority as TaskPriority,
          source: row.source as RequirementSource,
          createdBy: row.createdBy,
          approvedBy: row.approvedBy ?? undefined,
          approvedAt: row.approvedAt ? new Date(row.approvedAt as any).toISOString() : undefined,
          rejectedReason: row.rejectedReason ?? undefined,
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

  deleteRequirement(id: string): void {
    this.requirements.delete(id);
    if (this.requirementRepo) {
      this.requirementRepo.delete(id).catch((e: unknown) =>
        log.error('Failed to delete requirement from storage', { id, error: String(e) })
      );
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
