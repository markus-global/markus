import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api, wsClient, getHubToken, hubApi, type DeliverableInfo, type ProjectInfo, type AgentInfo, type TeamInfo, type AuthUser } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { ContentRenderer, resolveFormat, type HtmlSelectionData } from '../components/ContentRenderer.tsx';
import { OfficePreviewer } from '../components/OfficePreviewer.tsx';
import { copyPlainText } from '../components/markdown-copy.ts';
import { ArtifactPreview, type BuilderMode } from '../components/BuilderArtifact.tsx';
import { DeliverableShareModal } from '../components/DeliverableShareModal.tsx';
import { createDeliverableShareService, canShareDeliverableFormat, type DeliverableShareRecord } from '../lib/deliverableShare.ts';
import { navBus } from '../navBus.ts';
import { PAGE, resolvePageId } from '../routes.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { usePageActive } from '../hooks/usePageActive.ts';
import { MobileMenuButton } from '../components/MobileMenuButton.tsx';
import { useResizablePanel } from '../hooks/useResizablePanel.ts';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { useLayout } from '../contexts/LayoutContext.tsx';
import { isEditableTarget } from '../lib/keyboard-shortcuts.ts';

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

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** 分享状态（未分享返回 null）。 */
function shareStatusOf(d: { shareStatus?: string | null } | null): string | null {
  return d?.shareStatus ?? null;
}

