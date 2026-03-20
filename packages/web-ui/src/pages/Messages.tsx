import { useEffect, useRef, useState, useCallback } from 'react';
import { api, wsClient, type AgentInfo, type ChannelMessageInfo } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';

const DEFAULT_CHANNELS = ['#general', '#dev', '#support'];

const PAGE_SIZE = 50;

export function Messages() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [channels] = useState(DEFAULT_CHANNELS);
  const [activeChannel, setActiveChannel] = useState('#general');
  const [messages, setMessages] = useState<ChannelMessageInfo[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionDropdown, setMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const messagesEnd = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.agents.list().then(d => setAgents(d.agents)).catch(() => {});
  }, []);

  const loadMessages = useCallback(async (channel: string) => {
    setLoading(true);
    try {
      const result = await api.channels.getMessages(channel, PAGE_SIZE);
      setMessages(result.messages);
      setHasMore(result.hasMore);
    } catch {
      setMessages([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    const oldest = messages[0]!;
    setLoadingMore(true);
    try {
      const result = await api.channels.getMessages(activeChannel, PAGE_SIZE, new Date(oldest.createdAt).toISOString());
      setMessages(prev => [...result.messages, ...prev]);
      setHasMore(result.hasMore);
    } catch { /* ignore */ } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, messages, activeChannel]);

  useEffect(() => {
    loadMessages(activeChannel);
  }, [activeChannel, loadMessages]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Live WebSocket updates (agent replies from other sources)
  useEffect(() => {
    const handler = (event: { type: string; payload: Record<string, unknown> }) => {
      if (event.type === 'chat') {
        const p = event.payload;
        const newMsg: ChannelMessageInfo = {
          id: `ws_${Date.now()}`,
          channel: activeChannel,
          senderId: (p['agentId'] as string) ?? 'agent',
          senderType: 'agent',
          senderName: (p['agentId'] as string) ?? 'Agent',
          text: (p['text'] as string) ?? '',
          mentions: [],
          createdAt: new Date().toISOString(),
        };
        setMessages(prev => [...prev, newMsg]);
      }
    };
    const unsub = wsClient.on('chat', handler);
    return unsub;
  }, [activeChannel]);

  const parseMentions = (text: string): string[] => {
    const matches = text.match(/@(\w+)/g);
    return matches ? matches.map(m => m.slice(1)) : [];
  };

  const send = async () => {
    if (!input.trim() || sending) return;
    const text = input.trim();
    const mentions = parseMentions(text);
    setInput('');
    setSending(true);

    const mentionedAgent = mentions.length > 0
      ? agents.find(a => a.name.toLowerCase() === mentions[0]!.toLowerCase())
      : null;

    try {
      const result = await api.channels.sendMessage(activeChannel, {
        text,
        senderName: 'You',
        mentions,
        targetAgentId: mentionedAgent?.id,
        orgId: 'default',
      });
      // Append user message + agent reply returned from server
      const newMsgs: ChannelMessageInfo[] = [];
      if (result.userMessage) newMsgs.push(result.userMessage);
      if (result.agentMessage) newMsgs.push(result.agentMessage);
      if (newMsgs.length > 0) {
        setMessages(prev => [...prev, ...newMsgs]);
      }
    } catch (e) {
      setMessages(prev => [...prev, {
        id: `err_${Date.now()}`,
        channel: activeChannel,
        senderId: 'system',
        senderType: 'agent',
        senderName: 'System',
        text: `Error: ${String(e)}`,
        mentions: [],
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setSending(false);
    }
  };

  const handleInputChange = (val: string) => {
    setInput(val);
    const lastAt = val.lastIndexOf('@');
    if (lastAt >= 0 && (lastAt === 0 || val[lastAt - 1] === ' ')) {
      const afterAt = val.slice(lastAt + 1);
      if (!afterAt.includes(' ')) {
        setMentionDropdown(true);
        setMentionFilter(afterAt.toLowerCase());
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

  const filteredAgents = agents.filter(a => a.name.toLowerCase().includes(mentionFilter));

  const formatTime = (iso: string) => {
    try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
  };

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* Channel sidebar */}
      <div className="w-48 bg-surface-secondary/50 border-r border-border-default flex flex-col shrink-0">
        <div className="p-3 border-b border-border-default">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Channels</h3>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {channels.map(ch => (
            <button
              key={ch}
              onClick={() => setActiveChannel(ch)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors ${
                activeChannel === ch ? 'bg-brand-600/20 text-brand-300' : 'text-gray-400 hover:bg-surface-elevated'
              }`}
            >
              {ch}
            </button>
          ))}
        </div>
        <div className="p-2 border-t border-border-default">
          <div className="px-3 py-1.5 text-xs text-gray-500 font-semibold uppercase">Direct</div>
          {agents.map(a => (
            <div key={a.id} className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-400">
              <span className={`w-1.5 h-1.5 rounded-full ${a.status === 'idle' ? 'bg-green-500' : a.status === 'working' ? 'bg-yellow-500' : 'bg-gray-600'}`} />
              {a.name}
            </div>
          ))}
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-14 border-b border-border-default flex items-center px-6 shrink-0">
          <span className="font-semibold text-sm">{activeChannel}</span>
          <span className="ml-3 text-xs text-gray-500">{messages.length} messages</span>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div ref={topRef} />
          {loading && (
            <div className="flex items-center justify-center h-20 text-gray-500 text-sm animate-pulse">
              Loading messages…
            </div>
          )}
          {!loading && hasMore && (
            <div className="flex justify-center py-2">
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="text-xs text-brand-400 hover:text-brand-300 disabled:opacity-50 px-4 py-1.5 border border-brand-800/50 rounded-lg transition-colors"
              >
                {loadingMore ? 'Loading…' : '↑ Load earlier messages'}
              </button>
            </div>
          )}
          {!loading && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm">
              <div className="text-3xl opacity-20 mb-2">✉</div>
              <div>No messages in {activeChannel} yet.</div>
              <div className="text-xs text-gray-600 mt-1">Type @AgentName to mention a specific agent.</div>
            </div>
          )}
          {messages.map(msg => (
            <div key={msg.id} className="flex gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                msg.senderType === 'human' ? 'bg-brand-600' : 'bg-surface-overlay'
              }`}>
                {msg.senderName[0]?.toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-white">{msg.senderName}</span>
                  <span className="text-xs text-gray-600">{formatTime(msg.createdAt)}</span>
                  {msg.mentions.length > 0 && (
                    <span className="text-xs text-brand-400">@{msg.mentions.join(' @')}</span>
                  )}
                </div>
                {msg.senderType === 'agent'
                  ? <MarkdownMessage content={msg.text} className="text-sm text-gray-300 mt-0.5" />
                  : <div className="text-sm text-gray-300 mt-0.5 whitespace-pre-wrap break-words">{msg.text}</div>
                }
              </div>
            </div>
          ))}
          {sending && <div className="text-xs text-gray-500 animate-pulse ml-11">Agent is thinking…</div>}
          <div ref={messagesEnd} />
        </div>

        {/* Input with @mention */}
        <div className="p-4 border-t border-border-default relative">
          {mentionDropdown && filteredAgents.length > 0 && (
            <div className="absolute bottom-full left-4 mb-1 bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden">
              {filteredAgents.map(a => (
                <button
                  key={a.id}
                  onClick={() => insertMention(a.name)}
                  className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-surface-overlay flex items-center gap-2"
                >
                  <span className="text-brand-400">@</span>
                  {a.name}
                  <span className="text-xs text-gray-500 ml-auto">{a.role}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-3 items-end">
            <textarea
              value={input}
              onChange={e => {
                handleInputChange(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
              }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder={`Message ${activeChannel}… (use @name to mention)`}
              rows={1}
              className="flex-1 px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm focus:border-brand-500 outline-none resize-none overflow-y-auto leading-5"
              style={{ maxHeight: '120px' }}
            />
            <button
              onClick={() => void send()}
              disabled={sending || !input.trim()}
              className="px-5 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm rounded-xl transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
