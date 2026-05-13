import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { ArtifactDetail } from './ArtifactDetail.tsx';

interface InstalledArtifact {
  type: string;
  name: string;
  meta: Record<string, unknown>;
  path: string;
  updatedAt: string;
}

const TYPE_STYLES: Record<string, { icon: string; color: string; bg: string }> = {
  agent: { icon: '✦', color: 'text-brand-500', bg: 'bg-brand-500/10' },
  team: { icon: '◈', color: 'text-blue-600', bg: 'bg-blue-500/10' },
  skill: { icon: '⬡', color: 'text-green-600', bg: 'bg-green-500/10' },
};

function localizedField(meta: Record<string, unknown>, field: 'displayName' | 'description', lang: string): string | undefined {
  const i18n = meta.i18n as Record<string, Record<string, string>> | undefined;
  return i18n?.[lang]?.[field];
}

export function InstalledStore() {
  const { t, i18n } = useTranslation(['store', 'common']);
  const isMobile = useIsMobile();
  const lang = i18n.language;
  const [artifacts, setArtifacts] = useState<InstalledArtifact[]>([]);
  const [installedMap, setInstalledMap] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'agent' | 'team' | 'skill'>('all');
  const [detailItem, setDetailItem] = useState<{ type: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [artRes, instRes] = await Promise.all([
        api.builder.artifacts.list().catch(() => ({ artifacts: [] as InstalledArtifact[] })),
        api.builder.artifacts.installed().catch(() => ({ installed: {} as Record<string, unknown> })),
      ]);
      setInstalledMap(instRes.installed);
      const installed = artRes.artifacts.filter(a => {
        const key = `${a.type}/${a.name}`;
        return !!instRes.installed[key];
      });
      setArtifacts(installed);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const handler = () => void load();
    window.addEventListener('markus:data-changed', handler);
    return () => window.removeEventListener('markus:data-changed', handler);
  }, [load]);

  const filtered = artifacts.filter(a => {
    if (filterType !== 'all' && a.type !== filterType) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    const name = (localizedField(a.meta, 'displayName', lang) || a.meta.displayName as string || a.name).toLowerCase();
    const desc = (localizedField(a.meta, 'description', lang) || a.meta.description as string || '').toLowerCase();
    return name.includes(q) || desc.includes(q);
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
      <div className={`${isMobile ? 'px-4' : 'px-6'} h-14 flex items-center shrink-0`}>
        <h2 className="text-lg font-semibold">{t('installedTab.title')}</h2>
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(art => {
              const style = TYPE_STYLES[art.type] ?? TYPE_STYLES.agent;
              const displayName = localizedField(art.meta, 'displayName', lang) || art.meta.displayName as string || art.name;
              const description = localizedField(art.meta, 'description', lang) || art.meta.description as string || '';
              const version = art.meta.version as string || '';
              const author = art.meta.author as string || '';
              const tags = (art.meta.tags as string[]) ?? [];
              const category = art.meta.category as string || '';

              return (
                <div
                  key={`${art.type}/${art.name}`}
                  onClick={() => setDetailItem({ type: art.type, name: art.name })}
                  className="group relative bg-surface-secondary rounded-xl cursor-pointer transition-all duration-300 overflow-hidden hover:shadow-xl hover:shadow-brand-500/5 hover:-translate-y-0.5"
                >
                  <div className="absolute inset-0 rounded-xl border transition-colors duration-300 border-border-default group-hover:border-brand-500/30" />
                  <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-brand-500/40 to-transparent transition-opacity duration-300 opacity-0 group-hover:opacity-100" />

                  <div className="relative p-5">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`w-7 h-7 rounded-lg ${style.bg} flex items-center justify-center text-xs shrink-0 ${style.color}`}>{style.icon}</span>
                      <div className="font-semibold text-fg-primary truncate group-hover:text-brand-400 transition-colors">{displayName}</div>
                      {version && (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-medium shrink-0 bg-brand-500/15 text-brand-400 border border-brand-500/10">
                          v{version}
                        </span>
                      )}
                    </div>
                    {author && <div className="text-[11px] text-fg-tertiary mb-2">by {author}</div>}

                    <p className="text-sm text-fg-secondary line-clamp-2 leading-relaxed mb-3">{description}</p>

                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {category && (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-medium border capitalize bg-gray-500/15 text-fg-secondary border-gray-500/20">
                          {category}
                        </span>
                      )}
                      {tags.slice(0, 3).map(tag => (
                        <span key={tag} className="px-2 py-0.5 text-[10px] bg-surface-elevated/80 text-fg-secondary rounded-md border border-border-default/50">{tag}</span>
                      ))}
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-border-default/50">
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-medium capitalize ${style.bg} ${style.color}`}>{art.type}</span>
                      <span className="px-3 py-1.5 text-xs bg-green-500/10 text-green-500 rounded-lg border border-green-500/20 inline-flex items-center gap-1">
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                        {t('card.installed')}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
