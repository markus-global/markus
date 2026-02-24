import { useEffect, useRef, useState } from 'react';
import { api, type AgentInfo } from '../api.ts';

interface ChatMessage {
  sender: 'user' | 'agent';
  text: string;
  time: string;
}

export function Chat() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.agents.list().then((d) => setAgents(d.agents)).catch(() => {});
  }, []);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || !selectedAgent || sending) return;
    const text = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { sender: 'user', text, time: new Date().toLocaleTimeString() }]);
    setSending(true);

    try {
      const data = await api.agents.message(selectedAgent, text);
      setMessages((prev) => [...prev, { sender: 'agent', text: data.reply, time: new Date().toLocaleTimeString() }]);
    } catch (e) {
      setMessages((prev) => [...prev, { sender: 'agent', text: `Error: ${String(e)}`, time: new Date().toLocaleTimeString() }]);
    } finally {
      setSending(false);
    }
  };

  const agentName = agents.find((a) => a.id === selectedAgent)?.name ?? 'Agent';

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex items-center gap-4 px-7 h-15 border-b border-gray-800 bg-gray-900 shrink-0">
        <h2 className="text-lg font-semibold">Chat</h2>
        <select
          value={selectedAgent}
          onChange={(e) => { setSelectedAgent(e.target.value); setMessages([]); }}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none"
        >
          <option value="">Select an agent...</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto p-7 space-y-4">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[70%] ${msg.sender === 'user' ? 'order-1' : ''}`}>
              <div className="text-xs text-gray-500 mb-1">{msg.sender === 'user' ? 'You' : agentName} &middot; {msg.time}</div>
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
        {sending && (
          <div className="flex justify-start">
            <div className="bg-gray-800 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm text-gray-400">
              <span className="animate-pulse">Thinking...</span>
            </div>
          </div>
        )}
        <div ref={messagesEnd} />
      </div>

      <div className="p-4 border-t border-gray-800 bg-gray-900 flex gap-3 shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={selectedAgent ? 'Type a message...' : 'Select an agent first'}
          disabled={!selectedAgent}
          className="flex-1 px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-sm focus:border-indigo-500 outline-none disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={!selectedAgent || sending}
          className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-xl transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
