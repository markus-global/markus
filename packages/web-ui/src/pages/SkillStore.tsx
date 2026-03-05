import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.ts';
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
}

interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  source: string;
  status: string;
  version: string;
  authorName: string;
  category: string;
  tags: string[];
  tools: Array<{ name: string; description: string }>;
  readme: string | null;
  downloadCount: number;
  avgRating: number;
  ratingCount: number;
}

interface RegistrySkill {
  name: string;
  description: string;
  category: string;
  source: string;
  sourceUrl: string;
  author: string;
  addedAt?: string;
}

interface ExternalSkill {
  name: string;
  author: string;
  repo: string;
  description?: string;
  stars?: number;
  installs?: string;
  url: string;
  source: 'skillsmp' | 'skillssh';
}

type TabId = 'installed' | 'marketplace' | 'discover';
type DiscoverSource = 'openclaw' | 'skillsmp' | 'skillssh';

// ─── Constants ──────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  development: 'bg-blue-500/15 text-blue-400',
  devops: 'bg-orange-500/15 text-orange-400',
  productivity: 'bg-green-500/15 text-green-400',
  'AI Tools': 'bg-purple-500/15 text-purple-400',
  Frontend: 'bg-cyan-500/15 text-cyan-400',
  Backend: 'bg-amber-500/15 text-amber-400',
  Mobile: 'bg-pink-500/15 text-pink-400',
  Marketing: 'bg-rose-500/15 text-rose-400',
  Database: 'bg-teal-500/15 text-teal-400',
  Auth: 'bg-red-500/15 text-red-400',
  DevOps: 'bg-orange-500/15 text-orange-400',
  'Web Automation': 'bg-indigo-500/15 text-indigo-400',
  Other: 'bg-gray-500/15 text-gray-400',
  browser: 'bg-indigo-500/15 text-indigo-400',
  communication: 'bg-emerald-500/15 text-emerald-400',
  data: 'bg-violet-500/15 text-violet-400',
  custom: 'bg-gray-500/15 text-gray-400',
};

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'installed', label: 'Installed', icon: '◆' },
  { id: 'marketplace', label: 'Marketplace', icon: '◎' },
  { id: 'discover', label: 'Discover', icon: '⊕' },
];

const DISCOVER_SOURCES: Array<{ id: DiscoverSource; label: string; desc: string; url: string }> = [
  { id: 'openclaw', label: 'OpenClaw', desc: '127+ curated community skills', url: 'https://github.com/LeoYeAI/openclaw-master-skills' },
  { id: 'skillsmp', label: 'SkillsMP', desc: '364K+ open-source skills', url: 'https://skillsmp.com' },
  { id: 'skillssh', label: 'skills.sh', desc: '84K+ agent skills directory', url: 'https://skills.sh' },
];

// ─── Rating Stars ───────────────────────────────────────────────────────────────

function Stars({ rating, count }: { rating: number; count: number }) {
  if (!count) return <span className="text-[10px] text-gray-600">No ratings</span>;
  const full = Math.floor(rating / 20);
  return (
    <span className="flex items-center gap-1">
      <span className="text-amber-400 text-xs tracking-tight">
        {'★'.repeat(full)}{'☆'.repeat(5 - full)}
      </span>
      <span className="text-[10px] text-gray-500">({count})</span>
    </span>
  );
}

// ─── Skill Detail Modal ─────────────────────────────────────────────────────────

