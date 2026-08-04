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
  'creditsBudgetCu',
  'memberCuLimit',
  'memberCuUsed',
  'subscriptionStatus',
] as const;

const HUB_CU_SYNC_REQUIRED = [
  'ok',
  'entitlementCu',
  'creditsBudgetCu',
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
      entitlementCu: 8_800,
      creditsBudgetCu: 10_000,
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

  it('cu/status progress uses creditsBudgetCu not wallet entitlementCu', () => {
    // After burns: E=8977, S=10023 → bar must be 10023/19000 not 0/8977.
    const sync = {
      entitlementCu: 8_977,
      creditsBudgetCu: 19_000,
      usedCu: 10_023,
      remainingCu: 8_977,
    };
    const budget = Number(sync.creditsBudgetCu ?? 0) > 0
      ? Number(sync.creditsBudgetCu)
      : sync.usedCu + sync.remainingCu;
    const used = sync.usedCu;
    const pct = Math.round((used / budget) * 100);
    expect(budget).toBe(19_000);
    expect(pct).toBe(53);
    expect(budget).not.toBe(sync.entitlementCu);
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
      creditsBudgetCu: 10_300,
      memberCuLimit: 10_300,
      memberCuUsed: 50,
      subscriptionStatus: 'active',
      cuUsed: 50,
    };
    for (const k of HUB_PLAN_REQUIRED) expect(hubPlan).toHaveProperty(k);

    const face =
      (hubPlan.monthlyQuotaCu ?? 0) + (hubPlan.bonusCu ?? 0) + (hubPlan.purchasedCu ?? 0);
    const entitlement = hubPlan.creditsBudgetCu ?? face;
    expect(entitlement).toBe(10_300);
    expect(hubPlan.memberCuUsed ?? 0).toBeLessThanOrEqual(entitlement);
  });

  it('progress denominator prefers creditsBudgetCu over shrunk face after burns', () => {
    // Screenshot bug: face M+B+P=11000 while period budget stays 19000.
    const hubPlan = {
      monthlyQuotaCu: 10_000,
      bonusCu: 0,
      purchasedCu: 1_000,
      totalConsumedThisPeriod: 10_023,
      creditsBudgetCu: 19_000,
      memberCuLimit: 19_000,
      memberCuUsed: 10_023,
    };
    const face = hubPlan.monthlyQuotaCu + hubPlan.bonusCu + hubPlan.purchasedCu;
    const totalQuota = hubPlan.creditsBudgetCu ?? face;
    expect(face).toBe(11_000);
    expect(totalQuota).toBe(19_000);
    expect(Math.round((hubPlan.totalConsumedThisPeriod / totalQuota) * 100)).toBe(53);
  });

  it('golden soft-stop vector: A=19000 S=10023 ⇒ R=8977 (ledger must not gate)', () => {
    const allocationCu = 19_000;
    const orUsedCu = 10_023;
    const auditLedgerCu = 19_031; // historical double-count noise
    const remainingCu = Math.max(0, allocationCu - orUsedCu);
    expect(remainingCu).toBe(8_977);
    // Desktop soft-stop uses Hub sync remainingCu (= R), never A − ledger.
    expect(remainingCu).not.toBe(Math.max(0, allocationCu - auditLedgerCu));
    expect(remainingCu > 0).toBe(true);
  });
});
