/**
 * chatScrollRestore — per-view scroll memory for the chat transcript.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 *
 * Every conversation (agent DM, team channel, human DM) and every session tab is
 * rendered into the SAME long-lived scroll container. Switching views therefore
 * used to inherit whatever `scrollTop` the previous view happened to leave
 * behind: land in a session you had never scrolled and find yourself in the
 * middle of it. Two things were missing:
 *
 *   1. no memory of where each view was left, and
 *   2. no re-assertion after a view's history arrives — rows are measured
 *      lazily, so a "scroll to the bottom once" write lands short of the real
 *      bottom as soon as the freshly mounted markdown rows turn out to be
 *      taller than their estimate.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 *
 *   • Leaving a view records where it was (see `captureChatScrollAnchor`).
 *   • Re-entering restores exactly that spot; a view with no record goes to the
 *     bottom, i.e. the newest output.
 *   • The record lives in a module-level Map — **process lifetime only**. A
 *     restart therefore has no records and every view opens at the bottom, which
 *     is exactly the product rule.
 *
 * ── Why a row anchor and not a raw `scrollTop` ───────────────────────────────
 *
 * A stored pixel offset is only meaningful against the layout it was measured
 * in. Row heights here are estimated until measured (code blocks, tables and
 * tool cards routinely land 2–3× off), so a raw offset drifts as the list
 * settles. An anchor of "this message id, scrolled this far past the viewport
 * top" is layout-independent: the caller re-derives the target from wherever
 * that row currently sits, so each retry pass converges instead of drifting.
 *
 * Kept DOM-light and side-effect-free (the one DOM helper takes an element) so
 * the whole contract is unit-testable; `Team.tsx` owns the refs, timers and
 * virtualizer plumbing.
 */
import { isAtBottom } from './chatScrollFollow.ts';

/** Where a view was left: glued to the bottom, or parked on a specific row. */
export type ScrollAnchor =
  | { kind: 'bottom' }
  | { kind: 'row'; id: string; delta: number };

/** A `row` anchor on its own — callers that need `id`/`delta` should not have to narrow. */
export type RowScrollAnchor = Extract<ScrollAnchor, { kind: 'row' }>;

/** A row's top edge, expressed as an offset inside the scroll content. */
export interface RowOffset {
  id: string;
  start: number;
}

/** The geometry we need from a scroll container (a DOM element satisfies it). */
export interface ScrollViewState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Memory key for one view. `convKey` alone is not enough: a single agent holds
 * several session tabs, and each one must remember its own position.
 */
export function scrollMemoryKey(convKey: string, sessionId: string | null | undefined): string {
  return `${convKey || '_'}::${sessionId ?? ''}`;
}

/**
 * The row sitting at the viewport top: the last row whose start is at or above
 * `scrollTop`. Falls back to the first rendered row when the viewport starts
 * above every row (can happen right after a prepend), and to `null` when nothing
 * is measurable.
 */
export function pickAnchorRow(rows: RowOffset[], scrollTop: number): RowOffset | null {
  let best: RowOffset | null = null;
  for (const row of rows) {
    if (row.start > scrollTop + 1) continue;
    if (!best || row.start > best.start) best = row;
  }
  return best ?? rows[0] ?? null;
}

/**
 * Snapshot a view. At (or near) the bottom the anchor is simply `bottom` — the
 * follow loop then owns the position and a later restore glues to the newest
 * output instead of freezing an offset that keeps growing while a reply streams.
 */
export function captureChatScrollAnchor(rows: RowOffset[], view: ScrollViewState): ScrollAnchor {
  if (isAtBottom(view)) return { kind: 'bottom' };
  const row = pickAnchorRow(rows, view.scrollTop);
  if (!row) return { kind: 'bottom' };
  return { kind: 'row', id: row.id, delta: view.scrollTop - row.start };
}

