import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  api, wsClient,
  type AgentInfo, type AgentToolEvent, type StreamCommitEvent, type HumanUserInfo, type ExternalAgentInfo,
  type ChatMessageInfo, type ChatSessionInfo, type ChannelMessageInfo, type ChannelMsgMetadata,
  type TaskInfo, type TeamInfo, type AuthUser,
} from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { ActivityIndicator, type ActivityStep } from '../components/ActivityIndicator.tsx';
import {
  ToolCallRow, ExecEntryRow, ThinkingDots,
  taskLogToEntry, activityLogToEntry, filterCompletedStarts, attachSubagentLogsToEntries,
  type ExecEntry, type ExecutionStreamEntryUI,
} from '../components/ExecutionTimeline.tsx';
import { navBus } from '../navBus.ts';
import { PAGE, resolvePageId, hashPath } from '../routes.ts';
import { parseMentionNames, renderMentionText } from '../components/CommentInput.tsx';
import { ChatTeamSidebar } from '../components/ChatTeamSidebar.tsx';
import { TeamDetailPanel } from '../components/TeamDetailPanel.tsx';
import { AgentProfile, TAB_DEF as AGENT_TAB_DEF, type ProfileTab } from './AgentProfile.tsx';
import { TeamProfile, TABS as TEAM_TABS, type TeamTab } from './TeamProfile.tsx';
import { useResizablePanel } from '../hooks/useResizablePanel.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { useUnreadCounts, useAgentUnread } from '../hooks/useUnreadCounts.ts';
import { usePageActive } from '../hooks/usePageActive.ts';
import { Avatar } from '../components/Avatar.tsx';
import {
  type MsgSegment, type ChatMsg, type ChatMode,
  dbMsgToChat, channelMsgToChat, stripNotifyContext,
  formatSmartTime, getDateKey, formatDateLabel, throttle,
} from './ChatHelpers.ts';
import {
  NotificationBadge, ChatAgentLink, AvatarPopover, MessageActions,
  AgentMessageBody, segmentsToStreamEntries, friendlyAgentError,
} from './ChatComponents.tsx';
export type { MsgSegment };

