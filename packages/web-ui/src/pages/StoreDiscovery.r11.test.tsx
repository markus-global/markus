/**
 * R11（审计 §8.4）**站点级**接线测试：Hub 目录取数失败必须落成 error，
 * 而不是「生态正在成长中 / 成为首批创作者」——后者是那次失败**不能**下的结论。
 *
 * 会咬人的判据（改坏实现即红）：
 *   1. `hubApi.search` reject → 出现「Hub 资产读取失败：…（这不等于「没有可安装的资产」）」；
 *   2. 同一时刻**不得**出现空态文案（EmptyHint）——否则用户同时被告知
 *      「读取失败，这不等于没有资产」和「生态正在成长中」，两句互相矛盾；
 *   3. 反向守卫：真的读回 0 条时才出空态文案、且不报读取失败。
 *
 * 本文件在接线被改坏时**必须**红：删掉 `ReadErrorNotice` 的 error 门控 → 1 红；
 * 让 EmptyHint 不看 error → 2 红。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n/index.ts';

const mocks = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const hubApi = actual['hubApi'] as Record<string, unknown>;
  return { ...actual, hubApi: { ...hubApi, search: mocks.search } };
});

import { StoreDiscovery } from './StoreDiscovery.tsx';

/** 空态文案：与组件同一个 i18n 实例，不受测试环境语言影响。 */
const emptyCopy = () => i18n.t('store:discover.empty', { defaultValue: '生态正在成长中' });

beforeEach(async () => {
  await i18n.changeLanguage('en');
  mocks.search.mockReset();
});

describe('R11 Hub 目录取数失败 → 三态必须分开', () => {
  it('读失败：错误可见 + 可重试，且**不渲染**「生态正在成长中」', async () => {
    mocks.search.mockRejectedValue(new Error('hub 503'));

    render(<StoreDiscovery onOpenType={() => {}} />);

    expect(await screen.findByText(/Hub 资产读取失败/)).toBeTruthy();
    expect(screen.getByText(/这不等于「没有可安装的资产」/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    // 空态文案与失败条不得并存（同一屏上两句互相矛盾）
    expect(screen.queryByText(emptyCopy())).toBeNull();
  });

  it('反向守卫：真读到 0 条 → 出空态文案，且不报读取失败', async () => {
    mocks.search.mockResolvedValue({ items: [], total: 0 });

    render(<StoreDiscovery onOpenType={() => {}} />);

    await waitFor(() => expect(screen.getByText(emptyCopy())).toBeTruthy());
    expect(screen.queryByText(/Hub 资产读取失败/)).toBeNull();
  });
});
