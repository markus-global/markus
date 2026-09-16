/**
 * Single source of truth for "how many credits do I have left".
 *
 * Three surfaces used to answer this question independently, and they disagreed:
 *
 * - the account popover (avatar menu) summed `monthlyQuotaCu + bonusCu +
 *   purchasedCu` and subtracted `cuUsed`. That column sum is a *face* figure: it
 *   shrinks as bonus→monthly→purchased credits burn, so it reported 11k where
 *   the real balance was 19k.
 * - the overview quota bar preferred `creditsBudgetCu` (= used + wallet
 *   remaining, which survives those burns) and fell back to
 *   `totalConsumedThisPeriod`.
 * - the settings account card did a third variant of the same thing.
 *
 * The mobile drawer now shows credits as well, which made a fourth copy
 * tempting. Instead every surface funnels through {@link resolveCreditSummary},
 * so the number on the drawer, the popover, the overview bar and the settings
 * card cannot drift apart.
 *
 * Pure functions only — this package has no jsdom, so DOM rendering is tested
 * elsewhere (or not at all).
 */

/** The subset of the `/hub/user/plan` payload these rules need. */
export interface HubPlanLike {
  monthlyQuotaCu?: number | null;
  bonusCu?: number | null;
  purchasedCu?: number | null;
  cuUsed?: number | null;
  /** Credits consumed in the current period — survives bonus/purchased burns. */
  totalConsumedThisPeriod?: number | null;
  /** Period budget = used + wallet remaining. Preferred over the column sum. */
  creditsBudgetCu?: number | null;
  /** Set by an org admin to cap this member's personal allowance. */
  memberCuLimit?: number | null;
  memberCuUsed?: number | null;
}

/** The subset of an org membership these rules need. */
export interface HubOrgLike {
  role?: string;
  memberCount?: number;
}

export interface CreditSummary {
  /** Budget for the current period. */
  total: number;
  used: number;
  /** `total - used`, clamped at 0 so a burn overshoot never renders negative. */
  remaining: number;
  /** 0–100, rounded, for progress bars. */
  pct: number;
  /**
   * True only when somebody *else* capped this member. Owners/admins/solo orgs
   * manage their own allocation, so a stale `memberCuLimit` on their record must
   * not be presented as a third-party limit.
   */
  personalLimit: boolean;
}

const EMPTY: CreditSummary = { total: 0, used: 0, remaining: 0, pct: 0, personalLimit: false };

/** Where the credits row sends the user when tapped. */
export type HubCreditsAction = 'login' | 'billing';

/**
 * Tapping the credit balance has two legitimate meanings depending on state:
 * signed out it must start sign-in, signed in it should open the Hub billing
 * page (where credits are actually bought). The drawer shows the number but
 * cannot manage it, so a connected user tapping an unresponsive row is the
 * failure this prevents.
 */
export function resolveHubCreditsAction(connected: boolean): HubCreditsAction {
  return connected ? 'billing' : 'login';
}

/**
 * i18n key (under the `nav:sidebar` namespace) for the Hub connection line.
 * Extracted so the drawer and the desktop popover cannot pick different wording
 * for the same state, and so the key set is assertable in tests.
 */
export function hubConnectionLabelKey(connected: boolean, hasUsername: boolean): string {
  if (!connected) return 'sidebar.hubDisconnected';
  return hasUsername ? 'sidebar.hubConnectedAs' : 'sidebar.hubConnected';
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Whether an org admin capped this member's allowance.
 *
 * Requires live org metadata: without it we cannot tell a capped member from a
 * self-managed owner, and guessing "capped" for an owner would show them a
 * stale, smaller figure. Callers that have no org data (the popover/drawer) pass
 * `null` and correctly get the self-managed answer.
 */
export function isPersonalLimit(
  plan: HubPlanLike | null | undefined,
  orgMeta?: HubOrgLike | null,
): boolean {
  const limit = plan?.memberCuLimit;
  if (limit == null || limit <= 0) return false;
  if (!orgMeta) return false;
  return orgMeta.role !== 'owner'
    && orgMeta.role !== 'admin'
    && (orgMeta.memberCount ?? 1) > 1;
}

/**
 * Resolve the period budget, amount used, and what is left.
 *
 * `creditsBudgetCu` is preferred over the monthly+bonus+purchased column sum
 * because the columns are drawn down unevenly, so their total is not the
 * balance. The column sum survives only as the last-resort fallback for older
 * Hub payloads that omit the budget field.
 */
export function resolveCreditSummary(
  plan: HubPlanLike | null | undefined,
  orgMeta?: HubOrgLike | null,
): CreditSummary {
  if (!plan) return EMPTY;

  const personalLimit = isPersonalLimit(plan, orgMeta);
  const hasMemberLimit = plan.memberCuLimit != null && plan.memberCuLimit > 0;
  const columnQuota = num(plan.monthlyQuotaCu) + num(plan.bonusCu) + num(plan.purchasedCu);

  const total = personalLimit
    ? num(plan.memberCuLimit)
    : (plan.creditsBudgetCu ?? (hasMemberLimit ? num(plan.memberCuLimit) : columnQuota));

  // Raw `??` rather than `num()` so each fallback is genuinely skipped when
  // absent — `num()` would collapse a missing field to 0 and wrongly stop the
  // chain. `memberCuUsed` is last: for a self-managed owner it is a leftover
  // face figure, so it must never outrank a real period/cuUsed value.
  const used = personalLimit
    ? num(plan.memberCuUsed)
    : (plan.totalConsumedThisPeriod ?? plan.cuUsed ?? plan.memberCuUsed ?? 0);

  const remaining = Math.max(0, total - used);
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;

  return { total, used, remaining, pct, personalLimit };
}
