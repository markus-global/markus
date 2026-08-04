import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, getHubUser, type AgentUsageInfo, type OpsDashboard, type TeamInfo } from '../api.ts';
import { openExternal } from '../hooks/useElectron.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';

interface HubPlanInfo {
  orgId?: string | null;
  planType: string; planStatus: string;
  monthlyQuotaCu: number; cuUsed: number; cuResetAt: string | null;
  bonusCu: number; purchasedCu: number; windowQuotaCu: number;
  windowCuUsed?: number;
  totalConsumedThisPeriod?: number;
  creditsBudgetCu?: number;
  memberCuLimit?: number | null;
  memberCuUsed?: number;
}

export interface Contributor {
  id: string;
  name: string;
  type: 'agent' | 'human';
  role: string;
  teamName?: string;
  status?: string;
  tasksCompleted: number;
  tasksFailed: number;
  cuUsed: number;
  cuUsedToday: number;
  totalTokens: number;
  tokensToday: number;
  requestCount: number;
  toolCalls: number;
  healthScore: number;
  efficiency: number;
  provider?: string;
  avatarUrl?: string;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatCu(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function useOverviewUsageData(active: boolean, ops: OpsDashboard | null, teams: TeamInfo[]) {
  const [agents, setAgents] = useState<AgentUsageInfo[]>([]);
  const [hubPlan, setHubPlan] = useState<HubPlanInfo | null>(null);
  const [hubOrgMeta, setHubOrgMeta] = useState<{ role: string; memberCount: number } | null>(null);
  const [hubConnected, setHubConnected] = useState(hubApi.isAuthenticated());

  const fetchUsage = useCallback(async () => {
    try {
      const usage = await api.usage.agents();
      setAgents(usage.agents);
    } catch { /* */ }
  }, []);

  const fetchHubData = useCallback(async () => {
    if (!hubApi.isAuthenticated()) { setHubConnected(false); setHubOrgMeta(null); return; }
    setHubConnected(true);
    // Daily credit trends live on Hub Settings only — Overview just needs quota.
    try {
      const [plan, mine] = await Promise.all([
        hubApi.user.plan(),
        api.hubOrgs.mine().catch(() => null),
      ]);
      setHubPlan(plan);
      const org = mine?.orgs?.find(o => o.id === plan.orgId) ?? mine?.orgs?.[0];
      setHubOrgMeta(org ? { role: org.role, memberCount: org.memberCount ?? 1 } : null);
    } catch { /* */ }
  }, []);

  useEffect(() => {
    if (!active) return;
    fetchUsage();
    fetchHubData();
    const i = setInterval(fetchUsage, 30_000);
    const onDataChanged = () => {
      void fetchUsage();
      void fetchHubData();
    };
    window.addEventListener('markus:data-changed', onDataChanged);
    return () => {
      clearInterval(i);
      window.removeEventListener('markus:data-changed', onDataChanged);
    };
  }, [active, fetchUsage, fetchHubData]);

  const contributors = useMemo(() => {
    const result: Contributor[] = [];
    const teamMap = new Map<string, string>();
    for (const t of teams) {
      for (const m of t.members) teamMap.set(m.id, t.name);
    }
    const effMap = new Map((ops?.agentEfficiency ?? []).map(e => [e.agentId, e]));

    for (const a of agents) {
      const eff = effMap.get(a.agentId);
      const cu = a.cuUsed ?? 0;
      const tokens = a.totalTokens;
      const tasksCompleted = eff?.taskMetrics.completed ?? 0;
      const efficiency = tokens > 0 ? (tasksCompleted / tokens) * 1000 : (tasksCompleted > 0 ? Infinity : 0);
      result.push({
        id: a.agentId,
        name: a.agentName,
        type: 'agent',
        role: a.role,
        teamName: teamMap.get(a.agentId),
        status: a.status,
        tasksCompleted,
        tasksFailed: eff?.taskMetrics.failed ?? 0,
        cuUsed: cu,
        cuUsedToday: a.cuUsedToday ?? 0,
        totalTokens: tokens,
        tokensToday: a.tokensUsedToday,
        requestCount: a.requestCount,
        toolCalls: a.toolCalls,
        healthScore: eff?.healthScore ?? 0,
        efficiency,
        provider: a.provider,
      });
    }

    result.sort((a, b) => {
      return (b.cuUsed + b.tasksCompleted * 100) - (a.cuUsed + a.tasksCompleted * 100) === 0
        ? b.totalTokens - a.totalTokens
        : (b.cuUsed + b.tasksCompleted * 100) - (a.cuUsed + a.tasksCompleted * 100);
    });
    return result;
  }, [agents, ops, teams]);

  return {
    contributors,
    hubPlan,
    hubOrgMeta,
    hubConnected,
  };
}

function CollapsibleUsageCard({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation('home');
  const [expanded, setExpanded] = useState(false);

  return (
    <section className={`bg-surface-elevated shadow-sm rounded-2xl ${expanded ? 'overflow-visible' : 'overflow-hidden'}`}>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full px-4 sm:px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-surface-overlay/40 transition-colors text-left rounded-2xl"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold text-fg-primary truncate">{title}</h3>
          {badge}
        </div>
        <span className="flex items-center gap-1.5 text-[11px] text-fg-tertiary shrink-0">
          <span className="hidden sm:inline">{expanded ? t('usage.trends.collapse') : t('usage.trends.expand')}</span>
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {expanded && <div className="rounded-b-2xl overflow-visible">{children}</div>}
    </section>
  );
}

export function CloudQuotaBar({ hubConnected, hubPlan, hubOrgMeta }: {
  hubConnected: boolean;
  hubPlan: HubPlanInfo | null;
  hubOrgMeta?: { role: string; memberCount: number } | null;
}) {
  const { t } = useTranslation('home');
  const hubUser = getHubUser();

  if (!hubConnected) {
    return (
      <div className="px-4 sm:px-5 pb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-2 h-2 rounded-full bg-gray-500 shrink-0" />
          <span className="text-sm text-fg-tertiary">{t('usage.quota.notConnected')}</span>
        </div>
        <button onClick={() => hubApi.ensureAuth().catch(() => {})}
          className="px-3 py-1.5 text-xs font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-500 transition-colors shrink-0">
          {t('usage.quota.connect')}
        </button>
      </div>
    );
  }

  if (!hubPlan) {
    return (
      <div className="px-4 sm:px-5 pb-4 text-sm text-fg-tertiary">
        {t('usage.trends.noData')}
      </div>
    );
  }

  const hasMemberLimit = hubPlan.memberCuLimit != null && hubPlan.memberCuLimit > 0;
  // Owners/admins (and solo orgs) set their own allocation — don't imply a third-party admin.
  const isSelfManagedOrg = !hubOrgMeta
    || hubOrgMeta.role === 'owner'
    || hubOrgMeta.role === 'admin'
    || hubOrgMeta.memberCount <= 1;
  const showAdminLimitBanner = hasMemberLimit && !isSelfManagedOrg;
  const columnQuota = (hubPlan.monthlyQuotaCu ?? 0) + (hubPlan.bonusCu ?? 0) + (hubPlan.purchasedCu ?? 0);
  // Self-managed: period budget (used+remaining). Personal A only for admin-capped members.
  // Never use shrunk M+B+P face after B→M→P burns (that showed 11k instead of 19k).
  const totalQuota = showAdminLimitBanner
    ? hubPlan.memberCuLimit!
    : (hubPlan.creditsBudgetCu ?? (hasMemberLimit ? hubPlan.memberCuLimit! : columnQuota));
  const cuUsed = showAdminLimitBanner
    ? (hubPlan.memberCuUsed ?? 0)
    : (hubPlan.totalConsumedThisPeriod ?? hubPlan.memberCuUsed ?? 0);
  const pct = totalQuota > 0 ? Math.min(100, Math.round((cuUsed / totalQuota) * 100)) : 0;
  const barColor = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-brand-500';

  const openBilling = () => {
    openExternal(`${hubApi.getUrl().replace(/\/$/, '')}/settings?tab=billing`);
  };

  return (
    <div className="px-4 sm:px-5 pb-4">
      {showAdminLimitBanner && (
        <div className="mb-2 px-3 py-1.5 rounded-lg text-[10px] bg-amber-500/8 text-amber-500/80 border border-amber-500/15">
          {t('usage.quota.personalLimit')}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-fg-secondary">
            {hasMemberLimit && !isSelfManagedOrg
              ? t('usage.quota.personalLimitLabel')
              : t('usage.quota.title')}
          </span>
          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-brand-500/10 text-brand-500 uppercase shrink-0">
            {hubPlan.planType}
          </span>
          {hubUser?.username && (
            <span className="text-[10px] text-fg-tertiary truncate">
              {t('usage.quota.connectedAs', { username: hubUser.username })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-[10px] text-fg-tertiary">
          <span>{hubPlan.cuResetAt ? t('usage.quota.resetsAt', { date: new Date(hubPlan.cuResetAt).toLocaleDateString() }) : ''}</span>
          <button
            type="button"
            className="px-2 py-1 bg-brand-600 text-white rounded hover:bg-brand-500 transition-colors font-medium"
            onClick={e => { e.stopPropagation(); openBilling(); }}
          >
            {t('usage.quota.topUp')}
          </button>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 bg-surface-overlay rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs text-fg-secondary tabular-nums shrink-0">
          {formatCu(cuUsed)} / {formatCu(totalQuota)}
        </span>
      </div>
    </div>
  );
}

export function ContributorRankings({ contributors }: { contributors: Contributor[] }) {
  const { t } = useTranslation('home');
  const [sortBy, setSortBy] = useState<'cuUsed' | 'tasksCompleted' | 'totalTokens' | 'efficiency'>('totalTokens');
  const [sortDesc, setSortDesc] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED_COUNT = 10;

  const handleSort = (col: typeof sortBy) => {
    if (sortBy === col) setSortDesc(!sortDesc);
    else { setSortBy(col); setSortDesc(true); }
  };

  const sorted = useMemo(() => {
    return [...contributors].sort((a, b) => {
      const aVal = a[sortBy] === Infinity ? 999999 : (a[sortBy] as number);
      const bVal = b[sortBy] === Infinity ? 999999 : (b[sortBy] as number);
      return sortDesc ? bVal - aVal : aVal - bVal;
    });
  }, [contributors, sortBy, sortDesc]);

  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED_COUNT);
  const maxTokens = Math.max(1, ...contributors.map(c => c.totalTokens));
  const hasAnyCu = contributors.some(c => c.cuUsed > 0);
  const providers = new Set(contributors.filter(c => c.provider).map(c => c.provider));
  const isMixedProvider = providers.size > 1 || (providers.size === 1 && !providers.has('markus'));

  const mixedBadge = isMixedProvider ? (
    <span className="text-[10px] text-fg-tertiary bg-surface-overlay px-2 py-0.5 rounded shrink-0">
      {t('usage.agents.mixedProviders')}
    </span>
  ) : undefined;

  if (contributors.length === 0) {
    return (
      <CollapsibleUsageCard title={t('usage.agents.title')}>
        <div className="px-4 sm:px-5 pb-6 text-center">
          <p className="text-sm text-fg-tertiary">{t('usage.agents.noData')}</p>
        </div>
      </CollapsibleUsageCard>
    );
  }

  return (
    <CollapsibleUsageCard title={t('usage.agents.title')} badge={mixedBadge}>
      <div className="overflow-x-auto scrollbar-thin border-t border-border-default">
        <table className="w-full min-w-[520px]">
          <thead>
            <tr className="border-b border-border-default text-xs text-fg-tertiary uppercase tracking-wider">
              <th className="px-3 sm:px-4 py-3 text-left font-medium w-8">#</th>
              <th className="px-3 sm:px-4 py-3 text-left font-medium">{t('usage.agents.name')}</th>
              <th className="px-3 sm:px-4 py-3 text-left font-medium hidden sm:table-cell">{t('usage.agents.team')}</th>
              <SortTH label={t('usage.agents.tasks')} col="tasksCompleted" current={sortBy} desc={sortDesc} onSort={handleSort} />
              <SortTH label={t('usage.agents.tokens')} col="totalTokens" current={sortBy} desc={sortDesc} onSort={handleSort} />
              {hasAnyCu && <SortTH label={t('usage.agents.cuUsed')} col="cuUsed" current={sortBy} desc={sortDesc} onSort={handleSort} />}
              <SortTH label={t('usage.agents.efficiency')} col="efficiency" current={sortBy} desc={sortDesc} onSort={handleSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {visible.map((c, i) => (
              <ContributorRow key={c.id} contributor={c} rank={i + 1} maxTokens={maxTokens} showCu={hasAnyCu} />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border-default bg-surface-elevated/30">
              <td colSpan={2} className="px-3 sm:px-4 py-3 text-sm font-medium text-fg-secondary sm:hidden">
                {t('usage.agents.total', { count: contributors.length })}
              </td>
              <td colSpan={3} className="px-3 sm:px-4 py-3 text-sm font-medium text-fg-secondary hidden sm:table-cell">
                {t('usage.agents.total', { count: contributors.length })}
              </td>
              <td className="px-3 sm:px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">
                {contributors.reduce((s, c) => s + c.tasksCompleted, 0)}
              </td>
              <td className="px-3 sm:px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">
                {formatNumber(contributors.reduce((s, c) => s + c.totalTokens, 0))}
              </td>
              {hasAnyCu && (
                <td className="px-3 sm:px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">
                  {formatCu(contributors.reduce((s, c) => s + c.cuUsed, 0))}
                </td>
              )}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {sorted.length > COLLAPSED_COUNT && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="w-full px-4 py-2.5 text-xs font-medium text-brand-500 hover:bg-surface-overlay/40 border-t border-border-default transition-colors"
        >
          {expanded ? t('usage.agents.showLess') : t('usage.agents.showAll', { count: sorted.length })}
        </button>
      )}
    </CollapsibleUsageCard>
  );
}

function ContributorRow({ contributor: c, rank, maxTokens, showCu }: {
  contributor: Contributor; rank: number; maxTokens: number; showCu: boolean;
}) {
  const barWidth = maxTokens > 0 ? Math.min(100, (c.totalTokens / maxTokens) * 100) : 0;
  const statusColor = c.status === 'working' ? 'bg-blue-500' :
    c.status === 'idle' ? 'bg-green-500' :
    c.status === 'error' ? 'bg-red-500' : 'bg-gray-500';
  const effLabel = c.tasksCompleted === 0
    ? '—'
    : c.totalTokens > 0 ? `${c.efficiency.toFixed(1)}` : '∞';
  const rankBadge = rank <= 3
    ? `${rank === 1 ? 'text-amber-500' : rank === 2 ? 'text-gray-400' : 'text-amber-700'} font-bold`
    : 'text-fg-tertiary';
  const providerLabel = c.provider === 'markus' ? '' : c.provider ?? '';

  return (
    <tr
      className="border-b border-border-default/50 hover:bg-surface-elevated/30 transition-colors cursor-pointer"
      onClick={() => navBus.navigate(PAGE.TEAM, { selectAgent: c.id })}
    >
      <td className={`px-3 sm:px-4 py-3 text-sm tabular-nums ${rankBadge}`}>{rank}</td>
      <td className="px-3 sm:px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-2 h-2 rounded-full ${statusColor} shrink-0`} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-fg-primary truncate">{c.name}</span>
              {providerLabel && (
                <span className="px-1 py-0.5 rounded text-[8px] font-medium bg-surface-overlay text-fg-tertiary shrink-0">{providerLabel}</span>
              )}
            </div>
            <div className="text-[10px] text-fg-tertiary truncate">
              {c.role}
              <span className="sm:hidden">{c.teamName ? ` · ${c.teamName}` : ''}</span>
            </div>
          </div>
        </div>
      </td>
      <td className="px-3 sm:px-4 py-3 text-xs text-fg-tertiary hidden sm:table-cell">{c.teamName || '—'}</td>
      <td className="px-3 sm:px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-fg-secondary tabular-nums">{c.tasksCompleted}</span>
          {c.tasksFailed > 0 && (
            <span className="text-[10px] text-red-500 tabular-nums">({c.tasksFailed})</span>
          )}
        </div>
      </td>
      <td className="px-3 sm:px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden max-w-[80px] hidden md:block">
            <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${barWidth}%` }} />
          </div>
          <span className="text-sm text-fg-secondary tabular-nums">{formatNumber(c.totalTokens)}</span>
        </div>
      </td>
      {showCu && (
        <td className="px-3 sm:px-4 py-3 text-sm text-fg-secondary tabular-nums">
          {c.cuUsed > 0 ? formatCu(c.cuUsed) : <span className="text-fg-tertiary">—</span>}
        </td>
      )}
      <td className="px-3 sm:px-4 py-3 text-right">
        <span className={`text-sm font-medium tabular-nums ${
          c.tasksCompleted === 0 ? 'text-fg-tertiary'
          : c.efficiency > 5 ? 'text-green-500' : c.efficiency > 1 ? 'text-fg-secondary' : 'text-amber-500'
        }`}>{effLabel}</span>
      </td>
    </tr>
  );
}

type SortCol = 'cuUsed' | 'tasksCompleted' | 'totalTokens' | 'efficiency';

function SortTH({ label, col, current, desc, onSort, align }: {
  label: string; col: SortCol; current: SortCol; desc: boolean; onSort: (c: SortCol) => void; align?: string;
}) {
  const arrow = current === col ? (desc ? '↓' : '↑') : '↕';
  const arrowColor = current === col ? 'text-brand-500' : 'text-fg-muted';
  return (
    <th className={`px-3 sm:px-4 py-3 ${align === 'right' ? 'text-right' : 'text-left'} font-medium cursor-pointer select-none hover:text-fg-secondary`}
      onClick={() => onSort(col)}>
      {label}<span className={`ml-1 ${arrowColor}`}>{arrow}</span>
    </th>
  );
}

/**
 * Usage tier — kept low and collapsed by default so Overview stays action-first.
 * Quota only here; daily credit trends are on Hub Settings (server-side truth).
 * BYOK users (own provider, no Markus) skip the Cloud AI card entirely.
 */
export function OverviewUsageTier({
  contributors,
  hubPlan,
  hubOrgMeta,
  hubConnected,
  showMarkusUsage,
}: {
  contributors: Contributor[];
  hubPlan: HubPlanInfo | null;
  hubOrgMeta?: { role: string; memberCount: number } | null;
  hubConnected: boolean;
  showMarkusUsage: boolean;
}) {
  const { t } = useTranslation('home');

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-fg-tertiary px-0.5">{t('usage.sectionTitle')}</h3>

      {showMarkusUsage && (
        <CollapsibleUsageCard title={t('usage.creditsTitle')}>
          <CloudQuotaBar hubConnected={hubConnected} hubPlan={hubPlan} hubOrgMeta={hubOrgMeta} />
        </CollapsibleUsageCard>
      )}

      <ContributorRankings contributors={contributors} />
    </div>
  );
}

export { formatNumber, formatCu };
