export type PlanTier = 'free' | 'enterprise';

export interface PlanLimits {
  maxTeams: number;
  maxToolCallsPerDay: number;
  maxUsers: number;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    maxTeams: 5,
    maxToolCallsPerDay: 5000,
    maxUsers: 1,
  },
  enterprise: {
    maxTeams: -1,
    maxToolCallsPerDay: -1,
    maxUsers: -1,
  },
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
