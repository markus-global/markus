/**
 * 右侧栏「选中」视觉语言一致性（Owner 2026-11-28）：
 *
 *   浏览器 / 命令行模式按钮的选中态是**品牌色底**；标签页的选中态原本是**中性灰底**。
 *   同一行 chrome 里两套「我被选中了」的暗示，看着就是不一致。
 *
 * 这里钉的不是某个色值好看不好看，而是**两边必须是同一个 token**：
 * 从两处 className 里各抽出品牌底色类，断言字符串相等。只改一边 → 立刻红。
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

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

const tabs: RightPanelTab[] = [
  { id: 'tab-0', title: 'a.md', payload: { kind: 'file', path: '/tmp/a.md', title: 'a.md' } },
  { id: 'tab-1', title: 'b.md', payload: { kind: 'file', path: '/tmp/b.md', title: 'b.md' } },
];

/** 抽出「品牌底色」类，例如 bg-brand-500/15 —— 选中态的颜色口径就是它。 */
function brandTint(className: string): string | null {
  return className.match(/bg-brand-500\/\d+/)?.[0] ?? null;
}

function renderPanel() {
  return render(
    <RightPanel
      payload={tabs[1].payload}
      onClose={() => {}}
      width={480}
      onResizeStart={() => {}}
      tabs={tabs}
      activeTabId="tab-1"
      onSelectTab={() => {}}
      onCloseTab={() => {}}
      onNewTab={() => {}}
      panelMode="browser"
      onPanelModeChange={() => {}}
    />,
  );
}

describe('右侧栏选中态 — 标签与模式按钮同色', () => {
  it('选中的标签与选中的模式按钮使用同一个品牌底色 token', () => {
    const { container } = renderPanel();

    const activeTab = container.querySelector('[role="tab"][aria-selected="true"]')!.parentElement!;
    const pressedMode = container.querySelector('[aria-pressed="true"]')!;

    const tabTint = brandTint(activeTab.className);
    const modeTint = brandTint(pressedMode.className);

    // 两边都必须有品牌底色（不能退化成中性灰）。
    expect(tabTint).not.toBeNull();
    expect(modeTint).not.toBeNull();
    // 核心：同一个 token。改一边不改另一边 → 这里就不相等。
    expect(tabTint).toBe(modeTint);
  });

  it('未选中的标签不带品牌底色（选中态才该有颜色）', () => {
    const { container } = renderPanel();
    const inactive = container.querySelector('[role="tab"][aria-selected="false"]')!.parentElement!;
    expect(brandTint(inactive.className)).toBeNull();
  });
});
