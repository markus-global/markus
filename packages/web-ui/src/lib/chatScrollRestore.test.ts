import { describe, it, expect, beforeEach } from 'vitest';
import {
  ChatScrollMemory,
  GOTO_ROW_INSET,
  anchorStability,
  captureChatScrollAnchor,
  gotoAnchor,
  mayChangeViewportOwner,
  pickAnchorRow,
  planIntentPass,
  readRenderedRowOffsets,
  resolveRowAnchor,
  rowCorrection,
  scrollMemoryKey,
  shouldAcceptRestoreIntent,
  type RowOffset,
  type ScrollAnchor,
} from './chatScrollRestore.ts';

/** viewport helper — 1000px tall content window, scrolled `scrollTop` px down. */
function view(scrollTop: number, scrollHeight = 1000, clientHeight = 400) {
  return { scrollTop, scrollHeight, clientHeight };
}

const rows: RowOffset[] = [
  { id: 'a', start: 0 },
  { id: 'b', start: 200 },
  { id: 'c', start: 500 },
];

describe('scrollMemoryKey', () => {
  it('separates session tabs of the same conversation', () => {
    expect(scrollMemoryKey('agt_1', 'sess_a')).not.toBe(scrollMemoryKey('agt_1', 'sess_b'));
  });

  it('tolerates a missing conversation key or session id', () => {
    expect(scrollMemoryKey('', null)).toBe('_::');
    expect(scrollMemoryKey('ch:#general', undefined)).toBe('ch:#general::');
  });
});

describe('pickAnchorRow', () => {
  it('returns the last row at or above the viewport top', () => {
    expect(pickAnchorRow(rows, 250)?.id).toBe('b');
    expect(pickAnchorRow(rows, 200)?.id).toBe('b');
  });

  it('falls back to the first row when the viewport sits above every row', () => {
    expect(pickAnchorRow(rows, -50)?.id).toBe('a');
  });

  it('returns null when nothing is measurable', () => {
    expect(pickAnchorRow([], 100)).toBeNull();
  });
});

describe('captureChatScrollAnchor', () => {
  it('records the bottom — not an offset — when the user is at the bottom', () => {
    // distance from bottom = 0 → the follow loop should own this view.
    expect(captureChatScrollAnchor(rows, view(600))).toEqual({ kind: 'bottom' });
  });

  it('treats the epsilon band above the bottom as the bottom', () => {
    expect(captureChatScrollAnchor(rows, view(595))).toEqual({ kind: 'bottom' });
  });

  it('anchors on the row under the viewport top with the scrolled-past amount', () => {
    // scrollTop 250 → row b (start 200) is 50px above the viewport top.
    expect(captureChatScrollAnchor(rows, view(250))).toEqual({ kind: 'row', id: 'b', delta: 50 });
  });

  it('falls back to the bottom when no rows are rendered', () => {
    expect(captureChatScrollAnchor([], view(250))).toEqual({ kind: 'bottom' });
  });
});

describe('rowCorrection', () => {
  it('is zero when the row already sits where it was captured', () => {
    expect(rowCorrection(-50, 50)).toBe(0);
  });

  it('asks for the drift once rows above have been measured taller', () => {
    // the row is now 120px above the viewport top but was 50px when captured
    expect(rowCorrection(-120, 50)).toBe(-70);
  });

  it('pushes down when the row drifted below the viewport top', () => {
    expect(rowCorrection(30, 50)).toBe(80);
  });
});

