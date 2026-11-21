/**
 * 回归：工作实体（任务/子任务）生命周期工具必须恒在工具面。
 *
 * 事故（2026-10-13，tsk_5c5e70521395658de9149062 / tsk_3049533cc2236ff3e788c042）：
 * 任务执行反复「中断 → 自动重试」。根因：当时的预算淘汰器按 schema 体积驱逐，
 * `task_submit_review` 等生命周期工具被驱逐出 schema，而任务执行提示词**强制**
 * 要求调用它 → 回合被判「未提交」→ 平台自动重试 → 风暴。
 *
 * 历史修复：生命周期工具并入 TOOL_DEF_PROTECTED（免驱逐）。
 * 终态（Owner 2026-11-20，PR #471）：预算驱逐机制整体删除——工具面是固定段，
 * 上下文压力压缩历史而非工具面。本套件锁的是终态不变量：无论工具面多大，
 * 生命周期工具一个都不少，诱饵也不丢弃。
 */
import { describe, it, expect } from 'vitest';
import {
  TOOL_DEF_PROTECTED,
  EXECUTE_SESSION_ONLY_TOOLS,
} from '../src/capability-packs.js';
import { ToolSelector } from '../src/tool-selector.js';

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

type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

function big(name: string): ToolDef {
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

describe('任务生命周期工具恒在工具面（任务反复中断根因回归）', () => {
  it('TOOL_DEF_PROTECTED ⊇ 工作实体生命周期工具（防清单漂移）', () => {
    for (const n of EXECUTE_SESSION_ONLY_TOOLS) {
      expect(TOOL_DEF_PROTECTED.has(n), `未保护 ${n}`).toBe(true);
    }
  });

  it('execute 包全链路：超大工具面下生命周期工具与诱饵一个都不少', () => {
    const small = (name: string): ToolDef => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    });
    const allTools = new Map<string, ToolDef>();
    for (const n of [
      ...LIFECYCLE,
      'task_get', 'task_list', 'task_create', 'task_update', 'task_comment',
      'requirement_get', 'shell_execute', 'file_read', 'discover_tools',
      'notify_user', 'request_user_input', 'background_exec', 'process', 'deliverable_create',
    ]) {
      allTools.set(n, small(n));
    }
    // 大 schema 诱饵：把工具面撑到远超任何旧预算的量级。
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
    // 生命周期工具也用大 schema，复刻当年它们被淘汰的场景。
    for (const n of LIFECYCLE) allTools.set(n, big(n));

    const selector = new ToolSelector();
    const face = selector.selectTools({
      allTools,
      userMessage: 'execute the task',
      pack: 'execute',
      scenario: 'task_execution',
      isTaskExecution: true,
      recentToolNames: recent,
    });
    const names = face.map((t) => t.name);
    // 压力自证：工具面确实远超旧 execute 预算（10k tokens）。
    expect(Math.ceil(JSON.stringify(face).length / 3.5)).toBeGreaterThan(10_000);
    expect(names).toContain('task_submit_review');
    expect(names).toContain('subtask_create');
    expect(names).toContain('subtask_complete');
    expect(names).toContain('subtask_cancel');
    // 终态不变量：没有任何工具因体积被丢弃——诱饵也全部存活。
    for (const n of recent) expect(names, n).toContain(n);
  });
});
