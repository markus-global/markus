/**
 * jumpWindow 回归护栏 —— 「跨会话跳到搜索结果那条消息」的**取数**判定。
 *
 * 用户报障（第九轮，仍未修好）：跨会话搜索**多试几次**后，会「闪一下正确位置又跳走 /
 * 直接显示该会话最新消息 / 消息压根没加载」；**同一会话内搜却是正常的**。
 *
 * 根因（结构性，不是某个 if 写错）：跨会话跳转走的是一条**共享的增量翻页**通道
 * （`loadMore`），它的每一项前置状态都被别人共享/覆盖：
 *   • 翻页闸门读 `getWindowBounds(bufferId)`，**未写入时默认 `hasMore:false`**
 *     → `loadMore` 直接返回 0 → 判定「目标加载失败」→ 回到底部（= 显示最新消息）；
 *   • 在途去重 `loadMoreInflightRef` 是**全局**的，会把**别人的**在途请求返回给我，
 *     它返回 0 时我这边也立刻收手；
 *   • 请求回来时若「视图已变」会**丢弃整页**并返回 0。
 * 「0」同时表示三件完全不同的事（到底了 / 这页被丢弃 / 我加入了别人的请求），
 * 调用方无法区分 → 有时对、有时错（正是「多试几次才坏」的形态）。
 *
 * 契约（本文件钉住）：跳转**自带取数**，不再读共享翻页状态。
 *   • fast path：`has(targetId)` 已命中 → 不发请求、不安装；
 *   • 否则从**最新**往更早逐页取，直到命中 / 到头 / 上界；
 *   • 返回**累计窗口（升序 = 显示序）**，调用方一次性安装，目标必然在内。
 *
 * 数据形态与服务端一致：每页**升序**（`messages[0]` 是该页最早一条），
 * 页序为**最新→最旧**，游标 = 上一页 `messages[0].createdAt`。
 */
import { describe, it, expect, vi } from 'vitest';
import { collectJumpWindow, trimJumpWindow } from '../src/lib/jumpWindow.ts';

type M = { id: string; createdAt: string };
type Page = { messages: M[]; hasMore: boolean };

const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const msg = (id: string, day: number): M => ({ id, createdAt: at(day) });

/** 把升序消息切成页（每页 size 条），页按**最新→最旧**排列（= 服务端翻页顺序）。 */
function makePages(all: M[], size: number): Page[] {
  const chunks: M[][] = [];
  for (let i = 0; i < all.length; i += size) chunks.push(all.slice(i, i + size));
  const newestFirst = [...chunks].reverse();
  return newestFirst.map((msgs, i) => ({ messages: msgs, hasMore: i < newestFirst.length - 1 }));
}

/** fetchPage：before = 上一页最早一条的时间；undefined = 最新一页。 */
function makeFetch(pages: Page[]) {
  return vi.fn(async (before?: string): Promise<Page> => {
    if (before === undefined) return pages[0]!;
    const i = pages.findIndex((p) => p.messages[0]!.createdAt === before);
    return pages[i + 1] ?? { messages: [], hasMore: false };
  });
}

const days = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(`d${from + i}`, from + i));

