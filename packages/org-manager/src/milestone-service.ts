import {
  createLogger,
  generateId,
  normalizeMilestoneDueDate,
  MILESTONE_ACTIVE_STATUSES,
  MILESTONE_DONE_STATUSES,
  MILESTONE_EXCLUDED_STATUSES,
  type Milestone,
  type MilestoneProgress,
  type MilestoneWithProgress,
  type Requirement,
} from '@markus/shared';

const log = createLogger('milestone-service');

/** Minimal project lookup — satisfied by ProjectService. */
export interface MilestoneProjectLookup {
  getProject(id: string): { id?: string; name?: string } | null | undefined;
}

/**
 * What a milestone needs from the requirement side.
 *
 * Both methods are implemented by `RequirementService` — it owns the requirement map and is
 * the ONLY writer of `requirements.milestone_id`. This service never touches that column
 * itself: it asks, it does not write (single writer per column).
 */
export interface MilestoneRequirementBridge {
  /** Requirements currently attached to a milestone (read for progress derivation). */
  listByMilestone(milestoneId: string): Requirement[];
  /**
   * All requirements, so a LIST of milestones can be scored in ONE pass.
   *
   * Without this, `listWithProgress` is O(milestones x requirements): every milestone re-scans
   * the whole corpus. Optional so test bridges and partial wirings keep working — the fallback
   * stays per-milestone.
   */
  listAll?(): Requirement[];
  /** Detach every requirement from a milestone; returns how many were detached. */
  detachMilestone(milestoneId: string): number;
}

interface MilestoneRepo {
  create(data: Record<string, unknown>): Promise<unknown>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  listByProject(projectId: string): unknown[];
  listByOrg(orgId: string): unknown[];
}

/**
 * THE single definition of milestone completion.
 *
 * Progress is never stored (see `docs/architecture/work-hierarchy.md`): a stored counter is a
 * second source of truth that goes stale the moment a requirement changes status. Every
 * surface (API, agent tools, UI) reads this function's output.
 *
 * - `total` excludes cancelled/rejected — a milestone is "what we signed up for", not
 *   "everything ever filed against it".
 * - `done` includes archived: `REQ_TRANSITIONS` only allows `completed → archived`, so an
 *   archived requirement was finished earlier.
 */
