import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api, wsClient, type DeliverableInfo, type ProjectInfo, type AgentInfo } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { ArtifactPreview, type BuilderMode } from '../components/BuilderArtifact.tsx';
import { navBus } from '../navBus.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { useResizablePanel } from '../hooks/useResizablePanel.ts';

const TYPE_META: Record<string, { icon: string; color: string }> = {
  file:      { icon: '\u{1F4C4}', color: 'bg-green-500/10 text-green-600' },
  directory: { icon: '\u{1F4C1}', color: 'bg-blue-500/10 text-blue-600' },
};

const STATUS_META: Record<string, { label: string; color: string }> = {
  active:   { label: 'Active',   color: 'text-green-600 bg-green-500/10' },
  verified: { label: 'Verified', color: 'text-blue-600 bg-blue-500/10' },
  outdated: { label: 'Outdated', color: 'text-red-500 bg-red-500/10' },
};

const ALL_TYPES = ['file', 'directory'] as const;

const ARTIFACT_META: Record<string, { icon: string; label: string; color: string }> = {
  agent: { icon: '\u2726', label: 'Agent', color: 'bg-brand-500/10 text-brand-500' },
  team:  { icon: '\u25C8', label: 'Team',  color: 'bg-blue-500/10 text-blue-600' },
  skill: { icon: '\u2B21', label: 'Skill', color: 'bg-amber-500/10 text-amber-600' },
};

