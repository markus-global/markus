import { useEffect, useState, useMemo, useRef, useCallback, forwardRef } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { api, type AgentInfo, type TaskInfo, type OpsDashboard, type TeamInfo, type RequirementInfo, type ProjectInfo, type StorageInfo, type DeliverableInfo } from '../api.ts';
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

export interface HomePreviewData {
  agents?: AgentInfo[];
  teams?: TeamInfo[];
  board?: Record<string, TaskInfo[]>;
  ops?: OpsDashboard | null;
  requirements?: RequirementInfo[];
  projects?: ProjectInfo[];
  deliverableTotal?: number;
  storageInfo?: StorageInfo | null;
  usageInfo?: { llmTokens: number; storageBytes: number } | null;
}

export function HomePage({ authUser, previewMode, previewData }: { authUser?: { id: string; name: string; role: string; orgId: string }; previewMode?: boolean; previewData?: HomePreviewData } = {}) {
  const { t } = useTranslation(['home', 'common', 'team']);
  const isMobile = useIsMobile();
  const isActive = usePageActive(PAGE.HOME);
  const [agents, setAgents] = useState<AgentInfo[]>(previewData?.agents ?? []);
  const [teams, setTeams] = useState<TeamInfo[]>(previewData?.teams ?? []);
  const [board, setBoard] = useState<Record<string, TaskInfo[]>>(previewData?.board ?? {});
  const [ops, setOps] = useState<OpsDashboard | null>(previewData?.ops ?? null);
  const opsPeriod = '7d' as const;
  const [allRequirements, setAllRequirements] = useState<RequirementInfo[]>(previewData?.requirements ?? []);
  const [projects, setProjects] = useState<ProjectInfo[]>(previewData?.projects ?? []);
  const [deliverableTotal, setDeliverableTotal] = useState(previewData?.deliverableTotal ?? 0);
  const [recentDeliverables, setRecentDeliverables] = useState<DeliverableInfo[]>([]);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(previewData?.storageInfo ?? null);
  const [usageInfo, setUsageInfo] = useState<{ llmTokens: number; storageBytes: number } | null>(previewData?.usageInfo ?? null);
  const [cuQuota, setCuQuota] = useState<{ available: boolean; cuRemaining: number; cuLimit: number; cuUsedToday?: number } | null>(null);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [showWorkingModal, setShowWorkingModal] = useState(false);
  const [showHealthModal, setShowHealthModal] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);
  const [browserConnected, setBrowserConnected] = useState<boolean | null>(null);
  const [licenseConfigured, setLicenseConfigured] = useState<boolean | null>(null);
  const [codingToolsConfigured, setCodingToolsConfigured] = useState(false);
  const [checklistDismissed, setChecklistDismissed] = useState(() => localStorage.getItem('markus_checklist_dismissed') === 'true');
  const [secretaryHasChat, setSecretaryHasChat] = useState(false);
  const [checklistReady, setChecklistReady] = useState(false);
  const createMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showCreateMenu) return;
    const handler = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) setShowCreateMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCreateMenu]);

  useEffect(() => {
    if (!previewMode || !previewData) return;
    if (previewData.agents) setAgents(previewData.agents);
    if (previewData.teams) setTeams(previewData.teams);
    if (previewData.board) setBoard(previewData.board);
    setOps(previewData.ops ?? null);
    setAllRequirements(previewData.requirements ?? []);
    setProjects(previewData.projects ?? []);
    setDeliverableTotal(previewData.deliverableTotal ?? 0);
    if (previewData.storageInfo) setStorageInfo(previewData.storageInfo);
    if (previewData.usageInfo) setUsageInfo(previewData.usageInfo);
  }, [previewMode, previewData]);

  const refresh = useCallback(() => {
    const agentsP = api.agents.list().then(async d => {
      setAgents(d.agents);
      const sec = d.agents.find(a => a.role === 'secretary') ?? d.agents.find(a => a.name?.toLowerCase().includes('secretary'));
      if (sec) {
        try {
          const r = await api.sessions.listByAgent(sec.id, 1);
          if (r.sessions.length > 0) {
            const m = await api.sessions.getMessages(r.sessions[0]!.id, 1);
            setSecretaryHasChat(m.messages.length > 0);
          }
        } catch { /* ignore */ }
      }
    }).catch(() => {});
    const teamsP = api.teams.list().then(d => setTeams(d.teams)).catch(() => {});
    api.tasks.board().then(d => setBoard(d.board)).catch(() => {});
    api.ops.dashboard(opsPeriod).then(setOps).catch(() => {});
    const reqsP = api.requirements.list().then(d => setAllRequirements(d.requirements)).catch(() => {});
    const projsP = api.projects.list().then(d => setProjects(d.projects)).catch(() => {});
    api.deliverables.search({ limit: 18 }).then(d => {
      setDeliverableTotal(d.total);
      const seen = new Map<string, DeliverableInfo>();
      for (const item of d.results) {
        const key = item.reference;
        const prev = seen.get(key);
        if (!prev || item.updatedAt > prev.updatedAt) seen.set(key, item);
      }
      setRecentDeliverables([...seen.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6));
    }).catch(() => {});
    api.system.storage().then(setStorageInfo).catch(() => {});
    api.usage.summary().then(d => setUsageInfo(d.usage)).catch(() => {});
    api.cu.status().then(setCuQuota).catch(() => {});
    const llmP = api.settings.getLlm().then(d => {
      setLlmConfigured(Object.values(d.providers).some(p => p.configured));
    }).catch(() => {});
    const browserP = api.settings.getBrowser().then(d => {
      setBrowserConnected(d.extensionConnected);
    }).catch(() => {});
    const licenseP = api.license.get().then(d => {
      setLicenseConfigured(d.plan !== 'free');
    }).catch(() => {});
    const codingP = api.settings.getCodingTools().then(d => {
      setCodingToolsConfigured(d.enabled && Object.values(d.tools).some(t => t.enabled));
    }).catch(() => {});
    Promise.allSettled([agentsP, teamsP, reqsP, projsP, llmP, browserP, licenseP, codingP]).then(() => {
      setChecklistReady(true);
    });
  }, [opsPeriod]);

  useEffect(() => {
    if (previewMode || !isActive) return;
    refresh();
    const i = setInterval(refresh, 30000);
    const onDataChanged = () => refresh();
    window.addEventListener('markus:data-changed', onDataChanged);
    return () => { clearInterval(i); window.removeEventListener('markus:data-changed', onDataChanged); };
  }, [previewMode, opsPeriod, isActive, refresh]);

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

  const nav = previewMode ? (() => {}) as typeof navBus.navigate : navBus.navigate;

  const allTasksMap = useMemo(() => {
    const m = new Map<string, TaskInfo>();
    for (const tasks of Object.values(board)) for (const t of tasks) m.set(t.id, t);
    return m;
  }, [board]);

  const isBlockedAbnormally = useCallback((task: TaskInfo): boolean => {
    if (!task.blockedBy || task.blockedBy.length === 0) return true;
    return task.blockedBy.every(id => {
      const dep = allTasksMap.get(id);
      return dep && dep.status === 'completed';
    });
  }, [allTasksMap]);

  const attentionItems = useMemo(() => {
    const items: Array<{ type: 'review' | 'approval' | 'blocked' | 'blocked_abnormal'; count: number; tasks?: TaskInfo[]; urgent?: number }> = [];
    const reviewTasks = (board['review'] ?? []).filter(tk => tk.reviewerType === 'human');
    if (reviewTasks.length > 0) {
      const urg = reviewTasks.filter(tk => tk.priority === 'urgent' || tk.priority === 'high').length;
      items.push({ type: 'review', count: reviewTasks.length, tasks: reviewTasks, urgent: urg });
    }
    const pendingReqs = allRequirements.filter(r => r.status === 'pending');
    if (pendingReqs.length > 0) items.push({ type: 'approval', count: pendingReqs.length });

    const blockedTasks = [...(board['blocked'] ?? [])];
    const failedTasks = [...(board['failed'] ?? [])];
    const abnormal = blockedTasks.filter(t => isBlockedAbnormally(t));
    const normal = blockedTasks.filter(t => !isBlockedAbnormally(t));
    const allAbnormal = [...abnormal, ...failedTasks];

    if (allAbnormal.length > 0) {
      const urg = allAbnormal.filter(tk => tk.priority === 'urgent' || tk.priority === 'high').length;
      items.push({ type: 'blocked_abnormal', count: allAbnormal.length, tasks: allAbnormal, urgent: urg });
    }
    if (normal.length > 0) {
      items.push({ type: 'blocked', count: normal.length, tasks: normal });
    }
    return items;
  }, [board, allRequirements, isBlockedAbnormally]);

  const taskPriorityMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const tasks of Object.values(board)) {
      for (const tk of tasks) if (tk.priority) m.set(tk.id, tk.priority);
    }
    return m;
  }, [board]);

  const urgentHighActive = useMemo(() => {
    let count = 0;
    for (const [status, tasks] of Object.entries(board)) {
      if (status === 'completed' || status === 'archived' || status === 'cancelled') continue;
      count += tasks.filter(tk => tk.priority === 'urgent' || tk.priority === 'high').length;
    }
    return count;
  }, [board]);

  const agentNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.name);
    return m;
  }, [agents]);

  const { activityLimit, teamsLimit } = useMemo(() => {
    const entityCount = (projects.length > 0 ? 1 : 0) + (allRequirements.length > 0 ? 1 : 0) + (deliverableTotal > 0 ? 1 : 0);
    const leftOverview = totalRootTasks > 0 ? 6 + entityCount : 0;
    const leftGap = leftOverview > 0 ? 2 : 0;
    const leftActHeader = 2;
    const leftFixed = leftOverview + leftGap + leftActHeader;

    const rightPerf = topPerformers.length > 0 ? 2 + topPerformers.length : 0;
    const rightTeamsNatural = 2 + teamSummaries.length;
    const rightNatural = rightPerf + rightTeamsNatural;

    const wc = workingAgentsList.length;
    const naturalMax = wc > 0 ? 8 : 12;
    const spaceForAct = Math.max(0, rightNatural - leftFixed);
    let act = wc > 0 ? Math.max(wc, spaceForAct) : spaceForAct;
    act = Math.max(3, Math.min(naturalMax, act));

    const leftFinal = leftFixed + Math.max(wc, act);
    let teams = teamSummaries.length;
    if (rightNatural > leftFinal + 2) {
      const excess = rightNatural - leftFinal;
      teams = Math.max(2, teamSummaries.length - excess);
    } else if (leftFinal > rightNatural + 2) {
      const deficit = leftFinal - rightNatural;
      act = Math.max(3, act - deficit);
    }

    return { activityLimit: act, teamsLimit: teams };
  }, [topPerformers, teamSummaries, totalRootTasks, projects, allRequirements, deliverableTotal, workingAgentsList]);

  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      {/* ── Header ── */}
      <div className={`flex items-center justify-between px-4 sm:px-6 lg:px-8 h-14 sm:h-16 ${previewMode ? '' : 'max-w-7xl mx-auto'} w-full`}>
        <div className="flex items-center gap-2">
          {isMobile && <MobileMenuButton />}
          <div>
            <h2 className="text-base sm:text-lg font-bold">{t('title')}</h2>
            <p className="text-xs text-fg-tertiary hidden sm:block">{t('subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => previewMode ? undefined : isMobile ? navBus.navigate(PAGE.SEARCH) : window.dispatchEvent(new CustomEvent('markus:open-search'))}
            className="p-2 rounded-lg hover:bg-surface-overlay transition-colors text-fg-tertiary" aria-label="Search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          </button>
          <CreateMenu ref={createMenuRef} show={showCreateMenu} onToggle={() => setShowCreateMenu(!showCreateMenu)} onClose={() => setShowCreateMenu(false)} t={t} isMobile={isMobile} />
        </div>
      </div>

      <div className={`px-4 sm:px-6 lg:px-8 pb-8 space-y-6 ${previewMode ? '' : 'max-w-7xl mx-auto'} w-full`}>

        {/* ── Metric Cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard label={t('metricCards.working')} value={String(workingAgents)} sub={`/${agents.length}`}
            icon={<MetricIcon type="working" />} pulse={workingAgents > 0} onClick={() => setShowWorkingModal(true)} />
          <MetricCard label={t('metricCards.tasksDone')} value={`${completed}`} sub={`/${totalRootTasks}`}
            icon={<MetricIcon type="tasks" />} badge={urgentHighActive > 0 ? `${urgentHighActive} urgent/high` : undefined} onClick={() => navBus.navigate(PAGE.WORK)} />
          <MetricCard label={t('metricCards.projects')} value={String(activeProjects)}
            icon={<MetricIcon type="projects" />} onClick={() => navBus.navigate(PAGE.WORK)} />
          <MetricCard label={t('metricCards.health')} value={`${llmConfigured === false ? 100 : ops?.systemHealth.overallScore ?? '—'}`} sub={llmConfigured === false || ops ? '%' : undefined}
            icon={<MetricIcon type="health" />} color={llmConfigured === false ? 'green' : !ops ? undefined : ops.systemHealth.overallScore >= 80 ? 'green' : ops.systemHealth.overallScore >= 50 ? 'amber' : 'red'}
            onClick={() => setShowHealthModal(true)} />
        </div>

        {/* ── Needs Your Attention ── */}
        {!previewMode && attentionItems.length > 0 && (
          <div className="bg-gradient-to-r from-amber-500/5 via-surface-elevated to-surface-elevated border border-amber-500/20 rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                <h3 className="text-sm font-semibold text-fg-primary">{t('attention.title')}</h3>
              </div>
            </div>
            <div className="px-3 pb-3 space-y-1">
              {attentionItems.map(item => {
                const isAbnormal = item.type === 'blocked_abnormal';
                const isBlocked = item.type === 'blocked' || isAbnormal;
                const iconBg = item.type === 'review' ? 'bg-blue-500/15' : item.type === 'approval' ? 'bg-amber-500/15' : isAbnormal ? 'bg-red-500/15' : 'bg-amber-500/15';
                const btnCls = item.type === 'review' ? 'bg-blue-500/10 text-blue-500 hover:bg-blue-500/20'
                  : item.type === 'approval' ? 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/20'
                  : isAbnormal ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20'
                  : 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/20';
                const label = item.type === 'review' ? t('attention.tasksReview')
                  : item.type === 'approval' ? t('attention.requirements')
                  : isAbnormal ? t('attention.blockedAbnormal')
                  : t('attention.blockedNormal');
                const btnLabel = item.type === 'review' ? t('attention.goReview')
                  : item.type === 'approval' ? t('attention.goApprove')
                  : t('attention.viewDetails');
                return (
                  <div key={item.type} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-overlay/40 cursor-pointer transition-colors"
                    onClick={() => {
                      if (item.type === 'review') {
                        navBus.navigate(PAGE.WORK, { statusFilter: 'review' });
                      } else if (item.type === 'approval') {
                        navBus.navigate(PAGE.WORK);
                      } else if (isBlocked && item.tasks && item.tasks.length > 0) {
                        navBus.navigate(PAGE.WORK, { openTask: item.tasks[0]!.id });
                      } else {
                        navBus.navigate(PAGE.WORK);
                      }
                    }}>
                    <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>
                      <AttentionIcon type={isBlocked ? 'blocked' : item.type as 'review' | 'approval' | 'blocked'} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-fg-primary">
                        {item.count} {label}
                      </span>
                      {(item.urgent ?? 0) > 0 && (
                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 text-red-500">{item.urgent} urgent</span>
                      )}
                    </div>
                    <button className={`text-[11px] font-medium px-3 py-1 rounded-lg transition-colors shrink-0 ${btnCls}`}>
                      {btnLabel}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Recent Deliverables (full-width, high priority) ── */}
        {recentDeliverables.length > 0 && (
          <div className="bg-surface-elevated shadow-sm rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <h3 className="text-sm font-semibold text-fg-primary">{t('recentDeliverables.title')}</h3>
              <button onClick={() => navBus.navigate(PAGE.DELIVERABLES)} className="text-[11px] text-brand-400 hover:text-brand-300 font-medium">{t('common:viewAll')}</button>
            </div>
            <div className="px-3 pb-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1">
                {recentDeliverables.map(d => (
                  <div key={d.id} className="flex items-start gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-overlay/40 cursor-pointer transition-colors"
                    onClick={() => navBus.navigate(PAGE.DELIVERABLES, { openDeliverable: d.id })}>
                    <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                      d.artifactType ? 'bg-brand-500/10' : d.type === 'directory' ? 'bg-blue-500/10' : 'bg-green-500/10'
                    }`}>
                      <DeliverableTypeIcon type={d.type} artifactType={d.artifactType} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-fg-primary truncate">{d.title}</div>
                      <div className="text-[11px] text-fg-tertiary truncate mt-0.5">{d.summary}</div>
                      <div className="flex items-center gap-2 mt-1">
                        {d.agentId && agentNameMap.get(d.agentId) && (
                          <span className="text-[10px] text-fg-muted">{agentNameMap.get(d.agentId)}</span>
                        )}
                        <span className="text-[10px] text-fg-muted">{formatRelativeTime(d.updatedAt, t)}</span>
                        {d.status === 'verified' && (
                          <span className="text-[10px] text-blue-500 font-medium">Verified</span>
                        )}
                      </div>
                    </div>
                    {d.diffStats && (
                      <div className="text-[10px] text-fg-muted shrink-0 mt-1 tabular-nums">
                        <span className="text-green-500">+{d.diffStats.additions}</span>{' '}
                        <span className="text-red-500">-{d.diffStats.deletions}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Onboarding Checklist ── */}
        {!checklistDismissed && !checklistReady && (
          <div className="bg-gradient-to-br from-brand-600/10 via-surface-secondary to-surface-secondary border border-brand-500/20 rounded-2xl p-5 sm:p-6">
            <div className="flex items-center justify-center py-10 gap-3 text-fg-tertiary">
              <div className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">{t('common:loading')}</span>
            </div>
          </div>
        )}
        {!checklistDismissed && checklistReady && (() => {
          const navigateToSecretary = (prompt: string) => {
            const secretary = agents.find(a => a.role === 'secretary') ?? agents.find(a => a.name?.toLowerCase().includes('secretary'));
            navBus.navigate(PAGE.TEAM, {
              ...(secretary ? { agentId: secretary.id } : {}),
              prefillMessage: prompt,
            });
          };

          const setupSteps = [
            { id: 'llm', done: llmConfigured === true, isSetup: true, label: t('checklist.setup.llm'), desc: t('checklist.setup.llmDesc'), action: t('checklist.setup.llmAction'), onClick: () => { window.location.hash = '#settings/providers'; } },
            { id: 'browser', done: browserConnected === true, isSetup: true, optional: true, label: t('checklist.setup.browser'), desc: t('checklist.setup.browserDesc'), action: t('checklist.setup.browserAction'), onClick: () => { window.location.hash = '#settings/browser'; } },
            { id: 'coding-tools', done: codingToolsConfigured, isSetup: true, optional: true, label: t('checklist.setup.codingTools'), desc: t('checklist.setup.codingToolsDesc'), action: t('checklist.setup.codingToolsAction'), onClick: () => { window.location.hash = '#settings/coding-tools'; } },
            { id: 'license', done: licenseConfigured === true, isSetup: true, optional: true, label: t('checklist.setup.license'), desc: t('checklist.setup.licenseDesc'), action: t('checklist.setup.licenseAction'), onClick: () => { window.location.hash = '#settings/account'; } },
          ];

          const exploreSteps = [
            { id: 'greet', done: secretaryHasChat, label: t('checklist.explore.greet'), desc: t('checklist.explore.greetDesc'), action: t('checklist.explore.greetAction'), onClick: () => navigateToSecretary('你好！我是新用户，请简单介绍一下你能帮我做什么？') },
            { id: 'project', done: projects.length > 0, label: t('checklist.explore.project'), desc: t('checklist.explore.projectDesc'), action: t('checklist.explore.projectAction'), onClick: () => navigateToSecretary('帮我创建一个名为「Markus探索」的项目，用于了解和体验Markus的各项能力') },
            { id: 'requirements', done: allRequirements.length > 0, label: t('checklist.explore.requirements'), desc: t('checklist.explore.requirementsDesc'), action: t('checklist.explore.requirementsAction'), onClick: () => navigateToSecretary('在「Markus探索」项目中创建两个需求：1. 了解Markus开源项目的架构和设计理念 2. 探索Markus智能体的能力和使用方式') },
            { id: 'agent', done: agents.length > 1, label: t('checklist.explore.agent'), desc: t('checklist.explore.agentDesc'), action: t('checklist.explore.agentAction'), onClick: () => navigateToSecretary('帮我招聘一个研究员（Researcher）智能体，用于信息收集和分析') },
            { id: 'team', done: teams.length > 0, label: t('checklist.explore.team'), desc: t('checklist.explore.teamDesc'), action: t('checklist.explore.teamAction'), onClick: () => navigateToSecretary('帮我组建一个名为「科技前沿智库」的团队，成员包括4位科技领袖角色的智能体：埃隆·马斯克（关注太空、电动车、AI安全）、史蒂夫·乔布斯（关注产品设计与用户体验）、山姆·奥特曼（关注AGI与AI创业生态）、黄仁勋（关注GPU、AI算力与数据中心）。团队目标是从不同视角分析科技前沿趋势。') },
          ];

          const allSteps = [...setupSteps, ...exploreSteps];
          const doneCount = allSteps.filter(s => s.done).length;
          const totalSteps = allSteps.length;
          const allRequiredDone = setupSteps.filter(s => !s.optional).every(s => s.done) && exploreSteps.every(s => s.done);

          if (allRequiredDone) return null;

          const renderStep = (step: typeof allSteps[0] & { optional?: boolean; isSetup?: boolean }) => (
            <div key={step.id} className="flex items-start gap-3 py-2.5 px-3 rounded-lg hover:bg-surface-elevated/50 transition-colors group">
              <div className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${step.done ? 'bg-green-500' : 'border-2 border-border-default'}`}>
                {step.done && (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium ${step.done ? 'text-fg-tertiary line-through' : 'text-fg-primary'}`}>{step.label}</span>
                  {'optional' in step && step.optional && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-surface-elevated text-fg-muted font-medium">{t('checklist.setup.optional')}</span>
                  )}
                </div>
                <p className={`text-[11px] mt-0.5 ${step.done ? 'text-fg-muted' : 'text-fg-tertiary'}`}>{step.desc}</p>
              </div>
              {step.done && step.isSetup ? (
                <button onClick={step.onClick} className="shrink-0 text-[11px] px-3 py-1.5 rounded-lg border border-border-default hover:bg-surface-elevated text-fg-secondary font-medium transition-colors opacity-0 group-hover:opacity-100">
                  {t('checklist.setup.update')}
                </button>
              ) : !step.done ? (
                <button onClick={step.onClick} className="shrink-0 text-[11px] px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors opacity-80 group-hover:opacity-100">
                  {step.action}
                </button>
              ) : null}
            </div>
          );

          return (
            <div className="bg-gradient-to-br from-brand-600/10 via-surface-secondary to-surface-secondary border border-brand-500/20 rounded-2xl p-5 sm:p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-fg-primary mb-1">{t('checklist.title')}</h3>
                  <p className="text-xs text-fg-secondary">{t('checklist.subtitle')}</p>
                </div>
                <button onClick={() => { setChecklistDismissed(true); localStorage.setItem('markus_checklist_dismissed', 'true'); }} className="text-fg-muted hover:text-fg-secondary transition-colors p-1 -mr-1 -mt-1" title="Dismiss">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>

              {/* Progress bar */}
              <div className="flex items-center gap-3 mb-5">
                <div className="flex-1 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
                  <div className="h-full bg-brand-500 rounded-full transition-all duration-500" style={{ width: `${(doneCount / totalSteps) * 100}%` }} />
                </div>
                <span className="text-[11px] text-fg-secondary font-medium shrink-0">{t('checklist.progress', { done: doneCount, total: totalSteps })}</span>
              </div>

              {/* Group A: System Setup */}
              <div className="mb-4">
                <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wider mb-1 px-3">{t('checklist.setup.title')}</p>
                <div className="space-y-0.5">{setupSteps.map(renderStep)}</div>
              </div>

              {/* Divider */}
              <div className="border-t border-border-default/50 my-3" />

              {/* Group B: Start Exploring */}
              <div>
                <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wider mb-1 px-3">{t('checklist.explore.title')}</p>
                <div className="space-y-0.5">{exploreSteps.map(renderStep)}</div>
              </div>
            </div>
          );
        })()}

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
                            onClick={() => navBus.navigate(PAGE.TEAM, { agentId: a.id })}>
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
                        {ops.taskKPI.recentActivity.slice(0, activityLimit).map(act => {
                          const pri = taskPriorityMap.get(act.taskId);
                          return (
                          <div key={act.taskId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-overlay/40 cursor-pointer transition-colors"
                            onClick={() => navBus.navigate(PAGE.WORK, { openTask: act.taskId })}>
                            <span className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${ACTIVITY_ICON_BG[act.status] ?? 'bg-gray-500/15'}`}>
                              <ActivityIcon status={act.status} />
                            </span>
                            <span className="text-[11px] text-fg-secondary truncate flex-1">{act.title}</span>
                            {(pri === 'urgent' || pri === 'high') && (
                              <PriorityBadge priority={pri} />
                            )}
                            <span className="text-[10px] text-fg-muted shrink-0">{formatRelativeTime(act.updatedAt, t)}</span>
                          </div>
                          );
                        })}
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
                    <button onClick={() => setShowWorkingModal(true)} className="text-[11px] text-brand-400 hover:text-brand-300 font-medium">{t('common:viewAll')}</button>
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

              {/* Teams section — only show when teams exist */}
              {teamSummaries.length > 0 && (
              <div className={`p-5 ${topPerformers.length > 0 ? 'pt-3 border-t border-border-subtle/50' : ''}`}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-fg-primary">{t('teamOverview.title')}</h3>
                  <button onClick={() => navBus.navigate(PAGE.TEAM)} className="text-[11px] text-brand-400 hover:text-brand-300 font-medium">{t('common:viewAll')}</button>
                </div>
                <div className="space-y-0.5">
                  {teamSummaries.slice(0, teamsLimit).map(ts => (
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
                  {teamsLimit < teamSummaries.length && (
                    <button onClick={() => navBus.navigate(PAGE.TEAM)}
                      className="w-full text-center text-[11px] text-brand-400 hover:text-brand-300 font-medium py-1.5">
                      +{teamSummaries.length - teamsLimit} more
                    </button>
                  )}
                </div>
              </div>
              )}
            </div>

          </div>
        </div>
      </div>

      {/* ── Working & Ranking Modal ── */}
      {showWorkingModal && ops && <WorkingModal workingAgents={workingAgentsList} rankedAgents={allRankedAgents} onClose={() => setShowWorkingModal(false)} t={t} />}

      {/* ── Health Modal ── */}
      {showHealthModal && (
        <HealthModal ops={ops} completed={completed} totalRootTasks={totalRootTasks}
          workingAgents={workingAgents} totalAgents={agents.length}
          usageInfo={usageInfo} storageInfo={storageInfo} cuQuota={cuQuota}
          onClose={() => setShowHealthModal(false)} t={t} />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Sub-components
// ═════════════════════════════════════════════════════════════════════════════

function MetricCard({ label, value, sub, icon, pulse, color, badge, onClick }: {
  label: string; value: string; sub?: string; icon: React.ReactNode; pulse?: boolean; color?: 'green' | 'amber' | 'red'; badge?: string; onClick?: () => void;
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
        {badge && <div className="text-[10px] text-amber-500 font-medium mt-1.5">{badge}</div>}
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

// ── Attention Icon ──────────────────────────────────────────────────────────

function AttentionIcon({ type }: { type: 'review' | 'approval' | 'blocked' }) {
  const color = type === 'review' ? '#3b82f6' : type === 'approval' ? '#f59e0b' : '#ef4444';
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {type === 'review' && <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>}
      {type === 'approval' && <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="18" x2="12" y2="12" /><line x1="9" y1="15" x2="15" y2="15" /></>}
      {type === 'blocked' && <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>}
    </svg>
  );
}

// ── Priority Badge ──────────────────────────────────────────────────────────

function PriorityBadge({ priority }: { priority: string }) {
  if (priority === 'urgent') {
    return <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-500/15 text-red-500 shrink-0 uppercase tracking-wide">!</span>;
  }
  if (priority === 'high') {
    return <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/15 text-amber-600 shrink-0 uppercase tracking-wide">H</span>;
  }
  return null;
}

// ── Deliverable Type Icon ───────────────────────────────────────────────────

function DeliverableTypeIcon({ type, artifactType }: { type: string; artifactType?: string }) {
  if (artifactType) {
    const c = artifactType === 'agent' ? '#8b5cf6' : artifactType === 'team' ? '#3b82f6' : '#f59e0b';
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
      </svg>
    );
  }
  const c = type === 'directory' ? '#3b82f6' : '#22c55e';
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {type === 'directory'
        ? <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        : <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>
      }
    </svg>
  );
}

// ── Working & Ranking Modal ─────────────────────────────────────────────────

type RankSortKey = 'tasks' | 'health' | 'tokens' | 'errors';
type RankedAgent = { agentId: string; agentName: string; role: string; agentRole: string; healthScore: number; tokenUsage: { input: number; output: number; cost: number }; taskMetrics: { completed: number; failed: number }; errorRate: number };

function WorkingModal({ workingAgents, rankedAgents, onClose, t }: {
  workingAgents: AgentInfo[];
  rankedAgents: RankedAgent[];
  onClose: () => void; t: TFunction;
}) {
  const [sortKey, setSortKey] = useState<RankSortKey>('tasks');
  const [sortAsc, setSortAsc] = useState(false);

  const toggleSort = useCallback((key: RankSortKey) => {
    if (key === sortKey) { setSortAsc(prev => !prev); }
    else { setSortKey(key); setSortAsc(false); }
  }, [sortKey]);

  const sorted = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    const cmp = (a: RankedAgent, b: RankedAgent): number => {
      switch (sortKey) {
        case 'tasks': return (b.taskMetrics.completed - a.taskMetrics.completed) * dir;
        case 'health': return (b.healthScore - a.healthScore) * dir;
        case 'tokens': return ((b.tokenUsage.input + b.tokenUsage.output) - (a.tokenUsage.input + a.tokenUsage.output)) * dir;
        case 'errors': return (b.errorRate - a.errorRate) * dir;
      }
    };
    return [...rankedAgents].sort(cmp);
  }, [rankedAgents, sortKey, sortAsc]);

  const colBtn = (key: RankSortKey, label: string, w: string) => (
    <button onClick={() => toggleSort(key)}
      className={`${w} text-center cursor-pointer transition-colors ${sortKey === key ? 'text-brand-400 font-bold' : ''}`}>
      {label}{sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''}
    </button>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-elevated rounded-xl border border-border-default shadow-2xl w-[600px] max-w-[90vw] max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border-default flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold">{t('ranking.title')}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-overlay transition-colors text-fg-tertiary hover:text-fg-primary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 scrollbar-thin">
          {/* Working agents section */}
          {workingAgents.length > 0 && (
            <div className="px-5 py-4 border-b border-border-default/50">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                <h4 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">{t('ranking.workingNow')}</h4>
                <span className="text-[10px] text-fg-muted">{workingAgents.length}</span>
              </div>
              <div className="space-y-0.5">
                {workingAgents.map(a => (
                  <div key={a.id} className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-surface-overlay/40 cursor-pointer transition-colors"
                    onClick={() => { onClose(); navBus.navigate(PAGE.TEAM, { agentId: a.id }); }}>
                    <Avatar name={a.name} avatarUrl={(a as any).avatarUrl} size={26} bgClass="bg-brand-600/30 text-brand-300" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-fg-primary truncate">{a.name}</div>
                      <div className="text-[10px] text-fg-tertiary truncate">{(a as any).currentActivity?.label ?? '—'}</div>
                    </div>
                    <span className="text-[10px] text-green-500 font-medium shrink-0">Working</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sortable ranking table header */}
          <div className="px-4 py-2 flex items-center gap-3 text-[10px] text-fg-tertiary uppercase tracking-wider font-medium border-b border-border-default/50 select-none">
            <span className="w-7 text-center">#</span>
            <span className="flex-1">{t('ranking.agent')}</span>
            {colBtn('health', t('ranking.health'), 'w-14')}
            {colBtn('tasks', t('ranking.tasks'), 'w-14')}
            {colBtn('tokens', t('ranking.tokens'), 'w-16')}
            {colBtn('errors', t('ranking.errorRate'), 'w-14')}
          </div>
          {sorted.map((agent, idx) => {
            const hc = agent.healthScore >= 80 ? 'text-green-500' : agent.healthScore >= 50 ? 'text-amber-500' : 'text-red-500';
            const ep = Math.round(agent.errorRate * 100);
            const medal = idx < 3 ? ['text-amber-400', 'text-gray-400', 'text-amber-600'][idx] : 'text-fg-tertiary';
            const totalTokens = agent.tokenUsage.input + agent.tokenUsage.output;
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
                <span className="w-16 text-center text-xs text-fg-secondary tabular-nums">{formatTokenCount(totalTokens)}</span>
                <span className={`w-14 text-center text-xs ${ep > 20 ? 'text-red-500' : ep > 5 ? 'text-amber-500' : 'text-green-500'}`}>{ep}%</span>
              </div>
            );
          })}
          {sorted.length === 0 && <div className="py-8 text-center text-xs text-fg-tertiary">{t('ranking.noData')}</div>}
        </div>
      </div>
    </div>
  );
}

// ── Health Modal ────────────────────────────────────────────────────────────

function HealthModal({ ops, completed, totalRootTasks, workingAgents, totalAgents, usageInfo, storageInfo, cuQuota, onClose, t }: {
  ops: OpsDashboard | null; completed: number; totalRootTasks: number;
  workingAgents: number; totalAgents: number;
  usageInfo: { llmTokens: number; storageBytes: number } | null;
  storageInfo: StorageInfo | null;
  cuQuota: { available: boolean; cuRemaining: number; cuLimit: number; cuUsedToday?: number } | null;
  onClose: () => void; t: TFunction;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-elevated rounded-xl border border-border-default shadow-2xl w-[400px] max-w-[90vw] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border-default flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('systemHealth.title')}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-overlay transition-colors text-fg-tertiary hover:text-fg-primary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div className="p-5 space-y-4">
          {ops && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-fg-secondary">{t('systemHealth.successRate')}</span>
                <span className="text-sm font-bold text-fg-primary">{Math.round(ops.taskKPI.successRate)}%</span>
              </div>
              <div className="h-2 rounded-full bg-surface-overlay/60 overflow-hidden">
                <div className="h-full rounded-full bg-green-500 transition-all duration-500" style={{ width: `${Math.round(ops.taskKPI.successRate)}%` }} />
              </div>
            </div>
          )}
          {ops && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-secondary">{t('metricCards.health')}</span>
              <span className={`text-sm font-bold ${ops.systemHealth.overallScore >= 80 ? 'text-green-500' : ops.systemHealth.overallScore >= 50 ? 'text-amber-500' : 'text-red-500'}`}>{ops.systemHealth.overallScore}%</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-fg-secondary">{t('systemHealth.tasksTotal')}</span>
            <span className="text-xs font-semibold text-fg-primary">{completed}/{totalRootTasks}</span>
          </div>
          {usageInfo && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-secondary">{t('systemHealth.tokenUsage')}</span>
              <span className="text-xs font-semibold text-fg-primary">{formatTokenCount(usageInfo.llmTokens)}</span>
            </div>
          )}
          {cuQuota?.available && cuQuota.cuLimit > 0 && (() => {
            const used = cuQuota.cuLimit - cuQuota.cuRemaining;
            const pct = Math.min(100, Math.round((used / cuQuota.cuLimit) * 100));
            const textColor = pct >= 95 ? 'text-red-500' : pct >= 80 ? 'text-amber-500' : 'text-green-500';
            const barColor = pct >= 95 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-green-500';
            return (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-fg-secondary">CU Quota</span>
                  <span className={`text-xs font-semibold ${textColor}`}>
                    {formatTokenCount(used)} / {formatTokenCount(cuQuota.cuLimit)} ({pct}%)
                  </span>
                </div>
                <div className="h-2 rounded-full bg-surface-overlay/60 overflow-hidden">
                  <div className={`h-full rounded-full ${barColor} transition-all duration-500`}
                    style={{ width: `${pct}%` }} />
                </div>
                {cuQuota.cuUsedToday != null && cuQuota.cuUsedToday > 0 && (
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-xs text-fg-tertiary">Today&apos;s CU Used</span>
                    <span className="text-xs font-semibold text-fg-secondary">{formatTokenCount(cuQuota.cuUsedToday)}</span>
                  </div>
                )}
              </div>
            );
          })()}
          {workingAgents > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-secondary">{t('systemHealth.currentWorking')}</span>
              <span className="text-xs font-semibold text-green-500">{workingAgents}/{totalAgents}</span>
            </div>
          )}
          {storageInfo && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-secondary">{t('systemHealth.storage')}</span>
              <span className="text-xs font-semibold text-fg-primary">{fmtBytes(storageInfo.totalSize)}</span>
            </div>
          )}
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