function SkillDetailModal({ skill, onClose, onInstall }: {
  skill: InstalledSkill | MarketplaceSkill | RegistrySkill | ExternalSkill;
  onClose: () => void;
  onInstall?: () => void;
}) {
  const isMarketplace = 'id' in skill && 'downloadCount' in skill;
  const isRegistry = 'sourceUrl' in skill && !('repo' in skill);
  const isExternal = 'repo' in skill && 'source' in skill;
  const name = skill.name;
  const description = ('description' in skill ? skill.description : undefined) ?? '';
  const category = ('category' in skill ? skill.category : undefined) ?? 'custom';
  const author = isMarketplace ? (skill as MarketplaceSkill).authorName : ('author' in skill ? (skill as InstalledSkill | RegistrySkill | ExternalSkill).author : undefined);
  const readme = isMarketplace ? (skill as MarketplaceSkill).readme : null;
  const tools = 'tools' in skill ? (skill as InstalledSkill | MarketplaceSkill).tools : undefined;
  const tags = 'tags' in skill ? (skill as InstalledSkill | MarketplaceSkill).tags : undefined;
  const permissions = 'requiredPermissions' in skill ? (skill as InstalledSkill).requiredPermissions : undefined;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-[640px] max-h-[80vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 pt-5 pb-4 border-b border-gray-800 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">{name}</h3>
            <div className="flex items-center gap-2 mt-1.5">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${CATEGORY_COLORS[category] ?? 'bg-gray-500/15 text-gray-400'} capitalize`}>{category}</span>
              {author && <span className="text-xs text-gray-500">by {author}</span>}
              {'version' in skill && <span className="text-xs text-gray-600">v{(skill as InstalledSkill | MarketplaceSkill).version}</span>}
              {isExternal && <span className="text-xs text-gray-600">from {(skill as ExternalSkill).source}</span>}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <p className="text-sm text-gray-300">{description || 'No description available'}</p>

          {readme && (
            <div className="bg-gray-800/50 rounded-lg p-4">
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">README</h4>
              <MarkdownMessage content={readme} className="text-sm text-gray-300" />
            </div>
          )}

          {tags && tags.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Tags</h4>
              <div className="flex flex-wrap gap-1.5">
                {tags.map(t => <span key={t} className="px-2 py-0.5 text-[10px] bg-gray-800 text-gray-400 rounded-full">{t}</span>)}
              </div>
            </div>
          )}

          {tools && tools.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Tools ({tools.length})</h4>
              <div className="grid grid-cols-1 gap-1.5">
                {tools.map((tool, i) => (
                  <div key={i} className="bg-gray-800 rounded-lg px-3 py-2">
                    <div className="text-sm font-medium text-indigo-400">{typeof tool === 'string' ? tool : tool.name}</div>
                    {typeof tool !== 'string' && tool.description && <div className="text-xs text-gray-500 mt-0.5">{tool.description}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {permissions && permissions.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Required Permissions</h4>
              <div className="flex flex-wrap gap-1.5">
                {permissions.map(p => <span key={p} className="px-2 py-0.5 text-[10px] bg-amber-500/10 text-amber-400 rounded-full">{p}</span>)}
              </div>
            </div>
          )}

          {isMarketplace && (
            <div className="flex items-center gap-4 text-sm">
              <Stars rating={(skill as MarketplaceSkill).avgRating} count={(skill as MarketplaceSkill).ratingCount} />
              <span className="text-xs text-gray-500">{(skill as MarketplaceSkill).downloadCount} downloads</span>
            </div>
          )}

          {(isRegistry || isExternal) && (
            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Source</h4>
              <a href={isRegistry ? (skill as RegistrySkill).sourceUrl : (skill as ExternalSkill).url} target="_blank" rel="noopener noreferrer" className="text-sm text-indigo-400 hover:text-indigo-300 underline">
                {isRegistry ? (skill as RegistrySkill).sourceUrl : (skill as ExternalSkill).url}
              </a>
            </div>
          )}
        </div>

        {onInstall && (
          <div className="px-6 py-4 border-t border-gray-800 flex justify-end">
            <button onClick={onInstall} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg">
              Install Skill
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────────

export function SkillStore() {
  const [tab, setTab] = useState<TabId>('installed');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [discoverSource, setDiscoverSource] = useState<DiscoverSource>('openclaw');

  // Data
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [marketplace, setMarketplace] = useState<MarketplaceSkill[]>([]);
  const [registry, setRegistry] = useState<RegistrySkill[]>([]);
  const [externalSkills, setExternalSkills] = useState<ExternalSkill[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [loadingMarketplace, setLoadingMarketplace] = useState(false);
  const [loadingRegistry, setLoadingRegistry] = useState(false);
  const [loadingExternal, setLoadingExternal] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<InstalledSkill | MarketplaceSkill | RegistrySkill | ExternalSkill | null>(null);
  const [flash, setFlash] = useState('');
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  // For skillsmp search
  const [externalSearch, setExternalSearch] = useState('');

  const msg = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 4000); };

  const loadInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try { const d = await api.skills.list(); setInstalled(d.skills); } catch { /* */ }
    setLoadingInstalled(false);
  }, []);

  const loadMarketplace = useCallback(async () => {
    setLoadingMarketplace(true);
    try { const d = await api.marketplace.skills({ q: search || undefined, category: categoryFilter || undefined }); setMarketplace(d.skills); } catch { /* */ }
    setLoadingMarketplace(false);
  }, [search, categoryFilter]);

  const loadRegistry = useCallback(async () => {
    setLoadingRegistry(true);
    try { const d = await api.skills.registry('openclaw'); setRegistry(d.skills); } catch { /* */ }
    setLoadingRegistry(false);
  }, []);

  const loadSkillsmp = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setLoadingExternal(true);
    try {
      const d = await api.skills.registrySkillsmp(q);
      if (d.success && d.data) {
        setExternalSkills(d.data.results.map(s => ({
          name: s.name,
          author: s.owner,
          repo: s.repo,
          description: s.description,
          stars: s.stars,
          url: s.url,
          source: 'skillsmp' as const,
        })));
      }
    } catch { /* */ }
    setLoadingExternal(false);
  }, []);

  const loadSkillssh = useCallback(async (q?: string) => {
    setLoadingExternal(true);
    try {
      const d = await api.skills.registrySkillssh(q);
      setExternalSkills(d.skills.map(s => ({
        name: s.name,
        author: s.author,
        repo: s.repo,
        installs: s.installs,
        url: s.url,
        source: 'skillssh' as const,
      })));
    } catch { /* */ }
    setLoadingExternal(false);
  }, []);

  useEffect(() => { loadInstalled(); }, [loadInstalled]);
  useEffect(() => { if (tab === 'marketplace') loadMarketplace(); }, [tab, loadMarketplace]);
  useEffect(() => {
    if (tab === 'discover') {
      if (discoverSource === 'openclaw') loadRegistry();
      else if (discoverSource === 'skillssh') loadSkillssh();
      else setExternalSkills([]);
    }
  }, [tab, discoverSource, loadRegistry, loadSkillssh]);

  const installFromRegistry = async (skill: RegistrySkill) => {
    setInstalling(prev => new Set(prev).add(skill.name));
    try {
      await api.skills.import(skill.name, skill.sourceUrl, skill.description, skill.category);
      msg(`Installed "${skill.name}" successfully`);
    } catch (err) {
      msg(`Failed to install: ${err}`);
    }
    setInstalling(prev => { const next = new Set(prev); next.delete(skill.name); return next; });
  };

  const installFromMarketplace = async (skill: MarketplaceSkill) => {
    setInstalling(prev => new Set(prev).add(skill.id));
    try {
      await api.marketplace.installSkill(skill.id);
      msg(`Installed "${skill.name}" successfully`);
    } catch (err) {
      msg(`Failed to install: ${err}`);
    }
    setInstalling(prev => { const next = new Set(prev); next.delete(skill.id); return next; });
  };

  const installExternal = async (skill: ExternalSkill) => {
    setInstalling(prev => new Set(prev).add(skill.name));
    try {
      await api.skills.import(skill.name, skill.url, skill.description, 'custom');
      msg(`Installed "${skill.name}" successfully`);
    } catch (err) {
      msg(`Failed to install: ${err}`);
    }
    setInstalling(prev => { const next = new Set(prev); next.delete(skill.name); return next; });
  };

  // Categories for sidebar
  const getCategories = (): Array<{ name: string; count: number }> => {
    let items: Array<{ category?: string }> = [];
    if (tab === 'installed') items = installed;
    else if (tab === 'marketplace') items = marketplace;
    else if (tab === 'discover' && discoverSource === 'openclaw') items = registry;
    const counts = new Map<string, number>();
    for (const item of items) {
      const cat = item.category ?? 'Other';
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  };

  // Filter
  const filterBySearch = <T extends { name: string; description?: string }>(items: T[]): T[] => {
    if (!search) return items;
    const lower = search.toLowerCase();
    return items.filter(i => i.name.toLowerCase().includes(lower) || i.description?.toLowerCase().includes(lower));
  };

  const filterByCategory = <T extends { category?: string }>(items: T[]): T[] => {
    if (!categoryFilter) return items;
    return items.filter(i => (i.category ?? 'Other') === categoryFilter);
  };

  const filteredInstalled = filterByCategory(filterBySearch(installed));
  const filteredMarketplace = filterByCategory(filterBySearch(marketplace));
  const filteredRegistry = filterByCategory(filterBySearch(registry));
  const categories = getCategories();
  const showSidebar = tab !== 'discover' || discoverSource === 'openclaw';

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-7 h-14 border-b border-gray-800 bg-gray-900 shrink-0">
        <h2 className="text-lg font-semibold">Skill Store</h2>
        <div className="flex-1 max-w-md">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search skills..."
            className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-indigo-500 outline-none"
          />
        </div>
        <div className="flex gap-1">
          {TABS.map(t => (
            <button key={t.id} onClick={() => { setTab(t.id); setCategoryFilter(''); }}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1.5 ${
                tab === t.id ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}>
              <span>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {flash && <div className="mx-7 mt-2 px-3 py-1.5 bg-emerald-900/50 text-emerald-300 text-xs rounded-lg">{flash}</div>}

      {/* Content */}
      <div className="flex-1 overflow-hidden flex">
        {/* Category Sidebar — shown for installed, marketplace, and openclaw discover */}
        {showSidebar && (
          <div className="w-48 border-r border-gray-800 overflow-y-auto p-3 shrink-0 bg-gray-950">
            <div className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider px-2 mb-2">Categories</div>
            <button onClick={() => setCategoryFilter('')}
              className={`w-full text-left px-2 py-1.5 rounded-lg text-xs transition-colors mb-0.5 ${!categoryFilter ? 'bg-indigo-600/20 text-indigo-300' : 'text-gray-400 hover:bg-gray-800'}`}>
              All
            </button>
            {categories.map(c => (
              <button key={c.name} onClick={() => setCategoryFilter(f => f === c.name ? '' : c.name)}
                className={`w-full text-left px-2 py-1.5 rounded-lg text-xs transition-colors mb-0.5 flex justify-between ${
                  categoryFilter === c.name ? 'bg-indigo-600/20 text-indigo-300' : 'text-gray-400 hover:bg-gray-800'
                }`}>
                <span className="capitalize truncate">{c.name}</span>
                <span className="text-[10px] text-gray-600 ml-1">{c.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* Main grid */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Installed */}
          {tab === 'installed' && (
            loadingInstalled ? (
              <div className="text-center text-gray-500 py-20">Loading...</div>
            ) : filteredInstalled.length === 0 ? (
              <div className="text-center text-gray-500 py-20">
                <div className="text-4xl mb-3 opacity-30">◆</div>
                <div>No installed skills found.</div>
                <div className="text-xs mt-1">Check the Discover tab to find and import skills.</div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredInstalled.map(skill => (
                  <div key={skill.name} onClick={() => setSelectedSkill(skill)}
                    className="bg-gray-900 border border-gray-800 rounded-xl p-5 cursor-pointer hover:border-gray-700 transition-colors">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="font-semibold text-sm">{skill.name}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{skill.author ? `by ${skill.author}` : ''} {skill.version ? `v${skill.version}` : ''}</div>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${CATEGORY_COLORS[skill.category ?? ''] ?? 'bg-gray-500/15 text-gray-400'} capitalize`}>
                        {skill.category ?? 'custom'}
                      </span>
                    </div>
                    <p className="text-sm text-gray-400 mt-2 line-clamp-2">{skill.description ?? 'No description'}</p>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {skill.tags?.slice(0, 4).map(t => <span key={t} className="px-2 py-0.5 text-[10px] bg-gray-800 text-gray-500 rounded-full">{t}</span>)}
                    </div>
                    <div className="mt-2 pt-2 border-t border-gray-800 text-xs text-gray-500">
                      {skill.tools?.length ?? 0} tool{(skill.tools?.length ?? 0) !== 1 ? 's' : ''}
                      {skill.requiredPermissions?.length ? ` · ${skill.requiredPermissions.join(', ')}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {/* Marketplace */}
          {tab === 'marketplace' && (
            loadingMarketplace ? (
              <div className="text-center text-gray-500 py-20">Loading marketplace...</div>
            ) : filteredMarketplace.length === 0 ? (
              <div className="text-center text-gray-500 py-20">
                <div className="text-4xl mb-3 opacity-30">◎</div>
                <div>No marketplace skills found.</div>
                <div className="text-xs mt-1">Create skills using the Skill Architect in the Builder tab.</div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredMarketplace.map(skill => (
                  <div key={skill.id} onClick={() => setSelectedSkill(skill)}
                    className="bg-gray-900 border border-gray-800 rounded-xl p-5 cursor-pointer hover:border-gray-700 transition-colors">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="font-semibold text-sm">{skill.name}</div>
                        <div className="text-xs text-gray-500 mt-0.5">by {skill.authorName} · v{skill.version}</div>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${CATEGORY_COLORS[skill.category] ?? 'bg-gray-500/15 text-gray-400'} capitalize`}>
                        {skill.category}
                      </span>
                    </div>
                    <p className="text-sm text-gray-400 mt-2 line-clamp-2">{skill.description}</p>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {skill.tags?.slice(0, 4).map(t => <span key={t} className="px-2 py-0.5 text-[10px] bg-gray-800 text-gray-500 rounded-full">{t}</span>)}
                    </div>
                    <div className="mt-2 pt-2 border-t border-gray-800 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Stars rating={skill.avgRating} count={skill.ratingCount} />
                        <span className="text-[10px] text-gray-600">{skill.downloadCount} installs</span>
                      </div>
                      <button onClick={e => { e.stopPropagation(); void installFromMarketplace(skill); }}
                        disabled={installing.has(skill.id)}
                        className="px-2.5 py-1 text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-50">
                        {installing.has(skill.id) ? '...' : 'Install'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {/* Discover — multi-source browser */}
          {tab === 'discover' && (
            <div>
              {/* Source selector */}
              <div className="flex items-center gap-3 mb-5">
                {DISCOVER_SOURCES.map(src => (
                  <button key={src.id} onClick={() => { setDiscoverSource(src.id); setExternalSkills([]); setExternalSearch(''); }}
                    className={`flex-1 p-3 rounded-xl text-left transition-all border ${
                      discoverSource === src.id
                        ? 'bg-indigo-600/15 border-indigo-500/40 text-white'
                        : 'bg-gray-900 border-gray-800 text-gray-400 hover:border-gray-700 hover:text-gray-300'
                    }`}>
                    <div className="text-sm font-medium">{src.label}</div>
                    <div className="text-[10px] opacity-60 mt-0.5">{src.desc}</div>
                  </button>
                ))}
              </div>

              {/* Source header with link */}
              <div className="flex items-center gap-3 mb-4">
                <div className="text-sm font-semibold text-gray-200">
                  {DISCOVER_SOURCES.find(s => s.id === discoverSource)?.label}
                </div>
                <a href={DISCOVER_SOURCES.find(s => s.id === discoverSource)?.url} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-indigo-400 hover:text-indigo-300">
                  Visit site →
                </a>

                {/* Search for external sources */}
                {(discoverSource === 'skillsmp' || discoverSource === 'skillssh') && (
                  <div className="ml-auto flex gap-2 items-center">
                    <input
                      value={externalSearch}
                      onChange={e => setExternalSearch(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && externalSearch.trim()) {
                          if (discoverSource === 'skillsmp') void loadSkillsmp(externalSearch);
                          else void loadSkillssh(externalSearch);
                        }
                      }}
                      placeholder={`Search ${discoverSource === 'skillsmp' ? 'SkillsMP' : 'skills.sh'}...`}
                      className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-indigo-500 outline-none w-64"
                    />
                    <button
                      onClick={() => {
                        if (externalSearch.trim()) {
                          if (discoverSource === 'skillsmp') void loadSkillsmp(externalSearch);
                          else void loadSkillssh(externalSearch);
                        }
                      }}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg"
                    >
                      Search
                    </button>
                  </div>
                )}
              </div>

              {/* OpenClaw grid */}
              {discoverSource === 'openclaw' && (
                loadingRegistry ? (
                  <div className="text-center text-gray-500 py-20">Fetching from OpenClaw...</div>
                ) : filteredRegistry.length === 0 ? (
                  <div className="text-center text-gray-500 py-20">
                    <div className="text-4xl mb-3 opacity-30">⊕</div>
                    <div>No matching skills from OpenClaw.</div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredRegistry.map(skill => (
                      <div key={skill.name} onClick={() => setSelectedSkill(skill)}
                        className="bg-gray-900 border border-gray-800 rounded-xl p-5 cursor-pointer hover:border-gray-700 transition-colors">
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-sm truncate">{skill.name}</div>
                            <div className="text-xs text-gray-500 mt-0.5">{skill.author}</div>
                          </div>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${CATEGORY_COLORS[skill.category] ?? 'bg-gray-500/15 text-gray-400'} capitalize shrink-0 ml-2`}>
                            {skill.category}
                          </span>
                        </div>
                        <p className="text-sm text-gray-400 mt-2 line-clamp-2">{skill.description || 'No description'}</p>
                        {skill.addedAt && <div className="text-[10px] text-gray-600 mt-2">Added: {skill.addedAt}</div>}
                        <div className="mt-2 pt-2 border-t border-gray-800 flex items-center justify-between">
                          <a href={skill.sourceUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                            className="text-[10px] text-indigo-400 hover:text-indigo-300">Source →</a>
                          <button onClick={e => { e.stopPropagation(); void installFromRegistry(skill); }}
                            disabled={installing.has(skill.name)}
                            className="px-2.5 py-1 text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-50">
                            {installing.has(skill.name) ? '...' : 'Import'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}

              {/* SkillsMP / skills.sh grid */}
              {(discoverSource === 'skillsmp' || discoverSource === 'skillssh') && (
                loadingExternal ? (
                  <div className="text-center text-gray-500 py-20">
                    <div className="animate-pulse">Searching {discoverSource === 'skillsmp' ? 'SkillsMP' : 'skills.sh'}...</div>
                  </div>
                ) : externalSkills.length === 0 ? (
                  <div className="text-center text-gray-500 py-20">
                    <div className="text-4xl mb-3 opacity-30">{discoverSource === 'skillsmp' ? '◎' : '⬡'}</div>
                    {discoverSource === 'skillsmp' ? (
                      <>
                        <div>Search 364,000+ skills on SkillsMP</div>
                        <div className="text-xs mt-1">Enter a search query above to discover skills.</div>
                      </>
                    ) : (
                      <>
                        <div>Browse 84,000+ skills on skills.sh</div>
                        <div className="text-xs mt-1">The top skills are loaded automatically. Search for specific skills above.</div>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {externalSkills.map(skill => (
                      <div key={`${skill.source}-${skill.name}-${skill.repo}`} onClick={() => setSelectedSkill(skill)}
                        className="bg-gray-900 border border-gray-800 rounded-xl p-5 cursor-pointer hover:border-gray-700 transition-colors">
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-sm truncate">{skill.name}</div>
                            <div className="text-xs text-gray-500 mt-0.5">{skill.author} / {skill.repo}</div>
                          </div>
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-500/15 text-gray-400 shrink-0 ml-2">
                            {skill.source === 'skillsmp' ? 'SkillsMP' : 'skills.sh'}
                          </span>
                        </div>
                        {skill.description && <p className="text-sm text-gray-400 mt-2 line-clamp-2">{skill.description}</p>}
                        <div className="mt-2 pt-2 border-t border-gray-800 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {skill.stars !== undefined && <span className="text-[10px] text-amber-400">★ {skill.stars}</span>}
                            {skill.installs && <span className="text-[10px] text-gray-500">{skill.installs} installs</span>}
                          </div>
                          <div className="flex items-center gap-2">
                            <a href={skill.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                              className="text-[10px] text-indigo-400 hover:text-indigo-300">View →</a>
                            <button onClick={e => { e.stopPropagation(); void installExternal(skill); }}
                              disabled={installing.has(skill.name)}
                              className="px-2.5 py-1 text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-50">
                              {installing.has(skill.name) ? '...' : 'Import'}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      </div>

      {/* Detail modal */}
      {selectedSkill && (
        <SkillDetailModal
          skill={selectedSkill}
          onClose={() => setSelectedSkill(null)}
          onInstall={
            'sourceUrl' in selectedSkill && !('repo' in selectedSkill) ? () => { void installFromRegistry(selectedSkill as RegistrySkill); setSelectedSkill(null); } :
            'id' in selectedSkill && 'downloadCount' in selectedSkill ? () => { void installFromMarketplace(selectedSkill as MarketplaceSkill); setSelectedSkill(null); } :
            'repo' in selectedSkill ? () => { void installExternal(selectedSkill as ExternalSkill); setSelectedSkill(null); } :
            undefined
          }
        />
      )}
    </div>
  );
}
