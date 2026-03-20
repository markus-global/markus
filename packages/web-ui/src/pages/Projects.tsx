import { useState, useEffect, useCallback, useMemo, useRef, memo, type DragEvent } from 'react';
import { api, wsClient, type ProjectInfo, type IterationInfo, type TaskInfo, type AgentInfo, type TaskLogEntry, type TaskComment, type RequirementInfo } from '../api.ts';
import { ConfirmModal } from '../components/ConfirmModal.tsx';
import { MemoExecEntryRow, ThinkingDots, StreamingText, taskLogToEntry, filterCompletedStarts, type ExecEntry } from '../components/ExecutionTimeline.tsx';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { TaskDAG } from '../components/TaskDAG.tsx';
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
      <button onClick={() => setOpen(!open)} className="text-brand-400 hover:text-brand-300 hover:underline cursor-pointer">
        {displayName}
      </button>
      {open && agent && (
        <div className="absolute left-0 bottom-full mb-1.5 bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-40 w-56 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-brand-600/30 flex items-center justify-center text-[10px] font-bold text-brand-300">
              {agent.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-gray-200 font-medium truncate">{agent.name}</div>
              <div className="text-[10px] text-gray-500">{agent.role} · {agent.agentRole ?? 'worker'}</div>
            </div>
            <span className={`w-2 h-2 rounded-full shrink-0 ${agent.status === 'working' ? 'bg-yellow-400 animate-pulse' : agent.status === 'error' ? 'bg-red-400' : 'bg-green-400'}`} />
          </div>
          <button
            onClick={() => { setOpen(false); navBus.navigate('team', { selectAgent: agent.id }); }}
            className="w-full text-center text-[10px] text-brand-400 hover:text-brand-300 border border-border-default hover:border-gray-600 rounded-lg py-1 transition-colors"
          >
            View Profile →
          </button>
        </div>
      )}
      {open && !agent && (
        <div className="absolute left-0 bottom-full mb-1.5 bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-40 w-40 p-2">
          <div className="text-[10px] text-gray-500">Agent not found: {agentId.slice(0, 12)}…</div>
        </div>
      )}
    </span>
  );
}

// ─── Inline Editable Text ────────────────────────────────────────────────────────

function InlineEditableText({ value, onSave, className, placeholder }: {
  value: string;
  onSave: (v: string) => Promise<void>;
  className?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = async () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      try { await onSave(trimmed); } catch { setDraft(value); }
    } else {
      setDraft(value);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={e => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        className={`bg-transparent border-b border-brand-500/50 outline-none ${className ?? ''}`}
        placeholder={placeholder}
      />
    );
  }

  return (
    <span
      onClick={() => setEditing(true)}
      className={`cursor-pointer hover:border-b hover:border-gray-600 transition-colors ${className ?? ''}`}
      title="Click to edit"
    >{value || <span className="text-gray-600 italic">{placeholder ?? 'Click to edit'}</span>}</span>
  );
}

