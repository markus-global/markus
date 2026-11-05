/**
 * R12/R13 合并后的共享取数实现：**两条腿各自成态**。
 *
 * 旧代码在两个页面里各写一份 `catch { setTemplates([]); setHubItems([]) }`：
 * 一条腿失败就把另一条腿的数据一起清空，界面读成「一条都没有」。
 * 这里钉住三条：失败落 error、另一条腿不受影响、聚合态带失败标签。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  search: vi.fn(async () => ({ items: [{ id: 'hub-1', name: 'A', itemType: 'team' }], total: 1 })),
  // 显式签名：夹具的 `vi.fn(async () => …)` 会被推断成「零参」，而取数口实际接受
  // 搜索词 —— 零参 mock 让 `mocks.teamTemplates(q)` 变成类型错（且掩盖「搜索词没被
  // 透传」这类真实缺陷）。这里按真实契约写签名，不用 `as` 擦掉。
  teamTemplates: vi.fn(async (_search?: string) => ({ templates: [{ id: 'tpl-1', name: 'T' }] })),
}));

vi.mock('../api.ts', () => ({
  hubApi: { search: mocks.search },
  api: { teamTemplates: { list: mocks.teamTemplates } },
}));

import { useStoreCatalog } from './useStoreCatalog.ts';

const loadTemplates = async (q: string): Promise<readonly { id: string; name: string }[]> =>
  (await mocks.teamTemplates(q)).templates;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search.mockResolvedValue({ items: [{ id: 'hub-1', name: 'A', itemType: 'team' }], total: 1 });
  mocks.teamTemplates.mockResolvedValue({ templates: [{ id: 'tpl-1', name: 'T' }] });
});

describe('useStoreCatalog（R12/R13 的唯一取数实现）', () => {
  it('两条腿都成功 → 各自 ok，聚合态 ok', async () => {
    const { result } = renderHook(() => useStoreCatalog({ catalogType: 'team', search: '', loadTemplates }));
    await waitFor(() => expect(result.current.sources.loading).toBe(false));
    expect(result.current.hub.state).toBe('ok');
    expect(result.current.hub.items).toHaveLength(1);
    expect(result.current.templates.state).toBe('ok');
    expect(result.current.sources.failures).toEqual([]);
  });

  it('Hub 读失败 → hub 是 error（不是空列表），本地模板照常可用', async () => {
    mocks.search.mockRejectedValue(new Error('hub down'));
    const { result } = renderHook(() => useStoreCatalog({ catalogType: 'team', search: '', loadTemplates }));
    await waitFor(() => expect(result.current.sources.loading).toBe(false));

    expect(result.current.hub.state).toBe('error');
    expect(result.current.hub.error).toBe('hub down');
    // 关键：失败不得把另一条腿一起清空（旧实现就是这样一个 catch 清两个 state）
    expect(result.current.templates.state).toBe('ok');
    expect(result.current.templates.items).toHaveLength(1);
    expect(result.current.sources.failures).toEqual(['Hub 资产']);
    expect(result.current.sources.anyOk).toBe(true);
  });

  it('本地模板读失败 → templates 是 error，Hub 照常可用', async () => {
    mocks.teamTemplates.mockRejectedValue(new Error('tpl 500'));
    const { result } = renderHook(() => useStoreCatalog({ catalogType: 'team', search: '', loadTemplates }));
    await waitFor(() => expect(result.current.sources.loading).toBe(false));

    expect(result.current.templates.state).toBe('error');
    expect(result.current.templates.error).toBe('tpl 500');
    expect(result.current.hub.state).toBe('ok');
    expect(result.current.sources.failures).toEqual(['本地模板']);
  });
});
