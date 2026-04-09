import { useState, useEffect, useCallback } from 'react';
import { api, type AnnouncementInfo, type GovernancePolicyInfo, type ApprovalInfo } from '../api.ts';

export function GovernancePage() {
  const [status, setStatus] = useState<{ globalPaused: boolean; emergencyMode: boolean } | null>(null);
  const [announcements, setAnnouncements] = useState<AnnouncementInfo[]>([]);
  const [policy, setPolicy] = useState<GovernancePolicyInfo | null>(null);
  const [approvals, setApprovals] = useState<ApprovalInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [approvalFilter, setApprovalFilter] = useState<'pending' | 'all'>('pending');

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
      const [s, a, p, apr] = await Promise.all([
        api.governance.getSystemStatus(),
        api.governance.getAnnouncements(),
        api.governance.getPolicy(),
        api.approvals.list(),
      ]);
      setStatus(s);
      setAnnouncements(a.announcements);
      setPolicy(p.policy);
      setApprovals(apr.approvals);
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

  if (loading) return <div className="flex-1 flex items-center justify-center text-fg-tertiary">Loading…</div>;

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-surface-secondary border-b border-border-default px-6 h-14 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-fg-primary">Governance</h2>
          <p className="text-xs text-fg-tertiary">System controls, announcements, and governance policy</p>
        </div>
        {actionMsg && (
          <div className="px-3 py-1.5 bg-green-500/10 text-green-600 text-xs rounded-lg">{actionMsg}</div>
        )}
      </div>

      <div className="p-6 space-y-6 max-w-5xl">
        {/* System Status & Controls */}
        <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
          <h3 className="text-sm font-semibold text-fg-secondary mb-4">System Status</h3>
          <div className="flex items-center gap-4 mb-5">
            <StatusBadge label="Global" active={!status?.globalPaused} activeText="Running" inactiveText="Paused" />
            <StatusBadge label="Emergency" active={!status?.emergencyMode} activeText="Normal" inactiveText="ACTIVE" danger />
          </div>

          <div className="flex flex-wrap gap-3">
            {status?.globalPaused ? (
              <button onClick={handleResume} className="btn-primary text-sm px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500">
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
        <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-fg-secondary">Governance Policy</h3>
            <button onClick={() => { setShowPolicyEdit(!showPolicyEdit); if (policy) { setPolicyTier(policy.defaultApprovalTier); setPolicyMaxTasks(policy.maxTasksPerAgent ?? 10); setPolicyRequireReq(policy.requireRequirement ?? true); } }} className="text-xs text-brand-500 hover:text-brand-500">
              {showPolicyEdit ? 'Cancel' : 'Edit'}
            </button>
          </div>

          {showPolicyEdit ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-fg-tertiary block mb-1">Default Approval Tier</label>
                <select value={policyTier} onChange={e => setPolicyTier(e.target.value)} className="bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary w-48">
                  <option value="auto">Auto (no approval)</option>
                  <option value="manager">Manager Approval</option>
                  <option value="human">Human Approval</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-fg-tertiary block mb-1">Max Tasks per Agent</label>
                <input type="number" value={policyMaxTasks} onChange={e => setPolicyMaxTasks(Number(e.target.value))} className="bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary w-32" />
              </div>
              <div className="flex items-center gap-3">
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={policyRequireReq} onChange={e => setPolicyRequireReq(e.target.checked)} className="sr-only peer" />
                  <div className="w-9 h-5 bg-surface-overlay peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-brand-600" />
                </label>
                <div>
                  <span className="text-xs text-fg-secondary">Require Requirement for Tasks</span>
                  <p className="text-[10px] text-fg-tertiary">Top-level tasks must link to an approved requirement</p>
                </div>
              </div>
              <button onClick={handleSavePolicy} className="btn-primary text-sm px-4 py-2 rounded-lg">Save Policy</button>
            </div>
          ) : policy ? (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-fg-tertiary">Approval Tier:</span>
                <span className="ml-2 text-fg-primary">{policy.defaultApprovalTier}</span>
              </div>
              <div>
                <span className="text-fg-tertiary">Max Tasks/Agent:</span>
                <span className="ml-2 text-fg-primary">{policy.maxTasksPerAgent ?? '—'}</span>
              </div>
              <div className="col-span-2">
                <span className="text-fg-tertiary">Require Requirement:</span>
                <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${
                  policy.requireRequirement !== false
                    ? 'bg-brand-500/10 text-brand-500'
                    : 'bg-surface-overlay text-fg-secondary'
                }`}>{policy.requireRequirement !== false ? 'Enabled' : 'Disabled'}</span>
              </div>
              {policy.rules && policy.rules.length > 0 && (
                <div className="col-span-2">
                  <span className="text-fg-tertiary">Rules:</span>
                  <div className="mt-1 space-y-1">
                    {policy.rules.map((r, i) => (
                      <div key={i} className="text-xs bg-surface-elevated rounded px-2 py-1 text-fg-secondary">
                        When <code className="text-amber-600">{r.condition}</code> → <span className="text-brand-500">{r.approvalTier}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-fg-tertiary">No governance policy configured. Click Edit to set one.</p>
          )}
        </section>

        {/* Approval Queue */}
        <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-fg-secondary">
              Approval Queue
              {approvals.filter(a => a.status === 'pending').length > 0 && (
                <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-600">
                  {approvals.filter(a => a.status === 'pending').length} pending
                </span>
              )}
            </h3>
            <div className="flex gap-1 text-xs">
              <button
                onClick={() => setApprovalFilter('pending')}
                className={`px-2.5 py-1 rounded-md transition-colors ${approvalFilter === 'pending' ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary hover:text-fg-secondary'}`}
              >Pending</button>
              <button
                onClick={() => setApprovalFilter('all')}
                className={`px-2.5 py-1 rounded-md transition-colors ${approvalFilter === 'all' ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary hover:text-fg-secondary'}`}
              >All</button>
            </div>
          </div>

          {(() => {
            const filtered = approvalFilter === 'pending'
              ? approvals.filter(a => a.status === 'pending')
              : approvals;
            if (filtered.length === 0) return (
              <p className="text-sm text-fg-tertiary">{approvalFilter === 'pending' ? 'No pending approvals.' : 'No approval requests.'}</p>
            );

            const handleRespond = async (id: string, approved: boolean) => {
              setRespondingId(id);
              try {
                const { approval } = await api.approvals.respond(id, approved);
                setApprovals(prev => prev.map(a => a.id === id ? approval : a));
                flash(approved ? 'Approved' : 'Rejected');
                window.dispatchEvent(new CustomEvent('markus:notifications-changed'));
              } catch (e) { flash(`Error: ${e}`); }
              setRespondingId(null);
            };

            return (
              <div className="space-y-2">
                {filtered.map(a => (
                  <div key={a.id} className={`p-3 rounded-lg border transition-colors ${
                    a.status === 'pending' ? 'bg-surface-elevated/50 border-amber-500/20' : 'bg-surface-elevated/30 border-border-default/50 opacity-60'
                  }`}>
                    <div className="flex items-start gap-3">
                      <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                        a.status === 'pending' ? 'bg-amber-500' : a.status === 'approved' ? 'bg-green-500' : 'bg-red-500'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-fg-primary">{a.title}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            a.type === 'action' ? 'bg-blue-500/10 text-blue-500' : 'bg-surface-overlay text-fg-tertiary'
                          }`}>{a.type}</span>
                        </div>
                        <p className="text-xs text-fg-secondary mt-0.5">{a.description}</p>
                        <div className="flex items-center gap-3 mt-1 text-[10px] text-fg-tertiary">
                          <span>From: {a.agentName}</span>
                          <span>{new Date(a.requestedAt).toLocaleString()}</span>
                          {a.respondedBy && <span>Responded by: {a.respondedBy}</span>}
                        </div>
                      </div>
                      {a.status === 'pending' && (
                        <div className="flex gap-2 shrink-0">
                          <button
                            disabled={respondingId === a.id}
                            onClick={() => handleRespond(a.id, true)}
                            className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-500 disabled:opacity-50 transition-colors"
                          >Approve</button>
                          <button
                            disabled={respondingId === a.id}
                            onClick={() => handleRespond(a.id, false)}
                            className="px-3 py-1.5 text-xs font-medium border border-border-default text-fg-secondary rounded-lg hover:bg-surface-overlay disabled:opacity-50 transition-colors"
                          >Reject</button>
                        </div>
                      )}
                      {a.status !== 'pending' && (
                        <span className={`px-2 py-1 text-[10px] rounded-full font-medium shrink-0 ${
                          a.status === 'approved' ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-500'
                        }`}>{a.status}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </section>

        {/* Announcements */}
        <section className="bg-surface-secondary border border-border-default rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-fg-secondary">System Announcements</h3>
            <button onClick={() => setShowNewAnn(!showNewAnn)} className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white">
              + New Announcement
            </button>
          </div>

          {showNewAnn && (
            <div className="mb-4 p-4 bg-surface-elevated rounded-lg space-y-3">
              <input value={annTitle} onChange={e => setAnnTitle(e.target.value)} placeholder="Title" className="w-full bg-surface-overlay border border-gray-600 rounded-lg px-3 py-2 text-sm text-fg-primary" />
              <textarea value={annMessage} onChange={e => setAnnMessage(e.target.value)} placeholder="Message (optional)" className="w-full bg-surface-overlay border border-gray-600 rounded-lg px-3 py-2 text-sm text-fg-primary h-20 resize-none" />
              <div className="flex items-center gap-3">
                <select value={annPriority} onChange={e => setAnnPriority(e.target.value)} className="bg-surface-overlay border border-gray-600 rounded-lg px-3 py-2 text-sm text-fg-primary">
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
                <button onClick={handleCreateAnnouncement} className="btn-primary text-sm px-4 py-2 rounded-lg">Publish</button>
                <button onClick={() => setShowNewAnn(false)} className="text-sm text-fg-tertiary hover:text-fg-secondary">Cancel</button>
              </div>
            </div>
          )}

          {announcements.length === 0 ? (
            <p className="text-sm text-fg-tertiary">No announcements.</p>
          ) : (
            <div className="space-y-2">
              {announcements.map(a => (
                <div key={a.id} className="flex items-start gap-3 p-3 bg-surface-elevated/50 rounded-lg">
                  <PriorityDot priority={a.priority} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-fg-primary">{a.title}</div>
                    {a.message && <div className="text-xs text-fg-secondary mt-0.5">{a.message}</div>}
                    <div className="text-[10px] text-fg-tertiary mt-1">{new Date(a.createdAt).toLocaleString()}</div>
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
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 w-96 space-y-4">
            <h3 className="text-base font-semibold text-fg-primary">Pause All Agents</h3>
            <p className="text-sm text-fg-secondary">All agents will be paused. They will stop processing tasks until resumed.</p>
            <input value={pauseReason} onChange={e => setPauseReason(e.target.value)} placeholder="Reason (optional)" className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-fg-primary" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowPauseModal(false)} className="text-sm text-fg-tertiary hover:text-fg-secondary">Cancel</button>
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
      <span className="text-xs text-fg-tertiary">{label}:</span>
      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
        active
          ? 'bg-green-500/10 text-green-600'
          : danger
            ? 'bg-red-500/10 text-red-500 animate-pulse'
            : 'bg-amber-500/10 text-amber-600'
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
