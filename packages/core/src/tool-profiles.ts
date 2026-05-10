import type { AgentToolHandler } from './agent.js';
import { createLogger } from '@markus/shared';

const log = createLogger('tool-profiles');

export type ToolProfile = 'full' | 'coding' | 'messaging' | 'minimal' | 'external';

/**
 * Tool groups map a short name to a set of tool names.
 * Use "group:fs" in allow/deny lists to reference all tools in the group.
 */
const TOOL_GROUPS: Record<string, string[]> = {
  'group:fs': ['file_read', 'file_write', 'file_edit', 'apply_patch', 'grep_search', 'glob_find', 'list_directory'],
  'group:runtime': ['shell_execute', 'background_exec', 'process'],
  'group:memory': ['memory_save', 'memory_search', 'memory_list', 'memory_update_longterm', 'memory_delete'],
  'group:web': ['web_search', 'web_fetch', 'web_extract'],
  'group:messaging': ['agent_send_message', 'agent_list_colleagues', 'agent_send_group_message', 'agent_create_group_chat', 'agent_list_group_chats'],
  'group:a2a': ['agent_delegate_task', 'agent_broadcast_status', 'agent_send_message', 'agent_list_colleagues'],
  'group:agent': ['spawn_subagent', 'spawn_subagents'],
  'group:tasks': ['task_create', 'task_list', 'task_get', 'task_update', 'task_note', 'task_assign', 'task_submit_review', 'task_comment', 'subtask_create', 'subtask_complete', 'subtask_list'],
  'group:requirements': ['requirement_propose', 'requirement_list', 'requirement_get', 'requirement_update', 'requirement_update_status', 'requirement_resubmit', 'requirement_comment'],
  'group:project': ['list_projects', 'get_project', 'create_project', 'update_project', 'project_info', 'deliverable_create', 'deliverable_search', 'deliverable_list', 'deliverable_update'],
  'group:manager': ['team_list', 'team_status', 'delegate_message', 'team_update', 'agent_update', 'task_check_duplicates', 'task_cleanup_duplicates', 'task_board_health'],
};

/**
 * Base allowlists per profile.
 * 'full' = no restriction (all tools allowed).
 */
const PROFILE_ALLOWLISTS: Record<ToolProfile, string[] | null> = {
  full: null, // null means allow everything
  coding: ['group:fs', 'group:runtime', 'group:memory', 'group:web', 'group:agent'],
  messaging: ['group:messaging', 'group:memory'],
  minimal: ['memory_search', 'memory_list'],
  external: ['memory_search', 'memory_list', 'group:web'],
};

function expandGroups(names: string[]): Set<string> {
  const expanded = new Set<string>();
  for (const name of names) {
    if (name.startsWith('group:') && TOOL_GROUPS[name]) {
      for (const tool of TOOL_GROUPS[name]!) {
        expanded.add(tool);
      }
    } else {
      expanded.add(name);
    }
  }
  return expanded;
}

export interface ToolPolicyConfig {
  profile?: ToolProfile;
  allow?: string[];
  deny?: string[];
}

/**
 * Filters tools based on a ToolPolicyConfig.
 * Order of evaluation: profile → allow (additive) → deny (subtractive).
 */
export function applyToolPolicy(
  tools: AgentToolHandler[],
  policy: ToolPolicyConfig,
): AgentToolHandler[] {
  if (!policy.profile && !policy.allow?.length && !policy.deny?.length) {
    return tools;
  }

  const profile = policy.profile ?? 'full';
  const baseAllowlist = PROFILE_ALLOWLISTS[profile];

  // Build effective allow set
  let allowed: Set<string>;
  if (baseAllowlist === null) {
    // 'full' profile: start with all tools
    allowed = new Set(tools.map(t => t.name));
  } else {
    allowed = expandGroups(baseAllowlist);
  }

  // Additional explicit allows
  if (policy.allow?.length) {
    for (const name of expandGroups(policy.allow)) {
      allowed.add(name);
    }
  }

  // Deny overrides allow
  if (policy.deny?.length) {
    for (const name of expandGroups(policy.deny)) {
      allowed.delete(name);
    }
  }

  const filtered = tools.filter(t => allowed.has(t.name));
  log.debug('Tool policy applied', {
    profile,
    totalTools: tools.length,
    allowedTools: filtered.length,
    denied: tools.length - filtered.length,
  });

  return filtered;
}

export function getToolGroups(): Record<string, string[]> {
  return { ...TOOL_GROUPS };
}

export function getAvailableProfiles(): ToolProfile[] {
  return ['full', 'coding', 'messaging', 'minimal'];
}
