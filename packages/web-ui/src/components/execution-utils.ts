/**
 * Non-component utilities for execution timeline rendering.
 * Separated from ExecutionTimeline.tsx so Vite HMR Fast Refresh
 * works correctly (components-only files refresh faster).
 */
import type { TaskLogEntry, AgentActivityLogEntry } from '../api.ts';

// ─── Shared Types ─────────────────────────────────────────────────────────────

export interface SubagentLogEntry {
  eventType: 'started' | 'tool_start' | 'tool_end' | 'thinking' | 'iteration' | 'completed' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallInfo {
  tool: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  args?: unknown;
  result?: string;
  error?: string;
  durationMs?: number;
  liveOutput?: string;
  subagentLogs?: SubagentLogEntry[];
}

export type ExecEntry =
  | { type: 'text'; content: string; time?: string; timestamp?: string }
  | { type: 'thinking'; content: string; time?: string; timestamp?: string }
  | { type: 'tool'; info: ToolCallInfo; time?: string; key?: string; timestamp?: string }
  | { type: 'status'; content: string; time?: string; timestamp?: string }
  | { type: 'error'; content: string; time?: string; timestamp?: string };

export interface ExecutionStreamEntryUI {
  id: string;
  sourceType: string;
  sourceId: string;
  agentId: string;
  seq: number;
  type: 'status' | 'text' | 'tool_start' | 'tool_end' | 'error' | 'subagent_start' | 'subagent_progress' | 'subagent_end';
  content: string;
  metadata?: Record<string, unknown>;
  executionRound?: number;
  createdAt: string;
}

export interface TaskApprovalInfo {
  taskId: string;
  title: string;
  description?: string;
  assignedAgentId?: string;
  priority?: string;
}

export interface RequirementApprovalInfo {
  requirementId: string;
  title: string;
  description?: string;
  priority?: string;
}

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
  requirement_propose:  { label: 'Proposing requirement',  icon: '📋' },
  requirement_list:     { label: 'Listing requirements',   icon: '📋' },
  git_status:           { label: 'Git status',             icon: '🔀' },
  git_diff:             { label: 'Git diff',               icon: '🔀' },
  git_log:              { label: 'Git log',                icon: '📜' },
  git_branch:           { label: 'Git branch',             icon: '🌿' },
  git_add:              { label: 'Git add',                icon: '➕' },
  git_commit:           { label: 'Git commit',             icon: '💾' },
  code_search:          { label: 'Searching code',         icon: '🔍' },
  project_structure:    { label: 'Project structure',      icon: '🗂' },
  code_stats:           { label: 'Code stats',             icon: '📊' },
  navigate_page:        { label: 'Opening page',           icon: '🌐' },
  new_page:             { label: 'Opening new tab',        icon: '🌐' },
  close_page:           { label: 'Closing tab',            icon: '🌐' },
  select_page:          { label: 'Switching tab',          icon: '🌐' },
  list_pages:           { label: 'Listing tabs',           icon: '🌐' },
  click:                { label: 'Clicking element',       icon: '👆' },
  hover:                { label: 'Hovering element',       icon: '👆' },
  fill:                 { label: 'Filling field',          icon: '⌨' },
  fill_form:            { label: 'Filling form',           icon: '⌨' },
  type_text:            { label: 'Typing text',            icon: '⌨' },
  press_key:            { label: 'Pressing key',           icon: '⌨' },
  take_screenshot:      { label: 'Screenshot',             icon: '📸' },
  take_snapshot:        { label: 'Page snapshot',          icon: '📋' },
  evaluate_script:      { label: 'Running script',         icon: '⚙' },
  wait_for:             { label: 'Waiting',                icon: '⏳' },
  list_console_messages: { label: 'Console logs',          icon: '🔍' },
  list_network_requests: { label: 'Network requests',      icon: '🔍' },
  lighthouse_audit:     { label: 'Running audit',          icon: '📊' },
  agent_send_message:   { label: 'Messaging colleague',    icon: '💬' },
  agent_list:           { label: 'Checking team',          icon: '👥' },
  memory_save:          { label: 'Saving memory',          icon: '💾' },
  memory_search:        { label: 'Searching memory',       icon: '🔍' },
  feishu_send_message:  { label: 'Sending Feishu msg',     icon: '✉' },
  feishu_search_docs:   { label: 'Searching Feishu',       icon: '🔍' },
  spawn_subagent:       { label: 'Spawn Subagent',         icon: '◎' },
  spawn_subagents:      { label: 'Spawn Subagents',        icon: '◎' },
};

