/**
 * Credit derivation rules for the shared "available credits" figure.
 *
 * Every case corresponds to a real disagreement between the surfaces that used
 * to compute this independently, or to a state observed on the live Hub
 * payload. Pure-function tests only — no jsdom in this package.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveCreditSummary,
  isPersonalLimit,
  resolveHubCreditsAction,
  hubConnectionLabelKey,
  type HubPlanLike,
} from './hubCredits.ts';
import zhNav from '../locales/zh-CN/nav.json';
import enNav from '../locales/en/nav.json';
import zhCommon from '../locales/zh-CN/common.json';
import enCommon from '../locales/en/common.json';

describe('resolveCreditSummary — budget basis', () => {
  it('prefers creditsBudgetCu over the monthly+bonus+purchased column sum', () => {
    // The live regression: after bonus→monthly→purchased burns the column sum
    // read 11k while the real remaining budget was 19k. The popover rendered the
    // left-hand number, the overview bar the right-hand one — same account, two
    // different answers.
    const plan: HubPlanLike = {
      monthlyQuotaCu: 10_000,
      bonusCu: 1_000,
      purchasedCu: 0,
      creditsBudgetCu: 20_000,
      cuUsed: 1_000,
    };
    expect(resolveCreditSummary(plan).total).toBe(20_000);
    expect(resolveCreditSummary(plan).remaining).toBe(19_000);
  });

  it('falls back to the column sum when the Hub omits the budget field', () => {
    const plan: HubPlanLike = { monthlyQuotaCu: 500, bonusCu: 200, purchasedCu: 300, cuUsed: 100 };
    expect(resolveCreditSummary(plan).total).toBe(1_000);
    expect(resolveCreditSummary(plan).remaining).toBe(900);
  });
});

describe('resolveCreditSummary — consumed amount', () => {
  it('prefers totalConsumedThisPeriod over cuUsed', () => {
    // cuUsed is the monthly column only; a bonus-heavy period would understate use.
    const plan: HubPlanLike = { creditsBudgetCu: 1_000, cuUsed: 100, totalConsumedThisPeriod: 400 };
    expect(resolveCreditSummary(plan).used).toBe(400);
    expect(resolveCreditSummary(plan).remaining).toBe(600);
  });

  it('falls back to cuUsed when the period figure is absent', () => {
    expect(resolveCreditSummary({ creditsBudgetCu: 1_000, cuUsed: 250 }).used).toBe(250);
  });

  it('treats missing numbers as zero rather than NaN', () => {
    expect(resolveCreditSummary({ creditsBudgetCu: 1_000 }).used).toBe(0);
    expect(resolveCreditSummary({}).total).toBe(0);
    expect(resolveCreditSummary({}).remaining).toBe(0);
  });
});

describe('resolveCreditSummary — clamping', () => {
  it('never renders a negative balance', () => {
    const plan: HubPlanLike = { creditsBudgetCu: 100, totalConsumedThisPeriod: 250 };
    expect(resolveCreditSummary(plan).remaining).toBe(0);
  });

  it('caps pct at 100 and is 0 when there is no budget', () => {
    expect(resolveCreditSummary({ creditsBudgetCu: 100, totalConsumedThisPeriod: 250 }).pct).toBe(100);
    // A zero budget must not divide-by-zero into NaN% width.
    expect(resolveCreditSummary({ totalConsumedThisPeriod: 50 }).pct).toBe(0);
  });

  it('returns an empty summary for a missing plan', () => {
    for (const v of [null, undefined]) {
      expect(resolveCreditSummary(v)).toEqual({ total: 0, used: 0, remaining: 0, pct: 0, personalLimit: false });
    }
  });
});

describe('isPersonalLimit — who owns the cap', () => {
  it('is false without org metadata', () => {
    // The popover/drawer have no org data. Guessing "capped" would show an owner
    // a stale, smaller allowance than they actually hold.
    expect(isPersonalLimit({ memberCuLimit: 500 }, null)).toBe(false);
    expect(isPersonalLimit({ memberCuLimit: 500 }, undefined)).toBe(false);
  });

  it('is true only for a member capped inside a multi-person org', () => {
    expect(isPersonalLimit({ memberCuLimit: 500 }, { role: 'member', memberCount: 4 })).toBe(true);
  });

  it('is false for owners and admins even when a limit is present', () => {
    // memberCuLimit may be a leftover face-collapsed value on their record.
    expect(isPersonalLimit({ memberCuLimit: 500 }, { role: 'owner', memberCount: 4 })).toBe(false);
    expect(isPersonalLimit({ memberCuLimit: 500 }, { role: 'admin', memberCount: 4 })).toBe(false);
  });

  it('is false in a solo org regardless of role', () => {
    expect(isPersonalLimit({ memberCuLimit: 500 }, { role: 'member', memberCount: 1 })).toBe(false);
  });

  it('is false when the limit is absent or non-positive', () => {
    expect(isPersonalLimit({}, { role: 'member', memberCount: 4 })).toBe(false);
    expect(isPersonalLimit({ memberCuLimit: 0 }, { role: 'member', memberCount: 4 })).toBe(false);
    expect(isPersonalLimit({ memberCuLimit: null }, { role: 'member', memberCount: 4 })).toBe(false);
  });
});

describe('resolveHubCreditsAction', () => {
  it('starts sign-in when signed out', () => {
    expect(resolveHubCreditsAction(false)).toBe('login');
  });

  it('opens billing when signed in, so a tapped row is never inert', () => {
    // The drawer can show the balance but not buy credits; a connected user
    // tapping a row that does nothing reads as a broken button.
    expect(resolveHubCreditsAction(true)).toBe('billing');
  });
});

describe('hubConnectionLabelKey', () => {
  it('reports disconnected regardless of a cached username', () => {
    expect(hubConnectionLabelKey(false, true)).toBe('sidebar.hubDisconnected');
    expect(hubConnectionLabelKey(false, false)).toBe('sidebar.hubDisconnected');
  });

  it('names the account when connected and known', () => {
    expect(hubConnectionLabelKey(true, true)).toBe('sidebar.hubConnectedAs');
  });

  it('falls back to a bare connected label when the username is missing', () => {
    expect(hubConnectionLabelKey(true, false)).toBe('sidebar.hubConnected');
  });
});

describe('drawer i18n keys exist in both locales', () => {
  // Missing keys do not throw in i18next — they render as the raw key, so a
  // drawer cell reading "sidebar.hubConnectedAs" would ship silently. This is
  // the only place that can catch it, since the package has no DOM tests.
  const nav = { 'zh-CN': zhNav, en: enNav } as const;
  const common = { 'zh-CN': zhCommon, en: enCommon } as const;

  for (const locale of ['zh-CN', 'en'] as const) {
    it(`${locale}: every nav:sidebar key the drawer uses is defined`, () => {
      // Locale JSON is nested, so go through `unknown` and then assert the value
      // is actually a *string* — a key that exists but holds a nested object
      // would render as "[object Object]" rather than the raw key.
      const sidebar = (nav[locale] as unknown as { sidebar?: Record<string, unknown> }).sidebar;
      expect(sidebar, `${locale} nav:sidebar`).toBeTruthy();
      for (const key of ['hubDisconnected', 'hubConnectedAs', 'hubConnected', 'hubLoginShort']) {
        expect(typeof sidebar?.[key], `${locale} nav:sidebar.${key}`).toBe('string');
      }
    });

    it(`${locale}: every common key the drawer and settings logout use is defined`, () => {
      const c = common[locale] as unknown as Record<string, unknown>;
      for (const key of ['creditBalance', 'signOut', 'signOutConfirmTitle', 'signOutConfirmMessage']) {
        expect(typeof c[key], `${locale} common:${key}`).toBe('string');
      }
    });
  }
});

describe('resolveCreditSummary — personal limit override', () => {
  it('uses the member cap as both budget and consumed basis when capped', () => {
    const plan: HubPlanLike = {
      creditsBudgetCu: 50_000,
      totalConsumedThisPeriod: 10_000,
      memberCuLimit: 5_000,
      memberCuUsed: 4_500,
    };
    const s = resolveCreditSummary(plan, { role: 'member', memberCount: 9 });
    expect(s.personalLimit).toBe(true);
    expect(s.total).toBe(5_000);
    expect(s.used).toBe(4_500);
    expect(s.remaining).toBe(500);
    expect(s.pct).toBe(90);
  });

  it('ignores the member cap for a self-managed owner', () => {
    const plan: HubPlanLike = {
      creditsBudgetCu: 50_000,
      totalConsumedThisPeriod: 10_000,
      memberCuLimit: 5_000,
      memberCuUsed: 4_500,
    };
    const s = resolveCreditSummary(plan, { role: 'owner', memberCount: 9 });
    expect(s.personalLimit).toBe(false);
    expect(s.total).toBe(50_000);
    expect(s.remaining).toBe(40_000);
  });
});
