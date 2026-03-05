import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import {
  api, wsClient,
  type AgentInfo, type AgentToolEvent, type HumanUserInfo,
  type ChatMessageInfo, type ChatSessionInfo, type ChannelMessageInfo,
  type TaskInfo, type AuthUser, type StoredSegment,
} from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { ActivityIndicator, type ActivityStep } from '../components/ActivityIndicator.tsx';
import { navBus } from '../navBus.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single interleaved segment: either text or a tool call */
export type MsgSegment =
  | { type: 'text'; content: string }
  | { type: 'tool'; key: string; tool: string; status: 'running' | 'done' | 'error' };

interface ChatMsg {
  id: string;
  sender: 'user' | 'agent';
  text: string;          // plain text (used for DB-loaded messages without segments)
  time: string;
  agentName?: string;
  /** Chronologically interleaved segments (text + tool calls) — built during streaming */
  segments?: MsgSegment[];
  /** Legacy frozen activities for DB-loaded messages that predate the segments field */
  activities?: ActivityStep[];
}

type ChatMode = 'channel' | 'smart' | 'direct' | 'dm';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dbMsgToChat(m: ChatMessageInfo): ChatMsg {
  const base: ChatMsg = {
    id: m.id,
    sender: m.role === 'user' ? 'user' : 'agent',
    text: m.content,
    time: new Date(m.createdAt).toLocaleTimeString(),
  };
  // Reconstruct interleaved segments from persisted metadata
  if (m.role !== 'user' && m.metadata?.segments && m.metadata.segments.length > 0) {
    base.segments = m.metadata.segments.map((s: StoredSegment, i: number) =>
      s.type === 'tool'
        ? { type: 'tool' as const, key: `${s.tool}_${i}`, tool: s.tool, status: s.status }
        : { type: 'text' as const, content: s.content }
    );
  }
  return base;
}

function channelMsgToChat(m: ChannelMessageInfo): ChatMsg {
  return {
    id: m.id,
    sender: m.senderType === 'human' ? 'user' : 'agent',
    text: m.text,
    time: new Date(m.createdAt).toLocaleTimeString(),
    agentName: m.senderType === 'agent' ? m.senderName : undefined,
  };
}

function agentInitials(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
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

// ─── Tool icon map (inline to avoid extra file) ────────────────────────────────
const TOOL_META: Record<string, { label: string; icon: string }> = {
  shell_execute: { label: 'Running command', icon: '⌨' },
  file_read:     { label: 'Reading file',    icon: '📄' },
  file_write:    { label: 'Writing file',    icon: '✏' },
  file_edit:     { label: 'Editing file',    icon: '✏' },
  file_list:     { label: 'Listing files',   icon: '📂' },
  web_fetch:     { label: 'Fetching page',   icon: '🌐' },
  web_search:    { label: 'Searching web',   icon: '🔍' },
  create_task:   { label: 'Creating task',   icon: '📌' },
  create_subtask: { label: 'Adding subtask', icon: '📌' },
  update_task:   { label: 'Updating task',   icon: '✅' },
  add_task_note: { label: 'Adding note',     icon: '📝' },
  git_status:    { label: 'Git status',      icon: '🔀' },
  git_diff:      { label: 'Git diff',        icon: '🔀' },
  git_log:       { label: 'Git log',         icon: '📜' },
  git_commit:    { label: 'Git commit',      icon: '💾' },
  code_search:   { label: 'Searching code',  icon: '🔍' },
  agent_send_message: { label: 'Messaging colleague', icon: '💬' },
};
function toolMeta(tool: string) {
  return TOOL_META[tool] ?? { label: tool.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), icon: '⚙' };
}

// ─── AgentMessageBody ──────────────────────────────────────────────────────────
// Renders an agent message with tool calls and text interleaved in chronological order.

