import { useState, useEffect, useCallback, useMemo } from 'react';
import { api, type ReportInfo, type AgentUsageInfo } from '../api.ts';
import { navBus } from '../navBus.ts';

type Period = 'daily' | 'weekly' | 'monthly';

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

export function ReportsPage() {
  const [period, setPeriod] = useState<Period>('weekly');
  const [report, setReport] = useState<ReportInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [agents, setAgents] = useState<AgentUsageInfo[]>([]);
  const [sortBy, setSortBy] = useState<'totalTokens' | 'tokensUsedToday' | 'requestCount' | 'toolCalls' | 'estimatedCost'>('totalTokens');
  const [sortDesc, setSortDesc] = useState(true);

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

  useEffect(() => { fetchReport(period); }, [period, fetchReport]);
  useEffect(() => {
    fetchUsage();
    const i = setInterval(fetchUsage, 30000);
    return () => clearInterval(i);
  }, [fetchUsage]);

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
        {/* Header with inline filters */}
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-white">Reports</h1>
          <select
            value={period}
            onChange={e => setPeriod(e.target.value as Period)}
            className="bg-surface-elevated border border-border-default rounded-lg px-3 py-1.5 text-sm text-gray-200"
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>

        {/* Usage Overview */}
        {usageSummary && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <UsageCard label="LLM Tokens (this month)" value={formatNumber(usageSummary.llmTokens)} color="text-brand-400" />
            <UsageCard label="Tool Calls (today)" value={formatNumber(usageSummary.toolCalls)} color="text-blue-400" />
            <UsageCard label="Messages (today)" value={formatNumber(usageSummary.messages)} color="text-emerald-400" />
            <UsageCard label="Storage" value={formatBytes(usageSummary.storageBytes)} color="text-amber-400" />
          </div>
        )}

        {/* Period Report Data */}
        {loading ? (
          <div className="flex items-center justify-center h-32 text-gray-500 text-sm">Loading…</div>
        ) : error ? (
          <div className="flex items-center justify-center h-32 text-red-400 text-sm">{error}</div>
        ) : report ? (
          <>
            <div className="text-xs text-gray-500">
              {periodLabel[period]} · {new Date(report.periodStart).toLocaleDateString()} — {new Date(report.periodEnd).toLocaleDateString()}
            </div>

            {/* Task Metrics */}
            {report.metrics && (
              <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
                <h3 className="text-xs font-semibold text-gray-400 mb-3">Task Metrics</h3>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <MetricCard label="Completed" value={report.metrics.tasksCompleted} color="text-emerald-400" />
                  <MetricCard label="In Progress" value={report.metrics.tasksInProgress} color="text-brand-400" />
                  <MetricCard label="Created" value={report.metrics.tasksCreated} color="text-blue-400" />
                  <MetricCard label="Blocked" value={report.metrics.tasksBlocked} color="text-amber-400" />
                  <MetricCard label="Failed" value={report.metrics.tasksFailed} color="text-red-400" />
                </div>
              </section>
            )}

            {/* Cost Summary */}
            <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
              <h3 className="text-xs font-semibold text-gray-400 mb-3">Cost Overview</h3>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <div className="text-2xl font-bold text-white">{formatCost(totalCost)}</div>
                  <div className="text-xs text-gray-500">Est. Cost (all time)</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-white">{formatNumber(totalTokensToday)}</div>
                  <div className="text-xs text-gray-500">Tokens Today</div>
                </div>
                {report.costSummary && (
                  <>
                    <div>
                      <div className="text-2xl font-bold text-white">{report.costSummary.totalTokens.toLocaleString()}</div>
                      <div className="text-xs text-gray-500">Tokens ({periodLabel[period]})</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-white">{formatCost(report.costSummary.totalEstimatedCost)}</div>
                      <div className="text-xs text-gray-500">Cost ({periodLabel[period]})</div>
                    </div>
                  </>
                )}
              </div>
            </section>

            {/* Task Summary */}
            {report.taskSummary && (
              <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
                <h3 className="text-xs font-semibold text-gray-400 mb-3">Task Summary</h3>
                <div className="space-y-4">
                  {report.taskSummary.completed.length > 0 && (
                    <TaskSection title={`Completed (${report.taskSummary.completed.length})`} color="emerald" items={report.taskSummary.completed.map(t => ({ label: t.title, sub: t.agent }))} />
                  )}
                  {report.taskSummary.inProgress.length > 0 && (
                    <TaskSection title={`In Progress (${report.taskSummary.inProgress.length})`} color="indigo" items={report.taskSummary.inProgress.map(t => ({ label: t.title, sub: t.agent }))} />
                  )}
                  {report.taskSummary.blocked.length > 0 && (
                    <TaskSection title={`Blocked (${report.taskSummary.blocked.length})`} color="amber" items={report.taskSummary.blocked.map(t => ({ label: t.title, sub: t.reason || t.agent }))} />
                  )}
                  {report.taskSummary.completed.length === 0 && report.taskSummary.inProgress.length === 0 && report.taskSummary.blocked.length === 0 && (
                    <p className="text-sm text-gray-500">No tasks in this period.</p>
                  )}
                </div>
              </section>
            )}
          </>
        ) : null}

        {/* Per-Agent Breakdown */}
        <section className="bg-surface-secondary border border-border-default rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border-default">
            <h3 className="text-sm font-semibold text-gray-300">Per-Agent Usage</h3>
          </div>
          {agents.length === 0 ? (
            <div className="p-8 text-center text-gray-500 text-sm">No agent usage data yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border-default text-xs text-gray-500 uppercase tracking-wider">
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
                    <td className="px-4 py-3 text-sm font-medium text-gray-300">Total ({agents.length} agents)</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-300 tabular-nums">{formatNumber(agents.reduce((s, a) => s + a.totalTokens, 0))}</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-300 tabular-nums">{formatNumber(totalTokensToday)}</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-300 tabular-nums">{agents.reduce((s, a) => s + a.requestCount, 0)}</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-300 tabular-nums">{agents.reduce((s, a) => s + a.toolCalls, 0)}</td>
                    <td className="px-4 py-3 text-sm font-medium text-right text-gray-300 tabular-nums">{formatCost(totalCost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>

      </div>
    </div>
  );
}

// ── Shared components ────────────────────────────────────────────────────────

function MetricCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

function TaskSection({ title, color, items }: { title: string; color: string; items: Array<{ label: string; sub: string }> }) {
  return (
    <div>
      <div className={`text-xs font-medium text-${color}-400 mb-1.5`}>{title}</div>
      <div className="space-y-1">
        {items.map((item, i) => (
          <div key={i} className="text-sm text-gray-300 flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full bg-${color}-500 shrink-0`} />
            <span className="truncate">{item.label}</span>
            {item.sub && item.sub !== 'unassigned' && <span className="text-[10px] text-gray-500 shrink-0">{item.sub}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function UsageCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
      <div className="text-sm text-gray-400 mb-2">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

type SortCol = 'totalTokens' | 'tokensUsedToday' | 'requestCount' | 'toolCalls' | 'estimatedCost';

function SortHeader({ label, col, current, desc, onSort, align }: {
  label: string; col: SortCol; current: SortCol; desc: boolean; onSort: (c: SortCol) => void; align?: string;
}) {
  const arrow = current === col ? (desc ? '↓' : '↑') : '↕';
  const arrowColor = current === col ? 'text-brand-400' : 'text-gray-700';
  return (
    <th
      className={`px-4 py-3 ${align === 'right' ? 'text-right' : 'text-left'} font-medium cursor-pointer select-none hover:text-gray-300`}
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
        onClick={() => navBus.navigate('team', { selectAgent: agent.agentId })}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-2 h-2 rounded-full ${statusColor}`} />
          <div>
            <div className="text-sm font-medium text-gray-200 hover:text-brand-300 transition-colors">{agent.agentName}</div>
            <div className="text-xs text-gray-500">{agent.role}</div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 bg-surface-elevated rounded-full h-1.5 overflow-hidden max-w-[120px]">
            <div className="h-full bg-brand-500 rounded-full" style={{ width: `${barWidth}%` }} />
          </div>
          <span className="text-sm text-gray-300 tabular-nums">{formatNumber(agent.totalTokens)}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-gray-300 tabular-nums">{formatNumber(agent.tokensUsedToday)}</td>
      <td className="px-4 py-3 text-sm text-gray-300 tabular-nums">{agent.requestCount}</td>
      <td className="px-4 py-3 text-sm text-gray-300 tabular-nums">{agent.toolCalls}</td>
      <td className="px-4 py-3 text-sm text-right text-gray-300 tabular-nums">{formatCost(agent.estimatedCost)}</td>
    </tr>
  );
}
