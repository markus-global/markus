import { describe, it, expect } from 'vitest';
import { computeRailGeometry } from '../src/components/TabScrollRail.tsx';

/**
 * 口径锁定：轨道几何是纯函数，刻意与 DOM 解耦。
 *
 * 为什么不在 happy-dom 里断言真实布局 —— happy-dom 不做排版，`scrollWidth` /
 * `clientWidth` 恒为 0，写出来的「断言」只会绿得毫无意义（仓库里已有此类假绿教训）。
 * 真正依赖排版的几何在浏览器里验证；这里锁定的是**数学**：
 * 可见门槛、缩略块比例、最小可抓取宽度、以及「缩略块永不越出轨道」的边界夹取。
 */
describe('computeRailGeometry', () => {
  it('无溢出时不渲染轨道', () => {
    const g = computeRailGeometry({ left: 0, width: 400, viewport: 400 });
    expect(g.visible).toBe(false);
    expect(g.overflow).toBe(0);
  });

  it('内容比视口窄时同样不渲染（浮点残差不算溢出）', () => {
    expect(computeRailGeometry({ left: 0, width: 399.5, viewport: 400 }).visible).toBe(false);
  });

  it('有溢出时可见，并给出正确的溢出量与比例', () => {
    const g = computeRailGeometry({ left: 50, width: 1000, viewport: 500 });
    expect(g.visible).toBe(true);
    expect(g.overflow).toBe(500);
    expect(g.widthPct).toBeCloseTo(50, 5); // 视口占内容的一半
    expect(g.leftPct).toBeCloseTo(5, 5); // 滚到 50/1000
  });

  it('缩略块最小宽度 8%：内容极长时仍可抓取', () => {
    const g = computeRailGeometry({ left: 0, width: 100_000, viewport: 400 });
    expect(g.visible).toBe(true);
    expect(g.widthPct).toBe(8); // 原始 0.4% 被抬到下限
  });

  it('滚到最右端时缩略块右缘正好贴住轨道末端（不越界）', () => {
    const width = 1000;
    const viewport = 500;
    const g = computeRailGeometry({ left: width - viewport, width, viewport });
    expect(g.leftPct + g.widthPct).toBeCloseTo(100, 5);
  });

  it('触发最小宽度夹取时，滚到最右端仍不越界', () => {
    const width = 100_000;
    const viewport = 400;
    const g = computeRailGeometry({ left: width - viewport, width, viewport });
    expect(g.leftPct).toBeCloseTo(100 - 8, 5); // 夹到 100 - widthPct
    expect(g.leftPct + g.widthPct).toBeCloseTo(100, 5);
  });

  it('越界 / 回弹的 scrollLeft 不会把缩略块推到负位', () => {
    const g = computeRailGeometry({ left: -30, width: 1000, viewport: 500 });
    expect(g.leftPct).toBe(0);
  });

  it('退化输入（宽度为 0）不渲染，避免除零', () => {
    expect(computeRailGeometry({ left: 0, width: 0, viewport: 0 }).visible).toBe(false);
    expect(computeRailGeometry({ left: 0, width: 500, viewport: 0 }).visible).toBe(false);
  });
});
