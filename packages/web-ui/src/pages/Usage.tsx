import { useEffect, useState, useMemo } from 'react';
import { api, type AgentUsageInfo } from '../api.ts';
import { navBus } from '../navBus.ts';

interface UsageSummary {
  orgId: string;
  period: string;
  llmTokens: number;
  toolCalls: number;
  messages: number;
  storageBytes: number;
}

interface PlanInfo {
  orgId: string;
  tier: string;
  limits: {
    maxAgents: number;
    maxTokensPerMonth: number;
    maxToolCallsPerDay: number;
    maxMessagesPerDay: number;
    maxStorageBytes: number;
  };
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

const colorMap: Record<string, string> = {
  indigo: 'bg-brand-500',
  blue: 'bg-blue-500',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  purple: 'bg-purple-500',
  green: 'bg-green-500',
  red: 'bg-red-500',
};

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const isUnlimited = max < 0;
  const barColor = isUnlimited ? 'bg-gray-600' : pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : (colorMap[color] ?? 'bg-brand-500');
  return (
    <div className="w-full bg-surface-elevated rounded-full h-2 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${barColor}`}
        style={{ width: isUnlimited ? '5%' : `${pct}%` }}
      />
    </div>
  );
}

function UsageGauge({ label, value, max, unit, color }: {
  label: string; value: number; max: number; unit?: string; color: string;
}) {
  const isUnlimited = max < 0;
  const pct = isUnlimited ? 0 : max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-gray-400">{label}</span>
        {!isUnlimited && (
          <span className={`text-xs font-medium ${pct > 90 ? 'text-red-400' : pct > 70 ? 'text-amber-400' : 'text-gray-500'}`}>
            {pct.toFixed(0)}%
          </span>
        )}
      </div>
      <div className="text-2xl font-bold text-white mb-1">
        {formatNumber(value)}{unit ? ` ${unit}` : ''}
      </div>
      <div className="text-xs text-gray-500 mb-3">
        of {isUnlimited ? 'unlimited' : formatNumber(max)}
      </div>
      <ProgressBar value={value} max={max} color={color} />
    </div>
  );
}

