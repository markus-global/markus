/**
 * 右栏新建标签按钮「钉住」契约（Owner 2026-11-28 反馈）。
 *
 * 现象：新建按钮原本是标签条滚动容器的**最后一个子节点**，标签一多就被一起推出
 * 视口，必须横向滚到最右才点得到。
 *
 * 这里不用 className 断言（换个 class 就失效），而是断言**节点归属**：
 *  - 新建按钮不能是 `[role="tablist"]`（滚动容器）的后代 —— 只要它在里面，
 *    浏览器就有机会把它滚走；这是结构约束，不是样式约定。
 *  - 它与滚动容器是兄弟关系，因此横向滚动永远动不了它。
 *  - 点击仍然触发 onNewTab（钉住不等于失能）。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

vi.mock('../src/api.ts', () => ({
  api: {
    files: {
      preview: async () => ({ type: 'text', name: 'a.txt', path: '/tmp/a.txt', content: '' }),
      stat: async () => ({ exists: true, path: '/tmp/a.txt', mtimeMs: 1, size: 1 }),
      check: async () => ({ results: {} }),
      reveal: async () => ({}),
      streamUrl: (p: string) => `/api/files/stream?path=${encodeURIComponent(p)}`,
    },
    browser: { tabOwnership: async () => ({ ownership: [] }) },
    terminal: { sessionOwnership: async () => ({ ownership: [] }) },
    deliverables: { update: async () => ({}) },
  },
  wsClient: { on: () => () => {} },
  getHubToken: async () => null,
  hubApi: { getUrl: () => 'http://127.0.0.1:1/hub' },
}));

import { RightPanel, type RightPanelTab } from '../src/components/RightPanel.tsx';

function buildTabs(n: number): RightPanelTab[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `tab-${i}`,
    title: `tab-${i}.md`,
    payload: { kind: 'file' as const, path: `/tmp/tab-${i}.md`, title: `tab-${i}.md` },
  }));
}

function renderPanel(tabs: RightPanelTab[], onNewTab = vi.fn()) {
  const utils = render(
    <RightPanel
      payload={tabs[0].payload}
      onClose={() => {}}
      width={480}
      onResizeStart={() => {}}
      tabs={tabs}
      activeTabId={tabs[0].id}
      onSelectTab={() => {}}
      onCloseTab={() => {}}
      onNewTab={onNewTab}
    />,
  );
  return { ...utils, onNewTab };
}

describe('右栏新建标签按钮 — 不随标签滚动', () => {
  it('标签很多时，新建按钮仍挂在滚动容器之外（滚动动不了它）', () => {
    const { container } = renderPanel(buildTabs(9));

    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();

    const newTabBtn = container.querySelector('[title="New Tab"]');
    expect(newTabBtn).not.toBeNull();

    // 核心断言：不是滚动容器的后代 —— 只要在 tablist 里，标签够多就会被滚出视口。
    expect(tablist!.contains(newTabBtn!)).toBe(false);

    // 与滚动容器同级：同一个父节点下，滚的是标签，不是按钮。
    expect(newTabBtn!.parentElement?.parentElement).toBe(tablist!.parentElement);
  });

  it('滚动容器本身就装在标签区（结构：行 = 可滚动标签 + 固定按钮）', () => {
    const { container } = renderPanel(buildTabs(3));

    const tablist = container.querySelector('[role="tablist"]')!;
    const anchor = container.querySelector('[data-tab-new-tab]')!;
    expect(anchor).toBe(anchor);
    // 两者共享同一个行容器；该行容器没有 overflow，所以钉住的效果由结构保证。
    const row = tablist.parentElement!;
    expect(row.contains(anchor)).toBe(true);
    expect(row.className).not.toContain('overflow-x-auto');
  });

  it('滚动轨道脱离文档流，标签行保持垂直居中', async () => {
    const { container } = renderPanel(buildTabs(9));
    const strip = container.querySelector('[role="tablist"]') as HTMLElement;

    // happy-dom 没有布局引擎（scrollWidth/clientWidth 恒 0），这里只伪造出「有溢出」
    // 让轨道挂载；断言的是 **布局承诺**（脱离文档流 + 行居中），几何量在真实浏览器里看。
    Object.defineProperty(strip, 'scrollWidth', { value: 600, configurable: true });
    Object.defineProperty(strip, 'clientWidth', { value: 200, configurable: true });
    await act(async () => {
      strip.dispatchEvent(new Event('scroll'));
    });

    const rail = document.querySelector('[data-tab-scroll-rail]');
    expect(rail).not.toBeNull();

    // ① 轨道必须脱离文档流：留在流内就会占走高度，把标签行挤出垂直中线
    //    （无溢出时最刺眼：标签底边直接贴住 header 分隔线 — Owner 2026-11-28 反馈）。
    const railHolder = rail!.parentElement!;
    expect(railHolder.className).toContain('absolute');
    expect(railHolder.className).toContain('pointer-events-none');
    // 轨道自身仍然可拖（父层 pointer-events-none 不能把它一起关掉）。
    expect(rail!.className).toContain('pointer-events-auto');

    // ② 标签行由居中决定位置，不是被“顶到底部”。
    const column = strip.parentElement!.parentElement!;
    expect(column.className).toContain('justify-center');
    expect(column.className).not.toContain('justify-end');
  });

  it('钉住之后点击依然生效', () => {
    const { container, onNewTab } = renderPanel(buildTabs(2));

    const newTabBtn = container.querySelector('[title="New Tab"]')!;
    fireEvent.click(newTabBtn);
    expect(onNewTab).toHaveBeenCalledTimes(1);
  });
});