function agentInitials(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

// Components extracted to ChatComponents.tsx:
// NotificationBadge, ChatAgentLink, AvatarPopover, friendlyAgentError,
// MessageActions, segmentsToStreamEntries, AgentMessageBody

// (AvatarPopover, ChatAgentLink extracted to ChatComponents.tsx)

// ─── Main Component ───────────────────────────────────────────────────────────

type MainTab = 'chat' | 'profile'
  | 'overview' | 'files' | 'tools' | 'skills' | 'memory' | 'deliverables'
  | 'announcements' | 'norms' | 'settings';

const AGENT_TABS: MainTab[] = ['chat', 'overview', 'files', 'tools', 'skills', 'memory', 'deliverables'];
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

  // Sidebars collapsed: user can collapse both L1 and L2 together
  const [sidebarsCollapsed, setSidebarsCollapsed] = useState(false);

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
    if (isMobile || previewMode) return;
    const el = teamContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const containerW = entry.contentRect.width;
      const chatAreaIfL2 = containerW - chatSidebar.width - teamDetailPanel.width;
      setL2SpaceTight(chatAreaIfL2 < 400);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobile, previewMode, chatSidebar.width, teamDetailPanel.width]);

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
  const recentMsgIds = useRef<Set<string>>(new Set());
  const addRecentMsgId = (id: string) => {
    recentMsgIds.current.add(id);
    if (recentMsgIds.current.size > 100) {
      const first = recentMsgIds.current.values().next().value;
      if (first) recentMsgIds.current.delete(first);
    }
  };

  // ── Per-conversation buffers ──────────────────────────────────────────────────
  // Each conversation (agentId / channelName) stores its own message array
  // so that switching away never destroys in-progress streaming content.
  const msgBuffers    = useRef<Map<string, ChatMsg[]>>(new Map());
  const actBuffers    = useRef<Map<string, ActivityStep[]>>(new Map());
  const sendingConvs  = useRef<Set<string>>(new Set());
  // Which conv key the user is currently viewing (used inside async callbacks)
  const currentConvKeyRef = useRef<string>('');

  // Displayed state — always mirrors the current conv's buffer
  const [messages, setMessages] = useState<ChatMsg[]>(() => {
    if (previewData?.channelMessages) {
      const ch = previewData.activeChannel ?? 'custom:general';
      return previewData.channelMessages.filter(m => m.channel === ch).map(m => channelMsgToChat(m));
    }
    return [];
  });
  const [input, setInput] = useState('');
  const [chatReplyTo, setChatReplyTo] = useState<{ id: string; sender: string; text: string } | null>(null);
  const [sending, setSending] = useState(false);
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

  const [activities, setActivities] = useState<ActivityStep[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Image attachments
  const [pendingImages, setPendingImages] = useState<Array<{ id: string; dataUrl: string; name: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.max(52, Math.min(el.scrollHeight, 120));
    el.style.height = `${h}px`;
    el.style.overflowY = h >= 120 ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  // Session management (direct mode)
  const NEW_CHAT_PLACEHOLDER_ID = '__new_chat__';
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [openSessionTabs, setOpenSessionTabs] = useState<ChatSessionInfo[]>([]);
  const sessionTabsBuffer = useRef<Map<string, ChatSessionInfo[]>>(new Map());
  const activeSessionBuffer = useRef<Map<string, string | null>>(new Map());
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const oldestMsgId = useRef<string | null>(null);
  const loadingSessionRef = useRef<string | null>(null);

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
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
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
      if (!cancelled) setEntityMentionItems(items);
    };
    void load();
    return () => { cancelled = true; };
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

  const makeConvKey = (mode: ChatMode, agent: string, channel: string, dmUserId?: string) =>
    mode === 'channel' ? `ch:${channel}` :
    mode === 'dm'      ? `dm:${dmUserId ?? ''}` :
    (agent || '_direct');

  const MAX_MESSAGES_PER_CONV = 500;
  const MAX_BUFFERED_CONVERSATIONS = 5;

  /** Write to a conversation's message buffer and refresh display if currently viewing it */
  const rafPendingRef = useRef<number | null>(null);
  const updateConvMsgs = useCallback((key: string, updater: (prev: ChatMsg[]) => ChatMsg[]) => {
    let next = updater(msgBuffers.current.get(key) ?? []);
    if (next.length > MAX_MESSAGES_PER_CONV) {
      next = next.slice(-MAX_MESSAGES_PER_CONV);
    }
    msgBuffers.current.set(key, next);
    if (msgBuffers.current.size > MAX_BUFFERED_CONVERSATIONS) {
      const keys = [...msgBuffers.current.keys()];
      const toEvict = keys
        .filter(k => k !== key && k !== currentConvKeyRef.current)
        .slice(0, keys.length - MAX_BUFFERED_CONVERSATIONS);
      for (const k of toEvict) {
        msgBuffers.current.delete(k);
        actBuffers.current.delete(k);
        sessionTabsBuffer.current.delete(k);
        activeSessionBuffer.current.delete(k);
      }
    }
    if (currentConvKeyRef.current === key) setMessages(next);
  }, []);

  const updateConvMsgsRaf = useCallback((key: string, updater: (prev: ChatMsg[]) => ChatMsg[]) => {
    let next = updater(msgBuffers.current.get(key) ?? []);
    if (next.length > MAX_MESSAGES_PER_CONV) {
      next = next.slice(-MAX_MESSAGES_PER_CONV);
    }
    msgBuffers.current.set(key, next);
    if (currentConvKeyRef.current === key && rafPendingRef.current === null) {
      rafPendingRef.current = requestAnimationFrame(() => {
        rafPendingRef.current = null;
        const latest = msgBuffers.current.get(key);
        if (latest && currentConvKeyRef.current === key) setMessages([...latest]);
      });
    }
  }, []);

  useEffect(() => () => {
    if (rafPendingRef.current !== null) cancelAnimationFrame(rafPendingRef.current);
  }, []);

  /** Append an activity step to a conversation's activity buffer */
  const appendConvActivity = (key: string, step: ActivityStep) => {
    const next = [...(actBuffers.current.get(key) ?? []), step];
    actBuffers.current.set(key, next);
    if (currentConvKeyRef.current === key) setActivities(next);
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
    const unsubGroup = wsClient.on('chat:group_created', () => { throttledRefreshGroupChats(); throttledRefreshTeams(); });
    const unsubGroupUpdate = wsClient.on('chat:group_updated', throttledRefreshGroupChats);
    const unsubGroupDelete = wsClient.on('chat:group_deleted', () => { throttledRefreshGroupChats(); throttledRefreshTeams(); });
    const onDataChanged = () => { refreshAgents(); refreshTeams(); refreshHumans(); };
    window.addEventListener('markus:data-changed', onDataChanged);
    return () => { clearInterval(timer); clearInterval(teamTimer); unsub(); unsubTeamUpdate(); unsubTeamOnAgentRemoved(); unsubGroup(); unsubGroupUpdate(); unsubGroupDelete(); window.removeEventListener('markus:data-changed', onDataChanged); };
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
          handleViewProfile(detail.params.selectAgent);
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
            if (teamGc) { setChatMode('channel'); setActiveChannel(teamGc.channelKey); setMainTab('chat'); setShowMemberPanel(false); setShowTeamDetailPanel(true); }
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
      const navPrefill = localStorage.getItem('markus_nav_prefillMessage');
      if (navPrefill) {
        setChatMode('direct');
        setSelectedAgent(navAgent);
        setMainTab('chat');
        if (isMobile) enterMobileDetail();
      } else {
        handleViewProfile(navAgent, pTab ? { tab: pTab as 'overview' } : undefined);
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
      handleViewProfile(selectAgent);
    }
    const selectTeam = localStorage.getItem('markus_nav_selectTeam');
    if (selectTeam) {
      localStorage.removeItem('markus_nav_selectTeam');
      if (isMobile) {
        enterMobileTeam(selectTeam);
      } else {
        pendingSelectTeamRef.current = selectTeam;
      }
    }
    window.addEventListener('markus:navigate', handleNav);
    return () => window.removeEventListener('markus:navigate', handleNav);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode]);

  useEffect(() => {
    const teamId = pendingSelectTeamRef.current;
    if (!teamId || groupChats.length === 0) return;
    const teamGc = groupChats.find(gc => gc.type === 'team' && gc.teamId === teamId);
    if (teamGc) {
      pendingSelectTeamRef.current = null;
      setChatMode('channel'); setActiveChannel(teamGc.channelKey); setMainTab('chat'); setShowMemberPanel(false); setShowTeamDetailPanel(true);
    }
  }, [groupChats]);

  // Auto-select secretary agent when no valid agent is selected.
  // Also handles stale IDs from localStorage (e.g. deleted agents).
  useEffect(() => {
    if (previewMode && previewData?.chatMode === 'channel') return;
    if (agents.length === 0) return;
    if (selectedAgent && agents.some(a => a.id === selectedAgent)) return;
    const secretary = agents.find(a => a.role === 'secretary')
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

  // Track whether the user is at the bottom of the chat scroll container.
  // Every scroll event checks position; programmatic scrolls (from
  // scrollChatToBottom) are flagged so they don't flip userAtBottomRef off.
  const isProgrammaticScrollRef = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const newMsgCountRef = useRef(0);
  const [newMsgCount, setNewMsgCount] = useState(0);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const isAtBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const onScroll = () => {
      if (isProgrammaticScrollRef.current) return;
      if (isAtBottom()) {
        userAtBottomRef.current = true;
        setShowScrollBtn(false);
        newMsgCountRef.current = 0;
        setNewMsgCount(0);
      } else {
        userAtBottomRef.current = false;
        setShowScrollBtn(true);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, [mobileLayer]);

  // visibleMessages + virtualizer must be declared before scrollChatToBottom
  const visibleMessages = useMemo(() =>
    chatMode === 'channel' ? messages : messages.filter(m => !m.isActivityLog),
    [messages, chatMode]
  );
  const chatVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => chatScrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
  });

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = 'instant') => {
    isProgrammaticScrollRef.current = true;
    if (visibleMessages.length > 0) {
      chatVirtualizer.scrollToIndex(visibleMessages.length - 1, { align: 'end', behavior });
    } else {
      const el = chatScrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior });
    }
    requestAnimationFrame(() => { isProgrammaticScrollRef.current = false; });
  }, [visibleMessages.length, chatVirtualizer]);

  // ── Preserve scroll position across page-level navigation ──
  // PageSlot now uses visibility:hidden + position:absolute instead of
  // display:none, so the scroll container keeps its dimensions and scrollTop.
  // No save/restore logic needed — the browser preserves scroll position natively.
  const isActiveRef = useRef(isActive);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);

  // Snap to bottom after DOM updates, but only if user hasn't scrolled up.
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
    if (!userAtBottomRef.current) return;
    scrollChatToBottom();
  }, [messages, activities, scrollChatToBottom, chatVirtualizer]);

  const prevMainTabRef = useRef(mainTab);
  useEffect(() => {
    const wasProfile = prevMainTabRef.current !== 'chat';
    prevMainTabRef.current = mainTab;
    if (mainTab === 'chat' && wasProfile && userAtBottomRef.current) {
      requestAnimationFrame(() => scrollChatToBottom());
    }
  }, [mainTab, scrollChatToBottom]);

  // Load channel messages from DB → store in buffer + update display
  const loadChannelMessages = useCallback(async (channel: string, bufferKey?: string) => {
    const key = bufferKey ?? `ch:${channel}`;
    try {
      const result = await api.channels.getMessages(channel, 50);
      const msgs = result.messages.map(m => channelMsgToChat(m, authUser?.id));
      msgBuffers.current.set(key, msgs);
      if (currentConvKeyRef.current === key) {
        setMessages(msgs);
        setHasMore(result.hasMore);
        oldestMsgId.current = result.messages[0] ? new Date(result.messages[0].createdAt).toISOString() : null;
      }
    } catch {
      if (currentConvKeyRef.current === key) { setMessages([]); setHasMore(false); }
    }
  }, []);

  // Load session messages from DB → store in buffer + update display
  const loadSessionMessages = useCallback(async (sessionId: string, convKey: string): Promise<number> => {
    loadingSessionRef.current = sessionId;
    try {
      const result = await api.sessions.getMessages(sessionId, 50);
      const msgs = result.messages.map(dbMsgToChat).filter(m =>
        m.sender !== 'agent' || m.text || (m.segments && m.segments.length > 0)
      );
      msgBuffers.current.set(convKey, msgs);
      if (currentConvKeyRef.current === convKey && loadingSessionRef.current === sessionId) {
        setMessages(msgs);
        setHasMore(result.hasMore);
        oldestMsgId.current = result.messages[0] ? new Date(result.messages[0].createdAt).toISOString() : null;
      }
      return msgs.length;
    } catch {
      if (currentConvKeyRef.current === convKey && loadingSessionRef.current === sessionId) { setMessages([]); setHasMore(false); oldestMsgId.current = null; }
      return 0;
    }
  }, []);

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
          if (combined.length > MAX_MESSAGES_PER_CONV) combined = combined.slice(-MAX_MESSAGES_PER_CONV);
          msgBuffers.current.set(convKey, combined);
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
          if (combined.length > MAX_MESSAGES_PER_CONV) combined = combined.slice(-MAX_MESSAGES_PER_CONV);
          msgBuffers.current.set(convKey, combined);
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
      sessionTabsBuffer.current.set(prevKey, openSessionTabs);
      activeSessionBuffer.current.set(prevKey, activeSessionId);
      userAtBottomRef.current = true;
      setShowScrollBtn(false);
      newMsgCountRef.current = 0;
      setNewMsgCount(0);
    }

    // Restore displayed state from this conv's buffer
    const bufferedMsgs = msgBuffers.current.get(newKey);
    const bufferedActs = actBuffers.current.get(newKey) ?? [];
    const isSending = sendingConvs.current.has(newKey);

    setActivities(bufferedActs);
    setSending(isSending);

    // Always reload sessions list for direct mode so History panel stays accurate
    if (chatMode === 'direct' && selectedAgent) {
      loadSessions(selectedAgent);
    }
    // Restore or reset session tabs for the new agent
    const savedTabs = sessionTabsBuffer.current.get(newKey);
    const savedActiveSession = activeSessionBuffer.current.get(newKey);
    if (savedTabs && savedTabs.length > 0) {
      setOpenSessionTabs(savedTabs);
    }
    // If no saved tabs, we'll populate from DB below for direct mode
    setShowSessions(false);

    if (bufferedMsgs !== undefined) {
      // Already have content (possibly mid-stream) — show immediately
      setMessages(bufferedMsgs);
      setHasMore(false);
      if (savedActiveSession !== undefined) {
        setActiveSessionId(savedActiveSession);
      }
      if (!savedTabs || savedTabs.length === 0) setOpenSessionTabs([]);
      // For channel/dm modes, refresh from server in background to catch anything we missed
      if (chatMode === 'channel' || chatMode === 'dm') {
        const channelName = chatMode === 'dm'
          ? makeDmChannel(authUser?.id ?? '', activeDmUserId)
          : activeChannel;
        loadChannelMessages(channelName, newKey);
      }
    } else {
      // First visit for this conversation — load from DB
      setMessages([]);
      setHasMore(false);
      oldestMsgId.current = null;

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
            const defaultTabs = mainSession
              ? [mainSession, ...s.filter(ss => !ss.isMain).slice(0, 4)]
              : s.slice(0, 5);
            const initialTabs = (savedTabs && savedTabs.length > 0) ? savedTabs : defaultTabs;
            const restoreId = savedActiveSession !== undefined ? savedActiveSession : (mainSession?.id ?? initialTabs[0]!.id);
            const validId = restoreId && initialTabs.some(t => t.id === restoreId) ? restoreId : initialTabs[0]!.id;
            setActiveSessionId(validId);
            setOpenSessionTabs(initialTabs);
            loadSessionMessages(validId!, newKey);
          } else {
            setActiveSessionId(null);
            if (!savedTabs || savedTabs.length === 0) setOpenSessionTabs([]);
          }
        });
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

  // WS live updates for proactive agent messages (direct mode)
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
      const meta = (p['metadata'] as Record<string, unknown>) ?? {};
      if (!agentId || !message) return;
      if (message === '[cancelled]' || message === '[Stream cancelled]') return;

      const isActivity = !!meta.activityLog || message.startsWith('[ACTIVITY:');

      // Strip notify_context HTML comments from real-time messages
      const { cleaned: displayMessage, priority: parsedPriority } = stripNotifyContext(message);
      const isNotify = !!meta.notifyUser || displayMessage !== message;

      // Always buffer the message for this agent's conversation so it's
      // visible when the user switches to that agent (not just when already viewing)
      const newMsg: ChatMsg = {
        id: `proactive_${Date.now()}`,
        sender: 'agent',
        text: displayMessage,
        time: new Date().toLocaleTimeString(),
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
      };
      const key = makeConvKey('direct', agentId, '', '');
      updateConvMsgs(key, prev => [...prev, newMsg]);
    });
    return unsub;
  }, [previewMode, updateConvMsgs, t]);

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
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    // Immediately unblock the UI — don't wait for the async send() to catch the abort
    const sendKey = currentConvKeyRef.current;
    sendingConvs.current.delete(sendKey);
    actBuffers.current.delete(sendKey);
    setSending(false);
    setActivities([]);
    // Tell the backend to stop the agent's active stream so it doesn't keep
    // processing after the SSE connection is torn down.
    if (chatMode === 'direct' && selectedAgent) {
      void api.agents.cancelProcessing(selectedAgent).catch(() => {});
    }
  };

  const send = async (retryText?: string, options?: { isRetry?: boolean; isResume?: boolean }) => {
    const text = (retryText ?? input).trim();
    if (!text && pendingImages.length === 0) return;
    if (chatMode === 'direct' && !selectedAgent) return;
    userAtBottomRef.current = true;

    // If agent is currently streaming, interrupt it first then proceed
    if (sending) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      if (chatMode === 'direct' && selectedAgent) {
        void api.agents.cancelProcessing(selectedAgent).catch(() => {});
      }
      const prevKey = currentConvKeyRef.current;
      sendingConvs.current.delete(prevKey);
      actBuffers.current.delete(prevKey);
      // Mark the current agent message as stopped, keeping any partial content.
      // If the agent hadn't produced any content yet, remove the empty bubble entirely.
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
      // Small delay to let abort propagate before starting new stream
      await new Promise(r => setTimeout(r, 50));
    }

    const imagesToSend = pendingImages.length > 0 ? pendingImages.map(img => img.dataUrl) : undefined;
    const fileNamesToSend = pendingImages.length > 0 ? pendingImages.map(img => img.name) : undefined;
    const sendKey = makeConvKey(chatMode, selectedAgent, activeChannel, activeDmUserId);
    const replyCtx = chatReplyTo;

    if (!retryText) {
      setInput('');
    }
    setPendingImages([]);
    setMentionDropdown(false);
    setChatReplyTo(null);

    // Mark this conv as sending (skip for DM — instant DB write, no LLM wait)
    const isDm = chatMode === 'dm';
    sendingConvs.current.add(sendKey);
    actBuffers.current.set(sendKey, []);
    if (currentConvKeyRef.current === sendKey && !isDm) {
      setSending(true);
      setActivities([]);
    }

    if (chatMode === 'dm') {
      // Human-to-human DM or personal notepad — no agent routing
      const dmChannel = makeDmChannel(authUser?.id ?? '', activeDmUserId);
      const optId = `opt_${Date.now()}`;
      const userMsgDm: ChatMsg = { id: optId, sender: 'user', text, time: new Date().toLocaleTimeString() };
      if (replyCtx) { userMsgDm.replyToId = replyCtx.id; userMsgDm.replyToSender = replyCtx.sender; userMsgDm.replyToText = replyCtx.text; }
      updateConvMsgs(sendKey, prev => [...prev, userMsgDm]);
      try {
        const result = await api.channels.sendMessage(dmChannel, {
          text, senderName: authUser?.name ?? t('page.fallbackYou'),
          senderId: authUser?.id,
          mentions: [], orgId: 'default',
          humanOnly: true, // never route to agents
        });
        if (result.userMessage) addRecentMsgId(result.userMessage.id);
        updateConvMsgs(sendKey, prev => {
          const without = prev.filter(m => m.id !== optId);
          const newMsgs: ChatMsg[] = [];
          if (result.userMessage) newMsgs.push(channelMsgToChat(result.userMessage, authUser?.id));
          return newMsgs.length > 0 ? [...without, ...newMsgs] : prev;
        });
      } catch (e) {
        updateConvMsgs(sendKey, prev => [...prev, {
          id: `err_${Date.now()}`, sender: 'agent', text: t('page.errorWithMessage', { message: String(e) }),
          time: new Date().toLocaleTimeString(), agentName: t('page.systemName'), isError: true,
        }]);
      }
      sendingConvs.current.delete(sendKey);
      if (currentConvKeyRef.current === sendKey) setSending(false);
    } else if (chatMode === 'channel') {
      const optId = `opt_${Date.now()}`;
      const userMsgCh: ChatMsg = { id: optId, sender: 'user', text, time: new Date().toLocaleTimeString() };
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
        const friendly = friendlyAgentError(e, t) || t('page.errorWithMessage', { message: String(e) });
        updateConvMsgs(sendKey, prev => [...prev, {
          id: `err_${Date.now()}`, sender: 'agent', text: friendly,
          time: new Date().toLocaleTimeString(), agentName: t('page.systemName'), isError: true,
        }]);
        if (thinkingTimeoutRef.current) { clearTimeout(thinkingTimeoutRef.current); thinkingTimeoutRef.current = null; }
        setThinkingAgents([]);
      }
      sendingConvs.current.delete(sendKey);
      if (currentConvKeyRef.current === sendKey) setSending(false);
    } else {
      // direct — build an interleaved segment stream
      const agentMsgId = `a_${Date.now()}`;
      if (options?.isResume) {
        // Resume: don't add a duplicate user message — just append the
        // agent continuation placeholder after the existing partial response.
        const agentCreatedAt = new Date().toISOString();
        updateConvMsgs(sendKey, prev => [
          ...prev,
          { id: agentMsgId, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt, segments: [] },
        ]);
      } else {
        const agentCreatedAt = new Date().toISOString();
        const userMsg: ChatMsg = { id: `u_${Date.now()}`, sender: 'user', text, time: new Date().toLocaleTimeString() };
        if (imagesToSend?.length) userMsg.images = imagesToSend;
        if (replyCtx) { userMsg.replyToId = replyCtx.id; userMsg.replyToSender = replyCtx.sender; userMsg.replyToText = replyCtx.text; }
        updateConvMsgs(sendKey, prev => [
          ...prev,
          userMsg,
          { id: agentMsgId, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt, segments: [] },
        ]);
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
        });
      };

      /** Handle server-committed per-turn text/thinking entries (clean, non-fragmented) */
      const handleCommitEvent = (event: StreamCommitEvent) => {
        lastSseEventTimeRef.current = Date.now();
        // Capture sessionId early so subsequent messages continue in the same session
        // even if the stream is aborted before the final 'done' event.
        if (event.type === 'session_start' && event.sessionId) {
          if (currentConvKeyRef.current === sendKey) {
            setActiveSessionId(event.sessionId);
            setOpenSessionTabs(prev =>
              prev.map(t => t.id === NEW_CHAT_PLACEHOLDER_ID ? { ...t, id: event.sessionId! } : t)
            );
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
        });
      };

      /** Handle a tool event: start adds a 'running' segment, end updates it, output appends live text */
      const handleToolEvent = (event: AgentToolEvent) => {
        lastSseEventTimeRef.current = Date.now();
        if (event.phase === 'heartbeat') return;
        if (event.phase === 'start' || event.phase === 'end') {
          appendConvActivity(sendKey, { ...event, phase: event.phase, ts: Date.now() });
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
            // Only add to committedSegments from agent_tool start (has arguments,
            // arrives AFTER thinking_commit/text_commit) — NOT from tool_call_start
            // (no arguments, arrives before commits, would cause wrong ordering).
            const committed = [...(u[idx]!.committedSegments ?? [])];
            if (event.arguments !== undefined) {
              committed.push({ type: 'tool', key: toolKey, tool: event.tool, status: 'running', args: event.arguments, createdAt: now });
            }
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed };
            return u;
          });
        } else if (event.phase === 'output') {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const segs = [...(u[idx]!.segments ?? [])];
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                segs[i] = { ...s, liveOutput: (s.liveOutput ?? '') + (event.output ?? '') };
                break;
              }
            }
            u[idx] = { ...u[idx]!, segments: segs };
            return u;
          });
        } else if (event.phase === 'subagent_progress' && event.subagentEvent) {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const segs = [...(u[idx]!.segments ?? [])];
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i]!;
              if (s.type === 'tool' && (s.tool === 'spawn_subagent' || s.tool === 'spawn_subagents') && s.status === 'running') {
                segs[i] = { ...s, subagentLogs: [...(s.subagentLogs ?? []), event.subagentEvent!] };
                break;
              }
            }
            u[idx] = { ...u[idx]!, segments: segs };
            return u;
          });
        } else {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const now = new Date().toISOString();
            const segs = [...(u[idx]!.segments ?? [])];
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                segs[i] = { ...s, status: event.success === false ? 'error' : 'done', args: event.arguments, result: event.result, error: event.error, durationMs: event.durationMs, liveOutput: undefined, createdAt: now };
                break;
              }
            }
            const committed = [...(u[idx]!.committedSegments ?? [])];
            for (let i = committed.length - 1; i >= 0; i--) {
              const s = committed[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                committed[i] = { ...s, status: event.success === false ? 'error' : 'done', args: event.arguments, result: event.result, error: event.error, durationMs: event.durationMs, liveOutput: undefined, createdAt: now };
                break;
              }
            }
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed };
            return u;
          });
        }
      };

      const abortCtrl = new AbortController();
      abortControllerRef.current = abortCtrl;

      try {
        lastSseEventTimeRef.current = Date.now();
        const effectiveSessionId = activeSessionId === NEW_CHAT_PLACEHOLDER_ID ? null : activeSessionId;
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
        );
        if (currentConvKeyRef.current === sendKey) {
          // Message was merged into the agent's active processing — remove the
          // empty agent placeholder bubble since no separate reply will arrive.
          if (streamResult.merged) {
            updateConvMsgs(sendKey, prev => prev.filter(m => m.id !== agentMsgId));
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
              const finalSegs: MsgSegment[] = streamResult.segments!.map((s, i) =>
                s.type === 'tool'
                  ? { type: 'tool' as const, key: `${s.tool}_${i}`, tool: s.tool, status: s.status, args: s.arguments, result: s.result, error: s.error, durationMs: s.durationMs, createdAt: s.createdAt }
                  : { type: 'text' as const, content: s.content, thinking: s.thinking, createdAt: s.createdAt }
              );
              // Reconstruct text from segments if both streamResult.content and
              // accumulated msg.text are empty — prevents blank bubble when all
              // content arrived via text_commit events.
              let finalText = streamResult.content || u[idx]!.text;
              if (!finalText) {
                finalText = finalSegs
                  .filter(s => s.type === 'text')
                  .map(s => (s as { content: string }).content)
                  .join('');
              }
              u[idx] = { ...u[idx]!, text: finalText, segments: finalSegs, committedSegments: finalSegs };
              return u;
            });
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
              if (committed.length > 0 || finalText) {
                u[idx] = { ...msg, text: finalText, segments: committed.length > 0 ? committed : msg.segments };
              }
              return u;
            });
          }

          if (streamResult.sessionId) {
            setActiveSessionId(streamResult.sessionId);
            setOpenSessionTabs(prev =>
              prev.map(t => t.id === NEW_CHAT_PLACEHOLDER_ID ? { ...t, id: streamResult.sessionId! } : t)
            );
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
          });
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
          });
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
      });

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
        });
      }

      // Fallback: if the agent message is empty (SSE connection may have dropped),
      // poll the session messages to recover the persisted reply.
      // Use the actual session ID from the stream result (or activeSessionId) instead
      // of blindly fetching the "latest" session which could be a different conversation.
      const currentMsgs = msgBuffers.current.get(sendKey) ?? [];
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
                });
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
      if (abortControllerRef.current === abortCtrl || abortControllerRef.current === null) {
        abortControllerRef.current = null;
        sendingConvs.current.delete(sendKey);
        actBuffers.current.delete(sendKey);
        if (currentConvKeyRef.current === sendKey) {
          setSending(false);
          setActivities([]);
        }
      }
    }
  };
  sendRef.current = send;

  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [, setExpandedMsgIds] = useState<Set<string>>(new Set());

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

  const handleRetry = useCallback((retryMsg: ChatMsg) => {
    const convKey = currentConvKeyRef.current;
    const currentMsgs = msgBuffers.current.get(convKey) ?? messages;
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
      if (!window.confirm(followCount === 1 ? t('page.retryConfirmSingular') : t('page.retryConfirmPlural', { count: followCount }))) return;
    }

    // Remove the agent bubble, all messages after it, and (if immediately preceding) the user message
    const removeUserToo = userMsg && retryIdx > 0 && currentMsgs[retryIdx - 1]?.id === userMsg.id;
    updateConvMsgs(convKey, prev => {
      const idx = prev.findIndex(m => m.id === (removeUserToo ? userMsg!.id : retryMsg.id));
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });
    void send(retryText, { isRetry: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, updateConvMsgs, t]);

  const handleResume = useCallback((resumeMsg: ChatMsg) => {
    const convKey = currentConvKeyRef.current;
    const currentMsgs = msgBuffers.current.get(convKey) ?? messages;
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
    setChatReplyTo({ id: msg.id, sender: senderName, text: msg.text.slice(0, 120) });
    // Auto-insert @mention when replying to an agent in a group channel
    if (chatMode === 'channel' && msg.sender === 'agent' && msg.agentName) {
      const mention = `@${msg.agentName} `;
      setInput(prev => prev.startsWith(mention) ? prev : mention + prev);
    }
    textareaRef.current?.focus();
  }, [authUser?.name, chatMode, t]);

  const switchSession = async (s: ChatSessionInfo) => {
    setActiveSessionId(s.id);
    setShowSessions(false);
    setHasMore(false);
    oldestMsgId.current = null;
    userAtBottomRef.current = true;
    setShowScrollBtn(false);
    newMsgCountRef.current = 0;
    setNewMsgCount(0);
    const key = currentConvKeyRef.current;
    msgBuffers.current.delete(key);
    setMessages([]);
    setOpenSessionTabs(prev => prev.some(t => t.id === s.id) ? prev : [...prev, s]);
    await loadSessionMessages(s.id, key);
  };

  const closeSessionTab = (sessionId: string) => {
    setOpenSessionTabs(prev => prev.filter(t => t.id !== sessionId));
    if (activeSessionId === sessionId) {
      // Switch to another open tab, or new conversation
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
    msgBuffers.current.delete(key);
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

  const modeTitle =
    chatMode === 'channel' ? (activeGroupChat?.name ?? activeChannel) :
    chatMode === 'direct'  ? (currentAgent?.name ?? t('page.selectAgent')) :
    chatMode === 'dm'      ? (isSelfDm ? t('chat.myNotes') : (activeDmUser?.name ?? t('page.directMessage'))) :
    t('page.chatTitle');

  const directGreetingIdx = useMemo(() => Math.floor(Math.random() * 5), [selectedAgent, activeSessionId]);
  const emptyGreeting = selectedAgent ? t(`page.placeholder.directOptions.${directGreetingIdx}`) : '';
  const placeholder =
    chatMode === 'channel' ? (activeGroupChat ? t('page.placeholder.channel', { name: activeGroupChat.name }) : t('page.placeholder.channelWithMention', { name: activeChannel })) :
    chatMode === 'dm'      ? (isSelfDm ? t('page.placeholder.dmSelf') : t('page.placeholder.dmOther', { name: activeDmUser?.name ?? '' })) :
    selectedAgent ? t('page.placeholder.direct') : t('page.placeholder.noAgent');

  // ── Render ────────────────────────────────────────────────────────────────────
  const showChatOnMobile = isMobile && mobileLayer === 'chat';
  const isEmptyChat = mainTab === 'chat' && visibleMessages.length === 0 && !sending;

  return (
    <div ref={teamContainerRef} className="flex-1 overflow-hidden flex relative">
      {/* ── Left sidebar (ChatTeamSidebar) — L1 ── */}
      <ChatTeamSidebar
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
          const teamGc = groupChats.find(gc => gc.type === 'team' && gc.teamId === teamId);
          if (isMobile) {
            enterMobileTeam(teamId);
          } else {
            if (teamGc) { setChatMode('channel'); setActiveChannel(teamGc.channelKey); setMainTab('chat'); setShowMemberPanel(false); if (!showTeamDetailPanel && !l2SpaceTight) setShowTeamDetailPanel(true); }
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
        onCollapse={() => setSidebarsCollapsed(true)}
        initialLoading={initialLoading}
      />

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

      {/* ── L2: Team detail panel (desktop only) ── */}
      {/* Inline mode: when space allows */}
      {showTeamDetailPanel && !l2SpaceTight && !isMobile && !sidebarsCollapsed && (() => {
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
      {l2Floating && !isMobile && !sidebarsCollapsed && (() => {
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

      {/* ── Main area ── */}
      {(!isMobile || showChatOnMobile) && (
      <div className={`flex-1 overflow-hidden flex flex-col ${isMobile ? 'min-w-0' : 'min-w-[400px]'}`}>
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
                  <AgentStatusBadge agent={currentAgent} tasks={tasks} onViewProfile={handleViewProfile} />
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
                    onClick={() => setSidebarsCollapsed(false)}
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
                        <AgentStatusBadge agent={currentAgent} tasks={tasks} onViewProfile={handleViewProfile} />
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
                      msgBuffers.current.delete(key);
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
              onSelectAgent={(agentId) => { setChatMode('direct'); setSelectedAgent(agentId); switchToProfile(); }}
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
              onSelectAgent={(agentId) => { setChatMode('direct'); setSelectedAgent(agentId); setMainTab('overview'); if (!showTeamDetailPanel && !l2SpaceTight) setShowTeamDetailPanel(true); }}
            />
          </div>
        )}

        {/* Chat Tab: Messages */}
        <div className={`flex-1 overflow-hidden flex flex-col relative ${isEmptyChat ? 'justify-center' : ''} ${mainTab !== 'chat' ? 'hidden' : ''}`}>
          {loadingMore && (
            <div className="absolute top-0 left-0 right-0 z-10 flex justify-center items-center gap-2 py-2 bg-gradient-to-b from-surface-primary/90 to-transparent pointer-events-none">
              <svg className="animate-spin h-3.5 w-3.5 text-brand-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-xs text-fg-tertiary">{t('page.loadingEarlierMessages')}</span>
            </div>
          )}
          <div ref={chatScrollRef} className={`${isEmptyChat ? 'hidden' : 'flex-1'} overflow-y-auto ${isMobile ? 'p-2.5' : 'p-5 2xl:pr-[280px]'}`} onScroll={handleChatScroll} onTouchStart={isMobile ? mainTabSwipe.onTouchStart : undefined} onTouchEnd={isMobile ? mainTabSwipe.onTouchEnd : undefined}>

          {visibleMessages.length > 0 && (
          <div style={{ height: chatVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {chatVirtualizer.getVirtualItems().map(virtualRow => {
              const vIdx = virtualRow.index;
              const msg = visibleMessages[vIdx]!;
              const prevMsg = vIdx > 0 ? visibleMessages[vIdx - 1] : null;
              const curDate = getDateKey(msg.rawCreatedAt);
              const prevDate = prevMsg ? getDateKey(prevMsg.rawCreatedAt) : '';
              const showDateSep = curDate && curDate !== prevDate;
              const isLastMsg = vIdx === visibleMessages.length - 1;
              const isPending = isLastPending && isLastMsg;
              const isStreamingMsg = isPending && sending;
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
                      msg.isError || (msg.sender === 'agent' && msg.text.startsWith('⚠'))
                        ? 'border-b-2 border-red-500/60'
                        : ''
                    } ${showStreamingBubble && msg.sender === 'agent' ? 'streaming-bubble' : ''}`}>
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
                          ? <MarkdownMessage content={msg.text} className="text-sm text-fg-secondary" onMentionClick={handleMentionClick} knownNames={agentNames} />
                          : <AgentMessageBody
                              msg={msg}
                              isStreaming={isStreamingMsg}
                              liveActivities={isStreamingMsg ? activities : []}
                              onViewModeChange={(mode) => setExpandedMsgIds(prev => {
                                const next = new Set(prev);
                                if (mode === 'full') next.add(msg.id); else next.delete(msg.id);
                                return next;
                              })}
                              onMentionClick={handleMentionClick}
                              knownNames={agentNames}
                            />
                      }
                      {msg.isNotification && (
                        <NotificationBadge priority={msg.notifyPriority} />
                      )}
                    </div>
                    {showActions && !previewMode && (
                      <div className={`transition-opacity ${msg.isStopped || isMobile ? 'opacity-100' : 'opacity-0 group-hover/msg:opacity-100'}`}>
                        <MessageActions msg={msg} onCopy={handleCopy} onRetry={handleRetry} onResume={handleResume} onReply={handleReplyMsg} isCopied={copiedMsgId === msg.id} isLastAgentMsg={msg.id === lastAgentMsgId} />
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
                  onClick={() => handleViewProfile(ta.id, { tab: 'overview' })}
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

          {/* Scroll to bottom button */}
          {showScrollBtn && mainTab === 'chat' && (
            <button
              onClick={() => {
                userAtBottomRef.current = true;
                scrollChatToBottom('smooth');
                setShowScrollBtn(false);
                newMsgCountRef.current = 0;
                setNewMsgCount(0);
              }}
              className={`absolute ${isMobile ? 'bottom-4' : 'bottom-28'} left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3.5 py-2 bg-surface-secondary/95 backdrop-blur-sm border border-border-default rounded-full shadow-lg hover:bg-surface-elevated transition-colors text-xs text-fg-secondary`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
              {newMsgCount > 0
                ? t('page.newMessages', { count: newMsgCount })
                : t('page.scrollToBottom')}
            </button>
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

        {/* Input (only in chat tab) */}
        <div className={`${isMobile ? 'px-3 py-2' : 'px-5 py-3'} relative shrink-0 ${isEmptyChat ? '' : '2xl:pr-[280px]'}`} onDrop={handleDrop} onDragOver={handleDragOver}>
          <div className={`bg-surface-primary border border-border-default shadow-lg shadow-black/10 ${isMobile ? 'rounded-2xl p-3' : 'rounded-2xl p-3 max-w-3xl mx-auto'}`}>
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
          <div className="flex gap-2 items-end">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={chatMode === 'direct' && !selectedAgent}
              className="px-2.5 py-2.5 text-fg-tertiary hover:text-fg-secondary disabled:opacity-40 transition-colors rounded-xl hover:bg-surface-elevated"
              title={t('page.attachFilesTitle')}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
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
              disabled={chatMode === 'direct' && !selectedAgent}
              rows={2}
              className="flex-1 px-4 py-3 bg-transparent rounded-xl text-sm outline-none disabled:opacity-40 transition-colors resize-none overflow-hidden leading-relaxed placeholder:text-fg-secondary"
              style={{ minHeight: '52px', maxHeight: '120px' }}
            />
            {sending && chatMode !== 'dm' && (
              <button
                onClick={stopSending}
                className="px-3 py-2.5 bg-red-600 hover:bg-red-500 text-white text-sm rounded-xl transition-colors flex items-center gap-1.5"
                title={t('page.stopAgent')}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </button>
            )}
            <button
              onClick={() => void send()}
              disabled={(chatMode === 'direct' && !selectedAgent) || (!input.trim() && pendingImages.length === 0)}
              className="px-5 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-xl transition-colors"
            >
              {t('common:send')}
            </button>
          </div>
          </div>
        </div>
        </div>
      </div>
      )}

    </div>
  );
}

function AgentStatusBadge({ agent, tasks, onViewProfile }: { agent: AgentInfo; tasks: TaskInfo[]; onViewProfile?: (agentId: string, opts?: { tab?: 'overview' }) => void }) {
  const { t } = useTranslation(['team', 'common']);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const isWorking = agent.status === 'working';
  const isError = agent.status === 'error';
  const hasRecentError = !isError && !!agent.lastError && !!agent.lastErrorAt
    && (Date.now() - new Date(agent.lastErrorAt).getTime()) < 30 * 60 * 1000;
  const currentTask = isWorking ? tasks.find(t => t.assignedAgentId === agent.id && t.status === 'in_progress') : null;
  const activity = agent.currentActivity;

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
    : hasRecentError ? 'bg-amber-400'
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
          isWorking && !hasRecentError ? 'bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20'
          : isError ? 'bg-red-500/10 border border-red-500/20 hover:bg-red-500/20'
          : hasRecentError ? 'bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20'
          : 'bg-green-500/10 border border-green-500/20 hover:bg-green-500/20'
        }`}
      >
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span className={`text-xs ${isError ? 'text-red-500' : hasRecentError ? 'text-amber-600' : isWorking ? 'text-blue-500' : 'text-green-600'}`}>{label}</span>
        {hasRecentError && <span className="text-[9px] text-amber-500">⚠</span>}
        {agent.mailboxDepth != null && agent.mailboxDepth > 0 && (
          <span className="text-[9px] bg-fg-tertiary/20 text-fg-tertiary rounded-full px-1.5">{agent.mailboxDepth}</span>
        )}
      </button>

      {open && isError && (
        <div ref={popoverRef} className="absolute top-full left-0 mt-1.5 bg-surface-secondary border border-red-500/30 rounded-xl shadow-2xl z-30 w-80 max-w-[calc(100vw-1rem)] p-3 space-y-2">
          <p className="text-[10px] text-red-500 uppercase font-semibold">{t('page.errorDetails')}</p>
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
            <pre className="text-[10px] text-red-500/80 leading-relaxed whitespace-pre-wrap break-all font-mono line-clamp-6">
              {agent.lastError || t('page.agentErrorFallback')}
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

      {open && hasRecentError && (
        <div ref={popoverRef} className="absolute top-full left-0 mt-1.5 bg-surface-secondary border border-amber-500/30 rounded-xl shadow-2xl z-30 w-80 max-w-[calc(100vw-1rem)] p-3 space-y-2">
          <p className="text-[10px] text-amber-600 uppercase font-semibold">{t('page.recentErrorDetails')}</p>
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
            <pre className="text-[10px] text-amber-600/80 leading-relaxed whitespace-pre-wrap break-all font-mono line-clamp-6">
              {agent.lastError}
            </pre>
            {agent.lastErrorAt && <div className="text-[9px] text-amber-500/50 mt-1.5 border-t border-amber-500/10 pt-1">{new Date(agent.lastErrorAt).toLocaleString()}</div>}
          </div>
          <div className="text-[10px] text-fg-tertiary">{t('page.errorRecovered')}</div>
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

