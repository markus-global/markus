/**
 * 三态原语的契约（审计 §8.4 R1 的地基）。
 *
 * 这些断言**故意会咬人**：把 `readList` 的 catch 改回 `okResource([])`、
 * 或把 `listView.empty` 里的 `!error` 删掉，下面第 1/3/4 条立刻红 ——
 * 因为那正是「把没读到写成确实没有」这一族缺陷的两种写法。
 */
import { describe, it, expect } from 'vitest';
import {
  combineSources,
  errorMessage,
  listView,
  loadingResource,
  okResource,
  readList,
  type Resource,
} from './resourceState.ts';

describe('listView —— 「有没有东西」的唯一判据', () => {
  it('读失败 + 0 条 ≠ 空：empty 必须为 false（否则界面会断言「确实没有」）', () => {
    const r: Resource<string> = { state: 'error', items: [], error: 'boom' };
    const v = listView(r);
    expect(v.error).toBe(true);
    expect(v.rows).toEqual([]);
    expect(v.empty).toBe(false);
  });

  it('读到 0 条才是空（ok + 0 条 → empty）', () => {
    expect(listView(okResource<string>([])).empty).toBe(true);
  });

  it('还在读不算空（首帧 / 切对象时不得闪空态）', () => {
    const v = listView(loadingResource<string>());
    expect(v.loading).toBe(true);
    expect(v.empty).toBe(false);
  });

  it('读到内容时既不是空也不是失败', () => {
    const v = listView(okResource(['a']));
    expect(v).toMatchObject({ loading: false, error: false, empty: false });
    expect(v.rows).toEqual(['a']);
  });
});

describe('readList —— 失败不许抛出，也不许折成「读到了 0 条」', () => {
  it('reject → state=error + 人话原因；且此时 empty 必为 false', async () => {
    const r = await readList<string>(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(r.state).toBe('error');
    expect(r.items).toEqual([]);
    expect(r.error).toBe('ECONNREFUSED');
    expect(listView(r).empty).toBe(false);
  });

  it('通过非 Error 值 reject 也给出人话（不能渲染出 "undefined"）', async () => {
    const r = await readList<string>(() => Promise.reject('谁扔的字符串'));
    expect(r.error).toBe('谁扔的字符串');
  });

  it('resolve 空数组 → 这是**事实**：state=ok 且 empty=true', async () => {
    const r = await readList<string>(() => Promise.resolve([]));
    expect(r).toMatchObject({ state: 'ok', items: [], error: null });
    expect(listView(r).empty).toBe(true);
  });

  it('keep：刷新失败保留上一次内容，但结果仍非事实（empty=false 且带 error）', async () => {
    const r = await readList<string>(() => Promise.reject(new Error('timeout')), { keep: ['stale'] });
    expect(r.items).toEqual(['stale']);
    expect(r.state).toBe('error');
    expect(listView(r).empty).toBe(false);
    expect(listView(r).error).toBe(true);
  });

  it('成功时不受 keep 影响（不能让陈旧内容混进新结果）', async () => {
    const r = await readList<string>(() => Promise.resolve(['fresh']), { keep: ['stale'] });
    expect(r.items).toEqual(['fresh']);
    expect(r.state).toBe('ok');
  });
});

describe('combineSources —— 多腿取数的聚合（时间线与模板库共用）', () => {
  it('任一腿在读 → loading（即便另一腿已失败，也还没到结论时刻）', () => {
    const c = combineSources([
      { label: 'Hub', state: 'loading' },
      { label: '模板', state: 'error' },
    ]);
    expect(c).toMatchObject({ state: 'loading', loading: true, anyOk: false });
    expect(c.failures).toEqual(['模板']);
  });

  it('没有在飞 + 任一腿失败 → error，并列出失败腿的人话标签', () => {
    const c = combineSources([
      { label: 'Hub', state: 'error' },
      { label: '模板', state: 'ok' },
    ]);
    expect(c.state).toBe('error');
    expect(c.failures).toEqual(['Hub']);
    expect(c.anyOk).toBe(true);
  });

  it('全部成功 → ok 且无失败项', () => {
    const c = combineSources([{ label: 'a', state: 'ok' }, { label: 'b', state: 'ok' }]);
    expect(c).toMatchObject({ state: 'ok', loading: false, failures: [], anyOk: true });
  });
});

describe('errorMessage', () => {
  it('无消息的 Error 退回默认人话（不得渲染空串）', () => {
    expect(errorMessage(new Error(''))).toBe('读取失败');
    expect(errorMessage(new Error('磁盘满了'))).toBe('磁盘满了');
  });
});
