import { useEffect, useState, useCallback } from 'react';
import { api, wsClient, type TaskInfo, type AgentInfo } from '../api.ts';
import { ConfirmModal } from '../components/ConfirmModal.tsx';

const COLUMNS = ['pending', 'assigned', 'in_progress', 'completed'] as const;
const COLUMN_LABELS: Record<string, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  completed: 'Completed',
};
const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'border-l-red-500',
  high: 'border-l-amber-500',
  medium: 'border-l-blue-500',
  low: 'border-l-gray-500',
};

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

  const loadSubtasks = useCallback(async () => {
    try {
      const d = await api.tasks.listSubtasks(task.id);
      setSubtasks(d.subtasks);
    } catch { /* ok */ }
  }, [task.id]);

  useEffect(() => { void loadSubtasks(); }, [loadSubtasks]);

  const updateStatus = async (taskId: string, status: string) => {
    await api.tasks.updateStatus(taskId, status);
    onRefresh();
    void loadSubtasks();
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

  const completedCount = subtasks.filter(s => s.status === 'completed').length;
  const assignedName = agents.find(a => a.id === task.assignedAgentId)?.name;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-800 rounded-xl w-[520px] max-h-[85vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-gray-800">
          <div className="flex-1 min-w-0 pr-4">
            <h3 className="text-base font-semibold leading-snug">{task.title}</h3>
            {task.description && <p className="text-sm text-gray-400 mt-1">{task.description}</p>}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg shrink-0">×</button>
        </div>

        {/* Meta */}
        <div className="px-6 py-3 border-b border-gray-800/60 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
          <span>Status: <span className="text-gray-300">{task.status}</span></span>
          <span>Priority: <span className="text-gray-300">{task.priority}</span></span>
          <span>Assigned: <span className="text-gray-300">{assignedName ?? 'Unassigned'}</span></span>
          {task.parentTaskId && <span>Parent: <span className="font-mono text-gray-400">{task.parentTaskId.slice(-8)}</span></span>}
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

        {/* Actions */}
        <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between gap-2">
          <div className="flex gap-2 flex-wrap">
            {(task.status === 'pending' || task.status === 'assigned') && (
              <button onClick={() => void updateStatus(task.id, 'in_progress')} className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Start</button>
            )}
            {task.status === 'in_progress' && (
              <button onClick={() => void updateStatus(task.id, 'completed')} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 rounded-lg text-white">Complete</button>
            )}
            {task.status === 'in_progress' && (
              <button onClick={() => void updateStatus(task.id, 'blocked')} className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 rounded-lg text-white">Block</button>
            )}
            {task.status !== 'completed' && task.status !== 'cancelled' && (
              <button onClick={() => void updateStatus(task.id, 'cancelled')} className="px-3 py-1.5 text-xs text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10">Cancel</button>
            )}
          </div>
          <button
            onClick={() => setPendingDeleteParent(true)}
            className="px-3 py-1.5 text-xs text-gray-500 hover:text-red-400 border border-transparent hover:border-red-500/30 rounded-lg transition-colors"
          >
            Delete task
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

  const refresh = useCallback(() => {
    api.tasks.board().then((d) => setBoard(d.board)).catch(() => {});
    api.agents.list().then((d) => setAgents(d.agents)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 15000);
    const unsub = wsClient.on('task:update', () => refresh());
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

  // When a selected task is updated, refresh board and re-fetch the task
  const handleRefresh = () => {
    refresh();
    if (selectedTask) {
      // Re-read the updated task from board after refresh
      setTimeout(() => {
        api.tasks.board().then(d => {
          const allTasks = Object.values(d.board).flat();
          const updated = allTasks.find(t => t.id === selectedTask.id);
          if (updated) setSelectedTask(updated);
          else setSelectedTask(null); // task was deleted
        }).catch(() => {});
      }, 150);
    }
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-7 h-15 border-b border-gray-800 bg-gray-900 shrink-0">
        <h2 className="text-lg font-semibold">Task Board</h2>
        <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg">+ New Task</button>
      </div>

      <div className="flex-1 overflow-x-auto p-7">
        <div className="flex gap-4 min-h-full">
          {COLUMNS.map((col) => (
            <div key={col} className="w-72 shrink-0 bg-gray-900 rounded-xl p-4">
              <div className="flex justify-between items-center mb-3">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{COLUMN_LABELS[col]}</span>
                <span className="text-xs bg-gray-800 px-2 py-0.5 rounded-full">{board[col]?.length ?? 0}</span>
              </div>
              <div className="space-y-2">
                {(board[col] ?? []).filter(t => !t.parentTaskId).map((task) => {
                  const subCount = task.subtaskIds?.length ?? 0;
                  return (
                    <div
                      key={task.id}
                      role="button"
                      tabIndex={0}
                      aria-label={task.title}
                      onClick={() => setSelectedTask(task)}
                      onKeyDown={(e) => e.key === 'Enter' && setSelectedTask(task)}
                      className={`bg-gray-800 border border-gray-700 rounded-lg p-3 border-l-[3px] ${PRIORITY_COLORS[task.priority] ?? ''} hover:border-indigo-500/50 transition-colors cursor-pointer`}
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
                            <span className="text-xs text-indigo-400">
                              {agents.find((a) => a.id === task.assignedAgentId)?.name ?? task.assignedAgentId.slice(0, 8)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
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
