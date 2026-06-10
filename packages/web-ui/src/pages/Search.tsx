import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type AgentInfo, type TaskInfo, type ProjectInfo, type DeliverableInfo, type RequirementInfo, type WorkflowInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { Avatar } from '../components/Avatar.tsx';

type SearchCategory = 'all' | 'agents' | 'tasks' | 'requirements' | 'projects' | 'deliverables' | 'workflows';

interface SearchResults {
  agents: AgentInfo[];
  tasks: TaskInfo[];
  requirements: RequirementInfo[];
  projects: ProjectInfo[];
  deliverables: DeliverableInfo[];
  workflows: WorkflowInfo[];
}

export function SearchPage() {
  const { t } = useTranslation(['common', 'home', 'work']);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SearchCategory>('all');
  const [results, setResults] = useState<SearchResults>({ agents: [], tasks: [], requirements: [], projects: [], deliverables: [], workflows: [] });
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults({ agents: [], tasks: [], requirements: [], projects: [], deliverables: [], workflows: [] });
      setSearched(false);
      return;
    }
    setLoading(true);
    setSearched(true);
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
      setResults({ agents: [], tasks: [], requirements: [], projects: [], deliverables: [], workflows: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInput = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 400);
  };

  const categories: { id: SearchCategory; label: string }[] = [
    { id: 'all', label: t('common:all', { defaultValue: '全部' }) },
    { id: 'agents', label: t('common:agents', { defaultValue: '智能体' }) },
    { id: 'tasks', label: t('common:tasks', { defaultValue: '任务' }) },
    { id: 'requirements', label: t('common:requirements', { defaultValue: '需求' }) },
    { id: 'projects', label: t('common:projects', { defaultValue: '项目' }) },
    { id: 'deliverables', label: t('common:deliverables', { defaultValue: '交付物' }) },
    { id: 'workflows', label: t('common:workflows', { defaultValue: '工作流' }) },
  ];

  const hasResults = results.agents.length > 0 || results.tasks.length > 0 || results.requirements.length > 0 || results.projects.length > 0 || results.deliverables.length > 0 || results.workflows.length > 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Search header */}
      <div className="shrink-0 px-4 pt-4 pb-2 space-y-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navBus.navigate(PAGE.HOME)}
            className="p-1.5 rounded-lg hover:bg-surface-overlay transition-colors shrink-0"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><polyline points="12 19 5 12 12 5" /></svg>
          </button>
          <div className="flex-1 relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <input
              ref={inputRef}
              value={query}
              onChange={e => handleInput(e.target.value)}
              placeholder={t('common:search')}
              className="w-full bg-surface-elevated border border-border-default rounded-xl pl-9 pr-3 py-2.5 text-sm text-fg-primary placeholder:text-fg-tertiary focus:border-brand-500 focus:outline-none transition-colors"
            />
            {query && (
              <button
                onClick={() => { setQuery(''); setResults({ agents: [], tasks: [], requirements: [], projects: [], deliverables: [], workflows: [] }); setSearched(false); inputRef.current?.focus(); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-tertiary hover:text-fg-secondary"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            )}
          </div>
        </div>
        <div className="flex gap-1 overflow-x-auto scrollbar-hide">
          {categories.map(cat => (
            <button
              key={cat.id}
              onClick={() => setCategory(cat.id)}
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
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="text-fg-tertiary text-sm animate-pulse">{t('common:loading')}</div>
          </div>
        )}

        {!loading && searched && !hasResults && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-tertiary mb-3"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <p className="text-sm text-fg-tertiary">{t('common:noResults', { defaultValue: '没有找到相关结果' })}</p>
          </div>
        )}

        {!loading && hasResults && (
          <div className="space-y-4">
            {/* Agents */}
            {(category === 'all' || category === 'agents') && results.agents.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-fg-tertiary uppercase mb-2">{t('common:agents', { defaultValue: '智能体' })}</h3>
                <div className="space-y-1">
                  {(category === 'all' ? results.agents.slice(0, 8) : results.agents).map(agent => (
                    <button
                      key={agent.id}
                      onClick={() => navBus.navigate(PAGE.TEAM, { agentId: agent.id })}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-overlay transition-colors text-left"
                    >
                      <Avatar name={agent.name || 'Agent'} avatarUrl={agent.avatarUrl} size={32} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-fg-primary truncate">{agent.name}</div>
                        <div className="text-xs text-fg-tertiary truncate">{agent.role || agent.status}</div>
                      </div>
                      <StatusDot status={agent.status} />
                    </button>
                  ))}
                </div>
                {category === 'all' && results.agents.length > 8 && (
                  <button onClick={() => setCategory('agents')} className="mt-1 w-full text-xs text-brand-500 hover:text-brand-400 py-1.5 rounded-lg hover:bg-surface-overlay transition-colors">
                    {t('common:showAll', { defaultValue: '查看全部' })} ({results.agents.length})
                  </button>
                )}
              </section>
            )}

            {/* Tasks */}
            {(category === 'all' || category === 'tasks') && results.tasks.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-fg-tertiary uppercase mb-2">{t('common:tasks', { defaultValue: '任务' })}</h3>
                <div className="space-y-1">
                  {(category === 'all' ? results.tasks.slice(0, 8) : results.tasks).map(task => (
                    <button
                      key={task.id}
                      onClick={() => navBus.navigate(PAGE.WORK, { openTask: task.id })}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-overlay transition-colors text-left"
                    >
                      <TaskStatusIcon status={task.status} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-fg-primary truncate">{task.title}</div>
                        <div className="text-xs text-fg-tertiary truncate">{task.status} · {task.priority || ''}</div>
                      </div>
                    </button>
                  ))}
                </div>
                {category === 'all' && results.tasks.length > 8 && (
                  <button onClick={() => setCategory('tasks')} className="mt-1 w-full text-xs text-brand-500 hover:text-brand-400 py-1.5 rounded-lg hover:bg-surface-overlay transition-colors">
                    {t('common:showAll', { defaultValue: '查看全部' })} ({results.tasks.length})
                  </button>
                )}
              </section>
            )}

            {/* Requirements */}
            {(category === 'all' || category === 'requirements') && results.requirements.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-fg-tertiary uppercase mb-2">{t('common:requirements', { defaultValue: '需求' })}</h3>
                <div className="space-y-1">
                  {(category === 'all' ? results.requirements.slice(0, 8) : results.requirements).map(req => (
                    <button
                      key={req.id}
                      onClick={() => navBus.navigate(PAGE.WORK, { openRequirement: req.id })}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-overlay transition-colors text-left"
                    >
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                        req.status === 'approved' ? 'text-green-500 bg-green-500/15'
                        : req.status === 'pending' ? 'text-amber-500 bg-amber-500/15'
                        : req.status === 'rejected' ? 'text-red-500 bg-red-500/15'
                        : 'text-fg-tertiary bg-surface-elevated'
                      }`}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-fg-primary truncate">{req.title}</div>
                        <div className="text-xs text-fg-tertiary truncate">{req.status} · {req.priority || ''}</div>
                      </div>
                    </button>
                  ))}
                </div>
                {category === 'all' && results.requirements.length > 8 && (
                  <button onClick={() => setCategory('requirements')} className="mt-1 w-full text-xs text-brand-500 hover:text-brand-400 py-1.5 rounded-lg hover:bg-surface-overlay transition-colors">
                    {t('common:showAll', { defaultValue: '查看全部' })} ({results.requirements.length})
                  </button>
                )}
              </section>
            )}

            {/* Projects */}
            {(category === 'all' || category === 'projects') && results.projects.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-fg-tertiary uppercase mb-2">{t('common:projects', { defaultValue: '项目' })}</h3>
                <div className="space-y-1">
                  {(category === 'all' ? results.projects.slice(0, 8) : results.projects).map(proj => (
                    <button
                      key={proj.id}
                      onClick={() => navBus.navigate(PAGE.WORK, { projectId: proj.id })}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-overlay transition-colors text-left"
                    >
                      <div className="w-8 h-8 rounded-lg bg-brand-500/15 flex items-center justify-center shrink-0">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-brand-500"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-fg-primary truncate">{proj.name}</div>
                        {proj.description && <div className="text-xs text-fg-tertiary truncate">{proj.description}</div>}
                      </div>
                    </button>
                  ))}
                </div>
                {category === 'all' && results.projects.length > 8 && (
                  <button onClick={() => setCategory('projects')} className="mt-1 w-full text-xs text-brand-500 hover:text-brand-400 py-1.5 rounded-lg hover:bg-surface-overlay transition-colors">
                    {t('common:showAll', { defaultValue: '查看全部' })} ({results.projects.length})
                  </button>
                )}
              </section>
            )}

            {/* Deliverables */}
            {(category === 'all' || category === 'deliverables') && results.deliverables.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-fg-tertiary uppercase mb-2">{t('common:deliverables', { defaultValue: '交付物' })}</h3>
                <div className="space-y-1">
                  {(category === 'all' ? results.deliverables.slice(0, 8) : results.deliverables).map(d => (
                    <button
                      key={d.id}
                      onClick={() => navBus.navigate(PAGE.DELIVERABLES, { openDeliverable: d.id })}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-overlay transition-colors text-left"
                    >
                      <div className="w-8 h-8 rounded-lg bg-purple-500/15 flex items-center justify-center shrink-0">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-purple-500"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-fg-primary truncate">{d.title}</div>
                        <div className="text-xs text-fg-tertiary truncate">{d.type} · {d.status}</div>
                      </div>
                    </button>
                  ))}
                </div>
                {category === 'all' && results.deliverables.length > 8 && (
                  <button onClick={() => setCategory('deliverables')} className="mt-1 w-full text-xs text-brand-500 hover:text-brand-400 py-1.5 rounded-lg hover:bg-surface-overlay transition-colors">
                    {t('common:showAll', { defaultValue: '查看全部' })} ({results.deliverables.length})
                  </button>
                )}
              </section>
            )}

            {/* Workflows */}
            {(category === 'all' || category === 'workflows') && results.workflows.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-fg-tertiary uppercase mb-2">{t('common:workflows', { defaultValue: '工作流' })}</h3>
                <div className="space-y-1">
                  {(category === 'all' ? results.workflows.slice(0, 8) : results.workflows).map(wf => (
                    <button
                      key={wf.name}
                      onClick={() => navBus.navigate(PAGE.WORK, { boardType: 'workflows' })}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-overlay transition-colors text-left"
                    >
                      <div className="w-8 h-8 rounded-lg bg-teal-500/15 flex items-center justify-center shrink-0">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-teal-500"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-fg-primary truncate">{wf.displayName || wf.name}</div>
                        <div className="text-xs text-fg-tertiary truncate">{wf.stepCount} steps · v{wf.version}</div>
                      </div>
                    </button>
                  ))}
                </div>
                {category === 'all' && results.workflows.length > 8 && (
                  <button onClick={() => setCategory('workflows')} className="mt-1 w-full text-xs text-brand-500 hover:text-brand-400 py-1.5 rounded-lg hover:bg-surface-overlay transition-colors">
                    {t('common:showAll', { defaultValue: '查看全部' })} ({results.workflows.length})
                  </button>
                )}
              </section>
            )}
          </div>
        )}

        {!loading && !searched && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-tertiary mb-3"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <p className="text-sm text-fg-tertiary">{t('common:search')}</p>
          </div>
        )}
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
    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${color}`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
    </div>
  );
}
