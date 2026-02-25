import { useEffect, useRef, useState } from 'react';
import { api, wsClient, type AgentInfo } from '../api.ts';

interface ChannelMessage {
  id: string;
  channel: string;
  sender: string;
  senderType: 'human' | 'agent';
  text: string;
  mentions: string[];
  time: string;
}

const DEFAULT_CHANNELS = ['#general', '#dev', '#support'];

export function Messages() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [channels] = useState(DEFAULT_CHANNELS);
  const [activeChannel, setActiveChannel] = useState('#general');
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionDropdown, setMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.agents.list().then(d => setAgents(d.agents)).catch(() => {});
  }, []);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const handler = (event: { type: string; payload: Record<string, unknown> }) => {
      if (event.type === 'chat') {
        const p = event.payload;
        setMessages(prev => [...prev, {
          id: `ws_${Date.now()}`,
          channel: activeChannel,
          sender: (p['agentId'] as string) ?? 'agent',
          senderType: 'agent',
          text: (p['text'] as string) ?? '',
          mentions: [],
          time: new Date().toLocaleTimeString(),
        }]);
      }
    };
    wsClient.on('chat', handler);
    return () => wsClient.off('chat', handler);
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

    const userMsg: ChannelMessage = {
      id: `msg_${Date.now()}`,
      channel: activeChannel,
      sender: 'You',
      senderType: 'human',
      text,
      mentions,
      time: new Date().toLocaleTimeString(),
    };
    setMessages(prev => [...prev, userMsg]);

    // If there are @mentions, route to the mentioned agent
    const mentionedAgent = mentions.length > 0
      ? agents.find(a => a.name.toLowerCase() === mentions[0]!.toLowerCase())
      : null;

    try {
      if (mentionedAgent) {
        const reply = await api.agents.message(mentionedAgent.id, text);
        setMessages(prev => [...prev, {
          id: `reply_${Date.now()}`,
          channel: activeChannel,
          sender: mentionedAgent.name,
          senderType: 'agent',
          text: reply.reply,
          mentions: [],
          time: new Date().toLocaleTimeString(),
        }]);
      } else {
        const result = await api.message.send(text);
        const routedAgent = agents.find(a => a.id === result.agentId);
        setMessages(prev => [...prev, {
          id: `reply_${Date.now()}`,
          channel: activeChannel,
          sender: routedAgent?.name ?? 'Agent',
          senderType: 'agent',
          text: result.reply,
          mentions: [],
          time: new Date().toLocaleTimeString(),
        }]);
      }
    } catch (e) {
      setMessages(prev => [...prev, {
        id: `err_${Date.now()}`,
        channel: activeChannel,
        sender: 'System',
        senderType: 'agent',
        text: `Error: ${String(e)}`,
        mentions: [],
        time: new Date().toLocaleTimeString(),
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

  const channelMessages = messages.filter(m => m.channel === activeChannel);
  const filteredAgents = agents.filter(a => a.name.toLowerCase().includes(mentionFilter));

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* Channel sidebar */}
      <div className="w-48 bg-gray-900/50 border-r border-gray-800 flex flex-col shrink-0">
        <div className="p-3 border-b border-gray-800">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Channels</h3>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {channels.map(ch => (
            <button
              key={ch}
              onClick={() => setActiveChannel(ch)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors ${
                activeChannel === ch ? 'bg-indigo-600/20 text-indigo-300' : 'text-gray-400 hover:bg-gray-800'
              }`}
            >
              {ch}
            </button>
          ))}
        </div>
        <div className="p-2 border-t border-gray-800">
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
        <div className="h-12 border-b border-gray-800 flex items-center px-5 shrink-0">
          <span className="font-semibold text-sm">{activeChannel}</span>
          <span className="ml-3 text-xs text-gray-500">{channelMessages.length} messages</span>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {channelMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm">
              <div className="text-3xl opacity-20 mb-2">✉</div>
              <div>No messages in {activeChannel} yet.</div>
              <div className="text-xs text-gray-600 mt-1">Type @AgentName to mention a specific agent.</div>
            </div>
          )}
          {channelMessages.map(msg => (
            <div key={msg.id} className="flex gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                msg.senderType === 'human' ? 'bg-indigo-600' : 'bg-gray-700'
              }`}>
                {msg.sender[0]?.toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-white">{msg.sender}</span>
                  <span className="text-xs text-gray-600">{msg.time}</span>
                  {msg.mentions.length > 0 && (
                    <span className="text-xs text-indigo-400">@{msg.mentions.join(' @')}</span>
                  )}
                </div>
                <div className="text-sm text-gray-300 mt-0.5 whitespace-pre-wrap break-words">{msg.text}</div>
              </div>
            </div>
          ))}
          {sending && <div className="text-xs text-gray-500 animate-pulse ml-11">Agent is thinking...</div>}
          <div ref={messagesEnd} />
        </div>

        {/* Input with @mention */}
        <div className="p-4 border-t border-gray-800 relative">
          {mentionDropdown && filteredAgents.length > 0 && (
            <div className="absolute bottom-full left-4 mb-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
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
          <div className="flex gap-3">
            <input
              value={input}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={`Message ${activeChannel}... (use @name to mention)`}
              className="flex-1 px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-sm focus:border-indigo-500 outline-none"
            />
            <button
              onClick={send}
              disabled={sending || !input.trim()}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-xl transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