describe('ChatScrollMemory', () => {
  let mem: ChatScrollMemory;
  beforeEach(() => { mem = new ChatScrollMemory(3); });

  it('round-trips an anchor', () => {
    const anchor: ScrollAnchor = { kind: 'row', id: 'm1', delta: 12 };
    mem.save('k', anchor);
    expect(mem.get('k')).toEqual(anchor);
  });

  it('returns null for an unknown or empty key', () => {
    expect(mem.get('nope')).toBeNull();
    expect(mem.get('')).toBeNull();
  });

  it('overwrites without growing', () => {
    mem.save('k', { kind: 'bottom' });
    mem.save('k', { kind: 'row', id: 'm1', delta: 1 });
    expect(mem.size).toBe(1);
    expect(mem.get('k')).toEqual({ kind: 'row', id: 'm1', delta: 1 });
  });

  it('ignores an empty key', () => {
    mem.save('', { kind: 'bottom' });
    expect(mem.size).toBe(0);
  });

  it('evicts least-recently-used entries beyond capacity', () => {
    mem.save('a', { kind: 'bottom' });
    mem.save('b', { kind: 'bottom' });
    mem.save('c', { kind: 'bottom' });
    mem.save('d', { kind: 'bottom' });
    expect(mem.get('a')).toBeNull();
    expect(mem.get('d')).toEqual({ kind: 'bottom' });
    expect(mem.size).toBe(3);
  });

  it('counts a read as recent use', () => {
    mem.save('a', { kind: 'bottom' });
    mem.save('b', { kind: 'bottom' });
    mem.save('c', { kind: 'bottom' });
    mem.get('a');
    mem.save('d', { kind: 'bottom' });   // should evict b, not a
    expect(mem.get('a')).toEqual({ kind: 'bottom' });
    expect(mem.get('b')).toBeNull();
  });

  it('clears everything', () => {
    mem.save('a', { kind: 'bottom' });
    mem.clear();
    expect(mem.size).toBe(0);
  });
});

// ─── DOM helpers ─────────────────────────────────────────────────────────────
// happy-dom has no layout engine, so these are driven by hand-rolled nodes: the
// helpers only ever read `scrollTop` / `getBoundingClientRect` / child lookups.

interface FakeRow { id: string; top: number }

/**
 * Minimal stand-in for the real row markup: rows are queried as `[data-index]`,
 * each containing the message node `[id^="msg-"]` that anchors are stored against.
 */
function fakeContainer(rowsIn: FakeRow[], scrollTop: number, containerTop = 0) {
  const rect = (top: number) => ({ top } as DOMRect);
  const msgNode = (row: FakeRow) => ({ id: `msg-${row.id}`, getBoundingClientRect: () => rect(row.top) });
  const rowNodes = rowsIn.map(row => ({
    id: `row-${row.id}`,
    getBoundingClientRect: () => rect(row.top),
    querySelector: (sel: string) => (sel.startsWith('[id^="msg-"]') ? msgNode(row) : null),
  }));
  // A row carrying no message label must be skipped — exercises the guard in
  // readRenderedRowOffsets.
  const unlabelled = {
    id: 'row-unlabelled',
    getBoundingClientRect: () => rect(999),
    querySelector: () => null,
  };
  return {
    scrollTop,
    getBoundingClientRect: () => rect(containerTop),
    querySelectorAll: (sel: string) =>
      sel === '[data-index]' ? [...rowNodes, unlabelled] : rowsIn.map(msgNode),
  } as unknown as HTMLElement;
}

describe('readRenderedRowOffsets', () => {
  it('converts viewport positions into content offsets and sorts them', () => {
    const el = fakeContainer([
      { id: 'b', top: 5 },      // 100px above the container top, 50px scrolled past
      { id: 'a', top: -95 },
    ], 150);
    expect(readRenderedRowOffsets(el)).toEqual([
      { id: 'a', start: 55 },
      { id: 'b', start: 155 },
    ]);
  });

  it('skips rows without a message label', () => {
    const el = fakeContainer([{ id: 'a', top: 0 }], 0);
    expect(readRenderedRowOffsets(el).map(r => r.id)).toEqual(['a']);
  });
});

/**
 * 把行 anchor 解析成「这一帧要滚多少像素」—— 唯一的实现，按**行身份**定位。
 *
 * 为什么是身份而不是下标：这个列表渲染的是缓冲区的一个**投影**
 * （direct 模式剔除活动日志行、通知确认后再隐藏），下标随时会漂移；
 * 行 id 才是稳定的身份。
 */
