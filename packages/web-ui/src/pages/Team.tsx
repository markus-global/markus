import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  api, wsClient, invalidateApiCache,
  type AgentInfo, type AgentActivityInfo, type HumanUserInfo, type ExternalAgentInfo,
  type ChatMessageInfo, type ChatSessionInfo, type ChannelMessageInfo, type ChannelMsgMetadata,
  type TaskInfo, type TeamInfo, type AuthUser, type ApprovalInfo, type UserInputAnswer,
  type NotificationInfo,
} from '../api.ts';
import { MarkdownMessage, ImagePreviewModal } from '../components/MarkdownMessage.tsx';
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
import { renderMentionText } from '../components/CommentInput.tsx';
import { ChatTeamSidebar } from '../components/ChatTeamSidebar.tsx';
import { TeamDetailPanel } from '../components/TeamDetailPanel.tsx';
import { RightPanel } from '../components/RightPanel.tsx';
import { ChatSearchPanel, GroupMemberPanel, type PanelCandidate } from './teamPanels.tsx';
import { useLayout } from '../contexts/LayoutContext.tsx';
import { AgentProfile, type ProfileTab } from './AgentProfile.tsx';
import { TeamProfile, type TeamTab } from './TeamProfile.tsx';
import {
  type MainTab, AGENT_TABS, TEAM_TAB_SET, tabLabel, tabIcon, isProfileTab,
} from './tabDefs.ts';
import { useResizablePanel } from '../hooks/useResizablePanel.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { useUnreadCounts, useAgentUnread } from '../hooks/useUnreadCounts.ts';
import { usePageActive } from '../hooks/usePageActive.ts';
import { useConversationBuffers, makeConvKey, NEW_CHAT_PLACEHOLDER_ID } from '../hooks/useConversationBuffers.ts';
import { useChatStream, type ChatStreamVolatileState } from '../hooks/useChatStream.ts';
import { chatStore } from './useChatStore.ts';
import { Avatar } from '../components/Avatar.tsx';
import { ChatModelMenu, applyChatModelSelection, type ChatModelSelection } from '../components/ChatModelMenu.tsx';
import { ConfirmModal } from '../components/ConfirmModal.tsx';
import {
  type MsgSegment, type ChatMsg, type ChatMode,
  dbMsgToChat, channelMsgToChat, stripNotifyContext, insertChatMsgByCreatedAt,
  dedupeAdjacentUserMessages,
  stopRunningTools, hasStreamingTail,
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

// ─── Main Component ───────────────────────────────────────────────────────────

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

  const keyboardPane = layout?.keyboardPane ?? 'content';
  /**
   * L2 can be entered via L from L1 when a team context exists.
   * Independent of Cmd+B collapse — focus may stay on L1/L2 while rails are hidden.
   */
  const l2AvailableRef = useRef(false);
  const prevKeyboardPaneRef = useRef(keyboardPane);

  // Only auto-expand sidebars when *entering* L1/L2 (e.g. L from L0) — never fight Cmd+B.
  useEffect(() => {
    if (previewMode || isMobile || !isActive) return;
    const prev = prevKeyboardPaneRef.current;
    prevKeyboardPaneRef.current = keyboardPane;
    const entered = (keyboardPane === 'l1' || keyboardPane === 'l2') && prev !== keyboardPane;
    if (!entered) return;
    if (sidebarsCollapsed) {
      setSidebarsCollapsed(false);
      layout?.setLeftCollapsed(false);
    }
  }, [keyboardPane, previewMode, isMobile, isActive, sidebarsCollapsed, layout]);

  // Content → L2 (if open) or L1 via H. Further left moves are handled in L2/L1 components.
  useEffect(() => {
    if (previewMode || isMobile || !isActive) return;
    const onKey = (e: KeyboardEvent) => {
      const pane = layout?.keyboardPane ?? 'content';
      if (pane === 'l0' || pane === 'l1' || pane === 'l2') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
        if (e.target.closest('.xterm')) return;
      }
      const bare = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (bare !== 'h' && bare !== 'ArrowLeft') return;
      e.preventDefault();
      if (sidebarsCollapsed) {
        setSidebarsCollapsedPersisted(false);
        layout?.setLeftCollapsed(false);
      }
      layout?.setKeyboardPane(l2AvailableRef.current ? 'l2' : 'l1');
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [previewMode, isMobile, isActive, layout, sidebarsCollapsed, setSidebarsCollapsedPersisted]);

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
          kind?: 'url' | 'file' | 'deliverable' | 'terminal';
          url?: string;
          path?: string;
          title?: string;
          deliverableId?: string;
          terminalId?: string;
          cwd?: string;
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
      if (panel.kind === 'terminal') {
        const terminalId = panel.terminalId
          || `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        openRightPanel({
          kind: 'terminal',
          terminalId,
          title: panel.title || 'Terminal',
          cwd: panel.cwd,
        });
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

  // Parse a JSON array of context chips carried over navigation (e.g. from the
  // Deliverables page), turning each into a pending chat-context tag above the
  // input — same behaviour as right-panel "Add to conversation".
  const applyNavChatChips = useCallback((raw: string | null | undefined) => {
    if (!raw) return;
    try {
      const chips = JSON.parse(raw) as Array<{ label?: string; content?: string }>;
      if (!Array.isArray(chips) || chips.length === 0) return;
      const valid = chips.filter((c): c is { label: string; content: string } =>
        !!c && typeof c.content === 'string' && c.content.trim().length > 0);
      if (valid.length === 0) return;
      const withIds = valid.map(c => ({
        id: `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        label: c.label?.trim() || 'Context',
        content: c.content,
      }));
      setChatContext(prev => [...prev, ...withIds]);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      });
    } catch { /* malformed JSON → ignore silently */ }
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
    setActiveSession,
    currentConvKeyRef,
    updateConvMsgs, updateConvMsgsRaf, appendConvActivity,
    beginLoad, beginStream, endStream, resetConv, abortStream,
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
  // while the UI is still flushing thinking/text deltas. The tail scan is the
  // authoritative reattach-window signal (sending already ended, bubble still
  // isStreaming) — extracted to hasStreamingTail in ChatHelpers.
  const chatStreamActive = sending || streamingVisual || hasStreamingTail(messages);

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


  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  // Monotonic switch counter: only the LATEST switchSession may clear loadingChat.
  // Rapid tab switching otherwise lets an older request's finally{} kill the
  // spinner of the session that is actually being viewed now.
  const sessionSwitchSeqRef = useRef(0);
  // Image attachments
  const [pendingImages, setPendingImages] = useState<Array<{ id: string; dataUrl: string; name: string }>>([]);
  /** In-app lightbox for chat image attachments (avoid window.open on data: URLs). */
  const [imagePreviewSrc, setImagePreviewSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /**
   * The composer's model label.
   *   - non-null → the agent's OWN bound model (per-agent default)
   *   - null     → the agent follows global routing, and ChatModelMenu falls
   *                back to the global default itself.
   * Deliberately NOT session-scoped: every session of the same agent therefore
   * shows the same model, so switching tabs can never surface a foreign or
   * stale model name.
   */
  const [agentBoundModel, setAgentBoundModel] = useState<ChatModelSelection | null>(null);

  // Hydrate the composer's model label from the backend's authoritative
  // `effectiveModel`. This is the ONLY writer besides the composer's own
  // onSelect — no per-session/per-turn state is involved, so the label cannot
  // lag behind the agent it belongs to (the old code re-read a per-session
  // override *after* an awaited history fetch, which is why the name only
  // refreshed on a second visit / full reload).
  useEffect(() => {
    if (!selectedAgent) { setAgentBoundModel(null); return; }
    let cancelled = false;
    api.agents.get(selectedAgent)
      .then(d => {
        if (cancelled) return;
        const em = d.effectiveModel;
        setAgentBoundModel(
          em?.provider && em?.model ? { provider: em.provider, model: em.model } : null,
        );
      })
      .catch(() => { if (!cancelled) setAgentBoundModel(null); });
    return () => { cancelled = true; };
  }, [selectedAgent]);

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
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  // Inline rename state: which session is being renamed + the draft value
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renamingDraft, setRenamingDraft] = useState('');
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
  // Slash commands
  const [slashDropdown, setSlashDropdown] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [slashCommands, setSlashCommands] = useState<Array<{ name: string; description: string }>>([]);
  const slashCommandsLoadedRef = useRef(false);
  const loadSlashCommands = useCallback(() => {
    if (slashCommandsLoadedRef.current) return;
    slashCommandsLoadedRef.current = true;
    (async () => {
      try {
        const { skills } = await api.skills.list();
        setSlashCommands(skills.map(s => ({ name: s.name, description: s.description ?? s.name })));
      } catch { /* ignore */ }
    })();
  }, []);
  // Eager-load skills so slash commands are available immediately
  useEffect(() => { loadSlashCommands(); }, [loadSlashCommands]);
  const filteredSlashCmds = !slashFilter
    ? slashCommands
    : slashCommands.filter(c => c.name.toLowerCase().includes(slashFilter.toLowerCase()));

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
  const sendRef = useRef<(text?: string) => Promise<void>>(undefined);
  /**
   * SINGLE entry point for changing the active session view state. It always
   * keeps the manager's routing gate (ConversationBufferManager.activeSession)
   * in sync: a missing pin is exactly what lets a background session's stream
   * write into the shared display buffer (misordered / blank bubbles, the
   * multi-tab direct-mode bug family). Use this everywhere instead of calling
   * setActiveSessionId directly; paths that need resetConv (new chat / new
   * conversation) keep using the atomic resetConv(key, id) pair instead.
   */
  const changeActiveSession = useCallback((key: string, id: string | null) => {
    setActiveSessionId(id);
    if (!key) return;
    if (id === null) {
      bufMgr.clearActiveSession(key);
    } else {
      bufMgr.setActiveSession(key, id);
    }
  }, [setActiveSessionId, bufMgr]);
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

  // Keep the composer model reflecting the selected agent. When we switch agents,
  // fetch that agent's per-agent default model so the input shows it right away
  // (falls back to global when the agent has no bound model).
  useEffect(() => {
    let cancelled = false;
    if (previewMode || !selectedAgent || chatMode !== 'direct') {
      setAgentBoundModel(null);
      return;
    }
    api.agents.get(selectedAgent)
      .then(d => {
        if (cancelled) return;
        const lc = d.config?.llmConfig;
        setAgentBoundModel(
          lc?.modelMode === 'custom' && lc.primary && lc.defaultModel
            ? { provider: lc.primary, model: lc.defaultModel }
            : null,
        );
      })
      .catch(() => { if (!cancelled) setAgentBoundModel(null); });
    return () => { cancelled = true; };
  }, [selectedAgent, chatMode, previewMode]);

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
    const unsub = wsClient.on('agent:update', (event) => {
      // Apply the broadcast status/activity immediately — the throttled full
      // refresh below would otherwise coalesce a quick working→idle transition
      // into a single idle snapshot, so an agent that is actively streaming
      // (status cycling working while responses stream) would look idle.
      const p = event?.payload as Record<string, unknown> | undefined;
      if (p?.agentId) {
        const status = p.status as string | undefined;
        const currentActivity = p.currentActivity as AgentActivityInfo | undefined;
        // Authoritative stop: an offline agent can never be streaming. Force-clear
        // any stale frontend streaming refcount so the sidebar cannot stay pinned
        // to "working" after a missed endStream (abort / stop / disconnect path).
        if (status === 'offline') chatStore.clearAgentStreaming(p.agentId as string);
        setAgents(prev => prev.map(a => {
          if (a.id !== p.agentId) return a;
          const next = { ...a };
          if (status) next.status = status;
          if (currentActivity !== undefined) next.currentActivity = currentActivity;
          return next;
        }));
      }
      throttledRefreshAgents(); throttledRefreshTeams();
    });
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
        // 从交付物页跳转：右侧栏打开指定交付物预览。
        if (detail.params?.openDeliverable) {
          const did = detail.params.openDeliverable;
          localStorage.removeItem('markus_nav_openDeliverable');
          if (isMobile) {
            navBus.navigate(PAGE.DELIVERABLES, { openDeliverable: did });
          } else if (openRightPanel) {
            void api.deliverables.get(did).then(res => {
              if (res.deliverable) openRightPanel({ kind: 'deliverable', deliverable: res.deliverable });
            }).catch(() => { /* ignore missing deliverable */ });
          }
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
        if (detail.params?.chatChips) {
          const chipsRaw = detail.params.chatChips;
          localStorage.removeItem('markus_nav_chatChips');
          setMainTab('chat');
          applyNavChatChips(chipsRaw);
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
    const navChatChips = localStorage.getItem('markus_nav_chatChips');
    if (navChatChips) {
      localStorage.removeItem('markus_nav_chatChips');
      setMainTab('chat');
      applyNavChatChips(navChatChips);
    }
    // 交付物页跳转：右侧栏打开指定交付物预览（挂载前 navBus 已写入 localStorage）。
    const navOpenDeliverable = localStorage.getItem('markus_nav_openDeliverable');
    if (navOpenDeliverable) {
      localStorage.removeItem('markus_nav_openDeliverable');
      if (isMobile) {
        navBus.navigate(PAGE.DELIVERABLES, { openDeliverable: navOpenDeliverable });
      } else if (openRightPanel) {
        void api.deliverables.get(navOpenDeliverable).then(res => {
          if (res.deliverable) openRightPanel({ kind: 'deliverable', deliverable: res.deliverable });
        }).catch(() => { /* ignore missing deliverable */ });
      }
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

    // Post-removal navigation: go to team group chat instead of Secretary
    const navAfterRemove = localStorage.getItem('markus_nav_after_remove');
    if (navAfterRemove) {
      localStorage.removeItem('markus_nav_after_remove');
      if (navAfterRemove.startsWith('channel:')) {
        setChatMode('channel');
        setActiveChannel(navAfterRemove.slice(8));
        setMainTab('chat');
        return;
      }
    }

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

  // 右侧栏（chatRightReserve）开/关导致聊天区宽度变化：若用户本就在底部，
  // 重新贴底，避免因宽度变化导致内容上下跳动。
  const prevChatRightReserveRef = useRef(chatRightReserve);
  useEffect(() => {
    if (prevChatRightReserveRef.current === chatRightReserve) return;
    prevChatRightReserveRef.current = chatRightReserve;
    if (mainTab !== 'chat') return;
    if (visibleMessages.length === 0 || sending || loadingChat) return;
    if (!userAtBottomRef.current || userPinnedAwayRef.current) return;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const raf = requestAnimationFrame(() => scrollChatToBottom('instant'));
    for (const delay of [60, 160, 320]) {
      timers.push(setTimeout(() => scrollChatToBottom('instant'), delay));
    }
    return () => { cancelAnimationFrame(raf); for (const t of timers) clearTimeout(t); };
  }, [chatRightReserve, mainTab, visibleMessages.length, sending, loadingChat, scrollChatToBottom]);

  // Load channel messages from DB → store in buffer + update display
  // `quiet` skips the loading spinner — used by the WS reconnect catch-up so
  // a background refetch does not flash loading UI over an already-visible chat.
  const loadChannelMessages = useCallback(async (channel: string, bufferKey?: string, opts?: { quiet?: boolean }) => {
    const key = bufferKey ?? `ch:${channel}`;
    if (!opts?.quiet && currentConvKeyRef.current === key) setLoadingChat(true);
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
      if (!opts?.quiet && currentConvKeyRef.current === key) setLoadingChat(false);
    }
  }, []);

  // Load sessions list for agent (paginated — History panel loads 20 at a time)
  const loadSessions = useCallback(async (agentId: string) => {
    if (!agentId) { setSessions([]); setSessionsTotal(0); setSessionsPage(1); setSessionsHasMore(false); return []; }
    try {
      const res = await api.sessions.listByAgent(agentId, 20, 1);
      setSessions(res.sessions);
      setSessionsTotal(res.total ?? res.sessions.length);
      setSessionsPage(res.page ?? 1);
      setSessionsHasMore(!!res.hasMore);
      return res.sessions;
    } catch { setSessions([]); setSessionsTotal(0); setSessionsPage(1); setSessionsHasMore(false); return []; }
  }, []);

  // ── useChatStream: streaming orchestration extracted into a hook ──────────
  // Team.tsx owns ALL app state; the hook ONLY borrows it via ctx + stateRef.
  const streamVolatileRef = useRef<ChatStreamVolatileState>({
    chatContext: [], input: '', pendingImages: [],
    chatMode, selectedAgent, activeSessionId,
    activeDmUserId, authUser, activeChannel,
    groupChats, agents, humans, sending,
    chatReplyTo: null,
  });
  streamVolatileRef.current = {
    chatContext, input, pendingImages,
    chatMode, selectedAgent, activeSessionId,
    activeDmUserId, authUser, activeChannel,
    groupChats, agents, humans, sending,
    chatReplyTo,
  };
  const chatStream = useChatStream({
    stateRef: streamVolatileRef,
    msgBuffers, actBuffers, sessionMsgCache, activeSessionBuffer, currentConvKeyRef,
    updateConvMsgs, updateConvMsgsRaf, appendConvActivity,
    beginStream, endStream, abortStream, clearStreamSession, setStreamSession, getStreamSession,
    setActiveSession,
    incrementSending, decrementSending, loadAndDisplay,
    thinkingTimeoutRef, sessionSwitchSeqRef, oldestMsgId,
    setSending, setActivities, setInput, setChatContext, setPendingImages,
    setMentionDropdown, setChatReplyTo, setActiveSessionId, setStoredActiveSession,
    setOpenSessionTabs, setSessions, setLoadingChat, setHasMore, setThinkingAgents,
    makeConvKey, makeDmChannel, addRecentMsgId, resumeChatScrollFollow, loadSessions,
    t,
  });
  const { send: hookSend, stopSending, tryReattachActiveStream, loadSessionMessages } = chatStream;
  sendRef.current = hookSend;

  // Load session messages from DB — phase-aware via ConversationBufferManager.
  // (loadSessionMessages moved into useChatStream hook — see above)

  // (tryReattachActiveStream moved into useChatStream hook)

  // Returning to Team after visiting another page: reattach if a generation is
  // still running (SSE may have been killed while the tab was hidden).
  //
  // The callback is held in a ref on purpose: it used to sit in the deps array
  // while its own identity was unstable, so this effect re-fired on EVERY
  // render. Combined with the unconditional stream-membership bump inside
  // clearStreamSession that produced an infinite render loop (~120/s, no DOM
  // change, 100%+ CPU) exactly while the UI was idle. Depend only on real keys.
  const reattachRef = useRef(tryReattachActiveStream);
  reattachRef.current = tryReattachActiveStream;
  useEffect(() => {
    if (!isActive || previewMode || chatMode !== 'direct' || !selectedAgent) return;
    const sid = activeSessionId;
    if (!sid || sid === NEW_CHAT_PLACEHOLDER_ID) return;
    void reattachRef.current(selectedAgent, sid, currentConvKeyRef.current);
  }, [isActive, previewMode, chatMode, selectedAgent, activeSessionId]);

  // Load older sessions (append to the list) — History panel "load more"
  const loadMoreSessions = useCallback(async () => {
    if (sessionsLoadingMore || !selectedAgent || !sessionsHasMore) return;
    setSessionsLoadingMore(true);
    const nextPage = sessionsPage + 1;
    const agentId = selectedAgent;
    try {
      const res = await api.sessions.listByAgent(agentId, 20, nextPage);
      setSessions(prev => {
        const seen = new Set(prev.map(s => s.id));
        const merged = [...prev, ...res.sessions.filter(s => !seen.has(s.id))];
        setSessionsTotal(res.total ?? merged.length);
        return merged;
      });
      setSessionsPage(nextPage);
      setSessionsHasMore(!!res.hasMore);
    } catch { /* keep current state */ }
    setSessionsLoadingMore(false);
  }, [sessionsLoadingMore, sessionsHasMore, sessionsPage, selectedAgent]);

  // Rename a session (inline in the History panel)
  const startRenameSession = useCallback((s: ChatSessionInfo) => {
    setRenamingSessionId(s.id);
    setRenamingDraft((s.isMain ? '' : s.title) || '');
  }, []);
  const cancelRenameSession = useCallback(() => {
    setRenamingSessionId(null);
    setRenamingDraft('');
  }, []);
  const submitRenameSession = useCallback(async (s: ChatSessionInfo) => {
    const title = renamingDraft.trim();
    if (!title) { cancelRenameSession(); return; }
    try {
      const res = await api.sessions.renameTitle(s.id, title);
      const newTitle = res?.session?.title ?? title;
      setSessions(prev => prev.map(x => x.id === s.id ? { ...x, title: newTitle } : x));
      // Keep any open session tab in sync
      setOpenSessionTabs(prev => prev.map(x => x.id === s.id ? { ...x, title: newTitle } : x));
    } catch { /* best effort */ }
    cancelRenameSession();
  }, [renamingDraft, cancelRenameSession]);

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
        changeActiveSession(newKey, savedActiveSession);
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
            // changeActiveSession keeps view state and the manager routing gate
            // in sync (single entry) — a concurrently-streaming OTHER session
            // of this agent cannot land chunks in this buffer (same bug family
            // as switchSession).
            changeActiveSession(newKey, validId);
            setStoredActiveSession(selectedAgent!, validId);
            setOpenSessionTabs(initialTabs);
            void loadSessionMessages(validId!, newKey).then(() => {
              if (currentConvKeyRef.current === newKey && selectedAgent) {
                void tryReattachActiveStream(selectedAgent, validId!, newKey);
              }
            });
          } else {
            // No sessions exist yet — view has no active session and the gate
            // is unpinned so a stray background stream is conservatively routed
            // to its own cache (isDisplayRoute), never into this empty view.
            changeActiveSession(newKey, null);
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
        rawCreatedAt: (event.timestamp as string | undefined) ?? new Date().toISOString(),
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
      // Insert ordered by createdAt and skip ids already present in the buffer
      // (reconnect catch-up + late WS events must not duplicate history).
      updateConvMsgs(key, prev => insertChatMsgByCreatedAt(prev, newMsg));

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

  // WS reconnect catch-up. The server does NOT replay events that were sent
  // while the socket was down (it ignores the `since` param), but every
  // successful connection emits `connected`. When several agents reply to a
  // group message concurrently and one finishes inside the reconnect gap, its
  // persisted message would never reach the UI → the bubble looks stuck until
  // a manual refresh. On every reconnect (after the initial connect, which the
  // normal load path already covers) refetch the active channel history.
  const wsFirstConnectedRef = useRef(false);
  useEffect(() => {
    if (previewMode) return;
    const unsub = wsClient.on('connected', () => {
      const first = !wsFirstConnectedRef.current;
      wsFirstConnectedRef.current = true;
      if (first) return;
      if (chatMode === 'channel' && activeChannel) {
        void loadChannelMessages(activeChannel, undefined, { quiet: true });
      }
    });
    return unsub;
  }, [previewMode, chatMode, activeChannel, loadChannelMessages]);

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

  // Session title renamed (agent session_rename tool or another tab) — keep the
  // History panel list + open session tabs in sync without a full reload.
  useEffect(() => {
    if (previewMode) return;
    const unsub = wsClient.on('session:title_updated', (event) => {
      const p = event.payload as Record<string, unknown> | undefined;
      if (!p) return;
      const sessionId = p['sessionId'] as string | undefined;
      const title = p['title'] as string | undefined;
      if (!sessionId || typeof title !== 'string') return;
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title } : s));
      setOpenSessionTabs(prev => prev.map(s => s.id === sessionId ? { ...s, title } : s));
    });
    return unsub;
  }, [previewMode]);

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
        // Insert chronologically (never append) so the user bubble stays BEFORE
        // the agent reply even when the fallback arrives after the reply.
        let base = prev;
        if (!isUserTurn && fallbackUserText) {
          const hasUser = base.some(m =>
            (fallbackUserId && m.id === fallbackUserId)
            || (m.sender === 'user' && m.text === fallbackUserText),
          );
          if (!hasUser) {
            base = insertChatMsgByCreatedAt(base, {
              id: fallbackUserId || `feishu_user_${newMsg.id}`,
              sender: 'user' as const,
              text: fallbackUserText,
              time: new Date().toLocaleTimeString(),
              // Bubble clock mirrors the agent reply's start time so a fallback
              // user turn is never placed after the in-flight response.
              rawCreatedAt: newMsg.rawCreatedAt,
            });
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

  const [rememberTarget, setRememberTarget] = useState<ChatMsg | null>(null);
  const [rememberBusy, setRememberBusy] = useState(false);


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
    void hookSend(retryText, { isRetry: true });
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

    // Resolve the conversation's session id EXPLICITLY. A resume only makes
    // sense against an already-bound session: relying on the async view state
    // (activeSessionId) meant that after an app restart — before the view had
    // re-attached — the request went out with no session id and the backend
    // started a brand-new session, handing the model the "[Continue…]" prompt
    // with ZERO prior context.
    const resumeSessionId = activeSessionBuffer.get(convKey)
      ?? (activeSessionId && activeSessionId !== NEW_CHAT_PLACEHOLDER_ID ? activeSessionId : null);
    if (!resumeSessionId) {
      // Nothing to resume into — refuse rather than silently creating a new session.
      console.warn('[resume] no session bound to this conversation — resume aborted');
      return;
    }

    // Send a hidden continuation prompt — the backend reattaches to the bound
    // session and lets the LLM pick up where it left off.
    void hookSend(
      '[Continue from where you left off. Do not repeat content already generated.]',
      { isResume: true, sessionIdOverride: resumeSessionId },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, updateConvMsgs, activeSessionId]);

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
      // reset + re-pin atomically: resetConv deletes the manager's activeSession
      // for this key, then re-pins to the child session — so a stream from the
      // PARENT session still running on the backend is routed to its own cache,
      // never mixed into this new conversation's buffer.
      resetConv(key, childSession.id);
      setStoredActiveSession(selectedAgent, childSession.id);
      setMessages([]);
      setHasMore(false);
      oldestMsgId.current = null;
      await hookSend(result.seedPrompt, { sessionIdOverride: result.sessionId });
    } catch (err) {
      console.error('evolve-from-message failed', err);
    } finally {
      setRememberBusy(false);
    }
  };

  const switchSession = async (s: ChatSessionInfo) => {
    const switchSeq = ++sessionSwitchSeqRef.current;
    const prevSessionId = activeSessionId;
    const key = currentConvKeyRef.current;
    // Single entry point: updates view state + manager routing gate together.
    // Without the gate pin the gate stays on whatever resetConv pinned last
    // (new-chat placeholder) or undefined, so `updateMessages` judges every
    // stream same-session: a still-running stream from the PREVIOUS tab keeps
    // writing into the shared display buffer and mixes its bubbles into THIS
    // tab (user bubble lands below a streaming agent bubble / blank bubble
    // until refresh — the multi-tab direct-mode corruption family).
    changeActiveSession(key, s.id);
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
    const streamingSessions = getStreamSession(key);
    const streamForThis = !!streamingSessions && (streamingSessions.has(s.id) || streamingSessions.has(NEW_CHAT_PLACEHOLDER_ID));
    const isStreaming = isSendingFor(key) && streamForThis;
    setSending(isStreaming);
    if (isStreaming) {
      setActivities(actBuffers.get(s.id) ?? []);
    } else {
      setActivities([]);
    }
    if (selectedAgent) setStoredActiveSession(selectedAgent, s.id);
    if (prevSessionId && prevSessionId !== NEW_CHAT_PLACEHOLDER_ID) {
      saveSessionToCache(key, prevSessionId);
    }
    // If this session has no cached messages yet, show the loading state
    // immediately instead of a blank "new chat" surface while the DB fetch
    // is in flight. The try/finally guarantees the spinner is cleared even
    // when loadSessionMessages' own showSpinner guard doesn't fire (e.g. the
    // currentConvKey ref lags the just-switched activeSessionId).
    const restored = restoreSessionFromCache(key, s.id);
    if ((!restored || restored.length === 0) && s.id !== NEW_CHAT_PLACEHOLDER_ID) {
      setLoadingChat(true);
    }
    setOpenSessionTabs(prev => prev.some(t => t.id === s.id) ? prev : [...prev, s]);
    // Remove from closed-tabs list since user explicitly opened it
    if (selectedAgent) removeClosedTab(selectedAgent, s.id);
    // Always attempt DB load to sync with server. The phase-aware loadSessionMessages
    // blocks display writes during streaming, preventing race conditions.
    // Only the most recent switch may clear loadingChat (rapid tab switching).
    if (currentConvKeyRef.current !== key) currentConvKeyRef.current = key;
    try {
      await loadSessionMessages(s.id, key);
    } finally {
      if (sessionSwitchSeqRef.current === switchSeq) setLoadingChat(false);
    }
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
    // No model state to reset: the composer's label follows the AGENT (its own
    // bound model, else global routing), never the session — so a fresh chat
    // cannot inherit a foreign pick.
    const key = currentConvKeyRef.current;
    // reset + re-pin atomically: resetConv deletes the manager's activeSession
    // for this key, then re-pins it to the new-chat placeholder so a
    // still-running stream from a PREVIOUS session is routed to its own session
    // cache (isSameSession=false) instead of being written into the fresh
    // new-chat buffer — this is what mixed concurrent streams together and made
    // content land in the wrong bubbles.
    resetConv(key, NEW_CHAT_PLACEHOLDER_ID);
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
    // Mint a REAL session id right away so this tab is isolated from the start.
    // The first message then carries its own conversation identity
    // (`conv:<sessionId>`) — the key the backend's entity affinity locks on.
    // With only a placeholder, two fresh tabs share no distinguishable entity and
    // both fall back to `system:<agentId>`, i.e. they serialise instead of running
    // in parallel.
    const agentForNew = selectedAgent;
    if (agentForNew) {
      void api.sessions.create(agentForNew)
        .then(res => {
          const created = res?.session;
          if (!created?.id) return;
          const newId = created.id;
          // Adopt only if the user is STILL on this fresh, still-unbound tab —
          // otherwise a late response would hijack a conversation already in flight.
          if (currentConvKeyRef.current !== key) return;
          const pinned = activeSessionBuffer.get(key);
          if (pinned !== undefined && pinned !== NEW_CHAT_PLACEHOLDER_ID) return;
          changeActiveSession(key, newId);
          setStoredActiveSession(agentForNew, newId);
          setOpenSessionTabs(prev => prev.map(tab =>
            tab.id === NEW_CHAT_PLACEHOLDER_ID
              ? { ...tab, id: newId, title: created.title ?? tab.title }
              : tab,
          ));
        })
        .catch(() => { /* best-effort — if this fails the first message mints one server-side */ });
    }
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

    // ---- / slash command detection ----
    if (slashCommands.length > 0) {
      const slashIdx = textBeforeCursor.lastIndexOf('/');
      if (slashIdx >= 0) {
        const charBeforeSlash = slashIdx === 0 ? '' : textBeforeCursor[slashIdx - 1]!;
        const isValidSlashPos = slashIdx === 0 || /[\s\n,，。！？!?;；:：、（）()\[\]【】]/.test(charBeforeSlash);
        if (isValidSlashPos) {
          const slashFragment = textBeforeCursor.slice(slashIdx + 1);
          if (!slashFragment.includes(' ') && !slashFragment.includes('\n')) {
            loadSlashCommands();
            setSlashDropdown(true);
            setSlashFilter(slashFragment.toLowerCase());
            setSlashSelectedIndex(0);
            return;
          }
        }
      }
    }
    setSlashDropdown(false);
  };

  const insertSlashCommand = useCallback((cmd: { name: string; description: string }) => {
    const cursorPos = textareaRef.current?.selectionStart ?? input.length;
    const before = input.slice(0, cursorPos);
    const slashIdx = before.lastIndexOf('/');
    const after = input.slice(cursorPos);
    const newVal = input.slice(0, slashIdx) + '/' + cmd.name + ' ' + after;
    setInput(newVal);
    setSlashDropdown(false);
    setSlashSelectedIndex(0);
    const newPos = slashIdx + cmd.name.length + 2;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newPos, newPos);
    });
  }, [input]);

  const insertMention = (name: string, entityType?: string, entityId?: string) => {
    const cursorPos = textareaRef.current?.selectionStart ?? input.length;
    const before = input.slice(0, cursorPos);
    const atIdx = before.lastIndexOf('@');
    const after = input.slice(cursorPos);
    // 移除输入框中已输入的 @ + 过滤片段，改为在输入框上方生成标签（与右侧栏“添加到对话”一致）
    const newVal = input.slice(0, atIdx) + after;
    setInput(newVal);
    setMentionDropdown(false);
    setMentionSelectedIndex(0);
    const content = entityType && entityId
      ? `@[${name}](${entityType}:${entityId})`
      : name.includes(' ') ? `@[${name}]` : `@${name}`;
    const icon = entityType ? (ENTITY_TYPE_ICON[entityType] ?? '📄') : '🤖';
    addChatContext({ label: `${icon} ${name}`, content: `${content} ` });
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
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
  const l2TeamId = activeTeamId ?? (chatMode === 'direct' ? currentAgent?.teamId : undefined);
  /** Team context exists so L from L1 may enter L2 (even if Cmd+B currently hides rails). */
  const l2Navigable = !!(
    !isMobile && !rightPanelFullscreen && l2TeamId
    && teams.some(t => t.id === l2TeamId)
  );
  /** L2 panel is actually on screen (not collapsed by Cmd+B). */
  const l2Visible = !!(
    l2Navigable && !sidebarsCollapsed
    && ((showTeamDetailPanel && !l2SpaceTight) || l2Floating)
  );
  l2AvailableRef.current = l2Navigable;

  // Leave L2 focus only when the user closes L2 or loses team context — not on Cmd+B collapse.
  useEffect(() => {
    if (keyboardPane !== 'l2') return;
    if (!l2Navigable) {
      layout?.setKeyboardPane('l1');
      return;
    }
    if (!sidebarsCollapsed && !showTeamDetailPanel && !l2Floating) {
      layout?.setKeyboardPane('l1');
    }
  }, [keyboardPane, l2Navigable, sidebarsCollapsed, showTeamDetailPanel, l2Floating, layout]);

  // When *entering* L2 (L from L1), open the team detail panel. Do not undo Cmd+B.
  const prevPaneForL2Ref = useRef(keyboardPane);
  useEffect(() => {
    if (previewMode || isMobile || !isActive) return;
    const prev = prevPaneForL2Ref.current;
    prevPaneForL2Ref.current = keyboardPane;
    if (keyboardPane !== 'l2' || prev === 'l2') return;
    if (!l2TeamId) {
      layout?.setKeyboardPane('l1');
      return;
    }
    if (l2SpaceTight) setL2Floating(true);
    else setShowTeamDetailPanel(true);
  }, [keyboardPane, previewMode, isMobile, isActive, l2TeamId, l2SpaceTight, layout]);

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
  // Loading label: name the conversation being loaded, instead of a generic
  // "Loading conversation…" (UX: switching to a session with history should
  // not look like a brand-new chat while the history loads).
  const loadingChatLabel = useMemo(() => {
    if (chatMode === 'direct') {
      const sess = sessions.find(s => s.id === activeSessionId);
      if (sess?.title) return sess.title;
      if (currentAgent?.name) return currentAgent.name;
    }
    return (chatMode === 'channel'
      ? (activeGroupChat?.name ?? activeChannel)
      : activeDmUser?.name) || t('page.loadingChat', { defaultValue: 'Loading conversation…' });
  }, [chatMode, sessions, activeSessionId, currentAgent?.name, activeChannel, activeDmUserId, activeGroupChat?.name, activeDmUser?.name, t]);

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
        focused={!isMobile && !sidebarsCollapsed && keyboardPane === 'l1'}
        l2Available={l2Navigable}
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
            activeDmUserId={activeDmUserId}
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
            focused={keyboardPane === 'l2' && l2Visible}
          />
        );
      })()}
      {/* Floating mode: when space is tight, show as overlay */}
      {!rightPanelFullscreen && l2Floating && !isMobile && !sidebarsCollapsed && (() => {
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
                activeDmUserId={activeDmUserId}
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
                focused={keyboardPane === 'l2' && l2Visible}
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
              <div data-electron-drag className="flex items-center px-4 h-14 gap-2.5">
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
                  <div data-no-drag className="shrink-0">
                  {chatMode === 'channel' && activeTeamId ? (
                    <div className="w-9 h-9 rounded-xl bg-brand-600 text-white flex items-center justify-center text-sm font-bold">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    </div>
                  ) : (
                    <Avatar name={headerAvatarName} avatarUrl={headerAvatarUrl} size={36} className="rounded-xl shrink-0" />
                  )}
                  </div>
                )}

                {/* Name & Description (inline editable) */}
                {showEntityInfo ? (
                  <div data-no-drag className="flex-1 min-w-0">
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
                <div data-no-drag className="ml-auto flex items-center gap-2 shrink-0">
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
            <ChatSearchPanel
              searchQuery={searchQuery}
              searchLoading={searchLoading}
              searchResults={searchResults}
              onInputChange={handleSearchInput}
              onResultClick={handleSearchResultClick}
              onClose={() => { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); }}
            />
          )}

          {/* Session tab bar (direct mode, chat tab) — hide when only 1 session */}
          {chatMode === 'direct' && selectedAgent && mainTab === 'chat' && openSessionTabs.length > 1 && (() => {
            // Which of THIS agent's sessions currently have an in-flight stream.
            // Read live from the buffer manager during render;
            // useConversationBuffers bumps its own state on every membership
            // change, so a BACKGROUND tab's dot appears/disappears without
            // needing the user to switch to it first.
            const liveStreamSessions = getStreamSession(currentConvKeyRef.current);
            const isStreamingTab = (s: ChatSessionInfo) =>
              (liveStreamSessions?.has(s.id) ?? false)
              // Pre-`session_start` window: a brand-new chat streams before the
              // server assigns a real session id, so the active tab is the only
              // one that can be generating.
              || (sending && s.id === activeSessionId);
            return (
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
                      // Same atomic reset + re-pin as newConversation(): keeps a
                      // concurrently-streaming PREVIOUS session out of this tab.
                      const key = currentConvKeyRef.current;
                      resetConv(key, NEW_CHAT_PLACEHOLDER_ID);
                      setMessages([]);
                    } else {
                      void switchSession(s);
                    }
                  }}
                >
                  {s.isMain && <span className="text-[10px] opacity-50 shrink-0">●</span>}
                  <span className="truncate">{s.id === NEW_CHAT_PLACEHOLDER_ID ? t('page.newChat') : (s.isMain ? t('page.sessionMain') : (s.title || t('page.sessionConversation')))}</span>
                  {isStreamingTab(s) && (
                    // Same "agent working" signal as the sidebar (L1) — a blue
                    // pulsing dot, shown only while this session is generating.
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0"
                      title={t('common:status.working')}
                      aria-label={t('common:status.working')}
                      data-testid="session-tab-streaming"
                    />
                  )}
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
            );
          })()}
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
            const allCandidates: PanelCandidate[] = [];
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
              <GroupMemberPanel
                members={currentMembers}
                candidates={allCandidates}
                currentUserId={authUser?.id}
                memberCount={currentMembers.length}
                onClose={() => setShowMemberPanel(false)}
                onRemoveMember={(memberId) => {
                  void api.groupChats.removeMember(gc.id, memberId).then(() => {
                    setGroupChats(prev => prev.map(g => g.id === gc.id ? { ...g, members: (g.members ?? []).filter(x => x.id !== memberId), memberCount: (g.memberCount ?? 1) - 1 } : g));
                  }).catch(() => {});
                }}
                onAddMember={(candidateId) => {
                  const c = allCandidates.find(x => x.id === candidateId);
                  if (!c) return;
                  void api.groupChats.addMember(gc.id, c.id, c.type, c.name).then(() => {
                    setGroupChats(prev => prev.map(g => g.id === gc.id ? {
                      ...g,
                      members: [...(g.members ?? []), { id: c.id, name: c.name, type: c.type }],
                      memberCount: (g.memberCount ?? 0) + 1,
                    } : g));
                  }).catch(() => {});
                }}
              />
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
                        <div
                          key={s.id}
                          className={`w-full text-left px-3 py-2 rounded-lg text-xs mb-0.5 transition-colors ${
                            s.id === activeSessionId ? 'bg-brand-600/20 text-brand-500' : 'hover:bg-surface-elevated'
                          }`}
                        >
                          {renamingSessionId === s.id ? (
                            <div className="flex items-center gap-1.5">
                              <input
                                autoFocus
                                value={renamingDraft}
                                onChange={(e) => setRenamingDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') { e.stopPropagation(); void submitRenameSession(s); }
                                  if (e.key === 'Escape') cancelRenameSession();
                                }}
                                onClick={(e) => e.stopPropagation()}
                                placeholder={s.isMain ? t('page.sessionMain') : (s.title || t('page.sessionConversation'))}
                                className="w-full bg-surface-primary border border-brand-500/50 rounded-md px-2 py-1 text-xs text-fg-primary outline-none focus:ring-1 focus:ring-brand-500/50"
                              />
                              <button
                                onClick={(e) => { e.stopPropagation(); void submitRenameSession(s); }}
                                className="text-brand-400 hover:text-brand-300 shrink-0"
                                title={t('common:save')}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); cancelRenameSession(); }}
                                className="text-fg-tertiary hover:text-fg-secondary shrink-0"
                                title={t('common:cancel')}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => void switchSession(s)}
                              className="w-full text-left group/session"
                            >
                              <div className="truncate font-medium flex items-center gap-1">
                                {s.isMain && <span className="text-[10px] text-brand-500 opacity-80">●</span>}
                                <span className="truncate">{s.isMain ? t('page.sessionMain') : (s.title || t('page.sessionConversation'))}</span>
                                {!s.isMain && (
                                  <span
                                    role="button"
                                    tabIndex={0}
                                    onClick={(e) => { e.stopPropagation(); startRenameSession(s); }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); startRenameSession(s); } }}
                                    className="opacity-0 group-hover/session:opacity-100 transition-opacity ml-auto text-fg-tertiary hover:text-brand-400 shrink-0"
                                    title={t('page.renameSession')}
                                  >
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
                                  </span>
                                )}
                              </div>
                              <div className="text-fg-tertiary text-[10px] mt-0.5">{new Date(s.lastMessageAt).toLocaleString()}</div>
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ));
                })()}
                {sessionsHasMore && (
                  <button
                    onClick={() => void loadMoreSessions()}
                    disabled={sessionsLoadingMore}
                    className="w-full text-center text-[11px] text-fg-tertiary hover:text-brand-400 py-2 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {sessionsLoadingMore ? t('page.loadingEarlierMessages') : `${t('page.loadMoreSessions')} (${sessions.length}/${sessionsTotal})`}
                  </button>
                )}
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
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-xs text-fg-tertiary animate-pulse">
                  {t('page.loadingChat', { defaultValue: 'Loading conversation…' })}
                </span>
                <span className="text-[11px] text-fg-quaternary max-w-[70%] truncate">{loadingChatLabel}</span>
              </div>
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
          <div ref={chatScrollRef} className={`${isEmptyChat ? 'hidden' : 'flex-1'} overflow-y-auto scrollbar-thin ${isMobile ? 'p-2.5' : `p-5 ${chatRightReserve}`}`} onScroll={handleChatScroll} onTouchStart={isMobile ? mainTabSwipe.onTouchStart : undefined} onTouchEnd={isMobile ? mainTabSwipe.onTouchEnd : undefined}>

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
                                  <img
                                    key={idx}
                                    src={src}
                                    alt=""
                                    className="max-w-[200px] max-h-[150px] rounded-lg object-cover cursor-pointer hover:opacity-80 transition-opacity"
                                    onClick={() => setImagePreviewSrc(src)}
                                  />
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
                          ? (isStreamingMsg && !msg.text?.trim()
                            ? <ActivityIndicator activities={activities} isActive />
                            : <ErrorBoundary
                                resetKeys={[msg.text]}
                                fallback={<div className="whitespace-pre-wrap break-words text-sm text-fg-secondary">{msg.text}</div>}
                              >
                                <MarkdownMessage content={msg.text} className="text-sm text-fg-secondary" onMentionClick={handleMentionClick} knownNames={agentNames} />
                              </ErrorBoundary>)
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

          {/* Scroll to bottom — normal flow row above the input, never floats over it */}
          {showScrollBtn && mainTab === 'chat' && (
            <div
              className={`flex justify-center ${isMobile ? 'px-3' : `px-5 ${chatRightReserve}`} shrink-0 ${isMobile ? 'pb-1 pt-0' : 'pb-1'}`}
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
                    <span className="flex items-baseline gap-1.5 min-w-0">
                      <span className="flex-1 text-sm font-medium text-fg-primary truncate">{a.title}</span>
                      <span className="text-[10px] text-fg-tertiary shrink-0 whitespace-nowrap">{formatSmartTime(a.requestedAt, a.requestedAt, dateLabels)}</span>
                    </span>
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
                      <span className="flex items-baseline gap-1.5 min-w-0">
                        <span className="flex-1 text-sm font-medium text-fg-primary truncate">{n.title}</span>
                        <span className="text-[10px] text-fg-tertiary shrink-0 whitespace-nowrap">{formatSmartTime(n.createdAt, n.createdAt, dateLabels)}</span>
                      </span>
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
        <div data-keep-edit-focus className={`${isMobile ? 'px-3 py-2' : 'px-5 py-3'} relative shrink-0 ${isEmptyChat ? '' : chatRightReserve}`} onDrop={handleDrop} onDragOver={handleDragOver}>
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
          {slashDropdown && filteredSlashCmds.length > 0 && (
            <div className="absolute bottom-full left-4 mb-1 bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden z-10 max-h-64 max-w-xs w-72 overflow-y-auto">
              <div className="px-3 py-1.5 text-[10px] text-fg-tertiary font-medium uppercase tracking-wider border-b border-border-default">
                {t('page.slashSkill')}
              </div>
              {filteredSlashCmds.map((cmd, i) => (
                <button
                  key={cmd.name}
                  ref={el => { if (i === slashSelectedIndex && el) el.scrollIntoView({ block: 'nearest' }); }}
                  onClick={() => insertSlashCommand(cmd)}
                  onMouseEnter={() => setSlashSelectedIndex(i)}
                  className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2 transition-colors ${
                    i === slashSelectedIndex ? 'bg-brand-500/15 text-brand-500' : 'text-fg-secondary hover:bg-surface-overlay'
                  }`}
                >
                  <span className="text-xs w-5 h-5 flex items-center justify-center shrink-0">🔧</span>
                  <span className="flex-1 min-w-0 truncate font-mono text-[13px]">/{cmd.name}</span>
                  <span className="text-[10px] text-fg-tertiary ml-auto shrink-0 max-w-[100px] truncate">{cmd.description}</span>
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
                  // IME composition guard (中文/日文/韩文输入法):
                  // While the input method is composing (e.g. pinyin), pressing
                  // Enter commits the composition into the textarea, NOT send.
                  const nat = e.nativeEvent;
                  if (nat.isComposing === true || nat.keyCode === 229) return;
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
                  if (slashDropdown && filteredSlashCmds.length > 0) {
                    const isUp = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
                    const isDown = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
                    const isSelect = e.key === 'Enter' || e.key === 'Tab';
                    const isClose = e.key === 'Escape';
                    if (isUp) { e.preventDefault(); setSlashSelectedIndex(prev => (prev - 1 + filteredSlashCmds.length) % filteredSlashCmds.length); return; }
                    if (isDown) { e.preventDefault(); setSlashSelectedIndex(prev => (prev + 1) % filteredSlashCmds.length); return; }
                    if (isSelect) { e.preventDefault(); const cmd = filteredSlashCmds[slashSelectedIndex]; if (cmd) insertSlashCommand(cmd); return; }
                    if (isClose) { e.preventDefault(); setSlashDropdown(false); return; }
                  }
                  // Escape leaves the composer so JK/HL on the current keyboard pane work again.
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.currentTarget.blur();
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void hookSend(); }
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
                  value={agentBoundModel}
                  agentId={selectedAgent}
                  disabled={!selectedAgent || isAgentOffline}
                  onSelect={(sel, scope) => {
                    if (scope === 'agent') {
                      // Bind the model to the AGENT: every session of this agent
                      // then shows (and uses) it — no per-session divergence.
                      setAgentBoundModel(sel);
                      void applyChatModelSelection(sel, scope, selectedAgent).catch(() => { /* ignore */ });
                      return;
                    }
                    // Global pick: update global routing AND reset the current
                    // agent to "follow global" — so the shown label equals both
                    // the global default and the agent's actual model (no
                    // ambiguity). The agent no longer carries a model of its own,
                    // so the label falls back to the global default.
                    setAgentBoundModel(null);
                    void applyChatModelSelection(sel, scope, selectedAgent).catch(() => { /* ignore */ });
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
                  onClick={() => void hookSend()}
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
          {/* Shift+Enter hint — only while the user is typing (any composer mode) */}
          {(input.trim() || pendingImages.length > 0) && (
            <div className="mt-0.5 flex justify-end px-1 pointer-events-none select-none">
              <span className="text-[10px] text-fg-tertiary/80">{t('common:shiftEnterHint')}</span>
            </div>
          )}
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
            if (layout?.rightPanelMode === 'terminal') {
              const terminalId = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
              openRightPanel({
                kind: 'terminal',
                terminalId,
                title: 'Terminal',
              });
              return;
            }
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
          onBrowserMeta={layout?.updateRightPanelBrowserTab
            ? (browserId, meta) => layout.updateRightPanelBrowserTab(browserId, meta)
            : undefined}
          panelMode={layout?.rightPanelMode ?? 'browser'}
          onPanelModeChange={(mode) => layout?.switchRightPanelMode(mode)}
          onTerminalMeta={layout?.updateRightPanelTerminalTab
            ? (terminalId, meta) => layout.updateRightPanelTerminalTab(terminalId, meta)
            : undefined}
          onOpenUrlFromTerminal={(url) => {
            if (!openRightPanel) return;
            const browserId = `eb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
            openRightPanel({ kind: 'url', url, title: url, browserId });
          }}
          onOpenPathFromTerminal={(path) => {
            openRightPanel?.({ kind: 'file', path, title: path.split(/[/\\]/).pop() || path });
          }}
        />
      )}

      {imagePreviewSrc && (
        <ImagePreviewModal src={imagePreviewSrc} onClose={() => setImagePreviewSrc(null)} />
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
  const isWorking = agent.status === 'working' || (!!streamActive && agent.status !== 'offline');
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

