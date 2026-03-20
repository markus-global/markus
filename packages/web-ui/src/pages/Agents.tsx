import { useEffect, useState } from 'react';
import { api, wsClient, type AgentInfo } from '../api.ts';
import { AgentProfile } from './AgentProfile.tsx';
import { ConfirmModal } from '../components/ConfirmModal.tsx';

export function Agents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<{ id: string; name: string } | null>(null);

  const refresh = () => {
    api.agents.list().then((d) => setAgents(d.agents)).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 10000);
    const unsub = wsClient.on('agent:update', () => refresh());
    return () => { clearInterval(i); unsub(); };
  }, []);

  const selectedAgent = agents.find(a => a.id === selectedId);

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-6 h-14 flex items-center border-b border-border-default bg-surface-secondary shrink-0">
        <h2 className="text-lg font-semibold">Digital Employees</h2>
        <span className="ml-3 text-xs text-gray-500">{agents.length} agents</span>
      </div>

      <div className="flex-1 overflow-hidden flex">
        {/* Agent list */}
        <div className={`overflow-y-auto border-r border-border-default ${selectedId ? 'w-80 shrink-0' : 'flex-1'}`}>
          <table className="w-full text-sm">
            <thead className="bg-surface-secondary/80 text-gray-400 text-left sticky top-0 z-10">
              <tr>
                <th className="px-5 py-3 font-medium">Name</th>
                {!selectedId && <th className="px-5 py-3 font-medium">Role</th>}
                <th className="px-5 py-3 font-medium">Status</th>
                {!selectedId && <th className="px-5 py-3 font-medium">ID</th>}
                <th className="px-5 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {agents.map((a) => (
                <tr
                  key={a.id}
                  className={`hover:bg-surface-secondary/50 cursor-pointer transition-colors ${selectedId === a.id ? 'bg-brand-900/20 border-l-2 border-brand-500' : ''}`}
                  onClick={() => setSelectedId(selectedId === a.id ? null : a.id)}
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-brand-700 flex items-center justify-center text-xs font-bold shrink-0">
                        {a.name[0]}
                      </div>
                      <div>
                        <div className="font-medium leading-tight">{a.name}</div>
                        {a.agentRole === 'manager' && (
                          <span className="text-[10px] text-amber-400">★ Manager</span>
                        )}
                      </div>
                    </div>
                  </td>
                  {!selectedId && (
                    <td className="px-5 py-3 text-gray-400 text-xs">{a.role}</td>
                  )}
                  <td className="px-5 py-3">
                    <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${
                      a.status === 'idle' ? 'bg-green-400' :
                      a.status === 'working' ? 'bg-brand-400 animate-pulse' :
                      'bg-gray-500'
                    }`} />
                    <span className="text-xs text-gray-400">{a.status}</span>
                  </td>
                  {!selectedId && (
                    <td className="px-5 py-3 text-gray-500 font-mono text-[11px]">{a.id}</td>
                  )}
                  <td className="px-5 py-3">
                    <div className="flex gap-2 items-center" onClick={(e) => e.stopPropagation()}>
                      {a.status === 'offline'
                        ? <button onClick={() => api.agents.start(a.id).then(refresh)} className="text-xs text-green-400 hover:text-green-300">Start</button>
                        : <button onClick={() => api.agents.stop(a.id).then(refresh)} className="text-xs text-gray-400 hover:text-gray-300">Stop</button>
                      }
                      <button
                        onClick={() => setPendingRemove({ id: a.id, name: a.name })}
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {agents.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-gray-500">
                    No agents found. Go to the Team tab to hire agents.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Profile panel */}
        {selectedId && selectedAgent && (
          <div className="flex-1 overflow-y-auto">
            <AgentProfile agentId={selectedId} onBack={() => setSelectedId(null)} inline />
          </div>
        )}
      </div>

      {pendingRemove && (
        <ConfirmModal
          title={`Remove "${pendingRemove.name}"?`}
          message="This agent will be permanently removed from the organization."
          confirmLabel="Remove Agent"
          onConfirm={() => {
            api.agents.remove(pendingRemove.id).then(() => {
              refresh();
              if (selectedId === pendingRemove.id) setSelectedId(null);
            });
            setPendingRemove(null);
          }}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </div>
  );
}
