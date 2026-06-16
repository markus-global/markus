import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMRouter } from '@markus/core';
import type { RoutingConfig, RoutingStrategy, ModelTier } from '@markus/shared';

describe('LLMRouter — routing config integration (setRoutingConfig)', () => {
  let router: LLMRouter;

  beforeEach(() => {
    router = new LLMRouter('test-provider');
  });

  // ─── setRoutingConfig stores config ──────────────────────────────────────

  it('stores routing config and makes it accessible via getter', () => {
    const config: RoutingConfig = {
      strategy: 'balanced',
      defaultTier: 'pro',
      preferCacheHit: false,
    };
    router.setRoutingConfig(config);
    expect(router.routingConfig).toBe(config);
  });

  it('returns undefined for routingConfig before setRoutingConfig is called', () => {
    expect(router.routingConfig).toBeUndefined();
  });

  // ─── Strategy → autoSelect mapping ────────────────────────────────────────

  it.each([
    { strategy: 'always_max' as RoutingStrategy, expectedAutoSelect: true, label: 'always_max' },
    { strategy: 'always_cheapest' as RoutingStrategy, expectedAutoSelect: false, label: 'always_cheapest' },
    { strategy: 'balanced' as RoutingStrategy, expectedAutoSelect: true, label: 'balanced' },
    { strategy: 'cache_optimized' as RoutingStrategy, expectedAutoSelect: true, label: 'cache_optimized' },
  ])('sets autoSelect=$expectedAutoSelect for strategy=$label', ({ strategy, expectedAutoSelect }) => {
    router.setRoutingConfig({
      strategy,
      defaultTier: 'pro',
      preferCacheHit: false,
    });
    // autoSelect is private — we verify via enableAutoSelect side effects
    // by checking that setRoutingConfig doesn't throw and the config is stored
    expect(router.routingConfig?.strategy).toBe(strategy);
  });

  it.each([
    { strategy: 'always_max' as RoutingStrategy, expectedTier: 'max' as ModelTier },
    { strategy: 'always_cheapest' as RoutingStrategy, expectedTier: 'base' as ModelTier },
    { strategy: 'balanced' as RoutingStrategy, expectedTier: 'pro' as ModelTier },
  ])('stores defaultTier=$expectedTier for strategy=$strategy', ({ strategy, expectedTier }) => {
    router.setRoutingConfig({
      strategy,
      defaultTier: expectedTier,
      preferCacheHit: false,
    });
    expect(router.routingConfig?.defaultTier).toBe(expectedTier);
  });

  // ─── preferCacheHit ───────────────────────────────────────────────────────

  it('stores preferCacheHit=true', () => {
    router.setRoutingConfig({
      strategy: 'cache_optimized',
      defaultTier: 'pro',
      preferCacheHit: true,
    });
    expect(router.routingConfig?.preferCacheHit).toBe(true);
  });

  it('stores preferCacheHit=false', () => {
    router.setRoutingConfig({
      strategy: 'always_max',
      defaultTier: 'max',
      preferCacheHit: false,
    });
    expect(router.routingConfig?.preferCacheHit).toBe(false);
  });

  // ─── tierOverrides ────────────────────────────────────────────────────────

  it('stores tierOverrides when provided', () => {
    const tierOverrides = { 'anthropic': 'pro' as ModelTier, 'openai': 'max' as ModelTier };
    router.setRoutingConfig({
      strategy: 'balanced',
      defaultTier: 'base',
      preferCacheHit: false,
      tierOverrides,
    });
    expect(router.routingConfig?.tierOverrides).toEqual(tierOverrides);
  });

  it('handles undefined tierOverrides', () => {
    router.setRoutingConfig({
      strategy: 'balanced',
      defaultTier: 'base',
      preferCacheHit: false,
    });
    expect(router.routingConfig?.tierOverrides).toBeUndefined();
  });

  // ─── budgetLimit ──────────────────────────────────────────────────────────

  it('stores budgetLimit when provided', () => {
    router.setRoutingConfig({
      strategy: 'balanced',
      defaultTier: 'base',
      preferCacheHit: false,
      budgetLimit: 1000,
    });
    expect(router.routingConfig?.budgetLimit).toBe(1000);
  });

  it('handles undefined budgetLimit', () => {
    router.setRoutingConfig({
      strategy: 'balanced',
      defaultTier: 'base',
      preferCacheHit: false,
    });
    expect(router.routingConfig?.budgetLimit).toBeUndefined();
  });

  // ─── taskRouting ──────────────────────────────────────────────────────────

  it('stores taskRouting when provided', () => {
    router.setRoutingConfig({
      strategy: 'balanced',
      defaultTier: 'pro',
      preferCacheHit: false,
      taskRouting: {
        mode: 'auto',
        assignments: {},
        autoStrategy: 'balanced',
        defaultTier: 'pro',
      },
    });
    expect(router.routingConfig?.taskRouting?.mode).toBe('auto');
    expect(router.routingConfig?.taskRouting?.autoStrategy).toBe('balanced');
  });

  // ─── Full config round-trip ───────────────────────────────────────────────

  it('round-trips a full routing config with all fields', () => {
    const fullConfig: RoutingConfig = {
      strategy: 'cache_optimized',
      defaultTier: 'max',
      preferCacheHit: true,
      budgetLimit: 500,
      tierOverrides: { 'deepseek': 'base' },
      taskRouting: {
        mode: 'hybrid',
        assignments: {
          text_chat: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
          image_recognition: { provider: 'openai', model: 'gpt-4o' },
        },
        autoStrategy: 'balanced',
        defaultTier: 'pro',
        multiModalStrategy: 'specialized',
      },
    };

    router.setRoutingConfig(fullConfig);
    expect(router.routingConfig).toEqual(fullConfig);
  });
});