describe('resolveRowAnchor', () => {
  it('把锚定的行带回「视口顶部下方 inset 像素」处', () => {
    const el = fakeContainer([{ id: 'a', top: -10 }, { id: 'b', top: 90 }], 210);
    const correction = resolveRowAnchor(readRenderedRowOffsets(el), view(210), 'b', -12)!;
    // 行 b 在视口下方 90px → 一次修正后应停在视口顶下方 12px（= -delta）。
    expect(90 - correction).toBe(12);
  });

  it('按行身份定位，不受下标漂移影响', () => {
    // 同一条消息「过滤前」是第 1 行、「过滤后」是第 0 行 —— 结果必须一致。
    const filtered = fakeContainer([{ id: 'b', top: 90 }], 210);
    expect(resolveRowAnchor(readRenderedRowOffsets(filtered), view(210), 'b', -12)).toBe(78);
  });

  it('已在锚点位置 → 0（收敛，不放大误差）', () => {
    const el = fakeContainer([{ id: 'b', top: 12 }], 288);
    expect(resolveRowAnchor(readRenderedRowOffsets(el), view(288), 'b', -12)).toBe(0);
  });

  it('未渲染（被虚拟化掉）→ null，调用方退化为虚拟表估算', () => {
    const el = fakeContainer([{ id: 'a', top: 0 }], 0);
    expect(resolveRowAnchor(readRenderedRowOffsets(el), view(0), 'zz', -12)).toBeNull();
  });
});

describe('capture → restore round trip', () => {
  it('re-derives the same visual position after the rows above grew', () => {
    // Captured: row 'a' sits 95px above the container top, view scrolled 150px.
    const elBefore = fakeContainer([{ id: 'a', top: -95 }], 150);
    const anchor = captureChatScrollAnchor(readRenderedRowOffsets(elBefore), view(150, 2000));
    expect(anchor).toEqual({ kind: 'row', id: 'a', delta: 95 });

    // Restored: everything above got measured 300px taller, so the row now sits
    // 205px BELOW the container top and the view has not moved yet. One pass must
    // pull the user back to exactly 95px into that row (150 + 300 = 450).
    const elAfter = fakeContainer([{ id: 'a', top: 205 }], 150);
    const correction = resolveRowAnchor(readRenderedRowOffsets(elAfter), view(150, 2000), 'a', 95)!;
    expect(correction).toBe(300);
    expect(elAfter.scrollTop + correction).toBe(450);
  });

  it('a second pass is a no-op once the anchor is honoured', () => {
    const el = fakeContainer([{ id: 'a', top: -95 }], 450);
    expect(resolveRowAnchor(readRenderedRowOffsets(el), view(450, 2000), 'a', 95)).toBe(0);
  });
});

/**
 * 「跳到某条消息」= 一个指向某条消息的 scroll anchor。
 *
 * 回归背景：搜索跳转此前自带一套独立的滚动路径（pin + scrollToIndex），而切会话 /
 * 换 Agent 会同时排一个**指向底部**的 restore intent；两股力量互相覆盖，跳转被
 * 冲回底部。修法不是加护栏，而是让跳转复用唯一的 anchor 机制 —— 于是这里要钉住
 * 「goto anchor 的语义」：delta 表示「这条消息距视口顶部多少像素」，正值 = 留出呼吸空间。
 */
describe('gotoAnchor —— 跳到某条消息的 anchor 语义', () => {
  /**
   * 应用一次修正后，行顶在视口里的实际位置。
   * `scrollTop += rowCorrection(top, delta)` → 行顶落在 `-delta`（见 rowCorrection 契约）。
   */
  const landedTop = (top: number, delta: number) => top - rowCorrection(top, delta);

  it('产出指向该消息的行 anchor（而不是底部）', () => {
    const a = gotoAnchor('m123');
    expect(a.kind).toBe('row');
    expect(a).toMatchObject({ id: 'm123' });
    expect(a.kind).not.toBe('bottom');
    expect(GOTO_ROW_INSET).toBeGreaterThan(0);
  });

  it('落到视口顶部**下方** inset 像素处（上方留白，而不是被顶部裁掉）', () => {
    // 行在视口上方 500px —— 任意位置一次修正都应把它带到「顶下方 inset」处。
    expect(landedTop(-500, gotoAnchor('m').delta)).toBe(GOTO_ROW_INSET);
    expect(landedTop(0, gotoAnchor('m').delta)).toBe(GOTO_ROW_INSET);
  });

  it('已在命中位置时修正为 0（收敛，不放大误差）', () => {
    const a = gotoAnchor('m1');
    expect(rowCorrection(GOTO_ROW_INSET, a.delta)).toBe(0);
  });

  it('允许调用方覆盖 inset', () => {
    expect(landedTop(-500, gotoAnchor('m1', 0).delta)).toBe(0);
    expect(landedTop(-500, gotoAnchor('m1', 40).delta)).toBe(40);
  });
});

