import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, type ReportInfo, type ReportFeedbackInfo, type AgentUsageInfo, type AuthUser } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { MobileMenuButton } from '../components/MobileMenuButton.tsx';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { usePageActive } from '../hooks/usePageActive.ts';

type Period = 'daily' | 'weekly' | 'monthly';
interface ReportsPageProps { authUser?: AuthUser }

interface UsageSummary {
  orgId: string;
  period: string;
  llmTokens: number;
  toolCalls: number;
  messages: number;
  storageBytes: number;
}

interface HubPlanInfo {
  planType: string; planStatus: string;
  monthlyQuotaCu: number; cuUsed: number; cuResetAt: string | null;
  bonusCu: number; windowQuotaCu: number;
}

interface HubUsageStat {
  period: string; model: string | null;
  totalCu: number; totalInput: number; totalOutput: number; totalCached: number;
  requestCount: number;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatNumberFull(n: number): string {
  return n.toLocaleString();
}

function formatCu(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

export function ReportsPage({ authUser }: ReportsPageProps) {
  const { t } = useTranslation(['reports', 'common']);
  const isMobile = useIsMobile();
  const isActive = usePageActive(PAGE.REPORTS);
  const [period, setPeriod] = useState<Period>('weekly');
  const [report, setReport] = useState<ReportInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [agents, setAgents] = useState<AgentUsageInfo[]>([]);
  const [sortBy, setSortBy] = useState<'totalTokens' | 'tokensUsedToday' | 'requestCount' | 'toolCalls' | 'cuUsed'>('totalTokens');
  const [sortDesc, setSortDesc] = useState(true);

  const [tab, setTab] = useState<'generate' | 'history'>('generate');
  const [historyReports, setHistoryReports] = useState<ReportInfo[]>([]);
  const [selectedReport, setSelectedReport] = useState<ReportInfo | null>(null);
  const [feedback, setFeedback] = useState<ReportFeedbackInfo[]>([]);
  const [feedbackContent, setFeedbackContent] = useState('');
  const [flash, setFlash] = useState('');

  // Hub subscription data
  const [hubPlan, setHubPlan] = useState<HubPlanInfo | null>(null);
  const [hubStats, setHubStats] = useState<HubUsageStat[]>([]);
  const [hubGranularity, setHubGranularity] = useState<'day' | 'hour'>('day');
  const [hubDays, setHubDays] = useState(30);
  const [hubConnected, setHubConnected] = useState(hubApi.isAuthenticated());

  const showFlash = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 3000); };

  const fetchReport = useCallback(async (p: Period) => {
    setLoading(true);
    setError('');
    try {
      const { report: r } = await api.reports.generate({ period: p, scope: 'org', orgId: 'default' });
      setReport(r);
    } catch (e) {
      setError(String(e));
      setReport(null);
    }
    setLoading(false);
  }, []);

  const fetchUsage = useCallback(() => {
    api.usage.summary().then(d => setUsageSummary(d.usage)).catch(() => {});
    api.usage.agents().then(d => setAgents(d.agents)).catch(() => {});
  }, []);

  const fetchHistory = useCallback(async () => {
    try { const { reports } = await api.reports.list(); setHistoryReports(reports); } catch { /* */ }
  }, []);

