/**
 * Frozen Hub ↔ Desktop billing response contract.
 * Hub integration `billing-crossflows` asserts the same keys on live handlers;
 * Desktop only reads these fields from /api/user/plan and /api/user/cu/sync.
 */
import { describe, it, expect } from 'vitest';

/** Mirrors MarkusProvider.syncHubCredits + OverviewUsage hubPlan reads. */
const HUB_PLAN_REQUIRED = [
  'orgId',
  'planType',
  'planSource',
  'monthlyQuotaCu',
  'bonusCu',
  'purchasedCu',
  'totalConsumedThisPeriod',
  'memberCuLimit',
  'memberCuUsed',
  'subscriptionStatus',
] as const;

const HUB_CU_SYNC_REQUIRED = [
  'ok',
  'entitlementCu',
  'usedCu',
  'remainingCu',
  'memberUsedCu',
  'allocationCu',
  'openrouter',
] as const;

describe('Hub billing API contract (Desktop)', () => {
  it('parses /api/user/cu/sync the way MarkusProvider does', () => {
    const data = {
      ok: true,
      entitlementCu: 10_000,
      usedCu: 1_200,
      remainingCu: 8_800,
      memberUsedCu: 400,
      allocationCu: 10_000,
      openrouter: { limitUsd: 20, usageUsd: 1.5, remainingUsd: 18.5 },
    };
    for (const k of HUB_CU_SYNC_REQUIRED) expect(data).toHaveProperty(k);

    const remainingCu = Math.max(0, Number(data.remainingCu ?? 0));
    const remainingUsd = Math.max(0, Number(data.openrouter?.remainingUsd ?? 0));
    expect(remainingCu).toBe(8_800);
    expect(remainingUsd).toBe(18.5);
  });

  it('exposes /api/user/plan fields OverviewUsage reads', () => {
    const hubPlan = {
      orgId: 'org_x',
      planType: 'basic',
      planSource: 'org',
      monthlyQuotaCu: 10_000,
      bonusCu: 100,
      purchasedCu: 200,
      totalConsumedThisPeriod: 50,
      memberCuLimit: 10_300,
      memberCuUsed: 50,
      subscriptionStatus: 'active',
      cuUsed: 50,
    };
    for (const k of HUB_PLAN_REQUIRED) expect(hubPlan).toHaveProperty(k);

    const entitlement =
      (hubPlan.monthlyQuotaCu ?? 0) + (hubPlan.bonusCu ?? 0) + (hubPlan.purchasedCu ?? 0);
    expect(entitlement).toBe(10_300);
    expect(hubPlan.memberCuUsed ?? 0).toBeLessThanOrEqual(entitlement);
  });
});
