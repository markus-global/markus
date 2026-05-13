import { useEffect, useState, useMemo } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { api, type AgentInfo, type TaskInfo, type OpsDashboard, type TeamInfo, type RequirementInfo, type StorageInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { Avatar } from '../components/Avatar.tsx';

const SHOW_HERO_BANNER = false;

const DONUT_COLORS: Record<string, string> = {
  completed: '#22c55e', in_progress: '#8b5cf6', review: '#3b82f6',
  pending: '#f59e0b', failed: '#ef4444', blocked: '#f59e0b',
  rejected: '#fb7185', cancelled: '#6b7280',
};

const STATUS_COLORS_BG: Record<string, string> = {
  completed: 'bg-green-500', in_progress: 'bg-brand-500', review: 'bg-blue-500',
  pending: 'bg-amber-500', failed: 'bg-red-500', blocked: 'bg-amber-500',
  rejected: 'bg-rose-400', cancelled: 'bg-gray-500',
};

const TASK_STATUS_I18N: Record<string, string> = {
  pending: 'common:status.pending', in_progress: 'common:status.inProgress',
  blocked: 'common:status.blocked', review: 'common:status.review',
  completed: 'common:status.completed', failed: 'common:status.failed',
  rejected: 'common:status.rejected', cancelled: 'common:status.cancelled',
};

const STATUS_ORDER = ['completed', 'in_progress', 'review', 'pending', 'failed', 'blocked', 'rejected', 'cancelled'];

export function HomePage({ authUser }: { authUser?: { id: string; name: string; role: string; orgId: string } } = {}) {
  const { t } = useTranslation(['home', 'common', 'team']);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [board, setBoard] = useState<Record<string, TaskInfo[]>>({});
  const [ops, setOps] = useState<OpsDashboard | null>(null);
  const opsPeriod = '7d' as const;
  const [pendingReqs, setPendingReqs] = useState<RequirementInfo[]>([]);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [showDeployChoice, setShowDeployChoice] = useState(false);
  const [showRankingModal, setShowRankingModal] = useState(false);

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

  const rootStatusCounts: Record<string, number> = {};
  for (const [status, tasks] of Object.entries(board)) {
    if (status === 'archived') continue;
    const count = tasks.length;
    if (count > 0) rootStatusCounts[status] = count;
  }
  const completed = rootStatusCounts['completed'] ?? 0;
  const totalRootTasks = Object.values(rootStatusCounts).reduce((s, c) => s + c, 0);

  const activeAgents = agents.filter(a => a.status === 'idle' || a.status === 'working').length;
  const workingAgents = agents.filter(a => a.status === 'working').length;
  const totalMailboxDepth = agents.reduce((sum, a) => sum + (a.mailboxDepth ?? 0), 0);

  const teamSummaries = useMemo(() => {
    const agentMap = new Map(agents.map(a => [a.id, a]));
    return teams.map(team => {
      const memberAgents = team.members
        .filter(m => m.type === 'agent')
        .map(m => agentMap.get(m.id))
        .filter((a): a is AgentInfo => !!a);
      const working = memberAgents.filter(a => a.status === 'working').length;
      const active = memberAgents.filter(a => a.status === 'idle' || a.status === 'working').length;
      return { team, agents: memberAgents, working, active, total: memberAgents.length };
    });
  }, [teams, agents]);

  const topPerformers = useMemo(() => {
    if (!ops) return [];
    return [...ops.agentEfficiency]
      .filter(a => a.taskMetrics.completed > 0)
      .sort((a, b) => b.taskMetrics.completed - a.taskMetrics.completed)
      .slice(0, 5);
  }, [ops]);

  const allRankedAgents = useMemo(() => {
    if (!ops) return [];
    const rankScore = (a: typeof ops.agentEfficiency[0]) => {
      const tasks = a.taskMetrics.completed + a.taskMetrics.failed;
      // Health score is modulated by activity: without actual work,
      // an agent only gets 30% credit for its health score.
      // Reaches full credit at 3+ completed/failed tasks.
      const activityWeight = 0.3 + 0.7 * Math.min(1, tasks / 3);
      return a.healthScore * activityWeight + a.taskMetrics.completed * 0.5;
    };
    return [...ops.agentEfficiency].sort((a, b) => rankScore(b) - rankScore(a));
  }, [ops]);

  const completionRate = totalRootTasks > 0 ? Math.round((completed / totalRootTasks) * 100) : 0;

  const sortedStatusEntries = STATUS_ORDER
    .filter(s => (rootStatusCounts[s] ?? 0) > 0)
    .map(s => ({ status: s, count: rootStatusCounts[s]! }));

  const totalTokens = ops ? ops.agentEfficiency.reduce((sum, a) => sum + a.tokenUsage.input + a.tokenUsage.output, 0) : 0;

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-6 lg:px-8 h-14 sm:h-16">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-base sm:text-lg font-bold">{t('title')}</h2>
            <p className="text-xs text-fg-tertiary hidden sm:block">{t('subtitle')}</p>
          </div>
        </div>
        <button
          onClick={() => setShowDeployChoice(true)}
          className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 bg-brand-600 hover:bg-brand-500 text-white text-xs sm:text-sm font-medium rounded-xl transition-all shadow-md shadow-brand-900/30 hover:shadow-lg hover:shadow-brand-900/40"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="hidden sm:block"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="22" y1="11" x2="16" y2="11" /></svg>
          {t('hireAgent')}
        </button>
      </div>

      <div className="p-4 sm:p-6 lg:p-8 space-y-5 sm:space-y-6">
        {/* Metric Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <MetricCard label={t('metrics.activeAgents')} value={activeAgents} total={agents.length} icon={<IconAgents />} color="brand" onClick={() => navBus.navigate(PAGE.TEAM)} />
          <MetricCard label={t('metrics.workingNow')} value={workingAgents} icon={<IconRunning />} color="blue" onClick={() => navBus.navigate(PAGE.TEAM)} />
          <MetricCard label={t('metrics.healthScore')} value={ops?.systemHealth.overallScore ?? 0} suffix="%" icon={<IconHealth />} color="green" onClick={() => setShowRankingModal(true)} />
          <MetricCard label={t('metrics.totalTasks')} value={totalRootTasks} icon={<IconTasks />} color="amber" onClick={() => navBus.navigate(PAGE.WORK)} />
        </div>

        {/* Getting Started */}
        {totalRootTasks === 0 && (!ops || ops.taskKPI.recentActivity.length === 0) && (
          <div className="bg-gradient-to-br from-brand-600/10 via-surface-secondary to-surface-secondary border border-brand-500/20 rounded-2xl p-5 sm:p-6">
            <h3 className="text-sm font-semibold text-fg-primary mb-1">{t('gettingStarted.title')}</h3>
            <p className="text-xs text-fg-secondary mb-4">{t('gettingStarted.subtitle')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { labelKey: 'gettingStarted.describeGoal', descKey: 'gettingStarted.describeGoalDesc', page: PAGE.TEAM },
                { labelKey: 'gettingStarted.hireAgents', descKey: 'gettingStarted.hireAgentsDesc', page: PAGE.STORE },
                { labelKey: 'gettingStarted.createProject', descKey: 'gettingStarted.createProjectDesc', page: PAGE.WORK },
              ].map(item => (
                <button key={item.labelKey} onClick={() => navBus.navigate(item.page)} className="text-left bg-surface-elevated/50 hover:bg-surface-elevated border border-border-default/50 hover:border-brand-500/30 rounded-xl p-4 transition-all hover:shadow-lg hover:shadow-brand-500/5">
                  <div className="text-xs font-medium text-fg-primary">{t(item.labelKey)}</div>
                  <div className="text-[11px] text-fg-tertiary mt-1">{t(item.descKey)}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Hidden Hero Banner */}
        {SHOW_HERO_BANNER && (
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-brand-700 via-brand-600 to-blue-600 p-8">
            <div className="absolute inset-0 opacity-10">
              <div className="absolute top-4 right-12 w-24 h-24 rounded-full bg-white/20" />
              <div className="absolute bottom-4 right-32 w-16 h-16 rounded-full bg-white/15" />
              <div className="absolute top-8 right-48 w-12 h-12 rounded-full bg-white/10" />
            </div>
            <div className="relative z-10 max-w-md">
              <h3 className="text-xl font-bold text-white mb-2">{t('heroBanner.title')}</h3>
              <p className="text-sm text-white/80 mb-5">{t('heroBanner.subtitle')}</p>
              <div className="flex gap-3">
                <button className="px-5 py-2.5 bg-white text-brand-700 text-sm font-semibold rounded-xl hover:bg-white/90 transition-colors shadow-lg">{t('heroBanner.watchDemo')}</button>
                <button className="px-5 py-2.5 bg-white/15 text-white text-sm font-medium rounded-xl hover:bg-white/25 transition-colors border border-white/20">{t('heroBanner.learnMore')}</button>
              </div>
            </div>
          </div>
        )}

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 sm:gap-6">
          {/* Left Column */}
          <div className="lg:col-span-2 space-y-5 sm:space-y-6">
            {/* Pending Requirement Reviews */}
            {pendingReqs.length > 0 && (
              <div className="bg-surface-secondary border border-amber-500/30 rounded-2xl p-4 sm:p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
                    <h3 className="text-xs font-semibold text-amber-600 uppercase tracking-wider">{t('pendingReviews.title')}</h3>
                  </div>
                  <button onClick={() => navBus.navigate(PAGE.WORK)} className="text-[11px] text-fg-tertiary hover:text-fg-secondary">{t('pendingReviews.review')}</button>
                </div>
                <div className="space-y-2">
                  {pendingReqs.slice(0, 5).map(req => {
                    const authorAgent = agents.find(a => a.id === req.createdBy);
                    const authorName = authorAgent?.name ?? req.createdBy;
                    return (
                    <div key={req.id} className="flex items-start gap-2.5 py-2 px-2.5 rounded-xl bg-surface-elevated/40 hover:bg-surface-elevated/60 transition-colors cursor-pointer" onClick={() => navBus.navigate(PAGE.WORK, { openRequirement: req.id })}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {(req.priority === 'urgent' || req.priority === 'high') && (
                            <span className={`text-[10px] font-medium shrink-0 ${req.priority === 'urgent' ? 'text-red-500' : 'text-amber-500'}`}>[{t(`common:priority.${req.priority}`)}]</span>
                          )}
                          <span className="text-xs text-fg-primary font-medium truncate">{req.title}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[10px] text-fg-tertiary">{t('pendingReviews.proposedBy2', { author: authorName })}</span>
                          <span className="text-[10px] text-fg-muted">·</span>
                          <span className="text-[10px] text-fg-tertiary">{formatRelativeTime(req.createdAt, t)}</span>
                        </div>
                      </div>
                      <span className="text-[10px] bg-amber-500/15 text-amber-600 px-1.5 py-0.5 rounded-full shrink-0">{req.source === 'agent' ? t('pendingReviews.agent') : t('pendingReviews.user')}</span>
                    </div>
                    );
                  })}
                  {pendingReqs.length > 5 && <div className="text-[10px] text-fg-tertiary text-center pt-1">{t('common:units.more', { count: pendingReqs.length - 5 })}</div>}
                </div>
                <p className="text-[10px] text-fg-tertiary mt-3">{t('pendingReviews.agentProposed', { count: pendingReqs.length })}</p>
              </div>
            )}

            {/* Task Overview — donut + all status legend */}
            {totalRootTasks > 0 && (
              <div className="bg-surface-elevated rounded-2xl p-4 sm:p-5 cursor-pointer hover:bg-surface-overlay transition-colors" onClick={() => navBus.navigate(PAGE.WORK)}>
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h3 className="text-sm font-semibold text-fg-primary">{t('taskOverview.title')}</h3>
                    <p className="text-[11px] text-fg-tertiary mt-0.5">{t('taskOverview.subtitle', { total: totalRootTasks })}</p>
                  </div>
                  <button onClick={e => { e.stopPropagation(); navBus.navigate(PAGE.WORK); }} className="text-[11px] text-brand-400 hover:text-brand-300 font-medium">{t('common:viewAll')}</button>
                </div>

                <div className="flex flex-col sm:flex-row items-center gap-6 sm:gap-10">
                  <DonutChart statusCounts={rootStatusCounts} total={totalRootTasks} completionRate={completionRate} completed={completed} />
                  <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 min-w-0 w-full sm:w-auto">
                    {sortedStatusEntries.map(({ status, count }) => (
                      <DonutLegendItem key={status} color={STATUS_COLORS_BG[status] ?? 'bg-gray-500'} label={t(TASK_STATUS_I18N[status] ?? status)} count={count} />
                    ))}
                  </div>
                </div>
                {ops && (ops.taskKPI.stuckBlockedCount ?? 0) > 0 && (
                  <div className="mt-3 flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400"
                    onClick={e => { e.stopPropagation(); navBus.navigate(PAGE.WORK, { filter: 'blocked' }); }}>
                    <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse shrink-0" />
                    {t('taskOverview.stuckBlocked', { count: ops.taskKPI.stuckBlockedCount })}
                  </div>
                )}
              </div>
            )}

            {/* Activity Feed */}
            {ops && ops.taskKPI.recentActivity.length > 0 && (
              <div className="bg-surface-elevated rounded-2xl p-4 sm:p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-fg-primary">{t('recentActivity.title')}</h3>
                  <button onClick={() => navBus.navigate(PAGE.WORK)} className="text-[11px] text-brand-400 hover:text-brand-300 font-medium">{t('common:viewAll')}</button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
                  {ops.taskKPI.recentActivity.slice(0, 10).map(act => (
                    <div key={act.taskId}
                      className="flex items-center gap-2.5 py-2 px-2 rounded-xl hover:bg-surface-elevated/40 transition-colors cursor-pointer"
                      onClick={() => navBus.navigate(PAGE.WORK, { openTask: act.taskId })}
                    >
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${ACTIVITY_ICON_BG[act.status] ?? 'bg-gray-500/15'}`}>
                        <ActivityIcon status={act.status} />
                      </div>
                      <span className="text-xs text-fg-secondary truncate flex-1">{act.title}</span>
                      <span className="text-[10px] text-fg-tertiary shrink-0">{formatRelativeTime(act.updatedAt, t)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Team Overview */}
            <div className="bg-surface-elevated rounded-2xl p-4 sm:p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-fg-primary">{t('teamOverview.title')}</h3>
                  <p className="text-[11px] text-fg-tertiary mt-0.5">{t('teamOverview.subtitle', { teams: teams.length, members: agents.length })}</p>
                </div>
                <button onClick={() => navBus.navigate(PAGE.TEAM)} className="text-[11px] text-brand-400 hover:text-brand-300 font-medium">{t('common:viewAll')}</button>
              </div>
              {teamSummaries.length === 0 && agents.length === 0 ? (
                <div className="text-sm text-fg-tertiary py-6 text-center cursor-pointer" onClick={() => navBus.navigate(PAGE.TEAM)}>{t('teamStatus.noTeams')}</div>
              ) : (
                <div className="space-y-1">
                  {teamSummaries.slice(0, 5).map(ts => (
                    <div key={ts.team.id}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-elevated/40 cursor-pointer transition-colors"
                      onClick={() => navBus.navigate(PAGE.TEAM, { selectTeam: ts.team.id })}
                    >
                      <div className="w-8 h-8 rounded-lg bg-brand-600/20 flex items-center justify-center text-xs font-bold text-brand-400 shrink-0">{ts.team.name.charAt(0)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-fg-primary truncate">{ts.team.name}</div>
                        {ts.team.description && <div className="text-[11px] text-fg-tertiary truncate">{ts.team.description}</div>}
                      </div>
                      <div className="flex items-center -space-x-1.5 shrink-0">
                        {ts.agents.slice(0, 3).map(a => (
                          <Avatar key={a.id} name={a.name} avatarUrl={(a as any).avatarUrl} size={22} bgClass="bg-surface-overlay text-fg-secondary ring-2 ring-surface-secondary" />
                        ))}
                        {ts.agents.length > 3 && (
                          <div className="w-[22px] h-[22px] rounded-full bg-surface-overlay text-fg-tertiary flex items-center justify-center text-[8px] font-bold ring-2 ring-surface-secondary">+{ts.agents.length - 3}</div>
                        )}
                      </div>
                      {ts.active > 0 && (
                        <span className="text-[10px] bg-green-500/15 text-green-500 px-2 py-0.5 rounded-full shrink-0">{t('teamOverview.activeCount', { count: ts.active })}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>

          {/* Right Column */}
          <div className="space-y-5 sm:space-y-6">
            {/* Agent Focus — compact, only when agents working */}
            {workingAgents > 0 && (
              <div className="bg-surface-elevated rounded-2xl p-4 sm:p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-brand-500 animate-pulse" />
                    <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">{t('agentFocus.title')}</h3>
                  </div>
                  {totalMailboxDepth > 0 && <span className="text-[10px] text-fg-tertiary">{t('agentFocus.totalQueued', { count: totalMailboxDepth })}</span>}
                </div>
                <div className="space-y-1.5">
                  {agents.filter(a => a.status === 'working').map(a => (
                    <div key={a.id}
                      className="flex items-center gap-2 px-2.5 py-2 rounded-xl bg-surface-elevated/30 hover:bg-surface-elevated/60 cursor-pointer transition-colors"
                      onClick={() => navBus.navigate(PAGE.TEAM, { agentId: a.id, profileTab: 'overview' })}
                    >
                      <Avatar name={a.name} avatarUrl={(a as any).avatarUrl} size={22} bgClass="bg-brand-600/40 text-brand-300" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-fg-primary truncate">{a.name}</div>
                        <div className="text-[10px] text-fg-tertiary truncate">{localizeActivityLabel(a.currentActivity?.label, t) ?? t('agentFocus.working')}</div>
                      </div>
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

            {/* Top Performing Agents */}
            {topPerformers.length > 0 && (
              <div className="bg-surface-elevated rounded-2xl p-4 sm:p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-fg-primary">{t('topPerformers.title')}</h3>
                  <button onClick={() => setShowRankingModal(true)} className="text-[11px] text-brand-400 hover:text-brand-300 font-medium">{t('common:viewAll')}</button>
                </div>
                <div className="space-y-2.5">
                  {topPerformers.map(agent => (
                    <div key={agent.agentId}
                      className="flex items-center gap-3 cursor-pointer hover:bg-surface-elevated/30 rounded-xl px-2 py-1.5 transition-colors"
                      onClick={() => navBus.navigate(PAGE.TEAM, { selectAgent: agent.agentId })}
                    >
                      <Avatar name={agent.agentName} size={28} bgClass="bg-brand-600/30 text-brand-300" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-fg-primary truncate">{agent.agentName}</div>
                        <div className="text-[10px] text-fg-tertiary">{t('topPerformers.tasksCompleted', { count: agent.taskMetrics.completed })}</div>
                      </div>
                      {agent.healthScore >= 80 && (
                        <span className="text-[10px] text-green-500 font-medium">~{agent.healthScore}%</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* System Health + Storage */}
            {ops && (
              <div className="bg-surface-elevated rounded-2xl p-4 sm:p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-fg-primary">{t('systemHealth.title')}</h3>
                  {ops.systemHealth.overallScore >= 80 && (
                    <span className="flex items-center gap-1 text-[11px] text-green-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                      {t('systemHealth.allOperational')}
                    </span>
                  )}
                </div>
                <div className="space-y-3">
                  <HealthRow label={t('systemHealth.successRate')} value={ops.taskKPI.successRate} max={100} suffix="%" />
                  <HealthRow label={t('systemHealth.activeTotal')} value={activeAgents} max={agents.length || 1} suffix={`/${agents.length}`} />
                  <HealthRow label={t('systemHealth.tokenUsage')} value={totalTokens} max={totalTokens || 1} displayValue={fmtNumber(totalTokens)} alwaysGreen />
                  <HealthRow label={t('systemHealth.workingNow')} value={workingAgents} max={agents.length || 1} suffix={`/${agents.length}`} neutral />
                </div>

                {ops.systemHealth.criticalAgents.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-border-default">
                    <div className="flex items-center gap-2 text-xs text-red-500 flex-wrap">
                      <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                      {t('systemHealth.needsAttention')}
                      {ops.systemHealth.criticalAgents.map(a => (
                        <span key={a.id} className="px-2 py-0.5 bg-red-500/10 rounded-lg text-red-500 cursor-pointer hover:bg-red-500/20 transition-colors" onClick={() => navBus.navigate(PAGE.TEAM, { selectAgent: a.id })}>{t('systemHealth.agentScoreChip', { name: a.name, score: a.score })}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Storage */}
                {storageInfo && (
                  <div className="mt-4 pt-3 border-t border-border-default cursor-pointer" onClick={() => navBus.navigate(PAGE.SETTINGS)}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-fg-secondary">{t('storage.title')}</span>
                      <span className="text-sm font-semibold text-fg-primary">{fmtBytes(storageInfo.totalSize, t)}</span>
                    </div>
                    <div className="mt-1.5 flex gap-3 text-[11px] text-fg-tertiary">
                      <span>{t('storage.db', { size: fmtBytes(storageInfo.database.size, t) })}</span>
                      <span>{t('storage.agents', { count: storageInfo.agents.length })}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Deploy Agent Method Choice Modal */}
      {showDeployChoice && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDeployChoice(false)}>
          <div className="bg-surface-elevated rounded-xl border border-border-default shadow-2xl w-[340px] max-w-[90vw] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-default">
              <h3 className="text-sm font-semibold">{t('hireAgent')}</h3>
              <p className="text-[11px] text-fg-tertiary mt-0.5">{t('team:chat.methodChoiceSubtitle')}</p>
            </div>
            <div className="p-3 space-y-2">
              <button
                onClick={() => {
                  setShowDeployChoice(false);
                  const secretary = agents.find(a => a.role === 'secretary') ?? agents.find(a => a.name?.toLowerCase().includes('secretary'));
                  if (secretary) {
                    navBus.navigate(PAGE.TEAM, {
                      agentId: secretary.id,
                      prefillMessage: t('team:chat.addAgentPrefill'),
                    });
                  } else {
                    navBus.navigate(PAGE.STORE);
                  }
                }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-brand-500/30 bg-brand-500/5 hover:bg-brand-500/10 transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-full bg-brand-500/15 flex items-center justify-center shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-brand-500" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" /><path d="M20 3v4" /><path d="M22 5h-4" /></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-brand-500">{t('team:chat.methodSecretary')}</div>
                  <div className="text-[10px] text-fg-tertiary mt-0.5">{t('team:chat.methodSecretaryDesc')}</div>
                </div>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-brand-500/10 text-brand-500 font-medium shrink-0">{t('team:chat.recommended')}</span>
              </button>
              <button
                onClick={() => {
                  setShowDeployChoice(false);
                  navBus.navigate(PAGE.STORE, { storeTab: 'agents' });
                }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-border-default hover:bg-surface-overlay transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-full bg-surface-overlay flex items-center justify-center shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-fg-secondary" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-fg-secondary">{t('team:chat.methodManual')}</div>
                  <div className="text-[10px] text-fg-tertiary mt-0.5">{t('team:chat.methodManualAgentDesc')}</div>
                </div>
              </button>
            </div>
            <div className="px-5 py-3 border-t border-border-default flex justify-end">
              <button onClick={() => setShowDeployChoice(false)} className="px-3 py-1.5 text-xs text-fg-secondary hover:text-fg-primary rounded-lg hover:bg-surface-overlay transition-colors">{t('common:cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Agent Ranking Modal */}
      {showRankingModal && ops && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowRankingModal(false)}>
          <div className="bg-surface-elevated rounded-xl border border-border-default shadow-2xl w-[480px] max-w-[90vw] max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-default flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-sm font-semibold">{t('ranking.title')}</h3>
                <p className="text-[11px] text-fg-tertiary mt-0.5">{t('ranking.subtitle', { count: allRankedAgents.length })}</p>
              </div>
              <button onClick={() => setShowRankingModal(false)} className="p-1.5 rounded-lg hover:bg-surface-overlay transition-colors text-fg-tertiary hover:text-fg-primary">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 scrollbar-thin">
              <div className="px-4 py-2 flex items-center gap-3 text-[10px] text-fg-tertiary uppercase tracking-wider font-medium border-b border-border-default/50">
                <span className="w-7 text-center">#</span>
                <span className="flex-1">{t('ranking.agent')}</span>
                <span className="w-16 text-center">{t('ranking.health')}</span>
                <span className="w-16 text-center">{t('ranking.tasks')}</span>
                <span className="w-16 text-center">{t('ranking.errorRate')}</span>
              </div>
              {allRankedAgents.map((agent, idx) => {
                const healthColor = agent.healthScore >= 80 ? 'text-green-500' : agent.healthScore >= 50 ? 'text-amber-500' : 'text-red-500';
                const errorPct = Math.round(agent.errorRate * 100);
                const medal = idx === 0 ? 'text-amber-400' : idx === 1 ? 'text-gray-400' : idx === 2 ? 'text-amber-600' : 'text-fg-tertiary';
                return (
                  <div
                    key={agent.agentId}
                    className="px-4 py-2.5 flex items-center gap-3 hover:bg-surface-overlay/50 cursor-pointer transition-colors border-b border-border-default/30 last:border-0"
                    onClick={() => { setShowRankingModal(false); navBus.navigate(PAGE.TEAM, { selectAgent: agent.agentId }); }}
                  >
                    <span className={`w-7 text-center text-xs font-bold ${medal}`}>{idx + 1}</span>
                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                      <Avatar name={agent.agentName} size={28} bgClass="bg-brand-600/30 text-brand-300" />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-fg-primary truncate">{agent.agentName}</div>
                        <div className="text-[10px] text-fg-tertiary truncate">{agent.role || agent.agentRole || '—'}</div>
                      </div>
                    </div>
                    <span className={`w-16 text-center text-xs font-semibold ${healthColor}`}>{agent.healthScore}%</span>
                    <span className="w-16 text-center text-xs text-fg-secondary">{agent.taskMetrics.completed}<span className="text-fg-tertiary">/{agent.taskMetrics.completed + agent.taskMetrics.failed}</span></span>
                    <span className={`w-16 text-center text-xs ${errorPct > 20 ? 'text-red-500' : errorPct > 5 ? 'text-amber-500' : 'text-green-500'}`}>{errorPct}%</span>
                  </div>
                );
              })}
              {allRankedAgents.length === 0 && (
                <div className="py-8 text-center text-xs text-fg-tertiary">{t('ranking.noData')}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Metric Card ─────────────────────────────────────────────────────────────

function MetricCard({ label, value, total, suffix, icon, color, onClick }: {
  label: string; value: number; total?: number; suffix?: string; icon: React.ReactNode; color: string; onClick: () => void;
}) {
  const styles: Record<string, { bg: string; iconBg: string; text: string; glow: string }> = {
    brand:  { bg: 'border-brand-500/20', iconBg: 'bg-brand-500/15', text: 'text-brand-400', glow: 'hover:shadow-brand-500/10' },
    blue:   { bg: 'border-blue-500/20', iconBg: 'bg-blue-500/15', text: 'text-blue-400', glow: 'hover:shadow-blue-500/10' },
    amber:  { bg: 'border-amber-500/20', iconBg: 'bg-amber-500/15', text: 'text-amber-400', glow: 'hover:shadow-amber-500/10' },
    green:  { bg: 'border-green-500/20', iconBg: 'bg-green-500/15', text: 'text-green-400', glow: 'hover:shadow-green-500/10' },
  };
  const s = styles[color] ?? styles.brand!;

  return (
    <div onClick={onClick} className={`bg-surface-secondary border ${s.bg} rounded-2xl p-4 sm:p-5 cursor-pointer hover:bg-surface-elevated/60 hover:shadow-lg ${s.glow} transition-all duration-200 card-shine`}>
      <div className="flex items-start justify-between mb-2 sm:mb-3">
        <div className="text-[11px] sm:text-xs text-fg-tertiary font-medium">{label}</div>
        <div className={`w-8 h-8 sm:w-9 sm:h-9 rounded-xl ${s.iconBg} ${s.text} flex items-center justify-center`}>{icon}</div>
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`text-2xl sm:text-3xl font-bold ${s.text}`}>{value}</span>
        {suffix && <span className="text-base sm:text-lg font-semibold text-fg-muted">{suffix}</span>}
        {total !== undefined && <span className="text-xs sm:text-sm font-normal text-fg-muted">/{total}</span>}
      </div>
    </div>
  );
}

// ─── Donut Chart ─────────────────────────────────────────────────────────────

function DonutChart({ statusCounts, total, completionRate, completed }: {
  statusCounts: Record<string, number>; total: number; completionRate: number; completed: number;
}) {
  const size = 140;
  const r = 38;
  const strokeW = 14;
  const c = 2 * Math.PI * r;

  const segments = STATUS_ORDER
    .filter(s => (statusCounts[s] ?? 0) > 0)
    .map(s => ({ value: statusCounts[s]!, color: DONUT_COLORS[s] ?? '#6b7280' }));

  let offset = 0;
  const arcs = segments.map(seg => {
    const len = (seg.value / total) * c;
    const gap = Math.max(0, c - len - 1);
    const arc = { len: Math.max(len - 1, 0.5), gap, offset, color: seg.color };
    offset += len;
    return arc;
  });

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 100 100">
        {arcs.map((arc, i) => (
          <circle
            key={i}
            cx="50" cy="50" r={r}
            fill="none"
            stroke={arc.color}
            strokeWidth={strokeW}
            strokeDasharray={`${arc.len} ${c - arc.len}`}
            strokeDashoffset={-arc.offset}
            transform="rotate(-90 50 50)"
            className="transition-all duration-500"
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl sm:text-3xl font-bold text-fg-primary">{completionRate}%</span>
        <span className="text-[10px] text-fg-tertiary">{completed}/{total}</span>
      </div>
    </div>
  );
}

function DonutLegendItem({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${color}`} />
        <span className="text-xs text-fg-secondary truncate">{label}</span>
      </div>
      <span className="text-xs font-semibold text-fg-primary shrink-0">{count}</span>
    </div>
  );
}

// ─── Activity Feed ───────────────────────────────────────────────────────────

const ACTIVITY_ICON_BG: Record<string, string> = {
  completed: 'bg-green-500/15', in_progress: 'bg-brand-500/15', pending: 'bg-amber-500/15',
  review: 'bg-blue-500/15', failed: 'bg-red-500/15', blocked: 'bg-amber-500/15',
  rejected: 'bg-red-500/15', cancelled: 'bg-gray-500/15',
};

function ActivityIcon({ status }: { status: string }) {
  const sz = 12;
  const colorMap: Record<string, string> = {
    completed: '#22c55e', in_progress: '#8b5cf6', pending: '#f59e0b',
    review: '#3b82f6', failed: '#ef4444', blocked: '#f59e0b', rejected: '#ef4444', cancelled: '#6b7280',
  };
  const color = colorMap[status] ?? '#6b7280';
  return (
    <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      {status === 'completed' && <polyline points="20 6 9 17 4 12" />}
      {status === 'in_progress' && <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>}
      {status === 'pending' && <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>}
      {status === 'review' && <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>}
      {(status === 'failed' || status === 'rejected') && <><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>}
      {status === 'blocked' && <><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></>}
      {status === 'cancelled' && <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>}
    </svg>
  );
}

function formatRelativeTime(dateStr: string, t: TFunction): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('common:time.now');
  if (mins < 60) return t('common:time.minutesAgo', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('common:time.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return t('common:time.daysAgo', { count: days });
}

// ─── Health Row ──────────────────────────────────────────────────────────────

function HealthRow({ label, value, max, suffix, displayValue, alwaysGreen, neutral }: {
  label: string; value: number; max: number; suffix?: string; displayValue?: string; alwaysGreen?: boolean; neutral?: boolean;
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const barColor = neutral ? 'bg-blue-500' : alwaysGreen ? 'bg-brand-500' : pct >= 80 ? 'bg-green-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500';
  const textColor = neutral ? 'text-blue-400' : alwaysGreen ? 'text-brand-400' : pct >= 80 ? 'text-green-500' : pct >= 50 ? 'text-amber-500' : 'text-red-500';

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-fg-secondary">{label}</span>
        <span className={`text-sm font-semibold ${textColor}`}>{displayValue ?? `${value}${suffix ?? ''}`}</span>
      </div>
      <div className="w-full h-1.5 bg-surface-elevated rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function IconAgents() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconRunning() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function IconHealth() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function IconTasks() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

// ─── Utils ───────────────────────────────────────────────────────────────────

function fmtBytes(bytes: number, t: TFunction): string {
  if (bytes === 0) return t('storage.bytesZero');
  const unitKeys = ['storage.bytesB', 'storage.bytesKB', 'storage.bytesMB', 'storage.bytesGB'] as const;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), unitKeys.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${t(unitKeys[i])}`;
}

function fmtNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const ACTIVITY_LABEL_KEYS: Record<string, string> = {
  'Heartbeat check-in': 'agentFocus.heartbeatCheckIn',
  'Heartbeat check-in (idle skip)': 'agentFocus.heartbeatSkip',
};

function localizeActivityLabel(label: string | undefined, t: TFunction): string | null {
  if (!label) return null;
  const key = ACTIVITY_LABEL_KEYS[label];
  if (key) return t(key);
  return label;
}