export function getToolMeta(tool: string): { label: string; icon: string } {
  const baseName = tool.includes('__') ? tool.split('__').pop()! : tool;
  return TOOL_META[baseName] ?? TOOL_META[tool] ?? {
    label: baseName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    icon: '⚙',
  };
}

// ─── Format Helpers ───────────────────────────────────────────────────────────

export function formatDuration(ms: number | undefined): string {
  if (ms === null || ms === undefined) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatLogTime(isoStr: string): string {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${MM}-${DD} ${hh}:${mm}:${ss}`;
}

export function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.slice(0, len) + '…';
}

export function prettyJson(s: string): string {
  try {
    const parsed = JSON.parse(s);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return s;
  }
}

export function formatArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}: ${truncate(val, 120)}`);
  }
  return parts.join(', ');
}

export function formatArgsDetail(args: unknown): Array<{ key: string; value: string }> {
  if (!args || typeof args !== 'object') return [];
  const obj = args as Record<string, unknown>;
  return Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ({ key: k, value: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }));
}

/** Extract the shell command text from tool args, if applicable */
export function getShellCommand(info: ToolCallInfo): string | null {
  if (info.tool !== 'shell_execute' || !info.args || typeof info.args !== 'object') return null;
  const cmd = (info.args as Record<string, unknown>).command;
  return typeof cmd === 'string' ? cmd : null;
}

// ─── Conversion: TaskLogEntry → ExecEntry ─────────────────────────────────────

