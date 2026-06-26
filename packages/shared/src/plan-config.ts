// ─── Plan Configuration Module ─────────────────────────────────────────────
//
// Provides typed access to the 7-tier plan system.
// The canonical plan data is embedded here as a typed constant so it avoids
// ESM JSON import issues with tsc -b project references.
//
// A standalone JSON copy lives at plan-data.json for CF Workers and other
// non-TypeScript consumers. Keep both in sync.
//
// Subscription key format: markus_<48-hex-chars>
// The key itself does NOT encode the plan; plan is resolved via an async
// lookup strategy (e.g. Hub API call or local DB query).

import type { PlanName, PlanConfig, WindowQuota } from './types/plan.js';

// ── Canonical plan data ─────────────────────────────────────────────────────
// Keep in sync with plan-data.json

const PLANS: Record<PlanName, PlanConfig> = {
  free: {
    name: 'free',
    displayName: 'Free',
    monthlyQuotaCu: 10000,
    windowQuotas: [{ hours: 5, maxCu: 1000 }],
    priceUsd: 0,
    priceUsdYearly: 0,
    maxAgents: 1,
    maxTeamMembers: 1,
    features: ['core-agent', 'web-ui', 'community-skills'],
  },
  basic: {
    name: 'basic',
    displayName: 'Basic',
    monthlyQuotaCu: 50000,
    windowQuotas: [{ hours: 5, maxCu: 5000 }],
    priceUsd: 9,
    priceUsdYearly: 90,
    maxAgents: 3,
    maxTeamMembers: 3,
    features: ['core-agent', 'web-ui', 'community-skills', 'custom-tools', 'basic-support'],
  },
  plus: {
    name: 'plus',
    displayName: 'Plus',
    monthlyQuotaCu: 200000,
    windowQuotas: [{ hours: 5, maxCu: 20000 }],
    priceUsd: 29,
    priceUsdYearly: 290,
    maxAgents: 5,
    maxTeamMembers: 5,
    features: ['core-agent', 'web-ui', 'community-skills', 'custom-tools', 'priority-support', 'a2a'],
  },
  pro: {
    name: 'pro',
    displayName: 'Pro',
    monthlyQuotaCu: 500000,
    windowQuotas: [{ hours: 5, maxCu: 50000 }],
    priceUsd: 79,
    priceUsdYearly: 790,
    maxAgents: 10,
    maxTeamMembers: 10,
    features: ['core-agent', 'web-ui', 'community-skills', 'custom-tools', 'priority-support', 'a2a', 'custom-llm', 'analytics'],
  },
  max: {
    name: 'max',
    displayName: 'Max',
    monthlyQuotaCu: 2_000_000,
    windowQuotas: [{ hours: 5, maxCu: 200_000 }],
    priceUsd: 199,
    priceUsdYearly: 1990,
    maxAgents: 25,
    maxTeamMembers: 25,
    features: ['core-agent', 'web-ui', 'community-skills', 'custom-tools', 'priority-support', 'a2a', 'custom-llm', 'analytics', 'premium-models', 'advanced-workflows'],
  },
  team: {
    name: 'team',
    displayName: 'Team',
    monthlyQuotaCu: 5_000_000,
    windowQuotas: [{ hours: 5, maxCu: 500_000 }],
    priceUsd: 499,
    priceUsdYearly: 4990,
    maxAgents: 50,
    maxTeamMembers: 50,
    features: ['core-agent', 'web-ui', 'community-skills', 'custom-tools', 'dedicated-support', 'a2a', 'custom-llm', 'analytics', 'premium-models', 'advanced-workflows', 'sso', 'audit-logs'],
  },
  enterprise: {
    name: 'enterprise',
    displayName: 'Enterprise',
    monthlyQuotaCu: 20_000_000,
    windowQuotas: [{ hours: 5, maxCu: 2_000_000 }],
    priceUsd: 1499,
    priceUsdYearly: 14990,
    maxAgents: 999,
    maxTeamMembers: 999,
    features: ['core-agent', 'web-ui', 'community-skills', 'custom-tools', 'dedicated-support', 'a2a', 'custom-llm', 'analytics', 'premium-models', 'advanced-workflows', 'sso', 'audit-logs', 'on-premise', 'white-label', 'custom-contract'],
  },
};

const PLAN_NAMES: PlanName[] = ['free', 'basic', 'plus', 'pro', 'max', 'team', 'enterprise'];
const PLAN_NAMES_SET = new Set<string>(PLAN_NAMES);

// ── Validation patterns ─────────────────────────────────────────────────────

/** Pattern for a valid Markus subscription key: markus_<48-hex-chars> */
const SUBSCRIPTION_KEY_RE = /^markus_[0-9a-f]{48}$/;

/** Pattern for extracting the hex payload from a subscription key */
const HEX_48 = /^markus_([0-9a-f]{48})$/;

