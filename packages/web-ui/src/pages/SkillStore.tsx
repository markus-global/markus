import { useEffect, useState, useCallback } from 'react';
import { api, hubApi, type HubItem } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { consume, PREFETCH_KEYS } from '../prefetchCache.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';

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
  development: 'bg-blue-500/15 text-blue-600',
  devops: 'bg-amber-500/15 text-amber-600',
  productivity: 'bg-green-500/15 text-green-600',
  custom: 'bg-gray-500/15 text-fg-secondary',
  browser: 'bg-brand-500/15 text-brand-500',
  communication: 'bg-green-500/15 text-green-600',
  data: 'bg-brand-500/15 text-brand-500',
  'AI 智能': 'bg-brand-500/15 text-brand-500',
  '开发工具': 'bg-blue-500/15 text-blue-600',
  '效率提升': 'bg-green-500/15 text-green-600',
  '数据分析': 'bg-brand-500/15 text-brand-500',
  '内容创作': 'bg-brand-500/15 text-brand-500',
  '安全合规': 'bg-red-500/15 text-red-500',
  '通讯协作': 'bg-green-500/15 text-green-600',
};

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'installed', label: 'Installed' },
  { id: 'builtin', label: 'Built-in' },
  { id: 'skillhub', label: 'SkillHub' },
  { id: 'skillssh', label: 'skills.sh' },
  { id: 'markus-hub', label: 'Markus Hub' },
];

// ─── Hub Skill Install Button ────────────────────────────────────────────────

