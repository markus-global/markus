import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { PageId } from '../types.ts';
import { api, type AuthUser, type ProjectInfo, type TeamInfo } from '../api.ts';


interface Props {
  currentPage: string;
  onNavigate: (page: PageId) => void;
  authUser?: AuthUser;
  onLogout?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d={d} />
    </svg>
  );
}

const ICONS: Record<string, string> = {
  dashboard: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  projects:  'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  chat:      'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  reports:   'M18 20V10 M12 20V4 M6 20v-6',
  deliverables: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z',
  usage:     'M21.21 15.89A10 10 0 1 1 8 2.83 M22 12A10 10 0 0 0 12 2v10z',
  builder:   'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  agents:    'M8 3H5a2 2 0 0 0-2 2v3 M21 8V5a2 2 0 0 0-2-2h-3 M3 16v3a2 2 0 0 0 2 2h3 M16 21h3a2 2 0 0 0 2-2v-3 M9 9h6v6H9z',
  teams:     'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  skills:    'M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5',
  governance:'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  settings:  'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-500',
  paused: 'bg-amber-500',
  completed: 'bg-gray-500',
  archived: 'bg-gray-600',
};

const navItems: Array<{ id: PageId; label: string; section: string }> = [
  { id: 'dashboard', label: 'Overview', section: 'workspace' },
  { id: 'chat', label: 'Chat', section: 'workspace' },
  { id: 'deliverables', label: 'Deliverables', section: 'workspace' },
  { id: 'builder', label: 'Builder', section: 'build' },
  { id: 'agents', label: 'Agents', section: 'build' },
  { id: 'teams', label: 'Teams', section: 'build' },
  { id: 'skills', label: 'Skills', section: 'build' },
  { id: 'governance', label: 'Governance', section: 'system' },
  { id: 'reports', label: 'Reports', section: 'system' },
  { id: 'settings', label: 'Settings', section: 'system' },
];

const sections = [
  { key: 'workspace', label: 'WORKSPACE' },
  { key: 'build', label: 'BUILD' },
  { key: 'system', label: 'SYSTEM' },
];

const DEFAULT_VISIBLE_PROJECTS = 5;

