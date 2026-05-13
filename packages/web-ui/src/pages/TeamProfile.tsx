import { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, kebab } from '../api.ts';
import type { TeamInfo, TeamMemberInfo } from '../api.ts';
import { Avatar } from '../components/Avatar.tsx';

const LazyMarkdownMessage = lazy(() =>
  import('../components/MarkdownMessage.tsx').then(m => ({ default: m.MarkdownMessage }))
);

interface Props {
  teamId: string;
  onBack: () => void;
  inline?: boolean;
  headless?: boolean;
  activeTab?: TeamTab;
  onSelectAgent?: (agentId: string) => void;
}

export type TeamTab = 'overview' | 'announcements' | 'norms' | 'settings';

export const TABS: Array<{ key: TeamTab; labelKey: string; icon: string }> = [
  { key: 'overview', labelKey: 'teamProfile.overview', icon: '▦' },
  { key: 'announcements', labelKey: 'teamProfile.announcements', icon: '◈' },
  { key: 'norms', labelKey: 'teamProfile.norms', icon: '☰' },
  { key: 'settings', labelKey: 'teamProfile.settings', icon: '⚙' },
];

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-green-400', working: 'bg-blue-400 animate-pulse',
  paused: 'bg-amber-400', offline: 'bg-gray-500', error: 'bg-red-400',
};

