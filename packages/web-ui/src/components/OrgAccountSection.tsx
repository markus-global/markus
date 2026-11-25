/**
 * 组织标识 + 订阅账户信息。
 *
 * ## slug 只在 Hub 有意义
 *
 * slug 的唯一用途是 markus.global 上的**全局唯一命名空间**——`hub_organizations.slug`
 * 上有 `CREATE UNIQUE INDEX idx_orgs_slug`，唯一性由数据库层保证，唯一权威在 Hub。
 *
 * 因此本机不做任何编辑入口：
 *  - 未连接 Hub：没有全局命名空间，slug 是个无处可用的字符串，这一行不渲染。
 *  - 已连接 Hub：显示 Hub 镜像下来的值，修改在 Hub 侧完成。
 *
 * 历史教训（改造前）：本地 `PUT /api/orgs/:id/slug` 只写本地库，而登录时
 * `syncHubOrgIdentity` 会拿 Hub 的值覆盖本地 —— 用户改了个 Hub 不知道的名字，
 * 下次登录被静默回滚，且完全不知道为什么。任何"本地可编辑"的方案都会重演这个问题。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, getHubUser, getHubToken } from '../api';
import type { AuthUser } from '../api';

interface OrgIdentityState {
  orgSlug: string | null;
  hubOrgId: string | null;
}

/**
 * 组织标识 —— 订阅账户表格里的一行，只读镜像。
 *
 * 未绑定 Hub 时返回 null：没有 Hub 身份就没有全局命名空间，显示一个空标识行
 * 只会让人以为"我该填点什么"。
 */
function OrgSlugRow({ orgId }: { orgId?: string }) {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<OrgIdentityState | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    fetch(`/api/orgs/${orgId}/slug`, { credentials: 'include' })
      .then((res) => (res.ok ? (res.json() as Promise<OrgIdentityState>) : null))
      .then((data) => {
        if (!cancelled && data) setState(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // 没有 Hub 身份 = 没有全局命名空间 = 这一行不成立。
  if (!state?.hubOrgId) return null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-brand-500/25 bg-brand-600/[0.06] px-3 py-2">
      <span className="shrink-0 text-xs text-fg-tertiary">{t('orgIdentity.label')}</span>
      <div className="flex min-w-0 items-center gap-2">
        <code className="truncate font-mono text-xs text-fg-primary">
          {state.orgSlug || t('orgIdentity.unset')}
        </code>
        <span className="shrink-0 rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] text-green-600">
          {t('orgIdentity.synced')}
        </span>
      </div>
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

      {/* 表格：组织标识（特殊配色）在前，订阅事实在后。 */}
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
