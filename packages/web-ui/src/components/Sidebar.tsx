import { useEffect, useState, useCallback, useRef } from 'react';
import { type PageId, PAGE, PAGE_ICONS, SIDEBAR_NAV, SIDEBAR_SECTIONS, hashPath, resolvePageId } from '../routes.ts';
import { api, type AuthUser, type ProjectInfo } from '../api.ts';
import { NewProjectModal } from './NewProjectModal.tsx';
import { NotificationBell } from './NotificationBell.tsx';
import { Avatar, AvatarUpload } from './Avatar.tsx';


interface Props {
  currentPage: string;
  onNavigate: (page: PageId) => void;
  authUser?: AuthUser;
  onLogout?: () => void;
  onUserUpdated?: (user: AuthUser) => void;
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

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-500',
  paused: 'bg-amber-500',
  completed: 'bg-gray-500',
  archived: 'bg-gray-600',
};


function EditProfileModal({ authUser, onClose, onSaved }: { authUser: AuthUser; onClose: () => void; onSaved: (u: AuthUser) => void }) {
  const [name, setName] = useState(authUser.name || '');
  const [email, setEmail] = useState(authUser.email || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(authUser.avatarUrl);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Invalid email'); return; }
    setSaving(true); setError('');
    try {
      const { user } = await api.auth.updateProfile(name.trim(), email.trim());
      onSaved({ ...user, avatarUrl: avatarUrl ?? user.avatarUrl });
    } catch { setError('Failed to save'); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <form onSubmit={submit} className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[400px] shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-5">Edit Profile</h3>
        <div className="flex justify-center mb-5">
          <AvatarUpload
            currentUrl={avatarUrl}
            name={name}
            size={72}
            targetType="user"
            targetId={authUser.id}
            onUploaded={url => setAvatarUrl(url)}
          />
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-fg-tertiary font-medium mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none" />
          </div>
          <div>
            <label className="block text-xs text-fg-tertiary font-medium mb-1">Email</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none" />
          </div>
          {error && <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
        </div>
        <div className="flex justify-end gap-3 mt-5">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white rounded-lg">{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

function UserMenu({ authUser, collapsed, onLogout, onUserUpdated }: { authUser?: AuthUser; collapsed?: boolean; onLogout: () => void; onUserUpdated?: (u: AuthUser) => void }) {
  const [open, setOpen] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!authUser) return null;

  const displayName = authUser.name || 'User';
  const displayEmail = authUser.email || (authUser.role?.[0]?.toUpperCase() + authUser.role?.slice(1));

  return (
    <>
      <div ref={ref} className={`relative ${collapsed ? 'p-2 flex flex-col items-center' : 'px-4 py-3'}`}>
        <button
          onClick={() => setOpen(!open)}
          className={`${collapsed
            ? 'hover:ring-2 hover:ring-brand-500/50 transition-all rounded-full'
            : 'w-full flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-overlay transition-colors'
          }`}
          title={collapsed ? `${displayName} — ${displayEmail}` : undefined}
        >
          <Avatar name={displayName} avatarUrl={authUser.avatarUrl} size={collapsed ? 28 : 28} />
          {!collapsed && (
            <>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-xs text-fg-secondary truncate">{displayName}</div>
                <div className="text-[11px] text-fg-tertiary truncate">{displayEmail}</div>
              </div>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-tertiary shrink-0">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </>
          )}
        </button>

        {open && (
          <div className={`absolute ${collapsed ? 'left-full bottom-0 ml-2' : 'left-4 right-4 bottom-full mb-1'} bg-surface-secondary border border-border-default rounded-xl shadow-xl z-50 overflow-hidden`}
            style={collapsed ? { minWidth: 200 } : undefined}>
            <div className="px-4 py-3 border-b border-border-default">
              <div className="text-sm font-medium text-fg-primary">{displayName}</div>
              <div className="text-xs text-fg-tertiary mt-0.5">{displayEmail}</div>
              <div className="text-[11px] text-fg-tertiary mt-0.5 capitalize">{authUser.role}</div>
            </div>
            <div className="py-1">
              <button
                onClick={() => { setOpen(false); setShowEdit(true); }}
                className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-fg-secondary hover:bg-surface-overlay transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                Edit Profile
              </button>
              <button
                onClick={() => { setOpen(false); onLogout(); }}
                className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-red-500 hover:bg-red-500/10 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
      {showEdit && (
        <EditProfileModal
          authUser={authUser}
          onClose={() => setShowEdit(false)}
          onSaved={u => { setShowEdit(false); onUserUpdated?.(u); }}
        />
      )}
    </>
  );
}


const DEFAULT_VISIBLE_PROJECTS = 5;

export function Sidebar({ currentPage, onNavigate, authUser, onLogout, onUserUpdated, collapsed, onToggleCollapse }: Props) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);

  const fetchProjects = useCallback(() => {
    api.projects.list().then(d => setProjects(d.projects)).catch(() => {});
  }, []);

  useEffect(() => {
    fetchProjects();
    const timer = setInterval(fetchProjects, 30000);
    return () => clearInterval(timer);
  }, [fetchProjects]);

  // Sync project selection from hash on mount and page changes
  useEffect(() => {
    if (currentPage !== PAGE.WORK) { setSelectedProjectId(null); return; }
    const raw = window.location.hash.slice(1);
    const parts = raw.split('/');
    if (resolvePageId(parts[0]) === PAGE.WORK && parts[1]) setSelectedProjectId(parts[1]);
  }, [currentPage]);

  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    onLogout?.();
  };

  const visibleProjects = projectsExpanded ? projects : projects.slice(0, DEFAULT_VISIBLE_PROJECTS);
  const hasMoreProjects = projects.length > DEFAULT_VISIBLE_PROJECTS;

  return (
    <aside className="h-dvh bg-surface-secondary flex flex-col shrink-0 overflow-hidden border-r border-border-subtle">
      <div className={`flex items-center ${collapsed ? 'px-2 py-3.5 justify-center' : 'px-4 h-14 justify-between'}`}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <button onClick={onToggleCollapse} title="Expand sidebar" className="group">
              <img src="/logo.png" alt="Markus" className="w-8 h-8 rounded-lg group-hover:ring-2 group-hover:ring-brand-500/40 transition-all" />
            </button>
            <NotificationBell collapsed userId={authUser?.id} />
          </div>
        ) : (
          <>
            <button onClick={onToggleCollapse} className="flex items-center gap-2.5 min-w-0 group" title="Collapse sidebar">
              <img src="/logo.png" alt="Markus" className="w-8 h-8 rounded-lg shadow-md shadow-black/30 shrink-0 group-hover:ring-2 group-hover:ring-brand-500/40 transition-all" />
              <span className="text-[15px] font-bold tracking-tight text-fg-primary whitespace-nowrap">Markus</span>
            </button>
            <div className="flex items-center gap-1 shrink-0">
              <NotificationBell userId={authUser?.id} />
              <button
                onClick={onToggleCollapse}
                className="text-fg-tertiary hover:text-fg-secondary transition-colors p-1 rounded-md hover:bg-surface-overlay"
                title="Collapse sidebar"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="11 17 6 12 11 7" /><polyline points="18 17 13 12 18 7" /></svg>
              </button>
            </div>
          </>
        )}
      </div>
      <nav className={`${collapsed ? 'p-1.5' : 'p-3'} flex-1 overflow-y-auto`}>
        {SIDEBAR_SECTIONS.map((section, si) => (
          <div key={section.key}>
            <div className="mb-3">
              {!collapsed && (
                <div className="px-3 py-1.5 text-[11px] font-semibold text-fg-tertiary uppercase tracking-widest">
                  {section.label}
                </div>
              )}
              {collapsed && si > 0 && <div className="my-2 mx-1" />}
              {/* Render nav items, but defer Deliverables to after Projects */}
              {SIDEBAR_NAV.filter(i => i.section === section.key && !(section.key === 'workspace' && i.id === PAGE.DELIVERABLES)).map((item) => {
                const isActive = currentPage === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onNavigate(item.id)}
                    title={collapsed ? item.label : undefined}
                    className={`w-full flex items-center ${collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2'} rounded-lg text-sm mb-0.5 transition-all ${
                      isActive
                        ? 'bg-brand-600 text-white shadow-sm shadow-brand-900/30'
                        : 'text-fg-primary hover:bg-surface-overlay'
                    }`}
                  >
                    <Icon d={PAGE_ICONS[item.id] ?? ''} />
                    {!collapsed && item.label}
                  </button>
                );
              })}

              {/* Work (Projects) + sub-list — inside WORKSPACE, after Team, before Deliverables */}
              {section.key === 'workspace' && collapsed && (
                <>
                  <button
                    onClick={() => { setSelectedProjectId(null); onNavigate(PAGE.WORK); }}
                    title="Work"
                    className={`w-full flex items-center justify-center px-2 py-2 rounded-lg text-sm mb-0.5 transition-all ${
                      currentPage === PAGE.WORK && !selectedProjectId
                        ? 'bg-brand-600 text-white shadow-sm shadow-brand-900/30'
                        : currentPage === PAGE.WORK
                          ? 'bg-brand-600/15 text-fg-primary'
                          : 'text-fg-primary hover:bg-surface-overlay'
                    }`}
                  >
                    <Icon d={PAGE_ICONS[PAGE.WORK] ?? ''} />
                  </button>
                  <button
                    onClick={() => onNavigate(PAGE.DELIVERABLES)}
                    title="Deliverables"
                    className={`w-full flex items-center justify-center px-2 py-2 rounded-lg text-sm mb-0.5 transition-colors ${
                      currentPage === PAGE.DELIVERABLES ? 'bg-brand-600 text-white' : 'text-fg-primary hover:bg-surface-elevated'
                    }`}
                  >
                    <Icon d={PAGE_ICONS[PAGE.DELIVERABLES] ?? ''} />
                  </button>
                </>
              )}
              {section.key === 'workspace' && !collapsed && (
                <>
                  {/* Work nav item */}
                  <div className="flex items-center mb-0.5">
                    <button
                      onClick={() => { setSelectedProjectId(null); onNavigate(PAGE.WORK); }}
                      className={`flex-1 flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                        currentPage === PAGE.WORK && !selectedProjectId
                          ? 'bg-brand-600 text-white'
                          : 'text-fg-primary hover:bg-surface-elevated'
                      }`}
                    >
                      <Icon d={PAGE_ICONS[PAGE.WORK] ?? ''} />
                      Work
                    </button>
                    <button
                      onClick={() => setShowNewProject(true)}
                      className="text-fg-tertiary hover:text-fg-secondary transition-colors p-1.5 rounded hover:bg-surface-elevated shrink-0"
                      title="New Project"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                    </button>
                  </div>
                  {/* Project sub-list */}
                  {projects.length === 0 && (
                    <button
                      onClick={() => setShowNewProject(true)}
                      className="w-full flex items-center gap-2 pl-9 pr-3 py-1.5 text-xs text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated/50 rounded-lg transition-colors"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                      Create your first project
                    </button>
                  )}
                  {visibleProjects.map(p => {
                    const isActive = currentPage === PAGE.WORK && selectedProjectId === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => {
                          setSelectedProjectId(p.id);
                          if (currentPage !== PAGE.WORK) onNavigate(PAGE.WORK);
                          window.location.hash = hashPath(PAGE.WORK, p.id).slice(1);
                        }}
                        className={`w-full flex items-center gap-2.5 pl-9 pr-3 py-1.5 rounded-lg text-sm mb-0.5 transition-colors ${
                          isActive
                            ? 'bg-brand-600 text-white'
                            : 'text-fg-secondary hover:bg-surface-elevated'
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
                      className="w-full pl-9 pr-3 py-1 text-[11px] text-fg-tertiary hover:text-fg-secondary transition-colors text-left"
                    >
                      Show all {projects.length} projects...
                    </button>
                  )}
                  {/* Deliverables — after Projects */}
                  <button
                    onClick={() => onNavigate(PAGE.DELIVERABLES)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors ${
                      currentPage === PAGE.DELIVERABLES ? 'bg-brand-600 text-white' : 'text-fg-primary hover:bg-surface-elevated'
                    }`}
                  >
                    <Icon d={PAGE_ICONS[PAGE.DELIVERABLES] ?? ''} />
                    Deliverables
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </nav>
      <UserMenu authUser={authUser} collapsed={collapsed} onLogout={handleLogout} onUserUpdated={onUserUpdated} />
      {!collapsed && <div className="px-4 pb-2 text-[10px] text-fg-muted">v{__APP_VERSION__}</div>}

      {showNewProject && (
        <NewProjectModal
          orgId={authUser?.orgId}
          onCreated={() => { setShowNewProject(false); fetchProjects(); }}
          onClose={() => setShowNewProject(false)}
        />
      )}
    </aside>
  );
}
