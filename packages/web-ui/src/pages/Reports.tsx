import { useState, useEffect, useCallback, useMemo } from 'react';
import { api, type ReportInfo, type ReportFeedbackInfo, type AgentUsageInfo, type AuthUser } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';

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

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

export function ReportsPage({ authUser }: ReportsPageProps) {
  const [period, setPeriod] = useState<Period>('weekly');
  const [report, setReport] = useState<ReportInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [agents, setAgents] = useState<AgentUsageInfo[]>([]);
  const [sortBy, setSortBy] = useState<'totalTokens' | 'tokensUsedToday' | 'requestCount' | 'toolCalls' | 'estimatedCost'>('totalTokens');
  const [sortDesc, setSortDesc] = useState(true);

  const [tab, setTab] = useState<'generate' | 'history'>('generate');
  const [historyReports, setHistoryReports] = useState<ReportInfo[]>([]);
  const [selectedReport, setSelectedReport] = useState<ReportInfo | null>(null);
  const [feedback, setFeedback] = useState<ReportFeedbackInfo[]>([]);
  const [feedbackContent, setFeedbackContent] = useState('');
  const [flash, setFlash] = useState('');

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

  useEffect(() => { fetchReport(period); }, [period, fetchReport]);
  useEffect(() => {
    fetchUsage();
    const i = setInterval(fetchUsage, 30000);
    return () => clearInterval(i);
  }, [fetchUsage]);
  useEffect(() => { if (tab === 'history') fetchHistory(); }, [tab, fetchHistory]);

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      const aVal = a[sortBy] as number;
      const bVal = b[sortBy] as number;
      return sortDesc ? bVal - aVal : aVal - bVal;
    });
  }, [agents, sortBy, sortDesc]);

  const totalCost = agents.reduce((s, a) => s + a.estimatedCost, 0);
  const totalTokensToday = agents.reduce((s, a) => s + a.tokensUsedToday, 0);
  const maxAgentTokens = Math.max(1, ...agents.map(a => a.totalTokens));

  const handleSort = (col: typeof sortBy) => {
    if (sortBy === col) setSortDesc(!sortDesc);
    else { setSortBy(col); setSortDesc(true); }
  };

  const periodLabel: Record<Period, string> = { daily: 'Today', weekly: 'This Week', monthly: 'This Month' };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl p-6 space-y-6">
        {/* Header with tabs */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4 flex-wrap">
            <h1 className="text-xl font-semibold text-fg-primary">Reports</h1>
            <div className="flex gap-1 bg-surface-elevated rounded-lg p-0.5">
              <button onClick={() => setTab('generate')} className={`px-3 py-1.5 text-xs rounded-md transition-colors ${tab === 'generate' ? 'bg-surface-overlay text-fg-primary shadow-sm' : 'text-fg-tertiary hover:text-fg-secondary'}`}>Generate</button>
              <button onClick={() => setTab('history')} className={`px-3 py-1.5 text-xs rounded-md transition-colors ${tab === 'history' ? 'bg-surface-overlay text-fg-primary shadow-sm' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
                History{historyReports.length > 0 ? ` (${historyReports.length})` : ''}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {flash && <span className="px-2.5 py-1 bg-green-500/10 text-green-600 text-xs rounded-lg">{flash}</span>}
            {tab === 'generate' && (
              <div className="flex gap-1 bg-surface-elevated rounded-lg p-0.5">
                {(['daily', 'weekly', 'monthly'] as const).map(p => (
                  <button key={p} onClick={() => setPeriod(p)} className={`px-3 py-1.5 text-xs rounded-md transition-colors capitalize ${period === p ? 'bg-surface-overlay text-fg-primary shadow-sm' : 'text-fg-tertiary hover:text-fg-secondary'}`}>{p}</button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Report History Tab */}
        {tab === 'history' && !selectedReport && (
          <section className="bg-surface-secondary border border-border-default rounded-xl overflow-hidden">
            {historyReports.length === 0 ? (
              <div className="p-8 text-center text-fg-tertiary text-sm">No reports generated yet. Use the Generate tab to create one.</div>
            ) : (
              <div className="divide-y divide-border-default/50">
                {historyReports.map(r => (
                  <button key={r.id} onClick={() => openReport(r)} className="w-full text-left px-5 py-3 flex items-center gap-4 hover:bg-surface-elevated/30 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-fg-primary">{r.type} Report</div>
                      <div className="text-xs text-fg-tertiary mt-0.5">
                        {new Date(r.periodStart).toLocaleDateString()} — {new Date(r.periodEnd).toLocaleDateString()}
                      </div>
                    </div>
                    {r.plan && (
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${
                        r.plan.status === 'approved' ? 'bg-green-500/10 text-green-600' :
                        r.plan.status === 'rejected' ? 'bg-red-500/10 text-red-500' :
                        'bg-amber-500/10 text-amber-600'
                      }`}>{r.plan.status === 'pending' ? 'Plan pending' : `Plan ${r.plan.status}`}</span>
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
              <button onClick={() => { setSelectedReport(null); setFeedback([]); }} className="text-xs text-fg-tertiary hover:text-fg-secondary">&larr; Back to list</button>
              <span className="text-sm font-medium text-fg-primary">{selectedReport.type} Report</span>
              <span className="text-xs text-fg-tertiary">
                {new Date(selectedReport.periodStart).toLocaleDateString()} — {new Date(selectedReport.periodEnd).toLocaleDateString()}
              </span>
            </div>

            {/* Metrics Overview — always shown */}
            {selectedReport.metrics && (
              <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
                <h3 className="text-xs font-semibold text-fg-secondary mb-3">Task Metrics</h3>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <MetricCard label="Completed" value={selectedReport.metrics.tasksCompleted} color="text-green-600" />
                  <MetricCard label="In Progress" value={selectedReport.metrics.tasksInProgress} color="text-brand-500" />
                  <MetricCard label="Created" value={selectedReport.metrics.tasksCreated} color="text-blue-600" />
                  <MetricCard label="Blocked" value={selectedReport.metrics.tasksBlocked} color="text-amber-600" />
                  <MetricCard label="Failed" value={selectedReport.metrics.tasksFailed} color="text-red-500" />
                </div>
              </section>
            )}

            {/* Cost Summary */}
            {selectedReport.costSummary && (
              <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
                <h3 className="text-xs font-semibold text-fg-secondary mb-3">Cost Overview</h3>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <div className="text-2xl font-bold text-fg-primary">{selectedReport.costSummary.totalTokens.toLocaleString()}</div>
                    <div className="text-xs text-fg-tertiary">Total Tokens</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-fg-primary">{formatCost(selectedReport.costSummary.totalEstimatedCost)}</div>
                    <div className="text-xs text-fg-tertiary">Estimated Cost</div>
                  </div>
                  <div>
                    <div className={`text-2xl font-bold ${selectedReport.costSummary.trend === 'decreasing' ? 'text-green-600' : selectedReport.costSummary.trend === 'increasing' ? 'text-red-500' : 'text-fg-primary'}`}>
                      {selectedReport.costSummary.trend === 'decreasing' ? '↓' : selectedReport.costSummary.trend === 'increasing' ? '↑' : '→'} {selectedReport.costSummary.trend}
                    </div>
                    <div className="text-xs text-fg-tertiary">Trend</div>
                  </div>
                </div>
                {selectedReport.costSummary.byAgent && selectedReport.costSummary.byAgent.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-border-default/50 space-y-1.5">
                    {selectedReport.costSummary.byAgent.map((a, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-fg-secondary">{a.agentId}</span>
                        <span className="text-fg-tertiary tabular-nums">{formatNumber(a.tokens)} tokens · {formatCost(a.cost)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Task Summary */}
            {selectedReport.taskSummary && (
              <section className="bg-surface-secondary border border-border-default rounded-xl p-5 overflow-hidden">
                <h3 className="text-xs font-semibold text-fg-secondary mb-3">Task Summary</h3>
                <div className="space-y-4 min-w-0">
                  {selectedReport.taskSummary.completed.length > 0 && (
                    <TaskSection title={`Completed (${selectedReport.taskSummary.completed.length})`} color="emerald" items={selectedReport.taskSummary.completed.map(t => ({ id: t.id, label: t.title, sub: t.agent }))} />
                  )}
                  {selectedReport.taskSummary.inProgress.length > 0 && (
                    <TaskSection title={`In Progress (${selectedReport.taskSummary.inProgress.length})`} color="indigo" items={selectedReport.taskSummary.inProgress.map(t => ({ id: t.id, label: t.title, sub: t.agent }))} />
                  )}
                  {selectedReport.taskSummary.blocked.length > 0 && (
                    <TaskSection title={`Blocked (${selectedReport.taskSummary.blocked.length})`} color="amber" items={selectedReport.taskSummary.blocked.map(t => ({ id: t.id, label: t.title, sub: t.reason || t.agent }))} />
                  )}
                  {selectedReport.taskSummary.completed.length === 0 && selectedReport.taskSummary.inProgress.length === 0 && selectedReport.taskSummary.blocked.length === 0 && (
                    <p className="text-sm text-fg-tertiary">No tasks in this period.</p>
                  )}
                </div>
              </section>
            )}

            {/* Highlights */}
            {selectedReport.highlights && selectedReport.highlights.length > 0 && (
              <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
                <h3 className="text-xs font-semibold text-fg-secondary mb-2">Highlights</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-fg-secondary">
                  {selectedReport.highlights.map((h, i) => <li key={i}>{h}</li>)}
                </ul>
              </section>
            )}

            {/* Blockers */}
            {selectedReport.blockers && selectedReport.blockers.length > 0 && (
              <section className="bg-surface-secondary border border-amber-500/20 rounded-xl p-5">
                <h3 className="text-xs font-semibold text-amber-600 mb-2">Blockers</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-fg-secondary">
                  {selectedReport.blockers.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </section>
            )}

            {/* Plan approval */}
            {selectedReport.plan && (
              <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-fg-secondary">
                    Upcoming Plan
                    <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      selectedReport.plan.status === 'approved' ? 'bg-green-500/10 text-green-600' :
                      selectedReport.plan.status === 'rejected' ? 'bg-red-500/10 text-red-500' :
                      'bg-amber-500/10 text-amber-600'
                    }`}>{selectedReport.plan.status}</span>
                  </h3>
                  {selectedReport.plan.status === 'pending' && (
                    <div className="flex gap-2">
                      <button
                        onClick={async () => {
                          try {
                            const { report: r } = await api.reports.approvePlan(selectedReport.id, { approvedBy: authUser?.id ?? 'admin' });
                            setSelectedReport(r);
                            showFlash('Plan approved');
                            fetchHistory();
                          } catch (e) { showFlash(`Error: ${e}`); }
                        }}
                        className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-500 transition-colors"
                      >Approve Plan</button>
                      <button
                        onClick={async () => {
                          const reason = prompt('Rejection reason:');
                          if (!reason) return;
                          try {
                            const { report: r } = await api.reports.rejectPlan(selectedReport.id, { rejectedBy: authUser?.id ?? 'admin', reason });
                            setSelectedReport(r);
                            showFlash('Plan rejected');
                            fetchHistory();
                          } catch (e) { showFlash(`Error: ${e}`); }
                        }}
                        className="px-3 py-1.5 text-xs font-medium border border-border-default text-fg-secondary rounded-lg hover:bg-surface-overlay transition-colors"
                      >Reject Plan</button>
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

            {/* No data fallback */}
            {!selectedReport.metrics && !selectedReport.taskSummary && !selectedReport.costSummary && (
              <section className="bg-surface-secondary border border-border-default rounded-xl p-8 text-center">
                <p className="text-sm text-fg-tertiary">This report does not contain detailed metrics data.</p>
              </section>
            )}

            {/* Feedback */}
            <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
              <h3 className="text-xs font-semibold text-fg-secondary mb-3">Feedback ({feedback.length})</h3>
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
                  placeholder="Add feedback or instructions…"
                  className="flex-1 px-3 py-2 text-xs bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder:text-fg-tertiary"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && feedbackContent.trim()) {
                      api.reports.addFeedback(selectedReport.id, { author: authUser?.id ?? 'admin', type: 'comment', content: feedbackContent.trim() })
                        .then(({ feedback: fb }) => { setFeedback(prev => [...prev, fb]); setFeedbackContent(''); showFlash('Feedback added'); })
                        .catch(err => showFlash(`Error: ${err}`));
                    }
                  }}
                />
                <button
                  onClick={() => {
                    if (!feedbackContent.trim()) return;
                    api.reports.addFeedback(selectedReport.id, { author: authUser?.id ?? 'admin', type: 'comment', content: feedbackContent.trim() })
                      .then(({ feedback: fb }) => { setFeedback(prev => [...prev, fb]); setFeedbackContent(''); showFlash('Feedback added'); })
                      .catch(err => showFlash(`Error: ${err}`));
                  }}
                  disabled={!feedbackContent.trim()}
                  className="px-3 py-2 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >Send</button>
              </div>
            </section>
          </>
        )}

        {/* Generate Tab Content */}
        {tab === 'generate' && usageSummary && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <UsageCard label="LLM Tokens (this month)" value={formatNumber(usageSummary.llmTokens)} color="text-brand-500" />
            <UsageCard label="Tool Calls (today)" value={formatNumber(usageSummary.toolCalls)} color="text-blue-600" />
            <UsageCard label="Messages (today)" value={formatNumber(usageSummary.messages)} color="text-green-600" />
            <UsageCard label="Storage" value={formatBytes(usageSummary.storageBytes)} color="text-amber-600" />
          </div>
        )}

        {/* Period Report Data */}
        {tab === 'generate' && (loading ? (
          <div className="flex items-center justify-center h-32 text-fg-tertiary text-sm">Loading…</div>
        ) : error ? (
          <div className="flex items-center justify-center h-32 text-red-500 text-sm">{error}</div>
        ) : report ? (
          <>
            <div className="text-xs text-fg-tertiary">
              {periodLabel[period]} · {new Date(report.periodStart).toLocaleDateString()} — {new Date(report.periodEnd).toLocaleDateString()}
            </div>

            {/* Task Metrics */}
            {report.metrics && (
              <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
                <h3 className="text-xs font-semibold text-fg-secondary mb-3">Task Metrics</h3>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <MetricCard label="Completed" value={report.metrics.tasksCompleted} color="text-green-600" />
                  <MetricCard label="In Progress" value={report.metrics.tasksInProgress} color="text-brand-500" />
                  <MetricCard label="Created" value={report.metrics.tasksCreated} color="text-blue-600" />
                  <MetricCard label="Blocked" value={report.metrics.tasksBlocked} color="text-amber-600" />
                  <MetricCard label="Failed" value={report.metrics.tasksFailed} color="text-red-500" />
                </div>
              </section>
            )}

            {/* Cost Summary */}
            <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
              <h3 className="text-xs font-semibold text-fg-secondary mb-3">Cost Overview</h3>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <div className="text-2xl font-bold text-fg-primary">{formatCost(totalCost)}</div>
                  <div className="text-xs text-fg-tertiary">Est. Cost (all time)</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-fg-primary">{formatNumber(totalTokensToday)}</div>
                  <div className="text-xs text-fg-tertiary">Tokens Today</div>
                </div>
                {report.costSummary && (
                  <>
                    <div>
                      <div className="text-2xl font-bold text-fg-primary">{report.costSummary.totalTokens.toLocaleString()}</div>
                      <div className="text-xs text-fg-tertiary">Tokens ({periodLabel[period]})</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-fg-primary">{formatCost(report.costSummary.totalEstimatedCost)}</div>
                      <div className="text-xs text-fg-tertiary">Cost ({periodLabel[period]})</div>
                    </div>
                  </>
                )}
              </div>
            </section>

            {/* Task Summary */}
            {report.taskSummary && (
              <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
                <h3 className="text-xs font-semibold text-fg-secondary mb-3">Task Summary</h3>
                <div className="space-y-4">
                  {report.taskSummary.completed.length > 0 && (
                    <TaskSection title={`Completed (${report.taskSummary.completed.length})`} color="emerald" items={report.taskSummary.completed.map(t => ({ id: t.id, label: t.title, sub: t.agent }))} />
                  )}
                  {report.taskSummary.inProgress.length > 0 && (
                    <TaskSection title={`In Progress (${report.taskSummary.inProgress.length})`} color="indigo" items={report.taskSummary.inProgress.map(t => ({ id: t.id, label: t.title, sub: t.agent }))} />
                  )}
                  {report.taskSummary.blocked.length > 0 && (
                    <TaskSection title={`Blocked (${report.taskSummary.blocked.length})`} color="amber" items={report.taskSummary.blocked.map(t => ({ id: t.id, label: t.title, sub: t.reason || t.agent }))} />
                  )}
                  {report.taskSummary.completed.length === 0 && report.taskSummary.inProgress.length === 0 && report.taskSummary.blocked.length === 0 && (
                    <p className="text-sm text-fg-tertiary">No tasks in this period.</p>
                  )}
                </div>
              </section>
            )}
          </>
        ) : null)}

        {/* Per-Agent Breakdown */}
        {tab === 'generate' && (
        <section className="bg-surface-secondary border border-border-default rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border-default">
            <h3 className="text-sm font-semibold text-fg-secondary">Per-Agent Usage</h3>
          </div>
          {agents.length === 0 ? (
            <div className="p-8 text-center text-fg-tertiary text-sm">No agent usage data yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border-default text-xs text-fg-tertiary uppercase tracking-wider">
                    <th className="px-4 py-3 text-left font-medium">Agent</th>
                    <SortHeader label="Total Tokens" col="totalTokens" current={sortBy} desc={sortDesc} onSort={handleSort} />
                    <SortHeader label="Today" col="tokensUsedToday" current={sortBy} desc={sortDesc} onSort={handleSort} />
                    <SortHeader label="Requests" col="requestCount" current={sortBy} desc={sortDesc} onSort={handleSort} />
                    <SortHeader label="Tool Calls" col="toolCalls" current={sortBy} desc={sortDesc} onSort={handleSort} />
                    <SortHeader label="Est. Cost" col="estimatedCost" current={sortBy} desc={sortDesc} onSort={handleSort} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {sortedAgents.map(agent => (
                    <AgentRow key={agent.agentId} agent={agent} maxTokens={maxAgentTokens} />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border-default bg-surface-elevated/30">
                    <td className="px-4 py-3 text-sm font-medium text-fg-secondary">Total ({agents.length} agents)</td>
                    <td className="px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">{formatNumber(agents.reduce((s, a) => s + a.totalTokens, 0))}</td>
                    <td className="px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">{formatNumber(totalTokensToday)}</td>
                    <td className="px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">{agents.reduce((s, a) => s + a.requestCount, 0)}</td>
                    <td className="px-4 py-3 text-sm font-medium text-fg-secondary tabular-nums">{agents.reduce((s, a) => s + a.toolCalls, 0)}</td>
                    <td className="px-4 py-3 text-sm font-medium text-right text-fg-secondary tabular-nums">{formatCost(totalCost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
        )}

      </div>
    </div>
  );
}

// ── Shared components ────────────────────────────────────────────────────────

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
    <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
      <div className="text-sm text-fg-secondary mb-2">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

type SortCol = 'totalTokens' | 'tokensUsedToday' | 'requestCount' | 'toolCalls' | 'estimatedCost';

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
    agent.status === 'paused' ? 'bg-amber-500' :
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
          <span className="text-sm text-fg-secondary tabular-nums">{formatNumber(agent.totalTokens)}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-fg-secondary tabular-nums">{formatNumber(agent.tokensUsedToday)}</td>
      <td className="px-4 py-3 text-sm text-fg-secondary tabular-nums">{agent.requestCount}</td>
      <td className="px-4 py-3 text-sm text-fg-secondary tabular-nums">{agent.toolCalls}</td>
      <td className="px-4 py-3 text-sm text-right text-fg-secondary tabular-nums">{formatCost(agent.estimatedCost)}</td>
    </tr>
  );
}