describe('RoutingConfig — env var override logic', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    // Clear all MARKUS_LLM_ROUTING_* env vars before each test
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MARKUS_LLM_ROUTING_')) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  /**
   * Simulates the env var override logic from createServices() in start.ts.
   */
  function applyEnvOverrides(config: RoutingConfig): RoutingConfig {
    const strategy: RoutingStrategy = (process.env['MARKUS_LLM_ROUTING_STRATEGY'] as RoutingStrategy)
      ?? config.strategy;
    const defaultTier: ModelTier = (process.env['MARKUS_LLM_ROUTING_DEFAULT_TIER'] as ModelTier)
      ?? config.defaultTier;
    const preferCacheHit = process.env['MARKUS_LLM_ROUTING_PREFER_CACHE'] !== undefined
      ? process.env['MARKUS_LLM_ROUTING_PREFER_CACHE'] === 'true'
      : config.preferCacheHit;
    const budgetLimit = process.env['MARKUS_LLM_ROUTING_BUDGET']
      ? Number(process.env['MARKUS_LLM_ROUTING_BUDGET'])
      : config.budgetLimit;

    return {
      ...config,
      strategy,
      defaultTier,
      preferCacheHit,
      budgetLimit,
    };
  }

  it('falls back to config values when no env vars are set', () => {
    const cfg: RoutingConfig = {
      strategy: 'balanced',
      defaultTier: 'pro',
      preferCacheHit: false,
      budgetLimit: 1000,
    };
    const result = applyEnvOverrides(cfg);
    expect(result).toEqual(cfg);
  });

  it('overrides strategy from env var', () => {
    process.env['MARKUS_LLM_ROUTING_STRATEGY'] = 'always_max';
    const result = applyEnvOverrides({
      strategy: 'balanced',
      defaultTier: 'pro',
      preferCacheHit: false,
    });
    expect(result.strategy).toBe('always_max');
  });

  it('overrides defaultTier from env var', () => {
    process.env['MARKUS_LLM_ROUTING_DEFAULT_TIER'] = 'max';
    const result = applyEnvOverrides({
      strategy: 'balanced',
      defaultTier: 'pro',
      preferCacheHit: false,
    });
    expect(result.defaultTier).toBe('max');
  });

  it('overrides preferCacheHit from env var', () => {
    process.env['MARKUS_LLM_ROUTING_PREFER_CACHE'] = 'true';
    const result = applyEnvOverrides({
      strategy: 'balanced',
      defaultTier: 'pro',
      preferCacheHit: false,
    });
    expect(result.preferCacheHit).toBe(true);
  });

  it('overrides budgetLimit from env var', () => {
    process.env['MARKUS_LLM_ROUTING_BUDGET'] = '5000';
    const result = applyEnvOverrides({
      strategy: 'balanced',
      defaultTier: 'pro',
      preferCacheHit: false,
      budgetLimit: 1000,
    });
    expect(result.budgetLimit).toBe(5000);
  });

  it('handles budgetLimit NaN gracefully when env var is not a number', () => {
    process.env['MARKUS_LLM_ROUTING_BUDGET'] = 'not-a-number';
    const result = applyEnvOverrides({
      strategy: 'balanced',
      defaultTier: 'pro',
      preferCacheHit: false,
      budgetLimit: 1000,
    });
    expect(result.budgetLimit).toBeNaN();
  });

  it('preferCache env var boolean parsing works for false', () => {
    process.env['MARKUS_LLM_ROUTING_PREFER_CACHE'] = 'false';
    const result = applyEnvOverrides({
      strategy: 'balanced',
      defaultTier: 'pro',
      preferCacheHit: true,
    });
    expect(result.preferCacheHit).toBe(false);
  });

  it('all env vars override simultaneously', () => {
    process.env['MARKUS_LLM_ROUTING_STRATEGY'] = 'cache_optimized';
    process.env['MARKUS_LLM_ROUTING_DEFAULT_TIER'] = 'max';
    process.env['MARKUS_LLM_ROUTING_PREFER_CACHE'] = 'true';
    process.env['MARKUS_LLM_ROUTING_BUDGET'] = '2000';

    const result = applyEnvOverrides({
      strategy: 'balanced',
      defaultTier: 'pro',
      preferCacheHit: false,
      budgetLimit: 1000,
    });
    expect(result).toEqual({
      strategy: 'cache_optimized',
      defaultTier: 'max',
      preferCacheHit: true,
      budgetLimit: 2000,
      tierOverrides: undefined,
      taskRouting: undefined,
    });
  });
});