export function TeamProfile({ teamId, onBack, inline, headless, activeTab: externalTab, onSelectAgent }: Props) {
  const { t } = useTranslation('team');
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [tab, setTab] = useState<TeamTab>('overview');
  const effectiveTab = headless && externalTab ? externalTab : tab;
  const [announcements, setAnnouncements] = useState('');
  const [norms, setNorms] = useState('');
  const [editingAnn, setEditingAnn] = useState(false);
  const [editingNorms, setEditingNorms] = useState(false);
  const [annDraft, setAnnDraft] = useState('');
  const [normsDraft, setNormsDraft] = useState('');
  const annRef = useRef<HTMLDivElement>(null);
  const annTextareaRef = useRef<HTMLTextAreaElement>(null);
  const normsRef = useRef<HTMLDivElement>(null);
  const normsTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [saving, setSaving] = useState(false);
  const [editName, setEditName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [editDesc, setEditDesc] = useState(false);
  const [teamStatuses, setTeamStatuses] = useState<Array<{ id: string; name: string; status: string; role?: string }>>([]);
  const nameRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      const res = await api.teams.list();
      const found = res.teams.find(tm => tm.id === teamId);
      if (found) setTeam(found);

      const st = await api.teams.status(teamId);
      setTeamStatuses(st.agents);
    } catch { /* ignore */ }
  }, [teamId]);

  const loadFiles = useCallback(async () => {
    try {
      const ann = await api.teams.getFile(teamId, 'ANNOUNCEMENT.md');
      setAnnouncements(ann.content);
    } catch { setAnnouncements(''); }
    try {
      const n = await api.teams.getFile(teamId, 'NORMS.md');
      setNorms(n.content);
    } catch { setNorms(''); }
  }, [teamId]);

  useEffect(() => {
    setTab('overview');
    reload();
    loadFiles();
  }, [teamId, reload, loadFiles]);

  useEffect(() => {
    if (editingAnn && annTextareaRef.current) annTextareaRef.current.focus();
  }, [editingAnn]);

  useEffect(() => {
    if (editingNorms && normsTextareaRef.current) normsTextareaRef.current.focus();
  }, [editingNorms]);

  const saveFile = async (filename: string, content: string) => {
    setSaving(true);
    try {
      await api.teams.updateFile(teamId, filename, content);
      if (filename === 'ANNOUNCEMENT.md') {
        setAnnouncements(content);
        setEditingAnn(false);
      } else {
        setNorms(content);
        setEditingNorms(false);
      }
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleRename = async () => {
    if (!nameDraft.trim()) return;
    await api.teams.update(teamId, { name: nameDraft.trim() });
    setEditName(false);
    reload();
  };

  const handleUpdateDesc = async () => {
    await api.teams.update(teamId, { description: descDraft });
    setEditDesc(false);
    reload();
  };

  if (!team) return <div className="flex-1 flex items-center justify-center text-fg-tertiary text-sm">Loading team...</div>;

  const managerMember = team.members.find(m => m.agentRole === 'manager');
  const onlineCount = teamStatuses.filter(s => s.status !== 'offline').length;

  const isEditingFullscreen = (effectiveTab === 'announcements' && editingAnn) || (effectiveTab === 'norms' && editingNorms);

  if (headless) {
    return (
      <div className={`flex-1 bg-surface-primary ${isEditingFullscreen ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}>
        <div className={`${isEditingFullscreen ? 'flex-1 flex flex-col min-h-0 p-5' : 'p-5'}`}>
          {effectiveTab === 'overview' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-surface-secondary rounded-xl border border-border-default">
                  <div className="text-xs text-fg-tertiary mb-1">Manager</div>
                  <div className="text-sm font-medium">{managerMember?.name ?? team.managerName ?? 'None'}</div>
                </div>
                <div className="p-4 bg-surface-secondary rounded-xl border border-border-default">
                  <div className="text-xs text-fg-tertiary mb-1">Team ID</div>
                  <div className="text-sm font-mono text-fg-secondary truncate">{team.id}</div>
                </div>
              </div>
              <div className="space-y-3">
                <div className="text-xs text-fg-tertiary font-medium px-1">Members</div>
                {team.members.map(m => {
                  const st = teamStatuses.find(s => s.id === m.id);
                  const dot = STATUS_DOT[st?.status ?? 'offline'] ?? 'bg-gray-500';
                  const isAgent = m.type === 'agent';
                  return (
                    <div
                      key={m.id}
                      onClick={() => isAgent && onSelectAgent?.(m.id)}
                      className={`p-3 bg-surface-secondary rounded-xl border border-border-default flex items-center gap-3${isAgent && onSelectAgent ? ' cursor-pointer hover:border-brand-500/40 transition-colors' : ''}`}
                    >
                      <Avatar name={m.name} avatarUrl={m.avatarUrl} size={32} className="rounded-lg" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{m.name}</span>
                          <span className={`w-2 h-2 rounded-full ${dot}`} />
                          <span className="text-xs text-fg-tertiary">{st?.status ?? 'offline'}</span>
                          {m.agentRole === 'manager' && <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/15 text-amber-600 rounded font-medium">Manager</span>}
                        </div>
                        <div className="text-xs text-fg-tertiary">{m.role} · {m.type}</div>
                      </div>
                      {isAgent && onSelectAgent && (
                        <svg className="w-4 h-4 text-fg-tertiary shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                      )}
                    </div>
                  );
                })}
                {team.members.length === 0 && <div className="text-sm text-fg-tertiary text-center py-8">No members</div>}
              </div>
            </div>
          )}
          {effectiveTab === 'announcements' && (
            <MarkdownEditorSection
              content={announcements}
              draft={annDraft}
              setDraft={setAnnDraft}
              editing={editingAnn}
              setEditing={setEditingAnn}
              textareaRef={annTextareaRef}
              contentRef={annRef}
              saving={saving}
              onSave={() => saveFile('ANNOUNCEMENT.md', annDraft)}
              placeholder={t('teamProfile.annPlaceholder')}
              emptyText={t('teamProfile.noAnnouncements')}
            />
          )}
          {effectiveTab === 'norms' && (
            <MarkdownEditorSection
              content={norms}
              draft={normsDraft}
              setDraft={setNormsDraft}
              editing={editingNorms}
              setEditing={setEditingNorms}
              textareaRef={normsTextareaRef}
              contentRef={normsRef}
              saving={saving}
              onSave={() => saveFile('NORMS.md', normsDraft)}
              placeholder={t('teamProfile.normsPlaceholder')}
              emptyText={t('teamProfile.noNorms')}
            />
          )}
          {effectiveTab === 'settings' && (
            <div className="space-y-5">
              <div className="p-4 bg-surface-secondary rounded-xl border border-border-default space-y-4">
                <div>
                  <div className="text-xs text-fg-tertiary mb-1">Team Name</div>
                  {editName ? (
                    <div className="flex gap-2 items-center">
                      <input ref={nameRef} value={nameDraft} onChange={e => setNameDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleRename()}
                        className="flex-1 bg-surface-elevated border border-border-default rounded-lg px-3 py-1.5 text-sm text-fg-primary focus:outline-none focus:border-brand-500" autoFocus />
                      <button onClick={handleRename} className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 rounded-lg text-white">Save</button>
                      <button onClick={() => setEditName(false)} className="px-3 py-1.5 text-xs bg-surface-elevated hover:bg-surface-overlay rounded-lg text-fg-secondary">Cancel</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{team.name}</span>
                      <button onClick={() => { setNameDraft(team.name); setEditName(true); }} className="text-xs text-fg-tertiary hover:text-fg-secondary">Edit</button>
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-fg-tertiary mb-1">Description</div>
                  {editDesc ? (
                    <div className="space-y-2">
                      <textarea value={descDraft} onChange={e => setDescDraft(e.target.value)}
                        className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-1.5 text-sm text-fg-primary resize-y focus:outline-none focus:border-brand-500" rows={3} autoFocus />
                      <div className="flex gap-2">
                        <button onClick={handleUpdateDesc} className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 rounded-lg text-white">Save</button>
                        <button onClick={() => setEditDesc(false)} className="px-3 py-1.5 text-xs bg-surface-elevated hover:bg-surface-overlay rounded-lg text-fg-secondary">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-fg-secondary">{team.description || 'No description'}</span>
                      <button onClick={() => { setDescDraft(team.description ?? ''); setEditDesc(true); }} className="text-xs text-fg-tertiary hover:text-fg-secondary">Edit</button>
                    </div>
                  )}
                </div>
              </div>
              <DangerZone teamId={teamId} teamName={team.name} onDeleted={onBack} />
            </div>
          )}
        </div>
      </div>
    );
  }

  const isEditingFullscreenStandalone = (tab === 'announcements' && editingAnn) || (tab === 'norms' && editingNorms);

  return (
    <div className={`flex-1 bg-surface-primary ${isEditingFullscreenStandalone ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}>
      {/* Header */}
      <div className="px-5 py-3.5 bg-surface-secondary sticky top-0 z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-600 text-white flex items-center justify-center text-lg font-bold shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold">{team.name}</h2>
              <span className="px-1.5 py-0.5 text-[10px] bg-brand-500/15 text-brand-500 rounded font-medium">{team.members.length} members</span>
              <span className="px-1.5 py-0.5 text-[10px] bg-green-500/15 text-green-600 rounded font-medium">{onlineCount} online</span>
            </div>
            <div className="text-xs text-fg-tertiary truncate">{team.description || 'No description'}</div>
          </div>
          <button onClick={async () => {
            if (!team) return;
            try {
              const { files } = await api.teams.getFilesMap(team.id);
              const agentMembers = team.members.filter(m => m.type === 'agent');
              const config = {
                type: 'team' as const,
                name: kebab(team.name, team.name),
                displayName: team.name,
                version: '1.0.0',
                description: team.description ?? '',
                author: '',
                category: 'general',
                tags: [] as string[],
                team: {
                  members: agentMembers.map(m => ({
                    name: m.name,
                    roleName: m.role,
                    role: (m.agentRole ?? 'worker') as 'manager' | 'worker',
                    count: 1,
                    skills: [] as string[],
                  })),
                },
              };
              await hubApi.publishViaProxy({ itemType: 'team', name: team.name, description: team.description ?? '', category: 'general', config, files });
              alert(`Published "${team.name}" to Markus Hub`);
            } catch (e) { alert(`Failed to publish: ${e}`); }
          }} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors flex items-center gap-1" title="Publish to Markus Hub"><span>↑</span> Hub</button>
          {inline && <button onClick={onBack} className="p-1.5 text-fg-tertiary hover:text-fg-secondary text-lg leading-none">×</button>}
        </div>
        <div className="flex gap-1 mt-3 -mb-[1px] overflow-x-auto">
          {TABS.map(td => (
            <button key={td.key} onClick={() => setTab(td.key)}
              className={`px-3 py-1.5 text-xs rounded-t-lg whitespace-nowrap transition-colors ${tab === td.key ? 'bg-surface-primary text-fg-primary border border-border-default border-b-gray-950' : 'text-fg-tertiary hover:text-fg-secondary'}`}
            >{td.icon} {t(td.labelKey)}</button>
          ))}
        </div>
      </div>

      <div className={`${isEditingFullscreenStandalone ? 'flex-1 flex flex-col min-h-0 p-5' : 'p-5'}`}>
        {/* Overview Tab (includes members) */}
        {tab === 'overview' && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-surface-secondary rounded-xl border border-border-default">
                <div className="text-xs text-fg-tertiary mb-1">Manager</div>
                <div className="text-sm font-medium">{managerMember?.name ?? team.managerName ?? 'None'}</div>
              </div>
              <div className="p-4 bg-surface-secondary rounded-xl border border-border-default">
                <div className="text-xs text-fg-tertiary mb-1">Team ID</div>
                <div className="text-sm font-mono text-fg-secondary truncate">{team.id}</div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-xs text-fg-tertiary font-medium px-1">Members</div>
              {team.members.map(m => {
                const st = teamStatuses.find(s => s.id === m.id);
                const dot = STATUS_DOT[st?.status ?? 'offline'] ?? 'bg-gray-500';
                const isAgent = m.type === 'agent';
                return (
                  <div
                    key={m.id}
                    onClick={() => isAgent && onSelectAgent?.(m.id)}
                    className={`p-3 bg-surface-secondary rounded-xl border border-border-default flex items-center gap-3${isAgent && onSelectAgent ? ' cursor-pointer hover:border-brand-500/40 transition-colors' : ''}`}
                  >
                    <Avatar name={m.name} avatarUrl={m.avatarUrl} size={32} className="rounded-lg" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{m.name}</span>
                        <span className={`w-2 h-2 rounded-full ${dot}`} />
                        <span className="text-xs text-fg-tertiary">{st?.status ?? 'offline'}</span>
                        {m.agentRole === 'manager' && <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/15 text-amber-600 rounded font-medium">Manager</span>}
                      </div>
                      <div className="text-xs text-fg-tertiary">{m.role} · {m.type}</div>
                    </div>
                    {isAgent && onSelectAgent && (
                      <svg className="w-4 h-4 text-fg-tertiary shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                    )}
                  </div>
                );
              })}
              {team.members.length === 0 && <div className="text-sm text-fg-tertiary text-center py-8">No members</div>}
            </div>
          </div>
        )}

        {/* Announcements Tab */}
        {tab === 'announcements' && (
          <MarkdownEditorSection
            content={announcements}
            draft={annDraft}
            setDraft={setAnnDraft}
            editing={editingAnn}
            setEditing={setEditingAnn}
            textareaRef={annTextareaRef}
            contentRef={annRef}
            saving={saving}
            onSave={() => saveFile('ANNOUNCEMENT.md', annDraft)}
            placeholder={t('teamProfile.annPlaceholder')}
            emptyText={t('teamProfile.noAnnouncements')}
          />
        )}

        {/* Norms Tab */}
        {tab === 'norms' && (
          <MarkdownEditorSection
            content={norms}
            draft={normsDraft}
            setDraft={setNormsDraft}
            editing={editingNorms}
            setEditing={setEditingNorms}
            textareaRef={normsTextareaRef}
            contentRef={normsRef}
            saving={saving}
            onSave={() => saveFile('NORMS.md', normsDraft)}
            placeholder={t('teamProfile.normsPlaceholder')}
            emptyText={t('teamProfile.noNorms')}
          />
        )}

        {/* Settings Tab */}
        {tab === 'settings' && (
          <div className="space-y-5">
            <div className="p-4 bg-surface-secondary rounded-xl border border-border-default space-y-4">
              <div>
                <div className="text-xs text-fg-tertiary mb-1">Team Name</div>
                {editName ? (
                  <div className="flex gap-2 items-center">
                    <input ref={nameRef} value={nameDraft} onChange={e => setNameDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleRename()}
                      className="flex-1 bg-surface-elevated border border-border-default rounded-lg px-3 py-1.5 text-sm text-fg-primary focus:outline-none focus:border-brand-500" autoFocus />
                    <button onClick={handleRename} className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 rounded-lg text-white">Save</button>
                    <button onClick={() => setEditName(false)} className="px-3 py-1.5 text-xs bg-surface-elevated hover:bg-surface-overlay rounded-lg text-fg-secondary">Cancel</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{team.name}</span>
                    <button onClick={() => { setNameDraft(team.name); setEditName(true); }} className="text-xs text-fg-tertiary hover:text-fg-secondary">Edit</button>
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs text-fg-tertiary mb-1">Description</div>
                {editDesc ? (
                  <div className="space-y-2">
                    <textarea value={descDraft} onChange={e => setDescDraft(e.target.value)}
                      className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-1.5 text-sm text-fg-primary resize-y focus:outline-none focus:border-brand-500" rows={3} autoFocus />
                    <div className="flex gap-2">
                      <button onClick={handleUpdateDesc} className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 rounded-lg text-white">Save</button>
                      <button onClick={() => setEditDesc(false)} className="px-3 py-1.5 text-xs bg-surface-elevated hover:bg-surface-overlay rounded-lg text-fg-secondary">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-fg-secondary">{team.description || 'No description'}</span>
                    <button onClick={() => { setDescDraft(team.description ?? ''); setEditDesc(true); }} className="text-xs text-fg-tertiary hover:text-fg-secondary">Edit</button>
                  </div>
                )}
              </div>
            </div>

            <DangerZone teamId={teamId} teamName={team.name} onDeleted={onBack} />
          </div>
        )}
      </div>
    </div>
  );
}

function MarkdownEditorSection({
  content, draft, setDraft, editing, setEditing, textareaRef, contentRef, saving, onSave, placeholder, emptyText,
}: {
  content: string;
  draft: string;
  setDraft: (v: string) => void;
  editing: boolean;
  setEditing: (v: boolean) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  saving: boolean;
  onSave: () => void;
  placeholder: string;
  emptyText: string;
}) {
  if (editing) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== content) onSave();
            else setEditing(false);
          }}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); setDraft(content); setEditing(false); }
          }}
          className="flex-1 w-full bg-transparent border border-brand-500/30 rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none resize-none px-3 py-2 font-mono"
          placeholder={placeholder}
        />
        {saving && <div className="text-xs text-fg-tertiary mt-1 shrink-0">Saving...</div>}
      </div>
    );
  }
  return (
    <div
      ref={contentRef}
      className="group relative cursor-pointer rounded-lg px-1 py-1 hover:bg-surface-elevated/50 transition-colors min-h-[80px]"
      onClick={() => { setDraft(content); setEditing(true); }}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') { setDraft(content); setEditing(true); } }}
    >
      {content.trim() ? (
        <Suspense fallback={<div className="text-xs text-fg-tertiary">Loading…</div>}>
          <LazyMarkdownMessage content={content} className="text-sm text-fg-secondary leading-relaxed" />
        </Suspense>
      ) : (
        <div className="text-sm text-fg-tertiary italic">{emptyText}</div>
      )}
    </div>
  );
}