describe('collectJumpWindow', () => {
  it('目标已在缓冲里 → fast path：不发请求、不安装', async () => {
    const fetchPage = makeFetch(makePages(days(1, 4), 2));
    const r = await collectJumpWindow({ targetId: 'd4', has: () => true, fetchPage });
    expect(r.found).toBe(true);
    expect(r.messages).toEqual([]);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('目标在最新一页 → 只取一页，返回该页（升序）', async () => {
    const fetchPage = makeFetch(makePages(days(1, 4), 2)); // 页: [d3,d4] , [d1,d2]
    const r = await collectJumpWindow({ targetId: 'd4', has: () => false, fetchPage });
    expect(r.found).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(r.messages.map((m) => m.id)).toEqual(['d3', 'd4']);
    expect(r.hasMore).toBe(true);
    expect(r.oldestCursor).toBe(at(3));
  });

  it('目标在最旧一页 → 取满 3 页，累计窗口升序、目标必然在内', async () => {
    const fetchPage = makeFetch(makePages(days(1, 6), 2)); // [d5,d6] [d3,d4] [d1,d2]
    const r = await collectJumpWindow({ targetId: 'd1', has: () => false, fetchPage });
    expect(r.found).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(r.messages.map((m) => m.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
    expect(r.oldestCursor).toBe(at(1));
    expect(r.exhausted).toBe(false);
  });

  it('取到历史尽头（hasMore=false）仍没命中 → found=false, exhausted=true', async () => {
    const fetchPage = makeFetch(makePages(days(1, 4), 2));
    const r = await collectJumpWindow({ targetId: 'nope', has: () => false, fetchPage });
    expect(r.found).toBe(false);
    expect(r.exhausted).toBe(true);
    expect(r.messages.map((m) => m.id)).toEqual(['d1', 'd2', 'd3', 'd4']);
  });

  it('服务端返回空页 → 立即收手（exhausted），不空翻', async () => {
    const fetchPage = makeFetch([{ messages: [], hasMore: false }]);
    const r = await collectJumpWindow({ targetId: 'nope', has: () => false, fetchPage });
    expect(r.found).toBe(false);
    expect(r.exhausted).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('遵守 maxPages 上界（不会无限翻）', async () => {
    const fetchPage = makeFetch(makePages(days(1, 20), 2)); // 10 页
    const r = await collectJumpWindow({ targetId: 'nope', has: () => false, fetchPage, maxPages: 3 });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(r.found).toBe(false);
    expect(r.exhausted).toBe(false);
  });

  it('已知目标时间 → 翻过目标时间仍没命中就收手（不在本会话），不空翻到底', async () => {
    // 页: [d5,d6] [d3,d4] [d1,d2]，目标时间落在 d4 与 d5 之间（已被删除）。
    // 取到第二页（最早 d3 已比目标更旧）即可断定「不在本会话」，不必翻到 d1,d2。
    const fetchPage = makeFetch(makePages(days(1, 6), 2));
    const r = await collectJumpWindow({
      targetId: 'deleted', has: () => false, fetchPage,
      targetCreatedAt: '2026-10-04T12:00:00.000Z',
    });
    expect(r.found).toBe(false);
    expect(r.exhausted).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('翻到历史尽头但目标时间更早 → exhausted 优先于「翻过目标」判定', async () => {
    // [d5,d6] [d3,d4] [d1,d2]：目标时间比整段会话都早 → 真的没有更早的了。
    const fetchPage = makeFetch(makePages(days(1, 6), 2));
    const r = await collectJumpWindow({
      targetId: 'deleted', has: () => false, fetchPage, targetCreatedAt: at(1),
    });
    expect(r.found).toBe(false);
    expect(r.exhausted).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('取数抛错 → 不崩，返回已取得的部分', async () => {
    const fetchPage = vi.fn(async () => { throw new Error('network'); });
    const r = await collectJumpWindow({ targetId: 'x', has: () => false, fetchPage });
    expect(r.found).toBe(false);
    expect(r.messages).toEqual([]);
    expect(r.exhausted).toBe(false);
  });

  it('分页游标正确：第二页 before = 第一页最早一条的时间', async () => {
    const fetchPage = makeFetch(makePages(days(1, 6), 2));
    await collectJumpWindow({ targetId: 'd1', has: () => false, fetchPage });
    expect(fetchPage.mock.calls[0]![0]).toBeUndefined();
    expect(fetchPage.mock.calls[1]![0]).toBe(at(5));
  });
});

describe('trimJumpWindow', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, createdAt: at(i % 28 + 1) }));

  it('未超上限 → 原样返回（目标一定在）', () => {
    const all = list(10);
    expect(trimJumpWindow(all, 'm3', { cap: 20 })).toBe(all);
  });

  it('超上限时保住目标（而不是像 slice(-cap) 那样把最旧的目标丢掉）', () => {
    const all = list(1000);
    const trimmed = trimJumpWindow(all, 'm10', { cap: 500, contextBefore: 20 });
    expect(trimmed.length).toBe(500);
    expect(trimmed.some((m) => m.id === 'm10')).toBe(true);
    // 目标前的 20 条上下文也保留（窗口从 m0 起算时前移不大）
    expect(trimmed[0]!.id).toBe('m0');
  });

  it('目标在深历史（窗口中间偏后）→ 窗口后移，目标仍在内且不越界', () => {
    const all = list(1000);
    const trimmed = trimJumpWindow(all, 'm900', { cap: 500, contextBefore: 20 });
    expect(trimmed.length).toBe(500);
    expect(trimmed.some((m) => m.id === 'm900')).toBe(true);
    // 目标后还剩 99 条（m901..m999），窗口右端贴住序列末尾，不越界
    expect(trimmed[trimmed.length - 1]!.id).toBe('m999');
  });

  it('目标不在窗口里 → 退回「保留最新」的默认语义（调用方用 found=false 兜底）', () => {
    const all = list(1000);
    const trimmed = trimJumpWindow(all, 'ghost', { cap: 500 });
    expect(trimmed.length).toBe(500);
    expect(trimmed[499]!.id).toBe('m999');
  });
});
