/**
 * `activeTabScrollDelta` —— 新建按钮是 sticky 覆盖层时把活跃标签滚进**真正可见**区间。
 *
 * 为什么必须单独测：happy-dom 没有布局引擎，组件测试里测不到几何；而这条几何
 * 一旦算错，症状是「点了新建/切了标签，但标签停在 + 号底下看不见」——只能靠
 * 纯函数的边界值断言咬住。
 */
import { describe, it, expect } from 'vitest';
import { activeTabScrollDelta } from '../src/lib/tabStripScroll.ts';

const strip = { stripLeft: 0, stripRight: 300 };

describe('activeTabScrollDelta — 覆盖层右侧留量', () => {
  it('标签完全可见 → 不动', () => {
    expect(activeTabScrollDelta({ ...strip, tabLeft: 100, tabRight: 200, reserved: 0 })).toBe(0);
  });

  it('没有覆盖层时，标签被右缘切掉 → 向右滚到贴边', () => {
    const delta = activeTabScrollDelta({ ...strip, tabLeft: 250, tabRight: 340, reserved: 0 });
    expect(delta).toBe(44); // 340 - 300 + 4
  });

  it('有覆盖层（+ 按钮宽 30）时，用「可见右界」判定：300-30=270', () => {
    // 标签右缘 280：视觉上没超出视口，但被按钮盖住 → 必须滚。
    const delta = activeTabScrollDelta({ ...strip, tabLeft: 200, tabRight: 280, reserved: 30 });
    expect(delta).toBe(14); // 280 - 270 + 4
  });

  it('扣掉覆盖层后仍有余量 → 不动（避免无意义的抖动）', () => {
    expect(activeTabScrollDelta({ ...strip, tabLeft: 100, tabRight: 260, reserved: 30 })).toBe(0);
  });

  it('标签被滚到左边之外 → 向左滚回开头', () => {
    const delta = activeTabScrollDelta({ ...strip, tabLeft: -40, tabRight: 60, reserved: 30 });
    expect(delta).toBe(-44); // -40 - 0 - 4
  });

  it('标签左缘越过视口左缘 → 优先左对齐（保住标题开头）', () => {
    const delta = activeTabScrollDelta({ ...strip, tabLeft: 2, tabRight: 80, reserved: 30 });
    expect(delta).toBe(-2); // 2 - 0 - 4
  });

  it('宽标签且左缘已在视口内 → 对齐右缘（至少看得见结尾）', () => {
    const delta = activeTabScrollDelta({ ...strip, tabLeft: 10, tabRight: 400, reserved: 30 });
    expect(delta).toBe(134); // 400 - 270 + 4
  });

  it('自定义边缘留白只影响留量，不改判定方向', () => {
    expect(activeTabScrollDelta({ ...strip, tabLeft: 100, tabRight: 200, reserved: 0, edge: 0 })).toBe(0);
    expect(activeTabScrollDelta({ ...strip, tabLeft: 300, tabRight: 360, reserved: 0, edge: 0 })).toBe(60);
  });
});
