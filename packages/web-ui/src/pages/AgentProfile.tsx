import { useEffect, useState, useRef, useCallback } from 'react';
import { api, wsClient, hubApi } from '../api.ts';
import type { AgentDetail, AgentToolInfo, AgentMemorySummary, AgentHeartbeatInfo, TaskInfo, TaskLogEntry, AgentUsageInfo, ExternalAgentInfo, ActivitySummary, AgentActivityLogEntry, RoleUpdateStatus } from '../api.ts';
import { navBus } from '../navBus.ts';
import { ExecEntryRow, StreamingText, taskLogToEntry, activityLogToEntry, filterCompletedStarts, type ExecEntry, type ToolCallInfo } from '../components/ExecutionTimeline.tsx';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';

interface Props { agentId: string; onBack: () => void; inline?: boolean }

type ProfileTab = 'overview' | 'tools' | 'skills' | 'memory' | 'heartbeat' | 'files' | 'tasks';

const TABS: Array<{ key: ProfileTab; label: string; icon: string }> = [
  { key: 'overview', label: 'Overview', icon: '▦' },
  { key: 'files', label: 'Files', icon: '📄' },
  { key: 'tools', label: 'Tools', icon: '⚒' },
  { key: 'skills', label: 'Skills', icon: '◆' },
  { key: 'memory', label: 'Memory', icon: '🧠' },
  { key: 'heartbeat', label: 'Heartbeat', icon: '♡' },
  { key: 'tasks', label: 'Tasks', icon: '☑' },
];

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-green-400', working: 'bg-brand-400 animate-pulse',
  paused: 'bg-amber-400', offline: 'bg-gray-500', error: 'bg-red-400',
};

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function AgentProfile({ agentId, onBack, inline }: Props) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [tab, setTab] = useState<ProfileTab>('overview');
  const [externalInfo, setExternalInfo] = useState<ExternalAgentInfo | null>(null);

  const reload = useCallback(() => { api.agents.get(agentId).then(setAgent).catch(() => {}); }, [agentId]);

  useEffect(() => {
    setTab('overview');
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

  if (!agent) return <div className="flex-1 flex items-center justify-center text-fg-tertiary text-sm">Loading agent...</div>;

  const statusDot = STATUS_DOT[agent.state.status] ?? 'bg-gray-500';

  return (
    <div className="flex-1 overflow-y-auto bg-surface-primary">
      <div className="px-5 py-3.5 border-b border-border-default bg-surface-secondary sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-600 text-white flex items-center justify-center text-lg font-bold shrink-0">{agent.name.charAt(0)}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold">{agent.name}</h2>
              <span className={`w-2 h-2 rounded-full ${statusDot}`} />
              <span className="text-xs text-fg-tertiary">{agent.state.status}</span>
              {externalInfo && <span className="px-1.5 py-0.5 text-[10px] bg-brand-500/15 text-brand-500 rounded font-medium">External</span>}
              {agent.agentRole === 'manager' && <span className="px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-600 rounded font-medium">Manager</span>}
            </div>
            <div className="text-xs text-fg-tertiary truncate">{agent.role}{agent.roleDescription ? ` — ${agent.roleDescription}` : ''}</div>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <button onClick={() => navBus.navigate('chat', { agentId })} className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors flex items-center gap-1"><span>◈</span> Chat</button>
            <button onClick={async () => {
              if (!agent) return;
              try {
                const { filesMap } = await api.agents.getFilesMap(agentId);
                const config = {
                  type: 'agent' as const,
                  name: agent.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || agent.name,
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
                alert(`Published "${agent.name}" to Markus Hub`);
              } catch (e) { alert(`Failed to publish: ${e}`); }
            }} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors flex items-center gap-1" title="Publish to Markus Hub"><span>↑</span> Hub</button>
            {inline && <button onClick={onBack} className="p-1.5 text-fg-tertiary hover:text-fg-secondary text-lg leading-none">×</button>}
          </div>
        </div>
        <div className="flex gap-1 mt-3 -mb-[1px] overflow-x-auto">
          {TABS.filter(t => !externalInfo || ['overview', 'tasks'].includes(t.key)).map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-xs rounded-t-lg border border-b-0 transition-colors whitespace-nowrap ${
                tab === t.key ? 'bg-surface-primary text-fg-primary border-border-default' : 'text-fg-tertiary border-transparent hover:text-fg-secondary hover:bg-surface-elevated/50'
              }`}
            ><span className="mr-1">{t.icon}</span>{t.label}</button>
          ))}
        </div>
      </div>
      <div className="p-5">
        {tab === 'overview' && <OverviewTab agent={agent} onUpdate={reload} externalInfo={externalInfo} />}
        {tab === 'files' && <FilesTab agentId={agentId} />}
        {tab === 'tools' && <ToolsTab tools={agent.tools ?? []} />}
        {tab === 'skills' && <SkillsTab agent={agent} onUpdate={reload} />}
        {tab === 'memory' && <MemoryTab agentId={agentId} />}
        {tab === 'heartbeat' && <HeartbeatTab agentId={agentId} initialData={agent.heartbeat} />}
        {tab === 'tasks' && <TasksTab agentId={agentId} activeTaskIds={agent.state.activeTaskIds ?? []} />}
      </div>
    </div>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────────────────

function OverviewTab({ agent, onUpdate, externalInfo }: { agent: AgentDetail; onUpdate: () => void; externalInfo?: ExternalAgentInfo | null }) {
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

  if (externalInfo) {
    const GATEWAY_ENDPOINTS = [
      { method: 'POST', path: '/api/gateway/sync', desc: 'Exchange status, tasks, messages, team & project context' },
      { method: 'GET', path: '/api/gateway/manual', desc: 'Download integration handbook (dynamic, includes colleagues & projects)' },
      { method: 'GET', path: '/api/gateway/team', desc: 'Query team members, roles, and manager' },
      { method: 'GET', path: '/api/gateway/projects', desc: 'List projects with iterations and governance' },
      { method: 'GET', path: '/api/gateway/requirements', desc: 'Query requirements (filter by project/status)' },
    ];
    const SYNC_CONTEXT_FIELDS = [
      { field: 'assignedTasks', desc: 'Tasks with requirement & project traceability' },
      { field: 'inboxMessages', desc: 'Messages from teammates' },
      { field: 'teamContext', desc: 'Colleagues (id, name, role, status) + manager' },
      { field: 'projectContext', desc: 'Projects, iterations, active requirements' },
    ];

    return (
      <div className="space-y-4">
        <Card title="Identity">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <KV label="Name">{agent.name}</KV>
            <KV label="Agent Role">
              <span className={agent.agentRole === 'manager' ? 'text-amber-600' : 'text-blue-600'}>{agent.agentRole === 'manager' ? '★ Manager' : '◆ Worker'}</span>
            </KV>
            <KV label="Role Template">{agent.role}</KV>
            <KV label="Markus Agent ID" mono>{agent.id}</KV>
            <KV label="Organization">{agent.config?.orgId ?? 'default'}</KV>
            <KV label="Created">{agent.config?.createdAt ? new Date(agent.config.createdAt).toLocaleDateString() : '—'}</KV>
          </div>
        </Card>

        <Card title="Connection Status">
          <div className="grid grid-cols-4 gap-4">
            <StatBox label="Connection" value={externalInfo.connected ? 'Online' : 'Offline'} color={externalInfo.connected ? 'green' : 'gray'} />
            <StatBox label="Platform" value="OpenClaw" />
            <StatBox label="Active Tasks" value={String(agent.state.activeTaskIds?.length ?? 0)} />
            <StatBox label="Last Sync" value={externalInfo.lastHeartbeat ? new Date(externalInfo.lastHeartbeat).toLocaleTimeString() : 'Never'} />
          </div>
        </Card>

        <Card title="External Agent Details">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <KV label="External Agent ID" mono>{externalInfo.externalAgentId}</KV>
            <KV label="Registered">{new Date(externalInfo.registeredAt).toLocaleString()}</KV>
            <KV label="Capabilities">{externalInfo.capabilities.length > 0 ? externalInfo.capabilities.join(', ') : 'none declared'}</KV>
            <KV label="Last Heartbeat">{externalInfo.lastHeartbeat ? new Date(externalInfo.lastHeartbeat).toLocaleString() : 'Never'}</KV>
          </div>
        </Card>

        <Card title="Sync Context (received every sync cycle)">
          <div className="space-y-1.5">
            {SYNC_CONTEXT_FIELDS.map(f => (
              <div key={f.field} className="flex items-start gap-2.5 px-3 py-2 rounded-lg bg-surface-elevated/30 border border-border-default/30">
                <span className="font-mono text-[10px] text-brand-500 shrink-0 pt-0.5">{f.field}</span>
                <span className="text-[10px] text-fg-tertiary">{f.desc}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Gateway API Endpoints">
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
          <Card title="Recent Tasks" action={<button onClick={() => navBus.navigate('projects')} className="text-xs text-fg-tertiary hover:text-fg-secondary">View all →</button>}>
            <div className="divide-y divide-gray-800/50 -mx-5">
              {recentTasks.map(t => (
                <div key={t.id} className="flex items-center gap-2.5 px-5 py-2.5">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${TASK_DOT[t.status] ?? 'bg-gray-500'}`} />
                  <span className="text-xs text-fg-secondary flex-1 truncate">{t.title}</span>
                  <span className="text-[10px] text-fg-tertiary capitalize shrink-0">{t.status.replace(/_/g, ' ')}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card title="Identity" action={
        editing
          ? <div className="flex gap-2">
              <button onClick={() => setEditing(false)} className="text-xs text-fg-tertiary hover:text-fg-secondary">Cancel</button>
              <button onClick={save} disabled={saving} className="text-xs text-brand-500 hover:text-brand-500">{saving ? 'Saving...' : 'Save'}</button>
            </div>
          : <button onClick={() => { setEditing(true); setEditName(agent.name); setEditRole(agent.agentRole); setEditModelMode((agent.config?.llmConfig as Record<string, unknown>)?.modelMode as 'default' | 'custom' ?? 'default'); setEditModel(agent.config?.llmConfig.primary ?? ''); setEditFallback(agent.config?.llmConfig.fallback ?? ''); }} className="text-xs text-fg-tertiary hover:text-fg-secondary">Edit</button>
      }>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <KV label="Name">{editing ? <input className="input-sm" value={editName} onChange={e => setEditName(e.target.value)} /> : agent.name}</KV>
          <KV label="Agent Role">
            {editing
              ? <div className="flex gap-1.5">{(['worker', 'manager'] as const).map(r => (
                  <button key={r} onClick={() => setEditRole(r)} className={`px-2 py-1 text-[10px] rounded border transition-colors capitalize ${editRole === r ? (r === 'manager' ? 'bg-amber-500/15 text-amber-600 border-amber-500/30' : 'bg-blue-500/15 text-blue-600 border-blue-500/30') : 'bg-surface-elevated text-fg-tertiary border-border-default'}`}>{r}</button>
                ))}</div>
              : <span className={agent.agentRole === 'manager' ? 'text-amber-600' : 'text-blue-600'}>{agent.agentRole === 'manager' ? '★ Manager' : '◆ Worker'}</span>}
          </KV>
          <KV label="Role Template">{agent.role}</KV>
          <KV label="Agent ID" mono>{agent.id}</KV>
          <KV label="Organization">{agent.config?.orgId ?? 'default'}</KV>
          <KV label="Created">{agent.config?.createdAt ? new Date(agent.config.createdAt).toLocaleDateString() : '—'}</KV>
        </div>
      </Card>

      <Card title="Runtime Status">
        <div className="grid grid-cols-4 gap-4">
          <StatBox label="Status" value={agent.state.status} color={agent.state.status === 'idle' ? 'green' : agent.state.status === 'working' ? 'indigo' : agent.state.status === 'error' ? 'red' : 'gray'} />
          <StatBox label="Tokens Today" value={String(agent.state.tokensUsedToday)} />
          <StatBox label="Active Tasks" value={String(agent.state.activeTaskIds?.length ?? 0)} />
          <StatBox label="Last Heartbeat" value={agent.state.lastHeartbeat ? new Date(agent.state.lastHeartbeat).toLocaleTimeString() : 'Never'} />
        </div>

        {agent.state.status === 'error' && (
          <div className="mt-3 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-medium text-red-500">Error Details</span>
              {agent.state.lastErrorAt && <span className="text-[10px] text-red-500/50 ml-auto">{new Date(agent.state.lastErrorAt).toLocaleString()}</span>}
            </div>
            <pre className="text-[11px] text-red-500/80 leading-relaxed whitespace-pre-wrap break-all font-mono bg-red-500/5 rounded p-2">
              {agent.state.lastError || 'Agent encountered an error. Check logs for more details.'}
            </pre>
          </div>
        )}

        {agent.state.status === 'working' && (agent.state.activeTaskIds?.length ?? 0) > 0 && (
          <div className="mt-3 bg-brand-500/10 border border-brand-500/20 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" />
              <span className="text-xs font-medium text-brand-500">Currently Working</span>
              <span className="text-[10px] text-brand-500/50 ml-auto">{agent.state.activeTaskIds!.length} active task{agent.state.activeTaskIds!.length > 1 ? 's' : ''}</span>
            </div>
            <div className="space-y-1">
              {recentTasks.filter(t => agent.state.activeTaskIds?.includes(t.id)).map(t => (
                <div key={t.id} className="flex items-center gap-2 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse shrink-0" />
                  <span className="text-fg-secondary truncate flex-1">{t.title}</span>
                  <span className="text-fg-tertiary capitalize shrink-0">{t.status.replace(/_/g, ' ')}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-4 pt-3 border-t border-border-default/50">
          <button onClick={toggleAgent} className="px-3 py-1.5 text-xs border border-border-default rounded-lg hover:border-brand-500 transition-colors">
            {agent.state.status === 'offline' ? '▶ Start' : '⏹ Stop'}
          </button>
        </div>
      </Card>

      {usageInfo && (
        <Card title="Usage">
          <div className="grid grid-cols-3 gap-4">
            <StatBox label="Total Tokens" value={fmtNum(usageInfo.totalTokens)} />
            <StatBox label="Requests" value={String(usageInfo.requestCount)} />
            <StatBox label="Tool Calls" value={String(usageInfo.toolCalls)} />
            <StatBox label="Prompt Tokens" value={fmtNum(usageInfo.promptTokens)} />
            <StatBox label="Completion Tokens" value={fmtNum(usageInfo.completionTokens)} />
            <StatBox label="Est. Cost" value={`$${usageInfo.estimatedCost < 0.01 ? usageInfo.estimatedCost.toFixed(4) : usageInfo.estimatedCost.toFixed(2)}`} />
          </div>
        </Card>
      )}

      <Card title="LLM Configuration">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <KV label="Model Mode">
              {editing
                ? <div className="flex gap-1.5">
                    {(['default', 'custom'] as const).map(m => (
                      <button key={m} onClick={() => setEditModelMode(m)}
                        className={`px-2.5 py-1 text-[10px] rounded border transition-colors capitalize ${
                          editModelMode === m
                            ? (m === 'default' ? 'bg-brand-500/15 text-brand-500 border-brand-500/30' : 'bg-amber-500/15 text-amber-600 border-amber-500/30')
                            : 'bg-surface-elevated text-fg-tertiary border-border-default'
                        }`}
                      >{m === 'default' ? 'System Default' : 'Custom'}</button>
                    ))}
                  </div>
                : <span className={`text-xs ${currentModelMode === 'custom' ? 'text-amber-600' : 'text-brand-500'}`}>
                    {currentModelMode === 'custom' ? '⚙ Custom' : '◎ System Default'}
                  </span>}
            </KV>
            <KV label="Primary Model">
              {editing
                ? editModelMode === 'custom'
                  ? <select className="input-sm" value={editModel} onChange={e => setEditModel(e.target.value)}>
                      {configuredModels.map(m => <option key={m} value={m}>{m} ({providers[m]?.model})</option>)}
                      {!configuredModels.includes(editModel) && editModel && <option value={editModel}>{editModel}</option>}
                    </select>
                  : <span className="text-xs text-fg-secondary italic">follows system default ({defaultProvider || '...'})</span>
                : <span className="font-mono text-xs">
                    {currentModelMode === 'custom'
                      ? (agent.config?.llmConfig.primary ?? '—')
                      : <span className="text-fg-secondary">{defaultProvider || agent.config?.llmConfig.primary || '—'} <span className="text-fg-tertiary">(system default)</span></span>}
                  </span>}
            </KV>
            <KV label="Fallback">
              {editing
                ? <select className="input-sm" value={editFallback} onChange={e => setEditFallback(e.target.value)}>
                    <option value="">none</option>
                    {configuredModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                : <span className="font-mono text-xs">{agent.config?.llmConfig.fallback ?? 'none'}</span>}
            </KV>
            <KV label="Max Tokens/Request">{agent.config?.llmConfig.maxTokensPerRequest ?? 'default'}</KV>
            <KV label="Max Tokens/Day">{agent.config?.llmConfig.maxTokensPerDay ?? 'unlimited'}</KV>
          </div>
        </Card>

      {/* Recent Tasks */}
      {recentTasks.length > 0 && (
        <Card title="Recent Tasks" action={<button onClick={() => navBus.navigate('projects')} className="text-xs text-fg-tertiary hover:text-fg-secondary">View all →</button>}>
          <div className="divide-y divide-gray-800/50 -mx-5">
            {recentTasks.map(t => {
              const isExpanded = expandedTaskId === t.id;
              const hasLogs = ['in_progress', 'failed', 'completed', 'review'].includes(t.status);
              return (
                <div key={t.id}>
                  <button
                    onClick={() => hasLogs ? setExpandedTaskId(isExpanded ? null : t.id) : undefined}
                    className={`w-full flex items-center gap-2.5 px-5 py-2.5 text-left transition-colors ${hasLogs ? 'hover:bg-surface-elevated/40 cursor-pointer' : 'cursor-default'}`}
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${TASK_DOT[t.status] ?? 'bg-gray-500'}`} />
                    <span className="text-xs text-fg-secondary flex-1 truncate">{t.title}</span>
                    <span className="text-[10px] text-fg-tertiary capitalize shrink-0">{t.status.replace(/_/g, ' ')}</span>
                    {hasLogs && <span className="text-fg-tertiary text-[10px]">{isExpanded ? '▲' : '▼'}</span>}
                  </button>
                  {isExpanded && (
                    <div className="border-t border-border-default/60 bg-surface-primary/40">
                      <TaskLog taskId={t.id} isLive={t.status === 'in_progress'} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Recent Heartbeats */}
      {recentActivities.filter(a => a.type === 'heartbeat').length > 0 && (
        <Card title="Recent Heartbeats" action={<span className="text-[10px] text-fg-tertiary">{recentActivities.filter(a => a.type === 'heartbeat').length} runs</span>}>
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
      {recentActivities.filter(a => a.type === 'chat').length > 0 && (
        <Card title="Recent A2A Communications" action={<span className="text-[10px] text-fg-tertiary">{recentActivities.filter(a => a.type === 'chat').length} conversations</span>}>
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

// ─── Files Tab (System Prompts / Role Files) ─────────────────────────────────

function FilesTab({ agentId }: { agentId: string }) {
  const [files, setFiles] = useState<Array<{ name: string; content: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [roleStatus, setRoleStatus] = useState<RoleUpdateStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
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

  const syncFromTemplate = async (fileName?: string) => {
    setSyncing(true);
    try {
      await api.agents.roleSync(agentId, fileName ? [fileName] : undefined);
      setDiffView(null);
      setDirty(false);
      loadFiles();
    } catch { /* */ }
    setSyncing(false);
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

  if (loading) return <div className="text-xs text-fg-tertiary py-8 text-center">Loading files...</div>;

  const FILE_LABELS: Record<string, string> = {
    'ROLE.md': 'System Prompt / Role Definition',
    'HEARTBEAT.md': 'Heartbeat Tasks',
    'POLICIES.md': 'Policies & Guardrails',
    'CONTEXT.md': 'Context & Instructions',
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
            <div className="text-xs text-amber-600 font-medium">Template Update Available</div>
            <div className="text-[11px] text-amber-600/70 mt-0.5">
              {staleFiles.length} file{staleFiles.length > 1 ? 's' : ''} differ from the <code className="px-1 py-0.5 bg-amber-500/10 rounded text-amber-600">{roleStatus!.templateId}</code> template:
              {' '}{staleFiles.map(f => f.file).join(', ')}
            </div>
          </div>
          <button onClick={() => syncFromTemplate()} disabled={syncing}
            className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors shrink-0 disabled:opacity-50"
          >{syncing ? 'Syncing...' : 'Sync All'}</button>
        </div>
      )}

      <Card title="Agent Configuration Files" action={
        roleStatus?.hasTemplate
          ? <div className="flex items-center gap-2">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${roleStatus.isUpToDate ? 'bg-green-400' : 'bg-amber-400'}`} />
              <span className="text-[10px] text-fg-tertiary">
                Template: <span className="text-fg-secondary">{roleStatus.templateId}</span>
                {roleStatus.isUpToDate ? ' (up to date)' : ' (updates available)'}
              </span>
            </div>
          : <div className="text-[10px] text-fg-tertiary">Custom agent — no linked template</div>
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
              <div className="text-xs text-fg-secondary">{FILE_LABELS[selected] ?? selected}</div>
              <div className="flex gap-2 items-center">
                {selectedFileStale && (
                  <>
                    <button onClick={() => showDiff(selected)} className="px-2.5 py-1 text-[11px] text-amber-600 hover:text-amber-600 border border-amber-500/30 hover:border-amber-500/50 rounded-lg transition-colors">
                      {diffView?.file === selected ? 'Hide Diff' : 'View Diff'}
                    </button>
                    <button onClick={() => syncFromTemplate(selected)} disabled={syncing}
                      className="px-2.5 py-1 text-[11px] bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors disabled:opacity-50"
                    >{syncing ? 'Syncing...' : 'Sync This File'}</button>
                  </>
                )}
                {dirty && <span className="text-[10px] text-amber-600">unsaved</span>}
                <button onClick={saveFile} disabled={saving || !dirty}
                  className={`px-3 py-1 text-xs rounded-lg transition-colors ${dirty ? 'bg-brand-600 hover:bg-brand-500 text-white' : 'bg-surface-elevated text-fg-tertiary cursor-default'}`}
                >{saving ? 'Saving...' : 'Save'}</button>
              </div>
            </div>

            {diffView?.file === selected && (
              <div className="mb-3 border border-border-default rounded-lg overflow-hidden">
                <div className="grid grid-cols-2 text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider bg-surface-elevated/80">
                  <div className="px-3 py-2 border-r border-border-default">Current (Agent)</div>
                  <div className="px-3 py-2">Template ({roleStatus?.templateId})</div>
                </div>
                <div className="grid grid-cols-2 max-h-60 overflow-y-auto">
                  <pre className="px-3 py-2 text-[11px] font-mono text-red-500/70 bg-red-500/5 border-r border-border-default whitespace-pre-wrap break-words overflow-x-hidden">{diffView.agent}</pre>
                  <pre className="px-3 py-2 text-[11px] font-mono text-green-600/70 bg-green-500/5 whitespace-pre-wrap break-words overflow-x-hidden">{diffView.template}</pre>
                </div>
              </div>
            )}

            <textarea
              value={editContent}
              onChange={e => { setEditContent(e.target.value); setDirty(true); }}
              className="w-full h-80 bg-surface-elevated/60 border border-border-default rounded-lg p-4 text-xs font-mono text-fg-secondary leading-relaxed resize-y focus:border-brand-500 outline-none"
              spellCheck={false}
            />
            {selected === 'ROLE.md' && (
              <div className="text-[10px] text-fg-tertiary mt-2">Changes to ROLE.md will update the agent's runtime system prompt immediately.</div>
            )}
          </div>
        )}

        {files.length === 0 && <Empty text="No configuration files found for this role" />}
      </Card>
    </div>
  );
}

// ─── Tools Tab ───────────────────────────────────────────────────────────────

const TOOL_CATEGORIES: Record<string, string[]> = {
  'Files': ['file_read', 'file_write', 'file_edit', 'apply_patch'],
  'Search': ['grep_search', 'glob_find', 'list_directory'],
  'Runtime': ['shell_execute', 'background_exec', 'process'],
  'Web': ['web_search', 'web_fetch', 'web_extract'],
  'Tasks': ['task_create', 'task_list', 'task_update', 'task_get', 'task_assign', 'task_note', 'task_submit_review', 'subtask_create', 'subtask_complete', 'subtask_list'],
  'Requirements': ['requirement_propose', 'requirement_list', 'requirement_update_status'],
  'Projects': ['list_projects', 'get_project', 'project_info', 'iteration_status'],
  'Deliverables': ['deliverable_create', 'deliverable_search', 'deliverable_list', 'deliverable_update'],
  'Communication': ['agent_send_message', 'agent_list_colleagues', 'agent_send_group_message', 'agent_create_group_chat', 'agent_list_group_chats', 'agent_broadcast_status', 'agent_delegate_task'],
  'Memory': ['memory_save', 'memory_search', 'memory_list', 'memory_update_longterm'],
  'Planning': ['todo_write', 'todo_read'],
  'Team (Manager)': ['team_list', 'team_status', 'delegate_message', 'create_task', 'task_check_duplicates', 'task_cleanup_duplicates', 'task_board_health'],
};

function categorizeTools(tools: AgentToolInfo[]): Array<{ category: string; tools: AgentToolInfo[] }> {
  const categorized = new Map<string, AgentToolInfo[]>();
  const used = new Set<string>();
  for (const [cat, names] of Object.entries(TOOL_CATEGORIES)) {
    const matched = tools.filter(t => names.some(n => t.name.startsWith(n)));
    if (matched.length > 0) { categorized.set(cat, matched); matched.forEach(m => used.add(m.name)); }
  }
  const remaining = tools.filter(t => !used.has(t.name));
  for (const tool of remaining) {
    const sep = tool.name.indexOf('__');
    if (sep > 0) {
      const server = tool.name.slice(0, sep);
      const label = `MCP: ${server}`;
      if (!categorized.has(label)) categorized.set(label, []);
      categorized.get(label)!.push(tool);
      used.add(tool.name);
    }
  }
  const other = tools.filter(t => !used.has(t.name));
  if (other.length > 0) categorized.set('Other', other);
  return [...categorized.entries()].map(([category, tools]) => ({ category, tools }));
}

function ToolsTab({ tools }: { tools: AgentToolInfo[] }) {
  const groups = categorizeTools(tools);
  return (
    <div className="space-y-4">
      <div className="text-xs text-fg-tertiary">{tools.length} tools registered</div>
      {groups.map(g => (
        <Card key={g.category} title={g.category}>
          <div className="grid grid-cols-2 gap-2">
            {g.tools.map(t => (
              <div key={t.name} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-elevated/30 border border-border-default/30">
                <div className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium font-mono">{t.name}</div>
                  <div className="text-[10px] text-fg-tertiary truncate">{t.description}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
      {tools.length === 0 && <div className="text-center py-12 text-fg-tertiary text-sm">No tools registered</div>}
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

function SkillsTab({ agent, onUpdate }: { agent: AgentDetail; onUpdate: () => void }) {
  const proficiency = agent.proficiency ?? {};
  const [availableSkills, setAvailableSkills] = useState<Array<{ name: string; version: string; description?: string }>>([]);
  const [showImport, setShowImport] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    api.skills.list().then(d => setAvailableSkills(d.skills)).catch(() => {});
  }, []);

  const addSkill = async (skillName: string) => {
    await api.agents.addSkill(agent.id, skillName);
    onUpdate();
  };

  const removeSkill = async (skillName: string) => {
    await api.agents.removeSkill(agent.id, skillName);
    onUpdate();
  };

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

  const importable = availableSkills.filter(s => !agent.skills.includes(s.name) && s.name.toLowerCase().includes(search.toLowerCase()));

  const CATEGORY_COLORS: Record<string, string> = {
    development: 'bg-blue-500/15 text-blue-600', devops: 'bg-amber-500/15 text-amber-600',
    communication: 'bg-green-500/15 text-green-600', data: 'bg-brand-500/15 text-brand-500',
    productivity: 'bg-amber-500/15 text-amber-600', browser: 'bg-blue-500/15 text-blue-600',
    custom: 'bg-gray-500/15 text-fg-secondary',
  };

  return (
    <div className="space-y-4">
      <Card title={`Assigned Skills (${agent.skills.length})`} action={
        <button onClick={() => setShowImport(!showImport)} className="text-xs text-brand-500 hover:text-brand-500">
          {showImport ? 'Close' : '+ Add Skill'}
        </button>
      }>
        {showImport && (
          <div className="mb-4 p-3 bg-surface-elevated/40 rounded-lg border border-border-default/40">
            <input className="input-sm mb-2" placeholder="Search skills..." value={search} onChange={e => setSearch(e.target.value)} />
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {importable.length === 0 ? <div className="text-[10px] text-fg-tertiary py-2 text-center">No additional skills available</div> : importable.map(s => (
                <div key={s.name} className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-surface-elevated/30 hover:bg-surface-overlay/40 transition-colors">
                  <span className="text-xs text-fg-secondary flex-1">{s.name} <span className="text-fg-tertiary">v{s.version}</span></span>
                  <button onClick={() => addSkill(s.name)} className="px-2 py-0.5 text-[10px] bg-brand-600 hover:bg-brand-500 text-white rounded">Add</button>
                </div>
              ))}
            </div>
          </div>
        )}
        {agent.skills.length === 0 ? <Empty text="No skills configured" /> : (
          <div className="space-y-2">
            {agent.skills.map(skill => {
              const prof = proficiency[skill];
              const rate = prof && prof.uses > 0 ? Math.round(prof.successes / prof.uses * 100) : null;
              const isExpanded = expandedSkill === skill;
              return (
                <div key={skill}>
                  <div
                    className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border cursor-pointer transition-all ${
                      isExpanded ? 'bg-brand-500/10 border-brand-500/40' : 'bg-surface-elevated/30 border-border-default/30 hover:border-gray-600/50'
                    }`}
                    onClick={() => toggleDetail(skill)}
                  >
                    <span className={`text-sm transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{skill}</div>
                      {prof && <div className="text-[10px] text-fg-tertiary mt-0.5">{prof.uses} uses · {prof.successes} successes{prof.lastUsed && ` · last ${new Date(prof.lastUsed).toLocaleDateString()}`}</div>}
                    </div>
                    {rate !== null && (
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="w-16 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${rate >= 80 ? 'bg-green-400' : rate >= 50 ? 'bg-amber-400' : 'bg-red-400'}`} style={{ width: `${rate}%` }} />
                        </div>
                        <span className="text-[10px] text-fg-tertiary w-8 text-right">{rate}%</span>
                      </div>
                    )}
                    <button onClick={e => { e.stopPropagation(); removeSkill(skill); }} className="text-fg-tertiary hover:text-red-500 text-xs transition-colors" title="Remove skill">✕</button>
                  </div>

                  {isExpanded && (
                    <div className="ml-6 mt-1 mb-2 p-4 bg-surface-elevated/30 rounded-lg border border-border-default/20 space-y-3">
                      {detailLoading ? (
                        <div className="text-[10px] text-fg-tertiary py-3 text-center">Loading skill details…</div>
                      ) : skillDetail ? (
                        <>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${CATEGORY_COLORS[skillDetail.category] ?? CATEGORY_COLORS['custom']}`}>
                              {skillDetail.category}
                            </span>
                            <span className="text-[10px] text-fg-tertiary">v{skillDetail.version}</span>
                            {skillDetail.author && <span className="text-[10px] text-fg-tertiary">by {skillDetail.author}</span>}
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
                                Tools ({(skillDetail.toolDetails ?? skillDetail.tools ?? []).length})
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
                          Skill details not available (skill may not be registered in the store)
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Memory Tab ──────────────────────────────────────────────────────────────

function MemoryTab({ agentId }: { agentId: string }) {
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
    await api.agents.updateLongTermMemory(agentId, 'User-edited', longContent).catch(() => {});
    setSaving(false);
    setEditingLong(false);
    loadData();
  };

  if (loading) return <div className="text-xs text-fg-tertiary py-8 text-center">Loading memory...</div>;
  if (!data) return <div className="text-xs text-fg-tertiary py-8 text-center">Failed to load memory data</div>;

  const sectionTabs = [
    { key: 'entries' as const, label: `Recent (${data.entries.length})` },
    { key: 'sessions' as const, label: `Sessions (${data.sessions.length})` },
    { key: 'daily' as const, label: 'Daily Logs' },
    { key: 'longterm' as const, label: 'Long-term' },
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
        <Card title="Recent Memory Entries">
          {data.entries.length === 0 ? <Empty text="No memory entries" /> : (
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
                          <span>Type: {e.type}</span>
                          {e.importance != null && <span>Importance: {e.importance}</span>}
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
        <Card title="Chat Sessions">
          {data.sessions.length === 0 ? <Empty text="No sessions" /> : (
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
                      <span className="text-[10px] text-fg-tertiary">{s.messageCount} msgs</span>
                      <span className="text-[10px] text-fg-tertiary">{new Date(s.updatedAt).toLocaleDateString()}</span>
                      <span className="text-fg-tertiary text-[10px]">{isExpanded ? '▲' : '▼'}</span>
                    </button>
                    {isExpanded && (
                      <div className="mx-3 mt-1 mb-2 bg-surface-elevated/30 rounded-lg border border-border-default/20 max-h-96 overflow-y-auto">
                        {sessionLoading ? (
                          <div className="text-[10px] text-fg-tertiary py-3 text-center">Loading messages...</div>
                        ) : sessionMessages.length === 0 ? (
                          <div className="text-[10px] text-fg-tertiary py-3 text-center">No messages in this session</div>
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
                                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium mb-1 ${m.role === 'user' ? 'bg-blue-500/15 text-blue-600' : 'bg-surface-overlay text-fg-secondary'}`}>{m.role}</span>
                                      <div className="text-xs text-fg-secondary"><MarkdownMessage content={m.content} className="text-xs text-fg-secondary" /></div>
                                    </div>
                                  )}
                                  {m.role === 'assistant' && (
                                    <div className="space-y-1">
                                      {m.content && (
                                        <div>
                                          <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium mb-1 bg-green-500/15 text-green-600">assistant</span>
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
        <Card title="Daily Logs" action={
          editingDaily
            ? <div className="flex gap-2">
                <button onClick={() => setEditingDaily(false)} className="text-xs text-fg-tertiary">Cancel</button>
                <button onClick={saveDaily} disabled={saving} className="text-xs text-brand-500">{saving ? 'Saving...' : 'Save'}</button>
              </div>
            : <button onClick={() => setEditingDaily(true)} className="text-xs text-fg-tertiary hover:text-fg-secondary">Edit</button>
        }>
          {editingDaily ? (
            <textarea value={dailyContent} onChange={e => setDailyContent(e.target.value)}
              className="w-full h-64 bg-surface-elevated/60 border border-border-default rounded-lg p-4 text-xs font-mono text-fg-secondary leading-relaxed resize-y focus:border-brand-500 outline-none" />
          ) : data.recentDailyLogs ? (
            <pre className="text-xs text-fg-secondary whitespace-pre-wrap font-mono leading-relaxed bg-surface-elevated/30 rounded-lg p-4 max-h-96 overflow-y-auto">{data.recentDailyLogs}</pre>
          ) : <Empty text="No daily logs" />}
        </Card>
      )}

      {section === 'longterm' && (
        <Card title="Long-term Memory" action={
          editingLong
            ? <div className="flex gap-2">
                <button onClick={() => setEditingLong(false)} className="text-xs text-fg-tertiary">Cancel</button>
                <button onClick={saveLong} disabled={saving} className="text-xs text-brand-500">{saving ? 'Saving...' : 'Save'}</button>
              </div>
            : <button onClick={() => setEditingLong(true)} className="text-xs text-fg-tertiary hover:text-fg-secondary">Edit</button>
        }>
          {editingLong ? (
            <textarea value={longContent} onChange={e => setLongContent(e.target.value)}
              className="w-full h-64 bg-surface-elevated/60 border border-border-default rounded-lg p-4 text-xs font-mono text-fg-secondary leading-relaxed resize-y focus:border-brand-500 outline-none" />
          ) : data.longTermMemory ? (
            <pre className="text-xs text-fg-secondary whitespace-pre-wrap font-mono leading-relaxed bg-surface-elevated/30 rounded-lg p-4 max-h-96 overflow-y-auto">{data.longTermMemory}</pre>
          ) : <Empty text="No long-term memory stored" />}
        </Card>
      )}
    </div>
  );
}

// ─── Heartbeat Tab ───────────────────────────────────────────────────────────

function HeartbeatTab({ agentId, initialData }: { agentId: string; initialData?: AgentHeartbeatInfo }) {
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

  if (loading) return <div className="text-xs text-fg-tertiary py-8 text-center">Loading heartbeat data...</div>;
  if (!data) return <div className="text-xs text-fg-tertiary py-8 text-center">No heartbeat data available</div>;

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
      if (abs < 60000) return `in ${Math.ceil(abs / 1000)}s`;
      if (abs < 3600000) return `in ${Math.ceil(abs / 60000)}m`;
      return `in ${(abs / 3600000).toFixed(1)}h`;
    }
    if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    return `${(ms / 3600000).toFixed(1)}h ago`;
  };

  return (
    <div className="space-y-4">
      {/* Scheduler + Controls */}
      <Card title="Heartbeat Scheduler" action={
        <div className="flex items-center gap-2">
          <button onClick={refresh} className="text-[10px] text-fg-tertiary hover:text-fg-secondary transition-colors">
            Refresh
          </button>
          <button
            onClick={handleTrigger}
            disabled={triggering || !data.running}
            className="text-[10px] px-2.5 py-1 rounded-md bg-blue-600/20 text-blue-600 hover:bg-blue-600/30 border border-blue-500/30 transition-colors disabled:opacity-40"
          >
            {triggering ? 'Triggering...' : 'Trigger Now'}
          </button>
        </div>
      }>
        <div className="grid grid-cols-4 gap-4">
          <StatBox label="Status" value={data.running ? 'Running' : 'Stopped'} color={data.running ? 'green' : 'gray'} />
          <StatBox label="Interval" value={formatDuration(data.intervalMs) ?? '—'} />
          <StatBox label="Last Run" value={data.lastHeartbeat ? formatRelativeTime(data.lastHeartbeat) ?? '—' : 'Never'} />
          <StatBox label="Next Run" value={data.nextRunAt ? formatRelativeTime(data.nextRunAt) ?? '—' : data.running ? 'Pending' : '—'} />
        </div>
        {triggerMsg && (
          <div className="mt-3 text-[11px] text-blue-600 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
            {triggerMsg}
          </div>
        )}
      </Card>

      {/* Last Heartbeat Summary */}
      {data.lastSummary && (
        <Card title="Last Heartbeat Summary" action={
          data.lastSummaryAt ? <span className="text-[10px] text-fg-tertiary">{new Date(data.lastSummaryAt).toLocaleString()}</span> : undefined
        }>
          <div className="bg-surface-primary/50 rounded-lg px-4 py-3">
            <MarkdownMessage content={data.lastSummary} className="text-xs text-fg-secondary leading-relaxed" />
          </div>
        </Card>
      )}

      {/* Recent Runs */}
      {recentRuns.length > 0 ? (
        <Card title="Recent Runs" action={<span className="text-[10px] text-fg-tertiary">{recentRuns.length} runs this session</span>}>
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
                    <span className="text-[10px] text-fg-tertiary shrink-0">{act.logCount} actions</span>
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
        <Card title="Recent Runs">
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="text-xl mb-2 opacity-40">♡</div>
            <p className="text-xs text-fg-tertiary">No heartbeat runs yet this session.</p>
            <p className="text-[10px] text-fg-tertiary mt-1">
              {data.running
                ? `First heartbeat will trigger in ~${formatDuration(data.intervalMs - data.uptimeMs % data.intervalMs) ?? 'soon'}.`
                : 'Heartbeat scheduler is stopped.'}
            </p>
            {data.running && (
              <button onClick={handleTrigger} disabled={triggering}
                className="mt-3 text-[10px] px-3 py-1.5 rounded-md bg-blue-600/15 text-blue-600 hover:bg-blue-600/25 border border-blue-500/25 transition-colors disabled:opacity-40">
                {triggering ? 'Triggering...' : 'Run First Heartbeat Now'}
              </button>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

// ─── Tasks Tab ───────────────────────────────────────────────────────────────

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const TASK_STATUS_DOT: Record<string, string> = { pending: 'bg-gray-400', assigned: 'bg-blue-400', in_progress: 'bg-brand-400 animate-pulse', blocked: 'bg-amber-400', completed: 'bg-green-400', failed: 'bg-red-400', cancelled: 'bg-gray-600' };

function TasksTab({ agentId, activeTaskIds }: { agentId: string; activeTaskIds: string[] }) {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadTasks = useCallback(() => {
    api.tasks.list({ assignedAgentId: agentId })
      .then(d => { setTasks(d.tasks); })
      .catch(() => {});
  }, [agentId]);

  useEffect(() => { loadTasks(); const unsub = wsClient.on('task:update', () => loadTasks()); return unsub; }, [loadTasks]);

  const sorted = [...tasks].sort((a, b) => {
    const rank = (s: string) => s === 'in_progress' ? 0 : TERMINAL.has(s) ? 2 : 1;
    return rank(a.status) - rank(b.status);
  });

  return (
    <div className="space-y-4">
      <Card title="Tasks" action={<span className="text-xs text-fg-tertiary">{sorted.length} total</span>}>
        {sorted.length === 0 ? <Empty text="No tasks assigned" /> : (
          <div className="divide-y divide-gray-800/50 -mx-5">
            {sorted.map(task => {
              const isExpanded = expandedId === task.id;
              const isExecuting = activeTaskIds.includes(task.id) || task.status === 'in_progress';
              const hasLogs = task.status === 'in_progress' || task.status === 'failed' || task.status === 'completed';
              return (
                <div key={task.id}>
                  <button onClick={() => hasLogs ? setExpandedId(isExpanded ? null : task.id) : undefined}
                    className={`w-full flex items-center gap-3 px-5 py-3 text-left transition-colors ${hasLogs ? 'hover:bg-surface-elevated/40 cursor-pointer' : 'cursor-default'}`}>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${TASK_STATUS_DOT[task.status] ?? 'bg-gray-500'}`} />
                    <div className="flex-1 min-w-0">
                      <div className={`text-xs font-medium truncate ${TERMINAL.has(task.status) ? 'text-fg-tertiary' : 'text-fg-primary'}`}>{task.title}</div>
                      <div className="text-[10px] text-fg-tertiary mt-0.5 capitalize">{task.status.replace(/_/g, ' ')}</div>
                    </div>
                    {isExecuting && <span className="w-3 h-3 border-2 border-brand-400 border-t-transparent rounded-full animate-spin shrink-0" />}
                    {hasLogs && <span className="text-fg-tertiary text-[10px]">{isExpanded ? '▲' : '▼'}</span>}
                  </button>
                  {isExpanded && <div className="border-t border-border-default/60 bg-surface-primary/40"><TaskLog taskId={task.id} isLive={isExecuting} /></div>}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Task Log ────────────────────────────────────────────────────────────────

function TaskLog({ taskId, isLive }: { taskId: string; isLive: boolean }) {
  const [logs, setLogs] = useState<TaskLogEntry[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [loading, setLoading] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const logScrollRef = useRef<HTMLDivElement>(null);
  const logAtBottomRef = useRef(true);

  useEffect(() => {
    const el = logScrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      logAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

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

  useEffect(() => {
    if (!logAtBottomRef.current) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, streamingText]);

  if (loading) return <div className="px-4 py-3 text-xs text-fg-tertiary">Loading...</div>;
  if (logs.length === 0 && !streamingText) return <div className="px-4 py-3 text-xs text-fg-tertiary">No execution logs yet.</div>;

  const entries = filterCompletedStarts(logs.map(taskLogToEntry).filter((e): e is ExecEntry => e != null));

  return (
    <div ref={logScrollRef} className="max-h-56 overflow-y-auto px-3 py-2 space-y-0.5">
      {entries.map((entry, i) => <ExecEntryRow key={`e-${i}`} entry={entry} showTime />)}
      {streamingText && <StreamingText content={streamingText} />}
      <div ref={endRef} />
    </div>
  );
}


// ─── Activity Log (Heartbeat / A2A) ─────────────────────────────────────────

function ActivityLog({ agentId, activityId }: { agentId: string; activityId: string }) {
  const [logs, setLogs] = useState<AgentActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.agents.getActivityLogs(agentId, activityId)
      .then(d => { setLogs(d.logs); setLoading(false); })
      .catch(() => setLoading(false));
  }, [agentId, activityId]);

  if (loading) return <div className="px-4 py-3 text-xs text-fg-tertiary">Loading...</div>;
  if (logs.length === 0) return <div className="px-4 py-3 text-xs text-fg-tertiary">No activity logs available.</div>;

  const entries = filterCompletedStarts(logs.map(activityLogToEntry).filter((e): e is ExecEntry => e != null));

  return (
    <div className="max-h-56 overflow-y-auto px-3 py-2 space-y-0.5">
      {entries.map((entry, i) => <ExecEntryRow key={`a-${i}`} entry={entry} showTime />)}
    </div>
  );
}

// ─── Shared UI ───────────────────────────────────────────────────────────────

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
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
  const c = color === 'green' ? 'text-green-600' : color === 'indigo' ? 'text-brand-500' : color === 'red' ? 'text-red-500' : 'text-fg-secondary';
  return (<div className="text-center"><div className={`text-lg font-semibold ${c}`}>{value}</div><div className="text-[10px] text-fg-tertiary mt-0.5">{label}</div></div>);
}

function Empty({ text }: { text: string }) {
  return <div className="text-xs text-fg-tertiary py-6 text-center">{text}</div>;
}