export function computeMilestoneProgress(statuses: ReadonlyArray<string>): MilestoneProgress {
  let total = 0;
  let done = 0;
  let active = 0;
  let blocked = 0;
  for (const status of statuses) {
    if (MILESTONE_EXCLUDED_STATUSES.has(status)) continue;
    total += 1;
    if (MILESTONE_DONE_STATUSES.has(status)) done += 1;
    else if (MILESTONE_ACTIVE_STATUSES.has(status)) active += 1;
    else if (status === 'blocked') blocked += 1;
  }
  return {
    total,
    done,
    active,
    blocked,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

/**
 * One audit fact about a milestone write.
 *
 * MilestoneService does not know about the audit store (it must stay usable in tests and in
 * processes without one), so it publishes a fact and the bootstrap decides where it lands — the
 * same shape as the WS broadcaster, and for the same reason: one writer, one place to look.
 */
export interface MilestoneAuditEvent {
  type: 'milestone_created' | 'milestone_updated' | 'milestone_deleted';
  action: string;
  detail: string;
  metadata: Record<string, unknown>;
  actorId?: string;
}

export interface CreateMilestoneRequest {  orgId: string;
  projectId: string;
  name: string;
  description?: string;
  /** ISO date (YYYY-MM-DD) or null/undefined for "no deadline". */
  dueDate?: string | null;
  createdBy?: string;
}

export interface UpdateMilestoneRequest {
  name?: string;
  description?: string;
  /** `null` clears the deadline; `undefined` leaves it untouched. */
  dueDate?: string | null;
}

/**
 * Milestones (里程碑) — a project-owned checkpoint grouping requirements.
 *
 * Invariants owned here (see docs/architecture/work-hierarchy.md §invariants):
 * - a milestone always references an existing project (fail-closed, validated on write);
 * - deleting a milestone **unlinks** its requirements (never deletes them);
 * - deleting a project deletes its milestones (`deleteByProject`);
 * - completion is derived, never stored.
 *
 * The cross-entity invariant "a requirement's milestone belongs to the requirement's own
 * project" is owned by `RequirementService` (the writer of that column) — this service only
 * publishes `getMilestone()` for it to consult.
 */
export class MilestoneService {
  private milestones = new Map<string, Milestone>();
  private milestoneRepo?: MilestoneRepo;
  private projectLookup?: MilestoneProjectLookup;
  private requirementBridge?: MilestoneRequirementBridge;
  private ws?: { broadcast: (event: { type: string; payload: unknown; timestamp: string }) => void };
  private auditSink?: (event: MilestoneAuditEvent) => void;

  setMilestoneRepo(repo: MilestoneRepo): void {
    this.milestoneRepo = repo;
  }

  setProjectService(projectLookup: MilestoneProjectLookup): void {
    this.projectLookup = projectLookup;
  }

  setRequirementBridge(bridge: MilestoneRequirementBridge): void {
    this.requirementBridge = bridge;
  }

  setWSBroadcaster(ws: { broadcast: (event: { type: string; payload: unknown; timestamp: string }) => void }): void {
    this.ws = ws;
  }

  /** Who-did-what sink. A throwing sink must never abort the write it describes. */
  setAuditSink(fn: (event: MilestoneAuditEvent) => void): void {
    this.auditSink = fn;
  }

  async loadFromStorage(orgId: string): Promise<void> {
    if (!this.milestoneRepo) return;
    try {
      const rows = this.milestoneRepo.listByOrg(orgId) as Milestone[];
      for (const row of rows) {
        this.milestones.set(row.id, this.normalizeRow(row));
      }
      log.info(`Loaded ${this.milestones.size} milestones from DB`);
    } catch (err) {
      log.warn('Failed to load milestones from DB', { error: String(err) });
    }
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  getMilestone(id: string): Milestone | undefined {
    return this.milestones.get(id);
  }

  listByProject(projectId: string): Milestone[] {
    return [...this.milestones.values()]
      .filter(m => m.projectId === projectId)
      .sort(compareMilestones);
  }

  listByOrg(orgId: string): Milestone[] {
    return [...this.milestones.values()]
      .filter(m => m.orgId === orgId)
      .sort(compareMilestones);
  }

  /**
   * Milestones with derived progress.
   *
   * Ordering is the UI's reading order: milestones with a due date first (earliest first),
   * then undated ones by creation — so "what is next" is the top of the list.
   */
  listWithProgress(filters?: { orgId?: string; projectId?: string; milestoneId?: string }): MilestoneWithProgress[] {
    let list = filters?.projectId
      ? this.listByProject(filters.projectId)
      : filters?.orgId
        ? this.listByOrg(filters.orgId)
        : [...this.milestones.values()];
    if (filters?.milestoneId) list = list.filter(m => m.id === filters.milestoneId);

    // ONE pass over the requirements when the bridge can hand them over; otherwise fall back to
    // a per-milestone scan (O(milestones x requirements)). Same numbers, different cost.
    const all = this.requirementBridge?.listAll?.();
    if (all) {
      const grouped = new Map<string, string[]>();
      for (const r of all) {
        const mid = r.milestoneId;
        if (!mid) continue;
        const bucket = grouped.get(mid);
        if (bucket) bucket.push(r.status as string);
        else grouped.set(mid, [r.status as string]);
      }
      return list.map(m => ({ ...m, progress: computeMilestoneProgress(grouped.get(m.id) ?? []) }));
    }
    return list.map(m => ({ ...m, progress: this.progressOf(m.id) }));
  }

  /** Derived completion of one milestone — delegates to {@link computeMilestoneProgress}. */
  progressOf(milestoneId: string): MilestoneProgress {
    const requirements = this.requirementBridge?.listByMilestone(milestoneId) ?? [];
    return computeMilestoneProgress(requirements.map(r => r.status as string));
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  createMilestone(request: CreateMilestoneRequest): Milestone {
    const name = request.name?.trim();
    if (!name) throw new Error('Milestone name is required and cannot be empty.');
    if (!request.projectId) throw new Error('Milestone must belong to a project (projectId is required).');
    this.assertProjectExists(request.projectId);

    const dueDate = normalizeMilestoneDueDate(request.dueDate ?? null);
    if (dueDate === undefined) {
      throw new Error(
        `Invalid milestone due date "${String(request.dueDate)}" — expected an ISO date (YYYY-MM-DD) or null.`
      );
    }

    const now = new Date().toISOString();
    const milestone: Milestone = {
      id: generateId('ms'),
      orgId: request.orgId,
      projectId: request.projectId,
      name,
      description: request.description?.trim() ?? '',
      dueDate,
      createdBy: request.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    this.milestones.set(milestone.id, milestone);
    if (this.milestoneRepo) {
      this.milestoneRepo
        .create({
          id: milestone.id,
          orgId: milestone.orgId,
          projectId: milestone.projectId,
          name: milestone.name,
          description: milestone.description,
          dueDate: milestone.dueDate,
          createdBy: milestone.createdBy,
        })
        .catch((e: unknown) => log.error('Failed to persist milestone', { id: milestone.id, error: String(e) }));
    }

    this.broadcast('milestone:created', milestone);
    this.audit({
      type: 'milestone_created',
      action: 'create_milestone',
      detail: `Milestone "${milestone.name}" created in project ${milestone.projectId}`,
      metadata: { milestoneId: milestone.id, projectId: milestone.projectId, dueDate: milestone.dueDate },
      actorId: milestone.createdBy,
    });
    log.info('Milestone created', { id: milestone.id, projectId: milestone.projectId });
    return milestone;
  }

  /**
   * Update name / description / due date.
   *
   * `projectId` is deliberately NOT updatable: re-parenting a milestone would silently
   * re-home every requirement pointing at it (and break I2 for all of them at once).
   */
  updateMilestone(id: string, data: UpdateMilestoneRequest, actorId?: string): Milestone {
    const milestone = this.milestones.get(id);
    if (!milestone) throw new Error(`Milestone ${id} not found`);

    const patch: { name?: string; description?: string; dueDate?: string | null } = {};

    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new Error('Milestone name cannot be empty.');
      patch.name = name;
    }
    if (data.description !== undefined) patch.description = data.description.trim();
    if (data.dueDate !== undefined) {
      const dueDate = normalizeMilestoneDueDate(data.dueDate);
      if (dueDate === undefined) {
        throw new Error(
          `Invalid milestone due date "${String(data.dueDate)}" — expected an ISO date (YYYY-MM-DD) or null.`
        );
      }
      patch.dueDate = dueDate;
    }

    if (Object.keys(patch).length === 0) return milestone;

    // Validate before mutating: a rejected call must leave the milestone exactly as it was.
    Object.assign(milestone, patch, { updatedAt: new Date().toISOString() });
    if (this.milestoneRepo) {
      this.milestoneRepo
        .update(id, patch)
        .catch((e: unknown) => log.error('Failed to persist milestone update', { id, error: String(e) }));
    }

    this.broadcast('milestone:updated', milestone);
    this.audit({
      type: 'milestone_updated',
      action: 'update_milestone',
      detail: `Milestone "${milestone.name}" updated (${Object.keys(patch).join(', ')})`,
      metadata: { milestoneId: id, projectId: milestone.projectId, fields: Object.keys(patch) },
      actorId,
    });
    return milestone;
  }

  /**
   * Delete a milestone. Its requirements are **unlinked, not deleted** — requirements outlive
   * their milestone, exactly like tasks outlive a deleted project's scope.
   */
  deleteMilestone(id: string, actorId?: string): { deleted: boolean; detachedRequirements: number } {
    const milestone = this.milestones.get(id);
    if (!milestone) throw new Error(`Milestone ${id} not found`);

    const detachedRequirements = this.requirementBridge?.detachMilestone(id) ?? 0;

    this.milestones.delete(id);
    if (this.milestoneRepo) {
      this.milestoneRepo
        .delete(id)
        .catch((e: unknown) => log.error('Failed to delete milestone', { id, error: String(e) }));
    }

    this.broadcast('milestone:deleted', { id, projectId: milestone.projectId });
    this.audit({
      type: 'milestone_deleted',
      action: 'delete_milestone',
      detail: `Milestone "${milestone.name}" deleted; ${detachedRequirements} requirement(s) unlinked`,
      metadata: { milestoneId: id, projectId: milestone.projectId, detachedRequirements },
      actorId,
    });
    log.info('Milestone deleted', { id, detachedRequirements });
    return { deleted: true, detachedRequirements };
  }

  /**
   * Delete every milestone of a project (called when the project itself is deleted — a
   * milestone cannot outlive its project). Requirements are unlinked first.
   */
  deleteByProject(projectId: string): number {
    const doomed = [...this.milestones.values()].filter(m => m.projectId === projectId);
    for (const milestone of doomed) {
      try {
        this.requirementBridge?.detachMilestone(milestone.id);
      } catch (err) {
        log.warn('Failed to detach requirements while deleting project milestones', {
          milestoneId: milestone.id,
          error: String(err),
        });
      }
      this.milestones.delete(milestone.id);
      if (this.milestoneRepo) {
        this.milestoneRepo
          .delete(milestone.id)
          .catch((e: unknown) => log.error('Failed to delete milestone', { id: milestone.id, error: String(e) }));
      }
    }
    if (doomed.length > 0) {
      this.broadcast('milestone:deleted', { projectId, count: doomed.length });
      log.info('Deleted milestones of project', { projectId, count: doomed.length });
    }
    return doomed.length;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private assertProjectExists(projectId: string): void {
    if (!this.projectLookup) {
      throw new Error(
        'Cannot create a milestone: project lookup is unavailable in this process, so the ' +
          'owning project cannot be verified. Refusing rather than writing an unvalidated ' +
          'project reference.'
      );
    }
    if (!this.projectLookup.getProject(projectId)) {
      throw new Error(
        `Project "${projectId}" does not exist — a milestone pointing at a non-existent project ` +
          'would fall out of every project view. Create the project first, or pass a real project id.'
      );
    }
  }

  private normalizeRow(row: Milestone): Milestone {
    return {
      ...row,
      description: row.description ?? '',
      dueDate: row.dueDate ?? null,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(row.createdAt as unknown as Date).toISOString(),
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date(row.updatedAt as unknown as Date).toISOString(),
    };
  }

  private broadcast(type: string, data: unknown): void {
    if (this.ws) {
      this.ws.broadcast({ type, payload: data, timestamp: new Date().toISOString() });
    }
  }

  /** A failing audit sink must never abort the write it describes. */
  private audit(event: MilestoneAuditEvent): void {
    if (!this.auditSink) return;
    try {
      this.auditSink(event);
    } catch (err) {
      log.warn('Milestone audit sink failed', { type: event.type, error: String(err) });
    }
  }
}

/** Reading order: dated milestones first by date, then undated by creation. */
function compareMilestones(a: Milestone, b: Milestone): number {
  if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate) || a.createdAt.localeCompare(b.createdAt);
  if (a.dueDate) return -1;
  if (b.dueDate) return 1;
  return a.createdAt.localeCompare(b.createdAt);
}
