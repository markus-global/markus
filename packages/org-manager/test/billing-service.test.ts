import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BillingService } from '../src/billing-service.js';

describe('BillingService', () => {
  let service: BillingService;

  beforeEach(() => {
    service = new BillingService();
  });

  describe('usage recording', () => {
    it('records usage and summarizes by period', () => {
      service.recordUsage({ orgId: 'org-1', agentId: 'agent-1', type: 'llm_tokens', amount: 1000 });
      service.recordUsage({ orgId: 'org-1', agentId: 'agent-1', type: 'tool_call', amount: 5 });
      service.recordUsage({ orgId: 'org-1', agentId: 'agent-2', type: 'message', amount: 2 });

      const month = new Date().toISOString().slice(0, 7);
      const summary = service.getUsageSummary('org-1', month);
      expect(summary.llmTokens).toBe(1000);
      expect(summary.toolCalls).toBe(5);
      expect(summary.messages).toBe(2);
    });

    it('returns agent breakdown', () => {
      service.recordUsage({ orgId: 'org-1', agentId: 'agent-1', type: 'llm_tokens', amount: 500 });
      service.recordUsage({ orgId: 'org-1', agentId: 'agent-2', type: 'llm_tokens', amount: 300 });
      const breakdown = service.getAgentBreakdown('org-1');
      expect(breakdown).toHaveLength(2);
      expect(breakdown.find(b => b.agentId === 'agent-1')?.llmTokens).toBe(500);
    });

    it('computes project and task costs', () => {
      service.recordUsage({
        orgId: 'org-1', agentId: 'agent-1', type: 'llm_tokens', amount: 1000,
        projectId: 'proj-1', taskId: 'task-1',
      });
      service.recordUsage({
        orgId: 'org-1', agentId: 'agent-1', type: 'tool_call', amount: 3,
        projectId: 'proj-1', taskId: 'task-1',
      });

      const projectCost = service.getProjectCostBreakdown('proj-1');
      expect(projectCost.totalTokens).toBe(1000);
      expect(projectCost.totalToolCalls).toBe(3);
      expect(projectCost.estimatedCost).toBeCloseTo(0.003);

      const taskCost = service.getTaskCost('task-1');
      expect(taskCost.tokens).toBe(1000);
      expect(taskCost.toolCalls).toBe(3);
    });

    it('summarizes usage for custom period', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
      const start = new Date('2026-01-01T00:00:00.000Z');
      const end = new Date('2026-01-31T23:59:59.999Z');
      service.recordUsage({ orgId: 'org-1', agentId: 'agent-1', type: 'llm_tokens', amount: 200 });
      const summary = service.getUsageSummaryForPeriod('org-1', start, end);
      expect(summary.llmTokens).toBe(200);
      vi.useRealTimers();
    });
  });

  describe('API key management', () => {
    it('creates, validates, lists, and revokes keys', () => {
      const created = service.createAPIKey('org-1', 'CI Key', ['read'], 30);
      expect(created.key).toMatch(/^mk_/);
      expect(created.orgId).toBe('org-1');
      expect(created.scopes).toEqual(['read']);

      const validated = service.validateAPIKey(created.key);
      expect(validated?.id).toBe(created.id);
      expect(validated?.lastUsedAt).toBeDefined();

      const listed = service.listAPIKeys('org-1');
      expect(listed).toHaveLength(1);
      expect(listed[0]?.keyPreview).toContain('...');

      expect(service.revokeAPIKey(created.id)).toBe(true);
      expect(service.validateAPIKey(created.key)).toBeUndefined();
      expect(service.revokeAPIKey('missing')).toBe(false);
    });
  });

  describe('plan limits', () => {
    it('sets and returns org plan', () => {
      const plan = service.setOrgPlan('org-1', 'enterprise');
      expect(plan.tier).toBe('enterprise');
      expect(service.getOrgPlan('org-1').tier).toBe('enterprise');
    });

    it('allows enterprise usage without limits', () => {
      service.setOrgPlan('org-1', 'enterprise');
      expect(service.checkLimit('org-1', 'tool_call', 9999)).toEqual({ allowed: true });
    });

    it('enforces free tier tool call limit', () => {
      service.setOrgPlan('org-1', 'free');
      for (let i = 0; i < 500; i++) {
        service.recordUsage({ orgId: 'org-1', agentId: 'a', type: 'tool_call', amount: 1 });
      }
      const result = service.checkLimit('org-1', 'tool_call', 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Daily tool call limit/);
    });

    it('uses toolCallsTodayProvider when set', () => {
      service.setOrgPlan('org-1', 'free');
      service.setToolCallsTodayProvider(() => 499);
      expect(service.checkLimit('org-1', 'tool_call', 1).allowed).toBe(true);
      expect(service.checkLimit('org-1', 'tool_call', 2).allowed).toBe(false);
    });
  });
});
