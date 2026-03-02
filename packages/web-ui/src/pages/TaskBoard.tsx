import { useEffect, useState, useCallback, useRef, type DragEvent } from 'react';
import { api, wsClient, type TaskInfo, type AgentInfo, type TaskLogEntry } from '../api.ts';
import { ConfirmModal } from '../components/ConfirmModal.tsx';

const ALL_STATUSES = ['pending', 'assigned', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled'] as const;
const COLUMN_LABELS: Record<string, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const COLUMN_ACCENT: Record<string, string> = {
  pending: 'border-t-gray-500',
  assigned: 'border-t-blue-500',
  in_progress: 'border-t-indigo-500',
  blocked: 'border-t-amber-500',
  completed: 'border-t-green-500',
  failed: 'border-t-red-500',
  cancelled: 'border-t-gray-600',
};
const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'border-l-red-500',
  high: 'border-l-amber-500',
  medium: 'border-l-blue-500',
  low: 'border-l-gray-500',
};
const STATUS_DOT: Record<string, string> = {
  pending: 'bg-gray-400',
  assigned: 'bg-blue-400',
  in_progress: 'bg-indigo-400',
  blocked: 'bg-amber-400',
  completed: 'bg-green-400',
  failed: 'bg-red-400',
  cancelled: 'bg-gray-600',
};

// ─── Execution Log Panel ────────────────────────────────────────────────────────

function LogEntryRow({ entry }: { entry: TaskLogEntry }) {
  if (entry.type === 'status') {
    const isCompleted = entry.content === 'completed';
    const isStarted = entry.content === 'started';
    const color = isCompleted ? 'text-green-400' : isStarted ? 'text-blue-400' : 'text-gray-500';
    const dot = isCompleted ? 'bg-green-400' : isStarted ? 'bg-blue-400' : 'bg-gray-500';
    return (
      <div className="flex items-center gap-2 py-0.5 px-1">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        <span className={`text-xs capitalize ${color}`}>{entry.content}</span>
      </div>
    );
  }
  if (entry.type === 'text') {
    return (
      <div className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed bg-gray-800/50 rounded-lg px-3 py-2.5 my-1">
        {entry.content}
      </div>
    );
  }
  if (entry.type === 'tool_start') {
    return (
      <div className="flex items-center gap-2 py-1 px-1">
        <svg className="w-3 h-3 text-indigo-400 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" strokeLinecap="round" />
        </svg>
        <span className="text-xs text-indigo-300 font-medium">{entry.content}</span>
        <span className="text-xs text-gray-600">calling…</span>
      </div>
    );
  }
  if (entry.type === 'tool_end') {
    const success = (entry.metadata as Record<string, unknown> | undefined)?.success !== false;
    return (
      <div className="flex items-center gap-2 py-0.5 px-1">
        <span className={`text-xs ${success ? 'text-green-400' : 'text-red-400'}`}>
          {success ? '✓' : '✗'}
        </span>
        <span className={`text-xs font-medium ${success ? 'text-green-300' : 'text-red-300'}`}>{entry.content}</span>
        {!success && entry.metadata && (entry.metadata as Record<string, unknown>).error && (
          <span className="text-xs text-red-400 truncate">{String((entry.metadata as Record<string, unknown>).error)}</span>
        )}
      </div>
    );
  }
  if (entry.type === 'error') {
    return (
      <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2.5 py-2 my-1 leading-relaxed">
        <span className="font-medium">Error:</span> {entry.content}
      </div>
    );
  }
  return null;
}

