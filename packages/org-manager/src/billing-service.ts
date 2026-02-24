import { createLogger } from '@markus/shared';
import { randomBytes } from 'node:crypto';

const log = createLogger('billing');

export type PlanTier = 'free' | 'pro' | 'enterprise';

export interface UsageRecord {
  orgId: string;
  agentId: string;
  type: 'llm_tokens' | 'tool_call' | 'message' | 'storage_bytes';
  amount: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface UsageSummary {
  orgId: string;
  period: string;
  llmTokens: number;
  toolCalls: number;
  messages: number;
  storageBytes: number;
}

export interface APIKey {
  id: string;
  key: string;
  orgId: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  scopes: string[];
  active: boolean;
}

export interface OrgPlan {
  orgId: string;
  tier: PlanTier;
  limits: {
    maxAgents: number;
    maxTokensPerMonth: number;
    maxToolCallsPerDay: number;
    maxMessagesPerDay: number;
    maxStorageBytes: number;
  };
}

const DEFAULT_PLANS: Record<PlanTier, OrgPlan['limits']> = {
  free: {
    maxAgents: 3,
    maxTokensPerMonth: 100_000,
    maxToolCallsPerDay: 100,
    maxMessagesPerDay: 50,
    maxStorageBytes: 50 * 1024 * 1024,
  },
  pro: {
    maxAgents: 20,
    maxTokensPerMonth: 5_000_000,
    maxToolCallsPerDay: 5000,
    maxMessagesPerDay: 2000,
    maxStorageBytes: 5 * 1024 * 1024 * 1024,
  },
  enterprise: {
    maxAgents: -1,
    maxTokensPerMonth: -1,
    maxToolCallsPerDay: -1,
    maxMessagesPerDay: -1,
    maxStorageBytes: -1,
  },
};

let keyCounter = 0;

export class BillingService {
  private records: UsageRecord[] = [];
  private apiKeys = new Map<string, APIKey>();
  private apiKeysByKey = new Map<string, APIKey>();
  private orgPlans = new Map<string, OrgPlan>();

  setOrgPlan(orgId: string, tier: PlanTier): OrgPlan {
    const plan: OrgPlan = {
      orgId,
      tier,
      limits: { ...DEFAULT_PLANS[tier] },
    };
    this.orgPlans.set(orgId, plan);
    log.info(`Plan set for org ${orgId}: ${tier}`);
    return plan;
  }

  getOrgPlan(orgId: string): OrgPlan {
    return this.orgPlans.get(orgId) ?? {
      orgId,
      tier: 'free',
      limits: { ...DEFAULT_PLANS.free },
    };
  }

  recordUsage(record: Omit<UsageRecord, 'timestamp'>): UsageRecord {
    const full: UsageRecord = {
      ...record,
      timestamp: new Date().toISOString(),
    };
    this.records.push(full);
    return full;
  }

  getUsageSummary(orgId: string, periodPrefix?: string): UsageSummary {
    const period = periodPrefix ?? new Date().toISOString().slice(0, 7);
    const filtered = this.records.filter(r => r.orgId === orgId && r.timestamp.startsWith(period));

    return {
      orgId,
      period,
      llmTokens: filtered.filter(r => r.type === 'llm_tokens').reduce((s, r) => s + r.amount, 0),
      toolCalls: filtered.filter(r => r.type === 'tool_call').reduce((s, r) => s + r.amount, 0),
      messages: filtered.filter(r => r.type === 'message').reduce((s, r) => s + r.amount, 0),
      storageBytes: filtered.filter(r => r.type === 'storage_bytes').reduce((s, r) => s + r.amount, 0),
    };
  }

  checkLimit(orgId: string, type: UsageRecord['type'], additionalAmount = 1): { allowed: boolean; reason?: string } {
    const plan = this.getOrgPlan(orgId);
    if (plan.tier === 'enterprise') return { allowed: true };

    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);

    if (type === 'llm_tokens') {
      const summary = this.getUsageSummary(orgId, month);
      if (plan.limits.maxTokensPerMonth > 0 && summary.llmTokens + additionalAmount > plan.limits.maxTokensPerMonth) {
        return { allowed: false, reason: `Monthly token limit reached (${plan.limits.maxTokensPerMonth})` };
      }
    }

    if (type === 'tool_call') {
      const todayRecords = this.records.filter(r => r.orgId === orgId && r.type === 'tool_call' && r.timestamp.startsWith(today));
      const todayCount = todayRecords.reduce((s, r) => s + r.amount, 0);
      if (plan.limits.maxToolCallsPerDay > 0 && todayCount + additionalAmount > plan.limits.maxToolCallsPerDay) {
        return { allowed: false, reason: `Daily tool call limit reached (${plan.limits.maxToolCallsPerDay})` };
      }
    }

    if (type === 'message') {
      const todayRecords = this.records.filter(r => r.orgId === orgId && r.type === 'message' && r.timestamp.startsWith(today));
      const todayCount = todayRecords.reduce((s, r) => s + r.amount, 0);
      if (plan.limits.maxMessagesPerDay > 0 && todayCount + additionalAmount > plan.limits.maxMessagesPerDay) {
        return { allowed: false, reason: `Daily message limit reached (${plan.limits.maxMessagesPerDay})` };
      }
    }

    return { allowed: true };
  }

  createAPIKey(orgId: string, name: string, scopes: string[] = ['*'], expiresInDays?: number): APIKey {
    const id = `mk_${(++keyCounter).toString(36)}_${Date.now().toString(36)}`;
    const key = `mk_${randomBytes(32).toString('hex')}`;
    const now = new Date();
    const apiKey: APIKey = {
      id,
      key,
      orgId,
      name,
      createdAt: now.toISOString(),
      expiresAt: expiresInDays ? new Date(now.getTime() + expiresInDays * 86400000).toISOString() : undefined,
      scopes,
      active: true,
    };
    this.apiKeys.set(id, apiKey);
    this.apiKeysByKey.set(key, apiKey);
    log.info(`API key created: ${id} for org ${orgId}`);
    return apiKey;
  }

  validateAPIKey(key: string): APIKey | undefined {
    const apiKey = this.apiKeysByKey.get(key);
    if (!apiKey || !apiKey.active) return undefined;
    if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) return undefined;
    apiKey.lastUsedAt = new Date().toISOString();
    return apiKey;
  }

  revokeAPIKey(id: string): boolean {
    const apiKey = this.apiKeys.get(id);
    if (!apiKey) return false;
    apiKey.active = false;
    log.info(`API key revoked: ${id}`);
    return true;
  }

  listAPIKeys(orgId: string): Array<Omit<APIKey, 'key'> & { keyPreview: string }> {
    return [...this.apiKeys.values()]
      .filter(k => k.orgId === orgId)
      .map(k => ({
        id: k.id,
        orgId: k.orgId,
        name: k.name,
        keyPreview: k.key.slice(0, 7) + '...' + k.key.slice(-4),
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        expiresAt: k.expiresAt,
        scopes: k.scopes,
        active: k.active,
      }));
  }
}
