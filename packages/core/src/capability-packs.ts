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
  'spawn_subagents',
  'deliverable_create',
]);

/** Tools that must never be evicted for budget. */
export const TOOL_DEF_PROTECTED = new Set([
  'discover_tools',
  'notify_user',
  'request_user_input',
  'request_user_approval',
]);

export function scenarioToPack(scenario: string | undefined): CapabilityPack {
  switch (scenario) {
    case 'heartbeat':
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
 * Evict largest non-protected tools until under budget.
 * Returns remaining tools + catalog of evicted names for discover.
 */
export function evictToolsToBudget(
  tools: ToolDefLike[],
  budget: number,
  protectedNames: Set<string> = TOOL_DEF_PROTECTED,
): { tools: ToolDefLike[]; evicted: Array<{ name: string; description: string }> } {
  let current = [...tools];
  const evicted: Array<{ name: string; description: string }> = [];

  const sizeOf = (t: ToolDefLike) => JSON.stringify(t).length;

  while (estimateToolDefTokens(current) > budget && current.length > 0) {
    let victimIdx = -1;
    let victimSize = -1;
    for (let i = 0; i < current.length; i++) {
      const t = current[i]!;
      if (protectedNames.has(t.name)) continue;
      // Prefer evicting non-core (not in reflex core) large schemas
      const sz = sizeOf(t);
      if (sz > victimSize) {
        victimSize = sz;
        victimIdx = i;
      }
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
    'Call `discover_tools({ name: ["tool-name"] })` to load a schema before use.',
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
