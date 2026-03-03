import { useEffect, useState, useRef } from 'react';
import { api, wsClient, type TeamInfo, type TeamMemberInfo, type RoleInfo, type AuthUser } from '../api.ts';
import { AgentProfile } from './AgentProfile.tsx';
import { ConfirmModal } from '../components/ConfirmModal.tsx';

const ROLE_ICONS: Record<string, string> = {
  'developer': '💻', 'software-engineer': '💻',
  'product-manager': '📋',
  'data-analyst': '📊',
  'devops': '⚙️', 'devops-engineer': '⚙️',
  'support': '🎧', 'customer-support': '🎧',
  'content-writer': '✍️',
  'hr': '👥', 'hr-manager': '👥',
  'marketing': '📣', 'marketing-manager': '📣',
  'qa-engineer': '🔍',
  'finance': '💰',
  'operations': '🔧',
  'org-manager': '⭐',
  'secretary': '🗂',
};

function roleIcon(roleName: string): string {
  return ROLE_ICONS[roleName.toLowerCase().replace(/\s+/g, '-')] ?? '🤖';
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function TeamPage({ authUser }: { authUser?: AuthUser } = {}) {
  const isAdmin = authUser?.role === 'owner' || authUser?.role === 'admin';

  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [ungrouped, setUngrouped] = useState<TeamMemberInfo[]>([]);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const [showNewTeam, setShowNewTeam] = useState(false);
  const [showHire, setShowHire] = useState<{ teamId?: string } | null>(null);
  const [showAddHuman, setShowAddHuman] = useState<{ teamId?: string } | null>(null);
  const [showAddExisting, setShowAddExisting] = useState<string | null>(null);
  const [addMemberMenuTeam, setAddMemberMenuTeam] = useState<string | null>(null);

  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string; message: string; confirmLabel?: string; onConfirm: () => void;
  } | null>(null);
  const askConfirm = (title: string, message: string, onConfirm: () => void, confirmLabel?: string) => {
    setPendingConfirm({ title, message, onConfirm, confirmLabel });
  };

  const refresh = () => {
    api.teams.list().then(d => { setTeams(d.teams); setUngrouped(d.ungrouped); }).catch(() => {});
    api.roles.list().then(d => setRoles(d.roles)).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 15000);
    const unsub = wsClient.on('*', () => refresh());
    return () => { clearInterval(i); unsub(); };
  }, []);

  useEffect(() => {
    const openHire = localStorage.getItem('markus_nav_openHire');
    if (openHire === 'true') {
      localStorage.removeItem('markus_nav_openHire');
      setShowHire({});
    }

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      if (detail.page === 'team' && detail.params?.openHire === 'true') {
        setShowHire({});
      }
    };
    window.addEventListener('markus:navigate', handler);
    return () => window.removeEventListener('markus:navigate', handler);
  }, []);

  useEffect(() => {
    if (!addMemberMenuTeam) return;
    const handler = () => setAddMemberMenuTeam(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [addMemberMenuTeam]);

  const handleSetManager = async (teamId: string, memberId: string, memberType: 'human' | 'agent') => {
    await api.teams.update(teamId, { managerId: memberId, managerType: memberType });
    refresh();
  };

  const handleRemoveFromTeam = (teamId: string, memberId: string) => {
    askConfirm(
      'Remove from team?',
      'This member will be moved to Ungrouped. They will remain in the organization.',
      async () => { await api.teams.removeMember(teamId, memberId); refresh(); },
      'Remove from Team',
    );
  };

  const handleDeleteTeam = (teamId: string, teamName: string) => {
    askConfirm(
      `Delete "${teamName}"?`,
      'All members will become ungrouped but remain in the organization. This cannot be undone.',
      async () => { await api.teams.delete(teamId); refresh(); },
      'Delete Team',
    );
  };

  const handleStartStop = async (agentId: string, status: string) => {
    if (status === 'offline') await api.agents.start(agentId);
    else await api.agents.stop(agentId);
    refresh();
  };

  const handleRemoveAgent = (agentId: string, agentName: string) => {
    askConfirm(
      `Remove "${agentName}"?`,
      'This agent will be permanently removed from the organization.',
      async () => {
        await api.agents.remove(agentId);
        if (selectedAgentId === agentId) setSelectedAgentId(null);
        refresh();
      },
      'Remove Agent',
    );
  };

  const handleRemoveHuman = (userId: string, userName: string) => {
    askConfirm(
      `Remove "${userName}"?`,
      'This user will be removed from the organization and lose access.',
      async () => { await api.users.remove(userId); refresh(); },
      'Remove User',
    );
  };

  const handleMemberClick = (member: TeamMemberInfo) => {
    if (member.type === 'agent') {
      setSelectedAgentId(prev => prev === member.id ? null : member.id);
    }
  };

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* Left panel: team list */}
      <div className={`overflow-y-auto ${selectedAgentId ? 'w-[55%] border-r border-gray-800' : 'flex-1'} transition-all`}
        onClick={() => setAddMemberMenuTeam(null)}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-7 h-14 border-b border-gray-800 bg-gray-900 sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold">Team</h2>
            {authUser && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-900/40 border border-indigo-700/40 text-indigo-300 capitalize">
                {authUser.role}
              </span>
            )}
            <span className="text-xs text-gray-500">{teams.length} team{teams.length !== 1 ? 's' : ''}</span>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowHire({})}
                className="px-3 py-1.5 text-sm border border-gray-700 hover:border-indigo-500 text-gray-300 hover:text-indigo-300 rounded-lg transition-colors"
              >
                + Hire Agent
              </button>
              <button
                onClick={() => setShowNewTeam(true)}
                className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
              >
                + New Team
              </button>
            </div>
          )}
        </div>

        <div className="p-6 space-y-4">
          {teams.map(team => (
            <TeamCard
              key={team.id}
              team={team}
              isAdmin={isAdmin}
              authUserId={authUser?.id}
              selectedAgentId={selectedAgentId}
              addMemberMenuOpen={addMemberMenuTeam === team.id}
              onSetManager={handleSetManager}
              onRemoveFromTeam={handleRemoveFromTeam}
              onDeleteTeam={handleDeleteTeam}
              onStartStop={handleStartStop}
              onRemoveAgent={handleRemoveAgent}
              onRemoveHuman={handleRemoveHuman}
              onMemberClick={handleMemberClick}
              onOpenAddMenu={(e) => { e.stopPropagation(); setAddMemberMenuTeam(prev => prev === team.id ? null : team.id); }}
              onHireAgent={() => { setAddMemberMenuTeam(null); setShowHire({ teamId: team.id }); }}
              onAddHuman={() => { setAddMemberMenuTeam(null); setShowAddHuman({ teamId: team.id }); }}
              onAddExisting={() => { setAddMemberMenuTeam(null); setShowAddExisting(team.id); }}
              ungrouped={ungrouped}
            />
          ))}

          {ungrouped.length > 0 && (
            <UngroupedSection
              members={ungrouped}
              isAdmin={isAdmin}
              authUserId={authUser?.id}
              selectedAgentId={selectedAgentId}
              teams={teams}
              onStartStop={handleStartStop}
              onRemoveAgent={handleRemoveAgent}
              onRemoveHuman={handleRemoveHuman}
              onMemberClick={handleMemberClick}
              onMoveToTeam={async (memberId, memberType, teamId) => {
                await api.teams.addMember(teamId, memberId, memberType);
                refresh();
              }}
            />
          )}

          {teams.length === 0 && ungrouped.length === 0 && (
            <div className="text-center py-20 text-gray-500">
              <div className="text-4xl mb-3">👥</div>
              <div className="text-sm font-medium mb-1">No teams yet</div>
              <div className="text-xs text-gray-600">
                {isAdmin ? 'Create a team or hire agents to get started.' : 'No teams have been created yet.'}
              </div>
            </div>
          )}

          {teams.length === 0 && ungrouped.length > 0 && isAdmin && (
            <div className="text-center py-4 text-xs text-gray-600">
              Create a team above to organize these members.
            </div>
          )}
        </div>
      </div>

      {/* Right panel: agent profile */}
      {selectedAgentId && (
        <div className="w-[45%] overflow-y-auto bg-gray-950">
          <AgentProfile
            agentId={selectedAgentId}
            onBack={() => setSelectedAgentId(null)}
            inline
          />
        </div>
      )}

      {/* Modals */}
      {showNewTeam && (
        <NewTeamModal
          onClose={() => setShowNewTeam(false)}
          onCreate={async (name) => {
            await api.teams.create(name);
            setShowNewTeam(false);
            refresh();
          }}
        />
      )}

      {showHire !== null && (
        <HireAgentModal
          roles={roles}
          teamId={showHire.teamId}
          teams={teams}
          onClose={() => setShowHire(null)}
          onHire={async (name, roleName, agentRole, teamId) => {
            await api.agents.create(name, roleName, agentRole, teamId);
            setShowHire(null);
            refresh();
          }}
        />
      )}

      {showAddHuman !== null && (
        <AddHumanModal
          teamId={showAddHuman.teamId}
          teams={teams}
          onClose={() => setShowAddHuman(null)}
          onAdd={async (name, role, email, password, teamId) => {
            await api.users.create(name, role, undefined, email, password, teamId);
            setShowAddHuman(null);
            refresh();
          }}
        />
      )}

      {showAddExisting !== null && (
        <AddExistingModal
          teamId={showAddExisting}
          ungrouped={ungrouped}
          onClose={() => setShowAddExisting(null)}
          onAdd={async (memberId, memberType) => {
            await api.teams.addMember(showAddExisting, memberId, memberType);
            setShowAddExisting(null);
            refresh();
          }}
        />
      )}

      {pendingConfirm && (
        <ConfirmModal
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          onConfirm={() => { pendingConfirm.onConfirm(); setPendingConfirm(null); }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
  );
}

// ─── Team Card ────────────────────────────────────────────────────────────────

function TeamCard({
  team, isAdmin, authUserId, selectedAgentId, addMemberMenuOpen,
  onSetManager, onRemoveFromTeam, onDeleteTeam,
  onStartStop, onRemoveAgent, onRemoveHuman, onMemberClick,
  onOpenAddMenu, onHireAgent, onAddHuman, onAddExisting, ungrouped,
}: {
  team: TeamInfo;
  isAdmin: boolean;
  authUserId?: string;
  selectedAgentId: string | null;
  addMemberMenuOpen: boolean;
  ungrouped: TeamMemberInfo[];
  onSetManager: (teamId: string, memberId: string, memberType: 'human' | 'agent') => void;
  onRemoveFromTeam: (teamId: string, memberId: string) => void;
  onDeleteTeam: (teamId: string, teamName: string) => void;
  onStartStop: (agentId: string, status: string) => void;
  onRemoveAgent: (agentId: string, agentName: string) => void;
  onRemoveHuman: (userId: string, userName: string) => void;
  onMemberClick: (member: TeamMemberInfo) => void;
  onOpenAddMenu: (e: React.MouseEvent) => void;
  onHireAgent: () => void;
  onAddHuman: () => void;
  onAddExisting: () => void;
}) {
  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-xl hover:border-gray-700 transition-colors">
      {/* Team header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-800/60">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">{team.name}</span>
          <span className="text-xs text-gray-500">{team.members.length} member{team.members.length !== 1 ? 's' : ''}</span>
          {team.managerId && team.managerName && (
            <div className="flex items-center gap-1 text-xs text-amber-400/80 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
              <span>★</span>
              <span>{team.managerName}</span>
            </div>
          )}
          {!team.managerId && (
            <span className="text-xs text-gray-600 italic">No manager</span>
          )}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <div className="relative" onClick={e => e.stopPropagation()}>
              <button
                onClick={onOpenAddMenu}
                className="px-3 py-1 text-xs border border-gray-700 rounded-lg hover:border-indigo-500 hover:text-indigo-300 transition-colors"
              >
                + Add Member
              </button>
              {addMemberMenuOpen && (
                <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 z-30 w-44">
                  <button onClick={onHireAgent} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-700 text-indigo-300">
                    🤖 Hire AI Agent
                  </button>
                  <button onClick={onAddHuman} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-700 text-emerald-300">
                    👤 Add Human
                  </button>
                  {ungrouped.length > 0 && (
                    <button onClick={onAddExisting} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-700 text-gray-300">
                      ↗ Add Existing
                    </button>
                  )}
                </div>
              )}
            </div>
            <button
              onClick={() => onDeleteTeam(team.id, team.name)}
              className="p-1.5 text-gray-600 hover:text-red-400 transition-colors rounded"
              title="Delete team"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Members grid */}
      <div className="p-4">
        {team.members.length === 0 ? (
          <div className="text-center py-6 text-xs text-gray-600">
            No members yet — add someone above.
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {team.members.map(member => (
              <MemberCard
                key={member.id}
                member={member}
                teamId={team.id}
                isManager={team.managerId === member.id}
                isAdmin={isAdmin}
                isSelected={selectedAgentId === member.id}
                isSelf={member.id === authUserId}
                onClick={() => onMemberClick(member)}
                onSetManager={() => onSetManager(team.id, member.id, member.type)}
                onRemoveFromTeam={() => onRemoveFromTeam(team.id, member.id)}
                onStartStop={() => onStartStop(member.id, member.status ?? 'offline')}
                onRemoveFromOrg={() => member.type === 'agent' ? onRemoveAgent(member.id, member.name) : onRemoveHuman(member.id, member.name)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Member Card ──────────────────────────────────────────────────────────────

function MemberCard({
  member, teamId, isManager, isAdmin, isSelected, isSelf,
  onClick, onSetManager, onRemoveFromTeam, onStartStop, onRemoveFromOrg,
}: {
  member: TeamMemberInfo;
  teamId: string;
  isManager: boolean;
  isAdmin: boolean;
  isSelected: boolean;
  isSelf: boolean;
  onClick: () => void;
  onSetManager: () => void;
  onRemoveFromTeam: () => void;
  onStartStop: () => void;
  onRemoveFromOrg: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const isAI = member.type === 'agent';
  const avatarColor = isAI ? 'bg-indigo-700' : 'bg-emerald-800';
  const statusColor = member.status === 'idle' ? 'bg-green-400' : member.status === 'working' ? 'bg-indigo-400 animate-pulse' : 'bg-gray-600';

  return (
    <div
      onClick={onClick}
      className={`relative group w-44 border rounded-xl p-3.5 transition-all cursor-pointer ${
        isSelected
          ? 'border-indigo-500 bg-indigo-900/20 ring-1 ring-indigo-500/30'
          : isManager
            ? 'border-amber-500/40 bg-amber-500/5 hover:border-amber-400/60'
            : 'border-gray-700/60 bg-gray-800/50 hover:border-gray-500'
      }`}
    >
      {isManager && (
        <div className="absolute -top-2 -right-2 w-5 h-5 bg-amber-500 rounded-full flex items-center justify-center text-[10px] text-gray-900 font-bold shadow">★</div>
      )}

      <div className="flex items-center gap-2.5 mb-2.5">
        <div className={`w-9 h-9 ${avatarColor} rounded-lg flex items-center justify-center text-sm font-bold shrink-0 text-white`}>
          {member.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate leading-tight">{member.name}</div>
          <div className="text-[11px] text-gray-500 truncate">{member.role}</div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-[11px]">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${isAI ? 'bg-indigo-900/60 text-indigo-400' : 'bg-emerald-900/40 text-emerald-400'}`}>
          {isAI ? 'AI' : 'Human'}
        </span>
        {isAI && member.status && (
          <div className="flex items-center gap-1 ml-auto">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
            <span className="text-gray-500">{member.status}</span>
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity" ref={menuRef}>
          <button
            onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}
            className="w-6 h-6 rounded-md hover:bg-gray-700 flex items-center justify-center text-gray-500 hover:text-gray-300 text-xs"
          >
            ···
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-7 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 z-40 w-40" onClick={e => e.stopPropagation()}>
              {!isManager && (
                <button onClick={() => { setMenuOpen(false); onSetManager(); }} className="w-full text-left px-3 py-2 text-xs hover:bg-gray-700 text-amber-300">
                  ★ Set as Manager
                </button>
              )}
              {isAI && (
                <button onClick={() => { setMenuOpen(false); onStartStop(); }} className="w-full text-left px-3 py-2 text-xs hover:bg-gray-700 text-indigo-300">
                  {member.status === 'offline' ? '▶ Start' : '⏹ Stop'}
                </button>
              )}
              <button onClick={() => { setMenuOpen(false); onRemoveFromTeam(); }} className="w-full text-left px-3 py-2 text-xs hover:bg-gray-700 text-gray-400">
                ↩ Remove from team
              </button>
              {!isSelf && (
                <button onClick={() => { setMenuOpen(false); onRemoveFromOrg(); }} className="w-full text-left px-3 py-2 text-xs hover:bg-gray-700 text-red-400">
                  🗑 Remove from org
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Ungrouped Section ────────────────────────────────────────────────────────

function UngroupedSection({
  members, isAdmin, authUserId, selectedAgentId, teams,
  onStartStop, onRemoveAgent, onRemoveHuman, onMemberClick, onMoveToTeam,
}: {
  members: TeamMemberInfo[];
  isAdmin: boolean;
  authUserId?: string;
  selectedAgentId: string | null;
  teams: TeamInfo[];
  onStartStop: (agentId: string, status: string) => void;
  onRemoveAgent: (agentId: string, agentName: string) => void;
  onRemoveHuman: (userId: string, userName: string) => void;
  onMemberClick: (member: TeamMemberInfo) => void;
  onMoveToTeam: (memberId: string, memberType: 'human' | 'agent', teamId: string) => void;
}) {
  return (
    <div className="border border-dashed border-gray-700/50 rounded-xl">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-800/40">
        <span className="text-sm font-medium text-gray-400">Ungrouped</span>
        <span className="text-xs text-gray-600">{members.length} member{members.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="p-4 flex flex-wrap gap-3">
        {members.map(member => (
          <UngroupedMemberCard
            key={member.id}
            member={member}
            isAdmin={isAdmin}
            isSelected={selectedAgentId === member.id}
            isSelf={member.id === authUserId}
            teams={teams}
            onClick={() => onMemberClick(member)}
            onStartStop={() => onStartStop(member.id, member.status ?? 'offline')}
            onRemove={() => member.type === 'agent' ? onRemoveAgent(member.id, member.name) : onRemoveHuman(member.id, member.name)}
            onMoveToTeam={(teamId) => onMoveToTeam(member.id, member.type, teamId)}
          />
        ))}
      </div>
    </div>
  );
}

function UngroupedMemberCard({
  member, isAdmin, isSelected, isSelf, teams, onClick, onStartStop, onRemove, onMoveToTeam,
}: {
  member: TeamMemberInfo;
  isAdmin: boolean;
  isSelected: boolean;
  isSelf: boolean;
  teams: TeamInfo[];
  onClick: () => void;
  onStartStop: () => void;
  onRemove: () => void;
  onMoveToTeam: (teamId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const isAI = member.type === 'agent';
  const statusColor = member.status === 'idle' ? 'bg-green-400' : member.status === 'working' ? 'bg-indigo-400 animate-pulse' : 'bg-gray-600';

  return (
    <div
      onClick={onClick}
      className={`relative group w-44 border rounded-xl p-3.5 transition-all cursor-pointer ${
        isSelected
          ? 'border-indigo-500 bg-indigo-900/20 ring-1 ring-indigo-500/30'
          : 'border-gray-700/40 bg-gray-800/30 hover:border-gray-500'
      }`}
    >
      <div className="flex items-center gap-2.5 mb-2">
        <div className={`w-9 h-9 ${isAI ? 'bg-indigo-800/60' : 'bg-emerald-900/60'} rounded-lg flex items-center justify-center text-sm font-bold shrink-0`}>
          {member.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{member.name}</div>
          <div className="text-[11px] text-gray-500 truncate">{member.role}</div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${isAI ? 'bg-indigo-900/40 text-indigo-500' : 'bg-emerald-900/30 text-emerald-500'}`}>
          {isAI ? 'AI' : 'Human'}
        </span>
        {isAI && member.status && (
          <div className="flex items-center gap-1 ml-auto">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
            <span className="text-gray-600">{member.status}</span>
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity" ref={menuRef}>
          <button
            onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}
            className="w-6 h-6 rounded-md hover:bg-gray-700 flex items-center justify-center text-gray-500 hover:text-gray-300 text-xs"
          >
            ···
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-7 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 z-40 w-44" onClick={e => e.stopPropagation()}>
              {teams.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-[10px] text-gray-500 uppercase tracking-wider">Move to team</div>
                  {teams.map(t => (
                    <button key={t.id} onClick={() => { setMenuOpen(false); onMoveToTeam(t.id); }} className="w-full text-left px-3 py-2 text-xs hover:bg-gray-700 text-gray-300">
                      → {t.name}
                    </button>
                  ))}
                  <div className="border-t border-gray-700/50 my-1" />
                </div>
              )}
              {isAI && (
                <button onClick={() => { setMenuOpen(false); onStartStop(); }} className="w-full text-left px-3 py-2 text-xs hover:bg-gray-700 text-indigo-300">
                  {member.status === 'offline' ? '▶ Start' : '⏹ Stop'}
                </button>
              )}
              {!isSelf && (
                <button onClick={() => { setMenuOpen(false); onRemove(); }} className="w-full text-left px-3 py-2 text-xs hover:bg-gray-700 text-red-400">
                  🗑 Remove
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Modals ───────────────────────────────────────────────────────────────────

function NewTeamModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <Modal onClose={onClose} title="Create a New Team">
      <div className="space-y-4">
        <Field label="Team Name">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Engineering, Marketing, Support" className="input" autoFocus
            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onCreate(name.trim()); }}
          />
        </Field>
        <div className="text-xs text-gray-500">
          You can add human and AI members to this team after creating it.
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800">Cancel</button>
          <button onClick={() => name.trim() && onCreate(name.trim())} disabled={!name.trim()} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg text-white">
            Create Team
          </button>
        </div>
      </div>
    </Modal>
  );
}

function HireAgentModal({
  roles, teamId, teams, onClose, onHire,
}: {
  roles: RoleInfo[];
  teamId?: string;
  teams: TeamInfo[];
  onClose: () => void;
  onHire: (name: string, roleName: string, agentRole: 'worker' | 'manager', teamId?: string) => void;
}) {
  const [name, setName] = useState('');
  const [selectedRole, setSelectedRole] = useState('');
  const [agentRole, setAgentRole] = useState<'worker' | 'manager'>('worker');
  const [selectedTeam, setSelectedTeam] = useState(teamId ?? '');
  const [showMore, setShowMore] = useState(false);

  const visibleRoles = showMore ? roles : roles.slice(0, 8);

  return (
    <Modal onClose={onClose} title="Hire a Digital Employee" width="w-[560px]">
      <div className="space-y-5">
        <Field label="Name">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Alice, Bob" className="input" autoFocus />
        </Field>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-gray-400">Role</label>
            {roles.length > 8 && (
              <button onClick={() => setShowMore(v => !v)} className="text-xs text-indigo-400 hover:text-indigo-300">
                {showMore ? '▲ Less' : `▼ All ${roles.length} roles`}
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
            {visibleRoles.map(r => (
              <button
                key={r.id}
                onClick={() => setSelectedRole(r.id)}
                className={`text-left p-3 rounded-xl border text-xs transition-all ${
                  selectedRole === r.id
                    ? 'border-indigo-500 bg-indigo-600/15 text-white'
                    : 'border-gray-700 hover:border-gray-600 text-gray-400 hover:text-gray-200'
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span>{roleIcon(r.id)}</span>
                  <span className="font-medium capitalize">{r.name.replace(/-/g, ' ')}</span>
                  {selectedRole === r.id && <span className="ml-auto text-indigo-400 text-xs">✓</span>}
                </div>
                {r.description && <div className="text-gray-500 text-[11px] leading-snug truncate">{r.description}</div>}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Position">
            <div className="flex gap-2">
              {(['worker', 'manager'] as const).map(pos => (
                <button
                  key={pos}
                  onClick={() => setAgentRole(pos)}
                  className={`flex-1 py-2 text-xs rounded-lg border transition-colors ${
                    agentRole === pos ? 'border-indigo-500 bg-indigo-600/15 text-indigo-300' : 'border-gray-700 text-gray-400 hover:border-gray-600'
                  }`}
                >
                  {pos === 'worker' ? '👷 Worker' : '⭐ Manager'}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Assign to Team">
            <select value={selectedTeam} onChange={e => setSelectedTeam(e.target.value)} className="input text-sm">
              <option value="">No team (ungrouped)</option>
              {teams.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </Field>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800">Cancel</button>
          <button
            onClick={() => onHire(name, selectedRole, agentRole, selectedTeam || undefined)}
            disabled={!name.trim() || !selectedRole}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg text-white"
          >
            Hire
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AddHumanModal({
  teamId, teams, onClose, onAdd,
}: {
  teamId?: string;
  teams: TeamInfo[];
  onClose: () => void;
  onAdd: (name: string, role: string, email: string | undefined, password: string | undefined, teamId: string | undefined) => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('member');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [selectedTeam, setSelectedTeam] = useState(teamId ?? '');
  const [error, setError] = useState('');

  const submit = () => {
    setError('');
    if (!name.trim()) { setError('Name is required'); return; }
    if (password && password !== confirmPassword) { setError('Passwords do not match'); return; }
    onAdd(name.trim(), role, email || undefined, password || undefined, selectedTeam || undefined);
  };

  return (
    <Modal onClose={onClose} title="Add Human Team Member" width="w-[460px]">
      <div className="space-y-4">
        <Field label="Name *">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" className="input" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">
            <select value={role} onChange={e => setRole(e.target.value)} className="input">
              <option value="owner">Owner</option>
              <option value="admin">Admin</option>
              <option value="member">Member</option>
              <option value="guest">Guest</option>
            </select>
          </Field>
          <Field label="Assign to Team">
            <select value={selectedTeam} onChange={e => setSelectedTeam(e.target.value)} className="input">
              <option value="">No team</option>
              {teams.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Email">
          <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="Optional (required for login)" className="input" />
        </Field>
        <div className="border-t border-gray-800 pt-3">
          <div className="text-xs text-gray-500 mb-3">Set a password to allow this person to log in.</div>
          <Field label="Password">
            <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Leave blank for no login access" className="input" />
          </Field>
          {password && (
            <div className="mt-3">
              <Field label="Confirm Password">
                <input value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} type="password" placeholder="Repeat password" className="input" />
              </Field>
            </div>
          )}
        </div>
        {error && <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800">Cancel</button>
          <button onClick={submit} className="px-4 py-2 text-sm bg-emerald-700 hover:bg-emerald-600 rounded-lg text-white">Add Member</button>
        </div>
      </div>
    </Modal>
  );
}

function AddExistingModal({
  teamId, ungrouped, onClose, onAdd,
}: {
  teamId: string;
  ungrouped: TeamMemberInfo[];
  onClose: () => void;
  onAdd: (memberId: string, memberType: 'human' | 'agent') => void;
}) {
  return (
    <Modal onClose={onClose} title="Add Existing Member to Team">
      <div className="space-y-3">
        <div className="text-xs text-gray-500">Select an ungrouped member to add to this team.</div>
        {ungrouped.length === 0 ? (
          <div className="text-center py-8 text-sm text-gray-500">All members are already in a team.</div>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {ungrouped.map(m => (
              <button
                key={m.id}
                onClick={() => onAdd(m.id, m.type)}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-700 hover:border-indigo-500 hover:bg-indigo-900/10 text-left transition-all"
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${m.type === 'agent' ? 'bg-indigo-800' : 'bg-emerald-800'}`}>
                  {m.name.charAt(0)}
                </div>
                <div className="flex-1">
                  <div className="font-medium text-sm">{m.name}</div>
                  <div className="text-xs text-gray-500">{m.role} · {m.type === 'agent' ? 'AI' : 'Human'}</div>
                </div>
                {m.status && (
                  <span className={`w-2 h-2 rounded-full ${m.status === 'idle' ? 'bg-green-400' : m.status === 'working' ? 'bg-indigo-400' : 'bg-gray-600'}`} />
                )}
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800">Close</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── UI Primitives ────────────────────────────────────────────────────────────

function Modal({ children, onClose, title, width = 'w-[440px]' }: { children: React.ReactNode; onClose: () => void; title: string; width?: string }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className={`bg-gray-900 border border-gray-800 rounded-xl p-6 ${width} shadow-2xl max-h-[90vh] overflow-y-auto`} onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-5">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1.5 font-medium">{label}</label>
      {children}
    </div>
  );
}
