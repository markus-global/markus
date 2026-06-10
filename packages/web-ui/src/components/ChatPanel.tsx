import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api, wsClient,
  type AgentInfo, type AgentToolEvent, type StreamCommitEvent,
  type AuthUser, type StoredSegment,
} from '../api.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';
import {
  AgentMessageBody, segmentsToStreamEntries, friendlyAgentError,
} from '../pages/ChatComponents.tsx';
import { Avatar } from './Avatar.tsx';
import { ChatInput, type ContextChip, type MentionItem, type MentionChip } from './ChatInput.tsx';
import {
  type MsgSegment, type ChatMsg,
  dbMsgToChat, stripNotifyContext, formatSmartTime, getDateKey, formatDateLabel,
} from '../pages/ChatHelpers.ts';
import type { ActivityStep } from './ActivityIndicator.tsx';

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
}: ChatPanelProps) {
  const { t } = useTranslation(['team', 'common']);
  const agent = agents.find(a => a.id === agentId);
  const agentName = agent?.name ?? t('page.fallbackAgent');
  const userName = authUser?.name ?? t('page.fallbackYou');

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState('');
  const [activities, setActivities] = useState<ActivityStep[]>([]);
  const [currentMentionChips, setCurrentMentionChips] = useState<MentionChip[]>([]);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const userAtBottomRef = useRef(true);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

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

  // Load the agent's main session and messages
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessages([]);

    const load = async () => {
      try {
        let sid = initialSessionId ?? null;
        if (!sid) {
          const { sessions } = await api.sessions.listByAgent(agentId, 10);
          const main = sessions.find(s => s.isMain);
          sid = main?.id ?? sessions[0]?.id ?? null;
        }
        if (cancelled) return;
        setSessionId(sid);

        if (sid) {
          const result = await api.sessions.getMessages(sid, 50);
          if (cancelled) return;
          const msgs = result.messages.map(dbMsgToChat).filter(m =>
            m.sender !== 'agent' || m.text || (m.segments && m.segments.length > 0)
          );
          setMessages(msgs);
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [agentId, initialSessionId]);

  // Scroll to bottom on initial load
  const prevLoadingRef = useRef(true);
  useEffect(() => {
    if (prevLoadingRef.current && !loading && messages.length > 0) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToBottom());
      });
    }
    prevLoadingRef.current = loading;
  }, [loading, messages.length, scrollToBottom]);

  // Scroll to bottom when new messages arrive (not initial load)
  useEffect(() => {
    if (!loading && userAtBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom());
    }
  }, [messages, scrollToBottom, loading]);

  // WS: listen for proactive messages from this agent
  useEffect(() => {
    const unsub = wsClient.on('chat:proactive_message', (event) => {
      const p = event.payload;
      const msgAgentId = (p['agentId'] as string) ?? '';
      if (msgAgentId !== agentId) return;
      const targetUserId = p['targetUserId'] as string | undefined;
      if (targetUserId && targetUserId !== authUser?.id) return;
      const message = (p['message'] as string) ?? '';
      const msgSessionId = (p['sessionId'] as string) ?? '';
      if (!message || (message === '[cancelled]') || (message === '[Stream cancelled]')) return;

      if (msgSessionId && sessionIdRef.current && msgSessionId !== sessionIdRef.current) return;

      const { cleaned: displayMessage, priority: parsedPriority } = stripNotifyContext(message);
      const meta = (p['metadata'] as Record<string, unknown>) ?? {};
      const isNotify = !!meta.notifyUser || displayMessage !== message;
      const newMsg: ChatMsg = {
        id: `proactive_${Date.now()}`,
        sender: 'agent',
        text: displayMessage,
        time: new Date().toLocaleTimeString(),
        agentName: (p['agentName'] as string) ?? agentName,
        agentId: msgAgentId,
        ...(isNotify ? { isNotification: true, notifyPriority: (meta.priority as string) ?? parsedPriority } : {}),
      };
      setMessages(prev => [...prev, newMsg]);
    });
    return unsub;
  }, [agentId, agentName, authUser?.id]);

  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    userAtBottomRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  }, []);

  const stopSending = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setActivities([]);
    void api.agents.cancelProcessing(agentId).catch(() => {});
  }, [agentId]);

  const send = useCallback(async () => {
    const parts: string[] = [];

    if (currentMentionChips.length > 0) {
      parts.push(currentMentionChips.map(c => `@[${c.name}](${c.entityType}:${c.entityId})`).join(' '));
    }

    if (contextChips?.length) {
      for (const chip of contextChips) {
        parts.push(`[${chip.type}: ${chip.label}]\n${chip.content}`);
      }
    }

    if (input.trim()) parts.push(input.trim());

    const text = parts.join('\n\n');
    if (!text) return;

    setInput('');
    setCurrentMentionChips([]);
    userAtBottomRef.current = true;
    setSending(true);
    setActivities([]);

    const agentMsgId = `a_${Date.now()}`;
    const userMsg: ChatMsg = { id: `u_${Date.now()}`, sender: 'user', text, time: new Date().toLocaleTimeString() };
    const agentCreatedAt = new Date().toISOString();

    setMessages(prev => [
      ...prev,
      userMsg,
      { id: agentMsgId, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt, segments: [] },
    ]);

    let insideThink = false;

    const appendTextChunk = (chunk: string) => {
      setMessages(prev => {
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
          if (insideThink) {
            const closeIdx = remaining.indexOf('</think>');
            if (closeIdx >= 0) { thinking += remaining.slice(0, closeIdx); remaining = remaining.slice(closeIdx + '</think>'.length); insideThink = false; }
            else { thinking += remaining; remaining = ''; }
          } else {
            const openIdx = remaining.indexOf('<think>');
            if (openIdx >= 0) { content += remaining.slice(0, openIdx); remaining = remaining.slice(openIdx + '<think>'.length); insideThink = true; }
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
    };

    const handleCommitEvent = (event: StreamCommitEvent) => {
      if (event.type === 'session_start' && event.sessionId) {
        setSessionId(event.sessionId);
        return;
      }
      setMessages(prev => {
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

    const handleToolEvent = (event: AgentToolEvent) => {
      if (event.phase === 'heartbeat') return;
      if (event.phase === 'start') {
        setActivities(prev => [...prev, { ...event, phase: 'start', ts: Date.now() }]);
        setMessages(prev => {
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
        setMessages(prev => {
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
      } else if (event.phase === 'end') {
        setActivities(prev => [...prev, { ...event, phase: 'end', ts: Date.now() }]);
        setMessages(prev => {
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
    abortRef.current = abortCtrl;

    try {
      const streamResult = await api.agents.messageStream(
        agentId, text,
        appendTextChunk,
        handleToolEvent,
        abortCtrl.signal,
        undefined,
        sessionId,
        undefined,
        undefined,
        handleCommitEvent,
      );

      if (streamResult.merged) {
        setMessages(prev => prev.filter(m => m.id !== agentMsgId));
      }

      if (!streamResult.merged && streamResult.segments?.length) {
        setMessages(prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx < 0) return prev;
          const finalSegs: MsgSegment[] = streamResult.segments!.map((s: StoredSegment, i: number) =>
            s.type === 'tool'
              ? { type: 'tool' as const, key: `${s.tool}_${i}`, tool: s.tool, status: s.status, args: s.arguments, result: s.result, error: s.error, durationMs: s.durationMs, createdAt: s.createdAt }
              : { type: 'text' as const, content: s.content, thinking: s.thinking, createdAt: s.createdAt }
          );
          let finalText = streamResult.content || u[idx]!.text;
          if (!finalText) {
            finalText = finalSegs.filter(s => s.type === 'text').map(s => (s as { content: string }).content).join('');
          }
          u[idx] = { ...u[idx]!, text: finalText, segments: finalSegs, committedSegments: finalSegs };
          return u;
        });
      }

      if (!streamResult.merged && !streamResult.segments?.length) {
        setMessages(prev => {
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
        setSessionId(streamResult.sessionId);
      }
    } catch (e) {
      const errSessionId = (e as Error & { sessionId?: string })?.sessionId;
      if (errSessionId) setSessionId(errSessionId);

      const errText = friendlyAgentError(e, t);
      if (errText) {
        setMessages(prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx >= 0) {
            const segs = u[idx]!.segments ?? [];
            u[idx] = { ...u[idx]!, text: errText, isError: true, segments: [...segs, { type: 'text', content: errText }] };
          }
          return u;
        });
      } else {
        setMessages(prev => {
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
    setMessages(prev => {
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

    setSending(false);
    setActivities([]);
    abortRef.current = null;
  }, [input, agentId, sessionId, t, currentMentionChips, contextChips]);

  const lastMsg = messages[messages.length - 1];
  const isLastPending = sending && lastMsg?.sender === 'agent';

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
        {onClose && (
          <button onClick={onClose} className="text-fg-tertiary hover:text-fg-secondary transition-colors p-1">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Messages */}
      <div
        ref={chatScrollRef}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-3"
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
            const showDateSep = curDate && curDate !== prevDate;
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
                      msg.isError ? 'border-b-2 border-red-500/60' : ''
                    } ${showStreamingBubble && msg.sender === 'agent' ? 'streaming-bubble' : ''}`}>
                      {msg.sender === 'user'
                        ? <div className="text-sm text-fg-secondary whitespace-pre-wrap">{msg.text}</div>
                        : msg.segments && msg.segments.length > 0
                          ? <AgentMessageBody
                              msg={msg}
                              isStreaming={isStreamingMsg}
                              liveActivities={isStreamingMsg ? activities : []}
                              onViewModeChange={() => {}}
                            />
                          : <MarkdownMessage content={msg.text} className="text-sm text-fg-secondary" />
                      }
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

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

      {/* Input */}
      <div className="px-3 py-2 shrink-0 border-t border-border-default">
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={send}
          disabled={!agentId}
          placeholder={t('page.placeholder.direct')}
          sending={sending}
          onStop={stopSending}
          contextChips={contextChips}
          mentionItems={mentionItems}
          onMentionChipsChange={setCurrentMentionChips}
          compact
          className="shadow-none border-0"
        />
      </div>
    </div>
  );
}
