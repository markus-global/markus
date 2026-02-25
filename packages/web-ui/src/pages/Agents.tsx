import { useEffect, useState } from 'react';
import { api, wsClient, type AgentInfo } from '../api.ts';
import { AgentProfile } from './AgentProfile.tsx';

export function Agents() {
  const [profileAgentId, setProfileAgentId] = useState<string | null>(null);

  if (profileAgentId) {
    return <AgentProfile agentId={profileAgentId} onBack={() => setProfileAgentId(null)} />;
  }

  return <AgentList onViewProfile={setProfileAgentId} />;
}

function AgentList({ onViewProfile }: { onViewProfile: (id: string) => void }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = () => {
    api.agents.list().then((d) => setAgents(d.agents)).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 10000);
    const unsub = wsClient.on('agent:update', () => refresh());
    return () => { clearInterval(i); unsub(); };
  }, []);

  const detail = agents.find((a) => a.id === selected);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-7 h-15 flex items-center border-b border-gray-800 bg-gray-900">
        <h2 className="text-lg font-semibold">Digital Employees</h2>
      </div>
      <div className="p-7 flex gap-6">
        <div className={`overflow-hidden rounded-xl border border-gray-800 ${selected ? 'flex-1' : 'w-full'}`}>
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-left">
              <tr>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Role</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">ID</th>
                <th className="px-5 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {agents.map((a) => (
                <tr
                  key={a.id}
                  className={`hover:bg-gray-900/50 cursor-pointer ${selected === a.id ? 'bg-gray-800/60' : ''}`}
                  onClick={() => setSelected(selected === a.id ? null : a.id)}
                >
                  <td className="px-5 py-3 font-medium">{a.name}{a.agentRole === 'manager' ? <span className="ml-1.5 text-xs text-amber-400">★ Manager</span> : ''}</td>
                  <td className="px-5 py-3 text-gray-400">{a.role}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-block w-2 h-2 rounded-full mr-2 ${
                      a.status === 'idle' ? 'bg-green-400' :
                      a.status === 'working' ? 'bg-indigo-400 animate-pulse' :
                      'bg-gray-500'
                    }`} />
                    {a.status}
                  </td>
                  <td className="px-5 py-3 text-gray-500 font-mono text-xs">{a.id}</td>
                  <td className="px-5 py-3">
                    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => onViewProfile(a.id)} className="text-xs text-indigo-400 hover:text-indigo-300">Profile</button>
                      <button onClick={() => api.agents.start(a.id).then(refresh)} className="text-xs text-green-400 hover:text-green-300">Start</button>
                      <button onClick={() => api.agents.stop(a.id).then(refresh)} className="text-xs text-gray-400 hover:text-gray-300">Stop</button>
                      <button onClick={() => { if (confirm('Remove this agent?')) api.agents.remove(a.id).then(refresh); }} className="text-xs text-red-400 hover:text-red-300">Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
              {agents.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-10 text-center text-gray-500">No agents found.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {detail && (
          <div className="w-80 shrink-0 border border-gray-800 rounded-xl bg-gray-900/50 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-base">{detail.name}</h3>
              <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-gray-300 text-sm">&times;</button>
            </div>
            <div className="space-y-3 text-sm">
              <InfoRow label="Role" value={detail.role} />
              <InfoRow label="Status">
                <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${
                  detail.status === 'idle' ? 'bg-green-400' :
                  detail.status === 'working' ? 'bg-indigo-400' :
                  'bg-gray-500'
                }`} />
                {detail.status}
              </InfoRow>
              <InfoRow label="Agent ID">
                <span className="font-mono text-xs text-gray-400">{detail.id}</span>
              </InfoRow>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-200">{children ?? value}</span>
    </div>
  );
}
