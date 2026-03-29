import { useEffect, useLayoutEffect, useRef, useState, useCallback, type RefObject } from 'react';
import {
  api, wsClient,
  type AgentInfo, type AgentToolEvent, type HumanUserInfo, type ExternalAgentInfo,
  type ChatMessageInfo, type ChatSessionInfo, type ChannelMessageInfo, type ChannelMsgMetadata,
  type TaskInfo, type TeamInfo, type AuthUser, type StoredSegment,
  type AgentActivityInfo, type AgentActivityLogEntry, type TaskLogEntry,
} from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { ActivityIndicator, type ActivityStep } from '../components/ActivityIndicator.tsx';
import {
  ToolCallRow, ExecEntryRow, ThinkingDots,
  taskLogToEntry, activityLogToEntry, filterCompletedStarts,
  type ExecEntry,
} from '../components/ExecutionTimeline.tsx';
import { navBus } from '../navBus.ts';
import { ChatTeamSidebar } from '../components/ChatTeamSidebar.tsx';
import { AgentProfile } from './AgentProfile.tsx';
import { TeamProfile } from './TeamProfile.tsx';
import { useResizablePanel } from '../hooks/useResizablePanel.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single interleaved segment: either text or a tool call */
export type MsgSegment =
  | { type: 'text'; content: string; thinking?: string }
  | { type: 'tool'; key: string; tool: string; status: 'running' | 'done' | 'error' | 'stopped'; args?: unknown; result?: string; error?: string; durationMs?: number; liveOutput?: string };

interface ChatMsg {
  id: string;
  sender: 'user' | 'agent';
  text: string;          // plain text (used for DB-loaded messages without segments)
  time: string;
  agentName?: string;
  agentId?: string;
  /** Chronologically interleaved segments (text + tool calls) — built during streaming */
  segments?: MsgSegment[];
  /** Legacy frozen activities for DB-loaded messages that predate the segments field */
  activities?: ActivityStep[];
  /** True when this message represents a failed AI response */
  isError?: boolean;
  /** True when this message was stopped by the user mid-stream */
  isStopped?: boolean;
  /** Attached image data URLs */
  images?: string[];
}

type ChatMode = 'channel' | 'smart' | 'direct' | 'dm';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dbMsgToChat(m: ChatMessageInfo): ChatMsg {
  const base: ChatMsg = {
    id: m.id,
    sender: m.role === 'user' ? 'user' : 'agent',
    text: m.content,
    time: new Date(m.createdAt).toLocaleTimeString(),
    agentId: m.role !== 'user' ? m.agentId : undefined,
  };
  if (m.role !== 'user' && m.metadata?.segments && m.metadata.segments.length > 0) {
    base.segments = m.metadata.segments.map((s: StoredSegment, i: number) =>
      s.type === 'tool'
        ? { type: 'tool' as const, key: `${s.tool}_${i}`, tool: s.tool, status: s.status, args: s.arguments, result: s.result, error: s.error, durationMs: s.durationMs }
        : { type: 'text' as const, content: s.content }
    );
  }
  if (m.metadata?.isError || (m.role === 'assistant' && m.content.startsWith('⚠'))) {
    base.isError = true;
  }
  if (m.metadata?.isStopped) {
    base.isStopped = true;
  }
  if (m.metadata?.images?.length) {
    base.images = m.metadata.images;
  }
  return base;
}

function channelMsgToChat(m: ChannelMessageInfo): ChatMsg {
  const isError = m.senderType === 'system' || (m.senderType === 'agent' && m.text.startsWith('⚠'));
  const base: ChatMsg = {
    id: m.id,
    sender: m.senderType === 'human' ? 'user' : 'agent',
    text: m.text,
    time: new Date(m.createdAt).toLocaleTimeString(),
    agentName: m.senderType !== 'human' ? m.senderName : undefined,
    agentId: m.senderType !== 'human' ? m.senderId : undefined,
    isError,
  };
  // Build segments from metadata (thinking + tool calls)
  if (m.metadata && m.senderType === 'agent') {
    const segments: MsgSegment[] = [];
    const meta = m.metadata as ChannelMsgMetadata;
    if (meta.thinking?.length) {
      segments.push({ type: 'text', content: '', thinking: meta.thinking.join('\n\n') });
    }
    if (meta.toolCalls?.length) {
      for (let i = 0; i < meta.toolCalls.length; i++) {
        const tc = meta.toolCalls[i]!;
        segments.push({
          type: 'tool',
          key: `${tc.tool}_${i}`,
          tool: tc.tool,
          status: tc.status === 'error' ? 'error' : 'done',
          args: tc.arguments,
          result: tc.result,
          durationMs: tc.durationMs,
        });
      }
    }
    if (segments.length > 0) {
      segments.push({ type: 'text', content: m.text });
      base.segments = segments;
    }
  }
  return base;
}