export function DeliverablesPage() {
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
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const copyMenuRef = useRef<HTMLDivElement>(null);
  const [sharedDir, setSharedDir] = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flashMsg = (type: 'success' | 'error', text: string) => {
    setFlash({ type, text });
    setTimeout(() => setFlash(null), 3000);
  };

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch { return false; }
    }
  };

  const copyPath = async (text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1500);
    } else {
      flashMsg('error', 'Copy failed — try long-pressing to copy manually');
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
    const unsub = wsClient.on('deliverable:created', () => refresh());
    return unsub;
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
        label = item.projectId ? (projectMap.get(item.projectId)?.name ?? item.projectId) : 'No Project';
      } else if (groupBy === 'agent') {
        key = item.agentId ?? '_none';
        label = item.agentId ? (agentMap.get(item.agentId)?.name ?? item.agentId) : 'Unknown';
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
  }, [items, groupBy, projectMap, agentMap]);

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
        tags: newTags.split(',').map(t => t.trim()).filter(Boolean),
      });
      setShowCreate(false);
      flashMsg('success', 'Deliverable created');
      refresh();
    } catch (e) { flashMsg('error', `Error: ${e}`); }
    setCreating(false);
  };

  const handleVerify = async (d: DeliverableInfo) => {
    setActionLoading('verify');
    try {
      await api.deliverables.verify(d.id);
      flashMsg('success', 'Verified');
      setSelected({ ...d, status: 'verified' });
      refresh();
    } catch (e) { flashMsg('error', `Error: ${e}`); }
    setActionLoading('');
  };

  const handleFlagOutdated = async (d: DeliverableInfo) => {
    setActionLoading('flag');
    try {
      await api.deliverables.update(d.id, { status: 'outdated' });
      flashMsg('success', 'Flagged as outdated');
      setSelected({ ...d, status: 'outdated' });
      refresh();
    } catch (e) { flashMsg('error', `Error: ${e}`); }
    setActionLoading('');
  };

  const handleRemove = async (d: DeliverableInfo) => {
    setActionLoading('remove');
    try {
      await api.deliverables.remove(d.id);
      flashMsg('success', 'Removed');
      setSelected(null);
      refresh();
    } catch (e) { flashMsg('error', `Error: ${e}`); }
    setActionLoading('');
  };

  const handleOpenInBuilder = () => {
    navBus.navigate('builder');
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
    setCopyMenuOpen(false);
    if (selected) loadPreview(selected);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useEffect(() => {
    if (!copyMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (copyMenuRef.current && !copyMenuRef.current.contains(e.target as Node)) setCopyMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [copyMenuOpen]);

  const copyAsHtml = async (theme: 'light' | 'dark', sourceText: string) => {
    const sourceEl = previewRef.current?.firstElementChild as HTMLElement | null;
    if (!sourceEl) return;
    const html = buildStyledHtml(sourceEl, theme);
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([sourceText], { type: 'text/plain' }),
        }),
      ]);
      flashMsg('success', theme === 'light' ? 'HTML (light) copied' : 'HTML (dark) copied');
    } catch {
      const ok = await copyToClipboard(sourceText);
      flashMsg(ok ? 'success' : 'error', ok ? 'Text copied (HTML not supported)' : 'Copy failed');
    }
    setCopyMenuOpen(false);
  };

  const renderMarkdownPreview = (content: string) => (
    <div className="relative group/preview">
      <div
        className="absolute -top-1 -right-1 z-10"
        ref={copyMenuRef}
      >
        <button
          onClick={() => setCopyMenuOpen(o => !o)}
          className="p-1.5 rounded-lg bg-surface-elevated/80 hover:bg-surface-overlay text-fg-secondary hover:text-fg-primary backdrop-blur-sm border border-border-default/50 transition-all"
          title="Copy content"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
        {copyMenuOpen && (
          <div className="absolute right-0 top-full mt-1 bg-surface-elevated border border-border-default rounded-lg shadow-xl py-1 min-w-[180px]">
            <button
              onClick={async () => { const ok = await copyToClipboard(content); flashMsg(ok ? 'success' : 'error', ok ? 'Markdown source copied' : 'Copy failed'); setCopyMenuOpen(false); }}
              className="w-full px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary transition-colors flex items-center gap-2"
            >
              <span className="w-4 text-center text-fg-tertiary shrink-0 font-mono text-[10px]">Md</span>
              Copy Markdown Source
            </button>
            <button
              onClick={() => copyAsHtml('light', content)}
              className="w-full px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary transition-colors flex items-center gap-2"
            >
              <span className="w-4 text-center shrink-0">☀️</span>
              Copy HTML (Light)
            </button>
            <button
              onClick={() => copyAsHtml('dark', content)}
              className="w-full px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary transition-colors flex items-center gap-2"
            >
              <span className="w-4 text-center shrink-0">🌙</span>
              Copy HTML (Dark)
            </button>
          </div>
        )}
      </div>
      <div ref={previewRef}>
        <MarkdownMessage content={content} className="text-fg-secondary text-sm" />
      </div>
    </div>
  );

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
      history.pushState({ mobileDetail: 'deliverables' }, '', window.location.hash);
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
              Deliverables{totalCount > 0 && <span className="ml-1.5 text-fg-tertiary font-normal">({totalCount})</span>}
            </h2>
            <button onClick={openContributeForm} className="text-xs px-2.5 py-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors">+ Create</button>
          </div>
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search deliverables..."
            className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary focus:border-brand-500 focus:outline-none transition-colors"
          />
          {sharedDir && (
            <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-elevated/50 border border-border-default rounded-lg text-[10px] text-fg-tertiary">
              <span className="truncate font-mono">{sharedDir}</span>
              <button onClick={() => void api.system.openPath(sharedDir)}
                className="shrink-0 underline hover:text-fg-secondary transition-colors">Open</button>
            </div>
          )}
          {/* Type filter (includes artifact types) */}
          <div className="flex gap-1 overflow-x-auto scrollbar-hide">
            <FilterPill label="All types" value="" current={filterType || filterArtifact || ''} onClick={() => { setFilterType(''); setFilterArtifact(''); }} />
            {ALL_TYPES.map(t => (
              <FilterPill key={t} label={`${TYPE_META[t]?.icon ?? ''} ${t}`} value={t} current={filterType} onClick={v => { setFilterType(v); setFilterArtifact(''); }} />
            ))}
            {(['agent', 'team', 'skill'] as const).map(a => (
              <FilterPill key={a} label={`${ARTIFACT_META[a].icon} ${ARTIFACT_META[a].label}`} value={a} current={filterArtifact} onClick={v => { setFilterArtifact(v); setFilterType(''); }} />
            ))}
          </div>
          {/* Project filter */}
          {projects.length > 0 && (
            <div className="flex gap-1 overflow-x-auto scrollbar-hide">
              <FilterPill label="All projects" value="" current={filterProject} onClick={setFilterProject} />
              {projects.map(p => <FilterPill key={p.id} label={p.name} value={p.id} current={filterProject} onClick={setFilterProject} />)}
            </div>
          )}
          {/* Status filter */}
          <div className="flex gap-1 overflow-x-auto scrollbar-hide">
            <FilterPill label="Active" value="" current={filterStatus} onClick={setFilterStatus} />
            <FilterPill label="Verified" value="verified" current={filterStatus} onClick={setFilterStatus} />
            <FilterPill label="Outdated" value="outdated" current={filterStatus} onClick={setFilterStatus} />
          </div>
          {/* Group by */}
          <div className="flex gap-1.5 items-center">
            <span className="text-[10px] text-fg-tertiary">Group:</span>
            {(['date', 'project', 'agent', 'type'] as const).map(g => (
              <button key={g} onClick={() => { setGroupBy(g); setCollapsedGroups(new Set()); }}
                className={`px-2 py-1 rounded text-xs transition-colors ${groupBy === g ? 'bg-brand-600 text-white' : 'bg-surface-elevated text-fg-secondary hover:bg-surface-overlay'}`}>
                {g.charAt(0).toUpperCase() + g.slice(1)}
              </button>
            ))}
            {grouped.length > 1 && (
              <button
                onClick={toggleAllGroups}
                className="ml-auto px-1.5 py-1 rounded text-[10px] text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated transition-colors"
                title={collapsedGroups.size === grouped.length ? 'Expand all' : 'Collapse all'}
              >
                {collapsedGroups.size === grouped.length ? '▶ Expand' : '▼ Collapse'}
              </button>
            )}
          </div>
        </div>

        {flash && (
          <div className={`mx-4 mt-2 px-3 py-1.5 text-xs rounded-lg ${flash.type === 'success' ? 'bg-green-500/15 text-green-600' : 'bg-red-500/15 text-red-500'}`}>{flash.text}</div>
        )}

        <div ref={listRef} className="flex-1 overflow-y-auto p-2 space-y-1">
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
              <p className="text-sm text-fg-secondary">No deliverables yet</p>
              <p className="text-xs text-fg-tertiary mt-1 mb-3">Deliverables are created when tasks complete or manually</p>
              <button onClick={openContributeForm} className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors">+ Create first</button>
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
                          {ARTIFACT_META[item.artifactType].icon} {ARTIFACT_META[item.artifactType].label}
                        </span>
                      ) : (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium uppercase ${TYPE_META[item.type]?.color ?? 'bg-surface-overlay text-fg-secondary'}`}>{item.type}</span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_META[item.status]?.color ?? 'bg-surface-elevated text-fg-tertiary'}`}>{item.status}</span>
                      {item.agentId && <span className="text-[10px] text-fg-tertiary truncate">{agentMap.get(item.agentId)?.name ?? 'Agent'}</span>}
                    </div>
                  </button>
                ))}
              </div>
            );
          })}
          {loadingMore && (
            <div className="flex items-center justify-center gap-2 py-3 text-fg-tertiary">
              <Spinner /> <span className="text-[10px]">Loading more...</span>
            </div>
          )}
          {!loading && items.length > 0 && (
            <div className="text-center text-[10px] text-fg-tertiary py-2">
              {items.length < totalCount
                ? `${items.length} / ${totalCount} deliverables`
                : `${totalCount} deliverables`}
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
            <span className="text-sm font-medium truncate">{selected?.title ?? 'Details'}</span>
          </div>
        )}
        {!selected ? (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center text-fg-tertiary space-y-2">
              <svg className="w-12 h-12 mx-auto text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              <p className="text-sm">Select a deliverable to view details</p>
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
                    {actionLoading === 'verify' ? 'Verifying...' : 'Verify'}
                  </button>
                )}
                {selected.status !== 'outdated' && (
                  <button onClick={() => handleFlagOutdated(selected)} disabled={!!actionLoading}
                    className="px-3 py-1.5 text-xs rounded-lg bg-amber-600/20 text-amber-600 hover:bg-amber-600/30 disabled:opacity-50 transition-colors">
                    {actionLoading === 'flag' ? 'Flagging...' : 'Flag Outdated'}
                  </button>
                )}
                <button onClick={() => handleRemove(selected)} disabled={!!actionLoading}
                  className="px-3 py-1.5 text-xs rounded-lg bg-red-600/20 text-red-500 hover:bg-red-600/30 disabled:opacity-50 transition-colors">
                  {actionLoading === 'remove' ? 'Removing...' : 'Remove'}
                </button>
              </div>
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <span className={`px-2 py-0.5 rounded text-xs font-medium uppercase ${TYPE_META[selected.type]?.color ?? 'bg-surface-overlay text-fg-secondary'}`}>{TYPE_META[selected.type]?.icon ?? ''} {selected.type}</span>
                <span className={`px-2 py-0.5 rounded text-xs ${STATUS_META[selected.status]?.color ?? 'bg-surface-elevated text-fg-tertiary'}`}>{selected.status}</span>
                {selected.artifactType && ARTIFACT_META[selected.artifactType] && (
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${ARTIFACT_META[selected.artifactType].color}`}>
                    {ARTIFACT_META[selected.artifactType].icon} Builder {ARTIFACT_META[selected.artifactType].label}
                  </span>
                )}
              </div>
              {selected.reference && (selected.type === 'file' || selected.type === 'directory') && (
                <div className="flex items-center gap-2 mt-2 bg-surface-secondary/60 border border-border-default rounded-lg px-3 py-2">
                  <button
                    onClick={() => { api.files.reveal(selected.reference).catch(() => flashMsg('error', 'Failed to open file browser')); }}
                    className="text-xs font-mono text-brand-500 hover:text-brand-500 hover:underline truncate flex-1 text-left cursor-pointer"
                    title="Open in file browser"
                  >{selected.reference}</button>
                  <button
                    onClick={() => { api.files.reveal(selected.reference).catch(() => flashMsg('error', 'Failed to open file browser')); }}
                    className="px-2 py-1 text-[10px] rounded bg-brand-600/20 text-brand-500 hover:bg-brand-600/30 transition-colors shrink-0"
                    title="Reveal in Finder"
                  >Open</button>
                  <button
                    onClick={() => copyPath(selected.reference)}
                    className={`px-2 py-1 text-[10px] rounded transition-colors shrink-0 ${copiedPath ? 'bg-green-500/20 text-green-600' : 'bg-surface-overlay/50 text-fg-secondary hover:bg-surface-overlay'}`}
                    title="Copy path to clipboard"
                  >{copiedPath ? 'Copied!' : 'Copy'}</button>
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
                    <span className="text-[10px] text-fg-tertiary uppercase tracking-wider block mb-1">Artifact Directory</span>
                    <span className="text-xs text-fg-secondary font-mono break-all">{selected.reference}</span>
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleOpenInBuilder}
                    className="flex-1 px-4 py-2.5 bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    Open in Builder
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
                  <div className="flex items-center gap-2 text-fg-tertiary text-sm"><Spinner /> Loading preview...</div>
                ) : previewImage ? (
                  <div className="flex flex-col items-center gap-2">
                    <img src={previewImage.src} alt={previewImage.name} className="max-w-full max-h-[60vh] rounded-lg object-contain" />
                    <span className="text-xs text-fg-tertiary">{previewImage.name}</span>
                  </div>
                ) : previewContent ? (
                  renderMarkdownPreview(previewContent)
                ) : showCopyPath ? (
                  <div className="space-y-3">
                    <p className="text-sm text-fg-secondary">This {selected.type} cannot be previewed in the browser.</p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { api.files.reveal(selected!.reference).catch(() => flashMsg('error', 'Failed to open')); }}
                        className="text-xs bg-surface-elevated px-3 py-2 rounded text-brand-500 hover:text-brand-500 hover:underline flex-1 truncate text-left cursor-pointer font-mono"
                        title="Open in file browser"
                      >{selected.reference}</button>
                      <button onClick={() => { api.files.reveal(selected!.reference).catch(() => flashMsg('error', 'Failed to open')); }}
                        className="px-3 py-2 text-xs rounded-lg bg-brand-600/20 text-brand-500 hover:bg-brand-600/30 transition-colors shrink-0">Open</button>
                      <button onClick={() => copyPath(selected!.reference)}
                        className={`px-3 py-2 text-xs rounded-lg transition-colors shrink-0 ${copiedPath ? 'bg-green-500/20 text-green-600' : 'bg-surface-overlay/50 text-fg-secondary hover:bg-surface-overlay'}`}>{copiedPath ? 'Copied!' : 'Copy'}</button>
                    </div>
                  </div>
                ) : selected.summary ? (
                  renderMarkdownPreview(selected.summary)
                ) : (
                  <p className="text-sm text-fg-tertiary italic">No content</p>
                )}
              </div>
            )}

            {/* Diff stats / test results */}
            {(selected.diffStats || selected.testResults) && (
              <div className="flex gap-4 flex-wrap">
                {selected.diffStats && (
                  <div className="bg-surface-secondary border border-border-default rounded-lg px-4 py-3 text-xs space-y-1">
                    <div className="text-fg-tertiary font-medium">Diff Stats</div>
                    <div className="flex gap-3">
                      <span className="text-fg-secondary">{selected.diffStats.filesChanged} files</span>
                      <span className="text-green-600">+{selected.diffStats.additions}</span>
                      <span className="text-red-500">-{selected.diffStats.deletions}</span>
                    </div>
                  </div>
                )}
                {selected.testResults && (
                  <div className="bg-surface-secondary border border-border-default rounded-lg px-4 py-3 text-xs space-y-1">
                    <div className="text-fg-tertiary font-medium">Tests</div>
                    <div className="flex gap-3">
                      <span className="text-green-600">{selected.testResults.passed} passed</span>
                      <span className="text-red-500">{selected.testResults.failed} failed</span>
                      <span className="text-fg-secondary">{selected.testResults.skipped} skipped</span>
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
              <div className="text-xs text-fg-tertiary font-medium">Links</div>
              <div className="flex gap-3 flex-wrap">
                {selected.taskId && (
                  <button onClick={() => navBus.navigate('projects', { openTask: selected.taskId! })}
                    className="text-xs text-brand-500 hover:underline bg-brand-500/10 px-2.5 py-1 rounded">
                    Task: {selected.taskId.slice(0, 12)}...
                  </button>
                )}
                {selected.agentId && (
                  <button onClick={() => navBus.navigate('team', { selectAgent: selected.agentId! })}
                    className="text-xs text-blue-600 hover:underline bg-blue-500/10 px-2.5 py-1 rounded">
                    Agent: {agentMap.get(selected.agentId)?.name ?? selected.agentId.slice(0, 12)}
                  </button>
                )}
                {selected.projectId && (
                  <button onClick={() => navBus.navigate('projects', { projectId: selected.projectId! })}
                    className="text-xs text-blue-600 hover:underline bg-blue-500/10 px-2.5 py-1 rounded">
                    Project: {projectMap.get(selected.projectId)?.name ?? selected.projectId.slice(0, 12)}
                  </button>
                )}
              </div>
            </div>

            {/* Metadata */}
            <div className="text-xs text-fg-tertiary space-y-1 border-t border-border-default pt-4">
              <div className="flex gap-6 flex-wrap">
                <span>Created: <span className="text-fg-secondary">{new Date(selected.createdAt).toLocaleString()}</span></span>
                <span>Updated: <span className="text-fg-secondary">{new Date(selected.updatedAt).toLocaleString()}</span></span>
                <span>Accessed: <span className="text-fg-secondary">{selected.accessCount}x</span></span>
              </div>
              <div className="text-fg-muted select-all">ID: {selected.id}</div>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !creating && setShowCreate(false)}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[36rem] space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-fg-primary">Create Deliverable</h3>

            <div>
              <label className="text-xs text-fg-tertiary block mb-1">Type</label>
              <select value={newType} onChange={e => setNewType(e.target.value)}
                className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary">
                {ALL_TYPES.map(t => <option key={t} value={t}>{TYPE_META[t]?.icon ?? ''} {t}</option>)}
              </select>
            </div>

            <div>
              <label className="text-xs text-fg-tertiary block mb-1">Title <span className="text-red-500">*</span></label>
              <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Clear, searchable title"
                className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary focus:border-brand-500 focus:outline-none transition-colors" />
            </div>

            <div>
              <label className="text-xs text-fg-tertiary block mb-1">Reference <span className="text-fg-tertiary">(file path, URL, branch name)</span></label>
              <input value={newReference} onChange={e => setNewReference(e.target.value)} placeholder="/path/to/file or https://..."
                className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary focus:border-brand-500 focus:outline-none transition-colors font-mono" />
            </div>

            <div>
              <label className="text-xs text-fg-tertiary block mb-1">Summary <span className="text-red-500">*</span> <span className="text-fg-tertiary">(Markdown)</span></label>
              <textarea value={newSummary} onChange={e => setNewSummary(e.target.value)}
                placeholder="Describe the deliverable..."
                className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary h-36 resize-none focus:border-brand-500 focus:outline-none transition-colors font-mono" />
            </div>

            <div className="flex gap-4">
              <div className="flex-1">
                <label className="text-xs text-fg-tertiary block mb-1">Tags <span className="text-fg-tertiary">(comma separated)</span></label>
                <input value={newTags} onChange={e => setNewTags(e.target.value)} placeholder="react, api, docs"
                  className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary focus:border-brand-500 focus:outline-none transition-colors" />
              </div>
              <div className="flex-1">
                <label className="text-xs text-fg-tertiary block mb-1">Project</label>
                <select value={newProjectId} onChange={e => setNewProjectId(e.target.value)}
                  className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary">
                  <option value="">None</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-1 border-t border-border-default">
              <button onClick={() => setShowCreate(false)} disabled={creating}
                className="text-sm text-fg-tertiary hover:text-fg-secondary disabled:opacity-50 transition-colors py-2">Cancel</button>
              <button onClick={handleCreate}
                disabled={creating || !newTitle.trim() || !newSummary.trim()}
                className="bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50 flex items-center gap-2 transition-colors">
                {creating && <Spinner />}
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function buildStyledHtml(sourceEl: HTMLElement, theme: 'light' | 'dark'): string {
  const clone = sourceEl.cloneNode(true) as HTMLElement;
  const t = theme === 'light'
    ? {
        bg: '#ffffff', text: '#24292f', heading: '#1f2328', strong: '#1f2328',
        link: '#0969da', codeBg: '#eff1f3', codeText: '#24292f',
        preBg: '#f6f8fa', preText: '#24292f', preBorder: '#d0d7de',
        border: '#d0d7de', blockquoteBorder: '#d0d7de', blockquoteText: '#656d76',
        tableBorder: '#d0d7de', tableHeaderBg: '#f6f8fa', tableHeaderText: '#24292f',
        hrColor: '#d8dee4',
      }
    : {
        bg: '#0d1117', text: '#e6edf3', heading: '#f0f6fc', strong: '#f0f6fc',
        link: '#58a6ff', codeBg: '#161b22', codeText: '#e6edf3',
        preBg: '#161b22', preText: '#e6edf3', preBorder: '#30363d',
        border: '#30363d', blockquoteBorder: '#3b82f6', blockquoteText: '#8b949e',
        tableBorder: '#30363d', tableHeaderBg: '#161b22', tableHeaderText: '#e6edf3',
        hrColor: '#21262d',
      };

  const styleMap: Record<string, string> = {
    'p': `margin:0 0 10px;color:${t.text};line-height:1.7;`,
    'h1': `font-size:1.6em;font-weight:700;color:${t.heading};margin:20px 0 10px;line-height:1.3;border-bottom:1px solid ${t.border};padding-bottom:6px;`,
    'h2': `font-size:1.35em;font-weight:700;color:${t.heading};margin:18px 0 8px;line-height:1.3;`,
    'h3': `font-size:1.15em;font-weight:600;color:${t.heading};margin:14px 0 6px;line-height:1.3;`,
    'h4': `font-size:1em;font-weight:600;color:${t.heading};margin:12px 0 4px;`,
    'strong': `font-weight:600;color:${t.strong};`,
    'em': `font-style:italic;`,
    'a': `color:${t.link};text-decoration:underline;`,
    'ul': `padding-left:1.5em;margin:0 0 10px;`,
    'ol': `padding-left:1.5em;margin:0 0 10px;`,
    'li': `margin:3px 0;line-height:1.7;color:${t.text};`,
    'blockquote': `border-left:3px solid ${t.blockquoteBorder};padding:2px 0 2px 14px;margin:10px 0;color:${t.blockquoteText};`,
    'hr': `border:none;border-top:1px solid ${t.hrColor};margin:20px 0;`,
    'table': `border-collapse:collapse;width:100%;margin:10px 0;`,
    'thead': `background:${t.tableHeaderBg};`,
    'th': `border:1px solid ${t.tableBorder};padding:8px 12px;text-align:left;font-weight:600;color:${t.tableHeaderText};`,
    'td': `border:1px solid ${t.tableBorder};padding:8px 12px;color:${t.text};`,
    'img': 'max-width:100%;height:auto;',
  };

  function processNode(el: Element) {
    el.removeAttribute('class');
    const tag = el.tagName.toLowerCase();

    if (tag === 'pre') {
      el.setAttribute('style', `background:${t.preBg};color:${t.preText};padding:14px;border-radius:6px;overflow-x:auto;margin:10px 0;font-size:0.88em;line-height:1.5;border:1px solid ${t.preBorder};`);
      const codeChild = el.querySelector('code');
      if (codeChild) {
        codeChild.removeAttribute('class');
        codeChild.setAttribute('style', `background:transparent;padding:0;border-radius:0;color:inherit;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:inherit;`);
      }
      return;
    }

    if (tag === 'code') {
      el.setAttribute('style', `background:${t.codeBg};color:${t.codeText};padding:2px 6px;border-radius:4px;font-size:0.9em;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;`);
    } else if (styleMap[tag]) {
      el.setAttribute('style', styleMap[tag]!);
    }

    Array.from(el.children).forEach(processNode);
  }

  clone.removeAttribute('class');
  Array.from(clone.children).forEach(child => processNode(child as Element));

  return `<div style="background:${t.bg};color:${t.text};padding:20px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;max-width:800px;">${clone.innerHTML}</div>`;
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
