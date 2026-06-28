import { getPlanConfig, listPlans } from '../plan-config.js';

export type PlanTier = 'free' | 'basic' | 'plus' | 'pro' | 'max' | 'team' | 'enterprise';

export interface PlanLimits {
  maxTeams: number;
  maxToolCallsPerDay: number;
  maxUsers: number;
}

/**
 * Relationship between plan-config.ts and license.ts:
 *
 * - plan-config.ts is the canonical source for CU quotas, pricing, and subscription
 *   tier metadata (maxTeamMembers, maxAgents, features[]).
 * - license.ts adds instance-level enforcement limits (maxTeams, maxToolCallsPerDay)
 *   and enterprise feature gates (PLAN_FEATURES) used by LicenseService and the API.
 *
 * maxUsers here mirrors plan-config maxTeamMembers so seat limits stay aligned with
 * the Hub subscription tier. maxTeams and maxToolCallsPerDay remain license-only.
 */
const LICENSE_ONLY_LIMITS: Record<PlanTier, Pick<PlanLimits, 'maxTeams' | 'maxToolCallsPerDay'>> = {
  free:       { maxTeams: 5,   maxToolCallsPerDay: 5000 },
  basic:      { maxTeams: 2,   maxToolCallsPerDay: 10000 },
  plus:       { maxTeams: 3,   maxToolCallsPerDay: 20000 },
  pro:        { maxTeams: 5,   maxToolCallsPerDay: -1 },
  max:        { maxTeams: 10,  maxToolCallsPerDay: -1 },
  team:       { maxTeams: 25,  maxToolCallsPerDay: -1 },
  enterprise: { maxTeams: -1,  maxToolCallsPerDay: -1 },
};

function buildPlanLimits(): Record<PlanTier, PlanLimits> {
  const limits = {} as Record<PlanTier, PlanLimits>;
  for (const plan of listPlans()) {
    limits[plan] = {
      ...LICENSE_ONLY_LIMITS[plan],
      maxUsers: getPlanConfig(plan).maxTeamMembers,
    };
  }
  return limits;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = buildPlanLimits();

export type EnterpriseFeature =
  | 'multi_user'
  | 'unlimited_teams'
  | 'unlimited_tools'
  | 'sso'
  | 'audit_enhanced'
  | 'multi_instance';

export const ENTERPRISE_FEATURES: EnterpriseFeature[] = [
  'multi_user',
  'unlimited_teams',
  'unlimited_tools',
  'sso',
  'audit_enhanced',
  'multi_instance',
];

/** Features available at each plan tier (cumulative). */
export const PLAN_FEATURES: Record<PlanTier, EnterpriseFeature[]> = {
  free: [],
  basic: [],
  plus: ['multi_user'],
  pro: ['multi_user', 'unlimited_tools'],
  max: ['multi_user', 'unlimited_tools', 'unlimited_teams'],
  team: ['multi_user', 'unlimited_tools', 'unlimited_teams', 'sso', 'multi_instance'],
  enterprise: [...ENTERPRISE_FEATURES],
};

export interface LicenseInfo {
  plan: PlanTier;
  licenseKey?: string;
  validUntil?: string;
  isTrial?: boolean;
  isOffline?: boolean;
  features: EnterpriseFeature[];
  limits: PlanLimits;
  lastValidated?: string;
  instanceId: string;
  orgId?: string;
  orgName?: string;
  maxSeats?: number;
  usedSeats?: number;
}

export interface LicenseFilePayload {
  version: number;
  licenseId: string;
  plan: 'enterprise';
  issuedTo: {
    userId: string;
    email: string;
    company?: string;
  };
  validFrom: string;
  validUntil: string;
  maxInstances: number;
  features: EnterpriseFeature[];
  signature: string;
}

export interface AuthStatusResponse {
  initialized: boolean;
  hasOwner: boolean;
  hasMultipleUsers: boolean;
}
