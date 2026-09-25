/**
 * Scenario Capability Packs — Context Surface tool/prompt budgets.
 * Spec: docs/AGENT-RUNTIME.md §2–§5
 */
import {
  TOOL_DEF_BUDGET_REFLEX,
  TOOL_DEF_BUDGET_CONVERSE,
  TOOL_DEF_BUDGET_EXECUTE,
  TOOL_DEF_BUDGET_GOVERN,
} from '@markus/shared';

export type CapabilityPack = 'reflex' | 'converse' | 'execute' | 'govern';
export type PromptProfile = CapabilityPack;

/** Slim reflex core (AGENT-RUNTIME §2.2). */
export const REFLEX_CORE_TOOLS = [
  'task_list',
  'task_get',
  'memory_save',
  'memory_search',
  'notify_user',
  'request_user_input',
  'schedule_wakeup',
  'cancel_wakeup',
  'set_heartbeat_interval',
  'discover_tools',
  'check_mailbox',
  'file_read',
  'agent_send_message',
  'update_notebook',
] as const;

export const REFLEX_MANAGER_EXTRA_TOOLS = ['team_status'] as const;

/** Forbidden in default converse selection (discover only). */
export const CONVERSE_FORBIDDEN_DEFAULT = new Set([
  'deliverable_create',
]);

/** Tools that must never be evicted for budget. */
export const TOOL_DEF_PROTECTED = new Set([
  'discover_tools',
  'notify_user',
  'request_user_input',
  'request_user_approval',
]);

/**
 * Core Markus tools that should survive budget pressure before MCP/skill tools.
 * Prefer deferring chrome-devtools__* / feishu_* over shell_execute / file_read.
 */
export const TOOL_DEF_CORE_KEEP = new Set([
  ...TOOL_DEF_PROTECTED,
  'shell_execute',
  'file_read',
  'file_write',
  'file_edit',
  'grep_search',
  'glob_find',
  'list_directory',
  'apply_patch',
  'web_search',
  'web_fetch',
  'task_create',
  'task_list',
  'task_update',
  'task_get',
  'task_comment',
  'memory_save',
  'memory_search',
  'spawn_subagent',
  'spawn_subagents',
  'agent_send_message',
  'agent_list_colleagues',
  'deliverable_search',
  'requirement_comment',
  'session',
]);

/** MCP / skill-namespaced tools — evict these before core Markus tools. */
export function isSkillOrMcpToolName(name: string): boolean {
  return name.includes('__')
    || name.startsWith('feishu_')
    || name.startsWith('chrome-devtools')
    || name.startsWith('chrome_');
}

/**
 * Tools that require a **work-entity session** (task / requirement / workflow /
 * review), not free-floating Team Chat.
 *
 * Allowed packs/scenarios: execute, govern, and entity-bound converse
 * (`comment_response`, `requirement_action`, `workflow_action`).
 * Must NOT sticky into plain `chat` / `a2a` / `group_chat` / reflex — that
 * caused "No active task" when `task_submit_review` leaked without ALS.
 */
export const EXECUTE_SESSION_ONLY_TOOLS = new Set([
  'task_submit_review',
  'task_note',
  'task_assign',
  'subtask_create',
  'subtask_complete',
  'subtask_cancel',
  'subtask_list',
]);

/** @deprecated Alias — prefer {@link isWorkContextBoundTool}. */
export function isExecuteSessionOnlyTool(name: string): boolean {
  return isWorkContextBoundTool(name);
}

export function isWorkContextBoundTool(name: string): boolean {
  return EXECUTE_SESSION_ONLY_TOOLS.has(name);
}

/** Scenarios bound to a concrete task/requirement/workflow entity. */
export function isEntityBoundScenario(scenario?: string): boolean {
  return scenario === 'task_execution'
    || scenario === 'review'
    || scenario === 'comment_response'
    || scenario === 'requirement_action'
    || scenario === 'workflow_action'
    || scenario === 'deliberation';
}

/** Whether work-context-bound tools may appear LIVE for this pack/scenario. */
export function allowsWorkContextBoundTools(
  pack: CapabilityPack,
  scenario?: string,
): boolean {
  if (pack === 'execute' || pack === 'govern') return true;
  return isEntityBoundScenario(scenario);
}

