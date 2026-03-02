import { useEffect, useState, useRef } from 'react';
import { api, wsClient } from '../api.ts';
import type { AgentDetail, TaskInfo, TaskLogEntry } from '../api.ts';
import { navBus } from '../navBus.ts';

interface Props {
  agentId: string;
  onBack: () => void;
  /** When true, renders as a side panel instead of a full page */
  inline?: boolean;
}

const STATUS_DOT: Record<string, string> = {
  pending: 'bg-gray-400',
  assigned: 'bg-blue-400',
  in_progress: 'bg-indigo-400 animate-pulse',
  blocked: 'bg-amber-400',
  completed: 'bg-green-400',
  failed: 'bg-red-400',
  cancelled: 'bg-gray-600',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// ─── Log Entry Renderer ──────────────────────────────────────────────────────

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
        <span className={`text-xs ${success ? 'text-green-400' : 'text-red-400'}`}>{success ? '✓' : '✗'}</span>
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

/** Remove tool_start entries that have a matching tool_end later in the list. */
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

// ─── Task Execution Log ──────────────────────────────────────────────────────

function TaskLog({ taskId, isLive }: { taskId: string; isLive: boolean }) {
  const [logs, setLogs] = useState<TaskLogEntry[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [loading, setLoading] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setStreamingText('');
    api.tasks.getLogs(taskId)
      .then(d => { setLogs(d.logs); setLoading(false); })
      .catch(() => setLoading(false));
  }, [taskId]);

  useEffect(() => {
    if (!isLive) return;
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
    });
    const unsubDelta = wsClient.on('task:log:delta', (event) => {
      const p = event.payload;
      if (p.taskId !== taskId) return;
      setStreamingText(prev => prev + (p.text as string));
    });
    return () => { unsubLog(); unsubDelta(); };
  }, [taskId, isLive]);

  // Scroll to bottom on new logs or on initial mount (after load)
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, streamingText]);

  if (loading) return <div className="px-4 py-3 text-xs text-gray-600">Loading…</div>;
  if (logs.length === 0 && !streamingText) return <div className="px-4 py-3 text-xs text-gray-600">No execution logs yet.</div>;

  const visibleLogs = filterCompletedToolStarts(logs);

  return (
    <div className="max-h-56 overflow-y-auto px-3 py-2 space-y-0.5">
      {visibleLogs.map((entry, i) => <LogEntryRow key={`${entry.seq}-${i}`} entry={entry} />)}
      {streamingText && (
        <div className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed bg-gray-800/50 rounded-lg px-3 py-2.5 my-1">
          {streamingText}
          <span className="inline-block w-0.5 h-4 bg-indigo-400 animate-pulse ml-0.5 align-middle" />
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

// ─── Agent Tasks Section ─────────────────────────────────────────────────────

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function AgentTasks({ agentId, activeTaskIds }: { agentId: string; activeTaskIds: string[] }) {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadTasks = () => {
    api.tasks.list({ assignedAgentId: agentId })
      .then(d => {
        const filtered = d.tasks.filter(t => !t.parentTaskId);
        setTasks(filtered);
        // Auto-expand the first in_progress task so live logs are immediately visible
        const running = filtered.find(t => t.status === 'in_progress');
        if (running) setExpandedId(prev => prev ?? running.id);
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadTasks();
    const unsub = wsClient.on('task:update', () => loadTasks());
    return unsub;
  }, [agentId]);

  // Sort: active first, then pending/assigned/blocked, then terminal
  const sorted = [...tasks].sort((a, b) => {
    const rank = (s: string) => s === 'in_progress' ? 0 : TERMINAL.has(s) ? 2 : 1;
    return rank(a.status) - rank(b.status);
  });

  const active = sorted.filter(t => t.status === 'in_progress');
  const pending = sorted.filter(t => !TERMINAL.has(t.status) && t.status !== 'in_progress');
  const done = sorted.filter(t => TERMINAL.has(t.status));

  if (tasks.length === 0) {
    return (
      <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-5">
        <h3 className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-3">Tasks</h3>
        <div className="text-xs text-gray-600 text-center py-3">No tasks assigned.</div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-xl overflow-hidden">
      <h3 className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider px-5 py-3 border-b border-gray-800/60">
        Tasks
        <span className="ml-2 font-normal text-gray-700">
          {active.length > 0 && <span className="text-indigo-400">{active.length} running · </span>}
          {pending.length > 0 && `${pending.length} queued · `}
          {done.length > 0 && `${done.length} done`}
        </span>
      </h3>

      <div className="divide-y divide-gray-800/50">
        {sorted.map(task => {
          const isExpanded = expandedId === task.id;
          const isExecuting = activeTaskIds.includes(task.id) || task.status === 'in_progress';
          const isTerminal = TERMINAL.has(task.status);
          const hasLogs = task.status === 'in_progress' || task.status === 'failed' || task.status === 'completed';

          return (
            <div key={task.id}>
              <button
                onClick={() => hasLogs ? setExpandedId(isExpanded ? null : task.id) : undefined}
                className={`w-full flex items-center gap-3 px-5 py-3 text-left transition-colors ${hasLogs ? 'hover:bg-gray-800/40 cursor-pointer' : 'cursor-default'}`}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[task.status] ?? 'bg-gray-500'}`} />
                <div className="flex-1 min-w-0">
                  <div className={`text-xs font-medium truncate ${isTerminal ? 'text-gray-500' : 'text-gray-200'}`}>
                    {task.title}
                  </div>
                  <div className="text-[10px] text-gray-600 mt-0.5">{STATUS_LABEL[task.status] ?? task.status}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {isExecuting && (
                    <svg className="w-3 h-3 text-indigo-400 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" strokeLinecap="round" />
                    </svg>
                  )}
                  {hasLogs && (
                    <span className="text-gray-600 text-[10px]">{isExpanded ? '▲' : '▼'}</span>
                  )}
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-gray-800/60 bg-gray-950/40">
                  <TaskLog taskId={task.id} isLive={isExecuting} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function AgentProfile({ agentId, onBack, inline }: Props) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);

  useEffect(() => {
    api.agents.get(agentId).then(setAgent).catch(() => {});
    const unsub = wsClient.on('agent:update', (evt) => {
      if ((evt.payload as Record<string, string>).agentId === agentId) {
        api.agents.get(agentId).then(setAgent).catch(() => {});
      }
    });
    return unsub;
  }, [agentId]);

  const triggerDailyReport = async () => {
    try {
      await fetch(`/api/agents/${agentId}/daily-report`, { method: 'POST', credentials: 'include' });
    } catch { /* ignore */ }
  };

  const openChat = () => {
    navBus.navigate('chat', { agentId });
  };

  if (!agent) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Loading agent...
      </div>
    );
  }

  const statusColor =
    agent.state.status === 'idle' ? 'bg-green-400' :
    agent.state.status === 'working' ? 'bg-yellow-400 animate-pulse' : 'bg-gray-500';

  const activeTaskIds = agent.state.activeTaskIds ?? [];

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-800 bg-gray-900 shrink-0">
        <div className="flex items-center gap-3">
          {!inline && (
            <button onClick={onBack} className="text-gray-500 hover:text-gray-300 text-sm">&larr; Back</button>
          )}
          <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-lg font-bold shrink-0">
            {agent.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold">{agent.name}</h2>
              <span className={`w-2 h-2 rounded-full ${statusColor}`} />
              <span className="text-xs text-gray-500">{agent.state.status}</span>
              {agent.agentRole === 'manager' && (
                <span className="px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-400 rounded font-medium">Manager</span>
              )}
            </div>
            <div className="text-xs text-gray-500 truncate">{agent.role}</div>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <button
              onClick={triggerDailyReport}
              className="px-2.5 py-1 text-xs border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors"
            >
              Report
            </button>
            <button
              onClick={openChat}
              className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors flex items-center gap-1"
            >
              <span>◈</span> Chat
            </button>
            {inline && (
              <button onClick={onBack} className="p-1 text-gray-500 hover:text-gray-300 text-lg leading-none">&times;</button>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className={`p-5 grid gap-4 ${inline ? 'grid-cols-1' : 'grid-cols-2 max-w-3xl'}`}>

        {/* Stats */}
        <Card title="Stats">
          <StatRow label="Status" value={agent.state.status} />
          <StatRow label="Tokens Today" value={String(agent.state.tokensUsedToday)} />
          <StatRow label="Active Tasks" value={activeTaskIds.length > 0 ? `${activeTaskIds.length} running` : 'None'} />
          <StatRow label="Last Heartbeat" value={
            agent.state.lastHeartbeat
              ? new Date(agent.state.lastHeartbeat).toLocaleTimeString()
              : 'Never'
          } />
        </Card>

        {/* Identity */}
        <Card title="Identity">
          <StatRow label="Agent Role" value={agent.agentRole} />
          <StatRow label="Role Template" value={agent.role} />
          <StatRow label="ID" value={agent.id} mono />
        </Card>

        {/* Skills */}
        <Card title="Skills">
          {agent.skills.length === 0 ? (
            <div className="text-xs text-gray-600">No skills configured</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {agent.skills.map(s => (
                <span key={s} className="px-2 py-0.5 text-[10px] bg-indigo-500/15 text-indigo-400 rounded-full">{s}</span>
              ))}
            </div>
          )}
        </Card>

        {/* Tasks — always visible, spans full width */}
        <div className={inline ? '' : 'col-span-2'}>
          <AgentTasks agentId={agentId} activeTaskIds={activeTaskIds} />
        </div>

        {/* Chat CTA */}
        <div className="col-span-2 mt-2">
          <button
            onClick={openChat}
            className="w-full py-4 border border-dashed border-indigo-700/60 rounded-xl text-indigo-400 hover:bg-indigo-900/20 transition-colors flex items-center justify-center gap-3 text-sm"
          >
            <span className="text-xl">◈</span>
            <div className="text-left">
              <div className="font-medium">Open Chat with {agent.name}</div>
              <div className="text-xs text-indigo-500/70 mt-0.5">Navigate to the Chat tab to start or continue a conversation</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-5">
      <h3 className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-3">{title}</h3>
      {children}
    </div>
  );
}

function StatRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs py-1.5 border-b border-gray-800/60 last:border-0">
      <span className="text-gray-500">{label}</span>
      <span className={`text-gray-300 ${mono ? 'font-mono text-[10px]' : ''}`}>{value}</span>
    </div>
  );
}
