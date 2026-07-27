import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hubApi, type HubItem } from '../api.ts';
import { AssetCard } from '../components/AssetCard.tsx';
import { Masonry } from '../components/Masonry.tsx';
import { CreatorAvatar } from '../components/AssetIdentity.tsx';
import {
  assetCoverGradient,
  formatCount,
  normalizeAssetType,
  ASSET_TYPE_META,
  type AssetType,
} from '../lib/assetIdentity.ts';

interface StoreDiscoveryProps {
  /** open the tab for a given asset type, optionally highlighting an item */
  onOpenType: (type: AssetType, itemId?: string) => void;
}

const TYPE_ORDER: AssetType[] = ['agent', 'team', 'skill', 'connector'];

function SectionHeader({ title, subtitle, onMore, moreLabel }: { title: string; subtitle?: string; onMore?: () => void; moreLabel?: string }) {
  return (
    <div className="flex items-end justify-between mb-3">
      <div>
        <h3 className="section-title">{title}</h3>
        {subtitle && <p className="section-subtitle">{subtitle}</p>}
      </div>
      {onMore && (
        <button className="section-link" onClick={onMore}>{moreLabel ?? 'View all'} →</button>
      )}
    </div>
  );
}

function FeaturedHero({ item, onOpen }: { item: HubItem; onOpen: () => void }) {
  const type = normalizeAssetType(item.subtype === 'connector' ? 'connector' : item.itemType);
  const gradient = assetCoverGradient(type, item.slug || item.name);
  const meta = ASSET_TYPE_META[type];
  return (
    <button
      onClick={onOpen}
      className="group relative w-full overflow-hidden rounded-2xl text-left h-44 md:h-52"
      style={{ background: gradient }}
    >
      <div className="absolute inset-0 bg-gradient-to-r from-black/55 via-black/20 to-transparent" />
      <svg className="absolute -right-8 -bottom-10 opacity-20" width="220" height="220" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M12 2l2.4 6.9L21 9l-5.4 4 2 7-5.6-4.1L6.4 20l2-7L3 9l6.6-.1z" fill="white" />
      </svg>
      <div className="relative h-full flex flex-col justify-end p-5 md:p-6">
        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-white/20 backdrop-blur px-2.5 py-0.5 text-[11px] font-semibold text-white mb-2">
          ★ Featured · {meta.label}
        </span>
        <h2 className="text-xl md:text-2xl font-bold text-white drop-shadow-sm">{item.name}</h2>
        <p className="text-sm text-white/85 truncate max-w-lg mt-1">{item.description}</p>
        <div className="flex items-center gap-3 mt-3 text-white/80 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <CreatorAvatar name={item.author?.displayName} username={item.author?.username} avatarUrl={item.author?.avatarUrl} hubBase={hubApi.getUrl()} size={18} />
            {item.author?.displayName || item.author?.username}
          </span>
          <span>↓ {formatCount(item.downloadCount)}</span>
          {(item.priceCents ?? 0) > 0 ? <span className="badge-paid">${((item.priceCents ?? 0) / 100).toFixed(0)}</span> : <span className="badge-free">Free</span>}
        </div>
      </div>
    </button>
  );
}

function Rail({ items, onOpen }: { items: HubItem[]; onOpen: (i: HubItem) => void }) {
  return (
    <Masonry columns={3}>
      {items.map((it) => (
        <AssetCard
          key={it.id}
          type={it.subtype === 'connector' ? 'connector' : it.itemType}
          name={it.name}
          description={it.description}
          seed={it.slug || it.name}
          icon={it.icon}
          cover={it.thumbnailUrl}
          hubBase={hubApi.getUrl()}
          author={it.author}
          category={it.category}
          tags={it.tags}
          rating={parseFloat(it.avgRating) || 0}
          ratingCount={it.ratingCount}
          downloadCount={it.downloadCount}
          priceCents={it.priceCents}
          currency={it.currency}
          onClick={() => onOpen(it)}
        />
      ))}
    </Masonry>
  );
}

function RailSkeleton() {
  return (
    <Masonry columns={3}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-64 rounded-2xl skeleton" />
      ))}
    </Masonry>
  );
}

