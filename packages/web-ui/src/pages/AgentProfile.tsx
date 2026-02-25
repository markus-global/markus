import { useEffect, useState, useRef } from 'react';
import { api, wsClient } from '../api.ts';
import type { AgentDetail } from '../api.ts';

interface Props {
  agentId: string;
  onBack: () => void;
}

export function AgentProfile({ agentId, onBack }: Props) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'agent'; text: string }>>([]);
  const [streaming, setStreaming] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.agents.get(agentId).then(setAgent).catch(() => {});
    const unsub = wsClient.on('agent:update', (evt) => {
      if ((evt.payload as Record<string, string>).agentId === agentId) {
        api.agents.get(agentId).then(setAgent).catch(() => {});
      }
    });
    return unsub;
  }, [agentId]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    if (!chatInput.trim() || streaming) return;
    const text = chatInput.trim();
    setChatInput('');
    setMessages(prev => [...prev, { role: 'user', text }]);
    setStreaming(true);

    let agentReply = '';
    setMessages(prev => [...prev, { role: 'agent', text: '' }]);

    try {
      await api.agents.messageStream(agentId, text, (chunk) => {
        agentReply += chunk;
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'agent', text: agentReply };
          return updated;
        });
      });
    } catch (e) {
      agentReply = `Error: ${String(e)}`;
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'agent', text: agentReply };
        return updated;
      });
    }
    setStreaming(false);
  };

  const triggerDailyReport = async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/daily-report`, { method: 'POST' });
      const data = await res.json() as { report: string };
      setMessages(prev => [...prev, { role: 'agent', text: `📋 Daily Report:\n\n${data.report}` }]);
    } catch { /* ignore */ }
  };

  if (!agent) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Loading agent...
      </div>
    );
  }

  const statusColor = agent.state.status === 'idle' ? 'bg-green-400' :
    agent.state.status === 'working' ? 'bg-yellow-400' : 'bg-gray-500';

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-7 py-4 border-b border-gray-800 bg-gray-900 shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-500 hover:text-gray-300 text-sm">&larr; Back</button>
          <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-lg font-bold">
            {agent.name.charAt(0)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{agent.name}</h2>
              <span className={`w-2 h-2 rounded-full ${statusColor}`} />
              <span className="text-xs text-gray-500">{agent.state.status}</span>
              {agent.agentRole === 'manager' && (
                <span className="px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-400 rounded font-medium">Manager</span>
              )}
            </div>
            <div className="text-xs text-gray-500">{agent.role} · {agent.id}</div>
          </div>
          <div className="ml-auto flex gap-2">
            <button onClick={triggerDailyReport} className="px-3 py-1.5 text-xs border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors">
              Daily Report
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex">
        {/* Left: Info Panel */}
        <div className="w-72 border-r border-gray-800 overflow-y-auto p-5 space-y-6 shrink-0 bg-gray-900/50">
          {/* Stats */}
          <Section title="Stats">
            <StatRow label="Tokens Today" value={String(agent.state.tokensUsedToday)} />
            <StatRow label="Current Task" value={agent.state.currentTaskId ?? 'None'} />
            <StatRow label="Last Heartbeat" value={agent.state.lastHeartbeat ? new Date(agent.state.lastHeartbeat).toLocaleTimeString() : 'Never'} />
          </Section>

          {/* Skills */}
          <Section title="Skills">
            {agent.skills.length === 0 ? (
              <div className="text-xs text-gray-600">No skills configured</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {agent.skills.map(s => (
                  <span key={s} className="px-2 py-0.5 text-[10px] bg-indigo-500/15 text-indigo-400 rounded-full">{s}</span>
                ))}
              </div>
            )}
          </Section>

          {/* Identity */}
          <Section title="Identity">
            <StatRow label="Agent Role" value={agent.agentRole} />
            <StatRow label="Role Template" value={agent.role} />
          </Section>
        </div>

        {/* Right: Chat */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-5 space-y-3">
            {messages.length === 0 && (
              <div className="text-center text-gray-600 py-20">
                <div className="text-3xl mb-3 opacity-30">◈</div>
                <div className="text-sm">Start a conversation with {agent.name}</div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-800 text-gray-300'
                }`}>
                  {msg.text || (streaming ? '...' : '')}
                </div>
              </div>
            ))}
            <div ref={messagesEnd} />
          </div>

          <div className="border-t border-gray-800 px-5 py-3 flex gap-2 shrink-0">
            <input
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder={`Message ${agent.name}...`}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-indigo-500"
              disabled={streaming}
            />
            <button
              onClick={sendMessage}
              disabled={streaming || !chatInput.trim()}
              className="px-5 py-2.5 bg-indigo-600 rounded-lg text-sm font-medium hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-2">{title}</h3>
      {children}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs py-1">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-300 font-mono">{value}</span>
    </div>
  );
}
