/**
 * 组织标识 + 订阅账户信息。
 *
 * ## slug 的权威在哪（这一行的形态由它决定）
 *
 * slug 是全局唯一的命名空间（防抢注），**唯一权威是 markus.global**。本机离线时
 * 根本不可能知道某个名字有没有被别人占用，所以本地不是一个合法的写者。
 *
 * 现状（改造前）是个陷阱：本地 `PUT /api/orgs/:id/slug` 只写本地，而登录时
 * `syncHubOrgIdentity` 会拿 Hub 的 slug 覆盖本地 —— 用户改了一个 Hub 不知道的
 * 名字，下次登录被静默改回去，还不知道为什么。
 *
 * 因此按绑定状态分流：
 *  - 已绑定 Hub（hubOrgId 非空）→ 本机只读，按钮引导去 Hub 改。改完下次登录自动同步回来。
 *  - 纯本地组织 → 本地就是唯一权威，就地编辑（不存在跨世界冲突）。
 *
 * 不提供「本地改完推给 Hub」：那需要 Hub 先有更新端点，且会让本地重新变成第二写者。
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
 * 组织标识 —— 订阅账户表格里的一行。
 *
 * 只有一个写者的判断在这里：已绑定 Hub 时不给编辑控件（给了就是在制造分歧数据），
 * 未绑定时就地编辑（本地即权威）。
 */
function OrgSlugRow({ orgId }: { orgId?: string }) {
  const { t } = useTranslation(['settings', 'common']);
  const [state, setState] = useState<OrgIdentityState | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SlugError | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!orgId) {
      setLoading(false);
      return;
    }
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
      const body = (await res.json().catch(() => ({}))) as SlugError;
      if (!res.ok) {
        setError({ code: body.code ?? 'ERROR', hint: body.hint });
        return;
      }
      setSaved(true);
      setEditing(false);
      await load();
    } catch (err) {
      setError({ code: 'NETWORK', hint: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="text-xs text-fg-tertiary">{t('common:loading')}</p>;
  if (!state) return null;

  const slug = state.orgSlug ?? '';
  const synced = !!state.hubOrgId;
  // 已绑定 Hub ⇒ 不以本地为权威；已锁定 ⇒ 有成依赖的历史，不能改。
  const canEditHere = !synced && !state.locked;

  return (
    <div className="rounded-md border border-brand-500/25 bg-brand-600/[0.06] px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="shrink-0 text-xs text-fg-tertiary">{t('orgIdentity.label')}</span>
        <div className="flex min-w-0 items-center gap-2">
          <code className="truncate font-mono text-xs text-fg-primary">
            {slug || t('orgIdentity.unset')}
          </code>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
              synced ? 'bg-green-500/15 text-green-600' : 'bg-surface-elevated text-fg-tertiary'
            }`}
          >
            {synced ? t('orgIdentity.synced') : t('orgIdentity.localOnly')}
          </span>
          {/* 已绑定 Hub 时不给编辑控件：Hub 是唯一权威，本地改了会被下次登录覆盖。
              Hub 侧目前也还没有 slug 编辑入口（见 PR 说明），所以这里只如实展示状态，
              不放一个点过去也改不了的按钮。 */}
          {!synced && canEditHere && (
            <button
              type="button"
              onClick={() => {
                setEditing((v) => !v);
                setError(null);
                setSaved(false);
              }}
              className="shrink-0 rounded bg-brand-600 px-2 py-1 text-[11px] font-medium text-on-brand transition-colors hover:bg-brand-500"
            >
              {t('orgIdentity.edit')}
            </button>
          )}
        </div>
      </div>

      {state.locked && (
        <p className="mt-1.5 text-[11px] text-amber-600">
          {t('orgIdentity.locked', { count: state.issuedAddresses })}
        </p>
      )}

      {editing && canEditHere && (
        <div className="mt-2 space-y-2 border-t border-border-subtle pt-2">
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(false);
                setError(null);
              }}
              placeholder={t('orgIdentity.placeholder')}
              spellCheck={false}
              aria-label={t('orgIdentity.inputLabel')}
              className="min-w-0 flex-1 rounded-md border border-border-default bg-surface-primary px-2.5 py-1.5 font-mono text-xs text-fg-primary outline-none focus:border-brand-500"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !draft.trim() || draft.trim() === slug}
              className="shrink-0 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-on-brand transition-colors hover:bg-brand-500 disabled:opacity-50"
            >
              {busy ? t('orgIdentity.saving') : t('orgIdentity.save')}
            </button>
          </div>
          <p className="text-[11px] text-fg-tertiary">{t('orgIdentity.rule')}</p>
          {saved && <p className="text-[11px] text-green-600">{t('orgIdentity.saved')}</p>}
          {error && (
            <p className="text-[11px] text-red-500">
              {t(`orgIdentity.err.${error.code}`, error.code)}
              {error.hint && <span className="ml-1 font-mono text-red-500/80">{error.hint}</span>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Markus 订阅账户 —— 套餐 / 额度 / 成员 / 邀请。
 *
 * 只读：本地没有成员管理 API（`/api/orgs/*` 只有 GET、POST 和 slug），改成员、换套餐
 * 都在 markus.global 完成。这里让用户看清自己是什么状态，并给出去处。
 */
export function OrgSummarySection({ authUser }: { authUser?: AuthUser }) {
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
    <div className="space-y-3">
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

      {/* 表格：组织标识（特殊配色，可操作）在前，订阅事实在后。 */}
      <div className="space-y-2">
        <OrgSlugRow orgId={authUser?.orgId} />

        <div className="space-y-3 rounded-lg border border-border-default px-5 py-4">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-fg-tertiary">{t('orgSummary.plan')}</span>
            <span className="rounded border border-brand-500/15 bg-brand-600/10 px-2 py-0.5 text-xs font-semibold capitalize text-brand-500">
              {planInfo?.planType ?? t('orgSummary.planUnknown')}
            </span>
          </div>
          {creditsTotal > 0 && (
            <div className="flex items-center justify-between gap-3 text-xs">
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
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-fg-tertiary">{t('org.nameLabel')}</span>
                <span className="font-medium text-fg-primary">{primaryOrg.name}</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-fg-tertiary">{t('account.memberCount')}</span>
                <span className="font-medium text-fg-primary">{primaryOrg.memberCount}</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-fg-tertiary">{t('org.orgId')}</span>
                <code className="rounded bg-surface-elevated px-1.5 py-0.5 text-[11px] text-fg-secondary">
                  {primaryOrg.id}
                </code>
              </div>
            </>
          )}

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
    </div>
  );
}