export function StoreDiscovery({ onOpenType }: StoreDiscoveryProps) {
  const { t } = useTranslation(['store', 'common']);
  const [items, setItems] = useState<HubItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await hubApi.search({ limit: 60, sort: 'popular' });
        if (!cancelled) setItems(res.items ?? []);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const featured = useMemo(() => {
    const f = items.filter((i) => i.featured);
    const pool = f.length > 0 ? f : items;
    return pool.slice(0, 3);
  }, [items]);

  const trending = useMemo(
    () => [...items].sort((a, b) => (b.trendingScore ?? b.downloadCount) - (a.trendingScore ?? a.downloadCount)).slice(0, 10),
    [items],
  );

  const fresh = useMemo(
    () => [...items].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 10),
    [items],
  );

  const topCreators = useMemo(() => {
    const map = new Map<string, { author: HubItem['author']; downloads: number; count: number }>();
    for (const it of items) {
      const key = it.author?.username || it.author?.id;
      if (!key) continue;
      const cur = map.get(key) ?? { author: it.author, downloads: 0, count: 0 };
      cur.downloads += it.downloadCount || 0;
      cur.count += 1;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.downloads - a.downloads).slice(0, 6);
  }, [items]);

  const openItem = (it: HubItem) => onOpenType(normalizeAssetType(it.subtype === 'connector' ? 'connector' : it.itemType), it.id);

  return (
    <div className="flex-1 overflow-y-auto px-5 md:px-7 py-5 space-y-8">
      {/* Hero band */}
      <div className="hero-glow rounded-2xl border border-border-subtle bg-surface-secondary p-5 md:p-6">
        <h1 className="text-2xl font-bold text-gradient tracking-tight">{t('discover.title', 'Markus 广场')}</h1>
        <p className="text-sm text-fg-tertiary mt-1 max-w-2xl">
          {t('discover.subtitle', '发现社区共享的智能体、AI 小队、技能与连接器 — 由创作者共建的开放生态。')}
        </p>
        <div className="flex flex-wrap gap-2 mt-4">
          {TYPE_ORDER.map((tp) => (
            <button
              key={tp}
              onClick={() => onOpenType(tp)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-white bg-gradient-to-r ${ASSET_TYPE_META[tp].gradient} hover:opacity-90 transition-opacity`}
            >
              {ASSET_TYPE_META[tp].labelZh}
              <span className="opacity-70">{ASSET_TYPE_META[tp].label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Featured */}
      {loading ? (
        <div className="h-52 rounded-2xl skeleton" />
      ) : featured.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {featured.map((it) => (
            <FeaturedHero key={it.id} item={it} onOpen={() => openItem(it)} />
          ))}
        </div>
      ) : null}

      {/* Trending */}
      <section>
        <SectionHeader
          title={t('discover.trending', '热门趋势')}
          subtitle={t('discover.trendingSub', '社区中下载与评分增长最快的资产')}
        />
        {loading ? <RailSkeleton /> : trending.length > 0 ? <Rail items={trending} onOpen={openItem} /> : <EmptyHint />}
      </section>

      {/* New arrivals */}
      <section>
        <SectionHeader title={t('discover.fresh', '新鲜上架')} subtitle={t('discover.freshSub', '来自创作者的最新作品')} />
        {loading ? <RailSkeleton /> : fresh.length > 0 ? <Rail items={fresh} onOpen={openItem} /> : null}
      </section>

      {/* Top creators */}
      {topCreators.length > 0 && (
        <section>
          <SectionHeader title={t('discover.topCreators', '顶尖创作者')} subtitle={t('discover.topCreatorsSub', '生态贡献榜')} />
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {topCreators.map((c, idx) => (
              <div key={c.author?.username || idx} className="asset-card p-4 flex flex-col items-center text-center">
                <div className="relative">
                  <CreatorAvatar name={c.author?.displayName} username={c.author?.username} avatarUrl={c.author?.avatarUrl} hubBase={hubApi.getUrl()} size={48} verified={idx < 3} />
                  {idx < 3 && (
                    <span className="absolute -top-1 -left-1 w-5 h-5 rounded-full bg-amber-400 text-black text-[10px] font-bold flex items-center justify-center ring-2 ring-surface-secondary">
                      {idx + 1}
                    </span>
                  )}
                </div>
                <div className="text-sm font-semibold text-fg-primary truncate w-full mt-2">{c.author?.displayName || c.author?.username}</div>
                <div className="text-[11px] text-fg-tertiary mt-0.5">{c.count} 作品 · ↓ {formatCount(c.downloads)}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function EmptyHint() {
  const { t } = useTranslation(['store']);
  return (
    <div className="text-center py-12 rounded-2xl border border-dashed border-border-default">
      <div className="text-3xl mb-2 opacity-40">✦</div>
      <div className="text-fg-secondary font-medium">{t('discover.empty', '生态正在成长中')}</div>
      <div className="text-fg-tertiary text-sm mt-1">{t('discover.emptyHint', '成为首批创作者，分享你的第一个资产')}</div>
    </div>
  );
}