function InlineEditableTextarea({ value, onSave, className, placeholder }: {
  value: string;
  onSave: (v: string) => Promise<void>;
  className?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.style.height = 'auto'; ref.current.style.height = ref.current.scrollHeight + 'px'; } }, [editing]);

  const commit = async () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value) {
      try { await onSave(trimmed); } catch { setDraft(value); }
    } else {
      setDraft(value);
    }
  };

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={draft}
        onChange={e => { setDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
        onBlur={() => void commit()}
        onKeyDown={e => { if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        className={`bg-transparent border border-brand-500/30 rounded-lg p-2 outline-none resize-none w-full ${className ?? ''}`}
        placeholder={placeholder}
        rows={2}
      />
    );
  }

  return (
    <p
      onClick={() => setEditing(true)}
      className={`cursor-pointer hover:bg-surface-elevated/50 rounded-lg transition-colors px-2 py-1 -mx-2 -my-1 ${className ?? ''}`}
      title="Click to edit"
    >{value || <span className="text-gray-600 italic">{placeholder ?? 'Add a description…'}</span>}</p>
  );
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const ALL_STATUSES = ['pending', 'pending_approval', 'assigned', 'in_progress', 'blocked', 'review', 'revision', 'accepted', 'completed', 'failed', 'cancelled', 'archived'] as const;

const BOARD_COLUMNS = [
  { id: 'todo',        label: 'To Do',       statuses: ['pending_approval', 'pending', 'assigned'], accent: 'border-t-blue-500',   dropStatus: 'pending' },
  { id: 'in_progress', label: 'In Progress', statuses: ['in_progress', 'blocked'],                  accent: 'border-t-brand-500', dropStatus: 'in_progress' },
  { id: 'review',      label: 'In Review',   statuses: ['review', 'revision', 'accepted'],          accent: 'border-t-purple-500', dropStatus: 'review' },
  { id: 'done',        label: 'Done',        statuses: ['completed'],                               accent: 'border-t-green-500',  dropStatus: 'completed' },
  { id: 'closed',      label: 'Closed',      statuses: ['failed', 'cancelled'],                     accent: 'border-t-red-500',    dropStatus: 'cancelled' },
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
  in_progress: 'bg-brand-400', blocked: 'bg-amber-400',
  review: 'bg-purple-400', revision: 'bg-orange-400', accepted: 'bg-teal-400', completed: 'bg-green-400',
  failed: 'bg-red-400', cancelled: 'bg-gray-600', archived: 'bg-surface-overlay',
};

type ViewMode = 'all' | 'project';

// ─── Execution Log Panel ────────────────────────────────────────────────────────

function convertLogs(logs: TaskLogEntry[]): ExecEntry[] {
  return filterCompletedStarts(
    logs.map(taskLogToEntry).filter((e): e is ExecEntry => e != null)
  );
}

const MemoCommentBubble = memo(function CommentBubble({ comment }: { comment: TaskComment }) {
  return (
    <div className="bg-blue-950/30 border border-blue-800/30 rounded-lg px-3 py-2.5 my-1.5">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-5 h-5 rounded-full bg-blue-600/30 flex items-center justify-center text-[10px] text-blue-300 font-bold shrink-0">
          {comment.authorType === 'human' ? '👤' : '🤖'}
        </span>
        <span className="text-[11px] font-medium text-blue-300">{comment.authorName}</span>
        <span className="text-[10px] text-gray-600 ml-auto">{new Date(comment.createdAt).toLocaleString()}</span>
      </div>
      <MarkdownMessage content={comment.content} className="text-sm text-gray-300" />
      {comment.attachments?.map((att, i) => (
        att.type === 'image' ? (
          <img key={i} src={att.url} alt={att.name} className="mt-2 max-w-full max-h-48 rounded-lg border border-border-default" />
        ) : null
      ))}
    </div>
  );
});

// ─── Run-based types ────────────────────────────────────────────────────────

type TimelineItem =
  | { kind: 'log'; entry: ExecEntry; time: number }
  | { kind: 'comment'; entry: TaskComment; time: number };

interface RunGroup {
  runNumber: number;
  startTime: string;
  endTime?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  items: TimelineItem[];
  preComments: TimelineItem[]; // comments between previous run end and this run start
}

function groupTimelineIntoRuns(timeline: TimelineItem[]): RunGroup[] {
  const runs: RunGroup[] = [];
  let currentRun: RunGroup | null = null;
  let pendingComments: TimelineItem[] = [];

  for (const item of timeline) {
    if (item.kind === 'log' && item.entry.type === 'status' && item.entry.content === 'started') {
      currentRun = {
        runNumber: runs.length + 1,
        startTime: item.entry.timestamp ?? item.entry.time ?? '',
        status: 'running',
        items: [],
        preComments: [...pendingComments],
      };
      pendingComments = [];
      runs.push(currentRun);
      continue;
    }
    if (item.kind === 'log' && item.entry.type === 'status' && ['completed', 'failed', 'cancelled'].includes(item.entry.content)) {
      if (currentRun) {
        currentRun.status = item.entry.content as RunGroup['status'];
        currentRun.endTime = item.entry.timestamp ?? item.entry.time;
        currentRun = null;
      }
      continue;
    }
    if (currentRun) {
      currentRun.items.push(item);
    } else if (item.kind === 'comment') {
      pendingComments.push(item);
    }
  }
  if (currentRun && currentRun.status === 'running') {
    // Check if the task is still actually running vs interrupted
    const hasRecentActivity = currentRun.items.length > 0;
    if (!hasRecentActivity) currentRun.status = 'interrupted';
  }
  // Attach any trailing comments to the last run
  if (pendingComments.length > 0 && runs.length > 0) {
    runs[runs.length - 1]!.items.push(...pendingComments);
  }
  return runs;
}

function formatDurationShort(startTime: string, endTime?: string): string {
  if (!endTime) return '';
  const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  running: { label: 'Running', color: 'text-blue-400', bg: 'bg-blue-500/15' },
  completed: { label: 'Completed', color: 'text-green-400', bg: 'bg-green-500/15' },
  failed: { label: 'Failed', color: 'text-red-400', bg: 'bg-red-500/15' },
  cancelled: { label: 'Cancelled', color: 'text-gray-400', bg: 'bg-gray-500/15' },
  interrupted: { label: 'Interrupted', color: 'text-amber-400', bg: 'bg-amber-500/15' },
};

const RunSection = memo(function RunSection({ run, expanded, onToggle, isLive, streamingText, isExecuting }: {
  run: RunGroup;
  expanded: boolean;
  onToggle: () => void;
  isLive: boolean;
  streamingText?: string;
  isExecuting?: boolean;
}) {
  const sc = statusConfig[run.status] ?? statusConfig.running!;
  const duration = formatDurationShort(run.startTime, run.endTime);
  const startDate = (() => {
    try { return new Date(run.startTime).toLocaleString(); } catch { return run.startTime; }
  })();
  const toolCount = run.items.filter(i => i.kind === 'log' && i.entry.type === 'tool').length;
  const errorCount = run.items.filter(i => i.kind === 'log' && i.entry.type === 'error').length;

  return (
    <div className="border-b border-border-default/60 last:border-b-0">
      {/* Pre-comments (between runs) */}
      {run.preComments.length > 0 && (
        <div className="px-4 py-2">
          {run.preComments.map((item, i) =>
            item.kind === 'comment' ? <MemoCommentBubble key={`pc-${item.entry.id}`} comment={item.entry} /> : null
          )}
        </div>
      )}
      {/* Run header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-surface-elevated/40 transition-colors text-left"
      >
        <svg className={`w-3 h-3 text-gray-500 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} viewBox="0 0 12 12" fill="currentColor">
          <path d="M4 2l5 4-5 4V2z" />
        </svg>
        <span className="text-xs font-medium text-gray-300">Run #{run.runNumber}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${sc.bg} ${sc.color}`}>{sc.label}</span>
        {run.status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
        <span className="text-[10px] text-gray-600 ml-auto flex items-center gap-2">
          {toolCount > 0 && <span>{toolCount} tool calls</span>}
          {errorCount > 0 && <span className="text-red-400">{errorCount} errors</span>}
          {duration && <span>{duration}</span>}
          <span>{startDate}</span>
        </span>
      </button>
      {/* Run body (lazy rendered) */}
      {expanded && (
        <div className="px-4 pb-3 space-y-0.5">
          {run.items.map((item, i) =>
            item.kind === 'comment'
              ? <MemoCommentBubble key={`c-${item.entry.id}`} comment={item.entry} />
              : <MemoExecEntryRow key={`l-${(item.entry.type === 'tool' ? item.entry.key : undefined) ?? item.entry.timestamp ?? i}`} entry={item.entry} showTime />
          )}
          {isLive && streamingText && <StreamingText content={streamingText} />}
          {isLive && isExecuting && !streamingText && <ThinkingDots label="Thinking" />}
        </div>
      )}
    </div>
  );
});

function TaskExecutionLogs({ taskId, isVisible, isRunning, authUser }: { taskId: string; isVisible: boolean; isRunning: boolean; authUser?: { id: string; name: string } }) {
  const [logs, setLogs] = useState<TaskLogEntry[]>([]);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [isExecuting, setIsExecuting] = useState(isRunning);
  const [loading, setLoading] = useState(true);
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [imageAttachments, setImageAttachments] = useState<Array<{ type: string; url: string; name: string }>>([]);
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set());
  const [runsPage, setRunsPage] = useState(1);
  const RUNS_PAGE_SIZE = 20;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setIsExecuting(isRunning); }, [isRunning]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.tasks.getLogs(taskId).catch(() => ({ logs: [] as TaskLogEntry[] })),
      api.tasks.getComments(taskId).catch(() => ({ comments: [] as TaskComment[] })),
    ]).then(([logData, commentData]) => {
      setLogs(logData.logs);
      setComments(commentData.comments);
      setLoading(false);
    });
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
    const unsubComment = wsClient.on('task:comment', (event) => {
      const p = event.payload;
      if (p.taskId !== taskId) return;
      const c = p.comment as TaskComment;
      setComments(prev => prev.some(x => x.id === c.id) ? prev : [...prev, c]);
    });
    return () => { unsubLog(); unsubDelta(); unsubComment(); };
  }, [taskId]);

  const timeline = useMemo(() => {
    const execEntries = convertLogs(logs);
    const items: TimelineItem[] = [
      ...execEntries.map(entry => ({ kind: 'log' as const, entry, time: new Date(entry.timestamp ?? entry.time ?? 0).getTime() })),
      ...comments.map(entry => ({ kind: 'comment' as const, entry, time: new Date(entry.createdAt).getTime() })),
    ];
    items.sort((a, b) => a.time - b.time);
    return items;
  }, [logs, comments]);

  const runs = useMemo(() => groupTimelineIntoRuns(timeline), [timeline]);

  // Auto-expand the latest run; keep manually toggled runs in sync
  useEffect(() => {
    if (runs.length > 0) {
      setExpandedRuns(prev => {
        const lastRunNum = runs[runs.length - 1]!.runNumber;
        if (prev.has(lastRunNum)) return prev;
        return new Set([lastRunNum]);
      });
    }
  }, [runs.length]); // only re-run when run count changes

  // Scroll to bottom when new content arrives for the expanded live run
  useEffect(() => {
    if (isVisible && isExecuting) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, streamingText, isVisible, isExecuting]);

  const toggleRun = useCallback((runNumber: number) => {
    setExpandedRuns(prev => {
      const next = new Set(prev);
      if (next.has(runNumber)) next.delete(runNumber);
      else next.add(runNumber);
      return next;
    });
  }, []);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        setImageAttachments(prev => [...prev, { type: 'image', url: reader.result as string, name: file.name }]);
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  };

  const submitComment = async () => {
    if (!commentText.trim() && imageAttachments.length === 0) return;
    setSubmitting(true);
    try {
      const result = await api.tasks.addComment(taskId, commentText, authUser?.name, imageAttachments.length > 0 ? imageAttachments : undefined, authUser?.id);
      if (result.comment) {
        setComments(prev => prev.some(x => x.id === result.comment.id) ? prev : [...prev, result.comment]);
      }
      setCommentText('');
      setImageAttachments([]);
    } catch { /* ignore */ }
    setSubmitting(false);
  };

  const commentInput = (
    <div className="border-t border-border-default px-4 py-3">
      {imageAttachments.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {imageAttachments.map((att, i) => (
            <div key={i} className="relative group">
              <img src={att.url} alt={att.name} className="w-16 h-16 object-cover rounded-lg border border-border-default" />
              <button onClick={() => setImageAttachments(prev => prev.filter((_, j) => j !== i))}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100">×</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input type="text" value={commentText} onChange={e => setCommentText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitComment(); } }}
          placeholder="Add a comment or instruction…"
          className="flex-1 px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-blue-500 outline-none text-gray-200 placeholder-gray-600" />
        <input type="file" ref={fileInputRef} accept="image/*" multiple onChange={handleImageUpload} className="hidden" />
        <button onClick={() => fileInputRef.current?.click()} className="px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-gray-400 hover:text-gray-200 text-sm" title="Attach image">📎</button>
        <button onClick={() => void submitComment()} disabled={submitting || (!commentText.trim() && imageAttachments.length === 0)}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-white text-xs disabled:opacity-50">Send</button>
      </div>
    </div>
  );

  if (loading) return <div className="flex-1 flex items-center justify-center text-xs text-gray-600">Loading logs…</div>;
  if (runs.length === 0 && !streamingText) {
    return (
      <div className="flex flex-col flex-1">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-gray-600">
            <div className="text-2xl mb-2">📋</div>
            <div className="text-xs">No execution logs yet.<br />Click "Run with Agent" to start.</div>
          </div>
        </div>
        {commentInput}
      </div>
    );
  }

  // Paginate runs: show latest page first (reversed order, latest on page 1)
  const reversedRuns = [...runs].reverse();
  const totalRunPages = Math.ceil(reversedRuns.length / RUNS_PAGE_SIZE);
  const pagedRuns = reversedRuns.slice((runsPage - 1) * RUNS_PAGE_SIZE, runsPage * RUNS_PAGE_SIZE).reverse();

  return (
    <div>
      {totalRunPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-default">
          <span className="text-[10px] text-gray-500">{runs.length} runs total</span>
          <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
            <button disabled={runsPage >= totalRunPages} onClick={() => setRunsPage(p => p + 1)} className="px-1.5 py-0.5 rounded bg-surface-elevated hover:bg-surface-overlay disabled:opacity-30">← Older</button>
            <span>{runsPage}/{totalRunPages}</span>
            <button disabled={runsPage <= 1} onClick={() => setRunsPage(p => p - 1)} className="px-1.5 py-0.5 rounded bg-surface-elevated hover:bg-surface-overlay disabled:opacity-30">Newer →</button>
          </div>
        </div>
      )}
      <div className="py-1">
        {pagedRuns.map(run => (
          <RunSection
            key={run.runNumber}
            run={run}
            expanded={expandedRuns.has(run.runNumber)}
            onToggle={() => toggleRun(run.runNumber)}
            isLive={run.runNumber === runs.length && isExecuting}
            streamingText={run.runNumber === runs.length ? streamingText : undefined}
            isExecuting={run.runNumber === runs.length ? isExecuting : false}
          />
        ))}
        <div ref={endRef} />
      </div>
      {commentInput}
    </div>
  );
}

// ─── File Preview Modal ─────────────────────────────────────────────────────────

function FilePreviewModal({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const [data, setData] = useState<{ type: string; name: string; content: string; mimeType?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.files.preview(filePath)
      .then(d => setData(d))
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false));
  }, [filePath]);

  const fileName = filePath.split('/').pop() ?? filePath;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]" onClick={onClose}>
      <div className="bg-surface-secondary border border-border-default rounded-xl w-[720px] max-w-[92vw] max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-default shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <svg className="w-4 h-4 text-gray-500 shrink-0" viewBox="0 0 16 16" fill="currentColor"><path d="M3 1h7l4 4v10H3V1zm7 1H4v12h10V5.5L10 2z"/><path d="M10 1v4h4" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
            <span className="text-sm font-medium text-gray-200 truncate">{fileName}</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg shrink-0 ml-3">×</button>
        </div>
        <div className="px-4 py-1 border-b border-border-default/60">
          <p className="text-[10px] text-gray-600 font-mono truncate">{filePath}</p>
        </div>
        <div className="flex-1 overflow-auto min-h-0 p-5">
          {loading && <div className="text-sm text-gray-500 text-center py-8">Loading...</div>}
          {error && <div className="text-sm text-red-400 text-center py-8">{error}</div>}
          {data && data.type === 'image' && (
            <div className="flex justify-center">
              <img src={`data:${data.mimeType};base64,${data.content}`} alt={data.name} className="max-w-full max-h-[60vh] rounded-lg" />
            </div>
          )}
          {data && data.type === 'markdown' && (
            <MarkdownMessage content={data.content} className="text-sm text-gray-300 leading-relaxed" />
          )}
          {data && data.type === 'text' && (
            <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-words bg-surface-primary/50 rounded-lg p-4 leading-relaxed">{data.content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Task Detail Modal ──────────────────────────────────────────────────────────

function TaskDetailModal({
  task, agents, projects, requirements, allTasks, onClose, onRefresh, authUser,
}: {
  task: TaskInfo;
  agents: AgentInfo[];
  projects: ProjectInfo[];
  requirements: RequirementInfo[];
  allTasks: TaskInfo[];
  onClose: () => void;
  onRefresh: () => void;
  authUser?: { id: string; name: string; role: string; orgId: string };
}) {
  const [subtasks, setSubtasks] = useState<TaskInfo[]>([]);
  const [newSubtask, setNewSubtask] = useState('');
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<TaskInfo | null>(null);
  const [pendingDeleteParent, setPendingDeleteParent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'logs' | 'notes' | 'deliverables'>('details');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description);
  const [showRevision, setShowRevision] = useState(false);
  const [revisionReason, setRevisionReason] = useState('');
  const [deliverablesPage, setDeliverablesPage] = useState(1);
  const [notesPage, setNotesPage] = useState(1);
  const PAGE_SIZE = 20;
  const loadSubtasks = useCallback(async () => {
    try { const d = await api.tasks.listSubtasks(task.id); setSubtasks(d.subtasks); } catch { /* ok */ }
  }, [task.id]);

  useEffect(() => { void loadSubtasks(); }, [loadSubtasks]);

  const doUpdate = async (fn: () => Promise<unknown>) => {
    if (busy) return; setBusy(true);
    try { await fn(); onRefresh(); void loadSubtasks(); } catch (err) {
      setRunError(String(err).replace('Error: ', ''));
    } finally { setBusy(false); }
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
      await api.tasks.pause(task.id);
      onRefresh();
    } finally { setBusy(false); }
  };

  const resumeTask = async () => {
    if (running) return; setRunning(true); setRunError(null); setActiveTab('logs');
    try { await api.tasks.resume(task.id); onRefresh(); } catch (err) {
      setRunError(String(err).replace('Error: API error: 400', 'Server error').replace('Error: ', ''));
    } finally { setRunning(false); }
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
      onRefresh();
    } finally { setRunning(false); }
  };

  const runScheduledNow = async () => {
    if (running) return; setRunning(true); setRunError(null); setActiveTab('logs');
    try { await api.tasks.runNow(task.id); onRefresh(); } catch (err) {
      setRunError(String(err).replace('Error: API error: 400', 'Server error').replace('Error: ', ''));
      onRefresh();
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
  const isScheduled = task.taskType === 'scheduled' && !!task.scheduleConfig;
  const schedPaused = isScheduled && !!task.scheduleConfig?.paused;

  const taskProject = projects.find(p => p.id === task.projectId);
  const taskRequirement = requirements.find(r => r.id === task.requirementId);
  const assignedAgent = agents.find(a => a.id === task.assignedAgentId);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-secondary border border-border-default rounded-xl w-[780px] max-w-[95vw] max-h-[88vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header – title & close only */}
        <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b border-border-default shrink-0">
          <h3 className="text-base font-semibold leading-snug flex-1 min-w-0 pr-4">{task.title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg shrink-0">×</button>
        </div>

        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Description */}
          <div className="px-6 pt-4 pb-3 border-b border-border-default">
            {editingDesc ? (
              <div className="space-y-2">
                <textarea
                  value={descDraft}
                  onChange={e => setDescDraft(e.target.value)}
                  className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-gray-200 focus:border-brand-500 outline-none resize-y min-h-[80px]"
                  rows={4}
                  placeholder="Add a description…"
                />
                <div className="flex gap-2 justify-end">
                  <button onClick={() => { setEditingDesc(false); setDescDraft(task.description); }} className="px-2.5 py-1 text-xs border border-border-default rounded-lg hover:bg-surface-elevated">Cancel</button>
                  <button
                    onClick={() => { void doUpdate(() => api.tasks.update(task.id, { description: descDraft })); setEditingDesc(false); }}
                    disabled={busy}
                    className="px-2.5 py-1 text-xs bg-brand-600 hover:bg-brand-500 rounded-lg text-white disabled:opacity-50"
                  >Save</button>
                </div>
              </div>
            ) : (
              <div className="group relative">
                {task.description
                  ? <MarkdownMessage content={task.description} className="text-sm text-gray-400 leading-relaxed" />
                  : <p className="text-sm text-gray-600 italic">No description</p>
                }
                <button
                  onClick={() => { setDescDraft(task.description); setEditingDesc(true); }}
                  className="absolute top-0 right-0 text-[10px] text-gray-600 hover:text-brand-400 opacity-0 group-hover:opacity-100 transition-opacity"
                >Edit</button>
              </div>
            )}
          </div>

          {/* Context badges — project, requirement */}
          {(taskProject || taskRequirement || task.parentTaskId) && (
            <div className="px-6 py-2.5 border-b border-border-default flex flex-wrap items-center gap-2">
              {taskProject && (
                <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 bg-brand-500/10 text-brand-300 rounded-full">
                  <span className="text-[9px] text-brand-400/60">Project</span>
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
                <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 bg-surface-overlay/60 text-gray-400 rounded-full">
                  <span className="text-[9px] text-gray-500">Subtask of</span>
                  <span className="font-mono">{task.parentTaskId.slice(-8)}</span>
                </span>
              )}
            </div>
          )}

          {/* Dependencies — editable */}
          <div className="px-6 py-2.5 border-b border-border-default">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Dependencies</span>
            </div>
            {task.blockedBy && task.blockedBy.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {task.blockedBy.map(blockerId => {
                  const blockerTask = allTasks.find(t => t.id === blockerId);
                  const blockerDone = blockerTask && (blockerTask.status === 'completed' || blockerTask.status === 'cancelled');
                  return (
                    <span key={blockerId} className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full ${blockerDone ? 'bg-green-500/10 text-green-400' : 'bg-amber-500/10 text-amber-300'}`}>
                      <span className="text-[9px]">{blockerDone ? '✓' : '⏳'}</span>
                      <span className={`font-mono ${blockerDone ? 'line-through opacity-60' : ''}`}>{blockerTask ? blockerTask.title.slice(0, 30) : blockerId.slice(-8)}</span>
                      {!isTerminal && (
                        <button
                          onClick={async () => {
                            const newBlockedBy = (task.blockedBy ?? []).filter(id => id !== blockerId);
                            await api.tasks.update(task.id, { blockedBy: newBlockedBy });
                            onRefresh();
                          }}
                          className="ml-0.5 text-current opacity-40 hover:opacity-100 transition-opacity"
                          title="Remove dependency"
                        >×</button>
                      )}
                    </span>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11px] text-gray-600 mb-2">No dependencies</p>
            )}
            {!isTerminal && (
              <select
                value=""
                onChange={async (e) => {
                  const depId = e.target.value;
                  if (!depId) return;
                  const newBlockedBy = [...(task.blockedBy ?? []), depId];
                  await api.tasks.update(task.id, { blockedBy: newBlockedBy });
                  onRefresh();
                }}
                className="w-full px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-[11px] text-gray-400 focus:border-brand-500 outline-none"
              >
                <option value="">+ Add dependency…</option>
                {allTasks
                  .filter(t => t.id !== task.id && !t.parentTaskId && !(task.blockedBy ?? []).includes(t.id))
                  .map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
            )}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 px-6 pt-3 border-b border-border-default sticky top-0 z-10 bg-surface-secondary">
            <button onClick={() => setActiveTab('details')} className={`px-3 py-1.5 text-xs rounded-t-md transition-colors ${activeTab === 'details' ? 'bg-surface-elevated text-gray-100 font-medium' : 'text-gray-500 hover:text-gray-300'}`}>Details</button>
            <button onClick={() => setActiveTab('logs')} className={`px-3 py-1.5 text-xs rounded-t-md transition-colors flex items-center gap-1.5 ${activeTab === 'logs' ? 'bg-surface-elevated text-gray-100 font-medium' : 'text-gray-500 hover:text-gray-300'}`}>
              Execution Log
              {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse" />}
            </button>
            <button onClick={() => setActiveTab('notes')} className={`px-3 py-1.5 text-xs rounded-t-md transition-colors flex items-center gap-1.5 ${activeTab === 'notes' ? 'bg-surface-elevated text-gray-100 font-medium' : 'text-gray-500 hover:text-gray-300'}`}>
              Notes
              {task.notes && task.notes.length > 0 && <span className="text-[10px] text-gray-500 font-normal">{task.notes.length}</span>}
            </button>
            <button onClick={() => setActiveTab('deliverables')} className={`px-3 py-1.5 text-xs rounded-t-md transition-colors flex items-center gap-1.5 ${activeTab === 'deliverables' ? 'bg-surface-elevated text-gray-100 font-medium' : 'text-gray-500 hover:text-gray-300'}`}>
              Deliverables
              {(() => { const c = (task.deliverables ?? []).filter(d => d.type !== 'branch' && typeof d.reference === 'string' && d.reference.length > 0).length; return c > 0 ? <span className="text-[10px] text-gray-500 font-normal">{c}</span> : null; })()}
            </button>
          </div>

          {/* Logs tab — conditionally mounted to avoid unnecessary DOM / fetches */}
          {activeTab === 'logs' && (
            <div>
              {runError && (
                <div className="mx-4 mt-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
                  <span className="font-medium">Failed to start:</span> {runError}
                </div>
              )}
              <TaskExecutionLogs taskId={task.id} isVisible isRunning={task.status === 'in_progress'} authUser={authUser} />
            </div>
          )}

          {activeTab === 'details' && (
            <>
              {/* Editable fields */}
              <div className="px-6 py-4 border-b border-border-default/60 space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Project</label>
                    <select value={task.projectId ?? ''} onChange={e => void updateProject(e.target.value)} disabled={busy}
                      className="w-full px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-gray-200 focus:border-brand-500 outline-none disabled:opacity-50 cursor-pointer">
                      <option value="">No Project</option>
                      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Requirement</label>
                    <select value={task.requirementId ?? ''} onChange={e => doUpdate(() => api.tasks.update(task.id, { requirementId: e.target.value || null }))} disabled={busy}
                      className="w-full px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-gray-200 focus:border-brand-500 outline-none disabled:opacity-50 cursor-pointer">
                      <option value="">No Requirement</option>
                      {requirements.filter(r => !task.projectId || r.projectId === task.projectId).map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Assignee</label>
                    <select value={task.assignedAgentId ?? ''} onChange={e => void assignAgent(e.target.value)} disabled={busy}
                      className="w-full px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-gray-200 focus:border-brand-500 outline-none disabled:opacity-50 cursor-pointer">
                      <option value="">Unassigned</option>
                      {agents.map(a => <option key={a.id} value={a.id}>{a.name} ({a.status})</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Priority</label>
                    <select value={task.priority} onChange={e => void updatePriority(e.target.value)} disabled={busy}
                      className="w-full px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-gray-200 focus:border-brand-500 outline-none disabled:opacity-50 cursor-pointer">
                      <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Read-only metadata */}
              <div className="px-6 py-3 border-b border-border-default/60 grid grid-cols-3 gap-x-4 gap-y-2.5">
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

              {/* Workspace isolation & review info */}
              {(task.projectId || task.reviewerAgentId) && (
                <div className="px-6 py-2.5 border-b border-border-default/60 grid grid-cols-2 gap-x-4 gap-y-2">
                  {task.projectId && (
                    <div>
                      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-0.5">Task Branch</p>
                      <p className="text-xs text-cyan-400/80 font-mono">task/{task.id}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-0.5">Reviewer</p>
                    <p className="text-xs text-gray-400">{task.reviewerAgentId ? (agents.find(a => a.id === task.reviewerAgentId)?.name ?? task.reviewerAgentId) : <span className="text-gray-600">Pending review</span>}</p>
                  </div>
                </div>
              )}

              <div className="px-6 py-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Subtasks {subtasks.length > 0 && <span className="ml-1.5 text-gray-500 font-normal normal-case">{completedCount}/{subtasks.length} done</span>}
                  </span>
                  <button onClick={() => setAddingSubtask(true)} className="text-xs text-brand-400 hover:text-brand-300 transition-colors">+ Add subtask</button>
                </div>
                {subtasks.length > 0 && (
                  <div className="space-y-1.5 mb-3">
                    {subtasks.map(sub => (
                      <div key={sub.id} className="group flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-surface-elevated/50 transition-colors">
                        <button onClick={() => void toggleSubtask(sub)} className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${sub.status === 'completed' ? 'bg-green-600 border-green-600 text-white' : 'border-gray-600 hover:border-brand-500'}`}>
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
                      placeholder="Subtask title..." className="flex-1 px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none" />
                    <button onClick={() => void addSubtask()} className="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-xs rounded-lg">Add</button>
                    <button onClick={() => { setAddingSubtask(false); setNewSubtask(''); }} className="px-3 py-1.5 border border-border-default text-xs rounded-lg hover:bg-surface-elevated">Cancel</button>
                  </div>
                )}
                {/* Deliverables preview — latest 3 */}
                {(() => {
                  const validDeliverables = (task.deliverables ?? []).filter(
                    d => d.type !== 'branch' && typeof d.reference === 'string' && d.reference.length > 0
                  );
                  if (validDeliverables.length === 0) return null;
                  const typeColors: Record<string, string> = {
                    file: 'bg-cyan-500/15 text-cyan-400',
                    document: 'bg-blue-500/15 text-blue-400',
                    report: 'bg-purple-500/15 text-purple-400',
                  };
                  const latest3 = validDeliverables.slice(0, 3);
                  return (
                    <div className="mt-5">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Deliverables <span className="text-gray-600 font-normal">({validDeliverables.length})</span></p>
                        {validDeliverables.length > 3 && (
                          <button onClick={() => setActiveTab('deliverables')} className="text-[10px] text-brand-400 hover:text-brand-300">View all →</button>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        {latest3.map((d, i) => {
                          const fileName = d.reference.split('/').pop() ?? d.reference;
                          return (
                            <div key={i} className="flex items-start gap-2.5 bg-surface-elevated/60 rounded-lg px-3 py-2 group hover:bg-surface-elevated/80 transition-colors">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5 ${typeColors[d.type] ?? 'bg-gray-500/15 text-gray-400'}`}>{d.type}</span>
                              <div className="flex-1 min-w-0">
                                <button
                                  onClick={() => setPreviewFile(d.reference)}
                                  className="text-sm text-brand-400 hover:text-brand-300 font-medium truncate block max-w-full text-left hover:underline"
                                  title={d.reference}
                                >
                                  {fileName}
                                </button>
                                {d.summary && <p className="text-[11px] text-gray-400 mt-0.5 line-clamp-2">{d.summary}</p>}
                                <p className="text-[10px] text-gray-600 font-mono truncate mt-0.5">{d.reference}</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
                {/* Notes preview — latest 3 */}
                {task.notes && task.notes.length > 0 && (() => {
                  const latest3 = [...task.notes].reverse().slice(0, 3);
                  return (
                    <div className="mt-5">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Progress Notes <span className="text-gray-600 font-normal">({task.notes.length})</span></p>
                        {task.notes.length > 3 && (
                          <button onClick={() => setActiveTab('notes')} className="text-[10px] text-brand-400 hover:text-brand-300">View all →</button>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        {latest3.map((note, i) => <div key={i} className="text-xs text-gray-400 bg-surface-elevated/60 rounded px-2.5 py-1.5 leading-relaxed"><MarkdownMessage content={note} className="text-xs text-gray-400" /></div>)}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </>
          )}

          {/* Notes tab — full paginated list */}
          {activeTab === 'notes' && (
            <div className="px-6 py-4">
              {task.notes && task.notes.length > 0 ? (() => {
                const reversed = [...task.notes].reverse();
                const totalPages = Math.ceil(reversed.length / PAGE_SIZE);
                const paged = reversed.slice((notesPage - 1) * PAGE_SIZE, notesPage * PAGE_SIZE);
                return (
                  <>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Progress Notes <span className="text-gray-600 font-normal">({task.notes.length})</span></p>
                      {totalPages > 1 && (
                        <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                          <button disabled={notesPage <= 1} onClick={() => setNotesPage(p => p - 1)} className="px-1.5 py-0.5 rounded bg-surface-elevated hover:bg-surface-overlay disabled:opacity-30">‹</button>
                          <span>{notesPage}/{totalPages}</span>
                          <button disabled={notesPage >= totalPages} onClick={() => setNotesPage(p => p + 1)} className="px-1.5 py-0.5 rounded bg-surface-elevated hover:bg-surface-overlay disabled:opacity-30">›</button>
                        </div>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {paged.map((note, i) => <div key={i} className="text-xs text-gray-400 bg-surface-elevated/60 rounded px-2.5 py-1.5 leading-relaxed"><MarkdownMessage content={note} className="text-xs text-gray-400" /></div>)}
                    </div>
                  </>
                );
              })() : (
                <div className="flex items-center justify-center py-12 text-xs text-gray-600">No progress notes yet.</div>
              )}
            </div>
          )}

          {/* Deliverables tab — full paginated list */}
          {activeTab === 'deliverables' && (
            <div className="px-6 py-4">
              {(() => {
                const validDeliverables = (task.deliverables ?? []).filter(
                  d => d.type !== 'branch' && typeof d.reference === 'string' && d.reference.length > 0
                );
                if (validDeliverables.length === 0) return <div className="flex items-center justify-center py-12 text-xs text-gray-600">No deliverables yet.</div>;
                const typeColors: Record<string, string> = {
                  file: 'bg-cyan-500/15 text-cyan-400',
                  document: 'bg-blue-500/15 text-blue-400',
                  report: 'bg-purple-500/15 text-purple-400',
                };
                const totalPages = Math.ceil(validDeliverables.length / PAGE_SIZE);
                const paged = validDeliverables.slice((deliverablesPage - 1) * PAGE_SIZE, deliverablesPage * PAGE_SIZE);
                return (
                  <>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Deliverables <span className="text-gray-600 font-normal">({validDeliverables.length})</span></p>
                      {totalPages > 1 && (
                        <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                          <button disabled={deliverablesPage <= 1} onClick={() => setDeliverablesPage(p => p - 1)} className="px-1.5 py-0.5 rounded bg-surface-elevated hover:bg-surface-overlay disabled:opacity-30">‹</button>
                          <span>{deliverablesPage}/{totalPages}</span>
                          <button disabled={deliverablesPage >= totalPages} onClick={() => setDeliverablesPage(p => p + 1)} className="px-1.5 py-0.5 rounded bg-surface-elevated hover:bg-surface-overlay disabled:opacity-30">›</button>
                        </div>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {paged.map((d, i) => {
                        const fileName = d.reference.split('/').pop() ?? d.reference;
                        return (
                          <div key={i} className="flex items-start gap-2.5 bg-surface-elevated/60 rounded-lg px-3 py-2 group hover:bg-surface-elevated/80 transition-colors">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5 ${typeColors[d.type] ?? 'bg-gray-500/15 text-gray-400'}`}>{d.type}</span>
                            <div className="flex-1 min-w-0">
                              <button
                                onClick={() => setPreviewFile(d.reference)}
                                className="text-sm text-brand-400 hover:text-brand-300 font-medium truncate block max-w-full text-left hover:underline"
                                title={d.reference}
                              >
                                {fileName}
                              </button>
                              {d.summary && <p className="text-[11px] text-gray-400 mt-0.5 line-clamp-2">{d.summary}</p>}
                              <p className="text-[10px] text-gray-600 font-mono truncate mt-0.5">{d.reference}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
          )}
        </div>

        {/* Schedule info banner */}
        {isScheduled && task.scheduleConfig && (
          <div className={`mx-6 mt-3 mb-0 px-4 py-2.5 rounded-lg border text-xs ${schedPaused ? 'bg-amber-500/5 border-amber-500/20' : 'bg-brand-500/5 border-brand-500/20'}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={schedPaused ? 'text-amber-400' : 'text-brand-400'}>
                {schedPaused ? '⏸ Schedule Paused' : <><svg className="w-3.5 h-3.5 inline -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/></svg> Scheduled</>}
              </span>
              <span className="text-gray-500">·</span>
              <span className="text-gray-300">
                {task.scheduleConfig.every ? `Every ${task.scheduleConfig.every}` : task.scheduleConfig.cron ? `Cron: ${task.scheduleConfig.cron}` : task.scheduleConfig.runAt ? 'One-shot' : 'N/A'}
              </span>
              {!schedPaused && task.scheduleConfig.nextRunAt && (
                <>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-400">Next: {(() => {
                    const diff = new Date(task.scheduleConfig.nextRunAt).getTime() - Date.now();
                    if (diff <= 0) return 'due now';
                    const m = Math.floor(diff / 60000);
                    if (m < 60) return `in ${m}m`;
                    const h = Math.floor(m / 60);
                    return h < 24 ? `in ${h}h ${m % 60}m` : `in ${Math.floor(h / 24)}d ${h % 24}h`;
                  })()}</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1 text-gray-500">
              <span>Runs: {task.scheduleConfig.currentRuns ?? 0}{task.scheduleConfig.maxRuns != null ? ` / ${task.scheduleConfig.maxRuns}` : ''}</span>
              {task.scheduleConfig.lastRunAt && (
                <>
                  <span>·</span>
                  <span>Last: {(() => {
                    const diff = Date.now() - new Date(task.scheduleConfig.lastRunAt).getTime();
                    const m = Math.floor(diff / 60000);
                    if (m < 1) return 'just now';
                    if (m < 60) return `${m}m ago`;
                    const h = Math.floor(m / 60);
                    return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
                  })()}</span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="px-6 py-4 border-t border-border-default flex items-center justify-between gap-2">
          <div className="flex gap-2 flex-wrap">
            {isScheduled ? (<>
              {/* ── Scheduled task buttons ── */}
              {task.status === 'pending_approval' && (
                <>
                  <button onClick={() => doUpdate(() => api.tasks.approve(task.id))} disabled={busy} className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white disabled:opacity-50">Approve</button>
                  <button onClick={() => doUpdate(() => api.tasks.reject(task.id))} disabled={busy} className="px-3 py-1.5 text-xs text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50">Reject</button>
                </>
              )}
              {(task.status === 'pending' || task.status === 'assigned' || task.status === 'accepted' || isCompleted || isFailed) && task.assignedAgentId && (
                <button onClick={() => void runScheduledNow()} disabled={running} className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 rounded-lg text-white disabled:opacity-50 flex items-center gap-1.5">
                  {running ? <>Running…</> : <><svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7-4.5-7-4.5z" /></svg>Run Now</>}
                </button>
              )}
              {task.status === 'revision' && task.assignedAgentId && (
                <button onClick={() => void resumeTask()} disabled={running} className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 rounded-lg text-white disabled:opacity-50 flex items-center gap-1.5">
                  {running ? <>Running…</> : <><svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7-4.5-7-4.5z" /></svg>Run / Resume</>}
                </button>
              )}
              {isRunning && <button onClick={() => void pauseTask()} disabled={busy} className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 rounded-lg text-white disabled:opacity-50">Pause</button>}
              {isBlocked && <button onClick={() => void startTask()} disabled={busy} className="px-3 py-1.5 text-xs bg-surface-overlay hover:bg-gray-600 rounded-lg text-gray-200 disabled:opacity-50">Unblock</button>}
              {task.status === 'review' && (
                <>
                  <button onClick={() => void doUpdate(() => api.tasks.accept(task.id, authUser?.id))} disabled={busy} className="px-3 py-1.5 text-xs bg-teal-600 hover:bg-teal-500 rounded-lg text-white disabled:opacity-50">✓ Accept</button>
                  {!showRevision ? (
                    <button onClick={() => setShowRevision(true)} disabled={busy} className="px-3 py-1.5 text-xs bg-orange-600 hover:bg-orange-500 rounded-lg text-white disabled:opacity-50">↻ Revision</button>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <input type="text" value={revisionReason} onChange={e => setRevisionReason(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && revisionReason.trim()) { void doUpdate(() => api.tasks.revision(task.id, revisionReason.trim(), authUser?.id)); setShowRevision(false); setRevisionReason(''); } }}
                        placeholder="Revision reason…" autoFocus
                        className="px-2 py-1 text-xs bg-surface-elevated border border-orange-500/40 rounded-lg text-gray-200 focus:border-orange-400 outline-none w-48" />
                      <button onClick={() => { void doUpdate(() => api.tasks.revision(task.id, revisionReason.trim() || 'Revisions needed', authUser?.id)); setShowRevision(false); setRevisionReason(''); }}
                        disabled={busy} className="px-2.5 py-1 text-xs bg-orange-600 hover:bg-orange-500 rounded-lg text-white disabled:opacity-50">Send</button>
                      <button onClick={() => { setShowRevision(false); setRevisionReason(''); }}
                        className="px-1.5 py-1 text-xs text-gray-400 hover:text-gray-200">✕</button>
                    </div>
                  )}
                </>
              )}
              {(task.status === 'in_progress' || task.status === 'revision') && (
                <button onClick={() => void updateStatus(task.id, 'review')} disabled={busy} className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 rounded-lg text-white disabled:opacity-50">Submit for Review</button>
              )}
              {!isRunning && (
                schedPaused
                  ? <button onClick={() => void doUpdate(() => api.tasks.resumeSchedule(task.id))} disabled={busy} className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white disabled:opacity-50">▶ Resume Schedule</button>
                  : <button onClick={() => void doUpdate(() => api.tasks.pauseSchedule(task.id))} disabled={busy} className="px-3 py-1.5 text-xs border border-amber-500/30 text-amber-400 rounded-lg hover:bg-amber-500/10 disabled:opacity-50">⏸ Pause Schedule</button>
              )}
              {!isCompleted && !isFailed && !isCancelled && !isArchived && task.status !== 'pending_approval' && task.status !== 'accepted' && (
                <button onClick={() => void updateStatus(task.id, 'cancelled')} disabled={busy} className="px-3 py-1.5 text-xs text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50">Cancel</button>
              )}
            </>) : (<>
              {/* ── Standard task buttons ── */}
              {task.status === 'pending_approval' && (
                <>
                  <button onClick={() => doUpdate(() => api.tasks.approve(task.id))} disabled={busy} className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white disabled:opacity-50">Approve</button>
                  <button onClick={() => doUpdate(() => api.tasks.reject(task.id))} disabled={busy} className="px-3 py-1.5 text-xs text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50">Reject</button>
                </>
              )}
              {task.assignedAgentId && !isRunning && !isTerminal && task.status !== 'pending_approval' && task.status !== 'review' && task.status !== 'accepted' && task.status !== 'blocked' && (
                <button onClick={() => void resumeTask()} disabled={running} className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 rounded-lg text-white disabled:opacity-50 flex items-center gap-1.5">
                  {running ? <>Running…</> : <><svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7-4.5-7-4.5z" /></svg>Run / Resume</>}
                </button>
              )}
              {isRunning && <button onClick={() => void pauseTask()} disabled={busy} className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 rounded-lg text-white disabled:opacity-50">Pause</button>}
              {isRunning && <button onClick={() => void updateStatus(task.id, 'blocked')} disabled={busy} className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 rounded-lg text-white disabled:opacity-50">Block</button>}
              {isBlocked && <button onClick={() => void startTask()} disabled={busy} className="px-3 py-1.5 text-xs bg-surface-overlay hover:bg-gray-600 rounded-lg text-gray-200 disabled:opacity-50">Unblock</button>}
              {(task.status === 'pending' || task.status === 'assigned') && (
                <button onClick={() => void startTask()} disabled={busy} className="px-3 py-1.5 text-xs bg-surface-overlay hover:bg-gray-600 rounded-lg text-gray-200 disabled:opacity-50">Mark In Progress</button>
              )}
              {(isCompleted || isFailed) && task.assignedAgentId && (
                <button onClick={() => void resumeTask()} disabled={running} className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 rounded-lg text-white disabled:opacity-50">Run Again</button>
              )}
              {task.status === 'review' && (
                <>
                  <button onClick={() => void doUpdate(() => api.tasks.accept(task.id, authUser?.id))} disabled={busy} className="px-3 py-1.5 text-xs bg-teal-600 hover:bg-teal-500 rounded-lg text-white disabled:opacity-50">✓ Accept</button>
                  {!showRevision ? (
                    <button onClick={() => setShowRevision(true)} disabled={busy} className="px-3 py-1.5 text-xs bg-orange-600 hover:bg-orange-500 rounded-lg text-white disabled:opacity-50">↻ Revision</button>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <input type="text" value={revisionReason} onChange={e => setRevisionReason(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && revisionReason.trim()) { void doUpdate(() => api.tasks.revision(task.id, revisionReason.trim(), authUser?.id)); setShowRevision(false); setRevisionReason(''); } }}
                        placeholder="Revision reason…" autoFocus
                        className="px-2 py-1 text-xs bg-surface-elevated border border-orange-500/40 rounded-lg text-gray-200 focus:border-orange-400 outline-none w-48" />
                      <button onClick={() => { void doUpdate(() => api.tasks.revision(task.id, revisionReason.trim() || 'Revisions needed', authUser?.id)); setShowRevision(false); setRevisionReason(''); }}
                        disabled={busy} className="px-2.5 py-1 text-xs bg-orange-600 hover:bg-orange-500 rounded-lg text-white disabled:opacity-50">Send</button>
                      <button onClick={() => { setShowRevision(false); setRevisionReason(''); }}
                        className="px-1.5 py-1 text-xs text-gray-400 hover:text-gray-200">✕</button>
                    </div>
                  )}
                </>
              )}
              {(task.status === 'completed' || task.status === 'accepted') && (
                <button onClick={() => doUpdate(() => api.tasks.archive(task.id))} disabled={busy} className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 rounded-lg text-gray-200 disabled:opacity-50">Archive</button>
              )}
              {(task.status === 'in_progress' || task.status === 'revision') && (
                <button onClick={() => void updateStatus(task.id, 'review')} disabled={busy} className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 rounded-lg text-white disabled:opacity-50">Submit for Review</button>
              )}
              {isTerminal && <button onClick={() => void reopenTask()} disabled={busy} className="px-3 py-1.5 text-xs bg-surface-overlay hover:bg-gray-600 rounded-lg text-gray-200 disabled:opacity-50">Reopen</button>}
              {task.status === 'accepted' && <button onClick={() => void updateStatus(task.id, 'completed')} disabled={busy} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 rounded-lg text-white disabled:opacity-50">Complete</button>}
              {!isTerminal && task.status !== 'pending_approval' && task.status !== 'accepted' && <button onClick={() => void updateStatus(task.id, 'cancelled')} disabled={busy} className="px-3 py-1.5 text-xs text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50">Cancel</button>}
            </>)}
          </div>
          <button onClick={() => setPendingDeleteParent(true)} className="px-3 py-1.5 text-xs text-gray-500 hover:text-red-400 border border-transparent hover:border-red-500/30 rounded-lg transition-colors">Delete</button>
        </div>
      </div>

      {pendingDelete && <ConfirmModal title={`Delete subtask "${pendingDelete.title}"?`} message="This subtask will be permanently deleted." confirmLabel="Delete" onConfirm={() => void deleteSubtask(pendingDelete)} onCancel={() => setPendingDelete(null)} />}
      {pendingDeleteParent && <ConfirmModal title={`Delete task "${task.title}"?`} message={subtasks.length > 0 ? `This will also delete all ${subtasks.length} subtask(s).` : 'This task will be permanently deleted.'} confirmLabel="Delete Task" onConfirm={() => void deleteParent()} onCancel={() => setPendingDeleteParent(false)} />}
      {previewFile && <FilePreviewModal filePath={previewFile} onClose={() => setPreviewFile(null)} />}
    </div>
  );
}

// ─── Project Settings Panel ─────────────────────────────────────────────────────

function ProjectSettingsPanel({ project, iterations, tasks, requirements, agents, onIterationAction, onDeleteProject, onCreateIteration, onUpdateProject, onRefresh }: {
  project: ProjectInfo;
  iterations: IterationInfo[];
  tasks: TaskInfo[];
  requirements: RequirementInfo[];
  agents: AgentInfo[];
  onIterationAction: (iterId: string, status: string) => void;
  onDeleteProject: () => void;
  onCreateIteration: (name: string, goal: string, start: string, end: string) => void;
  onUpdateProject: (data: Partial<ProjectInfo>) => Promise<void>;
  onRefresh: () => void;
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

  const projTasks = useMemo(() => tasks.filter(t => t.projectId === project.id && !t.parentTaskId), [tasks, project.id]);
  const projReqs = useMemo(() => requirements.filter(r => r.projectId === project.id), [requirements, project.id]);
  const stats = useMemo(() => {
    const s = { total: projTasks.length, completed: 0, inProgress: 0, inReview: 0, blocked: 0, pending: 0, failed: 0, reqs: projReqs.length, reqsDone: 0 };
    for (const t of projTasks) {
      if (t.status === 'completed' || t.status === 'accepted') s.completed++;
      else if (t.status === 'in_progress') s.inProgress++;
      else if (t.status === 'review' || t.status === 'revision') s.inReview++;
      else if (t.status === 'blocked') s.blocked++;
      else if (t.status === 'failed') s.failed++;
      else s.pending++;
    }
    for (const r of projReqs) { if (r.status === 'completed') s.reqsDone++; }
    return s;
  }, [projTasks, projReqs]);
  const assignedAgentIds = useMemo(() => new Set(projTasks.map(t => t.assignedAgentId).filter(Boolean)), [projTasks]);
  const projAgents = useMemo(() => agents.filter(a => assignedAgentIds.has(a.id)), [agents, assignedAgentIds]);

  return (
    <div className="p-5 space-y-5 max-w-3xl">
      {/* Description + metadata (no duplicate name) */}
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0 space-y-2">
          <InlineEditableTextarea
            value={project.description ?? ''}
            onSave={async (desc) => { await onUpdateProject({ description: desc }); onRefresh(); }}
            className="text-sm text-gray-400"
            placeholder="Add a project description…"
          />
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <StatusPill status={project.status} />
            <IterModelBadge model={project.iterationModel} />
            {project.createdAt && <span className="text-gray-600">Created {new Date(project.createdAt).toLocaleDateString()}</span>}
          </div>
        </div>
        <button onClick={onDeleteProject} className="text-xs text-red-400 hover:text-red-300 shrink-0 ml-4">Delete Project</button>
      </div>

      {/* Task Statistics */}
      <div className="bg-surface-secondary border border-border-default rounded-xl p-4">
        <h4 className="text-xs font-semibold text-gray-400 mb-3">Task Overview</h4>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
          <StatCard label="Total" value={stats.total} color="text-gray-200" />
          <StatCard label="Completed" value={stats.completed} color="text-emerald-400" />
          <StatCard label="In Progress" value={stats.inProgress} color="text-brand-400" />
          <StatCard label="In Review" value={stats.inReview} color="text-purple-400" />
          <StatCard label="Blocked" value={stats.blocked} color="text-amber-400" />
          <StatCard label="Failed" value={stats.failed} color="text-red-400" />
        </div>
        {stats.total > 0 && (
          <div className="mt-3 flex h-2 rounded-full overflow-hidden bg-surface-elevated">
            {stats.completed > 0 && <div className="bg-emerald-500" style={{ width: `${(stats.completed / stats.total) * 100}%` }} />}
            {stats.inProgress > 0 && <div className="bg-brand-500" style={{ width: `${(stats.inProgress / stats.total) * 100}%` }} />}
            {stats.inReview > 0 && <div className="bg-purple-500" style={{ width: `${(stats.inReview / stats.total) * 100}%` }} />}
            {stats.blocked > 0 && <div className="bg-amber-500" style={{ width: `${(stats.blocked / stats.total) * 100}%` }} />}
            {stats.pending > 0 && <div className="bg-blue-500/40" style={{ width: `${(stats.pending / stats.total) * 100}%` }} />}
            {stats.failed > 0 && <div className="bg-red-500" style={{ width: `${(stats.failed / stats.total) * 100}%` }} />}
          </div>
        )}
      </div>

      {/* Requirement Stats */}
      <div className="bg-surface-secondary border border-border-default rounded-xl p-4">
        <h4 className="text-xs font-semibold text-gray-400 mb-3">Requirements</h4>
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Total" value={stats.reqs} color="text-gray-200" />
          <StatCard label="Completed" value={stats.reqsDone} color="text-emerald-400" />
          <StatCard label="Active" value={stats.reqs - stats.reqsDone} color="text-brand-400" />
        </div>
      </div>

      {/* Agents working on this project */}
      {projAgents.length > 0 && (
        <div className="bg-surface-secondary border border-border-default rounded-xl p-4">
          <h4 className="text-xs font-semibold text-gray-400 mb-3">Agents ({projAgents.length})</h4>
          <div className="flex flex-wrap gap-2">
            {projAgents.map(a => {
              const agentTasks = projTasks.filter(t => t.assignedAgentId === a.id);
              const activeTasks = agentTasks.filter(t => !['completed', 'failed', 'cancelled', 'archived'].includes(t.status));
              return (
                <div key={a.id} className="flex items-center gap-2 px-3 py-2 bg-surface-elevated/60 rounded-lg">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${a.status === 'working' ? 'bg-blue-500' : a.status === 'idle' ? 'bg-green-500' : 'bg-gray-500'}`} />
                  <span className="text-xs text-gray-300">{a.name}</span>
                  <span className="text-[10px] text-gray-600">{activeTasks.length} active / {agentTasks.length} total</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Repositories */}
      {project.repositories && project.repositories.length > 0 && (
        <div className="bg-surface-secondary border border-border-default rounded-xl p-4">
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

      {/* Iterations */}
      <div className="bg-surface-secondary border border-border-default rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs font-semibold text-gray-400">Iterations</h4>
          <button onClick={() => setShowIterForm(true)} className="text-xs px-2.5 py-1 rounded-lg bg-surface-overlay hover:bg-gray-600 text-gray-300">+ Add</button>
        </div>

        {showIterForm && (
          <div className="mb-3 p-3 bg-surface-elevated rounded-lg space-y-2">
            <input value={iterName} onChange={e => setIterName(e.target.value)} placeholder="Iteration name" className="w-full bg-surface-overlay border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-200" />
            <input value={iterGoal} onChange={e => setIterGoal(e.target.value)} placeholder="Goal" className="w-full bg-surface-overlay border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-200" />
            <div className="flex gap-2">
              <input type="date" value={iterStart} onChange={e => setIterStart(e.target.value)} className="bg-surface-overlay border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-200" />
              <input type="date" value={iterEnd} onChange={e => setIterEnd(e.target.value)} className="bg-surface-overlay border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-200" />
            </div>
            <div className="flex gap-2">
              <button onClick={handleCreate} className="text-sm px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white">Create</button>
              <button onClick={() => setShowIterForm(false)} className="text-sm text-gray-500">Cancel</button>
            </div>
          </div>
        )}

        {iterations.length === 0 ? (
          <p className="text-sm text-gray-500">No iterations yet.</p>
        ) : (
          <div className="space-y-1.5">
            {iterations.map(it => (
              <div key={it.id} className="p-2.5 bg-surface-elevated/50 rounded-lg flex items-center justify-between">
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
                  {it.status === 'active' && <button onClick={() => onIterationAction(it.id, 'review')} className="text-xs px-2 py-1 rounded bg-brand-700 hover:bg-brand-600 text-white">Review</button>}
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

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center py-2">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

// ─── Requirement → Board Column Mapping ──────────────────────────────────────

const REQ_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  draft:          { label: 'Draft',     cls: 'bg-gray-500/15 text-gray-400' },
  pending_review: { label: 'Pending',   cls: 'bg-yellow-500/15 text-yellow-400' },
  approved:       { label: 'Approved',  cls: 'bg-green-500/15 text-green-400' },
  in_progress:    { label: 'Active',    cls: 'bg-brand-500/15 text-brand-400' },
  completed:      { label: 'Done',      cls: 'bg-emerald-500/15 text-emerald-400' },
  rejected:       { label: 'Rejected',  cls: 'bg-red-500/15 text-red-400' },
  cancelled:      { label: 'Cancelled', cls: 'bg-gray-600/15 text-gray-500' },
};

const REQ_COLUMN_MAP: Record<string, string> = {
  draft: 'todo', pending_review: 'todo',
  approved: 'todo',
  in_progress: 'in_progress',
  completed: 'done',
  rejected: 'closed', cancelled: 'closed',
};

const REQ_DROP_STATUS: Record<string, string> = {
  todo: 'approved',
  in_progress: 'in_progress',
  review: 'approved',
  done: 'completed',
  closed: 'cancelled',
};

// ─── Backlog Table View ─────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const GROUP_ORDER: Record<string, number> = { todo: 0, in_progress: 1, review: 2, done: 3, closed: 4 };
const GROUP_ACCENT: Record<string, string> = {
  todo: 'border-l-blue-500 bg-blue-500/5',
  in_progress: 'border-l-brand-500 bg-brand-500/5',
  review: 'border-l-purple-500 bg-purple-500/5',
  done: 'border-l-green-500 bg-green-500/5',
  closed: 'border-l-red-500 bg-red-500/5',
};
const GROUP_HEADER_CLS: Record<string, string> = {
  todo: 'border-l-blue-500 text-blue-400',
  in_progress: 'border-l-brand-500 text-brand-400',
  review: 'border-l-purple-500 text-purple-400',
  done: 'border-l-green-500 text-green-400',
  closed: 'border-l-red-500 text-red-400',
};

const ALL_REQ_STATUSES = ['draft', 'pending_review', 'approved', 'in_progress', 'completed', 'rejected', 'cancelled'] as const;

function taskToGroup(status: string): string {
  for (const col of BOARD_COLUMNS) {
    if ((col.statuses as readonly string[]).includes(status)) return col.id;
  }
  return 'closed';
}

type BacklogRow =
  | { kind: 'task'; data: TaskInfo; group: string; groupOrder: number }
  | { kind: 'req';  data: RequirementInfo; group: string; groupOrder: number };

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function BacklogRowView({ row, idx, dragIdx, agentMap, projMap, onTaskClick, onReqClick, onRowDragStart, onRowDragEnd, handleStatusChange, handlePriorityChange }: {
  row: BacklogRow; idx: number; dragIdx: number | null;
  agentMap: Map<string, AgentInfo>; projMap: Map<string, ProjectInfo>;
  onTaskClick: (t: TaskInfo) => void; onReqClick: (r: RequirementInfo) => void;
  onRowDragStart: (e: React.DragEvent, idx: number) => void; onRowDragEnd: (e: React.DragEvent) => void;
  handleStatusChange: (row: BacklogRow, val: string) => Promise<void>;
  handlePriorityChange: (row: BacklogRow, val: string) => Promise<void>;
}) {
  const status = row.data.status;
  const priority = row.data.priority;
  const assignee = row.kind === 'task' ? agentMap.get(row.data.assignedAgentId ?? '') : undefined;
  const proj = projMap.get(row.kind === 'task' ? (row.data.projectId ?? '') : (row.data.projectId ?? ''));
  return (
    <div
      draggable
      onDragStart={e => onRowDragStart(e, idx)}
      onDragEnd={onRowDragEnd}
      onClick={() => row.kind === 'task' ? onTaskClick(row.data) : onReqClick(row.data)}
      className={`flex items-center gap-2 px-6 py-2 border-b border-border-default/40 cursor-pointer hover:bg-surface-elevated/50 transition-colors border-l-2 ${GROUP_ACCENT[row.group] ?? 'border-l-gray-700'} ${dragIdx === idx ? 'opacity-40' : ''}`}
    >
      <div className="w-12 shrink-0">
        {row.kind === 'req' ? (
          <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-amber-500/15 text-amber-400">REQ</span>
        ) : row.data.taskType === 'scheduled' ? (
          <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-cyan-500/15 text-cyan-400 inline-flex items-center gap-0.5" title="Scheduled task">SCHED</span>
        ) : (
          <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-gray-500/15 text-gray-400">TASK</span>
        )}
      </div>
      <div className="flex-1 min-w-[200px] text-sm text-gray-200 truncate">{row.data.title}</div>
      <div className="w-[130px] shrink-0" onClick={e => e.stopPropagation()}>
        <select
          value={status}
          onChange={e => void handleStatusChange(row, e.target.value)}
          className="w-full px-1.5 py-1 bg-surface-elevated/80 border border-border-default/50 rounded text-[11px] text-gray-300 outline-none focus:border-brand-500 cursor-pointer"
        >
          {row.kind === 'task'
            ? ALL_STATUSES.map(s => <option key={s} value={s}>{COLUMN_LABELS[s] ?? s}</option>)
            : ALL_REQ_STATUSES.map(s => <option key={s} value={s}>{REQ_STATUS_BADGE[s]?.label ?? s}</option>)
          }
        </select>
      </div>
      <div className="w-[100px] shrink-0" onClick={e => e.stopPropagation()}>
        <select
          value={priority}
          onChange={e => void handlePriorityChange(row, e.target.value)}
          className="w-full px-1.5 py-1 bg-surface-elevated/80 border border-border-default/50 rounded text-[11px] text-gray-300 outline-none focus:border-brand-500 cursor-pointer"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
      </div>
      <div className="w-[120px] shrink-0 text-[11px] text-gray-400 truncate">
        {assignee ? (
          <span className="flex items-center gap-1">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[assignee.status] ?? 'bg-gray-500'}`} />
            {assignee.name}
          </span>
        ) : (
          <span className="text-gray-600">—</span>
        )}
      </div>
      <div className="w-[120px] shrink-0 text-[11px] text-gray-500 truncate">
        {proj?.name ?? <span className="text-gray-700">—</span>}
      </div>
      <div className="w-[90px] shrink-0 text-[10px] text-gray-600 text-right">
        {relativeTime(row.data.updatedAt ?? '')}
      </div>
    </div>
  );
}

function BacklogTable({ tasks, requirements, agents, projects, onTaskClick, onReqClick, onRefresh }: {
  tasks: TaskInfo[];
  requirements: RequirementInfo[];
  agents: AgentInfo[];
  projects: ProjectInfo[];
  onTaskClick: (t: TaskInfo) => void;
  onReqClick: (r: RequirementInfo) => void;
  onRefresh: () => void;
}) {
  const [sortMode, setSortMode] = useState<'status' | 'priority'>('status');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);

  const rows = useMemo(() => {
    const result: BacklogRow[] = [];
    for (const t of tasks) {
      if (t.parentTaskId) continue;
      const group = taskToGroup(t.status);
      result.push({ kind: 'task', data: t, group, groupOrder: GROUP_ORDER[group] ?? 5 });
    }
    for (const r of requirements) {
      const group = REQ_COLUMN_MAP[r.status] ?? 'todo';
      result.push({ kind: 'req', data: r, group, groupOrder: GROUP_ORDER[group] ?? 5 });
    }

    if (sortMode === 'status') {
      result.sort((a, b) => {
        if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
        const aT = new Date(a.data.updatedAt ?? 0).getTime();
        const bT = new Date(b.data.updatedAt ?? 0).getTime();
        return bT - aT;
      });
    } else {
      const pA = (r: BacklogRow) => PRIORITY_ORDER[r.data.priority] ?? 2;
      result.sort((a, b) => {
        const pa = pA(a), pb = pA(b);
        if (pa !== pb) return pa - pb;
        return new Date(b.data.updatedAt ?? 0).getTime() - new Date(a.data.updatedAt ?? 0).getTime();
      });
    }
    return result;
  }, [tasks, requirements, sortMode]);

  const handleStatusChange = async (row: BacklogRow, newStatus: string) => {
    try {
      if (row.kind === 'task') {
        await api.tasks.updateStatus(row.data.id, newStatus);
      } else {
        await api.requirements.updateStatus(row.data.id, newStatus);
      }
      onRefresh();
    } catch { /* */ }
  };

  const handlePriorityChange = async (row: BacklogRow, newPriority: string) => {
    try {
      if (row.kind === 'task') {
        await api.tasks.update(row.data.id, { priority: newPriority });
      } else {
        await api.requirements.update(row.data.id, { priority: newPriority });
      }
      onRefresh();
    } catch { /* */ }
  };

  const onRowDragStart = (e: React.DragEvent, idx: number) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
    (e.currentTarget as HTMLElement).style.opacity = '0.4';
  };
  const onRowDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
    setDragIdx(null);
    setDragOverGroup(null);
  };
  const onGroupDragOver = (e: DragEvent<HTMLDivElement>, groupId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverGroup !== groupId) setDragOverGroup(groupId);
  };
  const onGroupDrop = async (e: DragEvent<HTMLDivElement>, groupId: string) => {
    e.preventDefault();
    setDragOverGroup(null);
    if (dragIdx == null) return;
    const row = rows[dragIdx];
    if (!row || row.group === groupId) return;
    const col = BOARD_COLUMNS.find(c => c.id === groupId);
    if (!col) return;
    try {
      if (row.kind === 'task') {
        if (row.data.status === 'pending_approval') return;
        await api.tasks.updateStatus(row.data.id, col.dropStatus);
      } else {
        const reqStatus = REQ_DROP_STATUS[groupId];
        if (reqStatus) await api.requirements.updateStatus(row.data.id, reqStatus);
      }
      onRefresh();
    } catch { /* */ }
    setDragIdx(null);
  };

  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const projMap = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);

  const ALWAYS_SHOW_GROUPS = ['todo', 'in_progress', 'review', 'done'];
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.group] = (counts[r.group] ?? 0) + 1;
    return counts;
  }, [rows]);
  const { rowsByGroup, rowIndexMap } = useMemo(() => {
    const map = new Map<string, BacklogRow[]>();
    const idxMap = new Map<BacklogRow, number>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      idxMap.set(r, i);
      const list = map.get(r.group) ?? [];
      list.push(r);
      map.set(r.group, list);
    }
    return { rowsByGroup: map, rowIndexMap: idxMap };
  }, [rows]);
  const visibleGroups = useMemo(() => {
    if (sortMode !== 'status') return null;
    const groups: string[] = [];
    const seen = new Set<string>();
    for (const g of ALWAYS_SHOW_GROUPS) { groups.push(g); seen.add(g); }
    for (const r of rows) { if (!seen.has(r.group)) { groups.push(r.group); seen.add(r.group); } }
    return groups;
  }, [rows, sortMode]);

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="min-w-[850px] h-full flex flex-col">
      {/* Table header with integrated sort */}
      <div className="flex items-center gap-2 px-6 py-2 border-b border-border-default text-[10px] font-semibold text-gray-600 uppercase tracking-wider shrink-0 bg-surface-secondary/80">
        <div className="w-12 shrink-0 text-gray-700 normal-case font-normal">{rows.length}</div>
        <div className="flex-1 min-w-[200px]">Title</div>
        <button onClick={() => setSortMode('status')} className={`w-[130px] shrink-0 text-left flex items-center gap-1 transition-colors ${sortMode === 'status' ? 'text-brand-400' : 'hover:text-gray-400'}`}>
          Status {sortMode === 'status' && <span className="text-[8px]">▼</span>}
        </button>
        <button onClick={() => setSortMode('priority')} className={`w-[100px] shrink-0 text-left flex items-center gap-1 transition-colors ${sortMode === 'priority' ? 'text-brand-400' : 'hover:text-gray-400'}`}>
          Priority {sortMode === 'priority' && <span className="text-[8px]">▼</span>}
        </button>
        <div className="w-[120px] shrink-0">Assignee</div>
        <div className="w-[120px] shrink-0">Project</div>
        <div className="w-[90px] shrink-0 text-right">Updated</div>
      </div>

      {/* Table body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {sortMode === 'status' && visibleGroups ? (
          visibleGroups.map(groupId => {
            const col = BOARD_COLUMNS.find(c => c.id === groupId);
            const groupRows = rowsByGroup.get(groupId) ?? [];
            return (
              <div key={groupId}>
                <div
                  className={`flex items-center gap-2 px-6 py-2 border-l-2 bg-surface-secondary/60 sticky top-0 z-10 ${GROUP_HEADER_CLS[groupId] ?? ''} ${dragOverGroup === groupId ? 'ring-1 ring-brand-500/40' : ''}`}
                  onDragOver={e => onGroupDragOver(e, groupId)}
                  onDragLeave={() => setDragOverGroup(null)}
                  onDrop={e => void onGroupDrop(e, groupId)}
                >
                  <span className="text-[11px] font-semibold uppercase tracking-wider">{col?.label ?? groupId}</span>
                  <span className="text-[10px] text-gray-600">{groupCounts[groupId] ?? 0}</span>
                </div>
                {groupRows.map(row => (
                  <BacklogRowView key={`${row.kind}-${row.data.id}`} row={row} idx={rowIndexMap.get(row) ?? 0} dragIdx={dragIdx} agentMap={agentMap} projMap={projMap} onTaskClick={onTaskClick} onReqClick={onReqClick} onRowDragStart={onRowDragStart} onRowDragEnd={onRowDragEnd} handleStatusChange={handleStatusChange} handlePriorityChange={handlePriorityChange} />
                ))}
              </div>
            );
          })
        ) : (
          rows.map((row, idx) => (
            <BacklogRowView key={`${row.kind}-${row.data.id}`} row={row} idx={idx} dragIdx={dragIdx} agentMap={agentMap} projMap={projMap} onTaskClick={onTaskClick} onReqClick={onReqClick} onRowDragStart={onRowDragStart} onRowDragEnd={onRowDragEnd} handleStatusChange={handleStatusChange} handlePriorityChange={handlePriorityChange} />
          ))
        )}
        {rows.length === 0 && (
          <div className="flex items-center justify-center py-16 text-sm text-gray-600">No items</div>
        )}
      </div>
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────────

export function ProjectsPage({ authUser }: { authUser?: { id: string; name: string; role: string; orgId: string } }) {
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
  const openCreateReq = useCallback(() => {
    setReqProjectId(selectedProjectId ?? '');
    setShowCreateReq(true);
  }, [selectedProjectId]);

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
  const [taskRequirementId, setTaskRequirementId] = useState<string>('');
  const [taskBlockedBy, setTaskBlockedBy] = useState<string[]>([]);
  const [taskType, setTaskType] = useState<'standard' | 'scheduled'>('standard');
  const [taskScheduleEvery, setTaskScheduleEvery] = useState('4h');

  const [selectedTask, setSelectedTask] = useState<TaskInfo | null>(null);
  const [selectedReq, setSelectedReq] = useState<RequirementInfo | null>(null);
  const [agentFilter, setAgentFilter] = useState<Set<string>>(new Set());
  const [projectFilter, setProjectFilter] = useState<Set<string>>(new Set());
  const savedProjectFilterRef = useRef<Set<string>>(new Set());
  const projectFilterRef = useRef<Set<string>>(new Set());
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [boardType, setBoardType] = useState<'backlog' | 'kanban' | 'dag'>('backlog');
  const [showArchived, setShowArchived] = useState(false);
  const dragTaskRef = useRef<TaskInfo | null>(null);
  const dragReqRef = useRef<RequirementInfo | null>(null);

  // Requirement create/reject modals
  const [showCreateReq, setShowCreateReq] = useState(false);
  const [reqTitle, setReqTitle] = useState('');
  const [reqDesc, setReqDesc] = useState('');
  const [reqPriority, setReqPriority] = useState('medium');
  const [reqProjectId, setReqProjectId] = useState('');
  const [rejectReqId, setRejectReqId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const msg = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 3000); };

  const selectedProject = projects.find(p => p.id === selectedProjectId) ?? null;

  useEffect(() => { projectFilterRef.current = projectFilter; }, [projectFilter]);

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

  useEffect(() => {
    if (selectedProjectId) loadIterations(selectedProjectId);
    else setIterations([]);
  }, [selectedProjectId, loadIterations]);

  const selectedTaskRef = useRef(selectedTask);
  selectedTaskRef.current = selectedTask;

  useEffect(() => {
    // Reduce polling frequency when modal is open (60s vs 15s)
    const pollMs = selectedTask ? 60000 : 15000;
    const i = setInterval(() => { refreshBoard(); refreshAgents(); refreshRequirements(); }, pollMs);
    const unsub = wsClient.on('task:update', (event) => {
      if (!selectedTaskRef.current) { refreshBoard(); refreshRequirements(); }
      const p = event?.payload as Record<string, unknown> | undefined;
      if (p?.taskId) {
        setSelectedTask(prev => {
          if (!prev || prev.id !== p.taskId) return prev;
          const patch: Partial<TaskInfo> = {};
          if (typeof p.status === 'string') patch.status = p.status;
          if (Array.isArray(p.deliverables)) patch.deliverables = p.deliverables as TaskInfo['deliverables'];
          if (Array.isArray(p.notes)) patch.notes = p.notes as string[];
          if (p.result !== undefined) patch.result = p.result as TaskInfo['result'];
          return { ...prev, ...patch };
        });
      }
    });
    return () => { clearInterval(i); unsub(); };
  }, [refreshBoard, refreshAgents, refreshRequirements, selectedTask]);

  // Board ref for event handlers that need current board without re-registering
  const boardRef = useRef(board);
  boardRef.current = board;

  // Try to open a task from localStorage (set by other pages)
  useEffect(() => {
    const navTaskId = localStorage.getItem('markus_nav_openTask');
    if (!navTaskId) return;
    const allTasks = Object.values(board).flat();
    const task = allTasks.find(t => t.id === navTaskId);
    if (task) { setSelectedTask(task); localStorage.removeItem('markus_nav_openTask'); }
  }, [board]);

  // Initial project selection from hash / localStorage (runs once on mount)
  useEffect(() => {
    const hashParts = window.location.hash.slice(1).split('/');
    if (hashParts[0] === 'projects' && hashParts[1]) {
      selectProject(hashParts[1]);
    } else {
      const navProjectId = localStorage.getItem('markus_nav_projectId');
      if (navProjectId) {
        localStorage.removeItem('markus_nav_projectId');
        selectProject(navProjectId);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hash change & custom navigation events
  useEffect(() => {
    const onHashChange = () => {
      const parts = window.location.hash.slice(1).split('/');
      if (parts[0] === 'projects' && parts[1]) {
        selectProject(parts[1]);
      } else if (parts[0] === 'projects') {
        selectAllTasks();
      }
    };

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      if (detail.page === 'tasks' || detail.page === 'projects') {
        if (detail.params?.openTask) {
          const allTasks = Object.values(boardRef.current).flat();
          const task = allTasks.find(t => t.id === detail.params!.openTask);
          if (task) setSelectedTask(task);
        }
        if (detail.params?.projectId) selectProject(detail.params.projectId);
        if (!detail.params?.projectId && !detail.params?.openTask) {
          selectAllTasks();
        }
      }
    };
    window.addEventListener('markus:navigate', handler);
    window.addEventListener('hashchange', onHashChange);
    return () => { window.removeEventListener('markus:navigate', handler); window.removeEventListener('hashchange', onHashChange); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Actions ──

  const selectProject = (projectId: string) => {
    if (projectFilterRef.current.size > 0) {
      savedProjectFilterRef.current = new Set(projectFilterRef.current);
    }
    setProjectFilter(new Set());
    setSelectedProjectId(projectId);
    setSelectedIterationId(null);
    setViewMode('project');
    setShowProjectSettings(false);
    history.replaceState(null, '', '#projects/' + projectId);
  };

  const selectAllTasks = () => {
    setProjectFilter(savedProjectFilterRef.current);
    setSelectedProjectId(null);
    setSelectedIterationId(null);
    setViewMode('all');
    setShowProjectSettings(false);
    history.replaceState(null, '', '#projects');
  };

  const handleCreateProject = async () => {
    if (!newProjName.trim()) return;
    try {
      const repos = newProjRepo.trim() ? [{ url: newProjRepo, defaultBranch: 'main' }] : [];
      await api.projects.create({ name: newProjName, description: newProjDesc, orgId: authUser?.orgId ?? 'default', repositories: repos } as Partial<ProjectInfo>);
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
    const reqId = taskRequirementId || undefined;
    try {
      await api.tasks.create(
        taskTitle, taskDesc, taskPriority,
        taskAutoAssign ? undefined : taskAssignTo || undefined,
        taskAutoAssign,
        projId,
        iterId,
        taskBlockedBy.length > 0 ? taskBlockedBy : undefined,
        reqId,
        taskType !== 'standard' ? taskType : undefined,
        taskType === 'scheduled' ? { every: taskScheduleEvery } : undefined,
      );
      setTaskTitle(''); setTaskDesc(''); setTaskBlockedBy([]); setTaskRequirementId(''); setTaskType('standard'); setTaskScheduleEvery('4h'); setShowCreateTask(false);
      refreshBoard();
    } catch (e) { msg(`Error creating task: ${e}`); }
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

  // ── Requirement actions ──

  const handleCreateReq = async () => {
    if (!reqTitle.trim()) return;
    if (!reqProjectId) { msg('Please select a project for this requirement'); return; }
    try {
      await api.requirements.create({ title: reqTitle, description: reqDesc, priority: reqPriority, projectId: reqProjectId });
      msg('Requirement created');
      setReqTitle(''); setReqDesc(''); setShowCreateReq(false);
      refreshRequirements();
    } catch (e) { msg(`Error: ${e}`); }
  };

  const handleApproveReq = async (id: string) => {
    try { await api.requirements.approve(id); msg('Requirement approved'); refreshRequirements(); refreshBoard(); } catch (e) { msg(`Error: ${e}`); }
  };

  const handleRejectReq = async () => {
    if (!rejectReqId) return;
    try { await api.requirements.reject(rejectReqId, rejectReason); msg('Requirement rejected'); setRejectReqId(null); setRejectReason(''); refreshRequirements(); } catch (e) { msg(`Error: ${e}`); }
  };

  const handleDeleteReq = async (id: string) => {
    try { await api.requirements.delete(id); msg('Requirement cancelled'); refreshRequirements(); } catch (e) { msg(`Error: ${e}`); }
  };

  // ── Drag handlers (tasks + requirements) ──

  const onDragStartTask = (e: DragEvent<HTMLDivElement>, task: TaskInfo) => {
    dragTaskRef.current = task; dragReqRef.current = null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `task:${task.id}`);
    (e.currentTarget as HTMLElement).style.opacity = '0.4';
  };
  const onDragStartReq = (e: DragEvent<HTMLDivElement>, req: RequirementInfo) => {
    dragReqRef.current = req; dragTaskRef.current = null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `req:${req.id}`);
    (e.currentTarget as HTMLElement).style.opacity = '0.4';
  };
  const onDragEnd = (e: DragEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
    dragTaskRef.current = null; dragReqRef.current = null; setDragOverCol(null);
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
    const req = dragReqRef.current;

    if (task) {
      const targetCol = BOARD_COLUMNS.find(c => c.id === colId);
      if (!targetCol) return;
      const targetStatus = targetCol.dropStatus;
      if (task.status === targetStatus) return;
      if (task.status === 'pending_approval') return;
      try { await api.tasks.updateStatus(task.id, targetStatus); refreshBoard(); } catch { /* */ }
    } else if (req) {
      const targetReqStatus = REQ_DROP_STATUS[colId];
      if (!targetReqStatus) return;
      if (req.status === targetReqStatus) return;
      try { await api.requirements.updateStatus(req.id, targetReqStatus); refreshRequirements(); } catch { /* */ }
    }
  };

  const toggleAgentFilter = (id: string) => {
    setAgentFilter(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleProjectFilter = (id: string) => {
    setProjectFilter(prev => {
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

  const filterTasks = (tasks: TaskInfo[], includeArchived = false) => {
    let result = tasks.filter(t => !t.parentTaskId && (showArchived || includeArchived || !isArchived(t)));
    if (viewMode === 'project' && selectedProjectId) {
      result = result.filter(t => t.projectId === selectedProjectId);
    }
    if (viewMode === 'project' && selectedIterationId) {
      result = result.filter(t => t.iterationId === selectedIterationId);
    }
    if (projectFilter.size > 0) result = result.filter(t => t.projectId && projectFilter.has(t.projectId));
    if (agentFilter.size > 0) result = result.filter(t => t.assignedAgentId && agentFilter.has(t.assignedAgentId));
    return result;
  };

  const getColumnTasks = (col: typeof BOARD_COLUMNS[number]) =>
    col.statuses.flatMap(s => filterTasks(board[s] ?? []));

  const filteredReqs = useMemo(() => {
    let list = allRequirements;
    if (viewMode === 'project' && selectedProjectId) list = list.filter(r => r.projectId === selectedProjectId);
    if (viewMode === 'project' && selectedIterationId) list = list.filter(r => r.iterationId === selectedIterationId);
    if (projectFilter.size > 0) list = list.filter(r => r.projectId && projectFilter.has(r.projectId));
    if (agentFilter.size > 0) list = list.filter(r => agentFilter.has(r.createdBy));
    return list;
  }, [allRequirements, viewMode, selectedProjectId, selectedIterationId, projectFilter, agentFilter]);

  const getColumnReqs = useCallback((col: typeof BOARD_COLUMNS[number]) =>
    filteredReqs.filter(r => REQ_COLUMN_MAP[r.status] === col.id), [filteredReqs]);

  const visibleColumns = BOARD_COLUMNS.filter(col => {
    if (col.id === 'closed') {
      const tasks = getColumnTasks(col);
      const reqs = getColumnReqs(col);
      return tasks.length + reqs.length > 0;
    }
    return true;
  });

  const archivedCount = Object.values(board).flat().filter(t => !t.parentTaskId && isArchived(t)).length;

  const sortedAgents = useMemo(() => {
    const terminal = new Set(['completed', 'failed', 'cancelled', 'archived']);
    const allTasks = Object.values(board).flat();
    const activeAgentIds = new Set<string>();
    for (const t of allTasks) {
      if (t.assignedAgentId && !terminal.has(t.status)) {
        if (!selectedProjectId || t.projectId === selectedProjectId) {
          activeAgentIds.add(t.assignedAgentId);
        }
      }
    }
    return [...agents].sort((a, b) => {
      const aActive = activeAgentIds.has(a.id) ? 0 : 1;
      const bActive = activeAgentIds.has(b.id) ? 0 : 1;
      return aActive - bActive;
    });
  }, [agents, board, selectedProjectId]);

  const sortedProjects = useMemo(() => {
    const terminal = new Set(['completed', 'failed', 'cancelled', 'archived']);
    const allTasks = Object.values(board).flat();
    const activeProjectIds = new Set<string>();
    for (const t of allTasks) {
      if (t.projectId && !terminal.has(t.status)) {
        activeProjectIds.add(t.projectId);
      }
    }
    return [...projects].sort((a, b) => {
      const aActive = activeProjectIds.has(a.id) ? 0 : 1;
      const bActive = activeProjectIds.has(b.id) ? 0 : 1;
      return aActive - bActive;
    });
  }, [projects, board]);

  // Count tasks per project — computed locally from existing board data
  const allTaskCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tasks of Object.values(board)) {
      for (const t of tasks) {
        if (t.parentTaskId) continue;
        const key = t.projectId ?? '__none__';
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }, [board]);

  const totalTaskCount = Object.values(allTaskCounts).reduce((a, b) => a + b, 0);

  // Active iteration for selected project
  const activeIteration = iterations.find(it => it.status === 'active');

  if (loading) return <div className="flex-1 flex items-center justify-center text-gray-500">Loading…</div>;

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* ── Task Board + Project Context ── */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Flash */}
        {flash && <div className="mx-6 mt-2 px-3 py-1.5 bg-emerald-900/50 text-emerald-300 text-xs rounded-lg">{flash}</div>}

        {/* Top bar */}
        <div className="flex items-center gap-3 px-6 h-14 border-b border-border-default bg-surface-secondary/80 shrink-0">
          {/* Project title + settings */}
          {selectedProject ? (
            <div className="flex items-center gap-1 shrink-0">
              <InlineEditableText
                value={selectedProject.name}
                onSave={async (name) => { await api.projects.update(selectedProject.id, { name } as Partial<ProjectInfo>); refreshProjects(); }}
                className="text-sm font-semibold text-gray-200"
              />
              <button
                onClick={() => setShowProjectSettings(!showProjectSettings)}
                className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors ${
                  showProjectSettings ? 'bg-surface-overlay text-gray-200' : 'text-gray-600 hover:text-gray-300 hover:bg-surface-elevated'
                }`}
                title="Project settings"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
              </button>
            </div>
          ) : (
            <h2 className="text-sm font-semibold text-gray-200 shrink-0">
              {projects.length === 1 ? projects[0].name : `${projects.length} Projects`}
            </h2>
          )}
          {archivedCount > 0 && (
            <button onClick={() => setShowArchived(v => !v)} className={`text-[10px] shrink-0 px-2 py-0.5 rounded-md transition-colors ${showArchived ? 'bg-surface-overlay text-gray-300' : 'text-gray-600 hover:text-gray-400'}`}>
              {showArchived ? `Hide ${archivedCount} archived` : `${archivedCount} archived`}
            </button>
          )}

          {/* View toggle */}
          <div className="flex items-center border border-border-default/60 rounded-md overflow-hidden shrink-0">
            {(['backlog', 'kanban', 'dag'] as const).map(v => (
              <button key={v} onClick={() => setBoardType(v)}
                className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${boardType === v ? 'bg-brand-600/25 text-brand-300' : 'text-gray-500 hover:text-gray-300 hover:bg-surface-elevated'}`}
              >{v === 'backlog' ? 'Backlog' : v === 'kanban' ? 'Kanban' : 'DAG'}</button>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={openCreateReq} className="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-xs rounded-lg font-medium transition-colors">+ Requirement</button>
            <button onClick={() => { setTaskProjectId(selectedProjectId ?? ''); setShowCreateTask(true); }} className="px-3 py-1.5 bg-surface-overlay/80 hover:bg-gray-600 text-gray-200 text-xs rounded-lg font-medium transition-colors">+ Task</button>
          </div>

          <div className="flex-1" />

          {/* Iteration (project view only) */}
          {viewMode === 'project' && selectedProject && (
            <>
              <select
                value={selectedIterationId ?? ''}
                onChange={e => setSelectedIterationId(e.target.value || null)}
                className="px-2 py-1 bg-surface-elevated/60 border border-border-default/60 rounded-md text-[11px] text-gray-400 focus:border-brand-500 outline-none shrink-0"
              >
                <option value="">All iterations</option>
                {iterations.map(it => (
                  <option key={it.id} value={it.id}>{it.name} ({it.status})</option>
                ))}
              </select>
              {activeIteration && !selectedIterationId && (
                <button onClick={() => setSelectedIterationId(activeIteration.id)}
                  className="flex items-center gap-1 text-[10px] text-brand-400/80 hover:text-brand-300 transition-colors shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse" />
                  {activeIteration.name}
                </button>
              )}
            </>
          )}
        </div>

        {/* Project filter bar — visible when not in single-project view */}
        {projects.length > 1 && !selectedProjectId && !showProjectSettings && (totalTaskCount > 0 || allRequirements.length > 0) && (
          <div className="px-6 py-1.5 border-b border-border-default/60 flex items-center gap-1.5 overflow-x-auto shrink-0">
            <button onClick={() => setProjectFilter(new Set())}
              className={`text-[10px] text-gray-500 hover:text-gray-300 px-2 py-1 rounded-md bg-surface-elevated/60 hover:bg-surface-overlay shrink-0 transition-all ${projectFilter.size > 0 ? 'visible opacity-100' : 'invisible opacity-0'}`}>Clear</button>
            {sortedProjects.map(p => {
              const selected = projectFilter.has(p.id);
              const count = allTaskCounts[p.id] ?? 0;
              return (
                <button key={p.id} onClick={() => toggleProjectFilter(p.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] shrink-0 transition-all ${
                    selected ? 'bg-violet-600/20 text-violet-300 ring-1 ring-violet-500/40' : 'text-gray-500 hover:bg-surface-elevated hover:text-gray-300'
                  }`}>
                  <span className={`w-4 h-4 rounded-sm flex items-center justify-center text-[9px] font-bold shrink-0 ${selected ? 'bg-violet-600 text-white' : 'bg-surface-overlay text-gray-400'}`}>{p.name[0]?.toUpperCase()}</span>
                  {p.name}
                  {count > 0 && <span className="text-[9px] text-gray-600 ml-0.5">{count}</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* Agent filter bar */}
        {agents.length > 0 && !showProjectSettings && (totalTaskCount > 0 || allRequirements.length > 0) && (
          <div className="px-6 py-1.5 border-b border-border-default/60 flex items-center gap-1.5 overflow-x-auto shrink-0">
            <button onClick={() => setAgentFilter(new Set())}
              className={`text-[10px] text-gray-500 hover:text-gray-300 px-2 py-1 rounded-md bg-surface-elevated/60 hover:bg-surface-overlay shrink-0 transition-all ${agentFilter.size > 0 ? 'visible opacity-100' : 'invisible opacity-0'}`}>Clear</button>
            {sortedAgents.map(a => {
              const selected = agentFilter.has(a.id);
              return (
                <button key={a.id} onClick={() => toggleAgentFilter(a.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] shrink-0 transition-all ${
                    selected ? 'bg-brand-600/20 text-brand-300 ring-1 ring-brand-500/40' : 'text-gray-500 hover:bg-surface-elevated hover:text-gray-300'
                  }`}>
                  <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${selected ? 'bg-brand-600 text-white' : 'bg-surface-overlay text-gray-400'}`}>{a.name[0]?.toUpperCase()}</span>
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
              tasks={Object.values(board).flat()}
              requirements={allRequirements}
              agents={agents}
              onIterationAction={handleIterStatus}
              onDeleteProject={() => handleDeleteProject(selectedProject.id)}
              onCreateIteration={handleCreateIteration}
              onUpdateProject={async (data) => { await api.projects.update(selectedProject.id, data); }}
              onRefresh={() => { refreshProjects(); }}
            />
          </div>
        ) : totalTaskCount === 0 && filteredReqs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="max-w-sm w-full text-center space-y-3">
              <div className="w-10 h-10 mx-auto rounded-lg bg-surface-elevated flex items-center justify-center">
                <span className="text-gray-500 text-lg">&#9744;</span>
              </div>
              <h3 className="text-sm font-medium text-gray-400">No items yet</h3>
              <p className="text-xs text-gray-600 leading-relaxed">
                Create a requirement to tell agents what you need.<br />
                Once approved, tasks will appear here automatically.
              </p>
              <button onClick={openCreateReq} className="text-xs text-brand-400 hover:text-brand-300 font-medium">
                + Create a requirement
              </button>
            </div>
          </div>
        ) : boardType === 'backlog' ? (
          <BacklogTable
            tasks={filterTasks(Object.values(board).flat())}
            requirements={filteredReqs}
            agents={agents}
            projects={projects}
            onTaskClick={task => setSelectedTask(task)}
            onReqClick={req => setSelectedReq(req)}
            onRefresh={() => { refreshBoard(); refreshRequirements(); }}
          />
        ) : boardType === 'dag' ? (
          <TaskDAG
            tasks={filterTasks(Object.values(board).flat(), true)}
            requirements={filteredReqs}
            agents={agents}
            onTaskClick={(task) => setSelectedTask(task)}
            onReqClick={(req) => setSelectedReq(req)}
            onDependencyChange={refreshBoard}
          />
        ) : (
          <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden p-6">
            <div className="flex gap-4 h-full">
              {visibleColumns.map(col => {
                const colTasks = getColumnTasks(col);
                const colReqs = getColumnReqs(col);
                const itemCount = colTasks.length + colReqs.length;
                const isOver = dragOverCol === col.id;
                return (
                  <div key={col.id}
                    className={`w-72 shrink-0 rounded-xl p-3.5 border-t-2 transition-colors flex flex-col h-full ${col.accent} ${isOver ? 'bg-surface-elevated/80 ring-1 ring-brand-500/40' : 'bg-surface-secondary'}`}
                    onDragOver={e => onDragOver(e, col.id)} onDragLeave={e => onDragLeave(e, col.id)} onDrop={e => void onDrop(e, col.id)}>
                    <div className="flex justify-between items-center mb-3 shrink-0">
                      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{col.label}</span>
                      <span className="text-xs bg-surface-elevated px-2 py-0.5 rounded-full">{itemCount}</span>
                    </div>
                    <div className="space-y-2 flex-1 min-h-0 overflow-y-auto scrollbar-thin">
                      {/* ── All cards merged & sorted by updatedAt ── */}
                      {(() => {
                        type CardItem = { kind: 'req'; data: RequirementInfo; time: number } | { kind: 'task'; data: TaskInfo; time: number };
                        const items: CardItem[] = [
                          ...colReqs.map(r => ({ kind: 'req' as const, data: r, time: new Date(r.updatedAt ?? r.createdAt).getTime() })),
                          ...colTasks.map(t => ({ kind: 'task' as const, data: t, time: new Date(t.updatedAt ?? t.createdAt ?? 0).getTime() })),
                        ];
                        items.sort((a, b) => b.time - a.time);
                        return items.map(item => {
                          if (item.kind === 'req') {
                            const req = item.data;
                        const badge = REQ_STATUS_BADGE[req.status] ?? { label: req.status, cls: 'bg-gray-500/15 text-gray-400' };
                        const isAgent = req.source === 'agent';
                        const needsReview = isAgent && (req.status === 'draft' || req.status === 'pending_review');
                        const reqProject = viewMode === 'all' && req.projectId ? projects.find(p => p.id === req.projectId) : null;
                        const creatorName = agents.find(a => a.id === req.createdBy)?.name ?? req.createdBy.slice(0, 10);
                        return (
                          <div key={`req-${req.id}`} role="button" tabIndex={0} draggable
                            onDragStart={e => onDragStartReq(e, req)} onDragEnd={onDragEnd}
                            onClick={() => setSelectedReq(req)} onKeyDown={e => e.key === 'Enter' && setSelectedReq(req)}
                            className={`bg-purple-500/[0.06] border rounded-lg p-3 border-l-[3px] border-l-purple-500 transition-colors cursor-grab active:cursor-grabbing ${needsReview ? 'border-yellow-500/40 ring-1 ring-yellow-500/20' : 'border-purple-500/20'} hover:border-purple-400/50`}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="text-[9px] font-bold text-purple-400 bg-purple-500/15 px-1.5 py-0.5 rounded shrink-0">REQ</span>
                                <span className="text-sm font-medium leading-snug truncate">{req.title}</span>
                              </div>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${badge.cls}`}>{badge.label}</span>
                            </div>
                            {req.description && <div className="text-xs text-gray-500 mt-1 line-clamp-2">{req.description}</div>}
                            {reqProject && (
                              <div className="mt-1.5">
                                <span className="text-[10px] px-1.5 py-0.5 bg-surface-overlay/60 text-gray-400 rounded truncate max-w-[120px]" title={reqProject.name}>{reqProject.name}</span>
                              </div>
                            )}
                            <div className="flex items-center justify-between mt-2">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs text-gray-600">{req.priority}</span>
                                <span className="text-[10px] text-gray-600">by {creatorName}</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                {req.taskIds.length > 0 && <span className="text-[10px] text-purple-400/60 bg-purple-500/10 px-1.5 py-0.5 rounded">{req.taskIds.length} tasks</span>}
                              </div>
                            </div>
                            {needsReview && (
                              <div className="flex items-center gap-2 mt-2 pt-2 border-t border-purple-500/10">
                                <button onClick={e => { e.stopPropagation(); handleApproveReq(req.id); }}
                                  className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] rounded-md font-medium transition-colors">Approve</button>
                                <button onClick={e => { e.stopPropagation(); setRejectReqId(req.id); }}
                                  className="px-2.5 py-1 border border-red-500/30 hover:bg-red-500/10 text-red-400 text-[10px] rounded-md font-medium transition-colors">Reject</button>
                              </div>
                            )}
                          </div>
                        );
                          } else {
                            const task = item.data;
                        const subCount = task.subtaskIds?.length ?? 0;
                        const badge = SUB_STATUS_BADGE[task.status];
                        const isApprovalTask = task.status === 'pending_approval';
                        const isSchedTask = task.taskType === 'scheduled' && !!task.scheduleConfig;
                        const schedLabel = isSchedTask ? (task.scheduleConfig!.every ? `Every ${task.scheduleConfig!.every}` : task.scheduleConfig!.cron ? `Cron` : 'Scheduled') : null;
                        const taskProjName = viewMode === 'all' && task.projectId ? projects.find(p => p.id === task.projectId)?.name : null;
                        const taskReqTitle = task.requirementId ? allRequirements.find(r => r.id === task.requirementId)?.title : null;
                        const taskCreatorName = task.createdBy ? (agents.find(a => a.id === task.createdBy)?.name ?? task.createdBy) : null;
                        return (
                          <div key={task.id} role="button" tabIndex={0} aria-label={task.title} draggable={!isApprovalTask}
                            onDragStart={e => !isApprovalTask && onDragStartTask(e, task)} onDragEnd={onDragEnd}
                            onClick={() => setSelectedTask(task)} onKeyDown={e => e.key === 'Enter' && setSelectedTask(task)}
                            className={`border rounded-lg p-3 border-l-[3px] transition-colors ${
                              isApprovalTask
                                ? 'bg-yellow-500/[0.04] border-yellow-500/30 border-l-yellow-500 cursor-pointer'
                                : isSchedTask
                                  ? `bg-cyan-500/[0.03] border-cyan-500/20 ${PRIORITY_COLORS[task.priority] ?? ''} hover:border-cyan-500/40 cursor-pointer`
                                  : `bg-surface-elevated border-border-default ${PRIORITY_COLORS[task.priority] ?? ''} hover:border-brand-500/50 cursor-grab active:cursor-grabbing`
                            }`}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                {isSchedTask && <span className="text-cyan-400 shrink-0" title={schedLabel ?? 'Scheduled'}><svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/></svg></span>}
                                <div className="text-sm font-medium leading-snug truncate">{task.title}</div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {isSchedTask && schedLabel && <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 whitespace-nowrap">{schedLabel}</span>}
                                {badge && <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>}
                              </div>
                            </div>
                            {task.description && <div className="text-xs text-gray-500 mt-1 line-clamp-2">{task.description}</div>}
                            {(taskProjName || taskReqTitle) && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {taskProjName && <span className="text-[10px] px-1.5 py-0.5 bg-surface-overlay/60 text-gray-400 rounded truncate max-w-[100px]" title={taskProjName}>{taskProjName}</span>}
                                {taskReqTitle && <span className="text-[10px] px-1.5 py-0.5 bg-brand-500/10 text-brand-400 rounded truncate max-w-[120px]" title={taskReqTitle}># {taskReqTitle}</span>}
                              </div>
                            )}
                            {task.blockedBy && task.blockedBy.length > 0 && (
                              <div className="mt-1.5 flex items-center gap-1">
                                <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/10 text-amber-400 rounded">⏳ {task.blockedBy.length} dep{task.blockedBy.length > 1 ? 's' : ''}</span>
                              </div>
                            )}
                            <div className="flex items-center justify-between mt-2">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs text-gray-600">{task.priority}</span>
                                {taskCreatorName && <span className="text-[10px] text-gray-600" title={`Created by ${taskCreatorName}`}>by {taskCreatorName}</span>}
                              </div>
                              <div className="flex items-center gap-2">
                                {subCount > 0 && <span className="text-[10px] text-gray-500 bg-surface-overlay/50 px-1.5 py-0.5 rounded">⋮ {subCount}</span>}
                                {task.notes && task.notes.length > 0 && <span className="text-[10px] text-gray-600">📝 {task.notes.length}</span>}
                                {task.assignedAgentId && (
                                  <span className="text-[10px] text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded flex items-center gap-1">
                                    <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[agents.find(a => a.id === task.assignedAgentId)?.status ?? ''] ?? 'bg-gray-500'}`} />
                                    {agents.find(a => a.id === task.assignedAgentId)?.name ?? task.assignedAgentId.slice(0, 8)}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                          }
                        });
                      })()}
                    </div>
                    {isOver && (
                      <div className="mt-2 border-2 border-dashed border-brand-500/30 rounded-lg h-12 flex items-center justify-center shrink-0">
                        <span className="text-xs text-brand-400/60">Drop here</span>
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
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[28rem] space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">New Project</h3>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Name</label>
              <input value={newProjName} onChange={e => setNewProjName(e.target.value)} placeholder="e.g. My App"
                className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-brand-500 outline-none" autoFocus />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Description</label>
              <textarea value={newProjDesc} onChange={e => setNewProjDesc(e.target.value)} placeholder="What is this project about? (optional)"
                className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-gray-200 h-20 resize-none focus:border-brand-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Repository URL</label>
              <input value={newProjRepo} onChange={e => setNewProjRepo(e.target.value)} placeholder="https://github.com/... (optional)"
                className="w-full bg-surface-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-brand-500 outline-none" />
            </div>
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => setShowCreateProject(false)} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated text-gray-300">Cancel</button>
              <button onClick={() => void handleCreateProject()} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 rounded-lg text-white">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Task Modal ── */}
      {showCreateTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCreateTask(false)}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[28rem] space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">New Task</h3>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Project</label>
              <select value={taskProjectId} onChange={e => setTaskProjectId(e.target.value)}
                className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none">
                <option value="">No Project</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Requirement</label>
              <select value={taskRequirementId} onChange={e => setTaskRequirementId(e.target.value)}
                className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none">
                <option value="">Select a requirement…</option>
                {allRequirements
                  .filter(r => r.status === 'approved' && (!taskProjectId || r.projectId === taskProjectId))
                  .map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Title</label>
              <input autoFocus value={taskTitle} onChange={e => setTaskTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void createTask(); }}
                className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Description</label>
              <textarea value={taskDesc} onChange={e => setTaskDesc(e.target.value)} rows={2}
                className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none resize-none" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Priority</label>
                <select value={taskPriority} onChange={e => setTaskPriority(e.target.value)}
                  className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none">
                  <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
                </select>
              </div>
              {!taskAutoAssign && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Assign to</label>
                  <select value={taskAssignTo} onChange={e => setTaskAssignTo(e.target.value)}
                    className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none">
                    <option value="">Unassigned</option>
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Task Type</label>
                <select value={taskType} onChange={e => setTaskType(e.target.value as 'standard' | 'scheduled')}
                  className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none">
                  <option value="standard">Standard</option>
                  <option value="scheduled">Scheduled (recurring)</option>
                </select>
              </div>
              {taskType === 'scheduled' && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Frequency</label>
                  <select value={taskScheduleEvery} onChange={e => setTaskScheduleEvery(e.target.value)}
                    className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none">
                    <option value="30m">Every 30 min</option>
                    <option value="1h">Every 1 hour</option>
                    <option value="2h">Every 2 hours</option>
                    <option value="4h">Every 4 hours</option>
                    <option value="8h">Every 8 hours</option>
                    <option value="12h">Every 12 hours</option>
                    <option value="1d">Every day</option>
                    <option value="1w">Every week</option>
                  </select>
                </div>
              )}
            </div>
            {/* Dependency selector */}
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Blocked By (dependencies)</label>
              <select
                value=""
                onChange={e => {
                  const id = e.target.value;
                  if (id && !taskBlockedBy.includes(id)) setTaskBlockedBy([...taskBlockedBy, id]);
                }}
                className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none">
                <option value="">Select a task to depend on…</option>
                {Object.values(board).flat()
                  .filter(t => !t.parentTaskId && t.status !== 'completed' && t.status !== 'cancelled' && !taskBlockedBy.includes(t.id))
                  .map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
              {taskBlockedBy.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {taskBlockedBy.map(id => {
                    const dep = Object.values(board).flat().find(t => t.id === id);
                    return (
                      <span key={id} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 bg-amber-500/10 text-amber-300 rounded-full">
                        ⏳ {dep ? dep.title.slice(0, 30) : id.slice(-8)}
                        <button onClick={() => setTaskBlockedBy(taskBlockedBy.filter(x => x !== id))} className="ml-0.5 text-amber-400/60 hover:text-amber-300">×</button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
              <input type="checkbox" checked={taskAutoAssign} onChange={e => setTaskAutoAssign(e.target.checked)} className="rounded bg-surface-elevated border-border-default" />
              Auto-assign to best available agent
            </label>
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => setShowCreateTask(false)} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated text-gray-300">Cancel</button>
              <button onClick={() => void createTask()} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 rounded-lg text-white">Create</button>
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
          allTasks={Object.values(board).flat()}
          onClose={() => setSelectedTask(null)}
          onRefresh={handleTaskRefresh}
          authUser={authUser}
        />
      )}

      {/* ── Create Requirement Modal ── */}
      {showCreateReq && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { setShowCreateReq(false); setReqTitle(''); setReqDesc(''); }}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[28rem] space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">New Requirement</h3>
            <p className="text-xs text-gray-500 -mt-2">Describe what you need. Agents will break approved requirements into tasks.</p>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Project</label>
              <select value={reqProjectId} onChange={e => setReqProjectId(e.target.value)}
                className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-gray-200 focus:border-brand-500 outline-none">
                <option value="">Select a project…</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Title</label>
              <input value={reqTitle} onChange={e => setReqTitle(e.target.value)} placeholder="e.g. Add user authentication"
                className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-gray-200 focus:border-brand-500 outline-none" autoFocus
                onKeyDown={e => { if (e.key === 'Enter' && reqTitle.trim()) void handleCreateReq(); }} />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Description</label>
              <textarea value={reqDesc} onChange={e => setReqDesc(e.target.value)} placeholder="What is needed and why..."
                rows={3} className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-gray-200 focus:border-brand-500 outline-none resize-none" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Priority</label>
              <select value={reqPriority} onChange={e => setReqPriority(e.target.value)}
                className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-gray-200 focus:border-brand-500 outline-none">
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
              </select>
            </div>
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => { setShowCreateReq(false); setReqTitle(''); setReqDesc(''); }} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated text-gray-300">Cancel</button>
              <button onClick={() => void handleCreateReq()} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 rounded-lg text-white">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reject Requirement Modal ── */}
      {rejectReqId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setRejectReqId(null)}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 w-96 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">Reject Requirement</h3>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Reason</label>
              <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="Why is this being rejected..."
                rows={3} className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-gray-200 focus:border-red-500 outline-none resize-none" autoFocus />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setRejectReqId(null)} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated text-gray-300">Cancel</button>
              <button onClick={() => void handleRejectReq()} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 rounded-lg text-white">Reject</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Requirement Detail Modal ── */}
      {selectedReq && (
        <RequirementDetailModal
          req={selectedReq}
          agents={agents}
          projects={projects}
          allTasks={Object.values(board).flat()}
          onClose={() => setSelectedReq(null)}
          onApprove={id => { handleApproveReq(id); setSelectedReq(null); }}
          onReject={id => { setRejectReqId(id); setSelectedReq(null); }}
          onCancel={id => { handleDeleteReq(id); setSelectedReq(null); }}
        />
      )}
    </div>
  );
}

// ─── Requirement Detail Modal ────────────────────────────────────────────────────

function RequirementDetailModal({
  req, agents, projects, allTasks, onClose, onApprove, onReject, onCancel,
}: {
  req: RequirementInfo;
  agents: AgentInfo[];
  projects: ProjectInfo[];
  allTasks: TaskInfo[];
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const badge = REQ_STATUS_BADGE[req.status] ?? { label: req.status, cls: 'bg-gray-500/15 text-gray-400' };
  const isAgent = req.source === 'agent';
  const needsReview = isAgent && (req.status === 'draft' || req.status === 'pending_review');
  const canCancel = req.status === 'draft' || req.status === 'approved';
  const reqProject = req.projectId ? projects.find(p => p.id === req.projectId) : null;
  const creatorAgent = agents.find(a => a.id === req.createdBy);
  const linkedTasks = allTasks.filter(t => req.taskIds.includes(t.id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-surface-secondary border border-border-default rounded-xl w-[36rem] max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between gap-4 p-5 pb-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-bold text-purple-400 bg-purple-500/15 px-2 py-0.5 rounded">REQ</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${badge.cls}`}>{badge.label}</span>
              {req.priority === 'high' || req.priority === 'urgent' ? (
                <span className={`text-[10px] font-medium ${req.priority === 'urgent' ? 'text-red-400' : 'text-orange-400'}`}>{req.priority}</span>
              ) : (
                <span className="text-[10px] text-gray-500">{req.priority}</span>
              )}
            </div>
            <h2 className="text-lg font-semibold text-white leading-snug">{req.title}</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none shrink-0 mt-1">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {req.description && (
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1 block">Description</label>
              <MarkdownMessage content={req.description} className="text-sm text-gray-300 leading-relaxed" />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="bg-surface-elevated/60 rounded-lg p-2.5">
              <span className="text-[10px] text-gray-500 block mb-1">Created by</span>
              <span className="text-gray-300">{creatorAgent?.name ?? req.createdBy.slice(0, 12)}</span>
              {isAgent && <span className="text-[10px] text-purple-400 ml-1.5">(Agent)</span>}
            </div>
            <div className="bg-surface-elevated/60 rounded-lg p-2.5">
              <span className="text-[10px] text-gray-500 block mb-1">Created</span>
              <span className="text-gray-300">{new Date(req.createdAt).toLocaleString()}</span>
            </div>
            {reqProject && (
              <div className="bg-surface-elevated/60 rounded-lg p-2.5">
                <span className="text-[10px] text-gray-500 block mb-1">Project</span>
                <span className="text-gray-300">{reqProject.name}</span>
              </div>
            )}
            {req.approvedBy && (
              <div className="bg-surface-elevated/60 rounded-lg p-2.5">
                <span className="text-[10px] text-gray-500 block mb-1">Approved by</span>
                <span className="text-gray-300"><AgentNameLink agentId={req.approvedBy} agents={agents} /></span>
                {req.approvedAt && <span className="text-[10px] text-gray-500 ml-1">{new Date(req.approvedAt).toLocaleDateString()}</span>}
              </div>
            )}
          </div>

          {req.rejectedReason && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <span className="text-[10px] font-semibold text-red-400 uppercase tracking-wider block mb-1">Rejection Reason</span>
              <p className="text-sm text-red-300/80">{req.rejectedReason}</p>
            </div>
          )}

          {req.tags && req.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {req.tags.map(tag => <span key={tag} className="text-[10px] bg-surface-elevated text-gray-400 px-2 py-0.5 rounded-full">#{tag}</span>)}
            </div>
          )}

          {linkedTasks.length > 0 && (
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2 block">Linked Tasks ({linkedTasks.length})</label>
              <div className="space-y-1.5">
                {linkedTasks.map(t => {
                  const sb = SUB_STATUS_BADGE[t.status];
                  return (
                    <div key={t.id} className="flex items-center gap-2 bg-surface-elevated/60 rounded-lg px-3 py-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_COLORS[t.priority]?.replace('border-l-', 'bg-') ?? 'bg-gray-500'}`} />
                      <span className="text-xs text-gray-300 flex-1 truncate">{t.title}</span>
                      {sb && <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${sb.cls}`}>{sb.label}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        {(needsReview || canCancel) && (
          <div className="flex items-center gap-2 p-5 pt-3 border-t border-border-default">
            {needsReview && (
              <>
                <button onClick={() => onApprove(req.id)} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg font-medium transition-colors">Approve</button>
                <button onClick={() => onReject(req.id)} className="px-4 py-2 border border-red-500/30 hover:bg-red-500/10 text-red-400 text-sm rounded-lg font-medium transition-colors">Reject</button>
              </>
            )}
            {canCancel && !needsReview && (
              <button onClick={() => onCancel(req.id)} className="px-4 py-2 text-gray-500 hover:text-red-400 text-sm transition-colors">Cancel Requirement</button>
            )}
            <div className="flex-1" />
            <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated text-gray-300">Close</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Shared mini-components ─────────────────────────────────────────────────────

function IterModelBadge({ model }: { model: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
      model === 'scrum' ? 'bg-brand-900/40 text-brand-300' : 'bg-surface-overlay text-gray-400'
    }`}>{model}</span>
  );
}

function StatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-emerald-900/40 text-emerald-400', planning: 'bg-blue-900/40 text-blue-400',
    review: 'bg-amber-900/40 text-amber-400', completed: 'bg-surface-overlay text-gray-400',
    archived: 'bg-surface-elevated text-gray-500', paused: 'bg-orange-900/40 text-orange-400',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[status] ?? 'bg-surface-overlay text-gray-400'}`}>{status}</span>
  );
}
