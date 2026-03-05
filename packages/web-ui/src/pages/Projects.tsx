import { useState, useEffect, useCallback, useRef, type DragEvent } from 'react';
import { api, wsClient, type ProjectInfo, type IterationInfo, type TaskInfo, type AgentInfo, type TaskLogEntry } from '../api.ts';
import { ConfirmModal } from '../components/ConfirmModal.tsx';
import { LogEntryRow } from '../components/ToolCallLogEntry.tsx';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';

// ─── Constants ──────────────────────────────────────────────────────────────────

const ALL_STATUSES = ['pending', 'pending_approval', 'assigned', 'in_progress', 'blocked', 'review', 'revision', 'accepted', 'completed', 'failed', 'cancelled', 'archived'] as const;

const BOARD_COLUMNS = [
  { id: 'approval',    label: 'Approval',    statuses: ['pending_approval'],                  accent: 'border-t-yellow-500', dropStatus: 'pending_approval' },
  { id: 'todo',        label: 'To Do',       statuses: ['pending', 'assigned'],               accent: 'border-t-gray-500',   dropStatus: 'pending' },
  { id: 'in_progress', label: 'In Progress', statuses: ['in_progress', 'blocked'],            accent: 'border-t-indigo-500', dropStatus: 'in_progress' },
  { id: 'review',      label: 'Review',      statuses: ['review', 'revision', 'accepted'],    accent: 'border-t-purple-500', dropStatus: 'review' },
  { id: 'done',        label: 'Done',        statuses: ['completed'],                         accent: 'border-t-green-500',  dropStatus: 'completed' },
  { id: 'closed',      label: 'Closed',      statuses: ['failed', 'cancelled'],               accent: 'border-t-red-500',    dropStatus: 'cancelled' },
] as const;

const COLUMN_LABELS: Record<string, string> = {
  pending: 'Pending', pending_approval: 'Awaiting Approval', assigned: 'Assigned',
  in_progress: 'In Progress', blocked: 'Blocked',
  review: 'In Review', revision: 'Needs Revision', accepted: 'Accepted', completed: 'Completed',
  failed: 'Failed', cancelled: 'Cancelled', archived: 'Archived',
};
const SUB_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending_approval: { label: 'Awaiting',  cls: 'bg-yellow-500/15 text-yellow-400' },
  assigned:         { label: 'Assigned',  cls: 'bg-blue-500/15 text-blue-400' },
  blocked:          { label: 'Blocked',   cls: 'bg-amber-500/15 text-amber-400' },
  revision:         { label: 'Revision',  cls: 'bg-orange-500/15 text-orange-400' },
  accepted:         { label: 'Accepted',  cls: 'bg-teal-500/15 text-teal-400' },
  failed:           { label: 'Failed',    cls: 'bg-red-500/15 text-red-400' },
};
const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'border-l-red-500', high: 'border-l-amber-500', medium: 'border-l-blue-500', low: 'border-l-gray-500',
};
const STATUS_DOT: Record<string, string> = {
  pending: 'bg-gray-400', pending_approval: 'bg-yellow-400', assigned: 'bg-blue-400',
  in_progress: 'bg-indigo-400', blocked: 'bg-amber-400',
  review: 'bg-purple-400', revision: 'bg-orange-400', accepted: 'bg-teal-400', completed: 'bg-green-400',
  failed: 'bg-red-400', cancelled: 'bg-gray-600', archived: 'bg-gray-700',
};

type ViewMode = 'all' | 'project';

// ─── Execution Log Panel ────────────────────────────────────────────────────────

function filterCompletedToolStarts(logs: TaskLogEntry[]): TaskLogEntry[] {
  const matchedStartIndices = new Set<number>();
  for (let i = 0; i < logs.length; i++) {
    if (logs[i]!.type === 'tool_end') {
      for (let j = i - 1; j >= 0; j--) {
        if (logs[j]!.type === 'tool_start' && !matchedStartIndices.has(j)) {
          matchedStartIndices.add(j);
          break;
        }
      }
    }
  }
  return logs.filter((_, i) => !matchedStartIndices.has(i));
}

function TaskExecutionLogs({ taskId, isVisible, isRunning }: { taskId: string; isVisible: boolean; isRunning: boolean }) {
  const [logs, setLogs] = useState<TaskLogEntry[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [isExecuting, setIsExecuting] = useState(isRunning);
  const [loading, setLoading] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setIsExecuting(isRunning); }, [isRunning]);

  useEffect(() => {
    setLoading(true);
    api.tasks.getLogs(taskId).then(d => { setLogs(d.logs); setLoading(false); }).catch(() => setLoading(false));
  }, [taskId]);

  useEffect(() => {
    const unsubLog = wsClient.on('task:log', (event) => {
      const p = event.payload;
      if (p.taskId !== taskId) return;
      const entry: TaskLogEntry = {
        id: p.id as string, taskId: p.taskId as string, agentId: p.agentId as string,
        seq: p.seq as number, type: p.logType as string, content: p.content as string,
        metadata: p.metadata as Record<string, unknown> | undefined, createdAt: p.createdAt as string,
      };
      setLogs(prev => {
        if (entry.id && prev.some(e => e.id === entry.id)) return prev;
        if (!entry.id && prev.some(e => e.seq === entry.seq && e.type === entry.type)) return prev;
        return [...prev, entry];
      });
      if (entry.type === 'text') setStreamingText('');
      if (entry.type === 'status') {
        if (entry.content === 'started') setIsExecuting(true);
        else if (['completed', 'failed', 'cancelled'].includes(entry.content)) setIsExecuting(false);
      }
      if (entry.type === 'error') setIsExecuting(false);
    });
    const unsubDelta = wsClient.on('task:log:delta', (event) => {
      const p = event.payload;
      if (p.taskId !== taskId) return;
      setStreamingText(prev => prev + (p.text as string));
    });
    return () => { unsubLog(); unsubDelta(); };
  }, [taskId]);

  useEffect(() => {
    if (isVisible) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, streamingText, isVisible]);

  if (loading) return <div className="flex-1 flex items-center justify-center text-xs text-gray-600">Loading logs…</div>;
  if (logs.length === 0 && !streamingText) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-gray-600">
          <div className="text-2xl mb-2">📋</div>
          <div className="text-xs">No execution logs yet.<br />Click "Run with Agent" to start.</div>
        </div>
      </div>
    );
  }

  const visibleLogs = filterCompletedToolStarts(logs);
  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5">
      {visibleLogs.map((entry, i) => <LogEntryRow key={`${entry.seq}-${i}`} entry={entry} />)}
      {streamingText && (
        <div className="bg-gray-800/50 rounded-lg px-3 py-2.5 my-1">
          <MarkdownMessage content={streamingText} className="text-sm text-gray-300" />
          <span className="inline-block w-0.5 h-4 bg-indigo-400 animate-pulse ml-0.5 align-middle" />
        </div>
      )}
      {isExecuting && !streamingText && (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500">
          <span className="flex gap-0.5">
            <span className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }} />
          </span>
          Thinking…
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