function relativeTime(dateStr: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('time.justNow');
  if (mins < 60) return t('time.minutesAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('time.hoursAgo', { count: hrs });
  const days = Math.floor(hrs / 24);
  if (days === 1) return t('time.yesterday');
  if (days < 30) return t('time.daysAgo', { count: days });
  const months = Math.floor(days / 30);
  if (months < 12) return t('time.monthsAgo', { count: months });
  return t('time.yearsAgo', { count: Math.floor(months / 12) });
}

const ARTIFACT_META: Record<string, { icon: string; color: string }> = {
  agent: { icon: '\u2726', color: 'bg-brand-500/10 text-brand-500' },
  team:  { icon: '\u25C8', color: 'bg-blue-500/10 text-blue-600' },
  skill: { icon: '\u2B21', color: 'bg-amber-500/10 text-amber-600' },
};

export interface DeliverablesPreviewData {
  items?: DeliverableInfo[];
  projects?: ProjectInfo[];
  agents?: AgentInfo[];
  initialSelectedId?: string;
}

export function DeliverablesPage({ authUser: _authUser, previewMode, previewData }: { authUser?: AuthUser; previewMode?: boolean; previewData?: DeliverablesPreviewData } = {}) {
  const { t } = useTranslation(['deliverables', 'common']);
  const isMobile = useIsMobile();
  const isActive = usePageActive(PAGE.DELIVERABLES);
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

  const DATE_PAGE_SIZE = 100;
  const ALL_ITEMS_LIMIT = 5000;
  const [items, setItems] = useState<DeliverableInfo[]>(previewData?.items ?? []);
  const [totalCount, setTotalCount] = useState(previewData?.items?.length ?? 0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>(previewData?.projects ?? []);
  const [agents, setAgents] = useState<AgentInfo[]>(previewData?.agents ?? []);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [loading, setLoading] = useState(previewData ? false : true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterArtifact, setFilterArtifact] = useState('');
  const [filterSource, setFilterSource] = useState<'agent' | 'knowledge' | ''>('');
  const [filterProject, setFilterProject] = useState('');
  const [bindOpen, setBindOpen] = useState(false);
  const [groupBy, setGroupBy] = useState<'project' | 'agent' | 'date' | 'team'>('date');
  const [selected, setSelected] = useState<DeliverableInfo | null>(() => {
    if (previewData?.initialSelectedId && previewData.items) {
      return previewData.items.find(d => d.id === previewData.initialSelectedId) ?? previewData.items[0] ?? null;
    }
    return previewData?.items?.[0] ?? null;
  });
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [actionLoading, setActionLoading] = useState('');
  const [defaultCollapsed, setDefaultCollapsed] = useState(true);
  const [groupOverrides, setGroupOverrides] = useState<Set<string>>(() => {
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return new Set([todayKey]);
  });
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const groupTabs = useMemo(() => [{ id: 'date' as const }, { id: 'project' as const }, { id: 'team' as const }, { id: 'agent' as const }], []);
  const handleGroupSwipe = useCallback((g: 'project' | 'agent' | 'date' | 'team') => { setGroupBy(g); }, []);
  const groupSwipe = useSwipeTabs(groupTabs, groupBy, handleGroupSwipe);
  const listRef = useRef<HTMLDivElement>(null);

  // File preview
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewFormat, setPreviewFormat] = useState<string>('markdown');
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const [previewMedia, setPreviewMedia] = useState<{ kind: 'audio' | 'video'; src: string; name: string } | null>(null);
  const [previewOffice, setPreviewOffice] = useState<{ format: string; streamUrl: string; name: string; size?: number; reference?: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showCopyPath, setShowCopyPath] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<DeliverableInfo | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [sharedDir, setSharedDir] = useState('');
  const [missingFileIds, setMissingFileIds] = useState<Set<string>>(new Set());

  // Sidebar collapse (Phase 2)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const layout = useLayout();
  const keyboardPane = layout?.keyboardPane ?? 'content';

  // Selection toolbar (Phase 4)
  const [selectionToolbar, setSelectionToolbar] = useState<{ x: number; y: number; text: string; htmlMeta?: { xpath: string; cssSelector: string } } | null>(null);

  // In-place editing (Phase 5)
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editDirty, setEditDirty] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [unsavedDialog, setUnsavedDialog] = useState<{ action: () => void } | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResizeTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, []);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    autoResizeTextarea(editTextareaRef.current);
  }, [editContent, editMode, autoResizeTextarea]);

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
  const teamMap = useMemo(() => new Map(teams.map(tm => [tm.id, tm])), [teams]);

  const resolveProjectName = useCallback((projectId: string | undefined): string | null => {
    if (!projectId || projectId === 'default') return null;
    const name = projectMap.get(projectId)?.name;
    if (!name || name === 'default') return null;
    return name;
  }, [projectMap]);

  useEffect(() => {
    if (previewMode) return;
    api.projects.list().then(r => setProjects(r.projects)).catch(() => {});
    api.agents.list().then(r => setAgents(r.agents ?? [])).catch(() => {});
    api.teams.list().then(r => setTeams(r.teams ?? [])).catch(() => {});
    api.system.storage().then(info => setSharedDir(info.dataDir + '/shared')).catch(() => {});
    api.deliverables.checkHealth().then(r => setMissingFileIds(new Set(r.missingFiles))).catch(() => {});
  }, [previewMode]);

  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchQuery]);

  const searchParams = useMemo(() => ({
    q: debouncedQuery || undefined,
    projectId: filterProject || undefined,
    type: filterType || undefined,
    artifactType: filterArtifact || undefined,
    source: filterSource || undefined,
  }), [debouncedQuery, filterType, filterArtifact, filterProject, filterSource]);

  const fetchLimit = groupBy === 'date' ? DATE_PAGE_SIZE : ALL_ITEMS_LIMIT;

  /** 静默刷新：不触发 setLoading / 不滚动到顶（避免 L1 侧边栏闪烁）。用于元数据类变更（如分享状态）。 */
  const mergeKeepShare = useCallback((prev: DeliverableInfo, fresh?: DeliverableInfo): DeliverableInfo => {
    if (!fresh) return prev;
    // 后端若未持久化分享字段（本地回写失败/尚未同步），保留前端已有值，避免“已分享”状态被清空
    return {
      ...fresh,
      hubShareId: fresh.hubShareId != null ? fresh.hubShareId : prev.hubShareId ?? null,
      shareStatus: fresh.shareStatus != null ? fresh.shareStatus : prev.shareStatus ?? null,
      shareUrl: fresh.shareUrl != null ? fresh.shareUrl : prev.shareUrl ?? null,
      shareVisibility: fresh.shareVisibility != null ? fresh.shareVisibility : prev.shareVisibility ?? null,
      shareReason: fresh.shareReason != null ? fresh.shareReason : prev.shareReason,
    };
  }, []);

  const silentRefresh = useCallback(async () => {
    try {
      const { results, total } = await api.deliverables.search({ ...searchParams, offset: 0, limit: fetchLimit });
      setItems(prev => prev.map(it => {
        const fresh = results.find(r => r.id === it.id);
        return fresh ? mergeKeepShare(it, fresh) : it;
      }));
      setTotalCount(total);
      setSelected(prev => {
        if (!prev) return null;
        const fresh = results.find(r => r.id === prev.id);
        return fresh ? mergeKeepShare(prev, fresh) : prev;
      });
    } catch { /* 静默失败，保持现有状态 */ }
  }, [searchParams, fetchLimit, mergeKeepShare]);

  const refresh = useCallback(async () => {
    setLoading(true);
    listRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    try {
      const { results, total } = await api.deliverables.search({ ...searchParams, offset: 0, limit: fetchLimit });
      setItems(results);
      setTotalCount(total);
      setSelected(prev => {
        if (!prev) return null;
        if (results.some(r => r.id === prev.id)) return prev;
        return null;
      });
    } catch { setItems([]); setTotalCount(0); setSelected(null); }
    setLoading(false);
  }, [searchParams, fetchLimit]);

  const loadMore = useCallback(async () => {
    if (loadingMore || items.length >= totalCount) return;
    setLoadingMore(true);
    try {
      const { results, total } = await api.deliverables.search({ ...searchParams, offset: items.length, limit: fetchLimit });
      setItems(prev => [...prev, ...results]);
      setTotalCount(total);
    } catch { /* keep existing items */ }
    setLoadingMore(false);
  }, [searchParams, fetchLimit, items.length, totalCount, loadingMore]);

  useEffect(() => { if (previewMode) return; refresh(); }, [refresh, previewMode]);

  useEffect(() => {
    if (!previewMode || !previewData) return;
    setItems(previewData.items ?? []);
    setTotalCount(previewData.items?.length ?? 0);
    setProjects(previewData.projects ?? []);
    setAgents(previewData.agents ?? []);
    if (previewData.initialSelectedId) {
      setSelected(previewData.items?.find(d => d.id === previewData.initialSelectedId) ?? previewData.items?.[0] ?? null);
    }
  }, [previewMode, previewData]);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    if (previewMode) return;
    if (!isActive) return;
    const unsub1 = wsClient.on('deliverable:created', () => refresh());
    const unsub2 = wsClient.on('deliverable:updated', (event) => {
      silentRefresh();
      const updatedId = event.payload?.deliverableId as string | undefined;
      if (updatedId && selectedRef.current?.id === updatedId) {
        api.deliverables.get(updatedId).then(r => {
          if (r.deliverable) {
            setSelected(prev => ({
              ...(prev ?? r.deliverable),
              ...r.deliverable,
              hubShareId: (prev?.hubShareId ?? r.deliverable.hubShareId) ?? null,
              shareStatus: (prev?.shareStatus ?? r.deliverable.shareStatus) ?? null,
              shareUrl: (prev?.shareUrl ?? r.deliverable.shareUrl) ?? null,
              shareVisibility: (prev?.shareVisibility ?? r.deliverable.shareVisibility) ?? null,
              shareReason: (prev?.shareReason ?? r.deliverable.shareReason) ?? null,
            }));
            loadPreview(r.deliverable);
          }
        }).catch(() => {});
      }
    });
    const unsub3 = wsClient.on('deliverable:removed', () => refresh());
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [silentRefresh, isActive, previewMode]);

  // 页面级 Hub 分享状态同步：不依赖分享弹窗常驻，页面可见期间周期性从 Hub 拉取
  // 当前用户的全部分享状态，把 moderationStatus（pending/published/rejected）映射回
  // 本地 items + selected，并回写本地 DB。这样管理员在 Hub 批准/拒绝后，客户端在不
  // 重新打开弹窗的情况下也能自动更新按钮/徽标（对齐资产 ArtifactDetail 的加载即同步模式）。
  const shareSyncService = useMemo(
    () => createDeliverableShareService(getHubToken, hubApi.getUrl()),
    [],
  );
  useEffect(() => {
    if (previewMode) return;
    if (!isActive) return;
    if (!getHubToken()) return; // 未登录 Hub 不轮询
    let cancelled = false;
    const run = async () => {
      try {
        const records = await shareSyncService.listMine();
        if (cancelled) return;
        // 按 hubShareId 或本地 id 映射到列表项
        const byShareId = new Map<string, DeliverableShareRecord>();
        const byLocalId = new Map<string, DeliverableShareRecord>();
        for (const r of records) {
          if (r.id) byShareId.set(r.id, r);
          if (r.localId) byLocalId.set(r.localId, r);
        }
        const patches = new Map<string, { hubShareId: string | null; shareStatus: string | null; shareUrl: string | null; shareVisibility: string | null; shareReason?: string | null }>();
        setItems(prev => prev.map(it => {
          const rec = (it.hubShareId && byShareId.get(it.hubShareId)) || byLocalId.get(it.id);
          if (!rec) return it;
          const patch = {
            hubShareId: it.hubShareId ?? rec.id ?? null,
            shareStatus: rec.status ?? null,
            shareUrl: rec.url ?? null,
            shareVisibility: it.shareVisibility ?? rec.visibility ?? null,
            ...(rec.reason != null ? { shareReason: rec.reason } : {}),
          };
          patches.set(it.id, patch);
          return { ...it, ...patch };
        }));
        // 更新 selected（若其状态变化）
        setSelected(prev => {
          if (!prev) return prev;
          const patch = patches.get(prev.id);
          if (!patch) return prev;
          return { ...prev, ...patch };
        });
        // 回写本地 DB 持久化（静默，不触发列表 loading；失败仅告警，下轮轮询重试）
        for (const [id, patch] of patches) {
          void api.deliverables.update(id, patch).catch((err) => {
            console.warn('[deliverables] Hub 分享状态本地持久化失败:', err);
          });
        }
      } catch {
        /* Hub 未就绪/网络失败：静默，下轮重试 */
      }
    };
    run();
    const timer = setInterval(run, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [shareSyncService, isActive, previewMode]);

  // Handle deep navigation to a specific deliverable
  const pendingOpenRef = useRef<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const openDeliverableById = useCallback((id: string) => {
    const showDetail = (item: DeliverableInfo) => {
      setSelected(item);
      if (isMobile) {
        setMobileShowDetail(true);
        history.pushState({ mobileDetail: PAGE.DELIVERABLES }, '', window.location.hash);
      }
    };
    const found = itemsRef.current.find(d => d.id === id);
    if (found) { showDetail(found); return; }
    api.deliverables.get(id).then(r => { if (r.deliverable) showDetail(r.deliverable); }).catch(() => {});
  }, [isMobile]);

  useEffect(() => {
    if (previewMode) return;
    // Support deep links of the form `#deliverables/<id>` (e.g. from a deliverable
    // tool's accessUrl). The page id is the first hash segment; the second is the id.
    const hashParts = window.location.hash.slice(1).split('/');
    const hashId = resolvePageId(hashParts[0]) === PAGE.DELIVERABLES ? hashParts[1] : undefined;
    // Navigation params from a previous page (e.g. project detail「在产出物中查看」):
    // projectId + source filter, and openDeliverable deep-link.
    const navProjectId = localStorage.getItem('markus_nav_projectId');
    const navSource = localStorage.getItem('markus_nav_source');
    if (navProjectId) {
      localStorage.removeItem('markus_nav_projectId');
      setFilterProject(navProjectId);
    }
    if (navSource === 'knowledge' || navSource === 'agent') {
      localStorage.removeItem('markus_nav_source');
      setFilterSource(navSource);
    }
    const navId = localStorage.getItem('markus_nav_openDeliverable') || hashId;
    if (navId) {
      localStorage.removeItem('markus_nav_openDeliverable');
      if (itemsRef.current.length > 0) {
        openDeliverableById(navId);
      } else {
        pendingOpenRef.current = navId;
      }
    }
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const p = detail?.params as Record<string, string> | undefined;
      if (p?.projectId) setFilterProject(p.projectId);
      if (p?.source === 'knowledge' || p?.source === 'agent') setFilterSource(p.source);
      if (p?.openDeliverable) {
        localStorage.removeItem('markus_nav_openDeliverable');
        openDeliverableById(p.openDeliverable);
      }
    };
    window.addEventListener('markus:navigate', handler);
    return () => window.removeEventListener('markus:navigate', handler);
  }, [openDeliverableById, previewMode]);

  useEffect(() => {
    const id = pendingOpenRef.current;
    if (!id || items.length === 0) return;
    pendingOpenRef.current = null;
    openDeliverableById(id);
  }, [items, openDeliverableById]);

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

  useEffect(() => { checkNeedMore(); }, [checkNeedMore, defaultCollapsed, groupOverrides]);

  const grouped = useMemo(() => {
    const groups = new Map<string, { label: string; items: DeliverableInfo[] }>();
    for (const item of items) {
      let key: string;
      let label: string;
      if (groupBy === 'project') {
        const pName = resolveProjectName(item.projectId);
        key = pName ? (item.projectId ?? '_none') : '_none';
        label = pName ?? t('noProject');
      } else if (groupBy === 'team') {
        const agent = item.agentId ? agentMap.get(item.agentId) : undefined;
        const tId = agent?.teamId ?? '_none';
        key = tId;
        label = tId !== '_none' ? (teamMap.get(tId)?.name ?? tId) : t('noTeam');
      } else if (groupBy === 'agent') {
        key = item.agentId ?? '_none';
        label = item.agentId ? (agentMap.get(item.agentId)?.name ?? item.agentId) : t('common:unknown');
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
  }, [items, groupBy, projectMap, agentMap, teamMap, t]);

  useEffect(() => {
    if (groupBy === 'date' && defaultCollapsed) {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      setGroupOverrides(new Set([todayKey]));
    } else {
      setGroupOverrides(new Set());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupBy]);

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

  // 分享到 Hub 结果回调：把分享字段写回 selected + 列表项（撑状态徽标/列表标识即时刷新）。
  // 同时回写本地 DB（PUT），避免 ws deliverable:updated / refresh 用无分享字段的后端对象覆盖按钮状态。
  // 分享操作的对象就是当前 selected（弹窗对 selected 操作），故本地 id 取 selected.id。
  const onShareResult = useCallback((r: DeliverableShareRecord) => {
    const selectedNow = selectedRef.current;
    const id = selectedNow?.id;
    if (!id) return;
    const patch = {
      hubShareId: r.id ?? null,
      shareStatus: r.status ?? null,
      shareUrl: r.url ?? null,
      shareVisibility: r.visibility ?? null,
      ...(r.reason != null || r.status === 'rejected' ? { shareReason: r.reason ?? selectedNow?.shareReason ?? null } : {}),
    };
    const filled = { ...patch, shareStatus: patch.shareStatus ?? selectedNow?.shareStatus ?? null };
    // 更新 selected：分享字段即时生效（按钮变色、徽标出现）
    setSelected(prev => (prev && prev.id === id) ? { ...prev, ...filled } : prev);
    // 同步更新列表项对应项，不触发整表 setLoading 刷新（避免 L1 侧边栏闪烁）
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...filled } : it));
    // 静默回写本地 DB；失败不影响 UI（分享状态已在 Hub）——再静默拉取对齐后端。
    // 若回写失败，页面轮询（shareSyncService）会在 30s 内从 Hub 拉取并将状态写回本地 DB。
    void (async () => {
      try {
        await api.deliverables.update(id, patch);
      } catch (err) {
        console.warn('[deliverables] 分享状态本地回写失败，将由 Hub 轮询补偿:', err);
      }
      silentRefresh();
    })();
  }, [silentRefresh]);

  const handleOpenInBuilder = () => {
    navBus.navigate(PAGE.BUILDER);
  };

  const loadPreview = async (d: DeliverableInfo) => {
    if (!d.reference) return;
    if (isUrl(d.reference)) return;
    if (d.type === 'directory') { setShowCopyPath(true); return; }

    setPreviewLoading(true);
    try {
      const resp = await api.files.preview(d.reference);
      if (resp.type === 'image' && resp.mimeType) {
        // 后端图片返回 streamUrl（不走 base64，防超大文件撑爆 inline 上限）
        const src = resp.streamUrl
          || (resp.path ? api.files.streamUrl(resp.path) : api.files.streamUrl(d.reference));
        setPreviewImage({ src, name: resp.name });
      } else if (resp.type === 'audio' || resp.type === 'video') {
        const src = resp.streamUrl
          || (resp.path ? api.files.streamUrl(resp.path) : api.files.streamUrl(d.reference));
        setPreviewMedia({ kind: resp.type, src, name: resp.name });
      } else if (resp.type === 'office') {
        const src = resp.streamUrl
          || (resp.path ? api.files.streamUrl(resp.path) : api.files.streamUrl(d.reference));
        setPreviewOffice({
          format: resp.format || String(resp.extension || '').replace(/^\./, '') || 'pdf',
          streamUrl: src,
          name: resp.name,
          size: resp.size,
          reference: resp.path || d.reference,
        });
      } else if (resp.type === 'binary') {
        setShowCopyPath(true);
      } else if (typeof resp.content === 'string') {
        setPreviewContent(resp.content);
        setPreviewFormat(resolveFormat({ format: d.format, reference: d.reference, content: resp.content }));
      } else {
        setShowCopyPath(true);
      }
    } catch {
      setPreviewContent(null);
      if (d.type === 'file') setShowCopyPath(true);
    }
    setPreviewLoading(false);
  };

  useEffect(() => {
    if (previewMode) return;
    setPreviewContent(null);
    setPreviewFormat('markdown');
    setPreviewImage(null);
    setPreviewMedia(null);
    setPreviewOffice(null);
    setShowCopyPath(false);
    if (selected) loadPreview(selected);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, previewMode]);

  const isGroupCollapsed = useCallback((key: string) => {
    return defaultCollapsed !== groupOverrides.has(key);
  }, [defaultCollapsed, groupOverrides]);

  const allGroupsCollapsed = grouped.length > 0 && grouped.every(([key]) => isGroupCollapsed(key));

  const toggleGroup = useCallback((key: string) => {
    setGroupOverrides(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Force a group open regardless of the current default. A group is expanded
  // when its override-membership equals `defaultCollapsed`, so we add/remove the
  // key accordingly (no-op if it is already expanded).
  const expandGroup = useCallback((key: string) => {
    setGroupOverrides(prev => {
      if (prev.has(key) === defaultCollapsed) return prev;
      const next = new Set(prev);
      if (defaultCollapsed) next.add(key);
      else next.delete(key);
      return next;
    });
  }, [defaultCollapsed]);

  const toggleAllGroups = useCallback(() => {
    setDefaultCollapsed(prev => !prev);
    setGroupOverrides(new Set());
  }, []);

  const hasActiveFilters = !!(filterType || filterArtifact || filterSource || filterProject || debouncedQuery);

  const clearAllFilters = useCallback(() => {
    setFilterType('');
    setFilterArtifact('');
    setFilterSource('');
    setFilterProject('');
    setSearchQuery('');
    setDebouncedQuery('');
  }, []);

  const flatItems = useMemo(() => grouped.flatMap(([, g]) => g.items), [grouped]);

  // Desktop: auto-select the most recent deliverable so the detail pane shows
  // useful content on load instead of a large empty state. Never on mobile
  // (would push into the detail view) and never over a deep-linked/pending pick.
  useEffect(() => {
    if (previewMode || isMobile || loading || selected) return;
    if (pendingOpenRef.current) return;
    if (flatItems.length === 0) return;
    setSelected(flatItems[0]);
  }, [previewMode, isMobile, loading, selected, flatItems]);

  // Reveal the selected deliverable in the list by expanding its group, so the
  // user can always see which item is currently shown in the detail pane. Only
  // fires when the selection changes (not on every group toggle) so manually
  // collapsing the active group is respected.
  const lastRevealedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) { lastRevealedRef.current = null; return; }
    if (lastRevealedRef.current === selected.id) return;
    const entry = grouped.find(([, g]) => g.items.some(it => it.id === selected.id));
    if (!entry) return; // item not in the loaded groups yet
    lastRevealedRef.current = selected.id;
    expandGroup(entry[0]);
  }, [selected?.id, grouped, expandGroup]);

  const searchInputRef = useRef<HTMLInputElement>(null);
  /** L1 侧边栏容器 ref（打开时聚焦，支持 J/K 键盘导航）。 */
  const l1Ref = useRef<HTMLDivElement>(null);
  /** 用户手动展开 L1 侧栏标记：auto-collapse 不覆盖手动操作。 */
  const sidebarManualRef = useRef(false);

  // Entering L1 from L0: expand only on pane *entry* — never fight Cmd+B.
  const prevDeliverablesKeyboardPaneRef = useRef(keyboardPane);
  useEffect(() => {
    if (previewMode || isMobile || !isActive) return;
    const prev = prevDeliverablesKeyboardPaneRef.current;
    prevDeliverablesKeyboardPaneRef.current = keyboardPane;
    if (keyboardPane !== 'l1' || prev === 'l1') return;
    if (sidebarCollapsed) {
      // 用户通过键盘导航进入 L1，视为手动操作：优先于 auto-collapse，不再自动折叠。
      sidebarManualRef.current = true;
      setSidebarCollapsed(false);
    }
  }, [keyboardPane, previewMode, isMobile, isActive, sidebarCollapsed]);

  useEffect(() => {
    if (previewMode || isMobile || !isActive) return;
    const handler = (e: KeyboardEvent) => {
      // Cmd/Ctrl 修饰键快捷键是全局命令，不受 keyboardPane 焦点区限制
      // （否则刚进入页面焦点默认在 L0 时 Cmd+B / Cmd+L / Cmd+F 全部被吞掉）。
      const isCmd = e.metaKey || e.ctrlKey;
      if (isCmd) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
          if (e.key === 'Escape') {
            (e.target as HTMLElement).blur();
            e.preventDefault();
          }
          return;
        }
        if (isEditableTarget(e.target)) return;
        if (e.key === 'f') {
          e.preventDefault();
          searchInputRef.current?.focus();
          return;
        }
        // Cmd/Ctrl + B：开/关左侧栏（L1 list）；Cmd/Ctrl + L：开/关右侧聊天栏。
        // （位于 isEditableTarget 守卫之后，编辑目标/输入框内不会触发）
        if (e.key.toLowerCase() === 'b') {
          e.preventDefault();
          setSidebarCollapsed(prev => {
            const next = !prev;
            // 用户手动打开 L1：标记 manual，auto-collapse 不再覆盖（手动优先）。
            if (next) {
              sidebarManualRef.current = true;
              // 打开后焦点落到 L1 容器，且键盘区切到 L1，J/K 立即可用。
              layout?.setKeyboardPane('l1');
              requestAnimationFrame(() => l1Ref.current?.focus());
            }
            return next;
          });
          return;
        }
        if (e.key.toLowerCase() === 'l') {
          e.preventDefault();
          // Cmd/Ctrl+L：不再打开本页聊天栏 — 跳转到 Team Chat 并在右侧栏预览当前交付物。
          openInTeamChat();
          return;
        }
        if (e.altKey) return;
        return;
      }
      // 以下裸字母 / 方向键导航受 keyboardPane 焦点区限制
      if (layout?.keyboardPane === 'l0') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.key === 'Escape') {
          (e.target as HTMLElement).blur();
          e.preventDefault();
        }
        return;
      }
      if (isEditableTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const bare = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      // H → L0 app rail; L stays on / returns to L1 list
      if (bare === 'h' || bare === 'ArrowLeft') {
        e.preventDefault();
        if (sidebarCollapsed) setSidebarCollapsed(false);
        layout?.setL0FocusPageId(PAGE.DELIVERABLES);
        layout?.setLeftCollapsed(false);
        layout?.setKeyboardPane('l0');
        return;
      }
      // L1 list is deepest — L only re-asserts list focus (never leaves the JK pane).
      if (bare === 'l' || bare === 'ArrowRight') {
        e.preventDefault();
        if (sidebarCollapsed) setSidebarCollapsed(false);
        if (layout?.keyboardPane !== 'l1') layout?.setKeyboardPane('l1');
        return;
      }

      const move = bare === 'j' || bare === 'ArrowDown' ? 1
        : bare === 'k' || bare === 'ArrowUp' ? -1
        : 0;
      if (!move) return;
      e.preventDefault();
      layout?.setKeyboardPane('l1');
      if (sidebarCollapsed) {
        sidebarManualRef.current = true;
        setSidebarCollapsed(false);
      }
      const list = flatItems;
      if (list.length === 0) return;
      const curIdx = selected ? list.findIndex(i => i.id === selected.id) : -1;
      const base = curIdx < 0 ? (move > 0 ? -1 : 0) : curIdx;
      const nextIdx = Math.max(0, Math.min(list.length - 1, base + move));
      handleSelectItem(list[nextIdx]!);
      requestAnimationFrame(() => {
        document.querySelector(`[data-deliverable-id="${list[nextIdx]!.id}"]`)?.scrollIntoView({ block: 'nearest' });
      });
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatItems, selected, previewMode, isMobile, isActive, layout, sidebarCollapsed]);

  const pullStartRef = useRef<{ y: number; scrollTop: number } | null>(null);
  const handlePullStart = useCallback((e: React.TouchEvent) => {
    if (!isMobile) return;
    const el = listRef.current;
    if (!el || el.scrollTop > 0) return;
    pullStartRef.current = { y: e.touches[0].clientY, scrollTop: el.scrollTop };
  }, [isMobile]);
  const handlePullEnd = useCallback((e: React.TouchEvent) => {
    if (!isMobile || !pullStartRef.current || pullRefreshing) return;
    const dy = e.changedTouches[0].clientY - pullStartRef.current.y;
    pullStartRef.current = null;
    if (dy > 80 && listRef.current && listRef.current.scrollTop <= 0) {
      setPullRefreshing(true);
      refresh().finally(() => setPullRefreshing(false));
    }
  }, [isMobile, pullRefreshing, refresh]);

  const handleSelectItem = (item: DeliverableInfo) => {
    const doSwitch = () => {
      setSelected(item);
      setShareOpen(false);
      setEditMode(false);
      setEditDirty(false);
      if (isMobile) {
        setMobileShowDetail(true);
        history.pushState({ mobileDetail: PAGE.DELIVERABLES }, '', window.location.hash);
      }
    };
    if (editDirty) {
      setUnsavedDialog({ action: doSwitch });
    } else {
      doSwitch();
    }
  };

  const handleStartEdit = () => {
    if (!editDirty) {
      const content = previewContent ?? selected?.summary ?? '';
      setEditContent(content);
    }
    setEditMode(true);
  };

  const handleSwitchToPreview = () => {
    if (editDirty) {
      setUnsavedDialog({ action: () => { setEditMode(false); setEditDirty(false); } });
    } else {
      setEditMode(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!selected?.reference || editSaving) return;
    setEditSaving(true);
    try {
      await api.files.write(selected.reference, editContent);
      setPreviewContent(editContent);
      setEditDirty(false);
      setEditMode(false);
      flashMsg('success', t('detail.saved'));
    } catch (e) {
      flashMsg('error', t('detail.saveFailed') + ': ' + String(e));
    }
    setEditSaving(false);
  };

  const handleDiscardEdit = () => {
    setEditMode(false);
    setEditDirty(false);
    setUnsavedDialog(null);
  };

  // Unsaved changes guard for navigation
  useEffect(() => {
    if (!editDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editDirty]);

  useEffect(() => {
    if (!editDirty) return;
    const handler = (e: CustomEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      setUnsavedDialog({ action: () => {
        setEditMode(false);
        setEditDirty(false);
        const { page, params } = e.detail || {};
        if (page) navBus.navigate(page, params);
      }});
    };
    window.addEventListener('markus:navigate', handler as EventListener);
    return () => window.removeEventListener('markus:navigate', handler as EventListener);
  }, [editDirty]);

  // 焦点跟随：Cmd+L 导航到 Team Chat → 由 Team 页聚焦输入框；本页不再有右侧聊天栏。

  // Selection toolbar handler (Phase 4)
  const detailContentRef = useRef<HTMLDivElement>(null);

  /**
   * 跳转到 Team Chat 页面：在右侧栏预览当前交付物，并把交付物（及可选选中文本）作为
   * 输入框上方的「标签」(chat context chips) 携带过去 —— 与右侧栏「添加到对话」一致，
   * 而不是预填输入框文本。
   */
  const openInTeamChat = useCallback((selectionText?: string, htmlMeta?: { xpath: string; cssSelector: string }) => {
    const agentId = selected?.agentId ?? '';
    const deliverableId = selected?.id ?? '';
    const params: Record<string, string> = {};
    if (deliverableId) params.openDeliverable = deliverableId;

    // 交付物本身作为一个标签，让 agent 明确知道讨论的是哪个交付物。
    const chips: Array<{ label: string; content: string }> = [];
    if (deliverableId) {
      const dTitle = selected?.title?.trim() || deliverableId;
      const dLabel = dTitle.length > 40 ? `${dTitle.slice(0, 24)}…${dTitle.slice(-12)}` : dTitle;
      chips.push({
        label: `📄 ${dLabel}`,
        content: [
          `[deliverable]`,
          `ID: ${deliverableId}`,
          `Title: ${selected?.title ?? ''}`,
          selected?.reference ? `Reference: ${selected.reference}` : '',
          selected?.taskId ? `Task: ${selected.taskId}` : '',
          selected?.projectId ? `Project: ${selected.projectId}` : '',
        ].filter(Boolean).join('\n'),
      });
    }
    if (selectionText?.trim()) {
      const short = selectionText.trim().length > 40
        ? `${selectionText.trim().slice(0, 24)}…${selectionText.trim().slice(-12)}`
        : selectionText.trim();
      if (htmlMeta) {
        const filePath = selected?.reference ?? '';
        chips.push({
          label: `🌐 ${short}`,
          content: [
            `[html-selection]`,
            `Text: "${selectionText.trim()}"`,
            `CSS Selector: ${htmlMeta.cssSelector}`,
            `XPath: ${htmlMeta.xpath}`,
            filePath ? `File: ${filePath}` : '',
          ].filter(Boolean).join('\n'),
        });
      } else {
        chips.push({ label: `📝 ${short}`, content: selectionText.trim() });
      }
    }
    if (chips.length > 0) params.chatChips = JSON.stringify(chips);

    if (agentId) params.agentId = agentId;
    setSelectionToolbar(null);
    window.getSelection()?.removeAllRanges();
    navBus.navigate(PAGE.TEAM, params);
  }, [selected]);

  const handleHtmlSelection = useCallback((data: HtmlSelectionData) => {
    if (!data.text.trim()) return;
    const iframeEl = detailContentRef.current?.querySelector('iframe');
    const iframeRect = iframeEl?.getBoundingClientRect();
    const x = (iframeRect?.left ?? 0) + data.rect.x + data.rect.width / 2;
    const y = (iframeRect?.top ?? 0) + data.rect.y;
    setSelectionToolbar({ x, y, text: data.text, htmlMeta: { xpath: data.xpath, cssSelector: data.cssSelector } });
  }, []);

  useEffect(() => {
    const el = detailContentRef.current;
    if (!el) return;
    const onMouseUp = () => {
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!text || !sel?.rangeCount) { setSelectionToolbar(null); return; }
        const range = sel.getRangeAt(0);
        if (!el.contains(range.commonAncestorContainer)) { setSelectionToolbar(null); return; }
        const rect = range.getBoundingClientRect();
        setSelectionToolbar({ x: rect.left + rect.width / 2, y: rect.top, text });
      });
    };
    const onMouseDown = (e: MouseEvent) => {
      const toolbar = document.getElementById('selection-toolbar');
      if (toolbar && toolbar.contains(e.target as Node)) return;
      setSelectionToolbar(null);
    };
    el.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      el.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, []);

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* Left sidebar — always mounted on mobile to preserve scroll position */}
      <div
        ref={l1Ref}
        tabIndex={-1}
        data-keyboard-pane="l1"
        className={`${isMobile ? 'flex-1 min-w-0' : 'shrink-0'} flex flex-col bg-surface-secondary rounded-xl m-1 mr-0 outline-none ${!isMobile && keyboardPane === 'l1' ? 'ring-1 ring-inset ring-brand-500/30' : ''}`}
        style={isMobile ? (mobileShowDetail ? { display: 'none' } : undefined) : sidebarCollapsed ? { display: 'none' } : { width: listPanel.width }}>
        <div data-electron-drag className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {isMobile && <MobileMenuButton />}
              {!isMobile && (
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors shrink-0 bg-brand-500/15 text-brand-500 hover:bg-brand-500/25"
                  title={t('sidebar.collapse')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                </button>
              )}
              <h2 className="text-sm font-semibold text-fg-secondary truncate">
                {t('title')}{totalCount > 0 && <span className="ml-1.5 text-fg-tertiary font-normal">({totalCount})</span>}
              </h2>
            </div>
          </div>
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-muted pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="w-full bg-surface-elevated border border-border-default rounded-lg pl-8 pr-8 py-2 text-sm text-fg-primary focus:border-brand-500 focus:outline-none transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(''); setDebouncedQuery(''); }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded-full bg-surface-overlay text-fg-tertiary hover:text-fg-secondary transition-colors"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            )}
          </div>
          {sharedDir && !isMobile && (
            <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-elevated rounded-lg text-[10px] text-fg-tertiary">
              <span className="truncate font-mono">{sharedDir}</span>
              <button onClick={() => void api.system.openPath(sharedDir)}
                className="shrink-0 underline hover:text-fg-secondary transition-colors">{t('common:open')}</button>
            </div>
          )}
          {/* Mobile: compact filter toggle */}
          {isMobile && (
            <button
              onClick={() => setMobileFiltersOpen(v => !v)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${mobileFiltersOpen || hasActiveFilters ? 'bg-brand-500/15 text-brand-500' : 'bg-surface-elevated text-fg-secondary'}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="12" y1="18" x2="20" y2="18" />
              </svg>
              {t('filters.filtersLabel')}
              {hasActiveFilters && <span className="w-1.5 h-1.5 rounded-full bg-brand-500" />}
              <svg className={`w-3 h-3 ml-auto transition-transform ${mobileFiltersOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
          )}
          {/* Filter rows — always visible on desktop, collapsible on mobile */}
          <div className={isMobile && !mobileFiltersOpen ? 'hidden' : 'space-y-3'}>
          {/* Source filter (agent / knowledge) + bind knowledge base entry */}
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide filter-pills-fade">
            <span className="text-[10px] text-fg-tertiary shrink-0">{t('filters.source')}</span>
            <FilterPill label={t('filters.allSources')} value="" current={filterSource} onClick={() => setFilterSource('')} />
            <FilterPill label={t('filters.sourceAgent')} value="agent" current={filterSource} onClick={v => setFilterSource((v || '') as 'agent' | 'knowledge' | '')} />
            <FilterPill label={t('filters.sourceKnowledge')} value="knowledge" current={filterSource} onClick={v => setFilterSource((v || '') as 'agent' | 'knowledge' | '')} />
            <button
              type="button"
              onClick={() => setBindOpen(true)}
              className="ml-auto shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[10px] text-fg-tertiary hover:text-brand-500 hover:bg-surface-elevated transition-colors"
              title={t('filters.bindKnowledgeBase')}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              {t('filters.bindKnowledgeBase')}
            </button>
          </div>
          {/* Type filter (includes artifact types) */}
          <div className="flex gap-1 overflow-x-auto scrollbar-hide filter-pills-fade">
            <FilterPill label={t('filters.allTypes')} value="" current={filterType || filterArtifact || ''} onClick={() => { setFilterType(''); setFilterArtifact(''); }} />
            {ALL_TYPES.map(ty => (
              <FilterPill key={ty} label={`${TYPE_META[ty]?.icon ?? ''} ${ty}`} value={ty} current={filterType} onClick={v => { setFilterType(v); setFilterArtifact(''); }} />
            ))}
            {(['agent', 'team', 'skill'] as const).map(a => (
              <FilterPill key={a} label={`${ARTIFACT_META[a].icon} ${t(`artifactTypes.${a}`)}`} value={a} current={filterArtifact} onClick={v => { setFilterArtifact(v); setFilterType(''); }} />
            ))}
          </div>
          {/* Group by */}
          <div className="flex gap-1.5 items-center">
            <span className="text-[10px] text-fg-tertiary">{t('filters.group')}</span>
            {(['date', 'project', 'team', 'agent'] as const).map(g => (
              <button key={g} onClick={() => { setGroupBy(g); }}
                className={`px-2 py-1 rounded text-xs transition-colors ${groupBy === g ? 'bg-brand-600 text-white' : 'bg-surface-elevated text-fg-secondary hover:bg-surface-overlay'}`}>
                {t(`groupBy.${g}`)}
              </button>
            ))}
            {grouped.length > 1 && (
              <button
                onClick={toggleAllGroups}
                className="ml-auto px-1.5 py-1 rounded text-[10px] text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated transition-colors"
                title={allGroupsCollapsed ? t('expandAllTooltip') : t('collapseAllTooltip')}
              >
                {allGroupsCollapsed ? t('expandAll') : t('collapseAll')}
              </button>
            )}
          </div>
          </div>
          {/* Active filter chips */}
          {hasActiveFilters && (
            <div className="flex items-center gap-1 flex-wrap">
              {debouncedQuery && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-500 text-[10px]">
                  &ldquo;{debouncedQuery}&rdquo;
                  <button onClick={() => { setSearchQuery(''); setDebouncedQuery(''); }} className="hover:text-brand-400">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </span>
              )}
              {filterType && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-500 text-[10px]">
                  {TYPE_META[filterType]?.icon} {filterType}
                  <button onClick={() => setFilterType('')} className="hover:text-brand-400">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </span>
              )}
              {filterArtifact && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-500 text-[10px]">
                  {ARTIFACT_META[filterArtifact]?.icon} {t(`artifactTypes.${filterArtifact}`)}
                  <button onClick={() => setFilterArtifact('')} className="hover:text-brand-400">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </span>
              )}
              {filterSource && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-500 text-[10px]">
                  {filterSource === 'knowledge' ? t('filters.sourceKnowledge') : t('filters.sourceAgent')}
                  <button onClick={() => setFilterSource('')} className="hover:text-brand-400">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </span>
              )}
              {filterProject && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-500 text-[10px]">
                  {resolveProjectName(filterProject) ?? filterProject}
                  <button onClick={() => setFilterProject('')} className="hover:text-brand-400">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </span>
              )}
              <button onClick={clearAllFilters} className="text-[10px] text-fg-tertiary hover:text-brand-500 ml-auto transition-colors">
                {t('filters.clearAll')}
              </button>
            </div>
          )}
        </div>

        {flash && (
          <div className={`mx-4 mt-2 px-3 py-1.5 text-xs rounded-lg ${flash.type === 'success' ? 'bg-green-500/15 text-green-600' : 'bg-red-500/15 text-red-500'}`}>{flash.text}</div>
        )}

        <div ref={listRef} className="flex-1 overflow-y-auto p-2 space-y-1 transition-opacity duration-150" style={{ opacity: loading ? 0.5 : 1 }}
          onTouchStart={isMobile ? (e) => { groupSwipe.onTouchStart(e); handlePullStart(e); } : undefined}
          onTouchEnd={isMobile ? (e) => { groupSwipe.onTouchEnd(e); handlePullEnd(e); } : undefined}>
          {pullRefreshing && (
            <div className="flex items-center justify-center gap-2 py-2 text-brand-500">
              <Spinner /> <span className="text-[10px]">{t('filters.refreshing')}</span>
            </div>
          )}
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
              {hasActiveFilters ? (
                <>
                  <p className="text-sm text-fg-secondary">{t('empty.noResults')}</p>
                  <p className="text-xs text-fg-tertiary mt-1 mb-3">{t('empty.noResultsHint')}</p>
                  <button onClick={clearAllFilters} className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors">{t('filters.clearAll')}</button>
                </>
              ) : (
                <>
                  <p className="text-sm text-fg-secondary">{t('empty.title')}</p>
                  <p className="text-xs text-fg-tertiary mt-1 mb-3">{t('empty.subtitle')}</p>
                  <button onClick={() => navBus.navigate(PAGE.WORK)} className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors">{t('empty.goToWork')}</button>
                </>
              )}
            </div>
          ) : grouped.map(([key, group]) => {
            const isCollapsed = isGroupCollapsed(key);
            return (
              <div key={key} className="mb-1">
                <button
                  onClick={() => toggleGroup(key)}
                  className="w-full flex items-center gap-1.5 px-2 py-2 rounded-md hover:bg-surface-elevated/50 transition-colors group/header border-b border-border-subtle/50"
                >
                  <svg
                    className={`w-3 h-3 text-fg-tertiary transition-transform duration-200 shrink-0 ${isCollapsed ? '' : 'rotate-90'}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-[11px] font-semibold text-fg-tertiary uppercase tracking-wider truncate">{group.label}</span>
                  <span className="text-[10px] text-fg-muted bg-surface-elevated px-1.5 py-0.5 rounded-full shrink-0">{group.items.length}{items.length < totalCount ? '+' : ''}</span>
                </button>
                <div className={`overflow-hidden transition-all duration-200 ${isCollapsed ? 'max-h-0 opacity-0' : 'max-h-[5000px] opacity-100'}`}>
                  {group.items.map(item => (
                  <button key={item.id} data-deliverable-id={item.id} onClick={() => handleSelectItem(item)}
                    className={`w-full text-left px-3 py-2 rounded-lg transition-all duration-150 ${selected?.id === item.id ? (keyboardPane === 'l1' ? 'bg-brand-500/25 ring-1 ring-inset ring-brand-500/40 border-l-2 border-l-brand-500 border-y border-r border-y-brand-500/20 border-r-brand-500/20' : 'bg-brand-600/15 border-l-2 border-l-brand-500 border-y border-r border-y-brand-500/20 border-r-brand-500/20') : 'hover:bg-surface-elevated/60 border-l-2 border-l-transparent border-y border-r border-transparent'}`}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      {item.artifactType && ARTIFACT_META[item.artifactType] ? (
                        <span className={`text-[10px] px-1 py-0.5 rounded font-medium shrink-0 ${ARTIFACT_META[item.artifactType].color}`}>
                          {ARTIFACT_META[item.artifactType].icon}
                        </span>
                      ) : (
                        <span className={`text-[10px] px-1 py-0.5 rounded font-medium uppercase shrink-0 ${TYPE_META[item.type]?.color ?? 'bg-surface-overlay text-fg-secondary'}`}>{TYPE_META[item.type]?.icon ?? item.type.charAt(0)}</span>
                      )}
                      <span className="text-sm font-medium text-fg-primary truncate flex-1">{item.title}</span>
                      {shareStatusOf(item) === 'published' && (
                        <svg className="shrink-0 text-green-500" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label={t('share.published', { defaultValue: '已发布到 Hub' })}>
                          <title>{t('share.published', { defaultValue: '已发布到 Hub' })}</title>
                          <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                        </svg>
                      )}
                      {shareStatusOf(item) === 'pending_review' && (
                        <svg className="shrink-0 text-amber-500 animate-pulse" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label={t('share.pendingReview', { defaultValue: 'Hub 审核中' })}>
                          <title>{t('share.pendingReview', { defaultValue: 'Hub 审核中' })}</title>
                          <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                        </svg>
                      )}
                      {shareStatusOf(item) === 'rejected' && (
                        <svg className="shrink-0 text-red-500" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label={t('share.rejected', { defaultValue: 'Hub 已拒绝' })}>
                          <title>{t('share.rejected', { defaultValue: 'Hub 已拒绝' })}</title>
                          <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                        </svg>
                      )}
                      {missingFileIds.has(item.id) && (
                        <span className="shrink-0 text-amber-500" title={t('detail.fileMissing')}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                          </svg>
                        </span>
                      )}
                      <span className="text-[10px] text-fg-muted shrink-0">{relativeTime(item.updatedAt, t)}</span>
                    </div>
                  </button>
                  ))}
                </div>
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
        <div className="w-2 shrink-0 cursor-col-resize group relative flex items-center justify-center hover:bg-brand-500/5 transition-colors" onMouseDown={listPanel.onResizeStart}>
          <div className="flex flex-col gap-1 items-center opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="w-1 h-1 rounded-full bg-fg-muted" />
            <div className="w-1 h-1 rounded-full bg-fg-muted" />
            <div className="w-1 h-1 rounded-full bg-fg-muted" />
          </div>
        </div>
      )}

      {/* Right detail panel — data-no-drag keeps absolute FAB positioning stable
          under Electron -webkit-app-region rules. */}
      {(!isMobile || mobileShowDetail) && (
      <div data-no-drag className="flex-1 overflow-hidden min-w-0 flex relative self-stretch">
        <div ref={detailContentRef} className="flex-1 overflow-y-auto min-w-0 h-full">
        {/* Expand sidebar button — shown when collapsed */}
        {sidebarCollapsed && !isMobile && (
          <div className="sticky top-0 z-10 bg-surface-primary/80 backdrop-blur-sm px-4 py-2 flex items-center gap-2">
            <button
              onClick={() => { sidebarManualRef.current = true; setSidebarCollapsed(false); }}
              className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors shrink-0 text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated"
              title={t('sidebar.expand')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            </button>
            <span className="text-sm font-medium text-fg-secondary truncate">{selected?.title ?? t('detail.details')}</span>
          </div>
        )}
        {isMobile && (
          <div className="sticky top-0 z-10 bg-surface-secondary px-4 py-2.5 flex items-center gap-2">
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
            <div className="text-center text-fg-tertiary space-y-3 max-w-xs">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-surface-elevated/60 flex items-center justify-center">
                <svg className="w-8 h-8 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </div>
              <p className="text-sm text-fg-secondary">{t('detail.selectToView')}</p>
              {!isMobile && (
                <p className="text-[10px] text-fg-muted">{t('detail.keyboardHint')}</p>
              )}
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-4">
            {/* File missing warning */}
            {!previewMode && missingFileIds.has(selected.id) && (
              <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-600 text-xs">
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <span>{t('detail.fileMissing')}</span>
              </div>
            )}

            {/* Header: title + badges + actions — all info at the top */}
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-xl font-semibold text-fg-primary">{selected.title}</h2>
                {!previewMode && (
                <div className="flex items-center gap-1 shrink-0">
                  {/* 分享到 Hub：仅格式命中白名单（markdown / html）时提供入口，与服务端一致 */}
                  {canShareDeliverableFormat(selected?.format) && (
                  <button
                    onClick={() => setShareOpen(true)}
                    title={t('share.title', { defaultValue: '分享到 Markus Hub' })}
                    aria-label={t('share.title', { defaultValue: '分享到 Markus Hub' })}
                    className={`relative p-1.5 rounded-lg transition-colors ${
                      shareStatusOf(selected) === 'published'
                        ? 'text-green-500 hover:text-green-400 hover:bg-green-500/10'
                        : shareStatusOf(selected) === 'pending_review'
                          ? 'text-amber-500 hover:text-amber-400 hover:bg-amber-500/10'
                          : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated'
                    }`}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                    </svg>
                    {shareStatusOf(selected) === 'published' || shareStatusOf(selected) === 'pending_review' || shareStatusOf(selected) === 'rejected' ? (
                      <span
                        className={`absolute top-0.5 right-0.5 w-2 h-2 rounded-full border border-surface-primary ${
                          shareStatusOf(selected) === 'published'
                            ? 'bg-green-500'
                            : shareStatusOf(selected) === 'pending_review'
                              ? 'bg-amber-500 animate-pulse'
                              : 'bg-red-500'
                        }`}
                        aria-hidden
                      />
                    ) : null}
                  </button>
                  )}
                  <button
                    onClick={() => setConfirmRemove(selected)}
                    disabled={!!actionLoading}
                    className="p-1.5 rounded-lg text-fg-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 shrink-0"
                    title={t('common:remove')}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
                )}
              </div>

              {/* All badges and info in one block */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`px-2 py-0.5 rounded text-xs font-medium uppercase ${TYPE_META[selected.type]?.color ?? 'bg-surface-overlay text-fg-secondary'}`}>{TYPE_META[selected.type]?.icon ?? ''} {selected.type}</span>
                {selected.artifactType && ARTIFACT_META[selected.artifactType] && (
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${ARTIFACT_META[selected.artifactType].color}`}>
                    {ARTIFACT_META[selected.artifactType].icon} {t('detail.builderWithType', { type: t(`artifactTypes.${selected.artifactType}`) })}
                  </span>
                )}
                {selected.tags.length > 0 && selected.tags.map(tag => (
                  <span key={tag} className="px-2 py-0.5 text-xs bg-surface-elevated text-fg-secondary rounded">{tag}</span>
                ))}
                {shareStatusOf(selected) === 'published' && (
                  <a href={selected.shareUrl ?? undefined} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-500/15 text-green-600 hover:bg-green-500/25 hover:underline"
                    title={selected.shareUrl ?? undefined}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" /></svg>
                    {t('share.published', { defaultValue: '已发布' })}
                  </a>
                )}
                {shareStatusOf(selected) === 'pending_review' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-500/15 text-amber-500">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    {t('share.pendingReview', { defaultValue: '审核中' })}
                  </span>
                )}
                {shareStatusOf(selected) === 'rejected' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-500/15 text-red-500"
                    title={selected.shareReason ?? undefined}>
                    {t('share.rejected', { defaultValue: '已拒绝' })}
                    {selected.shareReason ? <span className="text-red-400/90 font-normal">— {selected.shareReason}</span> : null}
                  </span>
                )}
              </div>

              {/* Association links inline */}
              {(selected.taskId || selected.agentId || resolveProjectName(selected.projectId)) && (
                <div className="flex items-center gap-2 flex-wrap">
                  {selected.taskId && (
                    <button onClick={() => navBus.navigate(PAGE.WORK, { openTask: selected.taskId! })}
                      className="text-xs text-brand-500 hover:underline bg-brand-500/10 px-2 py-0.5 rounded">
                      {t('links.task', { id: `${selected.taskId.slice(0, 12)}...` })}
                    </button>
                  )}
                  {selected.agentId && (
                    <button onClick={() => navBus.navigate(PAGE.TEAM, { selectAgent: selected.agentId! })}
                      className="text-xs text-blue-600 hover:underline bg-blue-500/10 px-2 py-0.5 rounded">
                      {t('links.agent', { name: agentMap.get(selected.agentId)?.name ?? selected.agentId.slice(0, 12) })}
                    </button>
                  )}
                  {resolveProjectName(selected.projectId) && (
                    <button onClick={() => navBus.navigate(PAGE.WORK, { projectId: selected.projectId! })}
                      className="text-xs text-blue-600 hover:underline bg-blue-500/10 px-2 py-0.5 rounded">
                      {t('links.project', { name: resolveProjectName(selected.projectId) })}
                    </button>
                  )}
                </div>
              )}

              {/* Diff stats / test results */}
              {(selected.diffStats || selected.testResults) && (
                <div className="flex gap-3 flex-wrap">
                  {selected.diffStats && (
                    <div className="bg-surface-elevated rounded-lg px-3 py-2 text-xs flex items-center gap-2">
                      <span className="text-fg-tertiary font-medium">{t('diffStats.title')}:</span>
                      <span className="text-fg-secondary">{t('diffStats.files', { count: selected.diffStats.filesChanged })}</span>
                      <span className="text-green-600">+{selected.diffStats.additions}</span>
                      <span className="text-red-500">-{selected.diffStats.deletions}</span>
                    </div>
                  )}
                  {selected.testResults && (
                    <div className="bg-surface-elevated rounded-lg px-3 py-2 text-xs flex items-center gap-2">
                      <span className="text-fg-tertiary font-medium">{t('testResults.title')}:</span>
                      <span className="text-green-600">{t('testResults.passed', { count: selected.testResults.passed })}</span>
                      <span className="text-red-500">{t('testResults.failed', { count: selected.testResults.failed })}</span>
                      <span className="text-fg-secondary">{t('testResults.skipped', { count: selected.testResults.skipped })}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Metadata */}
              <div className="flex items-center gap-4 text-[10px] text-fg-tertiary flex-wrap">
                <span>{t('metadata.created')} {new Date(selected.createdAt).toLocaleString()}</span>
                <span>{t('metadata.updated')} {new Date(selected.updatedAt).toLocaleString()}</span>
                <span className="text-fg-muted select-all">{selected.id.slice(0, 12)}</span>
              </div>

              {/* Reference/path — inline for files only; directories get a centered button in preview area */}
              {selected.reference && !isUrl(selected.reference) && selected.type === 'file' && (
                <div className="flex items-center gap-2 bg-surface-elevated rounded-lg px-3 py-2">
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
              {selected.reference && !isUrl(selected.reference) && selected.type !== 'file' && selected.type !== 'directory' && (
                <span className="text-xs text-fg-tertiary font-mono break-all">{selected.reference}</span>
              )}
            </div>

            {/* Preview area */}
            {selected.artifactType && selected.artifactData ? (
              <div className="space-y-4">
                <div className="bg-surface-elevated rounded-xl p-5">
                  <ArtifactPreview artifact={selected.artifactData} mode={selected.artifactType as BuilderMode} />
                </div>
                {selected.reference && (
                  <div className="px-3 py-2 bg-surface-elevated rounded-lg">
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
                  <div className="bg-surface-elevated rounded-xl p-5">
                    <MarkdownMessage content={selected.summary} className="text-fg-secondary text-sm" />
                  </div>
                )}
              </div>
            ) : selected.reference && isUrl(selected.reference) ? (
              <div className="space-y-4">
                {selected.summary && (
                  <div className="bg-surface-elevated rounded-xl p-5">
                    <MarkdownMessage content={selected.summary} className="text-fg-secondary text-sm" />
                  </div>
                )}
                <div className="flex flex-col items-center justify-center py-10">
                  <svg className="w-10 h-10 text-fg-muted mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  <p className="text-xs text-fg-tertiary font-mono mb-4 px-4 text-center break-all select-all">{selected.reference}</p>
                  <button
                    onClick={() => window.open(selected.reference, '_blank', 'noopener,noreferrer')}
                    className="px-6 py-2.5 bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium rounded-lg transition-colors"
                  >{t('detail.openUrl')}</button>
                </div>
              </div>
            ) : selected.type === 'directory' && selected.reference ? (
              <div className="space-y-4">
                {selected.summary && (
                  <div className="bg-surface-elevated rounded-xl p-5">
                    <MarkdownMessage content={selected.summary} className="text-fg-secondary text-sm" />
                  </div>
                )}
                <div className="flex flex-col items-center justify-center py-10">
                  <svg className="w-10 h-10 text-fg-muted mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <p className="text-xs text-fg-tertiary font-mono mb-4 px-4 text-center break-all select-all">{selected.reference}</p>
                  <button
                    onClick={() => { api.files.reveal(selected.reference).catch(() => flashMsg('error', t('detail.failedToOpenBrowser'))); }}
                    className="px-6 py-2.5 bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium rounded-lg transition-colors"
                  >{t('detail.openInFileBrowser')}</button>
                </div>
              </div>
            ) : (
              <div className="bg-surface-elevated rounded-xl overflow-hidden">
                {/* Edit/Preview toolbar — shown when there is editable text content */}
                {(previewContent || selected.summary) && !previewLoading && !previewImage && !showCopyPath && selected.reference && selected.type === 'file' && (previewFormat === 'markdown' || previewFormat === 'text' || previewFormat === 'html') && (
                  <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-surface-secondary/50">
                    <button
                      onClick={handleSwitchToPreview}
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${!editMode ? 'bg-brand-600/20 text-brand-500' : 'text-fg-tertiary hover:text-fg-secondary'}`}
                    >
                      {t('detail.preview')}
                    </button>
                    <button
                      onClick={handleStartEdit}
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${editMode ? 'bg-brand-600/20 text-brand-500' : 'text-fg-tertiary hover:text-fg-secondary'}`}
                    >
                      {t('detail.edit')}
                    </button>
                    <div className="flex-1" />
                    {editMode && (
                      <button
                        onClick={handleSaveEdit}
                        disabled={!editDirty || editSaving}
                        className="px-3 py-1 rounded text-xs font-medium bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {editSaving ? t('detail.saving') : t('detail.save')}
                      </button>
                    )}
                  </div>
                )}
                <div className="p-5">
                  {previewLoading ? (
                    <div className="animate-pulse space-y-4">
                      <div className="h-4 bg-surface-overlay/60 rounded w-full" />
                      <div className="h-4 bg-surface-overlay/60 rounded w-5/6" />
                      <div className="h-4 bg-surface-overlay/60 rounded w-4/6" />
                      <div className="h-32 bg-surface-overlay/40 rounded-lg w-full mt-2" />
                      <div className="h-4 bg-surface-overlay/60 rounded w-3/4" />
                      <div className="h-4 bg-surface-overlay/60 rounded w-2/3" />
                    </div>
                  ) : previewImage ? (
                    <div className="flex flex-col items-center gap-2">
                      <img src={previewImage.src} alt={previewImage.name} className="max-w-full max-h-[60vh] rounded-lg object-contain" />
                      <span className="text-xs text-fg-tertiary">{previewImage.name}</span>
                    </div>
                  ) : previewOffice ? (
                    <div className="h-[55vh]">
                      <OfficePreviewer
                        data={previewOffice}
                        reference={previewOffice.reference}
                        onFallback={previewOffice.reference ? () => { api.files.reveal(previewOffice.reference!).catch(() => {}); } : undefined}
                      />
                    </div>
                  ) : previewMedia ? (
                    <div className="flex flex-col gap-3 py-4">
                      {previewMedia.kind === 'audio' ? (
                        <audio controls preload="metadata" src={previewMedia.src} className="w-full" />
                      ) : (
                        <video controls preload="metadata" src={previewMedia.src} className="w-full max-h-[60vh] rounded-lg bg-black" />
                      )}
                      <span className="text-xs text-fg-tertiary">{previewMedia.name}</span>
                    </div>
                  ) : previewContent ? (
                    editMode ? (
                      <div key="edit" className="animate-fadeIn">
                      <textarea
                        ref={editTextareaRef}
                        value={editContent}
                        onChange={(e) => { setEditContent(e.target.value); setEditDirty(true); }}
                        className="w-full min-h-[120px] p-3 text-sm font-mono bg-surface-primary border border-border-subtle rounded-lg text-fg-secondary focus:outline-none focus:ring-1 focus:ring-brand-500/50 overflow-hidden"
                        style={{ resize: 'none' }}
                        spellCheck={false}
                      />
                      </div>
                    ) : (
                      <div key="preview" className="animate-fadeIn">
                      <ContentRenderer
                        content={previewContent}
                        format={previewFormat}
                        className="text-fg-secondary text-sm"
                        onHtmlSelection={handleHtmlSelection}
                        basePath={selected?.reference ? selected.reference.replace(/[/\\][^/\\]+$/, '') : undefined}
                      />
                      </div>
                    )
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
                    editMode ? (
                      <textarea
                        ref={editTextareaRef}
                        value={editContent}
                        onChange={(e) => { setEditContent(e.target.value); setEditDirty(true); }}
                        className="w-full min-h-[120px] p-3 text-sm font-mono bg-surface-primary border border-border-subtle rounded-lg text-fg-secondary focus:outline-none focus:ring-1 focus:ring-brand-500/50 overflow-hidden"
                        style={{ resize: 'none' }}
                        spellCheck={false}
                      />
                    ) : (
                      <MarkdownMessage content={selected.summary} className="text-fg-secondary text-sm" />
                    )
                  ) : (
                    <p className="text-sm text-fg-tertiary italic">{t('detail.noContent')}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

      </div>

        {/* Floating chat FAB — jump to Team Chat with this deliverable in the right panel */}
        {selected?.agentId && !isMobile && (
          <button
            type="button"
            onClick={() => openInTeamChat()}
            className="absolute bottom-6 right-6 z-20 w-12 h-12 rounded-full bg-brand-600 hover:bg-brand-500 text-white shadow-lg shadow-black/20 flex items-center justify-center transition-transform hover:scale-105 animate-fab-in"
            title={t('chat.openChat', { defaultValue: 'Open in Team Chat' })}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        )}
      </div>
      )}

      {/* Selection toolbar (Phase 4) */}
      {selectionToolbar && (
        <div
          id="selection-toolbar"
          className="fixed z-50 -translate-x-1/2 -translate-y-full bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden"
          style={{ left: selectionToolbar.x, top: selectionToolbar.y - 8 }}
        >
          <button
            onMouseDown={e => { e.preventDefault(); e.stopPropagation(); openInTeamChat(selectionToolbar.text, selectionToolbar.htmlMeta); }}
            className="px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {t('contextMenu.addToConversation')}
          </button>
        </div>
      )}

      {/* 分享产出物到 Hub */}
      {shareOpen && selected && (
        <DeliverableShareModal
          item={selected}
          onClose={() => setShareOpen(false)}
          onShared={onShareResult}
        />
      )}

      {/* Remove Confirmation */}
      {bindOpen && (
        <KnowledgeBindModal
          projects={projects}
          onClose={() => setBindOpen(false)}
          onBound={() => {
            setBindOpen(false);
            setFilterSource('knowledge');
            refresh();
          }}
        />
      )}

      {confirmRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setConfirmRemove(null)}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 max-w-sm mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </div>
              <div>
                <div className="text-sm font-medium text-fg-primary">{t('detail.confirmRemoveTitle')}</div>
                <div className="text-xs text-fg-secondary mt-0.5">{t('detail.confirmRemoveMessage', { name: confirmRemove.title })}</div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmRemove(null)}
                className="px-4 py-1.5 text-xs text-fg-secondary hover:text-fg-primary border border-border-default hover:border-gray-600 rounded-lg transition-colors">{t('common:cancel')}</button>
              <button onClick={() => { const d = confirmRemove; setConfirmRemove(null); handleRemove(d); }}
                disabled={!!actionLoading}
                className="px-4 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors disabled:opacity-50">{t('common:remove')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Unsaved Changes Dialog */}
      {unsavedDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setUnsavedDialog(null)}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 max-w-sm mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div>
                <div className="text-sm font-medium text-fg-primary">{t('detail.unsavedTitle')}</div>
                <div className="text-xs text-fg-secondary mt-0.5">{t('detail.unsavedMessage')}</div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setUnsavedDialog(null)}
                className="px-4 py-1.5 text-xs text-fg-secondary hover:text-fg-primary border border-border-default hover:border-gray-600 rounded-lg transition-colors">{t('common:cancel')}</button>
              <button onClick={() => { handleDiscardEdit(); unsavedDialog.action(); }}
                className="px-4 py-1.5 text-xs text-fg-secondary hover:text-fg-primary border border-border-default hover:border-gray-600 rounded-lg transition-colors">{t('detail.discard')}</button>
              <button onClick={async () => { await handleSaveEdit(); unsavedDialog.action(); setUnsavedDialog(null); }}
                className="px-4 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors">{t('detail.saveAndLeave')}</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function KnowledgeBindModal({ projects, onClose, onBound }: { projects: ProjectInfo[]; onClose: () => void; onBound: () => void }) {
  const { t } = useTranslation('deliverables');
  const [projectId, setProjectId] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selectedProject = projects.find(p => p.id === projectId);

  const canPickDir = typeof window !== 'undefined' && !!window.markusDesktop?.selectDirectory;

  const handleBrowse = async () => {
    try {
      const dir = await window.markusDesktop?.selectDirectory?.(t('bindBrowseTitle', { defaultValue: 'Select knowledge base directory' }));
      if (dir) setPath(dir);
    } catch (err) {
      setError(String(err));
    }
  };

  const submit = async () => {
    if (!projectId || !path.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const trimmed = path.trim();
      const paths = [...new Set([...(selectedProject?.knowledgeBasePaths ?? []), trimmed])];
      await api.projects.update(projectId, { knowledgeBasePaths: paths });
      // 绑定成功后立即扫描该目录，产出物页面立即可见
      await api.projects.syncKnowledge(projectId, [trimmed]);
      onBound();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { if (!busy) onClose(); }}>
      <div className="bg-surface-secondary border border-border-default rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="text-sm font-medium text-fg-primary mb-1">{t('bindKnowledgeBase')}</div>
        <p className="text-xs text-fg-secondary mb-4">{t('bindKnowledgeBaseHint')}</p>

        <label className="block text-[10px] text-fg-tertiary mb-1">{t('bindProject')}</label>
        <select
          value={projectId}
          onChange={e => setProjectId(e.target.value)}
          className="w-full mb-3 px-2.5 py-2 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary"
        >
          <option value="">{t('bindProjectSelect')}</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <label className="block text-[10px] text-fg-tertiary mb-1">{t('bindPath')}</label>
        <div className="flex gap-2 mb-2">
          <input
            value={path}
            onChange={e => setPath(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
            placeholder={t('bindPathPlaceholder')}
            className="flex-1 min-w-0 px-2.5 py-2 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder:text-fg-tertiary font-mono"
          />
          {canPickDir && (
            <button
              type="button"
              onClick={() => void handleBrowse()}
              disabled={busy}
              title={t('bindBrowse', { defaultValue: 'Browse…' })}
              className="shrink-0 px-3 py-2 text-xs bg-surface-overlay text-fg-secondary hover:text-fg-primary rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {t('bindBrowse', { defaultValue: 'Browse…' })}
            </button>
          )}
        </div>

        {selectedProject && (selectedProject.knowledgeBasePaths ?? []).length > 0 && (
          <div className="mb-3 space-y-1">
            <div className="text-[10px] text-fg-tertiary">{t('bindCurrentPaths')}</div>
            {(selectedProject.knowledgeBasePaths ?? []).map((p, i) => (
              <div key={`${p}-${i}`} className="text-[11px] text-fg-secondary font-mono truncate" title={p}>• {p}</div>
            ))}
          </div>
        )}

        {error && <div className="mb-3 px-2.5 py-1.5 text-[11px] rounded-md bg-red-500/15 text-red-500">{error}</div>}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} disabled={busy} className="px-3 py-1.5 text-xs text-fg-tertiary hover:text-fg-secondary rounded-lg transition-colors">{t('common:cancel', { defaultValue: 'Cancel' })}</button>
          <button
            onClick={() => void submit()}
            disabled={busy || !projectId || !path.trim()}
            className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? t('bindSaving', { defaultValue: 'Saving…' }) : t('bindSave', { defaultValue: 'Bind directory' })}
          </button>
        </div>
      </div>
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
