import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api, wsClient, type DeliverableInfo, type ProjectInfo, type AgentInfo, type AuthUser } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { copyPlainText } from '../components/markdown-copy.ts';
import { ArtifactPreview, type BuilderMode } from '../components/BuilderArtifact.tsx';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { useResizablePanel } from '../hooks/useResizablePanel.ts';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';

const TYPE_META: Record<string, { icon: string; color: string }> = {
  file:      { icon: '\u{1F4C4}', color: 'bg-green-500/10 text-green-600' },
  directory: { icon: '\u{1F4C1}', color: 'bg-blue-500/10 text-blue-600' },
};

const STATUS_META: Record<string, { color: string }> = {
  active:   { color: 'text-green-600 bg-green-500/10' },
  verified: { color: 'text-blue-600 bg-blue-500/10' },
  outdated: { color: 'text-red-500 bg-red-500/10' },
};

const ALL_TYPES = ['file', 'directory'] as const;

const ARTIFACT_META: Record<string, { icon: string; color: string }> = {
  agent: { icon: '\u2726', color: 'bg-brand-500/10 text-brand-500' },
  team:  { icon: '\u25C8', color: 'bg-blue-500/10 text-blue-600' },
  skill: { icon: '\u2B21', color: 'bg-amber-500/10 text-amber-600' },
};

