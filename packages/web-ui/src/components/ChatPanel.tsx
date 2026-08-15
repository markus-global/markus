import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api, wsClient,
  type AgentInfo, type AgentToolEvent, type StreamCommitEvent,
  type AuthUser,
} from '../api.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';
import {
  AgentMessageBody, MessageActions, RememberModal, friendlyAgentError,
} from '../pages/ChatComponents.tsx';
import { Avatar } from './Avatar.tsx';
import { ChatInput, type ContextChip, type MentionItem, type MentionChip, type SlashCommand, type PendingFile } from './ChatInput.tsx';
import { ChatModelMenu, applyChatModelSelection, type ChatModelSelection } from './ChatModelMenu.tsx';
import {
  type MsgSegment, type ChatMsg,
  dbMsgToChat, stripNotifyContext, insertChatMsgByCreatedAt, storedSegmentsToMsgSegments,
  appendLiveOutput, appendSubagentLog,
  formatSmartTime, getDateKey, formatDateLabel,
} from '../pages/ChatHelpers.ts';
import type { ActivityStep } from './ActivityIndicator.tsx';
import { createAgentChatStore, type AgentChatStore } from '../hooks/agentChatStore.ts';

export interface ChatPanelProps {
  agentId: string;
  sessionId?: string | null;
  agents: AgentInfo[];
  authUser?: AuthUser;
  onClose?: () => void;
  contextChips?: ContextChip[];
  /** Extra mention items to include (e.g. from parent that already loaded data) */
  extraMentionItems?: MentionItem[];
  width?: number;
  className?: string;
  /** 外部 textarea ref（供父级在打开右侧栏时自动聚焦输入框）。 */
  textareaRef?: React.Ref<HTMLTextAreaElement | null>;
}

/** 附着文件限制 —— 与 Team 页 composer 保持一致。 */
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

/**
 * 单 agent 主会话缓冲区：所有聊天状态按 agentId 隔离存放，避免 L1 切换时
 * 多 agent 并行流式输出互相污染（对齐 Team.tsx 的隔离+重连思路，但只落在
 * ChatPanel，不搬 Team 逻辑）。
 */
interface AgentBuffer {
  messages: ChatMsg[];
  sessionId: string | null;
  sending: boolean;
  input: string;
  mentionChips: MentionChip[];
  activities: ActivityStep[];
  files: PendingFile[];
  loaded: boolean;
  modelOverride: ChatModelSelection | null;
}

function makeBlankBuffer(initialSessionId?: string | null): AgentBuffer {
  return {
    messages: [],
    sessionId: initialSessionId ?? null,
    sending: false,
    input: '',
    mentionChips: [],
    activities: [],
    files: [],
    loaded: false,
    modelOverride: null,
  };
}

function isImageFile(f: { name: string; dataUrl: string }) {
  return f.dataUrl.startsWith('data:image/');
}

function getFileIcon(name: string, dataUrl: string) {
  if (isImageFile({ name, dataUrl })) return null;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const iconMap: Record<string, string> = {
    pdf: '📄', docx: '📝', doc: '📝', xlsx: '📊', xls: '📊',
    pptx: '📎', csv: '📊', json: '🔧', xml: '🔧', html: '🌐', epub: '📚',
  };
  return iconMap[ext] ?? '📁';
}

