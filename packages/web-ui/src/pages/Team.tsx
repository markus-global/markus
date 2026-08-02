import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  api, wsClient, invalidateApiCache,
  type AgentInfo, type AgentToolEvent, type StreamCommitEvent, type HumanUserInfo, type ExternalAgentInfo,
  type ChatMessageInfo, type ChatSessionInfo, type ChannelMessageInfo, type ChannelMsgMetadata,
  type TaskInfo, type TeamInfo, type AuthUser, type ApprovalInfo, type UserInputAnswer,
  type NotificationInfo, type SubagentProgressEvent,
} from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import { UserInputModal } from '../components/UserInputModal.tsx';
import { NotifyUserModal } from '../components/NotifyUserModal.tsx';
import { ActivityIndicator, type ActivityStep } from '../components/ActivityIndicator.tsx';
import {
  ToolCallRow, ExecEntryRow, ThinkingDots,
  filterCompletedStarts, attachSubagentLogsToEntries,
  type ExecEntry, type ExecutionStreamEntryUI,
} from '../components/ExecutionTimeline.tsx';
import { isVirtualScrollAdjustSuppressed } from '../components/execution-utils.ts';
import { navBus } from '../navBus.ts';
import { PAGE, resolvePageId, hashPath } from '../routes.ts';
import { parseMentionNames, renderMentionText } from '../components/CommentInput.tsx';
import { ChatTeamSidebar } from '../components/ChatTeamSidebar.tsx';
import { TeamDetailPanel } from '../components/TeamDetailPanel.tsx';
import { RightPanel } from '../components/RightPanel.tsx';
import { useLayout } from '../contexts/LayoutContext.tsx';
import { AgentProfile, TAB_DEF as AGENT_TAB_DEF, type ProfileTab } from './AgentProfile.tsx';
import { TeamProfile, TABS as TEAM_TABS, type TeamTab } from './TeamProfile.tsx';
import { useResizablePanel } from '../hooks/useResizablePanel.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { useUnreadCounts, useAgentUnread } from '../hooks/useUnreadCounts.ts';
import { usePageActive } from '../hooks/usePageActive.ts';
import { useConversationBuffers, makeConvKey, NEW_CHAT_PLACEHOLDER_ID } from '../hooks/useConversationBuffers.ts';
import { Avatar } from '../components/Avatar.tsx';
import { ChatModelMenu, applyChatModelSelection, type ChatModelSelection } from '../components/ChatModelMenu.tsx';
import { ConfirmModal } from '../components/ConfirmModal.tsx';
import {
  type MsgSegment, type ChatMsg, type ChatMode,
  dbMsgToChat, channelMsgToChat, stripNotifyContext, insertChatMsgByCreatedAt,
  storedSegmentsToMsgSegments, dedupeAdjacentUserMessages,
  appendLiveOutput, appendSubagentLog,
  formatSmartTime, getDateKey, formatDateLabel, throttle,
} from './ChatHelpers.ts';
import {
  NotificationBadge, ChatAgentLink, AvatarPopover, MessageActions, RememberModal,
  AgentMessageBody, segmentsToStreamEntries, friendlyAgentError, isMarkusCreditError, dispatchCreditNotification,
} from './ChatComponents.tsx';
export type { MsgSegment };

/** L1/L2 team-chat sidebar collapse preference. Only written on manual toggle. */
const TEAM_SIDEBARS_COLLAPSED_KEY = 'markus_team_sidebars_c';

