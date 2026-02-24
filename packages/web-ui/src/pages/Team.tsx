import { useEffect, useState } from 'react';
import { api, wsClient, type AgentInfo, type HumanUserInfo } from '../api.ts';

export function TeamPage() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [humans, setHumans] = useState<HumanUserInfo[]>([]);
  const [showAddHuman, setShowAddHuman] = useState(false);
  const [showHire, setShowHire] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);

  const [humanName, setHumanName] = useState('');
  const [humanRole, setHumanRole] = useState<string>('member');
  const [humanEmail, setHumanEmail] = useState('');

  const [hireName, setHireName] = useState('');
  const [hireRole, setHireRole] = useState('');
  const [hireAgentRole, setHireAgentRole] = useState<'worker' | 'manager'>('worker');

  const refresh = () => {
    api.agents.list().then(d => setAgents(d.agents)).catch(() => {});
    api.users.list().then(d => setHumans(d.users)).catch(() => {});
    api.roles.list().then(d => setRoles(d.roles)).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 15000);
    const unsub = wsClient.on('*', () => refresh());
    return () => { clearInterval(i); unsub(); };
  }, []);

  const addHuman = async () => {
    if (!humanName) return;
    await api.users.create(humanName, humanRole, undefined, humanEmail || undefined);
    setShowAddHuman(false);
    setHumanName('');
    setHumanEmail('');
    refresh();
  };

  const hire = async () => {
    if (!hireName || !hireRole) return;
    await api.agents.create(hireName, hireRole, hireAgentRole);
    setShowHire(false);
    setHireName('');
    refresh();
  };

  const manager = agents.find(a => a.agentRole === 'manager');

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center justify-between px-7 h-15 border-b border-gray-800 bg-gray-900">
        <h2 className="text-lg font-semibold">Organization Team</h2>
        <div className="flex gap-2">
          <button onClick={() => setShowAddHuman(true)} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors">
            + Add Human
          </button>
          <button onClick={() => setShowHire(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition-colors">
            + Hire Agent
          </button>
        </div>
      </div>

      <div className="p-7 space-y-8">
        {/* Manager Section */}
        <section>
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Organization Manager</h3>
          {manager ? (
            <div className="bg-gradient-to-r from-indigo-900/30 to-purple-900/30 border border-indigo-500/30 rounded-xl p-5 flex items-center gap-4">
              <div className="w-12 h-12 bg-indigo-600 rounded-xl flex items-center justify-center text-xl font-bold shrink-0">
                {manager.name.charAt(0)}
              </div>
              <div className="flex-1">
                <div className="font-semibold text-lg">{manager.name}</div>
                <div className="text-sm text-gray-400">{manager.role} &middot; AI Manager</div>
              </div>
              <StatusDot status={manager.status} />
            </div>
          ) : (
            <div className="border border-dashed border-gray-700 rounded-xl p-8 text-center text-gray-500 text-sm">
              No Organization Manager assigned yet. Hire an agent with the "manager" role to enable smart message routing and team coordination.
            </div>
          )}
        </section>

        {/* AI Agents Section */}
        <section>
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            AI Employees ({agents.filter(a => a.agentRole !== 'manager').length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.filter(a => a.agentRole !== 'manager').map(a => (
              <div key={a.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center text-sm font-bold text-indigo-400 shrink-0">
                    {a.name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{a.name}</div>
                    <div className="text-xs text-gray-500 truncate">{a.role}</div>
                  </div>
                  <StatusDot status={a.status} />
                </div>
                <div className="flex gap-2 mt-3 pt-3 border-t border-gray-800">
                  <button onClick={() => api.agents.start(a.id).then(refresh)} className="text-xs text-indigo-400 hover:text-indigo-300">Start</button>
                  <button onClick={() => api.agents.stop(a.id).then(refresh)} className="text-xs text-gray-400 hover:text-gray-300">Stop</button>
                  <button onClick={() => { if (confirm('Remove this agent?')) api.agents.remove(a.id).then(refresh); }} className="text-xs text-red-400 hover:text-red-300 ml-auto">Remove</button>
                </div>
              </div>
            ))}
            {agents.filter(a => a.agentRole !== 'manager').length === 0 && (
              <div className="col-span-full bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500 text-sm">
                No AI employees yet.
              </div>
            )}
          </div>
        </section>

        {/* Human Members Section */}
        <section>
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Human Members ({humans.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {humans.map(h => (
              <div key={h.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center text-sm font-bold text-emerald-400 shrink-0">
                    {h.name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{h.name}</div>
                    <div className="text-xs text-gray-500 truncate">{h.email || 'No email'}</div>
                  </div>
                  <RoleBadge role={h.role} />
                </div>
                <div className="flex gap-2 mt-3 pt-3 border-t border-gray-800 justify-end">
                  <button onClick={() => { if (confirm('Remove this user?')) api.users.remove(h.id).then(refresh); }} className="text-xs text-red-400 hover:text-red-300">Remove</button>
                </div>
              </div>
            ))}
            {humans.length === 0 && (
              <div className="col-span-full bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500 text-sm">
                No human members registered. Add a human member to enable identity-aware conversations.
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Add Human Modal */}
      {showAddHuman && (
        <Modal onClose={() => setShowAddHuman(false)} title="Add Human Team Member">
          <label className="block text-sm text-gray-400 mb-1.5">Name</label>
          <input value={humanName} onChange={e => setHumanName(e.target.value)} placeholder="e.g. John"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none" />
          <label className="block text-sm text-gray-400 mb-1.5">Email (optional)</label>
          <input value={humanEmail} onChange={e => setHumanEmail(e.target.value)} placeholder="john@example.com"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none" />
          <label className="block text-sm text-gray-400 mb-1.5">Role</label>
          <select value={humanRole} onChange={e => setHumanRole(e.target.value)}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-6 focus:border-indigo-500 outline-none">
            <option value="owner">Owner</option>
            <option value="admin">Admin</option>
            <option value="member">Member</option>
            <option value="guest">Guest</option>
          </select>
          <div className="flex justify-end gap-3">
            <button onClick={() => setShowAddHuman(false)} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800">Cancel</button>
            <button onClick={addHuman} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Add</button>
          </div>
        </Modal>
      )}

      {/* Hire Agent Modal */}
      {showHire && (
        <Modal onClose={() => setShowHire(false)} title="Hire a Digital Employee">
          <label className="block text-sm text-gray-400 mb-1.5">Name</label>
          <input value={hireName} onChange={e => setHireName(e.target.value)} placeholder="e.g. Alice"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none" />
          <label className="block text-sm text-gray-400 mb-1.5">Role Template</label>
          <select value={hireRole} onChange={e => setHireRole(e.target.value)}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none">
            <option value="">Select a role...</option>
            {roles.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <label className="block text-sm text-gray-400 mb-1.5">Position</label>
          <select value={hireAgentRole} onChange={e => setHireAgentRole(e.target.value as 'worker' | 'manager')}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-6 focus:border-indigo-500 outline-none">
            <option value="worker">Worker — Regular team member</option>
            <option value="manager">Manager — Organization leader (routes messages, coordinates team)</option>
          </select>
          <div className="flex justify-end gap-3">
            <button onClick={() => setShowHire(false)} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800">Cancel</button>
            <button onClick={hire} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Hire</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-7 w-[440px] shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-5">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'idle' ? 'bg-green-400' : status === 'working' ? 'bg-indigo-400 animate-pulse' : 'bg-gray-500';
  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-400">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      {status}
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const styles: Record<string, string> = {
    owner: 'bg-amber-500/15 text-amber-400',
    admin: 'bg-blue-500/15 text-blue-400',
    member: 'bg-gray-500/15 text-gray-400',
    guest: 'bg-gray-500/15 text-gray-500',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[role] ?? styles['member']}`}>
      {role}
    </span>
  );
}
