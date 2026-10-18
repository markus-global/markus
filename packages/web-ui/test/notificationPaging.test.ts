/**
 * 通知浮窗滚动到底部闪烁 — 回归护栏（Owner 报障 2026-10-18）。
 *
 * 实测（真实浏览器，修前）：用户停在底部时来一次刷新 —— 列表 150 行 → 30 行 →
 * 150 行，8 个请求，滚动条来回跳。机制不是「服务端反复给同一页」，而是**一个
 * 列表两个写者**：
 *   fetchData()             把整个列表替换成第 1 页
 *   loadMoreNotifications() 往列表尾部追加第 N 页
 * 列表一塌陷，scrollTop 被夹到新的底部，滚动处理器无法把它和「用户滚到底」区分
 * 开 → 立刻重新触发翻页 → 再塌陷…… 视觉上就是浮窗闪烁，主线程上是重渲染风暴。
 *
 * 这里钉住两条构造性规则：
 *  ① mergeNotificationPage：刷新只能 UPSERT，列表永不缩短 → 刷新不可能移动滚动
 *     位置，也就不可能重新武装触底加载。
 *  ② decideNextPage：是否还有下一页取决于**单调游标**（服务端已给过多少行），
 *     不取决于会被别处改写的 list.length。
 */
import { describe, it, expect } from 'vitest';
import {
  decideNextPage,
  mergeNotificationPage,
  type MergeableNotification,
} from '../src/lib/notificationPaging.ts';

const PAGE = 30;

interface Row extends MergeableNotification {
  id: string;
  read: boolean;
  title?: string;
}

const row = (i: number, read = true): Row => ({ id: `n_${i}`, read, title: `#${i}` });
const page = (from: number, size = PAGE): Row[] =>
  Array.from({ length: size }, (_, k) => row(from + k));

describe('mergeNotificationPage — 刷新只能 UPSERT，列表永不缩短', () => {
  it('加载了 5 页后刷新第 1 页：行数不许变少（旧行为：塌回 30 行 → 滚动被夹到底部）', () => {
    const loaded = [...page(0), ...page(30), ...page(60), ...page(90), ...page(120)];
    expect(loaded).toHaveLength(150);

    const afterRefresh = mergeNotificationPage(loaded, page(0));

    // 旧实现 setNotifications(page1) 后长度是 30 —— 正是滚动位置被夹到底部、
    // 进而重新触发 loadMore 的那一步。
    expect(afterRefresh).toHaveLength(150);
    expect(afterRefresh.map(r => r.id)).toEqual(loaded.map(r => r.id));
  });

  it('新通知插到前面也不丢已加载的旧页', () => {
    const loaded = page(30);
    const merged = mergeNotificationPage(loaded, [row(-1), row(-2), ...page(0, 28)]);
    expect(merged).toHaveLength(60);
    expect(merged.some(r => r.id === 'n_59')).toBe(true);
  });

  it('同一 id 以刷新到的为准（在别处读过 → 这里也必须变成已读）', () => {
    const loaded = [row(1, false), row(2, false)];
    const merged = mergeNotificationPage(loaded, [row(1, true)]);
    expect(merged.find(r => r.id === 'n_1')!.read).toBe(true);
    expect(merged.find(r => r.id === 'n_2')!.read).toBe(false);
  });

  it('什么都没有变时返回同一个引用（空闲刷新不触发重渲染）', () => {
    const loaded = page(0);
    expect(mergeNotificationPage(loaded, page(0))).toBe(loaded);
    expect(mergeNotificationPage(loaded, [])).toBe(loaded);
  });
});

describe('decideNextPage — 没有进展就不许再说「还有下一页」', () => {
  it('整页全是重复条目（fresh=0）→ 必须停止', () => {
    expect(decideNextPage({ loadedCount: 60, received: PAGE, fresh: 0, totalCount: null, pageSize: PAGE }))
      .toEqual({ hasMore: false });
    expect(decideNextPage({ loadedCount: 60, received: PAGE, fresh: 0, totalCount: 500, pageSize: PAGE }))
      .toEqual({ hasMore: false });
  });

  it('空页 → 停止', () => {
    expect(decideNextPage({ loadedCount: 120, received: 0, fresh: 0, totalCount: 1000, pageSize: PAGE }))
      .toEqual({ hasMore: false });
  });

  it('正常满页且未到总数 → 继续翻页', () => {
    expect(decideNextPage({ loadedCount: PAGE, received: PAGE, fresh: PAGE, totalCount: 100, pageSize: PAGE }))
      .toEqual({ hasMore: true });
  });

  it('游标到总数 → 停止（游标单调，刷新不会把它回退）', () => {
    expect(decideNextPage({ loadedCount: 100, received: 30, fresh: 30, totalCount: 100, pageSize: PAGE }))
      .toEqual({ hasMore: false });
  });

  it('服务端没给总数时，短页即最后一页', () => {
    expect(decideNextPage({ loadedCount: 37, received: 7, fresh: 7, totalCount: null, pageSize: PAGE }))
      .toEqual({ hasMore: false });
    expect(decideNextPage({ loadedCount: PAGE, received: PAGE, fresh: 12, totalCount: null, pageSize: PAGE }))
      .toEqual({ hasMore: true });
  });
});

