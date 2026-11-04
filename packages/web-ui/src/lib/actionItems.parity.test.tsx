/**
 * 判据「**API 返回的 id 序列 == 概览首屏渲染的 id 序列**」的前端一半。
 *
 * 服务端那一半在 `packages/org-manager/test/threads-order-parity.test.ts`。
 * 两侧读**同一份**夹具并断言**同一条** `expectedIds`（手写的契约期望序）：
 *
 *   · 服务端擅自改排序 → org-manager 侧红；
 *   · 前端擅自再排一次（历史上 ActionCenter 的 `sortActions` + 优先级权重表）→ 这里红；
 *   · 两侧各改各的 → 至少一侧红。
 *
 * 断言的是**真实渲染出来的首屏顺序**（`[data-action-id]` 的结构标记），不是「函数返回了
 * 某个数组」—— 否则「组件里又排了一次」这种回归会漏过去，而那正是这次要修的东西。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ActionCenter } from '../components/ActionCenter.tsx';
import { buildActionItems } from './actionItems.ts';
import { orderTodos } from './todoOrder.ts';
import type { ThreadAPI } from '../api.ts';

interface Fixture {
  todos: Array<{ id: string; stage: string; priority: string | null; lastActivity: number; title: string; ownerAgent: string }>;
  expectedIds: string[];
}

const FIXTURE: Fixture = JSON.parse(
  // 用 `process.cwd()`（vitest 从仓库根启动）而不是 `import.meta.url`：web-ui 项目跑在
  // happy-dom 里，`import.meta.url` 不保证是 `file:` scheme，`readFileSync(URL)` 会报
  // 「The URL must be of scheme file」—— 这条教训值得留着，别再踩第二次。
  readFileSync(resolve(process.cwd(), 'packages/shared/src/types/__fixtures__/todo-order-parity.json'), 'utf-8'),
);

/** 夹具行 → `ThreadAPI`（只填本条用例真正消费的字段）。 */
const asThreads = (): ThreadAPI[] =>
  FIXTURE.todos.map(t => ({
    id: t.id,
    ref: t.id,
    ownerAgent: t.ownerAgent,
    ownerSession: null,
    lastActivity: t.lastActivity,
    stage: t.stage,
    stageRank: 0,
    stageBasis: 'partial',
    missingFacts: [],
    taskStatus: null,
    title: t.title,
    detail: null,
    priority: t.priority,
  }));

describe('概览首屏序 == API 序（同一份夹具，同一条期望序）', () => {
  it('buildActionItems 只做映射，保持输入顺序（排序不是它的职责）', () => {
    // ① 喂「API 序」→ 输出就是 API 序
    const apiOrdered = orderTodos(asThreads());
    expect(buildActionItems(apiOrdered).map(i => i.id)).toEqual(FIXTURE.expectedIds);
    // ② 喂任意序（这里用倒序）→ 输出跟着同样倒过来，证明它没有自己再排一次。
    //    这条是防「组件/映射层偷偷排序」的关键断言：只看 ① 的话，一个内置排序也能绿。
    const reversed = [...asThreads()].reverse();
    expect(buildActionItems(reversed).map(i => i.id)).toEqual(reversed.map(t => t.id));
  });

  it('orderTodos 对已排好的 API 序列是幂等的（这是「两处一致」的结构前提）', () => {
    const ids = orderTodos(asThreads()).map(t => t.id);
    expect(ids).toEqual(FIXTURE.expectedIds);
  });

  it('真实渲染：行动台首屏的行顺序 == API 序列（逐条相等）', () => {
    const items = buildActionItems(asThreads());
    const { container } = render(<ActionCenter items={items} />);
    const rendered = [...container.querySelectorAll('[data-action-id]')].map(el => el.getAttribute('data-action-id'));
    expect(rendered).toEqual(FIXTURE.expectedIds);
  });

  it('把排序改坏（只按等待时长，丢掉 stage 与优先级）→ 首屏序立刻与 API 序分叉', () => {
    // 「测试能咬人」的自证：模拟一次真实回归形态 —— 曾经就是这么排的。
    const broken = [...asThreads()].sort((a, b) => a.lastActivity - b.lastActivity);
    expect(broken.map(t => t.id)).not.toEqual(FIXTURE.expectedIds);
  });
});