// ── Plan lookup helpers ─────────────────────────────────────────────────────

/**
 * Return the full config for a given plan name.
 * Throws if the plan name is unknown.
 */
export function getPlanConfig(plan: PlanName): PlanConfig {
  const cfg = PLANS[plan];
  if (!cfg) {
    throw new Error(`Unknown plan: "${plan}". Valid plans: ${PLAN_NAMES.join(', ')}`);
  }
  return cfg;
}

/**
 * Return the free plan config (safe default for unauthenticated / fallback).
 */
export function getDefaultPlan(): PlanConfig {
  return PLANS.free;
}

/**
 * List all valid plan names (ordered from Free → Enterprise).
 */
export function listPlans(): PlanName[] {
  return [...PLAN_NAMES];
}

/**
 * Check whether the given string is a known plan name.
 */
export function isValidPlan(value: string): value is PlanName {
  return PLAN_NAMES_SET.has(value);
}

// ── Subscription key helpers ────────────────────────────────────────────────

/**
 * Validate a subscription key format.
 * Returns `true` if the key matches `markus_<48-hex-chars>`.
 */
export function isValidSubscriptionKey(key: string): boolean {
  return SUBSCRIPTION_KEY_RE.test(key);
}

/**
 * Extract the hex payload from a subscription key.
 * Returns null if the key format is invalid.
 */
export function parseSubscriptionKey(key: string): string | null {
  const match = HEX_48.exec(key);
  return match ? match[1] : null;
}

// ── Plan detection ──────────────────────────────────────────────────────────

/**
 * Resolve which plan a subscription key belongs to.
 *
 * This is intentionally async — in production the caller provides a
 * `lookupStrategy` that queries the Hub DB (or a cache).  If no strategy is
 * given, falls back to the free plan (safe default for non-production paths).
 *
 * @example
 * ```ts
 * const plan = await detectPlan(key, async (k) => {
 *   const user = await db.select(...).where(eq(users.subscriptionKey, k));
 *   return user?.planType ?? 'free';
 * });
 * ```
 */
export async function detectPlan(
  subscriptionKey: string,
  lookupStrategy?: (key: string) => Promise<PlanName | undefined>,
): Promise<{ plan: PlanConfig; planName: PlanName }> {
  if (!isValidSubscriptionKey(subscriptionKey)) {
    return { plan: PLANS.free, planName: 'free' };
  }

  if (lookupStrategy) {
    const plan = await lookupStrategy(subscriptionKey);
    if (plan && isValidPlan(plan)) {
      return { plan: PLANS[plan], planName: plan };
    }
  }

  return { plan: PLANS.free, planName: 'free' };
}

// ── Subscription key prefix inspection ──────────────────────────────────────

/**
 * Inspect a subscription key to determine its validity and environment prefix.
 */
export function inspectSubscriptionKey(key: string): { valid: boolean; prefix: string } {
  const prefix = key.startsWith('markus_') ? 'markus' : 'unknown';
  return {
    valid: isValidSubscriptionKey(key),
    prefix,
  };
}

// ── Serialization helper ────────────────────────────────────────────────────

/**
 * Return a plain object of all plan configs (useful for HTTP responses
 * that need the full plan catalog).
 */
export function getAllPlanConfigs(): Record<PlanName, PlanConfig> {
  return { ...PLANS };
}

// ── Sync guard ──────────────────────────────────────────────────────────────

/**
 * Validate a PlanConfig object against known schema invariants.
 * Useful for verifying plan-data.json stays in sync with the TypeScript source.
 */
export function validatePlanConfig(config: PlanConfig): string[] {
  const errors: string[] = [];
  if (!PLAN_NAMES_SET.has(config.name)) {
    errors.push(`Invalid plan name: "${config.name}"`);
  }
  if (config.monthlyQuotaCu <= 0) {
    errors.push(`monthlyQuotaCu must be > 0, got ${config.monthlyQuotaCu}`);
  }
  if (config.windowQuotas.length === 0) {
    errors.push('windowQuotas must not be empty');
  }
  for (const wq of config.windowQuotas) {
    if (wq.hours <= 0) errors.push(`windowQuotas.hours must be > 0, got ${wq.hours}`);
    if (wq.maxCu <= 0) errors.push(`windowQuotas.maxCu must be > 0, got ${wq.maxCu}`);
  }
  if (config.priceUsd < 0) errors.push(`priceUsd must be >= 0, got ${config.priceUsd}`);
  if (config.priceUsdYearly < 0) errors.push(`priceUsdYearly must be >= 0, got ${config.priceUsdYearly}`);
  if (config.maxAgents <= 0) errors.push(`maxAgents must be > 0, got ${config.maxAgents}`);
  if (config.maxTeamMembers <= 0) errors.push(`maxTeamMembers must be > 0, got ${config.maxTeamMembers}`);
  return errors;
}
