import { createLogger, generateId, type Deliverable, type TaskDeliverable, type Task } from '@markus/shared';
import type { DeliverableRepo } from '@markus/storage';
import type { WSBroadcaster } from './ws-server.ts';
const log = createLogger('deliverable-service');

export class DeliverableService {
  private cache = new Map<string, Deliverable>();
  private ws?: WSBroadcaster;

  constructor(private repo?: DeliverableRepo) {}

  setWSBroadcaster(ws: WSBroadcaster): void {
    this.ws = ws;
  }

  async load(): Promise<void> {
    if (!this.repo) return;
    const rows = await this.repo.listAll(5000);
    for (const r of rows) {
      this.cache.set(r.id, this.rowToDeliverable(r));
    }
    log.info('Deliverables loaded', { count: this.cache.size });
  }

  async create(opts: {
    type: Deliverable['type'];
    title: string;
    summary: string;
    reference?: string;
    tags?: string[];
    taskId?: string;
    agentId?: string;
    projectId?: string;
    requirementId?: string;
    artifactType?: Deliverable['artifactType'];
    artifactData?: Deliverable['artifactData'];
    diffStats?: Deliverable['diffStats'];
    testResults?: Deliverable['testResults'];
  }): Promise<Deliverable> {
    // Upsert: if reference is non-empty and an active deliverable with the same
    // reference (scoped to projectId) already exists, update it instead of creating a duplicate.
    const ref = opts.reference?.trim();
    if (ref) {
      const existing = this.findByReference(ref, opts.projectId);
      if (existing) {
        const patch: Parameters<typeof this.update>[1] = {
          type: opts.type,
          title: opts.title,
          summary: opts.summary,
          tags: opts.tags ?? existing.tags,
        };
        if (opts.artifactType !== undefined) patch.artifactType = opts.artifactType;
        if (opts.artifactData !== undefined) patch.artifactData = opts.artifactData;
        if (opts.diffStats !== undefined) patch.diffStats = opts.diffStats;
        if (opts.testResults !== undefined) patch.testResults = opts.testResults;
        const updated = await this.update(existing.id, patch);
        log.info('Deliverable upserted (updated existing)', { id: existing.id, reference: ref });
        this.ws?.broadcastDeliverableUpdate(existing.id, 'updated', {
          type: opts.type,
          title: opts.title,
          agentId: opts.agentId,
          projectId: opts.projectId,
          taskId: opts.taskId,
        });
        return updated ?? existing;
      }
    }

    const id = generateId('dlv');
    const now = new Date().toISOString();
    const deliverable: Deliverable = {
      id,
      type: opts.type,
      title: opts.title,
      summary: opts.summary,
      reference: ref ?? '',
      tags: opts.tags ?? [],
      status: 'active',
      taskId: opts.taskId,
      agentId: opts.agentId,
      projectId: opts.projectId,
      requirementId: opts.requirementId,
      artifactType: opts.artifactType,
      artifactData: opts.artifactData,
      diffStats: opts.diffStats,
      testResults: opts.testResults,
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    await this.repo?.create({
      id,
      type: opts.type,
      title: opts.title,
      summary: opts.summary,
      reference: ref ?? '',
      tags: opts.tags ?? [],
      status: 'active',
      taskId: opts.taskId,
      agentId: opts.agentId,
      projectId: opts.projectId,
      requirementId: opts.requirementId,
      artifactType: opts.artifactType,
      artifactData: opts.artifactData,
      diffStats: opts.diffStats as Record<string, number> | undefined,
      testResults: opts.testResults as Record<string, number> | undefined,
    });
    this.cache.set(id, deliverable);
    log.info('Deliverable created', { id, type: opts.type, title: opts.title });
    this.ws?.broadcastDeliverableUpdate(id, 'created', {
      type: opts.type,
      title: opts.title,
      agentId: opts.agentId,
      projectId: opts.projectId,
      taskId: opts.taskId,
    });
    return deliverable;
  }

  get(id: string): Deliverable | undefined {
    const d = this.cache.get(id);
    if (d) {
      d.accessCount++;
      this.repo?.recordAccess(id).catch(() => {});
    }
    return d;
  }

  search(opts: {
    query?: string;
    projectId?: string;
    agentId?: string;
    taskId?: string;
    type?: Deliverable['type'];
    status?: Deliverable['status'];
    artifactType?: Deliverable['artifactType'];
    offset?: number;
    limit?: number;
  }): { results: Deliverable[]; total: number } {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    const queryLower = opts.query?.toLowerCase();
    const keywords = queryLower ? queryLower.split(/\s+/).filter(Boolean) : [];

    let filtered = [...this.cache.values()];

    if (opts.projectId) filtered = filtered.filter(d => d.projectId === opts.projectId);
    if (opts.agentId) filtered = filtered.filter(d => d.agentId === opts.agentId);
    if (opts.taskId) filtered = filtered.filter(d => d.taskId === opts.taskId);
    if (opts.type) filtered = filtered.filter(d => d.type === opts.type);
    if (opts.status) filtered = filtered.filter(d => d.status === opts.status);
    else filtered = filtered.filter(d => d.status !== 'outdated');
    if (opts.artifactType) filtered = filtered.filter(d => d.artifactType === opts.artifactType);

    if (keywords.length === 0) {
      filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { results: filtered.slice(offset, offset + limit), total: filtered.length };
    }

    const scored = filtered.map(d => {
      const text = `${d.title} ${d.summary} ${d.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) score += 1;
        if (d.title.toLowerCase().includes(kw)) score += 2;
      }
      if (d.status === 'verified') score += 0.5;
      return { d, score };
    });

    const matched = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    return {
      results: matched.slice(offset, offset + limit).map(s => s.d),
      total: matched.length,
    };
  }

  async update(id: string, data: Partial<{
    type: Deliverable['type'];
    title: string;
    summary: string;
    reference: string;
    tags: string[];
    status: Deliverable['status'];
    artifactType: Deliverable['artifactType'];
    artifactData: Deliverable['artifactData'];
    diffStats: Deliverable['diffStats'];
    testResults: Deliverable['testResults'];
  }>): Promise<Deliverable | undefined> {
    const d = this.cache.get(id);
    if (!d) return undefined;

    const now = new Date().toISOString();
    if (data.type !== undefined) d.type = data.type;
    if (data.title !== undefined) d.title = data.title;
    if (data.summary !== undefined) d.summary = data.summary;
    if (data.reference !== undefined) d.reference = data.reference;
    if (data.tags !== undefined) d.tags = data.tags;
    if (data.status !== undefined) d.status = data.status;
    if (data.artifactType !== undefined) d.artifactType = data.artifactType;
    if (data.artifactData !== undefined) d.artifactData = data.artifactData;
    if (data.diffStats !== undefined) d.diffStats = data.diffStats;
    if (data.testResults !== undefined) d.testResults = data.testResults;
    d.updatedAt = now;

    await this.repo?.update(id, data);
    log.info('Deliverable updated', { id, fields: Object.keys(data) });
    this.ws?.broadcastDeliverableUpdate(id, 'updated', {
      type: d.type,
      title: d.title,
      agentId: d.agentId,
      projectId: d.projectId,
      taskId: d.taskId,
    });
    return d;
  }

  async flagOutdated(id: string): Promise<void> {
    const d = this.cache.get(id);
    if (!d) return;
    d.status = 'outdated';
    d.updatedAt = new Date().toISOString();
    await this.repo?.update(id, { status: 'outdated' });
    log.info('Deliverable flagged outdated', { id });
    this.ws?.broadcastDeliverableUpdate(id, 'removed', {
      type: d.type,
      title: d.title,
      projectId: d.projectId,
    });
  }

  async remove(id: string): Promise<void> {
    await this.flagOutdated(id);
  }

  findByReference(reference: string, projectId?: string): Deliverable | undefined {
    for (const d of this.cache.values()) {
      if (d.status === 'outdated') continue;
      if (d.reference !== reference) continue;
      if (projectId !== undefined && d.projectId !== projectId) continue;
      return d;
    }
    return undefined;
  }

  findByTask(taskId: string): Deliverable[] {
    return [...this.cache.values()].filter(d => d.taskId === taskId && d.status !== 'outdated');
  }

  findByProject(projectId: string): Deliverable[] {
    return [...this.cache.values()].filter(d => d.projectId === projectId && d.status !== 'outdated');
  }

  findByAgent(agentId: string): Deliverable[] {
    return [...this.cache.values()].filter(d => d.agentId === agentId && d.status !== 'outdated');
  }

  getAll(): Deliverable[] {
    return [...this.cache.values()].filter(d => d.status !== 'outdated');
  }

  list(opts: {
    projectId?: string;
    agentId?: string;
    type?: string;
    status?: string;
    limit?: number;
  }): Deliverable[] {
    return this.search({
      ...opts,
      type: opts.type as Deliverable['type'],
      status: opts.status as Deliverable['status'],
    }).results;
  }

  async deduplicateByReference(): Promise<number> {
    const byRef = new Map<string, Deliverable[]>();
    for (const d of this.cache.values()) {
      if (d.status === 'outdated' || !d.reference) continue;
      const key = `${d.reference}||${d.projectId ?? ''}`;
      if (!byRef.has(key)) byRef.set(key, []);
      byRef.get(key)!.push(d);
    }
    let cleaned = 0;
    for (const [, dupes] of byRef) {
      if (dupes.length <= 1) continue;
      dupes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (let i = 1; i < dupes.length; i++) {
        await this.flagOutdated(dupes[i]!.id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.info('Deduplicated deliverables by reference', { cleaned });
    }
    return cleaned;
  }

  /**
   * One-time migration: scan existing tasks and create Deliverable entries
   * for any task.deliverables that don't yet have a corresponding row.
   * Also cleans up any legacy "branch"-type deliverables by marking them outdated.
   */
  async migrateFromTasks(tasks: Task[]): Promise<number> {
    // Clean up legacy branch-type deliverables (branch is task metadata, not a standalone deliverable)
    let branchCleaned = 0;
    for (const [id, d] of this.cache) {
      if ((d.type as string) === 'branch' && d.status !== 'outdated') {
        d.status = 'outdated';
        d.updatedAt = new Date().toISOString();
        await this.repo?.update(id, { status: 'outdated' });
        branchCleaned++;
      }
    }
    if (branchCleaned > 0) {
      log.info('Cleaned up legacy branch-type deliverables', { count: branchCleaned });
    }

    // Query ALL task IDs that have ever had deliverables (including outdated/deleted)
    // so we don't re-import items the user already removed.
    const existingTaskIds = this.repo
      ? await this.repo.listTaskIdsWithDeliverables()
      : new Set([...this.cache.values()].map(d => d.taskId).filter(Boolean) as string[]);

    let migrated = 0;
    for (const task of tasks) {
      if (!task.deliverables?.length) continue;
      if (existingTaskIds.has(task.id)) continue;

      for (const d of task.deliverables) {
        if (d.type === 'branch') continue;
        try {
          await this.create({
            type: this.mapTaskDeliverableType(d.type),
            title: d.summary?.slice(0, 200) || d.reference,
            summary: d.summary || '',
            reference: d.reference,
            taskId: task.id,
            agentId: task.assignedAgentId,
            projectId: task.projectId,
            requirementId: task.requirementId,
            diffStats: d.diffStats,
            testResults: d.testResults,
          });
          migrated++;
        } catch (err) {
          log.warn('Failed to migrate task deliverable', { taskId: task.id, ref: d.reference, error: String(err) });
        }
      }
    }

    if (migrated > 0) {
      log.info('Migrated task deliverables to unified table', { migrated });
    }
    return migrated;
  }

  private parseTags(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw !== 'string' || !raw) return [];
    try {
      let parsed = JSON.parse(raw);
      // Handle double-encoded JSON: if parse result is a string, parse again
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through */ }
    return [];
  }

  private mapTaskDeliverableType(type: TaskDeliverable['type']): Deliverable['type'] {
    switch (type) {
      case 'file': return 'file';
      default: return 'file';
    }
  }

  private rowToDeliverable(r: {
    id: string;
    type: string;
    title: string;
    summary: string;
    reference: string;
    tags: unknown;
    status: string;
    taskId: string | null;
    agentId: string | null;
    projectId: string | null;
    requirementId: string | null;
    artifactType?: string | null;
    artifactData?: unknown;
    diffStats: unknown;
    testResults: unknown;
    accessCount: number;
    createdAt: Date | string;
    updatedAt: Date | string;
  }): Deliverable {
    return {
      id: r.id,
      type: r.type as Deliverable['type'],
      title: r.title,
      summary: r.summary,
      reference: r.reference,
      tags: this.parseTags(r.tags),
      status: r.status as Deliverable['status'],
      taskId: r.taskId ?? undefined,
      agentId: r.agentId ?? undefined,
      projectId: r.projectId ?? undefined,
      requirementId: r.requirementId ?? undefined,
      artifactType: (r.artifactType as Deliverable['artifactType']) ?? undefined,
      artifactData: (r.artifactData as Deliverable['artifactData']) ?? undefined,
      diffStats: r.diffStats as Deliverable['diffStats'],
      testResults: r.testResults as Deliverable['testResults'],
      accessCount: r.accessCount,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString(),
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : r.updatedAt.toISOString(),
    };
  }
}
