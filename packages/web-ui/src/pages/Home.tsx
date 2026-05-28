import { useEffect, useState, useMemo, useRef, useCallback, forwardRef } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { api, type AgentInfo, type TaskInfo, type OpsDashboard, type TeamInfo, type RequirementInfo, type ProjectInfo, type StorageInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { usePageActive } from '../hooks/usePageActive.ts';
import { Avatar } from '../components/Avatar.tsx';
import { MobileMenuButton } from '../components/MobileMenuButton.tsx';
import { useIsMobile } from '../hooks/useIsMobile.ts';

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
const ACTIVITY_ICON_BG: Record<string, string> = {
  completed: 'bg-green-500/15', in_progress: 'bg-brand-500/15', pending: 'bg-amber-500/15',
  review: 'bg-blue-500/15', failed: 'bg-red-500/15', blocked: 'bg-amber-500/15',
  rejected: 'bg-red-500/15', cancelled: 'bg-gray-500/15',
};
const ACTIVITY_LABEL_KEYS: Record<string, string> = {
  'Heartbeat check-in': 'agentFocus.heartbeatCheckIn',
  'Heartbeat check-in (idle skip)': 'agentFocus.heartbeatSkip',
};

// ═════════════════════════════════════════════════════════════════════════════

export function HomePage({ authUser }: { authUser?: { id: string; name: string; role: string; orgId: string } } = {}) {
  const { t } = useTranslation(['home', 'common', 'team']);
  const isMobile = useIsMobile();
  const isActive = usePageActive(PAGE.HOME);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [board, setBoard] = useState<Record<string, TaskInfo[]>>({});
  const [ops, setOps] = useState<OpsDashboard | null>(null);
  const opsPeriod = '7d' as const;
  const [allRequirements, setAllRequirements] = useState<RequirementInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [deliverableTotal, setDeliverableTotal] = useState(0);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [usageInfo, setUsageInfo] = useState<{ llmTokens: number; storageBytes: number } | null>(null);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [showRankingModal, setShowRankingModal] = useState(false);
  const createMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showCreateMenu) return;
    const handler = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) setShowCreateMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCreateMenu]);

  const refresh = useCallback(() => {
    api.agents.list().then(d => setAgents(d.agents)).catch(() => {});
    api.teams.list().then(d => setTeams(d.teams)).catch(() => {});
    api.tasks.board().then(d => setBoard(d.board)).catch(() => {});
    api.ops.dashboard(opsPeriod).then(setOps).catch(() => {});
    api.requirements.list().then(d => setAllRequirements(d.requirements)).catch(() => {});
    api.projects.list().then(d => setProjects(d.projects)).catch(() => {});
    api.deliverables.search({ limit: 1 }).then(d => setDeliverableTotal(d.total)).catch(() => {});
    api.system.storage().then(setStorageInfo).catch(() => {});
    api.usage.summary().then(d => setUsageInfo(d.usage)).catch(() => {});
  }, [opsPeriod]);

  useEffect(() => {
    if (!isActive) return;
    refresh();
    const i = setInterval(refresh, 30000);
    const onDataChanged = () => refresh();
    window.addEventListener('markus:data-changed', onDataChanged);
    return () => { clearInterval(i); window.removeEventListener('markus:data-changed', onDataChanged); };
  }, [opsPeriod, isActive, refresh]);

  // ── Computed ──
  const rootStatusCounts: Record<string, number> = {};
  for (const [status, tasks] of Object.entries(board)) {
    if (status === 'archived') continue;
    if (tasks.length > 0) rootStatusCounts[status] = tasks.length;
  }
  const completed = rootStatusCounts['completed'] ?? 0;
  const totalRootTasks = Object.values(rootStatusCounts).reduce((s, c) => s + c, 0);
  const workingAgents = agents.filter(a => a.status === 'working').length;
  const activeProjects = projects.filter(p => p.status === 'active').length;
  const completionRate = totalRootTasks > 0 ? Math.round((completed / totalRootTasks) * 100) : 0;
  const sortedStatusEntries = STATUS_ORDER.filter(s => (rootStatusCounts[s] ?? 0) > 0).map(s => ({ status: s, count: rootStatusCounts[s]! }));

  const reqStatusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    allRequirements.forEach(r => { c[r.status] = (c[r.status] ?? 0) + 1; });
    return c;
  }, [allRequirements]);

  const teamSummaries = useMemo(() => {
    const agentMap = new Map(agents.map(a => [a.id, a]));
    return teams.map(team => {
      const ma = team.members.filter(m => m.type === 'agent').map(m => agentMap.get(m.id)).filter((a): a is AgentInfo => !!a);
      return { team, agents: ma, working: ma.filter(a => a.status === 'working').length, total: ma.length };
    });
  }, [teams, agents]);

  const topPerformers = useMemo(() => {
    if (!ops) return [];
    return [...ops.agentEfficiency].filter(a => a.taskMetrics.completed > 0).sort((a, b) => b.taskMetrics.completed - a.taskMetrics.completed).slice(0, 3);
  }, [ops]);

  const allRankedAgents = useMemo(() => {
    if (!ops) return [];
    const score = (a: typeof ops.agentEfficiency[0]) => {
      const w = 0.3 + 0.7 * Math.min(1, (a.taskMetrics.completed + a.taskMetrics.failed) / 3);
      return a.healthScore * w + a.taskMetrics.completed * 0.5;
    };
    return [...ops.agentEfficiency].sort((a, b) => score(b) - score(a));
  }, [ops]);

  const workingAgentsList = agents.filter(a => a.status === 'working');

  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 sm:px-6 lg:px-8 h-14 sm:h-16 max-w-7xl mx-auto w-full">
        <div className="flex items-center gap-2">
          {isMobile && <MobileMenuButton />}
          <div>
            <h2 className="text-base sm:text-lg font-bold">{t('title')}</h2>
            <p className="text-xs text-fg-tertiary hidden sm:block">{t('subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => isMobile ? navBus.navigate(PAGE.SEARCH) : window.dispatchEvent(new CustomEvent('markus:open-search'))}
            className="p-2 rounded-lg hover:bg-surface-overlay transition-colors text-fg-tertiary" aria-label="Search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          </button>
          <CreateMenu ref={createMenuRef} show={showCreateMenu} onToggle={() => setShowCreateMenu(!showCreateMenu)} onClose={() => setShowCreateMenu(false)} t={t} isMobile={isMobile} />
        </div>
      </div>

      <div className="px-4 sm:px-6 lg:px-8 pb-8 space-y-6 max-w-7xl mx-auto w-full">

        {/* ── Metric Cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard label={t('metricCards.working')} value={String(workingAgents)} sub={`/${agents.length}`}
            icon={<MetricIcon type="working" />} pulse={workingAgents > 0} onClick={() => navBus.navigate(PAGE.TEAM)} />
          <MetricCard label={t('metricCards.tasksDone')} value={`${completed}`} sub={`/${totalRootTasks}`}
            icon={<MetricIcon type="tasks" />} onClick={() => navBus.navigate(PAGE.WORK)} />
          <MetricCard label={t('metricCards.projects')} value={String(activeProjects)}
            icon={<MetricIcon type="projects" />} onClick={() => navBus.navigate(PAGE.WORK)} />
          <MetricCard label={t('metricCards.health')} value={`${ops?.systemHealth.overallScore ?? '—'}`} sub={ops ? '%' : undefined}
            icon={<MetricIcon type="health" />} color={!ops ? undefined : ops.systemHealth.overallScore >= 80 ? 'green' : ops.systemHealth.overallScore >= 50 ? 'amber' : 'red'}
            onClick={() => setShowRankingModal(true)} />
        </div>

        {/* ── Getting Started (empty state) ── */}
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

        {/* ── Main Content: 2-column layout ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* ── Left Column (2/3) ── */}
          <div className="lg:col-span-2 space-y-6">

            {/* Task Overview with donut */}
            {totalRootTasks > 0 && (
              <div className="bg-surface-elevated shadow-sm rounded-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 pt-5 pb-3">
                  <h3 className="text-sm font-semibold text-fg-primary">{t('globalOverview.title')}</h3>
                  <button onClick={() => navBus.navigate(PAGE.WORK)} className="text-[11px] text-brand-400 hover:text-brand-300 font-medium">{t('common:viewAll')}</button>
                </div>

                {/* Tasks with donut */}
                <div className="px-5 py-4 flex flex-col sm:flex-row items-center gap-6 border-t border-border-subtle/50">
                  <DonutChart statusCounts={rootStatusCounts} total={totalRootTasks} completionRate={completionRate} completed={completed} />
                  <div className="flex-1 min-w-0">
                    <div className="grid grid-cols-2 gap-x-5 gap-y-2.5">
                      {sortedStatusEntries.map(({ status, count }) => (
                        <button key={status} onClick={() => navBus.navigate(PAGE.WORK, { statusFilter: status })}
                          className="flex items-center gap-2 group cursor-pointer text-left">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS_BG[status] ?? 'bg-gray-500'}`} />
                          <span className="text-xs text-fg-tertiary group-hover:text-fg-secondary transition-colors">{t(TASK_STATUS_I18N[status] ?? status)}</span>
                          <span className="text-sm font-semibold text-fg-primary ml-auto tabular-nums">{count}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Entity rows */}
                <div className="divide-y divide-border-subtle/50">
                  {projects.length > 0 && (
                    <EntityRow icon="folder" label={t('globalOverview.projects')} value={projects.length} onClick={() => navBus.navigate(PAGE.WORK)}>
                      <Chip>{activeProjects} {t('globalOverview.active')}</Chip>
                    </EntityRow>
                  )}
                  {allRequirements.length > 0 && (
                    <EntityRow icon="edit" label={t('globalOverview.requirements')} value={allRequirements.length} onClick={() => navBus.navigate(PAGE.WORK)}>
                      {(['in_progress', 'pending', 'completed'] as const).map(s =>
                        (reqStatusCounts[s] ?? 0) > 0 && <Chip key={s}>{reqStatusCounts[s]} {t(`common:status.${s === 'in_progress' ? 'inProgress' : s}`)}</Chip>
                      )}
                    </EntityRow>
                  )}
                  {deliverableTotal > 0 && (
                    <EntityRow icon="book" label={t('globalOverview.deliverables')} value={deliverableTotal} onClick={() => navBus.navigate(PAGE.DELIVERABLES)} />
                  )}
                </div>
              </div>
            )}

            {/* Activity Feed */}
            {(workingAgentsList.length > 0 || (ops && ops.taskKPI.recentActivity.length > 0)) && (
              <div className="bg-surface-elevated shadow-sm rounded-2xl overflow-hidden">
                <div className={`grid grid-cols-1 ${workingAgentsList.length > 0 && ops && ops.taskKPI.recentActivity.length > 0 ? 'sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-border-subtle/50' : ''}`}>
                  {/* Who's Working */}
                  {workingAgentsList.length > 0 && (
                    <div className="p-5">
                      <div className="flex items-center gap-2 mb-4">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                        <h4 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">{t('liveActivity.whosWorking')}</h4>
                      </div>
                      <div className="space-y-1">
                        {workingAgentsList.map(a => (
                          <div key={a.id} className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-surface-overlay/40 cursor-pointer transition-colors"
                            onClick={() => navBus.navigate(PAGE.TEAM, { agentId: a.id, profileTab: 'overview' })}>
                            <Avatar name={a.name} avatarUrl={(a as any).avatarUrl} size={24} bgClass="bg-brand-600/30 text-brand-300" />
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-medium text-fg-primary truncate">{a.name}</div>
                              <div className="text-[10px] text-fg-tertiary truncate">{localizeActivityLabel(a.currentActivity?.label, t) ?? t('agentFocus.working')}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Recent Changes - takes full width when no working agents */}
                  {ops && ops.taskKPI.recentActivity.length > 0 && (
                    <div className="p-5">
                      <div className="flex items-center justify-between mb-4">
                        <h4 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">{t('liveActivity.recentChanges')}</h4>
                        <button onClick={() => navBus.navigate(PAGE.WORK)} className="text-[11px] text-brand-400 hover:text-brand-300 font-medium">{t('common:viewAll')}</button>
                      </div>
                      <div className={`${workingAgentsList.length > 0 ? '' : 'grid grid-cols-1 sm:grid-cols-2 gap-x-4'}`}>
                        {ops.taskKPI.recentActivity.slice(0, workingAgentsList.length > 0 ? 8 : 12).map(act => (
                          <div key={act.taskId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-overlay/40 cursor-pointer transition-colors"
                            onClick={() => navBus.navigate(PAGE.WORK, { openTask: act.taskId })}>
                            <span className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${ACTIVITY_ICON_BG[act.status] ?? 'bg-gray-500/15'}`}>
                              <ActivityIcon status={act.status} />
                            </span>
                            <span className="text-[11px] text-fg-secondary truncate flex-1">{act.title}</span>
                            <span className="text-[10px] text-fg-muted shrink-0">{formatRelativeTime(act.updatedAt, t)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── Right Column (1/3) ── */}
          <div className="space-y-6">

            {/* Top Performers + Teams (combined card) */}
            <div className="bg-surface-elevated shadow-sm rounded-2xl overflow-hidden">
              {/* Top Performers section (on top) */}
              {topPerformers.length > 0 && (
                <div className="p-5 pb-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-fg-primary">{t('topPerformers.title')}</h3>
                    <button onClick={() => setShowRankingModal(true)} className="text-[11px] text-brand-400 hover:text-brand-300 font-medium">{t('common:viewAll')}</button>
                  </div>
                  <div className="space-y-0.5">
                    {topPerformers.map((agent, idx) => (
                      <div key={agent.agentId} className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-surface-overlay/40 cursor-pointer transition-colors"
                        onClick={() => navBus.navigate(PAGE.TEAM, { selectAgent: agent.agentId })}>
                        <span className={`text-[10px] font-bold w-4 text-center ${idx === 0 ? 'text-amber-400' : idx === 1 ? 'text-gray-400' : 'text-amber-600'}`}>{idx + 1}</span>
                        <Avatar name={agent.agentName} size={24} bgClass="bg-brand-600/20 text-brand-300" />
                        <span className="text-xs font-medium text-fg-primary truncate flex-1">{agent.agentName}</span>
                        <span className="text-[10px] text-fg-tertiary tabular-nums">{agent.taskMetrics.completed} {t('topPerformers.done')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Teams section */}
              <div className={`p-5 ${topPerformers.length > 0 ? 'pt-3 border-t border-border-subtle/50' : ''}`}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-fg-primary">{t('teamOverview.title')}</h3>
                  <button onClick={() => navBus.navigate(PAGE.TEAM)} className="text-[11px] text-brand-400 hover:text-brand-300 font-medium">{t('common:viewAll')}</button>
                </div>
                {teamSummaries.length === 0 && agents.length === 0 ? (
                  <div className="text-xs text-fg-tertiary py-4 text-center cursor-pointer" onClick={() => navBus.navigate(PAGE.TEAM)}>{t('teamStatus.noTeams')}</div>
                ) : (
                  <div className="space-y-0.5">
                    {teamSummaries.map(ts => (
                      <div key={ts.team.id} className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surface-overlay/40 cursor-pointer transition-colors"
                        onClick={() => navBus.navigate(PAGE.TEAM, { selectTeam: ts.team.id })}>
                        <div className="w-7 h-7 rounded-md bg-brand-600/15 flex items-center justify-center text-[10px] font-bold text-brand-400 shrink-0">{ts.team.name.charAt(0)}</div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-fg-primary truncate">{ts.team.name}</div>
                        </div>
                        <div className="flex items-center -space-x-1 shrink-0">
                          {ts.agents.slice(0, 3).map(a => (
                            <Avatar key={a.id} name={a.name} avatarUrl={(a as any).avatarUrl} size={18} bgClass="bg-surface-overlay text-fg-secondary ring-1 ring-surface-elevated" />
                          ))}
                        </div>
                        {ts.working > 0 && <span className="text-[10px] text-green-500 font-medium shrink-0">{ts.working}/{ts.total}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* System Health */}
            <div className="bg-surface-elevated shadow-sm rounded-2xl p-5">
              <h3 className="text-sm font-semibold text-fg-primary mb-4">{t('systemHealth.title')}</h3>
              <div className="space-y-3">
                {ops && (
                  <HealthRow label={t('systemHealth.successRate')} value={`${Math.round(ops.taskKPI.successRate)}%`}
                    bar={Math.round(ops.taskKPI.successRate)} color="bg-green-500" />
                )}
                <HealthKV label={t('systemHealth.tasksTotal')} value={`${completed}/${totalRootTasks}`} />
                {usageInfo && (
                  <HealthKV label={t('systemHealth.tokenUsage')} value={formatTokenCount(usageInfo.llmTokens)} />
                )}
                {workingAgents > 0 && (
                  <HealthKV label={t('systemHealth.currentWorking')} value={`${workingAgents}/${agents.length}`} accent />
                )}
                {storageInfo && (
                  <HealthKV label={t('systemHealth.storage')} value={fmtBytes(storageInfo.totalSize)} />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Ranking Modal ── */}
      {showRankingModal && ops && <RankingModal agents={allRankedAgents} onClose={() => setShowRankingModal(false)} t={t} />}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Sub-components
// ═════════════════════════════════════════════════════════════════════════════

function MetricCard({ label, value, sub, icon, pulse, color, onClick }: {
  label: string; value: string; sub?: string; icon: React.ReactNode; pulse?: boolean; color?: 'green' | 'amber' | 'red'; onClick?: () => void;
}) {
  const colorClass = color === 'green' ? 'text-green-500' : color === 'amber' ? 'text-amber-500' : color === 'red' ? 'text-red-500' : 'text-fg-primary';
  return (
    <div onClick={onClick} className="bg-surface-elevated shadow-sm rounded-2xl p-4 sm:p-5 flex items-start justify-between cursor-pointer hover:shadow-md transition-shadow">
      <div>
        <div className="text-[11px] text-fg-tertiary mb-2">{label}</div>
        <div className="flex items-baseline gap-0.5">
          <span className={`text-2xl sm:text-3xl font-bold ${colorClass} leading-none`}>{value}</span>
          {sub && <span className="text-sm text-fg-muted font-medium">{sub}</span>}
        </div>
      </div>
      <div className="relative">
        <div className="w-10 h-10 rounded-xl bg-surface-overlay/60 flex items-center justify-center text-fg-tertiary">{icon}</div>
        {pulse && <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />}
      </div>
    </div>
  );
}

function MetricIcon({ type }: { type: string }) {
  const paths: Record<string, React.ReactNode> = {
    working: <><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></>,
    tasks: <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>,
    projects: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></>,
    health: <><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">{paths[type]}</svg>;
}

// ── Entity Row ──────────────────────────────────────────────────────────────

function EntityRow({ icon, label, value, onClick, children }: {
  icon: 'folder' | 'edit' | 'book'; label: string; value: number; onClick: () => void; children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-3 hover:bg-surface-overlay/30 cursor-pointer transition-colors" onClick={onClick}>
      <span className="text-fg-muted"><EntityIcon type={icon} /></span>
      <span className="text-xs text-fg-secondary">{label}</span>
      <span className="text-sm font-semibold text-fg-primary">{value}</span>
      <div className="flex items-center gap-2 ml-auto text-[11px] text-fg-tertiary">{children}</div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="px-2 py-0.5 rounded-full bg-surface-overlay/60 text-[11px] text-fg-secondary">{children}</span>;
}

function EntityIcon({ type }: { type: 'folder' | 'edit' | 'book' }) {
  const p: Record<string, string> = {
    folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
    edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
    book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z',
  };
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d={p[type]} /></svg>;
}

// ── Donut Chart ─────────────────────────────────────────────────────────────

function DonutChart({ statusCounts, total, completionRate, completed }: {
  statusCounts: Record<string, number>; total: number; completionRate: number; completed: number;
}) {
  const size = 120;
  const r = 42;
  const strokeW = 12;
  const c = 2 * Math.PI * r;
  const segments = STATUS_ORDER.filter(s => (statusCounts[s] ?? 0) > 0).map(s => ({ status: s, value: statusCounts[s]!, color: DONUT_COLORS[s] ?? '#6b7280' }));
  let offset = 0;
  const arcs = segments.map(seg => {
    const len = (seg.value / total) * c;
    const arc = { len: Math.max(len - 0.8, 0.5), offset, color: seg.color, status: seg.status };
    offset += len;
    return arc;
  });

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 120 120">
        {arcs.map((arc, i) => (
          <circle key={i} cx="60" cy="60" r={r} fill="none" stroke={arc.color} strokeWidth={strokeW}
            strokeDasharray={`${arc.len} ${c - arc.len}`} strokeDashoffset={-arc.offset}
            transform="rotate(-90 60 60)" className="transition-all duration-500 cursor-pointer"
            onClick={() => navBus.navigate(PAGE.WORK, { statusFilter: arc.status })} />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold text-fg-primary leading-none">{completionRate}%</span>
        <span className="text-[10px] text-fg-tertiary mt-0.5">{completed}/{total}</span>
      </div>
    </div>
  );
}

// ── Health Row / KV ─────────────────────────────────────────────────────────

function HealthRow({ label, value, bar, color }: { label: string; value: string; bar: number; color: string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-fg-secondary">{label}</span>
        <span className="text-xs font-semibold text-fg-primary">{value}</span>
      </div>
      <div className="h-1 rounded-full bg-surface-overlay/60 overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${bar}%` }} />
      </div>
    </div>
  );
}

function HealthKV({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-fg-secondary">{label}</span>
      <span className={`text-xs font-semibold ${accent ? 'text-green-500' : 'text-fg-primary'}`}>{value}</span>
    </div>
  );
}

// ── Activity Icon ───────────────────────────────────────────────────────────

function ActivityIcon({ status }: { status: string }) {
  const color: Record<string, string> = { completed: '#22c55e', in_progress: '#8b5cf6', pending: '#f59e0b', review: '#3b82f6', failed: '#ef4444', blocked: '#f59e0b', rejected: '#ef4444', cancelled: '#6b7280' };
  const c = color[status] ?? '#6b7280';
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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

// ── Ranking Modal ───────────────────────────────────────────────────────────

function RankingModal({ agents, onClose, t }: { agents: Array<{ agentId: string; agentName: string; role: string; agentRole: string; healthScore: number; taskMetrics: { completed: number; failed: number }; errorRate: number }>; onClose: () => void; t: TFunction }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-elevated rounded-xl border border-border-default shadow-2xl w-[480px] max-w-[90vw] max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border-default flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold">{t('ranking.title')}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-overlay transition-colors text-fg-tertiary hover:text-fg-primary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 scrollbar-thin">
          <div className="px-4 py-2 flex items-center gap-3 text-[10px] text-fg-tertiary uppercase tracking-wider font-medium border-b border-border-default/50">
            <span className="w-7 text-center">#</span><span className="flex-1">{t('ranking.agent')}</span>
            <span className="w-14 text-center">{t('ranking.health')}</span><span className="w-14 text-center">{t('ranking.tasks')}</span><span className="w-14 text-center">{t('ranking.errorRate')}</span>
          </div>
          {agents.map((agent, idx) => {
            const hc = agent.healthScore >= 80 ? 'text-green-500' : agent.healthScore >= 50 ? 'text-amber-500' : 'text-red-500';
            const ep = Math.round(agent.errorRate * 100);
            const medal = idx < 3 ? ['text-amber-400', 'text-gray-400', 'text-amber-600'][idx] : 'text-fg-tertiary';
            return (
              <div key={agent.agentId} className="px-4 py-2.5 flex items-center gap-3 hover:bg-surface-overlay/50 cursor-pointer transition-colors border-b border-border-default/30 last:border-0"
                onClick={() => { onClose(); navBus.navigate(PAGE.TEAM, { selectAgent: agent.agentId }); }}>
                <span className={`w-7 text-center text-xs font-bold ${medal}`}>{idx + 1}</span>
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Avatar name={agent.agentName} size={26} bgClass="bg-brand-600/20 text-brand-300" />
                  <div className="min-w-0"><div className="text-xs font-medium text-fg-primary truncate">{agent.agentName}</div><div className="text-[10px] text-fg-tertiary truncate">{agent.role || agent.agentRole || '—'}</div></div>
                </div>
                <span className={`w-14 text-center text-xs font-semibold ${hc}`}>{agent.healthScore}%</span>
                <span className="w-14 text-center text-xs text-fg-secondary">{agent.taskMetrics.completed}<span className="text-fg-tertiary">/{agent.taskMetrics.completed + agent.taskMetrics.failed}</span></span>
                <span className={`w-14 text-center text-xs ${ep > 20 ? 'text-red-500' : ep > 5 ? 'text-amber-500' : 'text-green-500'}`}>{ep}%</span>
              </div>
            );
          })}
          {agents.length === 0 && <div className="py-8 text-center text-xs text-fg-tertiary">{t('ranking.noData')}</div>}
        </div>
      </div>
    </div>
  );
}

// ── Create Menu ─────────────────────────────────────────────────────────────

const CreateMenu = forwardRef<HTMLDivElement, { show: boolean; onToggle: () => void; onClose: () => void; t: TFunction; isMobile?: boolean }>(
  ({ show, onToggle, onClose, t, isMobile }, ref) => (
    <div ref={ref} className="relative">
      <button onClick={onToggle} className="p-2 rounded-lg hover:bg-surface-overlay transition-colors text-fg-tertiary" aria-label="Create">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
      </button>
      {show && (
        <div className="absolute right-0 top-full mt-2 bg-surface-elevated border border-border-default rounded-xl shadow-xl z-50 overflow-hidden w-48 animate-fadeIn">
          <div className="py-1">
            <MenuBtn onClick={() => { onClose(); navBus.navigate(PAGE.BUILDER, isMobile ? { storeTab: 'builder' } : undefined); }}
              icon="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M19 8v6 M22 11h-6">{t('home:createMenu.agent')}</MenuBtn>
            <MenuBtn onClick={() => { onClose(); navBus.navigate(PAGE.BUILDER); }}
              icon="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75">{t('home:createMenu.team')}</MenuBtn>
            <MenuBtn onClick={() => { onClose(); navBus.navigate(PAGE.BUILDER); }}
              icon="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z">{t('home:createMenu.skill')}</MenuBtn>
            <div className="border-t border-border-default my-1" />
            <MenuBtn onClick={() => { onClose(); navBus.navigate(PAGE.STORE); }}
              icon="M6 2L3 7v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-3-5z M3 7h18 M16 11a4 4 0 0 1-8 0">{t('home:createMenu.discover')}</MenuBtn>
          </div>
        </div>
      )}
    </div>
  )
);

function MenuBtn({ onClick, icon, children }: { onClick: () => void; icon: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-fg-secondary hover:bg-surface-overlay transition-colors">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={icon} /></svg>
      {children}
    </button>
  );
}

// ── Utilities ───────────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string, t: TFunction): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('common:time.now');
  if (mins < 60) return t('common:time.minutesAgo', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('common:time.hoursAgo', { count: hours });
  return t('common:time.daysAgo', { count: Math.floor(hours / 24) });
}

function localizeActivityLabel(label: string | undefined, t: TFunction): string | null {
  if (!label) return null;
  return ACTIVITY_LABEL_KEYS[label] ? t(ACTIVITY_LABEL_KEYS[label]) : label;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
