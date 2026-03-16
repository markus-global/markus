import { useEffect, useState, useCallback } from 'react';
import { api, hubApi, AgentInfo, type HubItem } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface InstalledSkill {
  name: string;
  version: string;
  description?: string;
  author?: string;
  category?: string;
  tags?: string[];
  tools?: Array<{ name: string; description: string }>;
  requiredPermissions?: string[];
  type: 'builtin' | 'filesystem' | 'imported';
  sourcePath?: string;
  agentIds: string[];
}

interface SkillHubSkill {
  slug: string;
  name: string;
  description: string;
  description_zh?: string;
  version: string;
  homepage: string;
  tags: string[];
  downloads: number;
  stars: number;
  installs: number;
  score: number;
}

interface BuiltinSkill {
  name: string;
  version: string;
  description?: string;
  author?: string;
  category?: string;
  tags: string[];
  hasMcpServers: boolean;
  hasInstructions: boolean;
  requiredPermissions: string[];
  installed: boolean;
  installedVersion?: string | null;
}

function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

interface SkillsShSkill {
  name: string;
  author: string;
  repo: string;
  installs?: string;
  url: string;
  description?: string;
}

type TabId = 'installed' | 'builtin' | 'skillhub' | 'skillssh' | 'markus-hub';

// ─── Constants ──────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  development: 'bg-blue-500/15 text-blue-400',
  devops: 'bg-orange-500/15 text-orange-400',
  productivity: 'bg-green-500/15 text-green-400',
  custom: 'bg-gray-500/15 text-gray-400',
  browser: 'bg-indigo-500/15 text-indigo-400',
  communication: 'bg-emerald-500/15 text-emerald-400',
  data: 'bg-violet-500/15 text-violet-400',
  'AI 智能': 'bg-purple-500/15 text-purple-400',
  '开发工具': 'bg-blue-500/15 text-blue-400',
  '效率提升': 'bg-green-500/15 text-green-400',
  '数据分析': 'bg-violet-500/15 text-violet-400',
  '内容创作': 'bg-pink-500/15 text-pink-400',
  '安全合规': 'bg-red-500/15 text-red-400',
  '通讯协作': 'bg-emerald-500/15 text-emerald-400',
};

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'installed', label: 'Installed' },
  { id: 'builtin', label: 'Built-in' },
  { id: 'skillhub', label: 'SkillHub' },
  { id: 'skillssh', label: 'skills.sh' },
  { id: 'markus-hub', label: 'Markus Hub' },
];

// ─── Agent Assignment Modal ──────────────────────────────────────────────────────

