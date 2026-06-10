import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type AgentInfo, type TaskInfo, type ProjectInfo, type DeliverableInfo, type RequirementInfo, type WorkflowInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE, type PageId } from '../routes.ts';
import { Avatar } from './Avatar.tsx';

type SearchCategory = 'all' | 'agents' | 'tasks' | 'requirements' | 'projects' | 'deliverables' | 'workflows';

interface SearchResults {
  agents: AgentInfo[];
  tasks: TaskInfo[];
  requirements: RequirementInfo[];
  projects: ProjectInfo[];
  deliverables: DeliverableInfo[];
  workflows: WorkflowInfo[];
}

interface FlatItem {
  id: string;
  type: 'agent' | 'task' | 'requirement' | 'project' | 'deliverable' | 'workflow' | 'showMore';
  page: PageId;
  params?: Record<string, string>;
  expandCategory?: SearchCategory;
  totalCount?: number;
}

const EMPTY: SearchResults = { agents: [], tasks: [], requirements: [], projects: [], deliverables: [], workflows: [] };

type SectionId = 'agents' | 'tasks' | 'requirements' | 'projects' | 'deliverables' | 'workflows';

const PAGE_SECTION_ORDER: Record<string, SectionId[]> = {
  team: ['agents', 'workflows', 'tasks', 'requirements', 'projects', 'deliverables'],
  work: ['workflows', 'projects', 'requirements', 'tasks', 'agents', 'deliverables'],
  deliverables: ['deliverables', 'agents', 'tasks', 'requirements', 'projects', 'workflows'],
};
const DEFAULT_ORDER: SectionId[] = ['agents', 'tasks', 'requirements', 'projects', 'deliverables', 'workflows'];

let _persistedQuery = '';
let _persistedCategory: SearchCategory = 'all';
let _persistedResults: SearchResults = EMPTY;
let _persistedSearched = false;

