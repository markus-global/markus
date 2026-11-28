/**
 * Non-component utilities for execution timeline rendering.
 * Separated from ExecutionTimeline.tsx so Vite HMR Fast Refresh
 * works correctly (components-only files refresh faster).
 */
import type { TaskLogEntry } from '../api.ts';
import type { IconName } from './Icon.tsx';

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

// ─── Scroll anchoring coordination ────────────────────────────────────────────
// Collapsible rows (thinking / tool detail) live inside the chat's TanStack
// virtualizer. By default the virtualizer compensates scroll when a measured
// item resizes, which keeps the list bottom-pinned — so expanding a row makes the
// clicked header jump upward. When the user toggles a row we briefly set this
// flag so the virtualizer skips that compensation and the clicked row stays put
// (content grows downward / shrinks upward from a fixed top).
export const execScrollAnchor = { suppressAdjustUntil: 0 };

/**
 * While a user expands/collapses a tool/thinking row, suppress virtualizer
 * scroll compensation. Streaming replies keep resizing the same row for
 * several seconds, so a short window (e.g. 350ms) gets washed out — keep
 * suppression long enough for the interaction + follow-on height churn.
 */
export function suppressVirtualScrollAdjust(ms = 2500): void {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // Extend, don't shorten, if a prior suppress is still active.
  execScrollAnchor.suppressAdjustUntil = Math.max(execScrollAnchor.suppressAdjustUntil, now + ms);
}

export function isVirtualScrollAdjustSuppressed(): boolean {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) < execScrollAnchor.suppressAdjustUntil;
}

// ─── Tool Metadata ────────────────────────────────────────────────────────────

