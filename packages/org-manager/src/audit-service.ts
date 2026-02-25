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
  | 'bounty_post'
  | 'error'
  | 'system';

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

let entryCounter = 0;

export class AuditService {
  private entries: AuditEntry[] = [];
  private tokenUsage = new Map<string, TokenUsage>();

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

    return full;
  }

  recordLLMUsage(orgId: string, agentId: string, promptTokens: number, completionTokens: number): void {
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