export function SearchModal({ onClose, currentPage }: { onClose: () => void; currentPage?: string }) {
  const { t } = useTranslation(['common', 'home', 'work']);
  const [query, setQuery] = useState(_persistedQuery);
  const [category, setCategory] = useState<SearchCategory>(_persistedCategory);
  const [results, setResults] = useState<SearchResults>(_persistedResults);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(_persistedSearched);
  const [focusIdx, setFocusIdx] = useState(-1);

  useEffect(() => { _persistedQuery = query; }, [query]);
  useEffect(() => { _persistedCategory = category; }, [category]);
  useEffect(() => { _persistedResults = results; }, [results]);
  useEffect(() => { _persistedSearched = searched; }, [searched]);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const backdropRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 100);
  }, []);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults(EMPTY); setSearched(false); setFocusIdx(-1); return; }
    setLoading(true);
    setSearched(true);
    setFocusIdx(-1);
    const lower = q.toLowerCase();
    try {
      const [agentsRes, tasksRes, requirementsRes, projectsRes, deliverablesRes, teamsRes] = await Promise.allSettled([
        api.agents.list(),
        api.tasks.list({ search: q, pageSize: 20 }),
        api.requirements.list(),
        api.projects.list(),
        api.deliverables.search({ q, limit: 20 }),
        api.teams.list(),
      ]);
      const agents = agentsRes.status === 'fulfilled'
        ? agentsRes.value.agents.filter(a => a.name?.toLowerCase().includes(lower) || a.role?.toLowerCase().includes(lower))
        : [];
      const tasks = tasksRes.status === 'fulfilled' ? tasksRes.value.tasks : [];
      const requirements = requirementsRes.status === 'fulfilled'
        ? requirementsRes.value.requirements.filter(r => r.title?.toLowerCase().includes(lower) || r.description?.toLowerCase().includes(lower))
        : [];
      const projects = projectsRes.status === 'fulfilled'
        ? projectsRes.value.projects.filter(p => p.name?.toLowerCase().includes(lower) || p.description?.toLowerCase().includes(lower))
        : [];
      const deliverables = deliverablesRes.status === 'fulfilled' ? deliverablesRes.value.results : [];
      const workflows: WorkflowInfo[] = [];
      if (teamsRes.status === 'fulfilled') {
        const wfFetches = await Promise.allSettled(
          teamsRes.value.teams.map(team => api.workflows.list(team.id)),
        );
        for (const wfRes of wfFetches) {
          if (wfRes.status === 'fulfilled') {
            for (const wf of wfRes.value.workflows) {
              if (wf.name.toLowerCase().includes(lower) || (wf.displayName || '').toLowerCase().includes(lower) || wf.description?.toLowerCase().includes(lower)) {
                workflows.push(wf);
              }
            }
          }
        }
      }
      setResults({ agents, tasks, requirements, projects, deliverables, workflows });
    } catch {
      setResults(EMPTY);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInput = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 400);
  };

  const navigate = useCallback((page: PageId, params?: Record<string, string>) => {
    onClose();
    navBus.navigate(page, params);
  }, [onClose]);

  const categories: { id: SearchCategory; label: string }[] = [
    { id: 'all', label: t('common:all', { defaultValue: '全部' }) },
    { id: 'agents', label: t('common:agents', { defaultValue: '智能体' }) },
    { id: 'tasks', label: t('common:tasks', { defaultValue: '任务' }) },
    { id: 'requirements', label: t('common:requirements', { defaultValue: '需求' }) },
    { id: 'projects', label: t('common:projects', { defaultValue: '项目' }) },
    { id: 'deliverables', label: t('common:deliverables', { defaultValue: '交付物' }) },
    { id: 'workflows', label: t('common:workflows', { defaultValue: '工作流' }) },
  ];

  const sectionOrder = useMemo(() => PAGE_SECTION_ORDER[currentPage || ''] || DEFAULT_ORDER, [currentPage]);

  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = [];
    const limit = category === 'all' ? 8 : undefined;
    const addSection = (section: SectionId) => {
      if (category !== 'all' && category !== section) return;
      const arr = results[section];
      const sliced = limit ? arr.slice(0, limit) : arr;
      for (const item of sliced) {
        switch (section) {
          case 'agents': items.push({ id: item.id, type: 'agent', page: PAGE.TEAM, params: { agentId: item.id } }); break;
          case 'tasks': items.push({ id: item.id, type: 'task', page: PAGE.WORK, params: { openTask: item.id } }); break;
          case 'requirements': items.push({ id: item.id, type: 'requirement', page: PAGE.WORK, params: { openRequirement: item.id } }); break;
          case 'projects': items.push({ id: item.id, type: 'project', page: PAGE.WORK, params: { projectId: item.id } }); break;
          case 'deliverables': items.push({ id: item.id, type: 'deliverable', page: PAGE.DELIVERABLES, params: { openDeliverable: item.id } }); break;
          case 'workflows': items.push({ id: (item as unknown as WorkflowInfo).name, type: 'workflow', page: PAGE.WORK, params: { boardType: 'workflows' } }); break;
        }
      }
      if (limit && arr.length > limit) {
        items.push({ id: `more_${section}`, type: 'showMore', page: '' as PageId, expandCategory: section as SearchCategory, totalCount: arr.length });
      }
    };
    for (const s of sectionOrder) addSection(s);
    return items;
  }, [results, category, sectionOrder]);

  const openItem = useCallback((item: FlatItem) => {
    if (item.type === 'showMore' && item.expandCategory) {
      setCategory(item.expandCategory);
      setFocusIdx(-1);
      return;
    }
    navigate(item.page, item.params);
  }, [navigate]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || focusIdx < 0) return;
    const target = el.querySelector(`[data-idx="${focusIdx}"]`);
    if (target) target.scrollIntoView({ block: 'nearest' });
  }, [focusIdx]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const catIds = categories.map(c => c.id);
      const curIdx = catIds.indexOf(category);
      const next = e.shiftKey
        ? (curIdx <= 0 ? catIds.length - 1 : curIdx - 1)
        : (curIdx >= catIds.length - 1 ? 0 : curIdx + 1);
      setCategory(catIds[next]);
      setFocusIdx(-1);
      return;
    }
    const isDown = (e.ctrlKey && e.key === 'n') || e.key === 'ArrowDown';
    const isUp = (e.ctrlKey && e.key === 'p') || e.key === 'ArrowUp';
    if (isDown || isUp) {
      e.preventDefault();
      setFocusIdx(prev => {
        const max = flatItems.length - 1;
        if (max < 0) return -1;
        if (isDown) return prev >= max ? 0 : prev + 1;
        return prev <= 0 ? max : prev - 1;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (focusIdx >= 0 && focusIdx < flatItems.length) {
        openItem(flatItems[focusIdx]);
      }
    }
  }, [onClose, flatItems, focusIdx, openItem, categories, category]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const hasResults = flatItems.length > 0;

  let itemCounter = 0;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 pt-[8vh]"
      onClick={e => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="bg-surface-primary border border-border-default rounded-2xl shadow-2xl w-full max-w-3xl max-h-[78vh] flex flex-col overflow-hidden animate-fadeIn">
        {/* Search input */}
        <div className="shrink-0 px-5 pt-4 pb-3 border-b border-border-default space-y-3">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <input
              ref={inputRef}
              value={query}
              onChange={e => handleInput(e.target.value)}
              placeholder={t('common:search')}
              className="w-full bg-surface-elevated border border-border-default rounded-xl pl-9 pr-9 py-2.5 text-sm text-fg-primary placeholder:text-fg-tertiary focus:border-brand-500 focus:outline-none transition-colors"
            />
            {query && (
              <button
                onClick={() => { setQuery(''); setResults(EMPTY); setSearched(false); setFocusIdx(-1); inputRef.current?.focus(); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-tertiary hover:text-fg-secondary"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            )}
          </div>
          <div className="flex gap-1 overflow-x-auto scrollbar-hide">
            {categories.map(cat => (
              <button
                key={cat.id}
                onClick={() => { setCategory(cat.id); setFocusIdx(-1); }}
                className={`px-3 py-1.5 text-xs rounded-lg whitespace-nowrap transition-colors ${
                  category === cat.id ? 'bg-brand-600 text-white' : 'bg-surface-elevated text-fg-secondary hover:text-fg-primary'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-5 py-3">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="text-fg-tertiary text-sm animate-pulse">{t('common:loading')}</div>
            </div>
          )}

          {!loading && searched && !hasResults && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-tertiary mb-2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <p className="text-sm text-fg-tertiary">{t('common:noResults', { defaultValue: '没有找到相关结果' })}</p>
            </div>
          )}

          {!loading && hasResults && (
            <div className="space-y-4">
              {sectionOrder.map(section => {
                if (category !== 'all' && category !== section) return null;
                const limit = category === 'all' ? 8 : undefined;
                const showMoreBtn = (cat: SearchCategory) => {
                  const idx = itemCounter++;
                  const total = cat === 'agents' ? results.agents.length
                    : cat === 'tasks' ? results.tasks.length
                    : cat === 'requirements' ? results.requirements.length
                    : cat === 'projects' ? results.projects.length
                    : cat === 'workflows' ? results.workflows.length
                    : results.deliverables.length;
                  return (
                    <button data-idx={idx} onClick={() => { setCategory(cat); setFocusIdx(-1); }} className={`mt-1 w-full text-xs py-1.5 rounded-lg transition-colors ${idx === focusIdx ? 'bg-brand-600/15 ring-1 ring-brand-500/40 text-brand-500' : 'text-brand-500 hover:text-brand-400 hover:bg-surface-overlay'}`}>
                      {t('common:showAll', { defaultValue: '查看全部' })} ({total})
                    </button>
                  );
                };
                if (section === 'agents' && results.agents.length > 0) return (
                  <section key="agents">
                    <h3 className="text-xs font-medium text-fg-tertiary uppercase mb-2">{t('common:agents', { defaultValue: '智能体' })}</h3>
                    <div className="space-y-0.5">
                      {(limit ? results.agents.slice(0, limit) : results.agents).map(agent => {
                        const idx = itemCounter++;
                        return (
                          <button key={agent.id} data-idx={idx} onClick={() => navigate(PAGE.TEAM, { agentId: agent.id })} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-colors text-left ${idx === focusIdx ? 'bg-brand-600/15 ring-1 ring-brand-500/40' : 'hover:bg-surface-overlay'}`}>
                            <Avatar name={agent.name || 'Agent'} avatarUrl={agent.avatarUrl} size={28} />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-fg-primary truncate">{agent.name}</div>
                              <div className="text-xs text-fg-tertiary truncate">{agent.role || agent.status}</div>
                            </div>
                            <StatusDot status={agent.status} />
                          </button>
                        );
                      })}
                    </div>
                    {limit && results.agents.length > limit && showMoreBtn('agents')}
                  </section>
                );
                if (section === 'tasks' && results.tasks.length > 0) return (
                  <section key="tasks">
                    <h3 className="text-xs font-medium text-fg-tertiary uppercase mb-2">{t('common:tasks', { defaultValue: '任务' })}</h3>
                    <div className="space-y-0.5">
                      {(limit ? results.tasks.slice(0, limit) : results.tasks).map(task => {
                        const idx = itemCounter++;
                        return (
                          <button key={task.id} data-idx={idx} onClick={() => navigate(PAGE.WORK, { openTask: task.id })} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-colors text-left ${idx === focusIdx ? 'bg-brand-600/15 ring-1 ring-brand-500/40' : 'hover:bg-surface-overlay'}`}>
                            <TaskStatusIcon status={task.status} />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-fg-primary truncate">{task.title}</div>
                              <div className="text-xs text-fg-tertiary truncate">{task.status} · {task.priority || ''}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {limit && results.tasks.length > limit && showMoreBtn('tasks')}
                  </section>
                );
                if (section === 'requirements' && results.requirements.length > 0) return (
                  <section key="requirements">
                    <h3 className="text-xs font-medium text-fg-tertiary uppercase mb-2">{t('common:requirements', { defaultValue: '需求' })}</h3>
                    <div className="space-y-0.5">
                      {(limit ? results.requirements.slice(0, limit) : results.requirements).map(req => {
                        const idx = itemCounter++;
                        return (
                          <button key={req.id} data-idx={idx} onClick={() => navigate(PAGE.WORK, { openRequirement: req.id })} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-colors text-left ${idx === focusIdx ? 'bg-brand-600/15 ring-1 ring-brand-500/40' : 'hover:bg-surface-overlay'}`}>
                            <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                              req.status === 'approved' ? 'text-green-500 bg-green-500/15'
                              : req.status === 'pending' ? 'text-amber-500 bg-amber-500/15'
                              : req.status === 'rejected' ? 'text-red-500 bg-red-500/15'
                              : 'text-fg-tertiary bg-surface-elevated'
                            }`}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-fg-primary truncate">{req.title}</div>
                              <div className="text-xs text-fg-tertiary truncate">{req.status} · {req.priority || ''}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {limit && results.requirements.length > limit && showMoreBtn('requirements')}
                  </section>
                );
                if (section === 'projects' && results.projects.length > 0) return (
                  <section key="projects">
                    <h3 className="text-xs font-medium text-fg-tertiary uppercase mb-2">{t('common:projects', { defaultValue: '项目' })}</h3>
                    <div className="space-y-0.5">
                      {(limit ? results.projects.slice(0, limit) : results.projects).map(proj => {
                        const idx = itemCounter++;
                        return (
                          <button key={proj.id} data-idx={idx} onClick={() => navigate(PAGE.WORK, { projectId: proj.id })} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-colors text-left ${idx === focusIdx ? 'bg-brand-600/15 ring-1 ring-brand-500/40' : 'hover:bg-surface-overlay'}`}>
                            <div className="w-7 h-7 rounded-lg bg-brand-500/15 flex items-center justify-center shrink-0">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-brand-500"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-fg-primary truncate">{proj.name}</div>
                              {proj.description && <div className="text-xs text-fg-tertiary truncate">{proj.description}</div>}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {limit && results.projects.length > limit && showMoreBtn('projects')}
                  </section>
                );
                if (section === 'deliverables' && results.deliverables.length > 0) return (
                  <section key="deliverables">
                    <h3 className="text-xs font-medium text-fg-tertiary uppercase mb-2">{t('common:deliverables', { defaultValue: '交付物' })}</h3>
                    <div className="space-y-0.5">
                      {(limit ? results.deliverables.slice(0, limit) : results.deliverables).map(d => {
                        const idx = itemCounter++;
                        return (
                          <button key={d.id} data-idx={idx} onClick={() => navigate(PAGE.DELIVERABLES, { openDeliverable: d.id })} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-colors text-left ${idx === focusIdx ? 'bg-brand-600/15 ring-1 ring-brand-500/40' : 'hover:bg-surface-overlay'}`}>
                            <div className="w-7 h-7 rounded-lg bg-purple-500/15 flex items-center justify-center shrink-0">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-purple-500"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-fg-primary truncate">{d.title}</div>
                              <div className="text-xs text-fg-tertiary truncate">{d.type} · {d.status}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {limit && results.deliverables.length > limit && showMoreBtn('deliverables')}
                  </section>
                );
                if (section === 'workflows' && results.workflows.length > 0) return (
                  <section key="workflows">
                    <h3 className="text-xs font-medium text-fg-tertiary uppercase mb-2">{t('common:workflows', { defaultValue: '工作流' })}</h3>
                    <div className="space-y-0.5">
                      {(limit ? results.workflows.slice(0, limit) : results.workflows).map(wf => {
                        const idx = itemCounter++;
                        return (
                          <button key={wf.name} data-idx={idx} onClick={() => navigate(PAGE.WORK, { boardType: 'workflows' })} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-colors text-left ${idx === focusIdx ? 'bg-brand-600/15 ring-1 ring-brand-500/40' : 'hover:bg-surface-overlay'}`}>
                            <div className="w-7 h-7 rounded-lg bg-teal-500/15 flex items-center justify-center shrink-0">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-teal-500"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-fg-primary truncate">{wf.displayName || wf.name}</div>
                              <div className="text-xs text-fg-tertiary truncate">{wf.stepCount} steps · v{wf.version}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {limit && results.workflows.length > limit && showMoreBtn('workflows')}
                  </section>
                );
                return null;
              })}
            </div>
          )}

          {!loading && !searched && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-tertiary mb-2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <p className="text-sm text-fg-tertiary">{t('common:searchHint', { defaultValue: '输入关键词搜索' })}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 px-5 py-2 border-t border-border-default flex items-center gap-4 text-xs text-fg-tertiary flex-wrap">
          <span><kbd className="px-1.5 py-0.5 rounded bg-surface-elevated border border-border-default text-[11px] font-medium">{navigator.platform.toUpperCase().includes('MAC') ? 'Cmd+P' : 'Ctrl+P'}</kbd> {t('common:toggle', { defaultValue: '唤起/关闭' })}</span>
          <span><kbd className="px-1.5 py-0.5 rounded bg-surface-elevated border border-border-default text-[11px] font-medium">Tab</kbd> {t('common:switchTab', { defaultValue: '切换分类' })}</span>
          <span><kbd className="px-1.5 py-0.5 rounded bg-surface-elevated border border-border-default text-[11px] font-medium">↑↓</kbd> {t('common:navigate', { defaultValue: '导航' })}</span>
          <span><kbd className="px-1.5 py-0.5 rounded bg-surface-elevated border border-border-default text-[11px] font-medium">Enter</kbd> {t('common:open', { defaultValue: '打开' })}</span>
          <span><kbd className="px-1.5 py-0.5 rounded bg-surface-elevated border border-border-default text-[11px] font-medium">Esc</kbd> {t('common:close', { defaultValue: '关闭' })}</span>
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'active' || status === 'idle' ? 'bg-green-500'
    : status === 'working' || status === 'busy' ? 'bg-blue-500'
    : status === 'paused' ? 'bg-amber-500'
    : 'bg-gray-400';
  return <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

function TaskStatusIcon({ status }: { status: string }) {
  const color = status === 'completed' ? 'text-green-500 bg-green-500/15'
    : status === 'in_progress' ? 'text-blue-500 bg-blue-500/15'
    : status === 'pending' ? 'text-amber-500 bg-amber-500/15'
    : 'text-fg-tertiary bg-surface-elevated';
  return (
    <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${color}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
    </div>
  );
}
