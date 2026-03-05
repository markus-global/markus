import { useState, useEffect, useCallback } from 'react';
import { api, type AnnouncementInfo, type GovernancePolicyInfo } from '../api.ts';

export function GovernancePage() {
  const [status, setStatus] = useState<{ globalPaused: boolean; emergencyMode: boolean } | null>(null);
  const [announcements, setAnnouncements] = useState<AnnouncementInfo[]>([]);
  const [policy, setPolicy] = useState<GovernancePolicyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');

  // New announcement form
  const [showNewAnn, setShowNewAnn] = useState(false);
  const [annTitle, setAnnTitle] = useState('');
  const [annMessage, setAnnMessage] = useState('');
  const [annPriority, setAnnPriority] = useState('normal');

  // Pause reason
  const [pauseReason, setPauseReason] = useState('');
  const [showPauseModal, setShowPauseModal] = useState(false);

  // Policy edit
  const [showPolicyEdit, setShowPolicyEdit] = useState(false);
  const [policyTier, setPolicyTier] = useState('auto');
  const [policyMaxTasks, setPolicyMaxTasks] = useState(10);
  const [policyRequireReq, setPolicyRequireReq] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [s, a, p] = await Promise.all([
        api.governance.getSystemStatus(),
        api.governance.getAnnouncements(),
        api.governance.getPolicy(),
      ]);
      setStatus(s);
      setAnnouncements(a.announcements);
      setPolicy(p.policy);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const flash = (msg: string) => { setActionMsg(msg); setTimeout(() => setActionMsg(''), 3000); };

  const handlePause = async () => {
    try {
      await api.governance.pauseAll(pauseReason || undefined);
      flash('All agents paused');
      setShowPauseModal(false);
      setPauseReason('');
      refresh();
    } catch (e) { flash(`Error: ${e}`); }
  };

  const handleResume = async () => {
    try {
      await api.governance.resumeAll();
      flash('All agents resumed');
      refresh();
    } catch (e) { flash(`Error: ${e}`); }
  };

  const handleEmergencyStop = async () => {
    if (!confirm('EMERGENCY STOP will terminate all agents immediately. Continue?')) return;
    try {
      await api.governance.emergencyStop('Manual emergency stop from UI');
      flash('EMERGENCY STOP executed');
      refresh();
    } catch (e) { flash(`Error: ${e}`); }
  };

  const handleCreateAnnouncement = async () => {
    if (!annTitle.trim()) return;
    try {
      await api.governance.createAnnouncement({ title: annTitle, message: annMessage, priority: annPriority, scope: 'all' });
      setShowNewAnn(false);
      setAnnTitle('');
      setAnnMessage('');
      flash('Announcement created');
      refresh();
    } catch (e) { flash(`Error: ${e}`); }
  };

  const handleSavePolicy = async () => {
    try {
      const p: GovernancePolicyInfo = { defaultApprovalTier: policyTier, maxTasksPerAgent: policyMaxTasks, requireRequirement: policyRequireReq };
      await api.governance.setPolicy(p);
      flash('Policy updated');
      setShowPolicyEdit(false);
      refresh();
    } catch (e) { flash(`Error: ${e}`); }
  };

  if (loading) return <div className="flex-1 flex items-center justify-center text-gray-500">Loading…</div>;

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Governance</h2>
          <p className="text-xs text-gray-500">System controls, announcements, and governance policy</p>
        </div>
        {actionMsg && (
          <div className="px-3 py-1.5 bg-emerald-900/50 text-emerald-300 text-xs rounded-lg">{actionMsg}</div>
        )}
      </div>

      <div className="p-6 space-y-6 max-w-5xl">
        {/* System Status & Controls */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-4">System Status</h3>
          <div className="flex items-center gap-4 mb-5">
            <StatusBadge label="Global" active={!status?.globalPaused} activeText="Running" inactiveText="Paused" />
            <StatusBadge label="Emergency" active={!status?.emergencyMode} activeText="Normal" inactiveText="ACTIVE" danger />
          </div>

          <div className="flex flex-wrap gap-3">
            {status?.globalPaused ? (
              <button onClick={handleResume} className="btn-primary text-sm px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500">
                ▶ Resume All Agents
              </button>
            ) : (
              <button onClick={() => setShowPauseModal(true)} className="text-sm px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white">
                ⏸ Pause All Agents
              </button>
            )}
            <button onClick={handleEmergencyStop} className="text-sm px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-white">
              ⚠ Emergency Stop
            </button>
          </div>
        </section>

        {/* Governance Policy */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-300">Governance Policy</h3>
            <button onClick={() => { setShowPolicyEdit(!showPolicyEdit); if (policy) { setPolicyTier(policy.defaultApprovalTier); setPolicyMaxTasks(policy.maxTasksPerAgent ?? 10); setPolicyRequireReq(policy.requireRequirement ?? true); } }} className="text-xs text-indigo-400 hover:text-indigo-300">
              {showPolicyEdit ? 'Cancel' : 'Edit'}
            </button>
          </div>

          {showPolicyEdit ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Default Approval Tier</label>
                <select value={policyTier} onChange={e => setPolicyTier(e.target.value)} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 w-48">
                  <option value="auto">Auto (no approval)</option>
                  <option value="manager">Manager Approval</option>
                  <option value="human">Human Approval</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Max Tasks per Agent</label>
                <input type="number" value={policyMaxTasks} onChange={e => setPolicyMaxTasks(Number(e.target.value))} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 w-32" />
              </div>
              <div className="flex items-center gap-3">
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={policyRequireReq} onChange={e => setPolicyRequireReq(e.target.checked)} className="sr-only peer" />
                  <div className="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600" />
                </label>
                <div>
                  <span className="text-xs text-gray-300">Require Requirement for Tasks</span>
                  <p className="text-[10px] text-gray-500">Top-level tasks must link to an approved requirement</p>
                </div>
              </div>
              <button onClick={handleSavePolicy} className="btn-primary text-sm px-4 py-2 rounded-lg">Save Policy</button>
            </div>
          ) : policy ? (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Approval Tier:</span>
                <span className="ml-2 text-gray-200">{policy.defaultApprovalTier}</span>
              </div>
              <div>
                <span className="text-gray-500">Max Tasks/Agent:</span>
                <span className="ml-2 text-gray-200">{policy.maxTasksPerAgent ?? '—'}</span>
              </div>
              <div className="col-span-2">
                <span className="text-gray-500">Require Requirement:</span>
                <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${
                  policy.requireRequirement !== false
                    ? 'bg-indigo-900/40 text-indigo-300'
                    : 'bg-gray-700 text-gray-400'
                }`}>{policy.requireRequirement !== false ? 'Enabled' : 'Disabled'}</span>
              </div>
              {policy.rules && policy.rules.length > 0 && (
                <div className="col-span-2">
                  <span className="text-gray-500">Rules:</span>
                  <div className="mt-1 space-y-1">
                    {policy.rules.map((r, i) => (
                      <div key={i} className="text-xs bg-gray-800 rounded px-2 py-1 text-gray-400">
                        When <code className="text-amber-300">{r.condition}</code> → <span className="text-indigo-300">{r.approvalTier}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No governance policy configured. Click Edit to set one.</p>
          )}
        </section>

        {/* Announcements */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-300">System Announcements</h3>
            <button onClick={() => setShowNewAnn(!showNewAnn)} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white">
              + New Announcement
            </button>
          </div>

          {showNewAnn && (
            <div className="mb-4 p-4 bg-gray-800 rounded-lg space-y-3">
              <input value={annTitle} onChange={e => setAnnTitle(e.target.value)} placeholder="Title" className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200" />
              <textarea value={annMessage} onChange={e => setAnnMessage(e.target.value)} placeholder="Message (optional)" className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200 h-20 resize-none" />
              <div className="flex items-center gap-3">
                <select value={annPriority} onChange={e => setAnnPriority(e.target.value)} className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200">
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
                <button onClick={handleCreateAnnouncement} className="btn-primary text-sm px-4 py-2 rounded-lg">Publish</button>
                <button onClick={() => setShowNewAnn(false)} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
              </div>
            </div>
          )}

          {announcements.length === 0 ? (
            <p className="text-sm text-gray-500">No announcements.</p>
          ) : (
            <div className="space-y-2">
              {announcements.map(a => (
                <div key={a.id} className="flex items-start gap-3 p-3 bg-gray-800/50 rounded-lg">
                  <PriorityDot priority={a.priority} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-200">{a.title}</div>
                    {a.message && <div className="text-xs text-gray-400 mt-0.5">{a.message}</div>}
                    <div className="text-[10px] text-gray-600 mt-1">{new Date(a.createdAt).toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Pause Modal */}
      {showPauseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-96 space-y-4">
            <h3 className="text-base font-semibold text-white">Pause All Agents</h3>
            <p className="text-sm text-gray-400">All agents will be paused. They will stop processing tasks until resumed.</p>
            <input value={pauseReason} onChange={e => setPauseReason(e.target.value)} placeholder="Reason (optional)" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowPauseModal(false)} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
              <button onClick={handlePause} className="text-sm px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white">Pause All</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ label, active, activeText, inactiveText, danger }: { label: string; active: boolean; activeText: string; inactiveText: string; danger?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500">{label}:</span>
      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
        active
          ? 'bg-emerald-900/40 text-emerald-400'
          : danger
            ? 'bg-red-900/40 text-red-400 animate-pulse'
            : 'bg-amber-900/40 text-amber-400'
      }`}>
        {active ? activeText : inactiveText}
      </span>
    </div>
  );
}

function PriorityDot({ priority }: { priority: string }) {
  const color = priority === 'critical' ? 'bg-red-500' : priority === 'high' ? 'bg-amber-500' : priority === 'normal' ? 'bg-blue-500' : 'bg-gray-500';
  return <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${color}`} />;
}
