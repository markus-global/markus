import { useEffect, useLayoutEffect, useRef, useState, useCallback, type RefObject } from 'react';
import {
  api, wsClient,
  type AgentInfo, type AgentToolEvent, type HumanUserInfo, type ExternalAgentInfo,
  type ChatMessageInfo, type ChatSessionInfo, type ChannelMessageInfo,
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

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single interleaved segment: either text or a tool call */
export type MsgSegment =
  | { type: 'text'; content: string; thinking?: string }
  | { type: 'tool'; key: string; tool: string; status: 'running' | 'done' | 'error'; args?: unknown; result?: string; error?: string; durationMs?: number };

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
  if (m.metadata?.images?.length) {
    base.images = m.metadata.images;
  }
  return base;
}

function channelMsgToChat(m: ChannelMessageInfo): ChatMsg {
  const isError = m.senderType === 'system' || (m.senderType === 'agent' && m.text.startsWith('⚠'));
  return {
    id: m.id,
    sender: m.senderType === 'human' ? 'user' : 'agent',
    text: m.text,
    time: new Date(m.createdAt).toLocaleTimeString(),
    agentName: m.senderType !== 'human' ? m.senderName : undefined,
    agentId: m.senderType !== 'human' ? m.senderId : undefined,
    isError,
  };
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
      <button onClick={() => setOpen(!open)} className="text-gray-500 hover:text-indigo-400 cursor-pointer transition-colors">
        {name}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-40 w-56 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-indigo-600/30 flex items-center justify-center text-[10px] font-bold text-indigo-300">
              {agentInitials(agent.name)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-gray-200 font-medium truncate">{agent.name}</div>
              <div className="text-[10px] text-gray-500">{agent.role} · {agent.agentRole ?? 'worker'}</div>
            </div>
            <span className={`w-2 h-2 rounded-full shrink-0 ${agent.status === 'working' ? 'bg-yellow-400 animate-pulse' : agent.status === 'error' ? 'bg-red-400' : 'bg-green-400'}`} />
          </div>
          <button
            onClick={() => { setOpen(false); onViewProfile?.(agent.id); }}
            className="w-full text-center text-[10px] text-indigo-400 hover:text-indigo-300 border border-gray-700 hover:border-gray-600 rounded-lg py-1 transition-colors"
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

  const statusColor = agent.status === 'idle' ? 'bg-green-400' : agent.status === 'working' ? 'bg-yellow-400 animate-pulse' : agent.status === 'error' ? 'bg-red-400' : 'bg-gray-500';
  const statusLabel = agent.status === 'idle' ? 'Online' : agent.status === 'working' ? 'Working' : agent.status === 'error' ? 'Error' : agent.status === 'paused' ? 'Paused' : 'Offline';

  return (
    <div
      ref={ref}
      className="fixed z-50 w-64 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-4 space-y-3"
      style={{ top: anchorRect.top + 40, left: anchorRect.left }}
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-indigo-600/30 flex items-center justify-center text-sm font-bold text-indigo-300">
          {agentInitials(agent.name)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-200 font-medium truncate">{agent.name}</div>
          <div className="text-[11px] text-gray-500">{agent.role}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
            <span className="text-[10px] text-gray-400">{statusLabel}</span>
            {agent.agentRole && <span className="text-[10px] text-gray-600">· {agent.agentRole}</span>}
          </div>
        </div>
      </div>
      <button
        onClick={() => { onClose(); onViewProfile(agent.id); }}
        className="w-full py-1.5 text-xs text-indigo-400 hover:text-indigo-300 border border-gray-700 hover:border-gray-600 rounded-lg transition-colors text-center"
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
        className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-gray-500 hover:text-gray-200 hover:bg-gray-700/60 transition-colors"
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
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-indigo-400 hover:text-indigo-300 hover:bg-indigo-900/30 transition-colors"
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
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-red-400 hover:text-red-300 hover:bg-red-900/30 transition-colors"
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
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-400 transition-colors"
            >
              <span className={`transition-transform ${expandedThinking ? 'rotate-90' : ''}▶`} style={{ fontSize: 8 }} />
              <span>思考过程 ({allThinking.length} 字符)</span>
            </button>
            {expandedThinking && (
              <div className="mt-1 pl-3 border-l-2 border-indigo-500/50 text-xs text-gray-400 whitespace-pre-wrap max-h-60 overflow-y-auto">
                {allThinking}
              </div>
            )}
          </div>
        )}

        {segments.map((seg, i) => {
          const isLastSeg = i === segments.length - 1;
          if (seg.type === 'tool') {
            return <ToolCallRow key={seg.key} info={{ tool: seg.tool, status: seg.status, args: seg.args, result: seg.result, error: seg.error, durationMs: seg.durationMs }} isLast={isLastSeg && !isWaiting} />;
          }
          // text segment
          return (
            <div key={i} className={seg.content ? '' : 'hidden'}>
              <MarkdownMessage content={seg.content} />
              {isStreaming && isLastSeg && (
                <span className="inline-block w-0.5 h-4 bg-indigo-400 animate-pulse ml-0.5 align-text-bottom" />
              )}
            </div>
          );
        })}

        {/* Between-step thinking: a tool just finished, waiting for next action */}
        {isWaiting && (
          <div className="flex items-center gap-2 pl-0.5 pt-0.5">
            {/* Connector line from last tool down to dots */}
            <div className="flex flex-col items-center" style={{ width: 14 }}>
              <div className="w-px flex-1 bg-gray-700" style={{ minHeight: 6 }} />
              <div className="w-2 h-2 rounded-full border border-gray-600 bg-gray-800 shrink-0" />
            </div>
            <ThinkingDots label="Processing" />
          </div>
        )}

        {/* Stopped indicator */}
        {isStopped && (
          <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-gray-500">
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
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-gray-500">
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

  // Tab system: Chat vs Agent Profile
  const [mainTab, setMainTab] = useState<MainTab>('chat');

  // Avatar popover in chat messages
  const [avatarPopover, setAvatarPopover] = useState<{ agentId: string; top: number; left: number } | null>(null);

  const handleViewProfile = useCallback((agentId: string) => {
    setChatMode('direct');
    setSelectedAgent(agentId);
    setMainTab('profile');
    setAvatarPopover(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const oldestMsgId = useRef<string | null>(null);

  // Group chats
  const [groupChats, setGroupChats] = useState<Array<{ id: string; name: string; type: string; channelKey: string; memberCount?: number }>>([]);

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

  const messagesEnd = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  /** When true, the next scroll-to-bottom effect is suppressed (used by loadMore) */
  const skipScrollRef = useRef(false);

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
    return () => { clearInterval(timer); clearInterval(teamTimer); unsub(); unsubTeam(); unsubGroup(); };
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

  // Snap to bottom immediately after DOM updates.
  // Use `instant` so there's no scroll animation — the bottom is simply the initial position.
  // When `loadMore` prepends older messages we set skipScrollRef so the view doesn't jump.
  useLayoutEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      return;
    }
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
    try {
      const result = await api.sessions.getMessages(sessionId, 50);
      const msgs = result.messages.map(dbMsgToChat);
      msgBuffers.current.set(convKey, msgs);
      if (currentConvKeyRef.current === convKey) {
        setMessages(msgs);
        setHasMore(result.hasMore);
        oldestMsgId.current = result.messages[0] ? new Date(result.messages[0].createdAt).toISOString() : null;
      }
    } catch {
      if (currentConvKeyRef.current === convKey) { setMessages([]); setHasMore(false); oldestMsgId.current = null; }
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
    currentConvKeyRef.current = newKey;

    // Restore displayed state from this conv's buffer
    const bufferedMsgs = msgBuffers.current.get(newKey);
    const bufferedActs = actBuffers.current.get(newKey) ?? [];
    const isSending = sendingConvs.current.has(newKey);

    setActivities(bufferedActs);
    setSending(isSending);

    if (bufferedMsgs !== undefined) {
      // Already have content (possibly mid-stream) — show immediately, no DB load
      setMessages(bufferedMsgs);
      setHasMore(false); // pagination state will be restored when needed
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
      } else if (chatMode === 'smart') {
        loadChannelMessages('smart:default');
      } else if (chatMode === 'direct' && selectedAgent) {
        loadSessions(selectedAgent).then(s => {
          if (s.length > 0) {
            setActiveSessionId(s[0]!.id);
            loadSessionMessages(s[0]!.id, newKey);
          } else {
            setActiveSessionId(null);
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
      if (msgChannel && msgChannel !== activeChannel) return;
      const senderType = (p['senderType'] as string) ?? 'agent';
      const newMsg: ChatMsg = {
        id: `ws_${Date.now()}`,
        sender: senderType === 'human' ? 'user' : 'agent',
        text: (p['text'] as string) ?? (p['message'] as string) ?? '',
        time: new Date().toLocaleTimeString(),
        agentName: senderType === 'agent' ? ((p['senderName'] as string) ?? (p['agentId'] as string) ?? 'Agent') : undefined,
      };
      const key = makeConvKey('channel', selectedAgent, activeChannel, activeDmUserId);
      updateConvMsgs(key, prev => [...prev, newMsg]);
    });
    return unsub;
  }, [chatMode, activeChannel, selectedAgent, activeDmUserId, updateConvMsgs]);

  // ── Task helpers ─────────────────────────────────────────────────────────────
  const linkedTask = tasks.find(t => t.id === linkedTaskId);

  const createAndLinkTask = async () => {
    const title = newTaskTitle.trim() || (messages[0]?.text.slice(0, 60) ?? 'New Conversation Task');
    try {
      await api.tasks.create(title, `Created from chat with ${currentAgent?.name ?? 'agent'}`, 'medium', selectedAgent || undefined);
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
    if (sending) return;
    if (chatMode === 'direct' && !selectedAgent) return;

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

      /** Handle a tool event: start adds a 'running' segment, end updates it */
      const handleToolEvent = (event: AgentToolEvent) => {
        appendConvActivity(sendKey, { ...event, ts: Date.now() });
        if (event.phase === 'start') {
          const toolKey = `${event.tool}_${Date.now()}`;
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const segs = u[idx]!.segments ?? [];
            u[idx] = { ...u[idx]!, segments: [...segs, { type: 'tool', key: toolKey, tool: event.tool, status: 'running', args: event.arguments }] };
            return u;
          });
        } else {
          // Find the most recent running segment for this tool and mark it done/error
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const segs = [...(u[idx]!.segments ?? [])];
            // scan backwards for last 'running' entry of this tool
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                segs[i] = { ...s, status: event.success === false ? 'error' : 'done', args: event.arguments, result: event.result, error: event.error, durationMs: event.durationMs };
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
          await api.agents.messageStream(
            selectedAgent, text,
            appendTextChunk,
            handleToolEvent,
            abortCtrl.signal,
            imagesToSend,
          );
          loadSessions(selectedAgent).then(s => {
            setSessions(s);
            if (!activeSessionId && s.length > 0) setActiveSessionId(s[0]!.id);
          });
        }
      } catch (e) {
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
              const hasContent = msg.text || (msg.segments && msg.segments.some(s => s.type === 'text' && (s as { content: string }).content));
              if (!hasContent) {
                // No content at all — remove the bubble silently
                return prev.filter(m => m.id !== agentMsgId);
              }
              u[idx] = { ...msg, isStopped: true };
            }
            return u;
          });
        }
      }

      // Mark any still-running tool segments as error (stream ended unexpectedly)
      updateConvMsgs(sendKey, prev => {
        const u = [...prev];
        const idx = u.findIndex(m => m.id === agentMsgId);
        if (idx >= 0) {
          const segs = (u[idx]!.segments ?? []).map(s =>
            s.type === 'tool' && s.status === 'running' ? { ...s, status: 'error' as const } : s
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
            const hasContent = msg.text || (msg.segments && msg.segments.some(s => s.type === 'text' && (s as { content: string }).content));
            if (!hasContent) {
              return prev.filter(m => m.id !== agentMsgId);
            }
            u[idx] = { ...msg, isStopped: true };
          }
          return u;
        });
      }

      // Fallback: if the agent message is empty (SSE connection may have dropped),
      // poll the latest session messages to recover the persisted reply.
      // Skip if user aborted — no need to poll.
      const currentMsgs = msgBuffers.current.get(sendKey) ?? [];
      const agentMsg = currentMsgs.find(m => m.id === agentMsgId);
      if (agentMsg && !agentMsg.text && chatMode === 'direct' && selectedAgent && !abortCtrl.signal.aborted) {
        const pollForReply = async (retries: number, delayMs: number) => {
          for (let i = 0; i < retries; i++) {
            await new Promise(r => setTimeout(r, delayMs));
            try {
              const sess = await api.sessions.listByAgent(selectedAgent, 1);
              if (sess.sessions.length > 0) {
                const latestSession = sess.sessions[0]!;
                const result = await api.sessions.getMessages(latestSession.id, 2);
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
    // Clear this conv's buffer so it reloads from the selected session
    msgBuffers.current.delete(key);
    setMessages([]);
    await loadSessionMessages(s.id, key);
  };

  const newConversation = () => {
    setActiveSessionId(null);
    const key = currentConvKeyRef.current;
    msgBuffers.current.delete(key);
    setMessages([]);
    setHasMore(false);
    oldestMsgId.current = null;
    setShowSessions(false);
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
  return (
    <div className="flex-1 overflow-hidden flex">
      {/* ── Left sidebar (ChatTeamSidebar) ── */}
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
        onSelectAgent={(agentId) => { setChatMode('direct'); setSelectedAgent(agentId); setMainTab('chat'); }}
        onSelectChannel={(channelKey) => { setChatMode('channel'); setActiveChannel(channelKey); setMainTab('chat'); }}
        onSelectDm={(userId) => { setChatMode('dm'); setActiveDmUserId(userId); setMainTab('chat'); }}
        onRefreshTeams={refreshTeams}
        onRefreshAgents={refreshAgents}
        onViewProfile={handleViewProfile}
      />

      {/* ── Session history sidebar (direct mode) ── */}
      {mainTab === 'chat' && chatMode === 'direct' && selectedAgent && showSessions && (
        <div className="w-52 bg-gray-900/70 border-r border-gray-800 flex flex-col shrink-0">
          <div className="p-3 border-b border-gray-800 flex items-center justify-between">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">History</span>
            <button onClick={() => setShowSessions(false)} className="text-gray-600 hover:text-gray-300 text-xs">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            <button
              onClick={newConversation}
              className="w-full text-left px-3 py-2 text-xs text-indigo-400 hover:bg-gray-800 rounded-lg mb-1 flex items-center gap-1"
            >
              ＋ New conversation
            </button>
            {sessions.map(s => (
              <button
                key={s.id}
                onClick={() => void switchSession(s)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs mb-0.5 transition-colors ${
                  s.id === activeSessionId ? 'bg-indigo-600/20 text-indigo-300' : 'text-gray-400 hover:bg-gray-800'
                }`}
              >
                <div className="truncate">{s.title || 'Conversation'}</div>
                <div className="text-gray-600 mt-0.5">{new Date(s.lastMessageAt).toLocaleDateString()}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Main area ── */}
      <div className="flex-1 overflow-hidden flex flex-col min-w-0">
        {/* Header */}
        <div className="border-b border-gray-800 bg-gray-900 shrink-0">
          {/* Top row: title + status */}
          <div className="flex items-center px-5 h-10 gap-3">
            <span className="font-semibold text-sm">{modeTitle}</span>
            {chatMode === 'direct' && currentAgent && (
              <AgentStatusBadge agent={currentAgent} tasks={tasks} onViewProfile={handleViewProfile} />
            )}
            {(chatMode === 'channel' || chatMode === 'dm') && (
              <span className="text-xs text-gray-500">{messages.length} messages</span>
            )}
            {chatMode === 'dm' && (
              <span className="text-xs text-gray-600 ml-1">
                {isSelfDm ? '· Private notepad' : `· Direct message with ${activeDmUser?.name ?? ''}`}
              </span>
            )}
            {chatMode === 'direct' && currentAgent && (
              <button
                onClick={() => setShowSessions(!showSessions)}
                className="ml-auto text-xs text-gray-500 hover:text-gray-300 px-2 py-0.5 rounded hover:bg-gray-800 transition-colors"
              >
                ⏱ History
              </button>
            )}
          </div>

          {/* Tab row: Chat / Details (only in direct mode with an agent) */}
          {chatMode === 'direct' && selectedAgent && (
            <div className="flex items-center gap-0.5 px-5 -mb-px">
              <button
                onClick={() => setMainTab('chat')}
                className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                  mainTab === 'chat'
                    ? 'border-indigo-500 text-indigo-300'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                Chat
              </button>
              <button
                onClick={() => setMainTab('profile')}
                className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                  mainTab === 'profile'
                    ? 'border-indigo-500 text-indigo-300'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                Details
              </button>
            </div>
          )}
        </div>

        {/* Profile Tab */}
        {mainTab === 'profile' && selectedAgent && (
          <div className="flex-1 overflow-y-auto">
            <AgentProfile
              agentId={selectedAgent}
              onBack={() => setMainTab('chat')}
              inline
            />
          </div>
        )}

        {/* Chat Tab: Messages */}
        <div className={`flex-1 overflow-y-auto p-5 space-y-3 ${mainTab !== 'chat' ? 'hidden' : ''}`}>
          {hasMore && (
            <div className="flex justify-center py-2">
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50 px-4 py-1.5 border border-indigo-800/50 rounded-lg"
              >
                {loadingMore ? 'Loading…' : '↑ Load earlier messages'}
              </button>
            </div>
          )}

          {messages.length === 0 && !sending && (
            <div className="flex flex-col items-center justify-center h-full text-gray-600 text-sm space-y-2">
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
                      msg.sender === 'user' ? 'bg-indigo-600' : 'bg-gray-700 hover:ring-1 hover:ring-indigo-500/40'
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
                      <span className="text-sm font-medium text-white">
                        {msg.sender === 'user' ? (currentUserName ?? 'You') : msg.agentName ?? 'Agent'}
                      </span>
                      <span className="text-xs text-gray-600">{msg.time}</span>
                    </div>
                    <div className={msg.isError || (msg.sender === 'agent' && msg.text.startsWith('⚠'))
                      ? 'mt-0.5 px-3 py-2 rounded-lg bg-red-900/20 border border-red-800/30'
                      : 'mt-0.5'
                    }>
                      {msg.sender === 'agent'
                        ? <MarkdownMessage content={msg.text} className={`text-sm ${msg.isError || msg.text.startsWith('⚠') ? 'text-red-200' : 'text-gray-300'}`} />
                        : <div className="text-sm text-gray-300 whitespace-pre-wrap">
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
                      <div className="text-xs text-gray-500 mb-1">
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
                          ? 'bg-indigo-600 text-white rounded-br-sm'
                          : msg.isError || (msg.sender === 'agent' && msg.text.startsWith('⚠'))
                            ? 'bg-red-900/30 border border-red-800/40 text-red-200 rounded-bl-sm'
                            : 'bg-gray-800 text-gray-200 rounded-bl-sm'
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
            <div className="text-xs text-gray-500 animate-pulse ml-11">Agent is thinking…</div>
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
        <div className={`p-4 border-t border-gray-800 bg-gray-900 relative shrink-0 ${mainTab !== 'chat' ? 'hidden' : ''}`} onDrop={handleDrop} onDragOver={handleDragOver}>
          {mentionDropdown && filteredAgents.length > 0 && (
            <div className="absolute bottom-full left-4 mb-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden z-10">
              {filteredAgents.map(a => (
                <button
                  key={a.id}
                  onClick={() => insertMention(a.name)}
                  className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2"
                >
                  <span className="text-indigo-400">@</span>
                  {a.name}
                  <span className="text-xs text-gray-500 ml-auto">{a.role}</span>
                </button>
              ))}
            </div>
          )}
          {pendingImages.length > 0 && (
            <div className="flex items-center gap-2 mb-2 overflow-x-auto pb-1">
              {pendingImages.map(img => (
                <div key={img.id} className="relative group/img shrink-0">
                  <img src={img.dataUrl} alt={img.name} className="w-16 h-16 rounded-lg object-cover border border-gray-700" />
                  <button
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-900 border border-gray-600 rounded-full flex items-center justify-center text-gray-400 hover:text-red-400 hover:border-red-500 text-xs opacity-0 group-hover/img:opacity-100 transition-opacity"
                  >
                    ×
                  </button>
                </div>
              ))}
              {pendingImages.length < MAX_IMAGES && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-16 h-16 rounded-lg border border-dashed border-gray-600 flex items-center justify-center text-gray-500 hover:text-gray-300 hover:border-gray-400 transition-colors shrink-0"
                  title="Add more images"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
                </button>
              )}
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={e => { if (e.target.files) addImageFiles(e.target.files); e.target.value = ''; }} />
          <div className="flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={(chatMode === 'direct' && !selectedAgent) || (sending && chatMode !== 'dm')}
              className="px-2.5 py-2.5 text-gray-500 hover:text-gray-300 disabled:opacity-40 transition-colors rounded-xl hover:bg-gray-800"
              title="Attach images"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            </button>
            <input
              value={input}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={(chatMode === 'direct' && !selectedAgent) || (sending && chatMode !== 'dm')}
              className="flex-1 px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-sm focus:border-indigo-500 outline-none disabled:opacity-40 transition-colors"
            />
            {sending && chatMode !== 'dm' ? (
              <button
                onClick={stopSending}
                className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white text-sm rounded-xl transition-colors flex items-center gap-1.5"
                title="Stop agent"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
                Stop
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={(chatMode === 'direct' && !selectedAgent) || (!input.trim() && pendingImages.length === 0)}
                className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm rounded-xl transition-colors"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
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

  const dotColor = isError ? 'bg-red-400 animate-pulse' : isWorking ? 'bg-yellow-400 animate-pulse' : 'bg-green-400';
  const label = isError ? 'error' : isWorking ? 'busy' : 'idle';

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
          isWorking ? 'bg-yellow-500/10 border border-yellow-500/20 hover:bg-yellow-500/20'
          : isError ? 'bg-red-500/10 border border-red-500/20 hover:bg-red-500/20'
          : 'bg-green-500/10 border border-green-500/20 hover:bg-green-500/20'
        }`}
      >
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span className={`text-xs ${isError ? 'text-red-400' : isWorking ? 'text-yellow-400' : 'text-green-400'}`}>{label}</span>
      </button>

      {open && isError && (
        <div className="absolute top-full left-0 mt-1.5 bg-gray-900 border border-red-500/30 rounded-xl shadow-2xl z-30 w-80 p-3 space-y-2">
          <p className="text-[10px] text-red-400 uppercase font-semibold">Error Details</p>
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
            <pre className="text-[10px] text-red-300/80 leading-relaxed whitespace-pre-wrap break-all font-mono line-clamp-6">
              {agent.lastError || 'Agent encountered an error. Check profile for details.'}
            </pre>
            {agent.lastErrorAt && <div className="text-[9px] text-red-400/50 mt-1.5 border-t border-red-500/10 pt-1">{new Date(agent.lastErrorAt).toLocaleString()}</div>}
          </div>
          <button
            onClick={() => { setOpen(false); onViewProfile?.(agent.id); }}
            className="w-full text-center text-[10px] text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/50 rounded-lg py-1 transition-colors"
          >
            View Agent Profile →
          </button>
        </div>
      )}

      {open && isWorking && (
        <div className="absolute top-full left-0 mt-1.5 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-30 w-80 p-3 space-y-2">
          <p className="text-[10px] text-gray-500 uppercase font-semibold">Current Activity</p>
          {currentTask ? (
            <div
              className="flex items-center gap-2 p-2 rounded-lg bg-indigo-900/20 border border-indigo-700/30 cursor-pointer hover:bg-indigo-900/30 transition-colors"
              onClick={() => { setOpen(false); navBus.navigate('tasks', { openTask: currentTask.id }); }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-indigo-300 truncate">{currentTask.title}</div>
                <div className="text-[10px] text-gray-500">Working on task · Click to view</div>
              </div>
              <span className="text-[10px] text-gray-600">→</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 p-2 rounded-lg bg-gray-800/50">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                activity?.type === 'heartbeat' ? 'bg-cyan-400 animate-pulse'
                : activity?.type === 'chat' ? 'bg-blue-400 animate-pulse'
                : 'bg-yellow-400 animate-pulse'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-300">{activityLabel}</div>
                <div className="text-[10px] text-gray-500">
                  {activity?.type === 'heartbeat' ? 'Periodic check-in task'
                   : activity?.type === 'chat' ? 'Responding to conversation'
                   : 'Agent is thinking or communicating'}
                </div>
              </div>
            </div>
          )}
          <button
            onClick={() => { setOpen(false); setShowActivityModal(true); }}
            className="w-full text-center text-[10px] text-indigo-400 hover:text-indigo-300 border border-gray-700 hover:border-gray-600 rounded-lg py-1.5 transition-colors"
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

  // Auto-scroll
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [taskLogs, activityLogs]);

  const activityTypeLabel = activity?.type === 'heartbeat' ? 'Heartbeat Task'
    : activity?.type === 'chat' ? 'Chat Response'
    : activity?.type === 'task' ? 'Task Execution'
    : 'Processing';

  const activityTypeColor = activity?.type === 'heartbeat' ? 'text-cyan-400'
    : activity?.type === 'chat' ? 'text-blue-400'
    : 'text-indigo-400';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-[580px] max-h-[75vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-800">
          <div className="flex items-center gap-3 min-w-0">
            <span className={`w-2 h-2 rounded-full shrink-0 ${
              activity?.type === 'heartbeat' ? 'bg-cyan-400 animate-pulse'
              : activity?.type === 'chat' ? 'bg-blue-400 animate-pulse'
              : 'bg-indigo-400 animate-pulse'
            }`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{agent.name}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${activityTypeColor} border-current/20 bg-current/5`}>
                  {activityTypeLabel}
                </span>
              </div>
              <div className="text-xs text-gray-400 truncate mt-0.5">
                {activity?.label ?? currentTask?.title ?? 'Processing...'}
              </div>
              {activity?.startedAt && (
                <div className="text-[10px] text-gray-600 mt-0.5">
                  Started {new Date(activity.startedAt).toLocaleTimeString()}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onGoToTask && (
              <button onClick={onGoToTask} className="px-2.5 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors">
                Go to Task →
              </button>
            )}
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none px-1">×</button>
          </div>
        </div>

        {/* Logs — unified rendering for both task logs and activity logs */}
        <div className="flex-1 overflow-y-auto p-4 space-y-1.5">
          {loading ? (
            <div className="text-center py-8 text-xs text-gray-600">Loading logs…</div>
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
          ) : (
            <div className="text-center py-8 text-xs text-gray-600">No execution logs yet.</div>
          )}

          {agent.status === 'working' && <ThinkingDots label="Working" />}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}
