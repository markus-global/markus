import { useEffect, useState } from 'react';
import { api, wsClient, type TaskInfo, type AgentInfo } from '../api.ts';

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

  const refresh = () => {
    api.tasks.board().then((d) => setBoard(d.board)).catch(() => {});
    api.agents.list().then((d) => setAgents(d.agents)).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 15000);
    const unsub = wsClient.on('task:update', () => refresh());
    return () => { clearInterval(i); unsub(); };
  }, []);

  const createTask = async () => {
    if (!title) return;
    await api.tasks.create(title, desc, priority, autoAssign ? undefined : assignTo || undefined, autoAssign);
    setTitle('');
    setDesc('');
    setShowCreate(false);
    refresh();
  };

  const updateStatus = async (taskId: string, status: string) => {
    await api.tasks.updateStatus(taskId, status);
    setSelectedTask(null);
    refresh();
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
                {(board[col] ?? []).map((task) => (
                  <div
                    key={task.id}
                    onClick={() => setSelectedTask(task)}
                    className={`bg-gray-800 border border-gray-700 rounded-lg p-3 border-l-3 ${PRIORITY_COLORS[task.priority] ?? ''} hover:border-indigo-500/50 transition-colors cursor-pointer`}
                  >
                    <div className="text-sm font-medium">{task.title}</div>
                    {task.description && <div className="text-xs text-gray-500 mt-1 line-clamp-2">{task.description}</div>}
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-xs text-gray-500">{task.priority}</span>
                      {task.assignedAgentId && (
                        <span className="text-xs text-indigo-400">
                          {agents.find((a) => a.id === task.assignedAgentId)?.name ?? task.assignedAgentId.slice(0, 12)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
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
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none" />
            <label className="block text-sm text-gray-400 mb-1.5">Description</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none resize-none" />
            <label className="block text-sm text-gray-400 mb-1.5">Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>

            <div className="flex items-center gap-3 mb-4">
              <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
                <input type="checkbox" checked={autoAssign} onChange={(e) => setAutoAssign(e.target.checked)}
                  className="rounded bg-gray-800 border-gray-700" />
                Auto-assign to best available agent
              </label>
            </div>

            {!autoAssign && (
              <>
                <label className="block text-sm text-gray-400 mb-1.5">Assign to</label>
                <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none">
                  <option value="">Unassigned</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}
                </select>
              </>
            )}

            <div className="flex justify-end gap-3 mt-2">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800">Cancel</button>
              <button onClick={createTask} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Task Detail Drawer */}
      {selectedTask && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setSelectedTask(null)}>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-7 w-[480px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">{selectedTask.title}</h3>
              <button onClick={() => setSelectedTask(null)} className="text-gray-500 hover:text-gray-300">&times;</button>
            </div>
            {selectedTask.description && <p className="text-sm text-gray-400 mb-4">{selectedTask.description}</p>}
            <div className="space-y-2 text-sm mb-6">
              <div className="flex justify-between"><span className="text-gray-500">Status</span><span>{selectedTask.status}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Priority</span><span>{selectedTask.priority}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Assigned</span><span>{selectedTask.assignedAgentId ? agents.find((a) => a.id === selectedTask.assignedAgentId)?.name ?? selectedTask.assignedAgentId : 'Unassigned'}</span></div>
            </div>
            <div className="flex flex-wrap gap-2">
              {selectedTask.status === 'pending' && <button onClick={() => updateStatus(selectedTask.id, 'in_progress')} className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Start</button>}
              {selectedTask.status === 'assigned' && <button onClick={() => updateStatus(selectedTask.id, 'in_progress')} className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Start</button>}
              {selectedTask.status === 'in_progress' && <button onClick={() => updateStatus(selectedTask.id, 'completed')} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 rounded-lg text-white">Complete</button>}
              {selectedTask.status === 'in_progress' && <button onClick={() => updateStatus(selectedTask.id, 'blocked')} className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 rounded-lg text-white">Block</button>}
              {selectedTask.status !== 'completed' && selectedTask.status !== 'cancelled' && <button onClick={() => updateStatus(selectedTask.id, 'cancelled')} className="px-3 py-1.5 text-xs text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10">Cancel</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