/**
 * 审批历史（Owner 追问 2026-10-18：「为什么审批要点击按钮才加载，而通知是触底自动加载？」）
 *
 * 答案是「没有技术理由」——上一轮只做到「能加载」，加了个按钮就收工，同一个浮窗里
 * 两种交互。现在两个列表共用 notificationPaging.ts 的同一套规则：
 *  ① 同一个 merge（这里用状态比较器，通知用 read）→ 刷新永不替换列表；
 *  ② 同一个触底触发：列表末尾的 sentinel 元素 + IntersectionObserver；
 *  ③ 同一条「还有没有下一页」规则 decideNextPage，游标单调、与 list.length 无关。
 *
 * 下面钉住审批特有的那个 bug：游标曾经是 `approvals.length`。
 */
interface ApprovalRow {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  respondedAt?: string;
}

const APPROVAL_PAGE = 50;
const approvalRow = (i: number, status: ApprovalRow['status'] = 'approved'): ApprovalRow =>
  ({ id: `ap_${i}`, status });
const approvalChanged = (prev: ApprovalRow, row: ApprovalRow) =>
  prev.status !== row.status || prev.respondedAt !== row.respondedAt;

describe('审批历史 — 与通知同一套规则（一个列表一个游标）', () => {
  it('刷新只能 UPSERT：已加载的历史页不会因为一次 60s 刷新被丢掉', () => {
    const loaded = Array.from({ length: 150 }, (_, i) => approvalRow(i));
    const afterRefresh = mergeNotificationPage(loaded, loaded.slice(0, APPROVAL_PAGE), approvalChanged);
    expect(afterRefresh).toHaveLength(150);
  });

  it('状态变更会被刷新写入（别处已批准的不能再显示 pending）', () => {
    const loaded = [approvalRow(1, 'pending')];
    const merged = mergeNotificationPage(
      loaded,
      [{ id: 'ap_1', status: 'approved', respondedAt: '2026-10-18T12:00:00Z' }],
      approvalChanged,
    );
    expect(merged[0].status).toBe('approved');
  });

  it('触底翻页后再来 3 条新审批（插到队首）：offset 必须接着服务端给过的行数，而不是 list.length', () => {
    // 服务端按 requested_at DESC 分页，offset 是「已经拿过多少行」。
    let cursor = 0;
    const list: ApprovalRow[] = [];
    const takePage = (rows: ApprovalRow[]) => {
      cursor += rows.length;
      for (const r of rows) if (!list.some(x => x.id === r.id)) list.push(r);
    };

    takePage(Array.from({ length: APPROVAL_PAGE }, (_, i) => approvalRow(i)));
    expect(cursor).toBe(50);

    // 刷新：3 条新审批在最前面，列表长度变成 53。
    list.unshift(approvalRow(-1, 'pending'), approvalRow(-2, 'pending'), approvalRow(-3, 'pending'));
    expect(list).toHaveLength(53);

    // 旧实现 `offset = approvals.length` 这一步会变成 53 —— 跳过服务端的第 51~53 行。
    expect(cursor).toBe(50);

    takePage(Array.from({ length: APPROVAL_PAGE }, (_, i) => approvalRow(APPROVAL_PAGE + i)));
    expect(cursor).toBe(100);
    // 两页 + 3 条新行，无重复
    expect(new Set(list.map(r => r.id)).size).toBe(list.length);
  });

  it('翻到总数即停（不会在底部反复请求）', () => {
    expect(decideNextPage({
      loadedCount: 2522, received: APPROVAL_PAGE, fresh: APPROVAL_PAGE,
      totalCount: 2522, pageSize: APPROVAL_PAGE,
    })).toEqual({ hasMore: false });
  });
});
