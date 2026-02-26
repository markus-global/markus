import { useEffect, useState } from 'react';
import { api, wsClient } from '../api.ts';
import type { AgentDetail } from '../api.ts';
import { navBus } from '../navBus.ts';

interface Props {
  agentId: string;
  onBack: () => void;
  /** When true, renders as a side panel instead of a full page */
  inline?: boolean;
}

export function AgentProfile({ agentId, onBack, inline }: Props) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);

  useEffect(() => {
    api.agents.get(agentId).then(setAgent).catch(() => {});
    const unsub = wsClient.on('agent:update', (evt) => {
      if ((evt.payload as Record<string, string>).agentId === agentId) {
        api.agents.get(agentId).then(setAgent).catch(() => {});
      }
    });
    return unsub;
  }, [agentId]);

  const triggerDailyReport = async () => {
    try {
      await fetch(`/api/agents/${agentId}/daily-report`, { method: 'POST', credentials: 'include' });
    } catch { /* ignore */ }
  };

  const openChat = () => {
    navBus.navigate('chat', { agentId });
  };

  if (!agent) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Loading agent...
      </div>
    );
  }

  const statusColor =
    agent.state.status === 'idle' ? 'bg-green-400' :
    agent.state.status === 'working' ? 'bg-yellow-400' : 'bg-gray-500';

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className={`px-5 py-4 border-b border-gray-800 bg-gray-900 shrink-0`}>
        <div className="flex items-center gap-3">
          {!inline && (
            <button onClick={onBack} className="text-gray-500 hover:text-gray-300 text-sm">&larr; Back</button>
          )}
          <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-lg font-bold shrink-0">
            {agent.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold">{agent.name}</h2>
              <span className={`w-2 h-2 rounded-full ${statusColor}`} />
              <span className="text-xs text-gray-500">{agent.state.status}</span>
              {agent.agentRole === 'manager' && (
                <span className="px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-400 rounded font-medium">Manager</span>
              )}
            </div>
            <div className="text-xs text-gray-500 truncate">{agent.role}</div>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <button
              onClick={triggerDailyReport}
              className="px-2.5 py-1 text-xs border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors"
            >
              Report
            </button>
            <button
              onClick={openChat}
              className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors flex items-center gap-1"
            >
              <span>◈</span> Chat
            </button>
            {inline && (
              <button onClick={onBack} className="p-1 text-gray-500 hover:text-gray-300 text-lg leading-none">&times;</button>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className={`p-5 grid gap-4 ${inline ? 'grid-cols-1' : 'grid-cols-2 max-w-3xl'}`}>
        {/* Stats */}
        <Card title="Stats">
          <StatRow label="Status" value={agent.state.status} />
          <StatRow label="Tokens Today" value={String(agent.state.tokensUsedToday)} />
          <StatRow label="Current Task" value={agent.state.currentTaskId ?? 'None'} />
          <StatRow label="Last Heartbeat" value={
            agent.state.lastHeartbeat
              ? new Date(agent.state.lastHeartbeat).toLocaleTimeString()
              : 'Never'
          } />
        </Card>

        {/* Identity */}
        <Card title="Identity">
          <StatRow label="Agent Role" value={agent.agentRole} />
          <StatRow label="Role Template" value={agent.role} />
          <StatRow label="ID" value={agent.id} mono />
        </Card>

        {/* Skills */}
        <Card title="Skills">
          {agent.skills.length === 0 ? (
            <div className="text-xs text-gray-600">No skills configured</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {agent.skills.map(s => (
                <span key={s} className="px-2 py-0.5 text-[10px] bg-indigo-500/15 text-indigo-400 rounded-full">{s}</span>
              ))}
            </div>
          )}
        </Card>

        {/* Chat CTA */}
        <div className="col-span-2 mt-2">
          <button
            onClick={openChat}
            className="w-full py-4 border border-dashed border-indigo-700/60 rounded-xl text-indigo-400 hover:bg-indigo-900/20 transition-colors flex items-center justify-center gap-3 text-sm"
          >
            <span className="text-xl">◈</span>
            <div className="text-left">
              <div className="font-medium">Open Chat with {agent.name}</div>
              <div className="text-xs text-indigo-500/70 mt-0.5">Navigate to the Chat tab to start or continue a conversation</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-5">
      <h3 className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-3">{title}</h3>
      {children}
    </div>
  );
}

function StatRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs py-1.5 border-b border-gray-800/60 last:border-0">
      <span className="text-gray-500">{label}</span>
      <span className={`text-gray-300 ${mono ? 'font-mono text-[10px]' : ''}`}>{value}</span>
    </div>
  );
}