/**
 * How much to move `scrollTop` by so the anchored row ends up exactly `delta`
 * px above the viewport top again.
 *
 * `rowTopInViewport` is the row's current distance from the container's top
 * edge (negative once its top has scrolled past). Because both capture and
 * restore express the anchor the same way, the correction is a plain delta and
 * repeated passes drive the error to zero.
 */
export function rowCorrection(rowTopInViewport: number, delta: number): number {
  return rowTopInViewport + delta;
}

/**
 * 「跳到某条消息」的 anchor —— 与恢复语义共用同一套（见下）。
 *
 * 为什么复用而不是另起一套滚动：切会话 / 换 Agent 会排一个 restore intent，
 * 目标视图在本进程没有记录时该 intent 指向**底部**；若跳转自带第二条滚动路径，
 * 两条会互相覆盖（跳转被冲回底部、贴底跟随被重新武装）。一个视图同一时刻只能有
 * **一个** pending intent —— 让跳转去**替换**它，竞争就从结构上不存在了。
 *
 * `GOTO_ROW_INSET`：命中的消息停在视口顶部下方这么多像素，上方留一点呼吸空间，
 * 命中行更容易被认出来。
 */
export const GOTO_ROW_INSET = 12;

/**
 * 指向某条消息的行 anchor。
 *
 * `delta` 取**负值**：`rowCorrection` 把行顶收敛到 `-delta`（见其契约与测试），所以
 * delta = -inset 才让消息停在视口顶部**下方** inset 像素处 —— 留出呼吸空间、命中行
 * 更好认。若写成 +inset，消息会被推到视口顶上方、顶部被裁掉。
 */
export function gotoAnchor(messageId: string, inset: number = GOTO_ROW_INSET): RowScrollAnchor {
  return { kind: 'row', id: messageId, delta: -inset };
}

/** Rows currently mounted in the container, in content order. */
export function readRenderedRowOffsets(el: HTMLElement): RowOffset[] {
  const containerTop = el.getBoundingClientRect().top;
  const scrollTop = el.scrollTop;
  const rows: RowOffset[] = [];
  for (const node of Array.from(el.querySelectorAll<HTMLElement>('[data-index]'))) {
    const labelled = node.querySelector<HTMLElement>('[id^="msg-"]');
    const id = labelled?.id?.slice('msg-'.length);
    if (!id) continue;
    rows.push({ id, start: scrollTop + (node.getBoundingClientRect().top - containerTop) });
  }
  rows.sort((a, b) => a.start - b.start);
  return rows;
}

/**
 * 把一个行 anchor 解析成「**这一帧**要滚多少像素」，或 `null`（该行当前没渲染 ——
 * 调用方先按虚拟表的估算滚过去，下一趟再精确校正）。
 *
 * 它是「行 anchor → 位移」的**唯一**实现：`rows` 就是 `readRenderedRowOffsets(el)`
 * 的产物，于是 `row.start - view.scrollTop` 正好是该行距容器顶的距离（与
 * `rowCorrection` 的入参同一坐标系）—— 两处不再各查一遍 DOM、各算一遍。
 *
 * **按行身份（id）定位，不按下标**：这个列表渲染的是缓冲区的一个投影（direct 模式
 * 剔除活动日志行、通知确认后再隐藏），下标随时会漂移，行 id 才是稳定的身份。
 */
export function resolveRowAnchor(
  rows: RowOffset[],
  view: ScrollViewState,
  id: string,
  delta: number,
): number | null {
  const row = rows.find(r => r.id === id);
  if (!row) return null;
  return rowCorrection(row.start - view.scrollTop, delta);
}

/**
 * In-memory (process lifetime) store of per-view scroll anchors.
 *
 * Bounded and least-recently-used: a long session visits hundreds of views and
 * this must not grow without limit. Eviction is invisible to the user (an
 * evicted view simply opens at the bottom, like after a restart).
 */
export class ChatScrollMemory {
  private readonly entries = new Map<string, ScrollAnchor>();

  constructor(private readonly capacity = 120) {}

