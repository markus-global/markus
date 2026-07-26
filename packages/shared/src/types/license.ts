export type PlanTier = 'free' | 'basic' | 'plus' | 'pro' | 'max' | 'team' | 'enterprise';

/**
 * Plan limits are now CU-only. Non-CU limits (maxAgents, maxTeams,
 * maxToolCallsPerDay, maxUsers) have been removed — they ran on the
 * user's own machine at zero cost and created unnecessary complexity.
 */
export interface PlanLimits {
  [key: string]: unknown;
}

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
