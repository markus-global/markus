import { useEffect, useState } from 'react';
import { api, wsClient, type AgentInfo, type TaskInfo, type OpsDashboard } from '../api.ts';
import { ConfirmModal } from '../components/ConfirmModal.tsx';
import { navBus } from '../navBus.ts';

export function Dashboard() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [board, setBoard] = useState<Record<string, TaskInfo[]>>({});
  const [ops, setOps] = useState<OpsDashboard | null>(null);
  const [opsPeriod, setOpsPeriod] = useState<'1h' | '24h' | '7d'>('24h');
  const [pendingRemove, setPendingRemove] = useState<{ id: string; name: string } | null>(null);

  const refresh = () => {
    api.agents.list().then((d) => setAgents(d.agents)).catch(() => {});
    api.tasks.board().then((d) => setBoard(d.board)).catch(() => {});
    api.ops.dashboard(opsPeriod).then(setOps).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 15000);
    const unsub = wsClient.on('*', () => refresh());
    return () => { clearInterval(i); unsub(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opsPeriod]);

  const pending = (board['pending']?.length ?? 0) + (board['assigned']?.length ?? 0);
  const completed = board['completed']?.length ?? 0;

  const agentHealthMap = new Map<string, number>();
  if (ops) {
    for (const ae of ops.agentEfficiency) {
      agentHealthMap.set(ae.agentId, ae.healthScore);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center justify-between px-7 h-15 border-b border-gray-800 bg-gray-900">
        <h2 className="text-lg font-semibold">Dashboard</h2>
        <div className="flex items-center gap-3">
          <div className="flex gap-1 bg-gray-800 rounded-lg p-0.5">
            {(['1h', '24h', '7d'] as const).map(p => (
              <button
                key={p}
                onClick={() => setOpsPeriod(p)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  opsPeriod === p ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <button
            onClick={() => navBus.navigate('team', { openHire: 'true' })}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition-colors"
          >
            + Hire Agent
          </button>
        </div>
      </div>

      <div className="p-7 space-y-6">
        {/* System Health Banner */}
        {ops && (
          <div className="bg-gradient-to-r from-gray-900 to-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">System Health</h3>
              <span className="text-[10px] text-gray-600">Updated {new Date(ops.generatedAt).toLocaleTimeString()}</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
              <MetricCard
                label="Health Score"
                value={ops.systemHealth.overallScore}
                suffix="%"
                color={ops.systemHealth.overallScore >= 80 ? 'green' : ops.systemHealth.overallScore >= 50 ? 'amber' : 'red'}
              />
              <MetricCard
                label="Active Agents"
                value={ops.systemHealth.activeAgents}
                subtitle={`of ${ops.systemHealth.totalAgents}`}
                color="indigo"
              />
              <MetricCard label="Total Tasks" value={ops.taskKPI.totalTasks} color="blue" />
              <MetricCard
                label="Success Rate"
                value={ops.taskKPI.successRate}
                suffix="%"
                color={ops.taskKPI.successRate >= 80 ? 'green' : 'amber'}
              />
              <MetricCard
                label="Token Cost"
                value={`$${ops.systemHealth.totalTokenCost.toFixed(4)}`}
                color="purple"
                raw
              />
              <MetricCard label="Interactions" value={ops.systemHealth.totalInteractions} color="cyan" />
            </div>

            {ops.systemHealth.criticalAgents.length > 0 && (
              <div className="mt-4 pt-3 border-t border-gray-800">
                <div className="flex items-center gap-2 text-xs text-red-400">
                  <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  {ops.systemHealth.criticalAgents.length} agent{ops.systemHealth.criticalAgents.length > 1 ? 's' : ''} need attention:
                  {ops.systemHealth.criticalAgents.map(a => (
                    <span key={a.id} className="px-2 py-0.5 bg-red-500/10 rounded text-red-400">{a.name} ({a.score}%)</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Active Agents', value: agents.length, icon: '⊕' },
            { label: 'Pending Tasks', value: pending, icon: '☑' },
            { label: 'Completed', value: completed, icon: '✓' },
          ].map((s) => (
            <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center gap-3">
                <span className="text-2xl opacity-40">{s.icon}</span>
                <div>
                  <div className="text-3xl font-bold">{s.value}</div>
                  <div className="text-sm text-gray-500 mt-1">{s.label}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Task KPI Breakdown */}
        {ops && ops.taskKPI.totalTasks > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Task Distribution</h3>
            <div className="flex gap-2 flex-wrap">
              {Object.entries(ops.taskKPI.statusCounts)
                .filter(([, v]) => v > 0)
                .sort(([, a], [, b]) => b - a)
                .map(([status, count]) => (
                  <div key={status} className="flex items-center gap-2 px-3 py-2 bg-gray-800 rounded-lg">
                    <span className={`w-2.5 h-2.5 rounded-full ${STATUS_COLORS[status] ?? 'bg-gray-500'}`} />
                    <span className="text-sm text-gray-300 capitalize">{status}</span>
                    <span className="text-sm font-semibold text-white">{count}</span>
                  </div>
                ))
              }
            </div>
            {ops.taskKPI.blockedCount > 0 && (
              <div className="mt-3 text-xs text-amber-400 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-amber-400 rounded-full" />
                {ops.taskKPI.blockedCount} blocked task{ops.taskKPI.blockedCount > 1 ? 's' : ''} require attention
              </div>
            )}
          </div>
        )}

        {/* Digital Employees with Health Scores */}
        <h3 className="text-base font-semibold">Digital Employees</h3>
        {agents.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center text-gray-500">
            No digital employees yet. Click "Hire Agent" to get started.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.map((a) => {
              const healthScore = agentHealthMap.get(a.id);
              const efficiency = ops?.agentEfficiency.find(e => e.agentId === a.id);
              return (
                <div key={a.id} className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-indigo-500/50 transition-colors">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-semibold">{a.name}{a.agentRole === 'manager' ? ' ★' : ''}</div>
                      <div className="text-sm text-gray-500">{a.role}{a.agentRole === 'manager' ? ' · Manager' : ''}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {healthScore !== undefined && (
                        <HealthBadge score={healthScore} />
                      )}
                      <StatusBadge status={a.status} />
                    </div>
                  </div>

                  {efficiency && (
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <div className="bg-gray-800/50 rounded-lg py-1.5 px-1">
                        <div className="text-xs font-semibold text-white">{efficiency.taskMetrics.completed}</div>
                        <div className="text-[10px] text-gray-500">Done</div>
                      </div>
                      <div className="bg-gray-800/50 rounded-lg py-1.5 px-1">
                        <div className="text-xs font-semibold text-white">{efficiency.totalInteractions}</div>
                        <div className="text-[10px] text-gray-500">Chats</div>
                      </div>
                      <div className="bg-gray-800/50 rounded-lg py-1.5 px-1">
                        <div className="text-xs font-semibold text-white">${efficiency.tokenUsage.cost.toFixed(3)}</div>
                        <div className="text-[10px] text-gray-500">Cost</div>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2 mt-4 pt-4 border-t border-gray-800">
                    <button onClick={() => { api.agents.start(a.id).then(refresh); }} className="px-3 py-1.5 text-xs border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors">Start</button>
                    <button onClick={() => { api.agents.stop(a.id).then(refresh); }} className="px-3 py-1.5 text-xs border border-gray-700 rounded-lg hover:border-gray-500 transition-colors">Stop</button>
                    <button onClick={() => setPendingRemove({ id: a.id, name: a.name })} className="px-3 py-1.5 text-xs text-red-400 border border-transparent hover:border-red-500/30 rounded-lg transition-colors">Remove</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Agent Efficiency Ranking */}
        {ops && ops.agentEfficiency.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Agent Efficiency Ranking</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500 text-xs border-b border-gray-800">
                    <th className="text-left py-2 pr-4 font-medium">#</th>
                    <th className="text-left py-2 pr-4 font-medium">Agent</th>
                    <th className="text-left py-2 pr-4 font-medium">Health</th>
                    <th className="text-right py-2 pr-4 font-medium">Tasks Done</th>
                    <th className="text-right py-2 pr-4 font-medium">Error Rate</th>
                    <th className="text-right py-2 font-medium">Token Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {ops.agentEfficiency.map((ae, i) => (
                    <tr key={ae.agentId} className="border-b border-gray-800/50 last:border-0">
                      <td className="py-2.5 pr-4 text-gray-500">{i + 1}</td>
                      <td className="py-2.5 pr-4">
                        <div className="text-gray-200">{ae.agentName}</div>
                        <div className="text-[10px] text-gray-600">{ae.role} · {ae.agentRole}</div>
                      </td>
                      <td className="py-2.5 pr-4">
                        <HealthBadge score={ae.healthScore} />
                      </td>
                      <td className="py-2.5 pr-4 text-right text-gray-300">{ae.taskMetrics.completed}</td>
                      <td className="py-2.5 pr-4 text-right">
                        <span className={ae.errorRate > 0.2 ? 'text-red-400' : ae.errorRate > 0 ? 'text-amber-400' : 'text-green-400'}>
                          {(ae.errorRate * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td className="py-2.5 text-right text-gray-300">${ae.tokenUsage.cost.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Recent Activity */}
        {ops && ops.taskKPI.recentActivity.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Recent Activity</h3>
            <div className="space-y-2">
              {ops.taskKPI.recentActivity.slice(0, 8).map((act) => (
                <div key={act.taskId} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-gray-800/50 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[act.status] ?? 'bg-gray-500'}`} />
                    <span className="text-sm text-gray-300 truncate">{act.title}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <span className={`text-xs px-2 py-0.5 rounded capitalize ${
                      act.status === 'completed' ? 'bg-green-500/10 text-green-400' :
                      act.status === 'failed' ? 'bg-red-500/10 text-red-400' :
                      'bg-gray-500/10 text-gray-400'
                    }`}>{act.status}</span>
                    <span className="text-xs text-gray-600">{new Date(act.updatedAt).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {pendingRemove && (
        <ConfirmModal
          title={`Remove "${pendingRemove.name}"?`}
          message="This agent will be permanently removed from the organization."
          confirmLabel="Remove Agent"
          onConfirm={() => { api.agents.remove(pendingRemove.id).then(refresh); setPendingRemove(null); }}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-500',
  pending: 'bg-amber-500',
  assigned: 'bg-blue-500',
  'in-progress': 'bg-indigo-500',
  failed: 'bg-red-500',
  blocked: 'bg-orange-500',
  cancelled: 'bg-gray-500',
};

function MetricCard({ label, value, suffix, subtitle, color, raw }: {
  label: string;
  value: number | string;
  suffix?: string;
  subtitle?: string;
  color: string;
  raw?: boolean;
}) {
  const colorMap: Record<string, string> = {
    green: 'text-green-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
    indigo: 'text-indigo-400',
    blue: 'text-blue-400',
    purple: 'text-purple-400',
    cyan: 'text-cyan-400',
  };
  return (
    <div>
      <div className={`text-2xl font-bold ${colorMap[color] ?? 'text-white'}`}>
        {raw ? value : <>{value}{suffix}</>}
      </div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
      {subtitle && <div className="text-[10px] text-gray-600">{subtitle}</div>}
    </div>
  );
}

function HealthBadge({ score }: { score: number }) {
  const color = score >= 80 ? 'bg-green-500/15 text-green-400 border-green-500/20'
    : score >= 50 ? 'bg-amber-500/15 text-amber-400 border-amber-500/20'
    : 'bg-red-500/15 text-red-400 border-red-500/20';
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${color}`}>
      {score}%
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: 'bg-green-500/15 text-green-400',
    working: 'bg-indigo-500/15 text-indigo-400',
    offline: 'bg-gray-500/15 text-gray-400',
    error: 'bg-red-500/15 text-red-400',
  };
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? colors['offline']}`}>
      {status}
    </span>
  );
}
