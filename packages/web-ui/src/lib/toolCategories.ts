import type { TFunction } from 'i18next';
import type { AgentToolInfo } from '../api.ts';

/**
 * Authoritative tool → category mapping for the Agent Profile "Tools" tab.
 *
 * NOTE: this list is crafted from the *registered* platform tool names (see
 * packages/core/src/tools + agent.ts). When a NEW tool is added to the runtime,
 * it must get a prefix here — otherwise it falls into the catch-all "其他"
 * (other), which looks like a grouping bug.
 *
 * Prefix `startsWith` is prefix-based so `feishu_`, `terminal__`, `llm_`,
 * `markus-hub__` etc. cover whole namespaces with one entry.
 */
export const TOOL_CATEGORY_DEF: Array<{ id: string; prefixes: string[] }> = [
  { id: 'files', prefixes: ['file_read', 'file_write', 'file_edit', 'apply_patch'] },
  { id: 'search', prefixes: ['grep_search', 'glob_find', 'list_directory'] },
  { id: 'runtime', prefixes: ['shell_execute', 'background_exec', 'process'] },
  { id: 'terminal', prefixes: ['terminal__', 'list_terminals', 'new_terminal', 'select_terminal', 'close_terminal', 'read_terminal', 'write_terminal', 'exec_terminal'] },
  { id: 'web', prefixes: ['web_search', 'web_fetch', 'web_extract'] },
  { id: 'multimodal', prefixes: ['generate_image', 'text_to_speech', 'speech_to_text', 'generate_video', 'describe_image', 'upload_reference'] },
  { id: 'browser', prefixes: ['navigate_page', 'new_page', 'close_page', 'select_page', 'list_pages', 'open_page', 'resize_page', 'click', 'hover', 'fill', 'fill_form', 'type_text', 'press_key', 'take_screenshot', 'take_snapshot', 'evaluate_script', 'wait_for', 'list_console_messages', 'list_network_requests', 'get_console_message', 'get_network_request', 'lighthouse_audit', 'drag', 'upload_file', 'emulate', 'handle_dialog'] },
  { id: 'tasks', prefixes: ['task_create', 'task_list', 'task_update', 'task_get', 'task_assign', 'task_note', 'task_comment', 'task_submit_review', 'task_request_approval', 'subtask_create', 'subtask_complete', 'subtask_cancel', 'subtask_list', 'task_check_duplicates', 'task_cleanup_duplicates', 'task_board_health', 'create_task', 'update_task', 'add_task_note', 'create_subtask'] },
  { id: 'requirements', prefixes: ['requirement_propose', 'requirement_list', 'requirement_get', 'requirement_update', 'requirement_update_status', 'requirement_resubmit', 'requirement_comment'] },
  { id: 'projects', prefixes: ['list_projects', 'get_project', 'create_project', 'update_project', 'delete_project', 'project_stats', 'project_structure', 'code_stats', 'git_'] },
  { id: 'deliverables', prefixes: ['deliverable_create', 'deliverable_search', 'deliverable_list', 'deliverable_update', 'office_generate'] },
  { id: 'packages', prefixes: ['package_list', 'package_install', 'hub_search', 'hub_install', 'builder_list', 'builder_install', 'markus-hub__'] },
  { id: 'communication', prefixes: ['agent_send_message', 'agent_ask_agent', 'agent_list_colleagues', 'agent_send_group_message', 'agent_create_group_chat', 'agent_list_group_chats', 'agent_broadcast_status', 'agent_delegate_task', 'feishu_'] },
  { id: 'memory', prefixes: ['memory_', 'recall_context', 'recall_activity', 'notebook_upsert', 'notebook_clear', 'notebook_read', 'session'] },
  { id: 'knowledge', prefixes: ['kb_search', 'kb_list', 'kb_read'] },
  // 第六刀新增的邮箱工具（地址绑定 C1 / 路由与 catch-all 概览 C3）与投递域同一处分组：
  // 它们的读面都是 mailbox，放在这里才不会被归到「其他」。
  { id: 'mailbox', prefixes: ['check_mailbox', 'defer_mailbox_item', 'drop_mailbox_item', 'prioritize_mailbox_item', 'delegate_message', 'bind_address', 'address_revoke', 'address_list', 'message_route', 'catch_all',
    // C8-C: `rest(wakeOn)` 是「声明我在等哪条邮箱事件」，与邮箱同组；`list_waits` / `cancel_wait` 是同一关系的读/取消面。
    'rest', 'list_waits', 'cancel_wait'] },
  { id: 'planning', prefixes: ['goal_create', 'goal_update', 'goal_status', 'workflow_'] },
  { id: 'reasoning', prefixes: ['decide'] },
  { id: 'teamManager', prefixes: ['team_list', 'team_status', 'team_update', 'team_start', 'team_stop', 'agent_update', 'agent_start', 'agent_stop', 'list_teams'] },
  { id: 'subagents', prefixes: ['spawn_subagent', 'spawn_subagents', 'invoke_coding_tool', 'coding_tool_apply'] },
  // 第七刀 C7-A：`work_status` 是**运行时自省**（读本 agent 的 WorkUnit 台账），
  // 与 `discover_tools` 同族，归入 system；不新开分类 —— 新建一个桶要给
  // zh-CN/en/es 三份 locale 各加一个字串，而它只是展示分组，不值得那个改动量。
  { id: 'system', prefixes: ['work_status', 'discover_tools', 'notify_user', 'request_user_input', 'request_user_approval', 'schedule_wakeup', 'cancel_wakeup', 'set_heartbeat_interval'] },
  { id: 'llm', prefixes: ['llm_', 'agent_model_'] },
];

export interface ToolCategoryGroup {
  category: string;
  tools: AgentToolInfo[];
}

/**
 * Group tools into display categories (ordered by TOOL_CATEGORY_DEF priority).
 * MCP tools (`server__tool`) are grouped under "MCP: server"; any remainder
 * (truly unknown / third-party names) lands in "其他".
 */
export function categorizeTools(tools: AgentToolInfo[], t: TFunction): ToolCategoryGroup[] {
  const categorized = new Map<string, AgentToolInfo[]>();
  const used = new Set<string>();
  for (const { id, prefixes } of TOOL_CATEGORY_DEF) {
    const catLabel = t(`agent:toolCategories.${id}`);
    const matched = tools.filter(tool => !used.has(tool.name) && prefixes.some(n => tool.name.startsWith(n)));
    if (matched.length > 0) {
      categorized.set(catLabel, matched);
      matched.forEach(m => used.add(m.name));
    }
  }
  const remaining = tools.filter(tool => !used.has(tool.name));
  for (const tool of remaining) {
    const sep = tool.name.indexOf('__');
    if (sep > 0) {
      const server = tool.name.slice(0, sep);
      const label = t('agent:toolCategories.mcp', { server });
      if (!categorized.has(label)) categorized.set(label, []);
      categorized.get(label)!.push(tool);
      used.add(tool.name);
    }
  }
  const other = tools.filter(tool => !used.has(tool.name));
  if (other.length > 0) categorized.set(t('agent:toolCategories.other'), other);
  return [...categorized.entries()].map(([category, catTools]) => ({ category, tools: catTools }));
}