export function ChatPanel({
  agentId,
  sessionId: initialSessionId,
  agents,
  authUser,
  onClose,
  contextChips,
  extraMentionItems,
  width,
  className = '',
  textareaRef: externalTextareaRef,
}: ChatPanelProps) {
  const { t } = useTranslation(['team', 'common']);
  const agent = agents.find(a => a.id === agentId);
  const agentName = agent?.name ?? t('page.fallbackAgent');
  const userName = authUser?.name ?? t('page.fallbackYou');

  // ── 按 agent 隔离的状态容器 ──────────────────────────────────────────────
  const storeRef = useRef<AgentChatStore<AgentBuffer>>(
    createAgentChatStore<AgentBuffer>(() => makeBlankBuffer(initialSessionId)),
  );
  const activeAgentIdRef = useRef(agentId);
  activeAgentIdRef.current = agentId;
  /** send() 的实时流 AbortController，按 agent 隔离。 */
  const sendAbortRefs = useRef<Map<string, AbortController>>(new Map());
  /** reattachStream 的 AbortController，按 agent 隔离。 */
  const reattachAbortRefs = useRef<Map<string, AbortController>>(new Map());

  // ── 当前可见 agent 的渲染层镜像 ────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState('');
  const [activities, setActivities] = useState<ActivityStep[]>([]);
  const [currentMentionChips, setCurrentMentionChips] = useState<MentionChip[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [sessionModelOverride, setSessionModelOverride] = useState<ChatModelSelection | null>(null);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const userAtBottomRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dateLabels = useMemo(() => ({
    today: t('page.dateToday'),
    yesterday: t('page.dateYesterday'),
  }), [t]);

  const greeting = useMemo(() => {
    const list = t('page.chatGreetings', { returnObjects: true });
    if (Array.isArray(list) && list.length > 0) return list[Math.floor(Math.random() * list.length)];
    return '';
  }, [t]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  /** 把某 agent 的 store 状态同步到渲染层（仅当它是当前可见 agent）。 */
  const syncToDisplay = useCallback((aid: string) => {
    const st = storeRef.current.get(aid);
    if (!st || aid !== activeAgentIdRef.current) return;
    setMessages(st.messages);
    setSessionId(st.sessionId);
    setSending(st.sending);
    setInput(st.input);
    setCurrentMentionChips(st.mentionChips);
    setActivities(st.activities);
    setPendingFiles(st.files);
    setSessionModelOverride(st.modelOverride);
  }, []);

  /** 更新某 agent 的一个字段；命中当前可见 agent 时同步渲染层。 */
  const updateAgent = useCallback(<K extends keyof AgentBuffer>(
    aid: string,
    field: K,
    updater: AgentBuffer[K] | ((prev: AgentBuffer[K]) => AgentBuffer[K]),
  ) => {
    storeRef.current.updateField(aid, field, updater);
    syncToDisplay(aid);
  }, [syncToDisplay]);

  // 流式解析回调：写回目标 agent 的 store，背景 agent 也能继续消费。
  const appendTextChunk = useCallback((
    aid: string, agentMsgId: string, insideThinkRef: { current: boolean }, chunk: string,
  ) => {
    updateAgent(aid, 'messages', prev => {
      const u = [...prev];
      const idx = u.findIndex(m => m.id === agentMsgId);
      if (idx < 0) return prev;
      const segs = u[idx]!.segments ?? [];
      const last = segs[segs.length - 1];
      const prevThinking = last?.type === 'text' ? (last as { thinking?: string }).thinking ?? '' : '';

      let thinking = '';
      let content = '';
      let remaining = chunk;

      while (remaining.length > 0) {
        if (insideThinkRef.current) {
          const closeIdx = remaining.indexOf(' response');
          if (closeIdx >= 0) { thinking += remaining.slice(0, closeIdx); remaining = remaining.slice(closeIdx + ' response'.length); insideThinkRef.current = false; }
          else { thinking += remaining; remaining = ''; }
        } else {
          const openIdx = remaining.indexOf(' thinking');
          if (openIdx >= 0) { content += remaining.slice(0, openIdx); remaining = remaining.slice(openIdx + ' thinking'.length); insideThinkRef.current = true; }
          else { content += remaining; remaining = ''; }
        }
      }

      const mergedThinking = (prevThinking + thinking) || undefined;
      const newSegs: MsgSegment[] = last?.type === 'text'
        ? [...segs.slice(0, -1), { type: 'text', content: last.content + content, thinking: mergedThinking, createdAt: last.createdAt }]
        : [...segs, { type: 'text', content, thinking: mergedThinking, createdAt: new Date().toISOString() }];
      u[idx] = { ...u[idx]!, text: u[idx]!.text + content, segments: newSegs };
      return u;
    });
  }, [updateAgent]);

  const handleCommitEvent = useCallback((aid: string, agentMsgId: string, event: StreamCommitEvent) => {
    if (event.type === 'session_start' && event.sessionId) {
      updateAgent(aid, 'sessionId', event.sessionId);
      return;
    }
    updateAgent(aid, 'messages', prev => {
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
  }, [updateAgent]);

  const handleToolEvent = useCallback((aid: string, agentMsgId: string, event: AgentToolEvent) => {
    if (event.phase === 'heartbeat') return;
    if (event.phase === 'start') {
      updateAgent(aid, 'activities', prev => [...prev, { ...event, phase: 'start', ts: Date.now() }]);
      updateAgent(aid, 'messages', prev => {
        const u = [...prev];
        const idx = u.findIndex(m => m.id === agentMsgId);
        if (idx < 0) return prev;
        const segs = [...(u[idx]!.segments ?? [])];
        const toolKey = `${event.tool}_${Date.now()}`;
        const now = new Date().toISOString();
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
          segs.push({ type: 'tool', key: toolKey, tool: event.tool, status: 'running', args: event.arguments, createdAt: now });
        }
        const committed = [...(u[idx]!.committedSegments ?? [])];
        if (event.arguments !== undefined) {
          committed.push({ type: 'tool', key: toolKey, tool: event.tool, status: 'running', args: event.arguments, createdAt: now });
        }
        u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed };
        return u;
      });
    } else if (event.phase === 'output') {
      updateAgent(aid, 'messages', prev => {
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
      });
    } else if (event.phase === 'subagent_progress' && event.subagentEvent) {
      updateAgent(aid, 'messages', prev => {
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
        u[idx] = {
          ...u[idx]!,
          segments: appendLog(u[idx]!.segments ?? []),
          committedSegments: appendLog(u[idx]!.committedSegments ?? []),
        };
        return u;
      });
    } else if (event.phase === 'end') {
      updateAgent(aid, 'activities', prev => [...prev, { ...event, phase: 'end', ts: Date.now() }]);
      updateAgent(aid, 'messages', prev => {
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
      });
    }
  }, [updateAgent]);

  // ── 加载（或恢复）当前 agent 的主会话 ──────────────────────────────────
  useEffect(() => {
    activeAgentIdRef.current = agentId;
    // 离开旧 agent：中止其 reattach（send 流保持后台续跑，不中断）
    reattachAbortRefs.current.forEach((ctrl, aid) => {
      if (aid !== agentId) { ctrl.abort(); reattachAbortRefs.current.delete(aid); }
    });

    const aid = agentId;
    if (storeRef.current.has(aid)) {
      setLoading(false);
      syncToDisplay(aid);
      const st = storeRef.current.get(aid)!;
      // 切回有进行中输出的 agent：若没有本地实时流则 reattach 续接
      if (st.sending && st.sessionId) {
        const liveSend = sendAbortRefs.current.get(aid);
        if (!liveSend || liveSend.signal.aborted) {
          void tryReattach(aid, st.sessionId);
        }
      }
      return;
    }

    // 首次进入该 agent：建空白缓冲 + 拉取主会话
    storeRef.current.getOrCreate(aid);
    setLoading(true);
    syncToDisplay(aid);
    let cancelled = false;
    const load = async () => {
      try {
        let sid = initialSessionId ?? null;
        if (!sid) {
          const { sessions } = await api.sessions.listByAgent(aid, 10);
          const main = sessions.find(s => s.isMain);
          sid = main?.id ?? sessions[0]?.id ?? null;
        }
        if (cancelled) return;
        storeRef.current.updateField(aid, 'sessionId', sid);
        if (sid) {
          const result = await api.sessions.getMessages(sid, 50);
          if (cancelled) return;
          const msgs = result.messages.map(dbMsgToChat).filter(m =>
            m.sender !== 'agent' || m.text || (m.segments && m.segments.length > 0)
          );
          storeRef.current.updateField(aid, 'messages', msgs);
          storeRef.current.updateField(aid, 'loaded', true);
        }
        if (activeAgentIdRef.current === aid) { setLoading(false); syncToDisplay(aid); }
      } catch {
        if (activeAgentIdRef.current === aid) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, initialSessionId]);

  // 加载已安装技能用于 slash 命令
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { skills } = await api.skills.list();
        if (cancelled) return;
        const skillCmds: SlashCommand[] = skills.map(s => ({
          id: `skill:${s.name}`,
          name: s.name,
          description: s.description ?? s.name,
          type: 'skill' as const,
          icon: '🔧',
        }));
        setSlashCommands(skillCmds);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── reattach：切回有进行中输出的 agent 时续接 ──────────────────────────
  const tryReattach = useCallback(async (aid: string, sessionId: string) => {
    if (!aid || !sessionId) return;
    // 本地实时 send 仍持有该 SSE，无需重复 attach
    const liveSend = sendAbortRefs.current.get(aid);
    if (liveSend && !liveSend.signal.aborted) {
      updateAgent(aid, 'sending', true);
      return;
    }
    let abortCtrl: AbortController | null = null;
    try {
      const status = await api.sessions.streamStatus(aid, sessionId);
      if (status.status !== 'streaming') {
        updateAgent(aid, 'sending', false);
        return;
      }
      const msgs = storeRef.current.get(aid)?.messages ?? [];
      const last = [...msgs].reverse().find(m => m.sender === 'agent');
      let agentMsgId = last?.id;
      if (!last) {
        agentMsgId = `reattach_${Date.now()}`;
        updateAgent(aid, 'messages', prev => [
          ...prev,
          { id: agentMsgId!, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), segments: [] },
        ]);
      }
      const insideThinkRef = { current: false };
      abortCtrl = new AbortController();
      reattachAbortRefs.current.get(aid)?.abort();
      reattachAbortRefs.current.set(aid, abortCtrl);
      updateAgent(aid, 'sending', true);

      const result = await api.sessions.reattachStream(
        aid, sessionId,
        {
          onChunk: (chunk) => appendTextChunk(aid, agentMsgId!, insideThinkRef, chunk),
          onActivity: (event) => handleToolEvent(aid, agentMsgId!, event),
          onCommit: (event) => handleCommitEvent(aid, agentMsgId!, event),
          onSnapshot: (snap) => {
            const cur = storeRef.current.get(aid)?.messages ?? [];
            const target = cur.find(m => m.id === agentMsgId);
            const segs = storedSegmentsToMsgSegments(snap.segments, target?.segments);
            updateAgent(aid, 'messages', prev => prev.map(m =>
              m.id === agentMsgId
                ? { ...m, text: snap.content || m.text, segments: segs, committedSegments: segs }
                : m,
            ));
          },
        },
        abortCtrl.signal,
        0,
      );

      if (result.attached) {
        if (result.segments?.length) {
          updateAgent(aid, 'messages', prev => prev.map(m => {
            if (m.id !== agentMsgId) return m;
            const finalSegs = storedSegmentsToMsgSegments(result.segments!, m.segments);
            return { ...m, text: result.content || m.text, segments: finalSegs, committedSegments: finalSegs };
          }));
        } else if (result.content) {
          updateAgent(aid, 'messages', prev => prev.map(m =>
            m.id === agentMsgId ? { ...m, text: result.content || m.text } : m,
          ));
        }
      }
      updateAgent(aid, 'sending', false);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      updateAgent(aid, 'sending', false);
    } finally {
      reattachAbortRefs.current.delete(aid);
    }
  }, [appendTextChunk, handleToolEvent, handleCommitEvent, updateAgent]);

  // ── 滚动 ────────────────────────────────────────────────────────────────
  const prevLoadingRef = useRef(true);
  useEffect(() => {
    if (prevLoadingRef.current && !loading && messages.length > 0) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToBottom());
      });
    }
    prevLoadingRef.current = loading;
  }, [loading, messages.length, scrollToBottom]);

  useEffect(() => {
    if (!loading && userAtBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom());
    }
  }, [messages, scrollToBottom, loading]);

  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const handleScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    userAtBottomRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  }, []);

  // WS: listen for proactive messages from this agent (incl. Feishu user turns)
  useEffect(() => {
    const unsub = wsClient.on('chat:proactive_message', (event) => {
      const aid = activeAgentIdRef.current;
      const p = event.payload;
      const msgAgentId = (p['agentId'] as string) ?? '';
      if (msgAgentId !== agentId) return;
      const targetUserId = p['targetUserId'] as string | undefined;
      if (targetUserId && targetUserId !== authUser?.id) return;
      const message = (p['message'] as string) ?? '';
      const msgSessionId = (p['sessionId'] as string) ?? '';
      const messageId = (p['messageId'] as string) ?? '';
      if (!message || (message === '[cancelled]') || (message === '[Stream cancelled]')) return;

      const curSession = storeRef.current.get(aid)?.sessionId ?? null;
      if (msgSessionId && curSession && msgSessionId !== curSession) return;

      const meta = (p['metadata'] as Record<string, unknown>) ?? {};
      const isUserTurn = meta.role === 'user';
      const { cleaned: displayMessage, priority: parsedPriority } = stripNotifyContext(message);
      const isNotify = !isUserTurn && (!!meta.notifyUser || displayMessage !== message);
      const fallbackUserText = typeof meta.userText === 'string' ? meta.userText : '';
      const fallbackUserId = typeof meta.userMessageId === 'string' ? meta.userMessageId : '';
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
              agentName: (p['agentName'] as string) ?? agentName,
              agentId: msgAgentId,
              ...(isNotify ? { isNotification: true, notifyPriority: (meta.priority as string) ?? parsedPriority } : {}),
            }),
      };
      updateAgent(aid, 'messages', prev => {
        if (prev.some(m => m.id === newMsg.id)) return prev;
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
              time: displayTime,
              rawCreatedAt: createdAt,
            });
          }
        }
        return insertChatMsgByCreatedAt(base, newMsg);
      });
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, agentName, authUser?.id, updateAgent]);

  // stop 仅中止当前可见 agent 的流（send + reattach 都停）
  const stopSending = useCallback(() => {
    const aid = activeAgentIdRef.current;
    sendAbortRefs.current.get(aid)?.abort();
    sendAbortRefs.current.delete(aid);
    reattachAbortRefs.current.get(aid)?.abort();
    reattachAbortRefs.current.delete(aid);
    updateAgent(aid, 'sending', false);
    updateAgent(aid, 'activities', []);
    void api.agents.cancelProcessing(aid).catch(() => {});
  }, [updateAgent]);

  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [rememberTarget, setRememberTarget] = useState<ChatMsg | null>(null);
  const [rememberBusy, setRememberBusy] = useState(false);

  const send = useCallback(async (overrideText?: string, sessionIdOverride?: string | null) => {
    const aid = activeAgentIdRef.current;
    const store = storeRef.current;
    const st = store.get(aid);
    const stateInput = st?.input ?? input;
    const stateChips = st?.mentionChips ?? currentMentionChips;
    const stateFiles = st?.files ?? pendingFiles;
    const stateSession = st?.sessionId ?? sessionId;
    const stateModel = st?.modelOverride ?? sessionModelOverride;

    let text = overrideText?.trim() ?? '';
    if (!text) {
      const parts: string[] = [];

      if (stateChips.length > 0) {
        parts.push(stateChips.map(c => `@[${c.name}](${c.entityType}:${c.entityId})`).join(' '));
      }

      if (contextChips?.length) {
        for (const chip of contextChips) {
          parts.push(`[${chip.type}: ${chip.label}]\n${chip.content}`);
        }
      }

      if (stateInput.trim()) parts.push(stateInput.trim());
      text = parts.join('\n\n');
    }
    if (!text && stateFiles.length === 0) return;

    if (!overrideText) {
      updateAgent(aid, 'input', '');
      updateAgent(aid, 'mentionChips', []);
      updateAgent(aid, 'files', []);
    }
    userAtBottomRef.current = true;
    updateAgent(aid, 'sending', true);
    updateAgent(aid, 'activities', []);

    const streamSessionId = sessionIdOverride !== undefined ? sessionIdOverride : stateSession;
    const agentMsgId = `a_${Date.now()}`;
    const agentCreatedAt = new Date().toISOString();
    const userMsg: ChatMsg = { id: `u_${Date.now()}`, sender: 'user', text, time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt };

    updateAgent(aid, 'messages', prev => [
      ...prev,
      userMsg,
      { id: agentMsgId, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt, segments: [] },
    ]);

    const insideThinkRef = { current: false };

    const abortCtrl = new AbortController();
    sendAbortRefs.current.set(aid, abortCtrl);

    const imagesToSend = stateFiles.length > 0 ? stateFiles.map(f => f.dataUrl) : undefined;
    const fileNamesToSend = stateFiles.length > 0 ? stateFiles.map(f => f.name) : undefined;

    try {
      const streamResult = await api.agents.messageStream(
        aid, text,
        (chunk) => appendTextChunk(aid, agentMsgId, insideThinkRef, chunk),
        (event) => handleToolEvent(aid, agentMsgId, event),
        abortCtrl.signal,
        imagesToSend,
        streamSessionId,
        undefined,
        undefined,
        (event) => handleCommitEvent(aid, agentMsgId, event),
        fileNamesToSend,
        undefined,
        stateModel,
      );

      if (streamResult.merged) {
        updateAgent(aid, 'messages', prev => prev.filter(m => m.id !== agentMsgId));
      }

      if (!streamResult.merged && streamResult.segments?.length) {
        updateAgent(aid, 'messages', prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx < 0) return prev;
          const finalSegs: MsgSegment[] = storedSegmentsToMsgSegments(streamResult.segments!, u[idx]!.segments);
          let finalText = streamResult.content || u[idx]!.text;
          if (!finalText) {
            finalText = finalSegs.filter(s => s.type === 'text').map(s => (s as { content: string }).content).join('');
          }
          u[idx] = { ...u[idx]!, text: finalText, segments: finalSegs, committedSegments: finalSegs };
          return u;
        });
      }

      if (!streamResult.merged && !streamResult.segments?.length) {
        updateAgent(aid, 'messages', prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx < 0) return prev;
          const msg = u[idx]!;
          const committed = msg.committedSegments ?? [];
          const committedText = committed.filter((s): s is MsgSegment & { type: 'text' } => s.type === 'text' && !!s.content).map(s => s.content).join('');
          const finalText = committedText || streamResult.content || msg.text;
          if (committed.length > 0 || finalText) {
            u[idx] = { ...msg, text: finalText, segments: committed.length > 0 ? committed : msg.segments };
          }
          return u;
        });
      }

      if (streamResult.sessionId) {
        updateAgent(aid, 'sessionId', streamResult.sessionId);
      }
    } catch (e) {
      const errSessionId = (e as Error & { sessionId?: string })?.sessionId;
      if (errSessionId) updateAgent(aid, 'sessionId', errSessionId);

      const errText = friendlyAgentError(e, t);
      if (errText) {
        updateAgent(aid, 'messages', prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx >= 0) {
            const segs = u[idx]!.segments ?? [];
            u[idx] = { ...u[idx]!, text: errText, isError: true, segments: [...segs, { type: 'text', content: errText }] };
          }
          return u;
        });
      } else {
        updateAgent(aid, 'messages', prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx >= 0) {
            const msg = u[idx]!;
            const hasContent = msg.text || (msg.segments && msg.segments.length > 0 && msg.segments.some(s =>
              (s.type === 'text' && ((s as { content: string }).content || (s as { thinking?: string }).thinking)) || s.type === 'tool'
            ));
            if (!hasContent) return prev.filter(m => m.id !== agentMsgId);
            u[idx] = { ...msg, isStopped: true };
          }
          return u;
        });
      }
    }

    // Mark running tools as stopped
    updateAgent(aid, 'messages', prev => {
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

    updateAgent(aid, 'sending', false);
    updateAgent(aid, 'activities', []);
    sendAbortRefs.current.delete(aid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, sessionId, currentMentionChips, pendingFiles, sessionModelOverride, contextChips, t, appendTextChunk, handleToolEvent, handleCommitEvent, updateAgent]);

  const handleInputChange = useCallback((v: string) => {
    updateAgent(activeAgentIdRef.current, 'input', v);
  }, [updateAgent]);

  const handleMentionChipsChange = useCallback((chips: MentionChip[]) => {
    updateAgent(activeAgentIdRef.current, 'mentionChips', chips);
  }, [updateAgent]);

  const handleCopy = useCallback((msg: ChatMsg) => {
    void navigator.clipboard.writeText(msg.text || '').then(() => {
      setCopiedMsgId(msg.id);
      setTimeout(() => setCopiedMsgId(prev => (prev === msg.id ? null : prev)), 1500);
    });
  }, []);

  const handleRememberConfirm = async (userNote: string) => {
    const aid = activeAgentIdRef.current;
    const curSession = storeRef.current.get(aid)?.sessionId ?? null;
    if (!rememberTarget || !curSession) return;
    setRememberBusy(true);
    try {
      const result = await api.agents.evolveFromMessage(aid, {
        parentSessionId: curSession,
        sourceMessageId: rememberTarget.id.startsWith('a_') || rememberTarget.id.startsWith('u_')
          ? undefined
          : rememberTarget.id,
        sourceText: (rememberTarget.text || '').slice(0, 500) || undefined,
        userNote: userNote.trim() || undefined,
      });
      setRememberTarget(null);
      updateAgent(aid, 'sessionId', result.sessionId);
      updateAgent(aid, 'messages', []);
      await send(result.seedPrompt, result.sessionId);
    } catch (err) {
      console.error('evolve-from-message failed', err);
    } finally {
      setRememberBusy(false);
    }
  };

  // 附件处理（与 Team composer 一致）
  const isFileSupported = useCallback((f: File) => {
    return f.type.startsWith('image/') || SUPPORTED_DOC_TYPES.has(f.type);
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    const aid = activeAgentIdRef.current;
    const fileArr = Array.from(files).filter(isFileSupported);
    if (fileArr.length === 0) return;
    for (const file of fileArr) {
      if (file.size > MAX_FILE_SIZE) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        updateAgent(aid, 'files', prev => {
          if (prev.length >= MAX_FILES) return prev;
          if (prev.some(f => f.dataUrl === dataUrl)) return prev;
          return [...prev, { id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, dataUrl, name: file.name }];
        });
      };
      reader.readAsDataURL(file);
    }
  }, [isFileSupported, updateAgent]);

  const removeFile = useCallback((id: string) => {
    updateAgent(activeAgentIdRef.current, 'files', prev => prev.filter(f => f.id !== id));
  }, [updateAgent]);

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

  // 模型切换：记忆到当前 agent 缓冲 + 持久化到会话 override（可应用全局）
  const handleModelSelect = useCallback((sel: ChatModelSelection, applyToGlobal: boolean) => {
    const aid = activeAgentIdRef.current;
    const curSession = storeRef.current.get(aid)?.sessionId ?? null;
    updateAgent(aid, 'modelOverride', sel);
    void applyChatModelSelection(curSession, sel, applyToGlobal).catch(() => { /* ignore */ });
  }, [updateAgent]);

  const lastMsg = messages[messages.length - 1];
  const isLastPending = sending && lastMsg?.sender === 'agent';
  const lastAgentMsgId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.sender === 'agent') return messages[i]!.id;
    }
    return null;
  }, [messages]);

  const [entityMentions, setEntityMentions] = useState<MentionItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const items: MentionItem[] = [];
      try {
        const [projRes, reqRes, taskRes, delRes, teamsRes] = await Promise.all([
          api.projects.list().catch(() => ({ projects: [] })),
          api.requirements.list().catch(() => ({ requirements: [] })),
          api.tasks.list({ pageSize: 100 }).catch(() => ({ tasks: [] })),
          api.deliverables.search({ limit: 100 }).catch(() => ({ results: [] })),
          api.teams.list().catch(() => ({ teams: [], ungrouped: [] })),
        ]);
        for (const p of projRes.projects) items.push({ id: p.id, name: p.name, type: 'project', role: p.status });
        for (const r of reqRes.requirements) items.push({ id: r.id, name: r.title, type: 'requirement', role: r.priority });
        for (const t of taskRes.tasks) items.push({ id: t.id, name: t.title, type: 'task', role: t.status });
        for (const d of delRes.results) items.push({ id: d.id, name: d.title, type: 'deliverable', role: d.type });
        for (const team of teamsRes.teams) {
          try {
            const wfRes = await api.workflows.list(team.id);
            for (const wf of wfRes.workflows) items.push({ id: wf.name, name: wf.displayName || wf.name, type: 'workflow', role: `v${wf.version}` });
          } catch { /* skip teams without workflows */ }
        }
      } catch { /* ignore */ }
      if (!cancelled) setEntityMentions(items);
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  const mentionItems = useMemo(() => {
    const agentItems: MentionItem[] = agents.map(a => ({ id: a.id, name: a.name, role: a.role, avatarUrl: a.avatarUrl, type: 'agent' as const }));
    return [...entityMentions, ...agentItems, ...(extraMentionItems ?? [])];
  }, [agents, entityMentions, extraMentionItems]);

  return (
    <div
      className={`flex flex-col bg-surface-primary border-l border-border-default ${className}`}
      style={width ? { width } : { width: 400 }}
    >
      {/* Header */}
      <div className="h-12 px-4 flex items-center gap-2 shrink-0 border-b border-border-default">
        <Avatar
          name={agentName}
          avatarUrl={agent?.avatarUrl}
          size={24}
          bgClass="bg-brand-500/15 text-brand-600"
          className="rounded-md"
        />
        <span className="text-sm font-medium text-fg-primary truncate flex-1">{agentName}</span>
        <ChatModelMenu
          value={sessionModelOverride}
          disabled={!agentId}
          onSelect={handleModelSelect}
        />
        {onClose && (
          <button onClick={onClose} className="text-fg-tertiary hover:text-fg-secondary transition-colors p-1" aria-label={t('common:close', { defaultValue: 'Close' })}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Messages */}
      <div
        ref={chatScrollRef}
        className="flex-1 overflow-y-auto scrollbar-thin px-3 py-3 space-y-3"
        onScroll={handleScroll}
      >
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <svg className="animate-spin h-5 w-5 text-fg-tertiary" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Avatar name={agentName} avatarUrl={agent?.avatarUrl} size={40} bgClass="bg-brand-500/20 text-brand-500" />
            <p className="text-fg-secondary text-sm font-medium">{greeting}</p>
          </div>
        ) : (
          messages.map((msg, idx) => {
            const prevMsg = idx > 0 ? messages[idx - 1] : null;
            const curDate = getDateKey(msg.rawCreatedAt);
            const prevDate = prevMsg ? getDateKey(prevMsg.rawCreatedAt) : '';
            const showDateSep = Boolean(curDate && prevDate && curDate !== prevDate);
            const isLastMsg = idx === messages.length - 1;
            const isStreamingMsg = isLastPending && isLastMsg;
            const showStreamingBubble = isStreamingMsg;

            return (
              <div key={msg.id}>
                {showDateSep && (
                  <div className="flex items-center gap-3 py-1 my-1">
                    <div className="flex-1 h-px bg-border-default" />
                    <span className="text-[10px] text-fg-tertiary font-medium uppercase tracking-wider shrink-0">{formatDateLabel(msg.rawCreatedAt!, dateLabels)}</span>
                    <div className="flex-1 h-px bg-border-default" />
                  </div>
                )}
                <div className="flex gap-2">
                  <div className="shrink-0 mt-0.5">
                    <Avatar
                      name={msg.sender === 'user' ? userName : agentName}
                      avatarUrl={msg.sender === 'user' ? authUser?.avatarUrl : agent?.avatarUrl}
                      size={24}
                      bgClass={msg.sender === 'user' ? 'bg-brand-600' : 'bg-brand-500/15 text-brand-600'}
                      className="rounded-md"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-xs font-medium text-fg-primary">
                        {msg.sender === 'user' ? userName : agentName}
                      </span>
                      <span className="text-[10px] text-fg-tertiary">{formatSmartTime(msg.time, msg.rawCreatedAt, dateLabels)}</span>
                    </div>
                    <div className={`mt-0.5 ${msg.sender === 'agent' ? 'py-0.5' : 'bg-surface-secondary rounded-xl px-3 py-2 w-fit max-w-full'} ${
                      showStreamingBubble && msg.sender === 'agent' ? 'streaming-bubble' : ''
                    }`}>
                      {msg.sender === 'user'
                        ? <div className="text-sm text-fg-secondary whitespace-pre-wrap">{msg.text}</div>
                        : msg.segments && msg.segments.length > 0
                          ? <AgentMessageBody
                              msg={msg}
                              isStreaming={isStreamingMsg}
                              liveActivities={isStreamingMsg ? activities : []}
                            />
                          : msg.isError || msg.text.startsWith('⚠')
                            ? <div className="text-[13px] text-fg-tertiary leading-relaxed whitespace-pre-wrap">{msg.text.replace(/^⚠\s*/, '')}</div>
                            : <MarkdownMessage content={msg.text} className="text-sm text-fg-secondary" />
                      }
                    </div>
                    {!isStreamingMsg && (
                      <MessageActions
                        msg={msg}
                        onCopy={handleCopy}
                        onRemember={setRememberTarget}
                        showRemember
                        isCopied={copiedMsgId === msg.id}
                        isLastAgentMsg={msg.id === lastAgentMsgId}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {rememberTarget && (
        <RememberModal
          busy={rememberBusy}
          onConfirm={(note) => { void handleRememberConfirm(note); }}
          onCancel={() => { if (!rememberBusy) setRememberTarget(null); }}
        />
      )}

      {/* Scroll to bottom */}
      {showScrollBtn && (
        <div className="flex justify-center -mt-10 relative z-10 pointer-events-none">
          <button
            onClick={() => scrollToBottom('smooth')}
            className="pointer-events-auto w-8 h-8 rounded-full bg-surface-elevated border border-border-default shadow-md flex items-center justify-center text-fg-tertiary hover:text-fg-secondary transition-colors"
            title={t('page.scrollToBottom')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      )}

      {/* Input — 附件/拖拽/粘贴/模型切换，视觉交互与 Team 对齐，非 compact */}
      <div className="px-3 py-2 shrink-0 border-t border-border-default" onDrop={handleDrop} onDragOver={handleDragOver}>
        <ChatInput
          value={input}
          onChange={handleInputChange}
          onSend={() => { void send(); }}
          disabled={!agentId}
          placeholder={t('page.placeholder.direct')}
          sending={sending}
          onStop={stopSending}
          contextChips={contextChips}
          mentionItems={mentionItems}
          onMentionChipsChange={handleMentionChipsChange}
          slashCommands={slashCommands}
          pendingFiles={pendingFiles}
          onAttach={() => fileInputRef.current?.click()}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onRemoveFile={removeFile}
          fileInputRef={fileInputRef}
          visionWarning={pendingFiles.length > 0 && pendingFiles.some(f => isImageFile(f)) && agent?.modelSupportsVision === false}
          maxFiles={MAX_FILES}
          className="shadow-none border-0"
          textareaRef={externalTextareaRef}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf,.docx,.xlsx,.pptx,.xls,.doc,.csv,.json,.xml,.html,.epub"
          multiple
          className="hidden"
          onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
        />
      </div>
    </div>
  );
}

