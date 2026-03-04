import { useState, useEffect, useCallback } from 'react';
import { api, type ReportInfo, type ReportFeedbackInfo } from '../api.ts';

export function ReportsPage() {
  const [reports, setReports] = useState<ReportInfo[]>([]);
  const [selected, setSelected] = useState<ReportInfo | null>(null);
  const [feedback, setFeedback] = useState<ReportFeedbackInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState('');

  // Generate form
  const [showGenerate, setShowGenerate] = useState(false);
  const [genPeriod, setGenPeriod] = useState('daily');
  const [genScope, setGenScope] = useState('org');

  // Feedback form
  const [showFeedback, setShowFeedback] = useState(false);
  const [fbContent, setFbContent] = useState('');
  const [fbType, setFbType] = useState('comment');

  const msg = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 3000); };

  const refresh = useCallback(async () => {
    try {
      const { reports: r } = await api.reports.list();
      setReports(r);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const loadFeedback = useCallback(async (reportId: string) => {
    try {
      const { feedback: f } = await api.reports.getFeedback(reportId);
      setFeedback(f);
    } catch { setFeedback([]); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (selected) loadFeedback(selected.id); }, [selected, loadFeedback]);

  const handleGenerate = async () => {
    try {
      const { report } = await api.reports.generate({ period: genPeriod, scope: genScope, orgId: 'default' });
      setShowGenerate(false);
      msg('Report generated');
      await refresh();
      setSelected(report);
    } catch (e) { msg(`Error: ${e}`); }
  };

  const handleAddFeedback = async () => {
    if (!selected || !fbContent.trim()) return;
    try {
      await api.reports.addFeedback(selected.id, { author: 'admin', type: fbType, content: fbContent });
      setShowFeedback(false);
      setFbContent('');
      msg('Feedback added');
      loadFeedback(selected.id);
    } catch (e) { msg(`Error: ${e}`); }
  };

  const handleApprovePlan = async () => {
    if (!selected) return;
    try {
      await api.reports.approvePlan(selected.id, { approvedBy: 'admin', comments: 'Approved via UI' });
      msg('Plan approved');
      refresh();
    } catch (e) { msg(`Error: ${e}`); }
  };

  if (loading) return <div className="flex-1 flex items-center justify-center text-gray-500">Loading…</div>;

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* Report List (left) */}
      <div className="w-80 border-r border-gray-800 flex flex-col bg-gray-950">
        <div className="p-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-300">Reports</h2>
          <button onClick={() => setShowGenerate(true)} className="text-xs px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white">Generate</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {reports.length === 0 ? (
            <p className="text-xs text-gray-600 p-3">No reports yet. Generate one to get started.</p>
          ) : reports.map(r => (
            <button
              key={r.id}
              onClick={() => setSelected(r)}
              className={`w-full text-left p-3 rounded-lg transition-colors ${
                selected?.id === r.id ? 'bg-indigo-600/20 border border-indigo-500/30' : 'hover:bg-gray-800/60'
              }`}
            >
              <div className="text-sm font-medium text-gray-200 capitalize">{r.type} Report</div>
              <div className="text-[10px] text-gray-500 mt-0.5">
                {new Date(r.generatedAt).toLocaleDateString()} · {r.scope}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Detail (right) */}
      <div className="flex-1 overflow-y-auto">
        {flash && <div className="mx-6 mt-3 px-3 py-1.5 bg-emerald-900/50 text-emerald-300 text-xs rounded-lg">{flash}</div>}

        {!selected ? (
          <div className="flex-1 flex items-center justify-center h-full text-gray-600 text-sm">
            Select a report or generate a new one
          </div>
        ) : (
          <div className="p-6 space-y-6 max-w-4xl">
            {/* Report Header */}
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white capitalize">{selected.type} Report</h2>
                <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                  <span>Scope: {selected.scope}</span>
                  <span>Period: {new Date(selected.periodStart).toLocaleDateString()} — {new Date(selected.periodEnd).toLocaleDateString()}</span>
                  <span>Generated: {new Date(selected.generatedAt).toLocaleString()}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setShowFeedback(true)} className="text-xs px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300">+ Feedback</button>
                {selected.plan && selected.plan.status === 'pending' && (
                  <button onClick={handleApprovePlan} className="text-xs px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white">Approve Plan</button>
                )}
              </div>
            </div>

            {/* Metrics */}
            {selected.metrics && (
              <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <h3 className="text-xs font-semibold text-gray-400 mb-3">Metrics</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <MetricCard label="Completed" value={selected.metrics.tasksCompleted} color="text-emerald-400" />
                  <MetricCard label="In Progress" value={selected.metrics.tasksInProgress} color="text-indigo-400" />
                  <MetricCard label="Created" value={selected.metrics.tasksCreated} color="text-blue-400" />
                  <MetricCard label="Blocked" value={selected.metrics.tasksBlocked} color="text-amber-400" />
                  <MetricCard label="Failed" value={selected.metrics.tasksFailed} color="text-red-400" />
                  <MetricCard label="Avg Completion" value={`${Math.round(selected.metrics.avgCompletionTimeMs / 60000)}m`} color="text-gray-300" />
                  <MetricCard label="Tokens Used" value={selected.metrics.totalTokensUsed.toLocaleString()} color="text-gray-300" />
                  <MetricCard label="Est. Cost" value={`$${selected.metrics.estimatedCost.toFixed(2)}`} color="text-gray-300" />
                </div>
              </section>
            )}

            {/* Cost Summary */}
            {selected.costSummary && (
              <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <h3 className="text-xs font-semibold text-gray-400 mb-3">Cost Summary</h3>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <div className="text-2xl font-bold text-white">{selected.costSummary.totalTokens.toLocaleString()}</div>
                    <div className="text-xs text-gray-500">Total Tokens</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-white">${selected.costSummary.totalEstimatedCost.toFixed(4)}</div>
                    <div className="text-xs text-gray-500">Estimated Cost</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-white capitalize">{selected.costSummary.trend}</div>
                    <div className="text-xs text-gray-500">Trend</div>
                  </div>
                </div>
              </section>
            )}

            {/* Task Summary */}
            {selected.taskSummary && (
              <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <h3 className="text-xs font-semibold text-gray-400 mb-3">Task Summary</h3>
                <div className="space-y-4">
                  {selected.taskSummary.completed.length > 0 && (
                    <TaskSection title={`Completed (${selected.taskSummary.completed.length})`} color="emerald" items={selected.taskSummary.completed.slice(0, 10).map(t => ({ label: t.title, sub: t.agent }))} />
                  )}
                  {selected.taskSummary.inProgress.length > 0 && (
                    <TaskSection title={`In Progress (${selected.taskSummary.inProgress.length})`} color="indigo" items={selected.taskSummary.inProgress.slice(0, 10).map(t => ({ label: t.title, sub: t.agent }))} />
                  )}
                  {selected.taskSummary.blocked.length > 0 && (
                    <TaskSection title={`Blocked (${selected.taskSummary.blocked.length})`} color="amber" items={selected.taskSummary.blocked.map(t => ({ label: t.title, sub: t.reason || t.agent }))} />
                  )}
                </div>
              </section>
            )}

            {/* Feedback */}
            <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h3 className="text-xs font-semibold text-gray-400 mb-3">Feedback ({feedback.length})</h3>
              {feedback.length === 0 ? (
                <p className="text-sm text-gray-500">No feedback yet.</p>
              ) : (
                <div className="space-y-3">
                  {feedback.map(f => (
                    <div key={f.id} className="p-3 bg-gray-800/50 rounded-lg">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium text-gray-300">{f.authorName}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-700 text-gray-400">{f.type}</span>
                        <span className="text-[10px] text-gray-600">{new Date(f.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="text-sm text-gray-300">{f.content}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {/* Generate Modal */}
      {showGenerate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-96 space-y-4">
            <h3 className="text-base font-semibold text-white">Generate Report</h3>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Period</label>
              <select value={genPeriod} onChange={e => setGenPeriod(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200">
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Scope</label>
              <select value={genScope} onChange={e => setGenScope(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200">
                <option value="org">Organization</option>
                <option value="project">Project</option>
                <option value="team">Team</option>
              </select>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowGenerate(false)} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
              <button onClick={handleGenerate} className="btn-primary text-sm px-4 py-2 rounded-lg">Generate</button>
            </div>
          </div>
        </div>
      )}

      {/* Feedback Modal */}
      {showFeedback && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-[28rem] space-y-4">
            <h3 className="text-base font-semibold text-white">Add Feedback</h3>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Type</label>
              <select value={fbType} onChange={e => setFbType(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200">
                <option value="comment">Comment</option>
                <option value="directive">Directive</option>
                <option value="annotation">Annotation</option>
              </select>
            </div>
            <textarea value={fbContent} onChange={e => setFbContent(e.target.value)} placeholder="Your feedback…" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 h-28 resize-none" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowFeedback(false)} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
              <button onClick={handleAddFeedback} className="btn-primary text-sm px-4 py-2 rounded-lg">Submit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

function TaskSection({ title, color, items }: { title: string; color: string; items: Array<{ label: string; sub: string }> }) {
  return (
    <div>
      <div className={`text-xs font-medium text-${color}-400 mb-1.5`}>{title}</div>
      <div className="space-y-1">
        {items.map((item, i) => (
          <div key={i} className="text-sm text-gray-300 flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full bg-${color}-500 shrink-0`} />
            <span className="truncate">{item.label}</span>
            {item.sub && item.sub !== 'unassigned' && <span className="text-[10px] text-gray-500 shrink-0">{item.sub}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
