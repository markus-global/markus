import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, type HubItem } from '../api.ts';
import { consume, PREFETCH_KEYS } from '../prefetchCache.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { installHubItem } from './TemplateMarketplace.tsx';
import { ArtifactDetail } from './ArtifactDetail.tsx';

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
  instructions?: string;
  requiredPermissions: string[];
  installed: boolean;
  installedVersion?: string | null;
  i18n?: Record<string, { displayName?: string; description?: string }>;
}

function localizedBuiltinName(skill: BuiltinSkill, lang: string): string {
  return skill.i18n?.[lang]?.displayName || skill.name;
}

function localizedBuiltinDesc(skill: BuiltinSkill, lang: string): string {
  return skill.i18n?.[lang]?.description || skill.description || '';
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

type TabId = 'builtin' | 'skillhub' | 'skillssh' | 'markus-hub';

const CATEGORY_COLORS: Record<string, string> = {
  development: 'bg-blue-500/15 text-blue-600',
  devops: 'bg-amber-500/15 text-amber-600',
  productivity: 'bg-green-500/15 text-green-600',
  custom: 'bg-gray-500/15 text-fg-secondary',
  browser: 'bg-brand-500/15 text-brand-500',
  communication: 'bg-green-500/15 text-green-600',
  data: 'bg-brand-500/15 text-brand-500',
  platform: 'bg-blue-500/15 text-blue-600',
  'AI 智能': 'bg-brand-500/15 text-brand-500',
  '开发工具': 'bg-blue-500/15 text-blue-600',
  '效率提升': 'bg-green-500/15 text-green-600',
  '数据分析': 'bg-brand-500/15 text-brand-500',
  '内容创作': 'bg-brand-500/15 text-brand-500',
  '安全合规': 'bg-red-500/15 text-red-500',
  '通讯协作': 'bg-green-500/15 text-green-600',
};

function HubSkillInstallButton({ item, installedSkills, onMsg, onRefresh }: {
  item: HubItem;
  installedSkills: InstalledSkill[];
  onMsg: (text: string, type: 'success' | 'error') => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation(['store']);
  const [installing, setInstalling] = useState(false);

  const slug = item.name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[\/\\:*?"<>|]+/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'unnamed';
  const matchedSkill = installedSkills.find(s => s.name === item.name || s.name === slug);
  const isInstalled = !!matchedSkill;
  const canUpgrade = isInstalled && item.version && matchedSkill?.version && isNewerVersion(item.version, matchedSkill.version);
  const isPaid = (item.priceCents ?? 0) > 0;

  const handleInstall = async () => {
    if (installing) return;
    setInstalling(true);
    try {
      await installHubItem(item);
      onMsg(canUpgrade ? `Upgraded ${item.name}` : `Installed ${item.name}`, 'success');
      onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('402') || msg.includes('Purchase required')) {
        onMsg(t('card.purchaseRequired'), 'error');
      } else {
        onMsg(t('card.failed'), 'error');
      }
    } finally {
      setInstalling(false);
    }
  };

  if (canUpgrade) {
    return (
      <button onClick={() => void handleInstall()} disabled={installing}
        className="px-2.5 py-1 text-[10px] bg-amber-600 hover:bg-amber-500 text-white rounded-lg disabled:opacity-50">
        {installing ? t('card.upgrading') : t('card.upgrade', { version: item.version })}
      </button>
    );
  }

  if (isInstalled) {
    return (
      <span className="px-2.5 py-1 text-[10px] bg-surface-overlay text-fg-secondary rounded-lg">
        {t('card.installed')}{matchedSkill?.version ? ` (v${matchedSkill.version})` : ''}
      </span>
    );
  }

  if (isPaid) {
    return (
      <a href={`${hubApi.getUrl()}/${encodeURIComponent(item.author?.username ?? '')}/${encodeURIComponent(item.slug ?? item.id)}`}
        target="_blank" rel="noopener noreferrer"
        className="px-2.5 py-1 text-[10px] bg-amber-600 hover:bg-amber-500 text-white rounded-lg inline-flex items-center gap-1"
      >{t('card.buy', { price: `$${((item.priceCents ?? 0) / 100).toFixed(2)}` })}</a>
    );
  }

  return (
    <button onClick={() => void handleInstall()} disabled={installing}
      className="px-2.5 py-1 text-[10px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg disabled:opacity-50">
      {installing ? t('card.installing') : t('card.install')}
    </button>
  );
}

function HubSkillCard({ item, installedSkills, onMsg, onRefresh, highlight, onHighlightDone }: {
  item: HubItem;
  installedSkills: InstalledSkill[];
  onMsg: (text: string, type: 'success' | 'error') => void;
  onRefresh: () => void;
  highlight?: boolean;
  onHighlightDone?: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [glowing, setGlowing] = useState(false);

  useEffect(() => {
    if (highlight && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setGlowing(true);
      const timer = setTimeout(() => { setGlowing(false); onHighlightDone?.(); }, 4000);
      return () => clearTimeout(timer);
    }
  }, [highlight, onHighlightDone]);

  const detailUrl = item.slug && item.author?.username
    ? `${hubApi.getUrl()}/${encodeURIComponent(item.author.username)}/${encodeURIComponent(item.slug)}`
    : null;

  const iconIsEmoji = item.icon && !item.icon.startsWith('/') && !item.icon.startsWith('http');
  const iconSrc = item.icon && (item.icon.startsWith('http') ? item.icon : item.icon.startsWith('/') ? `${hubApi.getUrl()}${item.icon}` : null);
  const rating = Math.round(parseFloat(item.avgRating));

  const handleCardClick = () => {
    if (detailUrl) window.open(detailUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div ref={cardRef} onClick={handleCardClick} className={`group relative bg-surface-secondary rounded-xl overflow-hidden cursor-pointer transition-all duration-300 hover:shadow-xl hover:shadow-brand-500/5 hover:-translate-y-0.5 ${glowing ? 'ring-2 ring-brand-500 shadow-lg shadow-brand-500/20 animate-pulse' : ''}`}>
      <div className={`absolute inset-0 rounded-xl border transition-colors duration-300 ${glowing ? 'border-brand-500/60' : 'border-border-default group-hover:border-brand-500/30'}`} />
      <div className="relative p-5">
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-surface-elevated/80 border border-border-default/50 flex items-center justify-center shrink-0 text-lg">
            {iconSrc ? <img src={iconSrc} alt="" className="w-8 h-8 rounded object-cover" /> : iconIsEmoji ? item.icon : '\u{1F9E9}'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold truncate group-hover:text-brand-400 transition-colors">{item.name}</h3>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] text-fg-tertiary truncate">by {item.author?.displayName ?? item.author?.username}</span>
              {item.version && <span className="text-[10px] px-1.5 py-0.5 bg-brand-500/15 text-brand-400 rounded-md border border-brand-500/10 shrink-0">v{item.version}</span>}
            </div>
          </div>
        </div>

        <p className="text-sm text-fg-secondary line-clamp-2 leading-relaxed mb-3">{item.description}</p>

        {item.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {item.tags.slice(0, 3).map(tag => (
              <span key={tag} className="px-2 py-0.5 text-[10px] bg-surface-elevated/80 text-fg-secondary rounded-md border border-border-default/50">{tag}</span>
            ))}
            {item.tags.length > 3 && <span className="px-1 text-[10px] text-fg-muted">+{item.tags.length - 3}</span>}
          </div>
        )}

        <div className="flex items-center gap-3 text-xs text-fg-tertiary mb-3">
          <span className="text-amber-500 tracking-tight">{'\u2605'.repeat(rating)}{'\u2606'.repeat(5 - rating)}</span>
          <span className="text-fg-muted">({item.ratingCount})</span>
          <span>{'\u2193'} {item.downloadCount}</span>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-border-default/50" onClick={e => e.stopPropagation()}>
          <HubSkillInstallButton item={item} installedSkills={installedSkills} onMsg={onMsg} onRefresh={onRefresh} />
        </div>
      </div>
    </div>
  );
}

export function SkillStore({ highlightItemId, onHighlightDone }: { highlightItemId?: string | null; onHighlightDone?: () => void } = {}) {
  const { t, i18n } = useTranslation(['store', 'common']);
  const lang = i18n.language;
  const isMobile = useIsMobile();
  const [tab, setTab] = useState<TabId>(highlightItemId ? 'markus-hub' : 'builtin');
  const [flash, setFlash] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [installing, setInstalling] = useState<Set<string>>(new Set());

  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [selectedBuiltin, setSelectedBuiltin] = useState<BuiltinSkill | null>(null);

  const [skillhubSkills, setSkillhubSkills] = useState<SkillHubSkill[]>([]);
  const [skillhubTotal, setSkillhubTotal] = useState(0);
  const [skillhubPage, setSkillhubPage] = useState(1);
  const [skillhubCategories, setSkillhubCategories] = useState<string[]>([]);
  const [skillhubCategory, setSkillhubCategory] = useState('');
  const [skillhubSort, setSkillhubSort] = useState('score');
  const [skillhubSearch, setSkillhubSearch] = useState('');
  const [loadingSkillhub, setLoadingSkillhub] = useState(false);

  const [builtinSkills, setBuiltinSkills] = useState<BuiltinSkill[]>([]);
  const [loadingBuiltin, setLoadingBuiltin] = useState(false);

  const [skillsshList, setSkillsshList] = useState<SkillsShSkill[]>([]);
  const [skillsshSearch, setSkillsshSearch] = useState('');
  const [loadingSkillssh, setLoadingSkillssh] = useState(false);

  const [hubSkills, setHubSkills] = useState<HubItem[]>([]);
  const [loadingHub, setLoadingHub] = useState(false);
  const [hubSearch, setHubSearch] = useState('');

  const TABS: Array<{ id: TabId; labelKey: string }> = [
    { id: 'builtin', labelKey: 'skillStore.tabs.builtin' },
    { id: 'skillhub', labelKey: 'skillStore.tabs.skillhub' },
    { id: 'skillssh', labelKey: 'skillStore.tabs.skillssh' },
    { id: 'markus-hub', labelKey: 'skillStore.tabs.markusHub' },
  ];

  const msg = (m: string, type: 'success' | 'error' = 'success') => {
    setFlash({ text: m, type });
    setTimeout(() => setFlash(null), type === 'error' ? 10000 : 4000);
  };

  const loadInstalled = useCallback(async () => {
    try {
      const d = await api.skills.list();
      setInstalled(d.skills as InstalledSkill[]);
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
      const p = !q
        ? (consume<{ items: HubItem[] }>(PREFETCH_KEYS.hubSkills) ?? hubApi.search({ type: 'skill', limit: 50 }))
        : hubApi.search({ type: 'skill', q, limit: 50 });
      const d = await p;
      setHubSkills(d?.items ?? []);
    } catch { /* */ }
    setLoadingHub(false);
  }, []);

  useEffect(() => { loadInstalled(); loadBuiltin(); loadSkillhub(); loadSkillssh(); }, []);
  useEffect(() => { if (tab === 'markus-hub') loadHubSkills(hubSearch); }, [tab, hubSearch, loadHubSkills]);

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
    } catch {
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
    } catch {
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

  const filteredSkillssh = skillsshList.filter(s => {
    if (!skillsshSearch) return true;
    const q = skillsshSearch.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.repo.toLowerCase().includes(q);
  });

  if (selectedBuiltin) {
    const skill = selectedBuiltin;
    const skillFiles: Record<string, string> = {};
    if (skill.instructions) skillFiles['SKILL.md'] = skill.instructions;

    const manifestData = {
      type: 'skill',
      name: skill.name,
      displayName: localizedBuiltinName(skill, lang),
      version: skill.version,
      description: localizedBuiltinDesc(skill, lang),
      author: skill.author ?? '',
      category: skill.category ?? 'general',
      tags: skill.tags,
      files: skillFiles,
      skill: {
        skillFile: skill.instructions ? 'SKILL.md' : '',
        requiredPermissions: skill.requiredPermissions,
        mcpServers: undefined,
        alwaysOn: false,
      },
    };

    const installButton = skill.installed && skill.installedVersion && isNewerVersion(skill.version, skill.installedVersion) ? (
      <button onClick={() => void installBuiltin(skill)} disabled={installing.has(skill.name)}
        className="px-4 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg disabled:opacity-50 transition-colors">
        {installing.has(skill.name) ? t('card.upgrading') : t('card.upgrade', { version: skill.version })}
      </button>
    ) : skill.installed ? (
      <span className="px-4 py-1.5 text-xs bg-green-500/10 text-green-500 rounded-lg border border-green-500/20 inline-flex items-center gap-1">
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        {t('card.installed')}{skill.installedVersion ? ` v${skill.installedVersion}` : ''}
      </span>
    ) : (
      <button onClick={() => void installBuiltin(skill)} disabled={installing.has(skill.name)}
        className="px-4 py-1.5 text-xs bg-green-600 hover:bg-green-500 text-white rounded-lg disabled:opacity-50 transition-colors">
        {installing.has(skill.name) ? t('card.installing') : t('card.install')}
      </button>
    );

    const skillContentSlot = (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border-default bg-surface-secondary/40 p-5">
          <h3 className="text-xs text-fg-tertiary uppercase tracking-wider mb-3">{t('skillStore.details')}</h3>
          <div className="space-y-2.5 text-sm">
            {skill.category && (
              <div className="flex items-center gap-2">
                <span className="text-fg-tertiary w-24">{t('skillStore.category')}</span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium capitalize ${CATEGORY_COLORS[skill.category] ?? 'bg-gray-500/15 text-fg-secondary'}`}>{skill.category}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-fg-tertiary w-24">{t('skillStore.version')}</span>
              <span className="text-fg-secondary font-mono text-xs">{skill.version}</span>
            </div>
            {skill.hasMcpServers && (
              <div className="flex items-center gap-2">
                <span className="text-fg-tertiary w-24">{t('skillStore.integration')}</span>
                <span className="px-2 py-0.5 rounded text-[10px] bg-purple-500/15 text-purple-400">MCP</span>
              </div>
            )}
            {skill.hasInstructions && (
              <div className="flex items-center gap-2">
                <span className="text-fg-tertiary w-24">{t('skillStore.instructions')}</span>
                <span className="text-green-500 text-xs">✓</span>
              </div>
            )}
          </div>
        </div>
        {(skill.requiredPermissions.length > 0 || skill.tags.length > 0) && (
          <div className="space-y-4">
            {skill.requiredPermissions.length > 0 && (
              <div className="rounded-xl border border-border-default bg-surface-secondary/40 p-5">
                <h3 className="text-xs text-fg-tertiary uppercase tracking-wider mb-3">{t('skillStore.permissions')}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {skill.requiredPermissions.map(p => <span key={p} className="px-2.5 py-1 text-xs bg-amber-500/10 text-amber-500 rounded-lg border border-amber-500/20">{p}</span>)}
                </div>
              </div>
            )}
            {skill.tags.length > 0 && (
              <div className="rounded-xl border border-border-default bg-surface-secondary/40 p-5">
                <h3 className="text-xs text-fg-tertiary uppercase tracking-wider mb-3">{t('skillStore.tags')}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {skill.tags.map(tg => <span key={tg} className="px-2.5 py-1 text-xs bg-surface-elevated text-fg-secondary rounded-lg border border-border-default/50">{tg}</span>)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );

    return (
      <>
        <ArtifactDetail
          type="skill"
          name={skill.name}
          onBack={() => setSelectedBuiltin(null)}
          readOnly
          initialManifest={manifestData}
          actionSlot={installButton}
          contentSlot={skillContentSlot}
        />
        {flash && (
          <div className={`mx-7 mb-2 px-3 py-1.5 text-xs rounded-lg shrink-0 ${
            flash.type === 'error' ? 'bg-red-500/10 text-red-500' : 'bg-green-500/10 text-green-600'
          }`}>{flash.text}</div>
        )}
      </>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className={`${isMobile ? 'px-4' : 'px-6'} border-b border-border-default bg-surface-secondary shrink-0`}>
        <div className="flex items-center h-14">
          <h2 className="text-lg font-semibold">{t('skillStore.title')}</h2>
        </div>
        <div className={`flex ${isMobile ? 'flex-wrap' : ''} gap-1 pb-2 overflow-x-auto scrollbar-hide`}>
          {TABS.map(tb => (
            <button key={tb.id} onClick={() => setTab(tb.id)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors shrink-0 ${
                tab === tb.id ? 'bg-brand-600 text-white' : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-elevated'
              }`}>
              {t(tb.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {flash && (
        <div className={`mx-7 mt-2 px-3 py-1.5 text-xs rounded-lg shrink-0 ${
          flash.type === 'error' ? 'bg-red-500/10 text-red-500' : 'bg-green-500/10 text-green-600'
        }`}>{flash.text}</div>
      )}

      {tab === 'builtin' && (
        <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-6'}`}>
          <div className="flex items-center gap-3 mb-5">
            <span className="text-xs text-fg-tertiary">{t('skillStore.builtinCount', { count: builtinSkills.length })}</span>
            <button onClick={() => void loadBuiltin()} className="text-xs text-brand-500 hover:text-brand-500 transition-colors">
              {t('skillStore.refresh')}
            </button>
          </div>

          {loadingBuiltin ? (
            <div className="text-center text-fg-tertiary py-20"><div className="animate-pulse">{t('skillStore.loadingBuiltin')}</div></div>
          ) : builtinSkills.length === 0 ? (
            <div className="text-center text-fg-tertiary py-20">
              <div className="text-4xl mb-3 opacity-30">◇</div>
              <div>{t('skillStore.noBuiltin')}</div>
              <div className="text-xs mt-1">{t('skillStore.noBuiltinHint')}</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {builtinSkills.map(skill => (
                <div key={skill.name} onClick={() => setSelectedBuiltin(skill)}
                  className="group relative bg-surface-secondary rounded-xl cursor-pointer transition-all duration-300 overflow-hidden hover:shadow-xl hover:shadow-brand-500/5 hover:-translate-y-0.5">
                  <div className="absolute inset-0 rounded-xl border transition-colors duration-300 border-border-default group-hover:border-brand-500/30" />
                  <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-green-500/40 to-transparent transition-opacity duration-300 opacity-0 group-hover:opacity-100" />
                  <div className="relative p-5">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-semibold text-sm truncate group-hover:text-brand-400 transition-colors">{localizedBuiltinName(skill, lang)}</div>
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

                    <p className="text-sm text-fg-secondary mt-2 line-clamp-2">{localizedBuiltinDesc(skill, lang)}</p>

                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {skill.tags.slice(0, 4).map(tg => <span key={tg} className="px-2 py-0.5 text-[10px] bg-surface-elevated text-fg-tertiary rounded-full">{tg}</span>)}
                    </div>

                    {skill.requiredPermissions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {skill.requiredPermissions.map(p => (
                          <span key={p} className="px-1.5 py-0.5 text-[9px] bg-amber-500/10 text-amber-500 rounded">{p}</span>
                        ))}
                      </div>
                    )}

                    <div className="mt-3 pt-2 border-t border-border-default/50 flex items-center justify-between" onClick={e => e.stopPropagation()}>
                      {skill.installed && skill.installedVersion ? (
                        <span className="text-[10px] text-fg-tertiary">v{skill.installedVersion}</span>
                      ) : <span />}
                      {skill.installed && skill.installedVersion && isNewerVersion(skill.version, skill.installedVersion) ? (
                        <button
                          onClick={() => void installBuiltin(skill)}
                          disabled={installing.has(skill.name)}
                          className="px-2.5 py-1 text-[10px] bg-amber-600 hover:bg-amber-500 text-white rounded-lg disabled:opacity-50 transition-colors"
                        >
                          {installing.has(skill.name) ? t('card.upgrading') : t('card.upgrade', { version: skill.version })}
                        </button>
                      ) : skill.installed ? (
                        <span className="px-2.5 py-1 text-[10px] bg-surface-overlay text-fg-secondary rounded-lg">{t('card.installed')}</span>
                      ) : (
                        <button
                          onClick={() => void installBuiltin(skill)}
                          disabled={installing.has(skill.name)}
                          className="px-2.5 py-1 text-[10px] bg-green-600 hover:bg-green-500 text-white rounded-lg disabled:opacity-50 transition-colors"
                        >
                          {installing.has(skill.name) ? t('card.installing') : t('card.install')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'skillhub' && (
        <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-6'}`}>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <select
              value={skillhubCategory}
              onChange={e => { setSkillhubCategory(e.target.value); setSkillhubPage(1); void loadSkillhub({ q: skillhubSearch || undefined, category: e.target.value || undefined, page: 1 }); }}
              className="px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-fg-secondary outline-none"
            >
              <option value="">{t('skillStore.allCategories')}</option>
              {skillhubCategories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              value={skillhubSort}
              onChange={e => { setSkillhubSort(e.target.value); setSkillhubPage(1); void loadSkillhub({ q: skillhubSearch || undefined, category: skillhubCategory || undefined, page: 1, sort: e.target.value }); }}
              className="px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-fg-secondary outline-none"
            >
              <option value="score">{t('skillStore.sortScore')}</option>
              <option value="downloads">{t('skillStore.sortDownloads')}</option>
              <option value="stars">{t('skillStore.sortStars')}</option>
              <option value="installs">{t('skillStore.sortInstalls')}</option>
            </select>
            {!isMobile && <span className="text-xs text-fg-tertiary ml-auto">
              <a href="https://skillhub.tencent.com" target="_blank" rel="noopener noreferrer" className="text-brand-500 hover:text-brand-500">{t('skillStore.visitSite')}</a>
            </span>}
          </div>
          <div className="flex items-center gap-2 mb-5">
            <input
              value={skillhubSearch}
              onChange={e => setSkillhubSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { setSkillhubPage(1); void loadSkillhub({ q: skillhubSearch || undefined, category: skillhubCategory || undefined, page: 1 }); } }}
              placeholder={t('skillStore.searchSkillhub')}
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
            <div className="text-center text-fg-tertiary py-20"><div className="animate-pulse">{t('skillStore.loadingSkillhub')}</div></div>
          ) : skillhubSkills.length === 0 ? (
            <div className="text-center text-fg-tertiary py-20">
              <div className="text-4xl mb-3 opacity-30">◎</div>
              <div>{t('skillStore.noSkillhub')}</div>
            </div>
          ) : (
            <>
              <div className="text-xs text-fg-tertiary mb-3">{t('skillStore.skillhubTotal', { count: skillhubTotal.toLocaleString() })}</div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {skillhubSkills.map(skill => {
                  const isInst = installed.some(s => s.name === skill.name || s.name === skill.slug);
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
                          {skill.downloads > 0 && <span className="text-[10px] text-fg-tertiary">{skill.downloads >= 10000 ? `${(skill.downloads / 10000).toFixed(1)}万` : skill.downloads.toLocaleString()} {t('skillStore.downloads')}</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <a href={skill.homepage} target="_blank" rel="noopener noreferrer" className="text-[10px] text-brand-500 hover:text-brand-500">{t('card.view')}</a>
                          {isInst ? (
                            <span className="px-2.5 py-1 text-[10px] bg-surface-overlay text-fg-secondary rounded-lg">{t('card.installed')}</span>
                          ) : (
                            <button
                              onClick={() => void installSkillhub(skill)}
                              disabled={installing.has(skill.name)}
                              className="px-2.5 py-1 text-[10px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg disabled:opacity-50"
                            >
                              {installing.has(skill.name) ? '...' : t('card.install')}
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
                    {t('skillStore.prevPage')}
                  </button>
                  <span className="text-xs text-fg-tertiary">{t('skillStore.pageInfo', { current: skillhubPage, total: Math.ceil(skillhubTotal / 24) })}</span>
                  <button
                    disabled={skillhubPage >= Math.ceil(skillhubTotal / 24)}
                    onClick={() => { const p = skillhubPage + 1; setSkillhubPage(p); void loadSkillhub({ q: skillhubSearch || undefined, category: skillhubCategory || undefined, page: p }); }}
                    className="px-3 py-1.5 text-xs bg-surface-elevated text-fg-secondary rounded-lg hover:bg-surface-overlay disabled:opacity-30">
                    {t('skillStore.nextPage')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'skillssh' && (
        <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-6'}`}>
          <div className={`flex ${isMobile ? 'flex-wrap' : ''} items-center gap-2 mb-5`}>
            <input
              value={skillsshSearch}
              onChange={e => setSkillsshSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && skillsshSearch.trim()) void loadSkillssh(skillsshSearch); }}
              placeholder={t('skillStore.searchSkillssh')}
              className={`px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none ${isMobile ? 'flex-1 min-w-0' : 'w-72'}`}
            />
            <button
              onClick={() => { if (skillsshSearch.trim()) void loadSkillssh(skillsshSearch); }}
              className="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-xs rounded-lg shrink-0"
            >
              Search
            </button>
            {!isMobile && <span className="text-xs text-fg-tertiary ml-auto">
              <a href="https://skills.sh" target="_blank" rel="noopener noreferrer" className="text-brand-500 hover:text-brand-500">{t('skillStore.visitSite')}</a>
            </span>}
          </div>

          {loadingSkillssh ? (
            <div className="text-center text-fg-tertiary py-20"><div className="animate-pulse">{t('skillStore.loadingSkillssh')}</div></div>
          ) : filteredSkillssh.length === 0 ? (
            <div className="text-center text-fg-tertiary py-20">
              <div className="text-4xl mb-3 opacity-30">⬡</div>
              <div>{t('skillStore.browseSkillssh')}</div>
              <div className="text-xs mt-1">{t('skillStore.browseSkillsshHint')}</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredSkillssh.map(skill => {
                const isInst = installed.some(s => s.name === skill.name);
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
                        <a href={skill.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-brand-500 hover:text-brand-500">{t('card.view')}</a>
                        {isInst ? (
                          <span className="px-2.5 py-1 text-[10px] bg-surface-overlay text-fg-secondary rounded-lg">{t('card.installed')}</span>
                        ) : (
                          <button
                            onClick={() => void installSkillssh(skill)}
                            disabled={installing.has(skill.name)}
                            className="px-2.5 py-1 text-[10px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg disabled:opacity-50"
                          >
                            {installing.has(skill.name) ? '...' : t('card.install')}
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

      {tab === 'markus-hub' && (
        <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-6'}`}>
          <div className="flex items-center gap-2 mb-5">
            <input
              value={hubSearch}
              onChange={e => setHubSearch(e.target.value)}
              placeholder={t('skillStore.searchMarkusHub')}
              className={`px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none ${isMobile ? 'flex-1 min-w-0' : 'w-72'}`}
            />
            {!isMobile && <span className="text-xs text-fg-tertiary ml-auto">{t('skillStore.communitySkills')}</span>}
          </div>

          {loadingHub ? (
            <div className="text-center text-fg-tertiary py-20"><div className="animate-pulse">{t('skillStore.loadingHub')}</div></div>
          ) : hubSkills.length === 0 ? (
            <div className="text-center text-fg-tertiary py-20">
              <div className="text-4xl mb-3">🏪</div>
              <div>{t('skillStore.noHub')}</div>
              <div className="text-xs mt-1">{t('skillStore.noHubHint')}</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {hubSkills.map(item => (
                <HubSkillCard key={item.id} item={item} installedSkills={installed} onMsg={msg} onRefresh={() => void loadInstalled()} highlight={item.id === highlightItemId} onHighlightDone={onHighlightDone} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
