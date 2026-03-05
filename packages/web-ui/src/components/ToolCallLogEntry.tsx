import { useState, useRef, useEffect } from 'react';
import type { TaskLogEntry } from '../api.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';

const TOOL_LABELS: Record<string, string> = {
  shell_execute: 'Shell',
  file_read: 'Read File',
  file_write: 'Write File',
  file_edit: 'Edit File',
  file_list: 'List Files',
  web_fetch: 'Fetch URL',
  web_search: 'Web Search',
  code_search: 'Code Search',
  create_subtask: 'Create Subtask',
  create_task: 'Create Task',
  task_create: 'Create Task',
  update_task: 'Update Task',
  task_update: 'Update Task',
  add_task_note: 'Add Note',
  task_add_note: 'Add Note',
  task_list: 'List Tasks',
  git_status: 'Git Status',
  git_diff: 'Git Diff',
  git_log: 'Git Log',
  git_branch: 'Git Branch',
  git_add: 'Git Add',
  git_commit: 'Git Commit',
  browser_navigate: 'Open Page',
  browser_click: 'Click',
  browser_type: 'Type Text',
  browser_screenshot: 'Screenshot',
  browser_extract: 'Extract Content',
  agent_send_message: 'Send Message',
  agent_list: 'List Agents',
  feishu_send_message: 'Feishu Message',
  feishu_search_docs: 'Feishu Search',
};

function toolLabel(name: string) {
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(s: string, len: number): string {
  if (s.length <= len) return s;
  return s.slice(0, len) + '…';
}

function formatArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}: ${truncate(val, 60)}`);
  }
  return parts.join(', ');
}

function formatArgsForDetail(args: unknown): Array<{ key: string; value: string }> {
  if (!args || typeof args !== 'object') return [];
  const obj = args as Record<string, unknown>;
  return Object.entries(obj)
    .filter(([, v]) => v != null)
    .map(([k, v]) => ({
      key: k,
      value: typeof v === 'string' ? v : JSON.stringify(v, null, 2),
    }));
}

// ─── Hover Tooltip ───────────────────────────────────────────────────────────

function Tooltip({ entry, anchorRef }: { entry: TaskLogEntry; anchorRef: React.RefObject<HTMLElement | null> }) {
  const meta = entry.metadata as Record<string, unknown> | undefined;
  const args = meta?.arguments;
  const result = meta?.result as string | undefined;
  const error = meta?.error as string | undefined;
  const duration = meta?.durationMs as number | undefined;
  const success = meta?.success !== false;

  const [position, setPosition] = useState<'above' | 'below'>('above');
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPosition(rect.top > 200 ? 'above' : 'below');
    }
  }, [anchorRef]);

  const argSummary = formatArgs(args);

  return (
    <div
      ref={tooltipRef}
      className={`absolute z-50 left-0 ${position === 'above' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'} w-80 max-w-[90vw] bg-gray-900 border border-gray-700 rounded-lg shadow-xl text-xs pointer-events-none`}
    >
      <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
        <span className="font-medium text-gray-200">{toolLabel(entry.content)}</span>
        <div className="flex items-center gap-2">
          {duration != null && <span className="text-gray-500">{formatDuration(duration)}</span>}
          <span className={success ? 'text-green-400' : 'text-red-400'}>{success ? '✓ ok' : '✗ failed'}</span>
        </div>
      </div>
      {argSummary && (
        <div className="px-3 py-1.5 border-b border-gray-800">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Arguments</div>
          <div className="text-gray-400 font-mono text-[11px] break-all line-clamp-3">{argSummary}</div>
        </div>
      )}
      {result && (
        <div className="px-3 py-1.5">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Result</div>
          <div className="text-gray-400 font-mono text-[11px] break-all line-clamp-3">{truncate(result, 300)}</div>
        </div>
      )}
      {error && (
        <div className="px-3 py-1.5">
          <div className="text-[10px] text-red-500 uppercase tracking-wider mb-0.5">Error</div>
          <div className="text-red-400 font-mono text-[11px] break-all line-clamp-3">{truncate(String(error), 300)}</div>
        </div>
      )}
      {!argSummary && !result && !error && (
        <div className="px-3 py-1.5 text-gray-600 italic">No details recorded</div>
      )}
      <div className="px-3 py-1 border-t border-gray-800 text-[10px] text-gray-600">Click to expand full details</div>
    </div>
  );
}

// ─── Detail Modal ────────────────────────────────────────────────────────────

