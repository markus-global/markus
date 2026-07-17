import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, type ReportInfo, type ReportFeedbackInfo, type AgentUsageInfo, type AuthUser, type OpsDashboard, type TeamInfo, type TeamMemberInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { MobileMenuButton } from '../components/MobileMenuButton.tsx';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { usePageActive } from '../hooks/usePageActive.ts';

interface ReportsPageProps { authUser?: AuthUser }

interface HubPlanInfo {
  planType: string; planStatus: string;
  monthlyQuotaCu: number; cuUsed: number; cuResetAt: string | null;
  bonusCu: number; purchasedCu: number; windowQuotaCu: number;
  totalConsumedThisPeriod?: number;
  memberCuLimit?: number | null;
  memberCuUsed?: number;
}

interface HubUsageStat {
  period: string; model: string | null;
  totalCu: number; totalInput: number; totalOutput: number; totalCached: number;
  requestCount: number;
}

// Unified contributor type merging agent efficiency + usage data
interface Contributor {
  id: string;
  name: string;
  type: 'agent' | 'human';
  role: string;
  teamId?: string;
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
  efficiency: number; // tasks per 1K tokens; higher = better
  provider?: string; // 'markus' | provider name | 'unknown'
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

export function ReportsPage({ authUser }: ReportsPageProps) {
  const { t } = useTranslation(['reports', 'common']);
  const isMobile = useIsMobile();
  const isActive = usePageActive(PAGE.REPORTS);

  const [tab, setTab] = useState<'dashboard' | 'history'>('dashboard');

  // Dashboard data
  const [opsDashboard, setOpsDashboard] = useState<OpsDashboard | null>(null);
  const [agents, setAgents] = useState<AgentUsageInfo[]>([]);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [ungrouped, setUngrouped] = useState<TeamMemberInfo[]>([]);

  // Hub data
  const [hubPlan, setHubPlan] = useState<HubPlanInfo | null>(null);
  const [hubStats, setHubStats] = useState<HubUsageStat[]>([]);
  const [hubGranularity, setHubGranularity] = useState<'day' | 'hour'>('day');
  const [hubDays, setHubDays] = useState(30);
  const [hubConnected, setHubConnected] = useState(hubApi.isAuthenticated());

  // History
  const [historyReports, setHistoryReports] = useState<ReportInfo[]>([]);
  const [selectedReport, setSelectedReport] = useState<ReportInfo | null>(null);
  const [feedback, setFeedback] = useState<ReportFeedbackInfo[]>([]);
  const [feedbackContent, setFeedbackContent] = useState('');
  const [flash, setFlash] = useState('');

  const showFlash = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 3000); };

  const fetchDashboard = useCallback(async () => {
    try {
      const [dashboard, usage, teamData] = await Promise.all([
        api.ops.dashboard('24h'),
        api.usage.agents(),
        api.teams.list(),
      ]);
      setOpsDashboard(dashboard);
      setAgents(usage.agents);
      setTeams(teamData.teams);
      setUngrouped(teamData.ungrouped);
    } catch { /* */ }
  }, []);

  const fetchHubData = useCallback(async () => {
    if (!hubApi.isAuthenticated()) { setHubConnected(false); return; }
    setHubConnected(true);
    try { const plan = await hubApi.user.plan(); setHubPlan(plan); } catch { /* */ }
    try {
      const { stats } = await hubApi.user.cuStats(hubDays, hubGranularity);
      setHubStats(stats);
    } catch { /* */ }
  }, [hubDays, hubGranularity]);

  const fetchHistory = useCallback(async () => {
    try { const { reports } = await api.reports.list(); setHistoryReports(reports); } catch { /* */ }
  }, []);

  useEffect(() => {
    if (!isActive || tab !== 'dashboard') return;
    fetchDashboard();
    fetchHubData();
    const i = setInterval(fetchDashboard, 30000);
    return () => clearInterval(i);
  }, [isActive, tab, fetchDashboard, fetchHubData]);

  useEffect(() => { if (tab === 'history') fetchHistory(); }, [tab, fetchHistory]);

  // Build unified contributor list
  const contributors = useMemo(() => {
    const result: Contributor[] = [];
    const teamMap = new Map<string, string>();
    for (const t of teams) {
      for (const m of t.members) teamMap.set(m.id, t.name);
    }

    const effMap = new Map(
      (opsDashboard?.agentEfficiency ?? []).map(e => [e.agentId, e])
    );

    for (const a of agents) {
      const eff = effMap.get(a.agentId);
      const cu = a.cuUsed ?? 0;
      const tokens = a.totalTokens;
      const tasksCompleted = eff?.taskMetrics.completed ?? 0;
      // Efficiency = tasks per 1K tokens (universal, works for all providers)
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

    // Add humans from teams + ungrouped
    const allMembers = [
      ...teams.flatMap(t => t.members.filter(m => m.type === 'human').map(m => ({ ...m, teamName: t.name }))),
      ...ungrouped.filter(m => m.type === 'human').map(m => ({ ...m, teamName: undefined })),
    ];
    const seenHumans = new Set<string>();
    for (const m of allMembers) {
      if (seenHumans.has(m.id)) continue;
      seenHumans.add(m.id);
      result.push({
        id: m.id,
        name: m.name,
        type: 'human',
        role: m.role,
        teamName: (m as any).teamName,
        status: undefined,
        tasksCompleted: 0,
        tasksFailed: 0,
        cuUsed: 0,
        cuUsedToday: 0,
        totalTokens: 0,
        tokensToday: 0,
        requestCount: 0,
        toolCalls: 0,
        healthScore: 0,
        efficiency: 0,
        avatarUrl: m.avatarUrl,
      });
    }

    // Sort: agents by CU used (desc), then humans at bottom
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'agent' ? -1 : 1;
      if (a.type === 'agent') return (b.cuUsed + b.tasksCompleted * 100) - (a.cuUsed + a.tasksCompleted * 100) === 0
        ? b.cuUsed - a.cuUsed
        : (b.cuUsed + b.tasksCompleted * 100) - (a.cuUsed + a.tasksCompleted * 100);
      return a.name.localeCompare(b.name);
    });

    return result;
  }, [agents, opsDashboard, teams, ungrouped]);

  // Aggregate team performance
  const teamPerformance = useMemo(() => {
    return teams.map(team => {
      const agentMembers = team.members.filter(m => m.type === 'agent');
      const humanMembers = team.members.filter(m => m.type === 'human');
      const agentContribs = contributors.filter(c => c.type === 'agent' && agentMembers.some(m => m.id === c.id));
      const totalCu = agentContribs.reduce((s, c) => s + c.cuUsed, 0);
      const totalTasks = agentContribs.reduce((s, c) => s + c.tasksCompleted, 0);
      const totalTokens = agentContribs.reduce((s, c) => s + c.totalTokens, 0);
      return {
        id: team.id,
        name: team.name,
        agentCount: agentMembers.length,
        humanCount: humanMembers.length,
        totalCu,
        totalTasks,
        totalTokens,
        managerName: team.managerName,
      };
    }).sort((a, b) => b.totalTokens - a.totalTokens);
  }, [teams, contributors]);

  // KPI values
  const kpis = useMemo(() => {
    const d = opsDashboard;
    const totalCu = agents.reduce((s, a) => s + (a.cuUsed ?? 0), 0);
    const totalCuToday = agents.reduce((s, a) => s + (a.cuUsedToday ?? 0), 0);
    const totalTokens = agents.reduce((s, a) => s + a.totalTokens, 0);
    const totalTokensToday = agents.reduce((s, a) => s + a.tokensUsedToday, 0);
    const hasCu = totalCu > 0;
    return {
      tasksCompleted: d?.taskKPI.statusCounts.completed ?? 0,
      totalTasks: d?.taskKPI.totalTasks ?? 0,
      successRate: d?.taskKPI.successRate ?? 0,
      activeAgents: d?.systemHealth.activeAgents ?? 0,
      totalAgents: d?.systemHealth.totalAgents ?? 0,
      healthScore: d?.systemHealth.overallScore ?? 0,
      totalCu,
      totalCuToday,
      totalTokens,
      totalTokensToday,
      hasCu,
      humanCount: contributors.filter(c => c.type === 'human').length,
    };
  }, [opsDashboard, agents, contributors]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto w-full p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4 flex-wrap">
            {isMobile && <MobileMenuButton />}
            <h1 className="text-xl font-semibold text-fg-primary">{t('title')}</h1>
            <div className="flex gap-1 bg-surface-elevated rounded-lg p-0.5">
              <TabButton active={tab === 'dashboard'} onClick={() => setTab('dashboard')}>{t('tabs.dashboard')}</TabButton>
              <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
                {t('tabs.history')}{historyReports.length > 0 ? ` (${historyReports.length})` : ''}
              </TabButton>
            </div>
          </div>
          {flash && <span className="px-2.5 py-1 bg-green-500/10 text-green-600 text-xs rounded-lg">{flash}</span>}
        </div>

        {/* ═══ Dashboard Tab ═══ */}
        {tab === 'dashboard' && (
          <>
            {/* KPI Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KPICard
                label={t('kpi.tasksCompleted')}
                value={kpis.tasksCompleted}
                sub={t('kpi.ofTotal', { total: kpis.totalTasks })}
                color="text-green-500"
              />
              <KPICard
                label={t('kpi.activeContributors')}
                value={kpis.activeAgents + kpis.humanCount}
                sub={t('kpi.agentsAndHumans', { agents: kpis.activeAgents, humans: kpis.humanCount })}
                color="text-brand-500"
              />
              <KPICard
                label={kpis.hasCu ? t('kpi.cuConsumed') : t('kpi.tokensConsumed')}
                value={kpis.hasCu ? formatCu(kpis.totalCu) : formatNumber(kpis.totalTokens)}
                sub={t('kpi.todayAmount', { amount: kpis.hasCu ? formatCu(kpis.totalCuToday) : formatNumber(kpis.totalTokensToday) })}
                color="text-indigo-500"
              />
              <KPICard
                label={t('kpi.successRate')}
                value={`${kpis.successRate}%`}
                sub={t('kpi.healthScore', { score: kpis.healthScore })}
                color={kpis.successRate >= 80 ? 'text-green-500' : kpis.successRate >= 50 ? 'text-amber-500' : 'text-red-500'}
              />
            </div>

            {/* Cloud AI Quota — compact */}
            <CloudQuotaBar
              hubConnected={hubConnected}
              hubPlan={hubPlan}
              t={t}
            />

            {/* Agent Rankings */}
            <ContributorRankings contributors={contributors.filter(c => c.type === 'agent')} t={t} />

            {/* Human Members */}
            {contributors.some(c => c.type === 'human') && (
              <HumanMembersList contributors={contributors.filter(c => c.type === 'human')} t={t} />
            )}

            {/* Team Performance */}
            {teamPerformance.length > 0 && (
              <section className="bg-surface-elevated rounded-xl p-5">
                <h3 className="text-sm font-semibold text-fg-secondary mb-4">{t('teamPerf.title')}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {teamPerformance.map(team => (
                    <TeamCard key={team.id} team={team} t={t} />
                  ))}
                </div>
              </section>
            )}

            {/* Usage Trends */}
            {hubConnected && (
              <section className="bg-surface-elevated rounded-xl overflow-hidden">
                <div className="p-5 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-fg-secondary">{t('trends.title')}</h3>
                  <div className="flex items-center gap-2">
                    <div className="flex gap-0.5 bg-surface-overlay rounded-md p-0.5">
                      <button onClick={() => setHubGranularity('day')}
                        className={`px-2 py-1 text-[10px] rounded transition-colors ${hubGranularity === 'day' ? 'bg-brand-600 text-white' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
                        {t('trends.byDay')}
                      </button>
                      <button onClick={() => setHubGranularity('hour')}
                        className={`px-2 py-1 text-[10px] rounded transition-colors ${hubGranularity === 'hour' ? 'bg-brand-600 text-white' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
                        {t('trends.byHour')}
                      </button>
                    </div>
                    <select value={hubDays} onChange={e => setHubDays(Number(e.target.value))}
                      className="text-[10px] bg-surface-overlay border border-border-default rounded-md px-1.5 py-1 text-fg-secondary">
                      <option value={7}>7 {t('trends.days')}</option>
                      <option value={14}>14 {t('trends.days')}</option>
                      <option value={30}>30 {t('trends.days')}</option>
                    </select>
                  </div>
                </div>
                <div className="px-5 pb-5">
                  <UsageCharts stats={hubStats} granularity={hubGranularity} t={t} />
                </div>
              </section>
            )}
          </>
        )}

        {/* ═══ History Tab ═══ */}
        {tab === 'history' && !selectedReport && (
          <HistoryList reports={historyReports} t={t} onSelect={async (r) => {
            setSelectedReport(r);
            try { const { feedback: fb } = await api.reports.getFeedback(r.id); setFeedback(fb); } catch { setFeedback([]); }
          }} />
        )}

        {tab === 'history' && selectedReport && (
          <ReportDetail
            report={selectedReport}
            feedback={feedback}
            feedbackContent={feedbackContent}
            setFeedbackContent={setFeedbackContent}
            authUser={authUser}
            t={t}
            onBack={() => { setSelectedReport(null); setFeedback([]); }}
            onFlash={showFlash}
            onFeedbackAdded={(fb) => setFeedback(prev => [...prev, fb])}
            onReportUpdated={(r) => { setSelectedReport(r); fetchHistory(); }}
          />
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// KPI Card
// ═══════════════════════════════════════════════════════════════════════════════

function KPICard({ label, value, sub, color }: { label: string; value: string | number; sub: string; color: string }) {
  return (
    <div className="bg-surface-elevated rounded-xl p-4">
      <div className="text-xs text-fg-tertiary mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color} tabular-nums`}>{value}</div>
      <div className="text-[10px] text-fg-tertiary mt-1">{sub}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cloud Quota Bar — compact
// ═══════════════════════════════════════════════════════════════════════════════

function CloudQuotaBar({ hubConnected, hubPlan, t }: {
  hubConnected: boolean; hubPlan: HubPlanInfo | null;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  if (!hubConnected) {
    return (
      <div className="bg-surface-elevated rounded-xl px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-gray-500" />
          <span className="text-sm text-fg-tertiary">{t('quota.notConnected')}</span>
        </div>
        <button onClick={() => hubApi.ensureAuth().catch(() => {})}
          className="px-3 py-1.5 text-xs font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-500 transition-colors">
          {t('quota.connect')}
        </button>
      </div>
    );
  }

  if (!hubPlan) return null;

  const hasMemberLimit = hubPlan.memberCuLimit != null && hubPlan.memberCuLimit > 0;
  const totalQuota = hasMemberLimit
    ? hubPlan.memberCuLimit!
    : (hubPlan.monthlyQuotaCu ?? 0) + (hubPlan.bonusCu ?? 0) + (hubPlan.purchasedCu ?? 0);
  const cuUsed = hasMemberLimit
    ? (hubPlan.memberCuUsed ?? 0)
    : hubPlan.totalConsumedThisPeriod ?? ((hubPlan.monthlyQuotaCu ?? 0) + (hubPlan.bonusCu ?? 0) + (hubPlan.purchasedCu ?? 0) - Math.max(0, (hubPlan.monthlyQuotaCu ?? 0) - (hubPlan.cuUsed ?? 0)) - (hubPlan.bonusCu ?? 0) - (hubPlan.purchasedCu ?? 0));
  const pct = totalQuota > 0 ? Math.min(100, Math.round((cuUsed / totalQuota) * 100)) : 0;
  const barColor = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-brand-500';

  const hubUrl = typeof window !== 'undefined' && window.location.origin.includes('localhost')
    ? 'http://localhost:5174/settings?tab=billing' : 'https://markus.global/settings?tab=billing';

  return (
    <div className="bg-surface-elevated rounded-xl px-5 py-3">
      {hasMemberLimit && (
        <div className="mb-2 px-3 py-1.5 rounded-lg text-[10px] bg-amber-500/8 text-amber-500/80 border border-amber-500/15">
          {t('quota.personalLimit')}
        </div>
      )}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-fg-secondary">{hasMemberLimit ? t('quota.personalLimitLabel') : t('quota.title')}</span>
          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-brand-500/10 text-brand-500 uppercase">{hubPlan.planType}</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-fg-tertiary">
          {!hasMemberLimit && hubPlan.bonusCu > 0 && <span>{t('quota.bonus', { amount: formatCu(hubPlan.bonusCu) })}</span>}
          <span>{hubPlan.cuResetAt ? t('quota.resetsAt', { date: new Date(hubPlan.cuResetAt).toLocaleDateString() }) : ''}</span>
          <a href={hubUrl} target="_blank" rel="noopener noreferrer"
            className="px-2 py-1 bg-brand-600 text-white rounded hover:bg-brand-500 transition-colors font-medium">
            {t('quota.topUp')}
          </a>
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

      {/* Limits detail row */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 pt-2 border-t border-border-default/30 text-[10px] text-fg-tertiary">
        {hubPlan.windowQuotaCu > 0 && (
          <span>{t('quota.windowQuota', { amount: formatCu(hubPlan.windowQuotaCu) })}</span>
        )}
        {hubPlan.windowQuotaCu === 0 && (
          <span>{t('quota.windowQuotaNone')}</span>
        )}
        <span>{t('quota.rateLimit')}</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Contributor Rankings
// ═══════════════════════════════════════════════════════════════════════════════

function ContributorRankings({ contributors, t }: { contributors: Contributor[]; t: (k: string, o?: Record<string, unknown>) => string }) {
  const [sortBy, setSortBy] = useState<'cuUsed' | 'tasksCompleted' | 'totalTokens' | 'efficiency'>('totalTokens');
  const [sortDesc, setSortDesc] = useState(true);

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

  const maxTokens = Math.max(1, ...contributors.map(c => c.totalTokens));

  const hasAnyCu = contributors.some(c => c.cuUsed > 0);
  const providers = new Set(contributors.filter(c => c.provider).map(c => c.provider));
  const isMixedProvider = providers.size > 1 || (providers.size === 1 && !providers.has('markus'));

  if (contributors.length === 0) {
    return (
      <section className="bg-surface-elevated rounded-xl p-8 text-center">
        <p className="text-sm text-fg-tertiary">{t('agents.noData')}</p>
      </section>
    );
  }

  return (
    <section className="bg-surface-elevated rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border-default">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fg-secondary">{t('agents.title')}</h3>
          {isMixedProvider && (
            <span className="text-[10px] text-fg-tertiary bg-surface-overlay px-2 py-0.5 rounded">
              {t('agents.mixedProviders')}
            </span>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border-default text-xs text-fg-tertiary uppercase tracking-wider">
              <th className="px-4 py-3 text-left font-medium w-8">#</th>
              <th className="px-4 py-3 text-left font-medium">{t('agents.name')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('agents.team')}</th>
              <SortTH label={t('agents.tasks')} col="tasksCompleted" current={sortBy} desc={sortDesc} onSort={handleSort} />
              <SortTH label={t('agents.tokens')} col="totalTokens" current={sortBy} desc={sortDesc} onSort={handleSort} />
              {hasAnyCu && <SortTH label={t('agents.cuUsed')} col="cuUsed" current={sortBy} desc={sortDesc} onSort={handleSort} />}
              <SortTH label={t('agents.efficiency')} col="efficiency" current={sortBy} desc={sortDesc} onSort={handleSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c, i) => (
              <ContributorRow key={c.id} contributor={c} rank={i + 1} maxTokens={maxTokens} showCu={hasAnyCu} t={t} />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border-default bg-surface-elevated/30">
              <td colSpan={3} className="px-4 py-3 text-sm font-medium text-fg-secondary">
                {t('agents.total', { count: contributors.length })}
              </td>
              <td className="px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">
                {contributors.reduce((s, c) => s + c.tasksCompleted, 0)}
              </td>
              <td className="px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">
                {formatNumber(contributors.reduce((s, c) => s + c.totalTokens, 0))}
              </td>
              {hasAnyCu && (
                <td className="px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">
                  {formatCu(contributors.reduce((s, c) => s + c.cuUsed, 0))}
                </td>
              )}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function HumanMembersList({ contributors, t }: { contributors: Contributor[]; t: (k: string, o?: Record<string, unknown>) => string }) {
  return (
    <section className="bg-surface-elevated rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border-default">
        <h3 className="text-sm font-semibold text-fg-secondary">{t('humans.title')}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border-default text-xs text-fg-tertiary uppercase tracking-wider">
              <th className="px-4 py-3 text-left font-medium">{t('humans.name')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('humans.role')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('humans.team')}</th>
            </tr>
          </thead>
          <tbody>
            {contributors.map(c => (
              <tr key={c.id} className="border-b border-border-default/50 hover:bg-surface-elevated/30 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-2 h-2 rounded-full bg-indigo-500 shrink-0" />
                    <span className="text-sm font-medium text-fg-primary">{c.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-fg-secondary capitalize">{c.role}</td>
                <td className="px-4 py-3 text-xs text-fg-tertiary">{c.teamName || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ContributorRow({ contributor: c, rank, maxTokens, showCu, t }: { contributor: Contributor; rank: number; maxTokens: number; showCu: boolean; t: (k: string) => string }) {
  const barWidth = maxTokens > 0 ? Math.min(100, (c.totalTokens / maxTokens) * 100) : 0;

  const statusColor = c.status === 'working' ? 'bg-blue-500' :
    c.status === 'idle' ? 'bg-green-500' :
    c.status === 'error' ? 'bg-red-500' : 'bg-gray-500';

  const effLabel = c.totalTokens > 0
    ? `${c.efficiency.toFixed(1)}`
    : c.tasksCompleted > 0 ? '∞' : '—';

  const rankBadge = rank <= 3
    ? `${rank === 1 ? 'text-amber-500' : rank === 2 ? 'text-gray-400' : 'text-amber-700'} font-bold`
    : 'text-fg-tertiary';

  const providerLabel = c.provider === 'markus' ? '' : c.provider ?? '';

  return (
    <tr
      className="border-b border-border-default/50 hover:bg-surface-elevated/30 transition-colors cursor-pointer"
      onClick={() => navBus.navigate(PAGE.TEAM, { selectAgent: c.id })}
    >
      <td className={`px-4 py-3 text-sm tabular-nums ${rankBadge}`}>{rank}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-2 h-2 rounded-full ${statusColor} shrink-0`} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-fg-primary truncate">{c.name}</span>
              {providerLabel && (
                <span className="px-1 py-0.5 rounded text-[8px] font-medium bg-surface-overlay text-fg-tertiary shrink-0">{providerLabel}</span>
              )}
            </div>
            <div className="text-[10px] text-fg-tertiary">{c.role}</div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-xs text-fg-tertiary">{c.teamName || '—'}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-fg-secondary tabular-nums">{c.tasksCompleted}</span>
          {c.tasksFailed > 0 && (
            <span className="text-[10px] text-red-500 tabular-nums">({c.tasksFailed})</span>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden max-w-[80px]">
            <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${barWidth}%` }} />
          </div>
          <span className="text-sm text-fg-secondary tabular-nums">{formatNumber(c.totalTokens)}</span>
        </div>
      </td>
      {showCu && (
        <td className="px-4 py-3 text-sm text-fg-secondary tabular-nums">
          {c.cuUsed > 0 ? formatCu(c.cuUsed) : <span className="text-fg-tertiary">—</span>}
        </td>
      )}
      <td className="px-4 py-3 text-right">
        <span className={`text-sm font-medium tabular-nums ${
          c.efficiency > 5 ? 'text-green-500' : c.efficiency > 1 ? 'text-fg-secondary' : c.totalTokens > 0 ? 'text-amber-500' : 'text-fg-tertiary'
        }`}>{effLabel}</span>
      </td>
    </tr>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Team Performance Card
// ═══════════════════════════════════════════════════════════════════════════════

function TeamCard({ team, t }: {
  team: { id: string; name: string; agentCount: number; humanCount: number; totalCu: number; totalTasks: number; totalTokens: number; managerName?: string };
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  return (
    <div
      className="bg-surface-overlay rounded-lg p-4 hover:bg-surface-overlay/80 transition-colors cursor-pointer border border-border-default/30"
      onClick={() => navBus.navigate(PAGE.TEAM, { selectTeam: team.id })}
    >
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-fg-primary truncate">{team.name}</h4>
        <span className="text-[10px] text-fg-tertiary shrink-0">
          {t('teamPerf.members', { agents: team.agentCount, humans: team.humanCount })}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <div className="text-lg font-bold text-green-500 tabular-nums">{team.totalTasks}</div>
          <div className="text-[10px] text-fg-tertiary">{t('teamPerf.tasks')}</div>
        </div>
        <div>
          <div className="text-lg font-bold text-brand-500 tabular-nums">{formatCu(team.totalCu)}</div>
          <div className="text-[10px] text-fg-tertiary">{t('teamPerf.cuUsed')}</div>
        </div>
        <div>
          <div className="text-lg font-bold text-indigo-500 tabular-nums">{formatNumber(team.totalTokens)}</div>
          <div className="text-[10px] text-fg-tertiary">{t('teamPerf.tokens')}</div>
        </div>
      </div>
      {team.managerName && (
        <div className="mt-2 pt-2 border-t border-border-default/30 text-[10px] text-fg-tertiary">
          {t('teamPerf.managedBy', { name: team.managerName })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Usage Charts (Hub CU data)
// ═══════════════════════════════════════════════════════════════════════════════

interface PeriodData {
  period: string;
  credits: number;
  tokens: number;
  requests: number;
  models: Record<string, { credits: number; tokens: number; requests: number }>;
}

function UsageCharts({ stats, granularity, t }: {
  stats: HubUsageStat[];
  granularity: 'day' | 'hour';
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const { periods, totalCredits, totalTokens, totalRequests } = useMemo(() => {
    const periodMap = new Map<string, PeriodData>();
    for (const s of stats) {
      const key = s.period;
      let entry = periodMap.get(key);
      if (!entry) {
        entry = { period: key, credits: 0, tokens: 0, requests: 0, models: {} };
        periodMap.set(key, entry);
      }
      entry.credits += s.totalCu;
      entry.tokens += s.totalInput + s.totalOutput + s.totalCached;
      entry.requests += s.requestCount;
      const modelName = s.model ?? 'unknown';
      if (!entry.models[modelName]) entry.models[modelName] = { credits: 0, tokens: 0, requests: 0 };
      entry.models[modelName].credits += s.totalCu;
      entry.models[modelName].tokens += s.totalInput + s.totalOutput + s.totalCached;
      entry.models[modelName].requests += s.requestCount;
    }
    const sorted = [...periodMap.values()].sort((a, b) => a.period.localeCompare(b.period));
    return {
      periods: sorted,
      totalCredits: sorted.reduce((s, p) => s + p.credits, 0),
      totalTokens: sorted.reduce((s, p) => s + p.tokens, 0),
      totalRequests: sorted.reduce((s, p) => s + p.requests, 0),
    };
  }, [stats]);

  const maxCredits = Math.max(1, ...periods.map(p => p.credits));
  const maxTokens = Math.max(1, ...periods.map(p => p.tokens));

  if (periods.length === 0) {
    return <div className="py-8 text-center text-fg-tertiary text-sm">{t('trends.noData')}</div>;
  }

  const fmtLabel = (p: string) => {
    if (granularity === 'hour') {
      const d = new Date(p + 'Z');
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
    }
    const d = new Date(p + 'T00:00:00Z');
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  return (
    <div className="space-y-5">
      {/* Summary row */}
      <div className="grid grid-cols-3 gap-3">
        <MiniStat label={t('trends.totalCredits')} value={formatNumber(totalCredits)} />
        <MiniStat label={t('trends.totalTokens')} value={formatNumber(totalTokens)} />
        <MiniStat label={t('trends.totalRequests')} value={formatNumber(totalRequests)} />
      </div>

      {/* Credits chart */}
      <BarChart
        label={t('trends.creditsChart')}
        maxLabel={`${t('trends.max')}: ${formatNumber(maxCredits)}`}
        periods={periods}
        getValue={p => p.credits}
        maxValue={maxCredits}
        color="bg-brand-500"
        fmtLabel={fmtLabel}
        hoverIdx={hoverIdx}
        onHover={setHoverIdx}
        tooltipRef={tooltipRef}
        formatValue={formatNumber}
      />

      {/* Tokens chart */}
      <BarChart
        label={t('trends.tokensChart')}
        maxLabel={`${t('trends.max')}: ${formatNumber(maxTokens)}`}
        periods={periods}
        getValue={p => p.tokens}
        maxValue={maxTokens}
        color="bg-indigo-500"
        fmtLabel={fmtLabel}
        hoverIdx={hoverIdx}
        onHover={setHoverIdx}
        tooltipRef={tooltipRef}
        formatValue={formatNumber}
      />

      {/* Per-model breakdown */}
      <ModelBreakdown periods={periods} t={t} />
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-overlay rounded-lg p-3 text-center">
      <div className="text-lg font-bold text-fg-primary tabular-nums">{value}</div>
      <div className="text-[10px] text-fg-tertiary">{label}</div>
    </div>
  );
}

function BarChart({ label, maxLabel, periods, getValue, maxValue, color, fmtLabel, hoverIdx, onHover, tooltipRef, formatValue }: {
  label: string; maxLabel: string;
  periods: PeriodData[]; getValue: (p: PeriodData) => number; maxValue: number;
  color: string; fmtLabel: (p: string) => string;
  hoverIdx: number | null; onHover: (idx: number | null) => void;
  tooltipRef: React.RefObject<HTMLDivElement | null>;
  formatValue: (n: number) => string;
}) {
  return (
    <div className="bg-surface-overlay rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-fg-secondary">{label}</span>
        <span className="text-[10px] text-fg-tertiary">{maxLabel}</span>
      </div>
      <div className="relative h-28 flex items-end gap-px" onMouseLeave={() => onHover(null)}>
        {periods.map((p, i) => {
          const val = getValue(p);
          const h = maxValue > 0 ? Math.max(val > 0 ? 2 : 0, (val / maxValue) * 100) : 0;
          return (
            <div key={p.period} className="flex-1 flex flex-col items-center justify-end h-full relative"
              style={{ maxWidth: 16 }}
              onMouseEnter={() => onHover(i)}>
              <div className={`w-full rounded-t ${color} transition-all ${hoverIdx === i ? 'opacity-100' : 'opacity-80'}`}
                style={{ height: `${h}%`, minWidth: 4 }} />
              {hoverIdx === i && (
                <div ref={tooltipRef}
                  className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-50 pointer-events-none bg-gray-900 text-white text-[10px] px-2 py-1 rounded shadow-lg whitespace-nowrap">
                  <div className="font-medium">{fmtLabel(p.period)}</div>
                  <div className="tabular-nums">{formatValue(val)}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-1.5">
        <span className="text-[9px] text-fg-tertiary">{periods.length > 0 ? fmtLabel(periods[0].period) : ''}</span>
        <span className="text-[9px] text-fg-tertiary">{periods.length > 0 ? fmtLabel(periods[periods.length - 1].period) : ''}</span>
      </div>
    </div>
  );
}

function ModelBreakdown({ periods, t }: { periods: PeriodData[]; t: (key: string) => string }) {
  const modelTotals = useMemo(() => {
    const map = new Map<string, { credits: number; tokens: number; requests: number }>();
    for (const p of periods) {
      for (const [model, data] of Object.entries(p.models)) {
        const existing = map.get(model) ?? { credits: 0, tokens: 0, requests: 0 };
        existing.credits += data.credits;
        existing.tokens += data.tokens;
        existing.requests += data.requests;
        map.set(model, existing);
      }
    }
    return [...map.entries()]
      .sort((a, b) => b[1].credits - a[1].credits)
      .map(([name, data]) => ({ name, ...data }));
  }, [periods]);

  if (modelTotals.length === 0) return null;
  const maxCredits = Math.max(1, ...modelTotals.map(m => m.credits));

  return (
    <div className="bg-surface-overlay rounded-lg p-4">
      <div className="text-xs font-medium text-fg-secondary mb-3">{t('trends.models')}</div>
      <div className="space-y-2">
        {modelTotals.map(m => (
          <div key={m.name} className="flex items-center gap-3 text-xs">
            <span className="w-28 truncate text-fg-secondary shrink-0" title={m.name}>{m.name}</span>
            <div className="flex-1 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
              <div className="h-full bg-brand-500 rounded-full" style={{ width: `${(m.credits / maxCredits) * 100}%` }} />
            </div>
            <span className="text-fg-tertiary tabular-nums shrink-0 w-16 text-right">{formatNumber(m.credits)}</span>
            <span className="text-fg-tertiary tabular-nums shrink-0 w-20 text-right">{formatNumber(m.tokens)} tk</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// History Tab
// ═══════════════════════════════════════════════════════════════════════════════

function HistoryList({ reports, t, onSelect }: {
  reports: ReportInfo[];
  t: (k: string, o?: Record<string, unknown>) => string;
  onSelect: (r: ReportInfo) => void;
}) {
  return (
    <section className="bg-surface-elevated rounded-xl overflow-hidden">
      {reports.length === 0 ? (
        <div className="p-8 text-center text-fg-tertiary text-sm">{t('noReportsYet')}</div>
      ) : (
        <div className="divide-y divide-border-default/50">
          {reports.map(r => (
            <button key={r.id} onClick={() => onSelect(r)} className="w-full text-left px-5 py-3 flex items-center gap-4 hover:bg-surface-elevated/30 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-fg-primary">{t('reportType', { type: r.type })}</div>
                <div className="text-xs text-fg-tertiary mt-0.5">
                  {new Date(r.periodStart).toLocaleDateString()} — {new Date(r.periodEnd).toLocaleDateString()}
                </div>
              </div>
              {r.plan && (
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${
                  r.plan.status === 'approved' ? 'bg-green-500/10 text-green-600' :
                  r.plan.status === 'rejected' ? 'bg-red-500/10 text-red-500' :
                  'bg-amber-500/10 text-amber-600'
                }`}>{r.plan.status === 'pending' ? t('history.planPending') : t('history.planStatus', { status: r.plan.status })}</span>
              )}
              <span className="text-[10px] text-fg-tertiary shrink-0">{new Date(r.generatedAt).toLocaleDateString()}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ReportDetail({ report, feedback, feedbackContent, setFeedbackContent, authUser, t, onBack, onFlash, onFeedbackAdded, onReportUpdated }: {
  report: ReportInfo;
  feedback: ReportFeedbackInfo[];
  feedbackContent: string;
  setFeedbackContent: (v: string) => void;
  authUser?: AuthUser;
  t: (k: string, o?: Record<string, unknown>) => string;
  onBack: () => void;
  onFlash: (m: string) => void;
  onFeedbackAdded: (fb: ReportFeedbackInfo) => void;
  onReportUpdated: (r: ReportInfo) => void;
}) {
  const submitFeedback = async () => {
    if (!feedbackContent.trim()) return;
    try {
      const { feedback: fb } = await api.reports.addFeedback(report.id, { author: authUser?.id ?? 'unknown', type: 'comment', content: feedbackContent.trim() });
      onFeedbackAdded(fb);
      setFeedbackContent('');
      onFlash(t('history.feedbackAdded'));
    } catch (e) { onFlash(t('common:error', { message: String(e) })); }
  };

  return (
    <>
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-xs text-fg-tertiary hover:text-fg-secondary">{t('backToList')}</button>
        <span className="text-sm font-medium text-fg-primary">{t('reportType', { type: report.type })}</span>
        <span className="text-xs text-fg-tertiary">
          {new Date(report.periodStart).toLocaleDateString()} — {new Date(report.periodEnd).toLocaleDateString()}
        </span>
      </div>

      {report.metrics && (
        <section className="bg-surface-elevated rounded-xl p-5">
          <h3 className="text-xs font-semibold text-fg-secondary mb-3">{t('history.taskMetrics')}</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {(['completed', 'inProgress', 'created', 'blocked', 'failed'] as const).map(key => {
              const colors = { completed: 'text-green-600', inProgress: 'text-brand-500', created: 'text-blue-600', blocked: 'text-amber-600', failed: 'text-red-500' };
              const metricKey = `tasks${key.charAt(0).toUpperCase() + key.slice(1)}` as keyof typeof report.metrics;
              return (
                <div key={key} className="text-center">
                  <div className={`text-2xl font-bold ${colors[key]}`}>{(report.metrics as any)[metricKey] ?? 0}</div>
                  <div className="text-[10px] text-fg-tertiary mt-0.5">{t(`history.metric.${key}`)}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {report.costSummary && (
        <section className="bg-surface-elevated rounded-xl p-5">
          <h3 className="text-xs font-semibold text-fg-secondary mb-3">{t('history.costOverview')}</h3>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-2xl font-bold text-fg-primary">{report.costSummary.totalTokens.toLocaleString()}</div>
              <div className="text-xs text-fg-tertiary">{t('history.totalTokens')}</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-fg-primary">{formatCu(report.costSummary.totalCu ?? 0)}</div>
              <div className="text-xs text-fg-tertiary">{t('history.cuUsed')}</div>
            </div>
            <div>
              <div className={`text-2xl font-bold ${report.costSummary.trend === 'decreasing' ? 'text-green-600' : report.costSummary.trend === 'increasing' ? 'text-red-500' : 'text-fg-primary'}`}>
                {report.costSummary.trend === 'decreasing' ? '↓' : report.costSummary.trend === 'increasing' ? '↑' : '→'} {report.costSummary.trend}
              </div>
              <div className="text-xs text-fg-tertiary">{t('history.trend')}</div>
            </div>
          </div>
        </section>
      )}

      {report.taskSummary && (
        <section className="bg-surface-elevated rounded-xl p-5">
          <h3 className="text-xs font-semibold text-fg-secondary mb-3">{t('history.taskSummary')}</h3>
          <div className="space-y-4">
            {report.taskSummary.completed.length > 0 && (
              <TaskList title={t('history.completedCount', { count: report.taskSummary.completed.length })} color="emerald" items={report.taskSummary.completed.map(task => ({ id: task.id, label: task.title, sub: task.agent }))} />
            )}
            {report.taskSummary.inProgress.length > 0 && (
              <TaskList title={t('history.inProgressCount', { count: report.taskSummary.inProgress.length })} color="indigo" items={report.taskSummary.inProgress.map(task => ({ id: task.id, label: task.title, sub: task.agent }))} />
            )}
            {report.taskSummary.blocked.length > 0 && (
              <TaskList title={t('history.blockedCount', { count: report.taskSummary.blocked.length })} color="amber" items={report.taskSummary.blocked.map(task => ({ id: task.id, label: task.title, sub: task.reason || task.agent }))} />
            )}
            {report.taskSummary.completed.length === 0 && report.taskSummary.inProgress.length === 0 && report.taskSummary.blocked.length === 0 && (
              <p className="text-sm text-fg-tertiary">{t('history.noTasks')}</p>
            )}
          </div>
        </section>
      )}

      {report.highlights && report.highlights.length > 0 && (
        <section className="bg-surface-elevated rounded-xl p-5">
          <h3 className="text-xs font-semibold text-fg-secondary mb-2">{t('history.highlights')}</h3>
          <ul className="list-disc list-inside space-y-1 text-sm text-fg-secondary">
            {report.highlights.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </section>
      )}

      {report.blockers && report.blockers.length > 0 && (
        <section className="bg-surface-secondary border border-amber-500/20 rounded-xl p-5">
          <h3 className="text-xs font-semibold text-amber-600 mb-2">{t('history.blockers')}</h3>
          <ul className="list-disc list-inside space-y-1 text-sm text-fg-secondary">
            {report.blockers.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </section>
      )}

      {report.plan && (
        <section className="bg-surface-elevated rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-fg-secondary">
              {t('history.upcomingPlan')}
              <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                report.plan.status === 'approved' ? 'bg-green-500/10 text-green-600' :
                report.plan.status === 'rejected' ? 'bg-red-500/10 text-red-500' :
                'bg-amber-500/10 text-amber-600'
              }`}>{t(`common:status.${report.plan.status}`, { defaultValue: report.plan.status })}</span>
            </h3>
            {report.plan.status === 'pending' && (
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    try {
                      const { report: r } = await api.reports.approvePlan(report.id, { approvedBy: authUser?.id ?? 'unknown' });
                      onReportUpdated(r);
                      onFlash(t('history.planApproved'));
                    } catch (e) { onFlash(t('common:error', { message: String(e) })); }
                  }}
                  className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-500 transition-colors"
                >{t('history.approvePlan')}</button>
                <button
                  onClick={async () => {
                    const reason = prompt(t('history.rejectionReason'));
                    if (!reason) return;
                    try {
                      const { report: r } = await api.reports.rejectPlan(report.id, { rejectedBy: authUser?.id ?? 'unknown', reason });
                      onReportUpdated(r);
                      onFlash(t('history.planRejected'));
                    } catch (e) { onFlash(t('common:error', { message: String(e) })); }
                  }}
                  className="px-3 py-1.5 text-xs font-medium border border-border-default text-fg-secondary rounded-lg hover:bg-surface-overlay transition-colors"
                >{t('history.rejectPlan')}</button>
              </div>
            )}
          </div>
          {report.plan.items && report.plan.items.length > 0 && (
            <div className="space-y-1.5">
              {report.plan.items.map((item, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-fg-secondary">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    item.priority === 'high' ? 'bg-red-500/10 text-red-500' :
                    item.priority === 'medium' ? 'bg-amber-500/10 text-amber-600' :
                    'bg-gray-500/10 text-fg-tertiary'
                  }`}>{item.priority}</span>
                  <span>{item.title}</span>
                  {item.assignee && <span className="text-[10px] text-fg-tertiary ml-auto">{item.assignee}</span>}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {!report.metrics && !report.taskSummary && !report.costSummary && (
        <section className="bg-surface-elevated rounded-xl p-8 text-center">
          <p className="text-sm text-fg-tertiary">{t('history.noDetailedMetrics')}</p>
        </section>
      )}

      {/* Feedback */}
      <section className="bg-surface-elevated rounded-xl p-5">
        <h3 className="text-xs font-semibold text-fg-secondary mb-3">{t('history.feedbackTitle', { count: feedback.length })}</h3>
        {feedback.length > 0 && (
          <div className="space-y-2 mb-4">
            {feedback.map(fb => (
              <div key={fb.id} className="p-3 bg-surface-elevated/50 rounded-lg">
                <div className="flex items-center gap-2 text-[10px] text-fg-tertiary mb-1">
                  <span className="font-medium text-fg-secondary">{fb.authorName}</span>
                  <span>{fb.type}</span>
                  <span>{new Date(fb.createdAt).toLocaleDateString()}</span>
                </div>
                <p className="text-xs text-fg-secondary">{fb.content}</p>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            value={feedbackContent}
            onChange={e => setFeedbackContent(e.target.value)}
            placeholder={t('history.feedbackPlaceholder')}
            className="flex-1 px-3 py-2 text-xs bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder:text-fg-tertiary"
            onKeyDown={e => { if (e.key === 'Enter' && feedbackContent.trim()) submitFeedback(); }}
          />
          <button onClick={submitFeedback} disabled={!feedbackContent.trim()}
            className="px-3 py-2 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {t('common:send')}
          </button>
        </div>
      </section>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared small components
// ═══════════════════════════════════════════════════════════════════════════════

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
      active ? 'bg-surface-overlay text-fg-primary shadow-sm' : 'text-fg-tertiary hover:text-fg-secondary'
    }`}>{children}</button>
  );
}

function TaskList({ title, color, items }: { title: string; color: string; items: Array<{ id?: string; label: string; sub: string }> }) {
  return (
    <div className="min-w-0 overflow-hidden">
      <div className={`text-xs font-medium text-${color}-400 mb-1.5`}>{title}</div>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={item.id ?? i}
            className={`text-sm text-fg-secondary min-w-0 ${item.id ? 'cursor-pointer hover:text-fg-primary group' : ''}`}
            onClick={item.id ? () => navBus.navigate(PAGE.WORK, { openTask: item.id! }) : undefined}>
            <div className="flex items-center gap-2 min-w-0">
              <span className={`w-1.5 h-1.5 rounded-full bg-${color}-500 shrink-0`} />
              <span className={`truncate min-w-0 ${item.id ? 'group-hover:text-brand-500 transition-colors' : ''}`}>{item.label}</span>
            </div>
            {item.sub && item.sub !== 'unassigned' && (
              <div className="text-[10px] text-fg-tertiary ml-3.5 mt-0.5 break-all line-clamp-2">{item.sub}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type SortCol = 'cuUsed' | 'tasksCompleted' | 'totalTokens' | 'efficiency';

function SortTH({ label, col, current, desc, onSort, align }: {
  label: string; col: SortCol; current: SortCol; desc: boolean; onSort: (c: SortCol) => void; align?: string;
}) {
  const arrow = current === col ? (desc ? '↓' : '↑') : '↕';
  const arrowColor = current === col ? 'text-brand-500' : 'text-fg-muted';
  return (
    <th className={`px-4 py-3 ${align === 'right' ? 'text-right' : 'text-left'} font-medium cursor-pointer select-none hover:text-fg-secondary`}
      onClick={() => onSort(col)}>
      {label}<span className={`ml-1 ${arrowColor}`}>{arrow}</span>
    </th>
  );
}
