import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import type { AgentInfo, TeamInfo, HumanUserInfo, AuthUser } from '../api.ts';
import { Avatar } from './Avatar.tsx';

type ChatMode = 'channel' | 'direct' | 'dm';

interface TeamDetailPanelProps {
  team: TeamInfo;
  agents: AgentInfo[];
  humans: HumanUserInfo[];
  authUser?: AuthUser;
  groupChat?: { id: string; name: string; channelKey: string; memberCount?: number };
  chatMode: ChatMode;
  selectedAgent: string;
  activeChannel: string;
  teams: TeamInfo[];
  onSelectAgent: (agentId: string) => void;
  onSelectChannel: (channelKey: string) => void;
  onSelectDm: (userId: string) => void;
  onBack: () => void;
  onViewProfile: (agentId: string) => void;
  onRefreshAgents: () => void;
  onRefreshTeams: () => void;
  /** Per-agent unread notification count (agentId → count) */
  unreadByAgent?: Map<string, number>;
  width?: number;
  onResizeStart?: (e: React.MouseEvent) => void;
}

export function TeamDetailPanel({
  team, agents, humans, authUser, groupChat,
  chatMode, selectedAgent, activeChannel,
  teams,
  onSelectAgent, onSelectChannel, onSelectDm, onBack, onViewProfile,
  onRefreshAgents, onRefreshTeams,
  unreadByAgent,
  width, onResizeStart,
}: TeamDetailPanelProps) {
  const { t } = useTranslation(['team', 'common']);
  const isAdmin = authUser?.role === 'owner' || authUser?.role === 'admin';

  const teamAgents = useMemo(
    () => agents.filter(a => a.teamId === team.id),
    [agents, team.id],
  );

  const teamHumans = useMemo(() => {
    const humanIds = new Set(
      (team.members ?? []).filter(m => m.type === 'human').map(m => m.id),
    );
    return humans.filter(h => humanIds.has(h.id));
  }, [team.members, humans]);

  const isGcActive = groupChat && chatMode === 'channel' && activeChannel === groupChat.channelKey;

  // ── Agent context menu ──
  const [agentMenu, setAgentMenu] = useState<{ agentId: string; x: number; y: number } | null>(null);

  const clampMenuPos = useCallback((e: React.MouseEvent, menuW = 176, menuH = 480) => {
    const btn = e.currentTarget.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 8;
    let x = btn.left;
    let y = btn.bottom + 4;
    if (x + menuW > vw - pad) x = Math.max(pad, vw - menuW - pad);
    if (y + menuH > vh - pad) y = Math.max(pad, btn.top - menuH - 4);
    return { x, y };
  }, []);

  useEffect(() => {
    if (!agentMenu) return;
    const handler = () => setAgentMenu(null);
    const timer = setTimeout(() => document.addEventListener('click', handler), 0);
    return () => { clearTimeout(timer); document.removeEventListener('click', handler); };
  }, [agentMenu]);

  const handleStartStop = useCallback(async (agentId: string, status: string) => {
    if (status === 'offline') await api.agents.start(agentId);
    else await api.agents.stop(agentId);
    onRefreshAgents();
  }, [onRefreshAgents]);

  const handleSetManager = useCallback(async (memberId: string) => {
    await api.teams.update(team.id, { managerId: memberId, managerType: 'agent' });
    onRefreshTeams();
  }, [team.id, onRefreshTeams]);

  const handleRemoveFromTeam = useCallback(async (memberId: string) => {
    await api.teams.removeMember(team.id, memberId);
    onRefreshTeams();
    onRefreshAgents();
  }, [team.id, onRefreshTeams, onRefreshAgents]);

  const handleMoveToTeam = useCallback(async (agentId: string, targetTeamId: string) => {
    await api.teams.removeMember(team.id, agentId);
    await api.teams.addMember(targetTeamId, agentId, 'agent');
    onRefreshTeams();
    onRefreshAgents();
  }, [team.id, onRefreshTeams, onRefreshAgents]);

  return (
    <>
      <div
        className="bg-surface-elevated rounded-xl my-1 flex flex-col shrink-0"
        style={width != null ? { width } : { width: 260 }}
      >
        {/* Header */}
        <div className="px-3 h-14 flex items-center gap-2 shrink-0">
          <button
            onClick={onBack}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-brand-500/15 text-brand-500 transition-colors shrink-0"
            title={t('common:back', { defaultValue: 'Back' })}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <div className="truncate font-semibold text-sm">{team.name}</div>
            {team.description && (
              <div className="truncate text-[10px] text-fg-tertiary">{team.description}</div>
            )}
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col">
          {/* Team group chat entry */}
          {groupChat && (
            <div className="mb-3">
              <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wider mb-1.5 px-2.5">
                {t('chat.groupChat', { defaultValue: 'Group Chat' })}
              </p>
              <button
                onClick={() => onSelectChannel(groupChat.channelKey)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs transition-colors text-fg-primary ${
                  isGcActive ? 'bg-surface-overlay' : 'hover:bg-surface-overlay/60'
                }`}
              >
                <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-surface-overlay text-fg-primary">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                </div>
                <div className="flex-1 min-w-0 text-left">
                  <span className="truncate font-medium text-[12px] leading-tight block">{team.name}</span>
                  <div className="text-[10px] text-fg-secondary leading-tight mt-0.5">
                    {t('chat.members_other', { count: groupChat.memberCount || (teamAgents.length + teamHumans.length) })}
                  </div>
                </div>
              </button>
            </div>
          )}

          {/* Agent members */}
          {teamAgents.length > 0 && (
            <div className="mb-3">
              <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wider mb-1.5 px-2.5">
                {t('chat.agents', { defaultValue: 'Agents' })}
                <span className="ml-1 text-fg-tertiary font-normal">{teamAgents.length}</span>
              </p>
              {teamAgents.map(a => {
                const isActive = chatMode === 'direct' && selectedAgent === a.id;
                const isManager = team.managerId === a.id;
                const hasRecentError = a.status !== 'error' && !!a.lastError && !!a.lastErrorAt
                  && (Date.now() - new Date(a.lastErrorAt).getTime()) < 30 * 60 * 1000;
                const statusColor = a.status === 'idle' && !hasRecentError ? 'bg-green-500'
                  : a.status === 'working' && !hasRecentError ? 'bg-blue-500 animate-pulse'
                  : a.status === 'error' ? 'bg-red-500'
                  : hasRecentError ? 'bg-amber-500'
                  : a.status === 'paused' ? 'bg-amber-500' : 'bg-gray-600';

                return (
                  <button
                    key={a.id}
                    onClick={() => onSelectAgent(a.id)}
                    onContextMenu={e => {
                      if (!isAdmin) return;
                      e.preventDefault();
                      const pos = clampMenuPos(e);
                      setAgentMenu({ agentId: a.id, ...pos });
                    }}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs mb-0.5 transition-colors text-fg-primary ${
                      isActive ? 'bg-surface-overlay' : 'hover:bg-surface-overlay/60'
                    }`}
                  >
                    <Avatar
                      name={a.name}
                      avatarUrl={a.avatarUrl}
                      size={28}
                      bgClass="bg-surface-overlay text-fg-primary"
                    />
                    <div className="flex-1 min-w-0 text-left">
                      <div className="flex items-center gap-1">
                        <span className="truncate font-medium text-[12px] leading-tight">{a.name}</span>
                        {isManager && <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="text-amber-500 shrink-0"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>}
                      </div>
                      <div className="truncate text-[10px] leading-tight mt-0.5 text-fg-secondary">
                        {a.role || '\u00A0'}
                      </div>
                    </div>
                    {(unreadByAgent?.get(a.id) ?? 0) > 0 && (
                      <span className="min-w-[16px] h-[16px] flex items-center justify-center text-[9px] font-semibold text-white bg-red-500 rounded-full px-1 leading-none shrink-0">{unreadByAgent!.get(a.id)}</span>
                    )}
                    <span
                      title={a.status}
                      onClick={e => { e.stopPropagation(); onViewProfile(a.id); }}
                      className={`w-2 h-2 rounded-full cursor-pointer transition-transform duration-150 hover:scale-[2] shrink-0 ${statusColor}`}
                    />
                  </button>
                );
              })}
            </div>
          )}

          {/* Human members */}
          {teamHumans.length > 0 && (
            <div className="mb-3">
              <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wider mb-1.5 px-2.5">
                {t('chat.people')}
                <span className="ml-1 text-fg-tertiary font-normal">{teamHumans.length}</span>
              </p>
              {teamHumans.map(h => {
                const isSelf = h.id === authUser?.id;
                return (
                  <button
                    key={h.id}
                    onClick={() => onSelectDm(h.id)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs mb-0.5 transition-colors text-fg-primary hover:bg-white/[0.08]`}
                  >
                    <Avatar
                      name={h.name}
                      avatarUrl={h.avatarUrl}
                      size={28}
                      bgClass="bg-green-500/10 text-green-500"
                    />
                    <div className="flex-1 min-w-0 text-left">
                      <div className="truncate font-medium text-[12px] leading-tight">
                        {h.name}{isSelf ? ` (${t('chat.you', { defaultValue: 'You' })})` : ''}
                      </div>
                      <div className="text-fg-secondary truncate text-[10px] leading-tight mt-0.5">{h.email || h.role}</div>
                    </div>
                    <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                  </button>
                );
              })}
            </div>
          )}

          {/* Empty state */}
          {teamAgents.length === 0 && teamHumans.length === 0 && (
            <div className="text-xs text-fg-tertiary text-center py-6 px-2">
              {t('chat.noMembers', { defaultValue: 'No members in this team yet.' })}
            </div>
          )}
        </div>
      </div>

      {/* Resize handle */}
      {onResizeStart && (
        <div
          className="w-1.5 cursor-col-resize shrink-0 group relative flex items-center justify-center"
          onMouseDown={onResizeStart}
        >
          <div className="w-px h-2/3 border-l border-dashed border-transparent group-hover:border-border-default group-active:border-fg-tertiary transition-colors" />
        </div>
      )}

      {/* Agent context menu */}
      {agentMenu && (() => {
        const a = teamAgents.find(ag => ag.id === agentMenu.agentId);
        if (!a || !isAdmin) return null;
        const isManager = team.managerId === a.id;
        return (
          <div
            className="fixed bg-surface-elevated border border-border-default rounded-lg shadow-xl py-1 z-50 w-44 max-w-[calc(100vw-1rem)] max-h-[calc(100vh-1rem)] overflow-y-auto"
            style={{ left: agentMenu.x, top: agentMenu.y }}
            onClick={e => e.stopPropagation()}
          >
            <button onClick={() => { setAgentMenu(null); onViewProfile(a.id); }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-brand-500 flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
              {t('contextMenu.viewProfile')}
            </button>
            {a.status === 'offline' ? (
              <button onClick={() => { handleStartStop(a.id, 'offline'); setAgentMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-green-600 flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                {t('contextMenu.start')}
              </button>
            ) : (
              <button onClick={() => { handleStartStop(a.id, a.status ?? 'idle'); setAgentMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-red-500 flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
                {t('contextMenu.stop')}
              </button>
            )}
            {!isManager && (
              <button onClick={() => { handleSetManager(a.id); setAgentMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-amber-600 flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                {t('contextMenu.setAsManager')}
              </button>
            )}
            <button onClick={() => { handleRemoveFromTeam(a.id); setAgentMenu(null); }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-fg-secondary flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></svg>
              {t('contextMenu.removeFromTeam')}
            </button>
            {teams.filter(tm => tm.id !== team.id).length > 0 && (
              <>
                <div className="border-t border-border-default/50 my-1" />
                <div className="px-3 py-1 text-[10px] text-fg-tertiary uppercase flex items-center gap-1.5">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></svg>
                  {t('contextMenu.moveTo')}
                </div>
                {teams.filter(tm => tm.id !== team.id).map(tm => (
                  <button key={tm.id} onClick={() => { handleMoveToTeam(a.id, tm.id); setAgentMenu(null); }}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-fg-secondary flex items-center gap-2">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                    {tm.name}
                  </button>
                ))}
              </>
            )}
            <div className="border-t border-border-default/50 my-1" />
            <button onClick={async () => { await api.agents.remove(a.id); onRefreshAgents(); setAgentMenu(null); }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-surface-overlay text-red-500 flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
              {t('contextMenu.removeFromOrg')}
            </button>
          </div>
        );
      })()}
    </>
  );
}
