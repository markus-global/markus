import { useState, useEffect, useCallback, useRef, type DragEvent } from 'react';
import { api, wsClient, type ProjectInfo, type IterationInfo, type TaskInfo, type AgentInfo, type TaskLogEntry, type RequirementInfo } from '../api.ts';
import { ConfirmModal } from '../components/ConfirmModal.tsx';
import { LogEntryRow } from '../components/ToolCallLogEntry.tsx';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { navBus } from '../navBus.ts';

function AgentNameLink({ agentId, agents }: { agentId: string; agents: AgentInfo[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const agent = agents.find(a => a.id === agentId);
  const displayName = agent?.name ?? agentId.slice(0, 10);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <span ref={ref} className="relative inline-block">
      <button onClick={() => setOpen(!open)} className="text-indigo-400 hover:text-indigo-300 hover:underline cursor-pointer">
        {displayName}
      </button>
      {open && agent && (
        <div className="absolute left-0 bottom-full mb-1.5 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-40 w-56 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-indigo-600/30 flex items-center justify-center text-[10px] font-bold text-indigo-300">
              {agent.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-gray-200 font-medium truncate">{agent.name}</div>
              <div className="text-[10px] text-gray-500">{agent.role} · {agent.agentRole ?? 'worker'}</div>
            </div>
            <span className={`w-2 h-2 rounded-full shrink-0 ${agent.status === 'working' ? 'bg-yellow-400 animate-pulse' : agent.status === 'error' ? 'bg-red-400' : 'bg-green-400'}`} />
          </div>
          <button
            onClick={() => { setOpen(false); navBus.navigate('team', { agentId: agent.id }); }}
            className="w-full text-center text-[10px] text-indigo-400 hover:text-indigo-300 border border-gray-700 hover:border-gray-600 rounded-lg py-1 transition-colors"
          >
            View Profile →
          </button>
        </div>
      )}
      {open && !agent && (
        <div className="absolute left-0 bottom-full mb-1.5 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-40 w-40 p-2">
          <div className="text-[10px] text-gray-500">Agent not found: {agentId.slice(0, 12)}…</div>
        </div>
      )}
    </span>
  );
}

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
  task, agents, projects, requirements, onClose, onRefresh,
}: {
  task: TaskInfo;
  agents: AgentInfo[];
  projects: ProjectInfo[];
  requirements: RequirementInfo[];
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
  const isRunning = task.status === 'in_progress';
  const isBlocked = task.status === 'blocked';
  const isCompleted = task.status === 'completed';
  const isFailed = task.status === 'failed';
  const isCancelled = task.status === 'cancelled';
  const isArchived = task.status === 'archived';
  const isTerminal = isCompleted || isFailed || isCancelled || isArchived;
  void isBlocked;

  const taskProject = projects.find(p => p.id === task.projectId);
  const taskRequirement = requirements.find(r => r.id === task.requirementId);
  const assignedAgent = agents.find(a => a.id === task.assignedAgentId);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-[600px] max-h-[88vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header – title & close only */}
        <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b border-gray-800 shrink-0">
          <h3 className="text-base font-semibold leading-snug flex-1 min-w-0 pr-4">{task.title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg shrink-0">×</button>
        </div>

        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Description */}
          {task.description && (
            <div className="px-6 pt-4 pb-3 border-b border-gray-800">
              <MarkdownMessage content={task.description} className="text-sm text-gray-400 leading-relaxed" />
            </div>
          )}

          {/* Context badges — project, requirement */}
          {(taskProject || taskRequirement || task.parentTaskId) && (
            <div className="px-6 py-2.5 border-b border-gray-800 flex flex-wrap items-center gap-2">
              {taskProject && (
                <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 bg-indigo-500/10 text-indigo-300 rounded-full">
                  <span className="text-[9px] text-indigo-400/60">Project</span>
                  {taskProject.name}
                </span>
              )}
              {taskRequirement && (
                <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 bg-purple-500/10 text-purple-300 rounded-full">
                  <span className="text-[9px] text-purple-400/60">Req</span>
                  {taskRequirement.title.length > 40 ? taskRequirement.title.slice(0, 40) + '…' : taskRequirement.title}
                </span>
              )}
              {task.parentTaskId && (
                <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 bg-gray-700/60 text-gray-400 rounded-full">
                  <span className="text-[9px] text-gray-500">Subtask of</span>
                  <span className="font-mono">{task.parentTaskId.slice(-8)}</span>
                </span>
              )}
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-1 px-6 pt-3 border-b border-gray-800 sticky top-0 z-10 bg-gray-900">
            <button onClick={() => setActiveTab('details')} className={`px-3 py-1.5 text-xs rounded-t-md transition-colors ${activeTab === 'details' ? 'bg-gray-800 text-gray-100 font-medium' : 'text-gray-500 hover:text-gray-300'}`}>Details</button>
            <button onClick={() => setActiveTab('logs')} className={`px-3 py-1.5 text-xs rounded-t-md transition-colors flex items-center gap-1.5 ${activeTab === 'logs' ? 'bg-gray-800 text-gray-100 font-medium' : 'text-gray-500 hover:text-gray-300'}`}>
              Execution Log
              {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />}
            </button>
          </div>

          {/* Logs tab */}
          <div className={activeTab !== 'logs' ? 'hidden' : ''}>
            {runError && (
              <div className="mx-4 mt-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
                <span className="font-medium">Failed to start:</span> {runError}
              </div>
            )}
            <TaskExecutionLogs taskId={task.id} isVisible={activeTab === 'logs'} isRunning={task.status === 'in_progress'} />
          </div>

          {activeTab === 'details' && (
            <>
              {/* Editable fields */}
              <div className="px-6 py-4 border-b border-gray-800/60 space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Status</label>
                    <select value={task.status} onChange={e => void updateStatus(task.id, e.target.value)} disabled={busy || task.status === 'pending_approval'}
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
              </div>

              {/* Requirement link */}
              <div className="px-6 py-2.5 border-b border-gray-800/60">
                <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-1">Requirement</p>
                {taskRequirement ? (
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                      taskRequirement.status === 'approved' ? 'bg-green-500/15 text-green-400' :
                      taskRequirement.status === 'in_progress' ? 'bg-indigo-500/15 text-indigo-400' :
                      'bg-gray-500/15 text-gray-400'
                    }`}>{taskRequirement.status}</span>
                    <span className="text-xs text-gray-300">{taskRequirement.title}</span>
                  </div>
                ) : (
                  <p className="text-xs text-amber-500/70">Not linked to a requirement</p>
                )}
              </div>

              {/* Read-only metadata */}
              <div className="px-6 py-3 border-b border-gray-800/60 grid grid-cols-3 gap-x-4 gap-y-2.5">
                <div>
                  <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-0.5">Created by</p>
                  <p className="text-xs text-gray-400">{task.createdBy ? (agents.find(a => a.id === task.createdBy)?.name ?? task.createdBy) : <span className="text-gray-600">—</span>}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-0.5">Assignee</p>
                  <p className="text-xs text-gray-400">{assignedAgent ? assignedAgent.name : <span className="text-amber-500/70">Unassigned</span>}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-0.5">Last updated by</p>
                  <p className="text-xs text-gray-400">{task.updatedBy ? (agents.find(a => a.id === task.updatedBy)?.name ?? task.updatedBy) : <span className="text-gray-600">—</span>}</p>
                </div>
                {task.createdAt && (
                  <div>
                    <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-0.5">Created</p>
                    <p className="text-xs text-gray-500">{new Date(task.createdAt).toLocaleString()}</p>
                  </div>
                )}
                {task.updatedAt && (
                  <div>
                    <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-0.5">Updated</p>
                    <p className="text-xs text-gray-500">{new Date(task.updatedAt).toLocaleString()}</p>
                  </div>
                )}
                {task.startedAt && (
                  <div>
                    <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-0.5">Started</p>
                    <p className="text-xs text-gray-500">{new Date(task.startedAt).toLocaleString()}</p>
                  </div>
                )}
              </div>

              <div className="px-6 py-4">
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
                    <div className="space-y-1.5">
                      {task.notes.map((note, i) => <div key={i} className="text-xs text-gray-400 bg-gray-800/60 rounded px-2.5 py-1.5 leading-relaxed"><MarkdownMessage content={note} className="text-xs text-gray-400" /></div>)}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between gap-2">
          <div className="flex gap-2 flex-wrap">
            {task.status === 'pending_approval' && (
              <>
                <button onClick={() => doUpdate(() => api.tasks.approve(task.id))} disabled={busy} className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white disabled:opacity-50">Approve</button>
                <button onClick={() => doUpdate(() => api.tasks.reject(task.id))} disabled={busy} className="px-3 py-1.5 text-xs text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50">Reject</button>
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

// ─── Inline Requirements (sits above the board) ─────────────────────────────────

const REQ_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  draft:          { label: 'Draft',     cls: 'bg-gray-500/15 text-gray-400' },
  pending_review: { label: 'Pending',   cls: 'bg-yellow-500/15 text-yellow-400' },
  approved:       { label: 'Approved',  cls: 'bg-green-500/15 text-green-400' },
  in_progress:    { label: 'Active',    cls: 'bg-indigo-500/15 text-indigo-400' },
  completed:      { label: 'Done',      cls: 'bg-emerald-500/15 text-emerald-400' },
  rejected:       { label: 'Rejected',  cls: 'bg-red-500/15 text-red-400' },
  cancelled:      { label: 'Cancelled', cls: 'bg-gray-600/15 text-gray-500' },
};

function InlineRequirements({
  projectId,
  projects,
  agents,
  onFlash,
  triggerCreate = 0,
}: {
  projectId?: string;
  projects: ProjectInfo[];
  agents: AgentInfo[];
  onFlash: (m: string) => void;
  triggerCreate?: number;
}) {
  const [reqs, setReqs] = useState<RequirementInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [priority, setPriority] = useState('medium');
  const [createProjectId, setCreateProjectId] = useState(projectId ?? '');
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const filters: Record<string, string> = {};
      if (projectId) filters.projectId = projectId;
      const { requirements } = await api.requirements.list(filters);
      setReqs(requirements);
    } catch { /* */ }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (triggerCreate > 0) { setShowCreate(true); setCollapsed(false); setCreateProjectId(projectId ?? ''); } }, [triggerCreate, projectId]);

  const handleCreate = async () => {
    if (!title.trim()) return;
    try {
      await api.requirements.create({ title, description: desc, priority, projectId: createProjectId || undefined });
      onFlash('Requirement created');
      setTitle(''); setDesc(''); setShowCreate(false);
      void refresh();
    } catch (e) { onFlash(`Error: ${e}`); }
  };

  const handleApprove = async (id: string) => {
    try {
      await api.requirements.approve(id);
      onFlash('Requirement approved');
      void refresh();
    } catch (e) { onFlash(`Error: ${e}`); }
  };

  const handleReject = async () => {
    if (!rejectId) return;
    try {
      await api.requirements.reject(rejectId, rejectReason);
      onFlash('Requirement rejected');
      setRejectId(null); setRejectReason('');
      void refresh();
    } catch (e) { onFlash(`Error: ${e}`); }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.requirements.delete(id);
      onFlash('Requirement cancelled');
      void refresh();
    } catch (e) { onFlash(`Error: ${e}`); }
  };

  const pendingReqs = reqs.filter(r => r.source === 'agent' && (r.status === 'draft' || r.status === 'pending_review'));
  const activeReqs = reqs.filter(r => r.status !== 'completed' && r.status !== 'rejected' && r.status !== 'cancelled');
  const doneReqs = reqs.filter(r => r.status === 'completed' || r.status === 'rejected' || r.status === 'cancelled');
  const displayReqs = showCompleted ? reqs : activeReqs;

  if (loading) return null;

  return (
    <div className="border-b border-gray-800 bg-gray-900/40">
      {/* Header row */}
      <div className="px-6 py-2 flex items-center justify-between">
        <button onClick={() => setCollapsed(!collapsed)} className="flex items-center gap-2 group">
          <span className="text-[10px] text-gray-500 group-hover:text-gray-300 transition-transform inline-block" style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Requirements</span>
          <span className="text-[10px] bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded-full">{activeReqs.length}</span>
          {pendingReqs.length > 0 && (
            <span className="text-[10px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded-full font-medium animate-pulse">
              {pendingReqs.length} to review
            </span>
          )}
        </button>
        <div className="flex items-center gap-2">
          {doneReqs.length > 0 && (
            <button onClick={() => setShowCompleted(!showCompleted)} className="text-[10px] text-gray-600 hover:text-gray-400">
              {showCompleted ? 'Hide' : 'Show'} closed ({doneReqs.length})
            </button>
          )}
        </div>
      </div>

      {/* Collapsible body */}
      {!collapsed && (
        <div className="px-6 pb-3 space-y-1.5">
          {/* Empty state */}
          {displayReqs.length === 0 && (
            <div className="text-center py-4">
              <p className="text-xs text-gray-500">
                {reqs.length === 0
                  ? 'No requirements yet — create one to tell agents what to work on.'
                  : 'All requirements are done!'}
              </p>
            </div>
          )}

          {/* Requirement cards */}
          {displayReqs.map(req => {
            const badge = REQ_STATUS_BADGE[req.status] ?? { label: req.status, cls: 'bg-gray-500/15 text-gray-400' };
            const isAgent = req.source === 'agent';
            const needsReview = isAgent && (req.status === 'draft' || req.status === 'pending_review');
            const isOpen = expandedId === req.id;
            const reqProject = req.projectId ? projects.find(p => p.id === req.projectId) : null;
            return (
              <div key={req.id} className={`rounded-lg border transition-colors ${needsReview ? 'border-yellow-500/30 bg-yellow-500/[0.03]' : 'border-gray-800 bg-gray-900/60'}`}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${badge.cls}`}>{badge.label}</span>
                  <button onClick={() => setExpandedId(isOpen ? null : req.id)} className="text-xs font-medium text-gray-200 hover:text-white truncate text-left flex-1">
                    {req.title}
                  </button>
                  {isAgent && <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-400 shrink-0">Agent</span>}
                  {reqProject && !projectId && <span className="text-[9px] px-1 py-0.5 rounded bg-gray-700/60 text-gray-400 shrink-0 truncate max-w-[80px]">{reqProject.name}</span>}
                  {req.taskIds.length > 0 && <span className="text-[10px] text-gray-600 shrink-0">{req.taskIds.length} tasks</span>}
                  {needsReview && (
                    <>
                      <button onClick={() => handleApprove(req.id)} className="px-2 py-0.5 bg-green-600/20 hover:bg-green-600/30 text-green-400 text-[10px] rounded font-medium shrink-0">Approve</button>
                      <button onClick={() => setRejectId(req.id)} className="px-2 py-0.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-[10px] rounded font-medium shrink-0">Reject</button>
                    </>
                  )}
                  {(req.status === 'draft' || req.status === 'approved') && !needsReview && (
                    <button onClick={() => handleDelete(req.id)} className="text-gray-700 hover:text-red-400 text-[10px] shrink-0" title="Cancel">✕</button>
                  )}
                </div>
                {isOpen && (
                  <div className="px-3 pb-2.5 border-t border-gray-800/50 pt-2 space-y-1.5">
                    <p className="text-[11px] text-gray-400 whitespace-pre-wrap leading-relaxed">{req.description || 'No description.'}</p>
                    <div className="flex items-center gap-3 text-[10px] text-gray-500">
                      <span>{req.priority}</span>
                      <span className="inline-flex items-center gap-0.5">by <AgentNameLink agentId={req.createdBy} agents={agents} /></span>
                      <span>{new Date(req.createdAt).toLocaleDateString()}</span>
                      {req.approvedBy && <span className="inline-flex items-center gap-0.5">approved by <AgentNameLink agentId={req.approvedBy} agents={agents} /></span>}
                    </div>
                    {req.rejectedReason && <p className="text-[11px] text-red-400/80">Rejected: {req.rejectedReason}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create requirement modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { setShowCreate(false); setTitle(''); setDesc(''); }}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-[28rem] space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">New Requirement</h3>
            <p className="text-xs text-gray-500 -mt-2">Describe what you need. Agents will break approved requirements into tasks.</p>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Project</label>
              <select value={createProjectId} onChange={e => setCreateProjectId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-indigo-500 outline-none">
                <option value="">No project</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Title</label>
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Add user authentication"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-indigo-500 outline-none" autoFocus
                onKeyDown={e => { if (e.key === 'Enter' && title.trim()) void handleCreate(); }} />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Description</label>
              <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="What is needed and why..."
                rows={3} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-indigo-500 outline-none resize-none" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Priority</label>
              <select value={priority} onChange={e => setPriority(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-indigo-500 outline-none">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => { setShowCreate(false); setTitle(''); setDesc(''); }} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800 text-gray-300">Cancel</button>
              <button onClick={() => void handleCreate()} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Reject modal */}
      {rejectId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setRejectId(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-96 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">Reject Requirement</h3>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Reason</label>
              <textarea
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                placeholder="Why is this being rejected..."
                rows={3}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-red-500 outline-none resize-none"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setRejectId(null)} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800 text-gray-300">Cancel</button>
              <button onClick={() => void handleReject()} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 rounded-lg text-white">Reject</button>
            </div>
          </div>
        </div>
      )}
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
  const [allRequirements, setAllRequirements] = useState<RequirementInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState('');
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [triggerCreateReq, setTriggerCreateReq] = useState(0);

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

  const refreshRequirements = useCallback(async () => {
    try { const { requirements: r } = await api.requirements.list({}); setAllRequirements(r); } catch { /* */ }
  }, []);

  const loadIterations = useCallback(async (projectId: string) => {
    try { const { iterations: it } = await api.projects.listIterations(projectId); setIterations(it); } catch { setIterations([]); }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([refreshProjects(), refreshBoard(), refreshAgents(), refreshRequirements()]);
    setLoading(false);
  }, [refreshProjects, refreshBoard, refreshAgents, refreshRequirements]);

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
    if (task.status === 'pending_approval') return; // locked state — use Approve/Reject buttons
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
      <div className="w-56 border-r border-gray-800 flex flex-col bg-gray-950 shrink-0">
        <div className="px-4 h-12 border-b border-gray-800 flex items-center justify-between shrink-0">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Projects</span>
          <button onClick={() => setShowCreateProject(true)} className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium">+ New</button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {/* All Work */}
          <button
            onClick={selectAllTasks}
            className={`w-full text-left p-2.5 rounded-lg transition-colors flex items-center justify-between ${
              viewMode === 'all' ? 'bg-indigo-600/20 border border-indigo-500/30' : 'hover:bg-gray-800/60'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded bg-gray-700 flex items-center justify-center text-[10px] text-gray-400">⊞</span>
              <span className="text-sm font-medium text-gray-200">All Work</span>
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
            <div className="p-3 pt-2">
              <div className="rounded-lg border border-dashed border-gray-800 p-3 text-center space-y-1.5">
                <p className="text-[11px] text-gray-500">No projects yet</p>
                <button
                  onClick={() => setShowCreateProject(true)}
                  className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
                >
                  + Create project
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Right: Task Board + Project Context ── */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Flash */}
        {flash && <div className="mx-6 mt-2 px-3 py-1.5 bg-emerald-900/50 text-emerald-300 text-xs rounded-lg">{flash}</div>}

        {/* Top bar */}
        <div className="flex items-center justify-between px-6 h-12 border-b border-gray-800 bg-gray-900/80 shrink-0">
          <div className="flex items-center gap-3">
            {viewMode === 'all' ? (
              <h2 className="text-sm font-semibold text-gray-200">All Work</h2>
            ) : selectedProject ? (
              <>
                <h2 className="text-sm font-semibold text-gray-200">{selectedProject.name}</h2>
                <select
                  value={selectedIterationId ?? ''}
                  onChange={e => setSelectedIterationId(e.target.value || null)}
                  className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-[11px] text-gray-400 focus:border-indigo-500 outline-none"
                >
                  <option value="">All iterations</option>
                  {iterations.map(it => (
                    <option key={it.id} value={it.id}>{it.name} ({it.status})</option>
                  ))}
                </select>
                <button
                  onClick={() => setShowProjectSettings(!showProjectSettings)}
                  className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors text-xs ${
                    showProjectSettings ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
                  }`}
                  title="Project settings"
                >⚙</button>
              </>
            ) : null}
            {archivedCount > 0 && <span className="text-[10px] text-gray-600">{archivedCount} archived</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setTriggerCreateReq(c => c + 1)} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg font-medium">+ Requirement</button>
            <button onClick={() => { setTaskProjectId(selectedProjectId ?? ''); setShowCreateTask(true); }} className="px-3 py-1.5 text-gray-400 hover:text-gray-200 text-xs rounded-lg hover:bg-gray-800 transition-colors">+ Task</button>
          </div>
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

        {/* Agent filter bar — hide when board is empty */}
        {agents.length > 0 && !showProjectSettings && totalTaskCount > 0 && (
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
          <div className="flex-1 overflow-y-auto flex flex-col">
            {/* Inline requirements */}
            <InlineRequirements
              projectId={viewMode === 'project' ? selectedProjectId ?? undefined : undefined}
              projects={projects}
              agents={agents}
              onFlash={msg}
              triggerCreate={triggerCreateReq}
            />

            {/* Board or empty state */}
            {totalTaskCount === 0 ? (
              <div className="flex-1 flex items-center justify-center p-8">
                <div className="max-w-sm w-full text-center space-y-3">
                  <div className="w-10 h-10 mx-auto rounded-lg bg-gray-800 flex items-center justify-center">
                    <span className="text-gray-500 text-lg">&#9744;</span>
                  </div>
                  <h3 className="text-sm font-medium text-gray-400">No tasks yet</h3>
                  <p className="text-xs text-gray-600 leading-relaxed">
                    Create a requirement to tell agents what you need.<br />
                    Once approved, tasks will appear here automatically.
                  </p>
                  <button onClick={() => setTriggerCreateReq(c => c + 1)} className="text-xs text-indigo-400 hover:text-indigo-300 font-medium">
                    + Create a requirement
                  </button>
                </div>
              </div>
            ) : (
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
                            const taskReqTitle = task.requirementId ? allRequirements.find(r => r.id === task.requirementId)?.title : null;
                            const taskCreatorName = task.createdBy ? (agents.find(a => a.id === task.createdBy)?.name ?? task.createdBy) : null;
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
                                {/* Project / Requirement context */}
                                {(taskProjName || taskReqTitle) && (
                                  <div className="mt-1.5 flex flex-wrap gap-1">
                                    {taskProjName && (
                                      <span className="text-[10px] px-1.5 py-0.5 bg-gray-700/60 text-gray-400 rounded truncate max-w-[100px]" title={taskProjName}>{taskProjName}</span>
                                    )}
                                    {taskReqTitle && (
                                      <span className="text-[10px] px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 rounded truncate max-w-[120px]" title={taskReqTitle}># {taskReqTitle}</span>
                                    )}
                                  </div>
                                )}
                                <div className="flex items-center justify-between mt-2">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-xs text-gray-600">{task.priority}</span>
                                    {taskCreatorName && (
                                      <span className="text-[10px] text-gray-600" title={`Created by ${taskCreatorName}`}>by {taskCreatorName}</span>
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
        )}
      </div>

      {/* ── Create Project Modal ── */}
      {showCreateProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCreateProject(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-[28rem] space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">New Project</h3>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Name</label>
              <input value={newProjName} onChange={e => setNewProjName(e.target.value)} placeholder="e.g. My App"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-indigo-500 outline-none" autoFocus />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Description</label>
              <textarea value={newProjDesc} onChange={e => setNewProjDesc(e.target.value)} placeholder="What is this project about? (optional)"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 h-20 resize-none focus:border-indigo-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Repository URL</label>
              <input value={newProjRepo} onChange={e => setNewProjRepo(e.target.value)} placeholder="https://github.com/... (optional)"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-indigo-500 outline-none" />
            </div>
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => setShowCreateProject(false)} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800 text-gray-300">Cancel</button>
              <button onClick={() => void handleCreateProject()} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Task Modal ── */}
      {showCreateTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCreateTask(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-[28rem] space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">New Task</h3>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Project</label>
              <select value={taskProjectId} onChange={e => setTaskProjectId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none">
                <option value="">No Project</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Title</label>
              <input autoFocus value={taskTitle} onChange={e => setTaskTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void createTask(); }}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Description</label>
              <textarea value={taskDesc} onChange={e => setTaskDesc(e.target.value)} rows={2}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none resize-none" />
            </div>
            <div className="grid grid-cols-2 gap-4">
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
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
              <input type="checkbox" checked={taskAutoAssign} onChange={e => setTaskAutoAssign(e.target.checked)} className="rounded bg-gray-800 border-gray-700" />
              Auto-assign to best available agent
            </label>
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => setShowCreateTask(false)} className="px-4 py-2 text-sm border border-gray-700 rounded-lg hover:bg-gray-800 text-gray-300">Cancel</button>
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
          requirements={allRequirements}
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
