import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, ownsHubItem, type HubItem } from '../api.ts';
import { AssetCard } from '../components/AssetCard.tsx';
import { Masonry } from '../components/Masonry.tsx';
import { iconForSkill } from '../lib/namedIcons.tsx';
import { consume, PREFETCH_KEYS } from '../prefetchCache.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { installHubItem, purchaseAndInstall } from './TemplateMarketplace.tsx';
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

type TabId = 'skills' | 'skillhub' | 'skillssh';

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

function HubSkillInstallButton({ item, installedSkills, purchased, onMsg, onRefresh }: {
  item: HubItem;
  installedSkills: InstalledSkill[];
  purchased?: boolean;
  onMsg: (text: string, type: 'success' | 'error') => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation(['store']);
  const [installing, setInstalling] = useState(false);

  const slug = item.name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[\/\\:*?"<>|]+/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'unnamed';
  const matchedSkill = installedSkills.find(s => s.name === item.name || s.name === slug || (!!item.slug && s.name === item.slug));
  const isInstalled = !!matchedSkill;
  const canUpgrade = isInstalled && item.version && matchedSkill?.version && isNewerVersion(item.version, matchedSkill.version);
  const isPaid = (item.priceCents ?? 0) > 0;

  const [status, setStatus] = useState('');

  const handleInstall = async () => {
    if (installing) return;
    setInstalling(true);
    setStatus('');
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

  const handleBuy = async () => {
    if (installing) return;
    setInstalling(true);
    setStatus('');
    try {
      const result = await purchaseAndInstall(item, (s) => {
        if (s === 'checkout_opened') setStatus(t('card.waitingPurchase', 'Waiting for purchase...'));
        else if (s === 'installing') setStatus(t('card.installing'));
      });
      if (result === 'installed') {
        onMsg(`Purchased & installed ${item.name}`, 'success');
        onRefresh();
      }
      setStatus('');
    } catch (err: unknown) {
      onMsg(err instanceof Error ? err.message : t('card.failed'), 'error');
      setStatus('');
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

  if (isPaid && !purchased) {
    const priceLabel = `$${((item.priceCents ?? 0) / 100).toFixed(2)}`;
    return (
      <span className="inline-flex items-center gap-1.5">
        <button onClick={() => void handleBuy()} disabled={installing}
          className="px-2.5 py-1 text-[10px] bg-amber-600 hover:bg-amber-500 text-white rounded-lg disabled:opacity-50 inline-flex items-center gap-1">
          {installing ? (status || t('card.installing')) : <>{t('card.buy', 'Buy')} {priceLabel}</>}
        </button>
      </span>
    );
  }

  return (
    <button onClick={() => void handleInstall()} disabled={installing}
      className="px-2.5 py-1 text-[10px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg disabled:opacity-50">
      {installing ? t('card.installing') : t('card.install')}
    </button>
  );
}

function HubSkillCard({ item, installedSkills, purchased, onMsg, onRefresh, highlight, onHighlightDone, type = 'skill' }: {
  item: HubItem;
  installedSkills: InstalledSkill[];
  purchased?: boolean;
  onMsg: (text: string, type: 'success' | 'error') => void;
  onRefresh: () => void;
  highlight?: boolean;
  onHighlightDone?: () => void;
  type?: string;
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
    ? `${hubApi.getUrl()}/@${encodeURIComponent(item.author.username)}/${encodeURIComponent(item.slug)}`
    : null;

  const handleCardClick = () => {
    if (detailUrl) window.open(detailUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div ref={cardRef} className={glowing ? 'animate-pulse' : ''}>
      <AssetCard
        type={type}
        showTypeBadge={type !== 'skill'}
        name={item.name}
        description={item.description}
        seed={item.slug || item.name}
        icon={item.icon || iconForSkill(item.slug || item.name, item.category)}
        cover={item.thumbnailUrl}
        hubBase={hubApi.getUrl()}
        author={item.author}
        version={item.version}
        category={item.category}
        tags={item.tags}
        rating={parseFloat(item.avgRating) || 0}
        ratingCount={item.ratingCount}
        downloadCount={item.downloadCount}
        priceCents={item.priceCents}
        currency={item.currency}
        onClick={handleCardClick}
        actions={<HubSkillInstallButton item={item} installedSkills={installedSkills} purchased={purchased} onMsg={onMsg} onRefresh={onRefresh} />}
      />
    </div>
  );
}

export function SkillStore({ highlightItemId, onHighlightDone }: { highlightItemId?: string | null; onHighlightDone?: () => void } = {}) {
  const { t, i18n } = useTranslation(['store', 'common']);
  const lang = i18n.language;
  const isMobile = useIsMobile();
  const [tab, setTab] = useState<TabId>('skills');
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
  const [connectorItems, setConnectorItems] = useState<HubItem[]>([]);
  const [hubPurchasedIds, setHubPurchasedIds] = useState<Set<string>>(new Set());
  const [loadingHub, setLoadingHub] = useState(false);
  const [hubSearch, setHubSearch] = useState('');

  const TABS: Array<{ id: TabId; labelKey: string }> = [
    { id: 'skills', labelKey: 'skillStore.tabs.all' },
    { id: 'skillhub', labelKey: 'skillStore.tabs.skillhub' },
    { id: 'skillssh', labelKey: 'skillStore.tabs.skillssh' },
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
      const cp = hubApi.search({ subtype: 'connector', q: q || undefined, limit: 50 }).catch(() => ({ items: [] as HubItem[] }));
      const [d, c] = await Promise.all([
        p,
        cp,
        hubApi.isAuthenticated()
          ? hubApi.purchases.mine().then(r => setHubPurchasedIds(new Set(r.purchases.map(pp => pp.itemId)))).catch(() => {})
          : Promise.resolve(),
      ]);
      setHubSkills(d?.items ?? []);
      setConnectorItems(c?.items ?? []);
    } catch { /* */ }
    setLoadingHub(false);
  }, []);

  useEffect(() => { loadInstalled(); loadBuiltin(); loadSkillhub(); loadSkillssh(); }, []);
  useEffect(() => { if (tab === 'skills') loadHubSkills(hubSearch); }, [tab, hubSearch, loadHubSkills]);

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
      <div className={`${isMobile ? 'px-4' : 'px-6'} shrink-0`}>
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

      {tab === 'skills' && (() => {
        const q = hubSearch.trim().toLowerCase();
        const filteredBuiltin = q
          ? builtinSkills.filter(s => localizedBuiltinName(s, lang).toLowerCase().includes(q) || localizedBuiltinDesc(s, lang).toLowerCase().includes(q))
          : builtinSkills;
        const bothLoading = loadingBuiltin && loadingHub;
        const bothEmpty = filteredBuiltin.length === 0 && hubSkills.length === 0 && connectorItems.length === 0;
        return (
          <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-6'} space-y-8`}>
            <div className="flex items-center gap-2">
              <input
                value={hubSearch}
                onChange={e => setHubSearch(e.target.value)}
                placeholder={t('skillStore.searchMarkusHub')}
                className={`px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none ${isMobile ? 'flex-1 min-w-0' : 'w-72'}`}
              />
            </div>

            {bothLoading && bothEmpty ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-56 rounded-2xl skeleton" />)}
              </div>
            ) : bothEmpty ? (
              <div className="text-center text-fg-tertiary py-20">
                <div className="text-4xl mb-3 opacity-30">◇</div>
                <div>{t('skillStore.noBuiltin')}</div>
                <div className="text-xs mt-1">{t('skillStore.noBuiltinHint')}</div>
              </div>
            ) : (
              <>
                {filteredBuiltin.length > 0 && (
                  <section>
                    <div className="flex items-baseline gap-2 mb-3">
                      <h3 className="section-title">{t('skillStore.tabs.builtin')}</h3>
                      <span className="text-xs text-fg-tertiary">{t('skillStore.builtinCount', { count: filteredBuiltin.length })}</span>
                    </div>
                    <Masonry columns={3}>
                      {filteredBuiltin.map(skill => (
                        <AssetCard
                          key={skill.name}
                          type="skill"
                          name={localizedBuiltinName(skill, lang)}
                          description={localizedBuiltinDesc(skill, lang)}
                          seed={skill.name}
                          icon={iconForSkill(skill.name, skill.category)}
                          version={skill.version}
                          category={skill.category}
                          tags={skill.tags}
                          authorLabel={skill.author || undefined}
                          installed={skill.installed}
                          hideStats
                          showTypeBadge={false}
                          cornerLabel={skill.installed ? undefined : t('skillStore.tabs.builtin')}
                          onClick={() => setSelectedBuiltin(skill)}
                        />
                      ))}
                    </Masonry>
                  </section>
                )}

                {hubSkills.length > 0 && (
                  <section>
                    <h3 className="section-title mb-3">{t('skillStore.tabs.markusHub')}</h3>
                    <Masonry columns={3}>
                      {hubSkills.map(item => (
                        <HubSkillCard key={item.id} item={item} installedSkills={installed} purchased={ownsHubItem(item, hubPurchasedIds)} onMsg={msg} onRefresh={() => { void loadInstalled(); void loadHubSkills(hubSearch); }} highlight={item.id === highlightItemId} onHighlightDone={onHighlightDone} />
                      ))}
                    </Masonry>
                  </section>
                )}

                {connectorItems.length > 0 && (
                  <section>
                    <div className="mb-3">
                      <h3 className="section-title">{t('tabs.connectors')}</h3>
                      <p className="text-xs text-fg-tertiary mt-0.5">{t('connectorStore.emptyHint', '连接器让智能体接入外部工具与服务 (MCP)')}</p>
                    </div>
                    <Masonry columns={3}>
                      {connectorItems.map(item => (
                        <HubSkillCard key={item.id} item={item} type="connector" installedSkills={installed} purchased={ownsHubItem(item, hubPurchasedIds)} onMsg={msg} onRefresh={() => { void loadInstalled(); void loadHubSkills(hubSearch); }} highlight={item.id === highlightItemId} onHighlightDone={onHighlightDone} />
                      ))}
                    </Masonry>
                  </section>
                )}
              </>
            )}
          </div>
        );
      })()}

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
              <Masonry columns={3}>
                {skillhubSkills.map(skill => {
                  const isInst = installed.some(s => s.name === skill.name || s.name === skill.slug);
                  return (
                    <AssetCard
                      key={skill.slug}
                      type="skill"
                      name={skill.name}
                      description={skill.description_zh ?? skill.description ?? ''}
                      seed={skill.slug}
                      icon={iconForSkill(skill.slug || skill.name, skill.tags?.[0])}
                      version={skill.version}
                      authorLabel="SkillHub"
                      showTypeBadge={false}
                      tags={skill.tags}
                      installed={isInst}
                      hideStats
                      onClick={() => window.open(skill.homepage, '_blank', 'noopener,noreferrer')}
                      footerLeft={
                        <span className="flex items-center gap-2 text-[10px] text-fg-tertiary">
                          {skill.stars > 0 && <span className="text-amber-600">★ {skill.stars.toLocaleString()}</span>}
                          {skill.downloads > 0 && <span>{skill.downloads >= 10000 ? `${(skill.downloads / 10000).toFixed(1)}万` : skill.downloads.toLocaleString()} {t('skillStore.downloads')}</span>}
                        </span>
                      }
                      actions={isInst ? undefined : (
                        <button
                          onClick={() => void installSkillhub(skill)}
                          disabled={installing.has(skill.name)}
                          className="px-2.5 py-1 text-[10px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg disabled:opacity-50"
                        >
                          {installing.has(skill.name) ? '...' : t('card.install')}
                        </button>
                      )}
                    />
                  );
                })}
              </Masonry>
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
            <Masonry columns={3}>
              {filteredSkillssh.map(skill => {
                const isInst = installed.some(s => s.name === skill.name);
                return (
                  <AssetCard
                    key={`${skill.author}-${skill.name}`}
                    type="skill"
                    name={skill.name}
                    description={skill.description || ''}
                    seed={`${skill.author}-${skill.name}`}
                    icon={iconForSkill(skill.name)}
                    authorLabel={`${skill.author}/${skill.repo}`}
                    showTypeBadge={false}
                    installed={isInst}
                    hideStats
                    cornerLabel={isInst ? undefined : 'skills.sh'}
                    onClick={() => window.open(skill.url, '_blank', 'noopener,noreferrer')}
                    footerLeft={skill.installs ? <span className="text-[10px] text-fg-tertiary">{skill.installs} installs</span> : undefined}
                    actions={isInst ? undefined : (
                      <button
                        onClick={() => void installSkillssh(skill)}
                        disabled={installing.has(skill.name)}
                        className="px-2.5 py-1 text-[10px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg disabled:opacity-50"
                      >
                        {installing.has(skill.name) ? '...' : t('card.install')}
                      </button>
                    )}
                  />
                );
              })}
            </Masonry>
          )}
        </div>
      )}

    </div>
  );
}