function HubSkillInstallButton({ item, installedSkills, onMsg, onRefresh }: {
  item: HubItem;
  installedSkills: InstalledSkill[];
  onMsg: (text: string, type: 'success' | 'error') => void;
  onRefresh: () => void;
}) {
  const [installing, setInstalling] = useState(false);

  const slug = item.name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[\/\\:*?"<>|]+/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'unnamed';
  const matchedSkill = installedSkills.find(s => s.name === item.name || s.name === slug);
  const isInstalled = !!matchedSkill;
  const canUpgrade = isInstalled && item.version && matchedSkill?.version && isNewerVersion(item.version, matchedSkill.version);

  const handleInstall = async () => {
    if (installing) return;
    setInstalling(true);
    try {
      const data = await hubApi.download(item.id);
      const name = data.name || item.name;
      const s = name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[\/\\:*?"<>|]+/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'unnamed';
      const hubSource = { type: 'hub', hubItemId: item.id };
      if (data.files && Object.keys(data.files).length > 0) {
        await api.builder.artifacts.import('skill', s, data.files, hubSource);
      } else {
        const artifact = { ...(data.config as Record<string, unknown>), name, description: item.description, source: hubSource };
        await api.builder.artifacts.save('skill', artifact);
      }
      await api.builder.artifacts.install('skill', s);
      onMsg(canUpgrade ? `Upgraded ${item.name}` : `Installed ${item.name}`, 'success');
      onRefresh();
      window.dispatchEvent(new CustomEvent('markus:data-changed'));
    } catch {
      onMsg('Install failed', 'error');
    } finally {
      setInstalling(false);
    }
  };

  if (canUpgrade) {
    return (
      <button
        onClick={() => void handleInstall()}
        disabled={installing}
        className="px-2.5 py-1 text-[10px] bg-amber-600 hover:bg-amber-500 text-white rounded-lg disabled:opacity-50"
      >
        {installing ? 'Upgrading...' : `Upgrade → v${item.version}`}
      </button>
    );
  }

  if (isInstalled) {
    return (
      <span className="px-2.5 py-1 text-[10px] bg-surface-overlay text-fg-secondary rounded-lg">
        Installed{matchedSkill?.version ? ` (v${matchedSkill.version})` : ''}
      </span>
    );
  }

  return (
    <button
      onClick={() => void handleInstall()}
      disabled={installing}
      className="px-2.5 py-1 text-[10px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg disabled:opacity-50"
    >
      {installing ? 'Installing...' : 'Install'}
    </button>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────────

export function SkillStore() {
  const isMobile = useIsMobile();
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
      const p = !q
        ? (consume<{ items: HubItem[] }>(PREFETCH_KEYS.hubSkills) ?? hubApi.search({ type: 'skill', limit: 50 }))
        : hubApi.search({ type: 'skill', q, limit: 50 });
      const d = await p;
      setHubSkills(d?.items ?? []);
    } catch { /* Hub might be offline */ }
    setLoadingHub(false);
  }, []);

  useEffect(() => { loadInstalled(); loadBuiltin(); loadSkillhub(); loadSkillssh(); }, []);
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
      window.dispatchEvent(new CustomEvent('markus:data-changed'));
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
      window.dispatchEvent(new CustomEvent('markus:data-changed'));
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
      window.dispatchEvent(new CustomEvent('markus:data-changed'));
    } catch (err) {
      msg(`Install failed for "${skill.name}": ${err}`, 'error');
    }
    setInstalling(prev => { const next = new Set(prev); next.delete(skill.name); return next; });
  };

  const uninstallSkill = async (name: string) => {
    if (!confirm(`Uninstall "${name}"? This will delete the skill files from ~/.markus/skills/.`)) return;
    try {
      await api.skills.uninstall(name);
      await loadInstalled();
      msg(`"${name}" uninstalled`);
      window.dispatchEvent(new CustomEvent('markus:data-changed'));
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
      <div className={`${isMobile ? 'px-4' : 'px-6'} border-b border-border-default bg-surface-secondary shrink-0`}>
        <div className="flex items-center h-14">
          <h2 className="text-lg font-semibold">Skill Store</h2>
        </div>
        <div className={`flex ${isMobile ? 'flex-wrap' : ''} gap-1 pb-2 overflow-x-auto scrollbar-hide`}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors shrink-0 ${
                tab === t.id ? 'bg-brand-600 text-white' : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-elevated'
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {flash && (
        <div className={`mx-7 mt-2 px-3 py-1.5 text-xs rounded-lg shrink-0 ${
          flash.type === 'error' ? 'bg-red-500/10 text-red-500' : 'bg-green-500/10 text-green-600'
        }`}>{flash.text}</div>
      )}

      {/* ── Installed Tab ─────────────────────────────────────────────────────── */}
      {tab === 'installed' && (
        <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-6'}`}>
          <div className="flex items-center gap-3 mb-5">
            <input
              value={installedSearch}
              onChange={e => setInstalledSearch(e.target.value)}
              placeholder="Search installed skills..."
              className={`px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none ${isMobile ? 'flex-1 min-w-0' : 'w-72'}`}
            />
            <span className="text-xs text-fg-tertiary shrink-0">{filteredInstalled.length} skill{filteredInstalled.length !== 1 ? 's' : ''}</span>
          </div>

          {loadingInstalled ? (
            <div className="text-center text-fg-tertiary py-20">Loading...</div>
          ) : filteredInstalled.length === 0 ? (
            <div className="text-center text-fg-tertiary py-20">
              <div className="text-4xl mb-3 opacity-30">◆</div>
              <div>No installed skills found.</div>
              <div className="text-xs mt-1">Browse SkillHub or skills.sh to discover and install skills.</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredInstalled.map(skill => {
                return (
                  <div key={skill.name} className="bg-surface-secondary border border-border-default rounded-xl p-5 hover:border-gray-600 transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-semibold text-sm truncate">{skill.name}</div>
                          <span className={`px-1.5 py-0.5 rounded text-[9px] shrink-0 ${
                            skill.type === 'builtin' ? 'bg-blue-500/15 text-blue-600' :
                            skill.type === 'filesystem' ? 'bg-green-500/15 text-green-600' :
                            'bg-amber-500/15 text-amber-600'
                          }`}>{skill.type === 'builtin' ? 'built-in' : skill.type === 'filesystem' ? 'local' : 'imported'}</span>
                        </div>
                        <div className="text-xs text-fg-tertiary mt-0.5">
                          {skill.author ? `by ${skill.author} · ` : ''}{skill.version ? `v${skill.version}` : ''}
                          {skill.sourcePath && <span className="ml-1 text-fg-tertiary" title={skill.sourcePath}>📁 {skill.sourcePath.replace(/^.*\/\.([^/]+)\/skills\//, '~/.$1/skills/')}</span>}
                        </div>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${CATEGORY_COLORS[skill.category ?? ''] ?? 'bg-gray-500/15 text-fg-secondary'} capitalize shrink-0 ml-2`}>
                        {skill.category ?? 'custom'}
                      </span>
                    </div>

                    <p className="text-sm text-fg-secondary mt-2 line-clamp-2">{skill.description ?? 'No description'}</p>

                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {skill.tags?.slice(0, 3).map(t => <span key={t} className="px-2 py-0.5 text-[10px] bg-surface-elevated text-fg-tertiary rounded-full">{t}</span>)}
                    </div>

                    <div className="mt-3 pt-2 border-t border-border-default flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {skill.tools && skill.tools.length > 0 && (
                          <span className="text-[10px] text-fg-tertiary">{skill.tools.length} tool{skill.tools.length !== 1 ? 's' : ''}</span>
                        )}
                        <span className="text-[10px] text-fg-tertiary">Auto-discovered by agents</span>
                      </div>
                      {skill.type !== 'builtin' && (
                        <button
                          onClick={() => void uninstallSkill(skill.name)}
                          className="px-2 py-0.5 text-[10px] text-red-500 hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                        >
                          Uninstall
                        </button>
                      )}
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
        <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-6'}`}>
          <div className="flex items-center gap-3 mb-5">
            <span className="text-xs text-fg-tertiary">{builtinSkills.length} built-in skill{builtinSkills.length !== 1 ? 's' : ''} available</span>
            <button
              onClick={() => void loadBuiltin()}
              className="text-xs text-brand-500 hover:text-brand-500 transition-colors"
            >
              Refresh
            </button>
          </div>

          {loadingBuiltin ? (
            <div className="text-center text-fg-tertiary py-20"><div className="animate-pulse">Loading built-in skills...</div></div>
          ) : builtinSkills.length === 0 ? (
            <div className="text-center text-fg-tertiary py-20">
              <div className="text-4xl mb-3 opacity-30">◇</div>
              <div>No built-in skills found.</div>
              <div className="text-xs mt-1">Built-in skills are provided in templates/skills/.</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {builtinSkills.map(skill => (
                <div key={skill.name} className="bg-surface-secondary border border-border-default rounded-xl p-5 hover:border-gray-600 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="font-semibold text-sm truncate">{skill.name}</div>
                        {skill.hasMcpServers && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] bg-blue-500/15 text-blue-600 shrink-0">MCP</span>
                        )}
                      </div>
                      <div className="text-xs text-fg-tertiary mt-0.5">
                        {skill.author ? `by ${skill.author} · ` : ''}v{skill.version}
                      </div>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${CATEGORY_COLORS[skill.category ?? ''] ?? 'bg-gray-500/15 text-fg-secondary'} capitalize shrink-0 ml-2`}>
                      {skill.category ?? 'custom'}
                    </span>
                  </div>

                  <p className="text-sm text-fg-secondary mt-2 line-clamp-2">{skill.description ?? 'No description'}</p>

                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {skill.tags.slice(0, 4).map(t => <span key={t} className="px-2 py-0.5 text-[10px] bg-surface-elevated text-fg-tertiary rounded-full">{t}</span>)}
                  </div>

                  {skill.requiredPermissions.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {skill.requiredPermissions.map(p => (
                        <span key={p} className="px-1.5 py-0.5 text-[9px] bg-amber-500/10 text-amber-500 rounded">{p}</span>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 pt-2 border-t border-border-default flex items-center justify-between">
                    {skill.installed && skill.installedVersion ? (
                      <span className="text-[10px] text-fg-tertiary">v{skill.installedVersion}</span>
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
                      <span className="px-2.5 py-1 text-[10px] bg-surface-overlay text-fg-secondary rounded-lg">Installed</span>
                    ) : (
                      <button
                        onClick={() => void installBuiltin(skill)}
                        disabled={installing.has(skill.name)}
                        className="px-2.5 py-1 text-[10px] bg-green-600 hover:bg-green-500 text-white rounded-lg disabled:opacity-50 transition-colors"
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
        <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-6'}`}>
          {/* Controls */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <select
              value={skillhubCategory}
              onChange={e => { setSkillhubCategory(e.target.value); setSkillhubPage(1); void loadSkillhub({ q: skillhubSearch || undefined, category: e.target.value || undefined, page: 1 }); }}
              className="px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-fg-secondary outline-none"
            >
              <option value="">全部分类</option>
              {skillhubCategories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              value={skillhubSort}
              onChange={e => { setSkillhubSort(e.target.value); setSkillhubPage(1); void loadSkillhub({ q: skillhubSearch || undefined, category: skillhubCategory || undefined, page: 1, sort: e.target.value }); }}
              className="px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-fg-secondary outline-none"
            >
              <option value="score">综合排序</option>
              <option value="downloads">下载量</option>
              <option value="stars">收藏数</option>
              <option value="installs">安装量</option>
            </select>
            {!isMobile && <span className="text-xs text-fg-tertiary ml-auto">
              <a href="https://skillhub.tencent.com" target="_blank" rel="noopener noreferrer" className="text-brand-500 hover:text-brand-500">Visit site →</a>
            </span>}
          </div>
          <div className="flex items-center gap-2 mb-5">
            <input
              value={skillhubSearch}
              onChange={e => setSkillhubSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { setSkillhubPage(1); void loadSkillhub({ q: skillhubSearch || undefined, category: skillhubCategory || undefined, page: 1 }); } }}
              placeholder="搜索 SkillHub 技能..."
              className="px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none flex-1 min-w-0"
            />
            <button
              onClick={() => { setSkillhubPage(1); void loadSkillhub({ q: skillhubSearch || undefined, category: skillhubCategory || undefined, page: 1 }); }}
              className="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-xs rounded-lg shrink-0"
            >
              Search
            </button>
          </div>

          {loadingSkillhub ? (
            <div className="text-center text-fg-tertiary py-20"><div className="animate-pulse">正在加载 SkillHub 技能...</div></div>
          ) : skillhubSkills.length === 0 ? (
            <div className="text-center text-fg-tertiary py-20">
              <div className="text-4xl mb-3 opacity-30">◎</div>
              <div>未找到匹配的技能</div>
            </div>
          ) : (
            <>
              <div className="text-xs text-fg-tertiary mb-3">共 {skillhubTotal.toLocaleString()} 个技能</div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {skillhubSkills.map(skill => {
                  const isInstalled = installed.some(s => s.name === skill.name || s.name === skill.slug);
                  return (
                    <div key={skill.slug} className="bg-surface-secondary border border-border-default rounded-xl p-5 hover:border-gray-600 transition-colors">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm truncate">{skill.name}</div>
                          <div className="text-xs text-fg-tertiary mt-0.5">v{skill.version}</div>
                        </div>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ml-2 ${skill.tags?.[0] ? (CATEGORY_COLORS[skill.tags[0]] ?? 'bg-brand-500/15 text-brand-500') : 'bg-brand-500/15 text-brand-500'}`}>
                          {skill.tags?.[0] ?? 'SkillHub'}
                        </span>
                      </div>
                      <p className="text-sm text-fg-secondary mt-2 line-clamp-2">{skill.description_zh ?? skill.description ?? 'No description'}</p>
                      <div className="mt-2 pt-2 border-t border-border-default flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {skill.stars > 0 && <span className="text-[10px] text-amber-600">★ {skill.stars.toLocaleString()}</span>}
                          {skill.downloads > 0 && <span className="text-[10px] text-fg-tertiary">{skill.downloads >= 10000 ? `${(skill.downloads / 10000).toFixed(1)}万` : skill.downloads.toLocaleString()} 下载</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <a href={skill.homepage} target="_blank" rel="noopener noreferrer" className="text-[10px] text-brand-500 hover:text-brand-500">View →</a>
                          {isInstalled ? (
                            <span className="px-2.5 py-1 text-[10px] bg-surface-overlay text-fg-secondary rounded-lg">Installed</span>
                          ) : (
                            <button
                              onClick={() => void installSkillhub(skill)}
                              disabled={installing.has(skill.name)}
                              className="px-2.5 py-1 text-[10px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg disabled:opacity-50"
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
                    className="px-3 py-1.5 text-xs bg-surface-elevated text-fg-secondary rounded-lg hover:bg-surface-overlay disabled:opacity-30">
                    ← 上一页
                  </button>
                  <span className="text-xs text-fg-tertiary">第 {skillhubPage} / {Math.ceil(skillhubTotal / 24)} 页</span>
                  <button
                    disabled={skillhubPage >= Math.ceil(skillhubTotal / 24)}
                    onClick={() => { const p = skillhubPage + 1; setSkillhubPage(p); void loadSkillhub({ q: skillhubSearch || undefined, category: skillhubCategory || undefined, page: p }); }}
                    className="px-3 py-1.5 text-xs bg-surface-elevated text-fg-secondary rounded-lg hover:bg-surface-overlay disabled:opacity-30">
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
        <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-6'}`}>
          <div className={`flex ${isMobile ? 'flex-wrap' : ''} items-center gap-2 mb-5`}>
            <input
              value={skillsshSearch}
              onChange={e => setSkillsshSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && skillsshSearch.trim()) void loadSkillssh(skillsshSearch); }}
              placeholder="Search skills.sh..."
              className={`px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none ${isMobile ? 'flex-1 min-w-0' : 'w-72'}`}
            />
            <button
              onClick={() => { if (skillsshSearch.trim()) void loadSkillssh(skillsshSearch); }}
              className="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-xs rounded-lg shrink-0"
            >
              Search
            </button>
            {!isMobile && <span className="text-xs text-fg-tertiary ml-auto">
              <a href="https://skills.sh" target="_blank" rel="noopener noreferrer" className="text-brand-500 hover:text-brand-500">Visit site →</a>
            </span>}
          </div>

          {loadingSkillssh ? (
            <div className="text-center text-fg-tertiary py-20"><div className="animate-pulse">Searching skills.sh...</div></div>
          ) : filteredSkillssh.length === 0 ? (
            <div className="text-center text-fg-tertiary py-20">
              <div className="text-4xl mb-3 opacity-30">⬡</div>
              <div>Browse 84,000+ skills on skills.sh</div>
              <div className="text-xs mt-1">Top skills are loaded automatically. Search for specific skills above.</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredSkillssh.map(skill => {
                const isInstalled = installed.some(s => s.name === skill.name);
                return (
                  <div key={`${skill.author}-${skill.name}`} className="bg-surface-secondary border border-border-default rounded-xl p-5 hover:border-gray-600 transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm truncate">{skill.name}</div>
                        <div className="text-xs text-fg-tertiary mt-0.5">{skill.author} / {skill.repo}</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-500/15 text-fg-secondary shrink-0 ml-2">skills.sh</span>
                    </div>
                    <p className="text-sm text-fg-secondary mt-2 line-clamp-2">{skill.description || 'No description'}</p>
                    <div className="mt-2 pt-2 border-t border-border-default flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {skill.installs && <span className="text-[10px] text-fg-tertiary">{skill.installs} installs</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <a href={skill.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-brand-500 hover:text-brand-500">View →</a>
                        {isInstalled ? (
                          <span className="px-2.5 py-1 text-[10px] bg-surface-overlay text-fg-secondary rounded-lg">Installed</span>
                        ) : (
                          <button
                            onClick={() => void installSkillssh(skill)}
                            disabled={installing.has(skill.name)}
                            className="px-2.5 py-1 text-[10px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg disabled:opacity-50"
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
        <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-6'}`}>
          <div className="flex items-center gap-2 mb-5">
            <input
              value={hubSearch}
              onChange={e => setHubSearch(e.target.value)}
              placeholder="Search Markus Hub skills..."
              className={`px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none ${isMobile ? 'flex-1 min-w-0' : 'w-72'}`}
            />
            {!isMobile && <span className="text-xs text-fg-tertiary ml-auto">Community skills from Markus Hub</span>}
          </div>

          {loadingHub ? (
            <div className="text-center text-fg-tertiary py-20"><div className="animate-pulse">Loading from Hub...</div></div>
          ) : hubSkills.length === 0 ? (
            <div className="text-center text-fg-tertiary py-20">
              <div className="text-4xl mb-3">🏪</div>
              <div>No skills found on Markus Hub</div>
              <div className="text-xs mt-1">Hub may be offline or empty. Run the hub server at port 8059.</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {hubSkills.map(item => (
                <div key={item.id} className="bg-surface-secondary border border-border-default rounded-xl p-5 hover:border-gray-600 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm truncate">{item.name}</div>
                      <div className="text-xs text-fg-tertiary mt-0.5">by {item.author?.displayName ?? item.author?.username}</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-500/15 text-green-600 shrink-0 ml-2">Hub</span>
                  </div>
                  <p className="text-sm text-fg-secondary mt-2 line-clamp-2">{item.description}</p>
                  <div className="mt-2 text-xs text-amber-600">
                    {'★'.repeat(Math.round(parseFloat(item.avgRating)))}{'☆'.repeat(5 - Math.round(parseFloat(item.avgRating)))}
                    <span className="text-fg-tertiary ml-1">({item.ratingCount}) · ↓ {item.downloadCount}</span>
                  </div>
                  <div className="mt-2 pt-2 border-t border-border-default flex items-center justify-end gap-2">
                    <HubSkillInstallButton item={item} installedSkills={installed} onMsg={msg} onRefresh={() => void loadInstalled()} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