export function Sidebar({ currentPage, onNavigate, authUser, onLogout, collapsed, onToggleCollapse }: Props) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProj, setNewProj] = useState({ name: '', description: '', iterationModel: 'kanban' as string, repoUrl: '', teamIds: [] as string[] });
  const [creatingProject, setCreatingProject] = useState(false);
  const [availableTeams, setAvailableTeams] = useState<TeamInfo[]>([]);

  const fetchProjects = useCallback(() => {
    api.projects.list().then(d => setProjects(d.projects)).catch(() => {});
  }, []);

  useEffect(() => {
    fetchProjects();
    const timer = setInterval(fetchProjects, 30000);
    return () => clearInterval(timer);
  }, [fetchProjects]);

  const openNewProject = () => {
    setNewProj({ name: '', description: '', iterationModel: 'kanban', repoUrl: '', teamIds: [] });
    api.teams.list().then(d => setAvailableTeams(d.teams)).catch(() => {});
    setShowNewProject(true);
  };

  const handleCreateProject = async () => {
    if (!newProj.name.trim() || creatingProject) return;
    setCreatingProject(true);
    try {
      const repos = newProj.repoUrl.trim() ? [{ url: newProj.repoUrl.trim(), defaultBranch: 'main' }] : [];
      await api.projects.create({
        name: newProj.name.trim(),
        description: newProj.description.trim() || undefined,
        iterationModel: newProj.iterationModel,
        repositories: repos.length > 0 ? repos : undefined,
        teamIds: newProj.teamIds.length > 0 ? newProj.teamIds : undefined,
        orgId: 'default',
      } as Partial<ProjectInfo>);
      setShowNewProject(false);
      fetchProjects();
    } catch { /* ignore */ }
    setCreatingProject(false);
  };

  // Sync project selection from hash on mount and page changes
  useEffect(() => {
    if (currentPage !== 'projects') { setSelectedProjectId(null); return; }
    const raw = window.location.hash.slice(1);
    const parts = raw.split('/');
    if (parts[0] === 'projects' && parts[1]) setSelectedProjectId(parts[1]);
  }, [currentPage]);

  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    onLogout?.();
  };

  const visibleProjects = projectsExpanded ? projects : projects.slice(0, DEFAULT_VISIBLE_PROJECTS);
  const hasMoreProjects = projects.length > DEFAULT_VISIBLE_PROJECTS;

  return (
    <aside className="h-screen bg-gray-900 flex flex-col shrink-0 overflow-hidden">
      <div className={`border-b border-gray-800 flex items-center ${collapsed ? 'px-2 py-4 justify-center' : 'px-5 py-4 justify-between'}`}>
        {collapsed ? (
          <button onClick={onToggleCollapse} className="text-lg font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent" title="Expand sidebar">
            M
          </button>
        ) : (
          <>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                Markus
              </h1>
              <p className="text-xs text-gray-500 mt-0.5">AI Digital Employee Platform</p>
            </div>
            <button
              onClick={onToggleCollapse}
              className="text-gray-600 hover:text-gray-300 transition-colors p-1 rounded hover:bg-gray-800"
              title="Collapse sidebar"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="11 17 6 12 11 7" /><polyline points="18 17 13 12 18 7" /></svg>
            </button>
          </>
        )}
      </div>
      <nav className={`${collapsed ? 'p-1.5' : 'p-3'} flex-1 overflow-y-auto`}>
        {sections.map((section, si) => (
          <div key={section.key}>
            <div className="mb-3">
              {!collapsed && (
                <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-600 uppercase tracking-wider">
                  {section.label}
                </div>
              )}
              {collapsed && si > 0 && <div className="border-t border-gray-800 my-2 mx-1" />}
              {/* Render nav items, but defer Deliverables to after Projects */}
              {navItems.filter(i => i.section === section.key && !(section.key === 'workspace' && i.id === 'deliverables')).map((item) => {
                const isActive = currentPage === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onNavigate(item.id)}
                    title={collapsed ? item.label : undefined}
                    className={`w-full flex items-center ${collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2'} rounded-lg text-sm mb-0.5 transition-colors ${
                      isActive
                        ? 'bg-indigo-600 text-white'
                        : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                    }`}
                  >
                    <Icon d={ICONS[item.id] ?? ''} />
                    {!collapsed && item.label}
                  </button>
                );
              })}

              {/* Projects + sub-list — inside WORKSPACE, after Chat, before Deliverables */}
              {section.key === 'workspace' && collapsed && (
                <>
                  <button
                    onClick={() => { setSelectedProjectId(null); onNavigate('projects'); }}
                    title="Projects"
                    className={`w-full flex items-center justify-center px-2 py-2 rounded-lg text-sm mb-0.5 transition-colors ${
                      currentPage === 'projects' && !selectedProjectId
                        ? 'bg-indigo-600 text-white'
                        : currentPage === 'projects'
                          ? 'text-indigo-300 bg-indigo-600/15'
                          : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                    }`}
                  >
                    <Icon d={ICONS.projects ?? ''} />
                  </button>
                  <button
                    onClick={() => onNavigate('deliverables')}
                    title="Deliverables"
                    className={`w-full flex items-center justify-center px-2 py-2 rounded-lg text-sm mb-0.5 transition-colors ${
                      currentPage === 'deliverables' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                    }`}
                  >
                    <Icon d={ICONS.deliverables ?? ''} />
                  </button>
                </>
              )}
              {section.key === 'workspace' && !collapsed && (
                <>
                  {/* Projects nav item */}
                  <div className="flex items-center mb-0.5">
                    <button
                      onClick={() => { setSelectedProjectId(null); window.location.hash = 'projects'; onNavigate('projects'); }}
                      className={`flex-1 flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                        currentPage === 'projects' && !selectedProjectId
                          ? 'bg-indigo-600 text-white'
                          : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                      }`}
                    >
                      <Icon d={ICONS.projects ?? ''} />
                      Projects
                    </button>
                    <button
                      onClick={openNewProject}
                      className="text-gray-600 hover:text-gray-300 transition-colors p-1.5 rounded hover:bg-gray-800 shrink-0"
                      title="New Project"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                    </button>
                  </div>
                  {/* Project sub-list */}
                  {projects.length === 0 && (
                    <button
                      onClick={openNewProject}
                      className="w-full flex items-center gap-2 pl-9 pr-3 py-1.5 text-xs text-gray-600 hover:text-gray-400 hover:bg-gray-800/50 rounded-lg transition-colors"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                      Create your first project
                    </button>
                  )}
                  {visibleProjects.map(p => {
                    const isActive = currentPage === 'projects' && selectedProjectId === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => {
                          setSelectedProjectId(p.id);
                          if (currentPage !== 'projects') onNavigate('projects');
                          window.location.hash = 'projects/' + p.id;
                        }}
                        className={`w-full flex items-center gap-2.5 pl-9 pr-3 py-1.5 rounded-lg text-sm mb-0.5 transition-colors ${
                          isActive
                            ? 'bg-indigo-600/20 text-indigo-300'
                            : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                        }`}
                      >
                        <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[p.status] ?? 'bg-gray-600'}`} />
                        <span className="truncate text-xs">{p.name}</span>
                      </button>
                    );
                  })}
                  {hasMoreProjects && !projectsExpanded && (
                    <button
                      onClick={() => setProjectsExpanded(true)}
                      className="w-full pl-9 pr-3 py-1 text-[10px] text-gray-600 hover:text-gray-400 transition-colors text-left"
                    >
                      Show all {projects.length} projects...
                    </button>
                  )}
                  {/* Deliverables — after Projects */}
                  <button
                    onClick={() => onNavigate('deliverables')}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors ${
                      currentPage === 'deliverables' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                    }`}
                  >
                    <Icon d={ICONS.deliverables ?? ''} />
                    Deliverables
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </nav>
      <div className={`border-t border-gray-800 ${collapsed ? 'p-2 flex flex-col items-center gap-2' : 'p-4 space-y-2'}`}>
        {authUser && (
          collapsed ? (
            <button
              onClick={handleLogout}
              title={`${authUser.name ?? authUser.email} — Sign out`}
              className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-bold shrink-0 hover:ring-2 hover:ring-indigo-500/50 transition-all"
            >
              {authUser.name?.[0]?.toUpperCase() ?? 'A'}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
                {authUser.name?.[0]?.toUpperCase() ?? 'A'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-300 truncate">{authUser.name ?? authUser.email}</div>
                <div className="text-[10px] text-gray-600 truncate">{authUser.email ?? (authUser.role?.[0]?.toUpperCase() + authUser.role?.slice(1))}</div>
              </div>
              <button
                onClick={handleLogout}
                title="Sign out"
                className="text-gray-600 hover:text-gray-300 transition-colors text-sm"
              >
                ⇥
              </button>
            </div>
          )
        )}
        {!collapsed && <div className="text-[10px] text-gray-700">v{__APP_VERSION__}</div>}
      </div>

      {/* New Project Modal — portaled to body for full-page centering */}
      {showNewProject && createPortal(
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowNewProject(false)}>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 w-[520px] shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-5">New Project</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">Project Name *</label>
                <input
                  value={newProj.name}
                  onChange={e => setNewProj(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Mobile App, Website Redesign"
                  className="input"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">Description</label>
                <textarea
                  value={newProj.description}
                  onChange={e => setNewProj(p => ({ ...p, description: e.target.value }))}
                  placeholder="What is this project about?"
                  className="input"
                  rows={3}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">Iteration Model</label>
                  <div className="flex gap-2">
                    {(['kanban', 'sprint'] as const).map(model => (
                      <button
                        key={model}
                        onClick={() => setNewProj(p => ({ ...p, iterationModel: model }))}
                        className={`flex-1 py-2 text-xs rounded-lg border transition-colors capitalize ${
                          newProj.iterationModel === model
                            ? 'border-indigo-500 bg-indigo-600/15 text-indigo-300'
                            : 'border-gray-700 text-gray-400 hover:border-gray-600'
                        }`}
                      >
                        {model === 'kanban' ? 'Kanban' : 'Sprint'}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">Assign Teams</label>
                  {availableTeams.length === 0 ? (
                    <div className="text-[11px] text-gray-600 py-2">No teams available</div>
                  ) : (
                    <div className="space-y-1 max-h-24 overflow-y-auto">
                      {availableTeams.map(t => {
                        const checked = newProj.teamIds.includes(t.id);
                        return (
                          <label key={t.id} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer hover:text-gray-100 py-0.5">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => setNewProj(p => ({
                                ...p,
                                teamIds: checked ? p.teamIds.filter(id => id !== t.id) : [...p.teamIds, t.id],
                              }))}
                              className="accent-indigo-500"
                            />
                            <span className="truncate">{t.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">Repository URL</label>
                <input
                  value={newProj.repoUrl}
                  onChange={e => setNewProj(p => ({ ...p, repoUrl: e.target.value }))}
                  placeholder="https://github.com/org/repo (optional)"
                  className="input"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button onClick={() => setShowNewProject(false)} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800">Cancel</button>
                <button
                  onClick={handleCreateProject}
                  disabled={!newProj.name.trim() || creatingProject}
                  className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg text-white"
                >
                  {creatingProject ? 'Creating...' : 'Create Project'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </aside>
  );
}
