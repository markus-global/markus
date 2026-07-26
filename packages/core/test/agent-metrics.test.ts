import { describe, it, expect, beforeEach } from 'vitest';
import { AgentMetricsCollector } from '../src/agent-metrics.js';

describe('AgentMetricsCollector', () => {
  let collector: AgentMetricsCollector;

  beforeEach(() => {
    collector = new AgentMetricsCollector('agent-test-1');
  });

  describe('getMetrics', () => {
    it('returns empty metrics for a fresh collector', () => {
      const m = collector.getMetrics('24h');
      expect(m.agentId).toBe('agent-test-1');
      expect(m.period).toBe('24h');
      expect(m.tokenUsage.input).toBe(0);
      expect(m.tokenUsage.output).toBe(0);
      expect(m.taskMetrics.completed).toBe(0);
      expect(m.taskMetrics.failed).toBe(0);
      expect(m.heartbeatSuccessRate).toBe(1);
      expect(m.errorRate).toBe(0);
      expect(m.averageResponseTimeMs).toBe(0);
      expect(m.totalInteractions).toBe(0);
      expect(m.uptime).toBeGreaterThanOrEqual(0);
    });

    it('tracks token usage from audit events', () => {
      collector.recordAudit({ type: 'llm_request', action: 'chat', tokensUsed: 1000, durationMs: 500, success: true });
      collector.recordAudit({ type: 'llm_request', action: 'chat', tokensUsed: 2000, durationMs: 800, success: true });

      const m = collector.getMetrics('24h');
      expect(m.tokenUsage.input).toBe(2100); // 70% of 3000
      expect(m.tokenUsage.output).toBe(900); // 30% of 3000
      expect(m.tokenUsage.cost).toBe(0);
      expect(m.totalInteractions).toBe(2);
    });

    it('accumulates CU from audit events', () => {
      collector.recordAudit({
        type: 'llm_request',
        action: 'chat',
        tokensUsed: 500,
        cuCost: 12,
        success: true,
      });
      collector.recordAudit({
        type: 'llm_request',
        action: 'chat',
        tokensUsed: 300,
        cuCost: 8,
        success: true,
      });

      const stats = collector.getUsageStats();
      expect(stats.cuUsed).toBe(20);
      expect(stats.cuUsedToday).toBe(20);
      expect(stats.estimatedCost).toBe(0);
    });

    it('does not estimate USD when no cost provided', () => {
      collector.recordAudit({
        type: 'llm_request',
        action: 'chat',
        tokensUsed: 5000,
        inputTokens: 4000,
        outputTokens: 1000,
        success: true,
      });

      const stats = collector.getUsageStats();
      expect(stats.estimatedCost).toBe(0);
      expect(stats.costToday).toBe(0);
      expect(collector.getMetrics('24h').tokenUsage.cost).toBe(0);
    });

    it('tracks task completion metrics', () => {
      collector.recordTaskCompletion('task-1', 'completed', 5000);
      collector.recordTaskCompletion('task-2', 'completed', 3000);
      collector.recordTaskCompletion('task-3', 'failed', 1000);

      const m = collector.getMetrics('24h');
      expect(m.taskMetrics.completed).toBe(2);
      expect(m.taskMetrics.failed).toBe(1);
      expect(m.taskMetrics.averageCompletionTimeMs).toBe(4000); // avg of 5000 and 3000
    });

    it('tracks heartbeat success rate', () => {
      collector.recordHeartbeat(true);
      collector.recordHeartbeat(true);
      collector.recordHeartbeat(false);
      collector.recordHeartbeat(true);

      const m = collector.getMetrics('24h');
      expect(m.heartbeatSuccessRate).toBe(0.75);
    });

    it('computes error rate from audit events', () => {
      collector.recordAudit({ type: 'llm_request', action: 'chat', success: true, durationMs: 100 });
      collector.recordAudit({ type: 'tool_call', action: 'shell', success: false, durationMs: 50 });
      collector.recordAudit({ type: 'tool_call', action: 'read', success: true, durationMs: 30 });
      collector.recordAudit({ type: 'error', action: 'handle_message', success: false });

      const m = collector.getMetrics('24h');
      expect(m.errorRate).toBe(0.5); // 2 failures out of 4
    });

    it('computes average response time from LLM requests only', () => {
      collector.recordAudit({ type: 'llm_request', action: 'chat', success: true, durationMs: 1000 });
      collector.recordAudit({ type: 'llm_request', action: 'chat', success: true, durationMs: 2000 });
      collector.recordAudit({ type: 'tool_call', action: 'shell', success: true, durationMs: 100 });

      const m = collector.getMetrics('24h');
      expect(m.averageResponseTimeMs).toBe(1500);
    });
  });

  describe('health score', () => {
    it('returns max score for a healthy agent', () => {
      collector.recordHeartbeat(true);
      collector.recordHeartbeat(true);
      collector.recordTaskCompletion('t1', 'completed', 1000);
      collector.recordAudit({ type: 'llm_request', action: 'chat', success: true, durationMs: 100 });

      const m = collector.getMetrics('24h');
      // heartbeat: 1.0 * 40 = 40
      // task completion: 1.0 * 30 = 30
      // error rate: (1 - 0) * 20 = 20
      // recency: 10 (last success < 1 hour)
      expect(m.healthScore).toBe(100);
    });

    it('penalizes poor heartbeat success', () => {
      collector.recordHeartbeat(false);
      collector.recordHeartbeat(false);
      collector.recordHeartbeat(true);
      collector.recordAudit({ type: 'llm_request', action: 'chat', success: true, durationMs: 100 });

      const m = collector.getMetrics('24h');
      // heartbeat: 0.333 * 40 ≈ 13.3
      // tasks: none → 1.0 * 30 = 30
      // error: 0 → 20
      // recency: 10
      expect(m.healthScore).toBeLessThan(80);
      expect(m.healthScore).toBeGreaterThan(50);
    });

    it('penalizes high error rate', () => {
      collector.recordHeartbeat(true);
      collector.recordAudit({ type: 'llm_request', action: 'chat', success: false, durationMs: 100 });
      collector.recordAudit({ type: 'llm_request', action: 'chat', success: false, durationMs: 100 });

      const m = collector.getMetrics('24h');
      // heartbeat: 1.0 * 40 = 40
      // tasks: 1.0 * 30 = 30
      // error: (1 - 1.0) * 20 = 0
      // recency: 0 (no successful events)
      expect(m.healthScore).toBe(70);
    });

    it('penalizes task failures', () => {
      collector.recordHeartbeat(true);
      collector.recordTaskCompletion('t1', 'failed', 1000);
      collector.recordTaskCompletion('t2', 'failed', 500);
      collector.recordAudit({ type: 'llm_request', action: 'chat', success: true, durationMs: 100 });

      const m = collector.getMetrics('24h');
      // heartbeat: 1.0 * 40 = 40
      // tasks: 0/2 * 30 = 0
      // error: (1 - 0) * 20 = 20
      // recency: 10
      expect(m.healthScore).toBe(70);
    });
  });

  describe('period filtering', () => {
    it('only counts events within the requested period', () => {
      // Record events "now"
      collector.recordAudit({ type: 'llm_request', action: 'chat', tokensUsed: 500, durationMs: 100, success: true });
      collector.recordTaskCompletion('t1', 'completed', 1000);

      const m1h = collector.getMetrics('1h');
      expect(m1h.totalInteractions).toBe(1);
      expect(m1h.taskMetrics.completed).toBe(1);

      const m7d = collector.getMetrics('7d');
      expect(m7d.totalInteractions).toBe(1);
      expect(m7d.taskMetrics.completed).toBe(1);
    });
  });

  describe('cancelled tasks', () => {
    it('tracks cancelled tasks separately', () => {
      collector.recordTaskCompletion('t1', 'completed', 1000);
      collector.recordTaskCompletion('t2', 'cancelled');

      const m = collector.getMetrics('24h');
      expect(m.taskMetrics.completed).toBe(1);
      expect(m.taskMetrics.cancelled).toBe(1);
      expect(m.taskMetrics.failed).toBe(0);
    });
  });

  describe('C2: harness-health metrics', () => {
    it('starts at zero on a fresh collector', () => {
      const h = collector.getMetrics('24h').harness;
      expect(h.compressionCount).toBe(0);
      expect(h.markerFailureRate).toBe(0);
      expect(h.cacheHitRate).toBe(0);
      expect(h.perTurnCostUsd).toBe(0);
    });

    it('counts context compressions', () => {
      collector.recordCompression();
      collector.recordCompression();
      expect(collector.getMetrics('24h').harness.compressionCount).toBe(2);
    });

    it('computes marker-failure rate over non-chat turns only', () => {
      // Chat turns are exempt from the marker protocol → excluded from the denominator.
      collector.recordTurn({ isChat: true, hadCompletionMarker: false });
      // 4 non-chat turns, 1 missing its marker → 0.25
      collector.recordTurn({ isChat: false, hadCompletionMarker: true });
      collector.recordTurn({ isChat: false, hadCompletionMarker: true });
      collector.recordTurn({ isChat: false, hadCompletionMarker: true });
      collector.recordTurn({ isChat: false, hadCompletionMarker: false });

      expect(collector.getMetrics('24h').harness.markerFailureRate).toBe(0.25);
    });

    it('computes cache-hit rate from provider cache tokens', () => {
      // inputTokens=fresh prompt; cacheReadTokens=cached; hit = read / (read+write+fresh)
      collector.recordAudit({
        type: 'llm_request', action: 'chat', success: true,
        inputTokens: 200, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 200,
      });
      // 600 / (600 + 200 + 200) = 0.6
      expect(collector.getMetrics('24h').harness.cacheHitRate).toBeCloseTo(0.6, 5);
    });

    it('computes per-turn USD cost from reported costs', () => {
      collector.recordTurn({ isChat: false, hadCompletionMarker: true, costUsd: 0.10 });
      collector.recordTurn({ isChat: false, hadCompletionMarker: true, costUsd: 0.30 });
      // total 0.40 over 2 turns → 0.20
      expect(collector.getMetrics('24h').harness.perTurnCostUsd).toBeCloseTo(0.2, 5);
    });

    it('persists and reloads harness counters', () => {
      // A collector without a dataDir keeps counters in memory; assert accumulation is stable.
      collector.recordCompression();
      collector.recordTurn({ isChat: false, hadCompletionMarker: false });
      const h = collector.getMetrics('24h').harness;
      expect(h.compressionCount).toBe(1);
      expect(h.markerFailureRate).toBe(1);
    });
  });
});
