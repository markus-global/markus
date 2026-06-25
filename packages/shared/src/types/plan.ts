// ─── Plan Configuration Types ──────────────────────────────────────────────
//
// 7-tier plan system for Markus token-billing.
// Each plan has defined CU quotas, window rate limits, and pricing.
//
// The canonical plan config data lives in plan-data.json (in the parent dir);
// these types describe its shape and provide helper accessors.

/** All supported plan tiers */
export type PlanName = 'free' | 'basic' | 'plus' | 'pro' | 'max' | 'team' | 'enterprise';

/** Short time-window quota (e.g. 5-hour rate limit) */
export interface WindowQuota {
  /** Duration in hours */
  hours: number;
  /** Max compute units allowed in this window */
  maxCu: number;
}

/** Full plan configuration */
export interface PlanConfig {
  /** Unique identifier (matches PlanName) */
  name: PlanName;
  /** Human-readable display name */
  displayName: string;
  /** Monthly CU entitlement */
  monthlyQuotaCu: number;
  /** Short-window rate limits (throttling, not billing) */
  windowQuotas: WindowQuota[];
  /** Monthly price in USD (0 = free) */
  priceUsd: number;
  /** Annual price in USD per month (discounted; 0 = free) */
  priceUsdYearly: number;
  /** Max active agents allowed */
  maxAgents: number;
  /** Max team members allowed */
  maxTeamMembers: number;
  /** Feature flags / capability labels */
  features: string[];
}

/** Map of all plans keyed by name */
export type PlanConfigMap = Record<PlanName, PlanConfig>;