/**
 * 滚动意图优先级 —— 「未满足的 jump 不被后续 restore 覆盖」。
 *
 * 回归背景：跳转已接入唯一的 pendingRestoreRef，但 restore 是「后写者胜」。
 * 切会话路径会在 jump 之后排一次 restore（同 key、anchor = bottom），把跳转
 * 覆盖成底部 —— 用户看到「闪一下正确的消息，然后跳到底部」。
 */
describe('shouldAcceptRestoreIntent —— 意图优先级', () => {
  const jump = (key: string) => ({ key, priority: 'jump' as const });
  const restore = (key: string) => ({ key, priority: 'restore' as const });

  it('没有在途意图 → 一律接受', () => {
    expect(shouldAcceptRestoreIntent(null, jump('k'))).toBe(true);
    expect(shouldAcceptRestoreIntent(null, restore('k'))).toBe(true);
  });

  it('未满足的 jump 不被后续 restore 覆盖（同视图）', () => {
    expect(shouldAcceptRestoreIntent(jump('k'), restore('k'))).toBe(false);
  });

  it('新的 jump 可以覆盖旧的 jump（用户点了另一个结果）', () => {
    expect(shouldAcceptRestoreIntent(jump('k'), jump('k'))).toBe(true);
  });

  it('restore 之间后来者胜（同一视图再次进入）', () => {
    expect(shouldAcceptRestoreIntent(restore('k'), restore('k'))).toBe(true);
  });

  it('不同视图（key 不同）互不影响', () => {
    expect(shouldAcceptRestoreIntent(jump('k1'), restore('k2'))).toBe(true);
    expect(shouldAcceptRestoreIntent(restore('k1'), jump('k2'))).toBe(true);
  });
});

/**
 * prepend（向上翻页）保持视口不动 —— 与跳转**共用同一个**滚动意图机制。
 *
 * 回归背景（第四轮）：翻页此前自带第二条滚动路径
 * `chatVirtualizer.scrollToIndex(newMsgs.length, { align: 'start' })`。三个结构性缺陷：
 *
 *   ① 它**不受意图机制管辖**：跳转（`jump`）正在落位时它照样滚；
 *   ② `scrollToIndex` 会点亮 virtual-core 内部一个 ≤5s、**不可取消**的 rAF reconcile
 *      循环（`scrollState` + `reconcileScroll`，见 virtual-core@3.14）：该下标的偏移量
 *      每变一次就重新推一次视口 —— 而惰性测量的行高，正好在跳转落位的那几百毫秒里
 *      持续变化。于是「闪一下正确的消息，然后被拽到别处」。
 *   ③ 它拿「本次新增条数」当**渲染列表的下标**用。这两个数只有在「DB 行 == 渲染行」
 *      时才相等；direct 模式渲染的是 `messages.filter(m => !m.isActivityLog)`，
 *      一页里只要有一条活动日志行，下标就整体偏移。
 *
 * 症状因此是：**跨会话**搜索跳转（目标不在已加载窗口内 → 必须翻页）会闪一下正确的
 * 消息然后被拽走；**同一会话**跳转（不翻页）一直正常。
 *
 * 修法不是加护栏，而是**删掉第二条滚动路径**：翻页同样只是「一个指向某行的 anchor」，
 * 交给唯一的意图机制（`priority: 'prepend'`，优先级介于 `jump` 与 `restore` 之间）。
 * 下面钉住它的语义。
 */
