import { useEffect, useState, useRef, useCallback, useMemo, lazy, Suspense, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api, wsClient, hubApi, kebab } from '../api.ts';
import type { AgentDetail, AgentToolInfo, AgentMemorySummary, AgentHeartbeatInfo, TaskInfo, TaskLogEntry, AgentUsageInfo, ExternalAgentInfo, ActivitySummary, AgentActivityLogEntry, ActivityRecord, AgentActivityType, RoleUpdateStatus, StorageAgentItem, AuthUser, DeliverableInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { ExecEntryRow, StreamingText, filterCompletedStarts, attachSubagentLogsToEntries, CompactExecutionCard, FullExecutionLog, type ExecEntry, type ToolCallInfo, type ExecutionStreamEntryUI } from '../components/ExecutionTimeline.tsx';
import { taskLogToStreamEntry, activityLogToStreamEntry } from '../api.ts';
import { resolveTokensToday, visibleStorageBuckets, storageBucketLabelKey, agentStatusPresentation, recentActivityRows, splitRecentActivity, RECENT_ACTIVITY_FETCH_LIMIT, OVERVIEW_SECTION_IDS, resolveOverviewSection, deliverableClickTarget, type OverviewSectionId } from '../lib/agentOverview.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { Avatar } from '../components/Avatar.tsx';
import { ConfirmModal } from '../components/ConfirmModal.tsx';
import { friendlyAgentError } from './ChatComponents.tsx';
import { DELIVERABLE_TYPE_META, DELIVERABLE_STATUS_META } from '../components/DeliverableDetailModal.tsx';
import { getToolMeta } from '../components/execution-utils.ts';
import { categorizeTools } from '../lib/toolCategories.ts';
import { NamedIcon } from '../lib/namedIcons.tsx';
import { sliceNotebookForDisplay, formatNotebookAge, NOTEBOOK_DISPLAY_LIMIT } from '../lib/notebookDisplay.ts';
import { useLayout } from '../contexts/LayoutContext.tsx';

const LazyMarkdownMessage = lazy(() => import('../components/MarkdownMessage.tsx').then(m => ({ default: m.MarkdownMessage })));

interface Props { agentId: string; onBack: () => void; inline?: boolean; defaultTab?: ProfileTab; onSwipeBack?: () => void; highlightMailboxId?: string; authUser?: AuthUser; headless?: boolean; activeTab?: ProfileTab; initialSection?: OverviewSectionId }

export type ProfileTab = 'overview' | 'mind' | 'files' | 'tools' | 'memory' | 'deliverables';

/**
 * 概览页分组标识（现在渲染为**子 tab**）。
 * 规范定义在 `lib/agentOverview.ts`（`OVERVIEW_SECTION_IDS` 与之同源），此处只转发，
 * 供 Team.tsx 沿用——避免「页面一份、测试一份」两处定义漂移。
 */
export type { OverviewSectionId };

/** 旧的 tab 标识 → 概览分组：历史深链（如 Work 页的 profileTab:'mind'）继续有效。 */
export const LEGACY_TAB_SECTION: Partial<Record<ProfileTab, OverviewSectionId>> = {
  mind: 'mind',
  files: 'files',
  tools: 'tools',
  memory: 'memory',
};

/**
 * Tab 栅只保留少数入口（聊天在主区，见 Team.tsx 的 AGENT_TABS）。
 *
 * 【为什么下面的四组不是「搬到概览」而是「收进概览」】砍 tab 本身不减少内容，
 * 只会把内容搬到一个更长的页面上——用户会从「选哪个 tab」变成「滚不完的一页」。
 * 所以原 mind / files / tools / memory 的正文没有堆在概览里，而是变成概览页里
 * **默认收起、展开才挂载**的折叠分组（见 OverviewTab 与 CollapsibleSection）。
 */
export const TAB_DEF: Array<{ key: ProfileTab; icon: string }> = [
  { key: 'overview', icon: '▦' },
  { key: 'deliverables', icon: '📦' },
];

function taskStatusLabel(status: string, t: TFunction): string {
  return t(`agent:profilePage.taskStatus.${status}`, { defaultValue: status.replace(/_/g, ' ') });
}

/**
 * Label for a process status, delegated to the shared presentation table so this
 * page and the chat header badge cannot disagree about what "offline" means.
 *
 * The previous local map coloured `paused` (its dot map had the entry) but had no
 * label for it, so a paused agent would have rendered the raw English token
 * "paused" to the user.
 */
function agentRuntimeStatusLabel(status: string, t: TFunction): string {
  const { labelKey } = agentStatusPresentation(status);
  return labelKey ? t(labelKey) : status;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function AgentProfile({ agentId, onBack, inline, defaultTab, onSwipeBack, highlightMailboxId, authUser, headless, activeTab: externalTab, initialSection }: Props) {
  const { t } = useTranslation(['agent', 'common']);
  const isMobile = useIsMobile();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string; variant?: 'primary' | 'danger' } | null>(null);
  const [tab, setTab] = useState<ProfileTab>(defaultTab ?? 'overview');
  const effectiveTab = headless && externalTab ? externalTab : tab;
  const [externalInfo, setExternalInfo] = useState<ExternalAgentInfo | null>(null);
  const tabs = useMemo(() => TAB_DEF.map(tabDef => ({ ...tabDef, label: t(`agent:tabs.${tabDef.key}`) })), [t]);
  const profileTabsList = useMemo(() => tabs.map(tabRow => ({ id: tabRow.key })), [tabs]);
  const swipeOpts = useMemo(() => ({ onSwipeOutLeft: onSwipeBack }), [onSwipeBack]);
  const profileSwipe = useSwipeTabs(profileTabsList, tab, setTab, swipeOpts);
  const tabBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = tabBarRef.current;
    if (!bar) return;
    const active = bar.querySelector('[data-active="true"]') as HTMLElement | null;
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [tab]);

  const reload = useCallback(() => { api.agents.get(agentId).then(setAgent).catch(() => {}); }, [agentId]);

  useEffect(() => {
    setTab(defaultTab ?? 'overview');
    setExternalInfo(null);
    reload();
    api.externalAgents.list().then(d => {
      const match = d.agents.find(ea => ea.markusAgentId === agentId);
      setExternalInfo(match ?? null);
    }).catch(() => {});
    const unsub = wsClient.on('agent:update', (evt) => {
      if ((evt.payload as Record<string, string>).agentId === agentId) reload();
    });
    return unsub;
  }, [agentId, reload]);

  if (!agent) return <div className="flex-1 flex items-center justify-center text-fg-tertiary text-sm">{t('agent:profilePage.loadingAgent')}</div>;

  const statusDot = agentStatusPresentation(agent.state.status).dotClass;
  const canManageAgents = authUser?.role === 'owner' || authUser?.role === 'admin';
  // 「概览」与「心智」各自只渲染自己那一段。两者曾经被同一个条件一起渲染（根源是
  // mind 从未出现在 TAB_DEF / AGENT_TABS 里），结果概览页上出现两颗停止按钮、
  // 两个「空闲」。外部（网关）Agent 没有 mailbox/注意力循环，只有概览。
  //
  // 概览吸收了原 mind / files / tools / memory 四个 tab 的正文。旧深链（Work 页的
  // profileTab:'mind' 等）依然有效：落到概览，并自动展开对应分组。
  const sectionForTab = (tabId: ProfileTab): OverviewSectionId | undefined =>
    initialSection ?? LEGACY_TAB_SECTION[tabId];
  const bodyTabFor = (tabId: ProfileTab): ProfileTab =>
    externalInfo || LEGACY_TAB_SECTION[tabId] ? 'overview' : tabId;
  // 内联（非 headless）页自带的 tab 栅也会传入 defaultTab，同样需要归一。
  const localLegacySection = LEGACY_TAB_SECTION[tab];

  if (headless) {
    return (
      <div className="flex-1 overflow-y-auto bg-surface-primary">
        <div className="p-5">
          {bodyTabFor(effectiveTab) === 'overview' && (
            <OverviewTab agent={agent} onUpdate={reload} externalInfo={externalInfo} t={t} canManageAgents={canManageAgents} highlightMailboxId={highlightMailboxId} initialSection={sectionForTab(effectiveTab)} />
          )}
          {bodyTabFor(effectiveTab) === 'deliverables' && <DeliverablesTab agentId={agentId} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-surface-primary">
      <div className="px-5 py-3.5 bg-surface-secondary sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Avatar name={agent.name} avatarUrl={agent.avatarUrl} size={40} className="rounded-xl" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold">{agent.name}</h2>
              <span className={`w-2 h-2 rounded-full ${statusDot}`} />
              <span className="text-xs text-fg-tertiary">{agentRuntimeStatusLabel(agent.state.status, t)}</span>
              {externalInfo && <span className="px-1.5 py-0.5 text-[10px] bg-brand-500/15 text-brand-500 rounded font-medium">{t('agent:profilePage.badges.external')}</span>}
              {agent.agentRole === 'manager' && <span className="px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-600 rounded font-medium">{t('agent:profilePage.badges.manager')}</span>}
            </div>
            <div className="text-xs text-fg-tertiary truncate">{agent.role}{agent.roleDescription ? ` — ${agent.roleDescription}` : ''}</div>
          </div>
          <div className="flex gap-1.5 shrink-0">
            {!inline && <button onClick={() => navBus.navigate(PAGE.TEAM, { agentId })} className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors flex items-center gap-1"><span>◈</span> {t('agent:profilePage.chat')}</button>}
            {canManageAgents && (
            <button onClick={async () => {
              if (!agent) return;
              try {
                const { filesMap } = await api.agents.getFilesMap(agentId);
                const config = {
                  type: 'agent' as const,
                  name: kebab(agent.name, agent.name),
                  displayName: agent.name,
                  version: '1.0.0',
                  description: agent.roleDescription ?? agent.role,
                  author: '',
                  category: 'general',
                  tags: [] as string[],
                  agent: { roleName: agent.role, agentRole: agent.agentRole as 'manager' | 'worker' },
                  dependencies: { skills: agent.skills ?? [] },
                };
                await hubApi.publishViaProxy({ itemType: 'agent', name: agent.name, description: config.description, category: 'general', config, files: filesMap });
                setNotice({ title: t('agent:profilePage.hub'), message: t('agent:profilePage.publishSuccess', { name: agent.name }), variant: 'primary' });
              } catch (e) {
                setNotice({ title: t('agent:profilePage.hub'), message: t('agent:profilePage.publishFailed', { error: String(e) }), variant: 'danger' });
              }
            }} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors flex items-center gap-1" title={t('agent:profilePage.publishTitle')}><span>↑</span> {t('agent:profilePage.hub')}</button>
            )}
            {inline && <button onClick={onBack} className="p-1.5 text-fg-tertiary hover:text-fg-secondary text-lg leading-none">×</button>}
          </div>
        </div>
        <div ref={tabBarRef} className="flex gap-1 mt-3 -mb-[1px] overflow-x-auto scrollbar-hide">
          {tabs.filter(tabRow => !externalInfo || tabRow.key === 'overview').map(tabRow => (
            <button key={tabRow.key} onClick={() => setTab(tabRow.key)} data-active={tab === tabRow.key}
              className={`px-3 py-1.5 text-xs rounded-t-lg border border-b-0 transition-colors whitespace-nowrap ${
                tab === tabRow.key ? 'bg-surface-primary text-fg-primary border-border-default' : 'text-fg-tertiary border-transparent hover:text-fg-secondary hover:bg-surface-elevated/50'
              }`}
            ><span className="mr-1">{tabRow.icon}</span>{tabRow.label}</button>
          ))}
        </div>
      </div>
      <div className="p-5" onTouchStart={isMobile ? profileSwipe.onTouchStart : undefined} onTouchEnd={isMobile ? profileSwipe.onTouchEnd : undefined}>
        {bodyTabFor(tab) === 'overview' && (
          <OverviewTab agent={agent} onUpdate={reload} externalInfo={externalInfo} t={t} canManageAgents={canManageAgents} highlightMailboxId={highlightMailboxId} initialSection={initialSection ?? localLegacySection} />
        )}
        {bodyTabFor(tab) === 'deliverables' && <DeliverablesTab agentId={agentId} />}
      </div>
      {notice && (
        <ConfirmModal
          alertOnly
          variant={notice.variant ?? 'primary'}
          title={notice.title}
          message={notice.message}
          onConfirm={() => setNotice(null)}
          onCancel={() => setNotice(null)}
        />
      )}
    </div>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────────────────

// ─── Overview section shell (sub-tabs) ───────────────────────────────────────

/**
 * 概览分组的子 tab 栏。
 *
 * 【为什么从「折叠块」改成「子 tab」】折叠块要求「展开 A → 看完 → 收起 A → 向下滚很远
 * → 展开 B」。分组越多越痛：看第二组之前先要做两次无意义操作，滚动位置还得重新找。
 * 子 tab 让每一组都在一次点击之外，且当前组永远出现在同一个位置。
 *
 * 【内容区依然「只挂载当前组」】被收进来的四组（心智 / 文件 / 能力 / 记忆）各自都会发
 * 请求。若六组全部挂载、只用 CSS 隐藏，打开概览就等于同时打六组接口——那就把
 * 「入口太多」换成了「页面卡」。所以只有 `section` 选中的那一组会被渲染。
 *
 * 窄屏横向滚动、不换行：行数固定，切换时内容区的位置才不会跳。
 */
function OverviewSectionTabs({ section, onChange, t }: {
  section: OverviewSectionId; onChange: (id: OverviewSectionId) => void; t: TFunction;
}) {
  return (
    <div
      role="tablist"
      className="flex border-b border-border-default overflow-x-auto scrollbar-hide"
      // 窄屏下这一栏要能横向滑动；而它位于「整页切 tab」滑动容器的内部，手势会冒泡上去
      // ——于是想滑 tab 栅时会跳到「产出」。拦在这里：栅自己滚，页面不切。
      onTouchStart={e => e.stopPropagation()}
      onTouchEnd={e => e.stopPropagation()}
    >
      {OVERVIEW_SECTION_IDS.map(id => {
        const active = id === section;
        const hint = t(`agent:profilePage.overview.sections.${id}.hint`, { defaultValue: '' });
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            title={hint || undefined}
            onClick={() => onChange(id)}
            className={`px-3 py-2 text-xs whitespace-nowrap border-b-2 transition-colors cursor-pointer ${
              active
                ? 'border-brand-500 text-fg-primary font-medium'
                : 'border-transparent text-fg-tertiary hover:text-fg-secondary'
            }`}
          >
            {t(`agent:profilePage.overview.sections.${id}.title`)}
          </button>
        );
      })}
    </div>
  );
}

/** 子 tab 的内容容器：六组共用同一外壳，保证切换时内容区位置不跳。 */
function SectionPanel({ children }: { children: React.ReactNode }) {
  return (
    <div role="tabpanel" className="border border-border-default rounded-xl bg-surface-elevated/30 p-4">
      {children}
    </div>
  );
}

/** 单条活动（心跳 / A2A 共用）。两个列表原先各自烤了一份完全一样的行标记。 */
function ActivityRow({ agentId, act, dotClass, expanded, onToggle }: {
  agentId: string; act: ActivityRecord; dotClass: string; expanded: boolean; onToggle: () => void;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-elevated/40 cursor-pointer"
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
        <span className="text-xs text-fg-secondary flex-1 truncate">{act.label}</span>
        <span className="text-[10px] text-fg-tertiary shrink-0">{new Date(act.startedAt).toLocaleString()}</span>
        <span className="text-fg-tertiary text-[10px]">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="border-t border-border-default/60 bg-surface-primary/40">
          <ActivityLog agentId={agentId} activityId={act.id} />
        </div>
      )}
    </div>
  );
}

function OverviewTab({ agent, onUpdate, externalInfo, t, canManageAgents, highlightMailboxId, initialSection }: { agent: AgentDetail; onUpdate: () => void; externalInfo?: ExternalAgentInfo | null; t: TFunction; canManageAgents: boolean; highlightMailboxId?: string; initialSection?: OverviewSectionId }) {
  const [usageInfo, setUsageInfo] = useState<AgentUsageInfo | null>(null);
  // 持久化活动历史（SQLite），不是内存里的「此刻在跑」。类型见 api.ts 的 ActivityRecord。
  const [recentActivities, setRecentActivities] = useState<ActivityRecord[]>([]);
  const [expandedActivityId, setExpandedActivityId] = useState<string | null>(null);
  const [agentStorage, setAgentStorage] = useState<StorageAgentItem | null>(null);
  const [agentDataDir, setAgentDataDir] = useState('');
  const [activeTasks, setActiveTasks] = useState<TaskInfo[]>([]);
  // 排队消息数（mailbox 待处理）——用于 working 但无执行中任务时说明「在哪忙」
  const [queuedCount, setQueuedCount] = useState(0);

  // 概览子 tab（原先是折叠块）。落组规则见 resolveOverviewSection：
  // highlightMailboxId 优先（它指向的 mailbox 项只存在于「运行与注意力」），
  // 其次旧深链的 initialSection（profileTab:'mind' 等），否则第一组。
  const [section, setSection] = useState<OverviewSectionId>(
    () => resolveOverviewSection(initialSection, highlightMailboxId),
  );
  // 组件已挂载后再跳同一个入口（例如从 Work 页再次点「查看心智」）也要切过去，
  // 否则第二次点击不会有任何反应——这正是旧实现 defaultOpen 只在挂载时生效的毛病。
  useEffect(() => {
    setSection(resolveOverviewSection(initialSection, highlightMailboxId));
  }, [initialSection, highlightMailboxId]);

  // `agent.state.activeTaskIds` 每次 reload 都是新数组，直接把它当依赖会让这个
  // effect（内含 5 个请求，包括整组织目录扫描）在每次父组件重渲染时重跑。按内容做 key。
  const activeTaskIdsKey = (agent.state.activeTaskIds ?? []).join(',');

  useEffect(() => {
    api.usage.agents().then(d => {
      const info = d.agents.find(a => a.agentId === agent.id);
      if (info) setUsageInfo(info);
    }).catch(() => {});
    // 【为什么不用 /recent-activities】该接口返回的是 liveActivities()——内存中
    // 「此刻正在执行」的活动。它没有历史：agent 一空闲就返回空数组，于是标题写着
    // 「最近活动」的卡片只在 agent 正在干活时才有内容。持久化历史一直在写
    // （agent_activities 表），只是从来没被这个面板读过。
    api.agents.getActivities(agent.id, { limit: RECENT_ACTIVITY_FETCH_LIMIT })
      .then(d => setRecentActivities(d.activities)).catch(() => {});
    api.system.storage().then(info => {
      setAgentDataDir(info.dataDir + '/agents/' + agent.id);
      const match = info.agents.find(a => a.id === agent.id);
      if (match) setAgentStorage(match);
    }).catch(() => {});
    if (agent.state.activeTaskIds?.length) {
      api.tasks.list({ assignedAgentId: agent.id }).then(d => {
        setActiveTasks(d.tasks.filter(t => agent.state.activeTaskIds?.includes(t.id)));
      }).catch(() => {});
    }
    // 忙碌但无执行中任务时，显示 mailbox 排队情况（深度分拣/处理消息中）
    api.agents.getMailbox(agent.id, { limit: 1 }).then(mb => {
      setQueuedCount(mb.queued?.length ?? 0);
    }).catch(() => {});
  }, [agent.id, activeTaskIdsKey, agent.state.status]);

  const toggleAgent = () => {
    if (agent.state.status === 'offline') api.agents.start(agent.id).then(onUpdate);
    else api.agents.stop(agent.id).then(onUpdate);
  };

  const GATEWAY_ENDPOINTS = useMemo(() => [
    { method: 'POST' as const, path: '/api/gateway/sync', desc: t('agent:profilePage.gateway.sync') },
    { method: 'GET' as const, path: '/api/gateway/manual', desc: t('agent:profilePage.gateway.manual') },
    { method: 'GET' as const, path: '/api/gateway/team', desc: t('agent:profilePage.gateway.team') },
    { method: 'GET' as const, path: '/api/gateway/projects', desc: t('agent:profilePage.gateway.projects') },
    { method: 'GET' as const, path: '/api/gateway/requirements', desc: t('agent:profilePage.gateway.requirements') },
  ], [t]);
  const SYNC_CONTEXT_FIELDS = useMemo(() => [
    { field: 'assignedTasks', desc: t('agent:profilePage.syncContext.assignedTasks') },
    { field: 'inboxMessages', desc: t('agent:profilePage.syncContext.inboxMessages') },
    { field: 'teamContext', desc: t('agent:profilePage.syncContext.teamContext') },
    { field: 'projectContext', desc: t('agent:profilePage.syncContext.projectContext') },
  ], [t]);

  if (externalInfo) {
    return (
      <div className="space-y-4">
        <Card title={t('agent:profilePage.overview.identity')}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <KV label={t('agent:profilePage.overview.labels.name')}>{agent.name}</KV>
            <KV label={t('agent:profilePage.overview.labels.agentRole')}>
              <span className={agent.agentRole === 'manager' ? 'text-amber-600' : 'text-blue-600'}>{agent.agentRole === 'manager' ? t('agent:profilePage.roles.managerDisplay') : t('agent:profilePage.roles.workerDisplay')}</span>
            </KV>
            <KV label={t('agent:profilePage.overview.labels.roleTemplate')}>{agent.role}</KV>
            <KV label={t('agent:profilePage.overview.labels.markusAgentId')} mono>{agent.id}</KV>
            <KV label={t('agent:profilePage.overview.labels.organization')}>{agent.config?.orgId ?? 'default'}</KV>
            <KV label={t('agent:profilePage.overview.labels.created')}>{agent.config?.createdAt ? new Date(agent.config.createdAt).toLocaleDateString() : t('agent:profilePage.emDash')}</KV>
          </div>
        </Card>

        <Card title={t('agent:profilePage.overview.connectionStatus')}>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
            <StatBox label={t('agent:profilePage.overview.labels.connection')} value={externalInfo.connected ? t('common:status.online') : t('common:status.offline')} color={externalInfo.connected ? 'green' : 'gray'} />
            <StatBox label={t('agent:profilePage.overview.labels.platform')} value={t('agent:profilePage.overview.openClaw')} />
            <StatBox label={t('agent:profilePage.overview.labels.activeTasks')} value={String(agent.state.activeTaskIds?.length ?? 0)} />
            <StatBox label={t('agent:profilePage.overview.labels.lastSync')} value={externalInfo.lastHeartbeat ? new Date(externalInfo.lastHeartbeat).toLocaleTimeString() : t('agent:profilePage.never')} />
          </div>
        </Card>

        <Card title={t('agent:profilePage.overview.externalAgentDetails')}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <KV label={t('agent:profilePage.overview.labels.externalAgentId')} mono>{externalInfo.externalAgentId}</KV>
            <KV label={t('agent:profilePage.overview.labels.registered')}>{new Date(externalInfo.registeredAt).toLocaleString()}</KV>
            <KV label={t('agent:profilePage.overview.labels.capabilities')}>{externalInfo.capabilities.length > 0 ? externalInfo.capabilities.join(', ') : t('agent:profilePage.overview.noneDeclared')}</KV>
            <KV label={t('agent:profilePage.overview.labels.lastHeartbeat')}>{externalInfo.lastHeartbeat ? new Date(externalInfo.lastHeartbeat).toLocaleString() : t('agent:profilePage.never')}</KV>
          </div>
        </Card>

        <Card title={t('agent:profilePage.overview.syncContextTitle')}>
          <div className="space-y-1.5">
            {SYNC_CONTEXT_FIELDS.map(f => (
              <div key={f.field} className="flex items-start gap-2.5 px-3 py-2 rounded-lg bg-surface-elevated">
                <span className="font-mono text-[10px] text-brand-500 shrink-0 pt-0.5">{f.field}</span>
                <span className="text-[10px] text-fg-tertiary">{f.desc}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title={t('agent:profilePage.overview.gatewayEndpoints')}>
          <div className="space-y-1.5">
            {GATEWAY_ENDPOINTS.map(ep => (
              <div key={ep.path} className="flex items-start gap-2.5 px-3 py-2 rounded-lg bg-surface-elevated">
                <span className={`text-[10px] font-semibold shrink-0 pt-0.5 ${ep.method === 'POST' ? 'text-amber-600' : 'text-green-600'}`}>{ep.method}</span>
                <span className="font-mono text-[10px] text-fg-secondary shrink-0 pt-0.5">{ep.path}</span>
                <span className="text-[10px] text-fg-tertiary ml-auto">{ep.desc}</span>
              </div>
            ))}
          </div>
        </Card>

      </div>
    );
  }

  // 活动列表来自持久化历史（服务端按 started_at DESC 返回）。分组规则见
  // splitRecentActivity——A2A 组只认 'a2a'，不认 'chat'（后者是人类会话，
  // 在「聊天」tab 里有完整历史）。recentActivityRows 再统一排序 + 截断。
  const { heartbeats: heartbeatRows, comms: commRows } = splitRecentActivity(recentActivities);
  const heartbeats = recentActivityRows(heartbeatRows);
  const comms = recentActivityRows(commRows);
  const activeN = agent.state.activeTaskIds?.length ?? 0;
  // 列表只显示前几条（OVERVIEW_ACTIVITY_LIMIT），所以「共多少次」要单独给出来，
  // 否则看到 5 行会以为只有 5 次。
  // 计数是「窗口内」的条数，不是全历史总数——所以先把窗口说清楚，否则 N 会被
  // 读成「这个 agent 一共跑过 N 次」。
  const recentCaption = [
    recentActivities.length > 0 ? t('agent:profilePage.overview.recentWindow', { count: recentActivities.length }) : null,
    heartbeats.total > 0 ? t('agent:profilePage.overview.heartbeatRuns', { count: heartbeats.total }) : null,
    comms.total > 0 ? t('agent:profilePage.overview.a2aRuns', { count: comms.total }) : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="space-y-4">
      {/* Compact identity row */}
      <div className="bg-surface-elevated rounded-xl px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <KV label={t('agent:profilePage.overview.labels.roleTemplate')}>{agent.role}</KV>
        <KV label={t('agent:profilePage.overview.labels.agentRole')}>
          <span className={agent.agentRole === 'manager' ? 'text-amber-600' : 'text-blue-600'}>{agent.agentRole === 'manager' ? t('agent:profilePage.roles.managerDisplay') : t('agent:profilePage.roles.workerDisplay')}</span>
        </KV>
        <KV label={t('agent:profilePage.overview.labels.agentId')} mono>{agent.id}</KV>
        <KV label={t('agent:profilePage.overview.labels.model')}>
          {agent.effectiveModel?.model
            ? <span className="inline-flex items-center gap-1.5">
                <span className="font-mono">{agent.effectiveModel.model}</span>
                {agent.config?.llmConfig?.modelMode === 'custom' && agent.effectiveModel.source !== 'override'
                  ? <span className="px-1.5 py-0.5 text-[10px] bg-brand-500/15 text-brand-500 rounded font-medium">{t('agent:profilePage.overview.labels.badgeAgentModel')}</span>
                  : agent.effectiveModel.source === 'override'
                    ? <span className="px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-600 rounded font-medium">{t('agent:profilePage.overview.labels.badgeSessionModel')}</span>
                    : null}
              </span>
            : <span className="text-fg-tertiary">{t('agent:profilePage.overview.labels.followsGlobal')}</span>}
        </KV>
        <KV label={t('agent:profilePage.overview.labels.created')}>{agent.config?.createdAt ? new Date(agent.config.createdAt).toLocaleDateString() : t('agent:profilePage.emDash')}</KV>
      </div>

      {/* Runtime + Usage + Storage in a single compact card */}
      <div className="bg-surface-elevated rounded-xl px-4 py-3 space-y-3">
        {/* 运行时事实行。
            【为什么不在这里再画一次状态】进程状态已经由 Team Chat 顶部那颗常驻徽标
            展示（同页可见、不随滚动消失）。这里再画一遍，一页上就出现两个「空闲」；
            而且两者来源不同、可能互相矛盾（徽标曾把 offline 画成绿色「空闲」）。
            页面内这一行只回答三个问题：用了多少、手里有几个活、怎么启停。 */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <StatBox label={t('agent:profilePage.overview.labels.tokensToday')} value={fmtNum(resolveTokensToday(usageInfo, agent.state.tokensUsedToday))} />
          <StatBox label={t('agent:profilePage.overview.labels.activeTasks')} value={String(activeN)} color={activeN > 0 ? 'blue' : undefined} />
          {/* 「上次心跳」已从概览移除：它读的是 agent.state.lastHeartbeat（进程内、
              重启即丢，因此常年显示「从未」，而该 agent 的 metrics 里有 2000 条心跳记录），
              而「心跳」tab 用 /agents/:id/heartbeat 已经给出准确的上次心跳与下次唤醒。
              同一个数字留两处、其中一处是错的，只会让人怀疑整个面板。 */}
          {canManageAgents && (
            <button onClick={toggleAgent} className="ml-auto px-3 py-1 text-xs border border-border-default rounded-lg hover:border-brand-500 transition-colors shrink-0">
              {agent.state.status === 'offline' ? t('agent:profilePage.overview.startAgent') : t('agent:profilePage.overview.stopAgent')}
            </button>
          )}
        </div>

        {agent.state.status === 'error' && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-red-500">{t('agent:profilePage.overview.errorDetails')}</span>
              {agent.state.lastErrorAt && <span className="text-[10px] text-red-500/50 ml-auto">{new Date(agent.state.lastErrorAt).toLocaleString()}</span>}
            </div>
            <pre className="text-[11px] text-red-500/80 leading-relaxed whitespace-pre-wrap break-all font-mono bg-red-500/5 rounded p-2">
              {friendlyAgentError(agent.state.lastError, t) || agent.state.lastError || t('agent:profilePage.overview.errorFallback')}
            </pre>
          </div>
        )}

        {agent.state.status === 'working' && (activeN > 0 || queuedCount > 0 || agent.runtime?.activityLabel) && (
          <div className="bg-brand-500/10 border border-brand-500/20 rounded-lg p-2.5">
            <div className="space-y-1.5">
              {agent.runtime?.activityLabel && (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse shrink-0" />
                  <span className="text-fg-secondary truncate flex-1">{agent.runtime.activityLabel}</span>
                  {agent.runtime.activityType && (
                    <span className="text-fg-tertiary capitalize shrink-0">{agent.runtime.activityType}</span>
                  )}
                </div>
              )}
              {activeTasks.map(task => (
                <div key={task.id} className="flex items-center gap-2 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse shrink-0" />
                  <span className="text-fg-secondary truncate flex-1">{task.title}</span>
                  <span className="text-fg-tertiary capitalize shrink-0">{taskStatusLabel(task.status, t)}</span>
                </div>
              ))}
              {queuedCount > 0 && (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                  <span className="text-fg-secondary flex-1">{t('agent:profilePage.overview.mailboxQueued', { count: queuedCount })}</span>
                </div>
              )}
            </div>
          </div>
        )}

      </div>

      {/* 概览分组改成了子 tab：切组只有一次点击，不需要「收起上一组 → 向下滚很远」。 */}
      <OverviewSectionTabs section={section} onChange={setSection} t={t} />

      {section === 'usage' && (
        <SectionPanel>
          {/* 用量与存储明细。
              这里全是一次性/累计遥测：真要查的时候有用，一瞥面板时是噪音。
              【为什么不显示 提示/补全 Token】这两个计数器加起来 ≠ 总数
              （实测 3.03B vs 2.65B），因为 38,235 次请求里只有 590 次带过 provider
              上报的 prompt 计数，且 getUsageStats() 在计数器为 0 时会用写死的
              70/30 比例**编造**这两个值。一个加不起来的分解，看的人只会认为是面板
              坏了。与其加免责说明，不如不显示。 */}
          {(usageInfo || agentStorage) ? (
            <div className="space-y-2">
                {usageInfo && (
                  <div className="space-y-1">
                    <p className="text-[10px] text-fg-tertiary">{t('agent:profilePage.overview.lifetimeCaption')}</p>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
                      <StatBox label={t('agent:profilePage.overview.labels.totalTokens')} value={fmtNum(usageInfo.totalTokens)} />
                      <StatBox label={t('agent:profilePage.overview.labels.requests')} value={String(usageInfo.requestCount)} />
                      <StatBox label={t('agent:profilePage.overview.labels.toolCalls')} value={String(usageInfo.toolCalls)} />
                    </div>
                  </div>
                )}
                {agentStorage && (
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
                      <StatBox label={t('agent:profilePage.overview.storage')} value={fmtBytesLocal(agentStorage.size)} />
                      {visibleStorageBuckets(agentStorage.subItems).map(sub => {
                        const labelKey = storageBucketLabelKey(sub.name);
                        // 子项标题用真实目录名（服务端不再改写标签），已知的走 i18n，
                        // 未知的直接显示目录名——新目录会以正确的名字出现，而不是被漏掉。
                        return <StatBox key={sub.name} label={labelKey ? t(labelKey) : sub.name} value={fmtBytesLocal(sub.size)} />;
                      })}
                      <button onClick={() => void api.system.openPath(agentDataDir)}
                        className="text-[10px] text-fg-tertiary hover:text-fg-secondary ml-auto">{t('agent:profilePage.overview.openFolder')} →</button>
                    </div>
                    {agentStorage.depthLimited && (
                      // 目录遍历有深度上限（无上限的全量遍历在本机要 60s 以上），
                      // 所以这是下界而非精确值。与其把有上限的估算当精确数字展示，
                      // 不如说明它是什么。
                      <p className="text-[10px] text-fg-tertiary">{t('agent:profilePage.overview.storageDepthLimited')}</p>
                    )}
                  </div>
                )}
              </div>
          ) : (
            <p className="text-xs text-fg-tertiary">{t('agent:profilePage.overview.sections.usage.empty')}</p>
          )}
        </SectionPanel>
      )}

      {/* 最近活动 —— 心跳与 A2A 的遥测。 */}
      {section === 'recent' && (
        <SectionPanel>
          {recentCaption && <p className="text-[10px] text-fg-tertiary mb-2">{recentCaption}</p>}
          {heartbeats.total > 0 && (
            <div>
              <h4 className="text-[10px] text-fg-tertiary uppercase tracking-wider mb-1">{t('agent:profilePage.overview.recentHeartbeats')}</h4>
              <div className="divide-y divide-gray-800/50">
                {heartbeats.shown.map(act => (
                  <ActivityRow key={act.id} agentId={agent.id} act={act} dotClass="bg-green-400"
                    expanded={expandedActivityId === act.id}
                    onToggle={() => setExpandedActivityId(expandedActivityId === act.id ? null : act.id)} />
                ))}
              </div>
            </div>
          )}
          {comms.total > 0 && (
            <div className="mt-3">
              <h4 className="text-[10px] text-fg-tertiary uppercase tracking-wider mb-1">{t('agent:profilePage.overview.recentA2A')}</h4>
              <div className="divide-y divide-gray-800/50">
                {comms.shown.map(act => (
                  <ActivityRow key={act.id} agentId={agent.id} act={act} dotClass="bg-blue-400"
                    expanded={expandedActivityId === act.id}
                    onToggle={() => setExpandedActivityId(expandedActivityId === act.id ? null : act.id)} />
                ))}
              </div>
            </div>
          )}
          {heartbeats.total === 0 && comms.total === 0 && (
            <p className="text-xs text-fg-tertiary">{t('agent:profilePage.overview.sections.recent.empty')}</p>
          )}
        </SectionPanel>
      )}

      {/* ── 其余四组收进概览后依然「只挂载当前组」：它们各自都会发请求，若六组全部挂载、
          只用 CSS 隐藏，打开概览就等于同时打六组接口——那就把「入口太多」换成了
          「页面卡」。 */}
      {section === 'mind' && (
        <SectionPanel>
          <MindTab agentId={agent.id} highlightId={highlightMailboxId} agentStatus={agent.state.status} canManageAgents={canManageAgents} />
        </SectionPanel>
      )}

      {section === 'files' && (
        <SectionPanel>
          <FilesTab agentId={agent.id} />
        </SectionPanel>
      )}

      {section === 'tools' && (
        <SectionPanel>
          <CapabilitiesTab tools={agent.tools ?? []} agent={agent} />
        </SectionPanel>
      )}

      {section === 'memory' && (
        <SectionPanel>
          <HeartbeatTab agentId={agent.id} initialData={agent.heartbeat} />
          <div className="mt-6">
            <MemoryTab agentId={agent.id} />
          </div>
        </SectionPanel>
      )}
    </div>
  );
}

// ─── Inline Diff (line-level + word-level highlighting) ───────────────────────

type DiffLineType = 'equal' | 'add' | 'remove';
interface DiffLine { type: DiffLineType; content: string; lineNum?: number; oldLineNum?: number }

function computeLineDiff(a: string, b: string): DiffLine[] {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const m = aLines.length, n = bLines.length;

  // Myers-like LCS for line diff (O(mn) DP — fine for config files)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i]![j] = aLines[i] === bLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);

  const result: DiffLine[] = [];
  let i = 0, j = 0, oldLn = 1, newLn = 1;
  while (i < m || j < n) {
    if (i < m && j < n && aLines[i] === bLines[j]) {
      result.push({ type: 'equal', content: aLines[i]!, oldLineNum: oldLn++, lineNum: newLn++ });
      i++; j++;
    } else if (j < n && (i >= m || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      result.push({ type: 'add', content: bLines[j]!, lineNum: newLn++ });
      j++;
    } else {
      result.push({ type: 'remove', content: aLines[i]!, oldLineNum: oldLn++ });
      i++;
    }
  }
  return result;
}

function tokenizeWords(line: string): string[] {
  return line.match(/\S+|\s+/g) ?? [''];
}

function WordDiff({ oldText, newText, mode }: { oldText: string; newText: string; mode: 'add' | 'remove' }) {
  const oldWords = tokenizeWords(oldText);
  const newWords = tokenizeWords(newText);
  const m = oldWords.length, n = newWords.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i]![j] = oldWords[i] === newWords[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);

  const segments: Array<{ text: string; changed: boolean }> = [];
  let oi = 0, ni = 0;
  while (oi < m || ni < n) {
    if (oi < m && ni < n && oldWords[oi] === newWords[ni]) {
      segments.push({ text: mode === 'remove' ? oldWords[oi]! : newWords[ni]!, changed: false });
      oi++; ni++;
    } else if (ni < n && (oi >= m || dp[oi]![ni + 1]! >= dp[oi + 1]![ni]!)) {
      if (mode === 'add') segments.push({ text: newWords[ni]!, changed: true });
      ni++;
    } else {
      if (mode === 'remove') segments.push({ text: oldWords[oi]!, changed: true });
      oi++;
    }
  }

  return (
    <span>
      {segments.map((s, i) =>
        s.changed
          ? <span key={i} className={mode === 'add' ? 'bg-green-500/30 rounded-sm' : 'bg-red-500/30 rounded-sm'}>{s.text}</span>
          : <span key={i}>{s.text}</span>
      )}
    </span>
  );
}

function InlineDiff({ agent, template, templateId }: { agent: string; template: string; templateId: string }) {
  const { t } = useTranslation(['agent', 'common']);
  const lines = useMemo(() => computeLineDiff(agent, template), [agent, template]);
  const [collapsed, setCollapsed] = useState(true);

  // Group into hunks with context lines
  const contextSize = 3;
  const hunks = useMemo(() => {
    const changed = lines.map((l, i) => l.type !== 'equal' ? i : -1).filter(i => i >= 0);
    if (changed.length === 0) return [];

    const groups: Array<{ start: number; end: number }> = [];
    let start = Math.max(0, changed[0]! - contextSize);
    let end = Math.min(lines.length - 1, changed[0]! + contextSize);

    for (let k = 1; k < changed.length; k++) {
      const cs = Math.max(0, changed[k]! - contextSize);
      const ce = Math.min(lines.length - 1, changed[k]! + contextSize);
      if (cs <= end + 1) {
        end = ce;
      } else {
        groups.push({ start, end });
        start = cs;
        end = ce;
      }
    }
    groups.push({ start, end });
    return groups;
  }, [lines]);

  // Pair consecutive remove/add lines for word-level diff
  const renderLine = (line: DiffLine, idx: number, allLines: DiffLine[]) => {
    const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
    const bg = line.type === 'add' ? 'bg-green-500/8' : line.type === 'remove' ? 'bg-red-500/8' : '';
    const textColor = line.type === 'add' ? 'text-green-600/90' : line.type === 'remove' ? 'text-red-500/80' : 'text-fg-tertiary';
    const prefixColor = line.type === 'add' ? 'text-green-500' : line.type === 'remove' ? 'text-red-500' : 'text-fg-muted';
    const ln = line.type === 'remove' ? line.oldLineNum : line.lineNum;

    let wordDiffContent: React.ReactNode = null;
    if (line.type === 'remove' && idx + 1 < allLines.length && allLines[idx + 1]!.type === 'add') {
      wordDiffContent = <WordDiff oldText={line.content} newText={allLines[idx + 1]!.content} mode="remove" />;
    } else if (line.type === 'add' && idx > 0 && allLines[idx - 1]!.type === 'remove') {
      wordDiffContent = <WordDiff oldText={allLines[idx - 1]!.content} newText={line.content} mode="add" />;
    }

    return (
      <div key={idx} className={`flex ${bg} hover:brightness-95 transition-colors`}>
        <span className="w-10 shrink-0 text-right pr-2 text-[10px] text-fg-muted/50 select-none leading-[20px]">{ln ?? ''}</span>
        <span className={`w-4 shrink-0 text-center text-[11px] font-mono ${prefixColor} select-none leading-[20px]`}>{prefix}</span>
        <span className={`flex-1 text-[11px] font-mono ${textColor} whitespace-pre-wrap break-words leading-[20px]`}>
          {wordDiffContent ?? line.content}
          {line.content === '' && '\u00A0'}
        </span>
      </div>
    );
  };

  const addCount = lines.filter(l => l.type === 'add').length;
  const removeCount = lines.filter(l => l.type === 'remove').length;
  const displayLines = collapsed ? hunks.flatMap(h => {
    const hunkLines: Array<DiffLine & { _idx: number; _separator?: boolean }> = [];
    for (let i = h.start; i <= h.end; i++) hunkLines.push({ ...lines[i]!, _idx: i });
    return hunkLines;
  }) : lines.map((l, i) => ({ ...l, _idx: i }));

  return (
    <div className="mb-3 bg-surface-elevated rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-elevated">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider">
            {t('agent:profilePage.diff.title', { templateId })}
          </span>
          <span className="text-[10px] text-green-500 font-mono">+{addCount}</span>
          <span className="text-[10px] text-red-500 font-mono">-{removeCount}</span>
        </div>
        <button
          onClick={() => setCollapsed(c => !c)}
          className="text-[10px] text-brand-500 hover:text-brand-400 transition-colors"
        >{collapsed ? t('agent:profilePage.diff.showFullFile') : t('agent:profilePage.diff.showChangesOnly')}</button>
      </div>
      <div className="max-h-72 overflow-y-auto bg-surface-primary/50">
        {collapsed && hunks.length > 0 && hunks[0]!.start > 0 && (
          <div className="text-[10px] text-fg-muted/50 text-center py-0.5 bg-surface-elevated/40 border-b border-border-default/30">{t('agent:profilePage.diff.linesHidden', { count: hunks[0]!.start })}</div>
        )}
        {displayLines.map((line, viewIdx) => {
          const prevInDisplay = viewIdx > 0 ? displayLines[viewIdx - 1] : null;
          const showSep = collapsed && prevInDisplay && (line as any)._idx - (prevInDisplay as any)._idx > 1;
          return (
            <div key={viewIdx}>
              {showSep && <div className="text-[10px] text-fg-muted/50 text-center py-0.5 bg-surface-elevated/40 border-y border-border-default/30">···</div>}
              {renderLine(line, (line as any)._idx, lines)}
            </div>
          );
        })}
        {collapsed && hunks.length > 0 && hunks[hunks.length - 1]!.end < lines.length - 1 && (
          <div className="text-[10px] text-fg-muted/50 text-center py-0.5 bg-surface-elevated/40 border-t border-border-default/30">{t('agent:profilePage.diff.linesHidden', { count: lines.length - 1 - hunks[hunks.length - 1]!.end })}</div>
        )}
        {hunks.length === 0 && <div className="text-xs text-fg-tertiary text-center py-4">{t('agent:profilePage.diff.identical')}</div>}
      </div>
    </div>
  );
}

// ─── Files Tab (System Prompts / Role Files) ─────────────────────────────────

function buildSimpleDiff(current: string, template: string): string {
  const curLines = current.split('\n');
  const tplLines = template.split('\n');
  const lines: string[] = [];
  const maxLen = Math.max(curLines.length, tplLines.length);
  for (let i = 0; i < maxLen; i++) {
    const c = curLines[i];
    const t = tplLines[i];
    if (c === t) { lines.push(`  ${c ?? ''}`); continue; }
    if (c !== undefined && (t === undefined || c !== t)) lines.push(`- ${c}`);
    if (t !== undefined && (c === undefined || c !== t)) lines.push(`+ ${t}`);
  }
  if (lines.length > 80) {
    const changed = lines.filter(l => l.startsWith('+ ') || l.startsWith('- '));
    if (changed.length > 0) return changed.join('\n');
  }
  return lines.join('\n');
}

function FilesTab({ agentId }: { agentId: string }) {
  const { t } = useTranslation(['agent', 'common']);
  const [files, setFiles] = useState<Array<{ name: string; content: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [roleDir, setRoleDir] = useState('');
  const [pathCopied, setPathCopied] = useState(false);

  useEffect(() => {
    api.system.storage().then(info => {
      setRoleDir(info.dataDir + '/agents/' + agentId + '/role');
    }).catch(() => {});
  }, [agentId]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [roleStatus, setRoleStatus] = useState<RoleUpdateStatus | null>(null);
  const [diffView, setDiffView] = useState<{ file: string; agent: string; template: string } | null>(null);

  const loadFiles = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.agents.getFiles(agentId),
      api.agents.roleStatus(agentId).catch(() => null),
    ]).then(([d, status]) => {
      setFiles(d.files);
      setRoleStatus(status);
      if (d.files.length > 0 && !selected) {
        setSelected(d.files[0].name);
        setEditContent(d.files[0].content);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const selectFile = (name: string) => {
    const f = files.find(f => f.name === name);
    if (f) { setSelected(name); setEditContent(f.content); setDirty(false); setDiffView(null); }
  };

  const saveFile = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.agents.updateFile(agentId, selected, editContent);
      setFiles(prev => prev.map(f => f.name === selected ? { ...f, content: editContent } : f));
      setDirty(false);
      if (selected === 'ROLE.md') {
        await api.agents.updateSystemPrompt(agentId, editContent);
      }
    } catch { /* */ }
    setSaving(false);
  };

  const staleFiles = roleStatus?.files.filter(f => f.status === 'modified' || f.status === 'added_in_template') ?? [];

  const sendUpdateToAgent = async (fileName?: string) => {
    const filesToSend = fileName
      ? staleFiles.filter(f => f.file === fileName)
      : staleFiles;
    if (filesToSend.length === 0) return;

    const diffParts: string[] = [];
    for (const sf of filesToSend) {
      try {
        const d = await api.agents.roleDiff(agentId, sf.file);
        if (d.agentContent != null && d.templateContent != null) {
          diffParts.push(
            `## ${sf.file}\n\n` +
            `**Template file path:** built-in template \`${roleStatus?.templateId ?? 'unknown'}\`\n\n` +
            `**Key changes in the new template version:**\n` +
            '```diff\n' +
            buildSimpleDiff(d.agentContent, d.templateContent) +
            '\n```\n'
          );
        }
      } catch { /* skip */ }
    }
    if (diffParts.length === 0) return;

    const message =
      `Your role configuration files have been updated in the latest template (\`${roleStatus?.templateId ?? ''}\`). ` +
      `Please review the following changes and decide whether to update your files accordingly.\n\n` +
      diffParts.join('\n---\n\n') +
      `\nPlease review each change and update your files if appropriate. You can use the \`update_file\` tool or ask me to apply the changes.`;

    navBus.navigate(PAGE.TEAM, { agentId, prefillMessage: message });
  };

  const showDiff = async (fileName: string) => {
    if (diffView?.file === fileName) { setDiffView(null); return; }
    try {
      const d = await api.agents.roleDiff(agentId, fileName);
      if (d.agentContent != null && d.templateContent != null) {
        setDiffView({ file: fileName, agent: d.agentContent, template: d.templateContent });
      }
    } catch { /* */ }
  };

  if (loading) return <div className="text-xs text-fg-tertiary py-8 text-center">{t('agent:profilePage.filesTab.loading')}</div>;

  const FILE_LABEL_KEYS: Record<string, string> = {
    'ROLE.md': 'roleMd',
    'HEARTBEAT.md': 'heartbeatMd',
    'POLICIES.md': 'policiesMd',
    'CONTEXT.md': 'contextMd',
  };
  const fileLabel = (name: string) => {
    const k = FILE_LABEL_KEYS[name];
    return k ? t(`agent:profilePage.filesTab.fileLabels.${k}`) : name;
  };

  const hasUpdates = roleStatus?.hasTemplate && !roleStatus.isUpToDate;
  const selectedFileStale = selected ? staleFiles.some(f => f.file === selected) : false;

  return (
    <div className="space-y-4">
      {hasUpdates && (
        <div className="bg-amber-500/8 border border-amber-500/25 rounded-xl p-4 flex items-start gap-3">
          <span className="text-amber-600 text-sm mt-0.5">↻</span>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-amber-600 font-medium">{t('agent:profilePage.filesTab.templateUpdateAvailable')}</div>
            <div className="text-[11px] text-amber-600/70 mt-0.5">
              {t('agent:profilePage.filesTab.filesDiffer', { count: staleFiles.length, templateId: roleStatus!.templateId })}
              {' '}{staleFiles.map(f => f.file).join(', ')}
            </div>
          </div>
          <button onClick={() => sendUpdateToAgent()}
            className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors shrink-0"
          >{t('agent:profilePage.filesTab.sendToAgent')}</button>
        </div>
      )}

      <Card title={t('agent:profilePage.filesTab.agentConfigFiles')} action={
        roleStatus?.hasTemplate
          ? <div className="flex items-center gap-2">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${roleStatus.isUpToDate ? 'bg-green-400' : 'bg-amber-400'}`} />
              <span className="text-[10px] text-fg-tertiary">
                {t('agent:profilePage.filesTab.templateLabel')} <span className="text-fg-secondary">{roleStatus.templateId}</span>
                {roleStatus.isUpToDate ? t('agent:profilePage.filesTab.upToDate') : t('agent:profilePage.filesTab.updatesAvailable')}
              </span>
            </div>
          : <div className="text-[10px] text-fg-tertiary">{t('agent:profilePage.filesTab.customAgentNoTemplate')}</div>
      }>
        <div className="flex gap-2 mb-4 flex-wrap">
          {files.map(f => {
            const fStale = staleFiles.some(s => s.file === f.name);
            return (
              <button key={f.name} onClick={() => selectFile(f.name)}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors relative ${
                  selected === f.name ? 'bg-brand-600/15 border-brand-500/40 text-brand-500' : 'border-border-default text-fg-tertiary hover:text-fg-secondary'
                }`}
              >
                {f.name}
                {fStale && <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-400 rounded-full" />}
              </button>
            );
          })}
        </div>

        {selected && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs text-fg-secondary">{fileLabel(selected)}</div>
              <div className="flex gap-2 items-center">
                {selectedFileStale && (
                  <>
                    <button onClick={() => showDiff(selected)} className="px-2.5 py-1 text-[11px] text-amber-600 hover:text-amber-600 border border-amber-500/30 hover:border-amber-500/50 rounded-lg transition-colors">
                      {diffView?.file === selected ? t('agent:profilePage.filesTab.hideDiff') : t('agent:profilePage.filesTab.viewDiff')}
                    </button>
                    <button onClick={() => sendUpdateToAgent(selected)}
                      className="px-2.5 py-1 text-[11px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors"
                      title={t('agent:profilePage.filesTab.sendToAgentTitle')}
                    >{t('agent:profilePage.filesTab.sendToAgent')}</button>
                  </>
                )}
                {saving && <span className="text-[10px] text-fg-tertiary">{t('common:saving')}</span>}
              </div>
            </div>

            {roleDir && (
              <div className="flex items-center gap-2 mb-3 bg-surface-elevated/40 rounded-lg px-3 py-2">
                <code className="text-[10px] text-fg-tertiary font-mono flex-1 truncate select-all" title={`${roleDir}/${selected}`}>
                  {roleDir}/{selected}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`${roleDir}/${selected}`);
                    setPathCopied(true);
                    setTimeout(() => setPathCopied(false), 2000);
                  }}
                  className="shrink-0 px-2 py-1 text-[10px] text-fg-tertiary hover:text-fg-secondary border border-border-default hover:border-border-hover rounded-md transition-colors"
                  title={t('agent:profilePage.filesTab.copyPath')}
                >
                  {pathCopied ? t('agent:profilePage.filesTab.pathCopied') : t('agent:profilePage.filesTab.copyPath')}
                </button>
                <button
                  onClick={() => void api.system.openPath(roleDir)}
                  className="shrink-0 px-2 py-1 text-[10px] text-fg-tertiary hover:text-fg-secondary border border-border-default hover:border-border-hover rounded-md transition-colors"
                  title={t('agent:profilePage.filesTab.openInFinder')}
                >
                  {t('agent:profilePage.filesTab.openInFinder')}
                </button>
              </div>
            )}

            {diffView?.file === selected && (
              <InlineDiff agent={diffView.agent} template={diffView.template} templateId={roleStatus?.templateId ?? ''} />
            )}

            <FileMarkdownEditor
              content={files.find(f => f.name === selected)?.content ?? ''}
              editContent={editContent}
              setEditContent={(v) => { setEditContent(v); setDirty(true); }}
              dirty={dirty}
              onSave={saveFile}
            />
            {selected === 'ROLE.md' && (
              <div className="text-[10px] text-fg-tertiary mt-2">{t('agent:profilePage.filesTab.roleMdHint')}</div>
            )}
          </div>
        )}

        {files.length === 0 && <Empty text={t('agent:profilePage.filesTab.noConfigFiles')} />}
      </Card>
    </div>
  );
}