function agentInitials(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function ChatAgentLink({ name, agentId, agents, onViewProfile }: { name: string; agentId?: string; agents: AgentInfo[]; onViewProfile?: (agentId: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const agent = agentId ? agents.find(a => a.id === agentId) : agents.find(a => a.name === name);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!agent) return <span>{name}</span>;

  return (
    <span ref={ref} className="relative inline-block">
      <button onClick={() => setOpen(!open)} className="text-fg-tertiary hover:text-brand-500 cursor-pointer transition-colors">
        {name}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-40 w-56 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-brand-500/15 flex items-center justify-center text-[10px] font-bold text-brand-600">
              {agentInitials(agent.name)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-fg-primary font-medium truncate">{agent.name}</div>
              <div className="text-[10px] text-fg-tertiary">{agent.role} · {agent.agentRole ?? 'worker'}</div>
            </div>
            <span className={`w-2 h-2 rounded-full shrink-0 ${agent.status === 'working' ? 'bg-blue-400 animate-pulse' : agent.status === 'error' ? 'bg-red-400' : 'bg-green-400'}`} />
          </div>
          <button
            onClick={() => { setOpen(false); onViewProfile?.(agent.id); }}
            className="w-full text-center text-[10px] text-brand-500 hover:text-brand-500 border border-border-default hover:border-gray-600 rounded-lg py-1 transition-colors"
          >
            View Profile →
          </button>
        </div>
      )}
    </span>
  );
}

/** Agent avatar popover — shown when clicking an agent avatar in chat messages */
function AvatarPopover({ agent, anchorRect, onClose, onViewProfile }: {
  agent: AgentInfo;
  anchorRect: { top: number; left: number };
  onClose: () => void;
  onViewProfile: (agentId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const statusColor = agent.status === 'idle' ? 'bg-green-400' : agent.status === 'working' ? 'bg-blue-400 animate-pulse' : agent.status === 'error' ? 'bg-red-400' : 'bg-gray-500';
  const statusLabel = agent.status === 'idle' ? 'Online' : agent.status === 'working' ? 'Working' : agent.status === 'error' ? 'Error' : agent.status === 'paused' ? 'Paused' : 'Offline';

  return (
    <div
      ref={ref}
      className="fixed z-50 w-64 bg-surface-secondary border border-border-default rounded-xl shadow-2xl p-4 space-y-3"
      style={{ top: anchorRect.top + 40, left: anchorRect.left }}
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-brand-500/15 flex items-center justify-center text-sm font-bold text-brand-600">
          {agentInitials(agent.name)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-fg-primary font-medium truncate">{agent.name}</div>
          <div className="text-[11px] text-fg-tertiary">{agent.role}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
            <span className="text-[10px] text-fg-secondary">{statusLabel}</span>
            {agent.agentRole && <span className="text-[10px] text-fg-tertiary">· {agent.agentRole}</span>}
          </div>
        </div>
      </div>
      <button
        onClick={() => { onClose(); onViewProfile(agent.id); }}
        className="w-full py-1.5 text-xs text-brand-500 hover:text-brand-500 border border-border-default hover:border-gray-600 rounded-lg transition-colors text-center"
      >
        View Profile →
      </button>
    </div>
  );
}

/** Convert a raw LLM/network error into a user-friendly message with the actual reason */
function friendlyAgentError(err: unknown): string {
  const raw = String(err);

  if (raw.includes('AbortError') || raw.includes('abort'))
    return '';  // user cancelled — show nothing

  // Try to extract a clean message from JSON payloads like:
  // Error: OpenAI API error 402: {"error":{"message":"Insufficient Balance",...}}
  let detail = '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message ?? parsed.message ?? '';
    } catch { /* ignore */ }
  }
  if (!detail) {
    // Fall back to the text after the last colon (e.g. "OpenAI API error 402: Unauthorized")
    const colonIdx = raw.lastIndexOf(': ');
    if (colonIdx >= 0) detail = raw.slice(colonIdx + 2).trim();
  }

  if (raw.includes('402') || /insufficient.?balance/i.test(raw))
    return `⚠ AI service error: ${detail || 'Insufficient credits'}. Please top up the API balance or contact your administrator.`;
  if (raw.includes('401') || /unauthorized|invalid.?api.?key/i.test(raw))
    return `⚠ AI service authentication failed: ${detail || 'Invalid API key'}. Please check the configuration.`;
  if (raw.includes('429') || /rate.?limit/i.test(raw))
    return `⚠ Rate limit exceeded: ${detail || 'Too many requests'}. Please wait a moment and try again.`;
  if (raw.includes('503') || /service.?unavailable/i.test(raw))
    return `⚠ AI service unavailable: ${detail || 'Service temporarily down'}. Please try again later.`;

  return `⚠ AI service error: ${detail || raw.slice(0, 120)}`;
}

// ─── AgentMessageBody ──────────────────────────────────────────────────────────
// Renders an agent message with tool calls and text interleaved in chronological order.

/** Action toolbar shown on hover below a message bubble */
function MessageActions({
  msg, onCopy, onRetry, isCopied,
}: {
  msg: ChatMsg;
  onCopy: (msg: ChatMsg) => void;
  onRetry?: (msg: ChatMsg) => void;
  isCopied: boolean;
}) {
  const isError = msg.isError || (msg.sender === 'agent' && msg.text.startsWith('⚠'));
  const isStopped = msg.isStopped;
  return (
    <div className="flex items-center gap-0.5 mt-1">
      {/* Copy */}
      <button
        onClick={() => onCopy(msg)}
        className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay/60 transition-colors"
        title="Copy"
      >
        {isCopied ? (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
        ) : (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
        )}
        {isCopied ? 'Copied' : 'Copy'}
      </button>
      {/* Re-ask — for stopped messages */}
      {isStopped && onRetry && (
        <button
          onClick={() => onRetry(msg)}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-brand-500 hover:text-brand-500 hover:bg-brand-500/10 transition-colors"
          title="Re-ask"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
          Re-ask
        </button>
      )}
      {/* Retry — only for error messages */}
      {isError && !isStopped && onRetry && (
        <button
          onClick={() => onRetry(msg)}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-amber-600 hover:text-amber-600 hover:bg-amber-500/10 transition-colors"
          title="Retry"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
          Retry
        </button>
      )}
    </div>
  );
}

function AgentMessageBody({
  msg, isStreaming, liveActivities,
}: {
  msg: ChatMsg;
  isStreaming: boolean;
  liveActivities: import('../components/ActivityIndicator.tsx').ActivityStep[];
}) {
  const segments = msg.segments;
  const isStopped = msg.isStopped;
  const [expandedThinking, setExpandedThinking] = useState(false);

  // Messages with segment data: render interleaved
  if (segments !== undefined) {
    const lastSeg = segments[segments.length - 1];

    // "Between steps" state: streaming is active but last segment is a completed tool
    // (i.e. tool finished but neither the next tool nor text has arrived yet)
    const isWaiting = isStreaming &&
      segments.length > 0 &&
      lastSeg?.type === 'tool' &&
      lastSeg.status !== 'running';

    // Initial state: nothing has arrived yet
    const isEmpty = segments.length === 0;

    // Collect all thinking content from text segments
    const allThinking = segments
      .filter((s): s is { type: 'text'; content: string; thinking: string } => s.type === 'text' && !!s.thinking)
      .map(s => s.thinking)
      .join('');
    const hasThinking = allThinking.length > 0;

    return (
      <div className="space-y-0.5 min-h-[1em]">
        {/* Initial thinking — no segments yet */}
        {isEmpty && isStreaming && <ThinkingDots />}

        {/* Thinking collapse */}
        {hasThinking && (
          <div className="mb-2">
            <button
              onClick={() => setExpandedThinking(e => !e)}
              className="flex items-center gap-1 text-xs text-fg-tertiary hover:text-fg-secondary transition-colors"
            >
              <span className={`transition-transform ${expandedThinking ? 'rotate-90' : ''}▶`} style={{ fontSize: 8 }} />
              <span>思考过程 ({allThinking.length} 字符)</span>
            </button>
            {expandedThinking && (
              <div className="mt-1 pl-3 border-l-2 border-brand-500/50 text-xs text-fg-secondary whitespace-pre-wrap max-h-60 overflow-y-auto">
                {allThinking}
              </div>
            )}
          </div>
        )}

        {segments.map((seg, i) => {
          const isLastSeg = i === segments.length - 1;
          if (seg.type === 'tool') {
            return <ToolCallRow key={seg.key} info={{ tool: seg.tool, status: seg.status, args: seg.args, result: seg.result, error: seg.error, durationMs: seg.durationMs, liveOutput: seg.liveOutput }} isLast={isLastSeg && !isWaiting} />;
          }
          // text segment
          return (
            <div key={i} className={seg.content ? '' : 'hidden'}>
              <MarkdownMessage content={seg.content} />
              {isStreaming && isLastSeg && (
                <span className="inline-block w-0.5 h-4 bg-brand-400 animate-pulse ml-0.5 align-text-bottom" />
              )}
            </div>
          );
        })}

        {/* Between-step thinking: a tool just finished, waiting for next action */}
        {isWaiting && (
          <div className="flex items-center gap-2 pl-0.5 pt-0.5">
            {/* Connector line from last tool down to dots */}
            <div className="flex flex-col items-center" style={{ width: 14 }}>
              <div className="w-px flex-1 bg-surface-overlay" style={{ minHeight: 6 }} />
              <div className="w-2 h-2 rounded-full border border-gray-600 bg-surface-elevated shrink-0" />
            </div>
            <ThinkingDots label="Processing" />
          </div>
        )}

        {/* Stopped indicator */}
        {isStopped && (
          <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-fg-tertiary">
            <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
            <span>Stopped</span>
          </div>
        )}
      </div>
    );
  }

  // Fallback: old messages from DB (no segments) — use legacy ActivityIndicator + text
  const hasActivities = (msg.activities?.length ?? 0) > 0;
  return (
    <>
      {(isStreaming || hasActivities) && (
        <ActivityIndicator
          activities={isStreaming ? liveActivities : (msg.activities ?? [])}
          isActive={isStreaming}
          persistent={!isStreaming && hasActivities}
        />
      )}
      {msg.text ? <MarkdownMessage content={msg.text} /> : null}
      {isStopped && (
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-fg-tertiary">
          <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
          <span>Stopped</span>
        </div>
      )}
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type MainTab = 'chat' | 'profile';

export function Chat({ initialAgentId, authUser }: { initialAgentId?: string; authUser?: AuthUser } = {}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [humans, setHumans] = useState<HumanUserInfo[]>([]);
  const isMobile = useIsMobile();

  // Mobile: show list vs chat detail
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const mobileShowChatRef = useRef(mobileShowChat);
  mobileShowChatRef.current = mobileShowChat;

  const enterMobileDetail = useCallback(() => {
    setMobileShowChat(true);
    history.pushState({ mobileDetail: 'chat' }, '', window.location.hash);
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const handler = () => {
      if (mainTabRef.current === 'profile') {
        setMainTab('chat');
      } else if (mobileShowChatRef.current) {
        setMobileShowChat(false);
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [isMobile]);

  // Tab system: Chat vs Agent Profile
  const [mainTab, setMainTab] = useState<MainTab>('chat');
  const mainTabRef = useRef<MainTab>('chat');
  mainTabRef.current = mainTab;

  // Resizable chat left sidebar
  const chatSidebar = useResizablePanel({
    side: 'left',
    defaultWidth: 224,
    minWidth: 160,
    maxWidth: 360,
    storageKey: 'markus_chat_sidebar',
  });

  // Avatar popover in chat messages
  const [avatarPopover, setAvatarPopover] = useState<{ agentId: string; top: number; left: number } | null>(null);

  const switchToProfile = useCallback(() => {
    setMainTab('profile');
    if (isMobile) history.pushState({ mobileProfile: true }, '', window.location.hash);
  }, [isMobile]);

  const handleViewProfile = useCallback((agentId: string) => {
    setChatMode('direct');
    setSelectedAgent(agentId);
    switchToProfile();
    setAvatarPopover(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchToProfile]);

  // Mode & target
  const [chatMode, setChatMode] = useState<ChatMode>(
    () => initialAgentId ? 'direct' : ((localStorage.getItem('markus_chat_mode') as ChatMode | null) ?? 'direct')
  );
  const [selectedAgent, setSelectedAgent] = useState(
    () => initialAgentId ?? localStorage.getItem('markus_chat_agent') ?? ''
  );
  const [activeChannel, setActiveChannel] = useState(
    () => localStorage.getItem('markus_chat_channel') ?? '#general'
  );
  const [activeDmUserId, setActiveDmUserId] = useState<string>('');

  // ── Per-conversation buffers ──────────────────────────────────────────────────
  // Each conversation (agentId / channelName / 'smart') stores its own message array
  // so that switching away never destroys in-progress streaming content.
  const msgBuffers    = useRef<Map<string, ChatMsg[]>>(new Map());
  const actBuffers    = useRef<Map<string, ActivityStep[]>>(new Map());
  const sendingConvs  = useRef<Set<string>>(new Set());
  // Which conv key the user is currently viewing (used inside async callbacks)
  const currentConvKeyRef = useRef<string>('');

  // Displayed state — always mirrors the current conv's buffer
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [activities, setActivities] = useState<ActivityStep[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Image attachments
  const [pendingImages, setPendingImages] = useState<Array<{ id: string; dataUrl: string; name: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const [groupChats, setGroupChats] = useState<Array<{ id: string; name: string; type: string; channelKey: string; memberCount?: number; teamId?: string }>>([]);

  // Teams
  const [teams, setTeams] = useState<TeamInfo[]>([]);

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
    mode === 'direct'  ? (agent || '_direct') :
    mode === 'dm'      ? `dm:${dmUserId ?? ''}` :
    '_smart';

  /** Write to a conversation's message buffer and refresh display if currently viewing it */
  const updateConvMsgs = useCallback((key: string, updater: (prev: ChatMsg[]) => ChatMsg[]) => {
    const next = updater(msgBuffers.current.get(key) ?? []);
    msgBuffers.current.set(key, next);
    if (currentConvKeyRef.current === key) setMessages(next);
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

  // ── Data loading ─────────────────────────────────────────────────────────────
  const refreshAgents = useCallback(() => api.agents.list().then(d => setAgents(d.agents)).catch(() => {}), []);
  const refreshTeams = useCallback(() => api.teams.list().then(d => setTeams(d.teams)).catch(() => {}), []);

  useEffect(() => {
    refreshAgents();
    api.users.list().then(d => setHumans(d.users)).catch(() => {});
    api.tasks.list().then(d => setTasks(d.tasks)).catch(() => {});
    refreshTeams();
    api.externalAgents.list().then(d => setExternalAgents(d.agents)).catch(() => {});
    fetch('/api/group-chats').then(r => r.json()).then((d: { chats: typeof groupChats }) => setGroupChats(d.chats)).catch(() => {});

    const timer = setInterval(refreshAgents, 8000);
    const teamTimer = setInterval(refreshTeams, 15000);
    const unsub = wsClient.on('agent:update', refreshAgents);
    const unsubTeam = wsClient.on('*', refreshTeams);
    const unsubGroup = wsClient.on('chat:group_created', () => {
      fetch('/api/group-chats').then(r => r.json()).then((d: { chats: typeof groupChats }) => setGroupChats(d.chats)).catch(() => {});
    });
    const onDataChanged = () => { refreshAgents(); refreshTeams(); };
    window.addEventListener('markus:data-changed', onDataChanged);
    return () => { clearInterval(timer); clearInterval(teamTimer); unsub(); unsubTeam(); unsubGroup(); window.removeEventListener('markus:data-changed', onDataChanged); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check for nav params (e.g., navigated here from AgentProfile or Team redirect)
  useEffect(() => {
    const handleNav = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      if (detail.page === 'chat' || detail.page === 'team') {
        if (detail.params?.agentId) {
          setChatMode('direct');
          setSelectedAgent(detail.params.agentId);
        }
        if (detail.params?.selectAgent) {
          handleViewProfile(detail.params.selectAgent);
        }
        if (detail.params?.openHire === 'true') {
          // handled by ChatTeamSidebar via nav events
        }
      }
    };
    const navAgent = localStorage.getItem('markus_nav_agentId');
    if (navAgent) {
      localStorage.removeItem('markus_nav_agentId');
      setChatMode('direct');
      setSelectedAgent(navAgent);
    }
    const selectAgent = localStorage.getItem('markus_nav_selectAgent');
    if (selectAgent) {
      localStorage.removeItem('markus_nav_selectAgent');
      handleViewProfile(selectAgent);
    }
    window.addEventListener('markus:navigate', handleNav);
    return () => window.removeEventListener('markus:navigate', handleNav);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track whether the user is at the bottom of the chat scroll container.
  // When the user scrolls up manually, we stop auto-scrolling until they scroll back down.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const threshold = 80;
      userAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Snap to bottom after DOM updates, but only if user hasn't scrolled up.
  useLayoutEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      return;
    }
    if (!userAtBottomRef.current) return;
    messagesEnd.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages, activities]);

  // Load channel messages from DB → store in buffer + update display
  const loadChannelMessages = useCallback(async (channel: string) => {
    const key = channel === 'smart:default' ? '_smart' : `ch:${channel}`;
    try {
      const result = await api.channels.getMessages(channel, 50);
      const msgs = result.messages.map(channelMsgToChat);
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
  const loadSessionMessages = useCallback(async (sessionId: string, convKey: string) => {
    loadingSessionRef.current = sessionId;
    try {
      const result = await api.sessions.getMessages(sessionId, 50);
      const msgs = result.messages.map(dbMsgToChat);
      msgBuffers.current.set(convKey, msgs);
      if (currentConvKeyRef.current === convKey && loadingSessionRef.current === sessionId) {
        setMessages(msgs);
        setHasMore(result.hasMore);
        oldestMsgId.current = result.messages[0] ? new Date(result.messages[0].createdAt).toISOString() : null;
      }
    } catch {
      if (currentConvKeyRef.current === convKey && loadingSessionRef.current === sessionId) { setMessages([]); setHasMore(false); oldestMsgId.current = null; }
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

  // Load more (pagination)
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !oldestMsgId.current) return;
    setLoadingMore(true);
    try {
      const convKey = currentConvKeyRef.current;
      if (chatMode === 'channel' || chatMode === 'smart' || chatMode === 'dm') {
        const channelName = chatMode === 'smart' ? 'smart:default' :
          chatMode === 'dm' ? makeDmChannel(authUser?.id ?? '', activeDmUserId) : activeChannel;
        const result = await api.channels.getMessages(channelName, 50, oldestMsgId.current);
        const newMsgs = result.messages.map(channelMsgToChat);
        // Suppress scroll-to-bottom — prepending old messages must not jump the viewport
        skipScrollRef.current = true;
        setMessages(prev => {
          const combined = [...newMsgs, ...prev];
          msgBuffers.current.set(convKey, combined); // keep buffer in sync
          return combined;
        });
        setHasMore(result.hasMore);
        if (result.messages[0]) oldestMsgId.current = new Date(result.messages[0].createdAt).toISOString();
      } else if (activeSessionId) {
        const result = await api.sessions.getMessages(activeSessionId, 50, oldestMsgId.current);
        const newMsgs = result.messages.map(dbMsgToChat);
        skipScrollRef.current = true;
        setMessages(prev => {
          const combined = [...newMsgs, ...prev];
          msgBuffers.current.set(convKey, combined);
          return combined;
        });
        setHasMore(result.hasMore);
        if (result.messages[0]) oldestMsgId.current = new Date(result.messages[0].createdAt).toISOString();
      }
    } catch { /* ignore */ } finally { setLoadingMore(false); }
  }, [loadingMore, hasMore, chatMode, activeChannel, activeSessionId, authUser?.id, activeDmUserId]);

  // When mode/target changes: switch to the new conversation's buffer.
  // If the new conv is already streaming or has buffered messages, show them immediately.
  // Otherwise load from DB.
  useEffect(() => {
    const newKey = makeConvKey(chatMode, selectedAgent, activeChannel, activeDmUserId);
    const prevKey = currentConvKeyRef.current;
    currentConvKeyRef.current = newKey;

    // Save current session tabs & active session before switching away
    if (prevKey && prevKey !== newKey) {
      sessionTabsBuffer.current.set(prevKey, openSessionTabs);
      activeSessionBuffer.current.set(prevKey, activeSessionId);
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
      // Already have content (possibly mid-stream) — show immediately, no DB load
      setMessages(bufferedMsgs);
      setHasMore(false);
      // Restore the active session that was viewing these messages
      if (savedActiveSession !== undefined) {
        setActiveSessionId(savedActiveSession);
      }
      if (!savedTabs || savedTabs.length === 0) setOpenSessionTabs([]);
    } else {
      // First visit for this conversation — load from DB
      setMessages([]);
      setHasMore(false);
      oldestMsgId.current = null;

      if (chatMode === 'channel' || chatMode === 'dm') {
        const channelName = chatMode === 'dm'
          ? makeDmChannel(authUser?.id ?? '', activeDmUserId)
          : activeChannel;
        loadChannelMessages(channelName);
        if (!savedTabs || savedTabs.length === 0) setOpenSessionTabs([]);
      } else if (chatMode === 'smart') {
        loadChannelMessages('smart:default');
        if (!savedTabs || savedTabs.length === 0) setOpenSessionTabs([]);
      } else if (chatMode === 'direct' && selectedAgent) {
        loadSessions(selectedAgent).then(s => {
          if (currentConvKeyRef.current !== newKey) return;
          if (s.length > 0) {
            const initialTabs = (savedTabs && savedTabs.length > 0) ? savedTabs : s.slice(0, 5);
            const restoreId = savedActiveSession !== undefined ? savedActiveSession : initialTabs[0]!.id;
            const validId = restoreId && initialTabs.some(t => t.id === restoreId) ? restoreId : initialTabs[0]!.id;
            setActiveSessionId(validId);
            setOpenSessionTabs(initialTabs);
            loadSessionMessages(validId!, newKey);
          } else {
            setActiveSessionId(null);
            if (!savedTabs || savedTabs.length === 0) setOpenSessionTabs([]);
            // First-time conversation: auto-send intro request
            const introMsg = (() => {
              const lang = (navigator.language || '').toLowerCase();
              if (lang.startsWith('zh')) return '介绍一下你自己';
              if (lang.startsWith('ja')) return '自己紹介をしてください';
              if (lang.startsWith('ko')) return '자기소개를 해주세요';
              if (lang.startsWith('fr')) return 'Présentez-vous';
              if (lang.startsWith('de')) return 'Stell dich vor';
              if (lang.startsWith('es')) return 'Preséntate';
              if (lang.startsWith('pt')) return 'Apresente-se';
              if (lang.startsWith('ru')) return 'Представьтесь';
              return 'Introduce yourself';
            })();
            setTimeout(() => sendRef.current?.(introMsg), 150);
          }
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMode, selectedAgent, activeChannel, activeDmUserId]);

  // WS live updates for channel mode
  useEffect(() => {
    if (chatMode !== 'channel') return;
    const unsub = wsClient.on('chat:message', (event) => {
      const p = event.payload;
      const msgChannel = (p['channel'] as string) ?? '';
      // Only process messages with an explicit channel that matches the current one.
      // Messages without a channel field come from direct-chat broadcastChat() and must be ignored.
      if (!msgChannel || msgChannel !== activeChannel) return;
      const senderType = (p['senderType'] as string) ?? 'agent';
      const wsText = (p['text'] as string) ?? (p['message'] as string) ?? '';
      const wsSenderId = (p['senderId'] as string) ?? (p['agentId'] as string) ?? '';
      const wsSenderName = (p['senderName'] as string) ?? (p['agentId'] as string) ?? 'Agent';
      const wsMeta = p['metadata'] as ChannelMsgMetadata | undefined;

      const newMsg: ChatMsg = {
        id: `ws_${Date.now()}_${wsSenderId}`,
        sender: senderType === 'human' ? 'user' : 'agent',
        text: wsText,
        time: new Date().toLocaleTimeString(),
        agentName: senderType === 'agent' ? wsSenderName : undefined,
        agentId: senderType === 'agent' ? wsSenderId : undefined,
      };

      // Build segments from metadata (thinking + tool calls) if present
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

      const key = makeConvKey('channel', selectedAgent, activeChannel, activeDmUserId);
      updateConvMsgs(key, prev => [...prev, newMsg]);
    });
    return unsub;
  }, [chatMode, activeChannel, selectedAgent, activeDmUserId, updateConvMsgs]);

  // WS live updates for proactive agent messages (direct mode)
  useEffect(() => {
    const unsub = wsClient.on('chat:proactive_message', (event) => {
      const p = event.payload;
      const agentId = (p['agentId'] as string) ?? '';
      const agentName = (p['agentName'] as string) ?? 'Agent';
      const message = (p['message'] as string) ?? '';
      const sessionId = (p['sessionId'] as string) ?? '';
      if (!agentId || !message) return;

      // Only append to display if we're viewing this agent's direct chat
      if (chatMode === 'direct' && selectedAgent === agentId) {
        const newMsg: ChatMsg = {
          id: `proactive_${Date.now()}`,
          sender: 'agent',
          text: message,
          time: new Date().toLocaleTimeString(),
          agentName,
          agentId,
        };
        const key = makeConvKey('direct', agentId, activeChannel, activeDmUserId);
        updateConvMsgs(key, prev => [...prev, newMsg]);

        // Update the active session if the proactive message came with a session ID
        if (sessionId && activeSessionId !== sessionId) {
          setActiveSessionId(sessionId);
        }
      }
    });
    return unsub;
  }, [chatMode, selectedAgent, activeChannel, activeDmUserId, activeSessionId, updateConvMsgs]);

  // ── Task helpers ─────────────────────────────────────────────────────────────
  const linkedTask = tasks.find(t => t.id === linkedTaskId);

  const createAndLinkTask = async () => {
    if (!selectedAgent) return;
    const title = newTaskTitle.trim() || (messages[0]?.text.slice(0, 60) ?? 'New Conversation Task');
    try {
      await api.tasks.create(title, `Created from chat with ${currentAgent?.name ?? 'agent'}`, selectedAgent, selectedAgent, 'medium');
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
  const parseMentions = (text: string) => (text.match(/@(\w+)/g) ?? []).map(m => m.slice(1));

  const stopSending = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    // Immediately unblock the UI — don't wait for the async send() to catch the abort
    const sendKey = currentConvKeyRef.current;
    sendingConvs.current.delete(sendKey);
    actBuffers.current.delete(sendKey);
    setSending(false);
    setActivities([]);
  };

  const send = async (retryText?: string) => {
    const text = (retryText ?? input).trim();
    if (!text && pendingImages.length === 0) return;
    if (chatMode === 'direct' && !selectedAgent) return;
    userAtBottomRef.current = true;

    // If agent is currently streaming, interrupt it first then proceed
    if (sending) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      const prevKey = currentConvKeyRef.current;
      sendingConvs.current.delete(prevKey);
      actBuffers.current.delete(prevKey);
      // Mark the current agent message as stopped
      updateConvMsgs(prevKey, prev => {
        const u = [...prev];
        for (let i = u.length - 1; i >= 0; i--) {
          if (u[i]!.sender === 'agent' && !u[i]!.isStopped && !u[i]!.isError) {
            const msg = u[i]!;
            const segs = (msg.segments ?? []).map(s =>
              s.type === 'tool' && s.status === 'running' ? { ...s, status: 'stopped' as const } : s
            );
            u[i] = { ...msg, isStopped: true, segments: segs };
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
    const sendKey = makeConvKey(chatMode, selectedAgent, activeChannel, activeDmUserId);

    if (!retryText) setInput('');
    setPendingImages([]);
    setMentionDropdown(false);

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
      updateConvMsgs(sendKey, prev => [...prev, { id: optId, sender: 'user', text, time: new Date().toLocaleTimeString() }]);
      try {
        const result = await api.channels.sendMessage(dmChannel, {
          text, senderName: authUser?.name ?? 'You',
          senderId: authUser?.id,
          mentions: [], orgId: 'default',
          humanOnly: true, // never route to agents
        });
        updateConvMsgs(sendKey, prev => {
          const without = prev.filter(m => m.id !== optId);
          const newMsgs: ChatMsg[] = [];
          if (result.userMessage) newMsgs.push(channelMsgToChat(result.userMessage));
          return newMsgs.length > 0 ? [...without, ...newMsgs] : prev;
        });
      } catch (e) {
        updateConvMsgs(sendKey, prev => [...prev, {
          id: `err_${Date.now()}`, sender: 'agent', text: `Error: ${String(e)}`,
          time: new Date().toLocaleTimeString(), agentName: 'System', isError: true,
        }]);
      }
      sendingConvs.current.delete(sendKey);
      if (currentConvKeyRef.current === sendKey) setSending(false);
    } else if (chatMode === 'channel') {
      const optId = `opt_${Date.now()}`;
      updateConvMsgs(sendKey, prev => [...prev, { id: optId, sender: 'user', text, time: new Date().toLocaleTimeString() }]);
      try {
        const mentions = parseMentions(text);
        const mentionedAgent = mentions.length > 0
          ? agents.find(a => a.name.toLowerCase() === mentions[0]!.toLowerCase())
          : null;
        const result = await api.channels.sendMessage(activeChannel, {
          text, senderName: authUser?.name ?? 'You', mentions,
          senderId: authUser?.id,
          targetAgentId: mentionedAgent?.id, orgId: 'default',
        });
        updateConvMsgs(sendKey, prev => {
          const without = prev.filter(m => m.id !== optId);
          const newMsgs: ChatMsg[] = [];
          if (result.userMessage) newMsgs.push(channelMsgToChat(result.userMessage));
          if (result.agentMessage) newMsgs.push(channelMsgToChat(result.agentMessage));
          return newMsgs.length > 0 ? [...without, ...newMsgs] : prev;
        });
      } catch (e) {
        const friendly = friendlyAgentError(e) || `Error: ${String(e)}`;
        updateConvMsgs(sendKey, prev => [...prev, {
          id: `err_${Date.now()}`, sender: 'agent', text: friendly,
          time: new Date().toLocaleTimeString(), agentName: 'System', isError: true,
        }]);
      }
      sendingConvs.current.delete(sendKey);
      if (currentConvKeyRef.current === sendKey) setSending(false);
    } else {
      // direct or smart — build an interleaved segment stream
      const agentMsgId = `a_${Date.now()}`;
      const userMsg: ChatMsg = { id: `u_${Date.now()}`, sender: 'user', text, time: new Date().toLocaleTimeString() };
      if (imagesToSend?.length) userMsg.images = imagesToSend;
      updateConvMsgs(sendKey, prev => [
        ...prev,
        userMsg,
        { id: agentMsgId, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), segments: [] },
      ]);

      /** Append a text chunk to the segment stream */
      const appendTextChunk = (chunk: string) => {
        updateConvMsgs(sendKey, prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx < 0) return prev;
          const segs = u[idx]!.segments ?? [];
          const last = segs[segs.length - 1];

          // Extract thinking content from chunk (between <think> and </think> tags)
          let thinking: string | undefined;
          let content = chunk;

          // Check for standard format <think>...</think>
          const thinkingMatch = chunk.match(/<think>([\s\S]*?)<\/think>/);
          if (thinkingMatch) {
            thinking = (last?.type === 'text' ? (last as { thinking?: string }).thinking ?? '' : '') + thinkingMatch[1];
            content = chunk.replace(/<think>[\s\S]*?<\/think>/, '');
          }

          const newSegs: MsgSegment[] = last?.type === 'text'
            ? [...segs.slice(0, -1), { type: 'text', content: last.content + content, thinking: thinking ?? (last as { thinking?: string }).thinking }]
            : [...segs, { type: 'text', content, thinking }];
          u[idx] = { ...u[idx]!, text: u[idx]!.text + content, segments: newSegs };
          return u;
        });
      };

      /** Handle a tool event: start adds a 'running' segment, end updates it, output appends live text */
      const handleToolEvent = (event: AgentToolEvent) => {
        if (event.phase !== 'output') {
          appendConvActivity(sendKey, { ...event, ts: Date.now() });
        }
        if (event.phase === 'start') {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const segs = [...(u[idx]!.segments ?? [])];
            // If there's already a running segment for this tool (from tool_call_start),
            // update it with the arguments instead of creating a duplicate
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
            if (!updated) {
              const toolKey = `${event.tool}_${Date.now()}`;
              segs.push({ type: 'tool', key: toolKey, tool: event.tool, status: 'running', args: event.arguments });
            }
            u[idx] = { ...u[idx]!, segments: segs };
            return u;
          });
        } else if (event.phase === 'output') {
          // Streaming output from a running tool — append to liveOutput
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
        } else {
          // Find the most recent running segment for this tool and mark it done/error
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const segs = [...(u[idx]!.segments ?? [])];
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                segs[i] = { ...s, status: event.success === false ? 'error' : 'done', args: event.arguments, result: event.result, error: event.error, durationMs: event.durationMs, liveOutput: undefined };
                break;
              }
            }
            u[idx] = { ...u[idx]!, segments: segs };
            return u;
          });
        }
      };

      const abortCtrl = new AbortController();
      abortControllerRef.current = abortCtrl;

      try {
        if (chatMode === 'smart') {
          const result = await api.message.sendStream(
            text,
            appendTextChunk,
            { senderId: authUser?.id || undefined, signal: abortCtrl.signal, images: imagesToSend },
            handleToolEvent,
          );
          const ra = agents.find(a => a.id === result.agentId);
          if (ra) updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx >= 0) u[idx] = { ...u[idx]!, agentName: ra.name };
            return u;
          });
        } else {
          const effectiveSessionId = activeSessionId === NEW_CHAT_PLACEHOLDER_ID ? null : activeSessionId;
          const streamResult = await api.agents.messageStream(
            selectedAgent, text,
            appendTextChunk,
            handleToolEvent,
            abortCtrl.signal,
            imagesToSend,
            effectiveSessionId,
          );
          // Only update session state if user is still viewing this conversation
          if (currentConvKeyRef.current === sendKey) {
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

        const errText = friendlyAgentError(e);
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
                  (s.type === 'text' && (s as { content: string }).content) || s.type === 'tool'
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
                (s.type === 'text' && (s as { content: string }).content) || s.type === 'tool'
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
      if (agentMsg && !agentMsg.text && chatMode === 'direct' && pollSessionId && !abortCtrl.signal.aborted) {
        const pollForReply = async (retries: number, delayMs: number) => {
          for (let i = 0; i < retries; i++) {
            await new Promise(r => setTimeout(r, delayMs));
            try {
              const result = await api.sessions.getMessages(pollSessionId, 2);
              const assistantMsg = result.messages.find(m => m.role === 'assistant');
              if (assistantMsg?.content) {
                updateConvMsgs(sendKey, prev => {
                  const u = [...prev];
                  const idx = u.findIndex(m => m.id === agentMsgId);
                  if (idx >= 0) {
                    u[idx] = {
                      ...u[idx]!,
                      text: assistantMsg.content,
                      segments: [{ type: 'text', content: assistantMsg.content }],
                    };
                  }
                  return u;
                });
                return;
              }
            } catch { /* retry */ }
          }
        };
        void pollForReply(5, 3000);
      }
    }

    // Clear abort controller and sending state for this conv
    abortControllerRef.current = null;
    sendingConvs.current.delete(sendKey);
    actBuffers.current.delete(sendKey);
    if (currentConvKeyRef.current === sendKey) {
      setSending(false);
      setActivities([]);
    }
  };
  sendRef.current = send;

  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  const handleCopy = useCallback((msg: ChatMsg) => {
    const text = msg.segments
      ? msg.segments.filter(s => s.type === 'text').map(s => (s as { content: string }).content).join('\n')
      : msg.text;
    void navigator.clipboard.writeText(text);
    setCopiedMsgId(msg.id);
    setTimeout(() => setCopiedMsgId(prev => prev === msg.id ? null : prev), 2000);
  }, []);

  const handleRetry = useCallback((errorMsg: ChatMsg) => {
    const convKey = currentConvKeyRef.current;
    const currentMsgs = msgBuffers.current.get(convKey) ?? messages;
    const errIdx = currentMsgs.findIndex(m => m.id === errorMsg.id);
    if (errIdx < 0) return;
    // Find the user message immediately before the error/stopped bubble
    const userMsg = errIdx > 0 && currentMsgs[errIdx - 1]?.sender === 'user'
      ? currentMsgs[errIdx - 1]! : null;
    const retryText = userMsg?.text ?? '';
    if (!retryText) return;
    // Remove the error/stopped agent bubble (and the preceding user message so it re-appears cleanly)
    updateConvMsgs(convKey, prev => prev.filter(m =>
      m.id !== errorMsg.id && (userMsg ? m.id !== userMsg.id : true)
    ));
    void send(retryText);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, updateConvMsgs]);

  const switchSession = async (s: ChatSessionInfo) => {
    setActiveSessionId(s.id);
    setShowSessions(false);
    setHasMore(false);
    oldestMsgId.current = null;
    const key = currentConvKeyRef.current;
    msgBuffers.current.delete(key);
    setMessages([]);
    // Add to open tabs if not already there
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
        title: 'New Chat',
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      }, ...without];
    });
  };

  const handleInputChange = (val: string) => {
    setInput(val);
    if (chatMode !== 'channel') { setMentionDropdown(false); return; }
    const lastAt = val.lastIndexOf('@');
    if (lastAt >= 0 && (lastAt === 0 || val[lastAt - 1] === ' ')) {
      const after = val.slice(lastAt + 1);
      if (!after.includes(' ')) {
        setMentionDropdown(true);
        setMentionFilter(after.toLowerCase());
        return;
      }
    }
    setMentionDropdown(false);
  };

  const insertMention = (name: string) => {
    const lastAt = input.lastIndexOf('@');
    setInput(input.slice(0, lastAt) + '@' + name + ' ');
    setMentionDropdown(false);
  };

  // ── Image handling ──────────────────────────────────────────────────────────
  const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
  const MAX_IMAGES = 5;

  const addImageFiles = useCallback((files: FileList | File[]) => {
    const fileArr = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (fileArr.length === 0) return;
    for (const file of fileArr) {
      if (file.size > MAX_IMAGE_SIZE) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setPendingImages(p => {
          if (p.length >= MAX_IMAGES) return p;
          if (p.some(img => img.dataUrl === dataUrl)) return p;
          return [...p, { id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, dataUrl, name: file.name }];
        });
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const removeImage = useCallback((id: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== id));
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        e.preventDefault();
        addImageFiles(imageFiles);
      }
    }
  }, [addImageFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      addImageFiles(Array.from(files).filter(f => f.type.startsWith('image/')));
    }
  }, [addImageFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────────
  const currentAgent = agents.find(a => a.id === selectedAgent);
  const currentUserName = authUser?.name ?? 'You';
  const lastMsg = messages[messages.length - 1];
  const isLastPending = sending && lastMsg?.sender === 'agent';
  const filteredAgents = agents.filter(a => a.name.toLowerCase().includes(mentionFilter));

  const activeDmUser = humans.find(h => h.id === activeDmUserId);
  const isSelfDm = activeDmUserId === authUser?.id || !activeDmUserId;

  const activeGroupChat = groupChats.find(gc => gc.channelKey === activeChannel);
  const modeTitle =
    chatMode === 'channel' ? (activeGroupChat?.name ?? activeChannel) :
    chatMode === 'direct'  ? (currentAgent?.name ?? 'Select Agent') :
    chatMode === 'dm'      ? (isSelfDm ? 'My Notes' : (activeDmUser?.name ?? 'Direct Message')) :
    'Chat';

  const placeholder =
    chatMode === 'channel' ? (activeGroupChat ? `Message ${activeGroupChat.name}…` : `Message ${activeChannel}… (use @name to mention)`) :
    chatMode === 'dm'      ? (isSelfDm ? 'Write a note to yourself…' : `Message ${activeDmUser?.name ?? ''}…`) :
    selectedAgent ? 'Type a message…' : 'Select an agent to start chatting';

  // ── Render ────────────────────────────────────────────────────────────────────
  const showSidebarOnMobile = isMobile && !mobileShowChat;
  const showChatOnMobile = isMobile && mobileShowChat;

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* ── Left sidebar (ChatTeamSidebar) ── */}
      {(!isMobile || showSidebarOnMobile) && (
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
          onSelectAgent={(agentId) => { setChatMode('direct'); setSelectedAgent(agentId); setMainTab('chat'); if (isMobile) enterMobileDetail(); }}
          onSelectChannel={(channelKey) => { setChatMode('channel'); setActiveChannel(channelKey); setMainTab('chat'); if (isMobile) enterMobileDetail(); }}
          onSelectDm={(userId) => { setChatMode('dm'); setActiveDmUserId(userId); setMainTab('chat'); if (isMobile) enterMobileDetail(); }}
          onRefreshTeams={refreshTeams}
          onRefreshAgents={refreshAgents}
          onViewProfile={handleViewProfile}
          width={isMobile ? undefined : chatSidebar.width}
          onResizeStart={isMobile ? undefined : chatSidebar.onResizeStart}
        />
      )}

      {/* ── Main area ── */}
      {(!isMobile || showChatOnMobile) && (
      <div className="flex-1 overflow-hidden flex flex-col min-w-0">
        {/* Header */}
        <div className="border-b border-border-default bg-surface-secondary shrink-0 relative">
          {isMobile ? (
            <>
              {/* Mobile Row 1: back + name + status */}
              <div className="flex items-center px-3 h-11 gap-2">
                <button
                  onClick={() => history.back()}
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
                  onClick={() => { if (mainTab === 'profile') history.back(); else setMainTab('chat'); }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    mainTab === 'chat' ? 'bg-brand-500/15 text-brand-500' : 'text-fg-tertiary'
                  }`}
                >Chat</button>
                <button
                  onClick={() => { if (mainTab !== 'profile') switchToProfile(); }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    mainTab === 'profile' ? 'bg-brand-500/15 text-brand-500' : 'text-fg-tertiary'
                  }`}
                >{chatMode === 'channel' ? 'Team' : 'Profile'}</button>
                <div className="flex-1" />
                {chatMode === 'direct' && (
                  <>
                    <button
                      onClick={newConversation}
                      className="text-[11px] text-brand-500 px-2 py-1 rounded-md bg-brand-500/10 font-medium shrink-0"
                    >+ New</button>
                    <button
                      ref={historyBtnRef}
                      onClick={() => setShowSessions(!showSessions)}
                      className={`p-1 rounded-md transition-colors shrink-0 ${showSessions ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary'}`}
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
          /* Desktop: original single-row header */
          <div className="flex items-center px-6 h-14 gap-3">
            <span className="font-semibold text-sm truncate">{modeTitle}</span>
            {chatMode === 'direct' && currentAgent && (
              <AgentStatusBadge agent={currentAgent} tasks={tasks} onViewProfile={handleViewProfile} />
            )}
            {(chatMode === 'channel' || chatMode === 'dm') && (
              <span className="text-xs text-fg-tertiary">{messages.length} messages</span>
            )}
            {chatMode === 'dm' && (
              <span className="text-xs text-fg-tertiary ml-1">
                {isSelfDm ? '· Private notepad' : `· Direct message with ${activeDmUser?.name ?? ''}`}
              </span>
            )}

            {((chatMode === 'direct' && selectedAgent) || (chatMode === 'channel' && activeTeamId)) && (
              <div className="flex items-center gap-0.5 ml-4 -mb-px">
                <button
                  onClick={() => setMainTab('chat')}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                    mainTab === 'chat'
                      ? 'border-brand-500 text-brand-500'
                      : 'border-transparent text-fg-tertiary hover:text-fg-secondary'
                  }`}
                >
                  Chat
                </button>
                <button
                  onClick={() => setMainTab('profile')}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                    mainTab === 'profile'
                      ? 'border-brand-500 text-brand-500'
                      : 'border-transparent text-fg-tertiary hover:text-fg-secondary'
                  }`}
                >
                  {chatMode === 'channel' ? 'Team' : 'Profile'}
                </button>
              </div>
            )}

            {/* Right: New Chat + History buttons */}
            {chatMode === 'direct' && currentAgent && (
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={newConversation}
                  className="text-xs text-brand-500 hover:text-brand-500 px-2.5 py-1 rounded-md hover:bg-brand-500/10 border border-brand-500/20 transition-colors flex items-center gap-1"
                >
                  + New Chat
                </button>
                <button
                  ref={historyBtnRef}
                  onClick={() => setShowSessions(!showSessions)}
                  className={`p-1.5 rounded-md transition-colors ${showSessions ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated'}`}
                  title="History"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
              </div>
            )}
          </div>
          )}

          {/* Session tab bar (direct mode, chat tab) */}
          {chatMode === 'direct' && selectedAgent && mainTab === 'chat' && openSessionTabs.length > 0 && (
            <div className="flex items-center gap-0 px-3 overflow-x-auto scrollbar-hide border-t border-border-default/50">
              {openSessionTabs.map(s => (
                <div
                  key={s.id}
                  className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-b-2 transition-colors shrink-0 max-w-[180px] ${
                    s.id === activeSessionId
                      ? 'border-brand-500 text-brand-500 bg-brand-500/5'
                      : 'border-transparent text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated/50'
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
                  <span className="truncate">{s.id === NEW_CHAT_PLACEHOLDER_ID ? 'New Chat' : (s.title || 'Conversation')}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); closeSessionTab(s.id); }}
                    className="opacity-0 group-hover:opacity-100 text-fg-tertiary hover:text-fg-secondary transition-opacity shrink-0"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Floating history panel */}
          {chatMode === 'direct' && selectedAgent && showSessions && (
            <div
              ref={historyPanelRef}
              className="absolute right-4 top-full mt-1 w-72 max-h-[420px] bg-surface-secondary border border-border-default rounded-xl shadow-2xl shadow-black/40 z-50 flex flex-col overflow-hidden"
            >
              <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
                <span className="text-xs font-semibold text-fg-secondary uppercase tracking-wider">History</span>
                <button onClick={() => setShowSessions(false)} className="text-fg-tertiary hover:text-fg-secondary text-xs">✕</button>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {sessions.length === 0 && (
                  <div className="text-xs text-fg-tertiary text-center py-6">No conversations yet</div>
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
                  if (today.length > 0) groups.push({ label: 'Today', items: today });
                  if (yesterday.length > 0) groups.push({ label: 'Yesterday', items: yesterday });
                  if (week.length > 0) groups.push({ label: 'Previous 7 days', items: week });
                  if (older.length > 0) groups.push({ label: 'Older', items: older });
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
                          <div className="truncate font-medium">{s.title || 'Conversation'}</div>
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

        {/* Profile Tab */}
        {mainTab === 'profile' && chatMode === 'direct' && selectedAgent && (
          <div className="flex-1 overflow-y-auto">
            <AgentProfile
              agentId={selectedAgent}
              onBack={() => setMainTab('chat')}
              inline
            />
          </div>
        )}
        {mainTab === 'profile' && chatMode === 'channel' && activeTeamId && (
          <div className="flex-1 overflow-y-auto">
            <TeamProfile
              teamId={activeTeamId}
              onBack={() => setMainTab('chat')}
              inline
            />
          </div>
        )}

        {/* Chat Tab: Messages */}
        <div ref={chatScrollRef} className={`flex-1 overflow-y-auto p-5 space-y-3 ${mainTab !== 'chat' ? 'hidden' : ''}`}>
          {hasMore && (
            <div className="flex justify-center py-2">
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="text-xs text-brand-500 hover:text-brand-500 disabled:opacity-50 px-4 py-1.5 border border-brand-500/30 rounded-lg"
              >
                {loadingMore ? 'Loading…' : '↑ Load earlier messages'}
              </button>
            </div>
          )}

          {messages.length === 0 && !sending && (
            <div className="flex flex-col items-center justify-center h-full text-fg-tertiary text-sm space-y-2">
              <div className="opacity-20">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  {chatMode === 'channel'
                    ? <><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H6l-4 4V6c0-1.1.9-2 2-2z" /><line x1="8" y1="10" x2="16" y2="10" /><line x1="8" y1="14" x2="13" y2="14" /></>
                    : <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  }
                </svg>
              </div>
              {chatMode === 'channel' && <div>No messages in {activeGroupChat?.name ?? activeChannel} yet.</div>}
              {chatMode === 'direct' && !selectedAgent && <div>Select an agent from the sidebar to start.</div>}
              {chatMode === 'direct' && selectedAgent && <div>Start a new conversation with {currentAgent?.name}.</div>}
            </div>
          )}

          {chatMode === 'channel'
            ? messages.map(msg => (
                <div key={msg.id} className="group/msg flex gap-3">
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 cursor-pointer ${
                      msg.sender === 'user' ? 'bg-brand-600 text-white' : 'bg-brand-500/15 text-brand-600 hover:ring-1 hover:ring-brand-500/40'
                    }`}
                    onClick={(e) => {
                      if (msg.sender === 'agent' && msg.agentId) {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setAvatarPopover({ agentId: msg.agentId, top: rect.top, left: rect.right + 8 });
                      }
                    }}
                  >
                    {msg.sender === 'user' ? (currentUserName?.[0] ?? 'Y') : (msg.agentName?.[0] ?? 'A')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-fg-primary">
                        {msg.sender === 'user' ? (currentUserName ?? 'You') : msg.agentName ?? 'Agent'}
                      </span>
                      <span className="text-xs text-fg-tertiary">{msg.time}</span>
                    </div>
                    <div className={msg.isError || (msg.sender === 'agent' && msg.text.startsWith('⚠'))
                      ? 'mt-0.5 px-3 py-2 rounded-lg border-b-2 border-red-500/60'
                      : 'mt-0.5'
                    }>
                      {msg.sender === 'agent'
                        ? <MarkdownMessage content={msg.text} className="text-sm text-fg-secondary" />
                        : <div className="text-sm text-fg-secondary whitespace-pre-wrap">
                            {msg.images && msg.images.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mb-1">
                                {msg.images.map((src, idx) => (
                                  <img key={idx} src={src} alt="" className="max-w-[200px] max-h-[150px] rounded-lg object-cover cursor-pointer hover:opacity-80 transition-opacity" onClick={() => window.open(src, '_blank')} />
                                ))}
                              </div>
                            )}
                            {msg.text}
                          </div>
                      }
                    </div>
                    <div className="opacity-0 group-hover/msg:opacity-100 transition-opacity">
                      <MessageActions msg={msg} onCopy={handleCopy} onRetry={handleRetry} isCopied={copiedMsgId === msg.id} />
                    </div>
                  </div>
                </div>
              ))
            : messages.map((msg, i) => {
                const isPending = isLastPending && i === messages.length - 1;
                const isStreamingMsg = isPending && sending;
                // Always show actions for stopped/error messages, otherwise only when not streaming
                const showActions = !isStreamingMsg || msg.isStopped;
                return (
                  <div key={msg.id} className={`group/msg flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className="max-w-[75%]">
                      <div className="text-xs text-fg-tertiary mb-1">
                        {msg.sender === 'user'
                          ? (currentUserName ?? 'You')
                          : <ChatAgentLink
                              name={msg.agentName ?? (chatMode === 'direct' ? currentAgent?.name ?? 'Agent' : 'Agent')}
                              agentId={msg.agentId ?? (chatMode === 'direct' ? currentAgent?.id : undefined)}
                              agents={agents}
                              onViewProfile={handleViewProfile}
                            />
                        } · {msg.time}
                      </div>
                      <div className={`px-4 py-3 rounded-2xl text-sm ${
                        msg.sender === 'user'
                          ? 'bg-brand-600 text-white rounded-br-sm'
                          : msg.isError || (msg.sender === 'agent' && msg.text.startsWith('⚠'))
                            ? 'bg-surface-chat-bubble text-fg-primary rounded-bl-sm border-b-2 border-red-500/60'
                            : 'bg-surface-chat-bubble text-fg-primary rounded-bl-sm'
                      }`}>
                        {msg.sender === 'user'
                          ? <>
                              {msg.images && msg.images.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mb-2">
                                  {msg.images.map((src, idx) => (
                                    <img key={idx} src={src} alt="" className="max-w-[200px] max-h-[150px] rounded-lg object-cover cursor-pointer hover:opacity-80 transition-opacity" onClick={() => window.open(src, '_blank')} />
                                  ))}
                                </div>
                              )}
                              {msg.text && <span className="whitespace-pre-wrap leading-relaxed">{msg.text}</span>}
                            </>
                          : <AgentMessageBody
                              msg={msg}
                              isStreaming={isStreamingMsg}
                              liveActivities={isStreamingMsg ? activities : []}
                            />
                        }
                      </div>
                      {showActions && (
                        <div className={`transition-opacity ${msg.isStopped ? 'opacity-100' : 'opacity-0 group-hover/msg:opacity-100'} ${msg.sender === 'user' ? 'flex justify-end' : ''}`}>
                          <MessageActions msg={msg} onCopy={handleCopy} onRetry={handleRetry} isCopied={copiedMsgId === msg.id} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
          }
          {chatMode === 'channel' && sending && (
            <div className="text-xs text-fg-tertiary animate-pulse ml-11">Agent is thinking…</div>
          )}
          <div ref={messagesEnd} />
        </div>

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

        {/* Input (only in chat tab) */}
        <div className={`p-4 border-t border-border-default bg-surface-secondary relative shrink-0 ${mainTab !== 'chat' ? 'hidden' : ''}`} onDrop={handleDrop} onDragOver={handleDragOver}>
          {mentionDropdown && filteredAgents.length > 0 && (
            <div className="absolute bottom-full left-4 mb-1 bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden z-10">
              {filteredAgents.map(a => (
                <button
                  key={a.id}
                  onClick={() => insertMention(a.name)}
                  className="w-full text-left px-4 py-2 text-sm text-fg-secondary hover:bg-surface-overlay flex items-center gap-2"
                >
                  <span className="text-brand-500">@</span>
                  {a.name}
                  <span className="text-xs text-fg-tertiary ml-auto">{a.role}</span>
                </button>
              ))}
            </div>
          )}
          {pendingImages.length > 0 && (
            <div className="flex items-center gap-2 mb-2 overflow-x-auto pb-1">
              {pendingImages.map(img => (
                <div key={img.id} className="relative group/img shrink-0">
                  <img src={img.dataUrl} alt={img.name} className="w-16 h-16 rounded-lg object-cover border border-border-default" />
                  <button
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-surface-secondary border border-gray-600 rounded-full flex items-center justify-center text-fg-secondary hover:text-red-500 hover:border-red-500 text-xs opacity-0 group-hover/img:opacity-100 transition-opacity"
                  >
                    ×
                  </button>
                </div>
              ))}
              {pendingImages.length < MAX_IMAGES && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-16 h-16 rounded-lg border border-dashed border-gray-600 flex items-center justify-center text-fg-tertiary hover:text-fg-secondary hover:border-gray-400 transition-colors shrink-0"
                  title="Add more images"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
                </button>
              )}
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={e => { if (e.target.files) addImageFiles(e.target.files); e.target.value = ''; }} />
          <div className="flex gap-2 items-end">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={chatMode === 'direct' && !selectedAgent}
              className="px-2.5 py-2.5 text-fg-tertiary hover:text-fg-secondary disabled:opacity-40 transition-colors rounded-xl hover:bg-surface-elevated"
              title="Attach images"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            </button>
            <textarea
              value={input}
              onChange={e => {
                handleInputChange(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
              }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={chatMode === 'direct' && !selectedAgent}
              rows={1}
              className="flex-1 px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm focus:border-brand-500 outline-none disabled:opacity-40 transition-colors resize-none overflow-y-auto leading-5"
              style={{ maxHeight: '120px' }}
            />
            {sending && chatMode !== 'dm' && (
              <button
                onClick={stopSending}
                className="px-3 py-2.5 bg-red-600 hover:bg-red-500 text-white text-sm rounded-xl transition-colors flex items-center gap-1.5"
                title="Stop agent"
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
              Send
            </button>
          </div>
        </div>
      </div>
      )}

    </div>
  );
}

function AgentStatusBadge({ agent, tasks, onViewProfile }: { agent: AgentInfo; tasks: TaskInfo[]; onViewProfile?: (agentId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [showActivityModal, setShowActivityModal] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isWorking = agent.status === 'working';
  const isError = agent.status === 'error';
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

  const dotColor = isError ? 'bg-red-400 animate-pulse' : isWorking ? 'bg-blue-400 animate-pulse' : 'bg-green-400';
  const label = isError ? 'error' : isWorking ? 'working' : 'idle';

  const activityLabel = activity
    ? activity.type === 'heartbeat' ? `Heartbeat: ${activity.heartbeatName ?? activity.label}`
    : activity.type === 'chat' ? activity.label
    : activity.type === 'task' ? `Task: ${activity.label}`
    : activity.label
    : 'Processing...';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full transition-colors ${
          isWorking ? 'bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20'
          : isError ? 'bg-red-500/10 border border-red-500/20 hover:bg-red-500/20'
          : 'bg-green-500/10 border border-green-500/20 hover:bg-green-500/20'
        }`}
      >
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span className={`text-xs ${isError ? 'text-red-500' : isWorking ? 'text-amber-600' : 'text-green-600'}`}>{label}</span>
      </button>

      {open && isError && (
        <div className="absolute top-full left-0 mt-1.5 bg-surface-secondary border border-red-500/30 rounded-xl shadow-2xl z-30 w-80 p-3 space-y-2">
          <p className="text-[10px] text-red-500 uppercase font-semibold">Error Details</p>
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
            <pre className="text-[10px] text-red-500/80 leading-relaxed whitespace-pre-wrap break-all font-mono line-clamp-6">
              {agent.lastError || 'Agent encountered an error. Check profile for details.'}
            </pre>
            {agent.lastErrorAt && <div className="text-[9px] text-red-500/50 mt-1.5 border-t border-red-500/10 pt-1">{new Date(agent.lastErrorAt).toLocaleString()}</div>}
          </div>
          <button
            onClick={() => { setOpen(false); onViewProfile?.(agent.id); }}
            className="w-full text-center text-[10px] text-red-500 hover:text-red-500 border border-red-500/30 hover:border-red-500/50 rounded-lg py-1 transition-colors"
          >
            View Agent Profile →
          </button>
        </div>
      )}

      {open && isWorking && (
        <div className="absolute top-full left-0 mt-1.5 bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-30 w-80 p-3 space-y-2">
          <p className="text-[10px] text-fg-tertiary uppercase font-semibold">Current Activity</p>
          {currentTask ? (
            <div
              className="flex items-center gap-2 p-2 rounded-lg bg-brand-500/10 border border-brand-500/30 cursor-pointer hover:bg-brand-500/10 transition-colors"
              onClick={() => { setOpen(false); navBus.navigate('tasks', { openTask: currentTask.id }); }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-brand-500 truncate">{currentTask.title}</div>
                <div className="text-[10px] text-fg-tertiary">Working on task · Click to view</div>
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
                  {activity?.type === 'heartbeat' ? 'Periodic check-in task'
                   : activity?.type === 'chat' ? 'Responding to conversation'
                   : 'Agent is thinking or communicating'}
                </div>
              </div>
            </div>
          )}
          <button
            onClick={() => { setOpen(false); setShowActivityModal(true); }}
            className="w-full text-center text-[10px] text-brand-500 hover:text-brand-500 border border-border-default hover:border-gray-600 rounded-lg py-1.5 transition-colors"
          >
            View Execution Log →
          </button>
        </div>
      )}

      {showActivityModal && (
        <AgentActivityModal
          agent={agent}
          currentTask={currentTask}
          onClose={() => setShowActivityModal(false)}
          onGoToTask={currentTask ? () => { setShowActivityModal(false); navBus.navigate('tasks', { openTask: currentTask.id }); } : undefined}
        />
      )}
    </div>
  );
}

// ─── Agent Activity Modal ────────────────────────────────────────────────────

function AgentActivityModal({ agent, currentTask, onClose, onGoToTask }: {
  agent: AgentInfo;
  currentTask: TaskInfo | null | undefined;
  onClose: () => void;
  onGoToTask?: () => void;
}) {
  const activity = agent.currentActivity;
  const [taskLogs, setTaskLogs] = useState<TaskLogEntry[]>([]);
  const [activityLogs, setActivityLogs] = useState<AgentActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const modalScrollRef = useRef<HTMLDivElement>(null);
  const modalAtBottomRef = useRef(true);

  useEffect(() => {
    const el = modalScrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const threshold = 80;
      modalAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Fetch logs on mount
  useEffect(() => {
    setLoading(true);
    if (currentTask) {
      api.tasks.getLogs(currentTask.id).then(d => { setTaskLogs(d.logs); setLoading(false); }).catch(() => setLoading(false));
    } else if (activity) {
      api.agents.getActivityLogs(agent.id, activity.id).then(d => { setActivityLogs(d.logs); setLoading(false); }).catch(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [agent.id, activity, currentTask]);

  // Real-time task:log events
  useEffect(() => {
    if (!currentTask) return;
    const unsub = wsClient.on('task:log', (event) => {
      const p = event.payload;
      if (p.taskId !== currentTask.id) return;
      const entry: TaskLogEntry = {
        id: p.id as string, taskId: p.taskId as string, agentId: p.agentId as string,
        seq: p.seq as number, type: p.logType as string, content: p.content as string,
        metadata: p.metadata as Record<string, unknown> | undefined, createdAt: p.createdAt as string,
      };
      setTaskLogs(prev => {
        if (entry.id && prev.some(e => e.id === entry.id)) return prev;
        return [...prev, entry];
      });
    });
    return unsub;
  }, [currentTask]);

  // Real-time agent:activity_log events
  useEffect(() => {
    if (!activity || currentTask) return;
    const unsub = wsClient.on('agent:activity_log', (event) => {
      const p = event.payload;
      if (p.agentId !== agent.id || p.activityId !== activity.id) return;
      const entry: AgentActivityLogEntry = {
        seq: p.seq as number,
        type: p.type as AgentActivityLogEntry['type'],
        content: p.content as string,
        metadata: p.metadata as Record<string, unknown> | undefined,
        createdAt: p.createdAt as string,
      };
      setActivityLogs(prev => {
        if (prev.some(e => e.seq === entry.seq)) return prev;
        return [...prev, entry];
      });
    });
    return unsub;
  }, [agent.id, activity, currentTask]);

  useEffect(() => {
    if (!modalAtBottomRef.current) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [taskLogs, activityLogs]);

  const activityTypeLabel = activity?.type === 'heartbeat' ? 'Heartbeat Task'
    : activity?.type === 'chat' ? 'Chat Response'
    : activity?.type === 'task' ? 'Task Execution'
    : 'Processing';

  const activityTypeColor = activity?.type === 'heartbeat' ? 'text-blue-600'
    : activity?.type === 'chat' ? 'text-blue-600'
    : 'text-brand-500';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-secondary border border-border-default rounded-xl w-[780px] max-w-[95vw] max-h-[75vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-default">
          <div className="flex items-center gap-3 min-w-0">
            <span className={`w-2 h-2 rounded-full shrink-0 ${
              activity?.type === 'heartbeat' ? 'bg-blue-400 animate-pulse'
              : activity?.type === 'chat' ? 'bg-blue-400 animate-pulse'
              : 'bg-blue-400 animate-pulse'
            }`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{agent.name}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${activityTypeColor} border-current/20 bg-current/5`}>
                  {activityTypeLabel}
                </span>
              </div>
              <div className="text-xs text-fg-secondary truncate mt-0.5">
                {activity?.label ?? currentTask?.title ?? 'Processing...'}
              </div>
              {activity?.startedAt && (
                <div className="text-[10px] text-fg-tertiary mt-0.5">
                  Started {new Date(activity.startedAt).toLocaleTimeString()}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onGoToTask && (
              <button onClick={onGoToTask} className="px-2.5 py-1 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors">
                Go to Task →
              </button>
            )}
            <button onClick={onClose} className="text-fg-tertiary hover:text-fg-secondary text-lg leading-none px-1">×</button>
          </div>
        </div>

        {/* Logs — unified rendering for both task logs and activity logs */}
        <div ref={modalScrollRef} className="flex-1 overflow-y-auto p-4 space-y-1.5">
          {loading ? (
            <div className="text-center py-8 text-xs text-fg-tertiary">Loading logs…</div>
          ) : currentTask && taskLogs.length > 0 ? (
            <>
              {filterCompletedStarts(taskLogs.slice(-60).map(taskLogToEntry).filter((e): e is ExecEntry => e != null)).map((entry, i) => (
                <ExecEntryRow key={`t-${i}`} entry={entry} showTime />
              ))}
            </>
          ) : activityLogs.length > 0 ? (
            <>
              {filterCompletedStarts(activityLogs.map(activityLogToEntry).filter((e): e is ExecEntry => e != null)).map((entry, i) => (
                <ExecEntryRow key={`a-${i}`} entry={entry} showTime />
              ))}
            </>
          ) : agent.status === 'working' ? (
            <div className="text-center py-8 space-y-2">
              <div className="text-xs text-fg-tertiary">Agent just started processing...</div>
              <div className="text-[10px] text-fg-tertiary">Execution logs will appear here as the agent makes progress.</div>
            </div>
          ) : (
            <div className="text-center py-8 text-xs text-fg-tertiary">No execution logs available.</div>
          )}

          {agent.status === 'working' && <ThinkingDots label="Working" />}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}
