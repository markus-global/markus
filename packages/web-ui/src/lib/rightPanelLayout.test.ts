import { describe, it, expect } from 'vitest';
import {
  CHAT_MIN_W,
  rightPanelMaxWidth,
  railsActionOnPanelTransition,
} from './rightPanelLayout.ts';

/**
 * 这里只钉「拖拽上限」和「侧栏跃迁」。**40/60 的分栏比例不在这里** —— 它已经
 * 交给 flex 行自己保证（Team.tsx: 聊天 `flex-[4_1_0%]` / RightPanel `grow-[6]`）。
 *
 * 为什么搬走：比例曾经由 JS 用「量出来的容器宽 − 侧栏宽」算，实测在真实应用里
 * 这两个输入都是错的（2026-11-27：右侧栏渲染 558px，而公式认为 670px，反解出的
 * 共享空间比真实值少 188px）→ 输入错，比例就悄悄错。布局引擎算出来的比例不会
 * 和屏幕不一致。
 */
describe('rightPanelMaxWidth — 拖拽上限保住聊天底线', () => {
  it('leaves the chat its floor (400px) once the container can afford it', () => {
    expect(rightPanelMaxWidth(2000)).toBe(1600);
    expect(rightPanelMaxWidth(1000)).toBe(600);
    expect(2000 - rightPanelMaxWidth(2000)).toBeGreaterThanOrEqual(CHAT_MIN_W);
  });

  it('scales the reserve down to the chat 40% share on a narrow container', () => {
    expect(rightPanelMaxWidth(700)).toBe(420); // chat keeps 280 = 40%, not 400
    expect(700 - rightPanelMaxWidth(700)).toBe(280);
  });

  it('never returns a negative or overflowing cap', () => {
    for (let space = 0; space <= 4000; space += 25) {
      const cap = rightPanelMaxWidth(space);
      expect(cap).toBeGreaterThanOrEqual(0);
      expect(cap).toBeLessThanOrEqual(space);
    }
    expect(rightPanelMaxWidth(-50)).toBe(0);
  });
});

describe('railsActionOnPanelTransition', () => {
  it('collapses the rails when the panel opens', () => {
    expect(railsActionOnPanelTransition(false, true, null)).toBe('collapse');
  });

  it('restores the rails when the panel closes if they were open before it took the space', () => {
    expect(railsActionOnPanelTransition(true, false, false)).toBe('restore');
  });

  it('leaves the rails collapsed if the user had already collapsed them (Cmd+B)', () => {
    expect(railsActionOnPanelTransition(true, false, true)).toBe('none');
    expect(railsActionOnPanelTransition(true, false, null)).toBe('none');
  });

  it('does nothing without a transition — a manual toggle is never fought', () => {
    expect(railsActionOnPanelTransition(false, false, null)).toBe('none');
    expect(railsActionOnPanelTransition(false, false, true)).toBe('none');
    expect(railsActionOnPanelTransition(true, true, false)).toBe('none');
    expect(railsActionOnPanelTransition(true, true, true)).toBe('none');
  });
});
