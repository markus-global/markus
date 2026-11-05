/**
 * 三态渲染器的契约：**读失败不许渲染空态文案**。
 *
 * 这三条是「会咬人」的判据 —— 把 `ListState` 里 `view.error` 分支删掉、
 * 或让它先判 `empty`，第 1、2 条立刻红（界面会重新开始断言「确实没有」）。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ListState, ReadErrorNotice } from './ListState.tsx';
import type { Resource } from '../lib/resourceState.ts';

const EMPTY_COPY = '还没有任何交付物';
const LOADING_COPY = '正在读取…';

function renderList(resource: Resource<{ id: string }>, onRetry?: () => void) {
  return render(
    <ListState
      resource={resource}
      subject="交付物"
      notEquals="没有任何交付物"
      {...(onRetry ? { onRetry } : {})}
      loading={<div>{LOADING_COPY}</div>}
      empty={<div>{EMPTY_COPY}</div>}
    >
      {rows => (
        <ul>
          {rows.map(r => (
            <li key={r.id}>{r.id}</li>
          ))}
        </ul>
      )}
    </ListState>,
  );
}

describe('ListState', () => {
  it('读失败 → 出现「读取失败 + 这不等于…」，且**绝不**出现空态文案', () => {
    renderList({ state: 'error', items: [], error: 'HTTP 500' });
    expect(screen.getByRole('alert').textContent).toContain('交付物读取失败：HTTP 500');
    expect(screen.getByRole('alert').textContent).toContain('这不等于「没有任何交付物」');
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
  });

  it('读失败 + 手上有陈旧内容 → 保留列表并给出失败条（不清成空）', () => {
    renderList({ state: 'error', items: [{ id: 'old-1' }], error: 'timeout' });
    expect(screen.getByText('old-1')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('timeout');
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
  });

  it('确实读到 0 条 → 才渲染空态，且没有失败条', () => {
    renderList({ state: 'ok', items: [], error: null });
    expect(screen.getByText(EMPTY_COPY)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('读取中 → 只画 loading，不画空态（首帧不得闪「没有」）', () => {
    renderList({ state: 'loading', items: [], error: null });
    expect(screen.getByText(LOADING_COPY)).toBeTruthy();
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
  });

  it('有内容 → 渲染 rows', () => {
    renderList({ state: 'ok', items: [{ id: 'a' }, { id: 'b' }], error: null });
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.getByText('b')).toBeTruthy();
  });

  it('重试按钮走调用方给的同一个取数口', () => {
    const onRetry = vi.fn();
    renderList({ state: 'error', items: [], error: 'boom' }, onRetry);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('ReadErrorNotice', () => {
  it('无重试入口时给出可操作指引，而不是一个假按钮', () => {
    render(
      <ReadErrorNotice subject="模型目录" error="boom" notEquals="该 provider 没有模型" hint="稍后重试" />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('稍后重试')).toBeTruthy();
  });
});