function AgentAssignModal({
  skillName,
  agents,
  currentAgentIds,
  onClose,
  onConfirm,
}: {
  skillName: string;
  agents: AgentInfo[];
  currentAgentIds: string[];
  onClose: () => void;
  onConfirm: (agentIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(currentAgentIds));

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-[480px] max-h-[70vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 pt-5 pb-4 border-b border-gray-800">
          <h3 className="text-base font-semibold">Assign to Agents</h3>
          <p className="text-xs text-gray-400 mt-1">Select which agents can use <span className="text-indigo-400 font-medium">{skillName}</span></p>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {agents.length === 0 ? (
            <div className="text-sm text-gray-500 text-center py-8">No agents available</div>
          ) : (
            <div className="space-y-2">
              {agents.map(agent => (
                <label key={agent.id} className="flex items-center gap-3 p-3 rounded-lg bg-gray-800 hover:bg-gray-750 cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={selected.has(agent.id)}
                    onChange={() => toggle(agent.id)}
                    className="w-4 h-4 rounded accent-indigo-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{agent.name}</div>
                    <div className="text-xs text-gray-500">{agent.role} · {agent.status}</div>
                  </div>
                  {agent.skills?.includes(skillName) && (
                    <span className="text-[10px] text-emerald-400 shrink-0">assigned</span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 rounded-lg hover:bg-gray-800">
            Cancel
          </button>
          <button onClick={() => onConfirm([...selected])} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg">
            Confirm ({selected.size} agent{selected.size !== 1 ? 's' : ''})
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────────

export function SkillStore() {
  const [tab, setTab] = useState<TabId>('installed');
  const [flash, setFlash] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [installing, setInstalling] = useState<Set<string>>(new Set());

  // Installed tab
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [installedSearch, setInstalledSearch] = useState('');

  // SkillHub tab
  const [skillhubSkills, setSkillhubSkills] = useState<SkillHubSkill[]>([]);
  const [skillhubTotal, setSkillhubTotal] = useState(0);
  const [skillhubPage, setSkillhubPage] = useState(1);
  const [skillhubCategories, setSkillhubCategories] = useState<string[]>([]);
  const [skillhubCategory, setSkillhubCategory] = useState('');
  const [skillhubSort, setSkillhubSort] = useState('score');
  const [skillhubSearch, setSkillhubSearch] = useState('');
  const [loadingSkillhub, setLoadingSkillhub] = useState(false);

  // Built-in tab
  const [builtinSkills, setBuiltinSkills] = useState<BuiltinSkill[]>([]);
  const [loadingBuiltin, setLoadingBuiltin] = useState(false);

  // skills.sh tab
  const [skillsshList, setSkillsshList] = useState<SkillsShSkill[]>([]);
  const [skillsshSearch, setSkillsshSearch] = useState('');
  const [loadingSkillssh, setLoadingSkillssh] = useState(false);

  // Markus Hub tab
  const [hubSkills, setHubSkills] = useState<HubItem[]>([]);
  const [loadingHub, setLoadingHub] = useState(false);
  const [hubSearch, setHubSearch] = useState('');

  // Agents
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  // Assignment modal
  const [assignModal, setAssignModal] = useState<{ skillName: string; currentAgentIds: string[] } | null>(null);

  const msg = (m: string, type: 'success' | 'error' = 'success') => {
    setFlash({ text: m, type });
    setTimeout(() => setFlash(null), type === 'error' ? 10000 : 4000);
  };

  // ── Load functions ────────────────────────────────────────────────────────────

  const loadInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      const d = await api.skills.list();
      setInstalled(d.skills as InstalledSkill[]);
    } catch { /* */ }
    setLoadingInstalled(false);
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      const d = await api.agents.list();
      setAgents(d.agents);
    } catch { /* */ }
  }, []);

  const loadBuiltin = useCallback(async () => {
    setLoadingBuiltin(true);
    try {
      const d = await api.skills.builtin();
      setBuiltinSkills(d.skills);
    } catch { /* */ }
    setLoadingBuiltin(false);
  }, []);

  const loadSkillhub = useCallback(async (opts?: { q?: string; category?: string; page?: number; sort?: string }) => {
    setLoadingSkillhub(true);
    try {
      const d = await api.skills.registrySkillhub({
        q: opts?.q,
        category: opts?.category,
        page: opts?.page ?? 1,
        limit: 24,
        sort: opts?.sort ?? skillhubSort,
      });
      setSkillhubSkills(d.skills);
      setSkillhubTotal(d.total);
      if (d.categories?.length) setSkillhubCategories(d.categories);
    } catch { /* */ }
    setLoadingSkillhub(false);
  }, [skillhubSort]);

  const loadSkillssh = useCallback(async (q?: string) => {
    setLoadingSkillssh(true);
    try {
      const d = await api.skills.registrySkillssh(q);
      setSkillsshList(d.skills);
    } catch { /* */ }
    setLoadingSkillssh(false);
  }, []);

  const loadHubSkills = useCallback(async (q?: string) => {
    setLoadingHub(true);
    try {
      const d = await hubApi.search({ type: 'skill', q: q || undefined, limit: 50 });
      setHubSkills(d.items);
    } catch { /* Hub might be offline */ }
    setLoadingHub(false);
  }, []);

  useEffect(() => { loadInstalled(); loadAgents(); loadBuiltin(); loadSkillhub(); loadSkillssh(); }, []);
  useEffect(() => { if (tab === 'markus-hub') loadHubSkills(hubSearch); }, [tab, hubSearch, loadHubSkills]);

  // ── Install helpers ───────────────────────────────────────────────────────────

  const installSkillhub = async (skill: SkillHubSkill) => {
    setInstalling(prev => new Set(prev).add(skill.name));
    try {
      const result = await api.skills.install({
        name: skill.name,
        source: 'skillhub',
        slug: skill.slug,
        sourceUrl: skill.homepage,
        description: skill.description_zh ?? skill.description,
        category: 'custom',
        version: skill.version,
      });
      await loadInstalled();
      msg(`"${skill.name}" installed (${result.method}) → ${result.path}`);
      const agentIds = agents.filter(a => a.skills?.includes(skill.name)).map(a => a.id);
      setAssignModal({ skillName: skill.name, currentAgentIds: agentIds });
    } catch (err) {
      msg(`Download failed for "${skill.name}". You can try manually from: ${skill.homepage}`, 'error');
    }
    setInstalling(prev => { const next = new Set(prev); next.delete(skill.name); return next; });
  };

  const installSkillssh = async (skill: SkillsShSkill) => {
    setInstalling(prev => new Set(prev).add(skill.name));
    try {
      const result = await api.skills.install({
        name: skill.name,
        source: 'skillssh',
        sourceUrl: skill.url,
        githubRepo: `${skill.author}/${skill.repo}`,
        githubSkillPath: skill.name,
      });
      await loadInstalled();
      msg(`"${skill.name}" installed (${result.method}) → ${result.path}`);
      const agentIds = agents.filter(a => a.skills?.includes(skill.name)).map(a => a.id);
      setAssignModal({ skillName: skill.name, currentAgentIds: agentIds });
    } catch (err) {
      msg(`Download failed for "${skill.name}". You can try manually from: ${skill.url}`, 'error');
    }
    setInstalling(prev => { const next = new Set(prev); next.delete(skill.name); return next; });
  };

  const installBuiltin = async (skill: BuiltinSkill) => {
    setInstalling(prev => new Set(prev).add(skill.name));
    try {
      const result = await api.skills.install({ name: skill.name, source: 'builtin' });
      await loadInstalled();
      await loadBuiltin();
      msg(`"${skill.name}" installed (${result.method}) → ${result.path}`);
      const agentIds = agents.filter(a => a.skills?.includes(skill.name)).map(a => a.id);
      setAssignModal({ skillName: skill.name, currentAgentIds: agentIds });
    } catch (err) {
      msg(`Install failed for "${skill.name}": ${err}`, 'error');
    }
    setInstalling(prev => { const next = new Set(prev); next.delete(skill.name); return next; });
  };

  const handleAssignConfirm = async (skillName: string, newAgentIds: string[]) => {
    // Find current assignment
    const skill = installed.find(s => s.name === skillName);
    const currentIds = new Set(skill?.agentIds ?? []);
    const newIds = new Set(newAgentIds);

    // Add to new agents
    for (const agentId of newIds) {
      if (!currentIds.has(agentId)) {
        try { await api.agents.addSkill(agentId, skillName); } catch { /* */ }
      }
    }
    // Remove from unselected agents
    for (const agentId of currentIds) {
      if (!newIds.has(agentId)) {
        try { await api.agents.removeSkill(agentId, skillName); } catch { /* */ }
      }
    }
    await loadInstalled();
    await loadAgents();
    setAssignModal(null);
    msg(`Assignment updated for "${skillName}"`);
  };

  const uninstallSkill = async (name: string) => {
    if (!confirm(`Uninstall "${name}"? This will delete the skill files from ~/.markus/skills/.`)) return;
    try {
      await api.skills.uninstall(name);
      await loadInstalled();
      msg(`"${name}" uninstalled`);
    } catch (err) {
      msg(`Uninstall failed: ${err}`, 'error');
    }
  };

  // ── Filter ────────────────────────────────────────────────────────────────────

  const filteredInstalled = installed.filter(s => {
    if (!installedSearch) return true;
    const q = installedSearch.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q);
  });

  const filteredSkillssh = skillsshList.filter(s => {
    if (!skillsshSearch) return true;
    const q = skillsshSearch.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.repo.toLowerCase().includes(q);
  });

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-7 h-14 border-b border-gray-800 bg-gray-900 shrink-0">
        <h2 className="text-lg font-semibold">Skill Store</h2>
        <div className="flex gap-1 ml-2">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                tab === t.id ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {flash && (
        <div className={`mx-7 mt-2 px-3 py-1.5 text-xs rounded-lg shrink-0 ${
          flash.type === 'error' ? 'bg-red-900/50 text-red-300' : 'bg-emerald-900/50 text-emerald-300'
        }`}>{flash.text}</div>
      )}

      {/* ── Installed Tab ─────────────────────────────────────────────────────── */}
      {tab === 'installed' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex items-center gap-3 mb-5">
            <input
              value={installedSearch}
              onChange={e => setInstalledSearch(e.target.value)}
              placeholder="Search installed skills..."
              className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-indigo-500 outline-none w-72"
            />
            <span className="text-xs text-gray-500">{filteredInstalled.length} skill{filteredInstalled.length !== 1 ? 's' : ''}</span>
          </div>

          {loadingInstalled ? (
            <div className="text-center text-gray-500 py-20">Loading...</div>
          ) : filteredInstalled.length === 0 ? (
            <div className="text-center text-gray-500 py-20">
              <div className="text-4xl mb-3 opacity-30">◆</div>
              <div>No installed skills found.</div>
              <div className="text-xs mt-1">Browse SkillHub or skills.sh to discover and install skills.</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredInstalled.map(skill => {
                const agentNames = skill.agentIds.map(id => agents.find(a => a.id === id)?.name ?? id).filter(Boolean);
                return (
                  <div key={skill.name} className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-semibold text-sm truncate">{skill.name}</div>
                          <span className={`px-1.5 py-0.5 rounded text-[9px] shrink-0 ${
                            skill.type === 'builtin' ? 'bg-blue-500/15 text-blue-400' :
                            skill.type === 'filesystem' ? 'bg-emerald-500/15 text-emerald-400' :
                            'bg-amber-500/15 text-amber-400'
                          }`}>{skill.type === 'builtin' ? 'built-in' : skill.type === 'filesystem' ? 'local' : 'imported'}</span>
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {skill.author ? `by ${skill.author} · ` : ''}{skill.version ? `v${skill.version}` : ''}
                          {skill.sourcePath && <span className="ml-1 text-gray-600" title={skill.sourcePath}>📁 {skill.sourcePath.replace(/^.*\/\.([^/]+)\/skills\//, '~/.$1/skills/')}</span>}
                        </div>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${CATEGORY_COLORS[skill.category ?? ''] ?? 'bg-gray-500/15 text-gray-400'} capitalize shrink-0 ml-2`}>
                        {skill.category ?? 'custom'}
                      </span>
                    </div>

                    <p className="text-sm text-gray-400 mt-2 line-clamp-2">{skill.description ?? 'No description'}</p>

                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {skill.tags?.slice(0, 3).map(t => <span key={t} className="px-2 py-0.5 text-[10px] bg-gray-800 text-gray-500 rounded-full">{t}</span>)}
                    </div>

                    <div className="mt-3 pt-2 border-t border-gray-800 flex items-center justify-between">
                      <button
                        onClick={() => setAssignModal({ skillName: skill.name, currentAgentIds: skill.agentIds })}
                        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-indigo-400 transition-colors"
                      >
                        <span>
                          {agentNames.length === 0
                            ? '＋ Assign to agents'
                            : `${agentNames.length} agent${agentNames.length !== 1 ? 's' : ''}: ${agentNames.slice(0, 2).join(', ')}${agentNames.length > 2 ? '…' : ''}`}
                        </span>
                      </button>
                      <div className="flex items-center gap-2">
                        {skill.tools && skill.tools.length > 0 && (
                          <span className="text-[10px] text-gray-600">{skill.tools.length} tool{skill.tools.length !== 1 ? 's' : ''}</span>
                        )}
                        {skill.type !== 'builtin' && (
                          <button
                            onClick={() => void uninstallSkill(skill.name)}
                            className="px-2 py-0.5 text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors"
                          >
                            Uninstall
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Built-in Tab ─────────────────────────────────────────────────────── */}
      {tab === 'builtin' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex items-center gap-3 mb-5">
            <span className="text-xs text-gray-500">{builtinSkills.length} built-in skill{builtinSkills.length !== 1 ? 's' : ''} available</span>
            <button
              onClick={() => void loadBuiltin()}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Refresh
            </button>
          </div>

          {loadingBuiltin ? (
            <div className="text-center text-gray-500 py-20"><div className="animate-pulse">Loading built-in skills...</div></div>
          ) : builtinSkills.length === 0 ? (
            <div className="text-center text-gray-500 py-20">
              <div className="text-4xl mb-3 opacity-30">◇</div>
              <div>No built-in skills found.</div>
              <div className="text-xs mt-1">Built-in skills are provided in templates/skills/.</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {builtinSkills.map(skill => (
                <div key={skill.name} className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="font-semibold text-sm truncate">{skill.name}</div>
                        {skill.hasMcpServers && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] bg-cyan-500/15 text-cyan-400 shrink-0">MCP</span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {skill.author ? `by ${skill.author} · ` : ''}v{skill.version}
                      </div>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${CATEGORY_COLORS[skill.category ?? ''] ?? 'bg-gray-500/15 text-gray-400'} capitalize shrink-0 ml-2`}>
                      {skill.category ?? 'custom'}
                    </span>
                  </div>

                  <p className="text-sm text-gray-400 mt-2 line-clamp-2">{skill.description ?? 'No description'}</p>

                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {skill.tags.slice(0, 4).map(t => <span key={t} className="px-2 py-0.5 text-[10px] bg-gray-800 text-gray-500 rounded-full">{t}</span>)}
                  </div>

                  {skill.requiredPermissions.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {skill.requiredPermissions.map(p => (
                        <span key={p} className="px-1.5 py-0.5 text-[9px] bg-amber-500/10 text-amber-500 rounded">{p}</span>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 pt-2 border-t border-gray-800 flex items-center justify-between">
                    {skill.installed && skill.installedVersion ? (
                      <span className="text-[10px] text-gray-500">v{skill.installedVersion}</span>
                    ) : <span />}
                    {skill.installed && skill.installedVersion && isNewerVersion(skill.version, skill.installedVersion) ? (
                      <button
                        onClick={() => void installBuiltin(skill)}
                        disabled={installing.has(skill.name)}
                        className="px-2.5 py-1 text-[10px] bg-amber-600 hover:bg-amber-500 text-white rounded-lg disabled:opacity-50 transition-colors"
                      >
                        {installing.has(skill.name) ? 'Upgrading...' : `Upgrade → v${skill.version}`}
                      </button>
                    ) : skill.installed ? (
                      <span className="px-2.5 py-1 text-[10px] bg-gray-700 text-gray-400 rounded-lg">Installed</span>
                    ) : (
                      <button
                        onClick={() => void installBuiltin(skill)}
                        disabled={installing.has(skill.name)}
                        className="px-2.5 py-1 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 transition-colors"
                      >
                        {installing.has(skill.name) ? 'Installing...' : 'Install'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── SkillHub Tab ──────────────────────────────────────────────────────── */}
      {tab === 'skillhub' && (
        <div className="flex-1 overflow-y-auto p-6">
          {/* Controls */}
          <div className="flex items-center gap-2 mb-5 flex-wrap">
            <select
              value={skillhubCategory}
              onChange={e => { setSkillhubCategory(e.target.value); setSkillhubPage(1); void loadSkillhub({ q: skillhubSearch || undefined, category: e.target.value || undefined, page: 1 }); }}
              className="px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-300 outline-none"
            >
              <option value="">全部分类</option>
              {skillhubCategories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              value={skillhubSort}
              onChange={e => { setSkillhubSort(e.target.value); setSkillhubPage(1); void loadSkillhub({ q: skillhubSearch || undefined, category: skillhubCategory || undefined, page: 1, sort: e.target.value }); }}
              className="px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-300 outline-none"
            >
              <option value="score">综合排序</option>
              <option value="downloads">下载量</option>
              <option value="stars">收藏数</option>
              <option value="installs">安装量</option>
            </select>
            <input
              value={skillhubSearch}
              onChange={e => setSkillhubSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { setSkillhubPage(1); void loadSkillhub({ q: skillhubSearch || undefined, category: skillhubCategory || undefined, page: 1 }); } }}
              placeholder="搜索 SkillHub 技能..."
              className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-indigo-500 outline-none w-64"
            />
            <button
              onClick={() => { setSkillhubPage(1); void loadSkillhub({ q: skillhubSearch || undefined, category: skillhubCategory || undefined, page: 1 }); }}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg"
            >
              Search
            </button>
            <span className="text-xs text-gray-500 ml-auto">
              <a href="https://skillhub.tencent.com" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300">Visit site →</a>
            </span>
          </div>

          {loadingSkillhub ? (
            <div className="text-center text-gray-500 py-20"><div className="animate-pulse">正在加载 SkillHub 技能...</div></div>
          ) : skillhubSkills.length === 0 ? (
            <div className="text-center text-gray-500 py-20">
              <div className="text-4xl mb-3 opacity-30">◎</div>
              <div>未找到匹配的技能</div>
            </div>
          ) : (
            <>
              <div className="text-xs text-gray-500 mb-3">共 {skillhubTotal.toLocaleString()} 个技能</div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {skillhubSkills.map(skill => {
                  const isInstalled = installed.some(s => s.name === skill.name || s.name === skill.slug);
                  return (
                    <div key={skill.slug} className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-colors">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm truncate">{skill.name}</div>
                          <div className="text-xs text-gray-500 mt-0.5">v{skill.version}</div>
                        </div>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ml-2 ${skill.tags?.[0] ? (CATEGORY_COLORS[skill.tags[0]] ?? 'bg-indigo-500/15 text-indigo-400') : 'bg-indigo-500/15 text-indigo-400'}`}>
                          {skill.tags?.[0] ?? 'SkillHub'}
                        </span>
                      </div>
                      <p className="text-sm text-gray-400 mt-2 line-clamp-2">{skill.description_zh ?? skill.description ?? 'No description'}</p>
                      <div className="mt-2 pt-2 border-t border-gray-800 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {skill.stars > 0 && <span className="text-[10px] text-amber-400">★ {skill.stars.toLocaleString()}</span>}
                          {skill.downloads > 0 && <span className="text-[10px] text-gray-500">{skill.downloads >= 10000 ? `${(skill.downloads / 10000).toFixed(1)}万` : skill.downloads.toLocaleString()} 下载</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <a href={skill.homepage} target="_blank" rel="noopener noreferrer" className="text-[10px] text-indigo-400 hover:text-indigo-300">View →</a>
                          {isInstalled ? (
                            <span className="px-2.5 py-1 text-[10px] bg-gray-700 text-gray-400 rounded-lg">Installed</span>
                          ) : (
                            <button
                              onClick={() => void installSkillhub(skill)}
                              disabled={installing.has(skill.name)}
                              className="px-2.5 py-1 text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-50"
                            >
                              {installing.has(skill.name) ? '...' : 'Install'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {skillhubTotal > 24 && (
                <div className="flex items-center justify-center gap-2 mt-6">
                  <button
                    disabled={skillhubPage <= 1}
                    onClick={() => { const p = skillhubPage - 1; setSkillhubPage(p); void loadSkillhub({ q: skillhubSearch || undefined, category: skillhubCategory || undefined, page: p }); }}
                    className="px-3 py-1.5 text-xs bg-gray-800 text-gray-400 rounded-lg hover:bg-gray-700 disabled:opacity-30">
                    ← 上一页
                  </button>
                  <span className="text-xs text-gray-500">第 {skillhubPage} / {Math.ceil(skillhubTotal / 24)} 页</span>
                  <button
                    disabled={skillhubPage >= Math.ceil(skillhubTotal / 24)}
                    onClick={() => { const p = skillhubPage + 1; setSkillhubPage(p); void loadSkillhub({ q: skillhubSearch || undefined, category: skillhubCategory || undefined, page: p }); }}
                    className="px-3 py-1.5 text-xs bg-gray-800 text-gray-400 rounded-lg hover:bg-gray-700 disabled:opacity-30">
                    下一页 →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── skills.sh Tab ─────────────────────────────────────────────────────── */}
      {tab === 'skillssh' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex items-center gap-2 mb-5">
            <input
              value={skillsshSearch}
              onChange={e => setSkillsshSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && skillsshSearch.trim()) void loadSkillssh(skillsshSearch); }}
              placeholder="Search skills.sh..."
              className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-indigo-500 outline-none w-72"
            />
            <button
              onClick={() => { if (skillsshSearch.trim()) void loadSkillssh(skillsshSearch); }}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg"
            >
              Search
            </button>
            <span className="text-xs text-gray-500 ml-auto">
              <a href="https://skills.sh" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300">Visit site →</a>
            </span>
          </div>

          {loadingSkillssh ? (
            <div className="text-center text-gray-500 py-20"><div className="animate-pulse">Searching skills.sh...</div></div>
          ) : filteredSkillssh.length === 0 ? (
            <div className="text-center text-gray-500 py-20">
              <div className="text-4xl mb-3 opacity-30">⬡</div>
              <div>Browse 84,000+ skills on skills.sh</div>
              <div className="text-xs mt-1">Top skills are loaded automatically. Search for specific skills above.</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredSkillssh.map(skill => {
                const isInstalled = installed.some(s => s.name === skill.name);
                return (
                  <div key={`${skill.author}-${skill.name}`} className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm truncate">{skill.name}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{skill.author} / {skill.repo}</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-500/15 text-gray-400 shrink-0 ml-2">skills.sh</span>
                    </div>
                    <p className="text-sm text-gray-400 mt-2 line-clamp-2">{skill.description || 'No description'}</p>
                    <div className="mt-2 pt-2 border-t border-gray-800 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {skill.installs && <span className="text-[10px] text-gray-500">{skill.installs} installs</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <a href={skill.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-indigo-400 hover:text-indigo-300">View →</a>
                        {isInstalled ? (
                          <span className="px-2.5 py-1 text-[10px] bg-gray-700 text-gray-400 rounded-lg">Installed</span>
                        ) : (
                          <button
                            onClick={() => void installSkillssh(skill)}
                            disabled={installing.has(skill.name)}
                            className="px-2.5 py-1 text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-50"
                          >
                            {installing.has(skill.name) ? '...' : 'Install'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Markus Hub Tab ────────────────────────────────────────────────────── */}
      {tab === 'markus-hub' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex items-center gap-2 mb-5">
            <input
              value={hubSearch}
              onChange={e => setHubSearch(e.target.value)}
              placeholder="Search Markus Hub skills..."
              className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-indigo-500 outline-none w-72"
            />
            <span className="text-xs text-gray-500 ml-auto">Community skills from Markus Hub</span>
          </div>

          {loadingHub ? (
            <div className="text-center text-gray-500 py-20"><div className="animate-pulse">Loading from Hub...</div></div>
          ) : hubSkills.length === 0 ? (
            <div className="text-center text-gray-500 py-20">
              <div className="text-4xl mb-3">🏪</div>
              <div>No skills found on Markus Hub</div>
              <div className="text-xs mt-1">Hub may be offline or empty. Run the hub server at port 3003.</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {hubSkills.map(item => (
                <div key={item.id} className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm truncate">{item.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">by {item.author?.displayName ?? item.author?.username}</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-teal-500/15 text-teal-400 shrink-0 ml-2">Hub</span>
                  </div>
                  <p className="text-sm text-gray-400 mt-2 line-clamp-2">{item.description}</p>
                  <div className="mt-2 text-xs text-amber-400">
                    {'★'.repeat(Math.round(parseFloat(item.avgRating)))}{'☆'.repeat(5 - Math.round(parseFloat(item.avgRating)))}
                    <span className="text-gray-500 ml-1">({item.ratingCount}) · ↓ {item.downloadCount}</span>
                  </div>
                  <div className="mt-2 pt-2 border-t border-gray-800 flex justify-end">
                    <button
                      onClick={async () => {
                        try {
                          const data = await hubApi.download(item.id);
                          const blob = new Blob([JSON.stringify(data.config, null, 2)], { type: 'application/json' });
                          const a = document.createElement('a');
                          a.href = URL.createObjectURL(blob);
                          a.download = `${item.name}.json`;
                          a.click();
                          msg(`Downloaded ${item.name}`, 'success');
                        } catch { msg('Download failed', 'error'); }
                      }}
                      className="px-2.5 py-1 text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg"
                    >
                      Download
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Agent Assignment Modal ────────────────────────────────────────────── */}
      {assignModal && (
        <AgentAssignModal
          skillName={assignModal.skillName}
          agents={agents}
          currentAgentIds={assignModal.currentAgentIds}
          onClose={() => setAssignModal(null)}
          onConfirm={agentIds => void handleAssignConfirm(assignModal.skillName, agentIds)}
        />
      )}
    </div>
  );
}
