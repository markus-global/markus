/**
 * 右栏「本地文件」的刷新机制已被移除 —— 这道守卫钉住的是**行为**，不是源码文本。
 *
 * ── 为什么需要这道守卫 ──────────────────────────────────────────────────────
 *
 * Owner 判定右栏「手动刷新按钮 + 自动刷新开关」是多余控件，要求连同其背后的
 * 每 5s stat 轮询一并删除。这类删减有两个半途而废的典型死法，且**都不会让任何
 * 既有测试变红**：
 *
 *   ① 只删 UI 控件，留下 `autoRefresh` state 与 5s `setInterval` —— 用户看不见，
 *      但后台仍在每 5 秒打一次 `/api/files/stat`（面板开着就一直打）。
 *   ② 只删按钮，留下 `reloadNonce` 之类专为「刷新」存在的 state —— 成为永远不再
 *      变化、也永远无法被触发的幽灵机制。
 *
 * 所以这里断言两件可观测的事：
 *   • 渲染结果里**不存在**带 `aria-pressed` 的按钮（自动刷新开关是全组件唯一的
 *     切换按钮），也不存在标题含「刷新 / Refresh / Actualizar」的按钮；
 *   • 面板挂载后推进 15 秒（3 个轮询周期），`api.files.stat` **一次都不被调用**。
 *
 * 谁把轮询或基线 stat 加回来，第二条立刻红；谁把两个控件加回来，第一条红。
 *
 * ⚠️ 定时器纪律：`vi.useFakeTimers()` 与 `waitFor` 混用在 vitest 下会互相等死
 * （waitFor 内部的 setTimeout 不再前进 → 10s 超时）。因此第一条用例用真实定时器，
 * 第二条才装假定时器，并且用 `shouldAdvanceTime` 让微任务/内部轮询仍能推进。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';

const FILE = '/tmp/right-panel-fixture/report.md';

const fileStat = vi.fn(async () => ({ exists: true, path: FILE, mtimeMs: 1, size: 10 }));
const filePreview = vi.fn(async () => ({
  type: 'markdown',
  name: 'report.md',
  path: FILE,
  content: '# 右栏预览内容',
}));

vi.mock('../api.ts', () => ({
  api: {
    files: {
      preview: (...args: unknown[]) => filePreview(...(args as [])),
      stat: (...args: unknown[]) => fileStat(...(args as [])),
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

import { RightPanel } from './RightPanel.tsx';

function renderFilePanel() {
  return render(
    <RightPanel
      payload={{ kind: 'file', path: FILE, title: 'report.md' }}
      onClose={() => {}}
      width={480}
      onResizeStart={() => {}}
    />,
  );
}

describe('右栏本地文件 —— 刷新机制已移除', () => {
  beforeEach(() => {
    fileStat.mockClear();
    filePreview.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('不渲染「刷新」按钮与「自动刷新」开关，且预览本身仍能正常加载', async () => {
    const { container } = renderFilePanel();

    // 预览仍然工作（证明删掉的是刷新入口，不是预览能力）。
    await waitFor(() => {
      expect(container.textContent).toContain('右栏预览内容');
    });
    expect(filePreview).toHaveBeenCalledWith(FILE);

    // 操作区是刷新控件原来唯一的位置 —— 在这里断言，不受可选 props（panelMode 切换等）影响。
    const actions = container.querySelector('[data-panel-actions]');
    expect(actions).not.toBeNull();

    // 自动刷新开关是该区域唯一的 aria-pressed 切换按钮 → 现在一个都不该有。
    expect(actions!.querySelectorAll('[aria-pressed]')).toHaveLength(0);

    // 「刷新」按钮（中 / 英 / 西三语任一）都不该出现。
    const buttons = Array.from(actions!.querySelectorAll('button'));
    const refreshTitled = buttons.filter((b) => {
      const label = `${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''}`;
      return /刷新|Refresh|Actualizar|自动刷新|Auto-refresh|Auto-actualizar/i.test(label);
    });
    expect(refreshTitled).toHaveLength(0);
  });

  it('打开后 15 秒内不再发起任何 stat 轮询（5s 定时器已删除）', async () => {
    // shouldAdvanceTime 让 act()/内部 await 仍能推进，同时保留显式快进能力。
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { container } = renderFilePanel();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // 前置断言：面板确实挂载并完成了预览取数 —— 否则「没有 stat」可能只是没渲染。
    expect(container.textContent).toContain('右栏预览内容');

    // 只统计挂载之后发生的调用。
    fileStat.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(fileStat).not.toHaveBeenCalled();
  });
});