function AgentUsageRow({ agent, maxTokens }: { agent: AgentUsageInfo; maxTokens: number }) {
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

export function Usage() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [agents, setAgents] = useState<AgentUsageInfo[]>([]);
  const [sortBy, setSortBy] = useState<'totalTokens' | 'tokensUsedToday' | 'requestCount' | 'toolCalls' | 'estimatedCost'>('totalTokens');
  const [sortDesc, setSortDesc] = useState(true);

  const refresh = () => {
    api.usage.summary().then(d => {
      setSummary(d.usage);
      setPlan(d.plan);
    }).catch(() => {});
    api.usage.agents().then(d => setAgents(d.agents)).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 15000);
    return () => clearInterval(i);
  }, []);

  const sortedAgents = useMemo(() => {
    const sorted = [...agents].sort((a, b) => {
      const aVal = a[sortBy];
      const bVal = b[sortBy];
      return sortDesc ? (bVal as number) - (aVal as number) : (aVal as number) - (bVal as number);
    });
    return sorted;
  }, [agents, sortBy, sortDesc]);

  const totalCost = agents.reduce((s, a) => s + a.estimatedCost, 0);
  const totalTokensToday = agents.reduce((s, a) => s + a.tokensUsedToday, 0);
  const maxAgentTokens = Math.max(1, ...agents.map(a => a.totalTokens));

  const handleSort = (col: typeof sortBy) => {
    if (sortBy === col) setSortDesc(!sortDesc);
    else { setSortBy(col); setSortDesc(true); }
  };

  const SortIcon = ({ col }: { col: typeof sortBy }) => (
    <span className={`ml-1 ${sortBy === col ? 'text-brand-400' : 'text-gray-700'}`}>
      {sortBy === col ? (sortDesc ? '↓' : '↑') : '↕'}
    </span>
  );

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-6 h-14 border-b border-border-default bg-surface-secondary">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Usage & Costs</h2>
          {plan && (
            <span className={`px-2.5 py-0.5 text-xs rounded-full font-medium ${
              plan.tier === 'enterprise' ? 'bg-purple-900/50 text-purple-300 border border-purple-700' :
              plan.tier === 'pro' ? 'bg-blue-900/50 text-blue-300 border border-blue-700' :
              'bg-surface-elevated text-gray-400 border border-border-default'
            }`}>
              {plan.tier.charAt(0).toUpperCase() + plan.tier.slice(1)} Plan
            </span>
          )}
        </div>
        <button onClick={refresh} className="px-3 py-1.5 text-xs bg-surface-elevated hover:bg-surface-overlay rounded-lg text-gray-400 transition-colors">
          Refresh
        </button>
      </div>

      <div className="p-7 space-y-6">
        {/* Overview Gauges */}
        {summary && plan && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <UsageGauge
              label="LLM Tokens (this month)"
              value={summary.llmTokens}
              max={plan.limits.maxTokensPerMonth}
              color="indigo"
            />
            <UsageGauge
              label="Tool Calls (today)"
              value={summary.toolCalls}
              max={plan.limits.maxToolCallsPerDay}
              color="blue"
            />
            <UsageGauge
              label="Messages (today)"
              value={summary.messages}
              max={plan.limits.maxMessagesPerDay}
              color="emerald"
            />
            <UsageGauge
              label="Storage"
              value={summary.storageBytes}
              max={plan.limits.maxStorageBytes}
              unit=""
              color="amber"
            />
          </div>
        )}

        {/* Cost Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
            <div className="text-sm text-gray-400 mb-1">Estimated Cost (this month)</div>
            <div className="text-3xl font-bold text-white">{formatCost(totalCost)}</div>
          </div>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
            <div className="text-sm text-gray-400 mb-1">Tokens Today</div>
            <div className="text-3xl font-bold text-white">{formatNumber(totalTokensToday)}</div>
          </div>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
            <div className="text-sm text-gray-400 mb-1">Active Agents</div>
            <div className="text-3xl font-bold text-white">
              {agents.filter(a => a.status === 'idle' || a.status === 'working').length}
              <span className="text-lg text-gray-500 font-normal"> / {agents.length}</span>
            </div>
          </div>
        </div>

        {/* Per-Agent Usage Table */}
        <div className="bg-surface-secondary border border-border-default rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border-default">
            <h3 className="text-sm font-semibold text-gray-300">Per-Agent Breakdown</h3>
          </div>
          {agents.length === 0 ? (
            <div className="p-8 text-center text-gray-500 text-sm">
              No agent usage data yet. Agents will appear here after their first interaction.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border-default text-xs text-gray-500 uppercase tracking-wider">
                    <th className="px-4 py-3 text-left font-medium">Agent</th>
                    <th className="px-4 py-3 text-left font-medium cursor-pointer select-none hover:text-gray-300" onClick={() => handleSort('totalTokens')}>
                      Total Tokens<SortIcon col="totalTokens" />
                    </th>
                    <th className="px-4 py-3 text-left font-medium cursor-pointer select-none hover:text-gray-300" onClick={() => handleSort('tokensUsedToday')}>
                      Today<SortIcon col="tokensUsedToday" />
                    </th>
                    <th className="px-4 py-3 text-left font-medium cursor-pointer select-none hover:text-gray-300" onClick={() => handleSort('requestCount')}>
                      Requests<SortIcon col="requestCount" />
                    </th>
                    <th className="px-4 py-3 text-left font-medium cursor-pointer select-none hover:text-gray-300" onClick={() => handleSort('toolCalls')}>
                      Tool Calls<SortIcon col="toolCalls" />
                    </th>
                    <th className="px-4 py-3 text-right font-medium cursor-pointer select-none hover:text-gray-300" onClick={() => handleSort('estimatedCost')}>
                      Est. Cost<SortIcon col="estimatedCost" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAgents.map(agent => (
                    <AgentUsageRow key={agent.agentId} agent={agent} maxTokens={maxAgentTokens} />
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
        </div>

        {/* Plan Limits Info */}
        {plan && (
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Plan Limits — {plan.tier.charAt(0).toUpperCase() + plan.tier.slice(1)}</h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-xs">
              <div>
                <div className="text-gray-500">Max Agents</div>
                <div className="text-gray-300 mt-0.5">{plan.limits.maxAgents < 0 ? 'Unlimited' : plan.limits.maxAgents}</div>
              </div>
              <div>
                <div className="text-gray-500">Tokens / Month</div>
                <div className="text-gray-300 mt-0.5">{plan.limits.maxTokensPerMonth < 0 ? 'Unlimited' : formatNumber(plan.limits.maxTokensPerMonth)}</div>
              </div>
              <div>
                <div className="text-gray-500">Tool Calls / Day</div>
                <div className="text-gray-300 mt-0.5">{plan.limits.maxToolCallsPerDay < 0 ? 'Unlimited' : formatNumber(plan.limits.maxToolCallsPerDay)}</div>
              </div>
              <div>
                <div className="text-gray-500">Messages / Day</div>
                <div className="text-gray-300 mt-0.5">{plan.limits.maxMessagesPerDay < 0 ? 'Unlimited' : formatNumber(plan.limits.maxMessagesPerDay)}</div>
              </div>
              <div>
                <div className="text-gray-500">Storage</div>
                <div className="text-gray-300 mt-0.5">{plan.limits.maxStorageBytes < 0 ? 'Unlimited' : formatBytes(plan.limits.maxStorageBytes)}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
