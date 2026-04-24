import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api, wsClient, hubApi, kebab } from '../api.ts';
import type { AgentDetail, AgentToolInfo, AgentMemorySummary, AgentHeartbeatInfo, TaskInfo, TaskLogEntry, AgentUsageInfo, ExternalAgentInfo, ActivitySummary, AgentActivityLogEntry, ActivityRecord, AgentActivityType, RoleUpdateStatus, StorageAgentItem } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { ExecEntryRow, StreamingText, taskLogToEntry, activityLogToEntry, filterCompletedStarts, attachSubagentLogsToEntries, CompactExecutionCard, FullExecutionLog, type ExecEntry, type ToolCallInfo, type ExecutionStreamEntryUI } from '../components/ExecutionTimeline.tsx';
import { taskLogToStreamEntry, activityLogToStreamEntry } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { Avatar, AvatarUpload } from '../components/Avatar.tsx';

interface Props { agentId: string; onBack: () => void; inline?: boolean; defaultTab?: ProfileTab; onSwipeBack?: () => void; highlightMailboxId?: string }

type ProfileTab = 'overview' | 'mind' | 'tools' | 'skills' | 'memory' | 'heartbeat' | 'files';

const TAB_DEF: Array<{ key: ProfileTab; icon: string }> = [
  { key: 'overview', icon: '▦' },
  { key: 'mind', icon: '🔮' },
  { key: 'files', icon: '📄' },
  { key: 'tools', icon: '⚒' },
  { key: 'skills', icon: '◆' },
  { key: 'memory', icon: '🧠' },
  { key: 'heartbeat', icon: '♡' },
];

function taskStatusLabel(status: string, t: TFunction): string {
  return t(`agent:profilePage.taskStatus.${status}`, { defaultValue: status.replace(/_/g, ' ') });
}

function agentRuntimeStatusLabel(status: string, t: TFunction): string {
  const map: Record<string, string> = {
    idle: 'common:status.idle',
    working: 'common:status.working',
    offline: 'common:status.offline',
    paused: 'common:status.paused',
    error: 'common:status.error',
  };
  const key = map[status];
  return key ? t(key) : status;
}

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-green-400', working: 'bg-blue-400 animate-pulse',
  paused: 'bg-amber-400', offline: 'bg-gray-500', error: 'bg-red-400',
};

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function AgentProfile({ agentId, onBack, inline, defaultTab, onSwipeBack, highlightMailboxId }: Props) {
  const { t } = useTranslation(['agent', 'common']);
  const isMobile = useIsMobile();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [tab, setTab] = useState<ProfileTab>(defaultTab ?? 'overview');
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

  const statusDot = STATUS_DOT[agent.state.status] ?? 'bg-gray-500';

  return (
    <div className="flex-1 overflow-y-auto bg-surface-primary">
      <div className="px-5 py-3.5 border-b border-border-default bg-surface-secondary sticky top-0 z-10">
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
                alert(t('agent:profilePage.publishSuccess', { name: agent.name }));
              } catch (e) { alert(t('agent:profilePage.publishFailed', { error: String(e) })); }
            }} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors flex items-center gap-1" title={t('agent:profilePage.publishTitle')}><span>↑</span> {t('agent:profilePage.hub')}</button>
            {inline && <button onClick={onBack} className="p-1.5 text-fg-tertiary hover:text-fg-secondary text-lg leading-none">×</button>}
          </div>
        </div>
        <div ref={tabBarRef} className="flex gap-1 mt-3 -mb-[1px] overflow-x-auto scrollbar-hide">
          {tabs.filter(tabRow => !externalInfo || ['overview', 'mind'].includes(tabRow.key)).map(tabRow => (
            <button key={tabRow.key} onClick={() => setTab(tabRow.key)} data-active={tab === tabRow.key}
              className={`px-3 py-1.5 text-xs rounded-t-lg border border-b-0 transition-colors whitespace-nowrap ${
                tab === tabRow.key ? 'bg-surface-primary text-fg-primary border-border-default' : 'text-fg-tertiary border-transparent hover:text-fg-secondary hover:bg-surface-elevated/50'
              }`}
            ><span className="mr-1">{tabRow.icon}</span>{tabRow.label}</button>
          ))}
        </div>
      </div>
      <div className="p-5" onTouchStart={isMobile ? profileSwipe.onTouchStart : undefined} onTouchEnd={isMobile ? profileSwipe.onTouchEnd : undefined}>
        {tab === 'overview' && <OverviewTab agent={agent} onUpdate={reload} externalInfo={externalInfo} t={t} />}
        {tab === 'mind' && <MindTab agentId={agentId} highlightId={highlightMailboxId} />}
        {tab === 'files' && <FilesTab agentId={agentId} />}
        {tab === 'tools' && <ToolsTab tools={agent.tools ?? []} />}
        {tab === 'skills' && <SkillsTab agent={agent} />}
        {tab === 'memory' && <MemoryTab agentId={agentId} />}
        {tab === 'heartbeat' && <HeartbeatTab agentId={agentId} initialData={agent.heartbeat} />}
      </div>
    </div>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────────────────

