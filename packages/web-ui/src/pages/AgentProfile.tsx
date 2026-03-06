import { useEffect, useState, useRef, useCallback } from 'react';
import { api, wsClient } from '../api.ts';
import type { AgentDetail, AgentToolInfo, AgentMemorySummary, AgentHeartbeatInfo, TaskInfo, TaskLogEntry, AgentUsageInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { LogEntryRow } from '../components/ToolCallLogEntry.tsx';
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
  idle: 'bg-green-400', working: 'bg-indigo-400 animate-pulse',
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

  const reload = useCallback(() => { api.agents.get(agentId).then(setAgent).catch(() => {}); }, [agentId]);

  useEffect(() => {
    setTab('overview');
    reload();
    const unsub = wsClient.on('agent:update', (evt) => {
      if ((evt.payload as Record<string, string>).agentId === agentId) reload();
    });
    return unsub;
  }, [agentId, reload]);

  if (!agent) return <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">Loading agent...</div>;

  const statusDot = STATUS_DOT[agent.state.status] ?? 'bg-gray-500';

  return (
    <div className="flex-1 overflow-y-auto bg-gray-950">
      <div className="px-5 py-3.5 border-b border-gray-800 bg-gray-900 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-lg font-bold shrink-0">{agent.name.charAt(0)}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold">{agent.name}</h2>
              <span className={`w-2 h-2 rounded-full ${statusDot}`} />
              <span className="text-xs text-gray-500">{agent.state.status}</span>
              {agent.agentRole === 'manager' && <span className="px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-400 rounded font-medium">Manager</span>}
            </div>
            <div className="text-xs text-gray-500 truncate">{agent.role}{agent.roleDescription ? ` — ${agent.roleDescription}` : ''}</div>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <button onClick={() => navBus.navigate('chat', { agentId })} className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors flex items-center gap-1"><span>◈</span> Chat</button>
            {inline && <button onClick={onBack} className="p-1.5 text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>}
          </div>
        </div>
        <div className="flex gap-1 mt-3 -mb-[1px] overflow-x-auto">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-xs rounded-t-lg border border-b-0 transition-colors whitespace-nowrap ${
                tab === t.key ? 'bg-gray-950 text-white border-gray-800' : 'text-gray-500 border-transparent hover:text-gray-300 hover:bg-gray-800/50'
              }`}
            ><span className="mr-1">{t.icon}</span>{t.label}</button>
          ))}
        </div>
      </div>
      <div className="p-5">
        {tab === 'overview' && <OverviewTab agent={agent} onUpdate={reload} />}
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

function OverviewTab({ agent, onUpdate }: { agent: AgentDetail; onUpdate: () => void }) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(agent.name);
  const [editRole, setEditRole] = useState(agent.agentRole);
  const [editModel, setEditModel] = useState(agent.config?.llmConfig.primary ?? '');
  const [editFallback, setEditFallback] = useState(agent.config?.llmConfig.fallback ?? '');
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<Record<string, { model: string; configured: boolean }>>({});
  const [recentTasks, setRecentTasks] = useState<TaskInfo[]>([]);
  const [usageInfo, setUsageInfo] = useState<AgentUsageInfo | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  useEffect(() => {
    api.settings.getLlm().then(d => setProviders(d.providers)).catch(() => {});
    api.tasks.list({ assignedAgentId: agent.id }).then(d => setRecentTasks(d.tasks.slice(0, 5))).catch(() => {});
    api.usage.agents().then(d => {
      const info = d.agents.find(a => a.agentId === agent.id);
      if (info) setUsageInfo(info);
    }).catch(() => {});
  }, [agent.id]);

  const configuredModels = Object.entries(providers).filter(([, v]) => v.configured).map(([k]) => k);

  const save = async () => {
    setSaving(true);
    try {
      await api.agents.updateConfig(agent.id, {
        name: editName, agentRole: editRole,
        llmConfig: { primary: editModel, fallback: editFallback || undefined },
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

  const TASK_DOT: Record<string, string> = { pending: 'bg-gray-400', assigned: 'bg-blue-400', in_progress: 'bg-indigo-400', completed: 'bg-green-400', failed: 'bg-red-400', cancelled: 'bg-gray-600' };

  return (
    <div className="space-y-4">
      <Card title="Identity" action={
        editing
          ? <div className="flex gap-2">
              <button onClick={() => setEditing(false)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
              <button onClick={save} disabled={saving} className="text-xs text-indigo-400 hover:text-indigo-300">{saving ? 'Saving...' : 'Save'}</button>
            </div>
          : <button onClick={() => { setEditing(true); setEditName(agent.name); setEditRole(agent.agentRole); setEditModel(agent.config?.llmConfig.primary ?? ''); setEditFallback(agent.config?.llmConfig.fallback ?? ''); }} className="text-xs text-gray-600 hover:text-gray-400">Edit</button>
      }>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <KV label="Name">{editing ? <input className="input-sm" value={editName} onChange={e => setEditName(e.target.value)} /> : agent.name}</KV>
          <KV label="Agent Role">
            {editing
              ? <div className="flex gap-1.5">{(['worker', 'manager'] as const).map(r => (
                  <button key={r} onClick={() => setEditRole(r)} className={`px-2 py-1 text-[10px] rounded border transition-colors capitalize ${editRole === r ? (r === 'manager' ? 'bg-amber-500/15 text-amber-400 border-amber-500/30' : 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30') : 'bg-gray-800 text-gray-500 border-gray-700'}`}>{r}</button>
                ))}</div>
              : <span className={agent.agentRole === 'manager' ? 'text-amber-400' : 'text-cyan-400'}>{agent.agentRole === 'manager' ? '★ Manager' : '◆ Worker'}</span>}
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
              <span className="text-xs font-medium text-red-400">Error Details</span>
              {agent.state.lastErrorAt && <span className="text-[10px] text-red-400/50 ml-auto">{new Date(agent.state.lastErrorAt).toLocaleString()}</span>}
            </div>
            <pre className="text-[11px] text-red-300/80 leading-relaxed whitespace-pre-wrap break-all font-mono bg-red-500/5 rounded p-2">
              {agent.state.lastError || 'Agent encountered an error. Check logs for more details.'}
            </pre>
          </div>
        )}

        {agent.state.status === 'working' && (agent.state.activeTaskIds?.length ?? 0) > 0 && (
          <div className="mt-3 bg-indigo-500/10 border border-indigo-500/20 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
              <span className="text-xs font-medium text-indigo-400">Currently Working</span>
              <span className="text-[10px] text-indigo-400/50 ml-auto">{agent.state.activeTaskIds!.length} active task{agent.state.activeTaskIds!.length > 1 ? 's' : ''}</span>
            </div>
            <div className="space-y-1">
              {recentTasks.filter(t => agent.state.activeTaskIds?.includes(t.id)).map(t => (
                <div key={t.id} className="flex items-center gap-2 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse shrink-0" />
                  <span className="text-gray-300 truncate flex-1">{t.title}</span>
                  <span className="text-gray-500 capitalize shrink-0">{t.status.replace(/_/g, ' ')}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-4 pt-3 border-t border-gray-800/50">
          <button onClick={toggleAgent} className="px-3 py-1.5 text-xs border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors">
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

      {/* LLM Config */}
      <Card title="LLM Configuration">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <KV label="Primary Model">
            {editing
              ? <select className="input-sm" value={editModel} onChange={e => setEditModel(e.target.value)}>
                  {configuredModels.map(m => <option key={m} value={m}>{m} ({providers[m]?.model})</option>)}
                  {!configuredModels.includes(editModel) && editModel && <option value={editModel}>{editModel}</option>}
                </select>
              : <span className="font-mono text-xs">{agent.config?.llmConfig.primary ?? '—'}</span>}
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
        <Card title="Recent Tasks" action={<button onClick={() => navBus.navigate('projects')} className="text-xs text-gray-600 hover:text-gray-400">View all →</button>}>
          <div className="divide-y divide-gray-800/50 -mx-5">
            {recentTasks.map(t => {
              const isExpanded = expandedTaskId === t.id;
              const hasLogs = ['in_progress', 'failed', 'completed', 'review', 'accepted'].includes(t.status);
              return (
                <div key={t.id}>
                  <button
                    onClick={() => hasLogs ? setExpandedTaskId(isExpanded ? null : t.id) : undefined}
                    className={`w-full flex items-center gap-2.5 px-5 py-2.5 text-left transition-colors ${hasLogs ? 'hover:bg-gray-800/40 cursor-pointer' : 'cursor-default'}`}
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${TASK_DOT[t.status] ?? 'bg-gray-500'}`} />
                    <span className="text-xs text-gray-300 flex-1 truncate">{t.title}</span>
                    <span className="text-[10px] text-gray-600 capitalize shrink-0">{t.status.replace(/_/g, ' ')}</span>
                    {hasLogs && <span className="text-gray-600 text-[10px]">{isExpanded ? '▲' : '▼'}</span>}
                  </button>
                  {isExpanded && (
                    <div className="border-t border-gray-800/60 bg-gray-950/40">
                      <TaskLog taskId={t.id} isLive={t.status === 'in_progress'} />
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

  useEffect(() => {
    setLoading(true);
    api.agents.getFiles(agentId).then(d => {
      setFiles(d.files);
      if (d.files.length > 0 && !selected) {
        setSelected(d.files[0].name);
        setEditContent(d.files[0].content);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [agentId]);

  const selectFile = (name: string) => {
    const f = files.find(f => f.name === name);
    if (f) { setSelected(name); setEditContent(f.content); setDirty(false); }
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

  if (loading) return <div className="text-xs text-gray-600 py-8 text-center">Loading files...</div>;

  const FILE_LABELS: Record<string, string> = {
    'ROLE.md': 'System Prompt / Role Definition',
    'SKILLS.md': 'Default Skills',
    'HEARTBEAT.md': 'Heartbeat Tasks',
    'POLICIES.md': 'Policies & Guardrails',
    'CONTEXT.md': 'Context & Instructions',
  };

  return (
    <div className="space-y-4">
      <Card title="Agent Configuration Files" action={
        <div className="text-[10px] text-gray-600">Edit system prompts and role definitions</div>
      }>
        <div className="flex gap-2 mb-4 flex-wrap">
          {files.map(f => (
            <button key={f.name} onClick={() => selectFile(f.name)}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                selected === f.name ? 'bg-indigo-600/15 border-indigo-500/40 text-indigo-300' : 'border-gray-700 text-gray-500 hover:text-gray-300'
              }`}
            >{f.name}</button>
          ))}
        </div>

        {selected && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-gray-400">{FILE_LABELS[selected] ?? selected}</div>
              <div className="flex gap-2">
                {dirty && <span className="text-[10px] text-amber-400">unsaved</span>}
                <button onClick={saveFile} disabled={saving || !dirty}
                  className={`px-3 py-1 text-xs rounded-lg transition-colors ${dirty ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-gray-800 text-gray-600 cursor-default'}`}
                >{saving ? 'Saving...' : 'Save'}</button>
              </div>
            </div>
            <textarea
              value={editContent}
              onChange={e => { setEditContent(e.target.value); setDirty(true); }}
              className="w-full h-80 bg-gray-800/60 border border-gray-700 rounded-lg p-4 text-xs font-mono text-gray-300 leading-relaxed resize-y focus:border-indigo-500 outline-none"
              spellCheck={false}
            />
            {selected === 'ROLE.md' && (
              <div className="text-[10px] text-gray-600 mt-2">Changes to ROLE.md will update the agent's runtime system prompt immediately.</div>
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
  'Runtime': ['shell_execute', 'process'],
  'Web': ['web_search', 'web_fetch'],
  'Memory': ['memory_search', 'memory_get'],
  'Communication': ['agent_send_message', 'agent_list_colleagues', 'message'],
  'Browser & UI': ['browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_extract', 'browser_evaluate', 'gui_screenshot', 'gui_click', 'gui_type', 'gui_key_press', 'gui_scroll'],
  'Tasks': ['task_list', 'task_create', 'task_update', 'task_assign'],
  'Git': ['git_status', 'git_diff', 'git_log', 'git_branch'],
  'Code': ['code_search', 'project_structure', 'code_stats'],
};

function categorizeTools(tools: AgentToolInfo[]): Array<{ category: string; tools: AgentToolInfo[] }> {
  const categorized = new Map<string, AgentToolInfo[]>();
  const used = new Set<string>();
  for (const [cat, names] of Object.entries(TOOL_CATEGORIES)) {
    const matched = tools.filter(t => names.some(n => t.name.startsWith(n)));
    if (matched.length > 0) { categorized.set(cat, matched); matched.forEach(m => used.add(m.name)); }
  }
  const remaining = tools.filter(t => !used.has(t.name));
  if (remaining.length > 0) categorized.set('Other', remaining);
  return [...categorized.entries()].map(([category, tools]) => ({ category, tools }));
}

function ToolsTab({ tools }: { tools: AgentToolInfo[] }) {
  const groups = categorizeTools(tools);
  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-500">{tools.length} tools registered</div>
      {groups.map(g => (
        <Card key={g.category} title={g.category}>
          <div className="grid grid-cols-2 gap-2">
            {g.tools.map(t => (
              <div key={t.name} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-800/30 border border-gray-700/30">
                <div className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium font-mono">{t.name}</div>
                  <div className="text-[10px] text-gray-600 truncate">{t.description}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
      {tools.length === 0 && <div className="text-center py-12 text-gray-600 text-sm">No tools registered</div>}
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
    development: 'bg-blue-500/15 text-blue-400', devops: 'bg-orange-500/15 text-orange-400',
    communication: 'bg-green-500/15 text-green-400', data: 'bg-purple-500/15 text-purple-400',
    productivity: 'bg-amber-500/15 text-amber-400', browser: 'bg-cyan-500/15 text-cyan-400',
    custom: 'bg-gray-500/15 text-gray-400',
  };

  return (
    <div className="space-y-4">
      <Card title={`Assigned Skills (${agent.skills.length})`} action={
        <button onClick={() => setShowImport(!showImport)} className="text-xs text-indigo-400 hover:text-indigo-300">
          {showImport ? 'Close' : '+ Add Skill'}
        </button>
      }>
        {showImport && (
          <div className="mb-4 p-3 bg-gray-800/40 rounded-lg border border-gray-700/40">
            <input className="input-sm mb-2" placeholder="Search skills..." value={search} onChange={e => setSearch(e.target.value)} />
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {importable.length === 0 ? <div className="text-[10px] text-gray-600 py-2 text-center">No additional skills available</div> : importable.map(s => (
                <div key={s.name} className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-gray-800/30 hover:bg-gray-700/40 transition-colors">
                  <span className="text-xs text-gray-300 flex-1">{s.name} <span className="text-gray-600">v{s.version}</span></span>
                  <button onClick={() => addSkill(s.name)} className="px-2 py-0.5 text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white rounded">Add</button>
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
                      isExpanded ? 'bg-indigo-900/15 border-indigo-500/40' : 'bg-gray-800/30 border-gray-700/30 hover:border-gray-600/50'
                    }`}
                    onClick={() => toggleDetail(skill)}
                  >
                    <span className={`text-sm transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{skill}</div>
                      {prof && <div className="text-[10px] text-gray-500 mt-0.5">{prof.uses} uses · {prof.successes} successes{prof.lastUsed && ` · last ${new Date(prof.lastUsed).toLocaleDateString()}`}</div>}
                    </div>
                    {rate !== null && (
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${rate >= 80 ? 'bg-green-400' : rate >= 50 ? 'bg-amber-400' : 'bg-red-400'}`} style={{ width: `${rate}%` }} />
                        </div>
                        <span className="text-[10px] text-gray-500 w-8 text-right">{rate}%</span>
                      </div>
                    )}
                    <button onClick={e => { e.stopPropagation(); removeSkill(skill); }} className="text-gray-600 hover:text-red-400 text-xs transition-colors" title="Remove skill">✕</button>
                  </div>

                  {isExpanded && (
                    <div className="ml-6 mt-1 mb-2 p-4 bg-gray-800/30 rounded-lg border border-gray-700/20 space-y-3">
                      {detailLoading ? (
                        <div className="text-[10px] text-gray-600 py-3 text-center">Loading skill details…</div>
                      ) : skillDetail ? (
                        <>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${CATEGORY_COLORS[skillDetail.category] ?? CATEGORY_COLORS['custom']}`}>
                              {skillDetail.category}
                            </span>
                            <span className="text-[10px] text-gray-500">v{skillDetail.version}</span>
                            {skillDetail.author && <span className="text-[10px] text-gray-500">by {skillDetail.author}</span>}
                            {skillDetail.requiredPermissions?.map(p => (
                              <span key={p} className="px-1.5 py-0.5 bg-amber-500/10 text-amber-400 text-[10px] rounded">{p}</span>
                            ))}
                          </div>
                          {skillDetail.description && (
                            <p className="text-xs text-gray-400 leading-relaxed">{skillDetail.description}</p>
                          )}
                          {skillDetail.tags && skillDetail.tags.length > 0 && (
                            <div className="flex gap-1 flex-wrap">
                              {skillDetail.tags.map(tag => (
                                <span key={tag} className="px-1.5 py-0.5 bg-gray-700/40 text-gray-500 text-[10px] rounded">#{tag}</span>
                              ))}
                            </div>
                          )}
                          {(skillDetail.toolDetails ?? skillDetail.tools).length > 0 && (
                            <div>
                              <div className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider mb-2">
                                Tools ({(skillDetail.toolDetails ?? skillDetail.tools).length})
                              </div>
                              <div className="space-y-1.5">
                                {(skillDetail.toolDetails ?? skillDetail.tools).map(tool => (
                                  <div key={tool.name} className="px-3 py-2 bg-gray-900/50 rounded border border-gray-700/20">
                                    <div className="text-xs font-medium text-indigo-300">{tool.name}</div>
                                    {tool.description && <div className="text-[10px] text-gray-500 mt-0.5">{tool.description}</div>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="text-[10px] text-gray-600 py-3 text-center">
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

  if (loading) return <div className="text-xs text-gray-600 py-8 text-center">Loading memory...</div>;
  if (!data) return <div className="text-xs text-gray-600 py-8 text-center">Failed to load memory data</div>;

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
            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${section === s.key ? 'bg-indigo-600/15 border-indigo-500/40 text-indigo-300' : 'border-gray-700 text-gray-500 hover:text-gray-300'}`}
          >{s.label}</button>
        ))}
      </div>

      {section === 'entries' && (
        <Card title="Recent Memory Entries">
          {data.entries.length === 0 ? <Empty text="No memory entries" /> : (
            <div className="space-y-1.5 max-h-96 overflow-y-auto">
              {data.entries.map((e, i) => (
                <div key={i} className="flex gap-2 px-3 py-2 rounded-lg bg-gray-800/20 text-xs">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${e.type === 'fact' ? 'bg-blue-500/15 text-blue-400' : e.type === 'task' ? 'bg-green-500/15 text-green-400' : 'bg-gray-700 text-gray-400'}`}>{e.type}</span>
                  <span className="text-gray-300 flex-1 min-w-0 truncate">{e.content}</span>
                  <span className="text-gray-600 shrink-0">{new Date(e.timestamp).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {section === 'sessions' && (
        <Card title="Chat Sessions">
          {data.sessions.length === 0 ? <Empty text="No sessions" /> : (
            <div className="space-y-1.5">
              {data.sessions.map(s => (
                <div key={s.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-gray-800/20">
                  <div className="text-xs text-gray-400 font-mono flex-1 truncate">{s.id}</div>
                  <span className="text-[10px] text-gray-500">{s.messageCount} msgs</span>
                  <span className="text-[10px] text-gray-600">{new Date(s.updatedAt).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {section === 'daily' && (
        <Card title="Daily Logs" action={
          editingDaily
            ? <div className="flex gap-2">
                <button onClick={() => setEditingDaily(false)} className="text-xs text-gray-500">Cancel</button>
                <button onClick={saveDaily} disabled={saving} className="text-xs text-indigo-400">{saving ? 'Saving...' : 'Save'}</button>
              </div>
            : <button onClick={() => setEditingDaily(true)} className="text-xs text-gray-600 hover:text-gray-400">Edit</button>
        }>
          {editingDaily ? (
            <textarea value={dailyContent} onChange={e => setDailyContent(e.target.value)}
              className="w-full h-64 bg-gray-800/60 border border-gray-700 rounded-lg p-4 text-xs font-mono text-gray-300 leading-relaxed resize-y focus:border-indigo-500 outline-none" />
          ) : data.recentDailyLogs ? (
            <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed bg-gray-800/30 rounded-lg p-4 max-h-96 overflow-y-auto">{data.recentDailyLogs}</pre>
          ) : <Empty text="No daily logs" />}
        </Card>
      )}

      {section === 'longterm' && (
        <Card title="Long-term Memory" action={
          editingLong
            ? <div className="flex gap-2">
                <button onClick={() => setEditingLong(false)} className="text-xs text-gray-500">Cancel</button>
                <button onClick={saveLong} disabled={saving} className="text-xs text-indigo-400">{saving ? 'Saving...' : 'Save'}</button>
              </div>
            : <button onClick={() => setEditingLong(true)} className="text-xs text-gray-600 hover:text-gray-400">Edit</button>
        }>
          {editingLong ? (
            <textarea value={longContent} onChange={e => setLongContent(e.target.value)}
              className="w-full h-64 bg-gray-800/60 border border-gray-700 rounded-lg p-4 text-xs font-mono text-gray-300 leading-relaxed resize-y focus:border-indigo-500 outline-none" />
          ) : data.longTermMemory ? (
            <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed bg-gray-800/30 rounded-lg p-4 max-h-96 overflow-y-auto">{data.longTermMemory}</pre>
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

  useEffect(() => {
    api.agents.getHeartbeat(agentId).then(setData).catch(() => {}).finally(() => setLoading(false));
  }, [agentId]);

  if (loading) return <div className="text-xs text-gray-600 py-8 text-center">Loading heartbeat data...</div>;
  if (!data) return <div className="text-xs text-gray-600 py-8 text-center">No heartbeat data available</div>;

  return (
    <div className="space-y-4">
      <Card title="Scheduler">
        <div className="grid grid-cols-4 gap-4">
          <StatBox label="Status" value={data.running ? 'Running' : 'Stopped'} color={data.running ? 'green' : 'gray'} />
          <StatBox label="Tasks" value={String(data.taskCount)} />
          <StatBox label="Active" value={String(data.activeTasks)} />
          <StatBox label="Failed" value={String(data.failedTasks)} color={data.failedTasks > 0 ? 'red' : 'gray'} />
        </div>
        {data.lastHeartbeat && <div className="mt-3 pt-3 border-t border-gray-800/50 text-xs text-gray-500">Last heartbeat: {new Date(data.lastHeartbeat).toLocaleString()}</div>}
      </Card>
      <Card title={`Heartbeat Tasks (${data.taskStats.length})`}>
        {data.taskStats.length === 0 ? <Empty text="No heartbeat tasks configured" /> : (
          <div className="space-y-2">
            {data.taskStats.map(t => (
              <div key={t.name} className="px-4 py-3 rounded-lg bg-gray-800/30 border border-gray-700/30">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">{t.name}</span>
                  <div className="flex items-center gap-3 text-[10px] text-gray-500">
                    <span>{t.totalRuns} runs</span>
                    {t.failedRuns > 0 && <span className="text-red-400">{t.failedRuns} failed</span>}
                  </div>
                </div>
                <div className="flex gap-4 text-[10px] text-gray-600">
                  {t.lastRun && <span>Last: {new Date(t.lastRun).toLocaleString()}</span>}
                  {t.nextRun && <span>Next: {new Date(t.nextRun).toLocaleString()}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Tasks Tab ───────────────────────────────────────────────────────────────

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const TASK_STATUS_DOT: Record<string, string> = { pending: 'bg-gray-400', assigned: 'bg-blue-400', in_progress: 'bg-indigo-400 animate-pulse', blocked: 'bg-amber-400', completed: 'bg-green-400', failed: 'bg-red-400', cancelled: 'bg-gray-600' };

function TasksTab({ agentId, activeTaskIds }: { agentId: string; activeTaskIds: string[] }) {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadTasks = useCallback(() => {
    api.tasks.list({ assignedAgentId: agentId })
      .then(d => { setTasks(d.tasks.filter(t => !t.parentTaskId)); })
      .catch(() => {});
  }, [agentId]);

  useEffect(() => { loadTasks(); const unsub = wsClient.on('task:update', () => loadTasks()); return unsub; }, [loadTasks]);

  const sorted = [...tasks].sort((a, b) => {
    const rank = (s: string) => s === 'in_progress' ? 0 : TERMINAL.has(s) ? 2 : 1;
    return rank(a.status) - rank(b.status);
  });

  return (
    <div className="space-y-4">
      <Card title="Tasks" action={<span className="text-xs text-gray-600">{sorted.length} total</span>}>
        {sorted.length === 0 ? <Empty text="No tasks assigned" /> : (
          <div className="divide-y divide-gray-800/50 -mx-5">
            {sorted.map(task => {
              const isExpanded = expandedId === task.id;
              const isExecuting = activeTaskIds.includes(task.id) || task.status === 'in_progress';
              const hasLogs = task.status === 'in_progress' || task.status === 'failed' || task.status === 'completed';
              return (
                <div key={task.id}>
                  <button onClick={() => hasLogs ? setExpandedId(isExpanded ? null : task.id) : undefined}
                    className={`w-full flex items-center gap-3 px-5 py-3 text-left transition-colors ${hasLogs ? 'hover:bg-gray-800/40 cursor-pointer' : 'cursor-default'}`}>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${TASK_STATUS_DOT[task.status] ?? 'bg-gray-500'}`} />
                    <div className="flex-1 min-w-0">
                      <div className={`text-xs font-medium truncate ${TERMINAL.has(task.status) ? 'text-gray-500' : 'text-gray-200'}`}>{task.title}</div>
                      <div className="text-[10px] text-gray-600 mt-0.5 capitalize">{task.status.replace(/_/g, ' ')}</div>
                    </div>
                    {isExecuting && <span className="w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin shrink-0" />}
                    {hasLogs && <span className="text-gray-600 text-[10px]">{isExpanded ? '▲' : '▼'}</span>}
                  </button>
                  {isExpanded && <div className="border-t border-gray-800/60 bg-gray-950/40"><TaskLog taskId={task.id} isLive={isExecuting} /></div>}
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

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs, streamingText]);

  if (loading) return <div className="px-4 py-3 text-xs text-gray-600">Loading...</div>;
  if (logs.length === 0 && !streamingText) return <div className="px-4 py-3 text-xs text-gray-600">No execution logs yet.</div>;

  return (
    <div className="max-h-56 overflow-y-auto px-3 py-2 space-y-0.5">
      {logs.map((entry, i) => <LogEntryRow key={`${entry.seq}-${i}`} entry={entry} />)}
      {streamingText && (
        <div className="bg-gray-800/50 rounded-lg px-3 py-2.5 my-1">
          <MarkdownMessage content={streamingText} className="text-sm text-gray-300" />
          <span className="inline-block w-0.5 h-4 bg-indigo-400 animate-pulse ml-0.5 align-middle" />
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}


// ─── Shared UI ───────────────────────────────────────────────────────────────

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function KV({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (<div className="flex flex-col gap-0.5"><span className="text-[10px] text-gray-600">{label}</span><span className={`text-xs text-gray-300 ${mono ? 'font-mono text-[10px]' : ''}`}>{children}</span></div>);
}

function StatBox({ label, value, color }: { label: string; value: string; color?: string }) {
  const c = color === 'green' ? 'text-green-400' : color === 'indigo' ? 'text-indigo-400' : color === 'red' ? 'text-red-400' : 'text-gray-300';
  return (<div className="text-center"><div className={`text-lg font-semibold ${c}`}>{value}</div><div className="text-[10px] text-gray-600 mt-0.5">{label}</div></div>);
}

function Empty({ text }: { text: string }) {
  return <div className="text-xs text-gray-600 py-6 text-center">{text}</div>;
}