function DangerZone({ teamId, teamName, onDeleted }: { teamId: string; teamName: string; onDeleted: () => void }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [purgeFiles, setPurgeFiles] = useState(false);
  const [deleteMembers, setDeleteMembers] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <div className="p-4 bg-surface-secondary rounded-xl border border-red-900/30 space-y-3">
      <div className="text-sm font-medium text-red-500">Danger Zone</div>
      {!showConfirm ? (
        <button onClick={() => setShowConfirm(true)}
          className="px-4 py-1.5 text-xs bg-red-600/20 hover:bg-red-600/30 text-red-500 rounded-lg transition-colors border border-red-500/30">
          Delete Team
        </button>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-fg-secondary">Delete team &quot;{teamName}&quot;? This removes the team record from the database.</div>
          <label className="flex items-center gap-2 text-xs text-fg-secondary cursor-pointer">
            <input type="checkbox" checked={deleteMembers} onChange={e => setDeleteMembers(e.target.checked)} className="rounded" />
            Also delete all members in this team
          </label>
          <label className="flex items-center gap-2 text-xs text-fg-secondary cursor-pointer">
            <input type="checkbox" checked={purgeFiles} onChange={e => setPurgeFiles(e.target.checked)} className="rounded" />
            Also delete disk files (workspace, memory, logs)
          </label>
          <div className="flex gap-2">
            <button disabled={deleting} onClick={async () => {
              setDeleting(true);
              try { await api.teams.delete(teamId, deleteMembers, { purgeFiles }); window.dispatchEvent(new CustomEvent('markus:data-changed')); onDeleted(); }
              catch { setDeleting(false); }
            }} className="px-4 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-50">
              {deleting ? 'Deleting...' : 'Confirm Delete'}
            </button>
            <button onClick={() => setShowConfirm(false)}
              className="px-4 py-1.5 text-xs bg-surface-elevated hover:bg-surface-overlay text-fg-secondary rounded-lg transition-colors border border-border-default">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
