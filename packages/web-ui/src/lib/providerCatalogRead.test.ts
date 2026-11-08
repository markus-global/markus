/**
 * provider 模型目录取数：失败必须是 error，不能是空数组。
 *
 * 界面上「空数组」= 「这个 provider 没有模型」（一句我们并不知道的断言）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getByProvider: vi.fn(async () => ({ models: [{ id: 'gpt-x', name: 'GPT X' }] })),
  validateKey: vi.fn(async () => ({ valid: true, models: [{ id: 'gpt-y', name: 'GPT Y' }] })),
}));

vi.mock('../api.ts', () => ({
  api: { modelCatalog: { getByProvider: mocks.getByProvider, validateKey: mocks.validateKey } },
}));

import { readProviderCatalog } from './providerCatalogRead.ts';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getByProvider.mockResolvedValue({ models: [{ id: 'gpt-x', name: 'GPT X' }] });
});

describe('readProviderCatalog（R14/R15 的唯一取数实现）', () => {
  it('读成功 → ok + 模型清单', async () => {
    const r = await readProviderCatalog('openai');
    expect(r.state).toBe('ok');
    expect(r.items).toHaveLength(1);
    expect(r.error).toBeNull();
  });

  it('读失败 → state=error 且带人话原因（不是「读到了 0 个模型」）', async () => {
    mocks.getByProvider.mockRejectedValue(new Error('catalog 502'));
    const r = await readProviderCatalog('openai');
    expect(r.state).toBe('error');
    expect(r.error).toBe('catalog 502');
    expect(r.items).toEqual([]);
  });

  it('带 apiKey 时走校验口（不是第二条独立实现）', async () => {
    const r = await readProviderCatalog('openai', { apiKey: 'sk-test' });
    expect(mocks.validateKey).toHaveBeenCalledTimes(1);
    expect(mocks.getByProvider).not.toHaveBeenCalled();
    expect(r.state).toBe('ok');
    expect(r.items[0]?.id).toBe('gpt-y');
  });
});
