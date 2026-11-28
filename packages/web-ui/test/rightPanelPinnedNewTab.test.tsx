/**
 * 右栏新建标签按钮 — 「贴标签 / 溢出后钉右缘」契约（Owner 2026-11-28 两轮反馈）。
 *
 * 要的行为（浏览器同款）：
 *   · 标签没占满 —— 按钮就是标签条里的普通行内元素，紧贴最后一个标签，靠左；
 *   · 标签占满开始滚动 —— 按钮钉在滚动视口右缘，永远点得到；
 *   · 溢出时标签从按钮底下穿过 —— 按钮必须有不透明背景，否则两层叠字。
 *
 * happy-dom 没有布局引擎，sticky 的真实钉边效果测不出来（几何量由
 * `test/tabStripScroll.test.ts` 用纯函数钉住滚动量）。这里钉的是**布局承诺**：
 * 按钮在标签条内（所以能贴着标签）、声明 `sticky right-0`（所以溢出时不会被滚走）、
 * 且不透明（所以穿过去时不糊）。任一处被改回去，这些断言就红。
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

// happy-dom 15 没有实现 Element.scrollBy（真实浏览器有）；组件的『把活跃标签滚进可见区』
// 会调它。不补的话 rAF 里抛 TypeError 会变成 unhandled error —— 环境缺口不该污染断言。
if (typeof Element.prototype.scrollBy !== 'function') {
  Element.prototype.scrollBy = (() => {}) as typeof Element.prototype.scrollBy;
}

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

describe('右栏新建标签按钮 — 平时贴标签，溢出才钉右缘', () => {
  it('按钮在标签条内部，紧跟最后一个标签（所以贴着标签，而不是被排到最右）', () => {
    const { container } = renderPanel(buildTabs(3));

    const tablist = container.querySelector('[role="tablist"]')!;
    const anchor = container.querySelector('[data-tab-new-tab]')!;
    const newTabBtn = container.querySelector('[title="New Tab"]')!;

    // 在标签条内 ⇒ 行内自然位置就在最后一个标签之后。
    expect(tablist.contains(newTabBtn)).toBe(true);
    // 且是标签条里最后一个「行」—— 后面没有别的标签把它顶开。
    expect(tablist.lastElementChild).toBe(anchor);
  });

  it('溢出时钉在右缘：sticky right-0 + 不透明背景（标签会从它底下穿过）', () => {
    const { container } = renderPanel(buildTabs(9));

    const anchor = container.querySelector('[data-tab-new-tab]') as HTMLElement;
    expect(anchor.className).toContain('sticky');
    expect(anchor.className).toContain('right-0');
    expect(anchor.className).toContain('shrink-0');
    // 不透明：否则溢出时滑过的标签会和按钮叠在一起。
    expect(anchor.className).toContain('bg-surface-primary');
  });

  it('钉住之后点击依然生效', () => {
    const { container, onNewTab } = renderPanel(buildTabs(2));

    fireEvent.click(container.querySelector('[title="New Tab"]')!);
    expect(onNewTab).toHaveBeenCalledTimes(1);
  });
});

describe('右栏滚动轨道 — 不参与标签行布局', () => {
  it('轨道脱离文档流，标签行保持垂直居中', async () => {
    const { container } = renderPanel(buildTabs(9));
    const strip = container.querySelector('[role="tablist"]') as HTMLElement;

    // happy-dom 没有布局引擎（scrollWidth/clientWidth 恒 0），这里只伪造出「有溢出」
    // 让轨道挂载；断言的是布局承诺，几何量在真实浏览器里看。
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
    const column = strip.parentElement!;
    expect(column.className).toContain('justify-center');
    expect(column.className).not.toContain('justify-end');
  });
});
