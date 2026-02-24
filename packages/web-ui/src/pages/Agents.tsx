import { useEffect, useState } from 'react';
import { api, type AgentInfo } from '../api.ts';

export function Agents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  const refresh = () => {
    api.agents.list().then((d) => setAgents(d.agents)).catch(() => {});
  };

  useEffect(() => { refresh(); const i = setInterval(refresh, 5000); return () => clearInterval(i); }, []);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-7 h-15 flex items-center border-b border-gray-800 bg-gray-900">
        <h2 className="text-lg font-semibold">Digital Employees</h2>
      </div>
      <div className="p-7">
        <div className="overflow-hidden rounded-xl border border-gray-800">
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
                <tr key={a.id} className="hover:bg-gray-900/50">
                  <td className="px-5 py-3 font-medium">{a.name}</td>
                  <td className="px-5 py-3 text-gray-400">{a.role}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-block w-2 h-2 rounded-full mr-2 ${a.status === 'idle' ? 'bg-green-400' : a.status === 'working' ? 'bg-indigo-400' : 'bg-gray-500'}`} />
                    {a.status}
                  </td>
                  <td className="px-5 py-3 text-gray-500 font-mono text-xs">{a.id}</td>
                  <td className="px-5 py-3">
                    <div className="flex gap-2">
                      <button onClick={() => api.agents.start(a.id).then(refresh)} className="text-xs text-indigo-400 hover:text-indigo-300">Start</button>
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
      </div>
    </div>
  );
}
