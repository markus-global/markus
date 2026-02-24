import { useEffect, useRef, useState } from 'react';
import { api, type AgentInfo, type HumanUserInfo } from '../api.ts';

interface ChatMessage {
  sender: 'user' | 'agent';
  text: string;
  time: string;
  agentName?: string;
}

type ChatMode = 'direct' | 'smart';

export function Chat() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [humans, setHumans] = useState<HumanUserInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [selectedUser, setSelectedUser] = useState('');
  const [chatMode, setChatMode] = useState<ChatMode>('smart');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.agents.list().then(d => setAgents(d.agents)).catch(() => {});
    api.users.list().then(d => setHumans(d.users)).catch(() => {});
  }, []);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || sending) return;
    if (chatMode === 'direct' && !selectedAgent) return;

    const text = input.trim();
    setInput('');
    setMessages(prev => [...prev, { sender: 'user', text, time: new Date().toLocaleTimeString() }]);
    setSending(true);

    setMessages(prev => [...prev, { sender: 'agent', text: '', time: new Date().toLocaleTimeString() }]);

    try {
      if (chatMode === 'smart') {
        const result = await api.message.sendStream(text, chunk => {
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.sender === 'agent') {
              updated[updated.length - 1] = { ...last, text: last.text + chunk };
            }
            return updated;
          });
        }, {
          senderId: selectedUser || undefined,
          targetAgentId: undefined,
        });

        const routedAgent = agents.find(a => a.id === result.agentId);
        if (routedAgent) {
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.sender === 'agent') {
              updated[updated.length - 1] = { ...last, agentName: routedAgent.name };
            }
            return updated;
          });
        }
      } else {
        await api.agents.messageStream(selectedAgent, text, chunk => {
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.sender === 'agent') {
              updated[updated.length - 1] = { ...last, text: last.text + chunk };
            }
            return updated;
          });
        });
      }
    } catch (e) {
      setMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.sender === 'agent') {
          updated[updated.length - 1] = { ...last, text: `Error: ${String(e)}` };
        }
        return updated;
      });
    } finally {
      setSending(false);
    }
  };

  const directAgentName = agents.find(a => a.id === selectedAgent)?.name ?? 'Agent';
  const currentUserName = humans.find(h => h.id === selectedUser)?.name;

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-7 h-15 border-b border-gray-800 bg-gray-900 shrink-0">
        <h2 className="text-lg font-semibold">Workspace</h2>
        <div className="ml-4 flex gap-1 bg-gray-800 rounded-lg p-0.5">
          <button
            onClick={() => { setChatMode('smart'); setMessages([]); }}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${chatMode === 'smart' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
          >
            Smart Route
          </button>
          <button
            onClick={() => { setChatMode('direct'); setMessages([]); }}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${chatMode === 'direct' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
          >
            Direct
          </button>
        </div>
        {chatMode === 'direct' && (
          <select
            value={selectedAgent}
            onChange={e => { setSelectedAgent(e.target.value); setMessages([]); }}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none"
          >
            <option value="">Select agent...</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}
          </select>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500">Speaking as:</span>
          <select
            value={selectedUser}
            onChange={e => setSelectedUser(e.target.value)}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs focus:border-indigo-500 outline-none"
          >
            <option value="">Anonymous</option>
            {humans.map(h => <option key={h.id} value={h.id}>{h.name} ({h.role})</option>)}
          </select>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-7 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm space-y-2">
            <div className="text-4xl opacity-30">◈</div>
            {chatMode === 'smart' ? (
              <>
                <div>Send a message — it will be automatically routed to the right agent.</div>
                <div className="text-xs text-gray-600">The Organization Manager will triage your request if available.</div>
              </>
            ) : (
              <div>Select an agent and start chatting directly.</div>
            )}
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[70%] ${msg.sender === 'user' ? 'order-1' : ''}`}>
              <div className="text-xs text-gray-500 mb-1">
                {msg.sender === 'user'
                  ? (currentUserName ?? 'You')
                  : (msg.agentName ?? (chatMode === 'direct' ? directAgentName : 'Agent'))
                } &middot; {msg.time}
              </div>
              <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                msg.sender === 'user'
                  ? 'bg-indigo-600 text-white rounded-br-md'
                  : 'bg-gray-800 text-gray-200 rounded-bl-md'
              }`}>
                {msg.text}
              </div>
            </div>
          </div>
        ))}
        {sending && messages[messages.length - 1]?.text === '' && (
          <div className="flex justify-start">
            <div className="bg-gray-800 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm text-gray-400">
              <span className="animate-pulse">Thinking...</span>
            </div>
          </div>
        )}
        <div ref={messagesEnd} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-gray-800 bg-gray-900 flex gap-3 shrink-0">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={chatMode === 'smart' ? 'Type a message (auto-routed to the right agent)...' : (selectedAgent ? 'Type a message...' : 'Select an agent first')}
          disabled={chatMode === 'direct' && !selectedAgent}
          className="flex-1 px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-sm focus:border-indigo-500 outline-none disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={(chatMode === 'direct' && !selectedAgent) || sending}
          className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-xl transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
