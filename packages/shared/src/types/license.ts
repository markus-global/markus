export type PlanTier = 'free' | 'basic' | 'plus' | 'pro' | 'max' | 'team' | 'enterprise';

export interface PlanLimits {
  maxTeams: number;
  maxToolCallsPerDay: number;
  maxUsers: number;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free:       { maxTeams: 5,   maxToolCallsPerDay: 5000,  maxUsers: 1 },
  basic:      { maxTeams: 2,   maxToolCallsPerDay: 10000, maxUsers: 1 },
  plus:       { maxTeams: 3,   maxToolCallsPerDay: 20000, maxUsers: 3 },
  pro:        { maxTeams: 5,   maxToolCallsPerDay: -1,    maxUsers: 5 },
  max:        { maxTeams: 10,  maxToolCallsPerDay: -1,    maxUsers: 10 },
  team:       { maxTeams: 25,  maxToolCallsPerDay: -1,    maxUsers: -1 },
  enterprise: { maxTeams: -1,  maxToolCallsPerDay: -1,    maxUsers: -1 },
};

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
