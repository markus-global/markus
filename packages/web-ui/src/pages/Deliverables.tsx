import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api, wsClient, type DeliverableInfo, type ProjectInfo, type AgentInfo, type AuthUser } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { ContentRenderer, resolveFormat, type HtmlSelectionData } from '../components/ContentRenderer.tsx';
import { copyPlainText } from '../components/markdown-copy.ts';
import { ArtifactPreview, type BuilderMode } from '../components/BuilderArtifact.tsx';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { type ContextChip } from '../components/ChatInput.tsx';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { usePageActive } from '../hooks/usePageActive.ts';
import { MobileMenuButton } from '../components/MobileMenuButton.tsx';
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

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
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

  const PAGE_SIZE = 100;
  const [items, setItems] = useState<DeliverableInfo[]>(previewData?.items ?? []);
  const [totalCount, setTotalCount] = useState(previewData?.items?.length ?? 0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>(previewData?.projects ?? []);
  const [agents, setAgents] = useState<AgentInfo[]>(previewData?.agents ?? []);
  const [loading, setLoading] = useState(previewData ? false : true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [filterAgent, setFilterAgent] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterArtifact, setFilterArtifact] = useState('');
  const [groupBy, setGroupBy] = useState<'project' | 'agent' | 'date' | 'type'>('date');
  const [selected, setSelected] = useState<DeliverableInfo | null>(() => {
    if (previewData?.initialSelectedId && previewData.items) {
      return previewData.items.find(d => d.id === previewData.initialSelectedId) ?? previewData.items[0] ?? null;
    }
    return previewData?.items?.[0] ?? null;
  });
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [actionLoading, setActionLoading] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const groupTabs = useMemo(() => [{ id: 'date' as const }, { id: 'project' as const }, { id: 'agent' as const }, { id: 'type' as const }], []);
  const handleGroupSwipe = useCallback((g: 'project' | 'agent' | 'date' | 'type') => { setGroupBy(g); setCollapsedGroups(new Set()); }, []);
  const groupSwipe = useSwipeTabs(groupTabs, groupBy, handleGroupSwipe);
  const listRef = useRef<HTMLDivElement>(null);

  // File preview
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewFormat, setPreviewFormat] = useState<string>('markdown');
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showCopyPath, setShowCopyPath] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<DeliverableInfo | null>(null);
  const [sharedDir, setSharedDir] = useState('');
  const [missingFileIds, setMissingFileIds] = useState<Set<string>>(new Set());

  // Sidebar collapse (Phase 2)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Chat panel (Phase 3)
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const [contextChips, setContextChips] = useState<ContextChip[]>([]);

  // Selection toolbar (Phase 4)
  const [selectionToolbar, setSelectionToolbar] = useState<{ x: number; y: number; text: string; htmlMeta?: { xpath: string; cssSelector: string } } | null>(null);

  // In-place editing (Phase 5)
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editDirty, setEditDirty] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [unsavedDialog, setUnsavedDialog] = useState<{ action: () => void } | null>(null);

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
      refresh();
      const updatedId = event.payload?.deliverableId as string | undefined;
      if (updatedId && selectedRef.current?.id === updatedId) {
        api.deliverables.get(updatedId).then(r => {
          if (r.deliverable) {
            setSelected(r.deliverable);
            loadPreview(r.deliverable);
          }
        }).catch(() => {});
      }
    });
    const unsub3 = wsClient.on('deliverable:removed', () => refresh());
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [refresh, isActive, previewMode]);

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
    const navId = localStorage.getItem('markus_nav_openDeliverable');
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
      if (detail?.params?.openDeliverable) {
        localStorage.removeItem('markus_nav_openDeliverable');
        openDeliverableById(detail.params.openDeliverable);
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

  useEffect(() => { checkNeedMore(); }, [checkNeedMore, collapsedGroups]);

  const grouped = useMemo(() => {
    const groups = new Map<string, { label: string; items: DeliverableInfo[] }>();
    for (const item of items) {
      let key: string;
      let label: string;
      if (groupBy === 'project') {
        const pName = resolveProjectName(item.projectId);
        key = pName ? (item.projectId ?? '_none') : '_none';
        label = pName ?? t('noProject');
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
    if (isUrl(d.reference)) return;
    if (d.type === 'directory') { setShowCopyPath(true); return; }

    setPreviewLoading(true);
    try {
      const resp = await api.files.preview(d.reference);
      if (resp.type === 'image' && resp.mimeType) {
        setPreviewImage({ src: `data:${resp.mimeType};base64,${resp.content}`, name: resp.name });
      } else {
        setPreviewContent(resp.content);
        setPreviewFormat(resolveFormat({ format: d.format, reference: d.reference, content: resp.content }));
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
    setShowCopyPath(false);
    if (selected) loadPreview(selected);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, previewMode]);

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

  const handleSelectItem = (item: DeliverableInfo) => {
    const doSwitch = () => {
      setSelected(item);
      setContextChips([]);
      setEditMode(false);
      setEditDirty(false);
      if (isMobile) {
        setChatPanelOpen(false);
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

  // Auto-collapse sidebar when chat panel opens and content area is too narrow
  const sidebarManualRef = useRef(false);
  useEffect(() => {
    if (!chatPanelOpen) {
      sidebarManualRef.current = false;
      return;
    }
    if (isMobile || sidebarManualRef.current) return;
    const chatWidth = 400;
    const sidebarWidth = sidebarCollapsed ? 0 : (listPanel.width ?? 384);
    const appSidebarWidth = 160;
    const availableForContent = window.innerWidth - appSidebarWidth - sidebarWidth - chatWidth;
    if (availableForContent < 480 && !sidebarCollapsed) {
      setSidebarCollapsed(true);
    }
  }, [chatPanelOpen, isMobile, sidebarCollapsed, listPanel.width]);

  // Selection toolbar handler (Phase 4)
  const detailContentRef = useRef<HTMLDivElement>(null);

  const addToConversation = useCallback((text: string, htmlMeta?: { xpath: string; cssSelector: string }) => {
    const label = text.length > 30 ? `${text.slice(0, 15)}…${text.slice(-12)}` : text;
    const chipId = `sel_${Date.now()}`;
    let content: string;
    if (htmlMeta) {
      const filePath = selected?.reference ?? '';
      content = [
        `[html-selection]`,
        `Text: "${text}"`,
        `CSS Selector: ${htmlMeta.cssSelector}`,
        `XPath: ${htmlMeta.xpath}`,
        filePath ? `File: ${filePath}` : '',
      ].filter(Boolean).join('\n');
    } else {
      content = text;
    }
    setContextChips(prev => [...prev, {
      id: chipId,
      label: htmlMeta ? `🌐 ${label}` : label,
      type: 'selection',
      content,
      onRemove: () => setContextChips(p => p.filter(c => c.id !== chipId)),
    }]);
    if (!chatPanelOpen) setChatPanelOpen(true);
    setSelectionToolbar(null);
    window.getSelection()?.removeAllRanges();
  }, [chatPanelOpen, selected?.reference]);

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
      <div className={`${isMobile ? 'flex-1 min-w-0' : 'shrink-0'} flex flex-col bg-surface-secondary rounded-xl m-1 mr-0`}
        style={isMobile ? (mobileShowDetail ? { display: 'none' } : undefined) : sidebarCollapsed ? { display: 'none' } : { width: listPanel.width }}>
        <div className="p-4 space-y-3">
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
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary focus:border-brand-500 focus:outline-none transition-colors"
          />
          {sharedDir && (
            <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-elevated rounded-lg text-[10px] text-fg-tertiary">
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
          {/* Status filter (active/verified/outdated only relevant for legacy data) */}
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
              <button onClick={() => navBus.navigate(PAGE.WORK)} className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors">{t('empty.goToWork')}</button>
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
                    className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${selected?.id === item.id ? 'bg-brand-600/20 border border-brand-500/30' : 'hover:bg-surface-elevated/60 border border-transparent'}`}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      {item.artifactType && ARTIFACT_META[item.artifactType] ? (
                        <span className={`text-[10px] px-1 py-0.5 rounded font-medium shrink-0 ${ARTIFACT_META[item.artifactType].color}`}>
                          {ARTIFACT_META[item.artifactType].icon}
                        </span>
                      ) : (
                        <span className={`text-[10px] px-1 py-0.5 rounded font-medium uppercase shrink-0 ${TYPE_META[item.type]?.color ?? 'bg-surface-overlay text-fg-secondary'}`}>{TYPE_META[item.type]?.icon ?? item.type.charAt(0)}</span>
                      )}
                      <span className="text-sm font-medium text-fg-primary truncate">{item.title}</span>
                      {missingFileIds.has(item.id) && (
                        <span className="shrink-0 text-amber-500" title={t('detail.fileMissing')}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                          </svg>
                        </span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${STATUS_META[item.status]?.color ?? 'bg-surface-elevated text-fg-tertiary'}`}>{t(`common:status.${item.status}`, { defaultValue: item.status })}</span>
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
        <div className="w-1.5 shrink-0 cursor-col-resize group relative flex items-center justify-center" onMouseDown={listPanel.onResizeStart}>
          <div className="w-px h-2/3 border-l border-dashed border-transparent group-hover:border-border-default group-active:border-fg-tertiary transition-colors" />
        </div>
      )}

      {/* Right detail panel */}
      {(!isMobile || mobileShowDetail) && (
      <div className="flex-1 overflow-hidden min-w-0 flex relative">
        <div ref={detailContentRef} className="flex-1 overflow-y-auto min-w-0">
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
            <div className="text-center text-fg-tertiary space-y-2">
              <svg className="w-12 h-12 mx-auto text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              <p className="text-sm">{t('detail.selectToView')}</p>
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
                    <div className="flex items-center gap-2 text-fg-tertiary text-sm"><Spinner /> {t('detail.loadingPreview')}</div>
                  ) : previewImage ? (
                    <div className="flex flex-col items-center gap-2">
                      <img src={previewImage.src} alt={previewImage.name} className="max-w-full max-h-[60vh] rounded-lg object-contain" />
                      <span className="text-xs text-fg-tertiary">{previewImage.name}</span>
                    </div>
                  ) : previewContent ? (
                    editMode ? (
                      <textarea
                        value={editContent}
                        onChange={(e) => { setEditContent(e.target.value); setEditDirty(true); }}
                        className="w-full h-[50vh] min-h-[300px] p-3 text-sm font-mono bg-surface-primary border border-border-subtle rounded-lg text-fg-secondary resize-y focus:outline-none focus:ring-1 focus:ring-brand-500/50"
                        spellCheck={false}
                      />
                    ) : (
                      <ContentRenderer content={previewContent} format={previewFormat} className="text-fg-secondary text-sm" onHtmlSelection={handleHtmlSelection} />
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
                        value={editContent}
                        onChange={(e) => { setEditContent(e.target.value); setEditDirty(true); }}
                        className="w-full h-[50vh] min-h-[300px] p-3 text-sm font-mono bg-surface-primary border border-border-subtle rounded-lg text-fg-secondary resize-y focus:outline-none focus:ring-1 focus:ring-brand-500/50"
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

        {/* Floating chat FAB — positioned in the non-scrolling parent */}
        {selected?.agentId && !chatPanelOpen && !isMobile && (
          <button
            onClick={() => setChatPanelOpen(true)}
            className="absolute bottom-6 right-6 w-12 h-12 rounded-full bg-brand-600 hover:bg-brand-500 text-white shadow-lg shadow-black/20 flex items-center justify-center transition-all hover:scale-105 z-20"
            title={t('chat.openChat')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        )}

        {/* Chat panel (Phase 3b) */}
        {chatPanelOpen && selected?.agentId && !isMobile && (
          <ChatPanel
            agentId={selected.agentId}
            agents={agents}
            authUser={_authUser}
            onClose={() => { setChatPanelOpen(false); setContextChips([]); }}
            contextChips={[
              {
                id: `deliverable_ctx_${selected.id}`,
                label: `📦 ${selected.title}`,
                type: 'deliverable',
                content: `${t('chat.currentDeliverable')}: ${selected.title} (id: ${selected.id})`,
              },
              ...contextChips,
            ]}
            width={400}
          />
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
            onMouseDown={e => { e.preventDefault(); e.stopPropagation(); addToConversation(selectionToolbar.text, selectionToolbar.htmlMeta); }}
            className="px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {t('contextMenu.addToConversation')}
          </button>
        </div>
      )}

      {/* Remove Confirmation */}
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