const TOOL_META: Record<string, { label: string; icon: IconName }> = {
  shell_execute:        { label: 'Running command',        icon: 'keyboard' },
  list_terminals:       { label: 'Listing terminals',      icon: 'keyboard' },
  new_terminal:         { label: 'Opening terminal',       icon: 'keyboard' },
  select_terminal:      { label: 'Selecting terminal',     icon: 'keyboard' },
  close_terminal:       { label: 'Closing terminal',       icon: 'keyboard' },
  read_terminal:        { label: 'Reading terminal',       icon: 'keyboard' },
  write_terminal:       { label: 'Writing terminal',       icon: 'keyboard' },
  exec_terminal:        { label: 'Running in terminal',    icon: 'keyboard' },
  file_read:            { label: 'Reading file',           icon: 'file' },
  file_write:           { label: 'Writing file',           icon: 'pencil' },
  file_edit:            { label: 'Editing file',           icon: 'pencil' },
  apply_patch:          { label: 'Applying patch',         icon: 'shuffle' },
  list_directory:       { label: 'Listing directory',      icon: 'folder-open' },
  glob_find:            { label: 'Finding files',          icon: 'search' },
  grep_search:          { label: 'Searching code',         icon: 'search' },
  web_fetch:            { label: 'Fetching page',          icon: 'globe' },
  web_search:           { label: 'Searching web',          icon: 'search' },
  web_extract:          { label: 'Extracting content',     icon: 'file-text' },
  create_task:          { label: 'Creating task',          icon: 'pin' },
  task_create:          { label: 'Creating task',          icon: 'pin' },
  create_subtask:       { label: 'Adding subtask',         icon: 'pin' },
  update_task:          { label: 'Updating task',          icon: 'check-circle' },
  task_update:          { label: 'Updating task',          icon: 'check-circle' },
  add_task_note:        { label: 'Adding note',            icon: 'pencil-line' },
  task_add_note:        { label: 'Adding note',            icon: 'pencil-line' },
  task_list:            { label: 'Listing tasks',          icon: 'check-square' },
  task_get:             { label: 'Getting task',           icon: 'check-square' },
  task_note:            { label: 'Adding note',            icon: 'pencil-line' },
  task_assign:          { label: 'Assigning task',         icon: 'users' },
  task_submit_review:   { label: 'Submitting for review',  icon: 'check-circle' },
  task_comment:         { label: 'Commenting task',        icon: 'message' },
  subtask_create:       { label: 'Adding subtask',         icon: 'pin' },
  subtask_complete:     { label: 'Completing subtask',     icon: 'check-circle' },
  subtask_cancel:       { label: 'Cancelling subtask',     icon: 'ban' },
  subtask_list:         { label: 'Listing subtasks',       icon: 'check-square' },
  requirement_propose:  { label: 'Proposing requirement',  icon: 'target' },
  requirement_list:     { label: 'Listing requirements',   icon: 'target' },
  requirement_get:      { label: 'Getting requirement',    icon: 'target' },
  requirement_update:   { label: 'Updating requirement',   icon: 'target' },
  requirement_update_status: { label: 'Updating req status', icon: 'check-circle' },
  requirement_resubmit: { label: 'Resubmitting requirement', icon: 'target' },
  requirement_comment:  { label: 'Commenting requirement', icon: 'message' },
  list_projects:        { label: 'Listing projects',       icon: 'folder-tree' },
  get_project:          { label: 'Getting project',        icon: 'folder-tree' },
  create_project:       { label: 'Creating project',       icon: 'folder-tree' },
  update_project:       { label: 'Updating project',       icon: 'folder-tree' },
  deliverable_create:   { label: 'Creating deliverable',   icon: 'package' },
  deliverable_search:   { label: 'Searching deliverables', icon: 'search' },
  deliverable_list:     { label: 'Listing deliverables',   icon: 'package' },
  deliverable_update:   { label: 'Updating deliverable',   icon: 'package' },
  agent_ask_agent:      { label: 'Asking another agent',   icon: 'message' },
  git_status:           { label: 'Git status',             icon: 'shuffle' },
  git_diff:             { label: 'Git diff',               icon: 'shuffle' },
  git_log:              { label: 'Git log',                icon: 'scroll' },
  git_branch:           { label: 'Git branch',             icon: 'leaf' },
  git_add:              { label: 'Git add',                icon: 'plus' },
  git_commit:           { label: 'Git commit',             icon: 'save' },
  project_structure:    { label: 'Project structure',      icon: 'folder-tree' },
  code_stats:           { label: 'Code stats',             icon: 'bar-chart' },
  navigate_page:        { label: 'Opening page',           icon: 'globe' },
  new_page:             { label: 'Opening new tab',        icon: 'globe' },
  close_page:           { label: 'Closing tab',            icon: 'globe' },
  select_page:          { label: 'Switching tab',          icon: 'globe' },
  list_pages:           { label: 'Listing tabs',           icon: 'globe' },
  click:                { label: 'Clicking element',       icon: 'pointer' },
  hover:                { label: 'Hovering element',       icon: 'pointer' },
  fill:                 { label: 'Filling field',          icon: 'keyboard' },
  fill_form:            { label: 'Filling form',           icon: 'keyboard' },
  type_text:            { label: 'Typing text',            icon: 'keyboard' },
  press_key:            { label: 'Pressing key',           icon: 'keyboard' },
  take_screenshot:      { label: 'Screenshot',             icon: 'camera' },
  take_snapshot:        { label: 'Page snapshot',          icon: 'clipboard' },
  evaluate_script:      { label: 'Running script',         icon: 'gear' },
  wait_for:             { label: 'Waiting',                icon: 'hourglass' },
  list_console_messages: { label: 'Console logs',          icon: 'search' },
  list_network_requests: { label: 'Network requests',      icon: 'search' },
  lighthouse_audit:     { label: 'Running audit',          icon: 'bar-chart' },
  agent_send_message:   { label: 'Messaging colleague',    icon: 'message' },
  agent_list_colleagues: { label: 'Checking team',         icon: 'users' },
  memory_save:          { label: 'Saving memory',          icon: 'save' },
  memory_search:        { label: 'Searching memory',       icon: 'search' },
  memory_list:          { label: 'Listing memory',         icon: 'save' },
  memory_update:        { label: 'Updating memory',        icon: 'save' },
  recall_activity:      { label: 'Recalling activity',     icon: 'scroll' },
  notebook_upsert:      { label: 'Updating notebook',      icon: 'pencil-line' },
  kb_search:            { label: 'Searching knowledge base', icon: 'book' },
  kb_list:              { label: 'Listing knowledge base',   icon: 'book' },
  kb_read:              { label: 'Reading knowledge base',   icon: 'book' },
  notify_user:          { label: 'Notifying user',         icon: 'bell' },
  request_user_input:   { label: 'Requesting input',       icon: 'help-circle' },
  request_user_approval: { label: 'Requesting approval',   icon: 'help-circle' },
  schedule_wakeup:      { label: 'Scheduling wakeup',      icon: 'alarm' },
  cancel_wakeup:        { label: 'Cancelling wakeup',      icon: 'alarm' },
  set_heartbeat_interval: { label: 'Setting heartbeat',    icon: 'alarm' },
  discover_tools:       { label: 'Discovering tools',      icon: 'toolbox' },
  check_mailbox:        { label: 'Checking mailbox',       icon: 'inbox' },
  goal_create:          { label: 'Creating goal',          icon: 'target' },
  goal_update:          { label: 'Updating goal',          icon: 'target' },
  goal_status:          { label: 'Goal status',            icon: 'target' },
  background_exec:      { label: 'Background command',     icon: 'keyboard' },
  process:              { label: 'Managing process',       icon: 'gear' },
  feishu_send_message:  { label: 'Sending Feishu msg',     icon: 'mail' },
  feishu_search_docs:   { label: 'Searching Feishu',       icon: 'search' },
  spawn_subagent:       { label: 'Spawn Subagent',         icon: 'dot' },
  spawn_subagents:      { label: 'Spawn Subagents',        icon: 'dot' },
  invoke_coding_tool:   { label: 'Invoke Coding Tool',     icon: 'tools' },
  coding_tool_apply:    { label: 'Apply Coding Result',    icon: 'shuffle' },
  // Multimodal
  generate_image:       { label: 'Generating image',       icon: 'image' },
  text_to_speech:       { label: 'Generating speech',      icon: 'volume' },
  speech_to_text:       { label: 'Transcribing audio',     icon: 'microphone' },
  generate_video:       { label: 'Generating video',       icon: 'film' },
  // LLM settings
  llm_list_providers:   { label: 'Listing providers',      icon: 'gear' },
  llm_switch_model:     { label: 'Switching model',        icon: 'gear' },
  llm_switch_default_provider: { label: 'Switching provider', icon: 'gear' },
  llm_add_provider:     { label: 'Adding provider',        icon: 'gear' },
  llm_edit_provider:    { label: 'Editing provider',       icon: 'gear' },
  llm_add_model:        { label: 'Adding model',           icon: 'gear' },
  llm_get_capability_routing: { label: 'Checking capability routing', icon: 'gear' },
  llm_set_capability_routing: { label: 'Setting capability routing', icon: 'gear' },
  // Team / agent management
  team_list:            { label: 'Listing teams',          icon: 'users' },
  team_status:          { label: 'Team status',            icon: 'users' },
  team_start:           { label: 'Starting team',          icon: 'users' },
  team_stop:            { label: 'Stopping team',          icon: 'users' },
  team_update:          { label: 'Updating team',          icon: 'users' },
  agent_start:          { label: 'Starting agent',         icon: 'dot' },
  agent_stop:           { label: 'Stopping agent',         icon: 'dot' },
  agent_update:         { label: 'Updating agent',         icon: 'dot' },
  agent_delegate_task:  { label: 'Delegating task',        icon: 'pin' },
  agent_broadcast_status: { label: 'Broadcasting status',  icon: 'megaphone' },
  agent_create_group_chat: { label: 'Creating group chat', icon: 'message' },
  agent_list_group_chats: { label: 'Listing group chats',  icon: 'message' },
  agent_send_group_message: { label: 'Sending group message', icon: 'message' },
  // Projects / hub / packages
  delete_project:       { label: 'Deleting project',       icon: 'folder-tree' },
  project_stats:        { label: 'Project stats',          icon: 'bar-chart' },
  hub_search:           { label: 'Searching Hub',          icon: 'search' },
  hub_install:          { label: 'Installing from Hub',    icon: 'package' },
  package_list:         { label: 'Listing packages',       icon: 'package' },
  package_install:      { label: 'Installing package',     icon: 'package' },
  // Memory / mailbox / notebook
  memory_delete:        { label: 'Deleting memory',        icon: 'save' },
  memory_update_longterm: { label: 'Updating long-term memory', icon: 'save' },
  notebook_clear:       { label: 'Clearing notebook',      icon: 'pencil-line' },
  notebook_read:        { label: 'Reading notebook',       icon: 'pencil-line' },
  recall_context:       { label: 'Recalling context',      icon: 'scroll' },
  defer_mailbox_item:   { label: 'Deferring mailbox item', icon: 'inbox' },
  drop_mailbox_item:    { label: 'Dropping mailbox item',  icon: 'inbox' },
  prioritize_mailbox_item: { label: 'Prioritizing mailbox', icon: 'inbox' },
  delegate_message:     { label: 'Delegating message',     icon: 'message' },
  // Tasks / workflows
  task_board_health:    { label: 'Checking task board',    icon: 'clipboard' },
  task_check_duplicates: { label: 'Checking duplicates',   icon: 'clipboard' },
  task_cleanup_duplicates: { label: 'Cleaning duplicates', icon: 'clipboard' },
  workflow_list:        { label: 'Listing workflows',      icon: 'refresh' },
  workflow_create:      { label: 'Creating workflow',      icon: 'refresh' },
  workflow_update:      { label: 'Updating workflow',      icon: 'refresh' },
  workflow_delete:      { label: 'Deleting workflow',      icon: 'refresh' },
  workflow_run:         { label: 'Running workflow',       icon: 'refresh' },
  workflow_status:      { label: 'Workflow status',        icon: 'refresh' },
  workflow_cancel:      { label: 'Cancelling workflow',    icon: 'refresh' },
  // Browser extras
  open_page:            { label: 'Opening page',           icon: 'globe' },
  resize_page:          { label: 'Resizing page',          icon: 'globe' },
  drag:                 { label: 'Dragging element',       icon: 'pointer' },
  upload_file:          { label: 'Uploading file',         icon: 'paperclip' },
  emulate:              { label: 'Emulating device',       icon: 'smartphone' },
  handle_dialog:        { label: 'Handling dialog',        icon: 'message' },
  get_console_message:  { label: 'Console message',        icon: 'search' },
  get_network_request:  { label: 'Network request',        icon: 'search' },
};

