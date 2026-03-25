import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  api, wsClient,
  type AgentInfo, type TeamInfo, type TeamMemberInfo,
  type TaskInfo, type HumanUserInfo, type ExternalAgentInfo, type AuthUser,
} from '../api.ts';
import { navBus } from '../navBus.ts';
import { ConfirmModal } from './ConfirmModal.tsx';
import {
  NewTeamModal, AddHumanModal, AddExistingModal,
  OpenClawImportModal, BusyAgentModal,
} from './TeamModals.tsx';

// ─── Types ────────────────────────────────────────────────────────────────────

type ChatMode = 'channel' | 'smart' | 'direct' | 'dm';

interface ChatTeamSidebarProps {
  authUser?: AuthUser;
  agents: AgentInfo[];
  teams: TeamInfo[];
  humans: HumanUserInfo[];
  tasks: TaskInfo[];
  externalAgents: ExternalAgentInfo[];
  groupChats: Array<{ id: string; name: string; type: string; channelKey: string; memberCount?: number; teamId?: string }>;
  chatMode: ChatMode;
  selectedAgent: string;
  activeChannel: string;
  activeDmUserId: string;
  onSelectAgent: (agentId: string) => void;
  onSelectChannel: (channelKey: string) => void;
  onSelectDm: (userId: string) => void;
  onRefreshTeams: () => void;
  onRefreshAgents: () => void;
  onViewProfile: (agentId: string) => void;
  width?: number;
  onResizeStart?: (e: React.MouseEvent) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function agentInitials(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ChatTeamSidebar({
  authUser, agents, teams, humans, tasks, externalAgents, groupChats,
  chatMode, selectedAgent, activeChannel, activeDmUserId,
  onSelectAgent, onSelectChannel, onSelectDm,
  onRefreshTeams, onRefreshAgents, onViewProfile,
  width, onResizeStart,
}: ChatTeamSidebarProps) {
  const isAdmin = authUser?.role === 'owner' || authUser?.role === 'admin';
  const externalMarkusIds = useMemo(() => new Set(externalAgents.map(ea => ea.markusAgentId).filter(Boolean) as string[]), [externalAgents]);

  // Ungrouped members (from teams API)
  const [ungrouped, setUngrouped] = useState<TeamMemberInfo[]>([]);

  // Team section collapse
  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(new Set());

  // Modals
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [showAddHuman, setShowAddHuman] = useState<{ teamId?: string } | null>(null);
  const [showAddExisting, setShowAddExisting] = useState<string | null>(null);
  const [showOpenClaw, setShowOpenClaw] = useState(false);
  const [busyAgent, setBusyAgent] = useState<{ id: string; name: string; taskId: string } | null>(null);

  // Context menus
  const [teamMenu, setTeamMenu] = useState<{ teamId: string; x: number; y: number } | null>(null);
  const [agentMenu, setAgentMenu] = useState<{ agentId: string; teamId?: string; x: number; y: number } | null>(null);
  const [addMenu, setAddMenu] = useState<string | null>(null); // teamId for which add menu is open

  // Action bar dropdown
  const [actionMenu, setActionMenu] = useState(false);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  // Toast
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Confirm dialog
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string; message: string; confirmLabel?: string;
    checkboxes?: { id: string; label: string; defaultChecked?: boolean }[];
    onConfirm: (checked?: Record<string, boolean>) => void;
  } | null>(null);
  const askConfirm = (
    title: string, message: string, onConfirm: (checked?: Record<string, boolean>) => void,
    confirmLabel?: string, checkboxes?: { id: string; label: string; defaultChecked?: boolean }[]
  ) => {
    setPendingConfirm({ title, message, onConfirm, confirmLabel, checkboxes });
  };

  // Drag-and-drop state
  const [dragAgent, setDragAgent] = useState<{ agentId: string; fromTeamId?: string } | null>(null);
  const [dragOverTeam, setDragOverTeam] = useState<string | null>(null);
  const dragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Editing team name
  const [editingTeam, setEditingTeam] = useState<string | null>(null);
  const [editTeamName, setEditTeamName] = useState('');

  const adjustMenuPosition = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${Math.max(pad, window.innerHeight - rect.height - pad)}px`;
    }
    if (rect.right > window.innerWidth) {
      el.style.left = `${Math.max(pad, window.innerWidth - rect.width - pad)}px`;
    }
  }, []);

  // ── Last messages per agent ──────────────────────────────────────────────
  const [agentLastMsg, setAgentLastMsg] = useState<Map<string, string>>(new Map());
  const agentIdsKey = useMemo(() => agents.map(a => a.id).sort().join(','), [agents]);

  useEffect(() => {
    if (!agents.length) return;
    let cancelled = false;
    const fetchAll = async () => {
      const entries: [string, string][] = [];
      await Promise.allSettled(
        agents.map(async (a) => {
          try {
            const { sessions: ss } = await api.sessions.listByAgent(a.id, 1);
            if (!ss.length) return;
            const { messages } = await api.sessions.getMessages(ss[0].id, 1);
            if (messages.length) {
              const msg = messages[0];
              const segs = msg.metadata?.segments;
              let raw = msg.content;
              if (segs && segs.length > 0) {
                const last = [...segs].reverse().find(s => s.type === 'text');
                if (last && last.type === 'text') raw = last.content;
              }
              const txt = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\n+/g, ' ').trim().slice(0, 80);
              if (txt) entries.push([a.id, txt]);
            }
          } catch { /* ignore */ }
        }),
      );
      if (!cancelled) setAgentLastMsg(new Map(entries));
    };
    fetchAll();
    const timer = setInterval(fetchAll, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [agentIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Data loading ──────────────────────────────────────────────────────────
  const refreshUngrouped = useCallback(() => {
    api.teams.list().then(d => setUngrouped(d.ungrouped)).catch(() => {});
  }, []);

  useEffect(() => {
    refreshUngrouped();
  }, [refreshUngrouped]);

  useEffect(() => {
    const unsub = wsClient.on('*', refreshUngrouped);
    return unsub;
  }, [refreshUngrouped]);

  // Close menus on outside click
  useEffect(() => {
    if (!teamMenu && !agentMenu && !actionMenu) return;
    const handler = (e: MouseEvent) => {
      setTeamMenu(null);
      setAgentMenu(null);
      setActionMenu(false);
    };
    setTimeout(() => document.addEventListener('click', handler), 0);
    return () => document.removeEventListener('click', handler);
  }, [teamMenu, agentMenu, actionMenu]);

  // ── Team actions ──────────────────────────────────────────────────────────

  const handleDeleteTeam = (teamId: string, teamName: string) => {
    askConfirm(
      `Delete "${teamName}"?`,
      'This team will be permanently deleted.',
      async (checked) => {
        const deleteMembers = checked?.['deleteMembers'] ?? true;
        await api.teams.delete(teamId, deleteMembers);
        onRefreshTeams();
        refreshUngrouped();
      },
      'Delete Team',
      [{ id: 'deleteMembers', label: 'Also delete all members in this team', defaultChecked: true }],
    );
  };

  const handleBatchAction = async (teamId: string, action: 'start' | 'stop' | 'resume' | 'pause') => {
    try {
      const fn = action === 'start' ? api.teams.startAll
        : action === 'stop' ? api.teams.stopAll
        : action === 'pause' ? api.teams.pauseAll
        : api.teams.resumeAll;
      const result = await fn(teamId);
      const ok = result.success?.length ?? 0;
      const fail = result.failed?.length ?? 0;
      const labels: Record<string, string> = { start: 'started', stop: 'stopped', pause: 'paused', resume: 'resumed' };
      if (fail > 0) showToast(`${action}: ${ok} succeeded, ${fail} failed`, 'error');
      else if (ok > 0) showToast(`${ok} agent${ok > 1 ? 's' : ''} ${labels[action]}`, 'success');
      onRefreshAgents();
    } catch (err) {
      showToast(`Failed to ${action}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleSetManager = async (teamId: string, memberId: string, memberType: 'human' | 'agent') => {
    await api.teams.update(teamId, { managerId: memberId, managerType: memberType });
    onRefreshTeams();
  };

  const handleRenameTeam = async (teamId: string) => {
    if (!editTeamName.trim()) { setEditingTeam(null); return; }
    await api.teams.update(teamId, { name: editTeamName.trim() });
    setEditingTeam(null);
    onRefreshTeams();
  };

  // ── Agent actions ──────────────────────────────────────────────────────────

  const handleStartStop = async (agentId: string, status: string) => {
    if (status === 'offline') await api.agents.start(agentId);
    else await api.agents.stop(agentId);
    onRefreshAgents();
  };

  const handleRemoveFromTeam = (teamId: string, memberId: string) => {
    askConfirm(
      'Remove from team?',
      'This member will be moved to Ungrouped.',
      async () => {
        await api.teams.removeMember(teamId, memberId);
        onRefreshTeams();
        refreshUngrouped();
      },
      'Remove',
    );
  };

  const handleRemoveFromOrg = (id: string, name: string, type: 'agent' | 'human') => {
    askConfirm(
      `Remove "${name}"?`,
      type === 'agent' ? 'This agent will be permanently removed.' : 'This user will lose access.',
      async () => {
        if (type === 'agent') await api.agents.remove(id);
        else await api.users.remove(id);
        onRefreshAgents();
        onRefreshTeams();
        refreshUngrouped();
      },
      'Remove',
    );
  };

  // ── Drag-and-drop handlers ────────────────────────────────────────────────

  const handlePointerDown = (e: React.PointerEvent, agentId: string, fromTeamId?: string) => {
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    dragTimerRef.current = setTimeout(() => {
      setDragAgent({ agentId, fromTeamId });
      setIsDragging(true);
    }, 200);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStartPos.current || !dragTimerRef.current) return;
    const dx = Math.abs(e.clientX - dragStartPos.current.x);
    const dy = Math.abs(e.clientY - dragStartPos.current.y);
    if (dx > 5 || dy > 5) {
      // Moved before timer — it's a normal click/scroll, cancel drag
      if (!isDragging) {
        clearTimeout(dragTimerRef.current);
        dragTimerRef.current = null;
      }
    }
  };