function ToolSegmentRow({ seg, isLast }: { seg: Extract<MsgSegment, { type: 'tool' }>; isLast: boolean }) {
  const meta = toolMeta(seg.tool);
  return (
    <div className={`flex items-start gap-2 py-0.5 ${!isLast ? 'border-b border-gray-700/30 pb-1.5 mb-0.5' : ''}`}>
      <div className="flex flex-col items-center shrink-0 mt-0.5" style={{ width: 14 }}>
        <div className={`w-3 h-3 rounded-full border flex items-center justify-center text-[8px] shrink-0 ${
          seg.status === 'running' ? 'border-indigo-500 bg-indigo-950 animate-pulse' :
          seg.status === 'error'   ? 'border-red-600 bg-red-950 text-red-400' :
                                     'border-gray-600 bg-gray-800 text-gray-400'
        }`}>
          {seg.status === 'done' ? '✓' : seg.status === 'error' ? '✗' : ''}
        </div>
      </div>
      <div className={`flex items-center gap-1 text-xs leading-snug ${
        seg.status === 'running' ? 'text-indigo-300' :
        seg.status === 'error'   ? 'text-red-400 line-through opacity-50' :
                                   'text-gray-500'
      }`}>
        <span className="opacity-60">{meta.icon}</span>
        <span>{meta.label}{seg.status === 'running' ? '…' : ''}</span>
        {seg.status === 'running' && (
          <svg className="w-3 h-3 animate-spin ml-0.5 shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
      </div>
    </div>
  );
}

/** Pulsing dots — used for both initial "Thinking" and inter-step pauses */
function ThinkingDots({ label = 'Thinking' }: { label?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-400 py-0.5">
      <span>{label}</span>
      <span className="flex gap-0.5">
        {[0, 150, 300].map(d => (
          <span
            key={d}
            className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce"
            style={{ animationDelay: `${d}ms`, animationDuration: '1s' }}
          />
        ))}
      </span>
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

    return (
      <div className="space-y-0.5 min-h-[1em]">
        {/* Initial thinking — no segments yet */}
        {isEmpty && isStreaming && <ThinkingDots />}

        {segments.map((seg, i) => {
          const isLastSeg = i === segments.length - 1;
          if (seg.type === 'tool') {
            return <ToolSegmentRow key={seg.key} seg={seg} isLast={isLastSeg && !isWaiting} />;
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
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function Chat({ initialAgentId, authUser }: { initialAgentId?: string; authUser?: AuthUser } = {}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [humans, setHumans] = useState<HumanUserInfo[]>([]);

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

  // Session management (direct mode)
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const oldestMsgId = useRef<string | null>(null);

  // Group chats
  const [groupChats, setGroupChats] = useState<Array<{ id: string; name: string; type: string; channelKey: string; memberCount?: number }>>([]);

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
  useEffect(() => {
    const refreshAgents = () => api.agents.list().then(d => setAgents(d.agents)).catch(() => {});
    refreshAgents();
    api.users.list().then(d => setHumans(d.users)).catch(() => {});
    api.tasks.list().then(d => setTasks(d.tasks)).catch(() => {});
    fetch('/api/group-chats').then(r => r.json()).then((d: { chats: typeof groupChats }) => setGroupChats(d.chats)).catch(() => {});

    // Keep agent list in sync — poll every 8s and react to WS events
    const timer = setInterval(refreshAgents, 8000);
    const unsub = wsClient.on('agent:update', refreshAgents);
    const unsubGroup = wsClient.on('chat:group_created', () => {
      fetch('/api/group-chats').then(r => r.json()).then((d: { chats: typeof groupChats }) => setGroupChats(d.chats)).catch(() => {});
    });
    return () => { clearInterval(timer); unsub(); unsubGroup(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check for nav params (e.g., navigated here from AgentProfile)
  useEffect(() => {
    const handleNav = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      if (detail.page === 'chat' && detail.params?.agentId) {
        setChatMode('direct');
        setSelectedAgent(detail.params.agentId);
      }
    };
    // Also check localStorage on initial mount (in case Chat wasn't mounted when event fired)
    const navAgent = localStorage.getItem('markus_nav_agentId');
    if (navAgent) {
      localStorage.removeItem('markus_nav_agentId');
      setChatMode('direct');
      setSelectedAgent(navAgent);
    }
    window.addEventListener('markus:navigate', handleNav);
    return () => window.removeEventListener('markus:navigate', handleNav);
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
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (chatMode === 'direct' && !selectedAgent) return;

    // Capture the conversation key at send-time. All callbacks write to THIS key,
    // regardless of which conversation the user is currently viewing.
    const sendKey = makeConvKey(chatMode, selectedAgent, activeChannel, activeDmUserId);

    setInput('');
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
          time: new Date().toLocaleTimeString(), agentName: 'System',
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
          time: new Date().toLocaleTimeString(), agentName: 'System',
        }]);
      }
      sendingConvs.current.delete(sendKey);
      if (currentConvKeyRef.current === sendKey) setSending(false);
    } else {
      // direct or smart — build an interleaved segment stream
      const agentMsgId = `a_${Date.now()}`;
      updateConvMsgs(sendKey, prev => [
        ...prev,
        { id: `u_${Date.now()}`, sender: 'user', text, time: new Date().toLocaleTimeString() },
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
          const newSegs: MsgSegment[] = last?.type === 'text'
            ? [...segs.slice(0, -1), { type: 'text', content: last.content + chunk }]
            : [...segs, { type: 'text', content: chunk }];
          u[idx] = { ...u[idx]!, text: u[idx]!.text + chunk, segments: newSegs };
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
            u[idx] = { ...u[idx]!, segments: [...segs, { type: 'tool', key: toolKey, tool: event.tool, status: 'running' }] };
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
                segs[i] = { ...s, status: event.success === false ? 'error' : 'done' };
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
            { senderId: authUser?.id || undefined, signal: abortCtrl.signal },
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
              u[idx] = { ...u[idx]!, text: errText,
                segments: [...segs, { type: 'text', content: errText }] };
            }
            return u;
          });
        } else {
          // User cancelled — remove the empty agent bubble
          updateConvMsgs(sendKey, prev => prev.filter(m => m.id !== agentMsgId));
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

      // Fallback: if the agent message is empty (SSE connection may have dropped),
      // poll the latest session messages to recover the persisted reply.
      const currentMsgs = msgBuffers.current.get(sendKey) ?? [];
      const agentMsg = currentMsgs.find(m => m.id === agentMsgId);
      if (agentMsg && !agentMsg.text && chatMode === 'direct' && selectedAgent) {
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
    chatMode === 'channel' ? (activeGroupChat ? `👥 ${activeGroupChat.name}` : activeChannel) :
    chatMode === 'direct'  ? (currentAgent?.name ?? 'Select Agent') :
    chatMode === 'dm'      ? (isSelfDm ? '📝 My Notes' : `💬 ${activeDmUser?.name ?? 'Direct Message'}`) :
    'Chat';

  const placeholder =
    chatMode === 'channel' ? (activeGroupChat ? `Message ${activeGroupChat.name}…` : `Message ${activeChannel}… (use @name to mention)`) :
    chatMode === 'dm'      ? (isSelfDm ? 'Write a note to yourself…' : `Message ${activeDmUser?.name ?? ''}…`) :
    selectedAgent ? 'Type a message…' : 'Select an agent to start chatting';

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 overflow-hidden flex">
      {/* ── Left sidebar ── */}
      <div className="w-52 bg-gray-900/60 border-r border-gray-800 flex flex-col shrink-0">

        {/* Group Chats */}
        {groupChats.length > 0 && (
          <div className="px-3 py-2 border-b border-gray-800">
            <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-1.5">Group Chats</p>
            {groupChats.map(gc => (
              <button
                key={gc.id}
                onClick={() => { setChatMode('channel'); setActiveChannel(gc.channelKey); }}
                className={`w-full text-left px-3 py-1.5 rounded-lg text-xs mb-0.5 transition-colors flex items-center gap-2 ${
                  chatMode === 'channel' && activeChannel === gc.channelKey
                    ? 'bg-indigo-600/20 text-indigo-300'
                    : 'text-gray-400 hover:bg-gray-800'
                }`}
              >
                <span className="text-[10px]">{gc.type === 'team' ? '👥' : '💬'}</span>
                <span className="truncate flex-1">{gc.name}</span>
                {gc.memberCount !== undefined && gc.memberCount > 0 && (
                  <span className="text-[9px] text-gray-600 shrink-0">{gc.memberCount}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Agents (Direct) */}
        <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col">
          <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-2">Direct</p>
          {agents.length === 0 && (
            <p className="text-xs text-gray-600 px-1 mb-2">No agents yet</p>
          )}
          {agents.map(a => (
            <button
              key={a.id}
              onClick={() => { setChatMode('direct'); setSelectedAgent(a.id); }}
              className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-xs mb-0.5 transition-colors ${
                chatMode === 'direct' && selectedAgent === a.id
                  ? 'bg-indigo-600/20 text-indigo-300'
                  : 'text-gray-400 hover:bg-gray-800'
              }`}
            >
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                chatMode === 'direct' && selectedAgent === a.id ? 'bg-indigo-600' : 'bg-gray-700'
              }`}>
                {agentInitials(a.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="truncate">{a.name}</div>
                <div className="text-gray-600 truncate">{a.role}</div>
              </div>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                a.status === 'idle' ? 'bg-green-500' : a.status === 'working' ? 'bg-yellow-500' : 'bg-gray-600'
              }`} />
            </button>
          ))}

          {/* People — human-to-human DMs + personal notepad */}
          <div className="mt-3 pt-2 border-t border-gray-800/60">
            <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-2">People</p>

            {/* Self / Notes */}
            {authUser && (
              <button
                onClick={() => { setChatMode('dm'); setActiveDmUserId(authUser.id); }}
                className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-xs mb-0.5 transition-colors ${
                  chatMode === 'dm' && (activeDmUserId === authUser.id || !activeDmUserId)
                    ? 'bg-indigo-600/20 text-indigo-300'
                    : 'text-gray-400 hover:bg-gray-800'
                }`}
              >
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                  chatMode === 'dm' && (activeDmUserId === authUser.id || !activeDmUserId) ? 'bg-indigo-600' : 'bg-indigo-900'
                }`}>
                  {authUser.name[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="truncate">{authUser.name}</div>
                  <div className="text-gray-600 truncate">My Notes</div>
                </div>
                <span className="text-[9px] text-gray-600">📝</span>
              </button>
            )}

            {/* Other humans */}
            {humans.filter(h => h.id !== authUser?.id).map(h => (
              <button
                key={h.id}
                onClick={() => { setChatMode('dm'); setActiveDmUserId(h.id); }}
                className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-xs mb-0.5 transition-colors ${
                  chatMode === 'dm' && activeDmUserId === h.id
                    ? 'bg-emerald-900/30 text-emerald-300'
                    : 'text-gray-400 hover:bg-gray-800'
                }`}
              >
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                  chatMode === 'dm' && activeDmUserId === h.id ? 'bg-emerald-600' : 'bg-emerald-900/60'
                }`}>
                  {h.name[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="truncate">{h.name}</div>
                  <div className="text-gray-600 truncate">{h.email || h.role}</div>
                </div>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Session history sidebar (direct mode) ── */}
      {chatMode === 'direct' && selectedAgent && showSessions && (
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

      {/* ── Main chat area ── */}
      <div className="flex-1 overflow-hidden flex flex-col min-w-0">
        {/* Header */}
        <div className="h-12 border-b border-gray-800 bg-gray-900 flex items-center px-5 gap-3 shrink-0">
          <span className="font-semibold text-sm">{modeTitle}</span>
          {(chatMode === 'channel' || chatMode === 'dm') && (
            <span className="text-xs text-gray-500">{messages.length} messages</span>
          )}
          {chatMode === 'dm' && (
            <span className="text-xs text-gray-600 ml-1">
              {isSelfDm ? '· Private notepad' : `· Direct message with ${activeDmUser?.name ?? ''}`}
            </span>
          )}
          {chatMode === 'direct' && currentAgent && (
            <>
              <AgentStatusBadge agent={currentAgent} tasks={tasks} />

              <button
                onClick={() => setShowSessions(!showSessions)}
                className="ml-auto text-xs text-gray-500 hover:text-gray-300 px-2 py-0.5 rounded hover:bg-gray-800 transition-colors"
              >
                ⏱ History
              </button>
            </>
          )}
          {chatMode === 'smart' && (
            <span className="text-xs text-gray-500"></span>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
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
              <div className="text-4xl opacity-20">
                {chatMode === 'channel' ? '✉' : '💬'}
              </div>
              {chatMode === 'channel' && <div>No messages in {activeGroupChat?.name ?? activeChannel} yet.</div>}
              {chatMode === 'direct' && !selectedAgent && <div>Select an agent from the sidebar to start.</div>}
              {chatMode === 'direct' && selectedAgent && <div>Start a new conversation with {currentAgent?.name}.</div>}
            </div>
          )}

          {chatMode === 'channel'
            ? messages.map(msg => (
                <div key={msg.id} className="flex gap-3">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                    msg.sender === 'user' ? 'bg-indigo-600' : 'bg-gray-700'
                  }`}>
                    {msg.sender === 'user' ? (currentUserName?.[0] ?? 'Y') : (msg.agentName?.[0] ?? 'A')}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-white">
                        {msg.sender === 'user' ? (currentUserName ?? 'You') : msg.agentName ?? 'Agent'}
                      </span>
                      <span className="text-xs text-gray-600">{msg.time}</span>
                    </div>
                    {msg.sender === 'agent'
                      ? <MarkdownMessage content={msg.text} className="text-sm text-gray-300 mt-0.5" />
                      : <div className="text-sm text-gray-300 mt-0.5 whitespace-pre-wrap">{msg.text}</div>
                    }
                  </div>
                </div>
              ))
            : messages.map((msg, i) => {
                const isPending = isLastPending && i === messages.length - 1;
                const isStreamingMsg = isPending && sending;
                return (
                  <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className="max-w-[75%]">
                      <div className="text-xs text-gray-500 mb-1">
                        {msg.sender === 'user'
                          ? (currentUserName ?? 'You')
                          : (msg.agentName ?? (chatMode === 'direct' ? currentAgent?.name ?? 'Agent' : 'Agent'))
                        } · {msg.time}
                      </div>
                      <div className={`px-4 py-3 rounded-2xl text-sm ${
                        msg.sender === 'user'
                          ? 'bg-indigo-600 text-white rounded-br-sm'
                          : 'bg-gray-800 text-gray-200 rounded-bl-sm'
                      }`}>
                        {msg.sender === 'user'
                          ? <span className="whitespace-pre-wrap leading-relaxed">{msg.text}</span>
                          : <AgentMessageBody
                              msg={msg}
                              isStreaming={isStreamingMsg}
                              liveActivities={isStreamingMsg ? activities : []}
                            />
                        }
                      </div>
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

        {/* Input */}
        <div className="p-4 border-t border-gray-800 bg-gray-900 relative shrink-0">
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
          <div className="flex gap-2">
            <input
              value={input}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
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
                disabled={(chatMode === 'direct' && !selectedAgent) || !input.trim()}
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

function AgentStatusBadge({ agent, tasks }: { agent: AgentInfo; tasks: TaskInfo[] }) {
  const [hover, setHover] = useState(false);
  const isWorking = agent.status === 'working';
  const isError = agent.status === 'error';
  const currentTask = isWorking ? tasks.find(t => t.assignedAgentId === agent.id && t.status === 'in_progress') : null;

  const dotColor = isError ? 'bg-red-400' : isWorking ? 'bg-yellow-400 animate-pulse' : 'bg-green-400';
  const label = isError ? 'error' : isWorking ? 'busy' : 'idle';

  return (
    <div className="relative" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full ${isWorking ? 'bg-yellow-500/10 border border-yellow-500/20' : isError ? 'bg-red-500/10 border border-red-500/20' : 'bg-green-500/10 border border-green-500/20'} cursor-default`}>
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span className={`text-xs ${isError ? 'text-red-400' : isWorking ? 'text-yellow-400' : 'text-green-400'}`}>{label}</span>
      </div>
      {hover && isWorking && (
        <div className="absolute top-full left-0 mt-1.5 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-30 w-72 p-3">
          <p className="text-[10px] text-gray-500 uppercase font-semibold mb-2">Current Activity</p>
          {currentTask ? (
            <div
              className="flex items-center gap-2 p-2 rounded-lg bg-indigo-900/20 border border-indigo-700/30 cursor-pointer hover:bg-indigo-900/30 transition-colors"
              onClick={() => navBus.navigate('tasks', { openTask: currentTask.id })}
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
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-300">Processing...</div>
                <div className="text-[10px] text-gray-500">Agent is thinking or communicating</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
