import { useEffect, useState, useMemo } from 'react';
import { api, type AgentInfo, type TaskInfo, type OpsDashboard, type TeamInfo, type RequirementInfo } from '../api.ts';
import { navBus } from '../navBus.ts';

export function Dashboard() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [board, setBoard] = useState<Record<string, TaskInfo[]>>({});
  const [ops, setOps] = useState<OpsDashboard | null>(null);
  const [opsPeriod, setOpsPeriod] = useState<'1h' | '24h' | '7d'>('24h');
  const [pendingReqs, setPendingReqs] = useState<RequirementInfo[]>([]);

  const refresh = () => {
    api.agents.list().then(d => setAgents(d.agents)).catch(() => {});
    api.teams.list().then(d => setTeams(d.teams)).catch(() => {});
    api.tasks.board().then(d => setBoard(d.board)).catch(() => {});
    api.ops.dashboard(opsPeriod).then(setOps).catch(() => {});
    api.requirements.list({ source: 'agent' }).then(d => {
      setPendingReqs(d.requirements.filter(r => r.status === 'draft' || r.status === 'pending_review'));
    }).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 30000);
    return () => clearInterval(i);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opsPeriod]);

  const rootOnly = (tasks: TaskInfo[]) => tasks.filter(t => !t.parentTaskId);
  const rootStatusCounts: Record<string, number> = {};
  for (const [status, tasks] of Object.entries(board)) {
    const count = rootOnly(tasks).length;
    if (count > 0) rootStatusCounts[status] = count;
  }
  const pending = (rootStatusCounts['pending'] ?? 0) + (rootStatusCounts['assigned'] ?? 0);
  const inProgress = rootStatusCounts['in_progress'] ?? 0;
  const completed = rootStatusCounts['completed'] ?? 0;
  const failed = rootStatusCounts['failed'] ?? 0;
  const totalRootTasks = Object.values(rootStatusCounts).reduce((s, c) => s + c, 0);

  const activeAgents = agents.filter(a => a.status === 'idle' || a.status === 'working').length;
  const workingAgents = agents.filter(a => a.status === 'working').length;

  const teamSummaries = useMemo(() => {
    const agentMap = new Map(agents.map(a => [a.id, a]));
    return teams.map(t => {
      const memberAgents = t.members
        .filter(m => m.type === 'agent')
        .map(m => agentMap.get(m.id))
        .filter((a): a is AgentInfo => !!a);
      const working = memberAgents.filter(a => a.status === 'working').length;
      const active = memberAgents.filter(a => a.status === 'idle' || a.status === 'working').length;
      return { team: t, agents: memberAgents, working, active, total: memberAgents.length };
    });
  }, [teams, agents]);

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-6 h-14 border-b border-border-default bg-surface-secondary">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Overview</h2>
          <div className="flex gap-1 bg-surface-elevated rounded-lg p-0.5">
            {(['1h', '24h', '7d'] as const).map(p => (
              <button key={p} onClick={() => setOpsPeriod(p)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${opsPeriod === p ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
              >{p}</button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => navBus.navigate('agents')} className="px-4 py-2 bg-brand-600 hover:bg-brand-500 text-white text-sm rounded-lg transition-colors">+ Hire Agent</button>
        </div>
      </div>

      <div className="p-7 space-y-6">
        {/* Hero Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricTile label="Active Agents" value={activeAgents} total={agents.length} color="indigo" onClick={() => navBus.navigate('team')} />
          <MetricTile label="Tasks In Progress" value={inProgress} color="blue" onClick={() => navBus.navigate('tasks')} />
          <MetricTile label="Pending Queue" value={pending} color="amber" onClick={() => navBus.navigate('tasks')} />
          <MetricTile label="Completed" value={completed} total={totalRootTasks > 0 ? totalRootTasks : undefined} color="green" onClick={() => navBus.navigate('tasks')} />
        </div>

        {/* Getting Started — shown when no tasks exist yet */}
        {totalRootTasks === 0 && (!ops || ops.taskKPI.recentActivity.length === 0) && (
          <div className="bg-surface-secondary border border-brand-500/20 rounded-xl p-6">
            <h3 className="text-sm font-semibold text-white mb-1">Getting Started</h3>
            <p className="text-xs text-gray-400 mb-4">Your AI team is ready. Here are a few things to try first:</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { label: 'Chat with Secretary', desc: 'Your default team manager can help coordinate work', page: 'team' as const },
                { label: 'Browse Agent Templates', desc: 'Hire specialized agents from the template library', page: 'agents' as const },
                { label: 'Create a Project', desc: 'Set up a project with tasks and iterations', page: 'projects' as const },
              ].map(item => (
                <button key={item.label} onClick={() => navBus.navigate(item.page)} className="text-left bg-surface-elevated/50 hover:bg-surface-elevated border border-border-default/50 hover:border-brand-500/30 rounded-lg p-4 transition-colors">
                  <div className="text-xs font-medium text-white">{item.label}</div>
                  <div className="text-[11px] text-gray-500 mt-1">{item.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Charts */}
          <div className="lg:col-span-2 space-y-6">
            {/* Task Distribution Bar Chart */}
            {totalRootTasks > 0 && (
              <div className="bg-surface-secondary border border-border-default rounded-xl p-5 cursor-pointer hover:border-gray-600 transition-colors" onClick={() => navBus.navigate('tasks')}>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Task Distribution</h3>
                <TaskBar statusCounts={rootStatusCounts} total={totalRootTasks} />
                {(rootStatusCounts['blocked'] ?? 0) > 0 && (
                  <div className="mt-3 text-xs text-amber-400 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-amber-400 rounded-full" />
                    {rootStatusCounts['blocked']} blocked — needs attention
                  </div>
                )}
              </div>
            )}

            {/* Team Status — grouped by team */}
            <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Team Status</h3>
                <button onClick={() => navBus.navigate('team')} className="text-[10px] text-gray-600 hover:text-gray-400">View all →</button>
              </div>
              {teamSummaries.length === 0 && agents.length === 0 ? (
                <div className="text-sm text-gray-600 py-4 text-center cursor-pointer" onClick={() => navBus.navigate('team')}>No teams yet. Create a team or hire agents to get started.</div>
              ) : (
                <div className="space-y-4">
                  {teamSummaries.map(ts => (
                    <div key={ts.team.id} className="bg-surface-elevated/30 border border-border-default/30 rounded-lg p-4 hover:border-brand-500/20 transition-colors cursor-pointer" onClick={() => navBus.navigate('team')}>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-brand-600/30 flex items-center justify-center text-xs font-bold text-brand-400">{ts.team.name.charAt(0)}</div>
                          <div>
                            <div className="text-sm font-medium">{ts.team.name}</div>
                            {ts.team.description && <div className="text-[10px] text-gray-500 truncate max-w-[200px]">{ts.team.description}</div>}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-[10px] text-gray-500">
                          <span>{ts.total} members</span>
                          {ts.working > 0 && <span className="text-brand-400">{ts.working} working</span>}
                          <span className={ts.active === ts.total ? 'text-green-400' : ''}>{ts.active} active</span>
                        </div>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        {ts.agents.slice(0, 6).map(a => (
                          <div key={a.id} className="flex items-center gap-1.5 px-2 py-1 rounded bg-surface-overlay/30" onClick={e => { e.stopPropagation(); navBus.navigate('team', { selectAgent: a.id }); }}>
                            <span className={`w-1.5 h-1.5 rounded-full ${a.status === 'idle' ? 'bg-green-400' : a.status === 'working' ? 'bg-brand-400 animate-pulse' : 'bg-gray-600'}`} />
                            <span className="text-[11px] text-gray-300">{a.name}</span>
                          </div>
                        ))}
                        {ts.agents.length > 6 && <span className="text-[10px] text-gray-500 self-center">+{ts.agents.length - 6} more</span>}
                      </div>
                    </div>
                  ))}
                  {/* Ungrouped agents */}
                  {(() => {
                    const teamAgentIds = new Set(teams.flatMap(t => t.members.filter(m => m.type === 'agent').map(m => m.id)));
                    const ungrouped = agents.filter(a => !teamAgentIds.has(a.id));
                    if (ungrouped.length === 0) return null;
                    return (
                      <div className="bg-surface-elevated/20 border border-border-default/20 rounded-lg p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div className="text-xs text-gray-500 font-medium">Unassigned Agents</div>
                          <span className="text-[10px] text-gray-600">{ungrouped.length} agents</span>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {ungrouped.slice(0, 6).map(a => (
                            <div key={a.id} className="flex items-center gap-1.5 px-2 py-1 rounded bg-surface-overlay/30 cursor-pointer" onClick={() => navBus.navigate('team', { selectAgent: a.id })}>
                              <span className={`w-1.5 h-1.5 rounded-full ${a.status === 'idle' ? 'bg-green-400' : a.status === 'working' ? 'bg-brand-400 animate-pulse' : 'bg-gray-600'}`} />
                              <span className="text-[11px] text-gray-300">{a.name}</span>
                            </div>
                          ))}
                          {ungrouped.length > 6 && <span className="text-[10px] text-gray-500 self-center">+{ungrouped.length - 6} more</span>}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>

            {/* System Health */}
            {ops && (
              <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">System Health</h3>
                <div className="grid grid-cols-3 md:grid-cols-5 gap-4">
                  <HealthGauge label="Health Score" value={ops.systemHealth.overallScore} max={100} unit="%" color={ops.systemHealth.overallScore >= 80 ? 'green' : ops.systemHealth.overallScore >= 50 ? 'amber' : 'red'} />
                  <HealthGauge label="Success Rate" value={ops.taskKPI.successRate} max={100} unit="%" color={ops.taskKPI.successRate >= 80 ? 'green' : 'amber'} />
                  <HealthGauge label="Active / Total" value={activeAgents} max={agents.length || 1} unit={`/${agents.length}`} color="indigo" />
                  <HealthGauge label="Token Cost" value={parseFloat(ops.systemHealth.totalTokenCost.toFixed(4))} max={Math.max(1, Math.ceil(ops.systemHealth.totalTokenCost * 2))} unit="$" color="purple" raw />
                  <HealthGauge label="Working Now" value={workingAgents} max={agents.length || 1} unit={`/${agents.length}`} color="blue" />
                </div>

                {ops.systemHealth.criticalAgents.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-border-default">
                    <div className="flex items-center gap-2 text-xs text-red-400 flex-wrap">
                      <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                      Needs attention:
                      {ops.systemHealth.criticalAgents.map(a => (
                        <span key={a.id} className="px-2 py-0.5 bg-red-500/10 rounded text-red-400 cursor-pointer hover:bg-red-500/20" onClick={() => navBus.navigate('team', { selectAgent: a.id })}>{a.name} ({a.score}%)</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: Activity Feed */}
          <div className="space-y-6">
            {/* Pending Requirement Reviews */}
            {pendingReqs.length > 0 && (
              <div className="bg-surface-secondary border border-yellow-500/30 rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
                    <h3 className="text-xs font-semibold text-yellow-400 uppercase tracking-wider">Pending Reviews</h3>
                  </div>
                  <button onClick={() => navBus.navigate('projects')} className="text-[10px] text-gray-600 hover:text-gray-400">Review →</button>
                </div>
                <div className="space-y-2">
                  {pendingReqs.slice(0, 5).map(req => (
                    <div key={req.id} className="flex items-start gap-2.5 py-2 px-2.5 rounded-lg bg-surface-elevated/40 hover:bg-surface-elevated/60 transition-colors cursor-pointer" onClick={() => navBus.navigate('projects')}>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-gray-200 font-medium truncate">{req.title}</div>
                        <div className="text-[10px] text-gray-500 mt-0.5">
                          proposed by {req.createdBy} · {req.priority}
                        </div>
                      </div>
                      <span className="text-[10px] bg-yellow-500/15 text-yellow-400 px-1.5 py-0.5 rounded-full shrink-0">
                        {req.source === 'agent' ? 'Agent' : 'User'}
                      </span>
                    </div>
                  ))}
                  {pendingReqs.length > 5 && (
                    <div className="text-[10px] text-gray-500 text-center pt-1">+{pendingReqs.length - 5} more</div>
                  )}
                </div>
                <p className="text-[10px] text-gray-600 mt-3">
                  Agents proposed {pendingReqs.length} requirement{pendingReqs.length > 1 ? 's' : ''} — review to authorize work.
                </p>
              </div>
            )}

            {/* Recent Activity */}
            {ops && ops.taskKPI.recentActivity.length > 0 && (
              <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Recent Activity</h3>
                  <button onClick={() => navBus.navigate('tasks')} className="text-[10px] text-gray-600 hover:text-gray-400">View all →</button>
                </div>
                <div className="space-y-1.5">
                  {ops.taskKPI.recentActivity.slice(0, 8).map(act => (
                    <div key={act.taskId} className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-surface-elevated/40 transition-colors cursor-pointer" onClick={() => navBus.navigate('tasks', { openTask: act.taskId })}>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[act.status] ?? 'bg-gray-500'}`} />
                      <span className="text-xs text-gray-400 truncate flex-1">{act.title}</span>
                      <span className="text-[10px] text-gray-600 shrink-0">{new Date(act.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Task Distribution Bar ───────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-500', pending: 'bg-gray-500', assigned: 'bg-blue-500',
  in_progress: 'bg-brand-500', failed: 'bg-red-500', blocked: 'bg-amber-500', cancelled: 'bg-gray-600',
};

const STATUS_TEXT: Record<string, string> = {
  completed: 'text-green-400', pending: 'text-gray-400', assigned: 'text-blue-400',
  in_progress: 'text-brand-400', failed: 'text-red-400', blocked: 'text-amber-400', cancelled: 'text-gray-500',
};

function TaskBar({ statusCounts, total }: { statusCounts: Record<string, number>; total: number }) {
  const entries = Object.entries(statusCounts).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a);
  return (
    <div>
      {/* Stacked bar */}
      <div className="flex h-4 rounded-full overflow-hidden gap-0.5 mb-4">
        {entries.map(([status, count]) => (
          <div key={status} className={`${STATUS_COLORS[status] ?? 'bg-gray-600'} transition-all`} style={{ width: `${(count / total) * 100}%` }} title={`${status}: ${count}`} />
        ))}
      </div>
      {/* Legend */}
      <div className="flex gap-4 flex-wrap">
        {entries.map(([status, count]) => (
          <div key={status} className="flex items-center gap-1.5">
            <span className={`w-2.5 h-2.5 rounded-sm ${STATUS_COLORS[status] ?? 'bg-gray-600'}`} />
            <span className="text-xs text-gray-400 capitalize">{status.replace(/_/g, ' ')}</span>
            <span className={`text-xs font-semibold ${STATUS_TEXT[status] ?? 'text-gray-400'}`}>{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

function MetricTile({ label, value, total, color, onClick }: {
  label: string; value: number; total?: number; color: string; onClick: () => void;
}) {
  const colorMap: Record<string, { bg: string; text: string; border: string }> = {
    indigo: { bg: 'bg-brand-500/10', text: 'text-brand-400', border: 'border-brand-500/30' },
    blue: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
    amber: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
    green: { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/30' },
  };
  const c = colorMap[color] ?? colorMap['indigo']!;

  return (
    <div onClick={onClick} className={`${c.bg} ${c.border} border rounded-xl p-5 cursor-pointer hover:scale-[1.02] transition-all`}>
      <div className="text-xs text-gray-500 mb-2">{label}</div>
      <div className={`text-3xl font-bold ${c.text}`}>
        {value}
        {total !== undefined && <span className="text-base font-normal text-gray-600">/{total}</span>}
      </div>
    </div>
  );
}

function HealthGauge({ label, value, max, unit, color, raw }: {
  label: string; value: number; max: number; unit: string; color: string; raw?: boolean;
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const colorMap: Record<string, string> = { green: 'bg-green-400', amber: 'bg-amber-400', red: 'bg-red-400', indigo: 'bg-brand-400', purple: 'bg-purple-400', blue: 'bg-blue-400' };
  const textMap: Record<string, string> = { green: 'text-green-400', amber: 'text-amber-400', red: 'text-red-400', indigo: 'text-brand-400', purple: 'text-purple-400', blue: 'text-blue-400' };
  const bar = colorMap[color] ?? 'bg-gray-400';
  const txt = textMap[color] ?? 'text-gray-400';

  return (
    <div className="text-center">
      <div className={`text-xl font-bold ${txt}`}>
        {raw ? `${unit}${value}` : <>{value}<span className="text-xs font-normal text-gray-600">{unit}</span></>}
      </div>
      <div className="w-full h-1 bg-surface-elevated rounded-full overflow-hidden mt-2 mb-1">
        <div className={`h-full rounded-full ${bar} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[10px] text-gray-600">{label}</div>
    </div>
  );
}

