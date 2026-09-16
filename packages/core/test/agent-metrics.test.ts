import { describe, it, expect, beforeEach } from 'vitest';
import {
  AgentMetricsCollector,
  MAX_CACHE_WINDOW_SESSIONS,
  MAX_CACHE_WINDOW_SAMPLES_PER_SESSION,
} from '../src/agent-metrics.js';

/** Shorthand for a reported (or compat) llm_request audit. */
function llmReport(opts: {
  sessionId?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  tokensUsed?: number;
}) {
  return {
    type: 'llm_request',
    action: 'chat',
    success: true,
    tokensUsed: opts.tokensUsed ?? (opts.inputTokens ?? 0) + (opts.outputTokens ?? 0),
    ...opts,
  } as const;
}

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

    it('computes cache hit rate from cacheReadTokens over promptTokens', () => {
      collector.recordAudit({
        type: 'llm_request', action: 'chat', success: true,
        inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800,
      });
      const stats = collector.getUsageStats();
      expect(stats.cacheReadTokens).toBe(800);
      expect(stats.cacheHitRate).toBeCloseTo(0.8);
      const m = collector.getMetrics('24h');
      expect(m.harness.cacheHitRate).toBeCloseTo(0.8);
    });

    it('clamps cache hit rate to 1 when reads exceed prompt tokens', () => {
      collector.recordAudit({
        type: 'llm_request', action: 'chat', success: true,
        inputTokens: 100, outputTokens: 10, cacheReadTokens: 300,
      });
      expect(collector.getUsageStats().cacheHitRate).toBe(1);
    });

    it('returns 0 cache hit rate when nothing cacheable reported', () => {
      collector.recordAudit({
        type: 'llm_request', action: 'chat', success: true,
        inputTokens: 100, outputTokens: 10,
      });
      expect(collector.getUsageStats().cacheHitRate).toBe(0);
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
      // OpenAI-compatible semantics: cache reads are already part of inputTokens (prompt),
      // so hit = cacheRead / promptTokens. Here inputTokens=200 but cacheRead=600 (> prompt,
      // possible when a provider mixes shapes) → clamped to 1.
      collector.recordAudit({
        type: 'llm_request', action: 'chat', success: true,
        inputTokens: 200, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 200,
      });
      expect(collector.getMetrics('24h').harness.cacheHitRate).toBe(1);
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

  describe('reported-only cache-hit window (per-session)', () => {
    it('returns null window with 0 samples when the provider reports nothing', () => {
      // No `inputTokens` ⇒ local compatibility value only, must NOT be a sample.
      collector.recordAudit(
        llmReport({ sessionId: 's1', tokensUsed: 1000, cacheReadTokens: 300 }),
      );

      const stats = collector.getUsageStats();
      expect(stats.cacheHitRateWindow).toBeNull(); // unknown, not 0
      expect(stats.cacheHitRateSamples).toBe(0);
      expect(stats.promptTokensReported).toBe(0);

      const h = collector.getMetrics('24h').harness;
      expect(h.cacheHitRateWindow).toBeNull();
      expect(h.cacheHitRateSamples).toBe(0);
      // Legacy field stays a number (never null) for API stability.
      expect(typeof h.cacheHitRate).toBe('number');
    });

    it('returns null window on a completely fresh collector', () => {
      const stats = collector.getUsageStats();
      expect(stats.cacheHitRateWindow).toBeNull();
      expect(stats.cacheHitRateSamples).toBe(0);
      expect(collector.getMetrics('24h').harness.cacheHitRateWindow).toBeNull();
    });

    it('computes the windowed rate from reported samples', () => {
      collector.recordAudit(
        llmReport({ sessionId: 's1', provider: 'openai', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800 }),
      );
      const stats = collector.getUsageStats();
      expect(stats.cacheHitRateWindow).toBeCloseTo(0.8);
      expect(stats.cacheHitRateSamples).toBe(1);
      expect(stats.promptTokensReported).toBe(1);

      // Aggregates across calls: (800 + 200) / (1000 + 1000) = 0.5
      collector.recordAudit(
        llmReport({ sessionId: 's1', provider: 'openai', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200 }),
      );
      expect(collector.getUsageStats().cacheHitRateWindow).toBeCloseTo(0.5);
      expect(collector.getUsageStats().cacheHitRateSamples).toBe(2);
      expect(collector.getMetrics('24h').harness.cacheHitRateWindow).toBeCloseTo(0.5);
    });

    it('normalizes the denominator per provider (Anthropic excludes cached)', () => {
      // Anthropic: input_tokens excludes the cached portion, so prompt side =
      // 500 (fresh) + 500 (cache read) = 1000 ⇒ hit rate 0.5.
      collector.recordAudit(
        llmReport({ sessionId: 's1', provider: 'anthropic', inputTokens: 500, outputTokens: 20, cacheReadTokens: 500 }),
      );
      expect(collector.getUsageStats().cacheHitRateWindow).toBeCloseTo(0.5);

      // OpenAI-compatible: input_tokens already includes the cached portion ⇒ 1.0.
      collector = new AgentMetricsCollector('agent-test-1');
      collector.recordAudit(
        llmReport({ sessionId: 's2', provider: 'openrouter', inputTokens: 500, outputTokens: 20, cacheReadTokens: 500 }),
      );
      expect(collector.getUsageStats().cacheHitRateWindow).toBeCloseTo(1);
    });

    it('keeps per-session windows isolated from each other', () => {
      // Session A: a single reported sample with a perfect hit rate.
      collector.recordAudit(
        llmReport({ sessionId: 'A', provider: 'openai', inputTokens: 1000, outputTokens: 10, cacheReadTokens: 1000 }),
      );
      // Session B: overflow by 10 beyond the per-session cap with zero hits.
      for (let i = 0; i < MAX_CACHE_WINDOW_SAMPLES_PER_SESSION + 10; i++) {
        collector.recordAudit(
          llmReport({ sessionId: 'B', provider: 'openai', inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0 }),
        );
      }

      const stats = collector.getUsageStats();
      // A contributes 1, B is capped at exactly its own limit — A is NOT evicted
      // by B's overflow (the caps are independent), so the total is 1 + 50.
      expect(stats.cacheHitRateSamples).toBe(
        1 + MAX_CACHE_WINDOW_SAMPLES_PER_SESSION,
      );
      // read = 1000 (A only); denominator = 51 * 1000 ⇒ rate ≈ 0.0196.
      expect(stats.cacheHitRateWindow).toBeCloseTo(1000 / 51000, 6);
    });

    it('applies the sliding-window cap (drops oldest beyond the limit)', () => {
      const N = MAX_CACHE_WINDOW_SAMPLES_PER_SESSION;
      const sid = 'rolling';
      // First 10 calls: full cache hits.
      for (let i = 0; i < 10; i++) {
        collector.recordAudit(
          llmReport({ sessionId: sid, provider: 'openai', inputTokens: 1000, outputTokens: 10, cacheReadTokens: 1000 }),
        );
      }
      // Next N calls: zero hits → together this pushes the 10 hits out of the window.
      for (let i = 0; i < N; i++) {
        collector.recordAudit(
          llmReport({ sessionId: sid, provider: 'openai', inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0 }),
        );
      }

      const stats = collector.getUsageStats();
      // Only the last N samples survive; all are zero-hit ⇒ rate 0, not 10/60.
      expect(stats.cacheHitRateSamples).toBe(N);
      expect(stats.cacheHitRateWindow).toBe(0);
    });

    it('bounds the number of tracked sessions (no unbounded memory growth)', () => {
      for (let i = 0; i < MAX_CACHE_WINDOW_SESSIONS + 20; i++) {
        collector.recordAudit(
          llmReport({ sessionId: `sess-${i}`, provider: 'openai', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 }),
        );
      }
      // Oldest sessions are evicted; only the most recent cap remains.
      expect(collector.getUsageStats().cacheHitRateSamples).toBe(MAX_CACHE_WINDOW_SESSIONS);
    });

    it('does not mix compat samples into the reported denominator', () => {
      // One reported sample (hit rate 0.5) + one compat sample that must be ignored.
      collector.recordAudit(
        llmReport({ sessionId: 's1', provider: 'openai', inputTokens: 1000, outputTokens: 10, cacheReadTokens: 500 }),
      );
      collector.recordAudit(
        llmReport({ sessionId: 's1', tokensUsed: 5000, cacheReadTokens: 5000 }),
      );
      const stats = collector.getUsageStats();
      expect(stats.cacheHitRateSamples).toBe(1);
      expect(stats.cacheHitRateWindow).toBeCloseTo(0.5);
      expect(stats.promptTokensReported).toBe(1);
    });
  });
});
