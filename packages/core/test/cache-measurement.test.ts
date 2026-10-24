/**
 * Cache measurement — the thing we could not do before.
 *
 * Before this existed, `provider-helpers` parsed `prompt_cache_hit_tokens` /
 * `cache_read_input_tokens` into `usage.cacheReadTokens`, and `agent-metrics`
 * computed a rate — but the per-call figure never reached the database or the
 * log, so "are we actually hitting?" was unanswerable. Round 2026-10-23: the
 * whole runtime log of a day contained zero cache numbers.
 *
 * These tests pin the ONE definition of the denominator, because two definitions
 * of the same invariant is exactly how a metric silently starts lying:
 *  - OpenAI-compatible: `prompt_tokens` includes the cached part → subset.
 *  - Anthropic: `input_tokens` EXCLUDES it → must add reads+writes back.
 */

import { describe, it, expect } from 'vitest';
import { cacheDenominator, computeCacheHitRate } from '../src/llm/provider-helpers.js';
import { AgentMetricsCollector } from '../src/agent-metrics.js';

describe('cacheDenominator — provider-aware prompt side', () => {
  it('treats OpenAI-compatible prompt_tokens as already containing the cached part', () => {
    for (const provider of ['openai', 'openrouter', 'deepseek', 'markus']) {
      expect(
        cacheDenominator({ provider, promptTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 0 }),
      ).toBe(1000);
    }
  });

  it('adds reads and writes back for Anthropic, whose input_tokens excludes them', () => {
    expect(
      cacheDenominator({
        provider: 'anthropic',
        promptTokens: 200,       // uncached remainder only
        cacheReadTokens: 700,
        cacheWriteTokens: 100,
      }),
    ).toBe(1000);
  });

  it('assumes the OpenAI shape for an unknown provider (can only understate)', () => {
    // Conservative: an unrecognised provider must never produce a BETTER rate
    // than the un-inflated denominator would.
    const unknown = cacheDenominator({ promptTokens: 1000, cacheReadTokens: 800 });
    expect(unknown).toBe(1000);
    expect(computeCacheHitRate({ promptTokens: 1000, cacheReadTokens: 800 })).toBeCloseTo(0.8);
  });

  it('returns 0 denominator when the provider reported nothing', () => {
    expect(cacheDenominator({ provider: 'openai', promptTokens: 0 })).toBe(0);
    expect(cacheDenominator({ provider: 'anthropic', promptTokens: 0 })).toBe(0);
  });
});

describe('computeCacheHitRate', () => {
  it('returns null — not 0 — when there is nothing to divide', () => {
    // "no measurement" and "measured 0%" are different facts; collapsing them
    // hides a broken cache behind a plausible number.
    expect(computeCacheHitRate({ provider: 'openai', promptTokens: 0 })).toBeNull();
  });

  it('reports a real 0 when the provider did report prompt tokens', () => {
    expect(computeCacheHitRate({ provider: 'openai', promptTokens: 1000 })).toBe(0);
  });

  it('clamps to 1 when reads exceed the prompt side', () => {
    expect(computeCacheHitRate({ provider: 'openai', promptTokens: 100, cacheReadTokens: 300 })).toBe(1);
  });
});

/** Shorthand for a reported llm_request audit. */
function llmReport(opts: {
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}) {
  return {
    type: 'llm_request',
    action: 'chat',
    success: true,
    tokensUsed: (opts.inputTokens ?? 0) + (opts.outputTokens ?? 0),
    ...opts,
  } as const;
}

describe('AgentMetricsCollector — cumulative rate uses the same denominator', () => {
  it('counts an Anthropic-style call at its true hit rate, not 0%', () => {
    const c = new AgentMetricsCollector();
    // Uncached remainder 200 + 800 cached = a 1000-token prompt that was 80%
    // served from cache. Dividing by inputTokens alone would report 400%.
    c.recordAudit(llmReport({ provider: 'anthropic', inputTokens: 200, outputTokens: 50, cacheReadTokens: 800 }));
    expect(c.getUsageStats().cacheHitRate).toBeCloseTo(0.8);
  });

  it('keeps OpenAI-shaped calls at reads/prompt', () => {
    const c = new AgentMetricsCollector();
    c.recordAudit(llmReport({ provider: 'deepseek', inputTokens: 1000, outputTokens: 50, cacheReadTokens: 600 }));
    expect(c.getUsageStats().cacheHitRate).toBeCloseTo(0.6);
  });

  it('agrees with the windowed metric on a mixed-provider sample', () => {
    const c = new AgentMetricsCollector();
    c.recordAudit({ ...llmReport({ provider: 'deepseek', inputTokens: 1000, cacheReadTokens: 500 }), sessionId: 's1' });
    c.recordAudit({ ...llmReport({ provider: 'anthropic', inputTokens: 100, cacheReadTokens: 400 }), sessionId: 's1' });
    const m = c.getMetrics('24h');
    // cumulative: (500 + 400) / (1000 + 500) = 0.6
    expect(m.harness.cacheHitRate).toBeCloseTo(0.6);
    // windowed: same denominator definition → same answer, not a second truth
    expect(m.harness.cacheHitRateWindow).toBeCloseTo(0.6);
  });

  it('ignores compat samples (no provider report) in the denominator', () => {
    const c = new AgentMetricsCollector();
    // No inputTokens ⇒ not a provider report ⇒ must not enter the denominator,
    // otherwise a locally-derived number would masquerade as a measurement.
    c.recordAudit({ type: 'llm_request', action: 'chat', success: true, tokensUsed: 5000 });
    const stats = c.getUsageStats();
    expect(stats.promptTokensReported).toBe(0);
    expect(stats.cacheHitRate).toBe(0);
  });
});
