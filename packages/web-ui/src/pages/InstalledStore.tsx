import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { ArtifactDetail } from './ArtifactDetail.tsx';
import { AssetCard } from '../components/AssetCard.tsx';
import { Masonry } from '../components/Masonry.tsx';

interface InstalledArtifact {
  type: string;
  name: string;
  meta: Record<string, unknown>;
  path: string;
  updatedAt: string;
}

interface SkillUpdateInfo {
  availableVersion: string;
  installedVersion: string;
  displayName?: string;
  description?: string;
}

function localizedField(meta: Record<string, unknown>, field: 'displayName' | 'description', lang: string): string | undefined {
  const i18n = meta.i18n as Record<string, Record<string, string>> | undefined;
  return i18n?.[lang]?.[field];
}

export function InstalledStore() {
  const { t, i18n } = useTranslation(['store', 'common']);
  const isMobile = useIsMobile();
  const lang = i18n.language;
  const [artifacts, setArtifacts] = useState<InstalledArtifact[]>([]);
  const [updates, setUpdates] = useState<Record<string, SkillUpdateInfo>>({});
  const [updating, setUpdating] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'agent' | 'team' | 'skill'>('all');
  const [detailItem, setDetailItem] = useState<{ type: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [artRes, instRes, updatesRes, builtinRes] = await Promise.all([
        api.builder.artifacts.list().catch(() => ({ artifacts: [] as InstalledArtifact[] })),
        api.builder.artifacts.installed().catch(() => ({ installed: {} as Record<string, unknown> })),
        api.skills.updates().catch(() => ({ updates: [], count: 0 })),
        api.skills.builtin().catch(() => ({ skills: [] })),
      ]);

      const updateMap: Record<string, SkillUpdateInfo> = {};
      for (const u of updatesRes.updates) {
        updateMap[u.name] = {
          availableVersion: u.availableVersion,
          installedVersion: u.installedVersion,
          displayName: u.displayName,
          description: u.description,
        };
      }
      setUpdates(updateMap);

      const installed = artRes.artifacts.filter(a => {
        const key = `${a.type}/${a.name}`;
        return !!instRes.installed[key];
      });

      // Surface builtin-installed skills that have no builder-artifact card yet.
      const seenSkills = new Set(installed.filter(a => a.type === 'skill').map(a => a.name));
      for (const skill of builtinRes.skills) {
        if (!skill.installed || seenSkills.has(skill.name)) continue;
        const localOnly = !!instRes.installed[`skill/${skill.name}`] || !!updateMap[skill.name];
        if (!localOnly && !skill.updateAvailable) continue;
        if (!instRes.installed[`skill/${skill.name}`] && !updateMap[skill.name]) continue;
        installed.push({
          type: 'skill',
          name: skill.name,
          meta: {
            displayName: skill.i18n?.[lang]?.displayName || skill.name,
            description: skill.i18n?.[lang]?.description || skill.description || '',
            version: skill.installedVersion || skill.version,
            author: skill.author,
            category: skill.category,
            tags: skill.tags,
            i18n: skill.i18n,
          },
          path: '',
          updatedAt: '',
        });
        seenSkills.add(skill.name);
      }

      // Ensure every updatable skill appears even if not in artifacts/builtin list edge cases.
      for (const [name, info] of Object.entries(updateMap)) {
        if (seenSkills.has(name)) continue;
        installed.push({
          type: 'skill',
          name,
          meta: {
            displayName: info.displayName || name,
            description: info.description || '',
            version: info.installedVersion,
          },
          path: '',
          updatedAt: '',
        });
        seenSkills.add(name);
      }

      setArtifacts(installed);
    } catch { /* ignore */ }
    setLoading(false);
  }, [lang]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const handler = () => void load();
    window.addEventListener('markus:data-changed', handler);
    return () => window.removeEventListener('markus:data-changed', handler);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleUpdate = async (name: string, availableVersion: string) => {
    if (updating.has(name)) return;
    setUpdating(prev => new Set(prev).add(name));
    try {
      await api.skills.install({ name, source: 'builtin' });
      try { localStorage.removeItem('markus:template-updates-ack'); } catch { /* */ }
      setToast({ text: t('installedTab.updateSuccess', { name, version: availableVersion }), type: 'success' });
      window.dispatchEvent(new CustomEvent('markus:data-changed'));
      await load();
    } catch {
      setToast({ text: t('installedTab.updateFailed', { name }), type: 'error' });
    }
    setUpdating(prev => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  };

  const filtered = artifacts.filter(a => {
    if (filterType !== 'all' && a.type !== filterType) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    const name = (localizedField(a.meta, 'displayName', lang) || a.meta.displayName as string || a.name).toLowerCase();
    const desc = (localizedField(a.meta, 'description', lang) || a.meta.description as string || '').toLowerCase();
    return name.includes(q) || desc.includes(q);
  }).sort((a, b) => {
    const aUp = a.type === 'skill' && !!updates[a.name] ? 1 : 0;
    const bUp = b.type === 'skill' && !!updates[b.name] ? 1 : 0;
    return bUp - aUp;
  });

  if (detailItem) {
    return (
      <ArtifactDetail
        type={detailItem.type}
        name={detailItem.name}
        onBack={() => setDetailItem(null)}
      />
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div data-electron-drag className={`${isMobile ? 'px-4' : 'px-6'} h-14 flex items-center shrink-0 gap-3`}>
        <h2 className="text-lg font-semibold">{t('installedTab.title')}</h2>
        {Object.keys(updates).length > 0 && (
          <span className="px-2 py-0.5 text-[11px] font-medium rounded-md bg-amber-500/15 text-amber-600 border border-amber-500/25">
            {t('installedTab.updateAvailable')} · {Object.keys(updates).length}
          </span>
        )}
      </div>

      <div className={`flex flex-wrap items-center gap-2 ${isMobile ? 'px-4' : 'px-6'} py-2 shrink-0`}>
        <div className="flex gap-1">
          {(['all', 'agent', 'team', 'skill'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilterType(f)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                filterType === f ? 'bg-brand-600 text-white' : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-elevated'
              }`}
            >
              {t(`installedTab.filter${f === 'all' ? 'All' : f === 'agent' ? 'Agents' : f === 'team' ? 'Teams' : 'Skills'}`)}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-[120px]">
          <input
            type="text"
            placeholder={t('installedTab.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm w-full focus:border-brand-500 focus:outline-none"
          />
        </div>
      </div>

      <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-4' : 'p-7'}`}>
        {loading ? (
          <div className="text-center text-fg-tertiary py-20 animate-pulse">{t('installedTab.loading')}</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-4xl mb-4 opacity-30">&#x29C9;</div>
            <div className="text-fg-secondary font-medium mb-1">{t('installedTab.noItems')}</div>
            <div className="text-fg-tertiary text-sm">{t('installedTab.noItemsHint')}</div>
          </div>
        ) : (
          <Masonry columns={3}>
            {filtered.map(art => {
              const displayName = localizedField(art.meta, 'displayName', lang) || art.meta.displayName as string || art.name;
              const description = localizedField(art.meta, 'description', lang) || art.meta.description as string || '';
              const version = art.meta.version as string || '';
              const author = art.meta.author as string || '';
              const tags = (art.meta.tags as string[]) ?? [];
              const category = art.meta.category as string || '';
              const icon = art.meta.icon as string | undefined;
              const skillUpdate = art.type === 'skill' ? updates[art.name] : undefined;

              return (
                <AssetCard
                  key={`${art.type}/${art.name}`}
                  type={art.type}
                  name={displayName}
                  description={description}
                  seed={art.name}
                  icon={icon}
                  author={null}
                  authorLabel={author || undefined}
                  version={skillUpdate ? skillUpdate.installedVersion : version}
                  category={category}
                  tags={tags}
                  installed={!skillUpdate}
                  hideStats
                  cornerLabel={skillUpdate ? t('installedTab.updateAvailable') : undefined}
                  onClick={() => {
                    if (art.path) setDetailItem({ type: art.type, name: art.name });
                  }}
                  actions={skillUpdate ? (
                    <button
                      type="button"
                      disabled={updating.has(art.name)}
                      onClick={() => void handleUpdate(art.name, skillUpdate.availableVersion)}
                      className="px-3 py-1.5 text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white rounded-lg disabled:opacity-50 transition-colors"
                    >
                      {updating.has(art.name)
                        ? t('installedTab.updating')
                        : t('installedTab.updateTo', { version: skillUpdate.availableVersion })}
                    </button>
                  ) : undefined}
                />
              );
            })}
          </Masonry>
        )}
      </div>

      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm shadow-lg ${
          toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