function DetailModal({ entry, onClose }: { entry: TaskLogEntry; onClose: () => void }) {
  const meta = entry.metadata as Record<string, unknown> | undefined;
  const args = meta?.arguments;
  const result = meta?.result as string | undefined;
  const error = meta?.error as string | undefined;
  const duration = meta?.durationMs as number | undefined;
  const success = meta?.success !== false;

  const argEntries = formatArgsForDetail(args);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[560px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-semibold ${success ? 'text-gray-100' : 'text-red-300'}`}>
              {toolLabel(entry.content)}
            </span>
            <span className={`text-xs px-1.5 py-0.5 rounded ${success ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
              {success ? 'Success' : 'Failed'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {duration != null && <span className="text-xs text-gray-500">{formatDuration(duration)}</span>}
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Arguments */}
          {argEntries.length > 0 && (
            <div>
              <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Arguments</h4>
              <div className="space-y-2">
                {argEntries.map(({ key, value }) => (
                  <div key={key}>
                    <div className="text-[11px] text-indigo-400 font-medium mb-0.5">{key}</div>
                    <pre className="text-xs text-gray-300 bg-gray-800/70 rounded-lg px-3 py-2 overflow-x-auto max-h-40 whitespace-pre-wrap break-all font-mono">{value}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Result */}
          {result && (
            <div>
              <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Result</h4>
              <pre className="text-xs text-gray-300 bg-gray-800/70 rounded-lg px-3 py-2 overflow-x-auto max-h-60 whitespace-pre-wrap break-all font-mono">{result}</pre>
            </div>
          )}

          {/* Error */}
          {error && (
            <div>
              <h4 className="text-[10px] font-semibold text-red-500 uppercase tracking-wider mb-2">Error</h4>
              <pre className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 overflow-x-auto max-h-40 whitespace-pre-wrap break-all font-mono">{String(error)}</pre>
            </div>
          )}

          {!argEntries.length && !result && !error && (
            <div className="text-sm text-gray-600 italic py-4 text-center">No detailed data recorded for this tool call.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Exported Components ─────────────────────────────────────────────────────

/**
 * Compact tool_start row with spinner.
 */
export function ToolStartRow({ entry }: { entry: TaskLogEntry }) {
  const meta = entry.metadata as Record<string, unknown> | undefined;
  const argSummary = formatArgs(meta?.arguments);

  return (
    <div className="flex items-center gap-2 py-1 px-1 group">
      <svg className="w-3 h-3 text-indigo-400 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" strokeLinecap="round" />
      </svg>
      <span className="text-xs text-indigo-300 font-medium">{toolLabel(entry.content)}</span>
      {argSummary && <span className="text-xs text-gray-600 truncate max-w-[200px]" title={argSummary}>{argSummary}</span>}
      <span className="text-xs text-gray-600">calling…</span>
    </div>
  );
}

/**
 * Compact tool_end row with hover tooltip and click-to-expand detail modal.
 */
export function ToolEndRow({ entry }: { entry: TaskLogEntry }) {
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const meta = entry.metadata as Record<string, unknown> | undefined;
  const success = meta?.success !== false;
  const duration = meta?.durationMs as number | undefined;
  const argSummary = formatArgs(meta?.arguments);

  return (
    <>
      <div
        ref={rowRef}
        className="relative flex items-center gap-2 py-0.5 px-1 cursor-pointer rounded hover:bg-gray-800/40 transition-colors group"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => setExpanded(true)}
      >
        <span className={`text-xs ${success ? 'text-green-400' : 'text-red-400'}`}>{success ? '✓' : '✗'}</span>
        <span className={`text-xs font-medium ${success ? 'text-green-300' : 'text-red-300'}`}>{toolLabel(entry.content)}</span>
        {duration != null && <span className="text-[10px] text-gray-600">{formatDuration(duration)}</span>}
        {argSummary && <span className="text-[10px] text-gray-600 truncate max-w-[180px] hidden group-hover:inline" title={argSummary}>{argSummary}</span>}
        {!success && meta?.error && (
          <span className="text-xs text-red-400 truncate max-w-[200px]">{truncate(String(meta.error), 60)}</span>
        )}
        {hovered && <Tooltip entry={entry} anchorRef={rowRef} />}
      </div>
      {expanded && <DetailModal entry={entry} onClose={() => setExpanded(false)} />}
    </>
  );
}

/**
 * Renders any TaskLogEntry — auto-selects the right component for its type.
 * Drop-in replacement for all the inline renderLogEntry / LogEntry / LogEntryRow functions.
 */
export function LogEntryRow({ entry }: { entry: TaskLogEntry }) {
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
      <div className="bg-gray-800/50 rounded-lg px-3 py-2.5 my-1">
        <MarkdownMessage content={entry.content} className="text-sm text-gray-300" />
      </div>
    );
  }
  if (entry.type === 'tool_start') {
    return <ToolStartRow entry={entry} />;
  }
  if (entry.type === 'tool_end') {
    return <ToolEndRow entry={entry} />;
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