/** Session id carried by a notify_user → agent_report notification. */
function notifySessionId(n: NotificationInfo): string | undefined {
  const meta = n.metadata ?? {};
  if (typeof meta.sessionId === 'string' && meta.sessionId) return meta.sessionId;
  if (n.actionType === 'open_chat' && n.actionTarget) {
    try {
      const target = typeof n.actionTarget === 'string' ? JSON.parse(n.actionTarget) : n.actionTarget;
      if (target && typeof target === 'object' && typeof (target as { sessionId?: unknown }).sessionId === 'string') {
        return (target as { sessionId: string }).sessionId;
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

function agentInitials(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

// ─── Main Component ───────────────────────────────────────────────────────────

type MainTab = 'chat' | 'profile'
  | 'overview' | 'mind' | 'files' | 'tools' | 'memory' | 'deliverables'
  | 'announcements' | 'norms' | 'settings';

const AGENT_TABS: MainTab[] = ['chat', 'overview', 'files', 'tools', 'memory', 'deliverables'];
const TEAM_TAB_SET: MainTab[] = ['chat', 'overview', 'announcements', 'norms', 'settings'];

function tabLabel(tab: MainTab, t: TFunction): string {
  if (tab === 'chat') return t('page.chatTitle');
  const agentDef = AGENT_TAB_DEF.find(d => d.key === tab);
  if (agentDef) return t(`agent:tabs.${tab}`);
  const teamDef = TEAM_TABS.find(d => d.key === tab);
  if (teamDef) return t(teamDef.labelKey);
  return tab;
}

function tabIcon(tab: MainTab): string {
  if (tab === 'chat') return '💬';
  const agentDef = AGENT_TAB_DEF.find(d => d.key === tab);
  if (agentDef) return agentDef.icon;
  const teamDef = TEAM_TABS.find(d => d.key === tab);
  if (teamDef) return teamDef.icon;
  return '';
}

function isProfileTab(tab: MainTab): boolean {
  return tab !== 'chat';
}

// ── Hash-based store: the URL is the single source of truth for mobile nav ────
const _hashSubs = new Set<() => void>();
function _getHash() { return window.location.hash; }
function _subHash(cb: () => void) { _hashSubs.add(cb); return () => { _hashSubs.delete(cb); }; }
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => _hashSubs.forEach(fn => fn()));
}

export interface TeamPreviewData {
  agents?: AgentInfo[];
  humans?: HumanUserInfo[];
  teams?: TeamInfo[];
  groupChats?: Array<{ id: string; name: string; type: string; channelKey: string; memberCount?: number; teamId?: string; creatorId?: string; creatorName?: string; members?: Array<{ id: string; name: string; type: 'human' | 'agent' }> }>;
  channelMessages?: ChannelMessageInfo[];
  chatMode?: 'channel' | 'direct' | 'dm';
  activeChannel?: string;
  streamLastMessage?: boolean;
}

export function TeamPage({ initialAgentId, authUser, previewMode, previewData }: { initialAgentId?: string; authUser?: AuthUser; previewMode?: boolean; previewData?: TeamPreviewData } = {}) {
  const { t, i18n } = useTranslation(['team', 'common']);
  const dateLabels = useMemo(() => ({ today: t('page.dateToday'), yesterday: t('page.dateYesterday') }), [t]);
  const isActive = usePageActive(PAGE.TEAM);
  const [agents, setAgents] = useState<AgentInfo[]>(previewData?.agents ?? []);
  const [humans, setHumans] = useState<HumanUserInfo[]>(previewData?.humans ?? []);
  const [initialLoading, setInitialLoading] = useState(previewData ? false : true);
  const isMobile = useIsMobile();

  // Mobile: URL hash is the single source of truth for 3-layer navigation
  // L1 (roster): #team — sidebar list
  // L2 (team detail): #team/t/<teamId> — team agent list + channel
  // L3 (chat): #team/d — agent/channel chat
  const hash = useSyncExternalStore(_subHash, _getHash);
  const mobileShowChat = isMobile && (hash.startsWith(`#${PAGE.TEAM}/`) || hash.startsWith('#chat/'));
  const mobileTeamHash = isMobile && hash.match(/^#team\/t\/(.+)$/);
  const mobileLayer: 'roster' | 'team' | 'chat' = !isMobile ? 'roster'
    : mobileTeamHash ? 'team'
    : mobileShowChat ? 'chat'
    : 'roster';
  const mobileTeamId = mobileTeamHash ? mobileTeamHash[1] : null;

  const mobileBackHashRef = useRef<string>(PAGE.TEAM);
  const enterMobileDetail = useCallback(() => {
    mobileBackHashRef.current = window.location.hash.slice(1) || PAGE.TEAM;
    window.location.hash = `${PAGE.TEAM}/d`;
  }, []);

  const enterMobileTeam = useCallback((teamId: string) => {
    window.location.hash = `${PAGE.TEAM}/t/${teamId}`;
  }, []);

  // Profile tab: still uses pushState for back navigation
  useEffect(() => {
    if (!isMobile) return;
    const onPop = () => {
      if (isProfileTab(mainTabRef.current)) setMainTab('chat');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [isMobile]);

  // Tab system: Chat vs Agent Profile
  const [mainTab, setMainTab] = useState<MainTab>('chat');
  const mainTabRef = useRef<MainTab>('chat');
  mainTabRef.current = mainTab;

  // Resizable chat left sidebar
  const chatSidebar = useResizablePanel({
    side: 'left',
    defaultWidth: 280,
    minWidth: 220,
    maxWidth: 400,
    storageKey: 'markus_chat_sidebar',
  });

  // Sidebars collapsed: user can collapse both L1 and L2 together.
  // Persist only explicit user toggles (collapse/expand buttons). Default open.
  // Transient collapses (Cmd+B, right-panel open) must not write this key.
  const [sidebarsCollapsed, setSidebarsCollapsed] = useState(() => {
    try { return localStorage.getItem(TEAM_SIDEBARS_COLLAPSED_KEY) === '1'; }
    catch { return false; }
  });
  const setSidebarsCollapsedPersisted = useCallback((collapsed: boolean) => {
    setSidebarsCollapsed(collapsed);
    try { localStorage.setItem(TEAM_SIDEBARS_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, []);

  // Unified layout coordination (Cmd+B collapse, Cmd+L right panel, host registration)
  const layout = useLayout();
  const layoutLeftCollapsed = layout?.leftCollapsed ?? false;
  const rightPanelPayload = layout?.rightPanel ?? null;
  const rightPanelTabs = layout?.rightPanelTabs ?? [];
  const activeRightPanelTabId = layout?.activeRightPanelTabId ?? null;
  const rightPanelFullscreen = layout?.rightPanelFullscreen ?? false;
  // Wide right reserve keeps chat comfortably narrow on ultrawide screens, but
  // shrinks once the right panel is open (the panel already fills that space).
  const chatRightReserve = rightPanelPayload ? '2xl:pr-8' : '2xl:pr-[280px]';
  const setHostAvailable = layout?.setHostAvailable;
  // Header × collapses the panel (keeps tabs); tab × closes one tab.
  const collapseRightPanel = layout?.collapseRightPanelOnly ?? layout?.toggleRightPanel;
  const openRightPanel = layout?.openRightPanel;

  // Right-side resource panel (preview / selection-to-agent).
  // The rendered width is derived reactively from the space actually available in
  // the team container (see effectiveRightPanelWidth further below), so the panel
  // never gets pushed off-screen / truncated — even when the user manually
  // re-expands the L1/L2 sidebars while the panel is open. `panelWidthPref` is
  // 'auto' for the even 50/50 split, or a user-chosen pixel width after dragging.
  const CHAT_MIN_W = 400;
  const PANEL_MIN_W = 320;
  const RESIZE_HANDLE_W = 6;
  // Live width of the team container (already excludes the global L0 rail).
  const [containerWidth, setContainerWidth] = useState<number>(
    typeof window !== 'undefined' ? window.innerWidth : 1440,
  );
  const [panelWidthPref, setPanelWidthPref] = useState<number | 'auto'>('auto');

  // Drive L1+L2 collapse from the unified command (Cmd+B). React only to *changes*
  // after mount — never apply the initial L0-persisted leftCollapsed value, so a
  // hard refresh keeps L1 at its own default/persisted preference (open by default).
  const prevLayoutLeftCollapsed = useRef(layoutLeftCollapsed);
  useEffect(() => {
    if (prevLayoutLeftCollapsed.current === layoutLeftCollapsed) return;
    prevLayoutLeftCollapsed.current = layoutLeftCollapsed;
    setSidebarsCollapsed(layoutLeftCollapsed);
  }, [layoutLeftCollapsed]);

  // Register this page as a right-panel host while it is the active desktop page.
  useEffect(() => {
    if (!setHostAvailable) return;
    setHostAvailable(isActive && !isMobile);
    return () => setHostAvailable(false);
  }, [isActive, isMobile, setHostAvailable]);

  // Agent tools open_right_panel / collapse_right_panel (Team Chat only).
  useEffect(() => {
    if (previewMode || isMobile || !isActive) return;
    const unsub = wsClient.on('ui:right_panel', (event) => {
      const p = event.payload as {
        agentId?: string;
        action?: 'open' | 'collapse';
        panel?: {
          kind?: 'url' | 'file' | 'deliverable';
          url?: string;
          path?: string;
          title?: string;
          deliverableId?: string;
        };
      };
      if (p.action === 'collapse') {
        collapseRightPanel?.();
        return;
      }
      if (p.action !== 'open' || !p.panel || !openRightPanel) return;
      const panel = p.panel;
      if (panel.kind === 'url' && panel.url) {
        const browserId = `eb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        openRightPanel({
          kind: 'url',
          url: panel.url,
          title: panel.title || panel.url,
          browserId,
        });
        return;
      }
      if (panel.kind === 'file' && panel.path) {
        openRightPanel({ kind: 'file', path: panel.path, title: panel.title });
        return;
      }
      if (panel.kind === 'deliverable' && panel.deliverableId) {
        void api.deliverables.get(panel.deliverableId).then(res => {
          if (res.deliverable) {
            openRightPanel({ kind: 'deliverable', deliverable: res.deliverable });
          }
        }).catch(() => { /* ignore missing deliverable */ });
      }
    });
    return unsub;
  }, [previewMode, isMobile, isActive, collapseRightPanel, openRightPanel]);

  // Add a right-panel selection into the chat as pending context, then focus input.
  const addChatContext = useCallback((chip: { label: string; content: string }) => {
    const id = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setChatContext(prev => [...prev, { id, ...chip }]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // L2: Team detail panel (hidden by default, toggled via header button)
  const [showTeamDetailPanel, setShowTeamDetailPanel] = useState<boolean>(() => {
    if (previewMode) return true;
    try { return localStorage.getItem('markus_team_panel_visible') === 'true'; } catch { return false; }
  });
  const teamDetailPanel = useResizablePanel({
    side: 'left',
    defaultWidth: 260,
    minWidth: 200,
    maxWidth: 400,
    storageKey: 'markus_team_detail_panel',
  });

  // Track whether there's enough space for inline L2 (chat area >= 400px)
  const teamContainerRef = useRef<HTMLDivElement>(null);
  const [l2SpaceTight, setL2SpaceTight] = useState(false);
  const [l2Floating, setL2Floating] = useState(false);

  const toggleTeamDetailPanel = useCallback(() => {
    if (l2SpaceTight) {
      setL2Floating(prev => !prev);
    } else {
      setShowTeamDetailPanel(prev => {
        const next = !prev;
        try { localStorage.setItem('markus_team_panel_visible', String(next)); } catch { /* */ }
        return next;
      });
    }
  }, [l2SpaceTight]);

  useEffect(() => {
    if (isMobile) return;
    const el = teamContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const containerW = entry.contentRect.width;
      setContainerWidth(containerW);
      if (!previewMode) {
        const chatAreaIfL2 = containerW - chatSidebar.width - teamDetailPanel.width;
        setL2SpaceTight(chatAreaIfL2 < 400);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobile, previewMode, chatSidebar.width, teamDetailPanel.width]);

  // Space consumed by the L1/L2 sidebars that share the flex row with the chat
  // column + right panel. A collapsed L1 is fully hidden (0px) and a floating L2
  // is overlaid (0px in flow), so neither eats into the available width. The
  // extra buffer covers the sidebars' own resize-handle children (~6px each).
  const l2InlineOpen = showTeamDetailPanel && !l2SpaceTight && !l2Floating;
  const leftRailWidth = sidebarsCollapsed
    ? 0
    : chatSidebar.width + RESIZE_HANDLE_W + (l2InlineOpen ? teamDetailPanel.width + RESIZE_HANDLE_W : 0);
  // Width shared by the chat column and the right panel (everything except the
  // left rails). A small buffer keeps us on the safe side of rounding so the
  // flex row never overflows.
  const spaceForChatPanel = Math.max(0, containerWidth - leftRailWidth - RESIZE_HANDLE_W - 8);
  // Reserve for the chat column scales down when space is tight, so BOTH the chat
  // and the panel stay fully visible (never truncated) no matter how many
  // sidebars the user opens or which agent is active. The panel is then capped to
  // whatever remains — this is the invariant that prevents any overflow.
  const chatReserve = Math.min(CHAT_MIN_W, Math.floor(spaceForChatPanel * 0.4));
  const maxRightPanelWidth = Math.max(0, spaceForChatPanel - chatReserve);
  // Even 50/50 split of the shared space (chat column vs. panel).
  const evenSplitWidth = Math.min(Math.round(spaceForChatPanel / 2), maxRightPanelWidth);
  // Reactive: 'auto' keeps the even split as the layout settles/changes; a user
  // drag pins a pixel width. Either way it is clamped so the panel always fits.
  const desiredRightPanelWidth = panelWidthPref === 'auto' ? evenSplitWidth : panelWidthPref;
  const effectiveRightPanelWidth = Math.max(0, Math.min(desiredRightPanelWidth, maxRightPanelWidth));

  // On each fresh open of the right panel: collapse the L1/L2 sidebars to make
  // room, and re-center to an even 50/50 split. This fires directly on the
  // open transition (rather than relying on the shared leftCollapsed flag
  // changing), so it works even when that flag was already set. The user can
  // still manually re-expand the sidebars afterwards — the width stays clamped.
  const rightPanelWasOpen = useRef(false);
  useEffect(() => {
    const open = (layout?.rightPanel ?? null) !== null;
    if (open && !rightPanelWasOpen.current) {
      setSidebarsCollapsed(true);
      setPanelWidthPref('auto');
    }
    rightPanelWasOpen.current = open;
  }, [layout?.rightPanel]);

  // Custom resize handle for the right panel: seeds the drag from the currently
  // rendered width (so there's no jump), then pins a user-chosen pixel width.
  const effectiveRightPanelWidthRef = useRef(effectiveRightPanelWidth);
  effectiveRightPanelWidthRef.current = effectiveRightPanelWidth;
  const maxRightPanelWidthRef = useRef(maxRightPanelWidth);
  maxRightPanelWidthRef.current = maxRightPanelWidth;
  const onRightPanelResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = effectiveRightPanelWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      const next = startW + (startX - ev.clientX); // drag left → wider panel
      const max = maxRightPanelWidthRef.current;
      const min = Math.min(PANEL_MIN_W, max); // never below the soft min unless space is tighter
      setPanelWidthPref(Math.max(min, Math.min(max, next)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    if (!l2Floating) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-l2-floating]')) return;
      setL2Floating(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [l2Floating]);

  // Avatar popover in chat messages
  const [avatarPopover, setAvatarPopover] = useState<{ agentId: string; top: number; left: number } | null>(null);

  const [profileDefaultTab, setProfileDefaultTab] = useState<'overview' | undefined>();
  const [profileHighlightMailboxId, setProfileHighlightMailboxId] = useState<string | undefined>();

  // Inline editing for header name/description
  const [editingHeaderName, setEditingHeaderName] = useState(false);
  const [headerNameDraft, setHeaderNameDraft] = useState('');
  const [editingHeaderDesc, setEditingHeaderDesc] = useState(false);
  const [headerDescDraft, setHeaderDescDraft] = useState('');
  const headerNameRef = useRef<HTMLInputElement>(null);
  const headerDescRef = useRef<HTMLInputElement>(null);

  const switchToProfile = useCallback((defaultTab?: 'overview', highlightMailboxId?: string) => {
    setProfileDefaultTab(defaultTab);
    setProfileHighlightMailboxId(highlightMailboxId);
    if (isMobile) {
      setMainTab('profile');
      history.pushState({ mobileProfile: true }, '', window.location.hash);
    } else {
      setMainTab(defaultTab ?? 'overview');
    }
  }, [isMobile]);

  const mainTabsList = [{ id: 'chat' as const }, { id: 'profile' as const }];
  const handleMainTabSwipe = useCallback((tab: MainTab) => {
    if (tab === 'profile') switchToProfile();
    else { if (isProfileTab(mainTabRef.current)) history.back(); else setMainTab('chat'); }
  }, [switchToProfile]);
  const mainTabSwipe = useSwipeTabs(mainTabsList, mainTab, handleMainTabSwipe);

  const handleViewProfile = useCallback((agentId: string, opts?: { tab?: 'overview'; highlightMailboxId?: string }) => {
    setChatMode('direct');
    setSelectedAgent(agentId);
    if (isMobile) enterMobileDetail();
    switchToProfile(opts?.tab, opts?.highlightMailboxId);
    setAvatarPopover(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, enterMobileDetail, switchToProfile]);

  const handleMentionClick = useCallback((name: string, event: ReactMouseEvent) => {
    const agent = agents.find(a => a.name.toLowerCase() === name.toLowerCase());
    if (agent) {
      const rect = (event.target as HTMLElement).getBoundingClientRect();
      setAvatarPopover({ agentId: agent.id, top: rect.bottom, left: rect.left });
    }
  }, [agents]);

  const agentNames = useMemo(() => agents.map(a => a.name), [agents]);

  // Mode & target
  const [chatMode, setChatMode] = useState<ChatMode>(
    () => previewData?.chatMode ?? (initialAgentId ? 'direct' : ((localStorage.getItem('markus_chat_mode') as ChatMode | null) ?? 'direct'))
  );
  const [selectedAgent, setSelectedAgent] = useState(
    () => initialAgentId ?? localStorage.getItem('markus_chat_agent') ?? ''
  );
  const [activeChannel, setActiveChannel] = useState(
    () => previewData?.activeChannel ?? localStorage.getItem('markus_chat_channel') ?? '#general'
  );
  const [activeDmUserId, setActiveDmUserId] = useState<string>('');

  // ── Deduplication: track server message IDs we already inserted via HTTP ─────
  const MAX_RECENT_MSG_IDS = 500;
  const recentMsgIds = useRef<Set<string>>(new Set());
  const addRecentMsgId = (id: string) => {
    recentMsgIds.current.add(id);
    if (recentMsgIds.current.size > MAX_RECENT_MSG_IDS) {
      // Evict oldest 20% to avoid thrashing one-at-a-time
      const evictCount = Math.floor(MAX_RECENT_MSG_IDS * 0.2);
      const iter = recentMsgIds.current.values();
      for (let i = 0; i < evictCount; i++) {
        const v = iter.next().value;
        if (v) recentMsgIds.current.delete(v);
      }
    }
  };

  // ── Per-conversation buffers (managed by ConversationBufferManager) ──────────
  const bufferInitialMsgs = useMemo(() => {
    if (previewData?.channelMessages) {
      const ch = previewData.activeChannel ?? 'custom:general';
      return previewData.channelMessages.filter(m => m.channel === ch).map(m => channelMsgToChat(m));
    }
    return undefined;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const {
    manager: bufMgr,
    messages, setMessages,
    sending, setSending,
    activities, setActivities,
    msgBuffers, sessionMsgCache, activeSessionBuffer, actBuffers, sessionTabsBuffer,
    currentConvKeyRef,
    updateConvMsgs, updateConvMsgsRaf, appendConvActivity,
    beginLoad, beginStream, endStream, resetConv,
    loadAndDisplay,
    incrementSending, decrementSending, resetSending, isSendingFor,
    setStreamSession, clearStreamSession, getStreamSession,
    saveSessionToCache, restoreSessionFromCache,
  } = useConversationBuffers(bufferInitialMsgs);

  const [input, setInput] = useState('');
  const [chatReplyTo, setChatReplyTo] = useState<{ id: string; sender: string; text: string } | null>(null);
  // Selections sent from the right-side resource panel, prepended to the next message.
  const [chatContext, setChatContext] = useState<Array<{ id: string; label: string; content: string }>>([]);
  const [thinkingAgents, setThinkingAgents] = useState<Array<{ id: string; name: string; avatarUrl?: string }>>([]);
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [streamingVisual, setStreamingVisual] = useState(!!previewData?.streamLastMessage);
  const streamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const STREAMING_MIN_DISPLAY_MS = 400;
  useEffect(() => {
    if (sending) {
      if (streamingTimerRef.current) { clearTimeout(streamingTimerRef.current); streamingTimerRef.current = null; }
      setStreamingVisual(true);
    } else if (streamingVisual) {
      streamingTimerRef.current = setTimeout(() => { setStreamingVisual(false); streamingTimerRef.current = null; }, STREAMING_MIN_DISPLAY_MS);
    }
    return () => { if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current); };
  }, [sending]); // eslint-disable-line react-hooks/exhaustive-deps

  // Badge must follow local SSE/sending state — agent.status can return to idle
  // while the UI is still flushing thinking/text deltas. Only scan the tail:
  // streaming bubbles are always near the end of the conversation.
  const chatStreamActive = sending || streamingVisual || (() => {
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - 8); i--) {
      const m = messages[i]!;
      if (m.isStreaming && !m.isStopped) return true;
    }
    return false;
  })();

  // Preview mode: typewriter streaming effect for the last agent message
  const previewStreamRef = useRef<{ fullText: string; timers: ReturnType<typeof setTimeout>[] }>({ fullText: '', timers: [] });
  useEffect(() => {
    if (!previewMode || !previewData?.streamLastMessage) return;
    if (messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.sender !== 'agent') return;

    const fullText = lastMsg.text;
    previewStreamRef.current.fullText = fullText;
    const timers = previewStreamRef.current.timers;

    function startTypewriter() {
      let charIdx = 0;
      setMessages(prev => prev.map((m, i) => i === prev.length - 1 ? { ...m, text: '' } : m));
      setStreamingVisual(true);
      const interval = setInterval(() => {
        charIdx += 1 + Math.floor(Math.random() * 2);
        if (charIdx >= fullText.length) {
          clearInterval(interval);
          setMessages(prev => prev.map((m, i) => i === prev.length - 1 ? { ...m, text: fullText } : m));
          const t = setTimeout(() => setStreamingVisual(false), 800);
          timers.push(t);
          const restart = setTimeout(startTypewriter, 6000);
          timers.push(restart);
        } else {
          setMessages(prev => prev.map((m, i) => i === prev.length - 1 ? { ...m, text: fullText.slice(0, charIdx) } : m));
        }
      }, 30);
      timers.push(interval as any);
    }

    const delay = setTimeout(startTypewriter, 1500);
    timers.push(delay);

    return () => { timers.forEach(t => clearTimeout(t)); previewStreamRef.current.timers = []; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Track last SSE event time — used only for diagnostics / fallback polling,
  // NOT for auto-aborting the stream.  The SSE connection is kept alive by
  // server-side heartbeats; the browser / fetch API handles detecting a truly
  // dead TCP connection.  Any timer-based abort is inherently fragile because
  // tool executions can legitimately run for minutes or longer.
  const lastSseEventTimeRef = useRef<number>(0);

  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  // Image attachments
  const [pendingImages, setPendingImages] = useState<Array<{ id: string; dataUrl: string; name: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Session-scoped model pick from the composer menu (null = use global routing). */
  const [sessionModelOverride, setSessionModelOverride] = useState<ChatModelSelection | null>(null);
  const reattachAbortRef = useRef<AbortController | null>(null);

  /** Compact (1-line) composer vs taller empty-chat starter. Synced before render. */
  const compactComposerRef = useRef(false);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const compact = compactComposerRef.current;
    const minH = compact ? 36 : 52;
    const maxH = compact ? 160 : 120;
    el.style.height = 'auto';
    const h = Math.max(minH, Math.min(el.scrollHeight, maxH));
    el.style.height = `${h}px`;
    el.style.overflowY = h >= maxH ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    // Layout may switch between single-row and two-row when content appears; remeasure after paint.
    const id = requestAnimationFrame(() => adjustTextareaHeight());
    return () => cancelAnimationFrame(id);
  }, [input, pendingImages.length, adjustTextareaHeight]);

  // Session management (direct mode)
  // Persist closed session tabs in localStorage so they don't reappear on refresh
  const getClosedTabs = (agentId: string): Set<string> => {
    try {
      const raw = localStorage.getItem(`markus_closed_tabs_${agentId}`);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch { return new Set(); }
  };
  const addClosedTab = (agentId: string, sessionId: string) => {
    const closed = getClosedTabs(agentId);
    closed.add(sessionId);
    try { localStorage.setItem(`markus_closed_tabs_${agentId}`, JSON.stringify([...closed])); } catch { /* ignore */ }
  };
  const removeClosedTab = (agentId: string, sessionId: string) => {
    const closed = getClosedTabs(agentId);
    if (closed.delete(sessionId)) {
      try { localStorage.setItem(`markus_closed_tabs_${agentId}`, JSON.stringify([...closed])); } catch { /* ignore */ }
    }
  };
  // Persist the active session per agent so a page refresh restores the same
  // session the user was on (instead of always snapping back to the main session).
  const getStoredActiveSession = (agentId: string): string | null => {
    try { return localStorage.getItem(`markus_active_session_${agentId}`); } catch { return null; }
  };
  const setStoredActiveSession = (agentId: string, sessionId: string | null) => {
    if (!agentId) return;
    try {
      if (sessionId && sessionId !== NEW_CHAT_PLACEHOLDER_ID) {
        localStorage.setItem(`markus_active_session_${agentId}`, sessionId);
      } else {
        localStorage.removeItem(`markus_active_session_${agentId}`);
      }
    } catch { /* ignore */ }
  };

  const [sessions, setSessions] = useState<ChatSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  // Pending request_user_input requests raised by the agent during a direct chat.
  const [userInputApprovals, setUserInputApprovals] = useState<ApprovalInfo[]>([]);
  const [activeInputModal, setActiveInputModal] = useState<ApprovalInfo | null>(null);
  const [respondingInputId, setRespondingInputId] = useState<string | null>(null);
  // Unread notify_user (agent_report) cards for the active direct-chat session.
  const [sessionNotifyCards, setSessionNotifyCards] = useState<NotificationInfo[]>([]);
  const [activeNotifyModal, setActiveNotifyModal] = useState<NotificationInfo | null>(null);
  const [acknowledgingNotifyId, setAcknowledgingNotifyId] = useState<string | null>(null);
  // Message ids currently represented by a bottom notify card — hide the duplicate bubble.
  const [hiddenNotifyMsgIds, setHiddenNotifyMsgIds] = useState<string[]>([]);
  const [openSessionTabs, _setOpenSessionTabs] = useState<ChatSessionInfo[]>([]);
  // Wrapper that deduplicates tabs by ID to prevent duplicate "main session" entries
  const setOpenSessionTabs: typeof _setOpenSessionTabs = (action) => {
    _setOpenSessionTabs(prev => {
      const next = typeof action === 'function' ? action(prev) : action;
      const seen = new Set<string>();
      return next.filter(t => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
    });
  };
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const oldestMsgId = useRef<string | null>(null);

  // Group chats
  const [groupChats, setGroupChats] = useState<Array<{ id: string; name: string; type: string; channelKey: string; memberCount?: number; teamId?: string; creatorId?: string; creatorName?: string; members?: Array<{ id: string; name: string; type: 'human' | 'agent' }> }>>(previewData?.groupChats ?? []);
  const groupChatsRef = useRef(groupChats);
  groupChatsRef.current = groupChats;
  const pendingSelectTeamRef = useRef<string | null>(null);
  const [showMemberPanel, setShowMemberPanel] = useState(false);

  // Message search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<import('../api.ts').SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Teams
  const [teams, setTeams] = useState<TeamInfo[]>(previewData?.teams ?? []);

  // External agents (OpenClaw etc.)
  const [externalAgents, setExternalAgents] = useState<ExternalAgentInfo[]>([]);

  // Task context
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [linkedTaskId, setLinkedTaskId] = useState<string | null>(null);
  const [showTaskPicker, setShowTaskPicker] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');

  // Channel @mention
  const [mentionDropdown, setMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);

  type EntityMentionItem = { id: string; name: string; entityType: 'workflow' | 'project' | 'requirement' | 'task' | 'deliverable'; role?: string };
  const [entityMentionItems, setEntityMentionItems] = useState<EntityMentionItem[]>([]);
  const entityMentionLoadedRef = useRef(false);
  const loadEntityMentions = useCallback(() => {
    if (entityMentionLoadedRef.current) return;
    entityMentionLoadedRef.current = true;
    (async () => {
      const items: EntityMentionItem[] = [];
      try {
        const [projRes, reqRes, taskRes, delRes, teamsRes] = await Promise.all([
          api.projects.list().catch(() => ({ projects: [] as Array<{ id: string; name: string; status: string }> })),
          api.requirements.list().catch(() => ({ requirements: [] as Array<{ id: string; title: string; priority: string }> })),
          api.tasks.list({ pageSize: 100 }).catch(() => ({ tasks: [] as Array<{ id: string; title: string; status: string }> })),
          api.deliverables.search({ limit: 100 }).catch(() => ({ results: [] as Array<{ id: string; title: string; type: string }> })),
          api.teams.list().catch(() => ({ teams: [] as TeamInfo[], ungrouped: [] })),
        ]);
        for (const p of projRes.projects) items.push({ id: p.id, name: p.name, entityType: 'project', role: p.status });
        for (const r of reqRes.requirements) items.push({ id: r.id, name: r.title, entityType: 'requirement', role: r.priority });
        for (const tk of taskRes.tasks) items.push({ id: tk.id, name: tk.title, entityType: 'task', role: tk.status });
        for (const d of delRes.results) items.push({ id: d.id, name: d.title, entityType: 'deliverable', role: d.type });
        for (const team of teamsRes.teams) {
          try {
            const wfRes = await api.workflows.list(team.id);
            for (const wf of wfRes.workflows) items.push({ id: wf.name, name: wf.displayName || wf.name, entityType: 'workflow', role: `v${wf.version}` });
          } catch { /* skip */ }
        }
      } catch { /* ignore */ }
      setEntityMentionItems(items);
    })();
  }, []);

  const activeTeamId = chatMode === 'channel'
    ? groupChats.find(gc => gc.channelKey === activeChannel)?.teamId
    : undefined;

  const messagesEnd = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sendRef = useRef<(text?: string) => Promise<void>>(undefined);
  /** When true, the next scroll-to-bottom effect is suppressed (used by loadMore) */
  const skipScrollRef = useRef(false);
  /** Tracks whether user is at/near the bottom of the chat scroll container */
  const userAtBottomRef = useRef(true);
  /** Stable ref to loadMore for use in IntersectionObserver callback */
  const loadMoreRef = useRef<() => Promise<void>>(undefined);
  // Close history panel on click outside
  useEffect(() => {
    if (!showSessions) return;
    const handler = (e: MouseEvent) => {
      if (
        historyPanelRef.current && !historyPanelRef.current.contains(e.target as Node) &&
        historyBtnRef.current && !historyBtnRef.current.contains(e.target as Node)
      ) {
        setShowSessions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSessions]);

  // ── Conv-buffer helpers ───────────────────────────────────────────────────────
  const makeDmChannel = (myId: string, otherId: string) => {
    // Self-notes use a single-user channel; two-user DMs use sorted IDs for symmetry
    if (!otherId || myId === otherId) return `notes:${myId}`;
    const [a, b] = [myId, otherId].sort();
    return `dm:${a}:${b}`;
  };

  // ── Persistence ─────────────────────────────────────────────────────────────
  useEffect(() => { localStorage.setItem('markus_chat_mode', chatMode); }, [chatMode]);
  useEffect(() => { localStorage.setItem('markus_chat_agent', selectedAgent); }, [selectedAgent]);
  useEffect(() => { localStorage.setItem('markus_chat_channel', activeChannel); }, [activeChannel]);

  // ── Chat unread counts (unified single-source read cursor system) ────────────
  const { counts: chatUnreadCounts, sessionAgentMap, markRead: markChatRead, setActiveKey, clearActiveKey } = useUnreadCounts({ enabled: !previewMode });
  const unreadByChannel = useMemo(() => {
    const result: Record<string, number> = {};
    for (const [key, count] of Object.entries(chatUnreadCounts)) {
      if (key.startsWith('channel:')) {
        result[key.slice('channel:'.length)] = count;
      }
    }
    return result;
  }, [chatUnreadCounts]);

  // Derive per-agent unread from session-level read cursors (unified source).
  const unreadByAgentFromCursors = useAgentUnread(sessionAgentMap, chatUnreadCounts);

  // ── Per-agent unread counts (derived from unified read cursor system) ────────
  // Broadcast total unread for BottomNav badge
  useEffect(() => {
    let total = 0;
    for (const v of unreadByAgentFromCursors.values()) total += v;
    for (const v of Object.values(unreadByChannel)) total += v;
    window.dispatchEvent(new CustomEvent('markus:team-unread-changed', { detail: { count: total } }));
  }, [unreadByAgentFromCursors, unreadByChannel]);

  const unreadByAgent = unreadByAgentFromCursors;
  const markAgentNotificationsRead = useCallback(async (agentId: string) => {
    for (const [sid, aid] of Object.entries(sessionAgentMap)) {
      if (aid === agentId) markChatRead(`session:${sid}`);
    }
  }, [sessionAgentMap, markChatRead]);

  // Mark-read + suppress unread increments for the active conversation (merged to avoid race)
  useEffect(() => {
    if (previewMode) return;
    const isVisible = (!isMobile || mobileLayer === 'chat') && mainTab === 'chat';
    if (!isVisible) return;

    // Mark read
    if (chatMode === 'direct' && selectedAgent) {
      markAgentNotificationsRead(selectedAgent);
    }
    if (chatMode === 'channel' && activeChannel) {
      markChatRead(`channel:${activeChannel}`);
    } else if (chatMode === 'direct' && activeSessionId) {
      markChatRead(`session:${activeSessionId}`);
    } else if (chatMode === 'dm' && activeDmUserId) {
      const dmChannel = `dm:${[authUser?.id, activeDmUserId].sort().join(':')}`;
      markChatRead(`channel:${dmChannel}`);
    }

    // Suppress WS increments for all keys belonging to this conversation
    const keys: string[] = [];
    if (chatMode === 'direct' && activeSessionId) {
      keys.push(`session:${activeSessionId}`);
      for (const [sid, aid] of Object.entries(sessionAgentMap)) {
        if (aid === selectedAgent) keys.push(`session:${sid}`);
      }
    } else if (chatMode === 'channel' && activeChannel) {
      keys.push(`channel:${activeChannel}`);
    } else if (chatMode === 'dm' && activeDmUserId && authUser?.id) {
      keys.push(`channel:dm:${[authUser.id, activeDmUserId].sort().join(':')}`);
    }
    for (const k of keys) setActiveKey(k);
    return () => { for (const k of keys) clearActiveKey(k); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, chatMode, activeChannel, activeSessionId, activeDmUserId, selectedAgent, mobileLayer, mainTab, sessionAgentMap]);

  // ── Data loading ─────────────────────────────────────────────────────────────
  const refreshAgents = useCallback(() => api.agents.list().then(d => setAgents(d.agents)).catch(() => {}), []);
  const refreshTeams = useCallback(() => api.teams.list().then(d => setTeams(d.teams)).catch(() => {}), []);
  const refreshGroupChats = useCallback(() => api.groupChats.list().then(d => setGroupChats(d.chats)).catch(() => {}), []);

  // Throttled versions for WS-driven refreshes to prevent API spam
  const throttledRefreshAgents = useMemo(() => throttle(refreshAgents, 3000), [refreshAgents]);
  const throttledRefreshTeams = useMemo(() => throttle(refreshTeams, 5000), [refreshTeams]);
  const throttledRefreshGroupChats = useMemo(() => throttle(refreshGroupChats, 3000), [refreshGroupChats]);
  const refreshHumans = useCallback(() => {
    api.users.list(authUser?.orgId).then(d => setHumans(d.users)).catch(() => {});
  }, [authUser?.orgId]);

  useEffect(() => {
    if (previewMode) return;
    Promise.all([
      refreshAgents(),
      refreshTeams(),
    ]).finally(() => setInitialLoading(false));
    refreshHumans();
    api.tasks.list().then(d => setTasks(d.tasks)).catch(() => {});
    api.externalAgents.list().then(d => setExternalAgents(d.agents)).catch(() => {});
    refreshGroupChats();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, refreshHumans]);

  useEffect(() => {
    if (!previewMode || !previewData) return;
    setAgents(previewData.agents ?? []);
    setHumans(previewData.humans ?? []);
    setTeams(previewData.teams ?? []);
    setGroupChats(previewData.groupChats ?? []);
    if (previewData.channelMessages) {
      const ch = previewData.activeChannel ?? 'custom:general';
      setMessages(previewData.channelMessages.filter(m => m.channel === ch).map(m => channelMsgToChat(m)));
    }
  }, [previewMode, previewData]);

  useEffect(() => {
    if (previewMode) return;
    if (!isActive) return;
    refreshAgents();
    refreshTeams();
    const timer = setInterval(refreshAgents, 30_000);
    const teamTimer = setInterval(refreshTeams, 60_000);
    const unsub = wsClient.on('agent:update', () => { throttledRefreshAgents(); throttledRefreshTeams(); });
    const unsubTeamUpdate = wsClient.on('team:update', () => { throttledRefreshTeams(); throttledRefreshGroupChats(); });
    const unsubTeamOnAgentRemoved = wsClient.on('agent:removed', throttledRefreshTeams);
    // Team create must refresh immediately — throttled refresh left sidebar stale so
    // clicks no-oped until a full page reload (groupChats missing the new team channel).
    const unsubGroup = wsClient.on('chat:group_created', () => {
      void refreshGroupChats();
      void refreshTeams();
      void refreshAgents();
    });
    const unsubGroupUpdate = wsClient.on('chat:group_updated', throttledRefreshGroupChats);
    const unsubGroupDelete = wsClient.on('chat:group_deleted', () => { throttledRefreshGroupChats(); throttledRefreshTeams(); });
    const unsubTaskUpdate = wsClient.on('task:update', (event) => {
      const p = event?.payload as Record<string, unknown> | undefined;
      if (!p?.taskId) return;
      setTasks(prev => prev.map(t => t.id === p.taskId ? { ...t, status: p.status as string ?? t.status } : t));
    });
    const onDataChanged = () => { refreshAgents(); refreshTeams(); refreshHumans(); };
    window.addEventListener('markus:data-changed', onDataChanged);
    return () => { clearInterval(timer); clearInterval(teamTimer); unsub(); unsubTeamUpdate(); unsubTeamOnAgentRemoved(); unsubGroup(); unsubGroupUpdate(); unsubGroupDelete(); unsubTaskUpdate(); window.removeEventListener('markus:data-changed', onDataChanged); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, isActive, refreshHumans]);

  // Check for nav params (e.g., navigated here from AgentProfile or Team redirect)
  useEffect(() => {
    if (previewMode) return;
    const handleNav = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      if (resolvePageId(detail.page) === PAGE.TEAM) {
        if (detail.params?.agentId) {
          if (detail.params.profileTab) {
            handleViewProfile(detail.params.agentId, { tab: detail.params.profileTab as 'overview' });
          } else {
            setChatMode('direct');
            setSelectedAgent(detail.params.agentId);
            setMainTab('chat');
            if (isMobile) enterMobileDetail();
            if (detail.params.sessionId) {
              const targetSessionId = detail.params.sessionId;
              setTimeout(async () => {
                try {
                  const { sessions: s } = await api.sessions.listByAgent(detail.params!.agentId, 20);
                  const target = s.find((ss: ChatSessionInfo) => ss.id === targetSessionId);
                  if (target) void switchSession(target);
                } catch { /* session will load normally */ }
              }, 300);
            }
          }
        }
        if (detail.params?.selectAgent) {
          setChatMode('direct');
          setSelectedAgent(detail.params.selectAgent);
          setMainTab('chat');
          if (isMobile) enterMobileDetail();
        }
        if (detail.params?.prefillMessage) {
          const msg = detail.params.prefillMessage;
          localStorage.removeItem('markus_nav_prefillMessage');
          localStorage.removeItem('markus_nav_autoSend');
          setMainTab('chat');
          if (detail.params?.autoSend === 'true') {
            setTimeout(() => sendRef.current?.(msg), 300);
          } else {
            setInput(msg);
            setTimeout(() => {
              const el = textareaRef.current;
              if (el) {
                el.focus();
                el.setSelectionRange(el.value.length, el.value.length);
              }
            }, 100);
          }
        }
        if (detail.params?.dm) {
          setChatMode('dm');
          setActiveDmUserId(detail.params.dm);
          setMainTab('chat');
          if (isMobile) enterMobileDetail();
        }
        if (detail.params?.channel) {
          setChatMode('channel');
          setActiveChannel(detail.params.channel);
          setMainTab('chat');
          if (isMobile) enterMobileDetail();
        }
        if (detail.params?.selectTeam) {
          const teamId = detail.params.selectTeam;
          if (isMobile) {
            enterMobileTeam(teamId);
          } else {
            const teamGc = groupChatsRef.current.find(gc => gc.type === 'team' && gc.teamId === teamId);
            setChatMode('channel');
            setActiveChannel(teamGc?.channelKey ?? `group:${teamId}`);
            setMainTab('chat');
            setShowMemberPanel(false);
            setShowTeamDetailPanel(true);
          }
        }
        if (detail.params?.openHire === 'true') {
          // handled by ChatTeamSidebar via nav events
        }
      }
    };
    const navAgent = localStorage.getItem('markus_nav_agentId');
    if (navAgent) {
      localStorage.removeItem('markus_nav_agentId');
      const pTab = localStorage.getItem('markus_nav_profileTab');
      localStorage.removeItem('markus_nav_profileTab');
      setChatMode('direct');
      setSelectedAgent(navAgent);
      if (pTab) {
        handleViewProfile(navAgent, { tab: pTab as 'overview' });
      } else {
        setMainTab('chat');
        if (isMobile) enterMobileDetail();
      }
    }
    const navDm = localStorage.getItem('markus_nav_dm');
    if (navDm) {
      localStorage.removeItem('markus_nav_dm');
      setChatMode('dm'); setActiveDmUserId(navDm); setMainTab('chat');
      if (isMobile) enterMobileDetail();
    }
    const navChannel = localStorage.getItem('markus_nav_channel');
    if (navChannel) {
      localStorage.removeItem('markus_nav_channel');
      setChatMode('channel'); setActiveChannel(navChannel); setMainTab('chat');
      if (isMobile) enterMobileDetail();
    }
    const navPrefillMsg = localStorage.getItem('markus_nav_prefillMessage');
    if (navPrefillMsg) {
      localStorage.removeItem('markus_nav_prefillMessage');
      localStorage.removeItem('markus_nav_autoSend');
      setMainTab('chat');
      setInput(navPrefillMsg);
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      }, 150);
    }
    const selectAgent = localStorage.getItem('markus_nav_selectAgent');
    if (selectAgent) {
      localStorage.removeItem('markus_nav_selectAgent');
      setChatMode('direct');
      setSelectedAgent(selectAgent);
      setMainTab('chat');
      if (isMobile) enterMobileDetail();
    }
    const selectTeam = localStorage.getItem('markus_nav_selectTeam');
    if (selectTeam) {
      localStorage.removeItem('markus_nav_selectTeam');
      if (isMobile) {
        enterMobileTeam(selectTeam);
      } else {
        const teamGc = groupChatsRef.current.find(gc => gc.type === 'team' && gc.teamId === selectTeam);
        setChatMode('channel');
        setActiveChannel(teamGc?.channelKey ?? `group:${selectTeam}`);
        setMainTab('chat');
        setShowMemberPanel(false);
        setShowTeamDetailPanel(true);
      }
    }
    window.addEventListener('markus:navigate', handleNav);
    return () => window.removeEventListener('markus:navigate', handleNav);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode]);

  useEffect(() => {
    const teamId = pendingSelectTeamRef.current;
    if (!teamId) return;
    const teamGc = groupChats.find(gc => gc.type === 'team' && gc.teamId === teamId);
    // Enter as soon as we know the team id — synthetic channel works even before groupChats refresh.
    pendingSelectTeamRef.current = null;
    setChatMode('channel');
    setActiveChannel(teamGc?.channelKey ?? `group:${teamId}`);
    setMainTab('chat');
    setShowMemberPanel(false);
    setShowTeamDetailPanel(true);
  }, [groupChats, teams]);

  // Auto-select secretary agent when no valid agent is selected.
  // Also handles stale IDs from localStorage (e.g. deleted agents).
  useEffect(() => {
    if (previewMode && previewData?.chatMode === 'channel') return;
    if (agents.length === 0) return;
    if (selectedAgent && agents.some(a => a.id === selectedAgent)) return;
    const secretary = agents.find(a => !a.teamId && a.role?.toLowerCase() === 'secretary')
      ?? agents.find(a => a.role?.toLowerCase() === 'secretary')
      ?? agents.find(a => a.name?.toLowerCase().includes('secretary'));
    if (secretary) {
      setChatMode('direct');
      setSelectedAgent(secretary.id);
      setMainTab('chat');
    } else if (agents.length > 0) {
      setChatMode('direct');
      setSelectedAgent(agents[0]!.id);
      setMainTab('chat');
    }
  }, [agents, selectedAgent]);

  // Sticky-bottom follow: auto-scroll while the user is at/near the bottom.
  // During streaming, programmatic follow must not override a manual scroll-away;
  // once the user scrolls back to the latest output, follow resumes.
  const isProgrammaticScrollRef = useRef(false);
  /** True after an explicit user scroll-away until they return to the bottom. */
  const userPinnedAwayRef = useRef(false);
  /** Wheel / touch / scrollbar drag — honored even while a programmatic scroll is in flight. */
  const userScrollIntentRef = useRef(false);
  const lastChatScrollTopRef = useRef(0);
  /** Bumped to cancel in-flight scrollChatToBottom rAF chains. */
  const scrollFollowGenRef = useRef(0);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const newMsgCountRef = useRef(0);
  const [newMsgCount, setNewMsgCount] = useState(0);
  const resumeChatScrollFollow = useCallback(() => {
    userPinnedAwayRef.current = false;
    userScrollIntentRef.current = false;
    userAtBottomRef.current = true;
  }, []);
  const pinChatScrollAway = useCallback(() => {
    userPinnedAwayRef.current = true;
    userAtBottomRef.current = false;
    // Cancel any in-flight programmatic follow so streaming cannot yank the viewport.
    scrollFollowGenRef.current += 1;
    isProgrammaticScrollRef.current = false;
    setShowScrollBtn(true);
  }, []);
  const syncChatBottomState = useCallback((opts?: { fromProgrammatic?: boolean }) => {
    const el = chatScrollRef.current;
    if (!el) return;
    // Virtualizer totalSize is estimate-based; keep a looser threshold so the
    // jump button doesn't stick on when the last bubble is already in view.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance < 160;
    // Require getting closer than this before reclaiming follow after a pin-away,
    // so a tiny slack gap doesn't immediately re-stick while the user is reading.
    const resumeBottom = distance < 48;
    const prevTop = lastChatScrollTopRef.current;
    const scrollingUp = el.scrollTop < prevTop - 2;
    lastChatScrollTopRef.current = el.scrollTop;

    // Upward movement during follow = user taking over (wheel/touch/scrollbar),
    // even while a programmatic snap is in flight and even inside the near-bottom
    // slack zone (otherwise a small scroll-up keeps getting yanked back).
    if (scrollingUp && distance > 20) {
      userScrollIntentRef.current = true;
      pinChatScrollAway();
      return;
    }

    if (userScrollIntentRef.current) {
      if (resumeBottom) {
        resumeChatScrollFollow();
        setShowScrollBtn(false);
        newMsgCountRef.current = 0;
        setNewMsgCount(0);
      } else {
        pinChatScrollAway();
      }
      return;
    }

    if (nearBottom && !userPinnedAwayRef.current) {
      resumeChatScrollFollow();
      setShowScrollBtn(false);
      newMsgCountRef.current = 0;
      setNewMsgCount(0);
      return;
    }

    // During programmatic snap-to-bottom, ignore transient mid-scroll gaps.
    if (opts?.fromProgrammatic || isProgrammaticScrollRef.current) return;
    // Streaming/layout growth can push distance past the threshold without any
    // user gesture. Keep following in that case; only show the jump control once
    // the user has actually pinned away.
    if (!userPinnedAwayRef.current && userAtBottomRef.current) return;
    if (userPinnedAwayRef.current) {
      userAtBottomRef.current = false;
      setShowScrollBtn(true);
    }
  }, [pinChatScrollAway, resumeChatScrollFollow]);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const markUserScrollIntent = () => {
      userScrollIntentRef.current = true;
    };
    const onScroll = () => {
      syncChatBottomState({ fromProgrammatic: isProgrammaticScrollRef.current });
    };
    el.addEventListener('wheel', markUserScrollIntent, { passive: true });
    el.addEventListener('touchmove', markUserScrollIntent, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    // Virtualizer totalSize / streaming height changes don't always fire scroll.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => syncChatBottomState()) : null;
    ro?.observe(el);
    lastChatScrollTopRef.current = el.scrollTop;
    syncChatBottomState();
    return () => {
      el.removeEventListener('wheel', markUserScrollIntent);
      el.removeEventListener('touchmove', markUserScrollIntent);
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, [mobileLayer, syncChatBottomState]);

  // visibleMessages + virtualizer must be declared before scrollChatToBottom.
  // Unread notify_user items are shown as bottom cards — suppress the duplicate bubble
  // until the user acknowledges (then the history message reappears).
  const hiddenNotifyMsgIdSet = useMemo(() => new Set(hiddenNotifyMsgIds), [hiddenNotifyMsgIds]);
  const visibleMessages = useMemo(() => {
    const base = chatMode === 'channel' ? messages : messages.filter(m => !m.isActivityLog);
    if (hiddenNotifyMsgIdSet.size === 0) return base;
    return base.filter(m => !(m.isNotification && hiddenNotifyMsgIdSet.has(m.id)));
  }, [messages, chatMode, hiddenNotifyMsgIdSet]);

  // Keep composer height in sync when switching empty ↔ non-empty sessions.
  useEffect(() => {
    compactComposerRef.current = mainTab === 'chat' && visibleMessages.length > 0;
    adjustTextareaHeight();
  }, [mainTab, visibleMessages.length, adjustTextareaHeight]);

  const chatVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => chatScrollRef.current,
    // Key by message id so mid-list unhide (notify ack) doesn't reuse height
    // cache from a different row — index-only cache caused bubble overlap.
    getItemKey: (index) => visibleMessages[index]?.id ?? index,
    estimateSize: (index) => {
      const msg = visibleMessages[index];
      if (!msg) return 120;
      if (msg.segments && msg.segments.length > 0) return 300;
      if (msg.text.length > 500) return 200;
      return 120;
    },
    overscan: 8,
  });

  // NOTE: `shouldAdjustScrollPositionOnItemSizeChange` is a settable INSTANCE
  // property in virtual-core (not an option passed through setOptions), so it must
  // be assigned directly on the instance. When the user expands/collapses a row
  // inside a message we return false so the virtualizer skips its scroll
  // compensation and the clicked row stays anchored (top-fixed) — otherwise, for
  // a row near the viewport top, the default `item.start < scrollOffset` rule
  // shifts the whole list up and the clicked header scrolls off-screen. Outside a
  // user toggle we replicate the library default so normal scrolling through
  // not-yet-measured items above the viewport stays stable.
  chatVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (isVirtualScrollAdjustSuppressed()) return false;
    return item.start < (instance.scrollOffset ?? 0);
  };

  // NOTE: Do NOT call chatVirtualizer.measure() on message changes.
  // measureElement uses ResizeObserver internally (v3+) which automatically
  // detects height changes in rendered items. Calling measure() resets ALL
  // cached sizes back to estimateSize(72px), causing severe overlap artifacts.

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = 'instant') => {
    // Never reclaim the viewport while the user is reading earlier content.
    if (!userAtBottomRef.current || userPinnedAwayRef.current) return;

    const gen = ++scrollFollowGenRef.current;
    isProgrammaticScrollRef.current = true;
    const stillFollowing = () =>
      gen === scrollFollowGenRef.current
      && userAtBottomRef.current
      && !userPinnedAwayRef.current;

    const finish = () => {
      if (gen !== scrollFollowGenRef.current) return;
      isProgrammaticScrollRef.current = false;
      if (!stillFollowing()) {
        syncChatBottomState();
        return;
      }
      // Confirm from DOM instead of forcing stickiness — residual virtualizer
      // gaps shouldn't re-pin the user if they already scrolled away.
      const el = chatScrollRef.current;
      if (el) {
        lastChatScrollTopRef.current = el.scrollTop;
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distance < 160 && !userPinnedAwayRef.current) {
          resumeChatScrollFollow();
          setShowScrollBtn(false);
          newMsgCountRef.current = 0;
          setNewMsgCount(0);
        }
      }
      requestAnimationFrame(() => {
        if (gen === scrollFollowGenRef.current) {
          syncChatBottomState({ fromProgrammatic: true });
        }
      });
    };
    if (visibleMessages.length > 0) {
      chatVirtualizer.scrollToIndex(visibleMessages.length - 1, { align: 'end', behavior });
      // Re-scroll after virtualizer measures actual item sizes
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!stillFollowing()) {
            if (gen === scrollFollowGenRef.current) isProgrammaticScrollRef.current = false;
            return;
          }
          chatVirtualizer.scrollToIndex(visibleMessages.length - 1, { align: 'end', behavior: 'instant' });
          requestAnimationFrame(finish);
        });
      });
    } else {
      const el = chatScrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior });
      requestAnimationFrame(finish);
    }
  }, [visibleMessages.length, chatVirtualizer, syncChatBottomState, resumeChatScrollFollow]);

  // ── Preserve scroll position across page-level navigation ──
  // PageSlot now uses visibility:hidden + position:absolute instead of
  // display:none, so the scroll container keeps its dimensions and scrollTop.
  // No save/restore logic needed — the browser preserves scroll position natively.
  const isActiveRef = useRef(isActive);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);

  // Snap to bottom after message DOM updates, but only if user hasn't scrolled up.
  // Do NOT depend on `activities` — activity ticks during streaming would force
  // repeated scrollToBottom and fight the user / expand-anchor.
  // When items are prepended (loadMore), anchor scroll to the previously top-visible item.
  useLayoutEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      const count = prependCountRef.current;
      if (count > 0) {
        prependCountRef.current = 0;
        chatVirtualizer.scrollToIndex(count, { align: 'start', behavior: 'instant' });
      }
      return;
    }
    if (!isActiveRef.current) return;
    if (!userAtBottomRef.current || userPinnedAwayRef.current) return;
    // Expanding/collapsing a tool row temporarily owns scroll anchoring —
    // don't yank back to bottom while that suppression window is open.
    if (isVirtualScrollAdjustSuppressed()) return;
    scrollChatToBottom();
  }, [messages, scrollChatToBottom, chatVirtualizer]);

  const prevMainTabRef = useRef(mainTab);
  useEffect(() => {
    const wasProfile = prevMainTabRef.current !== 'chat';
    prevMainTabRef.current = mainTab;
    // Returning to the chat tab: the message list is virtualized inside a
    // container that was `display:none` while off-tab, so the virtualizer's
    // scroll element measured 0px and its visible range stayed pinned near the
    // top. A streaming message appended while we were away therefore sits
    // outside the rendered range and looks like it "disappeared". Re-scroll to
    // the bottom across several frames so the virtualizer re-measures the now
    // visible container and brings the in-progress message back into view.
    // Only reclaim the viewport if the user was already following the latest
    // output — don't override a deliberate scroll-away while streaming.
    if (mainTab === 'chat' && wasProfile && userAtBottomRef.current && !userPinnedAwayRef.current) {
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const raf = requestAnimationFrame(() => scrollChatToBottom('instant'));
      for (const delay of [60, 160, 320]) {
        timers.push(setTimeout(() => scrollChatToBottom('instant'), delay));
      }
      return () => { cancelAnimationFrame(raf); for (const t of timers) clearTimeout(t); };
    }
  }, [mainTab, sending, scrollChatToBottom]);

  // Load channel messages from DB → store in buffer + update display
  const loadChannelMessages = useCallback(async (channel: string, bufferKey?: string) => {
    const key = bufferKey ?? `ch:${channel}`;
    if (currentConvKeyRef.current === key) setLoadingChat(true);
    try {
      const result = await api.channels.getMessages(channel, 50);
      const msgs = result.messages.map(m => channelMsgToChat(m, authUser?.id));
      msgBuffers.set(key, msgs);
      if (currentConvKeyRef.current === key) {
        setMessages(msgs);
        setHasMore(result.hasMore);
        oldestMsgId.current = result.messages[0] ? new Date(result.messages[0].createdAt).toISOString() : null;
      }
    } catch {
      if (currentConvKeyRef.current === key) { setMessages([]); setHasMore(false); }
    } finally {
      if (currentConvKeyRef.current === key) setLoadingChat(false);
    }
  }, []);

  // Load session messages from DB — phase-aware via ConversationBufferManager.
  // During streaming phase, DB data is written to cache only, never to display.
  const loadSessionMessages = useCallback(async (sessionId: string, convKey: string): Promise<number> => {
    // Soft-refresh (buffer already has messages) should not flash a full-page spinner.
    const showSpinner = currentConvKeyRef.current === convKey
      && (msgBuffers.get(convKey)?.length ?? 0) === 0;
    if (showSpinner) setLoadingChat(true);
    try {
      const { count, hasMore: more, oldestCursor } = await loadAndDisplay(sessionId, convKey, async () => {
        const result = await api.sessions.getMessages(sessionId, 50);
        const msgs = dedupeAdjacentUserMessages(result.messages.map(dbMsgToChat).filter(m =>
          m.sender !== 'agent' || m.text || (m.segments && m.segments.length > 0) || m.isStreaming
        ));
        return {
          messages: msgs,
          hasMore: result.hasMore,
          oldestCursor: result.messages[0] ? new Date(result.messages[0].createdAt).toISOString() : null,
        };
      });
      setHasMore(more);
      oldestMsgId.current = oldestCursor;
      return count;
    } finally {
      if (showSpinner && currentConvKeyRef.current === convKey) setLoadingChat(false);
    }
  }, [loadAndDisplay, msgBuffers]);

  /**
   * After refresh / session switch: if the server still has an active generation
   * for this session, reattach SSE and continue streaming into the last agent bubble.
   * Must consume text + tool + commit events the same way as a live send().
   */
  const reattachCooldownRef = useRef<Map<string, number>>(new Map());
  const tryReattachActiveStream = useCallback(async (agentId: string, sessionId: string, convKey: string) => {
    if (!agentId || !sessionId || sessionId === NEW_CHAT_PLACEHOLDER_ID) return;
    let abortCtrl: AbortController | null = null;
    try {
      // Live send() still owns this session's SSE — keep consuming there; a second
      // attach would double-apply tool/subagent events.
      if (
        abortControllerRef.current
        && !abortControllerRef.current.signal.aborted
        && getStreamSession(convKey)?.has(sessionId)
      ) {
        beginStream(convKey);
        if (currentConvKeyRef.current === convKey) setSending(true);
        return;
      }

      // Prevent attach storms when the browser is out of sockets / soft-disconnect loops.
      const cooldownKey = `${agentId}:${sessionId}`;
      const lastAttempt = reattachCooldownRef.current.get(cooldownKey) ?? 0;
      if (Date.now() - lastAttempt < 1500) return;

      const status = await api.sessions.streamStatus(agentId, sessionId);
      const msgs = msgBuffers.get(convKey) ?? [];
      const last = [...msgs].reverse().find(m => m.sender === 'agent');
      // `active` stays true for ~90s after done/error so late refresh can drain
      // the terminal event — only attach when still streaming, or when the UI
      // bubble is still marked in-flight and needs the final `done`.
      const serverStreaming = status.status === 'streaming';
      const lateTerminal = !!status.active
        && (status.status === 'done' || status.status === 'error')
        && !!last?.isStreaming;
      if (!serverStreaming && !lateTerminal) return;

      reattachCooldownRef.current.set(cooldownKey, Date.now());
      reattachAbortRef.current?.abort();
      abortCtrl = new AbortController();
      reattachAbortRef.current = abortCtrl;
      beginStream(convKey);
      setSending(true);
      setStreamSession(convKey, sessionId);

      // Ensure there is an agent bubble to stream into. Keep DB tool segments as
      // an interim view — server `snapshot` (or live tool events) will replace/
      // update them. Do NOT wipe tools here: ring replay alone can miss early
      // tool events once the text_delta ring overflows.
      let agentMsgId = last?.id;
      if (!last || last.isError) {
        agentMsgId = `reattach_${Date.now()}`;
        updateConvMsgs(convKey, prev => [
          ...prev,
          { id: agentMsgId!, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), isStreaming: true, segments: [] },
        ], sessionId);
      } else {
        // Keep tool cards from soft-disconnect DB persist; drop text segments so
        // ring text_delta fallback (no snapshot) does not duplicate DB text.
        const revivedTools = (last.segments ?? [])
          .filter((s): s is Extract<typeof s, { type: 'tool' }> => s.type === 'tool')
          .map(s =>
            s.status === 'stopped' || s.status === 'running'
              ? { ...s, status: 'running' as const }
              : s,
          );
        updateConvMsgs(convKey, prev => prev.map(m =>
          m.id === last.id
            ? {
                ...m,
                text: '',
                isStreaming: true,
                isStopped: false,
                segments: revivedTools,
                committedSegments: undefined,
              }
            : m,
        ), sessionId);
      }

      let insideThink = false;
      const appendTextChunk = (chunk: string) => {
        if (currentConvKeyRef.current !== convKey) return;
        lastSseEventTimeRef.current = Date.now();
        updateConvMsgsRaf(convKey, prev => {
          const u = [...prev];
          const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
          const i = idx >= 0 ? idx : u.map((m, j) => ({ m, j })).reverse().find(x => x.m.sender === 'agent')?.j ?? -1;
          if (i < 0) return prev;
          const segs = u[i]!.segments ?? [];
          const lastSeg = segs[segs.length - 1];
          const prevThinking = lastSeg?.type === 'text' ? (lastSeg as { thinking?: string }).thinking ?? '' : '';

          let thinking = '';
          let content = '';
          let remaining = chunk;
          while (remaining.length > 0) {
            if (insideThink) {
              const closeIdx = remaining.indexOf('</think>');
              if (closeIdx >= 0) {
                thinking += remaining.slice(0, closeIdx);
                remaining = remaining.slice(closeIdx + '</think>'.length);
                insideThink = false;
              } else {
                thinking += remaining;
                remaining = '';
              }
            } else {
              const openIdx = remaining.indexOf('<think>');
              if (openIdx >= 0) {
                content += remaining.slice(0, openIdx);
                remaining = remaining.slice(openIdx + '<think>'.length);
                insideThink = true;
              } else {
                content += remaining;
                remaining = '';
              }
            }
          }
          const mergedThinking = (prevThinking + thinking) || undefined;
          const newSegs = lastSeg?.type === 'text'
            ? [...segs.slice(0, -1), { type: 'text' as const, content: lastSeg.content + content, thinking: mergedThinking, createdAt: lastSeg.createdAt }]
            : [...segs, { type: 'text' as const, content, thinking: mergedThinking, createdAt: new Date().toISOString() }];
          u[i] = { ...u[i]!, text: (u[i]!.text ?? '') + content, segments: newSegs, isStreaming: true };
          return u;
        }, sessionId);
      };

      const handleToolEvent = (event: AgentToolEvent) => {
        if (currentConvKeyRef.current !== convKey) return;
        lastSseEventTimeRef.current = Date.now();
        if (event.phase === 'heartbeat') return;
        if (event.phase === 'start' || event.phase === 'end') {
          appendConvActivity(convKey, { ...event, phase: event.phase, ts: Date.now() }, sessionId);
        }
        if (event.phase === 'start') {
          const toolKey = `${event.tool}_${Date.now()}`;
          const now = new Date().toISOString();
          // Revive a soft-disconnect "stopped/running" tool for the same name, else push a new one.
          const reviveOrPush = (list: MsgSegment[]): MsgSegment[] => {
            const arr = [...list];
            for (let i = arr.length - 1; i >= 0; i--) {
              const s = arr[i]!;
              if (s.type === 'tool' && s.tool === event.tool && (s.status === 'running' || s.status === 'stopped')) {
                arr[i] = { ...s, status: 'running', args: event.arguments ?? s.args };
                return arr;
              }
            }
            arr.push({ type: 'tool', key: toolKey, tool: event.tool, status: 'running', args: event.arguments, createdAt: now });
            return arr;
          };
          updateConvMsgs(convKey, prev => {
            const u = [...prev];
            const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
            if (idx < 0) return prev;
            const segs = reviveOrPush(u[idx]!.segments ?? []);
            // Keep committedSegments (snapshot-seeded) in sync so the always-expanded
            // full log renders tools that arrive live after reattach.
            const prevCommitted = u[idx]!.committedSegments;
            const committed = prevCommitted ? reviveOrPush(prevCommitted) : prevCommitted;
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed, isStreaming: true };
            return u;
          }, sessionId);
        } else if (event.phase === 'end') {
          const now = new Date().toISOString();
          const finalize = (list: MsgSegment[]): MsgSegment[] => {
            const arr = [...list];
            for (let i = arr.length - 1; i >= 0; i--) {
              const s = arr[i]!;
              if (s.type === 'tool' && s.tool === event.tool && (s.status === 'running' || s.status === 'stopped')) {
                arr[i] = {
                  ...s,
                  status: event.success === false ? 'error' : 'done',
                  args: event.arguments ?? s.args,
                  result: event.result,
                  error: event.error,
                  durationMs: event.durationMs,
                  liveOutput: undefined,
                  createdAt: now,
                };
                break;
              }
            }
            return arr;
          };
          updateConvMsgs(convKey, prev => {
            const u = [...prev];
            const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
            if (idx < 0) return prev;
            const segs = finalize(u[idx]!.segments ?? []);
            const prevCommitted = u[idx]!.committedSegments;
            const committed = prevCommitted ? finalize(prevCommitted) : prevCommitted;
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed, isStreaming: true };
            return u;
          }, sessionId);
        } else if (event.phase === 'subagent_progress' && event.subagentEvent) {
          const appendLog = (list: MsgSegment[]): MsgSegment[] => {
            const next = [...list];
            for (let i = next.length - 1; i >= 0; i--) {
              const s = next[i]!;
              if (s.type === 'tool' && (s.tool === 'spawn_subagent' || s.tool === 'spawn_subagents') && (s.status === 'running' || s.status === 'stopped')) {
                next[i] = { ...s, status: 'running', subagentLogs: appendSubagentLog(s.subagentLogs, event.subagentEvent!) };
                break;
              }
            }
            return next;
          };
          updateConvMsgsRaf(convKey, prev => {
            const u = [...prev];
            const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
            if (idx < 0) return prev;
            const segs = appendLog(u[idx]!.segments ?? []);
            const prevCommitted = u[idx]!.committedSegments;
            const committed = prevCommitted ? appendLog(prevCommitted) : prevCommitted;
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed, isStreaming: true };
            return u;
          }, sessionId);
        }
      };

      const handleCommitEvent = (event: StreamCommitEvent) => {
        if (currentConvKeyRef.current !== convKey) return;
        lastSseEventTimeRef.current = Date.now();
        updateConvMsgs(convKey, prev => {
          const u = [...prev];
          const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
          if (idx < 0) return prev;
          const committed = [...(u[idx]!.committedSegments ?? [])];
          if (event.type === 'thinking_commit') {
            committed.push({ type: 'text', content: '', thinking: event.content, createdAt: event.createdAt });
          } else if (event.type === 'text_commit') {
            committed.push({ type: 'text', content: event.content, createdAt: event.createdAt });
          } else {
            return prev;
          }
          u[idx] = { ...u[idx]!, committedSegments: committed, isStreaming: true };
          return u;
        }, sessionId);
      };

      const handleSnapshot = (snapshot: { content: string; segments: Array<{ type: string; content?: string; thinking?: string; tool?: string; status?: string; arguments?: unknown; result?: string; error?: string; durationMs?: number; createdAt?: string; subagentLogs?: SubagentProgressEvent[] }> }) => {
        if (currentConvKeyRef.current !== convKey) return;
        lastSseEventTimeRef.current = Date.now();
        const segs = (snapshot.segments ?? []).map((s, si) =>
          s.type === 'tool'
            ? {
                type: 'tool' as const,
                key: `${s.tool}_${si}`,
                tool: s.tool ?? 'tool',
                status: (s.status === 'error' ? 'error' : s.status === 'running' || s.status === 'stopped' ? 'running' : 'done') as 'running' | 'done' | 'error' | 'stopped',
                args: s.arguments,
                result: s.result,
                error: s.error,
                durationMs: s.durationMs,
                createdAt: s.createdAt,
                ...(s.subagentLogs?.length ? { subagentLogs: s.subagentLogs } : {}),
              }
            : {
                type: 'text' as const,
                content: s.content ?? '',
                thinking: s.thinking,
                createdAt: s.createdAt,
              },
        );
        updateConvMsgs(convKey, prev => {
          const u = [...prev];
          const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
          if (idx < 0) return prev;
          u[idx] = {
            ...u[idx]!,
            text: snapshot.content || u[idx]!.text,
            segments: segs,
            committedSegments: segs,
            isStreaming: true,
            isStopped: false,
          };
          return u;
        }, sessionId);
        // Rebuild activity chips from restored tool segments.
        for (const s of segs) {
          if (s.type !== 'tool') continue;
          appendConvActivity(convKey, {
            tool: s.tool,
            phase: s.status === 'running' || s.status === 'stopped' ? 'start' : 'end',
            success: s.status !== 'error',
            arguments: s.args,
            result: s.result,
            error: s.error,
            durationMs: s.durationMs,
            ts: Date.now(),
          }, sessionId);
        }
      };

      // Prefer server snapshot (tools + text). Falls back to ring replay if older server.
      const result = await api.sessions.reattachStream(
        agentId,
        sessionId,
        {
          onChunk: appendTextChunk,
          onActivity: handleToolEvent,
          onCommit: handleCommitEvent,
          onSnapshot: handleSnapshot,
        },
        abortCtrl.signal,
        0,
      );

      if (!result.attached) {
        // No live stream to reattach — clear stuck「思考中」locally (DB heal
        // runs on message load / process start; this covers the current view).
        endStream(convKey);
        if (currentConvKeyRef.current === convKey) {
          updateConvMsgs(convKey, prev => {
            const u = [...prev];
            const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
            const i = idx >= 0
              ? idx
              : u.map((m, j) => ({ m, j })).reverse().find(x => x.m.sender === 'agent' && x.m.isStreaming)?.j ?? -1;
            if (i < 0) return prev;
            const msg = u[i]!;
            if (!msg.isStreaming) return prev;
            u[i] = {
              ...msg,
              isStreaming: false,
              isStopped: msg.isError ? msg.isStopped : true,
            };
            return u;
          }, sessionId);
          setSending(false);
        }
        return;
      }

      if (currentConvKeyRef.current === convKey) {
        updateConvMsgs(convKey, prev => {
          const u = [...prev];
          const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
          const i = idx >= 0 ? idx : u.map((m, j) => ({ m, j })).reverse().find(x => x.m.sender === 'agent')?.j ?? -1;
          if (i < 0) return prev;
          const msg = u[i]!;
          const finalSegs = result.segments?.length
            ? storedSegmentsToMsgSegments(result.segments, msg.segments)
            : undefined;
          u[i] = {
            ...msg,
            text: result.content || msg.text,
            isStreaming: false,
            isStopped: false,
            ...(finalSegs
              ? { segments: finalSegs, committedSegments: finalSegs }
              : {}),
          };
          return u;
        }, sessionId);
        setSending(false);
      }
      endStream(convKey);
      if (reattachAbortRef.current === abortCtrl) reattachAbortRef.current = null;
    } catch (err) {
      // Aborted by stop / newer reattach / navigation — always clear local stream UI.
      if (reattachAbortRef.current === abortCtrl) reattachAbortRef.current = null;
      endStream(convKey);
      if (currentConvKeyRef.current === convKey) setSending(false);
      if (err instanceof Error && err.name === 'AbortError') return;
    }
  }, [appendConvActivity, beginStream, endStream, getStreamSession, msgBuffers, setStreamSession, updateConvMsgs, updateConvMsgsRaf]);

  // Returning to Team after visiting another page: reattach if a generation is
  // still running (SSE may have been killed while the tab was hidden).
  useEffect(() => {
    if (!isActive || previewMode || chatMode !== 'direct' || !selectedAgent) return;
    const sid = activeSessionId;
    if (!sid || sid === NEW_CHAT_PLACEHOLDER_ID) return;
    void tryReattachActiveStream(selectedAgent, sid, currentConvKeyRef.current);
  }, [isActive, previewMode, chatMode, selectedAgent, activeSessionId, tryReattachActiveStream]);

  // Load sessions list for agent
  const loadSessions = useCallback(async (agentId: string) => {
    if (!agentId) { setSessions([]); return []; }
    try {
      const { sessions: s } = await api.sessions.listByAgent(agentId, 10);
      setSessions(s);
      return s;
    } catch { setSessions([]); return []; }
  }, []);

  // Load more (pagination) — preserves scroll position after prepending
  const prependCountRef = useRef(0);
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !oldestMsgId.current) return;
    setLoadingMore(true);
    try {
      const convKey = currentConvKeyRef.current;
      if (chatMode === 'channel' || chatMode === 'dm') {
        const channelName = chatMode === 'dm' ? makeDmChannel(authUser?.id ?? '', activeDmUserId) : activeChannel;
        const result = await api.channels.getMessages(channelName, 50, oldestMsgId.current);
        const newMsgs = result.messages.map(m => channelMsgToChat(m, authUser?.id));
        prependCountRef.current = newMsgs.length;
        skipScrollRef.current = true;
        setMessages(prev => {
          let combined = [...newMsgs, ...prev];
          if (combined.length > 500) combined = combined.slice(-500);
          msgBuffers.set(convKey, combined);
          return combined;
        });
        setHasMore(result.hasMore);
        if (result.messages[0]) oldestMsgId.current = new Date(result.messages[0].createdAt).toISOString();
      } else if (activeSessionId) {
        const result = await api.sessions.getMessages(activeSessionId, 50, oldestMsgId.current);
        const newMsgs = result.messages.map(dbMsgToChat);
        prependCountRef.current = newMsgs.length;
        skipScrollRef.current = true;
        setMessages(prev => {
          let combined = [...newMsgs, ...prev];
          if (combined.length > 500) combined = combined.slice(-500);
          msgBuffers.set(convKey, combined);
          return combined;
        });
        setHasMore(result.hasMore);
        if (result.messages[0]) oldestMsgId.current = new Date(result.messages[0].createdAt).toISOString();
      }
    } catch { /* ignore */ } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, chatMode, activeChannel, activeSessionId, authUser?.id, activeDmUserId]);

  loadMoreRef.current = loadMore;

  // Auto-load earlier messages when user scrolls near the top.
  // Uses a React onScroll handler instead of addEventListener so it works
  // on mobile where the chat container is conditionally mounted.
  const scrollTickingRef = useRef(false);
  const handleChatScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (scrollTickingRef.current) return;
    scrollTickingRef.current = true;
    requestAnimationFrame(() => {
      scrollTickingRef.current = false;
      if ((e.target as HTMLDivElement).scrollTop < 100) {
        loadMoreRef.current?.();
      }
    });
  }, []);

  // When mode/target changes: switch to the new conversation's buffer.
  // If the new conv is already streaming or has buffered messages, show them immediately.
  // Otherwise load from DB.
  useEffect(() => {
    if (previewMode) return;
    const newKey = makeConvKey(chatMode, selectedAgent, activeChannel, activeDmUserId);
    const prevKey = currentConvKeyRef.current;
    currentConvKeyRef.current = newKey;

    // Save current session tabs & active session before switching away
    if (prevKey && prevKey !== newKey) {
      sessionTabsBuffer.set(prevKey, openSessionTabs);
      if (activeSessionId) activeSessionBuffer.set(prevKey, activeSessionId);
    }
    // Snap to bottom when entering a NEW conversation (or first mount)
    if (prevKey !== newKey) {
      resumeChatScrollFollow();
      setShowScrollBtn(false);
      newMsgCountRef.current = 0;
      setNewMsgCount(0);
    }

    // Restore displayed state from this conv's buffer
    const bufferedMsgs = msgBuffers.get(newKey);
    // Restore or reset session tabs for the new agent
    const savedTabs = sessionTabsBuffer.get(newKey);
    const savedActiveSession = activeSessionBuffer.get(newKey);
    // For direct mode, sending state is only relevant if the stream belongs
    // to the session we're switching TO. Otherwise a stream in session A
    // would incorrectly cause session B to appear as "streaming".
    const streamingSessions = getStreamSession(newKey);
    const targetSession = savedActiveSession ?? activeSessionId;
    const isSendingNow = isSendingFor(newKey) &&
      (chatMode !== 'direct' || !streamingSessions || !targetSession ||
       streamingSessions.has(targetSession));

    // Activities are keyed by session, not convKey
    const actBufKey = targetSession ?? newKey;
    const bufferedActs = actBuffers.get(actBufKey) ?? [];
    setActivities(isSendingNow ? bufferedActs : []);
    setSending(isSendingNow);

    // Always reload sessions list for direct mode so History panel stays accurate
    if (chatMode === 'direct' && selectedAgent) {
      loadSessions(selectedAgent);
    }
    if (savedTabs && savedTabs.length > 0) {
      setOpenSessionTabs(savedTabs);
    }
    // If no saved tabs, we'll populate from DB below for direct mode
    setShowSessions(false);

    // Empty in-memory buffers must NOT skip the DB load — a prior race can leave
    // `[]` in the map and make history look "missing" until a full page refresh.
    const hasBufferedContent = bufferedMsgs !== undefined && bufferedMsgs.length > 0;

    if (hasBufferedContent) {
      // Already have content (possibly mid-stream) — show immediately, then soft-refresh
      if (!isSendingNow) bufMgr.completeLoad(newKey);
      setLoadingChat(false);
      setMessages(bufferedMsgs!);
      setHasMore(false);
      if (savedActiveSession !== undefined) {
        setActiveSessionId(savedActiveSession);
      }
      if (!savedTabs || savedTabs.length === 0) setOpenSessionTabs([]);
      // Refresh from server in background to catch anything we missed while away
      if (chatMode === 'channel' || chatMode === 'dm') {
        const channelName = chatMode === 'dm'
          ? makeDmChannel(authUser?.id ?? '', activeDmUserId)
          : activeChannel;
        loadChannelMessages(channelName, newKey);
      } else if (
        chatMode === 'direct'
        && selectedAgent
        && savedActiveSession
        && savedActiveSession !== NEW_CHAT_PLACEHOLDER_ID
      ) {
        if (!isSendingNow) {
          void loadSessionMessages(savedActiveSession, newKey).then(() => {
            if (currentConvKeyRef.current === newKey && selectedAgent) {
              void tryReattachActiveStream(selectedAgent, savedActiveSession, newKey);
            }
          });
        } else {
          // Resume server stream if the original SSE dropped while we were away.
          void tryReattachActiveStream(selectedAgent, savedActiveSession, newKey);
        }
      }
    } else {
      // First visit / empty buffer — show loading spinner, then load from DB
      beginLoad(newKey);
      setLoadingChat(true);
      setMessages([]);
      setHasMore(false);
      oldestMsgId.current = null;
      // Clear a stale empty entry so later visits don't treat it as "already loaded"
      msgBuffers.delete(newKey);

      if (chatMode === 'channel' || chatMode === 'dm') {
        const channelName = chatMode === 'dm'
          ? makeDmChannel(authUser?.id ?? '', activeDmUserId)
          : activeChannel;
        loadChannelMessages(channelName, newKey);
        if (!savedTabs || savedTabs.length === 0) setOpenSessionTabs([]);
      } else if (chatMode === 'direct' && selectedAgent) {
        loadSessions(selectedAgent).then(s => {
          if (currentConvKeyRef.current !== newKey) return;
          if (s.length > 0) {
            const mainSession = s.find(ss => ss.isMain);
            // Filter out sessions that the user explicitly closed
            const closedIds = getClosedTabs(selectedAgent!);
            const defaultTabs = mainSession
              ? [mainSession, ...s.filter(ss => !ss.isMain && !closedIds.has(ss.id)).slice(0, 4)]
              : s.filter(ss => !closedIds.has(ss.id)).slice(0, 5);
            let initialTabs = (savedTabs && savedTabs.length > 0) ? savedTabs : defaultTabs;
            // Prefer, in order: the in-memory buffer (survives tab switches within a
            // session), the localStorage value (survives a full page refresh), then
            // the main session. This keeps the user on the session they left off on.
            const storedActive = getStoredActiveSession(selectedAgent!);
            const restoreId = savedActiveSession !== undefined
              ? savedActiveSession
              : (storedActive ?? mainSession?.id ?? initialTabs[0]!.id);
            // If the session we want to restore exists on the server but isn't in the
            // default tab set (e.g. an older session), surface it as a tab so it can
            // be activated instead of silently falling back to the first tab.
            if (restoreId && restoreId !== NEW_CHAT_PLACEHOLDER_ID && !initialTabs.some(t => t.id === restoreId)) {
              const found = s.find(ss => ss.id === restoreId);
              if (found) initialTabs = [...initialTabs, found];
            }
            const validId = restoreId && initialTabs.some(t => t.id === restoreId) ? restoreId : initialTabs[0]!.id;
            setActiveSessionId(validId);
            activeSessionBuffer.set(newKey, validId);
            setStoredActiveSession(selectedAgent!, validId);
            setOpenSessionTabs(initialTabs);
            const restored = s.find(ss => ss.id === validId);
            const mo = restored?.metadata?.modelOverride;
            setSessionModelOverride(mo?.provider && mo?.model ? { provider: mo.provider, model: mo.model } : null);
            void loadSessionMessages(validId!, newKey).then(() => {
              if (currentConvKeyRef.current === newKey && selectedAgent) {
                void tryReattachActiveStream(selectedAgent, validId!, newKey);
              }
            });
          } else {
            setActiveSessionId(null);
            setSessionModelOverride(null);
            setLoadingChat(false);
            if (!savedTabs || savedTabs.length === 0) setOpenSessionTabs([]);
          }
        }).catch(() => {
          if (currentConvKeyRef.current === newKey) setLoadingChat(false);
        });
      } else {
        setLoadingChat(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, chatMode, selectedAgent, activeChannel, activeDmUserId, i18n.language, t]);

  // WS live updates for channel mode — buffer messages for ALL channels, not just the active one
  useEffect(() => {
    if (previewMode) return;
    const unsub = wsClient.on('chat:message', (event) => {
      const p = event.payload;
      const msgChannel = (p['channel'] as string) ?? '';
      if (!msgChannel) return;
      const senderType = (p['senderType'] as string) ?? 'agent';
      const wsText = (p['text'] as string) ?? (p['message'] as string) ?? '';
      const wsSenderId = (p['senderId'] as string) ?? (p['agentId'] as string) ?? '';
      const wsSenderName = (p['senderName'] as string) ?? (p['agentId'] as string) ?? t('page.fallbackAgent');
      const wsMeta = p['metadata'] as ChannelMsgMetadata | undefined;

      // Dedup: skip if we already inserted this message via HTTP response
      const serverMsgId = (p['messageId'] as string) ?? (p['id'] as string) ?? '';
      if (serverMsgId && recentMsgIds.current.has(serverMsgId)) return;

      const isSelf = senderType === 'human' && wsSenderId === (authUser?.id ?? '');
      const newMsg: ChatMsg = {
        id: serverMsgId || `ws_${Date.now()}_${wsSenderId}`,
        sender: isSelf ? 'user' : 'agent',
        text: wsText,
        time: new Date().toLocaleTimeString(),
        agentName: isSelf ? undefined : wsSenderName,
        agentId: isSelf ? undefined : wsSenderId,
        replyToId: (p['replyToId'] as string) ?? undefined,
        replyToSender: (p['replyToSender'] as string) ?? undefined,
        replyToText: (p['replyToText'] as string) ?? undefined,
      };

      if (wsMeta && senderType === 'agent') {
        const segs: MsgSegment[] = [];
        if (wsMeta.thinking?.length) {
          segs.push({ type: 'text', content: '', thinking: wsMeta.thinking.join('\n\n') });
        }
        if (wsMeta.toolCalls?.length) {
          for (let i = 0; i < wsMeta.toolCalls.length; i++) {
            const tc = wsMeta.toolCalls[i]!;
            segs.push({
              type: 'tool', key: `${tc.tool}_${i}`, tool: tc.tool,
              status: tc.status === 'error' ? 'error' : 'done',
              args: tc.arguments, result: tc.result, durationMs: tc.durationMs,
            });
          }
        }
        if (segs.length > 0) {
          segs.push({ type: 'text', content: wsText });
          newMsg.segments = segs;
        }
      }

      let key: string;
      if (msgChannel.startsWith('notes:')) {
        key = `dm:${msgChannel.slice(6)}`;
      } else if (msgChannel.startsWith('dm:')) {
        const parts = msgChannel.slice(3).split(':');
        const otherId = parts.find(id => id !== (authUser?.id ?? '')) ?? parts[0] ?? '';
        key = `dm:${otherId}`;
      } else {
        key = `ch:${msgChannel}`;
      }
      updateConvMsgs(key, prev => [...prev, newMsg]);

      // Track new messages arriving while user is scrolled up
      if (key === currentConvKeyRef.current && !userAtBottomRef.current) {
        newMsgCountRef.current += 1;
        setNewMsgCount(newMsgCountRef.current);
        setShowScrollBtn(true);
      }

      if (senderType === 'agent' && key === `ch:${activeChannel}`) {
        setThinkingAgents(prev => {
          const next = prev.filter(a => a.id !== wsSenderId);
          if (next.length === 0 && thinkingTimeoutRef.current) {
            clearTimeout(thinkingTimeoutRef.current);
            thinkingTimeoutRef.current = null;
          }
          return next;
        });
      }
    });
    return unsub;
  }, [previewMode, updateConvMsgs, authUser?.id, activeChannel]);

  // Remove agent from thinkingAgents when it decides not to respond
  useEffect(() => {
    if (previewMode) return;
    const unsub = wsClient.on('chat:agent_no_response', (event) => {
      const p = event.payload;
      const msgChannel = (p['channel'] as string) ?? '';
      const agentId = (p['agentId'] as string) ?? '';
      if (msgChannel && agentId && `ch:${activeChannel}` === `ch:${msgChannel}`) {
        setThinkingAgents(prev => {
          const next = prev.filter(a => a.id !== agentId);
          if (next.length === 0 && thinkingTimeoutRef.current) {
            clearTimeout(thinkingTimeoutRef.current);
            thinkingTimeoutRef.current = null;
          }
          return next;
        });
      }
    });
    return unsub;
  }, [previewMode, activeChannel]);

  // WS live updates for proactive agent/user messages (direct mode)
  useEffect(() => {
    if (previewMode) return;
    const unsub = wsClient.on('chat:proactive_message', (event) => {
      const p = event.payload;
      const targetUserId = p['targetUserId'] as string | undefined;
      if (targetUserId && targetUserId !== authUser?.id) return;
      const agentId = (p['agentId'] as string) ?? '';
      const agentName = (p['agentName'] as string) ?? t('page.fallbackAgent');
      const message = (p['message'] as string) ?? '';
      const sessionId = (p['sessionId'] as string) ?? '';
      const messageId = (p['messageId'] as string) ?? '';
      const meta = (p['metadata'] as Record<string, unknown>) ?? {};
      if (!agentId || !message) return;
      if (message === '[cancelled]' || message === '[Stream cancelled]') return;

      const isUserTurn = meta.role === 'user';
      const isActivity = !isUserTurn && (!!meta.activityLog || message.startsWith('[ACTIVITY:'));

      // Strip notify_context HTML comments from real-time messages
      const { cleaned: displayMessage, priority: parsedPriority } = stripNotifyContext(message);
      const isNotify = !isUserTurn && (!!meta.notifyUser || displayMessage !== message);

      // Session-aware routing: only display proactive messages in the correct
      // session context to prevent messages from appearing in unrelated sessions.
      const key = makeConvKey('direct', agentId, '', '');
      if (sessionId && currentConvKeyRef.current === key) {
        // We're viewing this agent — check if the message belongs to the active session
        const currentActive = activeSessionId;
        if (currentActive && currentActive !== NEW_CHAT_PLACEHOLDER_ID && currentActive !== sessionId) {
          // Message belongs to a different session than what's being viewed.
          // Buffer it silently — it will appear when user switches to that session.
          // Don't append to current view to avoid confusing cross-session messages.
          return;
        }
      }

      const isWsFallback = !!meta.isMainSession && !isUserTurn;
      const proactiveSession = sessionId || activeSessionId;
      const fallbackUserText = typeof meta.userText === 'string' ? meta.userText : '';
      const fallbackUserId = typeof meta.userMessageId === 'string' ? meta.userMessageId : '';
      // Bubble clock = message start time (WS envelope / server createdAt), not "now" on render.
      const createdAt =
        (typeof meta.createdAt === 'string' && meta.createdAt)
        || (typeof (event as { timestamp?: string }).timestamp === 'string'
          ? (event as { timestamp: string }).timestamp
          : undefined)
        || new Date().toISOString();
      const displayTime = (() => {
        try { return new Date(createdAt).toLocaleTimeString(); }
        catch { return new Date().toLocaleTimeString(); }
      })();

      const newMsg: ChatMsg = {
        id: messageId || `proactive_${Date.now()}`,
        sender: isUserTurn ? 'user' : 'agent',
        text: displayMessage,
        time: displayTime,
        rawCreatedAt: createdAt,
        ...(isUserTurn
          ? {}
          : {
              agentName,
              agentId,
              ...(isNotify ? { isNotification: true, notifyPriority: (meta.priority as string) ?? parsedPriority } : {}),
              ...(isActivity ? {
                isActivityLog: true,
                activityType: meta.activityType as string | undefined,
                outcome: meta.outcome as string | undefined,
                mailboxItemId: meta.mailboxItemId as string | undefined,
                taskId: meta.taskId as string | undefined,
                requirementId: meta.requirementId as string | undefined,
              } : {}),
              ...(!isActivity && meta.taskId ? { taskId: meta.taskId as string } : {}),
              ...(!isActivity && meta.requirementId ? { requirementId: meta.requirementId as string } : {}),
            }),
      };

      // Unread notify_user is surfaced as a bottom card — hide the bubble immediately
      // so it doesn't flash before the notifications refresh lands.
      if (isNotify && newMsg.id) {
        setHiddenNotifyMsgIds(prev => (prev.includes(newMsg.id) ? prev : [...prev, newMsg.id]));
      }

      // WS fallback messages (from SSE disconnect recovery) should replace the
      // last partial/stopped agent message rather than duplicating it.
      updateConvMsgs(key, prev => {
        if (prev.some(m => m.id === newMsg.id)) return prev;

        // Feishu assistant event may carry the inbound user text as a safety net.
        let base = prev;
        if (!isUserTurn && fallbackUserText) {
          const hasUser = base.some(m =>
            (fallbackUserId && m.id === fallbackUserId)
            || (m.sender === 'user' && m.text === fallbackUserText),
          );
          if (!hasUser) {
            base = [...base, {
              id: fallbackUserId || `feishu_user_${newMsg.id}`,
              sender: 'user' as const,
              text: fallbackUserText,
              time: new Date().toLocaleTimeString(),
            }];
          }
        }

        if (isWsFallback) {
          for (let i = base.length - 1; i >= 0; i--) {
            const msg = base[i]!;
            if (msg.sender === 'agent' && msg.agentId === agentId && msg.isStopped) {
              const updated = [...base];
              updated[i] = { ...newMsg, id: msg.id };
              return updated;
            }
          }
        }
        // Chronological insert — late notify WS must not always append after an
        // in-flight reply that started later (would look "inserted in the wrong place").
        return insertChatMsgByCreatedAt(base, newMsg);
      }, proactiveSession || undefined);
    });
    return unsub;
  }, [previewMode, updateConvMsgs, t, activeSessionId]);

  // ── Task helpers ─────────────────────────────────────────────────────────────
  const linkedTask = tasks.find(t => t.id === linkedTaskId);

  const createAndLinkTask = async () => {
    if (!selectedAgent) return;
    const title = newTaskTitle.trim() || (messages[0]?.text.slice(0, 60) ?? t('page.newTaskTitle'));
    try {
      await api.tasks.create(title, t('page.taskFromChat', { name: currentAgent?.name ?? t('page.fallbackAgent') }), selectedAgent, selectedAgent, 'medium');
      setNewTaskTitle('');
      setShowTaskPicker(false);
      // Reload tasks to get new ID
      const { tasks: updated } = await api.tasks.list();
      setTasks(updated);
      const newest = updated.find(t => t.title === title);
      if (newest) setLinkedTaskId(newest.id);
    } catch { /* ignore */ }
  };

  // Reset linked task when switching agents
  useEffect(() => { setLinkedTaskId(null); }, [selectedAgent]);

  // ── Sending ──────────────────────────────────────────────────────────────────
  const parseMentions = (text: string) => parseMentionNames(text);

  const stopSending = () => {
    // 1) Tell the backend to stop FIRST. Aborting the SSE alone is a soft
    // disconnect — the agent keeps working for up to SSE_DISCONNECT_FORCE_STOP_MS
    // unless cancel-processing marks userStopped.
    const agentId = chatMode === 'direct' ? selectedAgent : null;
    if (agentId) {
      void api.agents.cancelProcessing(agentId).catch(() => {});
    }

    // 2) Abort both the live send() stream and any reattachStream consumer.
    // Previously only abortControllerRef was cleared — after refresh/reattach
    // the stop button looked clickable but did nothing to the open SSE.
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    reattachAbortRef.current?.abort();
    reattachAbortRef.current = null;

    // 3) Unblock the UI immediately
    const sendKey = currentConvKeyRef.current;
    resetSending(sendKey);
    actBuffers.delete(activeSessionId ?? sendKey);
    if (activeSessionId) clearStreamSession(sendKey, activeSessionId);
    endStream(sendKey);
    setSending(false);
    setActivities([]);
  };

  const [rememberTarget, setRememberTarget] = useState<ChatMsg | null>(null);
  const [rememberBusy, setRememberBusy] = useState(false);

  const lastSendGuardRef = useRef<{ text: string; at: number } | null>(null);
  const send = async (retryText?: string, options?: { isRetry?: boolean; isResume?: boolean; sessionIdOverride?: string }) => {
    const ctxPrefix = (!retryText && chatContext.length > 0)
      ? chatContext.map(c => c.content).join('\n\n') + '\n\n'
      : '';
    const text = (retryText ?? (ctxPrefix + input)).trim();
    if (!text && pendingImages.length === 0) return;
    if (chatMode === 'direct' && !selectedAgent) return;
    resumeChatScrollFollow();

    // Ignore accidental double-submit of the same text (double Enter / double click).
    const now = Date.now();
    const prevSend = lastSendGuardRef.current;
    if (
      !options?.isRetry
      && !options?.isResume
      && text
      && prevSend
      && prevSend.text === text
      && now - prevSend.at < 1500
    ) {
      return;
    }
    lastSendGuardRef.current = { text, at: now };

    // If agent is currently streaming in this same conversation, interrupt it first.
    // If the user is in a DIFFERENT session (e.g., new chat tab) while another session
    // streams, DON'T abort — the agent's mailbox will queue or merge the new message.
    if (sending && chatMode === 'direct') {
      const isSameSession = activeSessionId && activeSessionId !== NEW_CHAT_PLACEHOLDER_ID;
      if (isSameSession) {
        const prevKey = currentConvKeyRef.current;
        const buf = msgBuffers.get(prevKey) ?? [];
        const lastUser = [...buf].reverse().find(m => m.sender === 'user');
        // Same text already in-flight — don't stack another user bubble; retry the turn.
        if (lastUser?.text === text && !options?.isRetry && !options?.isResume) {
          abortControllerRef.current?.abort();
          abortControllerRef.current = null;
          void api.agents.cancelProcessing(selectedAgent!).catch(() => {});
          resetSending(prevKey);
          actBuffers.delete(activeSessionId ?? prevKey);
          endStream(prevKey);
          // Drop the in-flight user+empty agent pair before the retry re-adds them.
          updateConvMsgs(prevKey, prev => {
            const u = [...prev];
            // Remove trailing empty/partial agent, then the matching user bubble.
            if (u.length > 0 && u[u.length - 1]!.sender === 'agent') u.pop();
            if (u.length > 0 && u[u.length - 1]!.sender === 'user' && u[u.length - 1]!.text === text) u.pop();
            return u;
          });
          setSending(false);
          setActivities([]);
          await new Promise(r => setTimeout(r, 50));
          return send(text, { isRetry: true });
        }
        // Same session: interrupt current stream and resend
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        void api.agents.cancelProcessing(selectedAgent!).catch(() => {});
        resetSending(prevKey);
        actBuffers.delete(activeSessionId ?? prevKey);
        endStream(prevKey);
        updateConvMsgs(prevKey, prev => {
          const u = [...prev];
          for (let i = u.length - 1; i >= 0; i--) {
            if (u[i]!.sender === 'agent' && !u[i]!.isStopped && !u[i]!.isError) {
              const msg = u[i]!;
              const hasContent = msg.text?.trim() || (msg.segments ?? []).some(s =>
                (s.type === 'text' && ((s as { content: string }).content || (s as { thinking?: string }).thinking)) || s.type === 'tool'
              );
              if (!hasContent) {
                u.splice(i, 1);
              } else {
                const segs = (msg.segments ?? []).map(s =>
                  s.type === 'tool' && s.status === 'running' ? { ...s, status: 'stopped' as const } : s
                );
                u[i] = { ...msg, isStopped: true, segments: segs };
              }
              break;
            }
          }
          return u;
        });
        setSending(false);
        setActivities([]);
        await new Promise(r => setTimeout(r, 50));
      }
      // For new session (NEW_CHAT_PLACEHOLDER_ID): don't abort. The message will be
      // sent to the agent's mailbox and queued. The agent will process it after
      // finishing the current stream, and the response will arrive via SSE or WS fallback.
    } else if (sending && chatMode !== 'direct') {
      // Non-direct mode (channel/dm): abort as before since channels are independent
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      const prevKey = currentConvKeyRef.current;
      resetSending(prevKey);
      actBuffers.delete(prevKey);
      endStream(prevKey);
      updateConvMsgs(prevKey, prev => {
        const u = [...prev];
        for (let i = u.length - 1; i >= 0; i--) {
          if (u[i]!.sender === 'agent' && !u[i]!.isStopped && !u[i]!.isError) {
            const msg = u[i]!;
            const hasContent = msg.text?.trim() || (msg.segments ?? []).some(s =>
              (s.type === 'text' && ((s as { content: string }).content || (s as { thinking?: string }).thinking)) || s.type === 'tool'
            );
            if (!hasContent) {
              u.splice(i, 1);
            } else {
              const segs = (msg.segments ?? []).map(s =>
                s.type === 'tool' && s.status === 'running' ? { ...s, status: 'stopped' as const } : s
              );
              u[i] = { ...msg, isStopped: true, segments: segs };
            }
            break;
          }
        }
        return u;
      });
      setSending(false);
      setActivities([]);
      await new Promise(r => setTimeout(r, 50));
    }

    const imagesToSend = pendingImages.length > 0 ? pendingImages.map(img => img.dataUrl) : undefined;
    const fileNamesToSend = pendingImages.length > 0 ? pendingImages.map(img => img.name) : undefined;
    const sendKey = makeConvKey(chatMode, selectedAgent, activeChannel, activeDmUserId);
    const replyCtx = chatReplyTo;

    if (!retryText) {
      setInput('');
      setChatContext([]);
    }
    setPendingImages([]);
    setMentionDropdown(false);
    setChatReplyTo(null);

    // Mark this conv as sending (skip for DM — instant DB write, no LLM wait)
    const isDm = chatMode === 'dm';
    incrementSending(sendKey);
    // Initialize activity buffer keyed by session (not convKey) to prevent cross-session pollution
    const actBufKey = activeSessionId ?? sendKey;
    actBuffers.set(actBufKey, []);
    if (currentConvKeyRef.current === sendKey && !isDm) {
      setSending(true);
      setActivities([]);
    }

    if (chatMode === 'dm') {
      // Human-to-human DM or personal notepad — store only, never route to agents/LLM.
      const dmChannel = makeDmChannel(authUser?.id ?? '', activeDmUserId);
      const optId = `opt_${Date.now()}`;
      const userMsgDm: ChatMsg = { id: optId, sender: 'user', text, time: new Date().toLocaleTimeString(), rawCreatedAt: new Date().toISOString() };
      if (imagesToSend?.length) userMsgDm.images = imagesToSend;
      if (replyCtx) { userMsgDm.replyToId = replyCtx.id; userMsgDm.replyToSender = replyCtx.sender; userMsgDm.replyToText = replyCtx.text; }
      updateConvMsgs(sendKey, prev => [...prev, userMsgDm]);
      try {
        const result = await api.channels.sendMessage(dmChannel, {
          text, senderName: authUser?.name ?? t('page.fallbackYou'),
          senderId: authUser?.id,
          mentions: [], orgId: 'default',
          humanOnly: true, // never route to agents
          ...(imagesToSend?.length ? { images: imagesToSend } : {}),
        });
        if (result.userMessage) addRecentMsgId(result.userMessage.id);
        updateConvMsgs(sendKey, prev => {
          const without = prev.filter(m => m.id !== optId);
          const newMsgs: ChatMsg[] = [];
          if (result.userMessage) newMsgs.push(channelMsgToChat(result.userMessage, authUser?.id));
          return newMsgs.length > 0 ? [...without, ...newMsgs] : prev;
        });
      } catch (e) {
        if (isMarkusCreditError(e)) dispatchCreditNotification();
        updateConvMsgs(sendKey, prev => {
          const without = prev.filter(m => m.id !== optId);
          return [...without, {
            id: `err_${Date.now()}`, sender: 'agent', text: t('page.errorWithMessage', { message: String(e) }),
            time: new Date().toLocaleTimeString(), agentName: t('page.systemName'), isError: true,
          }];
        });
      }
      decrementSending(sendKey);
      if (currentConvKeyRef.current === sendKey) setSending(false);
    } else if (chatMode === 'channel') {
      const optId = `opt_${Date.now()}`;
      const userMsgCh: ChatMsg = { id: optId, sender: 'user', text, time: new Date().toLocaleTimeString(), rawCreatedAt: new Date().toISOString() };
      if (replyCtx) { userMsgCh.replyToId = replyCtx.id; userMsgCh.replyToSender = replyCtx.sender; userMsgCh.replyToText = replyCtx.text; }
      updateConvMsgs(sendKey, prev => [...prev, userMsgCh]);

      // All agents in a group channel receive and process the message.
      // Mentioned agents are instructed to respond; others may stay silent.
      const mentions = parseMentions(text);
      const gc = groupChats.find(g => g.channelKey === activeChannel);
      if (activeChannel.startsWith('group:')) {
        const allGroupAgents: Array<{ id: string; name: string; avatarUrl?: string }> = [];
        if (gc?.members) {
          for (const m of gc.members) {
            if (m.type === 'agent') {
              const a = agents.find(ag => ag.id === m.id);
              if (a) allGroupAgents.push({ id: a.id, name: a.name, avatarUrl: a.avatarUrl });
            }
          }
        }
        if (allGroupAgents.length > 0) {
          if (thinkingTimeoutRef.current) clearTimeout(thinkingTimeoutRef.current);
          setThinkingAgents(allGroupAgents);
          thinkingTimeoutRef.current = setTimeout(() => setThinkingAgents([]), 120_000);
        }
      }

      try {
        // Persist/send only the user's text. Reply context is carried via replyToId
        // (server prefixes [REPLY] for the agent; UI shows the quote header from metadata).
        const result = await api.channels.sendMessage(activeChannel, {
          text, senderName: authUser?.name ?? t('page.fallbackYou'), mentions,
          senderId: authUser?.id,
          orgId: 'default',
          replyToId: replyCtx?.id,
        });
        if (result.userMessage) addRecentMsgId(result.userMessage.id);
        if (result.agentMessage) addRecentMsgId(result.agentMessage.id);
        updateConvMsgs(sendKey, prev => {
          const without = prev.filter(m => m.id !== optId);
          const newMsgs: ChatMsg[] = [];
          if (result.userMessage) newMsgs.push(channelMsgToChat(result.userMessage, authUser?.id));
          if (result.agentMessage) newMsgs.push(channelMsgToChat(result.agentMessage, authUser?.id));
          return newMsgs.length > 0 ? [...without, ...newMsgs] : prev;
        });
      } catch (e) {
        if (isMarkusCreditError(e)) dispatchCreditNotification();
        const friendly = friendlyAgentError(e, t) || t('page.errorWithMessage', { message: String(e) });
        updateConvMsgs(sendKey, prev => [...prev, {
          id: `err_${Date.now()}`, sender: 'agent', text: friendly,
          time: new Date().toLocaleTimeString(), agentName: t('page.systemName'), isError: true,
        }]);
        if (thinkingTimeoutRef.current) { clearTimeout(thinkingTimeoutRef.current); thinkingTimeoutRef.current = null; }
        setThinkingAgents([]);
      }
      decrementSending(sendKey);
      if (currentConvKeyRef.current === sendKey) setSending(false);
    } else {
      // direct — build an interleaved segment stream
      beginStream(sendKey);
      const sendNonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const agentMsgId = `a_${sendNonce}`;
      const optimisticUserId = `u_${sendNonce}`;
      // Mutable session ID that gets resolved when session_start event arrives
      let streamSessionId: string | null = options?.sessionIdOverride
        ?? (activeSessionId === NEW_CHAT_PLACEHOLDER_ID ? null : activeSessionId);
      if (options?.isResume) {
        // Resume: don't add a duplicate user message — just append the
        // agent continuation placeholder after the existing partial response.
        const agentCreatedAt = new Date().toISOString();
        updateConvMsgs(sendKey, prev => [
          ...prev,
          { id: agentMsgId, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt, segments: [] },
        ], streamSessionId);
      } else {
        const agentCreatedAt = new Date().toISOString();
        const userMsg: ChatMsg = { id: optimisticUserId, sender: 'user', text, time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt };
        if (imagesToSend?.length) userMsg.images = imagesToSend;
        if (replyCtx) { userMsg.replyToId = replyCtx.id; userMsg.replyToSender = replyCtx.sender; userMsg.replyToText = replyCtx.text; }
        updateConvMsgs(sendKey, prev => [
          ...prev,
          userMsg,
          { id: agentMsgId, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt, segments: [] },
        ], streamSessionId);
      }

      /** Track whether we're inside a <think> block across streaming chunks */
      let insideThink = false;

      /** Append a text chunk to the segment stream (RAF-batched to reduce re-renders) */
      const appendTextChunk = (chunk: string) => {
        lastSseEventTimeRef.current = Date.now();
        updateConvMsgsRaf(sendKey, prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx < 0) return prev;
          const segs = u[idx]!.segments ?? [];
          const last = segs[segs.length - 1];
          const prevThinking = last?.type === 'text' ? (last as { thinking?: string }).thinking ?? '' : '';

          let thinking = '';
          let content = '';
          let remaining = chunk;

          // Process the chunk character-by-character tracking think state.
          // Handles <think>...</think> that may span across multiple chunks.
          while (remaining.length > 0) {
            if (insideThink) {
              const closeIdx = remaining.indexOf('</think>');
              if (closeIdx >= 0) {
                thinking += remaining.slice(0, closeIdx);
                remaining = remaining.slice(closeIdx + '</think>'.length);
                insideThink = false;
              } else {
                thinking += remaining;
                remaining = '';
              }
            } else {
              const openIdx = remaining.indexOf('<think>');
              if (openIdx >= 0) {
                content += remaining.slice(0, openIdx);
                remaining = remaining.slice(openIdx + '<think>'.length);
                insideThink = true;
              } else {
                content += remaining;
                remaining = '';
              }
            }
          }

          const mergedThinking = (prevThinking + thinking) || undefined;

          const newSegs: MsgSegment[] = last?.type === 'text'
            ? [...segs.slice(0, -1), { type: 'text', content: last.content + content, thinking: mergedThinking, createdAt: last.createdAt }]
            : [...segs, { type: 'text', content, thinking: mergedThinking, createdAt: new Date().toISOString() }];
          u[idx] = { ...u[idx]!, text: u[idx]!.text + content, segments: newSegs };
          return u;
        }, streamSessionId);
      };

      /** Handle server-committed per-turn text/thinking entries (clean, non-fragmented) */
      const handleCommitEvent = (event: StreamCommitEvent) => {
        lastSseEventTimeRef.current = Date.now();
        // Capture sessionId early so subsequent messages continue in the same session
        // even if the stream is aborted before the final 'done' event.
        if (event.type === 'session_start' && event.sessionId) {
          // Resolve the stream's session ID — replace placeholder with real ID
          const prevStreamSessionId = streamSessionId;
          streamSessionId = event.sessionId;
          if (prevStreamSessionId && prevStreamSessionId !== event.sessionId) {
            clearStreamSession(sendKey, prevStreamSessionId);
          }
          setStreamSession(sendKey, event.sessionId);
          // Persist composer model pick onto the newly created session
          if (sessionModelOverride) {
            void api.sessions.setModelOverride(event.sessionId, sessionModelOverride).catch(() => {});
          }
          // Replace optimistic user id with the server-persisted id so reload/dedupe align.
          if (event.userMessageId && !options?.isResume) {
            updateConvMsgs(sendKey, prev => prev.map(m =>
              m.id === optimisticUserId ? { ...m, id: event.userMessageId! } : m
            ), event.sessionId);
          }
          // Seed the session cache with current buffer so streaming reads don't start empty
          const currentBuf = msgBuffers.get(sendKey);
          if (currentBuf && currentBuf.length > 0) {
            sessionMsgCache.set(event.sessionId, currentBuf);
          }
          if (currentConvKeyRef.current === sendKey) {
            // Only update activeSessionId if this stream's session matches what user expects.
            // If user was on __new_chat__ or the same session, update. Otherwise skip to
            // prevent a different session's stream from hijacking the user's view.
            const currentSess = activeSessionId;
            if (!currentSess || currentSess === NEW_CHAT_PLACEHOLDER_ID || currentSess === event.sessionId) {
              setActiveSessionId(event.sessionId);
              activeSessionBuffer.set(sendKey, event.sessionId);
              if (selectedAgent) setStoredActiveSession(selectedAgent, event.sessionId);
              setOpenSessionTabs(prev => {
                // Replace placeholder if exists; otherwise ensure the session tab is present
                if (prev.some(t => t.id === NEW_CHAT_PLACEHOLDER_ID)) {
                  return prev.map(t => t.id === NEW_CHAT_PLACEHOLDER_ID ? { ...t, id: event.sessionId! } : t);
                }
                if (!prev.some(t => t.id === event.sessionId)) {
                  return [...prev, { id: event.sessionId!, agentId: selectedAgent ?? '', userId: null, title: '', createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() }];
                }
                return prev;
              });
            }
          }
          return;
        }
        updateConvMsgs(sendKey, prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx < 0) return prev;
          const committed = [...(u[idx]!.committedSegments ?? [])];
          if (event.type === 'thinking_commit') {
            committed.push({ type: 'text', content: '', thinking: event.content, createdAt: event.createdAt });
          } else {
            committed.push({ type: 'text', content: event.content, createdAt: event.createdAt });
          }
          u[idx] = { ...u[idx]!, committedSegments: committed };
          return u;
        }, streamSessionId);
      };

      /** Handle a tool event: start adds a 'running' segment, end updates it, output appends live text */
      const handleToolEvent = (event: AgentToolEvent) => {
        lastSseEventTimeRef.current = Date.now();
        if (event.phase === 'heartbeat') return;
        if (event.phase === 'start' || event.phase === 'end') {
          appendConvActivity(sendKey, { ...event, phase: event.phase, ts: Date.now() }, streamSessionId);
        }
        if (event.phase === 'start') {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const segs = [...(u[idx]!.segments ?? [])];
            let updated = false;
            if (event.arguments) {
              for (let i = segs.length - 1; i >= 0; i--) {
                const s = segs[i]!;
                if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                  segs[i] = { ...s, args: event.arguments };
                  updated = true;
                  break;
                }
              }
            }
            const toolKey = `${event.tool}_${Date.now()}`;
            const now = new Date().toISOString();
            if (!updated) {
              segs.push({ type: 'tool', key: toolKey, tool: event.tool, status: 'running', args: event.arguments, createdAt: now });
            }
            const committed = [...(u[idx]!.committedSegments ?? [])];
            if (event.arguments !== undefined) {
              committed.push({ type: 'tool', key: toolKey, tool: event.tool, status: 'running', args: event.arguments, createdAt: now });
            }
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed };
            return u;
          }, streamSessionId);
        } else if (event.phase === 'output') {
          // RAF-batch high-frequency stdout chunks (same as text deltas).
          updateConvMsgsRaf(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const segs = [...(u[idx]!.segments ?? [])];
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                segs[i] = { ...s, liveOutput: appendLiveOutput(s.liveOutput, event.output ?? '') };
                break;
              }
            }
            u[idx] = { ...u[idx]!, segments: segs };
            return u;
          }, streamSessionId);
        } else if (event.phase === 'subagent_progress' && event.subagentEvent) {
          // RAF-batch nested progress; cap retained rows so long sub-agents don't balloon DOM.
          updateConvMsgsRaf(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const appendLog = (list: MsgSegment[]): MsgSegment[] => {
              const next = [...list];
              for (let i = next.length - 1; i >= 0; i--) {
                const s = next[i]!;
                if (s.type === 'tool' && (s.tool === 'spawn_subagent' || s.tool === 'spawn_subagents') && s.status === 'running') {
                  next[i] = { ...s, subagentLogs: appendSubagentLog(s.subagentLogs, event.subagentEvent!) };
                  break;
                }
              }
              return next;
            };
            const segs = appendLog(u[idx]!.segments ?? []);
            const committed = appendLog(u[idx]!.committedSegments ?? []);
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed };
            return u;
          }, streamSessionId);
        } else {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const now = new Date().toISOString();
            const segs = [...(u[idx]!.segments ?? [])];
            let endedSubagentLogs: Extract<MsgSegment, { type: 'tool' }>['subagentLogs'];
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                endedSubagentLogs = s.subagentLogs;
                segs[i] = { ...s, status: event.success === false ? 'error' : 'done', args: event.arguments, result: event.result, error: event.error, durationMs: event.durationMs, liveOutput: undefined, createdAt: now };
                break;
              }
            }
            const committed = [...(u[idx]!.committedSegments ?? [])];
            for (let i = committed.length - 1; i >= 0; i--) {
              const s = committed[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                // Prefer logs accumulated on the live segment (progress may have
                // arrived before this committed row existed).
                committed[i] = {
                  ...s,
                  status: event.success === false ? 'error' : 'done',
                  args: event.arguments,
                  result: event.result,
                  error: event.error,
                  durationMs: event.durationMs,
                  liveOutput: undefined,
                  createdAt: now,
                  subagentLogs: endedSubagentLogs ?? s.subagentLogs,
                };
                break;
              }
            }
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed };
            return u;
          }, streamSessionId);
        }
      };

      const abortCtrl = new AbortController();
      abortControllerRef.current = abortCtrl;
      const effectiveSessionId = options?.sessionIdOverride
        ?? (activeSessionId === NEW_CHAT_PLACEHOLDER_ID ? null : activeSessionId);
      const streamSessionAtStart = effectiveSessionId;
      // Add this session to the set of actively streaming sessions for this agent.
      if (streamSessionAtStart) {
        setStreamSession(sendKey, streamSessionAtStart);
      }

      try {
        lastSseEventTimeRef.current = Date.now();
        // Persist/send only the user's text. Reply context goes via replyTo metadata
        // so reload does not show the quoted agent message inside the user bubble.
        const streamResult = await api.agents.messageStream(
          selectedAgent, text,
          appendTextChunk,
          handleToolEvent,
          abortCtrl.signal,
          imagesToSend,
          effectiveSessionId,
          options?.isRetry,
          options?.isResume,
          handleCommitEvent,
          fileNamesToSend,
          replyCtx,
          sessionModelOverride,
        );
        if (currentConvKeyRef.current === sendKey) {
          // Message was merged into the agent's active processing — remove the
          // empty agent placeholder and the follow-up user bubble (server also
          // deletes that DB row so reload won't resurrect it).
          if (streamResult.merged) {
            updateConvMsgs(sendKey, prev => prev.filter(m =>
              m.id !== agentMsgId && m.id !== optimisticUserId
            ), streamSessionId);
          }

          // Apply server's authoritative final segments and content so the
          // rendered state matches the DB-persisted data.  This prevents a
          // blank bubble when delta-built segments have empty content (e.g.
          // thinking-only responses before text_delta arrives).
          if (!streamResult.merged && streamResult.segments?.length) {
            updateConvMsgs(sendKey, prev => {
              const u = [...prev];
              const idx = u.findIndex(m => m.id === agentMsgId);
              if (idx < 0) return prev;
              const finalSegs = storedSegmentsToMsgSegments(streamResult.segments!, u[idx]!.segments);
              let finalText = streamResult.content || u[idx]!.text;
              if (!finalText) {
                finalText = finalSegs
                  .filter(s => s.type === 'text')
                  .map(s => (s as { content: string }).content)
                  .join('');
              }
              const empty = !finalText?.trim() && !finalSegs.some(s =>
                (s.type === 'text' && (s.content || s.thinking)) || s.type === 'tool'
              );
              u[idx] = {
                ...u[idx]!,
                text: finalText,
                segments: finalSegs,
                committedSegments: finalSegs,
                isStopped: streamResult.cancelled || u[idx]!.isStopped,
                emptyReply: streamResult.emptyReply || empty || undefined,
                isError: streamResult.emptyReply || empty ? true : u[idx]!.isError,
              };
              return u;
            }, streamSessionId);
          }

          // Fallback for pure text responses where the server sends text_commit
          // events (no text_delta, no done.segments) — build final segments
          // from the committedSegments that were accumulated during streaming.
          if (!streamResult.merged && !streamResult.segments?.length) {
            updateConvMsgs(sendKey, prev => {
              const u = [...prev];
              const idx = u.findIndex(m => m.id === agentMsgId);
              if (idx < 0) return prev;
              const msg = u[idx]!;
              const committed = msg.committedSegments ?? [];
              const committedText = committed
                .filter((s): s is MsgSegment & { type: 'text' } => s.type === 'text' && !!s.content)
                .map(s => s.content)
                .join('');
              const finalText = committedText || streamResult.content || msg.text;
              const empty = !finalText?.trim() && committed.length === 0;
              if (committed.length > 0 || finalText || streamResult.cancelled || streamResult.emptyReply || empty) {
                u[idx] = {
                  ...msg,
                  text: finalText,
                  segments: committed.length > 0 ? committed : msg.segments,
                  isStopped: streamResult.cancelled || msg.isStopped,
                  emptyReply: streamResult.emptyReply || empty || undefined,
                  isError: (streamResult.emptyReply || empty) ? true : msg.isError,
                };
              }
              return u;
            }, streamSessionId);
          }

          if (streamResult.sessionId) {
            // Only update active session if user hasn't switched to a different session
            setActiveSessionId(prev => {
              if (!prev || prev === NEW_CHAT_PLACEHOLDER_ID || prev === streamResult.sessionId) {
                return streamResult.sessionId!;
              }
              return prev;
            });
            setOpenSessionTabs(prev => {
              // Replace placeholder if exists
              if (prev.some(t => t.id === NEW_CHAT_PLACEHOLDER_ID)) {
                return prev.map(t => t.id === NEW_CHAT_PLACEHOLDER_ID ? { ...t, id: streamResult.sessionId! } : t);
              }
              // Deduplicate: don't add if already present
              if (prev.some(t => t.id === streamResult.sessionId)) return prev;
              return [...prev, { id: streamResult.sessionId!, agentId: selectedAgent ?? '', userId: null, title: '', createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() }];
            });
          }
          loadSessions(selectedAgent).then(s => {
            if (currentConvKeyRef.current !== sendKey) return;
            setSessions(s);
            if (streamResult.sessionId) {
              const newSess = s.find(ss => ss.id === streamResult.sessionId);
              if (newSess) {
                setOpenSessionTabs(prev => {
                  const exists = prev.some(t => t.id === newSess.id);
                  if (exists) return prev.map(t => t.id === newSess.id ? newSess : t);
                  return [newSess, ...prev.filter(t => t.id !== NEW_CHAT_PLACEHOLDER_ID)];
                });
              }
            }
          });

          // Soft disconnect (refresh / browser killing the SSE): the fetch ends
          // without a terminal `done`, but the agent may still be running. Keep
          // nested subagent progress and reattach instead of freezing the bubble.
          const resumeSessionId = streamResult.sessionId
            ?? (streamSessionAtStart && streamSessionAtStart !== NEW_CHAT_PLACEHOLDER_ID
              ? streamSessionAtStart
              : null);
          if (
            !abortCtrl.signal.aborted
            && !streamResult.merged
            // `segments === undefined` means the SSE closed without a terminal `done`.
            && streamResult.segments === undefined
            && chatMode === 'direct'
            && selectedAgent
            && resumeSessionId
          ) {
            try {
              const st = await api.sessions.streamStatus(selectedAgent, resumeSessionId);
              // `active` stays true briefly after done/error (TTL) — only resume mid-run.
              if (st.status === 'streaming') {
                updateConvMsgs(sendKey, prev => prev.map(m =>
                  m.id === agentMsgId
                    ? {
                        ...m,
                        isStreaming: true,
                        isStopped: false,
                        segments: (m.segments ?? []).map(s =>
                          s.type === 'tool' && (s.status === 'stopped' || s.status === 'running')
                            ? { ...s, status: 'running' as const }
                            : s,
                        ),
                      }
                    : m,
                ), resumeSessionId);
                decrementSending(sendKey);
                if (abortControllerRef.current === abortCtrl) abortControllerRef.current = null;
                setStreamSession(sendKey, resumeSessionId);
                void tryReattachActiveStream(selectedAgent, resumeSessionId, sendKey);
                return;
              }
            } catch { /* fall through to normal cleanup */ }
          }
        }
      } catch (e) {
        // Preserve sessionId from error so subsequent messages stay in the same session
        const errSessionId = (e as Error & { sessionId?: string })?.sessionId;
        if (errSessionId && chatMode === 'direct' && currentConvKeyRef.current === sendKey) {
          setActiveSessionId(errSessionId);
          setOpenSessionTabs(prev =>
            prev.map(t => t.id === NEW_CHAT_PLACEHOLDER_ID ? { ...t, id: errSessionId } : t)
          );
          loadSessions(selectedAgent!).then(s => {
            if (currentConvKeyRef.current !== sendKey) return;
            setSessions(s);
            const newSess = s.find(ss => ss.id === errSessionId);
            if (newSess) {
              setOpenSessionTabs(prev => {
                const exists = prev.some(t => t.id === newSess.id);
                if (exists) return prev.map(t => t.id === newSess.id ? newSess : t);
                return [newSess, ...prev];
              });
            }
          });
        }

        if (isMarkusCreditError(e)) dispatchCreditNotification();

        const errText = friendlyAgentError(e, t);
        if (errText) {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx >= 0) {
              const segs = u[idx]!.segments ?? [];
              u[idx] = { ...u[idx]!, text: errText, isError: true,
                segments: [...segs, { type: 'text', content: errText }] };
            }
            return u;
          }, streamSessionId);
        } else {
          // User cancelled — keep partial content and mark as stopped
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx >= 0) {
              const msg = u[idx]!;
              const hasContent = msg.text
                || (msg.segments && msg.segments.length > 0 && msg.segments.some(s =>
                  (s.type === 'text' && ((s as { content: string }).content || (s as { thinking?: string }).thinking)) || s.type === 'tool'
                ));
              if (!hasContent) {
                return prev.filter(m => m.id !== agentMsgId);
              }
              u[idx] = { ...msg, isStopped: true };
            }
            return u;
          }, streamSessionId);
        }
      }

      // Mark any still-running tool segments as stopped (stream ended due to cancellation or disconnect)
      updateConvMsgs(sendKey, prev => {
        const u = [...prev];
        const idx = u.findIndex(m => m.id === agentMsgId);
        if (idx >= 0) {
          const segs = (u[idx]!.segments ?? []).map(s =>
            s.type === 'tool' && s.status === 'running' ? { ...s, status: 'stopped' as const } : s
          );
          u[idx] = { ...u[idx]!, segments: segs };
        }
        return u;
      }, streamSessionId);

      // If stream was aborted by user (api resolves rather than rejects on abort) —
      // keep partial content and mark as stopped. The catch block handles the rejection path.
      if (abortCtrl.signal.aborted) {
        updateConvMsgs(sendKey, prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx >= 0) {
            const msg = u[idx]!;
            const hasContent = msg.text
              || (msg.segments && msg.segments.length > 0 && msg.segments.some(s =>
                (s.type === 'text' && ((s as { content: string }).content || (s as { thinking?: string }).thinking)) || s.type === 'tool'
              ));
            if (!hasContent) {
              return prev.filter(m => m.id !== agentMsgId);
            }
            u[idx] = { ...msg, isStopped: true };
          }
          return u;
        }, streamSessionId);
      }

      // Fallback: if the agent message is empty (SSE connection may have dropped),
      // poll the session messages to recover the persisted reply.
      // Use the actual session ID from the stream result (or activeSessionId) instead
      // of blindly fetching the "latest" session which could be a different conversation.
      const currentMsgs = msgBuffers.get(sendKey) ?? [];
      const agentMsg = currentMsgs.find(m => m.id === agentMsgId);
      const pollSessionId = activeSessionId && activeSessionId !== NEW_CHAT_PLACEHOLDER_ID ? activeSessionId : null;
      const hasVisibleContent = agentMsg?.text || (agentMsg?.segments?.some(s =>
        (s.type === 'text' && (s as { content: string }).content) || s.type === 'tool'
      ));
      if (agentMsg && !hasVisibleContent && chatMode === 'direct' && pollSessionId && !abortCtrl.signal.aborted) {
        const pollForReply = async (retries: number, delayMs: number) => {
          for (let i = 0; i < retries; i++) {
            await new Promise(r => setTimeout(r, delayMs));
            try {
              const result = await api.sessions.getMessages(pollSessionId, 2);
              const assistantMsg = result.messages.find(m => m.role === 'assistant');
              if (assistantMsg?.content) {
                const recovered = dbMsgToChat(assistantMsg);
                updateConvMsgs(sendKey, prev => {
                  const u = [...prev];
                  const idx = u.findIndex(m => m.id === agentMsgId);
                  if (idx >= 0) {
                    u[idx] = {
                      ...u[idx]!,
                      text: recovered.text,
                      segments: recovered.segments,
                    };
                  }
                  return u;
                }, streamSessionId);
                return;
              }
            } catch { /* retry */ }
          }
        };
        // Await polling so `sending` stays true (and the streaming animation
        // remains visible) while we recover the reply from the DB.
        await pollForReply(5, 3000);
      }

      // Only clean up if this invocation is still the active sender.
      // When a newer send() has taken over (user interrupted), abortControllerRef
      // already points to the new controller — skip cleanup to avoid killing
      // the new stream's state.
      const newCount = decrementSending(sendKey);
      if (streamSessionId) clearStreamSession(sendKey, streamSessionId);
      endStream(sendKey);
      if (abortControllerRef.current === abortCtrl || abortControllerRef.current === null) {
        abortControllerRef.current = null;
        actBuffers.delete(streamSessionId ?? sendKey);
        if (currentConvKeyRef.current === sendKey) {
          setSending(newCount > 0);
          if (newCount === 0) setActivities([]);
        }
      } else {
        actBuffers.delete(streamSessionId ?? sendKey);
      }
    }
  };
  sendRef.current = send;

  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [retryConfirm, setRetryConfirm] = useState<{
    retryMsg: ChatMsg;
    userMsg: ChatMsg | null;
    retryText: string;
    followCount: number;
  } | null>(null);

  const lastAgentMsgId = useMemo(() => {
    for (let j = messages.length - 1; j >= 0; j--) {
      if (messages[j]?.sender === 'agent' && !messages[j]?.isActivityLog) return messages[j]!.id;
    }
    return null;
  }, [messages]);

  const handleCopy = useCallback((msg: ChatMsg) => {
    const text = msg.segments
      ? msg.segments.filter(s => s.type === 'text').map(s => (s as { content: string }).content).join('\n')
      : msg.text;
    void navigator.clipboard.writeText(text);
    setCopiedMsgId(msg.id);
    setTimeout(() => setCopiedMsgId(prev => prev === msg.id ? null : prev), 2000);
  }, []);

  const executeRetry = useCallback((retryMsg: ChatMsg, userMsg: ChatMsg | null, retryText: string) => {
    const convKey = currentConvKeyRef.current;
    const currentMsgs = msgBuffers.get(convKey) ?? messages;
    const retryIdx = currentMsgs.findIndex(m => m.id === retryMsg.id);
    if (retryIdx < 0) return;
    // Remove the agent bubble, all messages after it, and (if immediately preceding) the user message
    const removeUserToo = userMsg && retryIdx > 0 && currentMsgs[retryIdx - 1]?.id === userMsg.id;
    updateConvMsgs(convKey, prev => {
      const idx = prev.findIndex(m => m.id === (removeUserToo ? userMsg!.id : retryMsg.id));
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });
    void send(retryText, { isRetry: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, updateConvMsgs]);

  const handleRetry = useCallback((retryMsg: ChatMsg) => {
    const convKey = currentConvKeyRef.current;
    const currentMsgs = msgBuffers.get(convKey) ?? messages;
    const retryIdx = currentMsgs.findIndex(m => m.id === retryMsg.id);
    if (retryIdx < 0) return;
    // Search backwards for the nearest user message
    let userMsg: ChatMsg | null = null;
    for (let i = retryIdx - 1; i >= 0; i--) {
      if (currentMsgs[i]?.sender === 'user') { userMsg = currentMsgs[i]!; break; }
    }
    const retryText = userMsg?.text ?? '';
    if (!retryText) return;

    const hasFollowingMsgs = retryIdx < currentMsgs.length - 1;
    if (hasFollowingMsgs) {
      const followCount = currentMsgs.length - 1 - retryIdx;
      setRetryConfirm({ retryMsg, userMsg, retryText, followCount });
      return;
    }

    executeRetry(retryMsg, userMsg, retryText);
  }, [messages, executeRetry]);

  const handleResume = useCallback((resumeMsg: ChatMsg) => {
    const convKey = currentConvKeyRef.current;
    const currentMsgs = msgBuffers.get(convKey) ?? messages;
    const resumeIdx = currentMsgs.findIndex(m => m.id === resumeMsg.id);
    if (resumeIdx < 0) return;

    // Trim the last incomplete segment from the agent bubble (stopped tools,
    // trailing empty text) but keep all completed content.
    updateConvMsgs(convKey, prev => {
      const u = [...prev];
      const idx = u.findIndex(m => m.id === resumeMsg.id);
      if (idx < 0) return prev;
      const msg = u[idx]!;
      const segs = [...(msg.segments ?? [])];
      while (segs.length > 0) {
        const last = segs[segs.length - 1]!;
        if (last.type === 'tool' && (last.status === 'stopped' || last.status === 'running')) {
          segs.pop();
        } else if (last.type === 'text' && !(last as { content: string }).content) {
          segs.pop();
        } else {
          break;
        }
      }
      u[idx] = { ...msg, segments: segs, isStopped: false, isError: false };
      return u;
    });

    // Send a hidden continuation prompt — the backend will keep the existing
    // session context and let the LLM pick up where it left off.
    void send('[Continue from where you left off. Do not repeat content already generated.]', { isResume: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, updateConvMsgs]);

  const handleReplyMsg = useCallback((msg: ChatMsg) => {
    const senderName = msg.sender === 'user' ? (authUser?.name ?? t('page.fallbackYou')) : (msg.agentName ?? t('page.fallbackAgent'));
    setChatReplyTo({ id: msg.id, sender: senderName, text: msg.text });
    // Auto-insert @mention when replying to an agent in a group channel
    if (chatMode === 'channel' && msg.sender === 'agent' && msg.agentName) {
      const mention = `@${msg.agentName} `;
      setInput(prev => prev.startsWith(mention) ? prev : mention + prev);
    }
    textareaRef.current?.focus();
  }, [authUser?.name, chatMode, t]);

  const handleRememberConfirm = async (userNote: string) => {
    if (!rememberTarget || !selectedAgent || chatMode !== 'direct') return;
    const parentSessionId = activeSessionId;
    if (!parentSessionId || parentSessionId === NEW_CHAT_PLACEHOLDER_ID) return;
    setRememberBusy(true);
    try {
      const result = await api.agents.evolveFromMessage(selectedAgent, {
        parentSessionId,
        sourceMessageId: rememberTarget.id.startsWith('a_') || rememberTarget.id.startsWith('u_')
          ? undefined
          : rememberTarget.id,
        sourceText: (rememberTarget.text || '').slice(0, 500) || undefined,
        userNote: userNote.trim() || undefined,
      });
      const nowIso = new Date().toISOString();
      const childSession: ChatSessionInfo = {
        id: result.sessionId,
        agentId: selectedAgent,
        userId: authUser?.id ?? null,
        title: 'Remember / Evolution',
        isMain: false,
        metadata: {
          kind: 'evolution',
          parentSessionId: result.parentSessionId,
          sourceMessageId: rememberTarget.id,
          sourceAgentId: selectedAgent,
          createdFrom: 'remember_button',
        },
        createdAt: nowIso,
        lastMessageAt: nowIso,
      };
      setRememberTarget(null);
      setSessions(prev => [childSession, ...prev.filter(s => s.id !== childSession.id)]);
      setOpenSessionTabs(prev => prev.some(t => t.id === childSession.id) ? prev : [...prev, childSession]);
      setActiveSessionId(childSession.id);
      const key = makeConvKey('direct', selectedAgent, activeChannel, activeDmUserId);
      activeSessionBuffer.set(key, childSession.id);
      setStoredActiveSession(selectedAgent, childSession.id);
      resetConv(key);
      setMessages([]);
      setHasMore(false);
      oldestMsgId.current = null;
      await send(result.seedPrompt, { sessionIdOverride: result.sessionId });
    } catch (err) {
      console.error('evolve-from-message failed', err);
    } finally {
      setRememberBusy(false);
    }
  };

  const switchSession = async (s: ChatSessionInfo) => {
    const prevSessionId = activeSessionId;
    setActiveSessionId(s.id);
    setShowSessions(false);
    setHasMore(false);
    oldestMsgId.current = null;
    resumeChatScrollFollow();
    setShowScrollBtn(false);
    newMsgCountRef.current = 0;
    setNewMsgCount(0);
    // Sync sending visual with the target session:
    // - If stream belongs to THIS session → show spinner
    // - If stream belongs to a DIFFERENT session → suppress spinner
    const key = currentConvKeyRef.current;
    const streamingSessions = getStreamSession(key);
    const streamForThis = !!streamingSessions && (streamingSessions.has(s.id) || streamingSessions.has(NEW_CHAT_PLACEHOLDER_ID));
    const isStreaming = isSendingFor(key) && streamForThis;
    setSending(isStreaming);
    if (isStreaming) {
      setActivities(actBuffers.get(s.id) ?? []);
    } else {
      setActivities([]);
    }
    activeSessionBuffer.set(key, s.id);
    if (selectedAgent) setStoredActiveSession(selectedAgent, s.id);
    if (prevSessionId && prevSessionId !== NEW_CHAT_PLACEHOLDER_ID) {
      saveSessionToCache(key, prevSessionId);
    }
    restoreSessionFromCache(key, s.id);
    setOpenSessionTabs(prev => prev.some(t => t.id === s.id) ? prev : [...prev, s]);
    // Remove from closed-tabs list since user explicitly opened it
    if (selectedAgent) removeClosedTab(selectedAgent, s.id);
    // Always attempt DB load to sync with server. The phase-aware loadSessionMessages
    // blocks display writes during streaming, preventing race conditions.
    await loadSessionMessages(s.id, key);
    const mo = s.metadata?.modelOverride;
    setSessionModelOverride(mo?.provider && mo?.model ? { provider: mo.provider, model: mo.model } : null);
    if (selectedAgent && !isStreaming) {
      void tryReattachActiveStream(selectedAgent, s.id, key);
    }
  };

  const closeSessionTab = (sessionId: string) => {
    setOpenSessionTabs(prev => prev.filter(t => t.id !== sessionId));
    // Persist closure so this tab doesn't reappear on page refresh
    if (selectedAgent && sessionId !== NEW_CHAT_PLACEHOLDER_ID) {
      addClosedTab(selectedAgent, sessionId);
    }
    if (activeSessionId === sessionId) {
      const remaining = openSessionTabs.filter(t => t.id !== sessionId);
      if (remaining.length > 0) {
        void switchSession(remaining[remaining.length - 1]!);
      } else {
        newConversation();
      }
    }
  };

  const executeSearch = useCallback(async (q: string) => {
    if (q.length < 2) { setSearchResults([]); return; }
    setSearchLoading(true);
    try {
      const scope = chatMode === 'channel' ? 'channel' : chatMode === 'direct' ? 'direct' : 'all';
      const channel = chatMode === 'channel' ? activeChannel : undefined;
      const { results } = await api.messages.search(q, { scope, channel, limit: 30 });
      setSearchResults(results);
    } catch { setSearchResults([]); }
    setSearchLoading(false);
  }, [chatMode, activeChannel]);

  const handleSearchInput = useCallback((q: string) => {
    setSearchQuery(q);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => executeSearch(q), 300);
  }, [executeSearch]);

  const handleSearchResultClick = useCallback((result: import('../api.ts').SearchResult) => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    if (result.source === 'channel' && result.channel) {
      setChatMode('channel');
      setActiveChannel(result.channel);
    } else if (result.source === 'direct' && result.agentId) {
      setChatMode('direct');
      setSelectedAgent(result.agentId);
    }
    setTimeout(() => {
      const el = document.getElementById(`msg-${result.id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('bg-brand-500/10');
        setTimeout(() => el.classList.remove('bg-brand-500/10'), 2000);
      }
    }, 500);
  }, []);

  const newConversation = () => {
    setActiveSessionId(NEW_CHAT_PLACEHOLDER_ID);
    const key = currentConvKeyRef.current;
    resetConv(key);
    setMessages([]);
    setHasMore(false);
    oldestMsgId.current = null;
    setShowSessions(false);
    // Add a placeholder "New Chat" tab
    setOpenSessionTabs(prev => {
      const without = prev.filter(t => t.id !== NEW_CHAT_PLACEHOLDER_ID);
      return [{
        id: NEW_CHAT_PLACEHOLDER_ID,
        agentId: selectedAgent ?? '',
        userId: null,
        title: t('page.newChat'),
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      }, ...without];
    });
  };

  const handleInputChange = (val: string) => {
    setInput(val);

    const cursorPos = textareaRef.current?.selectionStart ?? val.length;
    const textBeforeCursor = val.slice(0, cursorPos);

    const atIdx = textBeforeCursor.lastIndexOf('@');
    if (atIdx >= 0) {
      const charBefore = atIdx === 0 ? '' : textBeforeCursor[atIdx - 1]!;
      const isValidPosition = atIdx === 0 || /[\s\n,，。！？!?;；:：、（）()\[\]【】]/.test(charBefore);
      if (isValidPosition) {
        const fragment = textBeforeCursor.slice(atIdx + 1);
        if (!fragment.includes(' ') && !fragment.includes('\n')) {
          loadEntityMentions();
          setMentionDropdown(true);
          setMentionFilter(fragment.toLowerCase());
          setMentionSelectedIndex(0);
          return;
        }
      }
    }
    setMentionDropdown(false);
  };

  const insertMention = (name: string, entityType?: string, entityId?: string) => {
    const cursorPos = textareaRef.current?.selectionStart ?? input.length;
    const before = input.slice(0, cursorPos);
    const atIdx = before.lastIndexOf('@');
    const after = input.slice(cursorPos);
    const mention = entityType && entityId
      ? `@[${name}](${entityType}:${entityId})`
      : name.includes(' ') ? `@[${name}]` : `@${name}`;
    const newVal = input.slice(0, atIdx) + mention + ' ' + after;
    setInput(newVal);
    setMentionDropdown(false);
    setMentionSelectedIndex(0);
    const newCursor = atIdx + mention.length + 1;
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(newCursor, newCursor);
    });
  };

  // ── File attachment handling ─────────────────────────────────────────────────
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const MAX_FILES = 5;
  const SUPPORTED_DOC_TYPES = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'application/msword',
    'text/csv',
    'text/html',
    'application/json',
    'application/xml',
    'text/xml',
    'application/epub+zip',
  ]);

  const isFileSupported = useCallback((f: File) => {
    return f.type.startsWith('image/') || SUPPORTED_DOC_TYPES.has(f.type);
  }, []);

  const isImageFile = (f: { name: string; dataUrl: string }) => {
    return f.dataUrl.startsWith('data:image/');
  };

  const getFileIcon = (name: string, dataUrl: string) => {
    if (isImageFile({ name, dataUrl })) return null;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const iconMap: Record<string, string> = {
      pdf: '📄', docx: '📝', doc: '📝', xlsx: '📊', xls: '📊',
      pptx: '📎', csv: '📊', json: '🔧', xml: '🔧', html: '🌐', epub: '📚',
    };
    return iconMap[ext] ?? '📁';
  };

  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArr = Array.from(files).filter(isFileSupported);
    if (fileArr.length === 0) return;
    for (const file of fileArr) {
      if (file.size > MAX_FILE_SIZE) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setPendingImages(p => {
          if (p.length >= MAX_FILES) return p;
          if (p.some(img => img.dataUrl === dataUrl)) return p;
          return [...p, { id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, dataUrl, name: file.name }];
        });
      };
      reader.readAsDataURL(file);
    }
  }, [isFileSupported]);

  const removeImage = useCallback((id: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== id));
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      const supported = Array.from(files).filter(isFileSupported);
      if (supported.length > 0) {
        e.preventDefault();
        addFiles(supported);
      }
    }
  }, [addFiles, isFileSupported]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      addFiles(Array.from(files).filter(isFileSupported));
    }
  }, [addFiles, isFileSupported]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────────
  const currentAgent = agents.find(a => a.id === selectedAgent);
  const currentUserName = authUser?.name ?? t('page.fallbackYou');
  const lastMsg = visibleMessages[visibleMessages.length - 1];
  const isLastPending = sending && lastMsg?.sender === 'agent';
  const isLastVisualStreaming = streamingVisual && lastMsg?.sender === 'agent';
  const channelTeamMemberIds = useMemo(() => {
    if (chatMode !== 'channel') return null;
    if (activeChannel.startsWith('group:custom:')) {
      const gc = groupChats.find(g => g.channelKey === activeChannel);
      if (gc?.members) return new Set(gc.members.filter(m => m.type === 'agent').map(m => m.id));
      return null;
    }
    if (!activeTeamId) return null;
    const team = teams.find(t => t.id === activeTeamId);
    if (!team) return null;
    return new Set(team.members.filter(m => m.type === 'agent').map(m => m.id));
  }, [chatMode, activeChannel, activeTeamId, teams, groupChats]);
  const filteredAgents = agents
    .filter(a => channelTeamMemberIds ? channelTeamMemberIds.has(a.id) : true)
    .filter(a => a.name.toLowerCase().includes(mentionFilter));
  const filteredEntityItems = entityMentionItems.filter(e => e.name.toLowerCase().includes(mentionFilter));
  const ENTITY_TYPE_ICON: Record<string, string> = { workflow: '⚙️', project: '📁', requirement: '📋', task: '✅', deliverable: '📦' };
  type MentionDropdownItem = { kind: 'agent'; agent: AgentInfo } | { kind: 'entity'; entity: EntityMentionItem };
  const allMentionItems: MentionDropdownItem[] = useMemo(() => [
    ...filteredAgents.map(a => ({ kind: 'agent' as const, agent: a })),
    ...filteredEntityItems.map(e => ({ kind: 'entity' as const, entity: e })),
  ], [filteredAgents, filteredEntityItems]);

  const activeDmUser = humans.find(h => h.id === activeDmUserId);
  const isSelfDm = activeDmUserId === authUser?.id || !activeDmUserId;

  const activeGroupChat = groupChats.find(gc => gc.channelKey === activeChannel);

  // Fetch custom group chat details (with member list) when selected
  useEffect(() => {
    if (previewMode) return;
    if (!activeChannel.startsWith('group:custom:')) return;
    const gc = groupChats.find(g => g.channelKey === activeChannel);
    if (!gc || gc.members) return;
    api.groupChats.getById(gc.id).then(d => {
      if (d.chat.members) {
        setGroupChats(prev => prev.map(g => g.id === gc.id ? { ...g, members: d.chat.members } : g));
      }
    }).catch(() => {});
  }, [previewMode, activeChannel, groupChats]);

  // Load pending request_user_input requests for the agent in the active direct chat.
  const refreshUserInputs = useCallback(async () => {
    if (previewMode || chatMode !== 'direct' || !selectedAgent) { setUserInputApprovals([]); return; }
    try {
      // Bypass GET dedup cache — otherwise a pre-approval poll (empty list) can
      // shadow the WS-driven refresh for up to DEDUP_TTL_MS and hide the chat card.
      invalidateApiCache('/approvals');
      const { approvals } = await api.approvals.list('pending');
      setUserInputApprovals(approvals.filter(a =>
        a.status === 'pending' &&
        Array.isArray(a.questions) && a.questions.length > 0 &&
        ((a.details?.agentId as string | undefined) ?? a.agentId) === selectedAgent,
      ));
    } catch { /* */ }
  }, [previewMode, chatMode, selectedAgent]);

  // Load unread notify_user cards for the active session (mirrors user-input cards).
  const refreshSessionNotifies = useCallback(async () => {
    if (
      previewMode
      || chatMode !== 'direct'
      || !selectedAgent
      || !activeSessionId
      || activeSessionId === NEW_CHAT_PLACEHOLDER_ID
    ) {
      setSessionNotifyCards([]);
      return;
    }
    try {
      invalidateApiCache('/notifications');
      const { notifications } = await api.notifications.list(authUser?.id, true, {
        type: 'agent_report',
        limit: 30,
      });
      const cards = notifications
        .filter(n =>
          !n.read
          && n.type === 'agent_report'
          && !n.metadata?.creditExhausted
          && ((n.metadata?.agentId as string | undefined) === selectedAgent)
          && notifySessionId(n) === activeSessionId,
        )
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5);
      setSessionNotifyCards(cards);
      // Authoritative hide-set from unread cards (clears stale optimistic ids after read).
      setHiddenNotifyMsgIds(
        cards
          .map(n => n.metadata?.messageId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      );
    } catch { /* */ }
  }, [previewMode, chatMode, selectedAgent, activeSessionId, authUser?.id]);

  useEffect(() => {
    refreshUserInputs();
    refreshSessionNotifies();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void refreshUserInputs();
        void refreshSessionNotifies();
      }, 400);
    };
    const unsubA = wsClient.on('approval:requested', scheduleRefresh);
    const unsubN = wsClient.on('notification', scheduleRefresh);
    // Keep the in-chat card in sync when the user responds from another surface
    // (e.g. the notification bell modal) — the resolved approval drops out of the
    // pending list and the card disappears instead of looking re-submittable.
    const onNotifChanged = () => scheduleRefresh();
    window.addEventListener('markus:notifications-changed', onNotifChanged);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubA();
      unsubN();
      window.removeEventListener('markus:notifications-changed', onNotifChanged);
    };
  }, [refreshUserInputs, refreshSessionNotifies]);

  const handleUserInputSubmit = useCallback(async (
    approvalId: string,
    r: { approved: boolean; comment?: string; selectedOption?: string; answers?: UserInputAnswer[] },
  ) => {
    setRespondingInputId(approvalId);
    try {
      await api.approvals.respond(approvalId, r.approved, authUser?.id, r.comment, r.selectedOption, r.answers);
      setUserInputApprovals(prev => prev.filter(a => a.id !== approvalId));
      setActiveInputModal(null);
      window.dispatchEvent(new CustomEvent('markus:notifications-changed'));
    } catch { /* */ }
    setRespondingInputId(null);
  }, [authUser?.id]);

  const handleNotifyAcknowledge = useCallback(async (notificationId: string) => {
    setAcknowledgingNotifyId(notificationId);
    try {
      const card = sessionNotifyCards.find(n => n.id === notificationId) ?? activeNotifyModal;
      const messageId = typeof card?.metadata?.messageId === 'string' ? card.metadata.messageId : null;
      await api.notifications.markRead(notificationId);
      setSessionNotifyCards(prev => prev.filter(n => n.id !== notificationId));
      if (messageId) {
        setHiddenNotifyMsgIds(prev => prev.filter(id => id !== messageId));
      }
      setActiveNotifyModal(null);
      window.dispatchEvent(new CustomEvent('markus:notifications-changed'));
    } catch { /* */ }
    setAcknowledgingNotifyId(null);
  }, [sessionNotifyCards, activeNotifyModal]);

  const modeTitle =
    chatMode === 'channel' ? (activeGroupChat?.name ?? activeChannel) :
    chatMode === 'direct'  ? (currentAgent?.name ?? t('page.selectAgent')) :
    chatMode === 'dm'      ? (isSelfDm ? t('chat.myNotes') : (activeDmUser?.name ?? t('page.directMessage'))) :
    t('page.chatTitle');

  const directGreetingIdx = useMemo(() => Math.floor(Math.random() * 5), [selectedAgent, activeSessionId]);
  const emptyGreeting = selectedAgent ? t(`page.placeholder.directOptions.${directGreetingIdx}`) : '';
  const isAgentOffline = chatMode === 'direct' && !!currentAgent && currentAgent.status === 'offline';
  const placeholder =
    chatMode === 'channel' ? (activeGroupChat ? t('page.placeholder.channel', { name: activeGroupChat.name }) : t('page.placeholder.channelWithMention', { name: activeChannel })) :
    chatMode === 'dm'      ? (isSelfDm ? t('page.placeholder.dmSelf') : t('page.placeholder.dmOther', { name: activeDmUser?.name ?? '' })) :
    isAgentOffline ? t('page.placeholder.agentOffline') :
    selectedAgent ? t('page.placeholder.direct') : t('page.placeholder.noAgent');

  // ── Render ────────────────────────────────────────────────────────────────────
  const showChatOnMobile = isMobile && mobileLayer === 'chat';
  const isEmptyChat = mainTab === 'chat' && visibleMessages.length === 0 && !sending && !loadingChat;
  // Non-empty sessions: Cursor-style single-line composer that grows with content.
  const compactComposer = mainTab === 'chat' && visibleMessages.length > 0;
  compactComposerRef.current = compactComposer;
  // Typed / attached content → full-width textarea; model + send on a dedicated bottom row.
  const composerExpanded = Boolean(input.trim() || pendingImages.length > 0);

  return (
    <div ref={teamContainerRef} className="flex-1 overflow-hidden flex relative">
      {/* ── Left sidebar (ChatTeamSidebar) — L1 (hidden in preview fullscreen) ── */}
      {!rightPanelFullscreen && <ChatTeamSidebar
        authUser={authUser}
        agents={agents}
        teams={teams}
        humans={humans}
        tasks={tasks}
        externalAgents={externalAgents}
        groupChats={groupChats}
        chatMode={chatMode}
        selectedAgent={selectedAgent}
        activeChannel={activeChannel}
        activeDmUserId={activeDmUserId}
        previewMode={previewMode}
        onSelectAgent={(agentId) => { setChatMode('direct'); setSelectedAgent(agentId); setMainTab('chat'); setShowMemberPanel(false); if (isMobile) enterMobileDetail(); }}
        onSelectChannel={(channelKey) => { setChatMode('channel'); setActiveChannel(channelKey); setMainTab('chat'); setShowMemberPanel(false); if (isMobile) enterMobileDetail(); }}
        onSelectDm={(userId) => { setChatMode('dm'); setActiveDmUserId(userId); setMainTab('chat'); setShowMemberPanel(false); if (isMobile) enterMobileDetail(); }}
        onSelectTeam={(teamId) => {
          // Team channels are synthetic `group:{teamId}` — do not depend on a refreshed
          // groupChats entry (that race made brand-new teams unclickable until reload).
          const teamGc = groupChats.find(gc => gc.type === 'team' && gc.teamId === teamId);
          const channelKey = teamGc?.channelKey ?? `group:${teamId}`;
          if (isMobile) {
            enterMobileTeam(teamId);
          } else {
            setChatMode('channel');
            setActiveChannel(channelKey);
            setMainTab('chat');
            setShowMemberPanel(false);
            if (!showTeamDetailPanel && !l2SpaceTight) setShowTeamDetailPanel(true);
            if (!teamGc) {
              void refreshGroupChats();
              void refreshTeams();
            }
          }
        }}
        selectedTeamId={activeTeamId ?? (chatMode === 'direct' && currentAgent?.teamId ? currentAgent.teamId : null)}
        onRefreshTeams={refreshTeams}
        onRefreshAgents={refreshAgents}
        onRefreshHumans={refreshHumans}
        onRefreshGroupChats={refreshGroupChats}
        onViewProfile={handleViewProfile}
        onManageGroupMembers={(channelKey) => { setChatMode('channel'); setActiveChannel(channelKey); setMainTab('chat'); setShowMemberPanel(true); if (isMobile) enterMobileDetail(); }}
        unreadByAgent={unreadByAgent}
        unreadByChannel={unreadByChannel}
        width={isMobile ? undefined : chatSidebar.width}
        onResizeStart={isMobile ? undefined : chatSidebar.onResizeStart}
        hidden={(isMobile && mobileLayer !== 'roster') || (!isMobile && sidebarsCollapsed)}
        onCollapse={() => setSidebarsCollapsedPersisted(true)}
        initialLoading={initialLoading}
      />}

      {/* ── L2: Mobile team detail view ── */}
      {isMobile && mobileLayer === 'team' && mobileTeamId && (() => {
        const l2Team = teams.find(t => t.id === mobileTeamId);
        if (!l2Team) return null;
        const l2Agents = agents.filter(a => a.teamId === mobileTeamId);
        const l2Gc = groupChats.find(gc => gc.type === 'team' && gc.teamId === mobileTeamId);
        return (
          <div className="flex-1 overflow-hidden flex flex-col min-w-0">
            <div className="flex items-center gap-2 px-3 h-12 shrink-0 border-b border-border-default">
              <button
                onClick={() => { window.location.hash = PAGE.TEAM; }}
                className="p-1.5 -ml-1 rounded-lg hover:bg-surface-overlay transition-colors shrink-0 text-fg-secondary"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
              </button>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-brand-500/15 flex items-center justify-center shrink-0">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-brand-500"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-fg-primary truncate">{l2Team.name}</h3>
                  <p className="text-[10px] text-fg-tertiary">{t('chat.members_other', { count: l2Team.members?.length || l2Agents.length })}</p>
                </div>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
              {l2Gc && (() => {
                const gcUnread = unreadByChannel[l2Gc.channelKey] ?? 0;
                return (
                  <button
                    onClick={() => { setChatMode('channel'); setActiveChannel(l2Gc.channelKey); setMainTab('chat'); enterMobileDetail(); }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl hover:bg-surface-overlay transition-colors"
                  >
                    <div className="w-9 h-9 rounded-xl bg-brand-500/15 flex items-center justify-center shrink-0">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-brand-500"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                    </div>
                    <div className="flex-1 min-w-0 text-left">
                      <div className="text-sm font-medium text-fg-primary truncate">{l2Gc.name}</div>
                      <div className="text-[10px] text-fg-tertiary">{t('chat.groupChat')}</div>
                    </div>
                    {gcUnread > 0 ? (
                      <span className="min-w-[16px] h-[16px] flex items-center justify-center text-[9px] font-semibold text-white bg-red-500 rounded-full px-1 leading-none shrink-0">{gcUnread}</span>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-tertiary shrink-0"><polyline points="9 18 15 12 9 6" /></svg>
                    )}
                  </button>
                );
              })()}
              {l2Agents.length > 0 && (
                <>
                  <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wider px-2.5 pt-2">{t('chat.agents')}</p>
                  {l2Agents.map(agent => {
                    const agentUnread = unreadByAgent.get(agent.id) ?? 0;
                    const isStopped = agent.status === 'offline';
                    return (
                      <button
                        key={agent.id}
                        onClick={() => { setChatMode('direct'); setSelectedAgent(agent.id); setMainTab('chat'); enterMobileDetail(); }}
                        className={`w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl hover:bg-surface-overlay transition-colors ${isStopped ? 'opacity-50' : ''}`}
                      >
                        <Avatar name={agent.name || 'Agent'} avatarUrl={agent.avatarUrl} size={36} />
                        <div className="flex-1 min-w-0 text-left">
                          <div className="text-sm font-medium text-fg-primary truncate flex items-center gap-1.5">
                            {agent.name}
                            {isStopped && <span className="text-[8px] px-1 py-0 rounded bg-gray-500/20 text-gray-400 font-medium leading-relaxed">{t('common:status.offline')}</span>}
                          </div>
                          <div className="text-[10px] text-fg-tertiary truncate">{agent.role || agent.status}</div>
                        </div>
                        {agentUnread > 0 ? (
                          <span className="min-w-[16px] h-[16px] flex items-center justify-center text-[9px] font-semibold text-white bg-red-500 rounded-full px-1 leading-none shrink-0">{agentUnread}</span>
                        ) : (
                          <span className={`w-2 h-2 rounded-full shrink-0 ${agent.status === 'idle' ? 'bg-green-500' : agent.status === 'working' ? 'bg-blue-500' : 'bg-gray-400'}`} />
                        )}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── L2: Team detail panel (desktop only; hidden in preview fullscreen) ── */}
      {/* Inline mode: when space allows */}
      {!rightPanelFullscreen && showTeamDetailPanel && !l2SpaceTight && !isMobile && !sidebarsCollapsed && (() => {
        const l2TeamId = activeTeamId ?? (chatMode === 'direct' ? currentAgent?.teamId : undefined);
        if (!l2TeamId) return null;
        const panelTeam = teams.find(t => t.id === l2TeamId);
        if (!panelTeam) return null;
        const panelGc = groupChats.find(gc => gc.type === 'team' && gc.teamId === l2TeamId);
        return (
          <TeamDetailPanel
            team={panelTeam}
            agents={agents}
            humans={humans}
            authUser={authUser}
            groupChat={panelGc}
            chatMode={chatMode}
            selectedAgent={selectedAgent}
            activeChannel={activeChannel}
            teams={teams}
            onSelectAgent={(agentId) => { setChatMode('direct'); setSelectedAgent(agentId); setMainTab('chat'); setShowMemberPanel(false); }}
            onSelectChannel={(channelKey) => { setChatMode('channel'); setActiveChannel(channelKey); setMainTab('chat'); setShowMemberPanel(false); }}
            onSelectDm={(userId) => { setChatMode('dm'); setActiveDmUserId(userId); setMainTab('chat'); setShowMemberPanel(false); }}
            onBack={() => setShowTeamDetailPanel(false)}
            onViewProfile={handleViewProfile}
            onRefreshAgents={refreshAgents}
            onRefreshTeams={refreshTeams}
            unreadByAgent={unreadByAgent}
            width={teamDetailPanel.width}
            onResizeStart={teamDetailPanel.onResizeStart}
          />
        );
      })()}
      {/* Floating mode: when space is tight, show as overlay */}
      {!rightPanelFullscreen && l2Floating && !isMobile && !sidebarsCollapsed && (() => {
        const l2TeamId = activeTeamId ?? (chatMode === 'direct' ? currentAgent?.teamId : undefined);
        if (!l2TeamId) return null;
        const panelTeam = teams.find(t => t.id === l2TeamId);
        if (!panelTeam) return null;
        const panelGc = groupChats.find(gc => gc.type === 'team' && gc.teamId === l2TeamId);
        return (
          <div data-l2-floating className="absolute z-30 inset-0" style={{ left: chatSidebar.width + 6 }}>
            <div className="absolute inset-0 bg-black/20" onClick={() => setL2Floating(false)} />
            <div className="relative h-full" style={{ width: teamDetailPanel.width + 8 }}>
              <TeamDetailPanel
                team={panelTeam}
                agents={agents}
                humans={humans}
                authUser={authUser}
                groupChat={panelGc}
                chatMode={chatMode}
                selectedAgent={selectedAgent}
                activeChannel={activeChannel}
                teams={teams}
                onSelectAgent={(agentId) => { setChatMode('direct'); setSelectedAgent(agentId); setMainTab('chat'); setShowMemberPanel(false); setL2Floating(false); }}
                onSelectChannel={(channelKey) => { setChatMode('channel'); setActiveChannel(channelKey); setMainTab('chat'); setShowMemberPanel(false); setL2Floating(false); }}
                onSelectDm={(userId) => { setChatMode('dm'); setActiveDmUserId(userId); setMainTab('chat'); setShowMemberPanel(false); setL2Floating(false); }}
                onBack={() => setL2Floating(false)}
                onViewProfile={(agentId) => { handleViewProfile(agentId); setL2Floating(false); }}
                onRefreshAgents={refreshAgents}
                onRefreshTeams={refreshTeams}
                unreadByAgent={unreadByAgent}
                width={teamDetailPanel.width}
              />
            </div>
          </div>
        );
      })()}

      {/* ── Main area (hidden in preview fullscreen) ── */}
      {!rightPanelFullscreen && (!isMobile || showChatOnMobile) && (
      <div className={`flex-1 overflow-hidden flex flex-col ${isMobile || rightPanelPayload ? 'min-w-0' : 'min-w-[400px]'}`}>
        {/* Header */}
        <div className="shrink-0 relative pb-2">
          {isMobile ? (
            <>
              {/* Mobile Row 1: back + name + status */}
              <div className="flex items-center px-3 h-11 gap-2">
                <button
                  onClick={() => { window.location.hash = mobileBackHashRef.current; }}
                  className="text-fg-secondary hover:text-fg-primary transition-colors p-1 -ml-1 shrink-0"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                </button>
                <span className="font-semibold text-sm truncate min-w-0 flex-1">{modeTitle}</span>
                {chatMode === 'direct' && currentAgent && (
                  <AgentStatusBadge agent={currentAgent} tasks={tasks} onViewProfile={handleViewProfile} streamActive={chatStreamActive} />
                )}
              </div>
              {/* Mobile Row 2: tabs + actions */}
              <div className="flex items-center px-3 h-9 gap-1 border-t border-border-default/40">
                <button
                  onClick={() => { if (isProfileTab(mainTab)) history.back(); else setMainTab('chat'); }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    mainTab === 'chat' ? 'bg-brand-500/15 text-brand-500' : 'text-fg-tertiary'
                  }`}
                >{t('page.chatTitle')}</button>
                <button
                  onClick={() => { if (!isProfileTab(mainTab)) switchToProfile(); }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    isProfileTab(mainTab) ? 'bg-brand-500/15 text-brand-500' : 'text-fg-tertiary'
                  }`}
                >{chatMode === 'channel' ? t('page.teamTab') : t('page.profileTab')}</button>
                <div className="flex-1" />
                <button
                  onClick={() => { setSearchOpen(!searchOpen); if (!searchOpen) { setSearchQuery(''); setSearchResults([]); } }}
                  className={`p-1 rounded-md transition-colors shrink-0 ${searchOpen ? 'bg-brand-500/15 text-brand-500' : 'text-fg-tertiary'}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
                </button>
                {chatMode === 'channel' && activeGroupChat?.type === 'custom' && (
                  <button
                    onClick={() => setShowMemberPanel(!showMemberPanel)}
                    className={`text-[11px] px-2 py-1 rounded-md font-medium shrink-0 flex items-center gap-1 ${
                      showMemberPanel ? 'bg-brand-500/15 text-brand-500' : 'text-fg-tertiary'
                    }`}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                    {activeGroupChat.members?.length ?? activeGroupChat.memberCount ?? 0}
                  </button>
                )}
                {chatMode === 'direct' && !isProfileTab(mainTab) && (
                  <>
                    <button
                      onClick={newConversation}
                      className="text-[11px] text-brand-500 px-2 py-1 rounded-md bg-brand-500/10 font-medium shrink-0"
                    >{t('page.newChatPlus')}</button>
                    <button
                      ref={historyBtnRef}
                      onClick={() => setShowSessions(!showSessions)}
                      className={`p-1 rounded-md transition-colors shrink-0 ${showSessions ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary'}`}
                      title={t('page.historyTitle')}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
          /* Desktop: redesigned header with flattened tabs + inline editing */
          (() => {
            const activeTeam = activeTeamId ? teams.find(t => t.id === activeTeamId) : undefined;
            const activeTabs: MainTab[] =
              chatMode === 'direct' && selectedAgent ? AGENT_TABS
              : chatMode === 'channel' && activeTeamId ? TEAM_TAB_SET
              : ['chat'];

            const handleSaveHeaderName = async () => {
              const trimmed = headerNameDraft.trim();
              if (!trimmed) { setEditingHeaderName(false); return; }
              try {
                if (chatMode === 'direct' && selectedAgent) {
                  await api.agents.updateConfig(selectedAgent, { name: trimmed });
                  refreshAgents();
                } else if (chatMode === 'channel' && activeTeamId) {
                  await api.teams.update(activeTeamId, { name: trimmed });
                  refreshTeams();
                }
              } catch { /* */ }
              setEditingHeaderName(false);
            };

            const handleSaveHeaderDesc = async () => {
              try {
                if (chatMode === 'direct' && selectedAgent) {
                  await api.agents.updateConfig(selectedAgent, { roleDescription: headerDescDraft });
                  refreshAgents();
                } else if (chatMode === 'channel' && activeTeamId) {
                  await api.teams.update(activeTeamId, { description: headerDescDraft });
                  refreshTeams();
                }
              } catch { /* */ }
              setEditingHeaderDesc(false);
            };

            const headerName = chatMode === 'direct' ? currentAgent?.name : chatMode === 'channel' ? (activeTeam?.name ?? activeGroupChat?.name) : (activeDmUser?.name ?? '');
            const headerDesc = chatMode === 'direct' ? (currentAgent?.role || '') : chatMode === 'channel' ? (activeTeam?.description || '') : '';
            const headerAvatarUrl = chatMode === 'direct' ? currentAgent?.avatarUrl : undefined;
            const headerAvatarName = headerName || 'U';
            const showEntityInfo = (chatMode === 'direct' && selectedAgent) || (chatMode === 'channel' && activeTeamId);

            return (
            <div className="flex flex-col">
              {/* Row 1: L1/L2 toggle + avatar + name/desc + action buttons */}
              <div className="flex items-center px-4 h-14 gap-2.5">
                {/* Expand sidebars button — shown when sidebars are collapsed */}
                {sidebarsCollapsed && !isMobile && (
                  <button
                    onClick={() => setSidebarsCollapsedPersisted(false)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors shrink-0 text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated"
                    title={t('page.toggleSidebar')}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <line x1="9" y1="3" x2="9" y2="21" />
                    </svg>
                  </button>
                )}
                {/* L2 toggle button — shown when inline L2 is closed, or in tight mode to toggle floating */}
                {(!showTeamDetailPanel || l2SpaceTight) && ((chatMode === 'channel' && activeTeamId) || (chatMode === 'direct' && currentAgent?.teamId)) && (
                  <button
                    onClick={toggleTeamDetailPanel}
                    className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors shrink-0 ${
                      l2Floating ? 'bg-brand-500/15 text-brand-500' : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated'
                    }`}
                    title="Toggle team panel"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <line x1="9" y1="3" x2="9" y2="21" />
                    </svg>
                  </button>
                )}

                {/* Avatar */}
                {showEntityInfo && (
                  chatMode === 'channel' && activeTeamId ? (
                    <div className="w-9 h-9 rounded-xl bg-brand-600 text-white flex items-center justify-center text-sm font-bold shrink-0">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    </div>
                  ) : (
                    <Avatar name={headerAvatarName} avatarUrl={headerAvatarUrl} size={36} className="rounded-xl shrink-0" />
                  )
                )}

                {/* Name & Description (inline editable) */}
                {showEntityInfo ? (
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {editingHeaderName ? (
                        <input
                          ref={headerNameRef}
                          value={headerNameDraft}
                          onChange={e => setHeaderNameDraft(e.target.value)}
                          onBlur={handleSaveHeaderName}
                          onKeyDown={e => { if (e.key === 'Enter') handleSaveHeaderName(); if (e.key === 'Escape') setEditingHeaderName(false); }}
                          className="text-sm font-semibold bg-transparent border-b border-brand-500 outline-none py-0 px-0 min-w-[80px] max-w-[240px]"
                          autoFocus
                        />
                      ) : (
                        <span
                          className="text-sm font-semibold truncate cursor-pointer hover:text-brand-500 transition-colors"
                          onClick={() => { setHeaderNameDraft(headerName ?? ''); setEditingHeaderName(true); }}
                          title="Click to edit name"
                        >
                          {headerName}
                        </span>
                      )}
                      {chatMode === 'direct' && currentAgent && (
                        <AgentStatusBadge agent={currentAgent} tasks={tasks} onViewProfile={handleViewProfile} streamActive={chatStreamActive} />
                      )}
                    </div>
                    {(chatMode === 'direct' || (chatMode === 'channel' && activeTeamId)) && (
                      editingHeaderDesc ? (
                        <input
                          ref={headerDescRef}
                          value={headerDescDraft}
                          onChange={e => setHeaderDescDraft(e.target.value)}
                          onBlur={handleSaveHeaderDesc}
                          onKeyDown={e => { if (e.key === 'Enter') handleSaveHeaderDesc(); if (e.key === 'Escape') setEditingHeaderDesc(false); }}
                          className="text-[11px] text-fg-tertiary bg-transparent border-b border-brand-500/50 outline-none py-0 px-0 w-full max-w-[400px] mt-0.5"
                          placeholder="Add description..."
                          autoFocus
                        />
                      ) : (
                        <div
                          className="text-[11px] text-fg-tertiary truncate cursor-pointer hover:text-fg-secondary transition-colors mt-0.5"
                          onClick={() => { setHeaderDescDraft(headerDesc); setEditingHeaderDesc(true); }}
                          title="Click to edit description"
                        >
                          {headerDesc || 'No description'}
                        </div>
                      )
                    )}
                  </div>
                ) : (
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="font-semibold text-sm truncate">{modeTitle}</span>
                    {chatMode === 'dm' && (
                      <span className="text-xs text-fg-tertiary">
                        {isSelfDm ? t('page.privateNotepad') : ''}
                      </span>
                    )}
                  </div>
                )}

                {/* Right side buttons */}
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => { setSearchOpen(!searchOpen); if (!searchOpen) { setSearchQuery(''); setSearchResults([]); } }}
                    className={`p-1.5 rounded-md transition-colors ${searchOpen ? 'bg-brand-500/15 text-brand-500' : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated'}`}
                    title={t('page.searchMessages')}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                    </svg>
                  </button>
                  {chatMode === 'channel' && activeGroupChat?.type === 'custom' && (
                    <button
                      onClick={() => setShowMemberPanel(!showMemberPanel)}
                      className={`text-xs px-2.5 py-1 rounded-md border transition-colors flex items-center gap-1.5 ${
                        showMemberPanel
                          ? 'bg-brand-500/15 text-brand-500 border-brand-500/30'
                          : 'text-fg-secondary hover:text-fg-primary border-border-default hover:bg-surface-elevated'
                      }`}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                      {activeGroupChat.members?.length ?? activeGroupChat.memberCount ?? 0}
                    </button>
                  )}
                  {chatMode === 'direct' && currentAgent && mainTab === 'chat' && (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={newConversation}
                        className="text-xs text-brand-500 hover:text-brand-500 px-2.5 py-1 rounded-md hover:bg-brand-500/10 border border-brand-500/20 transition-colors flex items-center gap-1"
                      >
                        {t('page.newChatButton')}
                      </button>
                      <button
                        ref={historyBtnRef}
                        onClick={() => setShowSessions(!showSessions)}
                        className={`p-1.5 rounded-md transition-colors ${showSessions ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated'}`}
                        title={t('page.historyTitle')}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </button>
                    </div>
                  )}
                  {!isMobile && layout && (
                    <button
                      onClick={() => layout.toggleRightPanel()}
                      className={`p-1.5 rounded-md transition-colors ${rightPanelPayload ? 'bg-brand-500/15 text-brand-500' : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated'}`}
                      title={t('page.rightPanelToggle', { defaultValue: 'Toggle side panel' })}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <rect x="3" y="4" width="18" height="16" rx="2" />
                        <path d="M15 4v16" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Row 2: Flattened tabs */}
              {activeTabs.length > 1 && (
                <div className="flex items-center gap-1 px-4 pb-1.5 overflow-x-auto scrollbar-hide">
                  {activeTabs.map(tab => (
                    <button
                      key={tab}
                      onClick={() => setMainTab(tab)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap flex items-center gap-1 ${
                        mainTab === tab
                          ? 'bg-brand-500/15 text-brand-500'
                          : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated/50'
                      }`}
                    >
                      <span>{tabIcon(tab)}</span>
                      {tabLabel(tab, t)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            );
          })()
          )}

          {/* Search panel */}
          {searchOpen && (
            <div className="border-b border-border-default bg-surface-secondary/50 px-4 py-2 space-y-2 animate-in slide-in-from-top-2 duration-200">
              <div className="flex items-center gap-2">
                <div className="flex-1 relative">
                  <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                  </svg>
                  <input
                    autoFocus
                    value={searchQuery}
                    onChange={e => handleSearchInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); } }}
                    placeholder={t('page.searchPlaceholder')}
                    className="w-full pl-8 pr-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg outline-none focus:border-brand-500/50 transition-colors"
                  />
                </div>
                <button
                  onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); }}
                  className="text-fg-tertiary hover:text-fg-secondary text-xs px-1"
                >✕</button>
              </div>
              {searchLoading && (
                <div className="flex items-center gap-2 text-xs text-fg-tertiary py-1">
                  <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                  {t('page.searching')}
                </div>
              )}
              {!searchLoading && searchQuery.length >= 2 && searchResults.length === 0 && (
                <div className="text-xs text-fg-tertiary py-1">{t('page.noSearchResults')}</div>
              )}
              {searchResults.length > 0 && (
                <div className="max-h-60 overflow-y-auto space-y-0.5">
                  {searchResults.map(r => (
                    <button
                      key={r.id}
                      onClick={() => handleSearchResultClick(r)}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-surface-elevated transition-colors group"
                    >
                      <div className="flex items-center gap-2 text-[11px] text-fg-tertiary mb-0.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${r.source === 'channel' ? 'bg-blue-500/10 text-blue-500' : 'bg-emerald-500/10 text-emerald-500'}`}>
                          {r.source === 'channel' ? '#' : '1:1'}
                        </span>
                        {r.senderName && <span>{r.senderName}</span>}
                        <span>{new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                      </div>
                      <div className="text-xs text-fg-secondary line-clamp-2 group-hover:text-fg-primary transition-colors">
                        {r.text.length > 200 ? r.text.slice(0, 200) + '…' : r.text}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Session tab bar (direct mode, chat tab) — hide when only 1 session */}
          {chatMode === 'direct' && selectedAgent && mainTab === 'chat' && openSessionTabs.length > 1 && (
            <div className="flex items-center gap-0 px-3 overflow-x-auto scrollbar-hide">
              {openSessionTabs.map(s => (
                <div
                  key={s.id}
                  className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer rounded-md transition-colors shrink-0 max-w-[180px] ${
                    s.id === activeSessionId
                      ? 'text-brand-500 bg-brand-500/10'
                      : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated/50'
                  }`}
                  onClick={() => {
                    if (s.id === NEW_CHAT_PLACEHOLDER_ID) {
                      setActiveSessionId(NEW_CHAT_PLACEHOLDER_ID);
                      const key = currentConvKeyRef.current;
                      resetConv(key);
                      setMessages([]);
                    } else {
                      void switchSession(s);
                    }
                  }}
                >
                  {s.isMain && <span className="text-[10px] opacity-50 shrink-0">●</span>}
                  <span className="truncate">{s.id === NEW_CHAT_PLACEHOLDER_ID ? t('page.newChat') : (s.isMain ? t('page.sessionMain') : (s.title || t('page.sessionConversation')))}</span>
                  {!s.isMain && (
                    <button
                      onClick={(e) => { e.stopPropagation(); closeSessionTab(s.id); }}
                      className="opacity-0 group-hover:opacity-100 text-fg-tertiary hover:text-fg-secondary transition-opacity shrink-0"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {chatMode === 'direct' && mainTab === 'chat'
            && (openSessionTabs.find(s => s.id === activeSessionId) ?? sessions.find(s => s.id === activeSessionId))
              ?.metadata?.kind === 'evolution' && (
            <div className="px-4 py-1.5 text-[11px] text-fg-tertiary border-b border-border-default bg-surface-secondary/40">
              {t('page.messageActions.evolvedFrom')}
            </div>
          )}

          {/* Group chat member management panel */}
          {chatMode === 'channel' && activeGroupChat?.type === 'custom' && showMemberPanel && (() => {
            const gc = activeGroupChat;
            const currentMembers = gc.members ?? [];
            const allCandidates: Array<{ id: string; name: string; type: 'human' | 'agent'; subtitle: string }> = [];
            for (const a of agents) {
              if (!currentMembers.some(m => m.id === a.id)) {
                allCandidates.push({ id: a.id, name: a.name, type: 'agent', subtitle: a.role || 'Agent' });
              }
            }
            for (const h of humans) {
              if (!currentMembers.some(m => m.id === h.id)) {
                allCandidates.push({ id: h.id, name: h.name, type: 'human', subtitle: h.email || h.role || '' });
              }
            }
            return (
              <div className="bg-surface-secondary/80 px-4 py-3 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-fg-secondary">{t('page.members')} ({currentMembers.length})</span>
                  <button onClick={() => setShowMemberPanel(false)} className="text-fg-tertiary hover:text-fg-secondary text-xs">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {currentMembers.map(m => (
                    <span key={m.id} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium ${
                      m.type === 'agent' ? 'bg-brand-500/10 text-brand-500' : 'bg-green-500/10 text-green-600'
                    }`}>
                      <Avatar name={m.name} size={16} bgClass={m.type === 'agent' ? 'bg-brand-500/15 text-brand-500' : 'bg-green-500/15 text-green-600'} />
                      {m.name}
                      {m.id !== authUser?.id && (
                        <button
                          onClick={async () => {
                            try {
                              await api.groupChats.removeMember(gc.id, m.id);
                              setGroupChats(prev => prev.map(g => g.id === gc.id ? { ...g, members: (g.members ?? []).filter(x => x.id !== m.id), memberCount: (g.memberCount ?? 1) - 1 } : g));
                            } catch { /* ignore */ }
                          }}
                          className="ml-0.5 hover:text-red-500 transition-colors"
                          title={t('common:remove')}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                {allCandidates.length > 0 && (
                  <div className="mt-1">
                    <select
                      className="w-full bg-surface-primary border border-border-default rounded-lg px-2.5 py-1.5 text-xs text-fg-primary outline-none focus:ring-1 focus:ring-brand-500/50"
                      value=""
                      onChange={async (e) => {
                        const id = e.target.value;
                        if (!id) return;
                        const c = allCandidates.find(x => x.id === id);
                        if (!c) return;
                        try {
                          await api.groupChats.addMember(gc.id, c.id, c.type, c.name);
                          setGroupChats(prev => prev.map(g => g.id === gc.id ? {
                            ...g,
                            members: [...(g.members ?? []), { id: c.id, name: c.name, type: c.type }],
                            memberCount: (g.memberCount ?? 0) + 1,
                          } : g));
                        } catch { /* ignore */ }
                      }}
                    >
                      <option value="">{t('page.addMemberPlaceholder')}</option>
                      {allCandidates.map(c => (
                        <option key={c.id} value={c.id}>[{c.type === 'agent' ? 'Agent' : 'Human'}] {c.name}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Floating history panel */}
          {chatMode === 'direct' && selectedAgent && showSessions && (
            <div
              ref={historyPanelRef}
              className="absolute right-4 top-full mt-1 w-72 max-h-[420px] bg-surface-secondary border border-border-default rounded-xl shadow-2xl shadow-black/40 z-50 flex flex-col overflow-hidden"
            >
              <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
                <span className="text-xs font-semibold text-fg-secondary uppercase tracking-wider">{t('page.historyTitle')}</span>
                <button onClick={() => setShowSessions(false)} className="text-fg-tertiary hover:text-fg-secondary text-xs">✕</button>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {sessions.length === 0 && (
                  <div className="text-xs text-fg-tertiary text-center py-6">{t('page.noConversationsYet')}</div>
                )}
                {(() => {
                  const now = new Date();
                  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                  const yesterdayStart = todayStart - 86400000;
                  const weekStart = todayStart - 7 * 86400000;
                  const groups: Array<{ label: string; items: ChatSessionInfo[] }> = [];
                  const today: ChatSessionInfo[] = [];
                  const yesterday: ChatSessionInfo[] = [];
                  const week: ChatSessionInfo[] = [];
                  const older: ChatSessionInfo[] = [];
                  for (const s of sessions) {
                    const t = new Date(s.lastMessageAt).getTime();
                    if (t >= todayStart) today.push(s);
                    else if (t >= yesterdayStart) yesterday.push(s);
                    else if (t >= weekStart) week.push(s);
                    else older.push(s);
                  }
                  if (today.length > 0) groups.push({ label: t('page.dateToday'), items: today });
                  if (yesterday.length > 0) groups.push({ label: t('page.dateYesterday'), items: yesterday });
                  if (week.length > 0) groups.push({ label: t('page.datePrevious7Days'), items: week });
                  if (older.length > 0) groups.push({ label: t('page.dateOlder'), items: older });
                  return groups.map(g => (
                    <div key={g.label} className="mb-2">
                      <div className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider px-3 py-1.5">{g.label}</div>
                      {g.items.map(s => (
                        <button
                          key={s.id}
                          onClick={() => void switchSession(s)}
                          className={`w-full text-left px-3 py-2.5 rounded-lg text-xs mb-0.5 transition-colors ${
                            s.id === activeSessionId ? 'bg-brand-600/20 text-brand-500' : 'text-fg-secondary hover:bg-surface-elevated'
                          }`}
                        >
                          <div className="truncate font-medium flex items-center gap-1">
                            {s.isMain && <span className="text-[10px] text-brand-500 opacity-80">●</span>}
                            {s.isMain ? t('page.sessionMain') : (s.title || t('page.sessionConversation'))}
                          </div>
                          <div className="text-fg-tertiary text-[10px] mt-0.5">{new Date(s.lastMessageAt).toLocaleString()}</div>
                        </button>
                      ))}
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}
        </div>

        {/* Profile Tab — mobile: legacy full profile, desktop: headless tab content */}
        {isMobile && mainTab === 'profile' && chatMode === 'direct' && selectedAgent && (
          <div className="flex-1 overflow-y-auto">
            <AgentProfile
              agentId={selectedAgent}
              onBack={() => setMainTab('chat')}
              inline
              defaultTab={profileDefaultTab}
              highlightMailboxId={profileHighlightMailboxId}
              onSwipeBack={() => { if (isProfileTab(mainTabRef.current)) history.back(); else setMainTab('chat'); }}
              authUser={authUser}
            />
          </div>
        )}
        {isMobile && mainTab === 'profile' && chatMode === 'channel' && activeTeamId && (
          <div className="flex-1 overflow-y-auto" onTouchStart={isMobile ? mainTabSwipe.onTouchStart : undefined} onTouchEnd={isMobile ? mainTabSwipe.onTouchEnd : undefined}>
            <TeamProfile
              teamId={activeTeamId}
              onBack={() => setMainTab('chat')}
              inline
              onSelectAgent={(agentId) => { setChatMode('direct'); setSelectedAgent(agentId); setMainTab('chat'); }}
            />
          </div>
        )}

        {/* Desktop: flattened profile tab content (headless mode) */}
        {!isMobile && isProfileTab(mainTab) && chatMode === 'direct' && selectedAgent && (
          <div className="flex-1 overflow-y-auto">
            <AgentProfile
              agentId={selectedAgent}
              onBack={() => setMainTab('chat')}
              inline
              headless
              activeTab={mainTab as ProfileTab}
              highlightMailboxId={profileHighlightMailboxId}
              authUser={authUser}
            />
          </div>
        )}
        {!isMobile && isProfileTab(mainTab) && chatMode === 'channel' && activeTeamId && (
          <div className="flex-1 flex flex-col min-h-0">
            <TeamProfile
              teamId={activeTeamId}
              onBack={() => setMainTab('chat')}
              inline
              headless
              activeTab={mainTab as TeamTab}
              onSelectAgent={(agentId) => { setChatMode('direct'); setSelectedAgent(agentId); setMainTab('chat'); }}
            />
          </div>
        )}

        {/* Chat Tab: Messages */}
        <div className={`flex-1 overflow-hidden flex flex-col relative ${isEmptyChat ? 'justify-center' : ''} ${mainTab !== 'chat' ? 'hidden' : ''}`}>
          {loadingChat && visibleMessages.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <svg className="animate-spin h-6 w-6 text-brand-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-xs text-fg-tertiary animate-pulse">
                {t('page.loadingChat', { defaultValue: 'Loading conversation…' })}
              </span>
            </div>
          )}
          {loadingMore && (
            <div className="absolute top-0 left-0 right-0 z-10 flex justify-center items-center gap-2 py-2 bg-gradient-to-b from-surface-primary/90 to-transparent pointer-events-none">
              <svg className="animate-spin h-3.5 w-3.5 text-brand-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-xs text-fg-tertiary">{t('page.loadingEarlierMessages')}</span>
            </div>
          )}
          <div ref={chatScrollRef} className={`${isEmptyChat ? 'hidden' : 'flex-1'} overflow-y-auto ${isMobile ? 'p-2.5' : `p-5 ${chatRightReserve}`}`} onScroll={handleChatScroll} onTouchStart={isMobile ? mainTabSwipe.onTouchStart : undefined} onTouchEnd={isMobile ? mainTabSwipe.onTouchEnd : undefined}>

          {visibleMessages.length > 0 && (
          <div style={{ height: chatVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {chatVirtualizer.getVirtualItems().map(virtualRow => {
              const vIdx = virtualRow.index;
              const msg = visibleMessages[vIdx]!;
              const prevMsg = vIdx > 0 ? visibleMessages[vIdx - 1] : null;
              const curDate = getDateKey(msg.rawCreatedAt);
              const prevDate = prevMsg ? getDateKey(prevMsg.rawCreatedAt) : '';
              // Require both sides to have a date — optimistic local bubbles often omit
              // rawCreatedAt, which previously made every agent reply look like a new day ("今天").
              const showDateSep = Boolean(curDate && prevDate && curDate !== prevDate);
              const isLastMsg = vIdx === visibleMessages.length - 1;
              const isPending = isLastPending && isLastMsg;
              const isStreamingMsg = (isPending && sending) || !!msg.isStreaming;
              const showStreamingBubble = (isLastVisualStreaming && isLastMsg) || isStreamingMsg;
              const showActions = chatMode === 'channel' || (!isStreamingMsg || msg.isStopped);

              return (
                <div
                  key={msg.id}
                  data-index={vIdx}
                  ref={chatVirtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                >
                <div className="pb-3">
                {showDateSep && (
                  <div className="flex items-center gap-3 py-2 my-1">
                    <div className="flex-1 h-px bg-border-default" />
                    <span className="text-[10px] text-fg-tertiary font-medium uppercase tracking-wider shrink-0">{formatDateLabel(msg.rawCreatedAt!, dateLabels)}</span>
                    <div className="flex-1 h-px bg-border-default" />
                  </div>
                )}
                <div id={`msg-${msg.id}`} className="group/msg flex gap-3 transition-colors rounded-lg">
                  {chatMode === 'channel' ? (
                    <div
                      className="shrink-0 cursor-pointer"
                      onClick={(e) => {
                        if (msg.sender === 'agent' && msg.agentId) {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setAvatarPopover({ agentId: msg.agentId, top: rect.top, left: rect.right + 8 });
                        }
                      }}
                    >
                      <Avatar
                        name={msg.sender === 'user' ? currentUserName : (msg.agentName ?? t('page.fallbackAgent'))}
                        avatarUrl={msg.sender === 'user' ? authUser?.avatarUrl : agents.find(a => a.id === msg.agentId)?.avatarUrl}
                        size={32}
                        bgClass={msg.sender === 'user' ? 'bg-brand-600' : 'bg-brand-500/15 text-brand-600'}
                        className={msg.sender === 'agent' ? 'hover:ring-1 hover:ring-brand-500/40 rounded-lg' : 'rounded-lg'}
                      />
                    </div>
                  ) : (
                    <div className="shrink-0">
                      <Avatar
                        name={msg.sender === 'user' ? currentUserName : (msg.agentName ?? (chatMode === 'direct' ? currentAgent?.name ?? t('page.fallbackAgent') : t('page.fallbackAgent')))}
                        avatarUrl={msg.sender === 'user' ? authUser?.avatarUrl : (agents.find(a => a.id === (msg.agentId ?? (chatMode === 'direct' ? currentAgent?.id : undefined)))?.avatarUrl)}
                        size={32}
                        bgClass={msg.sender === 'user' ? 'bg-brand-600' : 'bg-brand-500/15 text-brand-600'}
                        className="rounded-lg"
                      />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-fg-primary">
                        {msg.sender === 'user'
                          ? currentUserName
                          : chatMode === 'channel'
                            ? (msg.agentName ?? t('page.fallbackAgent'))
                            : <ChatAgentLink
                                name={msg.agentName ?? (chatMode === 'direct' ? currentAgent?.name ?? t('page.fallbackAgent') : t('page.fallbackAgent'))}
                                agentId={msg.agentId ?? (chatMode === 'direct' ? currentAgent?.id : undefined)}
                                agents={agents}
                                onViewProfile={handleViewProfile}
                              />
                        }
                      </span>
                      <span className="text-xs text-fg-tertiary" title={msg.rawCreatedAt ? new Date(msg.rawCreatedAt).toLocaleString() : ''}>{formatSmartTime(msg.time, msg.rawCreatedAt, dateLabels)}</span>
                    </div>
                    {msg.replyToId && msg.replyToSender && (
                      <button
                        onClick={() => {
                          const el = document.getElementById(`msg-${msg.replyToId}`);
                          if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('bg-brand-500/10'); setTimeout(() => el.classList.remove('bg-brand-500/10'), 1500); }
                        }}
                        className="flex items-center gap-1.5 mt-0.5 mb-1 pl-2 py-0.5 border-l-2 border-brand-500/40 text-xs text-fg-tertiary hover:text-fg-secondary transition-colors cursor-pointer"
                      >
                        <span className="font-medium text-brand-500">{msg.replyToSender}</span>
                        <span className="truncate max-w-[250px]">{msg.replyToText ?? '...'}</span>
                      </button>
                    )}
                    <div className={`mt-0.5 ${msg.sender === 'agent' ? 'py-1' : 'bg-surface-secondary rounded-2xl px-3.5 py-2.5 w-fit max-w-full'} ${
                      showStreamingBubble && msg.sender === 'agent' ? 'streaming-bubble' : ''
                    }`}>
                      {msg.sender === 'user'
                        ? <div className="text-sm text-fg-secondary whitespace-pre-wrap">
                            {msg.images && msg.images.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mb-1">
                                {msg.images.map((src, idx) => (
                                  <img key={idx} src={src} alt="" className="max-w-[200px] max-h-[150px] rounded-lg object-cover cursor-pointer hover:opacity-80 transition-opacity" onClick={() => window.open(src, '_blank')} />
                                ))}
                              </div>
                            )}
                            {chatMode === 'channel'
                              ? renderMentionText(msg.text, agents, (agent, e) => {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  setAvatarPopover({ agentId: agent.id, top: rect.bottom, left: rect.left });
                                })
                              : (msg.text && <span className="leading-relaxed">{renderMentionText(msg.text, agents, (agent, e) => {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  setAvatarPopover({ agentId: agent.id, top: rect.bottom, left: rect.left });
                                })}</span>)
                            }
                          </div>
                        : msg.sender === 'agent' && chatMode === 'channel' && !(msg.segments && msg.segments.length > 0)
                          ? <ErrorBoundary
                              resetKeys={[msg.text]}
                              fallback={<div className="whitespace-pre-wrap break-words text-sm text-fg-secondary">{msg.text}</div>}
                            >
                              <MarkdownMessage content={msg.text} className="text-sm text-fg-secondary" onMentionClick={handleMentionClick} knownNames={agentNames} />
                            </ErrorBoundary>
                          : <ErrorBoundary
                              resetKeys={[msg.id, msg.text, msg.segments?.length, isStreamingMsg]}
                              fallback={<div className="whitespace-pre-wrap break-words text-sm text-fg-secondary">{msg.text}</div>}
                            >
                              <AgentMessageBody
                                msg={msg}
                                isStreaming={isStreamingMsg}
                                liveActivities={isStreamingMsg ? activities : []}
                                onMentionClick={handleMentionClick}
                                knownNames={agentNames}
                              />
                            </ErrorBoundary>
                      }
                      {msg.isNotification && (
                        <NotificationBadge priority={msg.notifyPriority} />
                      )}
                    </div>
                    {showActions && !previewMode && (
                      <div className={`transition-opacity ${msg.isStopped || msg.isError || msg.emptyReply || isMobile ? 'opacity-100' : 'opacity-0 group-hover/msg:opacity-100'}`}>
                        <MessageActions
                          msg={msg}
                          onCopy={handleCopy}
                          onRetry={handleRetry}
                          onResume={handleResume}
                          onReply={handleReplyMsg}
                          onRemember={chatMode === 'direct' ? setRememberTarget : undefined}
                          showRemember={chatMode === 'direct'}
                          isCopied={copiedMsgId === msg.id}
                          isLastAgentMsg={msg.id === lastAgentMsgId}
                        />
                      </div>
                    )}
                  </div>
                </div>
                </div>
                </div>
              );
            })}
          </div>
          )}
          {chatMode === 'channel' && thinkingAgents.length > 0 && (
            <div className="flex flex-col gap-1.5 py-2">
              {thinkingAgents.map(ta => (
                <div
                  key={ta.id}
                  className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg cursor-pointer hover:bg-surface-elevated/60 transition-colors group/think"
                  onClick={() => { setChatMode('direct'); setSelectedAgent(ta.id); setMainTab('chat'); }}
                >
                  <div className="relative shrink-0">
                    <Avatar name={ta.name} avatarUrl={ta.avatarUrl} size={28} bgClass="bg-brand-500/15 text-brand-600" />
                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse ring-2 ring-surface-primary" />
                  </div>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-sm font-medium text-fg-secondary truncate">{ta.name}</span>
                    <span className="flex items-center gap-0.5">
                      <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" />
                      <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0.15s' }} />
                      <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0.3s' }} />
                    </span>
                    <span className="text-xs text-fg-tertiary">{t('page.agentThinking')}</span>
                  </div>
                  <span className="ml-auto text-[10px] text-fg-tertiary opacity-0 group-hover/think:opacity-100 transition-opacity">→</span>
                </div>
              ))}
            </div>
          )}
          <div ref={messagesEnd} />
        </div>

          {/* Scroll to bottom — same horizontal box as the input (max-w-3xl + right reserve) */}
          {showScrollBtn && mainTab === 'chat' && (
            <div
              className={`absolute ${isMobile ? 'bottom-4' : 'bottom-28'} inset-x-0 z-10 pointer-events-none ${
                isMobile ? 'px-3' : `px-5 ${chatRightReserve}`
              }`}
            >
              <div className={`${isMobile ? '' : 'max-w-3xl mx-auto'} flex justify-center`}>
                <button
                  onClick={() => {
                    resumeChatScrollFollow();
                    scrollChatToBottom('smooth');
                    setShowScrollBtn(false);
                    newMsgCountRef.current = 0;
                    setNewMsgCount(0);
                  }}
                  className="pointer-events-auto flex items-center gap-1.5 px-3.5 py-2 bg-surface-secondary/95 backdrop-blur-sm border border-border-default rounded-full shadow-lg hover:bg-surface-elevated transition-colors text-xs text-fg-secondary"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                  {newMsgCount > 0
                    ? t('page.newMessages', { count: newMsgCount })
                    : t('page.scrollToBottom')}
                </button>
              </div>
            </div>
          )}

        {/* Avatar popover */}
        {avatarPopover && (() => {
          const popAgent = agents.find(a => a.id === avatarPopover.agentId);
          if (!popAgent) return null;
          return (
            <AvatarPopover
              agent={popAgent}
              anchorRect={{ top: avatarPopover.top, left: avatarPopover.left }}
              onClose={() => setAvatarPopover(null)}
              onViewProfile={handleViewProfile}
            />
          );
        })()}

        {/* Empty state greeting (above input when no messages) */}
        {isEmptyChat && emptyGreeting && (
          <div className="text-center mb-4">
            <h2 className="text-xl font-semibold text-fg-primary">{emptyGreeting}</h2>
          </div>
        )}

        {/* Pending user-input / notify_user cards for this direct-chat session */}
        {chatMode === 'direct' && (userInputApprovals.length > 0 || sessionNotifyCards.length > 0) && (
          <div className={`${isMobile ? 'px-3' : 'px-5'} pb-1 shrink-0 ${isEmptyChat ? '' : chatRightReserve}`}>
            <div className={`${isMobile ? '' : 'max-w-3xl mx-auto'} flex flex-col gap-1.5`}>
              {userInputApprovals.map(a => (
                <button
                  key={a.id}
                  onClick={() => setActiveInputModal(a)}
                  className="w-full text-left px-3.5 py-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15 transition-colors flex items-center gap-3"
                >
                  <span className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-500 flex items-center justify-center shrink-0">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-fg-primary truncate">{a.title}</span>
                    <span className="block text-xs text-fg-tertiary truncate">
                      {t('page.userInputPrompt', { count: a.questions?.length ?? 1, defaultValue: `${a.questions?.length ?? 1} question(s) awaiting your response` })}
                    </span>
                  </span>
                  <span className="text-xs font-medium text-amber-500 shrink-0 inline-flex items-center gap-1">
                    {t('page.userInputRespond', { defaultValue: 'Respond' })}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                  </span>
                </button>
              ))}
              {sessionNotifyCards.map(n => {
                const isHigh = n.priority === 'high' || n.priority === 'urgent';
                return (
                  <button
                    key={n.id}
                    onClick={() => setActiveNotifyModal(n)}
                    className={`w-full text-left px-3.5 py-2.5 rounded-xl border transition-colors flex items-center gap-3 ${
                      isHigh
                        ? 'border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15'
                        : 'border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/15'
                    }`}
                  >
                    <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                      isHigh ? 'bg-amber-500/20 text-amber-500' : 'bg-blue-500/20 text-blue-500'
                    }`}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                      </svg>
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-fg-primary truncate">{n.title}</span>
                      <span className="block text-xs text-fg-tertiary truncate">
                        {n.body?.replace(/\s+/g, ' ').trim() || t('page.notifyUserPrompt', { defaultValue: 'Agent notification awaiting your attention' })}
                      </span>
                    </span>
                    <span className={`text-xs font-medium shrink-0 inline-flex items-center gap-1 ${isHigh ? 'text-amber-500' : 'text-blue-500'}`}>
                      {t('page.notifyUserView', { defaultValue: 'View' })}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {activeInputModal && (
          <UserInputModal
            approval={activeInputModal}
            submitting={respondingInputId === activeInputModal.id}
            readOnly={activeInputModal.status !== 'pending'}
            onClose={() => setActiveInputModal(null)}
            onSubmit={(r) => handleUserInputSubmit(activeInputModal.id, r)}
          />
        )}
        {activeNotifyModal && (
          <NotifyUserModal
            notification={activeNotifyModal}
            agentName={currentAgent?.name}
            acknowledging={acknowledgingNotifyId === activeNotifyModal.id}
            onClose={() => setActiveNotifyModal(null)}
            onAcknowledge={() => handleNotifyAcknowledge(activeNotifyModal.id)}
          />
        )}
        {retryConfirm && (
          <ConfirmModal
            variant="primary"
            title={t('page.retry', { defaultValue: 'Retry' })}
            message={retryConfirm.followCount === 1
              ? t('page.retryConfirmSingular')
              : t('page.retryConfirmPlural', { count: retryConfirm.followCount })}
            confirmLabel={t('common:confirm')}
            onConfirm={() => {
              const pending = retryConfirm;
              setRetryConfirm(null);
              executeRetry(pending.retryMsg, pending.userMsg, pending.retryText);
            }}
            onCancel={() => setRetryConfirm(null)}
          />
        )}
        {rememberTarget && (
          <RememberModal
            busy={rememberBusy}
            onConfirm={(note) => { void handleRememberConfirm(note); }}
            onCancel={() => { if (!rememberBusy) setRememberTarget(null); }}
          />
        )}

        {/* Input (only in chat tab) */}
        <div className={`${isMobile ? 'px-3 py-2' : 'px-5 py-3'} relative shrink-0 ${isEmptyChat ? '' : chatRightReserve}`} onDrop={handleDrop} onDragOver={handleDragOver}>
          <div className={`bg-surface-primary border border-border-default shadow-lg shadow-black/10 ${
            isMobile
              ? `${compactComposer ? 'rounded-2xl p-2' : 'rounded-2xl p-3'}`
              : `${compactComposer ? 'rounded-2xl p-2' : 'rounded-2xl p-3'} max-w-3xl mx-auto`
          }`}>
          {mentionDropdown && allMentionItems.length > 0 && (
            <div className="absolute bottom-full left-4 mb-1 bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden z-10 max-h-64 max-w-xs w-72 overflow-y-auto">
              <div className="px-3 py-1.5 text-[10px] text-fg-tertiary font-medium uppercase tracking-wider border-b border-border-default">
                {t('page.mentionAgent')}
              </div>
              {allMentionItems.map((item, i) => item.kind === 'agent' ? (
                <button
                  key={`agt-${item.agent.id}`}
                  ref={el => { if (i === mentionSelectedIndex && el) el.scrollIntoView({ block: 'nearest' }); }}
                  onClick={() => insertMention(item.agent.name)}
                  onMouseEnter={() => setMentionSelectedIndex(i)}
                  className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2 transition-colors ${
                    i === mentionSelectedIndex ? 'bg-brand-500/15 text-brand-500' : 'text-fg-secondary hover:bg-surface-overlay'
                  }`}
                >
                  <Avatar name={item.agent.name} avatarUrl={item.agent.avatarUrl} size={24} bgClass="bg-brand-500/20 text-brand-500" />
                  <span className="flex-1 min-w-0 truncate">{item.agent.name}</span>
                  <span className="text-xs text-fg-tertiary ml-auto">{item.agent.role}</span>
                </button>
              ) : (
                <button
                  key={`${item.entity.entityType}-${item.entity.id}`}
                  ref={el => { if (i === mentionSelectedIndex && el) el.scrollIntoView({ block: 'nearest' }); }}
                  onClick={() => insertMention(item.entity.name, item.entity.entityType, item.entity.id)}
                  onMouseEnter={() => setMentionSelectedIndex(i)}
                  className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2 transition-colors ${
                    i === mentionSelectedIndex ? 'bg-brand-500/15 text-brand-500' : 'text-fg-secondary hover:bg-surface-overlay'
                  }`}
                >
                  <span className="w-6 h-6 flex items-center justify-center text-sm shrink-0">{ENTITY_TYPE_ICON[item.entity.entityType] ?? '📄'}</span>
                  <span className="flex-1 min-w-0 truncate">{item.entity.name}</span>
                  <span className="text-xs text-fg-tertiary ml-auto">{item.entity.role}</span>
                </button>
              ))}
            </div>
          )}
          {chatContext.length > 0 && (
            <div className="flex items-center gap-1.5 mb-2 flex-wrap">
              {chatContext.map(chip => (
                <span
                  key={chip.id}
                  className="inline-flex items-center gap-1 max-w-[240px] pl-2 pr-1 py-1 rounded-lg bg-brand-500/10 text-brand-500 text-xs border border-brand-500/20"
                  title={chip.content}
                >
                  <span className="truncate">{chip.label}</span>
                  <button
                    onClick={() => setChatContext(prev => prev.filter(c => c.id !== chip.id))}
                    className="w-4 h-4 flex items-center justify-center rounded hover:bg-brand-500/20 shrink-0"
                    aria-label={t('common:remove', { defaultValue: 'Remove' })}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </span>
              ))}
            </div>
          )}
          {pendingImages.length > 0 && (
            <div className="flex items-center gap-2 mb-2 overflow-x-auto pb-1">
              {pendingImages.map(img => (
                <div key={img.id} className="relative group/img shrink-0">
                  {isImageFile(img) ? (
                    <img src={img.dataUrl} alt={img.name} className="w-16 h-16 rounded-lg object-cover border border-border-default" />
                  ) : (
                    <div className="w-16 h-16 rounded-lg border border-border-default bg-surface-elevated flex flex-col items-center justify-center gap-0.5" title={img.name}>
                      <span className="text-xl leading-none">{getFileIcon(img.name, img.dataUrl)}</span>
                      <span className="text-[9px] text-fg-tertiary truncate max-w-[56px] px-0.5">{img.name.split('.').pop()?.toUpperCase()}</span>
                    </div>
                  )}
                  <button
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-surface-secondary border border-gray-600 rounded-full flex items-center justify-center text-fg-secondary hover:text-red-500 hover:border-red-500 text-xs opacity-0 group-hover/img:opacity-100 transition-opacity"
                  >
                    ×
                  </button>
                </div>
              ))}
              {pendingImages.length < MAX_FILES && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-16 h-16 rounded-lg border border-dashed border-gray-600 flex items-center justify-center text-fg-tertiary hover:text-fg-secondary hover:border-gray-400 transition-colors shrink-0"
                  title={t('page.addMoreFiles')}
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
                </button>
              )}
            </div>
          )}
          {pendingImages.length > 0 && pendingImages.some(f => isImageFile(f)) && currentAgent && currentAgent.modelSupportsVision === false && (
            <div className="text-[10px] text-amber-500/80 mb-1.5 flex items-center gap-1">
              <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4m0 4h.01M12 2L2 22h20L12 2z" strokeLinecap="round" strokeLinejoin="round" /></svg>
              {t('page.visionWarning')}
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="image/*,.pdf,.docx,.xlsx,.pptx,.xls,.doc,.csv,.json,.xml,.html,.epub" multiple className="hidden" onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          {chatReplyTo && (
            <div className="flex items-center gap-2 mb-2 px-3 py-1.5 bg-surface-elevated rounded-lg border border-border-default/50">
              <div className="flex-1 min-w-0 pl-2 border-l-2 border-brand-500/50">
                <span className="text-[11px] font-medium text-brand-500">{chatReplyTo.sender}</span>
                <p className="text-[11px] text-fg-tertiary truncate">{chatReplyTo.text}</p>
              </div>
              <button onClick={() => setChatReplyTo(null)} className="text-fg-tertiary hover:text-fg-secondary shrink-0 p-0.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          )}
          <div className={composerExpanded ? 'flex flex-col gap-2 min-w-0' : 'flex gap-2 items-end min-w-0'}>
            <div className={composerExpanded ? 'flex gap-2 items-end min-w-0' : 'contents'}>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={chatMode === 'direct' && (!selectedAgent || isAgentOffline)}
                className={`${compactComposer ? 'p-1.5' : 'px-2.5 py-2.5'} text-fg-tertiary hover:text-fg-secondary disabled:opacity-40 transition-colors rounded-xl hover:bg-surface-elevated shrink-0 self-end mb-0.5`}
                title={t('page.attachFilesTitle')}
              >
                <svg className={compactComposer ? 'w-[18px] h-[18px]' : 'w-5 h-5'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => {
                  handleInputChange(e.target.value);
                  adjustTextareaHeight();
                }}
                onKeyDown={e => {
                  if (mentionDropdown && allMentionItems.length > 0) {
                    const isUp = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
                    const isDown = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
                    const isSelect = e.key === 'Enter' || e.key === 'Tab';
                    const isClose = e.key === 'Escape';
                    if (isUp) { e.preventDefault(); setMentionSelectedIndex(prev => (prev - 1 + allMentionItems.length) % allMentionItems.length); return; }
                    if (isDown) { e.preventDefault(); setMentionSelectedIndex(prev => (prev + 1) % allMentionItems.length); return; }
                    if (isSelect) {
                      e.preventDefault();
                      const sel = allMentionItems[mentionSelectedIndex];
                      if (sel) {
                        if (sel.kind === 'agent') insertMention(sel.agent.name);
                        else insertMention(sel.entity.name, sel.entity.entityType, sel.entity.id);
                      }
                      return;
                    }
                    if (isClose) { e.preventDefault(); setMentionDropdown(false); return; }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
                }}
                onPaste={handlePaste}
                placeholder={placeholder}
                disabled={chatMode === 'direct' && (!selectedAgent || isAgentOffline)}
                rows={compactComposer ? 1 : 2}
                className={`flex-1 min-w-0 w-full bg-transparent rounded-xl text-sm outline-none disabled:opacity-40 transition-colors resize-none overflow-y-auto leading-relaxed placeholder:text-fg-secondary ${
                  compactComposer ? 'px-2 py-1.5' : 'px-4 py-3'
                }`}
                style={{
                  minHeight: compactComposer ? '36px' : '52px',
                  maxHeight: compactComposer ? '160px' : '120px',
                }}
              />
            </div>
            <div className={`flex items-center gap-1.5 shrink-0 ${composerExpanded ? 'justify-end' : ''}`}>
              {chatMode === 'direct' && (
                <ChatModelMenu
                  value={sessionModelOverride}
                  disabled={!selectedAgent || isAgentOffline}
                  onSelect={(sel, applyGlobal) => {
                    setSessionModelOverride(sel);
                    const sid = activeSessionId && activeSessionId !== NEW_CHAT_PLACEHOLDER_ID ? activeSessionId : null;
                    void applyChatModelSelection(sid, sel, applyGlobal).catch(() => { /* ignore */ });
                    if (sid) {
                      setSessions(prev => prev.map(s =>
                        s.id === sid
                          ? { ...s, metadata: { ...(s.metadata ?? {}), modelOverride: sel } }
                          : s,
                      ));
                    }
                  }}
                />
              )}
              {sending && chatMode !== 'dm' ? (
                <button
                  onClick={stopSending}
                  className={`${compactComposer ? 'w-8 h-8 rounded-full flex items-center justify-center' : 'px-3 py-2.5 rounded-xl'} bg-red-600 hover:bg-red-500 text-white text-sm transition-colors`}
                  title={t('page.stopAgent')}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={() => void send()}
                  disabled={(chatMode === 'direct' && (!selectedAgent || isAgentOffline)) || (!input.trim() && pendingImages.length === 0)}
                  className={
                    compactComposer
                      ? 'w-8 h-8 rounded-full flex items-center justify-center bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white transition-colors'
                      : 'px-5 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-xl transition-colors'
                  }
                  title={t('common:send')}
                >
                  {compactComposer ? (
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    t('common:send')
                  )}
                </button>
              )}
            </div>
          </div>
          </div>
        </div>
        </div>
      </div>
      )}

      {/* ── Right-side resource panel (preview / selection-to-agent) ── */}
      {!isMobile && rightPanelPayload && collapseRightPanel && (
        <RightPanel
          payload={rightPanelPayload}
          onClose={collapseRightPanel}
          width={rightPanelFullscreen ? containerWidth : effectiveRightPanelWidth}
          onResizeStart={onRightPanelResizeStart}
          onAddToChat={addChatContext}
          tabs={rightPanelTabs}
          activeTabId={activeRightPanelTabId}
          onSelectTab={layout?.setActiveRightPanelTab}
          onCloseTab={layout?.closeRightPanelTab}
          onNewTab={() => {
            if (!openRightPanel) return;
            const browserId = `eb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
            openRightPanel({
              kind: 'url',
              url: 'about:blank',
              title: 'New Tab',
              browserId,
            });
          }}
          fullscreen={rightPanelFullscreen}
          onToggleFullscreen={layout?.toggleRightPanelFullscreen}
        />
      )}

    </div>
  );
}

function AgentStatusBadge({ agent, tasks, onViewProfile, streamActive }: {
  agent: AgentInfo;
  tasks: TaskInfo[];
  onViewProfile?: (agentId: string, opts?: { tab?: 'overview' }) => void;
  /** Chat SSE / local sending can outlive agent.status flipping back to idle. */
  streamActive?: boolean;
}) {
  const { t } = useTranslation(['team', 'common']);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const isWorking = agent.status === 'working' || !!streamActive;
  const isError = agent.status === 'error';
  const currentTask = isWorking ? tasks.find(t => t.assignedAgentId === agent.id && t.status === 'in_progress') : null;
  const activity = agent.currentActivity;

  useEffect(() => {
    if (isError && agent.lastError && isMarkusCreditError(agent.lastError)) {
      dispatchCreditNotification();
    }
  }, [isError, agent.lastError]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !popoverRef.current) return;
    const el = popoverRef.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    if (rect.right > vw - 8) {
      el.style.left = 'auto';
      el.style.right = '0';
    }
    if (rect.left < 8) {
      el.style.left = '0';
      el.style.right = 'auto';
    }
    const maxW = vw - 16;
    if (rect.width > maxW) {
      el.style.width = `${maxW}px`;
    }
  }, [open]);

  const dotColor = isError ? 'bg-red-400 animate-pulse'
    : isWorking ? 'bg-blue-400 animate-pulse' : 'bg-green-400';
  const label = isError ? t('common:status.error') : isWorking ? t('common:status.working') : t('common:status.idle');

  const activityLabel = activity
    ? activity.type === 'heartbeat' ? t('page.activityHeartbeat', { name: activity.heartbeatName ?? activity.label })
    : activity.type === 'chat' ? activity.label
    : activity.type === 'task' ? t('page.activityTask', { label: activity.label })
    : activity.label
    : t('page.processing');

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full transition-colors ${
          isWorking ? 'bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20'
          : isError ? 'bg-red-500/10 border border-red-500/20 hover:bg-red-500/20'
          : 'bg-green-500/10 border border-green-500/20 hover:bg-green-500/20'
        }`}
      >
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span className={`text-xs ${isError ? 'text-red-500' : isWorking ? 'text-blue-500' : 'text-green-600'}`}>{label}</span>
        {agent.mailboxDepth != null && agent.mailboxDepth > 0 && (
          <span className="text-[9px] bg-fg-tertiary/20 text-fg-tertiary rounded-full px-1.5">{agent.mailboxDepth}</span>
        )}
      </button>

      {open && isError && (
        <div ref={popoverRef} className="absolute top-full left-0 mt-1.5 bg-surface-secondary border border-red-500/30 rounded-xl shadow-2xl z-30 w-80 max-w-[calc(100vw-1rem)] p-3 space-y-2">
          <p className="text-[10px] text-red-500 uppercase font-semibold">{t('page.errorDetails')}</p>
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
            <pre className="text-[10px] text-red-500/80 leading-relaxed whitespace-pre-wrap break-all font-mono line-clamp-6">
              {friendlyAgentError(agent.lastError, t) || agent.lastError || t('page.agentErrorFallback')}
            </pre>
            {agent.lastErrorAt && <div className="text-[9px] text-red-500/50 mt-1.5 border-t border-red-500/10 pt-1">{new Date(agent.lastErrorAt).toLocaleString()}</div>}
          </div>
          <button
            onClick={() => { setOpen(false); onViewProfile?.(agent.id); }}
            className="w-full text-center text-[10px] text-red-500 hover:text-red-500 border border-red-500/30 hover:border-red-500/50 rounded-lg py-1 transition-colors"
          >
            {t('page.viewAgentProfileArrow')}
          </button>
        </div>
      )}

      {open && isWorking && (
        <div ref={popoverRef} className="absolute top-full left-0 mt-1.5 bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-30 w-80 max-w-[calc(100vw-1rem)] p-3 space-y-2">
          <p className="text-[10px] text-fg-tertiary uppercase font-semibold">{t('page.currentActivity')}</p>
          {currentTask ? (
            <div
              className="flex items-center gap-2 p-2 rounded-lg bg-brand-500/10 border border-brand-500/30 cursor-pointer hover:bg-brand-500/10 transition-colors"
              onClick={() => { setOpen(false); navBus.navigate(PAGE.WORK, { openTask: currentTask.id }); }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-brand-500 truncate">{currentTask.title}</div>
                <div className="text-[10px] text-fg-tertiary">{t('page.workingOnTaskHint')}</div>
              </div>
              <span className="text-[10px] text-fg-tertiary">→</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 p-2 rounded-lg bg-surface-elevated/50">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                activity?.type === 'heartbeat' ? 'bg-blue-400 animate-pulse'
                : activity?.type === 'chat' ? 'bg-blue-400 animate-pulse'
                : 'bg-blue-400 animate-pulse'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-fg-secondary">{activityLabel}</div>
                <div className="text-[10px] text-fg-tertiary">
                  {activity?.type === 'heartbeat' ? t('page.activityDescHeartbeat')
                   : activity?.type === 'chat' ? t('page.activityDescChat')
                   : t('page.activityDescFallback')}
                </div>
              </div>
            </div>
          )}
          <button
            onClick={() => { setOpen(false); onViewProfile?.(agent.id, { tab: 'overview' }); }}
            className="w-full text-center text-[10px] text-brand-500 hover:text-brand-500 border border-border-default hover:border-gray-600 rounded-lg py-1.5 transition-colors"
          >
            {t('page.viewMindArrow')}
          </button>
        </div>
      )}
    </div>
  );
}

