import { createLogger } from '@markus/shared';

const log = createLogger('audit');

export type AuditEventType =
  | 'agent_message'
  | 'tool_call'
  | 'llm_request'
  | 'task_update'
  | 'agent_hire'
  | 'agent_fire'
  | 'approval_request'
  | 'approval_response'
  | 'error'
  | 'system'
  // Governance events
  | 'task_approval_requested'
  | 'task_approval_granted'
  | 'task_approval_rejected'
  | 'task_submitted_for_review'
  | 'task_review_accepted'
  | 'task_review_revision_requested'
  | 'task_branch_merged'
  | 'system_pause_all'
  | 'system_resume_all'
  | 'system_emergency_stop'
  | 'announcement_broadcast'
  | 'trust_level_changed'
  | 'project_created'
  | 'knowledge_contributed'
  | 'report_generated'
  | 'plan_approved'
  | 'plan_rejected'
  | 'feedback_submitted';

export interface AuditEntry {
  id: string;
  timestamp: string;
  orgId: string;
  agentId?: string;
  userId?: string;
  type: AuditEventType;
  action: string;
  detail?: string;
  metadata?: Record<string, unknown>;
  tokensUsed?: number;
  durationMs?: number;
  success: boolean;
  taskId?: string;
  projectId?: string;
}

export interface TokenUsage {
  orgId: string;
  agentId: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
  lastUpdated: string;
}

/** Minimal DB repository interface for persisting audit logs */
export interface AuditLogRepository {
  insert(row: {
    id: string;
    orgId: string;
    agentId?: string;
    userId?: string;
    type: string;
    action: string;
    detail?: string;
    metadata?: Record<string, unknown>;
    tokensUsed?: number;
    durationMs?: number;
    success: boolean;
    createdAt: Date;
  }): Promise<void>;
}

let entryCounter = 0;

export class AuditService {
  private entries: AuditEntry[] = [];
  private tokenUsage = new Map<string, TokenUsage>();
  private db?: AuditLogRepository;

  setRepository(db: AuditLogRepository): void {
    this.db = db;
    log.info('Audit persistence enabled — events will be written to DB');
  }

  record(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const full: AuditEntry = {
      ...entry,
      id: `aud_${(++entryCounter).toString(36)}_${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(full);

    if (this.entries.length > 10000) {
      this.entries = this.entries.slice(-5000);
    }

    if (this.db) {
      this.db
        .insert({
          id: full.id,
          orgId: full.orgId,
          agentId: full.agentId,
          userId: full.userId,
          type: full.type,
          action: full.action,
          detail: full.detail,
          metadata: full.metadata,
          tokensUsed: full.tokensUsed,
          durationMs: full.durationMs,
          success: full.success,
          createdAt: new Date(full.timestamp),
        })
        .catch(err =>
          log.warn('Failed to persist audit entry', { id: full.id, error: String(err) })
        );
    }

    return full;
  }

  recordLLMUsage(
    orgId: string,
    agentId: string,
    promptTokens: number,
    completionTokens: number
  ): void {
    const key = `${orgId}:${agentId}`;
    const existing = this.tokenUsage.get(key);
    if (existing) {
      existing.totalTokens += promptTokens + completionTokens;
      existing.promptTokens += promptTokens;
      existing.completionTokens += completionTokens;
      existing.requestCount += 1;
      existing.lastUpdated = new Date().toISOString();
    } else {
      this.tokenUsage.set(key, {
        orgId,
        agentId,
        totalTokens: promptTokens + completionTokens,
        promptTokens,
        completionTokens,
        requestCount: 1,
        lastUpdated: new Date().toISOString(),
      });
    }
  }

  getTokenUsage(orgId?: string, agentId?: string): TokenUsage[] {
    let results = [...this.tokenUsage.values()];
    if (orgId) results = results.filter(t => t.orgId === orgId);
    if (agentId) results = results.filter(t => t.agentId === agentId);
    return results;
  }

  getTotalTokens(orgId: string): number {
    return this.getTokenUsage(orgId).reduce((s, t) => s + t.totalTokens, 0);
  }

  query(opts?: {
    orgId?: string;
    agentId?: string;
    type?: AuditEventType;
    limit?: number;
    since?: string;
  }): AuditEntry[] {
    let results = [...this.entries];

    if (opts?.orgId) results = results.filter(e => e.orgId === opts.orgId);
    if (opts?.agentId) results = results.filter(e => e.agentId === opts.agentId);
    if (opts?.type) results = results.filter(e => e.type === opts.type);
    if (opts?.since) results = results.filter(e => e.timestamp >= opts.since!);

    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (opts?.limit) results = results.slice(0, opts.limit);

    return results;
  }

  summary(orgId: string): {
    totalEvents: number;
    totalTokens: number;
    eventsByType: Record<string, number>;
    errorCount: number;
    agentActivity: Array<{ agentId: string; events: number; tokens: number }>;
  } {
    const orgEntries = this.entries.filter(e => e.orgId === orgId);

    const eventsByType: Record<string, number> = {};
    let errorCount = 0;
    const agentEvents = new Map<string, number>();

    for (const e of orgEntries) {
      eventsByType[e.type] = (eventsByType[e.type] ?? 0) + 1;
      if (!e.success) errorCount++;
      if (e.agentId) {
        agentEvents.set(e.agentId, (agentEvents.get(e.agentId) ?? 0) + 1);
      }
    }

    const tokenData = this.getTokenUsage(orgId);
    const agentActivity = [...agentEvents.entries()].map(([agentId, events]) => ({
      agentId,
      events,
      tokens: tokenData.find(t => t.agentId === agentId)?.totalTokens ?? 0,
    }));

    return {
      totalEvents: orgEntries.length,
      totalTokens: this.getTotalTokens(orgId),
      eventsByType,
      errorCount,
      agentActivity,
    };
  }
}
