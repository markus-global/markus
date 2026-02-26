import { useEffect, useState } from 'react';
import { api, wsClient, type AgentInfo, type TaskInfo, type RoleInfo } from '../api.ts';
import { ConfirmModal } from '../components/ConfirmModal.tsx';

export function Dashboard() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [board, setBoard] = useState<Record<string, TaskInfo[]>>({});
  const [showHire, setShowHire] = useState(false);
  const [hireName, setHireName] = useState('');
  const [hireRole, setHireRole] = useState('');
  const [pendingRemove, setPendingRemove] = useState<{ id: string; name: string } | null>(null);

  const refresh = () => {
    api.agents.list().then((d) => setAgents(d.agents)).catch(() => {});
    api.roles.list().then((d) => setRoles(d.roles)).catch(() => {});
    api.tasks.board().then((d) => setBoard(d.board)).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 15000);
    const unsub = wsClient.on('*', () => refresh());
    return () => { clearInterval(i); unsub(); };
  }, []);

  const hire = async () => {
    if (!hireName || !hireRole) return;
    await api.agents.create(hireName, hireRole);
    setShowHire(false);
    setHireName('');
    refresh();
  };

  const pending = (board['pending']?.length ?? 0) + (board['assigned']?.length ?? 0);
  const completed = board['completed']?.length ?? 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center justify-between px-7 h-15 border-b border-gray-800 bg-gray-900">
        <h2 className="text-lg font-semibold">Dashboard</h2>
        <button onClick={() => setShowHire(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition-colors">
          + Hire Agent
        </button>
      </div>

      <div className="p-7 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: 'Active Agents', value: agents.length },
            { label: 'Role Templates', value: roles.length },
            { label: 'Pending Tasks', value: pending },
            { label: 'Completed', value: completed },
          ].map((s) => (
            <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="text-3xl font-bold">{s.value}</div>
              <div className="text-sm text-gray-500 mt-1">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Agent Cards */}
        <h3 className="text-base font-semibold">Digital Employees</h3>
        {agents.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center text-gray-500">
            No digital employees yet. Click "Hire Agent" to get started.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.map((a) => (
              <div key={a.id} className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-indigo-500/50 transition-colors">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-semibold">{a.name}{a.agentRole === 'manager' ? ' ★' : ''}</div>
                    <div className="text-sm text-gray-500">{a.role}{a.agentRole === 'manager' ? ' · Manager' : ''}</div>
                  </div>
                  <StatusBadge status={a.status} />
                </div>
                <div className="flex gap-2 mt-4 pt-4 border-t border-gray-800">
                  <button onClick={() => { api.agents.start(a.id).then(refresh); }} className="px-3 py-1.5 text-xs border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors">Start</button>
                  <button onClick={() => { api.agents.stop(a.id).then(refresh); }} className="px-3 py-1.5 text-xs border border-gray-700 rounded-lg hover:border-gray-500 transition-colors">Stop</button>
                  <button onClick={() => setPendingRemove({ id: a.id, name: a.name })} className="px-3 py-1.5 text-xs text-red-400 border border-transparent hover:border-red-500/30 rounded-lg transition-colors">Remove</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {pendingRemove && (
        <ConfirmModal
          title={`Remove "${pendingRemove.name}"?`}
          message="This agent will be permanently removed from the organization."
          confirmLabel="Remove Agent"
          onConfirm={() => { api.agents.remove(pendingRemove.id).then(refresh); setPendingRemove(null); }}
          onCancel={() => setPendingRemove(null)}
        />
      )}

      {/* Hire Modal */}
      {showHire && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowHire(false)}>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-7 w-[440px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-5">Hire a Digital Employee</h3>
            <label className="block text-sm text-gray-400 mb-1.5">Name</label>
            <input value={hireName} onChange={(e) => setHireName(e.target.value)} placeholder="e.g. Alice"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none" />
            <label className="block text-sm text-gray-400 mb-1.5">Role</label>
            <select value={hireRole} onChange={(e) => setHireRole(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-6 focus:border-indigo-500 outline-none">
              <option value="">Select a role...</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name.replace(/-/g, ' ')}</option>)}
            </select>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowHire(false)} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800">Cancel</button>
              <button onClick={hire} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Hire</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: 'bg-green-500/15 text-green-400',
    working: 'bg-indigo-500/15 text-indigo-400',
    offline: 'bg-gray-500/15 text-gray-400',
    error: 'bg-red-500/15 text-red-400',
  };
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? colors['offline']}`}>
      {status}
    </span>
  );
}