// Monochrome named-icon (see lib/namedIcons.tsx) per tool. Unlike the emoji in
// TOOL_META, these inherit `currentColor`, so the tool icon itself can be tinted
// green (success) / red (failure) instead of a separate status badge.
const TOOL_ICON_NAME: Record<string, string> = {
  shell_execute: 'square-terminal', background_exec: 'square-terminal', process: 'settings',
  list_terminals: 'square-terminal', new_terminal: 'square-terminal', select_terminal: 'square-terminal',
  close_terminal: 'square-terminal', read_terminal: 'square-terminal', write_terminal: 'square-terminal',
  exec_terminal: 'square-terminal',
  file_read: 'file-text', file_write: 'edit', file_edit: 'edit', apply_patch: 'git-branch',
  list_directory: 'folder', glob_find: 'search', grep_search: 'search',
  web_fetch: 'globe', web_search: 'search', web_extract: 'file-text',
  create_task: 'clipboard', task_create: 'clipboard', create_subtask: 'clipboard',
  update_task: 'check-circle', task_update: 'check-circle',
  add_task_note: 'edit', task_add_note: 'edit', task_note: 'edit', task_list: 'clipboard',
  task_get: 'clipboard', task_assign: 'users', task_submit_review: 'check-circle', task_comment: 'message-square',
  subtask_create: 'clipboard', subtask_complete: 'check-circle', subtask_cancel: 'alert-circle', subtask_list: 'clipboard',
  requirement_propose: 'clipboard', requirement_list: 'clipboard', requirement_get: 'clipboard',
  requirement_update: 'clipboard', requirement_update_status: 'check-circle', requirement_resubmit: 'clipboard', requirement_comment: 'message-square',
  list_projects: 'layers', get_project: 'layers', create_project: 'layers', update_project: 'layers',
  deliverable_create: 'package', deliverable_search: 'search', deliverable_list: 'package', deliverable_update: 'edit',
  git_status: 'git-branch', git_diff: 'git-branch', git_log: 'book-open',
  git_branch: 'git-branch', git_add: 'git-branch', git_commit: 'save',
  project_structure: 'layers', code_stats: 'bar-chart',
  navigate_page: 'globe', new_page: 'globe', close_page: 'globe', select_page: 'globe', list_pages: 'globe',
  click: 'target', hover: 'target',
  fill: 'terminal', fill_form: 'terminal', type_text: 'terminal', press_key: 'terminal',
  take_screenshot: 'camera', take_snapshot: 'camera', evaluate_script: 'code', wait_for: 'clock',
  list_console_messages: 'terminal', list_network_requests: 'globe', lighthouse_audit: 'bar-chart',
  agent_send_message: 'message-square', agent_list_colleagues: 'users',
  memory_save: 'database', memory_search: 'search', memory_list: 'database', memory_update: 'database',
  recall_activity: 'book-open', notebook_upsert: 'edit',
  kb_search: 'book-open', kb_list: 'book-open', kb_read: 'book-open',
  notify_user: 'megaphone', request_user_input: 'message-square', request_user_approval: 'check-circle',
  schedule_wakeup: 'clock', cancel_wakeup: 'clock', set_heartbeat_interval: 'clock',
  discover_tools: 'wrench', check_mailbox: 'message-square',
  goal_create: 'target', goal_update: 'target', goal_status: 'target',
  feishu_send_message: 'message-square', feishu_search_docs: 'search',
  spawn_subagent: 'bot', spawn_subagents: 'bot',
  invoke_coding_tool: 'wrench', coding_tool_apply: 'git-branch',
  generate_image: 'camera', text_to_speech: 'headphones', speech_to_text: 'headphones', generate_video: 'camera',
  llm_list_providers: 'settings', llm_switch_model: 'settings', llm_switch_default_provider: 'settings',
  llm_add_provider: 'settings', llm_edit_provider: 'settings', llm_add_model: 'settings',
  llm_get_capability_routing: 'settings', llm_set_capability_routing: 'settings',
  team_list: 'users', team_status: 'users', team_start: 'users', team_stop: 'users', team_update: 'users',
  agent_start: 'bot', agent_stop: 'bot', agent_update: 'bot', agent_delegate_task: 'clipboard',
  agent_broadcast_status: 'megaphone', agent_create_group_chat: 'message-square',
  agent_list_group_chats: 'message-square', agent_send_group_message: 'message-square',
  delete_project: 'layers', project_stats: 'bar-chart',
  hub_search: 'search', hub_install: 'package', package_list: 'package', package_install: 'package',
  memory_delete: 'database', memory_update_longterm: 'database',
  notebook_clear: 'edit', notebook_read: 'edit', recall_context: 'book-open',
  defer_mailbox_item: 'message-square', drop_mailbox_item: 'message-square', prioritize_mailbox_item: 'message-square',
  delegate_message: 'message-square',
  task_board_health: 'clipboard', task_check_duplicates: 'clipboard', task_cleanup_duplicates: 'clipboard',
  workflow_list: 'git-branch', workflow_create: 'git-branch', workflow_update: 'git-branch',
  workflow_delete: 'git-branch', workflow_run: 'git-branch', workflow_status: 'git-branch', workflow_cancel: 'git-branch',
  open_page: 'globe', resize_page: 'globe', drag: 'target', upload_file: 'file-text',
  emulate: 'settings', handle_dialog: 'message-square',
  get_console_message: 'terminal', get_network_request: 'globe',
};

export function getToolMeta(tool: string): { label: string; icon: string; iconName: string; key: string } {
  const baseName = tool.includes('__') ? tool.split('__').pop()! : tool;
  const base = TOOL_META[baseName] ?? TOOL_META[tool];
  const iconName = TOOL_ICON_NAME[baseName] ?? TOOL_ICON_NAME[tool] ?? 'settings';
  if (base) return { ...base, iconName, key: baseName };
  return {
    label: baseName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    icon: 'gear',
    iconName,
    key: baseName,
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
    // Chat stream keys are es_/ee_; task activity keys are ts_/te_.
    const seqStr = key.replace(/^(?:t[se]_|e[se]_)/, '');
    const seq = parseInt(seqStr, 10);
    if (isNaN(seq)) return entry;
    const logs = subagentLogsByRange.get(seq);
    if (!logs || logs.length === 0) return entry;
    return { ...entry, info: { ...entry.info, subagentLogs: logs } };
  });
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
        info: {
          tool: entry.content,
          status: 'running',
          args: meta?.arguments,
          subagentLogs: meta?.subagentLogs as SubagentLogEntry[] | undefined,
        },
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
