import { useEffect, useState, useCallback, useRef } from 'react';
import { api, hubApi } from '../api.ts';
import type { TeamInfo, TeamMemberInfo } from '../api.ts';

interface Props {
  teamId: string;
  onBack: () => void;
  inline?: boolean;
}

type TeamTab = 'overview' | 'members' | 'announcements' | 'norms' | 'settings';

const TABS: Array<{ key: TeamTab; label: string; icon: string }> = [
  { key: 'overview', label: 'Overview', icon: '▦' },
  { key: 'members', label: 'Members', icon: '◉' },
  { key: 'announcements', label: 'Announcements', icon: '◈' },
  { key: 'norms', label: 'Norms', icon: '☰' },
  { key: 'settings', label: 'Settings', icon: '⚙' },
];

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-green-400', working: 'bg-brand-400 animate-pulse',
  paused: 'bg-amber-400', offline: 'bg-gray-500', error: 'bg-red-400',
};

export function TeamProfile({ teamId, onBack, inline }: Props) {
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [tab, setTab] = useState<TeamTab>('overview');
  const [announcements, setAnnouncements] = useState('');
  const [norms, setNorms] = useState('');
  const [editingAnn, setEditingAnn] = useState(false);
  const [editingNorms, setEditingNorms] = useState(false);
  const [annDraft, setAnnDraft] = useState('');
  const [normsDraft, setNormsDraft] = useState('');
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
      const t = res.teams.find(t => t.id === teamId);
      if (t) setTeam(t);

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

  return (
    <div className="flex-1 overflow-y-auto bg-surface-primary">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-border-default bg-surface-secondary sticky top-0 z-10">
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
                name: team.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || team.name,
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
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-xs rounded-t-lg whitespace-nowrap transition-colors ${tab === t.key ? 'bg-surface-primary text-fg-primary border border-border-default border-b-gray-950' : 'text-fg-tertiary hover:text-fg-secondary'}`}
            >{t.icon} {t.label}</button>
          ))}
        </div>
      </div>

      <div className="p-5">
        {/* Overview Tab */}
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

            {announcements.trim() && (
              <div className="p-4 bg-surface-secondary rounded-xl border border-border-default">
                <div className="text-xs text-fg-tertiary mb-2 font-medium">Latest Announcement</div>
                <div className="text-sm text-fg-secondary whitespace-pre-wrap">{announcements.slice(0, 500)}{announcements.length > 500 ? '...' : ''}</div>
              </div>
            )}

            <div className="p-4 bg-surface-secondary rounded-xl border border-border-default">
              <div className="text-xs text-fg-tertiary mb-2 font-medium">Members</div>
              <div className="space-y-2">
                {team.members.map(m => {
                  const st = teamStatuses.find(s => s.id === m.id);
                  const dot = STATUS_DOT[st?.status ?? 'offline'] ?? 'bg-gray-500';
                  return (
                    <div key={m.id} className="flex items-center gap-2 text-sm">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                      <span className="font-medium">{m.name}</span>
                      <span className="text-fg-tertiary">{m.role}</span>
                      {m.agentRole === 'manager' && <span className="text-[10px] px-1 py-0.5 bg-amber-500/15 text-amber-600 rounded">Manager</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Members Tab */}
        {tab === 'members' && (
          <div className="space-y-3">
            {team.members.map(m => {
              const st = teamStatuses.find(s => s.id === m.id);
              const dot = STATUS_DOT[st?.status ?? 'offline'] ?? 'bg-gray-500';
              return (
                <div key={m.id} className="p-3 bg-surface-secondary rounded-xl border border-border-default flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-surface-elevated flex items-center justify-center text-sm font-bold shrink-0">{m.name.charAt(0)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{m.name}</span>
                      <span className={`w-2 h-2 rounded-full ${dot}`} />
                      <span className="text-xs text-fg-tertiary">{st?.status ?? 'offline'}</span>
                      {m.agentRole === 'manager' && <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/15 text-amber-600 rounded font-medium">Manager</span>}
                    </div>
                    <div className="text-xs text-fg-tertiary">{m.role} · {m.type}</div>
                  </div>
                </div>
              );
            })}
            {team.members.length === 0 && <div className="text-sm text-fg-tertiary text-center py-8">No members</div>}
          </div>
        )}

        {/* Announcements Tab */}
        {tab === 'announcements' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-fg-secondary">Team Announcements</h3>
              {!editingAnn && (
                <button onClick={() => { setAnnDraft(announcements); setEditingAnn(true); }}
                  className="px-3 py-1 text-xs bg-surface-elevated hover:bg-surface-overlay text-fg-secondary rounded-lg transition-colors">Edit</button>
              )}
            </div>
            {editingAnn ? (
              <div className="space-y-3">
                <textarea value={annDraft} onChange={e => setAnnDraft(e.target.value)}
                  className="w-full h-64 bg-surface-secondary border border-border-default rounded-xl p-3 text-sm text-fg-primary resize-y focus:outline-none focus:border-brand-500 font-mono"
                  placeholder="Write team announcements here (Markdown supported)..."
                />
                <div className="flex gap-2">
                  <button onClick={() => saveFile('ANNOUNCEMENT.md', annDraft)} disabled={saving}
                    className="px-4 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-50">
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button onClick={() => setEditingAnn(false)}
                    className="px-4 py-1.5 text-xs bg-surface-elevated hover:bg-surface-overlay text-fg-secondary rounded-lg transition-colors">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="p-4 bg-surface-secondary rounded-xl border border-border-default min-h-[120px]">
                {announcements.trim() ? (
                  <div className="text-sm text-fg-secondary whitespace-pre-wrap">{announcements}</div>
                ) : (
                  <div className="text-sm text-fg-tertiary italic">No announcements yet. Click Edit to add.</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Norms Tab */}
        {tab === 'norms' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-fg-secondary">Team Working Norms</h3>
              {!editingNorms && (
                <button onClick={() => { setNormsDraft(norms); setEditingNorms(true); }}
                  className="px-3 py-1 text-xs bg-surface-elevated hover:bg-surface-overlay text-fg-secondary rounded-lg transition-colors">Edit</button>
              )}
            </div>
            {editingNorms ? (
              <div className="space-y-3">
                <textarea value={normsDraft} onChange={e => setNormsDraft(e.target.value)}
                  className="w-full h-64 bg-surface-secondary border border-border-default rounded-xl p-3 text-sm text-fg-primary resize-y focus:outline-none focus:border-brand-500 font-mono"
                  placeholder="Define team norms and working agreements (Markdown supported)..."
                />
                <div className="flex gap-2">
                  <button onClick={() => saveFile('NORMS.md', normsDraft)} disabled={saving}
                    className="px-4 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-50">
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button onClick={() => setEditingNorms(false)}
                    className="px-4 py-1.5 text-xs bg-surface-elevated hover:bg-surface-overlay text-fg-secondary rounded-lg transition-colors">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="p-4 bg-surface-secondary rounded-xl border border-border-default min-h-[120px]">
                {norms.trim() ? (
                  <div className="text-sm text-fg-secondary whitespace-pre-wrap">{norms}</div>
                ) : (
                  <div className="text-sm text-fg-tertiary italic">No norms defined yet. Click Edit to add.</div>
                )}
              </div>
            )}
          </div>
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

            <div className="p-4 bg-surface-secondary rounded-xl border border-red-900/30 space-y-3">
              <div className="text-sm font-medium text-red-500">Danger Zone</div>
              <button onClick={async () => {
                if (!confirm(`Delete team "${team.name}"? This cannot be undone.`)) return;
                await api.teams.delete(teamId, false);
                onBack();
              }} className="px-4 py-1.5 text-xs bg-red-600/20 hover:bg-red-600/30 text-red-500 rounded-lg transition-colors border border-red-500/30">
                Delete Team
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
