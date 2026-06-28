import { describe, it, expect } from 'vitest';
import {
  getPlanConfig,
  getDefaultPlan,
  listPlans,
  isValidPlan,
  isValidSubscriptionKey,
  parseSubscriptionKey,
  detectPlan,
  inspectSubscriptionKey,
} from './plan-config.js';
import type { PlanName } from './types/plan.js';

// ── Test fixture ────────────────────────────────────────────────────────────

/** A valid subscription key (48 hex chars after prefix) */
const VALID_KEY = `markus_${'a'.repeat(48)}`;

/** Key of invalid length */
const INVALID_LEN_KEY = `markus_${'a'.repeat(16)}`;

/** Key with bad prefix */
const BAD_PREFIX_KEY = `hub_${'a'.repeat(48)}`;

/** Key with non-hex chars */
const BAD_HEX_KEY = `markus_${'g'.repeat(48)}`;

// ── getPlanConfig ───────────────────────────────────────────────────────────

describe('getPlanConfig', () => {
  it('should return config for free plan', () => {
    const cfg = getPlanConfig('free');
    expect(cfg.name).toBe('free');
    expect(cfg.monthlyQuotaCu).toBeGreaterThan(0);
    expect(cfg.priceUsd).toBe(0);
  });

  it('should return config for enterprise plan', () => {
    const cfg = getPlanConfig('enterprise');
    expect(cfg.name).toBe('enterprise');
    expect(cfg.monthlyQuotaCu).toBeGreaterThan(0);
    expect(cfg.priceUsd).toBe(-1); // custom contract
  });

  it('should include windowQuotas for each plan', () => {
    const names: PlanName[] = ['free', 'basic', 'plus', 'pro', 'max', 'team', 'enterprise'];
    for (const name of names) {
      const cfg = getPlanConfig(name);
      expect(cfg.windowQuotas.length).toBeGreaterThan(0);
      expect(cfg.windowQuotas[0].hours).toBeGreaterThan(0);
      expect(cfg.windowQuotas[0].maxCu).toBeGreaterThan(0);
    }
  });

  it('should have increasing monthly quotas', () => {
    const quotas = listPlans().map(p => getPlanConfig(p).monthlyQuotaCu);
    for (let i = 1; i < quotas.length; i++) {
      expect(quotas[i]).toBeGreaterThan(quotas[i - 1]);
    }
  });

  it('should have increasing prices (excluding enterprise custom)', () => {
    const paidPlans = listPlans().filter(p => p !== 'enterprise');
    const prices = paidPlans.map(p => getPlanConfig(p).priceUsd);
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
    }
    // Enterprise uses -1 (custom contract)
    expect(getPlanConfig('enterprise').priceUsd).toBe(-1);
  });

  it('should throw for unknown plan', () => {
    expect(() => getPlanConfig('unknown' as PlanName)).toThrow('Unknown plan');
  });
});

// ── getDefaultPlan ──────────────────────────────────────────────────────────

describe('getDefaultPlan', () => {
  it('should return the free plan', () => {
    const cfg = getDefaultPlan();
    expect(cfg.name).toBe('free');
    expect(cfg.priceUsd).toBe(0);
  });
});

// ── listPlans ───────────────────────────────────────────────────────────────

describe('listPlans', () => {
  it('should return 7 plan names', () => {
    const names = listPlans();
    expect(names).toHaveLength(7);
  });

  it('should return plans in order: free → enterprise', () => {
    const names = listPlans();
    expect(names[0]).toBe('free');
    expect(names[6]).toBe('enterprise');
  });

  it('should return a new array each call', () => {
    const a = listPlans();
    const b = listPlans();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

// ── isValidPlan ─────────────────────────────────────────────────────────────

describe('isValidPlan', () => {
  it('should return true for all valid plan names', () => {
    for (const name of listPlans()) {
      expect(isValidPlan(name)).toBe(true);
    }
  });

  it('should return false for unknown plan names', () => {
    expect(isValidPlan('unknown')).toBe(false);
    expect(isValidPlan('premium')).toBe(false);
    expect(isValidPlan('')).toBe(false);
  });
});

// ── isValidSubscriptionKey ──────────────────────────────────────────────────

describe('isValidSubscriptionKey', () => {
  it('should accept a correctly formatted key', () => {
    expect(isValidSubscriptionKey(VALID_KEY)).toBe(true);
  });

  it('should reject keys with wrong length', () => {
    expect(isValidSubscriptionKey(INVALID_LEN_KEY)).toBe(false);
  });

  it('should reject keys with wrong prefix', () => {
    expect(isValidSubscriptionKey(BAD_PREFIX_KEY)).toBe(false);
  });

  it('should reject keys with non-hex characters', () => {
    expect(isValidSubscriptionKey(BAD_HEX_KEY)).toBe(false);
  });

  it('should reject empty string', () => {
    expect(isValidSubscriptionKey('')).toBe(false);
  });
});

// ── parseSubscriptionKey ────────────────────────────────────────────────────

describe('parseSubscriptionKey', () => {
  it('should extract hex payload from valid key', () => {
    const hex = parseSubscriptionKey(VALID_KEY);
    expect(hex).toBe('a'.repeat(48));
  });

  it('should return null for invalid key', () => {
    expect(parseSubscriptionKey(BAD_HEX_KEY)).toBeNull();
    expect(parseSubscriptionKey('')).toBeNull();
  });
});

// ── detectPlan ──────────────────────────────────────────────────────────────

describe('detectPlan', () => {
  it('should return free plan for invalid key without strategy', async () => {
    const result = await detectPlan('bad_key');
    expect(result.plan.name).toBe('free');
  });

  it('should return free plan for valid key without strategy', async () => {
    const result = await detectPlan(VALID_KEY);
    expect(result.plan.name).toBe('free');
  });

  it('should use lookup strategy when provided', async () => {
    const strategy = async (_key: string): Promise<PlanName | undefined> => 'pro';
    const result = await detectPlan(VALID_KEY, strategy);
    expect(result.plan.name).toBe('pro');
    expect(result.planName).toBe('pro');
    expect(result.plan.monthlyQuotaCu).toBe(100000);
  });

  it('should fall back to free if strategy returns unknown plan', async () => {
    const strategy = async (_key: string): Promise<PlanName | undefined> => 'unknown' as PlanName;
    const result = await detectPlan(VALID_KEY, strategy);
    expect(result.plan.name).toBe('free');
  });

  it('should not call strategy for invalid keys', async () => {
    let called = false;
    const strategy = async (_key: string): Promise<PlanName | undefined> => {
      called = true;
      return 'pro';
    };
    const result = await detectPlan('bad_key', strategy);
    expect(result.plan.name).toBe('free');
    expect(called).toBe(false);
  });
});

// ── inspectSubscriptionKey ──────────────────────────────────────────────────

describe('inspectSubscriptionKey', () => {
  it('should return valid=true for correct key', () => {
    const info = inspectSubscriptionKey(VALID_KEY);
    expect(info.valid).toBe(true);
    expect(info.prefix).toBe('markus');
  });

  it('should return valid=false for incorrect key', () => {
    const info = inspectSubscriptionKey('bad');
    expect(info.valid).toBe(false);
  });
});
