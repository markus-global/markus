/**
 * 组织标识（C10-D）—— 声明组织 slug 的唯一 UI 入口。
 *
 * slug 是本组织在所有组织中的唯一标识（C10-A 的防抢注门）。`declareOrgSlug`
 * 在此之前只有 storage 方法，没有任何 HTTP/UI 入口 —— 真实用户永远走不到"声明"这一步。
 * 这个页面就是那个缺失的入口。
 *
 * 三条产品规则（都由后端裁决，前端只负责如实呈现）：
 *  1. 只有 owner 能改（slug 全局唯一，不能让成员改走别人的名字）。
 *  2. 已派生标识的组织**锁定** —— 再改会让已经依赖它的东西变成悬空引用。
 *  3. 校验失败要给出 hint 与错误码，不能只说"保存失败"。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, getHubUser, getHubToken } from '../api';
import type { AuthUser } from '../api';

interface OrgIdentityState {
  orgId: string;
  orgSlug: string | null;
  hubOrgId: string | null;
  issuedAddresses: number;
  locked: boolean;
}

interface SlugError {
  code: string;
  hint?: string;
}

/**
 * 组织只读汇总：套餐 / 额度 / 成员 / 邀请。
 *
 * 为什么是只读：本地根本没有成员管理 API（`/api/orgs/*` 只有 GET、POST 和 slug），
 * 改成员、换套餐、买企业版都在 markus.global 完成。这里做的是「让用户在本机看清
 * 自己是什么状态，并给出一个明确的去处」，而不是造一套半吊子的本地权限体系。
 */