function FileMarkdownEditor({ content, editContent, setEditContent, dirty, onSave }: {
  content: string;
  editContent: string;
  setEditContent: (v: string) => void;
  dirty: boolean;
  onSave: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (editing) textareaRef.current?.focus(); }, [editing]);

  useEffect(() => { setEditing(false); }, [content]);

  if (editing || dirty) {
    return (
      <textarea
        ref={textareaRef}
        value={editContent}
        onChange={e => setEditContent(e.target.value)}
        onBlur={() => {
          if (editContent !== content) onSave();
          setEditing(false);
        }}
        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setEditContent(content); setEditing(false); } }}
        className="w-full min-h-[60vh] bg-surface-elevated/60 border border-border-default rounded-lg p-4 text-xs font-mono text-fg-secondary leading-relaxed resize-y focus:border-brand-500 outline-none"
        spellCheck={false}
      />
    );
  }
  return (
    <div
      className="group relative cursor-pointer rounded-lg px-4 py-3 bg-surface-elevated hover:bg-surface-overlay transition-colors min-h-[200px]"
      onClick={() => setEditing(true)}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') setEditing(true); }}
    >
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-fg-tertiary bg-surface-secondary/80 px-2 py-0.5 rounded">
        Click to edit
      </div>
      {editContent.trim() ? (
        <Suspense fallback={<div className="text-xs text-fg-tertiary">Loading…</div>}>
          <LazyMarkdownMessage content={editContent} className="text-sm text-fg-secondary leading-relaxed" />
        </Suspense>
      ) : (
        <div className="text-sm text-fg-tertiary italic py-4 text-center">Empty</div>
      )}
    </div>
  );
}