function OverviewTab({ agent, onUpdate, externalInfo, t }: { agent: AgentDetail; onUpdate: () => void; externalInfo?: ExternalAgentInfo | null; t: TFunction }) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(agent.name);
  const [editRole, setEditRole] = useState(agent.agentRole);
  const [editModelMode, setEditModelMode] = useState<'default' | 'custom'>((agent.config?.llmConfig as Record<string, unknown>)?.modelMode as 'default' | 'custom' ?? 'default');
  const [editModel, setEditModel] = useState(agent.config?.llmConfig.primary ?? '');
  const [editFallback, setEditFallback] = useState(agent.config?.llmConfig.fallback ?? '');
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<Record<string, { model: string; configured: boolean }>>({});
  const [defaultProvider, setDefaultProvider] = useState('');
  const [recentTasks, setRecentTasks] = useState<TaskInfo[]>([]);
  const [usageInfo, setUsageInfo] = useState<AgentUsageInfo | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [recentActivities, setRecentActivities] = useState<ActivitySummary[]>([]);
  const [expandedActivityId, setExpandedActivityId] = useState<string | null>(null);
  const [agentStorage, setAgentStorage] = useState<StorageAgentItem | null>(null);
  const [agentDataDir, setAgentDataDir] = useState('');

  useEffect(() => {
    api.settings.getLlm().then(d => {
      setProviders(d.providers);
      setDefaultProvider(d.defaultProvider);
    }).catch(() => {});
    api.tasks.list({ assignedAgentId: agent.id }).then(d => setRecentTasks(d.tasks.slice(0, 5))).catch(() => {});
    api.usage.agents().then(d => {
      const info = d.agents.find(a => a.agentId === agent.id);
      if (info) setUsageInfo(info);
    }).catch(() => {});
    api.agents.getRecentActivities(agent.id).then(d => setRecentActivities(d.activities)).catch(() => {});
    api.system.storage().then(info => {
      setAgentDataDir(info.dataDir + '/agents/' + agent.id);
      const match = info.agents.find(a => a.id === agent.id);
      if (match) setAgentStorage(match);
    }).catch(() => {});
  }, [agent.id]);

  const configuredModels = Object.entries(providers).filter(([, v]) => v.configured).map(([k]) => k);
  const currentModelMode = ((agent.config?.llmConfig as Record<string, unknown>)?.modelMode as string) ?? 'default';

  const save = async () => {
    setSaving(true);
    try {
      await api.agents.updateConfig(agent.id, {
        name: editName, agentRole: editRole,
        llmConfig: {
          modelMode: editModelMode,
          primary: editModelMode === 'custom' ? editModel : defaultProvider,
          fallback: editFallback || undefined,
        },
      });
      onUpdate();
      setEditing(false);
    } catch { /* */ }
    setSaving(false);
  };

  const toggleAgent = () => {
    if (agent.state.status === 'offline') api.agents.start(agent.id).then(onUpdate);
    else api.agents.stop(agent.id).then(onUpdate);
  };

  const TASK_DOT: Record<string, string> = { pending: 'bg-gray-400', assigned: 'bg-blue-400', in_progress: 'bg-brand-400', completed: 'bg-green-400', failed: 'bg-red-400', cancelled: 'bg-gray-600' };

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
          <div className="grid grid-cols-4 gap-4">
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
              <div key={f.field} className="flex items-start gap-2.5 px-3 py-2 rounded-lg bg-surface-elevated/30 border border-border-default/30">
                <span className="font-mono text-[10px] text-brand-500 shrink-0 pt-0.5">{f.field}</span>
                <span className="text-[10px] text-fg-tertiary">{f.desc}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title={t('agent:profilePage.overview.gatewayEndpoints')}>
          <div className="space-y-1.5">
            {GATEWAY_ENDPOINTS.map(ep => (
              <div key={ep.path} className="flex items-start gap-2.5 px-3 py-2 rounded-lg bg-surface-elevated/30 border border-border-default/30">
                <span className={`text-[10px] font-semibold shrink-0 pt-0.5 ${ep.method === 'POST' ? 'text-amber-600' : 'text-green-600'}`}>{ep.method}</span>
                <span className="font-mono text-[10px] text-fg-secondary shrink-0 pt-0.5">{ep.path}</span>
                <span className="text-[10px] text-fg-tertiary ml-auto">{ep.desc}</span>
              </div>
            ))}
          </div>
        </Card>

        {recentTasks.length > 0 && (
          <Card title={t('agent:profilePage.overview.recentTasks')} action={<button onClick={() => navBus.navigate(PAGE.WORK)} className="text-xs text-fg-tertiary hover:text-fg-secondary">{t('common:viewAll')}</button>}>
            <div className="divide-y divide-gray-800/50 -mx-5">
              {recentTasks.map(task => (
                <div key={task.id} className="flex items-center gap-2.5 px-5 py-2.5">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${TASK_DOT[task.status] ?? 'bg-gray-500'}`} />
                  <span className="text-xs text-fg-secondary flex-1 truncate">{task.title}</span>
                  <span className="text-[10px] text-fg-tertiary capitalize shrink-0">{taskStatusLabel(task.status, t)}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    );
  }

  const hbCount = recentActivities.filter(a => a.type === 'heartbeat').length;
  const chatCount = recentActivities.filter(a => a.type === 'chat').length;
  const activeN = agent.state.activeTaskIds?.length ?? 0;

  return (
    <div className="space-y-4">
      <Card title={t('agent:profilePage.overview.identity')} action={
        editing
          ? <div className="flex gap-2">
              <button onClick={() => setEditing(false)} className="text-xs text-fg-tertiary hover:text-fg-secondary">{t('common:cancel')}</button>
              <button onClick={save} disabled={saving} className="text-xs text-brand-500 hover:text-brand-500">{saving ? t('common:saving') : t('common:save')}</button>
            </div>
          : <button onClick={() => { setEditing(true); setEditName(agent.name); setEditRole(agent.agentRole); setEditModelMode((agent.config?.llmConfig as Record<string, unknown>)?.modelMode as 'default' | 'custom' ?? 'default'); setEditModel(agent.config?.llmConfig.primary ?? ''); setEditFallback(agent.config?.llmConfig.fallback ?? ''); }} className="text-xs text-fg-tertiary hover:text-fg-secondary">{t('common:edit')}</button>
      }>
        <div className="flex items-start gap-4 mb-3">
          <AvatarUpload
            currentUrl={agent.avatarUrl}
            name={agent.name}
            size={48}
            targetType="agent"
            targetId={agent.id}
            onUploaded={() => onUpdate()}
          />
          <div className="flex-1 min-w-0 pt-1">
            <div className="text-sm font-medium text-fg-primary">{agent.name}</div>
            <div className="text-xs text-fg-tertiary mt-0.5">{agent.role} · {agent.agentRole ?? t('agent:profilePage.roles.worker')}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <KV label={t('agent:profilePage.overview.labels.name')}>{editing ? <input className="input-sm" value={editName} onChange={e => setEditName(e.target.value)} /> : agent.name}</KV>
          <KV label={t('agent:profilePage.overview.labels.agentRole')}>
            {editing
              ? <div className="flex gap-1.5">{(['worker', 'manager'] as const).map(r => (
                  <button key={r} onClick={() => setEditRole(r)} className={`px-2 py-1 text-[10px] rounded border transition-colors capitalize ${editRole === r ? (r === 'manager' ? 'bg-amber-500/15 text-amber-600 border-amber-500/30' : 'bg-blue-500/15 text-blue-600 border-blue-500/30') : 'bg-surface-elevated text-fg-tertiary border-border-default'}`}>{r}</button>
                ))}</div>
              : <span className={agent.agentRole === 'manager' ? 'text-amber-600' : 'text-blue-600'}>{agent.agentRole === 'manager' ? t('agent:profilePage.roles.managerDisplay') : t('agent:profilePage.roles.workerDisplay')}</span>}
          </KV>
          <KV label={t('agent:profilePage.overview.labels.roleTemplate')}>{agent.role}</KV>
          <KV label={t('agent:profilePage.overview.labels.agentId')} mono>{agent.id}</KV>
          <KV label={t('agent:profilePage.overview.labels.organization')}>{agent.config?.orgId ?? 'default'}</KV>
          <KV label={t('agent:profilePage.overview.labels.created')}>{agent.config?.createdAt ? new Date(agent.config.createdAt).toLocaleDateString() : t('agent:profilePage.emDash')}</KV>
        </div>
      </Card>

      <Card title={t('agent:profilePage.overview.runtimeStatus')}>
        <div className="grid grid-cols-4 gap-4">
          <StatBox label={t('agent:profilePage.overview.labels.status')} value={agentRuntimeStatusLabel(agent.state.status, t)} color={agent.state.status === 'idle' ? 'green' : agent.state.status === 'working' ? 'blue' : agent.state.status === 'error' ? 'red' : 'gray'} />
          <StatBox label={t('agent:profilePage.overview.labels.tokensToday')} value={String(agent.state.tokensUsedToday)} />
          <StatBox label={t('agent:profilePage.overview.labels.activeTasks')} value={String(agent.state.activeTaskIds?.length ?? 0)} />
          <StatBox label={t('agent:profilePage.overview.labels.lastHeartbeat')} value={agent.state.lastHeartbeat ? new Date(agent.state.lastHeartbeat).toLocaleTimeString() : t('agent:profilePage.never')} />
        </div>

        {agent.state.status === 'error' && (
          <div className="mt-3 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-medium text-red-500">{t('agent:profilePage.overview.errorDetails')}</span>
              {agent.state.lastErrorAt && <span className="text-[10px] text-red-500/50 ml-auto">{new Date(agent.state.lastErrorAt).toLocaleString()}</span>}
            </div>
            <pre className="text-[11px] text-red-500/80 leading-relaxed whitespace-pre-wrap break-all font-mono bg-red-500/5 rounded p-2">
              {agent.state.lastError || t('agent:profilePage.overview.errorFallback')}
            </pre>
          </div>
        )}

        {agent.state.status === 'working' && activeN > 0 && (
          <div className="mt-3 bg-brand-500/10 border border-brand-500/20 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" />
              <span className="text-xs font-medium text-brand-500">{t('agent:profilePage.overview.currentlyWorking')}</span>
              <span className="text-[10px] text-brand-500/50 ml-auto">{t('agent:profilePage.overview.activeTasksCount', { count: activeN })}</span>
            </div>
            <div className="space-y-1">
              {recentTasks.filter(task => agent.state.activeTaskIds?.includes(task.id)).map(task => (
                <div key={task.id} className="flex items-center gap-2 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse shrink-0" />
                  <span className="text-fg-secondary truncate flex-1">{task.title}</span>
                  <span className="text-fg-tertiary capitalize shrink-0">{taskStatusLabel(task.status, t)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-4 pt-3 border-t border-border-default/50">
          <button onClick={toggleAgent} className="px-3 py-1.5 text-xs border border-border-default rounded-lg hover:border-brand-500 transition-colors">
            {agent.state.status === 'offline' ? t('agent:profilePage.overview.startAgent') : t('agent:profilePage.overview.stopAgent')}
          </button>
        </div>
      </Card>

      {usageInfo && (
        <Card title={t('agent:profilePage.overview.usage')}>
          <div className="grid grid-cols-3 gap-4">
            <StatBox label={t('agent:profilePage.overview.labels.totalTokens')} value={fmtNum(usageInfo.totalTokens)} />
            <StatBox label={t('agent:profilePage.overview.labels.requests')} value={String(usageInfo.requestCount)} />
            <StatBox label={t('agent:profilePage.overview.labels.toolCalls')} value={String(usageInfo.toolCalls)} />
            <StatBox label={t('agent:profilePage.overview.labels.promptTokens')} value={fmtNum(usageInfo.promptTokens)} />
            <StatBox label={t('agent:profilePage.overview.labels.completionTokens')} value={fmtNum(usageInfo.completionTokens)} />
            <StatBox label={t('agent:profilePage.overview.labels.estCost')} value={`$${usageInfo.estimatedCost < 0.01 ? usageInfo.estimatedCost.toFixed(4) : usageInfo.estimatedCost.toFixed(2)}`} />
          </div>
        </Card>
      )}

      {agentStorage && (
        <Card title={t('agent:profilePage.overview.storage')} action={
          <button onClick={() => void api.system.openPath(agentDataDir)}
            className="text-xs text-fg-tertiary hover:text-fg-secondary">{t('agent:profilePage.overview.openFolder')}</button>
        }>
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-lg font-bold text-fg-primary">{fmtBytesLocal(agentStorage.size)}</span>
            <span className="text-xs text-fg-tertiary font-mono truncate">{agentDataDir}</span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {agentStorage.subItems.filter(s => s.size > 0).map(sub => (
              <StatBox key={sub.name} label={sub.name} value={fmtBytesLocal(sub.size)} />
            ))}
          </div>
        </Card>
      )}

      <Card title={t('agent:profilePage.overview.llmConfiguration')}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <KV label={t('agent:profilePage.overview.labels.modelMode')}>
              {editing
                ? <div className="flex gap-1.5">
                    {(['default', 'custom'] as const).map(m => (
                      <button key={m} onClick={() => setEditModelMode(m)}
                        className={`px-2.5 py-1 text-[10px] rounded border transition-colors capitalize ${
                          editModelMode === m
                            ? (m === 'default' ? 'bg-brand-500/15 text-brand-500 border-brand-500/30' : 'bg-amber-500/15 text-amber-600 border-amber-500/30')
                            : 'bg-surface-elevated text-fg-tertiary border-border-default'
                        }`}
                      >{m === 'default' ? t('agent:profilePage.overview.systemDefault') : t('agent:profilePage.overview.custom')}</button>
                    ))}
                  </div>
                : <span className={`text-xs ${currentModelMode === 'custom' ? 'text-amber-600' : 'text-brand-500'}`}>
                    {currentModelMode === 'custom' ? t('agent:profilePage.overview.customShort') : t('agent:profilePage.overview.systemDefaultShort')}
                  </span>}
            </KV>
            <KV label={t('agent:profilePage.overview.labels.primaryModel')}>
              {editing
                ? editModelMode === 'custom'
                  ? <select className="input-sm" value={editModel} onChange={e => setEditModel(e.target.value)}>
                      {configuredModels.map(m => <option key={m} value={m}>{m} ({providers[m]?.model})</option>)}
                      {!configuredModels.includes(editModel) && editModel && <option value={editModel}>{editModel}</option>}
                    </select>
                  : <span className="text-xs text-fg-secondary italic">{t('agent:profilePage.overview.followsSystemDefault', { provider: defaultProvider || '...' })}</span>
                : <span className="font-mono text-xs">
                    {currentModelMode === 'custom'
                      ? (agent.config?.llmConfig.primary ?? t('agent:profilePage.emDash'))
                      : <span className="text-fg-secondary">{defaultProvider || agent.config?.llmConfig.primary || t('agent:profilePage.emDash')} <span className="text-fg-tertiary">{t('agent:profilePage.overview.systemDefaultParen')}</span></span>}
                  </span>}
            </KV>
            <KV label={t('agent:profilePage.overview.labels.fallback')}>
              {editing
                ? <select className="input-sm" value={editFallback} onChange={e => setEditFallback(e.target.value)}>
                    <option value="">{t('agent:profilePage.overview.noneOption')}</option>
                    {configuredModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                : <span className="font-mono text-xs">{agent.config?.llmConfig.fallback ?? t('agent:profilePage.overview.noneOption')}</span>}
            </KV>
            <KV label={t('agent:profilePage.overview.labels.maxTokensRequest')}>{agent.config?.llmConfig.maxTokensPerRequest ?? t('agent:profilePage.overview.defaultValue')}</KV>
            <KV label={t('agent:profilePage.overview.labels.maxTokensDay')}>{agent.config?.llmConfig.maxTokensPerDay ?? t('agent:profilePage.overview.unlimited')}</KV>
          </div>
        </Card>

      {/* Recent Tasks */}
      {recentTasks.length > 0 && (
        <Card title={t('agent:profilePage.overview.recentTasks')} action={<button onClick={() => navBus.navigate(PAGE.WORK)} className="text-xs text-fg-tertiary hover:text-fg-secondary">{t('common:viewAll')}</button>}>
          <div className="divide-y divide-gray-800/50 -mx-5">
            {recentTasks.map(task => {
              const isExpanded = expandedTaskId === task.id;
              const hasLogs = ['in_progress', 'failed', 'completed', 'review'].includes(task.status);
              return (
                <div key={task.id}>
                  <button
                    onClick={() => hasLogs ? setExpandedTaskId(isExpanded ? null : task.id) : undefined}
                    className={`w-full flex items-center gap-2.5 px-5 py-2.5 text-left transition-colors ${hasLogs ? 'hover:bg-surface-elevated/40 cursor-pointer' : 'cursor-default'}`}
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${TASK_DOT[task.status] ?? 'bg-gray-500'}`} />
                    <span className="text-xs text-fg-secondary flex-1 truncate">{task.title}</span>
                    <span className="text-[10px] text-fg-tertiary capitalize shrink-0">{taskStatusLabel(task.status, t)}</span>
                    {hasLogs && <span className="text-fg-tertiary text-[10px]">{isExpanded ? '▲' : '▼'}</span>}
                  </button>
                  {isExpanded && (
                    <div className="border-t border-border-default/60 bg-surface-primary/40">
                      <TaskLog taskId={task.id} isLive={task.status === 'in_progress'} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Recent Heartbeats */}
      {hbCount > 0 && (
        <Card title={t('agent:profilePage.overview.recentHeartbeats')} action={<span className="text-[10px] text-fg-tertiary">{t('agent:profilePage.overview.heartbeatRuns', { count: hbCount })}</span>}>
          <div className="divide-y divide-gray-800/50 -mx-5">
            {recentActivities.filter(a => a.type === 'heartbeat').map(act => {
              const isExpanded = expandedActivityId === act.id;
              return (
                <div key={act.id}>
                  <button
                    onClick={() => setExpandedActivityId(isExpanded ? null : act.id)}
                    className="w-full flex items-center gap-2.5 px-5 py-2.5 text-left transition-colors hover:bg-surface-elevated/40 cursor-pointer"
                  >
                    <span className="w-2 h-2 rounded-full shrink-0 bg-green-400" />
                    <span className="text-xs text-fg-secondary flex-1 truncate">{act.label}</span>
                    <span className="text-[10px] text-fg-tertiary shrink-0">{new Date(act.startedAt).toLocaleString()}</span>
                    <span className="text-fg-tertiary text-[10px]">{isExpanded ? '▲' : '▼'}</span>
                  </button>
                  {isExpanded && (
                    <div className="border-t border-border-default/60 bg-surface-primary/40">
                      <ActivityLog agentId={agent.id} activityId={act.id} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Recent A2A Communications */}
      {chatCount > 0 && (
        <Card title={t('agent:profilePage.overview.recentA2A')} action={<span className="text-[10px] text-fg-tertiary">{t('agent:profilePage.overview.conversations', { count: chatCount })}</span>}>
          <div className="divide-y divide-gray-800/50 -mx-5">
            {recentActivities.filter(a => a.type === 'chat').map(act => {
              const isExpanded = expandedActivityId === act.id;
              return (
                <div key={act.id}>
                  <button
                    onClick={() => setExpandedActivityId(isExpanded ? null : act.id)}
                    className="w-full flex items-center gap-2.5 px-5 py-2.5 text-left transition-colors hover:bg-surface-elevated/40 cursor-pointer"
                  >
                    <span className="w-2 h-2 rounded-full shrink-0 bg-blue-400" />
                    <span className="text-xs text-fg-secondary flex-1 truncate">{act.label}</span>
                    <span className="text-[10px] text-fg-tertiary shrink-0">{new Date(act.startedAt).toLocaleString()}</span>
                    <span className="text-fg-tertiary text-[10px]">{isExpanded ? '▲' : '▼'}</span>
                  </button>
                  {isExpanded && (
                    <div className="border-t border-border-default/60 bg-surface-primary/40">
                      <ActivityLog agentId={agent.id} activityId={act.id} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
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
    <div className="mb-3 border border-border-default rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-elevated/80 border-b border-border-default">
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

function FilesTab({ agentId }: { agentId: string }) {
  const { t } = useTranslation(['agent', 'common']);
  const [files, setFiles] = useState<Array<{ name: string; content: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [roleStatus, setRoleStatus] = useState<RoleUpdateStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [diffView, setDiffView] = useState<{ file: string; agent: string; template: string } | null>(null);
  const [smartSyncing, setSmartSyncing] = useState(false);
  const [smartSyncResult, setSmartSyncResult] = useState<{ file: string; mergedContent: string; explanation: string; previousContent: string } | null>(null);

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

  const syncFromTemplate = async (fileName?: string) => {
    setSyncing(true);
    try {
      await api.agents.roleSync(agentId, fileName ? [fileName] : undefined);
      setDiffView(null);
      setDirty(false);
      setSmartSyncResult(null);
      loadFiles();
    } catch { /* */ }
    setSyncing(false);
  };

  const smartSync = async (fileName: string) => {
    setSmartSyncing(true);
    try {
      const result = await api.agents.roleSmartSync(agentId, fileName);
      if (result.success && result.mergedContent) {
        const currentFile = files.find(f => f.name === fileName);
        setSmartSyncResult({
          file: fileName,
          mergedContent: result.mergedContent,
          explanation: result.explanation,
          previousContent: currentFile?.content ?? editContent,
        });
        setEditContent(result.mergedContent);
        setDirty(true);
        setDiffView(null);
      }
    } catch { /* */ }
    setSmartSyncing(false);
  };

  const undoSmartSync = () => {
    if (!smartSyncResult) return;
    setEditContent(smartSyncResult.previousContent);
    setFiles(prev => prev.map(f => f.name === smartSyncResult.file ? { ...f, content: smartSyncResult.previousContent } : f));
    setDirty(false);
    setSmartSyncResult(null);
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

  const staleFiles = roleStatus?.files.filter(f => f.status === 'modified' || f.status === 'added_in_template') ?? [];
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
          <button onClick={() => syncFromTemplate()} disabled={syncing}
            className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors shrink-0 disabled:opacity-50"
          >{syncing ? t('agent:profilePage.filesTab.syncing') : t('agent:profilePage.filesTab.syncAll')}</button>
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
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-fg-secondary">{fileLabel(selected)}</div>
              <div className="flex gap-2 items-center">
                {selectedFileStale && (
                  <>
                    <button onClick={() => showDiff(selected)} className="px-2.5 py-1 text-[11px] text-amber-600 hover:text-amber-600 border border-amber-500/30 hover:border-amber-500/50 rounded-lg transition-colors">
                      {diffView?.file === selected ? t('agent:profilePage.filesTab.hideDiff') : t('agent:profilePage.filesTab.viewDiff')}
                    </button>
                    <button onClick={() => smartSync(selected)} disabled={smartSyncing || syncing}
                      className="px-2.5 py-1 text-[11px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-50"
                      title={t('agent:profilePage.filesTab.smartSyncTitle')}
                    >{smartSyncing ? t('agent:profilePage.filesTab.merging') : t('agent:profilePage.filesTab.smartSync')}</button>
                    <button onClick={() => syncFromTemplate(selected)} disabled={syncing}
                      className="px-2.5 py-1 text-[11px] bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors disabled:opacity-50"
                      title={t('agent:profilePage.filesTab.overwriteTemplateTitle')}
                    >{syncing ? t('agent:profilePage.filesTab.syncing') : t('agent:profilePage.filesTab.syncThisFile')}</button>
                  </>
                )}
                {smartSyncResult?.file === selected && (
                  <button onClick={undoSmartSync} className="px-2.5 py-1 text-[11px] text-red-500 hover:text-red-400 border border-red-500/30 hover:border-red-500/50 rounded-lg transition-colors"
                    title={t('agent:profilePage.filesTab.undoMergeTitle')}
                  >{t('agent:profilePage.filesTab.undoMerge')}</button>
                )}
                {dirty && <span className="text-[10px] text-amber-600">{t('agent:profilePage.filesTab.unsaved')}</span>}
                <button onClick={saveFile} disabled={saving || !dirty}
                  className={`px-3 py-1 text-xs rounded-lg transition-colors ${dirty ? 'bg-brand-600 hover:bg-brand-500 text-white' : 'bg-surface-elevated text-fg-tertiary cursor-default'}`}
                >{saving ? t('common:saving') : t('common:save')}</button>
              </div>
            </div>

            {diffView?.file === selected && (
              <InlineDiff agent={diffView.agent} template={diffView.template} templateId={roleStatus?.templateId ?? ''} />
            )}

            {smartSyncResult?.file === selected && (
              <div className="mb-3 bg-brand-600/8 border border-brand-500/25 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[10px] font-semibold text-brand-500 uppercase tracking-wider">{t('agent:profilePage.filesTab.smartSyncResult')}</span>
                  <span className="text-[10px] text-fg-tertiary">{t('agent:profilePage.filesTab.reviewAndSave')}</span>
                </div>
                <p className="text-[11px] text-fg-secondary whitespace-pre-wrap leading-relaxed">{smartSyncResult.explanation}</p>
              </div>
            )}

            <textarea
              value={editContent}
              onChange={e => { setEditContent(e.target.value); setDirty(true); }}
              className="w-full h-80 bg-surface-elevated/60 border border-border-default rounded-lg p-4 text-xs font-mono text-fg-secondary leading-relaxed resize-y focus:border-brand-500 outline-none"
              spellCheck={false}
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

// ─── Tools Tab ───────────────────────────────────────────────────────────────

const TOOL_CATEGORY_DEF: Array<{ id: string; prefixes: string[] }> = [
  { id: 'files', prefixes: ['file_read', 'file_write', 'file_edit', 'apply_patch'] },
  { id: 'search', prefixes: ['grep_search', 'glob_find', 'list_directory'] },
  { id: 'runtime', prefixes: ['shell_execute', 'background_exec', 'process'] },
  { id: 'web', prefixes: ['web_search', 'web_fetch', 'web_extract'] },
  { id: 'tasks', prefixes: ['task_create', 'task_list', 'task_update', 'task_get', 'task_assign', 'task_note', 'task_comment', 'task_submit_review', 'subtask_create', 'subtask_complete', 'subtask_list', 'task_check_duplicates', 'task_cleanup_duplicates', 'task_board_health'] },
  { id: 'requirements', prefixes: ['requirement_propose', 'requirement_list', 'requirement_update_status', 'requirement_comment'] },
  { id: 'projects', prefixes: ['list_projects', 'get_project', 'project_info'] },
  { id: 'deliverables', prefixes: ['deliverable_create', 'deliverable_search', 'deliverable_list', 'deliverable_update'] },
  { id: 'communication', prefixes: ['agent_send_message', 'agent_list_colleagues', 'agent_send_group_message', 'agent_create_group_chat', 'agent_list_group_chats', 'agent_broadcast_status', 'agent_delegate_task'] },
  { id: 'memory', prefixes: ['memory_save', 'memory_search', 'memory_list', 'memory_update_longterm'] },
  { id: 'planning', prefixes: ['todo_write', 'todo_read'] },
  { id: 'teamManager', prefixes: ['team_list', 'team_status', 'delegate_message', 'create_task'] },
  { id: 'subagents', prefixes: ['spawn_subagent', 'spawn_subagents'] },
  { id: 'llm', prefixes: ['llm_list_providers', 'llm_switch_model', 'llm_switch_default_provider', 'llm_add_provider', 'llm_edit_provider', 'llm_add_model'] },
];

function categorizeTools(tools: AgentToolInfo[], t: TFunction): Array<{ category: string; tools: AgentToolInfo[] }> {
  const categorized = new Map<string, AgentToolInfo[]>();
  const used = new Set<string>();
  for (const { id, prefixes } of TOOL_CATEGORY_DEF) {
    const catLabel = t(`agent:toolCategories.${id}`);
    const matched = tools.filter(tool => prefixes.some(n => tool.name.startsWith(n)));
    if (matched.length > 0) { categorized.set(catLabel, matched); matched.forEach(m => used.add(m.name)); }
  }
  const remaining = tools.filter(tool => !used.has(tool.name));
  for (const tool of remaining) {
    const sep = tool.name.indexOf('__');
    if (sep > 0) {
      const server = tool.name.slice(0, sep);
      const label = t('agent:toolCategories.mcp', { server });
      if (!categorized.has(label)) categorized.set(label, []);
      categorized.get(label)!.push(tool);
      used.add(tool.name);
    }
  }
  const other = tools.filter(tool => !used.has(tool.name));
  if (other.length > 0) categorized.set(t('agent:toolCategories.other'), other);
  return [...categorized.entries()].map(([category, catTools]) => ({ category, tools: catTools }));
}

function ToolsTab({ tools }: { tools: AgentToolInfo[] }) {
  const { t } = useTranslation(['agent', 'common']);
  const groups = categorizeTools(tools, t);
  return (
    <div className="space-y-4">
      <div className="text-xs text-fg-tertiary">{t('agent:profilePage.toolsTab.registeredCount', { count: tools.length })}</div>
      {groups.map(g => (
        <Card key={g.category} title={g.category}>
          <div className="grid grid-cols-2 gap-2">
            {g.tools.map(tool => (
              <div key={tool.name} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-elevated/30 border border-border-default/30">
                <div className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium font-mono">{tool.name}</div>
                  <div className="text-[10px] text-fg-tertiary truncate">{tool.description}</div>
                </div>
              </div>
            ))}
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

// ─── Memory Tab ──────────────────────────────────────────────────────────────

function MemoryTab({ agentId }: { agentId: string }) {
  const { t } = useTranslation(['agent', 'common']);
  const [data, setData] = useState<AgentMemorySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<'entries' | 'sessions' | 'daily' | 'longterm'>('entries');
  const [editingDaily, setEditingDaily] = useState(false);
  const [dailyContent, setDailyContent] = useState('');
  const [editingLong, setEditingLong] = useState(false);
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
    setEditingDaily(false);
    loadData();
  };

  const saveLong = async () => {
    setSaving(true);
    await api.agents.updateLongTermMemory(agentId, t('agent:profilePage.memoryTab.userEditedSource'), longContent).catch(() => {});
    setSaving(false);
    setEditingLong(false);
    loadData();
  };

  if (loading) return <div className="text-xs text-fg-tertiary py-8 text-center">{t('agent:profilePage.memoryTab.loading')}</div>;
  if (!data) return <div className="text-xs text-fg-tertiary py-8 text-center">{t('agent:profilePage.memoryTab.loadFailed')}</div>;

  const sectionTabs = [
    { key: 'entries' as const, label: t('agent:profilePage.memoryTab.recent', { count: data.entries.length }) },
    { key: 'sessions' as const, label: t('agent:profilePage.memoryTab.sessions', { count: data.sessions.length }) },
    { key: 'daily' as const, label: t('agent:profilePage.memoryTab.dailyLogs') },
    { key: 'longterm' as const, label: t('agent:profilePage.memoryTab.longTerm') },
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
          editingDaily
            ? <div className="flex gap-2">
                <button onClick={() => setEditingDaily(false)} className="text-xs text-fg-tertiary">{t('common:cancel')}</button>
                <button onClick={saveDaily} disabled={saving} className="text-xs text-brand-500">{saving ? t('common:saving') : t('common:save')}</button>
              </div>
            : <button onClick={() => setEditingDaily(true)} className="text-xs text-fg-tertiary hover:text-fg-secondary">{t('common:edit')}</button>
        }>
          {editingDaily ? (
            <textarea value={dailyContent} onChange={e => setDailyContent(e.target.value)}
              className="w-full h-64 bg-surface-elevated/60 border border-border-default rounded-lg p-4 text-xs font-mono text-fg-secondary leading-relaxed resize-y focus:border-brand-500 outline-none" />
          ) : data.recentDailyLogs ? (
            <pre className="text-xs text-fg-secondary whitespace-pre-wrap font-mono leading-relaxed bg-surface-elevated/30 rounded-lg p-4 max-h-96 overflow-y-auto">{data.recentDailyLogs}</pre>
          ) : <Empty text={t('agent:profilePage.memoryTab.noDailyLogs')} />}
        </Card>
      )}

      {section === 'longterm' && (
        <Card title={t('agent:profilePage.memoryTab.longTermTitle')} action={
          editingLong
            ? <div className="flex gap-2">
                <button onClick={() => setEditingLong(false)} className="text-xs text-fg-tertiary">{t('common:cancel')}</button>
                <button onClick={saveLong} disabled={saving} className="text-xs text-brand-500">{saving ? t('common:saving') : t('common:save')}</button>
              </div>
            : <button onClick={() => setEditingLong(true)} className="text-xs text-fg-tertiary hover:text-fg-secondary">{t('common:edit')}</button>
        }>
          {editingLong ? (
            <textarea value={longContent} onChange={e => setLongContent(e.target.value)}
              className="w-full h-64 bg-surface-elevated/60 border border-border-default rounded-lg p-4 text-xs font-mono text-fg-secondary leading-relaxed resize-y focus:border-brand-500 outline-none" />
          ) : data.longTermMemory ? (
            <pre className="text-xs text-fg-secondary whitespace-pre-wrap font-mono leading-relaxed bg-surface-elevated/30 rounded-lg p-4 max-h-96 overflow-y-auto">{data.longTermMemory}</pre>
          ) : <Empty text={t('agent:profilePage.memoryTab.noLongTerm')} />}
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

  const refresh = useCallback(() => {
    api.agents.getHeartbeat(agentId).then(setData).catch(() => {});
    api.agents.getRecentActivities(agentId).then(d => {
      setRecentRuns(d.activities.filter(a => a.type === 'heartbeat'));
    }).catch(() => {});
  }, [agentId]);

  useEffect(() => {
    setLoading(true);
    refresh();
    setLoading(false);
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
          <StatBox label={t('agent:profilePage.heartbeatTab.interval')} value={formatDuration(data.intervalMs) ?? t('agent:profilePage.emDash')} />
          <StatBox label={t('agent:profilePage.heartbeatTab.lastRun')} value={data.lastHeartbeat ? formatRelativeTime(data.lastHeartbeat) ?? t('agent:profilePage.emDash') : t('agent:profilePage.never')} />
          <StatBox label={t('agent:profilePage.heartbeatTab.nextRun')} value={data.nextRunAt ? formatRelativeTime(data.nextRunAt) ?? t('agent:profilePage.emDash') : data.running ? t('agent:profilePage.heartbeatTab.pending') : t('agent:profilePage.emDash')} />
        </div>
        {triggerMsg && (
          <div className="mt-3 text-[11px] text-blue-600 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
            {triggerMsg}
          </div>
        )}
      </Card>

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

  if (loading) return <div className="px-4 py-3 text-xs text-fg-tertiary">Loading...</div>;
  if (logs.length === 0 && !streamingText) return <div className="px-4 py-3 text-xs text-fg-tertiary">No execution logs yet.</div>;

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

  if (loading) return <div className="px-4 py-3 text-xs text-fg-tertiary">Loading...</div>;
  if (logs.length === 0) return <div className="px-4 py-3 text-xs text-fg-tertiary">No activity logs available.</div>;

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
    <div className="bg-surface-secondary/60 border border-border-default rounded-xl p-5">
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
  const c = color === 'green' ? 'text-green-600' : color === 'blue' ? 'text-blue-500' : color === 'indigo' ? 'text-brand-500' : color === 'red' ? 'text-red-500' : 'text-fg-secondary';
  return (<div className="text-center"><div className={`text-lg font-semibold ${c}`}>{value}</div><div className="text-[10px] text-fg-tertiary mt-0.5">{label}</div></div>);
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

const PRIORITY_LABELS: Record<number, string> = { 0: 'Critical', 1: 'High', 2: 'Normal', 3: 'Low', 4: 'Background' };
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

const CATEGORY_FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'interaction', label: 'Interaction' },
  { key: 'task', label: 'Task' },
  { key: 'notification', label: 'Notification' },
  { key: 'system', label: 'System' },
];

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-500', processing: 'bg-blue-400 animate-pulse',
  deferred: 'bg-purple-400', merged: 'bg-cyan-400', queued: 'bg-amber-400', dropped: 'bg-red-500',
};

const ACTIVITY_FILTERS: Array<{ key: AgentActivityType | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'task', label: 'Task' },
  { key: 'chat', label: 'Chat' },
  { key: 'heartbeat', label: 'Heartbeat' },
  { key: 'a2a', label: 'A2A' },
  { key: 'internal', label: 'Internal' },
  { key: 'respond_in_session', label: 'Session' },
];

const ACTIVITY_ICONS: Record<string, string> = {
  task: '☑', chat: '💬', heartbeat: '♡', a2a: '🔗', internal: '⚙', respond_in_session: '↩',
};

const STATUS_DISPLAY: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'text-gray-400' },
  assigned: { label: 'Assigned', color: 'text-blue-400' },
  in_progress: { label: 'In Progress', color: 'text-brand-400' },
  completed: { label: 'Completed', color: 'text-green-400' },
  failed: { label: 'Failed', color: 'text-red-400' },
  cancelled: { label: 'Cancelled', color: 'text-gray-500' },
  review: { label: 'Review', color: 'text-amber-400' },
  approved: { label: 'Approved', color: 'text-green-500' },
  rejected: { label: 'Rejected', color: 'text-red-500' },
  draft: { label: 'Draft', color: 'text-gray-400' },
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
function getMailboxItemDisplay(item: import('../api.ts').EnrichedMailboxItem): { title: string; subtitle?: string; badge?: { label: string; color: string } } {
  const payload = item.payload;
  const summary = payload?.summary ?? '';
  const content = payload?.content ?? '';
  const sender = item.metadata?.senderName as string | undefined;

  switch (item.sourceType) {
    case 'task_status_update': {
      // Extract task title and status transition from summary: `Task "title" status: from → to`
      const titleMatch = summary.match(/^Task "(.+?)" status:/);
      const statusMatch = summary.match(/status:\s*(\S+)\s*→\s*(\S+)/);
      const taskTitle = titleMatch?.[1] ?? summary;
      if (statusMatch) {
        const from = statusMatch[1];
        const to = statusMatch[2];
        const fromDisplay = STATUS_DISPLAY[from] ?? { label: from, color: 'text-fg-tertiary' };
        const toDisplay = STATUS_DISPLAY[to] ?? { label: to, color: 'text-fg-secondary' };
        return {
          title: taskTitle,
          subtitle: `${fromDisplay.label} → ${toDisplay.label}`,
          badge: toDisplay,
        };
      }
      // Fallback for task execution triggers
      const execMatch = summary.match(/^Task:\s*(.+)/);
      if (execMatch) return { title: execMatch[1] };
      return { title: taskTitle };
    }

    case 'task_comment': {
      const m = summary.match(/^Comment on task "(.+?)" from (.+?)(\s*\(\+\d+\))?$/);
      const commentText = extractCommentText(content);
      if (m) {
        const sub = commentText
          ? `${m[2]}: ${commentText}`
          : `Comment from ${m[2]}`;
        return { title: m[1], subtitle: sub };
      }
      return { title: summary };
    }

    case 'requirement_update': {
      // Summary: `Requirement "title" status: from → to` or `Requirement "title" rejected/approved`
      const titleMatch = summary.match(/^Requirement "(.+?)"\s+(.*)/);
      if (titleMatch) return { title: titleMatch[1], subtitle: titleMatch[2] };
      return { title: summary };
    }

    case 'requirement_comment': {
      const m = summary.match(/^Comment on requirement "(.+?)" from (.+?)(\s*\(\+\d+\))?$/);
      const commentText = extractCommentText(content);
      if (m) {
        const sub = commentText
          ? `${m[2]}: ${commentText}`
          : `Comment from ${m[2]}`;
        return { title: m[1], subtitle: sub };
      }
      return { title: summary };
    }

    case 'human_chat': {
      const preview = content.slice(0, 120).replace(/\n/g, ' ');
      return {
        title: sender ? `Chat from ${sender}` : 'Human Chat',
        subtitle: preview + (content.length > 120 ? '…' : ''),
      };
    }

    case 'a2a_message': {
      const preview = content.slice(0, 120).replace(/\n/g, ' ');
      return {
        title: sender ? `Message from ${sender}` : 'Agent Message',
        subtitle: preview + (content.length > 120 ? '…' : ''),
      };
    }

    case 'mention': {
      const m = summary.match(/from (.+)$/);
      const commentText = extractCommentText(content);
      return {
        title: m ? `Mentioned by ${m[1]}` : 'Mention',
        subtitle: commentText || undefined,
      };
    }

    case 'review_request': {
      const preview = content.slice(0, 120).replace(/\n/g, ' ');
      return {
        title: sender ? `Review request from ${sender}` : 'Review Request',
        subtitle: preview + (content.length > 120 ? '…' : ''),
      };
    }

    case 'session_reply': {
      const preview = content.slice(0, 120).replace(/\n/g, ' ');
      return {
        title: sender ? `Reply in session (${sender})` : 'Session Reply',
        subtitle: preview + (content.length > 120 ? '…' : ''),
      };
    }

    case 'heartbeat':
      return { title: 'Scheduled heartbeat check-in' };

    case 'daily_report':
      return { title: 'Daily Report' };

    case 'memory_consolidation':
      return { title: 'Memory Consolidation' };

    case 'system_event': {
      // Summary: `[Announcement] title`
      const annoMatch = summary.match(/^\[Announcement]\s*(.+)/);
      if (annoMatch) return { title: annoMatch[1], subtitle: 'System Announcement' };
      return { title: summary || 'System Event' };
    }

    default:
      return { title: summary || item.sourceType };
  }
}

function MindTab({ agentId, highlightId }: { agentId: string; highlightId?: string }) {
  const [mind, setMind] = useState<import('../api.ts').AgentMindState | null>(null);
  const [mailbox, setMailbox] = useState<import('../api.ts').AgentMailboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [catFilter, setCatFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(highlightId ?? null);
  const [highlightedId, setHighlightedId] = useState<string | null>(highlightId ?? null);
  const [hasMore, setHasMore] = useState(true);
  const PAGE = 50;

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
    const refresh = (evt: { payload?: unknown }) => {
      if ((evt.payload as { agentId?: string })?.agentId === agentId) load(false);
    };
    const unsubs = [
      wsClient.on('agent:mailbox', refresh),
      wsClient.on('agent:decision', refresh),
      wsClient.on('agent:attention', refresh),
      wsClient.on('agent:focus', refresh),
      wsClient.on('agent:update', refresh),
      wsClient.on('agent:triage', refresh),
    ];
    return () => unsubs.forEach(u => u());
  }, [agentId, load]);

  if (loading && !mind) return <div className="text-fg-tertiary text-sm animate-pulse">Loading agent mind state...</div>;

  return (
    <div className="space-y-4">
      {/* ── Current State ── */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${ATTENTION_COLORS[mind?.attentionState ?? 'idle'] ?? 'bg-gray-500/20 text-gray-500'}`}>
            {(mind?.attentionState ?? 'idle').toUpperCase()}
          </span>
          {mind?.currentFocus ? (() => {
            const focusDisplay = getMailboxItemDisplay({
              id: mind.currentFocus.mailboxItemId,
              agentId,
              sourceType: mind.currentFocus.type,
              priority: 0,
              status: 'processing',
              payload: { summary: mind.currentFocus.label, taskId: mind.currentFocus.taskId },
              metadata: {},
              queuedAt: mind.currentFocus.startedAt,
            } as import('../api.ts').EnrichedMailboxItem);
            return (
              <span className="text-sm text-fg-secondary">
                {MAILBOX_TYPE_ICONS[mind.currentFocus.type] ?? '●'}{' '}
                <span className="text-fg-primary font-medium">{focusDisplay.title}</span>
                {focusDisplay.subtitle && <span className="text-fg-tertiary ml-1.5 text-xs">{focusDisplay.subtitle}</span>}
                <span className="text-fg-tertiary ml-2 text-xs">since {new Date(mind.currentFocus.startedAt).toLocaleTimeString()}</span>
              </span>
            );
          })() : (
            <span className="text-sm text-fg-tertiary">Idle — waiting for new mail</span>
          )}
          <button onClick={() => { load(); }} className="ml-auto text-xs text-fg-tertiary hover:text-fg-secondary active:text-fg-primary transition-colors">↻ Refresh</button>
        </div>

        {(mind?.queuedItems?.length ?? 0) > 0 && (
          <div className="mb-3">
            <h4 className="text-xs font-medium text-amber-500 uppercase tracking-wider mb-1.5">Queue ({mind!.queuedItems.length})</h4>
            <div className="space-y-1">
              {mind!.queuedItems.map((item, i) => (
                <div key={item.id} className="flex items-center gap-2 px-3 py-1.5 rounded bg-amber-500/5 border border-amber-500/20 text-sm">
                  <span className="text-fg-tertiary w-4 text-right text-xs">{i + 1}</span>
                  <span className="text-sm">{MAILBOX_TYPE_ICONS[item.sourceType] ?? '●'}</span>
                  <span className={`text-[10px] ${PRIORITY_COLORS[item.priority] ?? 'text-fg-tertiary'}`}>{PRIORITY_LABELS[item.priority] ?? `P${item.priority}`}</span>
                  <span className="text-fg-secondary truncate flex-1 text-xs">{item.summary}</span>
                  <span className="text-[10px] text-fg-tertiary">{new Date(item.queuedAt).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Last Triage Decision ── */}
      {mind?.lastTriage && (
        <section className="bg-surface-2 rounded-lg border border-indigo-500/20 p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm">🧠</span>
            <h4 className="text-xs font-medium text-indigo-400 uppercase tracking-wider">Triage Decision</h4>
            <span className="text-[10px] text-fg-quaternary ml-auto">{new Date(mind.lastTriage.timestamp).toLocaleTimeString()}</span>
          </div>
          <p className="text-xs text-fg-secondary leading-relaxed">{mind.lastTriage.reasoning}</p>
          <div className="flex flex-wrap gap-2 mt-2 text-[10px]">
            <span className="px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">Processing: {mind.lastTriage.processedItemId.slice(0, 12)}…</span>
            {mind.lastTriage.deferredItemIds.length > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">Deferred: {mind.lastTriage.deferredItemIds.length}</span>
            )}
            {mind.lastTriage.droppedItemIds.length > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">Dropped: {mind.lastTriage.droppedItemIds.length}</span>
            )}
          </div>
        </section>
      )}

      {/* ── Mailbox History ── */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-xs font-medium text-fg-tertiary uppercase tracking-wider">Mailbox History</h3>
          <div className="flex gap-1 ml-auto flex-wrap">
            {CATEGORY_FILTERS.map(f => (
              <button key={f.key} onClick={() => setCatFilter(f.key)}
                className={`px-2 py-0.5 text-[10px] rounded-md border transition-colors ${
                  catFilter === f.key
                    ? 'bg-brand-500/20 border-brand-500/40 text-brand-300'
                    : 'bg-surface-2 border-border-subtle text-fg-secondary hover:bg-surface-3'
                }`}
              >{f.label}</button>
            ))}
          </div>
        </div>
        <div className="flex gap-1 mb-2 flex-wrap">
          {[
            { key: 'all', label: 'All', dot: '' },
            { key: 'queued', label: 'Queued', dot: 'bg-amber-400' },
            { key: 'processing', label: 'Processing', dot: 'bg-blue-400' },
            { key: 'completed', label: 'Completed', dot: 'bg-green-500' },
            { key: 'merged', label: 'Merged', dot: 'bg-cyan-400' },
            { key: 'deferred', label: 'Deferred', dot: 'bg-purple-400' },
            { key: 'dropped', label: 'Dropped', dot: 'bg-red-500' },
          ].map(f => (
            <button key={f.key} onClick={() => setStatusFilter(f.key)}
              className={`px-2 py-0.5 text-[10px] rounded-md border transition-colors flex items-center gap-1 ${
                statusFilter === f.key
                  ? 'bg-brand-500/20 border-brand-500/40 text-brand-300'
                  : 'bg-surface-2 border-border-subtle text-fg-secondary hover:bg-surface-3'
              }`}
            >{f.dot && <span className={`w-1.5 h-1.5 rounded-full ${f.dot}`} />}{f.label}</button>
          ))}
        </div>

        {(!mailbox?.history || mailbox.history.length === 0) && !loading && (
          <div className="text-center text-fg-tertiary text-sm py-8">No mailbox history yet</div>
        )}

        <div className="space-y-1">
          {mailbox?.history?.map(item => {
            const isExpanded = expandedId === item.id;
            const icon = MAILBOX_TYPE_ICONS[item.sourceType] ?? '●';
            const display = getMailboxItemDisplay(item);
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
                      <span className={`text-[10px] shrink-0 ${PRIORITY_COLORS[item.priority] ?? 'text-fg-tertiary'}`}>{PRIORITY_LABELS[item.priority] ?? ''}</span>
                    </div>
                    {display.subtitle && (
                      <div className={`text-[11px] text-fg-secondary mt-0.5 ${isExpanded ? '' : 'truncate'}`}>{display.subtitle}</div>
                    )}
                    <div className="text-[10px] text-fg-tertiary mt-0.5 flex gap-2 flex-wrap">
                      <span>{new Date(item.queuedAt).toLocaleString()}</span>
                      {item.completedAt && <span>→ {new Date(item.completedAt).toLocaleTimeString()}</span>}
                      {item.activity && (
                        <>
                          {item.activity.totalTokens > 0 && <span>{fmtNum(item.activity.totalTokens)} tokens</span>}
                          {item.activity.totalTools > 0 && <span>{item.activity.totalTools} tools</span>}
                        </>
                      )}
                    </div>
                  </div>
                  <span className="text-[10px] text-fg-tertiary bg-surface-3 px-1.5 py-0.5 rounded shrink-0">{item.sourceType}</span>
                </button>

                {isExpanded && (
                  <div className="border-t border-border-subtle px-3 py-3 space-y-3">
                    {/* Sender & contextual metadata */}
                    {senderName && (
                      <div className="text-[10px] text-fg-tertiary">
                        From: <span className="text-fg-secondary">{senderName}</span>
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
                        <h5 className="text-[10px] font-medium text-fg-tertiary uppercase tracking-wider mb-1">Decisions</h5>
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
                          Activity — {item.activity.label}
                          <span className={`ml-2 inline-block px-1 py-0 rounded text-[9px] ${item.activity.success ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-500'}`}>
                            {item.activity.success ? '✓ Success' : '✗ Failed'}
                          </span>
                        </h5>
                        {item.activity.type === 'task' && item.payload?.taskId ? (
                          <TaskLog taskId={item.payload.taskId as string} isLive={!item.activity.endedAt} />
                        ) : (
                          <ActivityLog agentId={agentId} activityId={item.activity.id} isLive={!item.activity.endedAt} />
                        )}
                      </div>
                    ) : item.status === 'processing' ? (
                      <div className="text-xs text-fg-tertiary text-center py-2 animate-pulse">Processing...</div>
                    ) : item.status === 'completed' ? (
                      <div className="text-xs text-fg-tertiary text-center py-2">No activity log recorded</div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {hasMore && (mailbox?.history?.length ?? 0) > 0 && (
          <div className="text-center mt-3">
            <button onClick={loadMore} className="text-xs text-brand-400 hover:text-brand-300 transition-colors">Load Earlier...</button>
          </div>
        )}
      </section>
    </div>
  );
}

