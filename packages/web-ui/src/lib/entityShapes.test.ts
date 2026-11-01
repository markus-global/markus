import { describe, it, expect } from 'vitest';
import { asStringList, normalizeRequirement, normalizeDeliverable } from './entityShapes.ts';

/**
 * 与服务端 `packages/shared/src/utils/tags.ts#toStringArray` 同口径的守卫。
 *
 * 为什么前端需要自己有一份：桌面壳可能连着旧版后端（本次白屏事故就是包已装、
 * 服务未重建）。归一化必须在渲染前把形状定下来，否则 `.join()` 直接抛错 →
 * React 卸载整棵树 → 白屏。
 */
describe('asStringList — 任意存储形态都必须收敛成 string[]', () => {
  it('三种历史编码都能读出原来的标签', () => {
    expect(asStringList(['a', 'b'])).toEqual(['a', 'b']);
    expect(asStringList('"内容运营,工作流,Easel"')).toEqual(['内容运营', '工作流', 'Easel']);
    expect(asStringList('{"item":["Q3","Skills生态"]}')).toEqual(['Q3', 'Skills生态']);
    expect(asStringList('前端, UX优化')).toEqual(['前端', 'UX优化']);
  });

  it('空值与无标签载荷返回空数组，而不是 null', () => {
    for (const v of [null, undefined, '', '[]', 0, false, {}, { a: 1, b: 2 }]) {
      expect(asStringList(v)).toEqual([]);
    }
  });

  it('永不返回非数组——这是它能挡住白屏的唯一理由', () => {
    const inputs: unknown[] = ['["a"]', '"a"', 'a', '{"item":["a"]}', ['a'], 0, {}, [[]], [{ x: 1 }]];
    for (const input of inputs) expect(Array.isArray(asStringList(input))).toBe(true);
  });
});

describe('实体归一 — 渲染路径拿到的字段已经是声明类型', () => {
  it('需求：脏 tags 被收敛，taskIds 不会变成 undefined', () => {
    // 模拟旧版后端：tags 是字符串、taskIds 缺失
    type Req = { id: string; title: string; tags: string[]; taskIds: string[] };
    const r = normalizeRequirement({ id: 'req_1', tags: '"a,b"', title: 't' } as unknown as Req);
    expect(r.tags).toEqual(['a', 'b']);
    expect(r.taskIds).toEqual([]);
    // 这正是白屏那一行代码，现在必须能跑
    expect(() => r.tags.join(', ')).not.toThrow();
  });

  it('产出物：tags 同样收敛', () => {
    type Dlv = { id: string; tags: string[] };
    expect(normalizeDeliverable({ id: 'dlv_1', tags: { item: ['x'] } } as unknown as Dlv).tags).toEqual(['x']);
  });
});