  const openReport = useCallback(async (r: ReportInfo) => {
    setSelectedReport(r);
    try { const { feedback: fb } = await api.reports.getFeedback(r.id); setFeedback(fb); } catch { setFeedback([]); }
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

  useEffect(() => { fetchReport(period); }, [period, fetchReport]);
  useEffect(() => {
    if (!isActive) return;
    fetchUsage();
    const i = setInterval(fetchUsage, 30000);
    return () => clearInterval(i);
  }, [fetchUsage, isActive]);
  useEffect(() => { if (tab === 'history') fetchHistory(); }, [tab, fetchHistory]);
  useEffect(() => { if (isActive && tab === 'generate') fetchHubData(); }, [isActive, tab, fetchHubData]);

  const sortedAgents = useMemo(() => {
    const getVal = (a: AgentUsageInfo, col: typeof sortBy): number => {
      if (col === 'cuUsed') return a.cuUsed ?? 0;
      return a[col] as number;
    };
    return [...agents].sort((a, b) => {
      const aVal = getVal(a, sortBy);
      const bVal = getVal(b, sortBy);
      return sortDesc ? bVal - aVal : aVal - bVal;
    });
  }, [agents, sortBy, sortDesc]);

  const totalCu = agents.reduce((s, a) => s + (a.cuUsed ?? 0), 0);
  const totalTokensToday = agents.reduce((s, a) => s + a.tokensUsedToday, 0);
  const maxAgentTokens = Math.max(1, ...agents.map(a => a.totalTokens));

  const handleSort = (col: typeof sortBy) => {
    if (sortBy === col) setSortDesc(!sortDesc);
    else { setSortBy(col); setSortDesc(true); }
  };

  const periodLabel = useMemo(() => ({
    daily: t('period.today'),
    weekly: t('period.thisWeek'),
    monthly: t('period.thisMonth'),
  }), [t]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto w-full p-6 space-y-6">
        {/* Header with tabs */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4 flex-wrap">
            {isMobile && <MobileMenuButton />}
            <h1 className="text-xl font-semibold text-fg-primary">{t('title')}</h1>
            <div className="flex gap-1 bg-surface-elevated rounded-lg p-0.5">
              <button onClick={() => setTab('generate')} className={`px-3 py-1.5 text-xs rounded-md transition-colors ${tab === 'generate' ? 'bg-surface-overlay text-fg-primary shadow-sm' : 'text-fg-tertiary hover:text-fg-secondary'}`}>{t('tabs.generate')}</button>
              <button onClick={() => setTab('history')} className={`px-3 py-1.5 text-xs rounded-md transition-colors ${tab === 'history' ? 'bg-surface-overlay text-fg-primary shadow-sm' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
                {t('tabs.history')}{historyReports.length > 0 ? ` (${historyReports.length})` : ''}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {flash && <span className="px-2.5 py-1 bg-green-500/10 text-green-600 text-xs rounded-lg">{flash}</span>}
            {tab === 'generate' && (
              <div className="flex gap-1 bg-surface-elevated rounded-lg p-0.5">
                {(['daily', 'weekly', 'monthly'] as const).map(p => (
                  <button key={p} onClick={() => setPeriod(p)} className={`px-3 py-1.5 text-xs rounded-md transition-colors ${period === p ? 'bg-surface-overlay text-fg-primary shadow-sm' : 'text-fg-tertiary hover:text-fg-secondary'}`}>{t(`period.${p}`)}</button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ═══ Generate Tab ═══ */}
        {tab === 'generate' && (
          <>
            {/* ── Markus Cloud AI Subscription ── */}
            <SubscriptionSection
              hubConnected={hubConnected}
              hubPlan={hubPlan}
              hubStats={hubStats}
              granularity={hubGranularity}
              days={hubDays}
              onGranularityChange={setHubGranularity}
              onDaysChange={setHubDays}
              t={t}
            />

            {/* ── Local Usage Summary Cards ── */}
            {usageSummary && (
              <div className={`grid gap-4 ${usageSummary.storageBytes > 0 ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-3'}`}>
                <UsageCard label={t('usage.llmTokens')} value={formatNumber(usageSummary.llmTokens)} color="text-brand-500" />
                <UsageCard label={t('usage.toolCalls')} value={formatNumber(usageSummary.toolCalls)} color="text-blue-600" />
                <UsageCard label={t('usage.messages')} value={formatNumber(usageSummary.messages)} color="text-green-600" />
                {usageSummary.storageBytes > 0 && (
                  <UsageCard label={t('usage.storage')} value={formatBytes(usageSummary.storageBytes)} color="text-amber-600" />
                )}
              </div>
            )}

            {/* ── Period Report Data ── */}
            {loading ? (
              <div className="flex items-center justify-center h-32 text-fg-tertiary text-sm">{t('common:loading')}</div>
            ) : error ? (
              <div className="flex items-center justify-center h-32 text-red-500 text-sm">{error}</div>
            ) : report ? (
              <>
                <div className="text-xs text-fg-tertiary">
                  {periodLabel[period]} · {new Date(report.periodStart).toLocaleDateString()} — {new Date(report.periodEnd).toLocaleDateString()}
                </div>

                {report.metrics && (
                  <section className="bg-surface-elevated rounded-xl p-5">
                    <h3 className="text-xs font-semibold text-fg-secondary mb-3">{t('taskMetrics.title')}</h3>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                      <MetricCard label={t('taskMetrics.completed')} value={report.metrics.tasksCompleted} color="text-green-600" />
                      <MetricCard label={t('taskMetrics.inProgress')} value={report.metrics.tasksInProgress} color="text-brand-500" />
                      <MetricCard label={t('taskMetrics.created')} value={report.metrics.tasksCreated} color="text-blue-600" />
                      <MetricCard label={t('taskMetrics.blocked')} value={report.metrics.tasksBlocked} color="text-amber-600" />
                      <MetricCard label={t('taskMetrics.failed')} value={report.metrics.tasksFailed} color="text-red-500" />
                    </div>
                  </section>
                )}

                <section className="bg-surface-elevated rounded-xl p-5">
                  <h3 className="text-xs font-semibold text-fg-secondary mb-3">{t('costOverview.title')}</h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <div className="text-2xl font-bold text-fg-primary">{formatCu(totalCu)}</div>
                      <div className="text-xs text-fg-tertiary">CU Used (all time)</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-fg-primary">{formatNumber(totalTokensToday)}</div>
                      <div className="text-xs text-fg-tertiary">{t('costOverview.tokensToday')}</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-fg-primary">{formatCu(agents.reduce((s, a) => s + (a.cuUsedToday ?? 0), 0))}</div>
                      <div className="text-xs text-fg-tertiary">CU Used Today</div>
                    </div>
                  </div>
                </section>

                {report.taskSummary && (
                  <section className="bg-surface-elevated rounded-xl p-5">
                    <h3 className="text-xs font-semibold text-fg-secondary mb-3">{t('taskSummary.title')}</h3>
                    <div className="space-y-4">
                      {report.taskSummary.completed.length > 0 && (
                        <TaskSection title={t('taskSummary.completedCount', { count: report.taskSummary.completed.length })} color="emerald" items={report.taskSummary.completed.map(task => ({ id: task.id, label: task.title, sub: task.agent }))} />
                      )}
                      {report.taskSummary.inProgress.length > 0 && (
                        <TaskSection title={t('taskSummary.inProgressCount', { count: report.taskSummary.inProgress.length })} color="indigo" items={report.taskSummary.inProgress.map(task => ({ id: task.id, label: task.title, sub: task.agent }))} />
                      )}
                      {report.taskSummary.blocked.length > 0 && (
                        <TaskSection title={t('taskSummary.blockedCount', { count: report.taskSummary.blocked.length })} color="amber" items={report.taskSummary.blocked.map(task => ({ id: task.id, label: task.title, sub: task.reason || task.agent }))} />
                      )}
                      {report.taskSummary.completed.length === 0 && report.taskSummary.inProgress.length === 0 && report.taskSummary.blocked.length === 0 && (
                        <p className="text-sm text-fg-tertiary">{t('taskSummary.noTasksInPeriod')}</p>
                      )}
                    </div>
                  </section>
                )}
              </>
            ) : null}

            {/* ── Per-Agent Breakdown ── */}
            <section className="bg-surface-elevated rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-border-default">
                <h3 className="text-sm font-semibold text-fg-secondary">{t('perAgentUsage.title')}</h3>
              </div>
              {agents.length === 0 ? (
                <div className="p-8 text-center text-fg-tertiary text-sm">{t('perAgentUsage.noData')}</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border-default text-xs text-fg-tertiary uppercase tracking-wider">
                        <th className="px-4 py-3 text-left font-medium">{t('perAgentUsage.agent')}</th>
                        <SortHeader label={t('perAgentUsage.totalTokens')} col="totalTokens" current={sortBy} desc={sortDesc} onSort={handleSort} />
                        <SortHeader label={t('perAgentUsage.today')} col="tokensUsedToday" current={sortBy} desc={sortDesc} onSort={handleSort} />
                        <SortHeader label={t('perAgentUsage.requests')} col="requestCount" current={sortBy} desc={sortDesc} onSort={handleSort} />
                        <SortHeader label={t('perAgentUsage.toolCalls')} col="toolCalls" current={sortBy} desc={sortDesc} onSort={handleSort} />
                        <SortHeader label="CU Used" col="cuUsed" current={sortBy} desc={sortDesc} onSort={handleSort} align="right" />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedAgents.map(agent => (
                        <AgentRow key={agent.agentId} agent={agent} maxTokens={maxAgentTokens} />
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border-default bg-surface-elevated/30">
                        <td className="px-4 py-3 text-sm font-medium text-fg-secondary">{t('perAgentUsage.totalAgents', { count: agents.length })}</td>
                        <td className="px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">{formatNumberFull(agents.reduce((s, a) => s + a.totalTokens, 0))}</td>
                        <td className="px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">{formatNumberFull(totalTokensToday)}</td>
                        <td className="px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">{agents.reduce((s, a) => s + a.requestCount, 0)}</td>
                        <td className="px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">{agents.reduce((s, a) => s + a.toolCalls, 0)}</td>
                        <td className="px-4 py-3 text-sm font-medium text-right text-fg-secondary tabular-nums">{formatCu(totalCu)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {/* ═══ History Tab ═══ */}
        {tab === 'history' && !selectedReport && (
          <section className="bg-surface-elevated rounded-xl overflow-hidden">
            {historyReports.length === 0 ? (
              <div className="p-8 text-center text-fg-tertiary text-sm">{t('noReportsYet')}</div>
            ) : (
              <div className="divide-y divide-border-default/50">
                {historyReports.map(r => (
                  <button key={r.id} onClick={() => openReport(r)} className="w-full text-left px-5 py-3 flex items-center gap-4 hover:bg-surface-elevated/30 transition-colors">
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
                      }`}>{r.plan.status === 'pending' ? t('upcomingPlan.planPending') : t('upcomingPlan.planStatus', { status: r.plan.status })}</span>
                    )}
                    <span className="text-[10px] text-fg-tertiary shrink-0">{new Date(r.generatedAt).toLocaleDateString()}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Report Detail View */}
        {tab === 'history' && selectedReport && (
          <>
            <div className="flex items-center gap-3">
              <button onClick={() => { setSelectedReport(null); setFeedback([]); }} className="text-xs text-fg-tertiary hover:text-fg-secondary">{t('backToList')}</button>
              <span className="text-sm font-medium text-fg-primary">{t('reportType', { type: selectedReport.type })}</span>
              <span className="text-xs text-fg-tertiary">
                {new Date(selectedReport.periodStart).toLocaleDateString()} — {new Date(selectedReport.periodEnd).toLocaleDateString()}
              </span>
            </div>

            {selectedReport.metrics && (
              <section className="bg-surface-elevated rounded-xl p-5">
                <h3 className="text-xs font-semibold text-fg-secondary mb-3">{t('taskMetrics.title')}</h3>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <MetricCard label={t('taskMetrics.completed')} value={selectedReport.metrics.tasksCompleted} color="text-green-600" />
                  <MetricCard label={t('taskMetrics.inProgress')} value={selectedReport.metrics.tasksInProgress} color="text-brand-500" />
                  <MetricCard label={t('taskMetrics.created')} value={selectedReport.metrics.tasksCreated} color="text-blue-600" />
                  <MetricCard label={t('taskMetrics.blocked')} value={selectedReport.metrics.tasksBlocked} color="text-amber-600" />
                  <MetricCard label={t('taskMetrics.failed')} value={selectedReport.metrics.tasksFailed} color="text-red-500" />
                </div>
              </section>
            )}

            {selectedReport.costSummary && (
              <section className="bg-surface-elevated rounded-xl p-5">
                <h3 className="text-xs font-semibold text-fg-secondary mb-3">{t('costOverview.title')}</h3>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <div className="text-2xl font-bold text-fg-primary">{selectedReport.costSummary.totalTokens.toLocaleString()}</div>
                    <div className="text-xs text-fg-tertiary">{t('costOverview.totalTokens')}</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-fg-primary">{formatCu(selectedReport.costSummary.totalCu ?? 0)}</div>
                    <div className="text-xs text-fg-tertiary">CU Used</div>
                  </div>
                  <div>
                    <div className={`text-2xl font-bold ${selectedReport.costSummary.trend === 'decreasing' ? 'text-green-600' : selectedReport.costSummary.trend === 'increasing' ? 'text-red-500' : 'text-fg-primary'}`}>
                      {selectedReport.costSummary.trend === 'decreasing' ? '↓' : selectedReport.costSummary.trend === 'increasing' ? '↑' : '→'} {selectedReport.costSummary.trend}
                    </div>
                    <div className="text-xs text-fg-tertiary">{t('costOverview.trend')}</div>
                  </div>
                </div>
                {selectedReport.costSummary.byAgent && selectedReport.costSummary.byAgent.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-border-default/50 space-y-1.5">
                    {selectedReport.costSummary.byAgent.map((a, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-fg-secondary">{a.agentId}</span>
                        <span className="text-fg-tertiary tabular-nums">{formatNumberFull(a.tokens)} CU · {formatCu(a.cost)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {selectedReport.taskSummary && (
              <section className="bg-surface-elevated rounded-xl p-5 overflow-hidden">
                <h3 className="text-xs font-semibold text-fg-secondary mb-3">{t('taskSummary.title')}</h3>
                <div className="space-y-4 min-w-0">
                  {selectedReport.taskSummary.completed.length > 0 && (
                    <TaskSection title={t('taskSummary.completedCount', { count: selectedReport.taskSummary.completed.length })} color="emerald" items={selectedReport.taskSummary.completed.map(task => ({ id: task.id, label: task.title, sub: task.agent }))} />
                  )}
                  {selectedReport.taskSummary.inProgress.length > 0 && (
                    <TaskSection title={t('taskSummary.inProgressCount', { count: selectedReport.taskSummary.inProgress.length })} color="indigo" items={selectedReport.taskSummary.inProgress.map(task => ({ id: task.id, label: task.title, sub: task.agent }))} />
                  )}
                  {selectedReport.taskSummary.blocked.length > 0 && (
                    <TaskSection title={t('taskSummary.blockedCount', { count: selectedReport.taskSummary.blocked.length })} color="amber" items={selectedReport.taskSummary.blocked.map(task => ({ id: task.id, label: task.title, sub: task.reason || task.agent }))} />
                  )}
                  {selectedReport.taskSummary.completed.length === 0 && selectedReport.taskSummary.inProgress.length === 0 && selectedReport.taskSummary.blocked.length === 0 && (
                    <p className="text-sm text-fg-tertiary">{t('taskSummary.noTasksInPeriod')}</p>
                  )}
                </div>
              </section>
            )}

            {selectedReport.highlights && selectedReport.highlights.length > 0 && (
              <section className="bg-surface-elevated rounded-xl p-5">
                <h3 className="text-xs font-semibold text-fg-secondary mb-2">{t('highlights')}</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-fg-secondary">
                  {selectedReport.highlights.map((h, i) => <li key={i}>{h}</li>)}
                </ul>
              </section>
            )}

            {selectedReport.blockers && selectedReport.blockers.length > 0 && (
              <section className="bg-surface-secondary border border-amber-500/20 rounded-xl p-5">
                <h3 className="text-xs font-semibold text-amber-600 mb-2">{t('blockers')}</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-fg-secondary">
                  {selectedReport.blockers.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </section>
            )}

            {selectedReport.plan && (
              <section className="bg-surface-elevated rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-fg-secondary">
                    {t('upcomingPlan.title')}
                    <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      selectedReport.plan.status === 'approved' ? 'bg-green-500/10 text-green-600' :
                      selectedReport.plan.status === 'rejected' ? 'bg-red-500/10 text-red-500' :
                      'bg-amber-500/10 text-amber-600'
                    }`}>{t(`common:status.${selectedReport.plan.status}`, { defaultValue: selectedReport.plan.status })}</span>
                  </h3>
                  {selectedReport.plan.status === 'pending' && (
                    <div className="flex gap-2">
                      <button
                        onClick={async () => {
                          try {
                            const { report: r } = await api.reports.approvePlan(selectedReport.id, { approvedBy: authUser?.id ?? 'unknown' });
                            setSelectedReport(r);
                            showFlash(t('upcomingPlan.planApproved'));
                            fetchHistory();
                          } catch (e) { showFlash(t('common:error', { message: String(e) })); }
                        }}
                        className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-500 transition-colors"
                      >{t('upcomingPlan.approvePlan')}</button>
                      <button
                        onClick={async () => {
                          const reason = prompt(t('upcomingPlan.rejectionReason'));
                          if (!reason) return;
                          try {
                            const { report: r } = await api.reports.rejectPlan(selectedReport.id, { rejectedBy: authUser?.id ?? 'unknown', reason });
                            setSelectedReport(r);
                            showFlash(t('upcomingPlan.planRejected'));
                            fetchHistory();
                          } catch (e) { showFlash(t('common:error', { message: String(e) })); }
                        }}
                        className="px-3 py-1.5 text-xs font-medium border border-border-default text-fg-secondary rounded-lg hover:bg-surface-overlay transition-colors"
                      >{t('upcomingPlan.rejectPlan')}</button>
                    </div>
                  )}
                </div>
                {selectedReport.plan.items && selectedReport.plan.items.length > 0 && (
                  <div className="space-y-1.5">
                    {selectedReport.plan.items.map((item, i) => (
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

            {!selectedReport.metrics && !selectedReport.taskSummary && !selectedReport.costSummary && (
              <section className="bg-surface-elevated rounded-xl p-8 text-center">
                <p className="text-sm text-fg-tertiary">{t('noDetailedMetrics')}</p>
              </section>
            )}

            <section className="bg-surface-elevated rounded-xl p-5">
              <h3 className="text-xs font-semibold text-fg-secondary mb-3">{t('feedback.title', { count: feedback.length })}</h3>
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
                  placeholder={t('feedback.placeholder')}
                  className="flex-1 px-3 py-2 text-xs bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder:text-fg-tertiary"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && feedbackContent.trim()) {
                      api.reports.addFeedback(selectedReport.id, { author: authUser?.id ?? 'unknown', type: 'comment', content: feedbackContent.trim() })
                        .then(({ feedback: fb }) => { setFeedback(prev => [...prev, fb]); setFeedbackContent(''); showFlash(t('feedback.added')); })
                        .catch(err => showFlash(t('common:error', { message: String(err) })));
                    }
                  }}
                />
                <button
                  onClick={() => {
                    if (!feedbackContent.trim()) return;
                    api.reports.addFeedback(selectedReport.id, { author: authUser?.id ?? 'unknown', type: 'comment', content: feedbackContent.trim() })
                      .then(({ feedback: fb }) => { setFeedback(prev => [...prev, fb]); setFeedbackContent(''); showFlash(t('feedback.added')); })
                      .catch(err => showFlash(t('common:error', { message: String(err) })));
                  }}
                  disabled={!feedbackContent.trim()}
                  className="px-3 py-2 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >{t('common:send')}</button>
              </div>
            </section>
          </>
        )}

      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Subscription Section — Markus Cloud AI plan info + usage charts
// ═══════════════════════════════════════════════════════════════════════════════

function SubscriptionSection({ hubConnected, hubPlan, hubStats, granularity, days, onGranularityChange, onDaysChange, t }: {
  hubConnected: boolean;
  hubPlan: HubPlanInfo | null;
  hubStats: HubUsageStat[];
  granularity: 'day' | 'hour';
  days: number;
  onGranularityChange: (g: 'day' | 'hour') => void;
  onDaysChange: (d: number) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  if (!hubConnected) {
    return (
      <section className="bg-surface-elevated rounded-xl p-5 border border-border-default/50">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-fg-secondary">{t('subscription.title')}</h3>
            <p className="text-xs text-fg-tertiary mt-1">{t('subscription.connectHint')}</p>
          </div>
          <button
            onClick={() => hubApi.ensureAuth().catch(() => {})}
            className="px-4 py-2 text-xs font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-500 transition-colors"
          >{t('subscription.connect')}</button>
        </div>
      </section>
    );
  }

  const totalQuota = (hubPlan?.monthlyQuotaCu ?? 0) + (hubPlan?.bonusCu ?? 0);
  const cuUsed = hubPlan?.cuUsed ?? 0;
  const usagePercent = totalQuota > 0 ? Math.min(100, Math.round((cuUsed / totalQuota) * 100)) : 0;

  const hubUrl = typeof window !== 'undefined' && window.location.origin.includes('localhost')
    ? 'http://localhost:5174/settings?tab=billing'
    : 'https://markus.global/settings?tab=billing';

  return (
    <section className="bg-surface-elevated rounded-xl overflow-hidden">
      {/* Plan info bar */}
      <div className="p-5 border-b border-border-default/50">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-fg-secondary">{t('subscription.title')}</h3>
            {hubPlan && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-brand-500/10 text-brand-500 uppercase">
                {hubPlan.planType}
              </span>
            )}
          </div>
          <a href={hubUrl} target="_blank" rel="noopener noreferrer"
            className="px-3 py-1.5 text-xs font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-500 transition-colors">
            {t('subscription.topUp')}
          </a>
        </div>

        {hubPlan && (
          <div className="space-y-2">
            {/* Credits bar */}
            <div className="flex items-center justify-between text-xs">
              <span className="text-fg-tertiary">{t('subscription.credits')}</span>
              <span className="text-fg-secondary tabular-nums">
                {t('subscription.creditsOf', { used: formatCu(cuUsed), total: formatCu(totalQuota) })}
              </span>
            </div>
            <div className="w-full h-2 bg-surface-overlay rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${usagePercent > 90 ? 'bg-red-500' : usagePercent > 70 ? 'bg-amber-500' : 'bg-brand-500'}`}
                style={{ width: `${usagePercent}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[10px] text-fg-tertiary">
              <span>
                {hubPlan.bonusCu > 0 && t('subscription.bonus', { amount: formatCu(hubPlan.bonusCu) })}
              </span>
              <span>
                {hubPlan.cuResetAt
                  ? t('subscription.resetsAt', { date: new Date(hubPlan.cuResetAt).toLocaleDateString() })
                  : t('subscription.oneTime')}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Usage charts */}
      <div className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-xs font-semibold text-fg-secondary">{t('subscription.credits')}</h4>
          <div className="flex items-center gap-2">
            <div className="flex gap-0.5 bg-surface-overlay rounded-md p-0.5">
              <button onClick={() => onGranularityChange('day')}
                className={`px-2 py-1 text-[10px] rounded transition-colors ${granularity === 'day' ? 'bg-brand-600 text-white' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
                {t('subscription.byDay')}
              </button>
              <button onClick={() => onGranularityChange('hour')}
                className={`px-2 py-1 text-[10px] rounded transition-colors ${granularity === 'hour' ? 'bg-brand-600 text-white' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
                {t('subscription.byHour')}
              </button>
            </div>
            <select value={days} onChange={e => onDaysChange(Number(e.target.value))}
              className="text-[10px] bg-surface-overlay border border-border-default rounded-md px-1.5 py-1 text-fg-secondary">
              <option value={7}>7 {t('subscription.days')}</option>
              <option value={14}>14 {t('subscription.days')}</option>
              <option value={30}>30 {t('subscription.days')}</option>
            </select>
          </div>
        </div>

        <UsageCharts stats={hubStats} granularity={granularity} t={t} />
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Usage Charts — bar charts for credits and tokens by period
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
    return <div className="py-8 text-center text-fg-tertiary text-sm">{t('subscription.noUsageData')}</div>;
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
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-surface-overlay rounded-lg p-3 text-center">
          <div className="text-lg font-bold text-fg-primary tabular-nums">{formatNumber(totalCredits)}</div>
          <div className="text-[10px] text-fg-tertiary">{t('subscription.totalCredits')}</div>
        </div>
        <div className="bg-surface-overlay rounded-lg p-3 text-center">
          <div className="text-lg font-bold text-fg-primary tabular-nums">{formatNumber(totalTokens)}</div>
          <div className="text-[10px] text-fg-tertiary">{t('subscription.totalTokens')}</div>
        </div>
        <div className="bg-surface-overlay rounded-lg p-3 text-center">
          <div className="text-lg font-bold text-fg-primary tabular-nums">{formatNumber(totalRequests)}</div>
          <div className="text-[10px] text-fg-tertiary">{t('subscription.totalRequests')}</div>
        </div>
      </div>

      {/* Credits chart */}
      <BarChart
        label={t('subscription.creditsChart')}
        maxLabel={`${t('subscription.max')}: ${formatNumber(maxCredits)}`}
        periods={periods}
        getValue={p => p.credits}
        maxValue={maxCredits}
        color="bg-brand-500"
        fmtLabel={fmtLabel}
        hoverIdx={hoverIdx}
        onHover={setHoverIdx}
        tooltipRef={tooltipRef}
        formatValue={formatNumber}
        granularity={granularity}
      />

      {/* Tokens chart */}
      <BarChart
        label={t('subscription.tokensChart')}
        maxLabel={`${t('subscription.max')}: ${formatNumber(maxTokens)}`}
        periods={periods}
        getValue={p => p.tokens}
        maxValue={maxTokens}
        color="bg-indigo-500"
        fmtLabel={fmtLabel}
        hoverIdx={hoverIdx}
        onHover={setHoverIdx}
        tooltipRef={tooltipRef}
        formatValue={formatNumber}
        granularity={granularity}
      />

      {/* Per-model breakdown */}
      <ModelBreakdown periods={periods} t={t} />
    </div>
  );
}

function BarChart({ label, maxLabel, periods, getValue, maxValue, color, fmtLabel, hoverIdx, onHover, tooltipRef, formatValue, granularity }: {
  label: string;
  maxLabel: string;
  periods: PeriodData[];
  getValue: (p: PeriodData) => number;
  maxValue: number;
  color: string;
  fmtLabel: (p: string) => string;
  hoverIdx: number | null;
  onHover: (idx: number | null) => void;
  tooltipRef: React.RefObject<HTMLDivElement | null>;
  formatValue: (n: number) => string;
  granularity: 'day' | 'hour';
}) {
  return (
    <div className="bg-surface-overlay rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-fg-secondary">{label}</span>
        <span className="text-[10px] text-fg-tertiary">{maxLabel}</span>
      </div>
      <div className="relative h-32 flex items-end gap-px" onMouseLeave={() => onHover(null)}>
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
      {/* X-axis labels */}
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
      <div className="text-xs font-medium text-fg-secondary mb-3">
        Models
      </div>
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
// Shared components
// ═══════════════════════════════════════════════════════════════════════════════

function MetricCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-fg-tertiary mt-0.5">{label}</div>
    </div>
  );
}

function TaskSection({ title, color, items }: { title: string; color: string; items: Array<{ id?: string; label: string; sub: string }> }) {
  return (
    <div className="min-w-0 overflow-hidden">
      <div className={`text-xs font-medium text-${color}-400 mb-1.5`}>{title}</div>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div
            key={item.id ?? i}
            className={`text-sm text-fg-secondary min-w-0 ${item.id ? 'cursor-pointer hover:text-fg-primary group' : ''}`}
            onClick={item.id ? () => navBus.navigate(PAGE.WORK, { openTask: item.id! }) : undefined}
          >
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

function UsageCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-surface-elevated rounded-xl p-5">
      <div className="text-sm text-fg-secondary mb-2">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

type SortCol = 'totalTokens' | 'tokensUsedToday' | 'requestCount' | 'toolCalls' | 'cuUsed';

function SortHeader({ label, col, current, desc, onSort, align }: {
  label: string; col: SortCol; current: SortCol; desc: boolean; onSort: (c: SortCol) => void; align?: string;
}) {
  const arrow = current === col ? (desc ? '↓' : '↑') : '↕';
  const arrowColor = current === col ? 'text-brand-500' : 'text-fg-muted';
  return (
    <th
      className={`px-4 py-3 ${align === 'right' ? 'text-right' : 'text-left'} font-medium cursor-pointer select-none hover:text-fg-secondary`}
      onClick={() => onSort(col)}
    >
      {label}<span className={`ml-1 ${arrowColor}`}>{arrow}</span>
    </th>
  );
}

function AgentRow({ agent, maxTokens }: { agent: AgentUsageInfo; maxTokens: number }) {
  const barWidth = maxTokens > 0 ? Math.min(100, (agent.totalTokens / maxTokens) * 100) : 0;
  const statusColor = agent.status === 'working' ? 'bg-blue-500' :
    agent.status === 'idle' ? 'bg-green-500' :
    agent.status === 'error' ? 'bg-red-500' : 'bg-gray-600';

  return (
    <tr className="border-b border-border-default/50 hover:bg-surface-elevated/30 transition-colors cursor-pointer"
        onClick={() => navBus.navigate(PAGE.TEAM, { selectAgent: agent.agentId })}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-2 h-2 rounded-full ${statusColor}`} />
          <div>
            <div className="text-sm font-medium text-fg-primary hover:text-brand-500 transition-colors">{agent.agentName}</div>
            <div className="text-xs text-fg-tertiary">{agent.role}</div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 bg-surface-elevated rounded-full h-1.5 overflow-hidden max-w-[120px]">
            <div className="h-full bg-brand-500 rounded-full" style={{ width: `${barWidth}%` }} />
          </div>
          <span className="text-sm text-fg-secondary tabular-nums">{formatNumberFull(agent.totalTokens)}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-fg-secondary tabular-nums">{formatNumberFull(agent.tokensUsedToday)}</td>
      <td className="px-4 py-3 text-sm text-fg-secondary tabular-nums">{agent.requestCount}</td>
      <td className="px-4 py-3 text-sm text-fg-secondary tabular-nums">{agent.toolCalls}</td>
      <td className="px-4 py-3 text-sm text-right text-fg-secondary tabular-nums">{formatCu(agent.cuUsed ?? 0)}</td>
    </tr>
  );
}
