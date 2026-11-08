/**
 * 右栏「本地文件」自动刷新 —— 用**行为**钉住，不看源码文本。
 *
 * 契约（Owner 2026-11-08 要求实现）：
 *   ① 面板挂载后立即探测一次文件元信息（建基线），此后按节流间隔探测；
 *   ② mtime / size 变了 → 重新读取内容（agent 改了磁盘上的文件，右栏要跟着变）；
 *   ③ 没变 → **不重读**（stat 便宜、重读整份 Markdown 很贵）；
 *   ④ 仍然**没有**手动刷新按钮、也没有自动刷新开关（这两个控件是上一轮删掉的，不回来）。
 *
 * 编辑中不探测、面板不可见不探测这两条由 `lib/fileAutoRefresh.test.ts` 用纯函数钉住
 * （在 jsdom 里模拟「用户正在编辑器里打字」既脆弱又测不准，纯函数才是诚实的边界）。
 *
 * ⚠️ 定时器纪律：`vi.useFakeTimers()` 与 `waitFor` 混用会互相等死，
 * 所以这里统一用 `shouldAdvanceTime: true` + 显式 `advanceTimersByTimeAsync`。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';

const FILE = '/tmp/right-panel-fixture/report.md';

let statMtime = 1;
let previewContent = '# 右栏预览内容';

const fileStat = vi.fn(async () => ({ exists: true, path: FILE, mtimeMs: statMtime, size: 10 + statMtime }));
const filePreview = vi.fn(async () => ({
  type: 'markdown',
  name: 'report.md',
  path: FILE,
  content: previewContent,
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

/** 让初始预览取数走完（含微任务链）。 */
async function settleInitialLoad() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('右栏本地文件自动刷新', () => {
  beforeEach(() => {
    statMtime = 1;
    previewContent = '# 右栏预览内容';
    fileStat.mockClear();
    filePreview.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('打开时没有「刷新」按钮，也没有自动刷新开关，但预览能正常加载', async () => {
    const { container } = renderFilePanel();

    await waitFor(() => {
      expect(container.textContent).toContain('右栏预览内容');
    });
    expect(filePreview).toHaveBeenCalledWith(FILE);

    const actions = container.querySelector('[data-panel-actions]');
    expect(actions).not.toBeNull();
    // 自动刷新开关（全组件唯一的 aria-pressed 切换按钮）不该存在。
    expect(actions!.querySelectorAll('[aria-pressed]')).toHaveLength(0);
    // 「刷新 / Refresh / Actualizar」按钮不该存在。
    const refreshTitled = Array.from(actions!.querySelectorAll('button')).filter((b) => {
      const label = `${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''}`;
      return /刷新|Refresh|Actualizar|自动刷新|Auto-refresh|Auto-actualizar/i.test(label);
    });
    expect(refreshTitled).toHaveLength(0);
  });

  it('挂载后立即探测一次元信息，建立基线', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderFilePanel();
    await settleInitialLoad();

    await waitFor(() => {
      expect(fileStat).toHaveBeenCalledWith(FILE);
    });
  });

  it('磁盘内容变了（mtime / size 变化）→ 自动重新读取并渲染新内容', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = renderFilePanel();
    await settleInitialLoad();
    expect(container.textContent).toContain('右栏预览内容');

    const previewCallsBefore = filePreview.mock.calls.length;

    // agent 在磁盘上改了文件
    statMtime = 500;
    previewContent = '# 磁盘上的新内容';

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    await settleInitialLoad();

    expect(filePreview.mock.calls.length).toBeGreaterThan(previewCallsBefore);
    await waitFor(() => {
      expect(container.textContent).toContain('磁盘上的新内容');
    });
  });

  it('元信息没变 → 不重读内容（探测便宜、重读很贵）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderFilePanel();
    await settleInitialLoad();
    await waitFor(() => {
      expect(fileStat).toHaveBeenCalled();
    });

    const previewCallsBefore = filePreview.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);   // 三个周期，什么都没改
    });
    await settleInitialLoad();

    expect(filePreview.mock.calls.length).toBe(previewCallsBefore);
  });
});