// ─── Task Detail Modal ──────────────────────────────────────────────────────────

function TaskDetailModal({
  task, agents, projects, onClose, onRefresh,
}: {
  task: TaskInfo;
  agents: AgentInfo[];
  projects: ProjectInfo[];
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [subtasks, setSubtasks] = useState<TaskInfo[]>([]);
  const [newSubtask, setNewSubtask] = useState('');
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<TaskInfo | null>(null);
  const [pendingDeleteParent, setPendingDeleteParent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'logs'>('details');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const loadSubtasks = useCallback(async () => {
    try { const d = await api.tasks.listSubtasks(task.id); setSubtasks(d.subtasks); } catch { /* ok */ }
  }, [task.id]);

  useEffect(() => { void loadSubtasks(); }, [loadSubtasks]);

  const doUpdate = async (fn: () => Promise<unknown>) => {
    if (busy) return; setBusy(true);
    try { await fn(); onRefresh(); void loadSubtasks(); } finally { setBusy(false); }
  };

  const updateStatus = (taskId: string, status: string) => doUpdate(() => api.tasks.updateStatus(taskId, status));
  const updatePriority = (priority: string) => doUpdate(() => api.tasks.update(task.id, { priority }));
  const assignAgent = (agentId: string) => doUpdate(() => api.tasks.assign(task.id, agentId || null));
  const updateProject = (projectId: string) => doUpdate(() => api.tasks.update(task.id, { projectId: projectId || null }));

  const startTask = async () => {
    if (busy) return; setBusy(true);
    try {
      if (!task.assignedAgentId) {
        const idle = agents.find(a => a.status === 'idle');
        if (idle) await api.tasks.assign(task.id, idle.id);
      }
      await api.tasks.updateStatus(task.id, 'in_progress');
      onRefresh();
    } finally { setBusy(false); }
  };

  const pauseTask = async () => {
    if (busy) return; setBusy(true);
    try {
      const nextStatus = task.assignedAgentId ? 'assigned' : 'pending';
      await api.tasks.updateStatus(task.id, nextStatus);
      onRefresh();
    } finally { setBusy(false); }
  };

  const addSubtask = async () => {
    if (!newSubtask.trim()) return;
    await api.tasks.createSubtask(task.id, newSubtask.trim());
    setNewSubtask(''); setAddingSubtask(false);
    void loadSubtasks(); onRefresh();
  };

  const toggleSubtask = async (sub: TaskInfo) => {
    await api.tasks.updateStatus(sub.id, sub.status === 'completed' ? 'pending' : 'completed');
    void loadSubtasks(); onRefresh();
  };

  const deleteSubtask = async (sub: TaskInfo) => {
    await api.tasks.delete(sub.id); setPendingDelete(null);
    void loadSubtasks(); onRefresh();
  };

  const deleteParent = async () => {
    await api.tasks.delete(task.id); setPendingDeleteParent(false);
    onClose(); onRefresh();
  };

  const reopenTask = async () => {
    if (busy) return; setBusy(true);
    try { await api.tasks.updateStatus(task.id, 'pending'); onRefresh(); } finally { setBusy(false); }
  };

  const runWithAgent = async () => {
    if (running) return; setRunning(true); setRunError(null); setActiveTab('logs');
    try { await api.tasks.run(task.id); onRefresh(); } catch (err) {
      setRunError(String(err).replace('Error: API error: 400', 'Server error').replace('Error: ', ''));
    } finally { setRunning(false); }
  };

  useEffect(() => {
    const unsub = wsClient.on('task:log:delta', (event) => {
      if (event.payload.taskId === task.id) setActiveTab('logs');
    });
    return unsub;
  }, [task.id]);

  const completedCount = subtasks.filter(s => s.status === 'completed').length;
  const assignedAgent = agents.find(a => a.id === task.assignedAgentId);
  void assignedAgent;
  const isRunning = task.status === 'in_progress';
  const isBlocked = task.status === 'blocked';
  const isCompleted = task.status === 'completed';
  const isFailed = task.status === 'failed';
  const isCancelled = task.status === 'cancelled';
  const isArchived = task.status === 'archived';
  const isTerminal = isCompleted || isFailed || isCancelled || isArchived;
  void isBlocked;

  const taskProject = projects.find(p => p.id === task.projectId);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-[600px] max-h-[88vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-gray-800">
          <div className="flex-1 min-w-0 pr-4">
            <h3 className="text-base font-semibold leading-snug">{task.title}</h3>
            {task.description && <div className="mt-1"><MarkdownMessage content={task.description} className="text-sm text-gray-400" /></div>}
            {taskProject && (
              <div className="flex items-center gap-1.5 mt-2">
                <span className="text-[10px] px-1.5 py-0.5 bg-indigo-900/30 text-indigo-300 rounded">{taskProject.name}</span>
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg shrink-0">×</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-6 pt-3 border-b border-gray-800 shrink-0">
          <button onClick={() => setActiveTab('details')} className={`px-3 py-1.5 text-xs rounded-t-md transition-colors ${activeTab === 'details' ? 'bg-gray-800 text-gray-100 font-medium' : 'text-gray-500 hover:text-gray-300'}`}>Details</button>
          <button onClick={() => setActiveTab('logs')} className={`px-3 py-1.5 text-xs rounded-t-md transition-colors flex items-center gap-1.5 ${activeTab === 'logs' ? 'bg-gray-800 text-gray-100 font-medium' : 'text-gray-500 hover:text-gray-300'}`}>
            Execution Log
            {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />}
          </button>
        </div>

        {/* Logs tab */}
        <div className={`flex-1 flex flex-col overflow-hidden ${activeTab !== 'logs' ? 'hidden' : ''}`}>
          {runError && (
            <div className="mx-4 mt-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
              <span className="font-medium">Failed to start:</span> {runError}
            </div>
          )}
          <TaskExecutionLogs taskId={task.id} isVisible={activeTab === 'logs'} isRunning={task.status === 'in_progress'} />
        </div>

        {activeTab === 'details' && (
          <>
            <div className="px-6 py-4 border-b border-gray-800/60 space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Status</label>
                  <select value={task.status} onChange={e => void updateStatus(task.id, e.target.value)} disabled={busy}
                    className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-200 focus:border-indigo-500 outline-none disabled:opacity-50 cursor-pointer">
                    {ALL_STATUSES.map(s => <option key={s} value={s}>{COLUMN_LABELS[s]}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Priority</label>
                  <select value={task.priority} onChange={e => void updatePriority(e.target.value)} disabled={busy}
                    className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-200 focus:border-indigo-500 outline-none disabled:opacity-50 cursor-pointer">
                    <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Assignee</label>
                  <select value={task.assignedAgentId ?? ''} onChange={e => void assignAgent(e.target.value)} disabled={busy}
                    className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-200 focus:border-indigo-500 outline-none disabled:opacity-50 cursor-pointer">
                    <option value="">Unassigned</option>
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name} ({a.status})</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Project</label>
                  <select value={task.projectId ?? ''} onChange={e => void updateProject(e.target.value)} disabled={busy}
                    className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-200 focus:border-indigo-500 outline-none disabled:opacity-50 cursor-pointer">
                    <option value="">No Project</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </div>
              {task.parentTaskId && (
                <div className="text-xs text-gray-500">Parent: <span className="font-mono text-gray-400">{task.parentTaskId.slice(-8)}</span></div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Subtasks {subtasks.length > 0 && <span className="ml-1.5 text-gray-500 font-normal normal-case">{completedCount}/{subtasks.length} done</span>}
                </span>
                <button onClick={() => setAddingSubtask(true)} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">+ Add subtask</button>
              </div>
              {subtasks.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  {subtasks.map(sub => (
                    <div key={sub.id} className="group flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-gray-800/50 transition-colors">
                      <button onClick={() => void toggleSubtask(sub)} className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${sub.status === 'completed' ? 'bg-green-600 border-green-600 text-white' : 'border-gray-600 hover:border-indigo-500'}`}>
                        {sub.status === 'completed' && <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                      </button>
                      <span className={`flex-1 text-sm ${sub.status === 'completed' ? 'line-through text-gray-500' : 'text-gray-300'}`}>{sub.title}</span>
                      <button onClick={() => setPendingDelete(sub)} className="shrink-0 opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all text-xs">✕</button>
                    </div>
                  ))}
                </div>
              )}
              {subtasks.length === 0 && !addingSubtask && <div className="text-xs text-gray-600 text-center py-4">No subtasks yet.</div>}
              {addingSubtask && (
                <div className="flex gap-2 mt-2">
                  <input autoFocus value={newSubtask} onChange={e => setNewSubtask(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void addSubtask(); if (e.key === 'Escape') { setAddingSubtask(false); setNewSubtask(''); } }}
                    placeholder="Subtask title..." className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none" />
                  <button onClick={() => void addSubtask()} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg">Add</button>
                  <button onClick={() => { setAddingSubtask(false); setNewSubtask(''); }} className="px-3 py-1.5 border border-gray-700 text-xs rounded-lg hover:bg-gray-800">Cancel</button>
                </div>
              )}
              {task.notes && task.notes.length > 0 && (
                <div className="mt-5">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Progress Notes</p>
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {task.notes.map((note, i) => <div key={i} className="text-xs text-gray-400 bg-gray-800/60 rounded px-2.5 py-1.5 leading-relaxed"><MarkdownMessage content={note} className="text-xs text-gray-400" /></div>)}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Actions */}
        <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between gap-2">
          <div className="flex gap-2 flex-wrap">
            {task.status === 'pending_approval' && (
              <>
                <button onClick={() => void updateStatus(task.id, 'pending')} disabled={busy} className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white disabled:opacity-50">Approve</button>
                <button onClick={() => void updateStatus(task.id, 'cancelled')} disabled={busy} className="px-3 py-1.5 text-xs text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50">Reject</button>
              </>
            )}
            {task.assignedAgentId && !isRunning && !isTerminal && task.status !== 'pending_approval' && (
              <button onClick={() => void runWithAgent()} disabled={running} className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white disabled:opacity-50 flex items-center gap-1.5">
                {running ? <>Running…</> : <><svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7-4.5-7-4.5z" /></svg>Run with Agent</>}
              </button>
            )}
            {isRunning && <button onClick={() => void pauseTask()} disabled={busy} className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 rounded-lg text-white disabled:opacity-50">Pause</button>}
            {isRunning && <button onClick={() => void updateStatus(task.id, 'blocked')} disabled={busy} className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 rounded-lg text-white disabled:opacity-50">Block</button>}
            {isBlocked && <button onClick={() => void startTask()} disabled={busy} className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-200 disabled:opacity-50">Unblock</button>}
            {(task.status === 'pending' || task.status === 'assigned') && (
              <button onClick={() => void startTask()} disabled={busy} className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-200 disabled:opacity-50">Mark In Progress</button>
            )}
            {(isCompleted || isFailed) && task.assignedAgentId && (
              <button onClick={() => void runWithAgent()} disabled={running} className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white disabled:opacity-50">Run Again</button>
            )}
            {task.status === 'review' && (
              <>
                <button onClick={() => doUpdate(() => api.tasks.accept(task.id))} disabled={busy} className="px-3 py-1.5 text-xs bg-teal-600 hover:bg-teal-500 rounded-lg text-white disabled:opacity-50">✓ Accept</button>
                <button onClick={() => { const reason = prompt('Reason for requesting revision:'); if (reason) doUpdate(() => api.tasks.revision(task.id, reason)); }} disabled={busy} className="px-3 py-1.5 text-xs bg-orange-600 hover:bg-orange-500 rounded-lg text-white disabled:opacity-50">↻ Revision</button>
              </>
            )}
            {(task.status === 'completed' || task.status === 'accepted') && (
              <button onClick={() => doUpdate(() => api.tasks.archive(task.id))} disabled={busy} className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 rounded-lg text-gray-200 disabled:opacity-50">Archive</button>
            )}
            {task.status === 'in_progress' && (
              <button onClick={() => void updateStatus(task.id, 'review')} disabled={busy} className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 rounded-lg text-white disabled:opacity-50">Submit for Review</button>
            )}
            {isTerminal && <button onClick={() => void reopenTask()} disabled={busy} className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-200 disabled:opacity-50">Reopen</button>}
            {!isTerminal && task.status !== 'pending_approval' && <button onClick={() => void updateStatus(task.id, 'completed')} disabled={busy} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 rounded-lg text-white disabled:opacity-50">Complete</button>}
            {!isTerminal && task.status !== 'pending_approval' && <button onClick={() => void updateStatus(task.id, 'cancelled')} disabled={busy} className="px-3 py-1.5 text-xs text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50">Cancel</button>}
          </div>
          <button onClick={() => setPendingDeleteParent(true)} className="px-3 py-1.5 text-xs text-gray-500 hover:text-red-400 border border-transparent hover:border-red-500/30 rounded-lg transition-colors">Delete</button>
        </div>
      </div>

      {pendingDelete && <ConfirmModal title={`Delete subtask "${pendingDelete.title}"?`} message="This subtask will be permanently deleted." confirmLabel="Delete" onConfirm={() => void deleteSubtask(pendingDelete)} onCancel={() => setPendingDelete(null)} />}
      {pendingDeleteParent && <ConfirmModal title={`Delete task "${task.title}"?`} message={subtasks.length > 0 ? `This will also delete all ${subtasks.length} subtask(s).` : 'This task will be permanently deleted.'} confirmLabel="Delete Task" onConfirm={() => void deleteParent()} onCancel={() => setPendingDeleteParent(false)} />}
    </div>
  );
}

// ─── Project Settings Panel ─────────────────────────────────────────────────────

function ProjectSettingsPanel({ project, iterations, onIterationAction, onDeleteProject, onCreateIteration }: {
  project: ProjectInfo;
  iterations: IterationInfo[];
  onIterationAction: (iterId: string, status: string) => void;
  onDeleteProject: () => void;
  onCreateIteration: (name: string, goal: string, start: string, end: string) => void;
}) {
  const [showIterForm, setShowIterForm] = useState(false);
  const [iterName, setIterName] = useState('');
  const [iterGoal, setIterGoal] = useState('');
  const [iterStart, setIterStart] = useState('');
  const [iterEnd, setIterEnd] = useState('');

  const handleCreate = () => {
    if (!iterName.trim()) return;
    onCreateIteration(iterName, iterGoal, iterStart, iterEnd);
    setShowIterForm(false); setIterName(''); setIterGoal(''); setIterStart(''); setIterEnd('');
  };

  return (
    <div className="p-5 space-y-5 max-w-3xl">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">{project.name}</h3>
          {project.description && <p className="text-sm text-gray-400 mt-1">{project.description}</p>}
          <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
            <StatusPill status={project.status} />
            <IterModelBadge model={project.iterationModel} />
          </div>
        </div>
        <button onClick={onDeleteProject} className="text-xs text-red-400 hover:text-red-300">Delete Project</button>
      </div>

      {project.repositories && project.repositories.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h4 className="text-xs font-semibold text-gray-400 mb-2">Repositories</h4>
          {project.repositories.map((r, i) => (
            <div key={i} className="text-sm text-gray-300 flex items-center gap-2">
              <span className="text-gray-600">⎇</span>
              <span>{r.url || r.localPath}</span>
              <span className="text-xs text-gray-600">({r.defaultBranch})</span>
            </div>
          ))}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs font-semibold text-gray-400">Iterations</h4>
          <button onClick={() => setShowIterForm(true)} className="text-xs px-2.5 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300">+ Add</button>
        </div>

        {showIterForm && (
          <div className="mb-3 p-3 bg-gray-800 rounded-lg space-y-2">
            <input value={iterName} onChange={e => setIterName(e.target.value)} placeholder="Iteration name" className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-200" />
            <input value={iterGoal} onChange={e => setIterGoal(e.target.value)} placeholder="Goal" className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-200" />
            <div className="flex gap-2">
              <input type="date" value={iterStart} onChange={e => setIterStart(e.target.value)} className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-200" />
              <input type="date" value={iterEnd} onChange={e => setIterEnd(e.target.value)} className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-200" />
            </div>
            <div className="flex gap-2">
              <button onClick={handleCreate} className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white">Create</button>
              <button onClick={() => setShowIterForm(false)} className="text-sm text-gray-500">Cancel</button>
            </div>
          </div>
        )}

        {iterations.length === 0 ? (
          <p className="text-sm text-gray-500">No iterations yet.</p>
        ) : (
          <div className="space-y-1.5">
            {iterations.map(it => (
              <div key={it.id} className="p-2.5 bg-gray-800/50 rounded-lg flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-200">{it.name}</div>
                  {it.goal && <div className="text-xs text-gray-400 mt-0.5">{it.goal}</div>}
                  <div className="text-[10px] text-gray-600 mt-1 flex items-center gap-2">
                    <StatusPill status={it.status} />
                    {it.startDate && <span>{it.startDate} → {it.endDate || '?'}</span>}
                  </div>
                </div>
                <div className="flex gap-1.5 ml-3">
                  {it.status === 'planning' && <button onClick={() => onIterationAction(it.id, 'active')} className="text-xs px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white">Start</button>}
                  {it.status === 'active' && <button onClick={() => onIterationAction(it.id, 'review')} className="text-xs px-2 py-1 rounded bg-indigo-700 hover:bg-indigo-600 text-white">Review</button>}
                  {it.status === 'review' && <button onClick={() => onIterationAction(it.id, 'completed')} className="text-xs px-2 py-1 rounded bg-gray-600 hover:bg-gray-500 text-white">Complete</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────────

export function ProjectsPage() {
  // ── State ──
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedIterationId, setSelectedIterationId] = useState<string | null>(null);
  const [iterations, setIterations] = useState<IterationInfo[]>([]);
  const [board, setBoard] = useState<Record<string, TaskInfo[]>>({});
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState('');
  const [showProjectSettings, setShowProjectSettings] = useState(false);

  // Create modals
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [newProjDesc, setNewProjDesc] = useState('');
  const [newProjRepo, setNewProjRepo] = useState('');

  const [showCreateTask, setShowCreateTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDesc, setTaskDesc] = useState('');
  const [taskPriority, setTaskPriority] = useState('medium');
  const [taskAutoAssign, setTaskAutoAssign] = useState(true);
  const [taskAssignTo, setTaskAssignTo] = useState('');
  const [taskProjectId, setTaskProjectId] = useState<string>('');

  const [selectedTask, setSelectedTask] = useState<TaskInfo | null>(null);
  const [agentFilter, setAgentFilter] = useState<Set<string>>(new Set());
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const dragTaskRef = useRef<TaskInfo | null>(null);

  const msg = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 3000); };

  const selectedProject = projects.find(p => p.id === selectedProjectId) ?? null;

  // ── Data fetching ──

  const refreshProjects = useCallback(async () => {
    try { const { projects: p } = await api.projects.list(); setProjects(p); } catch { /* */ }
  }, []);

  const refreshBoard = useCallback(async () => {
    const filters: { projectId?: string; iterationId?: string } = {};
    if (viewMode === 'project' && selectedProjectId) {
      filters.projectId = selectedProjectId;
      if (selectedIterationId) filters.iterationId = selectedIterationId;
    }
    try {
      const { board: b } = await api.tasks.board(filters);
      setBoard(b);
    } catch { /* */ }
  }, [viewMode, selectedProjectId, selectedIterationId]);

  const refreshAgents = useCallback(async () => {
    try { const { agents: a } = await api.agents.list(); setAgents(a); } catch { /* */ }
  }, []);

  const loadIterations = useCallback(async (projectId: string) => {
    try { const { iterations: it } = await api.projects.listIterations(projectId); setIterations(it); } catch { setIterations([]); }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([refreshProjects(), refreshBoard(), refreshAgents()]);
    setLoading(false);
  }, [refreshProjects, refreshBoard, refreshAgents]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { refreshBoard(); }, [refreshBoard]);

  useEffect(() => {
    if (selectedProjectId) loadIterations(selectedProjectId);
    else setIterations([]);
  }, [selectedProjectId, loadIterations]);

  useEffect(() => {
    const i = setInterval(() => { refreshBoard(); refreshAgents(); }, 15000);
    const unsub = wsClient.on('task:update', (event) => {
      refreshBoard();
      const p = event?.payload as { taskId?: string; status?: string } | undefined;
      if (p?.taskId && p.status) {
        setSelectedTask(prev => prev && prev.id === p.taskId ? { ...prev, status: p.status as string } : prev);
      }
    });
    return () => { clearInterval(i); unsub(); };
  }, [refreshBoard, refreshAgents]);

  // Open task from navigation params (e.g. from Dashboard)
  useEffect(() => {
    const tryOpenTask = (taskId: string) => {
      const allTasks = Object.values(board).flat();
      const task = allTasks.find(t => t.id === taskId);
      if (task) { setSelectedTask(task); localStorage.removeItem('markus_nav_openTask'); }
    };
    const navTaskId = localStorage.getItem('markus_nav_openTask');
    if (navTaskId) tryOpenTask(navTaskId);

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      if ((detail.page === 'tasks' || detail.page === 'projects') && detail.params?.openTask) {
        tryOpenTask(detail.params.openTask);
      }
    };
    window.addEventListener('markus:navigate', handler);
    return () => window.removeEventListener('markus:navigate', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board]);

  // ── Actions ──

  const selectProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    setSelectedIterationId(null);
    setViewMode('project');
    setShowProjectSettings(false);
  };

  const selectAllTasks = () => {
    setSelectedProjectId(null);
    setSelectedIterationId(null);
    setViewMode('all');
    setShowProjectSettings(false);
  };

  const handleCreateProject = async () => {
    if (!newProjName.trim()) return;
    try {
      const repos = newProjRepo.trim() ? [{ url: newProjRepo, defaultBranch: 'main' }] : [];
      await api.projects.create({ name: newProjName, description: newProjDesc, orgId: 'default', repositories: repos } as Partial<ProjectInfo>);
      setShowCreateProject(false); setNewProjName(''); setNewProjDesc(''); setNewProjRepo('');
      msg('Project created');
      refreshProjects();
    } catch (e) { msg(`Error: ${e}`); }
  };

  const handleDeleteProject = async (id: string) => {
    if (!confirm('Delete this project and unlink all its tasks?')) return;
    try {
      await api.projects.delete(id);
      if (selectedProjectId === id) selectAllTasks();
      msg('Project deleted');
      refreshProjects(); refreshBoard();
    } catch (e) { msg(`Error: ${e}`); }
  };

  const handleCreateIteration = async (name: string, goal: string, start: string, end: string) => {
    if (!selectedProjectId) return;
    try {
      await api.projects.createIteration(selectedProjectId, { name, goal, startDate: start || undefined, endDate: end || undefined } as Partial<IterationInfo>);
      msg('Iteration created');
      loadIterations(selectedProjectId);
    } catch (e) { msg(`Error: ${e}`); }
  };

  const handleIterStatus = async (iterId: string, status: string) => {
    try {
      await api.projects.updateIterationStatus(iterId, status);
      msg(`Iteration ${status}`);
      if (selectedProjectId) loadIterations(selectedProjectId);
    } catch (e) { msg(`Error: ${e}`); }
  };

  const createTask = async () => {
    if (!taskTitle) return;
    const projId = taskProjectId || undefined;
    const iterId = projId && selectedIterationId ? selectedIterationId : undefined;
    await api.tasks.create(
      taskTitle, taskDesc, taskPriority,
      taskAutoAssign ? undefined : taskAssignTo || undefined,
      taskAutoAssign,
      projId,
      iterId,
    );
    setTaskTitle(''); setTaskDesc(''); setShowCreateTask(false);
    refreshBoard();
  };

  const handleTaskRefresh = () => {
    refreshBoard();
    if (selectedTask) {
      setTimeout(() => {
        const filters: { projectId?: string; iterationId?: string } = {};
        if (viewMode === 'project' && selectedProjectId) filters.projectId = selectedProjectId;
        api.tasks.board(filters).then(d => {
          const all = Object.values(d.board).flat();
          const updated = all.find(t => t.id === selectedTask.id);
          if (updated) setSelectedTask(updated); else setSelectedTask(null);
        }).catch(() => {});
      }, 150);
    }
  };

  // ── Drag handlers ──

  const onDragStart = (e: DragEvent<HTMLDivElement>, task: TaskInfo) => {
    dragTaskRef.current = task;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
    (e.currentTarget as HTMLElement).style.opacity = '0.4';
  };
  const onDragEnd = (e: DragEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
    dragTaskRef.current = null; setDragOverCol(null);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>, col: string) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    if (dragOverCol !== col) setDragOverCol(col);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>, col: string) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { clientX: x, clientY: y } = e;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      if (dragOverCol === col) setDragOverCol(null);
    }
  };
  const onDrop = async (e: DragEvent<HTMLDivElement>, colId: string) => {
    e.preventDefault(); setDragOverCol(null);
    const task = dragTaskRef.current;
    if (!task) return;
    const targetCol = BOARD_COLUMNS.find(c => c.id === colId);
    if (!targetCol) return;
    const targetStatus = targetCol.dropStatus;
    if (task.status === targetStatus) return;
    try { await api.tasks.updateStatus(task.id, targetStatus); refreshBoard(); } catch { /* */ }
  };

  const toggleAgentFilter = (id: string) => {
    setAgentFilter(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ── Filter & display helpers ──

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const isArchived = (t: TaskInfo) =>
    t.status === 'completed' && t.updatedAt && (now - new Date(t.updatedAt).getTime() > ONE_DAY_MS);

  const filterTasks = (tasks: TaskInfo[]) => {
    let result = tasks.filter(t => !t.parentTaskId && !isArchived(t));
    if (viewMode === 'project' && selectedProjectId) {
      result = result.filter(t => t.projectId === selectedProjectId);
    }
    if (viewMode === 'project' && selectedIterationId) {
      result = result.filter(t => t.iterationId === selectedIterationId);
    }
    if (agentFilter.size > 0) result = result.filter(t => t.assignedAgentId && agentFilter.has(t.assignedAgentId));
    return result;
  };

  const getColumnTasks = (col: typeof BOARD_COLUMNS[number]) =>
    col.statuses.flatMap(s => filterTasks(board[s] ?? []));

  const visibleColumns = BOARD_COLUMNS.filter(col => {
    const tasks = getColumnTasks(col);
    if (col.id === 'closed' || col.id === 'approval') return tasks.length > 0;
    return true;
  });

  const archivedCount = Object.values(board).flat().filter(t => !t.parentTaskId && isArchived(t)).length;

  // Count tasks per project (from full unfiltered board for sidebar)
  const [allTaskCounts, setAllTaskCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    api.tasks.board().then(({ board: fullBoard }) => {
      const counts: Record<string, number> = {};
      for (const tasks of Object.values(fullBoard)) {
        for (const t of tasks as TaskInfo[]) {
          if (t.parentTaskId) continue;
          const key = t.projectId ?? '__none__';
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
      setAllTaskCounts(counts);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board]);

  const totalTaskCount = Object.values(allTaskCounts).reduce((a, b) => a + b, 0);

  // Active iteration for selected project
  const activeIteration = iterations.find(it => it.status === 'active');

  if (loading) return <div className="flex-1 flex items-center justify-center text-gray-500">Loading…</div>;

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* ── Left: Project Sidebar ── */}
      <div className="w-64 border-r border-gray-800 flex flex-col bg-gray-950 shrink-0">
        <div className="p-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-300">Work</h2>
          <button onClick={() => setShowCreateProject(true)} className="text-xs px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white">+ Project</button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {/* All Tasks */}
          <button
            onClick={selectAllTasks}
            className={`w-full text-left p-2.5 rounded-lg transition-colors flex items-center justify-between ${
              viewMode === 'all' ? 'bg-indigo-600/20 border border-indigo-500/30' : 'hover:bg-gray-800/60'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm">☑</span>
              <span className="text-sm font-medium text-gray-200">All Tasks</span>
            </div>
            {totalTaskCount > 0 && (
              <span className="text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded-full">{totalTaskCount}</span>
            )}
          </button>

          {/* Divider */}
          {projects.length > 0 && <div className="border-t border-gray-800/50 my-2" />}

          {/* Project list */}
          {projects.map(p => {
            const count = allTaskCounts[p.id] ?? 0;
            const isSelected = viewMode === 'project' && selectedProjectId === p.id;
            return (
              <button
                key={p.id}
                onClick={() => selectProject(p.id)}
                className={`w-full text-left p-2.5 rounded-lg transition-colors flex items-center justify-between ${
                  isSelected ? 'bg-indigo-600/20 border border-indigo-500/30' : 'hover:bg-gray-800/60'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-200 truncate">{p.name}</div>
                  <div className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-1.5">
                    <StatusPill status={p.status} />
                    <IterModelBadge model={p.iterationModel} />
                  </div>
                </div>
                {count > 0 && (
                  <span className="text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded-full shrink-0 ml-2">{count}</span>
                )}
              </button>
            );
          })}

          {projects.length === 0 && (
            <p className="text-xs text-gray-600 p-3 text-center">No projects yet.<br />Create one to organize tasks.</p>
          )}
        </div>
      </div>

      {/* ── Right: Task Board + Project Context ── */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Flash */}
        {flash && <div className="mx-6 mt-2 px-3 py-1.5 bg-emerald-900/50 text-emerald-300 text-xs rounded-lg">{flash}</div>}

        {/* Top bar */}
        <div className="flex items-center justify-between px-6 h-14 border-b border-gray-800 bg-gray-900 shrink-0">
          <div className="flex items-center gap-3">
            {viewMode === 'all' ? (
              <h2 className="text-base font-semibold">All Tasks</h2>
            ) : selectedProject ? (
              <div className="flex items-center gap-3">
                <h2 className="text-base font-semibold">{selectedProject.name}</h2>
                {/* Iteration selector */}
                <select
                  value={selectedIterationId ?? ''}
                  onChange={e => setSelectedIterationId(e.target.value || null)}
                  className="px-2 py-1 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-300 focus:border-indigo-500 outline-none"
                >
                  <option value="">All iterations</option>
                  {iterations.map(it => (
                    <option key={it.id} value={it.id}>{it.name} ({it.status})</option>
                  ))}
                </select>
                {/* Settings toggle */}
                <button
                  onClick={() => setShowProjectSettings(!showProjectSettings)}
                  className={`px-2 py-1 text-xs rounded-lg transition-colors ${
                    showProjectSettings ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
                  }`}
                  title="Project settings"
                >
                  ⚙
                </button>
              </div>
            ) : null}
            {archivedCount > 0 && <span className="text-[10px] text-gray-600">{archivedCount} archived</span>}
          </div>
          <button onClick={() => { setTaskProjectId(selectedProjectId ?? ''); setShowCreateTask(true); }} className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg">+ New Task</button>
        </div>

        {/* Active iteration banner (when viewing a project with an active iteration) */}
        {viewMode === 'project' && activeIteration && !selectedIterationId && (
          <div className="px-6 py-2 border-b border-gray-800 bg-gray-900/40 flex items-center gap-3">
            <span className="text-xs text-gray-500">Active:</span>
            <button
              onClick={() => setSelectedIterationId(activeIteration.id)}
              className="text-xs text-indigo-400 hover:text-indigo-300 font-medium"
            >
              {activeIteration.name}
            </button>
            {activeIteration.goal && <span className="text-xs text-gray-500">— {activeIteration.goal}</span>}
            {activeIteration.endDate && <span className="text-[10px] text-gray-600">ends {activeIteration.endDate}</span>}
          </div>
        )}

        {/* Agent filter bar */}
        {agents.length > 0 && !showProjectSettings && (
          <div className="px-6 py-2 border-b border-gray-800 bg-gray-900/60 flex items-center gap-2 overflow-x-auto shrink-0">
            <span className="text-[10px] text-gray-600 uppercase tracking-wider shrink-0 mr-1">Filter</span>
            {agentFilter.size > 0 && (
              <button onClick={() => setAgentFilter(new Set())} className="text-[10px] text-gray-500 hover:text-gray-300 px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 shrink-0">Clear</button>
            )}
            {agents.map(a => {
              const selected = agentFilter.has(a.id);
              return (
                <button key={a.id} onClick={() => toggleAgentFilter(a.id)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs transition-all shrink-0 ${
                    selected ? 'bg-indigo-600/30 text-indigo-300 ring-1 ring-indigo-500/50' : 'bg-gray-800/60 text-gray-500 hover:bg-gray-800 hover:text-gray-300'
                  }`}>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${selected ? 'bg-indigo-600' : 'bg-gray-700'}`}>{a.name[0]?.toUpperCase()}</span>
                  {a.name}
                </button>
              );
            })}
          </div>
        )}

        {/* Project settings panel */}
        {showProjectSettings && selectedProject ? (
          <div className="flex-1 overflow-y-auto">
            <ProjectSettingsPanel
              project={selectedProject}
              iterations={iterations}
              onIterationAction={handleIterStatus}
              onDeleteProject={() => handleDeleteProject(selectedProject.id)}
              onCreateIteration={handleCreateIteration}
            />
          </div>
        ) : (
          /* Kanban board */
          <div className="flex-1 overflow-x-auto p-6">
            <div className="flex gap-4 min-h-full">
              {visibleColumns.map(col => {
                const colTasks = getColumnTasks(col);
                const isOver = dragOverCol === col.id;
                return (
                  <div key={col.id}
                    className={`w-64 shrink-0 rounded-xl p-3.5 border-t-2 transition-colors ${col.accent} ${isOver ? 'bg-gray-800/80 ring-1 ring-indigo-500/40' : 'bg-gray-900'}`}
                    onDragOver={e => onDragOver(e, col.id)} onDragLeave={e => onDragLeave(e, col.id)} onDrop={e => void onDrop(e, col.id)}>
                    <div className="flex justify-between items-center mb-3">
                      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{col.label}</span>
                      <span className="text-xs bg-gray-800 px-2 py-0.5 rounded-full">{colTasks.length}</span>
                    </div>
                    <div className="space-y-2">
                      {colTasks.map(task => {
                        const subCount = task.subtaskIds?.length ?? 0;
                        const badge = SUB_STATUS_BADGE[task.status];
                        const taskProjName = viewMode === 'all' && task.projectId ? projects.find(p => p.id === task.projectId)?.name : null;
                        return (
                          <div key={task.id} role="button" tabIndex={0} aria-label={task.title} draggable
                            onDragStart={e => onDragStart(e, task)} onDragEnd={onDragEnd}
                            onClick={() => setSelectedTask(task)} onKeyDown={e => e.key === 'Enter' && setSelectedTask(task)}
                            className={`bg-gray-800 border border-gray-700 rounded-lg p-3 border-l-[3px] ${PRIORITY_COLORS[task.priority] ?? ''} hover:border-indigo-500/50 transition-colors cursor-grab active:cursor-grabbing`}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="text-sm font-medium leading-snug">{task.title}</div>
                              {badge && <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${badge.cls}`}>{badge.label}</span>}
                            </div>
                            {task.description && <div className="text-xs text-gray-500 mt-1 line-clamp-2">{task.description}</div>}
                            <div className="flex items-center justify-between mt-2">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs text-gray-600">{task.priority}</span>
                                {taskProjName && (
                                  <span className="text-[10px] px-1.5 py-0.5 bg-gray-700/60 text-gray-400 rounded truncate max-w-[80px]">{taskProjName}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                {subCount > 0 && <span className="text-[10px] text-gray-500 bg-gray-700/50 px-1.5 py-0.5 rounded">⋮ {subCount}</span>}
                                {task.notes && task.notes.length > 0 && <span className="text-[10px] text-gray-600">📝 {task.notes.length}</span>}
                                {task.assignedAgentId && (
                                  <span className="text-[10px] text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded flex items-center gap-1">
                                    <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[agents.find(a => a.id === task.assignedAgentId)?.status ?? ''] ?? 'bg-gray-500'}`} />
                                    {agents.find(a => a.id === task.assignedAgentId)?.name ?? task.assignedAgentId.slice(0, 8)}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {isOver && (
                      <div className="mt-2 border-2 border-dashed border-indigo-500/30 rounded-lg h-12 flex items-center justify-center">
                        <span className="text-xs text-indigo-400/60">Drop here</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Create Project Modal ── */}
      {showCreateProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCreateProject(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-[28rem] space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">New Project</h3>
            <input value={newProjName} onChange={e => setNewProjName(e.target.value)} placeholder="Project name"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200" autoFocus />
            <textarea value={newProjDesc} onChange={e => setNewProjDesc(e.target.value)} placeholder="Description (optional)"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 h-20 resize-none" />
            <input value={newProjRepo} onChange={e => setNewProjRepo(e.target.value)} placeholder="Repository URL (optional)"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowCreateProject(false)} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
              <button onClick={() => void handleCreateProject()} className="text-sm px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Create Project</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Task Modal ── */}
      {showCreateTask && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowCreateTask(false)}>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-7 w-[480px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-5">Create Task</h3>
            <div className="mb-4">
              <label className="block text-sm text-gray-400 mb-1.5">Project</label>
              <select value={taskProjectId} onChange={e => setTaskProjectId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none">
                <option value="">No Project</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <label className="block text-sm text-gray-400 mb-1.5">Title</label>
            <input autoFocus value={taskTitle} onChange={e => setTaskTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void createTask(); }}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none" />
            <label className="block text-sm text-gray-400 mb-1.5">Description</label>
            <textarea value={taskDesc} onChange={e => setTaskDesc(e.target.value)} rows={2}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none resize-none" />
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Priority</label>
                <select value={taskPriority} onChange={e => setTaskPriority(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none">
                  <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
                </select>
              </div>
              {!taskAutoAssign && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Assign to</label>
                  <select value={taskAssignTo} onChange={e => setTaskAssignTo(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none">
                    <option value="">Unassigned</option>
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer mb-5">
              <input type="checkbox" checked={taskAutoAssign} onChange={e => setTaskAutoAssign(e.target.checked)} className="rounded bg-gray-800 border-gray-700" />
              Auto-assign to best available agent
            </label>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowCreateTask(false)} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800">Cancel</button>
              <button onClick={() => void createTask()} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Task Detail Modal ── */}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          agents={agents}
          projects={projects}
          onClose={() => setSelectedTask(null)}
          onRefresh={handleTaskRefresh}
        />
      )}
    </div>
  );
}

// ─── Shared mini-components ─────────────────────────────────────────────────────

function IterModelBadge({ model }: { model: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
      model === 'scrum' ? 'bg-indigo-900/40 text-indigo-300' : 'bg-gray-700 text-gray-400'
    }`}>{model}</span>
  );
}

function StatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-emerald-900/40 text-emerald-400', planning: 'bg-blue-900/40 text-blue-400',
    review: 'bg-amber-900/40 text-amber-400', completed: 'bg-gray-700 text-gray-400',
    archived: 'bg-gray-800 text-gray-500', paused: 'bg-orange-900/40 text-orange-400',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[status] ?? 'bg-gray-700 text-gray-400'}`}>{status}</span>
  );
}