  const handlePointerUp = async () => {
    if (dragTimerRef.current) {
      clearTimeout(dragTimerRef.current);
      dragTimerRef.current = null;
    }
    dragStartPos.current = null;

    if (isDragging && dragAgent && dragOverTeam) {
      const targetTeamId = dragOverTeam === '_ungrouped' ? undefined : dragOverTeam;
      try {
        if (dragAgent.fromTeamId && dragAgent.fromTeamId !== targetTeamId) {
          await api.teams.removeMember(dragAgent.fromTeamId, dragAgent.agentId);
        }
        if (targetTeamId && targetTeamId !== dragAgent.fromTeamId) {
          const a = agents.find(ag => ag.id === dragAgent.agentId);
          await api.teams.addMember(targetTeamId, dragAgent.agentId, 'agent');
        }
        onRefreshTeams();
        onRefreshAgents();
        refreshUngrouped();
      } catch (err) {
        showToast(`Move failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    }
    setDragAgent(null);
    setDragOverTeam(null);
    setIsDragging(false);
  };

  // ── Computed ──────────────────────────────────────────────────────────────

  const teamMap = useMemo(() => new Map(teams.map(t => [t.id, t])), [teams]);
  const agentsByTeam = useMemo(() => {
    const map = new Map<string, AgentInfo[]>();
    const ug: AgentInfo[] = [];
    for (const a of agents) {
      if (a.teamId && teamMap.has(a.teamId)) {
        const list = map.get(a.teamId) ?? [];
        list.push(a);
        map.set(a.teamId, list);
      } else {
        ug.push(a);
      }
    }
    return { byTeam: map, ungrouped: ug };
  }, [agents, teamMap]);

  const teamIds = teams.filter(t => agentsByTeam.byTeam.has(t.id) || t.members?.length > 0).map(t => t.id);

  const toggleTeam = (tid: string) => setCollapsedTeams(prev => {
    const next = new Set(prev);
    if (next.has(tid)) next.delete(tid); else next.add(tid);
    return next;
  });

  // ── Agent sidebar item renderer ──────────────────────────────────────────

  const renderAgentItem = (a: AgentInfo, teamId?: string) => {
    const selected = chatMode === 'direct' && selectedAgent === a.id;
    const isExt = externalMarkusIds.has(a.id);
    const statusColor = a.status === 'idle' ? 'bg-green-500' : a.status === 'working' ? 'bg-blue-500 animate-pulse' : a.status === 'error' ? 'bg-red-500' : a.status === 'paused' ? 'bg-amber-500' : 'bg-gray-600';

    const team = teamId ? teamMap.get(teamId) : undefined;
    const isManager = team?.managerId === a.id;
    const roleNorm = a.role?.toLowerCase().replace(/[-_]/g, ' ').trim();
    const nameNorm = a.name.toLowerCase().trim();
    const showRole = roleNorm && roleNorm !== nameNorm;

    const subtitle = agentLastMsg.get(a.id)
      || (a.currentActivity?.label?.slice(0, 60) || '');

    const statusTitle = a.status === 'idle' ? 'Online' : a.status === 'working' ? 'Working' : a.status === 'error' ? 'Error' : a.status === 'paused' ? 'Paused' : 'Offline';

    return (
      <div
        key={a.id}
        className={`relative mb-0.5 ${isDragging && dragAgent?.agentId === a.id ? 'opacity-40' : ''}`}
        onPointerDown={e => handlePointerDown(e, a.id, teamId)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <button
          onClick={() => {
            if (!isDragging) onSelectAgent(a.id);
          }}
          onContextMenu={e => {
            if (!isAdmin) return;
            e.preventDefault();
            setAgentMenu({ agentId: a.id, teamId, x: e.clientX, y: e.clientY });
          }}
          className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-xs transition-colors touch-none select-none ${
            selected ? 'bg-brand-600/20 text-brand-500' : 'text-fg-secondary hover:bg-surface-elevated'
          }`}
        >
          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
            selected ? 'bg-brand-600 text-white' : 'bg-surface-overlay text-fg-secondary'
          }`}>
            {agentInitials(a.name)}
          </div>
          <div className="flex-1 min-w-0 text-left">
            <div className="flex items-center gap-1">
              <span className="truncate font-medium text-[11px] leading-tight">{a.name}</span>
              {showRole && <span className="text-[9px] text-fg-tertiary shrink-0 truncate max-w-[60px]">({a.role})</span>}
              {isManager && <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" className="text-amber-600 shrink-0"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>}
              {isExt && <span className="text-[8px] px-1 py-0 rounded bg-brand-500/20 text-brand-500 font-medium shrink-0 leading-relaxed">EXT</span>}
            </div>
            <div className="truncate text-[10px] leading-tight mt-0.5 text-fg-tertiary">
              {subtitle || '\u00A0'}
            </div>
          </div>
          <span
            title={statusTitle}
            onClick={e => { e.stopPropagation(); onViewProfile(a.id); }}
            className={`w-2 h-2 rounded-full shrink-0 cursor-pointer transition-transform duration-150 hover:scale-[2] ${statusColor}`}
          />
        </button>
      </div>
    );
  };

  // ── Team section renderer ────────────────────────────────────────────────

  const renderTeamSection = (tid: string, team: TeamInfo | null, agentList: AgentInfo[], label: string) => {
    const isCollapsed = collapsedTeams.has(tid);
    const isDropTarget = isDragging && dragOverTeam === tid && dragAgent?.fromTeamId !== tid;
    const teamGc = tid !== '_ungrouped' ? (groupChatsByTeam.byTeam.get(tid) ?? [])[0] : undefined;
    const isGcActive = teamGc && chatMode === 'channel' && activeChannel === teamGc.channelKey;

    return (
      <div
        key={tid}
        className={`mb-1 rounded-lg transition-colors ${isDropTarget ? 'ring-1 ring-brand-500/50 bg-brand-500/5' : ''}`}
        onPointerEnter={() => { if (isDragging) setDragOverTeam(tid); }}
        onPointerLeave={() => { if (isDragging && dragOverTeam === tid) setDragOverTeam(null); }}
      >
        {/* Team header: click name to enter group chat, separate expand/collapse + menu buttons */}
        <div className="group/teamhdr flex items-center gap-0.5">
          <button
            onClick={() => {
              if (teamGc) onSelectChannel(teamGc.channelKey);
              else toggleTeam(tid);
            }}
            onContextMenu={e => {
              if (!isAdmin || !team) return;
              e.preventDefault();
              setTeamMenu({ teamId: tid, x: e.clientX, y: e.clientY });
            }}
            className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors min-w-0 ${
              isGcActive
                ? 'bg-brand-600/20 text-brand-500'
                : 'text-fg-secondary hover:bg-surface-elevated'
            }`}
          >
            <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
              isGcActive ? 'bg-brand-600 text-white' : 'bg-surface-overlay text-fg-secondary'
            }`}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            </div>
            <div className="flex-1 min-w-0 text-left">
              {editingTeam === tid ? (
                <input
                  className="bg-transparent border-b border-brand-500 text-fg-secondary text-[11px] font-medium outline-none w-full"
                  value={editTeamName}
                  onChange={e => setEditTeamName(e.target.value)}
                  onBlur={() => handleRenameTeam(tid)}
                  onKeyDown={e => { if (e.key === 'Enter') handleRenameTeam(tid); if (e.key === 'Escape') setEditingTeam(null); }}
                  onClick={e => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <span className="truncate font-medium text-[11px] leading-tight block">{label}</span>
              )}
              <div className="text-[10px] text-fg-tertiary leading-tight mt-0.5">{agentList.length} members</div>
            </div>
          </button>

          {/* Expand / collapse toggle */}
          <button
            onClick={() => toggleTeam(tid)}
            className="w-5 h-5 flex items-center justify-center text-fg-tertiary hover:text-fg-secondary rounded transition-colors shrink-0 opacity-60 hover:opacity-100"
            title={isCollapsed ? 'Expand' : 'Collapse'}
          >
            <svg
              className={`w-3 h-3 transition-transform duration-150 ${isCollapsed ? '' : 'rotate-90'}`}
              fill="currentColor" viewBox="0 0 20 20"
            >
              <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
            </svg>
          </button>

          {/* More options menu */}
          {isAdmin && team && (
            <button
              onClick={e => { e.stopPropagation(); setTeamMenu({ teamId: tid, x: e.clientX, y: e.clientY }); }}
              className="w-5 h-5 flex items-center justify-center text-fg-tertiary hover:text-fg-secondary rounded transition-colors shrink-0 opacity-0 group-hover/teamhdr:opacity-100"
              title="More options"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" /></svg>
            </button>
          )}
        </div>

        {isDropTarget && isDragging && (
          <div className="text-[9px] text-brand-500 px-4 py-0.5 animate-pulse">Drop here</div>
        )}
        {!isCollapsed && (
          <div className="ml-1">
            {agentList.map(a => renderAgentItem(a, tid === '_ungrouped' ? undefined : tid))}
          </div>
        )}
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────

  // Group chats by team
  const groupChatsByTeam = useMemo(() => {
    const map = new Map<string, typeof groupChats>();
    const unmatched: typeof groupChats = [];
    for (const gc of groupChats) {
      if (gc.teamId) {
        const list = map.get(gc.teamId) ?? [];
        list.push(gc);
        map.set(gc.teamId, list);
      } else {
        const team = teams.find(t => gc.name.toLowerCase().includes(t.name.toLowerCase()) || t.name.toLowerCase().includes(gc.name.toLowerCase()));
        if (team) {
          const list = map.get(team.id) ?? [];
          list.push(gc);
          map.set(team.id, list);
        } else {
          unmatched.push(gc);
        }
      }
    }
    return { byTeam: map, unmatched };
  }, [groupChats, teams]);

  return (
    <>
      <div className="bg-surface-secondary/60 border-r border-border-default flex flex-col shrink-0" style={{ width: width ?? 224 }}>
        {/* Header with title */}
        <div className="px-4 h-14 flex items-center border-b border-border-default shrink-0">
          <h2 className="text-lg font-semibold">Chat</h2>
        </div>
        {/* Action bar */}
        {isAdmin && (
          <div className="px-3 pt-2 pb-1 flex items-center gap-1.5" ref={actionMenuRef}>
            <div className="relative flex-1">
              <button
                onClick={() => setActionMenu(!actionMenu)}
                className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-medium text-fg-secondary hover:text-fg-primary bg-surface-elevated/60 hover:bg-surface-elevated rounded-lg transition-colors"
              >
                <span className="text-brand-500">+</span> Manage
                <svg className={`w-2.5 h-2.5 ml-auto transition-transform ${actionMenu ? 'rotate-180' : ''}`} fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </button>
              {actionMenu && (
                <div className="absolute left-0 top-full mt-1 w-48 bg-surface-secondary border border-border-default rounded-lg shadow-xl z-30 overflow-hidden">
                  <button onClick={() => { setActionMenu(false); setShowNewTeam(true); }}
                    className="w-full text-left px-4 py-2.5 text-xs text-fg-secondary hover:bg-surface-elevated transition-colors">
                    <div className="font-medium flex items-center gap-1.5">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                      New Team
                    </div>
                    <div className="text-[10px] text-fg-tertiary mt-0.5 pl-[18px]">Create an empty team</div>
                  </button>
                  <button onClick={() => { setActionMenu(false); navBus.navigate('agents'); }}
                    className="w-full text-left px-4 py-2.5 text-xs text-fg-secondary hover:bg-surface-elevated border-t border-border-default transition-colors">
                    <div className="font-medium flex items-center gap-1.5">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
                      Add Agent
                    </div>
                    <div className="text-[10px] text-fg-tertiary mt-0.5 pl-[18px]">Create from templates</div>
                  </button>
                  <button onClick={() => { setActionMenu(false); setShowOpenClaw(true); }}
                    className="w-full text-left px-4 py-2.5 text-xs text-brand-500 hover:bg-surface-elevated border-t border-border-default transition-colors">
                    <div className="font-medium flex items-center gap-1.5">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 0 1 9-9" /></svg>
                      Import OpenClaw
                    </div>
                    <div className="text-[10px] text-fg-tertiary mt-0.5 pl-[18px]">Connect an external agent</div>
                  </button>
                  <button onClick={() => { setActionMenu(false); setShowAddHuman({}); }}
                    className="w-full text-left px-4 py-2.5 text-xs text-green-600 hover:bg-surface-elevated border-t border-border-default transition-colors">
                    <div className="font-medium flex items-center gap-1.5">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" /></svg>
                      Add Human
                    </div>
                    <div className="text-[10px] text-fg-tertiary mt-0.5 pl-[18px]">Add a human team member</div>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Teams + Agents */}
        <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col">
          {agents.length === 0 && teams.length === 0 && (
            <p className="text-xs text-fg-tertiary px-1 mb-2">No agents yet</p>
          )}

          {/* Unmatched group chats (no matching team) */}
          {groupChatsByTeam.unmatched.map(gc => (
            <button
              key={gc.id}
              onClick={() => onSelectChannel(gc.channelKey)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs mb-0.5 transition-colors ${
                chatMode === 'channel' && activeChannel === gc.channelKey
                  ? 'bg-brand-600/20 text-brand-500'
                  : 'text-fg-secondary hover:bg-surface-elevated'
              }`}
            >
              <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                chatMode === 'channel' && activeChannel === gc.channelKey ? 'bg-brand-600 text-white' : 'bg-surface-overlay text-fg-secondary'
              }`}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              </div>
              <div className="flex-1 min-w-0 text-left">
                <span className="truncate font-medium text-[11px] leading-tight block">{gc.name}</span>
                <div className="text-[10px] text-fg-tertiary leading-tight mt-0.5">Group Chat</div>
              </div>
              {gc.memberCount !== undefined && gc.memberCount > 0 && (
                <span className="text-[9px] text-fg-tertiary shrink-0">{gc.memberCount}</span>
              )}
            </button>
          ))}

          {/* Teams with agents */}
          {teams.map(t => {
            const agentList = agentsByTeam.byTeam.get(t.id) ?? [];
            if (agentList.length === 0 && (!t.members || t.members.length === 0)) return null;
            return renderTeamSection(t.id, t, agentList, t.name);
          })}

          {/* Empty teams */}
          {teams.filter(t => {
            const agentList = agentsByTeam.byTeam.get(t.id) ?? [];
            return agentList.length === 0 && t.members && t.members.length > 0;
          }).map(t => renderTeamSection(t.id, t, [], t.name))}

          {/* Ungrouped agents */}
          {agentsByTeam.ungrouped.length > 0 && renderTeamSection('_ungrouped', null, agentsByTeam.ungrouped, 'Other')}

          {/* No teams — flat agent list */}
          {teams.length === 0 && agents.length > 0 && agents.map(a => renderAgentItem(a))}

          {/* People */}
          <div className="mt-3 pt-2 border-t border-border-default/60">
            <p className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2">People</p>

            {authUser && (
              <button
                onClick={() => onSelectDm(authUser.id)}
                className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-xs mb-0.5 transition-colors ${
                  chatMode === 'dm' && (activeDmUserId === authUser.id || !activeDmUserId)
                    ? 'bg-brand-600/20 text-brand-500'
                    : 'text-fg-secondary hover:bg-surface-elevated'
                }`}
              >
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                  chatMode === 'dm' && (activeDmUserId === authUser.id || !activeDmUserId) ? 'bg-brand-600 text-white' : 'bg-brand-500/15 text-brand-500'
                }`}>
                  {authUser.name[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0 text-left">
                  <div className="truncate font-medium text-[11px] leading-tight">{authUser.name}</div>
                  <div className="text-fg-tertiary truncate text-[10px] leading-tight mt-0.5">My Notes</div>
                </div>
                <span className="text-fg-tertiary shrink-0"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg></span>
              </button>
            )}

            {humans.filter(h => h.id !== authUser?.id).map(h => (
              <button
                key={h.id}
                onClick={() => onSelectDm(h.id)}
                className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-xs mb-0.5 transition-colors ${
                  chatMode === 'dm' && activeDmUserId === h.id
                    ? 'bg-green-500/10 text-green-600'
                    : 'text-fg-secondary hover:bg-surface-elevated'
                }`}
              >
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                  chatMode === 'dm' && activeDmUserId === h.id ? 'bg-green-600 text-white' : 'bg-green-500/10 text-green-600'
                }`}>
                  {h.name[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0 text-left">
                  <div className="truncate font-medium text-[11px] leading-tight">{h.name}</div>
                  <div className="text-fg-tertiary truncate text-[10px] leading-tight mt-0.5">{h.email || h.role}</div>
                </div>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Resize handle */}
      {onResizeStart && (
        <div
          className="w-1 cursor-col-resize shrink-0 group relative"
          onMouseDown={onResizeStart}
        >
          <div className="absolute inset-y-0 -left-0.5 -right-0.5 group-hover:bg-brand-500/30 group-active:bg-brand-500/50 transition-colors" />
        </div>
      )}

      {/* ── Context Menu: Team ── */}
      {teamMenu && (() => {
        const teamAgents = agentsByTeam.byTeam.get(teamMenu.teamId) ?? [];
        const hasOffline = teamAgents.some(a => a.status === 'offline');
        const hasRunning = teamAgents.some(a => a.status === 'idle' || a.status === 'working');
        const hasPaused = teamAgents.some(a => a.status === 'paused');
        const hasActive = teamAgents.some(a => a.status !== 'offline');
        return (
          <div
            ref={adjustMenuPosition}
            className="fixed bg-surface-elevated border border-border-default rounded-lg shadow-xl py-1 z-50 w-44"
            style={{ left: teamMenu.x, top: teamMenu.y }}
            onClick={e => e.stopPropagation()}
          >
            <button onClick={() => {
              const t = teamMap.get(teamMenu.teamId);
              if (t) { setEditingTeam(teamMenu.teamId); setEditTeamName(t.name); }
              setTeamMenu(null);
            }} className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-fg-secondary flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
              Rename Team
            </button>
            {hasOffline && (
              <button onClick={() => { handleBatchAction(teamMenu.teamId, 'start'); setTeamMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-green-600 flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                Start All
              </button>
            )}
            {hasActive && (
              <button onClick={() => { handleBatchAction(teamMenu.teamId, 'stop'); setTeamMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-red-500 flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
                Stop All
              </button>
            )}
            {hasRunning && (
              <button onClick={() => { handleBatchAction(teamMenu.teamId, 'pause'); setTeamMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-amber-600 flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                Pause All
              </button>
            )}
            {hasPaused && (
              <button onClick={() => { handleBatchAction(teamMenu.teamId, 'resume'); setTeamMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-blue-600 flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                Resume All
              </button>
            )}
            <div className="border-t border-border-default/50 my-1" />
            <button onClick={() => { setTeamMenu(null); navBus.navigate('agents'); }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-brand-500 flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              Add Agent
            </button>
            <button onClick={() => { setTeamMenu(null); setShowAddHuman({ teamId: teamMenu.teamId }); }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-green-600 flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" /></svg>
              Add Human
            </button>
            {ungrouped.length > 0 && (
              <button onClick={() => { setTeamMenu(null); setShowAddExisting(teamMenu.teamId); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-fg-secondary flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><polyline points="17 11 19 13 23 9" /></svg>
                Add Existing
              </button>
            )}
            <div className="border-t border-border-default/50 my-1" />
            <button onClick={() => {
              const t = teamMap.get(teamMenu.teamId);
              if (t) handleDeleteTeam(teamMenu.teamId, t.name);
              setTeamMenu(null);
            }} className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-red-500 flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
              Delete Team
            </button>
          </div>
        );
      })()}

      {/* ── Context Menu: Agent ── */}
      {agentMenu && (() => {
        const a = agents.find(ag => ag.id === agentMenu.agentId);
        if (!a) return null;
        const team = agentMenu.teamId ? teamMap.get(agentMenu.teamId) : undefined;
        const isManager = team?.managerId === a.id;
        const isSelf = a.id === authUser?.id;
        return (
          <div
            ref={adjustMenuPosition}
            className="fixed bg-surface-elevated border border-border-default rounded-lg shadow-xl py-1 z-50 w-44"
            style={{ left: agentMenu.x, top: agentMenu.y }}
            onClick={e => e.stopPropagation()}
          >
            <button onClick={() => { setAgentMenu(null); onViewProfile(a.id); }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-brand-500 flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
              View Profile
            </button>
            {a.status === 'offline' ? (
              <button onClick={() => { handleStartStop(a.id, 'offline'); setAgentMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-green-600 flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                Start
              </button>
            ) : (
              <button onClick={() => { handleStartStop(a.id, a.status ?? 'idle'); setAgentMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-red-500 flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
                Stop
              </button>
            )}
            {agentMenu.teamId && !isManager && (
              <button onClick={() => { handleSetManager(agentMenu.teamId!, a.id, 'agent'); setAgentMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-amber-600 flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                Set as Manager
              </button>
            )}
            {agentMenu.teamId && (
              <button onClick={() => { handleRemoveFromTeam(agentMenu.teamId!, a.id); setAgentMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-fg-secondary flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></svg>
                Remove from team
              </button>
            )}
            {teams.length > 0 && (
              <>
                <div className="border-t border-border-default/50 my-1" />
                <div className="px-3 py-1 text-[10px] text-fg-tertiary uppercase flex items-center gap-1.5">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></svg>
                  Move to
                </div>
                {teams.filter(t => t.id !== agentMenu.teamId).map(t => (
                  <button key={t.id} onClick={async () => {
                    if (agentMenu.teamId) await api.teams.removeMember(agentMenu.teamId, a.id);
                    await api.teams.addMember(t.id, a.id, 'agent');
                    onRefreshTeams(); onRefreshAgents(); refreshUngrouped();
                    setAgentMenu(null);
                  }} className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-fg-secondary pl-7">
                    {t.name}
                  </button>
                ))}
              </>
            )}
            <div className="border-t border-border-default/50 my-1" />
            {!isSelf && (
              <button onClick={() => { handleRemoveFromOrg(a.id, a.name, 'agent'); setAgentMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-red-500 flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                Remove from org
              </button>
            )}
          </div>
        );
      })()}

      {/* ── Modals ── */}
      {showNewTeam && (
        <NewTeamModal
          onClose={() => setShowNewTeam(false)}
          onCreate={async (name, description) => {
            await api.teams.create(name, description);
            setShowNewTeam(false);
            onRefreshTeams();
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
            onRefreshTeams();
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
            onRefreshTeams();
            refreshUngrouped();
          }}
        />
      )}

      {showOpenClaw && (
        <OpenClawImportModal
          onClose={() => setShowOpenClaw(false)}
          onConnected={() => {
            setShowOpenClaw(false);
            onRefreshAgents();
            onRefreshTeams();
          }}
        />
      )}

      {busyAgent && (
        <BusyAgentModal
          agentName={busyAgent.name}
          taskId={busyAgent.taskId}
          onClose={() => setBusyAgent(null)}
          onGoToTask={() => {
            setBusyAgent(null);
            navBus.navigate('tasks', { openTask: busyAgent.taskId });
          }}
        />
      )}

      {pendingConfirm && (
        <ConfirmModal
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          checkboxes={pendingConfirm.checkboxes}
          onConfirm={(checked) => { pendingConfirm.onConfirm(checked); setPendingConfirm(null); }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}

      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg shadow-xl text-sm font-medium ${
          toast.type === 'error'
            ? 'bg-red-500/10 text-red-500 border border-red-500/30'
            : 'bg-surface-elevated/95 text-fg-primary border border-border-default/50'
        }`}>
          {toast.message}
        </div>
      )}
    </>
  );
}
