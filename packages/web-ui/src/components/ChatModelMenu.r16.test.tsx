/**
 * R16（审计 §8.4）**站点级**接线测试：全局默认 / 模型目录取数失败必须是 error，
 * 不能是一个安静的空菜单（「一个可用模型都没有」）。
 *
 * 为什么必须有这一条（评审第 4 轮实测过假绿）：
 *   `ListState` / `resourceState` 的原语测试**覆盖不到站点接线** —— 把本组件
 *   catch 里的 `setLoadError(...)` 删掉，原语测试照旧全绿。所以判据「改坏实现即红」
 *   只能由**这一层**证明：
 *     1. `fetch('/api/settings/llm')` 失败 → 菜单里出现「模型目录读取失败：…（这不等于…）」；
 *     2. 同一时刻**不得**出现空态文案（「没有可用模型」是那句我们不能下的结论）；
 *     3. 反向守卫：真的读回 0 个 provider 时**必须**出空态文案、且不得报读取失败
 *        （否则把「永远报错」焊死也能让 1 与 2 通过）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../i18n/index.ts';
import { ChatModelMenu } from './ChatModelMenu.tsx';

/** 空态文案：与组件同源（同一个 i18n 实例），不受测试环境语言影响。 */
const emptyCopy = () => i18n.t('team:chatModel.empty', { defaultValue: 'No enabled providers / models' });

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 打开菜单（trigger 是唯一的 button；面板里的控件只有打开后才存在）。 */
async function openMenu() {
  render(<ChatModelMenu value={null} onSelect={() => {}} />);
  await userEvent.click(screen.getByRole('button'));
}

describe('R16 模型目录取数失败 → 三态必须分开', () => {
  it('读失败：错误可见 + 可重试，且**不渲染**「没有可用的模型」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));

    await openMenu();

    expect(await screen.findByText(/模型目录读取失败/)).toBeTruthy();
    expect(screen.getByText(/这不等于「没有可用的模型」/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    // 空态文案 = 一句断言（「确实一个都没有」）—— 我们并不知道
    expect(screen.queryByText(emptyCopy())).toBeNull();
  });

  it('反向守卫：真读到 0 个 provider → 出空态文案，且不报读取失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ providers: {} }),
    })));

    await openMenu();

    await waitFor(() => expect(screen.getByText(emptyCopy())).toBeTruthy());
    expect(screen.queryByText(/模型目录读取失败/)).toBeNull();
  });
});