export function taskLogToEntry(entry: TaskLogEntry): ExecEntry | null {
  const time = formatLogTime(entry.createdAt);
  const ts = entry.createdAt;
  const meta = entry.metadata as Record<string, unknown> | undefined;
  switch (entry.type) {
    case 'text':
      if (meta?.isThinking) return { type: 'thinking', content: entry.content, time, timestamp: ts };
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

type RawLogLike = Pick<TaskLogEntry, 'seq' | 'type' | 'content' | 'metadata'>;

/**
 * Post-process raw log entries to attach subagent_* logs to parent spawn_subagent(s) tool entries.
 * Accepts both TaskLogEntry[] and AgentActivityLogEntry[] (or any array with seq/type/content/metadata).
 */
export function attachSubagentLogsToEntries(rawLogs: RawLogLike[], entries: ExecEntry[]): ExecEntry[] {
  const subagentLogsByRange: Map<number, SubagentLogEntry[]> = new Map();
  let currentSpawnStartSeq: number | null = null;

  for (const log of rawLogs) {
    if (log.type === 'tool_start' && (log.content === 'spawn_subagent' || log.content === 'spawn_subagents')) {
      currentSpawnStartSeq = log.seq;
      subagentLogsByRange.set(log.seq, []);
    } else if (log.type === 'tool_end' && (log.content === 'spawn_subagent' || log.content === 'spawn_subagents')) {
      if (currentSpawnStartSeq !== null) {
        const logs = subagentLogsByRange.get(currentSpawnStartSeq);
        if (logs) subagentLogsByRange.set(log.seq, logs);
      }
      currentSpawnStartSeq = null;
    } else if (currentSpawnStartSeq !== null && log.type.startsWith('subagent_')) {
      const eventType = log.type.replace('subagent_', '') as SubagentLogEntry['eventType'];
      const meta = log.metadata as Record<string, unknown> | undefined;
      subagentLogsByRange.get(currentSpawnStartSeq)?.push({
        eventType,
        content: log.content,
        metadata: meta,
      });
    }
  }

  return entries.map(entry => {
    if (entry.type !== 'tool') return entry;
    const key = entry.key;
    if (!key) return entry;
    const seqStr = key.replace(/^t[se]_/, '');
    const seq = parseInt(seqStr, 10);
    if (isNaN(seq)) return entry;
    const logs = subagentLogsByRange.get(seq);
    if (!logs || logs.length === 0) return entry;
    return { ...entry, info: { ...entry.info, subagentLogs: logs } };
  });
}

// ─── Conversion: AgentActivityLogEntry → ExecEntry ────────────────────────────

export function activityLogToEntry(entry: AgentActivityLogEntry): ExecEntry | null {
  const time = formatLogTime(entry.createdAt);
  const meta = entry.metadata as Record<string, unknown> | undefined;
  switch (entry.type) {
    case 'text':
      if (meta?.isThinking) return { type: 'thinking', content: entry.content, time };
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

// ─── ExecutionStreamEntry → ExecEntry ─────────────────────────────────────────

export function streamEntryToExecEntry(entry: ExecutionStreamEntryUI): ExecEntry | null {
  const time = formatLogTime(entry.createdAt);
  const ts = entry.createdAt;
  const meta = entry.metadata;
  switch (entry.type) {
    case 'text':
      if (meta?.isThinking) return { type: 'thinking', content: entry.content, time, timestamp: ts };
      return { type: 'text', content: entry.content, time, timestamp: ts };
    case 'status': {
      const action = meta?.action as string | undefined;
      if (action && ['chat', 'chat_stream', 'task_execution', 'respond_in_session'].includes(action)) return null;
      return { type: 'status', content: entry.content, time, timestamp: ts };
    }
    case 'error':
      return { type: 'error', content: entry.content, time, timestamp: ts };
    case 'tool_start':
      return {
        type: 'tool', time, timestamp: ts,
        key: `es_${entry.seq}`,
        info: { tool: entry.content, status: 'running', args: meta?.arguments },
      };
    case 'tool_end':
      return {
        type: 'tool', time, timestamp: ts,
        key: `ee_${entry.seq}`,
        info: {
          tool: entry.content,
          status: meta?.success === false ? 'error' : 'done',
          args: meta?.arguments,
          result: meta?.result as string | undefined,
          error: meta?.error as string | undefined,
          durationMs: meta?.durationMs as number | undefined,
          subagentLogs: meta?.subagentLogs as SubagentLogEntry[] | undefined,
        },
      };
    default:
      return null;
  }
}

// ─── Parse helpers for inline approval cards ──────────────────────────────────

export function parseTaskApprovalFromResult(tool: string, result?: string): TaskApprovalInfo | null {
  if (tool !== 'task_create' && tool !== 'create_task') return null;
  if (!result) return null;
  try {
    const parsed = JSON.parse(result);
    if (!parsed.task) return null;
    const t = parsed.task;
    return {
      taskId: t.id,
      title: t.title,
      description: t.description,
      assignedAgentId: t.assignedAgentId,
      priority: t.priority,
    };
  } catch {
    return null;
  }
}

export function parseRequirementApprovalFromResult(tool: string, result?: string): RequirementApprovalInfo | null {
  if (tool !== 'requirement_propose') return null;
  if (!result) return null;
  try {
    const parsed = JSON.parse(result);
    if (parsed.status !== 'success' || !parsed.requirement) return null;
    const r = parsed.requirement;
    if (r.status !== 'pending') return null;
    return {
      requirementId: r.id,
      title: r.title,
      description: r.description,
      priority: r.priority,
    };
  } catch {
    return null;
  }
}