export function scenarioToPack(scenario: string | undefined): CapabilityPack {
  switch (scenario) {
    case 'heartbeat':
      // 心跳与普通 session 同级的能力（converse）。不再用小工具 reflex 包锁死——
      // 约束回归「心跳描述文件（HEARTBEAT.md）+ 心跳间隔」：HEARTBEAT.md 定义巡检
      // 范围与行为红线，间隔控制成本。见 docs/agent-liveness-redesign.md §三.2。
      return 'converse';
    case 'memory_consolidation':
    case 'memory_flush':
    case 'distillation':
      return 'reflex';
    case 'task_execution':
      return 'execute';
    case 'review':
    case 'deliberation':
      return 'govern';
    case 'chat':
    case 'a2a':
    case 'group_chat':
    case 'comment_response':
    case 'requirement_action':
    case 'workflow_action':
    default:
      return 'converse';
  }
}

export function packToolDefBudget(pack: CapabilityPack): number {
  switch (pack) {
    case 'reflex':
      return TOOL_DEF_BUDGET_REFLEX;
    case 'converse':
      return TOOL_DEF_BUDGET_CONVERSE;
    case 'execute':
      return TOOL_DEF_BUDGET_EXECUTE;
    case 'govern':
      return TOOL_DEF_BUDGET_GOVERN;
  }
}

export function packToPromptProfile(pack: CapabilityPack): PromptProfile {
  return pack;
}

export function getReflexAllowlist(isManager: boolean): Set<string> {
  const set = new Set<string>(REFLEX_CORE_TOOLS);
  if (isManager) {
    for (const t of REFLEX_MANAGER_EXTRA_TOOLS) set.add(t);
  }
  return set;
}

/** Distillation extras beyond reflex (LEARNING-LOOP §2.2 / AGENT-RUNTIME §2.2.1). */
export const DISTILLATION_EXTRA_TOOLS = [
  'memory_update',
  'memory_update_longterm',
  'file_write',
  'file_edit',
  'package_list',
  'package_install',
] as const;

/** Reflex + encode/install tools for post-task distillation. */
export function getDistillationAllowlist(isManager: boolean): Set<string> {
  const set = getReflexAllowlist(isManager);
  for (const t of DISTILLATION_EXTRA_TOOLS) set.add(t);
  return set;
}

/**
 * Task-execution extras beyond the converse base (AGENT-RUNTIME §2.3).
 *
 * `task_execution` is the one scenario whose prompt *mandates* tools that the
 * keyword-driven selector cannot be relied on to surface: `background_exec`
 * ("run builds and tests via background_exec — continue other subtasks while
 * waiting") is in no tool group (the `shell` group carries `shell_execute`
 * only, and it is not in {@link TOOL_DEF_CORE_KEEP}), and `deliverable_create`
 * ("register key outputs via deliverable_create") is discover-only for
 * converse. Without this list the prompt tells the model to call tools that
 * never reach its schema.
 */
export const TASK_EXECUTION_EXTRA_TOOLS = [
  'background_exec',
  'process',
  'deliverable_create',
  'goal_create',
  'goal_status',
  'goal_update',
] as const;

/**
 * Tools an entity-bound **action** scenario is allowed to call.
 *
 * These scenarios are `converse` pack (so they do not get the execute pack's
 * keyword-independent tool set) yet their prompt gives hard mandates —
 * e.g. `requirement_action` says "**MANDATORY**: before deciding, call
 * `requirement_get`" and "you MUST call at least one action tool" listing
 * `requirement_update_status`; `workflow_action` says "use `workflow_status`"
 * / "`workflow_cancel`". None of those names is in {@link BASE_TOOL_NAMES} or
 * {@link TOOL_DEF_CORE_KEEP}, and there is no `requirement`/`workflow` tool
 * group, so they were unreachable — the model had to burn a turn on
 * `discover_tools` (or fail) before it could obey its own instructions.
 *
 * Same contract as `HEARTBEAT_ALLOWED_TOOLS` / `DELIBERATION_ALLOWED_TOOLS`:
 * the set is authoritative, and `agent.ts` unions it into the selected schema.
 */
export const COMMENT_RESPONSE_ALLOWED_TOOLS: readonly string[] = [
  'task_get', 'requirement_get', 'task_list', 'requirement_list',
  'task_comment', 'requirement_comment',
  'task_update', 'task_note', 'requirement_update', 'requirement_update_status',
  'subtask_create', 'subtask_complete', 'subtask_cancel', 'subtask_list',
  'task_submit_review',
  'file_read', 'grep_search', 'glob_find', 'list_directory',
  'deliverable_search', 'deliverable_create',
  'memory_search', 'memory_save',
  'notify_user', 'agent_send_message',
];

export const REQUIREMENT_ACTION_ALLOWED_TOOLS: readonly string[] = [
  'requirement_get', 'requirement_list', 'requirement_comment',
  'requirement_update', 'requirement_update_status', 'requirement_resubmit',
  'task_create', 'task_list', 'task_get', 'task_update',
  'subtask_create', 'subtask_complete', 'subtask_list',
  'deliverable_search', 'deliverable_create',
  'file_read', 'grep_search',
  'memory_search', 'memory_save', 'update_notebook',
  'notify_user', 'agent_send_message',
];

