/**
 * Unified Execution Timeline — shared rendering for agent tool calls,
 * text output, status changes, and errors across all views:
 * - Chat message segments
 * - Task execution logs
 * - Agent activity modal (heartbeats, chat responses)
 * - Agent profile task logs
 * - Team busy-agent modal
 */
import { useState, useRef, useEffect, useCallback, memo, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { TaskLogEntry, AgentActivityLogEntry } from '../api.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';

// ─── Shared Types ─────────────────────────────────────────────────────────────

export interface ToolCallInfo {
  tool: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  args?: unknown;
  result?: string;
  error?: string;
  durationMs?: number;
  liveOutput?: string;
}

export type ExecEntry =
  | { type: 'text'; content: string; time?: string; timestamp?: string }
  | { type: 'tool'; info: ToolCallInfo; time?: string; key?: string; timestamp?: string }
  | { type: 'status'; content: string; time?: string; timestamp?: string }
  | { type: 'error'; content: string; time?: string; timestamp?: string };

// ─── Tool Metadata ────────────────────────────────────────────────────────────

const TOOL_META: Record<string, { label: string; icon: string }> = {
  shell_execute:        { label: 'Running command',        icon: '⌨' },
  file_read:            { label: 'Reading file',           icon: '📄' },
  file_write:           { label: 'Writing file',           icon: '✏' },
  file_edit:            { label: 'Editing file',           icon: '✏' },
  file_list:            { label: 'Listing files',          icon: '📂' },
  web_fetch:            { label: 'Fetching page',          icon: '🌐' },
  web_search:           { label: 'Searching web',          icon: '🔍' },
  web_extract:          { label: 'Extracting content',     icon: '📑' },
  create_task:          { label: 'Creating task',          icon: '📌' },
  task_create:          { label: 'Creating task',          icon: '📌' },
  create_subtask:       { label: 'Adding subtask',         icon: '📌' },
  update_task:          { label: 'Updating task',          icon: '✅' },
  task_update:          { label: 'Updating task',          icon: '✅' },
  add_task_note:        { label: 'Adding note',            icon: '📝' },
  task_add_note:        { label: 'Adding note',            icon: '📝' },
  task_list:            { label: 'Listing tasks',          icon: '📋' },
  git_status:           { label: 'Git status',             icon: '🔀' },
  git_diff:             { label: 'Git diff',               icon: '🔀' },
  git_log:              { label: 'Git log',                icon: '📜' },
  git_branch:           { label: 'Git branch',             icon: '🌿' },
  git_add:              { label: 'Git add',                icon: '➕' },
  git_commit:           { label: 'Git commit',             icon: '💾' },
  code_search:          { label: 'Searching code',         icon: '🔍' },
  project_structure:    { label: 'Project structure',      icon: '🗂' },
  code_stats:           { label: 'Code stats',             icon: '📊' },
  browser_navigate:     { label: 'Opening page',           icon: '🌐' },
  browser_click:        { label: 'Clicking element',       icon: '👆' },
  browser_type:         { label: 'Typing text',            icon: '⌨' },
  browser_screenshot:   { label: 'Screenshot',             icon: '📸' },
  browser_extract:      { label: 'Extracting content',     icon: '📋' },
  browser_evaluate:     { label: 'Running script',         icon: '⚙' },
  agent_send_message:   { label: 'Messaging colleague',    icon: '💬' },
  agent_list:           { label: 'Checking team',          icon: '👥' },
  memory_save:          { label: 'Saving memory',          icon: '💾' },
  memory_search:        { label: 'Searching memory',       icon: '🔍' },
  feishu_send_message:  { label: 'Sending Feishu msg',     icon: '✉' },
  feishu_search_docs:   { label: 'Searching Feishu',       icon: '🔍' },
};

export function getToolMeta(tool: string): { label: string; icon: string } {
  return TOOL_META[tool] ?? {
    label: tool.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    icon: '⚙',
  };
}

/** Extract the shell command text from tool args, if applicable */
function getShellCommand(info: ToolCallInfo): string | null {
  if (info.tool !== 'shell_execute' || !info.args || typeof info.args !== 'object') return null;
  const cmd = (info.args as Record<string, unknown>).command;
  return typeof cmd === 'string' ? cmd : null;
}

// ─── Format Helpers ───────────────────────────────────────────────────────────

export function formatDuration(ms: number | undefined): string {
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.slice(0, len) + '…';
}

function prettyJson(s: string): string {
  try {
    const parsed = JSON.parse(s);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return s;
  }
}

function formatArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}: ${truncate(val, 120)}`);
  }
  return parts.join(', ');
}

function formatArgsDetail(args: unknown): Array<{ key: string; value: string }> {
  if (!args || typeof args !== 'object') return [];
  const obj = args as Record<string, unknown>;
  return Object.entries(obj)
    .filter(([, v]) => v != null)
    .map(([k, v]) => ({ key: k, value: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }));
}

// ─── Conversion: TaskLogEntry → ExecEntry ─────────────────────────────────────

export function taskLogToEntry(entry: TaskLogEntry): ExecEntry | null {
  const time = new Date(entry.createdAt).toLocaleTimeString();
  const ts = entry.createdAt;
  const meta = entry.metadata as Record<string, unknown> | undefined;
  switch (entry.type) {
    case 'text':
      return { type: 'text', content: entry.content, time, timestamp: ts };
    case 'status':
      return { type: 'status', content: entry.content, time, timestamp: ts };
    case 'error':
      return { type: 'error', content: entry.content, time, timestamp: ts };
    case 'tool_start':
      return {
        type: 'tool', time, timestamp: ts,
        key: `ts_${entry.seq}`,
        info: { tool: entry.content, status: 'running', args: meta?.arguments },
      };
    case 'tool_end':
      return {
        type: 'tool', time, timestamp: ts,
        key: `te_${entry.seq}`,
        info: {
          tool: entry.content,
          status: meta?.success === false ? 'error' : 'done',
          args: meta?.arguments,
          result: meta?.result as string | undefined,
          error: meta?.error as string | undefined,
          durationMs: meta?.durationMs as number | undefined,
        },
      };
    default:
      return null;
  }
}

// ─── Conversion: AgentActivityLogEntry → ExecEntry ────────────────────────────

export function activityLogToEntry(entry: AgentActivityLogEntry): ExecEntry | null {
  const time = new Date(entry.createdAt).toLocaleTimeString();
  const meta = entry.metadata as Record<string, unknown> | undefined;
  switch (entry.type) {
    case 'text':
      return { type: 'text', content: entry.content, time };
    case 'status':
      return { type: 'status', content: entry.content, time };
    case 'error':
      return { type: 'error', content: entry.content, time };
    case 'tool_start':
      return {
        type: 'tool', time,
        key: `as_${entry.seq}`,
        info: { tool: entry.content, status: 'running', args: meta?.arguments ?? meta?.args },
      };
    case 'tool_end':
      return {
        type: 'tool', time,
        key: `ae_${entry.seq}`,
        info: {
          tool: entry.content,
          status: meta?.success === false ? 'error' : 'done',
          args: meta?.arguments,
          result: (meta?.result ?? meta?.preview) as string | undefined,
          error: meta?.error as string | undefined,
          durationMs: meta?.durationMs as number | undefined,
        },
      };
    default:
      return null;
  }
}

// ─── Filter: remove tool_start entries that have a matching tool_end ──────────

export function filterCompletedStarts(entries: ExecEntry[]): ExecEntry[] {
  const matchedIndices = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.type === 'tool' && (e.info.status === 'done' || e.info.status === 'error')) {
      for (let j = i - 1; j >= 0; j--) {
        const p = entries[j]!;
        if (p.type === 'tool' && p.info.status === 'running' && p.info.tool === e.info.tool && !matchedIndices.has(j)) {
          matchedIndices.add(j);
          break;
        }
      }
    }
  }
  return entries.filter((_, i) => !matchedIndices.has(i));
}

// ─── ThinkingDots ─────────────────────────────────────────────────────────────

export function ThinkingDots({ label = 'Thinking' }: { label?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-400 py-0.5">
      <span>{label}</span>
      <span className="flex gap-0.5">
        {[0, 150, 300].map(d => (
          <span key={d} className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce"
            style={{ animationDelay: `${d}ms`, animationDuration: '1s' }} />
        ))}
      </span>
    </div>
  );
}

// ─── StreamingText ────────────────────────────────────────────────────────────

export function StreamingText({ content, className }: { content: string; className?: string }) {
  return (
    <div className="bg-gray-800/50 rounded-lg px-3 py-2.5 my-1">
      <MarkdownMessage content={content} className={className ?? 'text-sm text-gray-300'} />
      <span className="inline-block w-0.5 h-4 bg-indigo-400 animate-pulse ml-0.5 align-middle" />
    </div>
  );
}

// ─── Tool Tooltip ─────────────────────────────────────────────────────────────

function ToolTooltip({ info, anchorRef, onHover }: { info: ToolCallInfo; anchorRef: RefObject<HTMLElement | null>; onHover: (v: boolean) => void }) {
  const [pos, setPos] = useState<{ top: number; left: number; direction: 'above' | 'below' } | null>(null);

  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      const above = rect.top > 240;
      setPos({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)),
        top: above ? rect.top - 6 : rect.bottom + 6,
        direction: above ? 'above' : 'below',
      });
    }
  }, [anchorRef]);

  if (!pos) return null;

  const argSummary = formatArgs(info.args);
  const success = info.status !== 'error';
  const meta = getToolMeta(info.tool);

  const style: React.CSSProperties = {
    position: 'fixed',
    left: pos.left,
    ...(pos.direction === 'above' ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
    zIndex: 9999,
  };

  return createPortal(
    <div
      style={style}
      className="w-96 max-w-[90vw] max-h-[60vh] bg-gray-900 border border-gray-700 rounded-lg shadow-xl text-xs flex flex-col"
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between shrink-0">
        <span className="font-medium text-gray-200">{meta.label}</span>
        <div className="flex items-center gap-2">
          {info.durationMs != null && <span className="text-gray-500">{formatDuration(info.durationMs)}</span>}
          <span className={success ? 'text-green-400' : 'text-red-400'}>{success ? '✓ ok' : '✗ failed'}</span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {argSummary && (
          <div className="px-3 py-1.5 border-b border-gray-800">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Arguments</div>
            <div className="text-gray-400 font-mono text-[11px] break-all">{argSummary}</div>
          </div>
        )}
        {info.result && (
          <div className="px-3 py-1.5">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Result</div>
            <div className="text-gray-400 font-mono text-[11px] break-all whitespace-pre-wrap">{prettyJson(info.result)}</div>
          </div>
        )}
        {info.error && (
          <div className="px-3 py-1.5">
            <div className="text-[10px] text-red-500 uppercase tracking-wider mb-0.5">Error</div>
            <div className="text-red-400 font-mono text-[11px] break-all whitespace-pre-wrap">{prettyJson(String(info.error))}</div>
          </div>
        )}
        {!argSummary && !info.result && !info.error && (
          <div className="px-3 py-1.5 text-gray-600 italic">No details recorded</div>
        )}
      </div>
      <div className="px-3 py-1 border-t border-gray-800 text-[10px] text-gray-600 shrink-0">Click to expand full details</div>
    </div>,
    document.body,
  );
}

// ─── Tool Detail Modal ────────────────────────────────────────────────────────

function ToolDetailModal({ info, onClose }: { info: ToolCallInfo; onClose: () => void }) {
  const meta = getToolMeta(info.tool);
  const argEntries = formatArgsDetail(info.args);
  const success = info.status !== 'error';

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[560px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <span className="opacity-60 text-sm">{meta.icon}</span>
            <span className={`text-sm font-semibold ${success ? 'text-gray-100' : 'text-red-300'}`}>{meta.label}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded ${success ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
              {success ? 'Success' : 'Failed'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {info.durationMs != null && <span className="text-xs text-gray-500">{formatDuration(info.durationMs)}</span>}
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
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
          {info.result && (
            <div>
              <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Result</h4>
              <pre className="text-xs text-gray-300 bg-gray-800/70 rounded-lg px-3 py-2 overflow-x-auto max-h-60 whitespace-pre-wrap break-all font-mono">{prettyJson(info.result)}</pre>
            </div>
          )}
          {info.error && (
            <div>
              <h4 className="text-[10px] font-semibold text-red-500 uppercase tracking-wider mb-2">Error</h4>
              <pre className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 overflow-x-auto max-h-40 whitespace-pre-wrap break-all font-mono">{prettyJson(String(info.error))}</pre>
            </div>
          )}
          {!argEntries.length && !info.result && !info.error && (
            <div className="text-sm text-gray-600 italic py-4 text-center">No detailed data recorded for this tool call.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── ToolCallRow — unified rendering for a single tool call ───────────────────

export function ToolCallRow({ info, showTime, time, isLast }: {
  info: ToolCallInfo;
  showTime?: boolean;
  time?: string;
  isLast?: boolean;
}) {
  const meta = getToolMeta(info.tool);
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout>>();
  const isDone = info.status !== 'running';
  const isStopped = info.status === 'stopped';

  const handleHover = useCallback((v: boolean) => {
    clearTimeout(hoverTimeout.current);
    if (v) {
      hoverTimeout.current = setTimeout(() => setHovered(true), 200);
    } else {
      hoverTimeout.current = setTimeout(() => setHovered(false), 150);
    }
  }, []);

  useEffect(() => () => clearTimeout(hoverTimeout.current), []);

  const shellCmd = getShellCommand(info);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [info.liveOutput]);

  return (
    <>
      <div
        ref={rowRef}
        className={`relative flex items-start gap-2 py-0.5 ${!isLast ? 'border-b border-gray-700/30 pb-1.5 mb-0.5' : ''} ${isDone ? 'cursor-pointer rounded hover:bg-gray-800/30 transition-colors' : ''}`}
        onMouseEnter={() => isDone && handleHover(true)}
        onMouseLeave={() => handleHover(false)}
        onClick={() => isDone && setExpanded(true)}
      >
        {showTime && time && (
          <span className="text-[10px] text-gray-600 shrink-0 w-16 text-right tabular-nums mt-0.5">{time}</span>
        )}
        <div className="flex flex-col items-center shrink-0 mt-0.5" style={{ width: 14 }}>
          <div className={`w-3 h-3 rounded-full border flex items-center justify-center text-[8px] shrink-0 ${
            info.status === 'running' ? 'border-indigo-500 bg-indigo-950 animate-pulse'
            : info.status === 'error' ? 'border-red-600 bg-red-950 text-red-400'
            : isStopped ? 'border-gray-500 bg-gray-900 text-gray-500'
            : 'border-gray-600 bg-gray-800 text-gray-400'
          }`}>
            {info.status === 'done' ? '✓' : info.status === 'error' ? '✗' : isStopped ? '■' : ''}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className={`flex items-center gap-1 text-xs leading-snug ${
            info.status === 'running' ? 'text-indigo-300'
            : info.status === 'error' ? 'text-red-400 line-through opacity-50'
            : isStopped ? 'text-gray-500 opacity-60'
            : 'text-gray-500'
          }`}>
            <span className="opacity-60">{meta.icon}</span>
            <span>{meta.label}{info.status === 'running' ? '…' : ''}</span>
            {info.status === 'running' && (
              <svg className="w-3 h-3 animate-spin ml-0.5 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {info.durationMs != null && info.status !== 'running' && (
              <span className="text-[10px] text-gray-600 ml-0.5">{formatDuration(info.durationMs)}</span>
            )}
          </div>
          {/* Show shell command being executed */}
          {shellCmd && (
            <div className={`mt-0.5 font-mono text-[11px] truncate max-w-full ${info.status === 'running' ? 'text-gray-400' : 'text-gray-600'}`} title={shellCmd}>
              <span className="text-gray-600 select-none">$ </span>{truncate(shellCmd, 120)}
            </div>
          )}
          {/* Live streaming output */}
          {info.liveOutput && info.status === 'running' && (
            <pre ref={outputRef} className="mt-1 font-mono text-[11px] text-gray-500 bg-gray-900/60 rounded px-2 py-1.5 max-h-32 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all">
              {info.liveOutput}
            </pre>
          )}
        </div>
        {hovered && <ToolTooltip info={info} anchorRef={rowRef} onHover={handleHover} />}
      </div>
      {expanded && <ToolDetailModal info={info} onClose={() => setExpanded(false)} />}
    </>
  );
}

// ─── ExecEntryRow — renders a single execution entry ──────────────────────────

export const MemoExecEntryRow = memo(ExecEntryRow);

export function ExecEntryRow({ entry, showTime, isLast }: {
  entry: ExecEntry;
  showTime?: boolean;
  isLast?: boolean;
}) {
  if (entry.type === 'tool') {
    return <ToolCallRow info={entry.info} showTime={showTime} time={entry.time} isLast={isLast} key={entry.key} />;
  }
  if (entry.type === 'text') {
    return (
      <div className={`flex items-start gap-2 ${showTime ? '' : ''}`}>
        {showTime && entry.time && (
          <span className="text-[10px] text-gray-600 shrink-0 w-16 text-right tabular-nums mt-2.5">{entry.time}</span>
        )}
        <div className="flex-1 bg-gray-800/50 rounded-lg px-3 py-2.5 my-1">
          <MarkdownMessage content={entry.content} className="text-sm text-gray-300" />
        </div>
      </div>
    );
  }
  if (entry.type === 'status') {
    const isCompleted = entry.content === 'completed';
    const isStarted = entry.content === 'started';
    const color = isCompleted ? 'text-green-400' : isStarted ? 'text-blue-400' : 'text-gray-500';
    const dot = isCompleted ? 'bg-green-400' : isStarted ? 'bg-blue-400' : 'bg-gray-500';
    return (
      <div className="flex items-center gap-2 py-0.5 px-1">
        {showTime && entry.time && (
          <span className="text-[10px] text-gray-600 shrink-0 w-16 text-right tabular-nums">{entry.time}</span>
        )}
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        <span className={`text-xs capitalize ${color}`}>{entry.content}</span>
      </div>
    );
  }
  if (entry.type === 'error') {
    return (
      <div className={`flex items-start gap-2 ${showTime ? '' : ''}`}>
        {showTime && entry.time && (
          <span className="text-[10px] text-gray-600 shrink-0 w-16 text-right tabular-nums mt-2">{entry.time}</span>
        )}
        <div className="flex-1 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2.5 py-2 my-1 leading-relaxed">
          <span className="font-medium">Error:</span> {entry.content}
        </div>
      </div>
    );
  }
  return null;
}

// ─── Legacy adapter: LogEntryRow for backward compatibility ───────────────────

export function LogEntryRow({ entry }: { entry: TaskLogEntry }) {
  const execEntry = taskLogToEntry(entry);
  if (!execEntry) return null;
  return <ExecEntryRow entry={execEntry} />;
}