describe('prepend（向上翻页）的锚点语义', () => {
  const jump = (key: string) => ({ key, priority: 'jump' as const });
  const prepend = (key: string) => ({ key, priority: 'prepend' as const });
  const restore = (key: string) => ({ key, priority: 'restore' as const });

  it('锚点是「翻页前视口顶部那一行」，delta = 它距视口顶部的距离', () => {
    const el = fakeContainer([{ id: 'old-top', top: -60 }, { id: 'x', top: 40 }], 300);
    expect(captureChatScrollAnchor(readRenderedRowOffsets(el), view(300, 4000)))
      .toEqual({ kind: 'row', id: 'old-top', delta: 60 });
  });

  it('50 行插到上方之后，一次修正就把同一行放回原处', () => {
    const before = fakeContainer([{ id: 'old-top', top: -60 }], 300);
    const anchor = captureChatScrollAnchor(readRenderedRowOffsets(before), view(300, 4000));
    expect(anchor).toEqual({ kind: 'row', id: 'old-top', delta: 60 });

    // 50 行 × 120px = 6000px 被插到上方：同一行现在落在视口下方 5940px 处，
    // 而视口还没动。一次修正必须把它拉回「上方 60px」处（scrollTop 300 → 6300）。
    const after = fakeContainer([{ id: 'old-top', top: 5940 }], 300);
    const correction = resolveRowAnchor(readRenderedRowOffsets(after), view(300, 10000), 'old-top', 60)!;
    expect(correction).toBe(6000);
    expect(after.scrollTop + correction).toBe(6300);
  });

  it('用户本来就在底部 → 锚点是 bottom（翻页不该把他从最新输出处拽走）', () => {
    expect(captureChatScrollAnchor(rows, view(600))).toEqual({ kind: 'bottom' });
  });

  it('prepend 让位给未满足的 jump（跳转翻页时不会被翻页锚点拽走）', () => {
    expect(shouldAcceptRestoreIntent(jump('k'), prepend('k'))).toBe(false);
  });

  it('prepend 压过切视图排的 restore（同视图）', () => {
    expect(shouldAcceptRestoreIntent(restore('k'), prepend('k'))).toBe(true);
  });

  it('prepend 之间后来者胜（连续翻页）', () => {
    expect(shouldAcceptRestoreIntent(prepend('k'), prepend('k'))).toBe(true);
  });
});