/** Remove tool_start entries that have a matching tool_end later in the list.
 *  This prevents showing "calling…" for tools that have already completed. */
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
  // Initialise from prop so we show "Thinking…" immediately when modal is opened
  // while a heartbeat-triggered task is already in_progress.
  const [isExecuting, setIsExecuting] = useState(isRunning);
  const [loading, setLoading] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Keep isExecuting in sync when the parent task status changes (e.g. heartbeat flip)
  useEffect(() => {
    setIsExecuting(isRunning);
  }, [isRunning]);

  useEffect(() => {
    setLoading(true);
    api.tasks.getLogs(taskId).then(d => {
      setLogs(d.logs);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [taskId]);

  useEffect(() => {
    const unsubLog = wsClient.on('task:log', (event) => {
      const p = event.payload;
      if (p.taskId !== taskId) return;
      const entry: TaskLogEntry = {
        id: p.id as string,
        taskId: p.taskId as string,
        agentId: p.agentId as string,
        seq: p.seq as number,
        type: p.logType as string,
        content: p.content as string,
        metadata: p.metadata as Record<string, unknown> | undefined,
        createdAt: p.createdAt as string,
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

  // Scroll to bottom when logs update (live) or when tab becomes visible
  useEffect(() => {
    if (isVisible) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, streamingText, isVisible]);

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-xs text-gray-600">Loading logs…</div>;
  }

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
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5">
      {visibleLogs.map((entry, i) => <LogEntryRow key={`${entry.seq}-${i}`} entry={entry} />)}
      {streamingText && (
        <div className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed bg-gray-800/50 rounded-lg px-3 py-2.5 my-1">
          {streamingText}
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

// ─── Task Detail Modal ─────────────────────────────────────────────────────────

function TaskDetailModal({
  task, agents, onClose, onRefresh,
}: {
  task: TaskInfo;
  agents: AgentInfo[];
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
    try {
      const d = await api.tasks.listSubtasks(task.id);
      setSubtasks(d.subtasks);
    } catch { /* ok */ }
  }, [task.id]);

  useEffect(() => { void loadSubtasks(); }, [loadSubtasks]);

  const doUpdate = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      onRefresh();
      void loadSubtasks();
    } finally {
      setBusy(false);
    }
  };

  const updateStatus = (taskId: string, status: string) =>
    doUpdate(() => api.tasks.updateStatus(taskId, status));

  const updatePriority = (priority: string) =>
    doUpdate(() => api.tasks.update(task.id, { priority }));

  const assignAgent = (agentId: string) =>
    doUpdate(() => api.tasks.assign(task.id, agentId || null));

  const startTask = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!task.assignedAgentId) {
        const idle = agents.find(a => a.status === 'idle');
        if (idle) {
          await api.tasks.assign(task.id, idle.id);
        }
      }
      await api.tasks.updateStatus(task.id, 'in_progress');
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const pauseTask = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const nextStatus = task.assignedAgentId ? 'assigned' : 'pending';
      await api.tasks.updateStatus(task.id, nextStatus);
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const addSubtask = async () => {
    if (!newSubtask.trim()) return;
    await api.tasks.createSubtask(task.id, newSubtask.trim());
    setNewSubtask('');
    setAddingSubtask(false);
    void loadSubtasks();
    onRefresh();
  };

  const toggleSubtask = async (sub: TaskInfo) => {
    const next = sub.status === 'completed' ? 'pending' : 'completed';
    await api.tasks.updateStatus(sub.id, next);
    void loadSubtasks();
    onRefresh();
  };

  const deleteSubtask = async (sub: TaskInfo) => {
    await api.tasks.delete(sub.id);
    setPendingDelete(null);
    void loadSubtasks();
    onRefresh();
  };

  const deleteParent = async () => {
    await api.tasks.delete(task.id);
    setPendingDeleteParent(false);
    onClose();
    onRefresh();
  };

  const reopenTask = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.tasks.updateStatus(task.id, 'pending');
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const runWithAgent = async () => {
    if (running) return;
    setRunning(true);
    setRunError(null);
    setActiveTab('logs');
    try {
      await api.tasks.run(task.id);
      onRefresh();
    } catch (err) {
      const msg = String(err).replace('Error: API error: 400', 'Server error').replace('Error: ', '');
      setRunError(msg);
    } finally {
      setRunning(false);
    }
  };

  // Auto-switch to logs tab when execution starts via WS
  useEffect(() => {
    const unsub = wsClient.on('task:log:delta', (event) => {
      if (event.payload.taskId === task.id) setActiveTab('logs');
    });
    return unsub;
  }, [task.id]);

  const completedCount = subtasks.filter(s => s.status === 'completed').length;
  const assignedAgent = agents.find(a => a.id === task.assignedAgentId);
  const isRunning = task.status === 'in_progress';
  const isBlocked = task.status === 'blocked';
  const isCompleted = task.status === 'completed';
  const isFailed = task.status === 'failed';
  const isCancelled = task.status === 'cancelled';
  const isTerminal = isCompleted || isFailed || isCancelled;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-800 rounded-xl w-[600px] max-h-[88vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-gray-800">
          <div className="flex-1 min-w-0 pr-4">
            <h3 className="text-base font-semibold leading-snug">{task.title}</h3>
            {task.description && <p className="text-sm text-gray-400 mt-1">{task.description}</p>}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg shrink-0">×</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-6 pt-3 border-b border-gray-800 shrink-0">
          <button
            onClick={() => setActiveTab('details')}
            className={`px-3 py-1.5 text-xs rounded-t-md transition-colors ${
              activeTab === 'details'
                ? 'bg-gray-800 text-gray-100 font-medium'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            Details
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`px-3 py-1.5 text-xs rounded-t-md transition-colors flex items-center gap-1.5 ${
              activeTab === 'logs'
                ? 'bg-gray-800 text-gray-100 font-medium'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            Execution Log
            {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />}
          </button>
        </div>

        {/* Logs tab — always mounted so WS events aren't missed; hidden when on details tab */}
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
            {/* Editable Meta */}
            <div className="px-6 py-4 border-b border-gray-800/60 space-y-3">
              <div className="grid grid-cols-3 gap-4">
                {/* Status */}
                <div>
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Status</label>
                  <select
                    value={task.status}
                    onChange={e => void updateStatus(task.id, e.target.value)}
                    disabled={busy}
                    className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-200 focus:border-indigo-500 outline-none disabled:opacity-50 cursor-pointer"
                  >
                    {ALL_STATUSES.map(s => (
                      <option key={s} value={s}>{COLUMN_LABELS[s]}</option>
                    ))}
                  </select>
                </div>

                {/* Priority */}
                <div>
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Priority</label>
                  <select
                    value={task.priority}
                    onChange={e => void updatePriority(e.target.value)}
                    disabled={busy}
                    className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-200 focus:border-indigo-500 outline-none disabled:opacity-50 cursor-pointer"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>

                {/* Assignee */}
                <div>
                  <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Assignee</label>
                  <select
                    value={task.assignedAgentId ?? ''}
                    onChange={e => void assignAgent(e.target.value)}
                    disabled={busy}
                    className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-200 focus:border-indigo-500 outline-none disabled:opacity-50 cursor-pointer"
                  >
                    <option value="">Unassigned</option>
                    {agents.map(a => (
                      <option key={a.id} value={a.id}>{a.name} ({a.status})</option>
                    ))}
                  </select>
                </div>
              </div>

              {task.parentTaskId && (
                <div className="text-xs text-gray-500">
                  Parent: <span className="font-mono text-gray-400">{task.parentTaskId.slice(-8)}</span>
                </div>
              )}
            </div>

            {/* Subtasks */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Subtasks {subtasks.length > 0 && (
                    <span className="ml-1.5 text-gray-500 font-normal normal-case">
                      {completedCount}/{subtasks.length} done
                    </span>
                  )}
                </span>
                <button
                  onClick={() => setAddingSubtask(true)}
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  + Add subtask
                </button>
              </div>

              {subtasks.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  {subtasks.map(sub => (
                    <div
                      key={sub.id}
                      className="group flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-gray-800/50 transition-colors"
                    >
                      <button
                        onClick={() => void toggleSubtask(sub)}
                        className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                          sub.status === 'completed'
                            ? 'bg-green-600 border-green-600 text-white'
                            : 'border-gray-600 hover:border-indigo-500'
                        }`}
                        title={sub.status === 'completed' ? 'Mark incomplete' : 'Mark complete'}
                      >
                        {sub.status === 'completed' && (
                          <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="none">
                            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </button>
                      <span className={`flex-1 text-sm ${sub.status === 'completed' ? 'line-through text-gray-500' : 'text-gray-300'}`}>
                        {sub.title}
                      </span>
                      <span className={`text-[10px] shrink-0 ${
                        sub.priority === 'urgent' ? 'text-red-400' :
                        sub.priority === 'high' ? 'text-amber-400' :
                        sub.priority === 'low' ? 'text-gray-600' : 'text-gray-600'
                      }`}>
                        {sub.priority !== 'medium' ? sub.priority : ''}
                      </span>
                      <button
                        onClick={() => setPendingDelete(sub)}
                        className="shrink-0 opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all text-xs"
                        title="Delete subtask"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {subtasks.length === 0 && !addingSubtask && (
                <div className="text-xs text-gray-600 text-center py-4">
                  No subtasks yet. Break this task into smaller steps.
                </div>
              )}

              {addingSubtask && (
                <div className="flex gap-2 mt-2">
                  <input
                    autoFocus
                    value={newSubtask}
                    onChange={e => setNewSubtask(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void addSubtask();
                      if (e.key === 'Escape') { setAddingSubtask(false); setNewSubtask(''); }
                    }}
                    placeholder="Subtask title..."
                    className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none"
                  />
                  <button onClick={() => void addSubtask()} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg">Add</button>
                  <button onClick={() => { setAddingSubtask(false); setNewSubtask(''); }} className="px-3 py-1.5 border border-gray-700 text-xs rounded-lg hover:bg-gray-800">Cancel</button>
                </div>
              )}

              {/* Notes */}
              {task.notes && task.notes.length > 0 && (
                <div className="mt-5">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Progress Notes</p>
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {task.notes.map((note, i) => (
                      <div key={i} className="text-xs text-gray-400 bg-gray-800/60 rounded px-2.5 py-1.5 leading-relaxed">{note}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Actions — follow the task state machine strictly */}
        <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between gap-2">
          <div className="flex gap-2 flex-wrap">

            {/* ── pending / assigned / blocked: Run with Agent (triggers LLM execution) */}
            {task.assignedAgentId && !isRunning && !isTerminal && (
              <button
                onClick={() => void runWithAgent()}
                disabled={running}
                className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white disabled:opacity-50 flex items-center gap-1.5"
              >
                {running ? (
                  <>
                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83" strokeLinecap="round" />
                    </svg>
                    Running…
                  </>
                ) : (
                  <>
                    <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7-4.5-7-4.5z" /></svg>
                    Run with Agent
                  </>
                )}
              </button>
            )}

            {/* ── in_progress: Pause (status → assigned/pending, execution continues) */}
            {isRunning && (
              <button
                onClick={() => void pauseTask()}
                disabled={busy}
                className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 rounded-lg text-white disabled:opacity-50 flex items-center gap-1.5"
                title="Change status to assigned/pending (does not abort running agent)"
              >
                <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
                  <rect x="2" y="1.5" width="3" height="9" rx="0.5" />
                  <rect x="7" y="1.5" width="3" height="9" rx="0.5" />
                </svg>
                Pause
              </button>
            )}

            {/* ── in_progress: Block */}
            {isRunning && (
              <button
                onClick={() => void updateStatus(task.id, 'blocked')}
                disabled={busy}
                className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 rounded-lg text-white disabled:opacity-50"
              >
                Block
              </button>
            )}

            {/* ── blocked: Unblock (manual status change, no agent execution) */}
            {isBlocked && (
              <button
                onClick={() => void startTask()}
                disabled={busy}
                className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-200 disabled:opacity-50"
                title="Mark as in-progress without running agent"
              >
                Unblock
              </button>
            )}

            {/* ── pending / assigned: Mark In Progress (manual, no agent execution) */}
            {(task.status === 'pending' || task.status === 'assigned') && (
              <button
                onClick={() => void startTask()}
                disabled={busy}
                className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-200 disabled:opacity-50"
                title="Mark as in-progress without running agent"
              >
                Mark In Progress
              </button>
            )}

            {/* ── completed / failed: Run Again (re-execute with agent) */}
            {(isCompleted || isFailed) && task.assignedAgentId && (
              <button
                onClick={() => void runWithAgent()}
                disabled={running}
                className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white disabled:opacity-50 flex items-center gap-1.5"
              >
                <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M1 6a5 5 0 019.33-2.5M11 6a5 5 0 01-9.33 2.5" strokeLinecap="round" />
                  <path d="M10.33 1v2.5H7.83M1.67 11V8.5H4.17" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Run Again
              </button>
            )}

            {/* ── all terminal: Reopen → back to pending */}
            {isTerminal && (
              <button
                onClick={() => void reopenTask()}
                disabled={busy}
                className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-200 disabled:opacity-50"
              >
                Reopen
              </button>
            )}

            {/* ── all non-terminal: Complete */}
            {!isTerminal && (
              <button
                onClick={() => void updateStatus(task.id, 'completed')}
                disabled={busy}
                className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 rounded-lg text-white disabled:opacity-50"
              >
                Complete
              </button>
            )}

            {/* ── all non-terminal: Cancel */}
            {!isTerminal && (
              <button
                onClick={() => void updateStatus(task.id, 'cancelled')}
                disabled={busy}
                className="px-3 py-1.5 text-xs text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50"
              >
                Cancel
              </button>
            )}
          </div>
          <button
            onClick={() => setPendingDeleteParent(true)}
            className="px-3 py-1.5 text-xs text-gray-500 hover:text-red-400 border border-transparent hover:border-red-500/30 rounded-lg transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {pendingDelete && (
        <ConfirmModal
          title={`Delete subtask "${pendingDelete.title}"?`}
          message="This subtask will be permanently deleted."
          confirmLabel="Delete"
          onConfirm={() => void deleteSubtask(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingDeleteParent && (
        <ConfirmModal
          title={`Delete task "${task.title}"?`}
          message={subtasks.length > 0 ? `This will also delete all ${subtasks.length} subtask(s).` : 'This task will be permanently deleted.'}
          confirmLabel="Delete Task"
          onConfirm={() => void deleteParent()}
          onCancel={() => setPendingDeleteParent(false)}
        />
      )}
    </div>
  );
}

// ─── Main TaskBoard ────────────────────────────────────────────────────────────

export function TaskBoard() {
  const [board, setBoard] = useState<Record<string, TaskInfo[]>>({});
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [priority, setPriority] = useState('medium');
  const [autoAssign, setAutoAssign] = useState(true);
  const [assignTo, setAssignTo] = useState('');
  const [selectedTask, setSelectedTask] = useState<TaskInfo | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const dragTaskRef = useRef<TaskInfo | null>(null);

  const refresh = useCallback(() => {
    api.tasks.board().then((d) => setBoard(d.board)).catch(() => {});
    api.agents.list().then((d) => setAgents(d.agents)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 15000);
    const unsub = wsClient.on('task:update', (event) => {
      refresh();
      // If the updated task is currently open in the modal, sync its status immediately
      // without waiting for the next refresh so the modal doesn't show stale data.
      const p = event?.payload as { taskId?: string; status?: string; title?: string } | undefined;
      if (p?.taskId && p.status) {
        setSelectedTask(prev =>
          prev && prev.id === p.taskId ? { ...prev, status: p.status as TaskInfo['status'] } : prev
        );
      }
    });
    return () => { clearInterval(i); unsub(); };
  }, [refresh]);

  const createTask = async () => {
    if (!title) return;
    await api.tasks.create(title, desc, priority, autoAssign ? undefined : assignTo || undefined, autoAssign);
    setTitle('');
    setDesc('');
    setShowCreate(false);
    refresh();
  };

  const handleRefresh = () => {
    refresh();
    if (selectedTask) {
      setTimeout(() => {
        api.tasks.board().then(d => {
          const allTasks = Object.values(d.board).flat();
          const updated = allTasks.find(t => t.id === selectedTask.id);
          if (updated) setSelectedTask(updated);
          else setSelectedTask(null);
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
    dragTaskRef.current = null;
    setDragOverCol(null);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>, col: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverCol !== col) setDragOverCol(col);
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>, col: string) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { clientX: x, clientY: y } = e;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      if (dragOverCol === col) setDragOverCol(null);
    }
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>, col: string) => {
    e.preventDefault();
    setDragOverCol(null);
    const task = dragTaskRef.current;
    if (!task || task.status === col) return;
    try {
      await api.tasks.updateStatus(task.id, col);
      refresh();
    } catch { /* ok */ }
  };

  const visibleColumns = ALL_STATUSES.filter(col => {
    const tasks = board[col] ?? [];
    const hasRootTasks = tasks.some(t => !t.parentTaskId);
    if (col === 'failed' || col === 'cancelled') return hasRootTasks;
    return true;
  });

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-7 h-15 border-b border-gray-800 bg-gray-900 shrink-0">
        <h2 className="text-lg font-semibold">Task Board</h2>
        <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg">+ New Task</button>
      </div>

      <div className="flex-1 overflow-x-auto p-7">
        <div className="flex gap-4 min-h-full">
          {visibleColumns.map((col) => {
            const colTasks = (board[col] ?? []).filter(t => !t.parentTaskId);
            const isOver = dragOverCol === col;
            return (
              <div
                key={col}
                className={`w-64 shrink-0 rounded-xl p-4 border-t-2 transition-colors ${COLUMN_ACCENT[col]} ${
                  isOver ? 'bg-gray-800/80 ring-1 ring-indigo-500/40' : 'bg-gray-900'
                }`}
                onDragOver={e => onDragOver(e, col)}
                onDragLeave={e => onDragLeave(e, col)}
                onDrop={e => void onDrop(e, col)}
              >
                <div className="flex justify-between items-center mb-3">
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{COLUMN_LABELS[col]}</span>
                  <span className="text-xs bg-gray-800 px-2 py-0.5 rounded-full">{colTasks.length}</span>
                </div>
                <div className="space-y-2">
                  {colTasks.map((task) => {
                    const subCount = task.subtaskIds?.length ?? 0;
                    return (
                      <div
                        key={task.id}
                        role="button"
                        tabIndex={0}
                        aria-label={task.title}
                        draggable
                        onDragStart={e => onDragStart(e, task)}
                        onDragEnd={onDragEnd}
                        onClick={() => setSelectedTask(task)}
                        onKeyDown={(e) => e.key === 'Enter' && setSelectedTask(task)}
                        className={`bg-gray-800 border border-gray-700 rounded-lg p-3 border-l-[3px] ${PRIORITY_COLORS[task.priority] ?? ''} hover:border-indigo-500/50 transition-colors cursor-grab active:cursor-grabbing`}
                      >
                        <div className="text-sm font-medium leading-snug">{task.title}</div>
                        {task.description && <div className="text-xs text-gray-500 mt-1 line-clamp-2">{task.description}</div>}
                        <div className="flex items-center justify-between mt-2">
                          <span className="text-xs text-gray-600">{task.priority}</span>
                          <div className="flex items-center gap-2">
                            {subCount > 0 && (
                              <span className="text-[10px] text-gray-500 bg-gray-700/50 px-1.5 py-0.5 rounded">
                                ⋮ {subCount}
                              </span>
                            )}
                            {task.notes && task.notes.length > 0 && (
                              <span className="text-[10px] text-gray-600">📝 {task.notes.length}</span>
                            )}
                            {task.assignedAgentId && (
                              <span className="text-[10px] text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded flex items-center gap-1">
                                <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[agents.find(a => a.id === task.assignedAgentId)?.status ?? ''] ?? 'bg-gray-500'}`} />
                                {agents.find((a) => a.id === task.assignedAgentId)?.name ?? task.assignedAgentId.slice(0, 8)}
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

      {/* Create Task Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-7 w-[480px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-5">Create Task</h3>
            <label className="block text-sm text-gray-400 mb-1.5">Title</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void createTask(); }}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none"
            />
            <label className="block text-sm text-gray-400 mb-1.5">Description</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none resize-none" />
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Priority</label>
                <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none">
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              {!autoAssign && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Assign to</label>
                  <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none">
                    <option value="">Unassigned</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer mb-5">
              <input type="checkbox" checked={autoAssign} onChange={(e) => setAutoAssign(e.target.checked)} className="rounded bg-gray-800 border-gray-700" />
              Auto-assign to best available agent
            </label>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800">Cancel</button>
              <button onClick={() => void createTask()} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Create</button>
            </div>
          </div>
        </div>
      )}

      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          agents={agents}
          onClose={() => setSelectedTask(null)}
          onRefresh={handleRefresh}
        />
      )}
    </div>
  );
}
