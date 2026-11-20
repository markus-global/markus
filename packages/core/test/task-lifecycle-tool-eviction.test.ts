/**
 * 回归：工作实体（任务/子任务）生命周期工具不得被 ToolDef 预算驱逐。
 *
 * 事故（2026-10-13，tsk_5c5e70521395658de9149062 / tsk_3049533cc2236ff3e788c042）：
 * 任务执行反复「中断 → 自动重试」。真实运行日志：
 *   [task-service] Task execution finished without task_submit_review — auto-retrying in 96s (attempt 3)
 *
 * 根因：`task_submit_review`（以及 subtask_* / task_note / task_assign）由
 * ToolSelector 在 execute 包被选中（tool-selector.ts 的 isTaskExecution 分支），
 * 但它们既不在 TOOL_DEF_PROTECTED，也不在 TOOL_DEF_CORE_KEEP 里 → 驱逐优先级
 * = 2（普通 builtin）→ 预算压力下被驱逐出 schema。而任务执行提示词**强制**要求
 * 调用 `task_submit_review`（"the round is NOT complete without it"）→ 模型被要求
 * 调用一个 schema 里不存在的工具 → 回合结束被判「未提交」→ 平台自动重试 → 风暴。
 *
 * 真实日志实证（runtime-2026-10-13.log，pack=execute budget=10000）：
 *   "evicted":[...,"task_submit_review",...,"subtask_cancel",...,"subtask_create",
 *              "subtask_complete",...,"task_note",...,"subtask_list","task_assign",...]
 *
 * 修复：把「工作实体生命周期工具」并入 TOOL_DEF_PROTECTED（驱逐 tier 0，永不驱逐）。
 * 不变量：**凡是提示词/流程强制要求调用的工具，绝不能被"按 schema 体积决定谁活下来"
 * 的预算淘汰器淘汰。**
 */
import { describe, it, expect } from 'vitest';
import {
  TOOL_DEF_PROTECTED,
  TOOL_DEF_CORE_KEEP,
  EXECUTE_SESSION_ONLY_TOOLS,
  evictToolsToBudget,
  toolEvictionTier,
  type ToolDefLike,
} from '../src/capability-packs.js';
import { ToolSelector } from '../src/tool-selector.js';
import { TOOL_DEF_BUDGET_EXECUTE } from '@markus/shared';

/** 任务执行流程必须能调到的生命周期工具。 */
const LIFECYCLE = [
  'task_submit_review',
  'task_note',
  'task_assign',
  'subtask_create',
  'subtask_complete',
  'subtask_cancel',
  'subtask_list',
];

function big(name: string): ToolDefLike {
  return {
    name,
    description: `${name} `.repeat(120),
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`f${i}`, { type: 'string', description: 'x'.repeat(60) }]),
      ),
    },
  };
}

describe('任务生命周期工具必须免驱逐（任务反复中断根因回归）', () => {
  it('每个生命周期工具都是 tier 0（永不驱逐）', () => {
    for (const n of LIFECYCLE) expect(toolEvictionTier(n), n).toBe(0);
  });

  it('TOOL_DEF_PROTECTED ⊇ 工作实体生命周期工具（防清单漂移）', () => {
    for (const n of EXECUTE_SESSION_ONLY_TOOLS) {
      expect(TOOL_DEF_PROTECTED.has(n), `未保护 ${n}`).toBe(true);
    }
  });

  it('evictToolsToBudget：预算压力下不驱逐生命周期工具（即便它们是最大的诱饵）', () => {
    const defs: ToolDefLike[] = [
      { name: 'discover_tools', description: 'discover', inputSchema: { type: 'object', properties: {} } },
      { name: 'notify_user', description: 'notify', inputSchema: { type: 'object', properties: {} } },
      // 生命周期工具本身也是「大 schema」——制造与生产一致的驱逐压力
      ...LIFECYCLE.map(big),
      ...Array.from({ length: 20 }, (_, i) => big(`feishu_huge_${i}`)),
    ];
    const protectedNames = new Set<string>([...TOOL_DEF_PROTECTED, ...TOOL_DEF_CORE_KEEP]);
    const { tools: kept, evicted } = evictToolsToBudget(
      defs,
      TOOL_DEF_BUDGET_EXECUTE,
      protectedNames,
      TOOL_DEF_CORE_KEEP,
    );
    const keptNames = kept.map((t) => t.name);
    for (const n of LIFECYCLE) expect(keptNames, n).toContain(n);
    // 测试有效性自证：确实发生了驱逐（否则没测到驱逐路径）
    expect(evicted.some((e) => e.name.startsWith('feishu_huge_'))).toBe(true);
  });

  it('execute 包经 ToolSelector 全链路：预算压力下 task_submit_review 仍在 schema 里', () => {
    const small = (name: string) => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    });
    const allTools = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>();
    for (const n of [
      ...LIFECYCLE,
      'task_get', 'task_list', 'task_create', 'task_update', 'task_comment',
      'requirement_get', 'shell_execute', 'file_read', 'discover_tools',
      'notify_user', 'request_user_input', 'background_exec', 'process', 'deliverable_create',
    ]) {
      allTools.set(n, small(n));
    }
    // 大 schema 诱饵（small 名 + big schema）：确保总额撑爆 execute 预算
    const recent: string[] = [];
    for (let i = 0; i < 60; i++) {
      const n = `huge_builtin_${i}`;
      allTools.set(n, {
        name: n,
        description: `${n} `.repeat(80),
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 40 }, (_, k) => [`f${k}`, { type: 'string', description: 'y'.repeat(60) }]),
          ),
        },
      });
      recent.push(n);
    }
    // 生命周期工具也用「大 schema」，复刻生产中它们被淘汰的场景
    for (const n of LIFECYCLE) allTools.set(n, big(n));

    const selector = new ToolSelector();
    const names = selector
      .selectTools({
        allTools,
        userMessage: 'execute the task',
        pack: 'execute',
        scenario: 'task_execution',
        isTaskExecution: true,
        recentToolNames: recent,
      })
      .map((t) => t.name);

    expect(names).toContain('task_submit_review');
    expect(names).toContain('subtask_create');
    expect(names).toContain('subtask_complete');
    expect(names).toContain('subtask_cancel');
  });
});