  save(key: string, anchor: ScrollAnchor): void {
    if (!key) return;
    // Re-insert so the Map's iteration order stays least→most recently used.
    this.entries.delete(key);
    this.entries.set(key, anchor);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get(key: string): ScrollAnchor | null {
    if (!key) return null;
    const anchor = this.entries.get(key);
    if (!anchor) return null;
    // Touch: a view you just looked at is the least likely one to be evicted.
    this.entries.delete(key);
    this.entries.set(key, anchor);
    return anchor;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Process-lifetime default store (see the header: a restart starts at bottom). */
export const chatScrollMemory = new ChatScrollMemory();

/**
 * 滚动意图的**优先级**（同一视图同一时刻只允许一个在途意图）。
 *
 *   • `jump`    —— 用户**明确要求**去看某条消息（搜索结果 / ⌘F 命中 / 通知深链）。
 *   • `prepend` —— **布局补偿**：向上翻页把历史插到了当前内容上方，必须把「翻页前
 *                  视口顶部那一行」放回原处。它不是导航，而是渲染的前提。
 *   • `restore` —— 进入视图时的「回到上次位置 / 到底部」。
 *
 * 为什么必须排优先级，而不是「后写者胜」：`pendingRestoreRef` 名义上是「唯一写者」，
 * 但这些写者会**互相覆盖**。切会话的路径（`switchSession`、换 Agent 的 effect）会在
 * jump 之后排一次 `restore`（同 key、anchor = bottom）→ 跳转被冲回底部；翻页补偿同理
 * 可以把一个正在落位的跳转拽走（「闪一下正确的消息，然后被拽到别处」）。
 *
 * 判据（由高到低）：**用户的显式导航 > 布局补偿 > 进入视图的位置记忆**。
 */
export type ScrollIntentPriority = 'jump' | 'prepend' | 'restore';

/** 优先级排序表 —— 判定只在 `shouldAcceptRestoreIntent` 里发生（唯一执行点）。 */
const SCROLL_INTENT_RANK: Record<ScrollIntentPriority, number> = {
  jump: 3,
  prepend: 2,
  restore: 1,
};

/** 一个视图的在途滚动意图（只用到 key + 优先级做判定）。 */
export interface ScrollIntent {
  key: string;
  priority: ScrollIntentPriority;
}

/**
 * 新的意图是否应当取代在途意图？**唯一规则**：同视图时，优先级不低于在途意图才接受
 * （同级 = 后来者胜）。于是：未满足的 `jump` 不被任何 `prepend`/`restore` 覆盖；
 * `prepend` 压过 `restore`（布局补偿比"回到上次位置"更具体、更晚发生）；换了 key
 * （另一个视图）或本来就没有在途意图，一律接受。
 */
export function shouldAcceptRestoreIntent(
  current: ScrollIntent | null,
  incoming: ScrollIntent,
): boolean {
  if (!current) return true;
  if (current.key !== incoming.key) return true;
  return SCROLL_INTENT_RANK[incoming.priority] >= SCROLL_INTENT_RANK[current.priority];
}

/**
 * How long a pending restore intent stays worth honouring. Long enough to
 * outlive a slow transcript round-trip, short enough that an intent nobody could
 * satisfy (a failed load) cannot hijack a later repaint of the same view.
 */
export const RESTORE_INTENT_TTL_MS = 10_000;

/**
 * 意图还没落位时的**重试间隔**。
 *
 * 为什么需要重试而不是"六趟打完就放弃"：行高是惰性测量的，第一趟往往只能拿到
 * 虚拟表的**估算**偏移（刚写入 `el.scrollTop` 后目标行才被挂载）。旧实现把"放弃"绑在
 * 计时器上（最后一趟无条件清掉意图），于是目标行稍晚一点渲染出来，视口就永久停在
 * 估算的位置上 —— 用户看到的"定位到错误位置"。
 *
 * 现在:落位由**事实**释放（见 `planIntentPass`），重试一直续跑到落位或 TTL 到期，
 * 所以"晚一点才渲染出来"必然收敛，而"永远不满足"也**不可能**永远 pin 住视口。
 */
export const INTENT_RETRY_MS = 300;

export function isRestoreIntentStale(at: number, now: number): boolean {
  return now - at > RESTORE_INTENT_TTL_MS;
}

/**
 * 这一趟应用该做什么 —— **意图生命周期的唯一判定点**。
 *
 * 为什么要有它：旧实现的"释放"由**计时器**决定（链的最后一趟 `finalPass` **无条件**清掉意图）。
 * 目标行还没渲染出来时（翻页深 / 惰性测量未收敛 / 刚写下的偏移还只是**估算**），意图被丢掉 →
 * 视口停在半路（用户看到的"定位到错误位置"），而且此后任何东西都能接管它。
 * 现在"释放"由**事实**决定：
 *
 *   • `apply`   —— 这一帧能精确落位 → 落位即完成，释放（不再看计时器）。
 *                  `stale` 不覆盖它：能校正时没有理由放弃。
 *   • `keep`    —— 还没落位，但**行还在权威缓冲里**（迟早会渲染）→ 保持，由调用方续跑重试。
 *   • `release-bottom` —— 行确实不在这个会话里（历史被裁剪 / 换了修订）→ 底部兜底并释放。
 *                  **只给 `restore`**：底部正是"没有位置记忆"时的位置，是它的自然兜底。
 *   • `release-hold`   —— 释放但**视口保持原地**。给 `jump`（用户在等那条消息：
 *                  把他送到最新输出处是**谎报**）与 `prepend`（布局补偿没做成只是没做成，
 *                  把用户从历史里搬到底部是过度反应）。TTL 到期也走这里。
 *                  这条保证**意图不可能永远 pin 住视口**（否则贴底跟随会被永久冻结）。
 *
 * ── 「行不在了」不能靠**一次观测**，要靠**翻遍历史**（第九轮报障的根因）──────
 *
 * 释放的另一个出口 —— 「这一帧没渲染到它、也不在缓冲里」—— 曾经是**单次采样**的直接判决。
 * 真实浏览器里复现到的失败序列：
 *
 *     intent:refine  correction:20          ← 目标已基本就位
 *     intent:release-hold  stale:false      ← +142ms：单次「不在缓冲里」就释放了
 *     （此后该视图的缓冲被并发重载改写，内容整体缩短 17k px → 视口停在错误的地方）
 *
 * 两个缺陷：
 *   ① 判据读的是**环境指针**（`getMessages(convKey)` 会经视图指针解析到别处），
 *      而意图的归属是由 `activeScrollKeyRef` 表达的 —— 同一事实的两种口径；
 *   ② 「此刻不在缓冲里」只是**瞬时**观测（缓冲被并发重载替换），却被当成**终局**事实。
 *
 * 所以缺席的判据改成：**只要这个视图还能往前翻，就不能断定「不在了」**，
 * 而要用唯一的定位器把这一行再取回来（调用方负责触发）。只有翻到没有更早历史
 * （或 TTL 到期）时，缺席才算**被证明**。这样 `jump` 不会因为缓冲被替换而烂尾，
 * 也不会因为目标真的被删除而无限 pin 住视口。
 */
export type IntentPassAction = 'apply' | 'refine' | 'keep' | 'release-bottom' | 'release-hold';

/**
 * 锚点的位置**稳定了没有**？
 *
 * `settledNow` = 这一趟量到锚点已经就位（|修正| ≤ 1px）；`prevSettled` = 上一趟也是
 * （`null` = 还没量过）。两者都成立才算稳定。
 *
 * ── 为什么「渲染出来」不等于「稳定」（第八轮报障的根因）─────────────────────
 *
 * 跨会话跳转时，目标行附近的**行高全是估算值** —— 本进程从没渲染过那个会话，虚拟表
 * 只有 `estimateSize`（120px），而真实行高常是它的 2~3 倍。跳转落位后 ResizeObserver
 * 才逐行测量，于是**目标行上方的行一个个变高** → `virtualRow.start` 变大 → 目标行
 * （用 `translateY(start)` 定位）被推走；而 `scrollTop` 不变（视口归属已被 pin，
 * 虚拟表不替我们补偿，见 shouldAdjustScrollPositionOnItemSizeChange）。
 *
 * 结果就是用户看到的「闪一下正确的消息位置，然后位置又变了」——
 * 第一帧确实落在了估算的右位置，但那是个**马上会被测量推翻**的位置。
 * 同会话不坏，正是因为那些行早已测量过、位置本来就稳定。
 *
 * 所以要两趟都为「已就位」才释放：一趟只能是「恰好此刻看起来对」。
 */
export function anchorStability(settledNow: boolean, prevSettled: boolean | null): boolean {
  return settledNow && prevSettled === true;
}

export function planIntentPass(input: {
  priority: ScrollIntentPriority;
  /** 目标行这一帧渲染在 DOM 里（于是能算精确校正量）。 */
  rendered: boolean;
  /** 意图已超过 `RESTORE_INTENT_TTL_MS`。 */
  stale: boolean;
  /**
   * 位置已经稳定（见 `anchorStability`）。必填：稳定性的唯一执行点就在这里，
   * 缺省成 `true` 会让「一渲染出来就释放」这个 bug 重新变得可表达。
   */
  stable: boolean;
  /**
   * 目标行这一帧既没渲染、也不在**这个意图自己的 buffer**里。
   */
  absent: boolean;
  /**
   * 这个视图还能往前翻（还有更早的历史可取）。
   *
   * 它让「不在」从**一次观测**升格为**被证明**：只要还能翻，就不允许断定行已消失，
   * 调用方会用唯一的定位器把它取回来。`getMessages(k)` 会经视图指针解析，
   * 所以这个值必须从**意图自己的 bufferId** 的权威边界读（`getWindowBounds`），
   * 不能读环境指针或渲染期投影。
   */
  canLoadMore: boolean;
}): IntentPassAction {
  // 渲染出来了：要么已稳定 → 落位并释放；否则 → 微调并**继续重试**，
  // 直到测量收敛（或 TTL 兜底）。TTL 在这里不是释放理由 —— 能校正就校正。
  if (input.rendered) return input.stable ? 'apply' : 'refine';
  // TTL 是唯一的**无条件**出口：任何意图都不允许永远 pin 住视口。
  if (input.stale) {
    return input.priority === 'restore' ? 'release-bottom' : 'release-hold';
  }
  // 行还在缓冲里 → 迟早会渲染出来（惰性测量）→ 等。
  if (!input.absent) return 'keep';
  // 不在缓冲里：只要还能往前翻，就再取一次 —— 不把瞬时空窗读成终局事实。
  if (input.canLoadMore) return 'keep';
  // 翻遍了也没有：缺席至此才算**被证明**，按优先级兜底。
  return input.priority === 'restore' ? 'release-bottom' : 'release-hold';
}

/**
 * 这个意图是否有权**改变视口归属**（`userTakeoverRef`）？
 *
 * `restore` 要：它就是「进入视图时的位置决定」——锚点是 bottom 时把视口交还贴底跟随，
 * 锚点是某一行时 pin 住。`jump` 也要：用户明确接管了视口。
 *
 * `prepend` **不要**：它是**布局补偿**（把翻页前视口顶部那一行放回原处），不是导航。
 * 它跑在跳转翻页的过程中（此时调用方刚刚 pin 住视口来抢所有权），若它顺手
 * `resumeChatScrollFollow()`，就等于把视口还给贴底跟随、把跳转的 pin 抹掉。
 * 一个只该挪像素的操作，不该有改变所有权的副作用。
 */
export function mayChangeViewportOwner(priority: ScrollIntentPriority): boolean {
  return priority !== 'prepend';
}