export const WORKFLOW_ACTION_ALLOWED_TOOLS: readonly string[] = [
  'workflow_list', 'workflow_status', 'workflow_get',
  'workflow_run', 'workflow_cancel', 'workflow_update', 'workflow_create',
  'task_get', 'task_list', 'task_update', 'task_comment', 'task_note',
  'subtask_list',
  'deliverable_search', 'deliverable_list',
  'file_read', 'grep_search',
  'memory_search', 'memory_save',
  'notify_user', 'agent_send_message',
];

/** Scenario → authoritative allowed-tool set (authoritative union in agent.ts). */
export const SCENARIO_ALLOWED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  comment_response: COMMENT_RESPONSE_ALLOWED_TOOLS,
  requirement_action: REQUIREMENT_ACTION_ALLOWED_TOOLS,
  workflow_action: WORKFLOW_ACTION_ALLOWED_TOOLS,
};

export type ToolDefLike = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** Rough token estimate for tool JSON (chars / 3.5). */
export function estimateToolDefTokens(tools: ToolDefLike[]): number {
  if (!tools.length) return 0;
  return Math.ceil(JSON.stringify(tools).length / 3.5);
}

/**
 * Evict tools until under budget.
 * Order: skill/MCP tools first (largest among them), then other non-core,
 * then non-protected core as last resort. Never evict `protectedNames`.
 */
export function evictToolsToBudget(
  tools: ToolDefLike[],
  budget: number,
  protectedNames: Set<string> = TOOL_DEF_PROTECTED,
  coreKeep: Set<string> = TOOL_DEF_CORE_KEEP,
): { tools: ToolDefLike[]; evicted: Array<{ name: string; description: string }> } {
  const current = [...tools];
  const evicted: Array<{ name: string; description: string }> = [];

  const sizeOf = (t: ToolDefLike) => JSON.stringify(t).length;

  const pickVictim = (predicate: (t: ToolDefLike) => boolean): number => {
    let victimIdx = -1;
    let victimSize = -1;
    for (let i = 0; i < current.length; i++) {
      const t = current[i]!;
      if (protectedNames.has(t.name)) continue;
      if (!predicate(t)) continue;
      const sz = sizeOf(t);
      if (sz > victimSize) {
        victimSize = sz;
        victimIdx = i;
      }
    }
    return victimIdx;
  };

  while (estimateToolDefTokens(current) > budget && current.length > 0) {
    // 1) Skill/MCP namespaces first — these flooded converse and deferred shell/file
    let victimIdx = pickVictim((t) => isSkillOrMcpToolName(t.name));
    // 2) Other non-core
    if (victimIdx < 0) {
      victimIdx = pickVictim((t) => !coreKeep.has(t.name));
    }
    // 3) Last resort: largest non-protected (may include core)
    if (victimIdx < 0) {
      victimIdx = pickVictim(() => true);
    }
    if (victimIdx < 0) break; // only protected left
    const [victim] = current.splice(victimIdx, 1);
    if (victim) {
      evicted.push({
        name: victim.name,
        description: (victim.description || '').slice(0, 60),
      });
    }
  }

  return { tools: current, evicted };
}

/**
 * Format evicted tools as a short Tier-3 catalog (Afford.S2).
 * Name-only preferred; optional ≤40 char blurb. Hard-capped by DEFERRED_CATALOG_MAX_CHARS.
 */
export function formatEvictedToolCatalog(
  evicted: Array<{ name: string; description: string }>,
  maxChars?: number,
): string {
  const cap = maxChars ?? 1_500;
  if (!evicted.length) return '';
  const header = [
    '\n## Deferred Tools (schemas omitted for budget)',
    'Core platform tools (shell/files/tasks/memory) stay LIVE above. These entries are optional extras — call `discover_tools({ name: ["tool-or-skill"] })` only when you need one.',
  ].join('\n');
  const lines: string[] = [];
  let used = header.length;
  for (const e of evicted) {
    const blurb = (e.description || '').trim().slice(0, 40);
    const line = blurb ? `- \`${e.name}\`: ${blurb}` : `- \`${e.name}\``;
    if (used + 1 + line.length > cap) break;
    lines.push(line);
    used += 1 + line.length;
  }
  if (!lines.length) {
    // At least list names comma-separated under the header budget
    const names = evicted.map((e) => e.name).join(', ');
    return `${header}\n${names}`.slice(0, cap);
  }
  return [header, ...lines].join('\n');
}
