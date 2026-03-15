import { createLogger, generateId, type Deliverable } from '@markus/shared';
import type { DeliverableRepo } from '@markus/storage';

const log = createLogger('deliverable-service');

export class DeliverableService {
  private cache = new Map<string, Deliverable>();

  constructor(private repo?: DeliverableRepo) {}

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
    diffStats?: Deliverable['diffStats'];
    testResults?: Deliverable['testResults'];
  }): Promise<Deliverable> {
    const id = generateId('dlv');
    const now = new Date().toISOString();
    const deliverable: Deliverable = {
      id,
      type: opts.type,
      title: opts.title,
      summary: opts.summary,
      reference: opts.reference ?? '',
      tags: opts.tags ?? [],
      status: 'active',
      taskId: opts.taskId,
      agentId: opts.agentId,
      projectId: opts.projectId,
      requirementId: opts.requirementId,
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
      reference: opts.reference,
      tags: opts.tags,
      taskId: opts.taskId,
      agentId: opts.agentId,
      projectId: opts.projectId,
      requirementId: opts.requirementId,
      diffStats: opts.diffStats as Record<string, number> | undefined,
      testResults: opts.testResults as Record<string, number> | undefined,
    });
    this.cache.set(id, deliverable);
    log.info('Deliverable created', { id, type: opts.type, title: opts.title });
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
    limit?: number;
  }): Deliverable[] {
    const limit = opts.limit ?? 100;
    const queryLower = opts.query?.toLowerCase();
    const keywords = queryLower ? queryLower.split(/\s+/).filter(Boolean) : [];

    let results = [...this.cache.values()];

    if (opts.projectId) results = results.filter(d => d.projectId === opts.projectId);
    if (opts.agentId) results = results.filter(d => d.agentId === opts.agentId);
    if (opts.taskId) results = results.filter(d => d.taskId === opts.taskId);
    if (opts.type) results = results.filter(d => d.type === opts.type);
    if (opts.status) results = results.filter(d => d.status === opts.status);
    else results = results.filter(d => d.status !== 'outdated');

    if (keywords.length === 0) {
      return results
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
    }

    const scored = results.map(d => {
      const text = `${d.title} ${d.summary} ${d.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) score += 1;
        if (d.title.toLowerCase().includes(kw)) score += 2;
      }
      if (d.status === 'verified') score += 0.5;
      return { d, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.d);
  }

  async update(id: string, data: Partial<{
    type: Deliverable['type'];
    title: string;
    summary: string;
    reference: string;
    tags: string[];
    status: Deliverable['status'];
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
    d.updatedAt = now;

    await this.repo?.update(id, data);
    log.info('Deliverable updated', { id, fields: Object.keys(data) });
    return d;
  }

  async flagOutdated(id: string): Promise<void> {
    const d = this.cache.get(id);
    if (!d) return;
    d.status = 'outdated';
    d.updatedAt = new Date().toISOString();
    await this.repo?.update(id, { status: 'outdated' });
    log.info('Deliverable flagged outdated', { id });
  }

  async remove(id: string): Promise<void> {
    await this.flagOutdated(id);
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
    });
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
      tags: Array.isArray(r.tags) ? r.tags : JSON.parse(String(r.tags || '[]')),
      status: r.status as Deliverable['status'],
      taskId: r.taskId ?? undefined,
      agentId: r.agentId ?? undefined,
      projectId: r.projectId ?? undefined,
      requirementId: r.requirementId ?? undefined,
      diffStats: r.diffStats as Deliverable['diffStats'],
      testResults: r.testResults as Deliverable['testResults'],
      accessCount: r.accessCount,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString(),
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : r.updatedAt.toISOString(),
    };
  }
}
