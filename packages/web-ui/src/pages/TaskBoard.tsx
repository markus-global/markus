import { useEffect, useState } from 'react';
import { api, type TaskInfo } from '../api.ts';

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
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [priority, setPriority] = useState('medium');

  const refresh = () => {
    api.tasks.board().then((d) => setBoard(d.board)).catch(() => {});
  };

  useEffect(() => { refresh(); const i = setInterval(refresh, 5000); return () => clearInterval(i); }, []);

  const createTask = async () => {
    if (!title) return;
    await api.tasks.create(title, desc, priority);
    setTitle('');
    setDesc('');
    setShowCreate(false);
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
                  <div key={task.id} className={`bg-gray-800 border border-gray-700 rounded-lg p-3 border-l-3 ${PRIORITY_COLORS[task.priority] ?? ''} hover:border-indigo-500/50 transition-colors cursor-pointer`}>
                    <div className="text-sm font-medium">{task.title}</div>
                    <div className="text-xs text-gray-500 mt-1">{task.priority} priority</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-7 w-[480px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-5">Create Task</h3>
            <label className="block text-sm text-gray-400 mb-1.5">Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none" />
            <label className="block text-sm text-gray-400 mb-1.5">Description</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-4 focus:border-indigo-500 outline-none resize-none" />
            <label className="block text-sm text-gray-400 mb-1.5">Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-6 focus:border-indigo-500 outline-none">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800">Cancel</button>
              <button onClick={createTask} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