// ─── Tools Tab ───────────────────────────────────────────────────────────────

function cleanDescription(desc: string): string {
  return desc.replace(/^\[MCP:[^\]]*\]\s*/i, '');
}

function ToolsTab({ tools }: { tools: AgentToolInfo[] }) {
  const { t } = useTranslation(['agent', 'common']);
  const groups = categorizeTools(tools, t);
  return (
    <div className="space-y-4">
      <div className="text-xs text-fg-tertiary">{t('agent:profilePage.toolsTab.registeredCount', { count: tools.length })}</div>
      {groups.map(g => (
        <Card key={g.category} title={`${g.category} (${g.tools.length})`}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {g.tools.map(tool => {
              const meta = getToolMeta(tool.name);
              const label = t(`common:execution.tools.${meta.key}`, { defaultValue: meta.label });
              const isMcp = tool.name.includes('__');
              const rawName = isMcp ? tool.name.split('__').pop()! : tool.name;
              const description = cleanDescription(tool.description || '');
              return (
                <div key={tool.name} className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-surface-elevated min-w-0">
                  <NamedIcon name={meta.iconName} size={15} className="shrink-0 mt-0.5 text-fg-secondary" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-xs font-medium text-fg-primary truncate">{label}</span>
                      {isMcp && (
                        <span className="text-[9px] px-1 py-px rounded bg-surface-secondary text-fg-tertiary border border-border-default/40 shrink-0">
                          MCP
                        </span>
                      )}
                    </div>
                    {/* Technical id under the localized label — useful when label ≠ snake_case name. */}
                    {rawName !== label && (
                      <div className="text-[10px] font-mono text-fg-tertiary/70 truncate">{rawName}</div>
                    )}
                    {description && (
                      <div className="text-[10px] text-fg-tertiary truncate mt-0.5" title={description}>{description}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ))}
      {tools.length === 0 && <div className="text-center py-12 text-fg-tertiary text-sm">{t('agent:profilePage.toolsTab.noToolsRegistered')}</div>}
    </div>
  );
}

// ─── Skills Tab ──────────────────────────────────────────────────────────────

interface SkillDetail {
  name: string; version: string; description: string; author: string;
  category: string; tags?: string[];
  tools: Array<{ name: string; description: string }>;
  toolDetails?: Array<{ name: string; description: string; inputSchema?: unknown }>;
  requiredPermissions?: string[];
}

function SkillsTab({ agent }: { agent: AgentDetail }) {
  const { t } = useTranslation(['agent', 'common']);
  const proficiency = agent.proficiency ?? {};
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const allSkills = agent.availableSkills ?? [];
  const byCategory = new Map<string, typeof allSkills>();
  for (const s of allSkills) {
    const cat = s.category || 'custom';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(s);
  }

  const toggleDetail = async (skillName: string) => {
    if (expandedSkill === skillName) { setExpandedSkill(null); setSkillDetail(null); return; }
    setExpandedSkill(skillName);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}`);
      if (res.ok) {
        const data = await res.json();
        setSkillDetail(data.skill);
      } else {
        setSkillDetail(null);
      }
    } catch { setSkillDetail(null); }
    setDetailLoading(false);
  };

  const CATEGORY_COLORS: Record<string, string> = {
    development: 'bg-blue-500/15 text-blue-600', devops: 'bg-amber-500/15 text-amber-600',
    communication: 'bg-green-500/15 text-green-600', data: 'bg-brand-500/15 text-brand-500',
    productivity: 'bg-amber-500/15 text-amber-600', browser: 'bg-blue-500/15 text-blue-600',
    custom: 'bg-gray-500/15 text-fg-secondary', platform: 'bg-purple-500/15 text-purple-500',
  };

  const renderSkillRow = (skill: { name: string; description: string; category: string; builtIn?: boolean; alwaysOn?: boolean }) => {
    const prof = proficiency[skill.name];
    const rate = prof && prof.uses > 0 ? Math.round(prof.successes / prof.uses * 100) : null;
    const profLine = prof && (
      <div className="text-[10px] text-fg-tertiary mt-0.5">
        {t('agent:profilePage.skillsTab.usesStats', { uses: prof.uses, successes: prof.successes })}
        {prof.lastUsed && t('agent:profilePage.skillsTab.lastUsed', { date: new Date(prof.lastUsed).toLocaleDateString() })}
      </div>
    );
    const isExpanded = expandedSkill === skill.name;

    return (
      <div key={skill.name}>
        <div
          className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border cursor-pointer transition-all ${
            isExpanded ? 'bg-brand-500/10 border-brand-500/40' : 'bg-surface-elevated/30 border-border-default/30 hover:border-gray-600/50'
          }`}
          onClick={() => toggleDetail(skill.name)}
        >
          <span className={`text-sm transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{skill.name}</span>
              {skill.alwaysOn && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-green-500/15 text-green-500">{t('agent:profilePage.skillsTab.alwaysOn')}</span>
              )}
              {skill.builtIn && !skill.alwaysOn && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-surface-overlay/40 text-fg-tertiary">{t('agent:profilePage.skillsTab.builtIn')}</span>
              )}
              {!skill.builtIn && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-brand-500/15 text-brand-400">{t('agent:profilePage.skillsTab.installed')}</span>
              )}
            </div>
            <div className="text-[10px] text-fg-tertiary mt-0.5 truncate">{skill.description}</div>
            {profLine}
          </div>
          {rate !== null && (
            <div className="flex items-center gap-2 shrink-0">
              <div className="w-16 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${rate >= 80 ? 'bg-green-400' : rate >= 50 ? 'bg-amber-400' : 'bg-red-400'}`} style={{ width: `${rate}%` }} />
              </div>
              <span className="text-[10px] text-fg-tertiary w-8 text-right">{rate}%</span>
            </div>
          )}
        </div>

        {isExpanded && (
          <div className="ml-6 mt-1 mb-2 p-4 bg-surface-elevated/30 rounded-lg border border-border-default/20 space-y-3">
            {detailLoading ? (
              <div className="text-[10px] text-fg-tertiary py-3 text-center">{t('agent:profilePage.skillsTab.loadingDetails')}</div>
            ) : skillDetail ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${CATEGORY_COLORS[skillDetail.category] ?? CATEGORY_COLORS['custom']}`}>
                    {skillDetail.category}
                  </span>
                  <span className="text-[10px] text-fg-tertiary">v{skillDetail.version}</span>
                  {skillDetail.author && <span className="text-[10px] text-fg-tertiary">{t('agent:profilePage.skillsTab.byAuthor', { author: skillDetail.author })}</span>}
                  {skillDetail.requiredPermissions?.map(p => (
                    <span key={p} className="px-1.5 py-0.5 bg-amber-500/10 text-amber-600 text-[10px] rounded">{p}</span>
                  ))}
                </div>
                {skillDetail.description && (
                  <p className="text-xs text-fg-secondary leading-relaxed">{skillDetail.description}</p>
                )}
                {skillDetail.tags && skillDetail.tags.length > 0 && (
                  <div className="flex gap-1 flex-wrap">
                    {skillDetail.tags.map(tag => (
                      <span key={tag} className="px-1.5 py-0.5 bg-surface-overlay/40 text-fg-tertiary text-[10px] rounded">#{tag}</span>
                    ))}
                  </div>
                )}
                {(skillDetail.toolDetails ?? skillDetail.tools ?? []).length > 0 && (
                  <div>
                    <div className="text-[10px] text-fg-tertiary font-semibold uppercase tracking-wider mb-2">
                      {t('agent:profilePage.skillsTab.toolsHeading', { count: (skillDetail.toolDetails ?? skillDetail.tools ?? []).length })}
                    </div>
                    <div className="space-y-1.5">
                      {(skillDetail.toolDetails ?? skillDetail.tools ?? []).map(tool => (
                        <div key={tool.name} className="px-3 py-2 bg-surface-secondary/50 rounded border border-border-default/20">
                          <div className="text-xs font-medium text-brand-500">{tool.name}</div>
                          {tool.description && <div className="text-[10px] text-fg-tertiary mt-0.5">{tool.description}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-[10px] text-fg-tertiary py-3 text-center">
                {t('agent:profilePage.skillsTab.detailsUnavailable')}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const CATEGORY_ORDER = ['development', 'productivity', 'browser', 'communication', 'devops', 'data', 'platform', 'custom'];
  const sortedCategories = [...byCategory.entries()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a[0]);
    const bi = CATEGORY_ORDER.indexOf(b[0]);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-fg-tertiary">{t('agent:profilePage.skillsTab.installedCount', { count: allSkills.length })}</div>
      </div>
      {sortedCategories.map(([cat, skills]) => (
        <Card key={cat} title={<span className="capitalize">{cat} <span className="text-fg-tertiary font-normal">({skills.length})</span></span>}>
          <div className="space-y-2">
            {skills.map(s => renderSkillRow(s))}
          </div>
        </Card>
      ))}
      {allSkills.length === 0 && <Empty text={t('agent:profilePage.skillsTab.noSkills')} />}
    </div>
  );
}

// ─── Capabilities Tab (Tools + Skills) ───────────────────────────────────────

function CapabilitiesTab({ tools, agent }: { tools: AgentToolInfo[]; agent: AgentDetail }) {
  const { t } = useTranslation(['agent', 'common']);
  const [section, setSection] = useState<'tools' | 'skills'>('tools');
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-2">
        {(['tools', 'skills'] as const).map(s => (
          <button key={s} onClick={() => setSection(s)}
            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
              section === s ? 'bg-brand-600/15 border-brand-500/40 text-brand-500' : 'border-border-default text-fg-tertiary hover:text-fg-secondary'
            }`}
          >
            {s === 'tools' ? `${t('agent:profilePage.toolsTab.title', { defaultValue: 'Tools' })} (${tools.length})` : `${t('agent:tabs.skills')} (${agent.availableSkills?.length ?? 0})`}
          </button>
        ))}
      </div>
      {section === 'tools' ? <ToolsTab tools={tools} /> : <SkillsTab agent={agent} />}
    </div>
  );
}

// ─── Memory Tab ──────────────────────────────────────────────────────────────

function MemoryTab({ agentId }: { agentId: string }) {
  const { t } = useTranslation(['agent', 'common']);
  const [data, setData] = useState<AgentMemorySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<'entries' | 'sessions' | 'daily' | 'longterm'>('longterm');
  const [dailyContent, setDailyContent] = useState('');
  const [longContent, setLongContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [expandedEntryIdx, setExpandedEntryIdx] = useState<number | null>(null);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<Array<{ role: string; content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }>; toolCallId?: string }>>([]);
  const [sessionLoading, setSessionLoading] = useState(false);

  const loadData = useCallback(() => {
    setLoading(true);
    api.agents.getMemory(agentId).then(d => {
      setData(d);
      setDailyContent(d.recentDailyLogs ?? '');
      setLongContent(d.longTermMemory ?? '');
    }).catch(() => {}).finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveDaily = async () => {
    setSaving(true);
    await api.agents.updateDailyMemory(agentId, dailyContent).catch(() => {});
    setSaving(false);
    loadData();
  };

  const saveLong = async () => {
    setSaving(true);
    await api.agents.updateLongTermMemory(agentId, t('agent:profilePage.memoryTab.userEditedSource'), longContent).catch(() => {});
    setSaving(false);
    loadData();
  };

  const dailyDirty = dailyContent !== (data?.recentDailyLogs ?? '');
  const longDirty = longContent !== (data?.longTermMemory ?? '');

  if (loading) return <div className="text-xs text-fg-tertiary py-8 text-center">{t('agent:profilePage.memoryTab.loading')}</div>;
  if (!data) return <div className="text-xs text-fg-tertiary py-8 text-center">{t('agent:profilePage.memoryTab.loadFailed')}</div>;

  const sectionTabs = [
    { key: 'longterm' as const, label: 'MEMORY.md' },
    { key: 'entries' as const, label: `Observations (${data.entries.length})` },
    { key: 'sessions' as const, label: t('agent:profilePage.memoryTab.sessions', { count: data.sessions.length }) },
    { key: 'daily' as const, label: t('agent:profilePage.memoryTab.dailyLogs') },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {sectionTabs.map(s => (
          <button key={s.key} onClick={() => setSection(s.key)}
            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${section === s.key ? 'bg-brand-600/15 border-brand-500/40 text-brand-500' : 'border-border-default text-fg-tertiary hover:text-fg-secondary'}`}
          >{s.label}</button>
        ))}
      </div>

      {section === 'entries' && (
        <Card title={t('agent:profilePage.memoryTab.recentEntries')}>
          {data.entries.length === 0 ? <Empty text={t('agent:profilePage.memoryTab.noEntries')} /> : (
            <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
              {data.entries.map((e, i) => {
                const isExpanded = expandedEntryIdx === i;
                return (
                  <div key={i}>
                    <button
                      onClick={() => setExpandedEntryIdx(isExpanded ? null : i)}
                      className="w-full flex gap-2 px-3 py-2 rounded-lg bg-surface-elevated/20 text-xs text-left hover:bg-surface-elevated/40 transition-colors cursor-pointer"
                    >
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${e.type === 'fact' ? 'bg-blue-500/15 text-blue-600' : e.type === 'task' ? 'bg-green-500/15 text-green-600' : e.type === 'note' ? 'bg-brand-500/15 text-brand-500' : 'bg-surface-overlay text-fg-secondary'}`}>{e.type}</span>
                      <span className={`text-fg-secondary flex-1 min-w-0 ${isExpanded ? '' : 'line-clamp-2'}`}>{e.content}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        {e.importance != null && (
                          <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${e.importance >= 7 ? 'bg-red-500/15 text-red-500' : e.importance >= 4 ? 'bg-amber-500/15 text-amber-600' : 'bg-surface-overlay text-fg-tertiary'}`}>
                            P{e.importance}
                          </span>
                        )}
                        <span className="text-fg-tertiary text-[10px]">{new Date(e.timestamp).toLocaleTimeString()}</span>
                        <span className="text-fg-tertiary text-[10px]">{isExpanded ? '▲' : '▼'}</span>
                      </div>
                    </button>
                    {isExpanded && (
                      <div className="mx-3 mt-1 mb-2 p-3 bg-surface-elevated/30 rounded-lg border border-border-default/20">
                        <pre className="text-xs text-fg-secondary whitespace-pre-wrap font-mono leading-relaxed break-words">{e.content}</pre>
                        <div className="flex gap-3 mt-2 pt-2 border-t border-border-default/30 text-[10px] text-fg-tertiary">
                          <span>{t('agent:profilePage.overview.labels.type')}: {e.type}</span>
                          {e.importance != null && <span>{t('agent:profilePage.overview.labels.importance')}: {e.importance}</span>}
                          <span>{new Date(e.timestamp).toLocaleString()}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {section === 'sessions' && (
        <Card title={t('agent:profilePage.memoryTab.chatSessions')}>
          {data.sessions.length === 0 ? <Empty text={t('agent:profilePage.memoryTab.noSessions')} /> : (
            <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
              {data.sessions.map(s => {
                const isExpanded = expandedSessionId === s.id;
                const toggleSession = async () => {
                  if (isExpanded) { setExpandedSessionId(null); setSessionMessages([]); return; }
                  setExpandedSessionId(s.id);
                  setSessionLoading(true);
                  try {
                    const res = await api.agents.getMemorySession(agentId, s.id);
                    setSessionMessages(res.messages);
                  } catch { setSessionMessages([]); }
                  setSessionLoading(false);
                };
                return (
                  <div key={s.id}>
                    <button
                      onClick={toggleSession}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface-elevated/20 hover:bg-surface-elevated/40 transition-colors cursor-pointer text-left"
                    >
                      <div className="text-xs text-fg-secondary font-mono flex-1 truncate">{s.id}</div>
                      <span className="text-[10px] text-fg-tertiary">{s.messageCount} {t('agent:profilePage.memoryTab.msgs')}</span>
                      <span className="text-[10px] text-fg-tertiary">{new Date(s.updatedAt).toLocaleDateString()}</span>
                      <span className="text-fg-tertiary text-[10px]">{isExpanded ? '▲' : '▼'}</span>
                    </button>
                    {isExpanded && (
                      <div className="mx-3 mt-1 mb-2 bg-surface-elevated/30 rounded-lg border border-border-default/20 max-h-96 overflow-y-auto">
                        {sessionLoading ? (
                          <div className="text-[10px] text-fg-tertiary py-3 text-center">{t('agent:profilePage.memoryTab.loadingMessages')}</div>
                        ) : sessionMessages.length === 0 ? (
                          <div className="text-[10px] text-fg-tertiary py-3 text-center">{t('agent:profilePage.memoryTab.noMessagesInSession')}</div>
                        ) : (() => {
                          const toolResultMap = new Map<string, string>();
                          for (const m of sessionMessages) {
                            if (m.role === 'tool' && m.toolCallId) toolResultMap.set(m.toolCallId, m.content);
                          }
                          return (
                            <div className="divide-y divide-gray-700/30">
                              {sessionMessages.filter(m => m.role !== 'tool').map((m, i) => (
                                <div key={i} className="px-3 py-2">
                                  {(m.role === 'user' || m.role === 'system') && (
                                    <div>
                                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium mb-1 ${m.role === 'user' ? 'bg-blue-500/15 text-blue-600' : 'bg-surface-overlay text-fg-secondary'}`}>{t(`agent:profilePage.memoryTab.roles.${m.role}`, { defaultValue: m.role })}</span>
                                      <div className="text-xs text-fg-secondary"><MarkdownMessage content={m.content} className="text-xs text-fg-secondary" /></div>
                                    </div>
                                  )}
                                  {m.role === 'assistant' && (
                                    <div className="space-y-1">
                                      {m.content && (
                                        <div>
                                          <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium mb-1 bg-green-500/15 text-green-600">{t('agent:profilePage.memoryTab.roles.assistant')}</span>
                                          <div className="text-xs text-fg-secondary"><MarkdownMessage content={m.content} className="text-xs text-fg-secondary" /></div>
                                        </div>
                                      )}
                                      {m.toolCalls && m.toolCalls.length > 0 && (
                                        <div className="space-y-0.5">
                                          {m.toolCalls.map(tc => {
                                            let parsedArgs: Record<string, unknown> | undefined;
                                            try { parsedArgs = JSON.parse(tc.arguments); } catch { /* ignore */ }
                                            const info: ToolCallInfo = {
                                              tool: tc.name,
                                              status: 'done',
                                              args: parsedArgs,
                                              result: toolResultMap.get(tc.id),
                                            };
                                            return <ExecEntryRow key={tc.id} entry={{ type: 'tool', info }} />;
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {section === 'daily' && (
        <Card title={t('agent:profilePage.memoryTab.dailyLogs')} action={
          !dailyDirty ? null
            : <div className="flex gap-2">
                <button onClick={() => setDailyContent(data?.recentDailyLogs ?? '')} className="text-xs text-fg-tertiary hover:text-fg-secondary">{t('common:cancel')}</button>
                <button onClick={saveDaily} disabled={saving} className="text-xs text-brand-500">{saving ? t('common:saving') : t('common:save')}</button>
              </div>
        }>
          <textarea value={dailyContent} onChange={e => setDailyContent(e.target.value)} placeholder={t('agent:profilePage.memoryTab.noDailyLogs')}
            className="w-full min-h-[50vh] bg-surface-elevated/30 border border-border-default/50 hover:border-border-default focus:border-brand-500 rounded-lg p-4 text-xs font-mono text-fg-secondary leading-relaxed resize-y outline-none transition-colors" />
        </Card>
      )}

      {section === 'longterm' && (
        <Card title={t('agent:profilePage.memoryTab.longTermTitle')} action={
          !longDirty ? null
            : <div className="flex gap-2">
                <button onClick={() => setLongContent(data?.longTermMemory ?? '')} className="text-xs text-fg-tertiary hover:text-fg-secondary">{t('common:cancel')}</button>
                <button onClick={saveLong} disabled={saving} className="text-xs text-brand-500">{saving ? t('common:saving') : t('common:save')}</button>
              </div>
        }>
          <textarea value={longContent} onChange={e => setLongContent(e.target.value)} placeholder={t('agent:profilePage.memoryTab.noLongTerm')}
            className="w-full min-h-[50vh] bg-surface-elevated/30 border border-border-default/50 hover:border-border-default focus:border-brand-500 rounded-lg p-4 text-xs font-mono text-fg-secondary leading-relaxed resize-y outline-none transition-colors" />
        </Card>
      )}
    </div>
  );
}

// ─── Heartbeat Tab ───────────────────────────────────────────────────────────

function HeartbeatTab({ agentId, initialData }: { agentId: string; initialData?: AgentHeartbeatInfo }) {
  const { t } = useTranslation(['agent', 'common']);
  const [data, setData] = useState<AgentHeartbeatInfo | null>(initialData ?? null);
  const [loading, setLoading] = useState(!initialData);
  const [recentRuns, setRecentRuns] = useState<ActivitySummary[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);
  /** 唤醒取消的反馈。此前失败被 `catch {}` 静默吞掉，按钮点下去毫无反应。 */
  const [wakeupMsg, setWakeupMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const wakeupMsgTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (wakeupMsgTimer.current !== null) window.clearTimeout(wakeupMsgTimer.current);
  }, []);

  const refresh = useCallback(() => {
    return Promise.all([
      api.agents.getHeartbeat(agentId).then(setData).catch(() => {}),
      api.agents.getRecentActivities(agentId).then(d => {
        setRecentRuns(d.activities.filter(a => a.type === 'heartbeat'));
      }).catch(() => {}),
    ]);
  }, [agentId]);

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  // Auto-refresh when agent activity changes (heartbeat completes)
  useEffect(() => {
    const unsub = wsClient.on('agent:update', (event) => {
      if (event.payload?.agentId === agentId) refresh();
    });
    return unsub;
  }, [agentId, refresh]);

  const handleTrigger = async () => {
    setTriggering(true);
    setTriggerMsg(null);
    try {
      const r = await api.agents.triggerHeartbeat(agentId);
      setTriggerMsg(r.message);
      setTimeout(() => setTriggerMsg(null), 4000);
      setTimeout(refresh, 2000);
    } catch (err) {
      setTriggerMsg(String(err).replace('Error: ', ''));
    }
    setTriggering(false);
  };

  const handleCancelWakeup = async (wakeupId: string) => {
    if (wakeupMsgTimer.current !== null) window.clearTimeout(wakeupMsgTimer.current);
    setWakeupMsg(null);
    try {
      await api.agents.cancelWakeup(agentId, wakeupId);
      setWakeupMsg({ kind: 'ok', text: t('agent:profilePage.heartbeatTab.cancelWakeupOk') });
      wakeupMsgTimer.current = window.setTimeout(() => setWakeupMsg(null), 4000);
    } catch (err) {
      // 失败必须可见：静默吞错会与「取消不了」无法区分（概览页取消的同类体验问题）。
      // 404 是常见情形——该唤醒在别处已被触发/取消，此时更需要如实说明而非装作成功。
      const raw = err instanceof Error ? err.message : String(err);
      const gone = !raw || /no scheduled wakeup|404/i.test(raw);
      setWakeupMsg({
        kind: 'error',
        text: gone
          ? t('agent:profilePage.heartbeatTab.cancelWakeupGone')
          : `${t('agent:profilePage.heartbeatTab.cancelWakeupFailed')}: ${raw}`,
      });
    }
    // 无论成败都刷新：让 UI 回到真实状态，而不是停在用户以为的那个状态。
    refresh();
  };

  if (loading) return <div className="text-xs text-fg-tertiary py-8 text-center">{t('agent:profilePage.heartbeatTab.loading')}</div>;
  if (!data) return <div className="text-xs text-fg-tertiary py-8 text-center">{t('agent:profilePage.heartbeatTab.noData')}</div>;

  const formatDuration = (ms?: number) => {
    if (!ms) return null;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const formatRelativeTime = (iso?: string) => {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) {
      const abs = Math.abs(ms);
      if (abs < 60000) return t('agent:profilePage.relative.inSeconds', { count: Math.ceil(abs / 1000) });
      if (abs < 3600000) return t('agent:profilePage.relative.inMinutes', { count: Math.ceil(abs / 60000) });
      return t('agent:profilePage.relative.inHours', { hours: (abs / 3600000).toFixed(1) });
    }
    if (ms < 60000) return t('agent:profilePage.relative.secondsAgo', { count: Math.floor(ms / 1000) });
    if (ms < 3600000) return t('agent:profilePage.relative.minutesAgo', { count: Math.floor(ms / 60000) });
    return t('agent:profilePage.relative.hoursAgo', { hours: (ms / 3600000).toFixed(1) });
  };

  return (
    <div className="space-y-4">
      {/* Scheduler + Controls */}
      <Card title={t('agent:profilePage.heartbeatTab.scheduler')} action={
        <div className="flex items-center gap-2">
          <button onClick={refresh} className="text-[10px] text-fg-tertiary hover:text-fg-secondary transition-colors">
            {t('common:refresh')}
          </button>
          <button
            onClick={handleTrigger}
            disabled={triggering || !data.running}
            className="text-[10px] px-2.5 py-1 rounded-md bg-blue-600/20 text-blue-600 hover:bg-blue-600/30 border border-blue-500/30 transition-colors disabled:opacity-40"
          >
            {triggering ? t('agent:profilePage.heartbeatTab.triggering') : t('agent:profilePage.heartbeatTab.triggerNow')}
          </button>
        </div>
      }>
        <div className="grid grid-cols-4 gap-4">
          <StatBox label={t('agent:profilePage.overview.labels.status')} value={data.running ? t('agent:profilePage.heartbeatTab.running') : t('agent:profilePage.heartbeatTab.stopped')} color={data.running ? 'green' : 'gray'} />
          <HeartbeatIntervalEditor agentId={agentId} intervalMs={data.intervalMs} onChanged={refresh} />
          <StatBox label={t('agent:profilePage.heartbeatTab.lastRun')} value={data.lastHeartbeat ? formatRelativeTime(data.lastHeartbeat) ?? t('agent:profilePage.emDash') : t('agent:profilePage.never')} />
          <StatBox label={t('agent:profilePage.heartbeatTab.nextWake')} value={data.nextWakeAt ? formatRelativeTime(data.nextWakeAt) ?? t('agent:profilePage.emDash') : data.running ? t('agent:profilePage.heartbeatTab.pending') : t('agent:profilePage.emDash')} />
        </div>
        <p className="mt-2 text-[10px] text-fg-tertiary leading-relaxed">{t('agent:profilePage.heartbeatTab.rhythmHint')}</p>
        {triggerMsg && (
          <div className="mt-3 text-[11px] text-blue-600 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
            {triggerMsg}
          </div>
        )}
      </Card>

      {/* 唤醒取消的反馈 —— 失败也必须可见（此前这里是静默吞错） */}
      {wakeupMsg && (
        <div className={`text-[11px] rounded-lg px-3 py-2 border ${
          wakeupMsg.kind === 'ok'
            ? 'text-green-600 bg-green-500/10 border-green-500/20'
            : 'text-red-500 bg-red-500/10 border-red-500/20'
        }`}>
          {wakeupMsg.text}
        </div>
      )}

      {/* Scheduled Wakeups */}
      {data.wakeups && data.wakeups.length > 0 && (
        <Card title={t('agent:profilePage.heartbeatTab.wakeupsTitle')} action={<span className="text-[10px] text-fg-tertiary">{t('agent:profilePage.heartbeatTab.wakeupsCount', { count: data.wakeups.length })}</span>}>
          <div className="divide-y divide-gray-800/50 -mx-5">
            {data.wakeups.map(w => (
              <div key={w.id} className="flex items-center gap-2.5 px-5 py-2.5">
                <span className="text-sm shrink-0 opacity-60">⏰</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-fg-secondary truncate">{w.note || t('agent:profilePage.heartbeatTab.wakeupNoNote')}</div>
                  <div className="text-[10px] text-fg-tertiary">
                    {formatRelativeTime(w.wakeAt) ?? new Date(w.wakeAt).toLocaleString()}
                    {w.recurringMs ? ` · ${t('agent:profilePage.heartbeatTab.recurring')}` : ''}
                    {` · ${w.deliveryMode === 'in_session' ? t('agent:profilePage.heartbeatTab.deliveryInSession') : t('agent:profilePage.heartbeatTab.deliveryMailbox')}`}
                  </div>
                </div>
                <button
                  onClick={() => handleCancelWakeup(w.id)}
                  className="text-[10px] px-2 py-0.5 rounded text-fg-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
                >
                  {t('agent:profilePage.heartbeatTab.cancelWakeup')}
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Pending Async Operations */}
      {data.pendingCallbacks && data.pendingCallbacks.length > 0 && (
        <Card title={t('agent:profilePage.heartbeatTab.pendingOpsTitle')} action={<span className="text-[10px] text-fg-tertiary">{t('agent:profilePage.heartbeatTab.pendingOpsCount', { count: data.pendingCallbacks.length })}</span>}>
          <div className="divide-y divide-gray-800/50 -mx-5">
            {data.pendingCallbacks.map(c => (
              <div key={c.id} className="flex items-center gap-2.5 px-5 py-2.5">
                <span className="text-sm shrink-0 opacity-60">{c.type === 'background_exec' ? '⚙' : '↔'}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-fg-secondary truncate font-mono">{c.label}</div>
                  <div className="text-[10px] text-fg-tertiary">
                    {t(`agent:profilePage.heartbeatTab.callbackType.${c.type}`)}
                    {` · ${t('agent:profilePage.heartbeatTab.timesOut')} ${formatRelativeTime(c.timeoutAt) ?? new Date(c.timeoutAt).toLocaleString()}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Last Heartbeat Summary */}
      {data.lastSummary && (
        <Card title={t('agent:profilePage.heartbeatTab.lastSummary')} action={
          data.lastSummaryAt ? <span className="text-[10px] text-fg-tertiary">{new Date(data.lastSummaryAt).toLocaleString()}</span> : undefined
        }>
          <div className="bg-surface-primary/50 rounded-lg px-4 py-3">
            <MarkdownMessage content={data.lastSummary} className="text-xs text-fg-secondary leading-relaxed" />
          </div>
        </Card>
      )}

      {/* Recent Runs */}
      {recentRuns.length > 0 ? (
        <Card title={t('agent:profilePage.heartbeatTab.recentRuns')} action={<span className="text-[10px] text-fg-tertiary">{t('agent:profilePage.heartbeatTab.runsThisSession', { count: recentRuns.length })}</span>}>
          <div className="divide-y divide-gray-800/50 -mx-5">
            {[...recentRuns].reverse().map(act => {
              const isExpanded = expandedRunId === act.id;
              return (
                <div key={act.id}>
                  <button
                    onClick={() => setExpandedRunId(isExpanded ? null : act.id)}
                    className="w-full flex items-center gap-2.5 px-5 py-2.5 text-left transition-colors hover:bg-surface-elevated/40 cursor-pointer"
                  >
                    <span className="w-2 h-2 rounded-full shrink-0 bg-blue-400" />
                    <span className="text-xs text-fg-secondary flex-1 truncate">{act.label}</span>
                    <span className="text-[10px] text-fg-tertiary shrink-0">{t('agent:profilePage.heartbeatTab.actionsCount', { count: act.logCount })}</span>
                    <span className="text-[10px] text-fg-tertiary shrink-0">{new Date(act.startedAt).toLocaleString()}</span>
                    <svg className={`w-3 h-3 text-fg-tertiary shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="currentColor">
                      <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                  {isExpanded && (
                    <div className="border-t border-border-default/60 bg-surface-primary/40">
                      <ActivityLog agentId={agentId} activityId={act.id} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      ) : !data.lastHeartbeat ? (
        <Card title={t('agent:profilePage.heartbeatTab.recentRuns')}>
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="text-xl mb-2 opacity-40">♡</div>
            <p className="text-xs text-fg-tertiary">{t('agent:profilePage.heartbeatTab.noRunsYet')}</p>
            <p className="text-[10px] text-fg-tertiary mt-1">
              {data.running
                ? t('agent:profilePage.heartbeatTab.firstHeartbeatSoon', { when: formatDuration(data.intervalMs - data.uptimeMs % data.intervalMs) ?? t('agent:profilePage.heartbeatTab.soon') })
                : t('agent:profilePage.heartbeatTab.schedulerStopped')}
            </p>
            {data.running && (
              <button onClick={handleTrigger} disabled={triggering}
                className="mt-3 text-[10px] px-3 py-1.5 rounded-md bg-blue-600/15 text-blue-600 hover:bg-blue-600/25 border border-blue-500/25 transition-colors disabled:opacity-40">
                {triggering ? t('agent:profilePage.heartbeatTab.triggering') : t('agent:profilePage.heartbeatTab.runFirstNow')}
              </button>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

// ─── Task Log ────────────────────────────────────────────────────────────────

function TaskLog({ taskId, isLive }: { taskId: string; isLive: boolean }) {
  const { t } = useTranslation('agent');
  const [logs, setLogs] = useState<TaskLogEntry[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'compact' | 'full'>('compact');

  useEffect(() => {
    setLoading(true); setStreamingText('');
    api.tasks.getLogs(taskId).then(d => { setLogs(d.logs); setLoading(false); }).catch(() => setLoading(false));
  }, [taskId]);

  useEffect(() => {
    if (!isLive) return;
    const unsubLog = wsClient.on('task:log', (event) => {
      const p = event.payload;
      if (p.taskId !== taskId) return;
      const entry: TaskLogEntry = { id: p.id as string, taskId: p.taskId as string, agentId: p.agentId as string, seq: p.seq as number, type: p.logType as string, content: p.content as string, metadata: p.metadata as Record<string, unknown> | undefined, createdAt: p.createdAt as string };
      setLogs(prev => { if (entry.id && prev.some(e => e.id === entry.id)) return prev; return [...prev, entry]; });
      if (entry.type === 'text') setStreamingText('');
    });
    const unsubDelta = wsClient.on('task:log:delta', (event) => {
      const p = event.payload;
      if (p.taskId !== taskId) return;
      setStreamingText(prev => prev + (p.text as string));
    });
    return () => { unsubLog(); unsubDelta(); };
  }, [taskId, isLive]);

  if (loading) return <div className="px-4 py-3 text-xs text-fg-tertiary">{t('profilePage.taskLog.loading')}</div>;
  if (logs.length === 0 && !streamingText) return <div className="px-4 py-3 text-xs text-fg-tertiary">{t('profilePage.taskLog.noLogs')}</div>;

  const streamEntries: ExecutionStreamEntryUI[] = logs.map(l => taskLogToStreamEntry(l));
  const hasMultipleRounds = new Set(streamEntries.filter(e => e.executionRound != null).map(e => e.executionRound!)).size > 1;

  return (
    <div className="px-3 py-2">
      {viewMode === 'compact' ? (
        <CompactExecutionCard entries={streamEntries} streamingText={streamingText} isActive={isLive} onExpand={() => setViewMode('full')} showRounds={hasMultipleRounds} />
      ) : (
        <FullExecutionLog entries={streamEntries} streamingText={streamingText} isActive={isLive} onCollapse={() => setViewMode('compact')} showRounds={hasMultipleRounds} />
      )}
    </div>
  );
}


// ─── Activity Log (Heartbeat / A2A) ─────────────────────────────────────────

function ActivityLog({ agentId, activityId, isLive = false }: { agentId: string; activityId: string; isLive?: boolean }) {
  const { t } = useTranslation('agent');
  const [logs, setLogs] = useState<AgentActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'compact' | 'full'>('compact');

  useEffect(() => {
    setLoading(true);
    api.agents.getActivityLogs(agentId, activityId)
      .then(d => { setLogs(d.logs); setLoading(false); })
      .catch(() => setLoading(false));
  }, [agentId, activityId]);

  useEffect(() => {
    if (!isLive) return;
    const unsub = wsClient.on('agent:activity_log', (event) => {
      const p = event.payload;
      if (p.agentId !== agentId || p.activityId !== activityId) return;
      const entry: AgentActivityLogEntry = {
        seq: p.seq as number,
        type: p.type as AgentActivityLogEntry['type'],
        content: p.content as string,
        metadata: p.metadata as Record<string, unknown> | undefined,
        createdAt: p.createdAt as string,
      };
      setLogs(prev => {
        if (prev.some(e => e.seq === entry.seq)) return prev;
        return [...prev, entry];
      });
    });
    return unsub;
  }, [agentId, activityId, isLive]);

  if (loading) return <div className="px-4 py-3 text-xs text-fg-tertiary">{t('profilePage.activityLog.loading')}</div>;
  if (logs.length === 0) return <div className="px-4 py-3 text-xs text-fg-tertiary">{t('profilePage.activityLog.noLogs')}</div>;

  const streamEntries: ExecutionStreamEntryUI[] = logs.map(e => activityLogToStreamEntry(e, activityId, agentId)).filter((e): e is ExecutionStreamEntryUI => e !== null);

  return (
    <div className="px-3 py-2">
      {viewMode === 'compact' ? (
        <CompactExecutionCard entries={streamEntries} isActive={isLive} onExpand={() => setViewMode('full')} />
      ) : (
        <FullExecutionLog entries={streamEntries} isActive={isLive} onCollapse={() => setViewMode('compact')} />
      )}
    </div>
  );
}

// ─── Shared UI ───────────────────────────────────────────────────────────────

function Card({ title, action, children }: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-surface-elevated rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function KV({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (<div className="flex flex-col gap-0.5"><span className="text-[10px] text-fg-tertiary">{label}</span><span className={`text-xs text-fg-secondary ${mono ? 'font-mono text-[10px]' : ''}`}>{children}</span></div>);
}

function StatBox({ label, value, color }: { label: string; value: string; color?: string }) {
  const c = color === 'green' ? 'text-green-500' : color === 'blue' ? 'text-blue-400' : color === 'indigo' ? 'text-brand-500' : color === 'red' ? 'text-red-400' : 'text-fg-secondary';
  return (<div className="flex items-baseline gap-1.5"><span className={`text-sm font-semibold ${c}`}>{value}</span><span className="text-[10px] text-fg-tertiary">{label}</span></div>);
}

const HEARTBEAT_PRESETS_MS = [
  30 * 60 * 1000,
  60 * 60 * 1000,
  3 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];
const HEARTBEAT_MIN_MINUTES = 5;
const HEARTBEAT_MAX_MINUTES = 24 * 60;

// Editable safety-net interval control (mirrors the StatBox layout).
function HeartbeatIntervalEditor({ agentId, intervalMs, onChanged }: { agentId: string; intervalMs: number; onChanged: () => void }) {
  const { t } = useTranslation(['agent', 'common']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customMin, setCustomMin] = useState(String(Math.round(intervalMs / 60000)));

  const presetLabel = (ms: number) =>
    ms % (60 * 60 * 1000) === 0
      ? t('agent:profilePage.heartbeatTab.intervalHours', { count: ms / (60 * 60 * 1000) })
      : t('agent:profilePage.heartbeatTab.intervalMinutes', { count: Math.round(ms / 60000) });

  const apply = async (ms: number) => {
    setSaving(true);
    setError(null);
    try {
      await api.agents.updateConfig(agentId, { heartbeatIntervalMs: ms });
      onChanged();
    } catch (err) {
      setError(String(err).replace('Error: ', ''));
    }
    setSaving(false);
  };

  const onSelectChange = (e: ChangeEvent<HTMLSelectElement>) => {
    if (e.target.value === 'custom') {
      setShowCustom(true);
      return;
    }
    setShowCustom(false);
    void apply(Number(e.target.value));
  };

  const applyCustom = () => {
    const min = Math.round(Number(customMin));
    if (!Number.isFinite(min) || min < HEARTBEAT_MIN_MINUTES || min > HEARTBEAT_MAX_MINUTES) {
      setError(t('agent:profilePage.heartbeatTab.intervalRangeHint'));
      return;
    }
    void apply(min * 60 * 1000);
  };

  const isPreset = HEARTBEAT_PRESETS_MS.includes(intervalMs);
  const selectValue = showCustom || !isPreset ? 'custom' : String(intervalMs);

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-fg-tertiary">{t('agent:profilePage.heartbeatTab.safetyNetInterval')}</span>
      <select
        value={selectValue}
        onChange={onSelectChange}
        disabled={saving}
        className="text-xs bg-bg-secondary border border-gray-700/50 rounded-md px-1.5 py-1 text-fg-secondary focus:outline-none focus:border-blue-500/50 disabled:opacity-40"
      >
        {!isPreset && <option value={String(intervalMs)}>{presetLabel(intervalMs)}</option>}
        {HEARTBEAT_PRESETS_MS.map(ms => (
          <option key={ms} value={String(ms)}>{presetLabel(ms)}</option>
        ))}
        <option value="custom">{t('agent:profilePage.heartbeatTab.intervalCustom')}</option>
      </select>
      {(showCustom || !isPreset) && (
        <div className="flex items-center gap-1.5 mt-1">
          <input
            type="number"
            min={HEARTBEAT_MIN_MINUTES}
            max={HEARTBEAT_MAX_MINUTES}
            value={customMin}
            onChange={e => setCustomMin(e.target.value)}
            disabled={saving}
            className="w-16 text-xs bg-bg-secondary border border-gray-700/50 rounded-md px-1.5 py-1 text-fg-secondary focus:outline-none focus:border-blue-500/50 disabled:opacity-40"
          />
          <span className="text-[10px] text-fg-tertiary">{t('agent:profilePage.heartbeatTab.intervalCustomUnit')}</span>
          <button
            onClick={applyCustom}
            disabled={saving}
            className="text-[10px] px-2 py-1 rounded-md bg-blue-600/20 text-blue-600 hover:bg-blue-600/30 border border-blue-500/30 transition-colors disabled:opacity-40"
          >
            {saving ? t('agent:profilePage.heartbeatTab.intervalSaving') : t('agent:profilePage.heartbeatTab.intervalSave')}
          </button>
        </div>
      )}
      {error && <span className="text-[10px] text-red-400">{error}</span>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-xs text-fg-tertiary py-6 text-center">{text}</div>;
}

function fmtBytesLocal(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

// ─── Mind Tab (Mailbox & Attention) ──────────────────────────────────────────

const PRIORITY_KEYS: Record<number, string> = { 0: '0', 1: '1', 2: '2', 3: '3', 4: '4' };
const PRIORITY_COLORS: Record<number, string> = { 0: 'text-red-500', 1: 'text-amber-500', 2: 'text-fg-secondary', 3: 'text-fg-tertiary', 4: 'text-fg-tertiary/60' };
const DECISION_COLORS: Record<string, string> = {
  pick: 'bg-brand-500/20 text-brand-500',
  continue: 'bg-gray-500/20 text-gray-500',
  preempt: 'bg-amber-500/20 text-amber-500',
  merge: 'bg-blue-500/20 text-blue-500',
  defer: 'bg-purple-500/20 text-purple-500',
  delegate: 'bg-green-500/20 text-green-500',
  drop: 'bg-red-500/20 text-red-500',
};
const ATTENTION_COLORS: Record<string, string> = {
  idle: 'bg-green-500/20 text-green-500',
  focused: 'bg-brand-500/20 text-brand-500',
  deciding: 'bg-amber-500/20 text-amber-500',
};

const MAILBOX_TYPE_ICONS: Record<string, string> = {
  system_event: '⚙', human_chat: '💬', task_comment: '💬',
  mention: '@', session_reply: '↩', task_status_update: '📋', a2a_message: '🔗',
  review_request: '👀', requirement_update: '📝', requirement_comment: '💬', daily_report: '📊',
  heartbeat: '♡', memory_consolidation: '🧠',
};

const CATEGORY_FILTER_KEYS = ['all', 'interaction', 'task', 'notification', 'system'] as const;

const CATEGORY_SOURCE_TYPES: Record<string, string[]> = {
  interaction: ['human_chat', 'a2a_message', 'mention'],
  task: ['task_status_update', 'task_comment', 'requirement_comment', 'review_request', 'session_reply'],
  notification: ['requirement_update'],
  system: ['system_event', 'heartbeat', 'daily_report', 'memory_consolidation'],
};

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-500', processing: 'bg-blue-400 animate-pulse',
  deferred: 'bg-purple-400', merged: 'bg-brand-400', queued: 'bg-amber-400', dropped: 'bg-red-500',
};

const ACTIVITY_FILTER_KEYS: Array<AgentActivityType | 'all'> = ['all', 'task', 'chat', 'heartbeat', 'a2a', 'internal', 'respond_in_session'];

const ACTIVITY_ICONS: Record<string, string> = {
  task: '☑', chat: '💬', heartbeat: '♡', a2a: '🔗', internal: '⚙', respond_in_session: '↩',
};

const STATUS_DISPLAY_COLORS: Record<string, string> = {
  pending: 'text-gray-400',
  assigned: 'text-blue-400',
  in_progress: 'text-brand-400',
  completed: 'text-green-400',
  failed: 'text-red-400',
  cancelled: 'text-gray-500',
  review: 'text-amber-400',
  approved: 'text-green-500',
  rejected: 'text-red-500',
  draft: 'text-gray-400',
};

/**
 * Extract the actual comment text from a mailbox content payload.
 * The content typically looks like:
 *   `... Comment from Author: <actual text>\n\n**MANDATORY ...`
 * We extract just the user-written comment, trimmed to a reasonable preview length.
 */
function extractCommentText(content: string): string | undefined {
  // Pattern: "Comment from AuthorName: actual comment text"
  const m = content.match(/Comment from .+?:\s*(.+?)(?:\n\n\*\*MANDATORY|\n\n---|\n\n\[|$)/s);
  if (m?.[1]) {
    const text = m[1].trim().replace(/\n/g, ' ');
    if (text.length > 80) return text.slice(0, 80) + '…';
    return text;
  }
  return undefined;
}

/**
 * Extract user-friendly display title and optional subtitle from a mailbox item,
 * replacing raw prompt text with structured information.
 */
function getMailboxItemDisplay(item: import('../api.ts').EnrichedMailboxItem, t: TFunction): { title: string; subtitle?: string; badge?: { label: string; color: string } } {
  const payload = item.payload;
  const summary = payload?.summary ?? '';
  const content = payload?.content ?? '';
  const sender = item.metadata?.senderName as string | undefined;

  switch (item.sourceType) {
    case 'task_status_update': {
      const titleMatch = summary.match(/^Task "(.+?)" status:/);
      const statusMatch = summary.match(/status:\s*(\S+)\s*→\s*(\S+)/);
      const taskTitle = titleMatch?.[1] ?? summary;
      if (statusMatch) {
        const from = statusMatch[1];
        const to = statusMatch[2];
        const fromLabel = taskStatusLabel(from, t);
        const fromColor = STATUS_DISPLAY_COLORS[from] ?? 'text-fg-tertiary';
        const toLabel = taskStatusLabel(to, t);
        const toColor = STATUS_DISPLAY_COLORS[to] ?? 'text-fg-secondary';
        return {
          title: taskTitle,
          subtitle: t('agent:profilePage.mind.mailbox.statusArrow', { from: fromLabel, to: toLabel }),
          badge: { label: toLabel, color: toColor },
        };
      }
      const execMatch = summary.match(/^Task:\s*(.+)/);
      if (execMatch) return { title: execMatch[1] };
      return { title: taskTitle };
    }

    case 'task_comment': {
      const m = summary.match(/^Comment on task "(.+?)" from (.+?)(\s*\(\+\d+\))?$/);
      const commentText = extractCommentText(content);
      if (m) {
        const sub = commentText
          ? t('agent:profilePage.mind.mailbox.commentFromAuthor', { author: m[2], text: commentText })
          : t('agent:profilePage.mind.mailbox.commentFrom', { name: m[2] });
        return { title: m[1], subtitle: sub };
      }
      return { title: summary };
    }

    case 'requirement_update': {
      const titleMatch = summary.match(/^Requirement "(.+?)"\s+(.*)/);
      if (titleMatch) return { title: titleMatch[1], subtitle: titleMatch[2] };
      return { title: summary };
    }

    case 'requirement_comment': {
      const m = summary.match(/^Comment on requirement "(.+?)" from (.+?)(\s*\(\+\d+\))?$/);
      const commentText = extractCommentText(content);
      if (m) {
        const sub = commentText
          ? t('agent:profilePage.mind.mailbox.commentFromAuthor', { author: m[2], text: commentText })
          : t('agent:profilePage.mind.mailbox.commentFrom', { name: m[2] });
        return { title: m[1], subtitle: sub };
      }
      return { title: summary };
    }

    case 'human_chat': {
      const preview = content.slice(0, 120).replace(/\n/g, ' ');
      return {
        title: sender ? t('agent:profilePage.mind.mailbox.chatFrom', { sender }) : t('agent:profilePage.mind.mailbox.humanChat'),
        subtitle: preview + (content.length > 120 ? '…' : ''),
      };
    }

    case 'a2a_message': {
      const preview = content.slice(0, 120).replace(/\n/g, ' ');
      return {
        title: sender ? t('agent:profilePage.mind.mailbox.messageFrom', { sender }) : t('agent:profilePage.mind.mailbox.agentMessage'),
        subtitle: preview + (content.length > 120 ? '…' : ''),
      };
    }

    case 'mention': {
      const m = summary.match(/from (.+)$/);
      const commentText = extractCommentText(content);
      return {
        title: m ? t('agent:profilePage.mind.mailbox.mentionedBy', { name: m[1] }) : t('agent:profilePage.mind.mailbox.mention'),
        subtitle: commentText || undefined,
      };
    }

    case 'review_request': {
      const preview = content.slice(0, 120).replace(/\n/g, ' ');
      return {
        title: sender ? t('agent:profilePage.mind.mailbox.reviewRequestFrom', { sender }) : t('agent:profilePage.mind.mailbox.reviewRequest'),
        subtitle: preview + (content.length > 120 ? '…' : ''),
      };
    }

    case 'session_reply': {
      const preview = content.slice(0, 120).replace(/\n/g, ' ');
      return {
        title: sender ? t('agent:profilePage.mind.mailbox.replyInSession', { sender }) : t('agent:profilePage.mind.mailbox.sessionReply'),
        subtitle: preview + (content.length > 120 ? '…' : ''),
      };
    }

    case 'heartbeat':
      return { title: t('agent:profilePage.mind.mailbox.scheduledHeartbeat') };

    case 'daily_report':
      return { title: t('agent:profilePage.mind.mailbox.dailyReport') };

    case 'memory_consolidation':
      return { title: t('agent:profilePage.mind.mailbox.memoryConsolidation') };

    case 'system_event': {
      const annoMatch = summary.match(/^\[Announcement]\s*(.+)/);
      if (annoMatch) return { title: annoMatch[1], subtitle: t('agent:profilePage.mind.mailbox.systemAnnouncement') };
      return { title: summary || t('agent:profilePage.mind.mailbox.systemEvent') };
    }

    default:
      return { title: summary || item.sourceType };
  }
}

function MindTab({ agentId, highlightId, agentStatus, canManageAgents }: { agentId: string; highlightId?: string; agentStatus?: string; canManageAgents?: boolean }) {
  const { t } = useTranslation(['agent', 'common', 'team']);
  const [mind, setMind] = useState<import('../api.ts').AgentMindState | null>(null);
  const [mailbox, setMailbox] = useState<import('../api.ts').AgentMailboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [catFilter, setCatFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(highlightId ?? null);
  const [highlightedId, setHighlightedId] = useState<string | null>(highlightId ?? null);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [notebookExpanded, setNotebookExpanded] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const PAGE = 50;
  const QUEUE_COLLAPSE_THRESHOLD = 3;

  const load = useCallback(async (reset = true) => {
    if (reset) setLoading(true);
    try {
      const catParam = catFilter === 'all' ? undefined : catFilter;
      const statusParam = statusFilter === 'all' ? undefined : statusFilter;
      const [m, mb] = await Promise.all([
        api.agents.getMindState(agentId),
        api.agents.getMailbox(agentId, { limit: PAGE, category: catParam, status: statusParam }),
      ]);
      setMind(m);
      setMailbox(mb);
      setHasMore((mb.history?.length ?? 0) >= PAGE);
    } catch { /* ignore */ }
    setLoading(false);
  }, [agentId, catFilter, statusFilter]);

  const loadMore = useCallback(async () => {
    if (!mailbox) return;
    const catParam = catFilter === 'all' ? undefined : catFilter;
    const statusParam = statusFilter === 'all' ? undefined : statusFilter;
    try {
      const mb = await api.agents.getMailbox(agentId, { limit: PAGE, offset: mailbox.history.length, category: catParam, status: statusParam });
      setMailbox(prev => prev ? { ...prev, history: [...prev.history, ...mb.history] } : mb);
      setHasMore((mb.history?.length ?? 0) >= PAGE);
    } catch { /* ignore */ }
  }, [agentId, mailbox, catFilter, statusFilter]);

  useEffect(() => {
    setExpandedId(highlightId ?? null);
    setHighlightedId(highlightId ?? null);
    load();
  }, [load, highlightId]);

  // Auto-load more history until the highlighted item appears, then scroll to it
  const autoLoadingForHighlightRef = useRef(false);
  useEffect(() => {
    if (!highlightedId || loading) return;
    const found = mailbox?.history?.some(h => h.id === highlightedId);
    if (found) {
      autoLoadingForHighlightRef.current = false;
      const el = document.getElementById(`mbx-${highlightedId}`);
      if (el) {
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
        const timer = setTimeout(() => setHighlightedId(null), 3000);
        return () => clearTimeout(timer);
      }
    } else if (hasMore && !autoLoadingForHighlightRef.current) {
      autoLoadingForHighlightRef.current = true;
      (async () => {
        let currentHistory = mailbox?.history ?? [];
        let moreAvailable: boolean = hasMore;
        while (moreAvailable) {
          try {
            const mb = await api.agents.getMailbox(agentId, { limit: PAGE, offset: currentHistory.length });
            const newHistory = [...currentHistory, ...mb.history];
            currentHistory = newHistory;
            moreAvailable = (mb.history?.length ?? 0) >= PAGE;
            const itemFound = mb.history.some(h => h.id === highlightedId);
            setMailbox(prev => prev ? { ...prev, history: newHistory } : mb);
            setHasMore(moreAvailable);
            if (itemFound || !moreAvailable) break;
          } catch { break; }
        }
        autoLoadingForHighlightRef.current = false;
      })();
    }
  }, [highlightedId, loading, mailbox, hasMore, agentId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = (evt: { payload?: unknown }) => {
      if ((evt.payload as { agentId?: string })?.agentId !== agentId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; load(false); }, 500);
    };
    const unsubs = [
      wsClient.on('agent:mailbox', refresh),
      wsClient.on('agent:decision', refresh),
      wsClient.on('agent:attention', refresh),
      wsClient.on('agent:focus', refresh),
      wsClient.on('agent:update', refresh),
      wsClient.on('agent:triage', refresh),
    ];
    return () => { if (timer) clearTimeout(timer); unsubs.forEach(u => u()); };
  }, [agentId, load]);

  if (loading && !mind) return <div className="text-fg-tertiary text-sm animate-pulse">{t('agent:profilePage.mind.loading')}</div>;

  const queueDepth = mind?.mailboxDepth ?? mind?.queuedItems?.length ?? 0;
  // 「心智」展示的是注意力循环的内部状态。进程停止时该循环不存在，因此所有派生
  // 结论（等待新消息 / 队列应即将被接手 / 有项卡在 processing）都是假的。
  const agentRunning = agentStatusPresentation(agentStatus).running;
  const effectiveAttentionState: string = (() => {
    const raw = mind?.attentionState ?? 'idle';
    if (raw === 'deciding') return 'deciding';
    // Focused without a focus object is a transient race — keep "focused" only when
    // we still have a focus; otherwise fall back. But idle + non-empty queue is NOT
    // truly idle (lost-wakeup / about to pick) — surface as deciding so the UI
    // doesn't claim "waiting for mail" while work is piled up.
    if (raw === 'idle' && queueDepth > 0) return 'deciding';
    if (raw !== 'idle' && !mind?.currentFocus) return 'idle';
    return raw;
  })();

  const hasStaleProcessingItems = effectiveAttentionState === 'idle' && mailbox?.history?.some(h => h.status === 'processing');
  const hasStuckQueue = (mind?.attentionState ?? 'idle') === 'idle' && queueDepth > 0;

  return (
    <div className="space-y-4">
      {/* ── Current State ── */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          {/* 注意力状态 ≠ 进程状态：`attention.idle` 的意思是「循环在等活」，而进程
              停止时根本没有循环。它曾与进程状态共用「空闲」一词，于是概览页上出现两个
              含义不同的「空闲」，停止后还会声称「等待新消息」。 */}
          {!agentRunning ? (
            <span className="px-2.5 py-1 text-xs font-medium rounded-full bg-gray-500/20 text-fg-tertiary">
              {t('agent:profilePage.mind.agentStopped')}
            </span>
          ) : (
            <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${ATTENTION_COLORS[effectiveAttentionState] ?? 'bg-gray-500/20 text-gray-500'}`}>
              {t(`agent:profilePage.mind.attention.${effectiveAttentionState}`)}
            </span>
          )}
          {!agentRunning ? (
            <span className="text-sm text-fg-tertiary">{t('agent:profilePage.mind.stoppedHint')}</span>
          ) : mind?.currentFocus ? (() => {
            const focusDisplay = getMailboxItemDisplay({
              id: mind.currentFocus.mailboxItemId,
              agentId,
              sourceType: mind.currentFocus.type,
              priority: 0,
              status: 'processing',
              payload: { summary: mind.currentFocus.label, taskId: mind.currentFocus.taskId },
              metadata: {},
              queuedAt: mind.currentFocus.startedAt,
            } as import('../api.ts').EnrichedMailboxItem, t);
            return (
              <span className="text-sm text-fg-secondary inline-flex items-center gap-2">
                <span>
                  {MAILBOX_TYPE_ICONS[mind.currentFocus.type] ?? '●'}{' '}
                  <span className="text-fg-primary font-medium">{focusDisplay.title}</span>
                  {focusDisplay.subtitle && <span className="text-fg-tertiary ml-1.5 text-xs">{focusDisplay.subtitle}</span>}
                  <span className="text-fg-tertiary ml-2 text-xs">{t('agent:profilePage.mind.since', { time: new Date(mind.currentFocus.startedAt).toLocaleTimeString() })}</span>
                </span>
                {canManageAgents && (
                  <button
                    onClick={() => setCancelConfirmId(mind.currentFocus!.mailboxItemId)}
                    className="px-2 py-0.5 text-[10px] font-medium rounded-md bg-red-500/15 text-red-500 hover:bg-red-500/25 transition-colors shrink-0"
                  >
                    ✕ {t('agent:profilePage.mind.cancelCurrentBtn')}
                  </button>
                )}
              </span>
            );
          })() : hasStuckQueue ? (
            <span className="text-sm text-amber-500">{t('agent:profilePage.mind.queuedButIdle', { count: queueDepth, defaultValue: 'Queue has {{count}} item(s) — attention loop should pick them up…' })}</span>
          ) : effectiveAttentionState === 'deciding' ? (
            <span className="text-sm text-amber-500">{t('agent:profilePage.mind.decidingWaiting', { count: queueDepth })}</span>
          ) : (
            <span className="text-sm text-fg-tertiary">{t('agent:profilePage.mind.idleWaiting')}</span>
          )}
          {/* 【为什么不在这里放启停按钮】启停是 Agent 生命周期，归概览页那颗唯一
              按钮管（OverviewTab）。mind 曾经也画一颗，而概览页把两个区块叠在一起
              渲染，于是同一页出现两个「停止」。这里只留「刷新」。 */}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => { load(); }} className="text-xs text-fg-tertiary hover:text-fg-secondary active:text-fg-primary transition-colors">{t('agent:profilePage.mind.refresh')}</button>
          </div>
        </div>

        {agentRunning && hasStaleProcessingItems && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center gap-2">
            <span className="text-amber-500 text-sm">⚠</span>
            <span className="text-[11px] text-amber-600">{t('agent:profilePage.mind.staleProcessingWarning')}</span>
          </div>
        )}

        {(mind?.queuedItems?.length ?? 0) > 0 && (() => {
          const items = mind!.queuedItems;
          const shouldCollapse = items.length > QUEUE_COLLAPSE_THRESHOLD;
          const visibleItems = shouldCollapse && !queueExpanded ? items.slice(0, QUEUE_COLLAPSE_THRESHOLD) : items;
          const typeCounts = items.reduce<Record<string, number>>((acc, item) => {
            acc[item.sourceType] = (acc[item.sourceType] ?? 0) + 1;
            return acc;
          }, {});
          return (
            <div className="mb-3">
              <div className="flex items-center gap-2 mb-1.5">
                <h4 className="text-xs font-medium text-amber-500 uppercase tracking-wider">{t('agent:profilePage.mind.queue', { count: items.length })}</h4>
                <div className="flex gap-1.5 flex-wrap">
                  {Object.entries(typeCounts).map(([type, count]) => (
                    <span key={type} className="text-[10px] text-fg-tertiary bg-amber-500/10 px-1.5 py-0.5 rounded">
                      {MAILBOX_TYPE_ICONS[type] ?? '●'} {count}
                    </span>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                {visibleItems.map((item, i) => (
                  <div key={item.id} className="flex items-center gap-2 px-3 py-1.5 rounded bg-amber-500/5 border border-amber-500/20 text-sm">
                    <span className="text-fg-tertiary w-4 text-right text-xs">{i + 1}</span>
                    <span className="text-sm">{MAILBOX_TYPE_ICONS[item.sourceType] ?? '●'}</span>
                    <span className={`text-[10px] ${PRIORITY_COLORS[item.priority] ?? 'text-fg-tertiary'}`}>{t(`agent:profilePage.mind.priority.${PRIORITY_KEYS[item.priority] ?? item.priority}`, { defaultValue: `P${item.priority}` })}</span>
                    <span className="text-fg-secondary truncate flex-1 text-xs">{item.summary}</span>
                    <span className="text-[10px] text-fg-tertiary">{new Date(item.queuedAt).toLocaleTimeString()}</span>
                  </div>
                ))}
                {shouldCollapse && (
                  <button
                    onClick={() => setQueueExpanded(!queueExpanded)}
                    className="w-full text-center text-[11px] text-amber-500 hover:text-amber-400 py-1 transition-colors"
                  >
                    {queueExpanded
                      ? t('agent:profilePage.mind.collapseQueue')
                      : t('agent:profilePage.mind.expandQueue', { count: items.length - QUEUE_COLLAPSE_THRESHOLD })}
                  </button>
                )}
              </div>
            </div>
          );
        })()}
      </section>

      {/* ── Notebook (Cognitive Workspace) ── */}
      {(mind?.notebook?.length ?? 0) > 0 && (() => {
        const nb = sliceNotebookForDisplay(mind!.notebook, notebookExpanded);
        return (
          <section className="bg-surface-2 rounded-lg border border-border-subtle p-3">
            <details>
              <summary className="flex items-center gap-2 cursor-pointer list-none">
                <span className="text-sm">📓</span>
                <h4 className="text-xs font-medium text-fg-secondary uppercase tracking-wider">{t('agent:profilePage.mind.notebook')}</h4>
                <span className="text-[10px] text-fg-quaternary ml-auto">
                  {t('agent:profilePage.mind.notebookEntries', { count: mind!.notebook!.length })}
                </span>
              </summary>
              <p className="mt-2 text-[10px] text-fg-quaternary leading-relaxed">{t('agent:profilePage.mind.notebookHint', { count: NOTEBOOK_DISPLAY_LIMIT })}</p>
              <div className="mt-2 space-y-2">
                {nb.visible.map(entry => {
                  const age = formatNotebookAge(entry.updatedAt);
                  const ageLabel = t(`agent:profilePage.relative.${age.unit === 'seconds' ? 'secondsAgo' : age.unit === 'minutes' ? 'minutesAgo' : 'hoursAgo'}`, { count: age.count, hours: age.count });
                  const managedColor = entry.managed === 'system' ? 'text-blue-400' : entry.managed === 'cpp' ? 'text-purple-400' : 'text-emerald-400';
                  return (
                    <div key={entry.key} className="px-3 py-2 rounded bg-surface-3 border border-border-subtle">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium text-fg-primary">{entry.key}</span>
                        <span className={`text-[10px] ${managedColor}`}>[{entry.managed}]</span>
                        <span className="text-[10px] text-fg-quaternary ml-auto">{ageLabel}</span>
                      </div>
                      <pre className="text-[11px] text-fg-secondary whitespace-pre-wrap break-words leading-relaxed max-h-32 overflow-y-auto">{entry.text.length > 500 ? entry.text.slice(0, 500) + '…' : entry.text}</pre>
                    </div>
                  );
                })}
                {nb.collapsible && (
                  <button
                    onClick={() => setNotebookExpanded(!notebookExpanded)}
                    className="w-full text-center text-[11px] text-accent-primary hover:opacity-80 py-1 transition-colors"
                  >
                    {notebookExpanded
                      ? t('agent:profilePage.mind.collapseQueue')
                      : t('agent:profilePage.mind.expandNotebook', { count: nb.hiddenCount })}
                  </button>
                )}
              </div>
            </details>
          </section>
        );
      })()}

      {/* ── Live Deliberation Activity ── */}
      {mind?.deliberationActivity && (
        <section className="bg-surface-2 rounded-lg border border-amber-500/20 p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm">🧠</span>
            <h4 className="text-xs font-medium text-amber-500 uppercase tracking-wider">{t('agent:profilePage.mind.deliberationInProgress')}</h4>
            <span className="text-[10px] text-fg-quaternary ml-auto">{t('agent:profilePage.mind.since', { time: new Date(mind.deliberationActivity.startedAt).toLocaleTimeString() })}</span>
          </div>
          <ActivityLog agentId={agentId} activityId={mind.deliberationActivity.activityId} isLive />
        </section>
      )}

      {/* ── Last Triage Decision ── */}
      {mind?.lastTriage && (() => {
        const triageAgeMs = Date.now() - new Date(mind.lastTriage.timestamp).getTime();
        const isStale = triageAgeMs > 60_000;
        return (
          <section className={`bg-surface-2 rounded-lg border p-3 transition-opacity ${isStale ? 'border-border-subtle opacity-60' : 'border-indigo-500/20'}`}>
            <details open={!isStale}>
              <summary className="flex items-center gap-2 cursor-pointer list-none">
                <span className="text-sm">🧠</span>
                <h4 className="text-xs font-medium text-indigo-400 uppercase tracking-wider">{t('agent:profilePage.mind.triageDecision')}</h4>
                <span className="text-[10px] text-fg-quaternary ml-auto">{new Date(mind.lastTriage.timestamp).toLocaleTimeString()}</span>
              </summary>
              <p className="text-xs text-fg-secondary leading-relaxed mt-2">{mind.lastTriage.reasoning}</p>
              <div className="flex flex-wrap gap-2 mt-2 text-[10px]">
                <span className="px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">{t('agent:profilePage.mind.processingItem', { id: mind.lastTriage.processedItemId.slice(0, 12) })}</span>
                {mind.lastTriage.deferredItemIds.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">{t('agent:profilePage.mind.deferred', { count: mind.lastTriage.deferredItemIds.length })}</span>
                )}
                {mind.lastTriage.droppedItemIds.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">{t('agent:profilePage.mind.dropped', { count: mind.lastTriage.droppedItemIds.length })}</span>
                )}
                {(mind.lastTriage.inlineCompletedIds?.length ?? 0) > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">{t('agent:profilePage.mind.inlineCompleted', { count: mind.lastTriage.inlineCompletedIds!.length })}</span>
                )}
              </div>
            </details>
          </section>
        );
      })()}

      {/* ── Mailbox History ── */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-xs font-medium text-fg-tertiary uppercase tracking-wider">{t('agent:profilePage.mind.mailboxHistory')}</h3>
          <div className="flex gap-1 ml-auto flex-wrap">
            {CATEGORY_FILTER_KEYS.map(key => {
              const stc = mailbox?.sourceTypeCounts;
              const catCount = key === 'all'
                ? (stc ? Object.values(stc).reduce((a, b) => a + b, 0) : undefined)
                : (stc ? (CATEGORY_SOURCE_TYPES[key] ?? []).reduce((s, t2) => s + (stc[t2] ?? 0), 0) : undefined);
              return (
                <button key={key} onClick={() => setCatFilter(key)}
                  className={`px-2 py-0.5 text-[10px] rounded-md border transition-colors ${
                    catFilter === key
                      ? 'bg-brand-500/20 border-brand-500/40 text-brand-300'
                      : 'bg-surface-2 border-border-subtle text-fg-secondary hover:bg-surface-3'
                  }`}
                >{t(`agent:profilePage.mind.categoryFilters.${key}`)}{catCount != null && catCount > 0 && <span className="ml-1 opacity-60">{catCount}</span>}</button>
              );
            })}
          </div>
        </div>
        <div className="flex gap-1 mb-2 flex-wrap">
          {[
            { key: 'all', dot: '' },
            { key: 'queued', dot: 'bg-amber-400' },
            { key: 'processing', dot: 'bg-blue-400' },
            { key: 'completed', dot: 'bg-green-500' },
            { key: 'merged', dot: 'bg-brand-400' },
            { key: 'deferred', dot: 'bg-purple-400' },
            { key: 'dropped', dot: 'bg-red-500' },
          ].map(f => {
            const sc = mailbox?.statusCounts;
            const cnt = f.key === 'all'
              ? (sc ? Object.values(sc).reduce((a, b) => a + b, 0) : undefined)
              : sc?.[f.key];
            return (
              <button key={f.key} onClick={() => setStatusFilter(f.key)}
                className={`px-2 py-0.5 text-[10px] rounded-md border transition-colors flex items-center gap-1 ${
                  statusFilter === f.key
                    ? 'bg-brand-500/20 border-brand-500/40 text-brand-300'
                    : 'bg-surface-2 border-border-subtle text-fg-secondary hover:bg-surface-3'
                }`}
              >{f.dot && <span className={`w-1.5 h-1.5 rounded-full ${f.dot}`} />}{t(`agent:profilePage.mind.statusFilters.${f.key}`)}{cnt != null && cnt > 0 && <span className="ml-1 opacity-60">{cnt}</span>}</button>
            );
          })}
        </div>

        {(!mailbox?.history || mailbox.history.length === 0) && !loading && (
          <div className="text-center text-fg-tertiary text-sm py-8">{t('agent:profilePage.mind.noHistory')}</div>
        )}

        <div className="space-y-1">
          {mailbox?.history?.map(item => {
            const isExpanded = expandedId === item.id;
            const icon = MAILBOX_TYPE_ICONS[item.sourceType] ?? '●';
            const display = getMailboxItemDisplay(item, t);
            const senderName = item.metadata?.senderName as string | undefined;
            const senderRole = item.metadata?.senderRole as string | undefined;
            const isHighlighted = highlightedId === item.id;
            return (
              <div key={item.id} id={`mbx-${item.id}`} className={`bg-surface-2 rounded-lg border transition-colors duration-1000 ${isHighlighted ? 'border-brand-500 ring-1 ring-brand-500/40' : 'border-border-subtle'}`}>
                <button
                  className="w-full px-3 py-2.5 flex items-start gap-2 text-left hover:bg-surface-3/50 transition-colors rounded-lg"
                  onClick={() => setExpandedId(isExpanded ? null : item.id)}
                >
                  <span className="text-xs mt-0.5 text-fg-tertiary">{isExpanded ? '▾' : '▸'}</span>
                  <span className={`w-2 h-2 mt-1.5 rounded-full shrink-0 ${STATUS_COLORS[item.status] ?? 'bg-gray-400'}`} />
                  <span className="text-sm">{icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium text-fg-primary ${isExpanded ? '' : 'truncate'}`}>{display.title}</span>
                      {display.badge && (
                        <span className={`text-[10px] font-medium shrink-0 ${display.badge.color}`}>{display.badge.label}</span>
                      )}
                      <span className={`text-[10px] shrink-0 ${PRIORITY_COLORS[item.priority] ?? 'text-fg-tertiary'}`}>{t(`agent:profilePage.mind.priority.${PRIORITY_KEYS[item.priority] ?? item.priority}`, { defaultValue: '' })}</span>
                    </div>
                    {display.subtitle && (
                      <div className={`text-[11px] text-fg-secondary mt-0.5 ${isExpanded ? '' : 'truncate'}`}>{display.subtitle}</div>
                    )}
                    <div className="text-[10px] text-fg-tertiary mt-0.5 flex gap-2 flex-wrap">
                      <span>{new Date(item.queuedAt).toLocaleString()}</span>
                      {item.completedAt && <span>→ {new Date(item.completedAt).toLocaleTimeString()}</span>}
                      {item.activity && (
                        <>
                          {item.activity.totalTokens > 0 && <span>{t('agent:profilePage.mind.tokensCount', { count: fmtNum(item.activity.totalTokens) })}</span>}
                          {item.activity.totalTools > 0 && <span>{t('agent:profilePage.mind.toolsCount', { count: item.activity.totalTools })}</span>}
                        </>
                      )}
                    </div>
                  </div>
                  <span className="text-[10px] text-fg-tertiary bg-surface-3 px-1.5 py-0.5 rounded shrink-0">{item.sourceType}</span>
                  {canManageAgents && item.status === 'processing' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setCancelConfirmId(item.id); }}
                      className="px-2 py-0.5 text-[10px] font-medium rounded-md bg-red-500/15 text-red-500 hover:bg-red-500/25 transition-colors shrink-0"
                    >
                      ✕ {t('agent:profilePage.mind.cancelCurrentBtn')}
                    </button>
                  )}
                </button>

                {isExpanded && (
                  <div className="border-t border-border-subtle px-3 py-3 space-y-3">
                    {/* Sender & contextual metadata */}
                    {senderName && (
                      <div className="text-[10px] text-fg-tertiary">
                        {t('agent:profilePage.mind.from')} <span className="text-fg-secondary">{senderName}</span>
                        {senderRole && <span className="text-fg-tertiary"> ({senderRole})</span>}
                      </div>
                    )}

                    {/* Full content for message-type items (chat, a2a, comments, reviews) */}
                    {item.payload?.content && ['human_chat', 'a2a_message', 'task_comment', 'requirement_comment', 'review_request', 'session_reply', 'mention'].includes(item.sourceType) && (
                      <div className="text-xs text-fg-secondary bg-surface-primary/50 rounded-md p-2.5 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
                        {item.payload.content}
                      </div>
                    )}

                    {/* Decisions for this item */}
                    {item.decisions && item.decisions.length > 0 && (
                      <div>
                        <h5 className="text-[10px] font-medium text-fg-tertiary uppercase tracking-wider mb-1">{t('agent:profilePage.mind.decisions')}</h5>
                        <div className="space-y-1">
                          {item.decisions.map((d: import('../api.ts').MailboxHistoryDecision) => (
                            <div key={d.id} className="flex items-start gap-2 text-xs">
                              <span className={`px-1.5 py-0.5 rounded shrink-0 ${DECISION_COLORS[d.decisionType] ?? 'bg-gray-500/20 text-gray-500'}`}>{d.decisionType}</span>
                              <span className="text-fg-secondary flex-1">{d.reasoning}</span>
                              <span className="text-fg-tertiary shrink-0">{new Date(d.createdAt).toLocaleTimeString()}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Activity log */}
                    {item.activity ? (
                      <div>
                        <h5 className="text-[10px] font-medium text-fg-tertiary uppercase tracking-wider mb-1">
                          {t('agent:profilePage.mind.activityHeading', { label: item.activity.label })}
                          <span className={`ml-2 inline-block px-1 py-0 rounded text-[9px] ${item.activity.success ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-500'}`}>
                            {item.activity.success ? t('agent:profilePage.mind.success') : t('agent:profilePage.mind.failed')}
                          </span>
                        </h5>
                        {item.activity.type === 'task' && item.payload?.taskId ? (
                          <TaskLog taskId={item.payload.taskId as string} isLive={!item.activity.endedAt} />
                        ) : (
                          <ActivityLog agentId={agentId} activityId={item.activity.id} isLive={!item.activity.endedAt} />
                        )}
                      </div>
                    ) : item.status === 'processing' ? (
                      <div className="text-xs text-fg-tertiary text-center py-2 animate-pulse">{t('agent:profilePage.mind.processing')}</div>
                    ) : item.status === 'completed' ? (
                      <div className="text-xs text-fg-tertiary text-center py-2">{t('agent:profilePage.mind.noActivityLog')}</div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {hasMore && (mailbox?.history?.length ?? 0) > 0 && (
          <div className="text-center mt-3">
            <button onClick={loadMore} className="text-xs text-brand-400 hover:text-brand-300 transition-colors">{t('agent:profilePage.mind.loadEarlier')}</button>
          </div>
        )}
      </section>

      {cancelConfirmId && (
        <ConfirmModal
          title={t('agent:profilePage.mind.cancelConfirmTitle')}
          message={t('agent:profilePage.mind.cancelConfirmMessage')}
          confirmLabel={t('agent:profilePage.mind.cancelCurrentBtn')}
          onConfirm={() => {
            // 【为什么必须带上 itemId】cancelConfirmId 就是用户点的那一条 mailbox
            // item。并发模式（workerCount > 1）下不带 target，后端
            // resolveCancelTargetWorker() 第一行 `if (!target) return undefined`
            // 会直接走 ALS 兼容路径；而取消是从 HTTP 请求线程发起的，那条线程
            // 没有 ALS 上下文，于是取消落不到真正在跑该 item 的 worker 上 ——
            // 表现就是「点了取消没反应，行一直停在处理中」。
            // 同源问题见 core/test/agent-concurrent-cancel-isolation.test.ts「根因 1」。
            const targetItemId = cancelConfirmId;
            setCancelConfirmId(null);
            api.agents.cancelProcessing(agentId, { itemId: targetItemId }).then(() => {
              // Cancel takes effect at the next yield — poll so the row leaves
              // "processing" / "思考中" instead of looking unchanged.
              let tries = 0;
              const poll = () => {
                tries += 1;
                void load();
                if (tries < 8) window.setTimeout(poll, 750);
              };
              poll();
            }).catch(() => { void load(); });
          }}
          onCancel={() => setCancelConfirmId(null)}
        />
      )}
    </div>
  );
}

// ─── Deliverables Tab ────────────────────────────────────────────────────────

function DeliverablesTab({ agentId }: { agentId: string }) {
  const { t } = useTranslation(['agent', 'common']);
  const layout = useLayout();
  const [items, setItems] = useState<DeliverableInfo[]>([]);
  const [loading, setLoading] = useState(true);

  /**
   * 点击产出：
   *  - 桌面端（当前页确实渲染了右侧栏）→ 在右侧栏就地预览，不离开当前页；
   *  - 移动端 / 无右侧栏宿主 → 跳到该产出物自己的页面（那里才是完整的详情与操作）。
   *
   * 【为什么判据是 hostAvailable 而不是「openRightPanel 是否存在」】后者永远为真
   * （它是 LayoutContext 上的常量），而「宿主页面此刻是否真的渲染右侧栏」是另一件事：
   * Team 页在移动端把 hostAvailable 设成 false
   * （`setHostAvailable(isActive && !isMobile)`）。旧判断因此**总是**走右侧栏分支——
   * 移动端点击只是往一个不存在的面板里塞了个 tab，表现就是「点了没反应」。
   * 规则本体在 lib/agentOverview.ts，便于用测试锁住（纯函数测试，本包无 jsdom）。
   */
  const openDeliverable = useCallback((item: DeliverableInfo) => {
    if (deliverableClickTarget(layout?.hostAvailable) === 'right-panel') {
      layout?.openRightPanel({ kind: 'deliverable', deliverable: item });
      return;
    }
    navBus.navigate(PAGE.DELIVERABLES, { openDeliverable: item.id });
  }, [layout]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { results } = await api.deliverables.search({ agentId, limit: 200 });
      setItems(results);
    } catch { setItems([]); }
    setLoading(false);
  }, [agentId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const unsub1 = wsClient.on('deliverable:created', () => refresh());
    const unsub2 = wsClient.on('deliverable:updated', () => refresh());
    const unsub3 = wsClient.on('deliverable:removed', () => refresh());
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [refresh]);

  if (loading) {
    return (
      <div className="space-y-3 py-4">
        {[1, 2, 3].map(i => (
          <div key={i} className="animate-pulse space-y-2">
            <div className="h-4 bg-surface-elevated rounded w-3/4" />
            <div className="h-3 bg-surface-elevated rounded w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <span className="text-3xl mb-3">📦</span>
        <p className="text-sm text-fg-secondary">{t('agent:deliverables.empty')}</p>
        <p className="text-xs text-fg-tertiary mt-1">{t('agent:deliverables.emptyHint')}</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        <div className="text-xs text-fg-tertiary mb-3">
          {t('agent:deliverables.count', { count: items.length })}
        </div>
        {items.map(item => {
          const typeMeta = DELIVERABLE_TYPE_META[item.type] ?? { icon: '📎', color: 'bg-surface-elevated text-fg-secondary' };
          const statusMeta = DELIVERABLE_STATUS_META[item.status] ?? DELIVERABLE_STATUS_META.active!;
          return (
            <button
              key={item.id}
              onClick={() => openDeliverable(item)}
              className="w-full text-left rounded-xl border border-border-default bg-surface-elevated/30 overflow-hidden transition-colors hover:border-brand-500/40 hover:bg-surface-elevated/50 px-4 py-3 flex items-start gap-3"
            >
              <span className={`inline-flex items-center justify-center w-8 h-8 rounded-lg text-sm shrink-0 ${typeMeta.color}`}>
                {typeMeta.icon}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-fg-primary truncate">{item.title}</span>
                  <span className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${statusMeta.color}`}>{item.status}</span>
                </div>
                {item.summary && (
                  <p className="text-xs text-fg-tertiary mt-0.5 line-clamp-1">{item.summary}</p>
                )}
                <div className="flex items-center gap-3 mt-1 text-[10px] text-fg-tertiary">
                  <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                  {item.tags.length > 0 && <span>{item.tags.slice(0, 3).join(', ')}</span>}
                </div>
              </div>
              <svg className="w-4 h-4 text-fg-tertiary shrink-0 mt-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          );
        })}
      </div>
    </>
  );
}