export function OrgSummarySection() {
  const { t } = useTranslation(['settings', 'common']);
  const [planInfo, setPlanInfo] = useState<{
    orgId?: string | null;
    planType: string;
    monthlyQuotaCu: number;
    cuUsed: number;
    bonusCu: number;
    purchasedCu?: number;
    totalConsumedThisPeriod?: number;
    creditsBudgetCu?: number;
    memberCuLimit?: number | null;
    memberCuUsed?: number;
  } | null>(null);
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string; slug: string; role: string; memberCount: number }>>([]);
  const [invitations, setInvitations] = useState<Array<{ orgId: string; orgName: string; invitedBy: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const loadOrgs = useCallback(() => {
    api.hubOrgs
      .mine()
      .catch((e) => {
        setMsg({ type: 'err', text: e instanceof Error ? e.message : t('org.loadFailed') });
        return { orgs: [] as Array<{ id: string; name: string; slug: string; role: string; memberCount: number }> };
      })
      .then((o) => {
        setOrgs(o.orgs);
        api.hubOrgs.invitations().then((inv) => setInvitations(inv.invitations)).catch(() => {});
      });
  }, [t]);

  useEffect(() => {
    if (!getHubUser() && !getHubToken()) {
      setLoading(false);
      return;
    }
    loadOrgs();
    hubApi.user
      .plan()
      .then((p) => setPlanInfo(p as typeof planInfo))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [loadOrgs]);

  const handleAcceptInvite = async (orgId: string) => {
    try {
      await api.hubOrgs.acceptInvitation(orgId);
      setInvitations((prev) => prev.filter((i) => i.orgId !== orgId));
      loadOrgs();
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof Error ? e.message : 'Failed' });
    }
  };

  const primaryOrg = orgs.find((o) => o.id === planInfo?.orgId) ?? orgs[0];
  const totalCredits = planInfo
    ? (planInfo.creditsBudgetCu ??
      (planInfo.monthlyQuotaCu ?? 0) + (planInfo.bonusCu ?? 0) + (planInfo.purchasedCu ?? 0))
    : 0;
  // 个人额度只对有上限的非 owner/admin 成员有意义；owner 看的是整期预算。
  const showPersonalLimit = !!(
    planInfo?.memberCuLimit != null &&
    planInfo.memberCuLimit > 0 &&
    primaryOrg &&
    primaryOrg.role !== 'owner' &&
    primaryOrg.role !== 'admin' &&
    primaryOrg.memberCount > 1
  );
  const creditsUsed = showPersonalLimit
    ? Math.round(planInfo?.memberCuUsed ?? 0)
    : Math.round(planInfo?.totalConsumedThisPeriod ?? planInfo?.cuUsed ?? 0);
  const creditsTotal = showPersonalLimit ? (planInfo?.memberCuLimit ?? 0) : totalCredits;

  if (loading) return <p className="text-sm text-fg-tertiary">{t('common:loading')}</p>;

  return (
    <div className="space-y-4">
      {msg && (
        <div
          className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm ${
            msg.type === 'ok'
              ? 'border border-green-500/20 bg-green-500/10 text-green-600'
              : 'border border-red-500/20 bg-red-500/10 text-red-500'
          }`}
        >
          <span>{msg.type === 'ok' ? '✓' : '✕'}</span>
          <span>{msg.text}</span>
        </div>
      )}

      {invitations.length > 0 && (
        <div className="space-y-2">
          {invitations.map((inv) => (
            <div
              key={inv.orgId}
              className="flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3"
            >
              <div className="text-sm">
                <span className="font-medium text-fg-primary">{inv.orgName}</span>
                <span className="ml-1 text-fg-tertiary">
                  — {t('org.invitedBy')} {inv.invitedBy}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleAcceptInvite(inv.orgId)}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-on-brand transition-colors hover:bg-brand-500"
              >
                {t('org.accept')}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3 rounded-lg border border-border-default px-5 py-4">
        <div className="flex items-center justify-between text-xs">
          <span className="text-fg-tertiary">{t('orgSummary.plan')}</span>
          <span className="rounded border border-brand-500/15 bg-brand-600/10 px-2 py-0.5 text-xs font-semibold capitalize text-brand-500">
            {planInfo?.planType ?? t('orgSummary.planUnknown')}
          </span>
        </div>
        {creditsTotal > 0 && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-fg-tertiary">
              {showPersonalLimit ? t('account.personalLimit') : t('account.credits')}
            </span>
            <span className="font-medium tabular-nums text-fg-primary">
              {creditsUsed.toLocaleString()} / {creditsTotal.toLocaleString()}
            </span>
          </div>
        )}
        {primaryOrg && (
          <>
            <div className="flex items-center justify-between text-xs">
              <span className="text-fg-tertiary">{t('org.nameLabel')}</span>
              <span className="font-medium text-fg-primary">{primaryOrg.name}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-fg-tertiary">{t('account.memberCount')}</span>
              <span className="font-medium text-fg-primary">{primaryOrg.memberCount}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-fg-tertiary">{t('org.orgId')}</span>
              <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[11px] text-fg-secondary">
                {primaryOrg.id}
              </code>
            </div>
          </>
        )}

        {/* 改动一律去 Hub：本地没有成员/计费 API，按钮必须说清"去哪儿做什么"。 */}
        <div className="flex flex-wrap gap-2 pt-1">
          <a
            href={`${hubApi.getUrl()}/settings?tab=billing`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-xs font-medium text-on-brand no-underline transition-colors hover:bg-brand-500"
          >
            {t('orgSummary.manageBilling')}
          </a>
          <a
            href={`${hubApi.getUrl()}/settings?tab=organization`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-4 py-2 text-xs font-medium text-fg-secondary no-underline transition-colors hover:bg-surface-elevated"
          >
            {t('orgSummary.manageMembers')}
          </a>
        </div>
      </div>
    </div>
  );
}

export function OrgIdentitySection({ authUser }: { authUser?: AuthUser }) {
  const { t } = useTranslation('settings');
  const orgId = authUser?.orgId;
  const isOwner = authUser?.role === 'owner';

  const [state, setState] = useState<OrgIdentityState | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SlugError | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/slug`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as OrgIdentityState;
        setState(data);
        setDraft(data.orgSlug ?? '');
      }
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!orgId) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/orgs/${orgId}/slug`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: draft.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as SlugError & { orgSlug?: string };
      if (!res.ok) {
        setError({ code: body.code ?? 'ERROR', hint: body.hint });
        return;
      }
      setSaved(true);
      await load();
    } catch (err) {
      setError({ code: 'NETWORK', hint: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const locked = state?.locked ?? false;
  const slug = state?.orgSlug ?? '';

  return (
    <div className="space-y-8">
      <OrgSummarySection />

      <div>
        <h2 className="text-lg font-semibold text-fg-primary">{t('orgIdentity.title')}</h2>
        <p className="mt-1 text-sm text-fg-secondary">{t('orgIdentity.desc')}</p>
      </div>

      {loading && <p className="text-sm text-fg-tertiary">{t('common:loading')}</p>}

      {!loading && state && (
        <div className="rounded-lg border border-border-default bg-surface-secondary p-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-fg-tertiary">
                {t('orgIdentity.current')}
              </p>
              <p className="mt-1 font-mono text-sm text-fg-primary">
                {slug || t('orgIdentity.unset')}
              </p>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                state.hubOrgId
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-amber-500/10 text-amber-600'
              }`}
            >
              {state.hubOrgId ? t('orgIdentity.hosted') : t('orgIdentity.localOnly')}
            </span>
          </div>

          {locked ? (
            <p className="rounded-md bg-surface-elevated p-3 text-sm text-fg-secondary">
              {t('orgIdentity.locked', { count: state.issuedAddresses })}
            </p>
          ) : isOwner ? (
            <div className="space-y-3">
              <label className="block text-sm text-fg-secondary" htmlFor="org-slug-input">
                {t('orgIdentity.inputLabel')}
              </label>
              <div className="flex gap-2">
                <input
                  id="org-slug-input"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setSaved(false);
                    setError(null);
                  }}
                  placeholder={t('orgIdentity.placeholder')}
                  spellCheck={false}
                  className="flex-1 rounded-md border border-border-default bg-surface-primary px-3 py-2 font-mono text-sm text-fg-primary outline-none focus:border-brand-500"
                />
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy || !draft.trim() || draft.trim() === slug}
                  className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-on-brand transition-colors hover:bg-brand-500 disabled:opacity-50"
                >
                  {busy ? t('orgIdentity.saving') : t('orgIdentity.save')}
                </button>
              </div>
              <p className="text-xs text-fg-tertiary">{t('orgIdentity.rule')}</p>
            </div>
          ) : (
            <p className="text-sm text-fg-secondary">{t('orgIdentity.ownerOnly')}</p>
          )}

          {saved && <p className="text-sm text-emerald-600">{t('orgIdentity.saved')}</p>}

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm">
              <p className="font-medium text-red-600">{t(`orgIdentity.err.${error.code}`, error.code)}</p>
              {error.hint && <p className="mt-1 font-mono text-xs text-red-500/80">{error.hint}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