describe('planIntentPass —— 意图生命周期的唯一判定点', () => {
  // `absent: true` = 目标行这一帧既没渲染、也不在**这个意图自己的缓冲**里；
  // `canLoadMore: false` = 这个 buffer 已经没有更早的历史可取（缺席至此才算被证明）。
  const base = {
    rendered: false, absent: true, canLoadMore: false, stale: false, stable: false,
  } as const;

  it('渲染出来 + 位置已稳定 → 落位并释放', () => {
    expect(planIntentPass({ ...base, priority: 'jump', rendered: true, stable: true })).toBe('apply');
    expect(planIntentPass({ ...base, priority: 'restore', rendered: true, stable: true })).toBe('apply');
    // 能精确校正时，TTL 不再成立理由：落位优先于放弃。
    expect(planIntentPass({ ...base, priority: 'jump', rendered: true, stable: true, stale: true })).toBe('apply');
  });

  /**
   * 本轮报障的根因：跨会话跳转「闪一下正确的消息，然后位置又变了」。
   *
   * 跨会话时目标行附近的**行高全是估算值**（本进程从未测量过），跳转落位后
   * ResizeObserver 才逐个测量 → 目标行上方的行变高 → `virtualRow.start` 变大 →
   * 目标行在 `translateY` 里被推走，而 `scrollTop` 没有变（视口归属被 pin 住，
   * 虚拟表不替我们补偿）。所以「渲染出来」**不等于**「位置稳定」——
   * 一渲染出来就释放，就会把视口停在一个马上要被测量推翻的估算位置上。
   * 同会话不坏正是因为那些行早已测量过、位置本来就稳定。
   */
  it('渲染出来但位置还没稳定 → 继续微调（不释放），等测量收敛', () => {
    expect(planIntentPass({ ...base, priority: 'jump', rendered: true, stable: false })).toBe('refine');
    expect(planIntentPass({ ...base, priority: 'prepend', rendered: true, stable: false })).toBe('refine');
    expect(planIntentPass({ ...base, priority: 'restore', rendered: true, stable: false })).toBe('refine');
    // 位置没稳定时 TTL 不是释放理由 —— 能校正就校正（与 rendered+stable 同一契约）。
    expect(planIntentPass({ ...base, priority: 'jump', rendered: true, stable: false, stale: true })).toBe('refine');
  });

  it('这一帧没渲染、但行还在缓冲里 → 等（惰性测量还没轮到它），不释放', () => {
    for (const priority of ['jump', 'prepend', 'restore'] as const) {
      expect(planIntentPass({ ...base, priority, absent: false })).toBe('keep');
    }
  });

  /**
   * 第九轮报障的根因（在真实浏览器里复现到）。
   *
   * 失败序列：`intent:refine correction:20` → +142ms 后 `intent:release-hold` ——
   * 目标行明明已基本就位，却因为**单次**观测到「此刻不在缓冲里」而被终局释放；
   * 那个瞬间恰好是视图还在加载、缓冲正被并发改写的窗口（此后内容整体缩短 17k px），
   * 于是目标被推走、意图已经没了、视口停在错误的位置。
   *
   * 判据：「不在」只要还是**可恢复**的（这个视图还能往前翻），就不允许它终结一个
   * 用户显式发起的 `jump`。缺席只有在**翻遍历史**（或 TTL 到期）后才算被证明。
   */
  it('只要还能往前翻，就不允许断定「行不在了」—— 继续取回，不释放（第九轮）', () => {
    for (const priority of ['jump', 'prepend', 'restore'] as const) {
      expect(planIntentPass({ ...base, priority, absent: true, canLoadMore: true })).toBe('keep');
    }
  });

  it('jump：行确实不在了也**不**送去底部 —— 用户在等那条消息，不是等最新输出', () => {
    expect(planIntentPass({ ...base, priority: 'jump' })).toBe('release-hold');
  });

  it('prepend：补偿没做成只是没做成 —— 释放但视口留在原地（不把用户从历史里搬到底部）', () => {
    expect(planIntentPass({ ...base, priority: 'prepend' })).toBe('release-hold');
  });

  it('restore：位置记忆的行被裁剪了 → 底部兜底并释放（底部是"没有记忆"时的位置）', () => {
    expect(planIntentPass({ ...base, priority: 'restore' })).toBe('release-bottom');
  });

  it('TTL 到期：释放，且只有 restore 会去底部 —— 意图不可能永远 pin 住视口', () => {
    for (const priority of ['jump', 'prepend', 'restore'] as const) {
      const action = planIntentPass({ ...base, priority, absent: false, stale: true });
      expect(action).toBe(priority === 'restore' ? 'release-bottom' : 'release-hold');
    }
  });
});

describe('anchorStability —— 「位置稳定了没有」的唯一判定点', () => {
  it('这一趟已就位、上一趟也就位 → 稳定', () => {
    expect(anchorStability(true, true)).toBe(true);
  });

  it('刚就位（上一趟没量过）→ 还不稳定：测量可能马上推翻它', () => {
    expect(anchorStability(true, null)).toBe(false);
  });

  it('刚刚被量走位（这一趟不就位）→ 不稳定', () => {
    expect(anchorStability(false, true)).toBe(false);
    expect(anchorStability(false, false)).toBe(false);
    expect(anchorStability(false, null)).toBe(false);
  });
});

describe('mayChangeViewportOwner —— 谁能改变视口归属（userTakeover）', () => {
  it('prepend 不能：它只是布局补偿，不该把 jump 刚 pin 住的视口交还贴底跟随', () => {
    expect(mayChangeViewportOwner('prepend')).toBe(false);
  });

  it('restore 与 jump 能：一个是「进入视图的位置决定」，一个是用户明确接管', () => {
    expect(mayChangeViewportOwner('restore')).toBe(true);
    expect(mayChangeViewportOwner('jump')).toBe(true);
  });
});