export function DeliverablesPage({ authUser: _authUser }: { authUser?: AuthUser } = {}) {
  const { t } = useTranslation(['deliverables', 'common']);
  const isMobile = useIsMobile();
  const listPanel = useResizablePanel({ side: 'left', defaultWidth: 384, minWidth: 280, maxWidth: 600, storageKey: 'markus_deliverables_list' });
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const mobileShowDetailRef = useRef(mobileShowDetail);
  mobileShowDetailRef.current = mobileShowDetail;

  useEffect(() => {
    if (!isMobile) return;
    const handler = () => {
      if (mobileShowDetailRef.current) {
        setMobileShowDetail(false);
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [isMobile]);

  const PAGE_SIZE = 100;
  const [items, setItems] = useState<DeliverableInfo[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [filterAgent, setFilterAgent] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterArtifact, setFilterArtifact] = useState('');
  const [groupBy, setGroupBy] = useState<'project' | 'agent' | 'date' | 'type'>('date');
  const [selected, setSelected] = useState<DeliverableInfo | null>(null);
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [actionLoading, setActionLoading] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const groupTabs = useMemo(() => [{ id: 'date' as const }, { id: 'project' as const }, { id: 'agent' as const }, { id: 'type' as const }], []);
  const handleGroupSwipe = useCallback((g: 'project' | 'agent' | 'date' | 'type') => { setGroupBy(g); setCollapsedGroups(new Set()); }, []);
  const groupSwipe = useSwipeTabs(groupTabs, groupBy, handleGroupSwipe);
  const listRef = useRef<HTMLDivElement>(null);

  // Create form
  const [newType, setNewType] = useState<string>('file');
  const [newTitle, setNewTitle] = useState('');
  const [newSummary, setNewSummary] = useState('');
  const [newReference, setNewReference] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [newTags, setNewTags] = useState('');

  // File preview
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showCopyPath, setShowCopyPath] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [sharedDir, setSharedDir] = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flashMsg = (type: 'success' | 'error', text: string) => {
    setFlash({ type, text });
    setTimeout(() => setFlash(null), 3000);
  };

  const copyPath = async (text: string) => {
    const ok = await copyPlainText(text);
    if (ok) {
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1500);
    } else {
      flashMsg('error', t('detail.copyFailed'));
    }
  };

  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const projectMap = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);

  useEffect(() => {
    api.projects.list().then(r => setProjects(r.projects)).catch(() => {});
    api.agents.list().then(r => setAgents(r.agents ?? [])).catch(() => {});
    api.system.storage().then(info => setSharedDir(info.dataDir + '/shared')).catch(() => {});
  }, []);

  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchQuery]);

  const searchParams = useMemo(() => ({
    q: debouncedQuery || undefined,
    projectId: filterProject || undefined,
    agentId: filterAgent || undefined,
    type: filterType || undefined,
    status: filterStatus || undefined,
    artifactType: filterArtifact || undefined,
  }), [debouncedQuery, filterProject, filterAgent, filterType, filterStatus, filterArtifact]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { results, total } = await api.deliverables.search({ ...searchParams, offset: 0, limit: PAGE_SIZE });
      setItems(results);
      setTotalCount(total);
    } catch { setItems([]); setTotalCount(0); }
    setLoading(false);
  }, [searchParams]);

  const loadMore = useCallback(async () => {
    if (loadingMore || items.length >= totalCount) return;
    setLoadingMore(true);
    try {
      const { results, total } = await api.deliverables.search({ ...searchParams, offset: items.length, limit: PAGE_SIZE });
      setItems(prev => [...prev, ...results]);
      setTotalCount(total);
    } catch { /* keep existing items */ }
    setLoadingMore(false);
  }, [searchParams, items.length, totalCount, loadingMore]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const unsub1 = wsClient.on('deliverable:created', () => refresh());
    const unsub2 = wsClient.on('deliverable:updated', () => refresh());
    const unsub3 = wsClient.on('deliverable:removed', () => refresh());
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [refresh]);

  const checkNeedMore = useCallback(() => {
    const el = listRef.current;
    if (!el || loading || loadingMore || items.length >= totalCount) return;
    if (el.scrollHeight <= el.clientHeight + 100) {
      loadMore();
    }
  }, [loading, loadingMore, items.length, totalCount, loadMore]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
        loadMore();
      }
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [loadMore]);

  useEffect(() => { checkNeedMore(); }, [checkNeedMore, collapsedGroups]);

  const grouped = useMemo(() => {
    const groups = new Map<string, { label: string; items: DeliverableInfo[] }>();
    for (const item of items) {
      let key: string;
      let label: string;
      if (groupBy === 'project') {
        key = item.projectId ?? '_none';
        label = item.projectId ? (projectMap.get(item.projectId)?.name ?? item.projectId) : t('noProject');
      } else if (groupBy === 'agent') {
        key = item.agentId ?? '_none';
        label = item.agentId ? (agentMap.get(item.agentId)?.name ?? item.agentId) : t('common:unknown');
      } else if (groupBy === 'type') {
        key = item.type;
        label = item.type.charAt(0).toUpperCase() + item.type.slice(1);
      } else {
        const d = new Date(item.updatedAt);
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        label = key;
      }
      if (!groups.has(key)) groups.set(key, { label, items: [] });
      groups.get(key)!.items.push(item);
    }
    const sorted = [...groups.entries()];
    if (groupBy === 'date') sorted.sort((a, b) => b[0].localeCompare(a[0]));
    else sorted.sort((a, b) => a[1].label.localeCompare(b[1].label));
    return sorted;
  }, [items, groupBy, projectMap, agentMap, t]);

  const handleCreate = async () => {
    if (!newTitle.trim() || !newSummary.trim()) return;
    setCreating(true);
    try {
      await api.deliverables.create({
        type: newType as DeliverableInfo['type'],
        title: newTitle,
        summary: newSummary,
        reference: newReference,
        projectId: newProjectId || undefined,
        tags: newTags.split(',').map(s => s.trim()).filter(Boolean),
      });
      setShowCreate(false);
      flashMsg('success', t('createModal.created'));
      refresh();
    } catch (e) { flashMsg('error', t('common:error', { message: String(e) })); }
    setCreating(false);
  };

  const handleVerify = async (d: DeliverableInfo) => {
    setActionLoading('verify');
    try {
      await api.deliverables.verify(d.id);
      flashMsg('success', t('common:verified'));
      setSelected({ ...d, status: 'verified' });
      refresh();
    } catch (e) { flashMsg('error', t('common:error', { message: String(e) })); }
    setActionLoading('');
  };

  const handleFlagOutdated = async (d: DeliverableInfo) => {
    setActionLoading('flag');
    try {
      await api.deliverables.update(d.id, { status: 'outdated' });
      flashMsg('success', t('flaggedOutdated'));
      setSelected({ ...d, status: 'outdated' });
      refresh();
    } catch (e) { flashMsg('error', t('common:error', { message: String(e) })); }
    setActionLoading('');
  };

  const handleRemove = async (d: DeliverableInfo) => {
    setActionLoading('remove');
    try {
      await api.deliverables.remove(d.id);
      flashMsg('success', t('removed'));
      setSelected(null);
      refresh();
    } catch (e) { flashMsg('error', t('common:error', { message: String(e) })); }
    setActionLoading('');
  };

  const handleOpenInBuilder = () => {
    navBus.navigate(PAGE.BUILDER);
  };

  const loadPreview = async (d: DeliverableInfo) => {
    if (!d.reference) return;
    if (d.type === 'directory') { setShowCopyPath(true); return; }

    setPreviewLoading(true);
    try {
      const resp = await api.files.preview(d.reference);
      if (resp.type === 'image' && resp.mimeType) {
        setPreviewImage({ src: `data:${resp.mimeType};base64,${resp.content}`, name: resp.name });
      } else {
        setPreviewContent(resp.content);
      }
    } catch {
      setPreviewContent(null);
      if (d.type === 'file') setShowCopyPath(true);
    }
    setPreviewLoading(false);
  };

  useEffect(() => {
    setPreviewContent(null);
    setPreviewImage(null);
    setShowCopyPath(false);
    if (selected) loadPreview(selected);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAllGroups = useCallback(() => {
    if (collapsedGroups.size === grouped.length) {
      setCollapsedGroups(new Set());
    } else {
      setCollapsedGroups(new Set(grouped.map(([key]) => key)));
    }
  }, [collapsedGroups.size, grouped]);

  const openContributeForm = () => {
    setNewTitle(''); setNewSummary(''); setNewReference(''); setNewTags('');
    setNewType('file');
    if (projects.length > 0) setNewProjectId(projects[0]!.id);
    setShowCreate(true);
  };

  const handleSelectItem = (item: DeliverableInfo) => {
    setSelected(item);
    if (isMobile) {
      setMobileShowDetail(true);
      history.pushState({ mobileDetail: PAGE.DELIVERABLES }, '', window.location.hash);
    }
  };

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* Left sidebar — always mounted on mobile to preserve scroll position */}
      <div className={`${isMobile ? 'flex-1 min-w-0' : 'shrink-0'} border-r border-border-default flex flex-col bg-surface-primary`}
        style={isMobile ? (mobileShowDetail ? { display: 'none' } : undefined) : { width: listPanel.width }}>
        <div className="p-4 border-b border-border-default space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg-secondary">
              {t('title')}{totalCount > 0 && <span className="ml-1.5 text-fg-tertiary font-normal">({totalCount})</span>}
            </h2>
            <button onClick={openContributeForm} className="text-xs px-2.5 py-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors">{t('create')}</button>
          </div>
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary focus:border-brand-500 focus:outline-none transition-colors"
          />
          {sharedDir && (
            <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-elevated/50 border border-border-default rounded-lg text-[10px] text-fg-tertiary">
              <span className="truncate font-mono">{sharedDir}</span>
              <button onClick={() => void api.system.openPath(sharedDir)}
                className="shrink-0 underline hover:text-fg-secondary transition-colors">{t('common:open')}</button>
            </div>
          )}
          {/* Type filter (includes artifact types) */}
          <div className="flex gap-1 overflow-x-auto scrollbar-hide">
            <FilterPill label={t('filters.allTypes')} value="" current={filterType || filterArtifact || ''} onClick={() => { setFilterType(''); setFilterArtifact(''); }} />
            {ALL_TYPES.map(ty => (
              <FilterPill key={ty} label={`${TYPE_META[ty]?.icon ?? ''} ${ty}`} value={ty} current={filterType} onClick={v => { setFilterType(v); setFilterArtifact(''); }} />
            ))}
            {(['agent', 'team', 'skill'] as const).map(a => (
              <FilterPill key={a} label={`${ARTIFACT_META[a].icon} ${t(`artifactTypes.${a}`)}`} value={a} current={filterArtifact} onClick={v => { setFilterArtifact(v); setFilterType(''); }} />
            ))}
          </div>
          {/* Project filter */}
          {projects.length > 0 && (
            <div className="flex gap-1 overflow-x-auto scrollbar-hide">
              <FilterPill label={t('filters.allProjects')} value="" current={filterProject} onClick={setFilterProject} />
              {projects.map(p => <FilterPill key={p.id} label={p.name} value={p.id} current={filterProject} onClick={setFilterProject} />)}
            </div>
          )}
          {/* Status filter */}
          <div className="flex gap-1 overflow-x-auto scrollbar-hide">
            <FilterPill label={t('filters.active')} value="" current={filterStatus} onClick={setFilterStatus} />
            <FilterPill label={t('filters.verified')} value="verified" current={filterStatus} onClick={setFilterStatus} />
            <FilterPill label={t('filters.outdated')} value="outdated" current={filterStatus} onClick={setFilterStatus} />
          </div>
          {/* Group by */}
          <div className="flex gap-1.5 items-center">
            <span className="text-[10px] text-fg-tertiary">{t('filters.group')}</span>
            {(['date', 'project', 'agent', 'type'] as const).map(g => (
              <button key={g} onClick={() => { setGroupBy(g); setCollapsedGroups(new Set()); }}
                className={`px-2 py-1 rounded text-xs transition-colors ${groupBy === g ? 'bg-brand-600 text-white' : 'bg-surface-elevated text-fg-secondary hover:bg-surface-overlay'}`}>
                {t(`groupBy.${g}`)}
              </button>
            ))}
            {grouped.length > 1 && (
              <button
                onClick={toggleAllGroups}
                className="ml-auto px-1.5 py-1 rounded text-[10px] text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated transition-colors"
                title={collapsedGroups.size === grouped.length ? t('expandAllTooltip') : t('collapseAllTooltip')}
              >
                {collapsedGroups.size === grouped.length ? t('expandAll') : t('collapseAll')}
              </button>
            )}
          </div>
        </div>

        {flash && (
          <div className={`mx-4 mt-2 px-3 py-1.5 text-xs rounded-lg ${flash.type === 'success' ? 'bg-green-500/15 text-green-600' : 'bg-red-500/15 text-red-500'}`}>{flash.text}</div>
        )}

        <div ref={listRef} className="flex-1 overflow-y-auto p-2 space-y-1" onTouchStart={isMobile ? groupSwipe.onTouchStart : undefined} onTouchEnd={isMobile ? groupSwipe.onTouchEnd : undefined}>
          {loading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="animate-pulse space-y-2">
                  <div className="h-4 bg-surface-elevated rounded w-3/4" />
                  <div className="h-3 bg-surface-elevated rounded w-1/2" />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <svg className="w-12 h-12 text-fg-muted mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              <p className="text-sm text-fg-secondary">{t('empty.title')}</p>
              <p className="text-xs text-fg-tertiary mt-1 mb-3">{t('empty.subtitle')}</p>
              <button onClick={openContributeForm} className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors">{t('empty.createFirst')}</button>
            </div>
          ) : grouped.map(([key, group]) => {
            const isCollapsed = collapsedGroups.has(key);
            return (
              <div key={key}>
                <button
                  onClick={() => toggleGroup(key)}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-surface-elevated/50 transition-colors group/header"
                >
                  <svg
                    className={`w-3 h-3 text-fg-tertiary transition-transform duration-200 shrink-0 ${isCollapsed ? '' : 'rotate-90'}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-[10px] font-medium text-fg-tertiary uppercase tracking-wider truncate">{group.label}</span>
                  <span className="text-[10px] text-fg-tertiary shrink-0">({group.items.length})</span>
                </button>
                {!isCollapsed && group.items.map(item => (
                  <button key={item.id} onClick={() => handleSelectItem(item)}
                    className={`w-full text-left p-3 rounded-lg transition-colors ${selected?.id === item.id ? 'bg-brand-600/20 border border-brand-500/30' : 'hover:bg-surface-elevated/60 border border-transparent'}`}>
                    <div className="text-sm font-medium text-fg-primary truncate">{item.title}</div>
                    <div className="flex items-center gap-2 mt-1">
                      {item.artifactType && ARTIFACT_META[item.artifactType] ? (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${ARTIFACT_META[item.artifactType].color}`}>
                          {ARTIFACT_META[item.artifactType].icon} {t(`artifactTypes.${item.artifactType}`)}
                        </span>
                      ) : (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium uppercase ${TYPE_META[item.type]?.color ?? 'bg-surface-overlay text-fg-secondary'}`}>{item.type}</span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_META[item.status]?.color ?? 'bg-surface-elevated text-fg-tertiary'}`}>{t(`common:status.${item.status}`, { defaultValue: item.status })}</span>
                      {item.agentId && <span className="text-[10px] text-fg-tertiary truncate">{agentMap.get(item.agentId)?.name ?? t('groupBy.agent')}</span>}
                    </div>
                  </button>
                ))}
              </div>
            );
          })}
          {loadingMore && (
            <div className="flex items-center justify-center gap-2 py-3 text-fg-tertiary">
              <Spinner /> <span className="text-[10px]">{t('common:loadingMore')}</span>
            </div>
          )}
          {!loading && items.length > 0 && (
            <div className="text-center text-[10px] text-fg-tertiary py-2">
              {items.length < totalCount
                ? t('count.partial', { loaded: items.length, total: totalCount })
                : t('count.total', { total: totalCount })}
            </div>
          )}
        </div>
      </div>

      {/* Resize handle */}
      {!isMobile && (
        <div className="w-1 shrink-0 cursor-col-resize hover:bg-brand-500/30 active:bg-brand-500/50 transition-colors" onMouseDown={listPanel.onResizeStart} />
      )}

      {/* Right detail panel */}
      {(!isMobile || mobileShowDetail) && (
      <div className="flex-1 overflow-y-auto min-w-0">
        {isMobile && (
          <div className="sticky top-0 z-10 bg-surface-secondary border-b border-border-default px-4 py-2.5 flex items-center gap-2">
            <button
              onClick={() => history.back()}
              className="text-fg-secondary hover:text-fg-primary transition-colors p-1 -ml-1"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            <span className="text-sm font-medium truncate">{selected?.title ?? t('detail.details')}</span>
          </div>
        )}
        {!selected ? (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center text-fg-tertiary space-y-2">
              <svg className="w-12 h-12 mx-auto text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              <p className="text-sm">{t('detail.selectToView')}</p>
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-5">
            {/* Header */}
            <div>
              <h2 className="text-xl font-semibold text-fg-primary">{selected.title}</h2>
              <div className="flex items-center gap-2 mt-2">
                {selected.status !== 'verified' && (
                  <button onClick={() => handleVerify(selected)} disabled={!!actionLoading}
                    className="px-3 py-1.5 text-xs rounded-lg bg-green-600/20 text-green-600 hover:bg-green-600/30 disabled:opacity-50 transition-colors">
                    {actionLoading === 'verify' ? t('common:verifying') : t('detail.verify')}
                  </button>
                )}
                {selected.status !== 'outdated' && (
                  <button onClick={() => handleFlagOutdated(selected)} disabled={!!actionLoading}
                    className="px-3 py-1.5 text-xs rounded-lg bg-amber-600/20 text-amber-600 hover:bg-amber-600/30 disabled:opacity-50 transition-colors">
                    {actionLoading === 'flag' ? t('detail.flagging') : t('detail.flagOutdated')}
                  </button>
                )}
                <button onClick={() => handleRemove(selected)} disabled={!!actionLoading}
                  className="px-3 py-1.5 text-xs rounded-lg bg-red-600/20 text-red-500 hover:bg-red-600/30 disabled:opacity-50 transition-colors">
                  {actionLoading === 'remove' ? t('common:removing') : t('common:remove')}
                </button>
              </div>
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <span className={`px-2 py-0.5 rounded text-xs font-medium uppercase ${TYPE_META[selected.type]?.color ?? 'bg-surface-overlay text-fg-secondary'}`}>{TYPE_META[selected.type]?.icon ?? ''} {selected.type}</span>
                <span className={`px-2 py-0.5 rounded text-xs ${STATUS_META[selected.status]?.color ?? 'bg-surface-elevated text-fg-tertiary'}`}>{t(`common:status.${selected.status}`, { defaultValue: selected.status })}</span>
                {selected.artifactType && ARTIFACT_META[selected.artifactType] && (
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${ARTIFACT_META[selected.artifactType].color}`}>
                    {ARTIFACT_META[selected.artifactType].icon} {t('detail.builderWithType', { type: t(`artifactTypes.${selected.artifactType}`) })}
                  </span>
                )}
              </div>
              {selected.reference && (selected.type === 'file' || selected.type === 'directory') && (
                <div className="flex items-center gap-2 mt-2 bg-surface-secondary/60 border border-border-default rounded-lg px-3 py-2">
                  <button
                    onClick={() => { api.files.reveal(selected.reference).catch(() => flashMsg('error', t('detail.failedToOpenBrowser'))); }}
                    className="text-xs font-mono text-brand-500 hover:text-brand-500 hover:underline truncate flex-1 text-left cursor-pointer"
                    title={t('detail.openInFileBrowser')}
                  >{selected.reference}</button>
                  <button
                    onClick={() => { api.files.reveal(selected.reference).catch(() => flashMsg('error', t('detail.failedToOpenBrowser'))); }}
                    className="px-2 py-1 text-[10px] rounded bg-brand-600/20 text-brand-500 hover:bg-brand-600/30 transition-colors shrink-0"
                    title={t('detail.revealInFinder')}
                  >{t('common:open')}</button>
                  <button
                    onClick={() => copyPath(selected.reference)}
                    className={`px-2 py-1 text-[10px] rounded transition-colors shrink-0 ${copiedPath ? 'bg-green-500/20 text-green-600' : 'bg-surface-overlay/50 text-fg-secondary hover:bg-surface-overlay'}`}
                    title={t('detail.copyPath')}
                  >{copiedPath ? t('common:copied') : t('common:copy')}</button>
                </div>
              )}
              {selected.reference && selected.type !== 'file' && selected.type !== 'directory' && (
                <div className="mt-2">
                  <span className="text-xs text-fg-tertiary font-mono break-all">{selected.reference}</span>
                </div>
              )}
            </div>

            {/* Preview area */}
            {selected.artifactType && selected.artifactData ? (
              <div className="space-y-4">
                <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
                  <ArtifactPreview artifact={selected.artifactData} mode={selected.artifactType as BuilderMode} />
                </div>
                {selected.reference && (
                  <div className="px-3 py-2 bg-surface-secondary/50 border border-border-default rounded-lg">
                    <span className="text-[10px] text-fg-tertiary uppercase tracking-wider block mb-1">{t('detail.artifactDirectory')}</span>
                    <span className="text-xs text-fg-secondary font-mono break-all">{selected.reference}</span>
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleOpenInBuilder}
                    className="flex-1 px-4 py-2.5 bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    {t('detail.openInBuilder')}
                  </button>
                </div>
                {selected.summary && (
                  <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
                    <MarkdownMessage content={selected.summary} className="text-fg-secondary text-sm" />
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
                {previewLoading ? (
                  <div className="flex items-center gap-2 text-fg-tertiary text-sm"><Spinner /> {t('detail.loadingPreview')}</div>
                ) : previewImage ? (
                  <div className="flex flex-col items-center gap-2">
                    <img src={previewImage.src} alt={previewImage.name} className="max-w-full max-h-[60vh] rounded-lg object-contain" />
                    <span className="text-xs text-fg-tertiary">{previewImage.name}</span>
                  </div>
                ) : previewContent ? (
                  <MarkdownMessage content={previewContent} className="text-fg-secondary text-sm" />
                ) : showCopyPath ? (
                  <div className="space-y-3">
                    <p className="text-sm text-fg-secondary">{t('detail.cannotPreview', { type: selected.type })}</p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { api.files.reveal(selected!.reference).catch(() => flashMsg('error', t('detail.failedToOpen'))); }}
                        className="text-xs bg-surface-elevated px-3 py-2 rounded text-brand-500 hover:text-brand-500 hover:underline flex-1 truncate text-left cursor-pointer font-mono"
                        title={t('detail.openInFileBrowser')}
                      >{selected.reference}</button>
                      <button onClick={() => { api.files.reveal(selected!.reference).catch(() => flashMsg('error', t('detail.failedToOpen'))); }}
                        className="px-3 py-2 text-xs rounded-lg bg-brand-600/20 text-brand-500 hover:bg-brand-600/30 transition-colors shrink-0">{t('common:open')}</button>
                      <button onClick={() => copyPath(selected!.reference)}
                        className={`px-3 py-2 text-xs rounded-lg transition-colors shrink-0 ${copiedPath ? 'bg-green-500/20 text-green-600' : 'bg-surface-overlay/50 text-fg-secondary hover:bg-surface-overlay'}`}>{copiedPath ? t('common:copied') : t('common:copy')}</button>
                    </div>
                  </div>
                ) : selected.summary ? (
                  <MarkdownMessage content={selected.summary} className="text-fg-secondary text-sm" />
                ) : (
                  <p className="text-sm text-fg-tertiary italic">{t('detail.noContent')}</p>
                )}
              </div>
            )}

            {/* Diff stats / test results */}
            {(selected.diffStats || selected.testResults) && (
              <div className="flex gap-4 flex-wrap">
                {selected.diffStats && (
                  <div className="bg-surface-secondary border border-border-default rounded-lg px-4 py-3 text-xs space-y-1">
                    <div className="text-fg-tertiary font-medium">{t('diffStats.title')}</div>
                    <div className="flex gap-3">
                      <span className="text-fg-secondary">{t('diffStats.files', { count: selected.diffStats.filesChanged })}</span>
                      <span className="text-green-600">+{selected.diffStats.additions}</span>
                      <span className="text-red-500">-{selected.diffStats.deletions}</span>
                    </div>
                  </div>
                )}
                {selected.testResults && (
                  <div className="bg-surface-secondary border border-border-default rounded-lg px-4 py-3 text-xs space-y-1">
                    <div className="text-fg-tertiary font-medium">{t('testResults.title')}</div>
                    <div className="flex gap-3">
                      <span className="text-green-600">{t('testResults.passed', { count: selected.testResults.passed })}</span>
                      <span className="text-red-500">{t('testResults.failed', { count: selected.testResults.failed })}</span>
                      <span className="text-fg-secondary">{t('testResults.skipped', { count: selected.testResults.skipped })}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Tags */}
            {selected.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selected.tags.map(tag => (
                  <span key={tag} className="px-2 py-0.5 text-xs bg-surface-elevated text-fg-secondary rounded">{tag}</span>
                ))}
              </div>
            )}

            {/* Association links */}
            <div className="border-t border-border-default pt-4 space-y-2">
              <div className="text-xs text-fg-tertiary font-medium">{t('links.title')}</div>
              <div className="flex gap-3 flex-wrap">
                {selected.taskId && (
                  <button onClick={() => navBus.navigate(PAGE.WORK, { openTask: selected.taskId! })}
                    className="text-xs text-brand-500 hover:underline bg-brand-500/10 px-2.5 py-1 rounded">
                    {t('links.task', { id: `${selected.taskId.slice(0, 12)}...` })}
                  </button>
                )}
                {selected.agentId && (
                  <button onClick={() => navBus.navigate(PAGE.TEAM, { selectAgent: selected.agentId! })}
                    className="text-xs text-blue-600 hover:underline bg-blue-500/10 px-2.5 py-1 rounded">
                    {t('links.agent', { name: agentMap.get(selected.agentId)?.name ?? selected.agentId.slice(0, 12) })}
                  </button>
                )}
                {selected.projectId && (
                  <button onClick={() => navBus.navigate(PAGE.WORK, { projectId: selected.projectId! })}
                    className="text-xs text-blue-600 hover:underline bg-blue-500/10 px-2.5 py-1 rounded">
                    {t('links.project', { name: projectMap.get(selected.projectId)?.name ?? selected.projectId.slice(0, 12) })}
                  </button>
                )}
              </div>
            </div>

            {/* Metadata */}
            <div className="text-xs text-fg-tertiary space-y-1 border-t border-border-default pt-4">
              <div className="flex gap-6 flex-wrap">
                <span>{t('metadata.created')} <span className="text-fg-secondary">{new Date(selected.createdAt).toLocaleString()}</span></span>
                <span>{t('metadata.updated')} <span className="text-fg-secondary">{new Date(selected.updatedAt).toLocaleString()}</span></span>
                <span>{t('metadata.accessed')} <span className="text-fg-secondary">{selected.accessCount}x</span></span>
              </div>
              <div className="text-fg-muted select-all">{t('metadata.id', { id: selected.id })}</div>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !creating && setShowCreate(false)}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[36rem] space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-fg-primary">{t('createModal.title')}</h3>

            <div>
              <label className="text-xs text-fg-tertiary block mb-1">{t('createModal.type')}</label>
              <select value={newType} onChange={e => setNewType(e.target.value)}
                className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary">
                {ALL_TYPES.map(ty => <option key={ty} value={ty}>{TYPE_META[ty]?.icon ?? ''} {ty}</option>)}
              </select>
            </div>

            <div>
              <label className="text-xs text-fg-tertiary block mb-1">{t('createModal.titleField')} <span className="text-red-500">{t('createModal.required')}</span></label>
              <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder={t('createModal.titlePlaceholder')}
                className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary focus:border-brand-500 focus:outline-none transition-colors" />
            </div>

            <div>
              <label className="text-xs text-fg-tertiary block mb-1">{t('createModal.reference')} <span className="text-fg-tertiary">({t('createModal.referenceHint')})</span></label>
              <input value={newReference} onChange={e => setNewReference(e.target.value)} placeholder={t('createModal.referencePlaceholder')}
                className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary focus:border-brand-500 focus:outline-none transition-colors font-mono" />
            </div>

            <div>
              <label className="text-xs text-fg-tertiary block mb-1">{t('createModal.summary')} <span className="text-red-500">{t('createModal.required')}</span> <span className="text-fg-tertiary">({t('createModal.summaryHint')})</span></label>
              <textarea value={newSummary} onChange={e => setNewSummary(e.target.value)}
                placeholder={t('createModal.summaryPlaceholder')}
                className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary h-36 resize-none focus:border-brand-500 focus:outline-none transition-colors font-mono" />
            </div>

            <div className="flex gap-4">
              <div className="flex-1">
                <label className="text-xs text-fg-tertiary block mb-1">{t('createModal.tags')} <span className="text-fg-tertiary">({t('createModal.tagsHint')})</span></label>
                <input value={newTags} onChange={e => setNewTags(e.target.value)} placeholder={t('createModal.tagsPlaceholder')}
                  className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary focus:border-brand-500 focus:outline-none transition-colors" />
              </div>
              <div className="flex-1">
                <label className="text-xs text-fg-tertiary block mb-1">{t('createModal.project')}</label>
                <select value={newProjectId} onChange={e => setNewProjectId(e.target.value)}
                  className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary">
                  <option value="">{t('common:none')}</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-1 border-t border-border-default">
              <button onClick={() => setShowCreate(false)} disabled={creating}
                className="text-sm text-fg-tertiary hover:text-fg-secondary disabled:opacity-50 transition-colors py-2">{t('common:cancel')}</button>
              <button onClick={handleCreate}
                disabled={creating || !newTitle.trim() || !newSummary.trim()}
                className="bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50 flex items-center gap-2 transition-colors">
                {creating && <Spinner />}
                {creating ? t('common:creating') : t('common:create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterPill({ label, value, current, onClick }: { label: string; value: string; current: string; onClick: (v: string) => void }) {
  return (
    <button
      onClick={() => onClick(current === value ? '' : value)}
      className={`px-2 py-1 rounded text-xs whitespace-nowrap shrink-0 transition-colors ${
        current === value ? 'bg-brand-600 text-white' : 'bg-surface-elevated text-fg-secondary hover:bg-surface-overlay'
      }`}
    >
      {label}
    </button>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
