import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type AgentInfo, type TaskInfo, type OpsDashboard, type TeamInfo, type RequirementInfo, type StorageInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { NotificationBell } from '../components/NotificationBell.tsx';
import { useIsMobile } from '../hooks/useIsMobile.ts';

export function HomePage({ authUser }: { authUser?: { id: string; name: string; role: string; orgId: string } } = {}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [board, setBoard] = useState<Record<string, TaskInfo[]>>({});
  const [ops, setOps] = useState<OpsDashboard | null>(null);
  const opsPeriod = '7d' as const;
  const [pendingReqs, setPendingReqs] = useState<RequirementInfo[]>([]);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);

  const refresh = () => {
    api.agents.list().then(d => setAgents(d.agents)).catch(() => {});
    api.teams.list().then(d => setTeams(d.teams)).catch(() => {});
    api.tasks.board().then(d => setBoard(d.board)).catch(() => {});
    api.ops.dashboard(opsPeriod).then(setOps).catch(() => {});
    api.requirements.list({ source: 'agent' }).then(d => {
      setPendingReqs(d.requirements.filter(r => r.status === 'pending'));
    }).catch(() => {});
    api.system.storage().then(setStorageInfo).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 30000);
    const onDataChanged = () => refresh();
    window.addEventListener('markus:data-changed', onDataChanged);
    return () => { clearInterval(i); window.removeEventListener('markus:data-changed', onDataChanged); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opsPeriod]);

  const rootOnly = (tasks: TaskInfo[]) => tasks;
  const rootStatusCounts: Record<string, number> = {};
  for (const [status, tasks] of Object.entries(board)) {
    const count = rootOnly(tasks).length;
    if (count > 0) rootStatusCounts[status] = count;
  }
  const pending = rootStatusCounts['pending'] ?? 0;
  const inProgress = rootStatusCounts['in_progress'] ?? 0;
  const completed = rootStatusCounts['completed'] ?? 0;
  const failed = rootStatusCounts['failed'] ?? 0;
  const totalRootTasks = Object.values(rootStatusCounts).reduce((s, c) => s + c, 0);

  const activeAgents = agents.filter(a => a.status === 'idle' || a.status === 'working').length;
  const workingAgents = agents.filter(a => a.status === 'working').length;
  const totalMailboxDepth = agents.reduce((sum, a) => sum + (a.mailboxDepth ?? 0), 0);

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
          {isMobile && <NotificationBell collapsed userId={authUser?.id} />}
          <h2 className="text-lg font-semibold">{t('home.overview')}</h2>
        </div>
        <div className="flex gap-2">
          <button onClick={() => navBus.navigate(PAGE.STORE, { storeTab: 'agents' })} className="px-4 py-2 bg-brand-600 hover:bg-brand-500 text-white text-sm rounded-lg transition-colors">+ {t('home.hireAgent').replace('+ ', '')}</button>
        </div>
      </div>

      <div className="p-7 space-y-6">
        {/* Hero Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricTile label={t('home.metrics.activeAgents')} value={activeAgents} total={agents.length} color="indigo" onClick={() => navBus.navigate(PAGE.TEAM)} />
          <MetricTile label={t('home.metrics.tasksInProgress')} value={inProgress} color="blue" onClick={() => navBus.navigate(PAGE.WORK)} />
          <MetricTile label={t('home.metrics.pendingQueue')} value={pending} color="amber" onClick={() => navBus.navigate(PAGE.WORK)} />
          <MetricTile label={t('home.metrics.completed')} value={completed} total={totalRootTasks > 0 ? totalRootTasks : undefined} color="green" onClick={() => navBus.navigate(PAGE.WORK)} />
        </div>

        {/* Getting Started — shown when no tasks exist yet */}
        {totalRootTasks === 0 && (!ops || ops.taskKPI.recentActivity.length === 0) && (
          <div className="bg-surface-secondary border border-brand-500/20 rounded-xl p-6">
            <h3 className="text-sm font-semibold text-fg-primary mb-1">{t('home.aiWorkforce.title')}</h3>
            <p className="text-xs text-fg-secondary mb-4">{t('home.aiWorkforce.desc')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { label: t('home.quickActions.describeGoal'), desc: t('home.quickActions.describeGoalDesc'), page: PAGE.TEAM },
                { label: t('home.quickActions.hireAgents'), desc: t('home.quickActions.hireAgentsDesc'), page: PAGE.STORE },
                { label: t('home.quickActions.createProject'), desc: t('home.quickActions.createProjectDesc'), page: PAGE.WORK },
              ].map(item => (
                <button key={item.label} onClick={() => navBus.navigate(item.page)} className="text-left bg-surface-elevated/50 hover:bg-surface-elevated border border-border-default/50 hover:border-brand-500/30 rounded-lg p-4 transition-colors">
                  <div className="text-xs font-medium text-fg-primary">{item.label}</div>
                  <div className="text-[11px] text-fg-tertiary mt-1">{item.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Agent Focus Summary — shows what each working agent is doing */}
        {workingAgents > 0 && (
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">{t('home.agentFocus.title')}</h3>
              {totalMailboxDepth > 0 && <span className="text-xs text-fg-tertiary">{t('home.agentFocus.totalQueued', { count: totalMailboxDepth })}</span>}
            </div>
            <div className="space-y-1.5">
              {agents.filter(a => a.status === 'working').map(a => (
                <div key={a.id}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-elevated/30 hover:bg-surface-elevated/60 cursor-pointer transition-colors"
                  onClick={() => navBus.navigate(PAGE.TEAM, { agentId: a.id, profileTab: 'mind' })}
                >
                  <div className="w-5 h-5 rounded-full bg-brand-600/30 flex items-center justify-center text-[9px] font-bold text-brand-400 shrink-0">
                    {a.name.charAt(0)}
                  </div>
                  <span className="text-xs font-medium text-fg-primary truncate">{a.name}</span>
                  <span className="text-[10px] text-fg-tertiary truncate flex-1">
                    {a.currentActivity?.label ?? t('home.agentFocus.working')}
                  </span>
                  {(a.mailboxDepth ?? 0) > 0 && (
                    <span className="text-[9px] bg-amber-500/20 text-amber-400 rounded-full px-1.5 shrink-0">{a.mailboxDepth} queued</span>
                  )}
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    a.attentionState === 'focused' ? 'bg-brand-400 animate-pulse'
                    : a.attentionState === 'deciding' ? 'bg-amber-400 animate-pulse'
                    : 'bg-green-400'
                  }`} />
                </div>
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
              <div className="bg-surface-secondary border border-border-default rounded-xl p-5 cursor-pointer hover:border-gray-600 transition-colors" onClick={() => navBus.navigate(PAGE.WORK)}>
                <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider mb-4">{t('home.taskDistribution.title')}</h3>
                <TaskBar statusCounts={rootStatusCounts} total={totalRootTasks} />
                {(rootStatusCounts['blocked'] ?? 0) > 0 && (
                  <div className="mt-3 text-xs text-amber-600 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-amber-400 rounded-full" />
                    {rootStatusCounts['blocked']} {t('home.taskDistribution.blocked')}
                  </div>
                )}
              </div>
            )}

            {/* Team Status — grouped by team */}
            <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">{t('home.teamStatus.title')}</h3>
                <button onClick={() => navBus.navigate(PAGE.TEAM)} className="text-[11px] text-fg-tertiary hover:text-fg-secondary">{t('home.teamStatus.viewAll')}</button>
              </div>
              {teamSummaries.length === 0 && agents.length === 0 ? (
                <div className="text-sm text-fg-tertiary py-4 text-center cursor-pointer" onClick={() => navBus.navigate(PAGE.TEAM)}>{t('home.teamStatus.noTeams')}</div>
              ) : (
                <div className="space-y-4">
                  {teamSummaries.map(ts => (
                    <div key={ts.team.id} className="bg-surface-elevated/30 border border-border-default/30 rounded-lg p-4 hover:border-brand-500/20 transition-colors cursor-pointer" onClick={() => navBus.navigate(PAGE.TEAM)}>
                      <div className="flex items-center gap-2 mb-3 flex-wrap">
                        <div className="w-7 h-7 rounded-lg bg-brand-600/30 flex items-center justify-center text-xs font-bold text-brand-500 shrink-0">{ts.team.name.charAt(0)}</div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{ts.team.name}</div>
                          {ts.team.description && <div className="text-[11px] text-fg-tertiary truncate max-w-[260px]">{ts.team.description}</div>}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-fg-tertiary ml-auto shrink-0">
                          <span className="px-1.5 py-0.5 rounded bg-surface-overlay/50">{ts.total} {t('home.teamStatus.members')}</span>
                          {ts.working > 0 && <span className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-500">{ts.working} {t('home.teamStatus.working')}</span>}
                          <span className={`px-1.5 py-0.5 rounded ${ts.active === ts.total ? 'bg-green-500/15 text-green-600' : 'bg-surface-overlay/50'}`}>{ts.active} {t('home.teamStatus.active')}</span>
                        </div>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        {ts.agents.slice(0, 6).map(a => (
                          <div key={a.id} className="flex items-center gap-1.5 px-2 py-1 rounded bg-surface-overlay/30" onClick={e => { e.stopPropagation(); navBus.navigate(PAGE.TEAM, { selectAgent: a.id }); }}>
                            <span className={`w-1.5 h-1.5 rounded-full ${a.status === 'idle' ? 'bg-green-400' : a.status === 'working' ? 'bg-blue-400 animate-pulse' : 'bg-gray-600'}`} />
                            <span className="text-[11px] text-fg-secondary">{a.name}</span>
                          </div>
                        ))}
                        {ts.agents.length > 6 && <span className="text-[10px] text-fg-tertiary self-center">{t('home.unassignedAgents.more', { count: ts.agents.length - 6 })}</span>}
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
                          <div className="text-xs text-fg-tertiary font-medium">{t('home.unassignedAgents.title')}</div>
                          <span className="text-[10px] text-fg-tertiary">{t('home.unassignedAgents.count', { count: ungrouped.length })}</span>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {ungrouped.slice(0, 6).map(a => (
                            <div key={a.id} className="flex items-center gap-1.5 px-2 py-1 rounded bg-surface-overlay/30 cursor-pointer" onClick={() => navBus.navigate(PAGE.TEAM, { selectAgent: a.id })}>
                              <span className={`w-1.5 h-1.5 rounded-full ${a.status === 'idle' ? 'bg-green-400' : a.status === 'working' ? 'bg-blue-400 animate-pulse' : 'bg-gray-600'}`} />
                              <span className="text-[11px] text-fg-secondary">{a.name}</span>
                            </div>
                          ))}
                          {ungrouped.length > 6 && <span className="text-[10px] text-fg-tertiary self-center">{t('home.unassignedAgents.more', { count: ungrouped.length - 6 })}</span>}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>

          </div>

          {/* Right: Activity Feed */}
          <div className="space-y-6">
            {/* Pending Requirement Reviews */}
            {pendingReqs.length > 0 && (
              <div className="bg-surface-secondary border border-amber-500/30 rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
                    <h3 className="text-xs font-semibold text-amber-600 uppercase tracking-wider">{t('home.pendingReviews.title')}</h3>
                  </div>
                  <button onClick={() => navBus.navigate(PAGE.WORK)} className="text-[11px] text-fg-tertiary hover:text-fg-secondary">Review →</button>
                </div>
                <div className="space-y-2">
                  {pendingReqs.slice(0, 5).map(req => (
                    <div key={req.id} className="flex items-start gap-2.5 py-2 px-2.5 rounded-lg bg-surface-elevated/40 hover:bg-surface-elevated/60 transition-colors cursor-pointer" onClick={() => navBus.navigate(PAGE.WORK)}>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-fg-primary font-medium truncate">{req.title}</div>
                        <div className="text-[10px] text-fg-tertiary mt-0.5">
                          proposed by {req.createdBy} · {req.priority}
                        </div>
                      </div>
                      <span className="text-[10px] bg-amber-500/15 text-amber-600 px-1.5 py-0.5 rounded-full shrink-0">
                        {req.source === 'agent' ? 'Agent' : 'User'}
                      </span>
                    </div>
                  ))}
                  {pendingReqs.length > 5 && (
                    <div className="text-[10px] text-fg-tertiary text-center pt-1">{t('home.pendingReviews.more', { count: pendingReqs.length - 5 })}</div>
                  )}
                </div>
                <p className="text-[10px] text-fg-tertiary mt-3">
                  Agents proposed {pendingReqs.length} requirement{pendingReqs.length > 1 ? 's' : ''} — review to authorize work.
                </p>
              </div>
            )}

            {/* Recent Activity */}
            {ops && ops.taskKPI.recentActivity.length > 0 && (
              <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">{t('home.recentActivity.title')}</h3>
                  <button onClick={() => navBus.navigate(PAGE.WORK)} className="text-[11px] text-fg-tertiary hover:text-fg-secondary">View all →</button>
                </div>
                <div className="space-y-1.5">
                  {ops.taskKPI.recentActivity.slice(0, 8).map(act => (
                    <div key={act.taskId} className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-surface-elevated/40 transition-colors cursor-pointer" onClick={() => navBus.navigate(PAGE.WORK, { openTask: act.taskId })}>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[act.status] ?? 'bg-gray-500'}`} />
                      <span className="text-xs text-fg-secondary truncate flex-1">{act.title}</span>
                      <span className="text-[10px] text-fg-tertiary shrink-0">{new Date(act.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* System Health */}
            {ops && (
              <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
                <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider mb-4">{t('home.systemHealth.title')}</h3>
                <div className="space-y-3">
                  <HealthGauge label="Health Score" value={ops.systemHealth.overallScore} max={100} unit="%" color={ops.systemHealth.overallScore >= 80 ? 'green' : ops.systemHealth.overallScore >= 50 ? 'amber' : 'red'} />
                  <HealthGauge label="Success Rate" value={ops.taskKPI.successRate} max={100} unit="%" color={ops.taskKPI.successRate >= 80 ? 'green' : 'amber'} />
                  <HealthGauge label="Active / Total" value={activeAgents} max={agents.length || 1} unit={`/${agents.length}`} color="brand" />
                  <HealthGauge label="Token Cost" value={parseFloat(ops.systemHealth.totalTokenCost.toFixed(2))} max={Math.max(1, Math.ceil(ops.systemHealth.totalTokenCost * 2))} unit="$" color="brand" raw />
                  <HealthGauge label="Working Now" value={workingAgents} max={agents.length || 1} unit={`/${agents.length}`} color="blue" />
                </div>

                {ops.systemHealth.criticalAgents.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-border-default">
                    <div className="flex items-center gap-2 text-xs text-red-500 flex-wrap">
                      <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                      Needs attention:
                      {ops.systemHealth.criticalAgents.map(a => (
                        <span key={a.id} className="px-2 py-0.5 bg-red-500/10 rounded text-red-500 cursor-pointer hover:bg-red-500/20" onClick={() => navBus.navigate(PAGE.TEAM, { selectAgent: a.id })}>{a.name} ({a.score}%)</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Storage Summary */}
            {storageInfo && (
              <div className="bg-surface-secondary border border-border-default rounded-xl p-5 cursor-pointer hover:border-brand-500/30 transition-colors"
                onClick={() => navBus.navigate(PAGE.SETTINGS)}>
                <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider mb-3">{t('home.storage.title')}</h3>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-fg-primary">{fmtBytes(storageInfo.totalSize)}</span>
                  <span className="text-xs text-fg-tertiary">total</span>
                </div>
                <div className="mt-2 flex gap-4 text-xs text-fg-tertiary">
                  <span>DB: {fmtBytes(storageInfo.database.size)}</span>
                  <span>Agents: {storageInfo.agents.length}</span>
                </div>
                <div className="mt-2 text-[10px] text-fg-tertiary">Click to view details in Settings</div>
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
  pending: 'bg-amber-500', in_progress: 'bg-brand-500', blocked: 'bg-red-500',
  review: 'bg-blue-500', completed: 'bg-green-500', failed: 'bg-red-500', rejected: 'bg-red-500', cancelled: 'bg-gray-600',
};

const STATUS_TEXT: Record<string, string> = {
  pending: 'text-amber-600', in_progress: 'text-brand-500', blocked: 'text-red-500',
  review: 'text-blue-600', completed: 'text-green-600', failed: 'text-red-500', rejected: 'text-red-500', cancelled: 'text-fg-tertiary',
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
            <span className="text-xs text-fg-secondary capitalize">{status.replace(/_/g, ' ')}</span>
            <span className={`text-xs font-semibold ${STATUS_TEXT[status] ?? 'text-fg-secondary'}`}>{count}</span>
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
  const accentMap: Record<string, { text: string; border: string; glow: string }> = {
    indigo: { text: 'text-brand-400', border: 'border-l-brand-500', glow: 'hover:shadow-brand-500/10' },
    blue: { text: 'text-blue-400', border: 'border-l-blue-500', glow: 'hover:shadow-blue-500/10' },
    amber: { text: 'text-amber-400', border: 'border-l-amber-500', glow: 'hover:shadow-amber-500/10' },
    green: { text: 'text-green-400', border: 'border-l-green-500', glow: 'hover:shadow-green-500/10' },
  };
  const c = accentMap[color] ?? accentMap['indigo']!;

  return (
    <div onClick={onClick} className={`bg-surface-secondary border border-border-default ${c.border} border-l-2 rounded-xl p-5 cursor-pointer hover:bg-surface-elevated/80 hover:shadow-lg ${c.glow} transition-all duration-200`}>
      <div className="text-xs text-fg-tertiary mb-2">{label}</div>
      <div className={`text-3xl font-bold ${c.text}`}>
        {value}
        {total !== undefined && <span className="text-base font-normal text-fg-muted">/{total}</span>}
      </div>
    </div>
  );
}

function HealthGauge({ label, value, max, unit, color, raw }: {
  label: string; value: number; max: number; unit: string; color: string; raw?: boolean;
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const colorMap: Record<string, string> = { green: 'bg-green-400', amber: 'bg-amber-400', red: 'bg-red-400', brand: 'bg-brand-400', blue: 'bg-blue-400' };
  const textMap: Record<string, string> = { green: 'text-green-600', amber: 'text-amber-600', red: 'text-red-500', brand: 'text-brand-500', blue: 'text-blue-600' };
  const bar = colorMap[color] ?? 'bg-gray-400';
  const txt = textMap[color] ?? 'text-fg-secondary';

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[11px] text-fg-tertiary">{label}</span>
        <span className={`text-sm font-semibold ${txt}`}>
          {raw ? `${unit}${value}` : <>{value}<span className="text-[10px] font-normal text-fg-tertiary">{unit}</span></>}
        </span>
      </div>
      <div className="w-full h-1.5 bg-surface-elevated rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${bar} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

