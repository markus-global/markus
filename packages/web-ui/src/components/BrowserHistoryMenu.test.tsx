/**
 * 历史下拉行必须按 kind 区分并原样回传条目。
 *
 * 为什么需要这道守卫：模型扩到 file / deliverable 之后，有两条「静默失败」的走法
 * 都不会让任何既有测试变红：
 *   ① 行的 key / 移除回调还按 `entry.url` 走 —— 新条目没有 url，删不掉、key 全变 undefined；
 *   ② 行渲染只认 title —— 文件与产出物丢了自己的位置行（路径 / 引用），用户看不到要打开什么。
 * 所以这里渲染**真实**条目数据，断言三件事：每种 kind 都出「位置行」、移除回传整条目、
 * 点击回传整条目（而不是回传一个字符串，让调用方再去猜 kind）。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserHistoryMenu } from './BrowserHistoryMenu.tsx';
import type { BrowserHistoryEntry } from '../lib/browserHistory.ts';

const URL_ROW: BrowserHistoryEntry = {
  kind: 'url',
  target: 'https://github.com/markus/platform',
  title: 'Markus',
  visitedAt: 3000,
  visitCount: 2,
};
const FILE_ROW: BrowserHistoryEntry = {
  kind: 'file',
  target: '/Users/me/notes/roadmap.md',
  title: 'roadmap.md',
  visitedAt: 2000,
  visitCount: 1,
};
const DELIVERABLE_ROW: BrowserHistoryEntry = {
  kind: 'deliverable',
  target: 'dlv_7',
  title: '审计报告',
  location: '/out/hardcoded-audit.md',
  visitedAt: 1000,
  visitCount: 1,
};

function renderMenu(items: BrowserHistoryEntry[], over: Partial<Parameters<typeof BrowserHistoryMenu>[0]> = {}) {
  const onPick = vi.fn();
  const onRemove = vi.fn();
  const onClear = vi.fn();
  render(
    <BrowserHistoryMenu
      items={items}
      query=""
      activeIndex={-1}
      onHover={() => {}}
      onPick={onPick}
      onRemove={onRemove}
      onClear={onClear}
      {...over}
    />,
  );
  return { onPick, onRemove, onClear };
}

describe('BrowserHistoryMenu', () => {
  it('shows one row per kind with its own location line', () => {
    renderMenu([URL_ROW, FILE_ROW, DELIVERABLE_ROW]);

    // url → host+path without scheme; file → the path; deliverable → its reference.
    expect(screen.getByText('github.com/markus/platform')).toBeTruthy();
    expect(screen.getByText('/Users/me/notes/roadmap.md')).toBeTruthy();
    expect(screen.getByText('/out/hardcoded-audit.md')).toBeTruthy();
    expect(screen.getByText('审计报告')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('falls back to the deliverable target when there is no reference', () => {
    renderMenu([{ ...DELIVERABLE_ROW, location: undefined }]);
    expect(screen.getByText('dlv_7')).toBeTruthy();
  });

  it('passes the whole entry to pick / remove, so the opener never guesses the kind', () => {
    const { onPick, onRemove } = renderMenu([FILE_ROW, DELIVERABLE_ROW]);

    const rows = screen.getAllByRole('option');
    rows[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(onPick).toHaveBeenCalledWith(DELIVERABLE_ROW);

    const removeButtons = screen.getAllByLabelText('从历史记录中移除');
    removeButtons[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(onRemove).toHaveBeenCalledWith(FILE_ROW);
    // Removing must not also open the row.
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('hides the keyboard hint where the consumer has no keyboard nav', () => {
    // The panel-chrome menu has no ↑↓ handler, so advertising the keys would lie.
    renderMenu([URL_ROW], { keyboardHint: false });
    expect(screen.queryByTitle('↑↓ 或 Ctrl+N/P 选择 · Enter 打开')).toBeNull();
  });

  it('renders the empty state instead of a headed list', () => {
    renderMenu([]);
    expect(screen.getByText('暂无浏览历史')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});
